"use strict";

// Rule planning: locate, rewrite, assert the end state, and derive the inverse.
//
// Terminal-state assertion is the contract. The previous implementation skipped
// an edit whenever its replacement text appeared anywhere in the bundle, which
// is content-triggered rather than state-triggered: a comment, a string literal,
// or unrelated upstream code silently dropped the edit and the build still
// reported success. The worst observed case shipped a guard that referenced an
// undeclared __dtMode, and node --check passed because a syntax check does not
// resolve scope. Here every rule must show the old shape gone AND the new shape
// present inside its own region, before and after an apply, and the inverse is
// verified against the bytes it replaced.

const { BOUND, DRIFTED, REMOVED, resolveRegion } = require("./locate.js");
const { readRegion } = require("./chunks.js");
const {
  QUOTE_CHARS,
  compileSegments,
  patternSegments,
  pinSegments,
  quotesFromMatch,
  renderSegments,
  templateSegments,
} = require("./segments.js");

const MAX_HITS = 5;
const EXCERPT_TAIL = 900;

// The quote style a chunk's minifier uses. All four carriers are backtick,
// but the bundler has been known to switch, and a reverse pass has to restore
// the byte that was really there, so it is detected from the region rather than
// assumed.
function dominantQuote(body, literals) {
  const counts = {};
  for (const quote of QUOTE_CHARS) counts[quote] = 0;
  for (const literal of literals) {
    for (const quote of QUOTE_CHARS) {
      counts[quote] += splitCount(body, quote + literal + quote);
    }
  }
  const backtick = counts[QUOTE_CHARS[0]] ?? 0;
  const double = counts[QUOTE_CHARS[1]] ?? 0;
  return double > backtick ? QUOTE_CHARS[1] : QUOTE_CHARS[0];
}

function splitCount(text, needle) {
  if (needle.length === 0) return 0;
  return text.split(needle).length - 1;
}

function literalsOf(edits) {
  const literals = [];
  for (const edit of edits) {
    for (const segment of patternSegments(edit.find)) {
      if (segment.kind === "quoted") literals.push(segment.text);
    }
  }
  return literals;
}

function excerptFor(filePath, offset, rule) {
  const before = (rule.region && rule.region.excerptBefore) || 240;
  const span = (rule.region && rule.region.span) || 1200;
  const start = Math.max(0, offset - before);
  const text = readRegion(filePath, start, EXCERPT_TAIL + before + span);
  return { offset: start, text, caretColumn: offset - start };
}

// Asserts the terminal state of one rule over a region body.
function assertEndState(body, rule, label) {
  const problems = [];
  for (const token of rule.assertions.gone) {
    const re = compileSegments(patternSegments(token));
    const count = countMatches(body, re);
    if (count > 0) problems.push("target structure still present (" + count + "x): " + token);
  }
  for (const token of rule.assertions.present) {
    const re = compileSegments(patternSegments(token));
    if (countMatches(body, re) === 0) problems.push("expected structure absent: " + token);
  }
  const ordered = rule.assertions.ordered;
  if (Array.isArray(ordered) && ordered.length >= 2) {
    let previous = -1;
    for (const token of ordered) {
      const re = compileSegments(patternSegments(token));
      const match = re.exec(body);
      if (match == null) {
        problems.push("ordering anchor absent: " + token);
        break;
      }
      if (previous >= 0 && match.index < previous) {
        problems.push("ordering violated: " + token + " appears before its prerequisite");
        break;
      }
      previous = match.index;
    }
  }
  if (problems.length > 0) {
    throw new Error("durable-turns: " + label + " end state not reached: " + problems.join(" ; "));
  }
}

function countMatches(text, re) {
  const global = new RegExp(re.source, "g");
  let count = 0;
  let match;
  while ((match = global.exec(text)) !== null) {
    count += 1;
    if (match[0].length === 0) global.lastIndex += 1;
    if (count >= MAX_HITS) break;
  }
  return count;
}

function bindEdits(body, rule, scopeGroups) {
  const bindings = [];
  for (const edit of rule.edits) {
    const segments = pinSegments(patternSegments(edit.find), scopeGroups);
    const re = compileSegments(segments, { global: true });
    const hits = [];
    let match;
    while ((match = re.exec(body)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const groups = match.groups || {};
      hits.push({
        index: match.index,
        length: match[0].length,
        groups: withoutQuoteGroups(groups),
        quotes: quotesFromMatch(segments, match),
        text: match[0],
      });
      if (hits.length >= MAX_HITS) break;
    }
    bindings.push({ edit, segments, hits });
  }
  return bindings;
}

// The positional quote captures are an implementation detail of a segment; they
// must not be mistaken for a rule placeholder.
function withoutQuoteGroups(groups) {
  const out = {};
  for (const [key, value] of Object.entries(groups)) {
    if (key.startsWith("__q")) continue;
    out[key] = value;
  }
  return out;
}

function splice(body, rewrites) {
  const ordered = [...rewrites].sort((left, right) => left.start - right.start);
  let out = "";
  let cursor = 0;
  for (const rewrite of ordered) {
    if (rewrite.start < cursor) throw new Error("durable-turns: overlapping edits inside one region");
    out += body.slice(cursor, rewrite.start);
    out += rewrite.replacement;
    cursor = rewrite.end;
  }
  return out + body.slice(cursor);
}

// Plans one rule against one carrier file. mode "check" resolves and projects
// without ever mutating, and reports BOUND / DRIFTED / REMOVED.
function planRule(carrier, rule, scan, mode) {
  const resolution = resolveQuietly(carrier, rule, scan);
  const base = {
    ruleId: rule.id,
    title: rule.title,
    file: carrier.relPath,
    status: resolution.status,
    why: resolution.why || null,
    rewrites: [],
    variants: [],
    excerpt: resolution.excerpt || null,
    editsTotal: rule.edits.length,
  };
  if (resolution.status !== BOUND) return base;

  const body = resolution.body;
  const scopeGroups = (resolution.region && resolution.region.groups) || {};
  const bindings = bindEdits(body, rule, scopeGroups);
  const bound = bindings.filter((binding) => binding.hits.length === 1);
  const ambiguous = bindings.filter((binding) => binding.hits.length > 1);

  if (ambiguous.length > 0) {
    return drifted(base, carrier, resolution, rule, "anchor ambiguous ("
      + ambiguous.map((b) => b.edit.id + "=" + b.hits.length + "x").join(", ") + ")");
  }

  const variantMembers = rule.edits.filter((edit) => edit.variant != null);
  const isVariantRule = variantMembers.length > 1 && variantMembers.length === rule.edits.length;
  const boundKeys = bound.map((entry) => entry.edit.variantKey).filter(Boolean);

  if (isVariantRule && boundKeys.length > 1) {
    return drifted(base, carrier, resolution, rule, "variant group " + rule.variantGroup
      + " bound more than one variant: " + boundKeys.join(", "));
  }

  const quote = dominantQuote(body, literalsOf(rule.edits));
  const regionStart = resolution.region.start;
  const planned = bound.map((binding) => {
    const hit = binding.hits[0];
    const values = { ...scopeGroups, ...hit.groups };
    const replacement = renderSegments(templateSegments(binding.edit.template), values);
    return {
      editId: binding.edit.id,
      start: regionStart + hit.index,
      end: regionStart + hit.index + hit.length,
      original: hit.text,
      replacement,
    };
  });

  const nothingBound = isVariantRule ? boundKeys.length === 0 : bound.length !== rule.edits.length;
  if (nothingBound) {
    // All anchors absent is acceptable only when the end state already holds;
    // that is the idempotent no-op path, never a shortcut.
    try {
      assertEndState(body, rule, rule.id);
      return { ...base, status: BOUND, applied: true, quote };
    } catch (error) {
      return drifted(base, carrier, resolution, rule, error.message);
    }
  }

  const projected = splice(body, planned.map((entry) => ({
    start: entry.start - regionStart,
    end: entry.end - regionStart,
    replacement: entry.replacement,
  })));

  try {
    assertEndState(projected, rule, rule.id);
  } catch (error) {
    return drifted(base, carrier, resolution, rule, error.message);
  }

  // Reversibility is verified, not assumed: undoing the rewrite must reproduce
  // the bytes that were there, or the rule is broken and must fail now rather
  // than corrupt a bundle later.
  // Offsets have to be re-based against the projected text: every earlier edit
  // moved everything after it by the difference between its replacement and the
  // text it replaced.
  let delta = 0;
  const inverse = planned.map((entry) => {
    const start = entry.start - regionStart + delta;
    delta += entry.replacement.length - entry.original.length;
    return { start, end: start + entry.replacement.length, replacement: entry.original };
  });
  const reverted = splice(projected, inverse);
  if (reverted !== body) {
    return drifted(base, carrier, resolution, rule, "reverse round-trip is not byte-identical");
  }

  return {
    ...base,
    status: BOUND,
    applied: false,
    rewrites: planned,
    variants: boundKeys,
    projected,
    quote,
    editsApplied: planned.length,
  };
}

function drifted(base, carrier, resolution, rule, why) {
  const offset = resolution.region ? resolution.region.start : 0;
  return {
    ...base,
    status: DRIFTED,
    why,
    excerpt: resolution.excerpt || excerptFor(carrier.filePath, offset, rule),
  };
}

function resolveQuietly(carrier, rule, scan) {
  try {
    return resolveRegion(carrier.filePath, rule, scan);
  } catch (error) {
    return { status: DRIFTED, why: "region resolution threw: " + error.message };
  }
}

// Plans every rule against a carrier and folds the non-overlapping rewrites
// into one pass over the file. A rule that does not bind makes the whole carrier
// fail: ciPolicy required-upstream means an unbound rule breaks the build.
function planCarrier(carrier, rules, scan, mode) {
  const plans = rules.map((rule) => planRule(carrier, rule, scan, mode));
  const failed = plans.filter((plan) => plan.status !== BOUND);
  const rewrites = [];
  for (const plan of plans) {
    for (const rewrite of plan.rewrites) rewrites.push(rewrite);
  }
  return { carrier, plans, failed, rewrites };
}

module.exports = {
  BOUND,
  DRIFTED,
  REMOVED,
  assertEndState,
  dominantQuote,
  excerptFor,
  planCarrier,
  planRule,
  splice,
};
