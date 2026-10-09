"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { compile, matchCount } = require("./anchor.js");
const { containsAllSymbols, forEachMatch, readRegion } = require("./chunks.js");

const BOUND = "BOUND";
const DRIFTED = "DRIFTED";
const REMOVED = "REMOVED";

function listJsFiles(rootDir, fileSuffix) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(fileSuffix)) out.push(full);
    }
  }
  return out.sort();
}

function scanDirs(extractedDir, scan) {
  const files = [];
  for (const rel of scan.dirs) {
    files.push(...listJsFiles(path.join(extractedDir, rel), scan.fileSuffix));
  }
  return files;
}

// A chunk is a carrier only when it holds the whole turn-lifecycle contract.
// Screening on the symbols is sound because they are property and method names
// that rollup does not rename; the structural signatures do the real work.
function findCarriers(extractedDir, library) {
  const carriers = [];
  for (const filePath of scanDirs(extractedDir, library.scan)) {
    if (containsAllSymbols(filePath, library.carrierSymbols, library.scan)) {
      carriers.push({ filePath, relPath: path.relative(extractedDir, filePath) });
    }
  }
  return carriers;
}

function matchesIn(filePath, token, scan) {
  const found = [];
  const re = compile(token, { global: true });
  forEachMatch(filePath, re, scan, (match) => found.push(match));
  return found;
}

function earliestClose(filePath, closeTokens, from, span, scan) {
  let best = null;
  const limit = from + span;
  for (const token of closeTokens) {
    for (const match of matchesIn(filePath, token, scan)) {
      if (match.start < from) continue;
      if (match.start > limit) break;
      if (best == null || match.end < best.end) best = match;
    }
  }
  return best;
}

function excerptAt(filePath, offset, before, span) {
  const back = before ?? 240;
  const start = Math.max(0, offset - back);
  const text = readRegion(filePath, start, (span ?? 2000) + back);
  return { offset: start, text, caretColumn: offset - start };
}

// Resolves the region a rule operates on.
//
//   open       candidate anchors; upstream shape and this patcher's own output
//              are both accepted, which is what makes a re-apply a no-op
//   close      first match of any of these after the open ends the region;
//              close tokens must be patch-neutral so the region resolves
//              identically before and after an apply
//   invariants structural facts that must hold inside the region for it to be
//              the right place, and that no edit disturbs
//
// A candidate that fails an invariant is rejected rather than patched, so a
// bundle that grew a second copy of the shape reports DRIFTED (ambiguous)
// instead of being silently edited in the wrong function.
function resolveRegion(filePath, rule, scan) {
  const opens = [];
  for (const token of rule.region.open) {
    for (const match of matchesIn(filePath, token, scan)) opens.push({ token, match });
  }
  if (opens.length === 0) {
    return { status: REMOVED, why: "no region anchor matched in " + filePath, candidates: 0 };
  }

  const accepted = [];
  const rejects = [];
  // Two open tokens can describe the same location (the upstream shape and
  // this patcher's own output). Dedupe by start so an already-patched region is
  // one region, not an ambiguous pair.
  const seenStarts = new Set();
  const candidates = [];
  for (const { token, match } of opens) {
    if (seenStarts.has(match.start)) continue;
    seenStarts.add(match.start);
    candidates.push({ token, match });
  }
  for (const { token, match } of candidates) {
    const close = earliestClose(filePath, rule.region.close, match.end, rule.region.span, scan);
    if (close == null) {
      rejects.push({ start: match.start, why: "no region terminator within span " + rule.region.span });
      continue;
    }
    // The opener's captures travel with the region: they name the identifiers
    // that edits must be pinned to (the conversation id, the mode parameter).
    const region = { start: match.start, end: close.end, groups: match.groups || {} };
    const body = readRegion(filePath, region.start, region.end - region.start);
    const failing = rule.region.invariants.filter((invariant) => matchCount(body, invariant) === 0);
    if (failing.length > 0) {
      rejects.push({ start: match.start, why: "invariant(s) absent from region: " + failing.join(" | ") });
      continue;
    }
    accepted.push({ openToken: token, region, body });
  }

  if (accepted.length === 0) {
    const first = opens[0].match;
    return {
      status: DRIFTED,
      why: rejects.length > 0 ? rejects[0].why : "every candidate region failed its invariants",
      rejects,
      region: { start: first.start, end: first.end },
      excerpt: excerptAt(filePath, first.start, rule.region.excerptBefore, rule.region.span),
    };
  }
  if (accepted.length > 1) {
    return {
      status: DRIFTED,
      why: "ambiguous: " + accepted.length + " regions passed their invariants in " + filePath,
      region: accepted[0].region,
      excerpt: excerptAt(filePath, accepted[0].region.start, rule.region.excerptBefore, rule.region.span),
    };
  }
  return { status: BOUND, ...accepted[0] };
}

module.exports = {
  BOUND,
  DRIFTED,
  REMOVED,
  excerptAt,
  findCarriers,
  listJsFiles,
  matchesIn,
  resolveRegion,
  scanDirs,
};
