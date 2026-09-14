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

// guards against ReDoS: two+ variable-width digit fragments glued together with
// nothing marking where one ends ("MdMdMd...") have multiple ways to split the digit
// run, and a failing match tries every combination — exponential in fragment count.
// a "Md" repeated 13 times took ~2.7s against the naive per-token approach.
// fixed at pattern-build time by collapsing glued runs into one bounded \d{R,2R}
// group (split resolved after the match via enumerateValidSplits in pattern.ts) and
// using yyyy's exact 4-digit fragment whenever a digit-consuming literal follows too,
// not just a digit-leading token. anything left over gets scored against this bit
// budget and rejected if it's still exponential-shaped — normal formats score 0-3
const MAX_AMBIGUITY_BITS = 12;

function widthChoicesBits(choices: number): number {
  return Math.ceil(Math.log2(Math.max(choices, 1)));
}

// does this piece's fragment start by eating a bare digit — used to spot boundaries
// where a variable-width consumer before it could trade digits with what follows
function isDigitConsumingStart(piece: Piece | undefined): boolean {
  if (piece === undefined) return false;
  if (piece.kind === 'literal') return /^[0-9]/.test(piece.value);
  return DIGIT_LEADING_TOKENS.has(piece.value);
}

export interface CapturingPattern {
  regex: RegExp;
  groups: Array<{ name: string; token: string }>; // token pieces, in order
  // glued runs (e.g. "Md") captured by one regex group — groupNames are the per-token
  // names, present in `groups` for structure but not readable off match.groups, since
  // per-token values come from enumerateValidSplits() at match time instead
  ambiguousRuns: Array<{ groupName: string; groupNames: string[]; tokens: string[] }>;
}

// same walk as buildPatternSource() in pattern.ts, but each token piece gets its own
// named capture group so a caller can pull the matched substring back out per token
export function buildCapturingPattern(pieces: Piece[], locale: string): CapturingPattern {
  const groups: Array<{ name: string; token: string }> = [];
  const ambiguousRuns: Array<{ groupName: string; groupNames: string[]; tokens: string[] }> = [];
  let source = '';
  let i = 0;
  let ambiguityBits = 0;

  // tracks the current run of adjacent unpadded-numeric pieces — nothing's broken it
  // yet, so names get recorded in order in case 2+ collapse into one group
  let currentRun: { names: string[]; tokens: string[] } = { names: [], tokens: [] };

  const flushRun = (nextPiece: Piece | undefined) => {
    if (currentRun.tokens.length === 1) {
      // lone token just gets its normal fragment — only charge a bit if the next
      // thing can also eat a digit
      const name = currentRun.names[0]!;
      const token = currentRun.tokens[0]!;
      source += `(?<${name}>${tokenFragment(token, locale)})`;
      if (isDigitConsumingStart(nextPiece)) ambiguityBits += 1;
    } else if (currentRun.tokens.length >= 2) {
      // one bounded digit group covers the same territory the old per-token fragments
      // did (R unpadded tokens accept R to 2R digits total) without the backtracking
      const runName = `r${i++}`;
      const tokenCount = currentRun.tokens.length;
      source += `(?<${runName}>\\d{${tokenCount},${tokenCount * 2}})`;
      // no `groups` entry for the run group itself — consumers reach it through
      // ambiguousRuns[].groupName instead
      ambiguousRuns.push({
        groupName: runName,
        groupNames: currentRun.names,
        tokens: currentRun.tokens,
      });
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
      // possible glued run — hold off and let flushRun collapse 2+ into one group
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

    // yyyy needs the exact 4-digit form whenever anything digit-consuming follows,
    // token or literal — open-ended is only safe otherwise
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
