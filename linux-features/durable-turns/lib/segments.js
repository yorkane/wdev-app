"use strict";

// Segments: one representation that can both match and render.
//
// A signature token compiles to a list of segments, each one of
//   lit     fixed text
//   quoted  a string literal; the quote characters match as a class (the
//           bundler alternates between backtick and double quote between
//           releases) and the quote that actually matched is captured so a
//           reverse pass renders the identical byte
//   group   a named capture of a minified identifier
//   ref     the same identifier as an earlier group in this shape
//   regex   an opaque regex fragment, for the numeric alternations and
//           lookarounds that carry no text to render
//
// Because a segment list can be compiled and rendered, an edit is two segment
// lists and reversing it is the same operation with the sides exchanged: match
// the patched shape, render the upstream shape. Reversibility therefore needs
// no recorded originals. The invariant that makes that work, namely that every
// identifier the upstream shape consumes also appears on the patched side, is
// checked once when the library loads (assertReversible), so a rule that could
// not be undone fails loudly instead of producing a corrupt revert.

const IDENT = "[A-Za-z_$][\\w$]*";
const QUOTE_CHARS = [String.fromCharCode(96), String.fromCharCode(34)];
const QUOTE_PATTERN = "[" + QUOTE_CHARS.join("") + "]";
const PLACEHOLDER = /<([A-Za-z_][A-Za-z0-9_]*)>/g;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A brace opens a macro only when the balanced content is an uppercase token
// name, so the ordinary code braces inside a shape (function bodies, object
// literals) stay literal and readable.
function macroEnd(token, start) {
  let depth = 0;
  for (let index = start; index < token.length; index += 1) {
    if (token[index] === "{") depth += 1;
    else if (token[index] === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      const directive = token.slice(start + 1, index);
      if (!/^[A-Z][A-Z0-9_]*(:[\s\S]*)?$/.test(directive)) return -1;
      return index;
    }
  }
  return -1;
}

function splitAlternatives(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function assertGroupName(value, label) {
  if (value == null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("{" + label + ":} needs an identifier group name, got " + String(value));
  }
}

// Tokens outside the render model become opaque fragments. They match but
// carry no text, and renderSegments throws if one ever reaches it.
// The tokens that are pure text, spelled as macros so a shape stays readable.
const BRACKETS = { B: "{", E: "}", BS: String.fromCharCode(92) };

// Zero-width assertions: they constrain a position but consume no text, which is
// why they render as the empty string and only ever appear in a matcher.
function zeroWidthSource(directive) {
  const colon = directive.indexOf(":");
  const name = colon < 0 ? directive : directive.slice(0, colon);
  const arg = colon < 0 ? null : directive.slice(colon + 1);
  if (name === "FWD") return "(?=" + expandToken(arg ?? "") + ")";
  if (name === "NOT") return "(?!" + expandToken(arg ?? "") + ")";
  return null;
}

function opaqueSource(directive) {
  const colon = directive.indexOf(":");
  const name = colon < 0 ? directive : directive.slice(0, colon);
  const arg = colon < 0 ? null : directive.slice(colon + 1);
  if (name === "OR") return "(?:" + splitAlternatives(arg).map(expandToken).join("|") + ")";
  if (name === "OPT") return "(?:" + expandToken(arg ?? "") + ")?";
  if (name === "RAW") {
    if (arg == null) throw new Error("{RAW:} needs a pattern");
    return "(?:" + arg + ")";
  }
  const simple = {
    ID: IDENT,
    THIS: "(?:this|" + IDENT + ")",
  }[name];
  if (simple != null && arg == null) return simple;
  throw new Error("unknown signature token {" + directive + "}");
}

function expandToken(token) {
  return segmentsSource(patternSegments(token));
}

function patternSegments(token) {
  if (typeof token !== "string") throw new Error("signature must be a string");
  const segments = [];
  let pending = "";
  let index = 0;
  const flush = () => {
    if (pending.length > 0) segments.push({ kind: "lit", text: pending });
    pending = "";
  };
  while (index < token.length) {
    const open = token[index] === "{" ? macroEnd(token, index) : -1;
    if (open < 0) {
      pending += token[index];
      index += 1;
      continue;
    }
    const directive = token.slice(index + 1, open);
    const colon = directive.indexOf(":");
    const name = colon < 0 ? directive : directive.slice(0, colon);
    const arg = colon < 0 ? null : directive.slice(colon + 1);
    flush();
    if (name === "LIT") {
      if (arg == null || arg.length === 0) throw new Error("{LIT:} needs a literal");
      segments.push({ kind: "quoted", text: arg });
    } else if (name === "CAP") {
      assertGroupName(arg, "CAP");
      segments.push({ kind: "group", name: arg });
    } else if (name === "NCAP") {
      // A capture whose body is not a bare identifier (eg `this` or an id).
      // The name and the body are split on the first colon so a regex pipe in
      // the body is never mistaken for an alternation separator.
      const splitAt = arg == null ? -1 : arg.indexOf("|");
      if (splitAt <= 0 || splitAt === arg.length - 1) {
        throw new Error("{NCAP:name|pattern} needs both parts, got " + String(arg));
      }
      assertGroupName(arg.slice(0, splitAt), "NCAP");
      segments.push({ kind: "group", name: arg.slice(0, splitAt), source: arg.slice(splitAt + 1) });
    } else if (name === "BACK") {
      assertGroupName(arg, "BACK");
      segments.push({ kind: "ref", name: arg });
    } else if (Object.prototype.hasOwnProperty.call(BRACKETS, name) && arg == null) {
      segments.push({ kind: "lit", text: BRACKETS[name] });
    } else if (zeroWidthSource(directive) != null) {
      segments.push({ kind: "look", source: zeroWidthSource(directive) });
    } else {
      segments.push({ kind: "regex", source: opaqueSource(directive) });
    }
    index = open + 1;
  }
  flush();
  return segments;
}

// A rewrite template is emitted verbatim, so every run of text outside a
// placeholder is fixed and every placeholder is an identifier capture.
function templateSegments(template) {
  if (typeof template !== "string") throw new Error("template must be a string");
  const segments = [];
  const chunks = [];
  let pending = "";
  let index = 0;
  while (index < template.length) {
    const open = template[index] === "{" ? macroEnd(template, index) : -1;
    const directive = open < 0 ? null : template.slice(index + 1, open);
    if (directive != null && directive.startsWith("NCAP:")) {
      if (pending.length > 0) chunks.push(pending);
      chunks.push({ ncap: directive.slice(5) });
      pending = "";
      index = open + 1;
      continue;
    }
    if (directive != null && directive.startsWith("BACK:")) {
      // A template re-emits a name the upstream side captured. As a backref it
      // renders that name and, on a revert pass, matches it without opening a
      // second capture of the same name -- which would not even compile.
      if (pending.length > 0) chunks.push(pending);
      chunks.push({ back: directive.slice(5) });
      pending = "";
      index = open + 1;
      continue;
    }
    pending += template[index];
    index += 1;
  }
  if (pending.length > 0) chunks.push(pending);
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      segments.push(...placeholdersIn(chunk));
      continue;
    }
    if (chunk.back != null) {
      assertGroupName(chunk.back, "BACK");
      segments.push({ kind: "ref", name: chunk.back });
      continue;
    }
    const splitAt = chunk.ncap.indexOf("|");
    if (splitAt <= 0 || splitAt === chunk.ncap.length - 1) {
      throw new Error("{NCAP:name|pattern} in a template needs both parts, got " + chunk.ncap);
    }
    assertGroupName(chunk.ncap.slice(0, splitAt), "NCAP");
    segments.push({ kind: "group", name: chunk.ncap.slice(0, splitAt), source: chunk.ncap.slice(splitAt + 1) });
  }
  return segments;
}

function placeholdersIn(text) {
  const segments = [];
  const captured = new Set();
  PLACEHOLDER.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = PLACEHOLDER.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ kind: "lit", text: text.slice(cursor, match.index) });
    // A placeholder used twice is one capture plus a backreference: the patched
    // text must repeat the identical identifier, and a second group with the same
    // name would not even compile.
    segments.push(captured.has(match[1])
      ? { kind: "ref", name: match[1] }
      : { kind: "group", name: match[1] });
    captured.add(match[1]);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "lit", text: text.slice(cursor) });
  return segments;
}

// Renders a segment list, given the values a match captured. A placeholder with
// no value is an error rather than an empty string: silently dropping an
// identifier is how a half-applied bundle gets shipped.
function renderSegments(segments, values, quoteByIndex, defaultQuote) {
  const missing = [];
  const out = segments.map((segment, position) => {
    if (segment.kind === "lit") return segment.text;
    if (segment.kind === "quoted") {
      // The quote the match actually used wins. When a reverse pass cannot see
      // one -- the patched side re-emits the literal itself, so no quote was
      // consumed -- the quote the rest of the region uses is the answer.
      const quote = (quoteByIndex && quoteByIndex[position]) || defaultQuote || QUOTE_CHARS[0];
      if (!QUOTE_CHARS.includes(quote)) {
        throw new Error("durable-turns: invalid quote character at position " + position);
      }
      return quote + segment.text + quote;
    }
    if (segment.kind === "group" || segment.kind === "ref") {
      const value = values[segment.name];
      if (value == null) {
        missing.push(segment.name);
        return "";
      }
      return value;
    }
    if (segment.kind === "look") return "";
    throw new Error("durable-turns: an opaque regex segment carries no text and cannot be rendered");
  }).join("");
  if (missing.length > 0) {
    throw new Error("durable-turns: shape referenced uncaptured placeholder(s): " + missing.join(", "));
  }
  return out;
}

function segmentsSource(segments) {
  const captured = new Set();
  return segments.map((segment, position) => {
    if (segment.kind === "lit") return escapeRegExp(segment.text);
    if (segment.kind === "quoted") {
      // The quote that matched is captured so a reverse pass renders the
      // identical byte instead of guessing at the bundler's choice.
      const quoteGroup = "__q" + position;
      return "(?<" + quoteGroup + ">" + QUOTE_PATTERN + ")" + escapeRegExp(segment.text)
        + "\\k<" + quoteGroup + ">";
    }
    if (segment.kind === "group") {
      // A name a shape already captured is a backreference, not a second
      // capture of the same group (which would not even compile). This is
      // the rule that turns a repeated <placeholder> into one capture plus a
      // reference, and it lets a template re-emit one quote capture -- the
      // follower literal copied into two guards, both arms of the discard
      // ternary -- without opening the group twice.
      if (captured.has(segment.name)) return "\\k<" + segment.name + ">";
      captured.add(segment.name);
      return "(?<" + segment.name + ">" + (segment.source || IDENT) + ")";
    }
    if (segment.kind === "ref") {
      if (!captured.has(segment.name)) {
        throw new Error("durable-turns: a ref to " + segment.name + " has no preceding capture in the same shape");
      }
      return "\\k<" + segment.name + ">";
    }
    if (segment.kind === "look") return "(?:" + segment.source + ")";
    if (segment.kind === "regex") return "(?:" + segment.source + ")";
    throw new Error("durable-turns: unknown segment kind " + segment.kind);
  }).join("");
}

function compileSegments(segments, options) {
  const opts = options || {};
  const source = segmentsSource(segments);
  try {
    const flags = (opts.global ? "g" : "") + (opts.sticky ? "y" : "");
    return new RegExp((opts.anchored ? "^" : "") + source + (opts.anchored ? "$" : ""), flags);
  } catch (error) {
    throw new Error("durable-turns: bad shape /" + source + "/: " + error.message);
  }
}

// Recovers the quote characters a match used, keyed by segment position.
function quotesFromMatch(segments, match) {
  const quotes = {};
  segments.forEach((segment, position) => {
    if (segment.kind !== "quoted") return;
    const value = match.groups && match.groups["__q" + position];
    if (value != null) quotes[position] = value;
  });
  return quotes;
}

function groupNamesOf(segments) {
  const names = new Set();
  for (const segment of segments) {
    if (segment.kind === "group" || segment.kind === "ref") names.add(segment.name);
  }
  return [...names];
}

// Rewrites references to names the region opener already captured into fixed
// text, so an edit can only bind inside the function the region was accepted
// for. An unpinned capture could bind a same-shaped identifier from an
// unrelated function and the rewrite would land in the wrong scope.
function pinSegments(segments, scopeValues) {
  if (scopeValues == null) return segments;
  return segments.map((segment) => {
    if ((segment.kind === "group" || segment.kind === "ref") && scopeValues[segment.name] != null) {
      return { kind: "lit", text: scopeValues[segment.name] };
    }
    return segment;
  });
}

// The reversibility invariant, checked when the library loads: everything the
// upstream shape consumes has to appear on the patched side too, otherwise a
// reverse pass cannot read the value back out of the patched text.
function assertReversible(findSegments, templateSegments, label) {
  const patched = new Set(groupNamesOf(templateSegments));
  const lost = groupNamesOf(findSegments).filter((name) => !patched.has(name));
  if (lost.length > 0) {
    throw new Error("durable-turns: " + label + " is not reversible, patched side loses identifier(s): "
      + lost.join(", "));
  }
}

module.exports = {
  IDENT,
  QUOTE_CHARS,
  assertReversible,
  compileSegments,
  escapeRegExp,
  groupNamesOf,
  patternSegments,
  pinSegments,
  quotesFromMatch,
  renderSegments,
  segmentsSource,
  templateSegments,
};
