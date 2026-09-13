/*
 * Copyright 2026 DirazCoder
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Piece } from './tokenize.js';
import { tokenFragment, UNPADDED_NUMERIC_TOKENS, DIGIT_LEADING_TOKENS } from './pattern.js';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Guards against catastrophic backtracking (ReDoS) in the generated regex.
//
// Every ReDoS in this shape of library comes from the same root cause: two
// or more variable-width digit-consuming regex fragments sitting next to
// each other with nothing to tell the engine where one ends and the next
// begins — either glued straight together ("MdMdMd...", "HmsHms...") or
// separated only by a literal that itself starts with a digit ("M1M1M1...").
// Each fragment then has multiple ways to split up the digit run, and on a
// failing match the engine tries every combination — exponential in the
// number of fragments. A "Md" repeated 13 times (26-char format, 40-char
// input) took ~2.7s against the naive per-token-fragment approach; a
// digit-prefixed-literal variant repeated 8 times took ~26s.
//
// Two fixes, both at pattern-build time:
//
//  1. A run of 2+ glued unpadded-numeric tokens becomes ONE bounded digit
//     group `(?<rN>\d{R,2R})` instead of R separate variable-width
//     fragments. The per-token split is resolved after the match via
//     enumerateValidSplits() in pattern.ts — the same machinery parse()
//     already used to detect ambiguous glued runs, so observable behavior
//     is unchanged (unique split resolves; 2+ valid splits still throws;
//     0 splits is a mismatch). A lone \d{R,2R} group backtracks at most
//     R+1 times — linear, not exponential.
//
//  2. "yyyy" now uses the exact -?\d{4} fragment not just when the next
//     TOKEN is digit-leading (existing rule) but also when the next
//     LITERAL starts with a digit. An open-ended -?\d{4,} year glued
//     right up against a digit literal was the cheapest possible
//     exponential blowup (unbounded width choices per year); the exact
//     form still matches everything the open form did in that spot except
//     5+ digit years glued directly to an unquoted digit literal, which is
//     a fine trade.
//
// Anything still left over is bounded by an ambiguity-bit budget: every
// adjacency between a variable-width digit consumer (lone unpadded token,
// or a glued-run group) and a digit-consuming successor costs log2 of the
// consumer's width choices, added to a running total. Go over
// MAX_AMBIGUITY_BITS (12 — a hard ceiling of 4096 backtrack paths) and the
// format string is rejected at build time instead of compiled into
// something that can blow up later. Normal format strings score 0-3.
const MAX_AMBIGUITY_BITS = 12;

function widthChoicesBits(choices: number): number {
  return Math.ceil(Math.log2(Math.max(choices, 1)));
}

// Does this piece's regex fragment start by eating a bare digit? (tokens
// that can match starting with 0-9, and literals whose first char is a
// digit.) Used to spot boundaries where a variable-width digit consumer
// before it could end up trading digits with whatever follows.
function isDigitConsumingStart(piece: Piece | undefined): boolean {
  if (piece === undefined) return false;
  if (piece.kind === 'literal') return /^[0-9]/.test(piece.value);
  return DIGIT_LEADING_TOKENS.has(piece.value);
}

export interface CapturingPattern {
  regex: RegExp;
  groups: Array<{ name: string; token: string }>; // token pieces, in order
  // Runs of 2+ adjacent unpadded-numeric tokens glued together with no
  // literal separator (e.g. "Md", "Hms"). Each run is captured by ONE
  // regex group named `groupName` spanning the whole digit run (R..2R
  // digits) — per-token values are pulled out later by
  // enumerateValidSplits() at match time. `groupNames` is the per-token
  // group names, which show up in `groups` for structure/position but
  // don't exist in the regex itself, so consumers need to read values
  // from the split enumeration, not match.groups.
  ambiguousRuns: Array<{ groupName: string; groupNames: string[]; tokens: string[] }>;
}

/**
 * Same walk as buildPatternSource() in pattern.ts, but each token piece
 * gets its own named capture group (positionally named so the same token,
 * e.g. "yyyy", could in theory appear twice) so a caller can pull the
 * matched substring for each token back out after a successful match.
 */
export function buildCapturingPattern(pieces: Piece[], locale: string): CapturingPattern {
  const groups: Array<{ name: string; token: string }> = [];
  const ambiguousRuns: Array<{ groupName: string; groupNames: string[]; tokens: string[] }> = [];
  let source = '';
  let i = 0;
  let ambiguityBits = 0;

  // tracks the current run of adjacent unpadded-numeric pieces (nothing's
  // broken it yet — no literal, no non-unpadded token). names get recorded
  // in order so a run of 2+ can collapse into one group while each token
  // still gets its own entry in `groups`
  let currentRun: { names: string[]; tokens: string[] } = { names: [], tokens: [] };

  const flushRun = (nextPiece: Piece | undefined) => {
    if (currentRun.tokens.length === 1) {
      // a lone unpadded token just gets its normal two-way fragment.
      // two width choices on their own aren't a problem; only charge an
      // ambiguity bit if the next thing can also eat a digit
      const name = currentRun.names[0]!;
      const token = currentRun.tokens[0]!;
      source += `(?<${name}>${tokenFragment(token, locale)})`;
      if (isDigitConsumingStart(nextPiece)) ambiguityBits += 1;
    } else if (currentRun.tokens.length >= 2) {
      // emit the whole accumulated run as ONE bounded digit group. R
      // unpadded tokens together accept somewhere between R and 2R digits
      // total, and anything outside that range can't match no matter how
      // you split it — so this single group covers exactly the same
      // territory the old per-token fragments did, just without the
      // combinatorial backtracking. worst case here is R+1 width choices,
      // which is linear
      const runName = `r${i++}`;
      const tokenCount = currentRun.tokens.length;
      source += `(?<${runName}>\\d{${tokenCount},${tokenCount * 2}})`;
      // note: no `groups` entry for the run group itself — `groups` only
      // lists per-token pieces (already pushed when we visited them), so
      // consumers still see exactly one entry per token. The regex group
      // itself is only reachable through ambiguousRuns[].groupName
      ambiguousRuns.push({
        groupName: runName,
        groupNames: currentRun.names,
        tokens: currentRun.tokens,
      });
      // a run group next to a digit-consuming successor still keeps its
      // (R+1) width choices at that boundary, so charge the budget for it
      if (isDigitConsumingStart(nextPiece)) {
        ambiguityBits += widthChoicesBits(tokenCount + 1);
      }
    }
    currentRun = { names: [], tokens: [] };
  };

  for (const [idx, piece] of pieces.entries()) {
    if (piece.kind === 'literal') {
      flushRun(piece);
      source += escapeRegExp(piece.value);
      continue;
    }

    if (UNPADDED_NUMERIC_TOKENS.has(piece.value)) {
      // part of a (possible) glued run — hold off emitting the fragment
      // and let flushRun deal with it, so 2+ in a row collapse into one
      // bounded group instead of staying separate
      const name = `g${i++}`;
      groups.push({ name, token: piece.value });
      currentRun.names.push(name);
      currentRun.tokens.push(piece.value);
      continue;
    }

    flushRun(piece);
    const name = `g${i++}`;
    groups.push({ name, token: piece.value });
    const nextPiece = pieces[idx + 1];
    const nextToken = nextPiece?.kind === 'token' ? nextPiece.value : undefined;

    // yyyy's fragment depends on what comes next: exact 4-digit form
    // whenever something digit-consuming follows (digit-leading token —
    // the original rule — OR a literal starting with a digit, added as
    // part of the ReDoS fix above). The open-ended form is only safe
    // when nothing digit-consuming can come right after it.
    if (piece.value === 'yyyy' && nextToken === undefined && isDigitConsumingStart(nextPiece)) {
      source += `(?<${name}>${tokenFragment(piece.value, locale, 'M')})`;
    } else {
      source += `(?<${name}>${tokenFragment(piece.value, locale, nextToken)})`;
    }
  }
  flushRun(undefined);

  if (ambiguityBits > MAX_AMBIGUITY_BITS) {
    throw new Error(
      `temporal-fmt-lite: format string has too many variable-width numeric tokens glued to digit-consuming ` +
      `neighbors (ambiguity score ${ambiguityBits} > ${MAX_AMBIGUITY_BITS}). ` +
      `This shape makes the regex engine backtrack exponentially on near-miss input. ` +
      `Add a non-digit separator between these tokens (e.g. "-" or " ") or use their padded forms (MM/dd/HH/mm/ss).`
    );
  }

  return { regex: new RegExp(`^(?:${source})$`, 'u'), groups, ambiguousRuns };
}
