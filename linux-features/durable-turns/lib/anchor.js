"use strict";

// Thin compatibility layer over lib/segments.js.
//
// The signature language itself lives in segments.js, which is the only place
// that knows how a token becomes both a matcher and a renderer. This module
// keeps the small count/first-match helpers that the scanner and the assertion
// layer use, so nothing else has to think about regex sources.

const {
  IDENT,
  QUOTE_CHARS,
  compileSegments,
  patternSegments,
  renderSegments,
  segmentsSource,
  templateSegments,
} = require("./segments.js");

const MAX_COUNT = 64;

function compile(token, options) {
  return compileSegments(patternSegments(token), options);
}

function matchCount(text, token) {
  const re = compile(token, { global: true });
  let count = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    count += 1;
    if (match[0].length === 0) re.lastIndex += 1;
    if (count >= MAX_COUNT) break;
  }
  return count;
}

function firstMatch(text, token) {
  return compile(token).exec(text);
}

module.exports = {
  CB: QUOTE_CHARS[0],
  DQ: QUOTE_CHARS[1],
  IDENT,
  compile,
  expand: (token) => segmentsSource(patternSegments(token)),
  firstMatch,
  matchCount,
  patternSegments,
  renderSegments,
  templateSegments,
};
