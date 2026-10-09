"use strict";

// Reverse pass: turn a patched chunk back into the bytes upstream shipped.
//
// This is the same machinery as the forward pass with the two sides exchanged.
// An edit is a pair of shapes, so undoing it means matching the patched shape,
// reading the minified identifiers back out of it, and rendering the upstream
// shape with those values. Nothing is stored about the original file, which is
// why the library insists on reversibility up front (assertReversible).

const { BOUND, resolveRegion } = require("./locate.js");
const { assertVariantGroup, dominantQuote, excerptFor } = require("./plan.js");
const {
  compileSegments,
  patternSegments,
  pinSegments,
  quotesFromMatch,
  renderSegments,
  templateSegments,
} = require("./segments.js");

// How much following region text a restored edit is re-matched against, which
// is what lets a shape end in a zero-width assertion.
const VERIFY_CONTEXT = 400;

function literalsOf(rule) {
  const literals = [];
  for (const edit of rule.edits) {
    for (const segment of patternSegments(edit.find)) {
      if (segment.kind === "quoted") literals.push(segment.text);
    }
  }
  return literals;
}

function valuesFromPatched(edit, body, scopeGroups, regionStart) {
  const segments = pinSegments(templateSegments(edit.template), scopeGroups);
  const re = compileSegments(segments, { global: true });
  const hits = [];
  let match;
  while ((match = re.exec(body)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    hits.push({ index: match.index, length: match[0].length, groups: match.groups || {}, quotes: quotesFromMatch(segments, match), text: match[0] });
    if (hits.length > 1) break;
  }
  return { segments, hits, regionStart };
}

// Plans the inverse rewrites for one rule. Returns the same shape as planRule so
// the caller can treat both passes uniformly; status is BOUND only when the
// patched side bound exactly once and the restored text really matches the
// upstream shape.
function reverseRule(carrier, rule, scan) {
  const resolution = resolveRegionQuietly(carrier, rule, scan);
  const base = {
    ruleId: rule.id,
    file: carrier.relPath,
    status: resolution.status,
    why: resolution.why || null,
    rewrites: [],
    editsTotal: rule.edits.length,
  };
  if (resolution.status !== BOUND) return base;

  const body = resolution.body;
  const scopeGroups = (resolution.region && resolution.region.groups) || {};
  const quote = dominantQuote(body, literalsOf(rule));
  const planned = [];
  const unmatched = [];

  for (const edit of rule.edits) {
    const { hits } = valuesFromPatched(edit, body, scopeGroups, resolution.region.start);
    if (hits.length === 0) {
      unmatched.push(edit.id);
      continue;
    }
    if (hits.length > 1) {
      return { ...base, status: "DRIFTED", why: "patched anchor ambiguous for " + edit.id };
    }
    const hit = hits[0];
    const values = { ...scopeGroups, ...withoutInternal(hit.groups) };
    const restoration = renderSegments(patternSegments(edit.find), values, hit.quotes, quote);
    // Verify rather than trust: the restored text has to be exactly what the
    // upstream shape describes, otherwise the revert silently corrupts. The
    // trailing bytes matter, because a shape can end in a zero-width assertion
    // that only the following code can satisfy. Those bytes are untouched
    // upstream code on both sides, so they are safe to match over.
    const after = body.slice(hit.index + hit.length, hit.index + hit.length + VERIFY_CONTEXT);
    const verify = compileSegments(pinSegments(patternSegments(edit.find), scopeGroups), { sticky: true });
    verify.lastIndex = 0;
    if (!verify.test(restoration + after)) {
      return {
        ...base,
        status: "DRIFTED",
        why: "restored text does not match the upstream shape for " + edit.id,
        excerpt: excerptFor(carrier.filePath, resolution.region.start, rule),
      };
    }
    planned.push({
      editId: edit.id,
      start: resolution.region.start + hit.index,
      end: resolution.region.start + hit.index + hit.length,
      original: hit.text,
      replacement: restoration,
    });
  }

  if (planned.length === 0) {
    return { ...base, status: BOUND, applied: true };
  }

  // A variant rule holds one edit per upstream flavour and exactly one of them
  // ever applies, so the others are expected to be absent here; a non-variant
  // rule has to find every one of its edits or the tree is in a half-patched
  // state that no revert may guess at.
  const isVariantRule = assertVariantGroup(rule);
  if (isVariantRule ? planned.length !== 1 : unmatched.length > 0) {
    return {
      ...base,
      status: "DRIFTED",
      why: "partial patch state, patched anchor absent for " + (unmatched.length > 0
        ? unmatched.join(", ")
        : "exactly one variant of " + rule.variantGroup),
    };
  }

  return { ...base, status: BOUND, applied: false, rewrites: planned };
}

function withoutInternal(groups) {
  const out = {};
  for (const [key, value] of Object.entries(groups)) {
    if (key.startsWith("__q")) continue;
    out[key] = value;
  }
  return out;
}

function resolveRegionQuietly(carrier, rule, scan) {
  try {
    return resolveRegion(carrier.filePath, rule, scan);
  } catch (error) {
    return { status: "DRIFTED", why: "region resolution threw: " + error.message };
  }
}

module.exports = { reverseRule };
