"use strict";

// Chunked, offset-exact reader for minified bundles.
//
// The official Codex Desktop bundle ships single-line chunks of 2-11 MB, so the
// patcher never loads a whole chunk to run a regex over it. Files are consumed
// as fixed-size blocks with an overlap tail, and a match is accepted only when
// it starts inside the exclusive region of its block, so a match straddling a
// boundary is seen exactly once. Blocks decode as latin1, one byte per
// character, which makes a string index equal to a byte offset and lets the
// rewriter splice by offset without ever holding the file in memory. Every
// anchor is pure ASCII, so a boundary can only ever split a string literal.

const fs = require("node:fs");

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

// Scratch names used next to a carrier while a rewrite is staged. The baseline
// keeps the .js suffix on purpose (node --check must reject it for the right
// reason), so the scanner has to exclude it by name; the temp file is what the
// asar packer would otherwise sweep into the published build.
const BASELINE_SUFFIX = ".durable-turns.baseline.js";
const TEMP_SUFFIX = ".durable-turns.tmp";
const DEFAULT_OVERLAP_BYTES = 256 * 1024;
const COPY_BLOCK_BYTES = 1024 * 1024;

function readRange(fd, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const got = fs.readSync(fd, buffer, read, length - read, start + read);
    if (got === 0) break;
    read += got;
  }
  return { buffer, read };
}

// Reads a short region around an offset, for signature checks and drift excerpts.
function readRegion(filePath, start, length) {
  const size = fs.statSync(filePath).size;
  const from = Math.max(0, Math.min(start, size));
  const to = Math.max(from, Math.min(start + length, size));
  if (to === from) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const { buffer, read } = readRange(fd, from, to - from);
    return buffer.subarray(0, read).toString("latin1");
  } finally {
    fs.closeSync(fd);
  }
}

// Calls visit({start, end, text, groups}) once per match of matchRe in the file.
function forEachMatch(filePath, matchRe, options, visit) {
  const chunkBytes = (options && options.chunkBytes) || DEFAULT_CHUNK_BYTES;
  const overlapBytes = (options && options.overlapBytes) || DEFAULT_OVERLAP_BYTES;
  if (overlapBytes >= chunkBytes) throw new Error("overlapBytes must stay below chunkBytes");
  if (matchRe == null) throw new Error("a compiled matcher is required");

  const probes = options && options.probes ? options.probes : null;
  const fd = fs.openSync(filePath, "r");
  let visited = 0;
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return visited;
    let position = 0;
    while (position < size) {
      const wanted = Math.min(chunkBytes, size - position);
      const { buffer, read } = readRange(fd, position, wanted);
      const isFinal = position + read >= size;
      const exclusiveEnd = isFinal ? read : Math.max(0, read - overlapBytes);
      const text = buffer.subarray(0, read).toString("latin1");
      const re = new RegExp(matchRe.source, "g");
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        if (match.index < exclusiveEnd) {
          const whole = match[0];
          if (probes == null || probes.every((probe) => whole.includes(probe))) {
            visited += 1;
            visit({
              start: position + match.index,
              end: position + match.index + whole.length,
              text: whole,
              groups: match.groups || {},
            });
          }
        } else if (!isFinal) {
          break;
        }
      }
      if (isFinal) break;
      position += read - Math.min(overlapBytes, read - 1);
    }
  } finally {
    fs.closeSync(fd);
  }
  return visited;
}

// Streams a chunk and reports whether every needle occurs in it. Used to screen
// carriers by symbol, which is the one pass that touches every candidate file, so
// it must not allocate a 10 MB string per file. The overlap tail is what catches a
// needle that a block boundary happens to split.
function containsAllSymbols(filePath, needles, options) {
  if (!Array.isArray(needles) || needles.length === 0) return true;
  const chunkBytes = (options && options.chunkBytes) || DEFAULT_CHUNK_BYTES;
  const overlapBytes = (options && options.overlapBytes) || DEFAULT_OVERLAP_BYTES;
  const present = new Set();
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let position = 0;
    while (position < size) {
      const wanted = Math.min(chunkBytes, size - position);
      const { buffer, read } = readRange(fd, position, wanted);
      const text = buffer.subarray(0, read).toString("latin1");
      for (const needle of needles) {
        if (!present.has(needle) && text.includes(needle)) present.add(needle);
      }
      if (present.size === needles.length) return true;
      if (position + read >= size) break;
      position += read - Math.min(overlapBytes, read - 1);
    }
  } finally {
    fs.closeSync(fd);
  }
  return present.size === needles.length;
}

// Splices non-overlapping rewrites into the file via a temporary file, then
// renames over the target so a crash cannot leave a half-patched bundle.
function applyRewrites(filePath, rewrites) {
  const ordered = [...rewrites].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error("overlapping rewrites in " + filePath);
    }
  }

  const size = fs.statSync(filePath).size;
  const tempPath = filePath + TEMP_SUFFIX;
  const readFd = fs.openSync(filePath, "r");
  const writeFd = fs.openSync(tempPath, "w", 0o644);
  let failed = false;
  try {
    const block = Buffer.allocUnsafe(COPY_BLOCK_BYTES);
    let writeAt = 0;
    const write = (data) => {
      let offset = 0;
      while (offset < data.length) {
        const got = fs.writeSync(writeFd, data, offset, data.length - offset, writeAt + offset);
        if (got === 0) throw new Error("stalled write to " + tempPath);
        writeAt += got;
        offset += got;
      }
    };
    let cursor = 0;
    const copyTo = (target) => {
      while (cursor < target) {
        const want = Math.min(block.length, target - cursor);
        const got = fs.readSync(readFd, block, 0, want, cursor);
        if (got === 0) throw new Error("short read while rewriting " + filePath);
        write(block.subarray(0, got));
        cursor += got;
      }
    };
    for (const rewrite of ordered) {
      copyTo(rewrite.start);
      write(Buffer.from(rewrite.replacement, "latin1"));
      cursor = rewrite.end;
    }
    copyTo(size);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    fs.closeSync(readFd);
    fs.closeSync(writeFd);
    if (failed && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  try {
    fs.chmodSync(tempPath, fs.statSync(filePath).mode & 0o777);
  } catch {
    // Mode preservation is best effort; the content is what matters.
  }
  fs.renameSync(tempPath, filePath);
  return ordered.length;
}

module.exports = {
  BASELINE_SUFFIX,
  COPY_BLOCK_BYTES,
  containsAllSymbols,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_OVERLAP_BYTES,
  TEMP_SUFFIX,
  applyRewrites,
  forEachMatch,
  readRegion,
};
