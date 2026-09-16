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

import { getLocaleVocab } from './localeVocab.js';
import { getTemporal } from './temporalProvider.js';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alternation(values: string[], caseInsensitive = false): string {
  const escaped = values.map(escapeRegExp);
  if (!caseInsensitive) return `(?:${escaped.join('|')})`;
  // no per-group case-insensitive flag in JS regex, so fold case by listing both explicitly
  return `(?:${escaped.map(foldCase).join('|')})`;
}

// expands "PM" into "[Pp][Mm]" so any casing matches. only for the day-period token —
// month/weekday names are a different, riskier problem this doesn't try to solve
function foldCase(value: string): string {
  return value.replace(/[a-zA-Z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

// just matches the shape of a zone id/offset instead of alternating all ~400
// real names inline, keeps the regex small. isValidTimeZone() checks it's real after
const TIME_ZONE_SHAPE = '(?:UTC|[+-]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?|[A-Za-z_]+(?:[+-]\\d{1,2})?(?:\\/[A-Za-z0-9_+-]+)*)';

function getTimeZoneFragment(): string {
  return TIME_ZONE_SHAPE;
}

let validZoneSet: Set<string> | undefined;

// UTC isn't a real IANA zone name but zzz has always accepted it, so add it on top
function getValidZoneSet(): Set<string> {
  if (!validZoneSet) {
    validZoneSet = new Set(Intl.supportedValuesOf('timeZone'));
    validZoneSet.add('UTC');
  }
  return validZoneSet;
}

const FIXED_OFFSET_RE = /^[+-]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

// Intl.supportedValuesOf only lists canonical zone ids, not aliases like "Asia/Kolkata" —
// which Temporal resolves fine, so we double check against Temporal before rejecting
export function isValidTimeZone(raw: string): boolean {
  if (FIXED_OFFSET_RE.test(raw) || getValidZoneSet().has(raw)) return true;
  try {
    getTemporal().ZonedDateTime.from({
      year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0,
      timeZone: raw,
    });
    return true;
  } catch {
    return false;
  }
}

// mirrors what pad() in tokens.ts produces, keep in sync
// longer branch listed first (1[0-2] before [1-9]) so a LONE unpadded token greedily prefers
// its 2-digit reading when it's up against a digit-leading literal or the end of the string —
// e.g. "M" against "12" in "M'x'" matches month=12, not month=1 with "2" left over for the
// literal to fail on. this ordering only matters for a lone token like that: two or more
// unpadded tokens glued together (like "Md") don't use this alternation at all anymore — they
// go through the bounded digit group + enumerateValidSplits() below instead, which is what
// actually decides "Md" against "121" (that used to be resolved by this same greedy ordering,
// back when glued runs were still one big alternation; these days a glued run like that comes
// out ambiguous and parse() throws rather than guessing — see enumerateValidSplits())
const NUMERIC_FRAGMENTS: Record<string, string> = {
  yy: '\\d{2}',
  MM: '(?:0[1-9]|1[0-2])',
  M: '(?:1[0-2]|[1-9])',
  dd: '(?:0[1-9]|[12]\\d|3[01])',
  d: '(?:[12]\\d|3[01]|[1-9])',
  HH: '(?:[01]\\d|2[0-3])',
  H: '(?:1\\d|2[0-3]|[0-9])',
  hh: '(?:0[1-9]|1[0-2])',
  h: '(?:1[0-2]|[1-9])',
  mm: '(?:[0-5]\\d)',
  m: '(?:[1-5]\\d|[0-9])',
  ss: '(?:[0-5]\\d)',
  s: '(?:[1-5]\\d|[0-9])',
  SSS: '\\d{3}',
};

// pad() never truncates years, so "yyyy" can run past 4 digits or start with '-' for BCE.
// EXACT is used whenever a digit token follows so year greediness can't eat its digits
const YYYY_EXACT = '-?\\d{4}';
const YYYY_EXTENDED = '-?\\d{4,}';

// every token whose match can start with a digit, so a preceding "yyyy" knows when to use EXACT
export const DIGIT_LEADING_TOKENS = new Set([
  'yyyy', 'yy', 'MM', 'M', 'dd', 'd', 'HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 's', 'SSS',
]);

export function tokenFragment(token: string, locale: string, nextToken?: string): string {
  if (token === 'yyyy') {
    return nextToken !== undefined && DIGIT_LEADING_TOKENS.has(nextToken) ? YYYY_EXACT : YYYY_EXTENDED;
  }

  const numeric = NUMERIC_FRAGMENTS[token];
  if (numeric) {
    return numeric;
  }

  const vocab = getLocaleVocab(locale);
  switch (token) {
    case 'MMMM': return alternation(vocab.monthLong);
    case 'MMM': return alternation(vocab.monthShort);
    case 'EEEE': return alternation(vocab.weekdayLong);
    case 'EEE': return alternation(vocab.weekdayShort);
    // case-insensitive on purpose — "pm"/"Pm"/"PM" all mean the same thing and there's
    // no ambiguity to lose by accepting all of them, unlike Md-style glue elsewhere here
    case 'a': return alternation(vocab.dayPeriod, true);
    case 'zzz': return getTimeZoneFragment();
    default:
      throw new Error(`temporal-fmt-lite: unknown token "${token}"`);
  }
}

// variable-width tokens — glue two of these together and you can get more than one valid
// split ("Md" vs "dM"), so parsePattern.ts handles these separately at match time
export const UNPADDED_NUMERIC_TOKENS = new Set(['M', 'd', 'H', 'h', 'm', 's']);

// same values as NUMERIC_FRAGMENTS, just as data so we can enumerate splits at match time
export const UNPADDED_NUMERIC_RANGES: Record<string, Array<{ digits: 1 | 2; min: number; max: number }>> = {
  M: [{ digits: 1, min: 1, max: 9 }, { digits: 2, min: 10, max: 12 }],
  d: [{ digits: 1, min: 1, max: 9 }, { digits: 2, min: 10, max: 31 }],
  H: [{ digits: 1, min: 0, max: 9 }, { digits: 2, min: 10, max: 23 }],
  h: [{ digits: 1, min: 1, max: 9 }, { digits: 2, min: 10, max: 12 }],
  m: [{ digits: 1, min: 0, max: 9 }, { digits: 2, min: 10, max: 59 }],
  s: [{ digits: 1, min: 0, max: 9 }, { digits: 2, min: 10, max: 59 }],
};

// splits a matched digit run into per-token pieces. the caller (parse.ts) only ever needs to
// know if there were 0, 1, or 2+ valid splits and see up to two examples, so this stops
// counting at 2 — 0 shouldn't happen, 1 is unambiguous, 2+ means the caller throws instead of
// guessing. recursive so a 3+ token run like "Hms" works too, not just pairs
//
// two passes instead of one: countSplitsFrom() below walks the (tokenIndex, offset) grid once,
// memoized, and only ever stores a count (capped at 2) at each cell — never a split array. the
// old version memoized full arrays and built each one with [value, ...restSplit], so on a long
// run every one of the O(n^2) grid cells* paid to copy its child's array on top of just visiting
// it, and a 1000-char glued run (MAX_FORMAT_LENGTH's max) spent a quarter of a second doing nothing
// but that copying. counting first is cheap (integers, not arrays), and reconstructSplit() then
// replays the counts to build at most 2 real splits in a single pass each, with no re-searching.
//
// *why O(n^2) cells and not O(n): tokenIndex always advances by 1 per token, but offset can
// advance by 1 or 2 digits depending on which width matched, so by the time we're n tokens in,
// offset could be anywhere from n to 2n — that's O(n) reachable offsets per tokenIndex, O(n^2)
// total. that's inherent to variable-width tokens, not something memoization alone fixes; it's
// why this still costs tens of milliseconds at the format-length ceiling instead of being free
export function enumerateValidSplits(digits: string, tokens: string[]): number[][] {
  const memo = new Map<number, number>();
  const gridWidth = digits.length + 1;
  const cellKey = (tokenIndex: number, offset: number) => tokenIndex * gridWidth + offset;

  function countSplitsFrom(tokenIndex: number, offset: number): number {
    const key = cellKey(tokenIndex, offset);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let total = 0;
    if (tokenIndex === tokens.length) {
      total = offset === digits.length ? 1 : 0;
    } else {
      const ranges = UNPADDED_NUMERIC_RANGES[tokens[tokenIndex]!];
      if (!ranges) {
        throw new Error(`temporal-fmt-lite: internal error — "${tokens[tokenIndex]}" is not an unpadded numeric token`);
      }
      for (const { digits: width, min, max } of ranges) {
        if (offset + width > digits.length) continue;
        const piece = digits.slice(offset, offset + width);
        if (width === 2 && piece[0] === '0') continue;
        const value = Number(piece);
        if (value < min || value > max) continue;
        total += countSplitsFrom(tokenIndex + 1, offset + width);
        if (total >= 2) break;
      }
      total = Math.min(total, 2);
    }

    memo.set(key, total);
    return total;
  }

  const splitCount = countSplitsFrom(0, 0);
  if (splitCount === 0) return [];

  // walks the same grid countSplitsFrom() already filled in, picking the `skip`-th split at
  // each fork — every count this needs is already memoized, so it's O(tokens.length) lookups
  // total, not a fresh search
  function reconstructSplit(skip: number): number[] {
    const result: number[] = [];
    let tokenIndex = 0;
    let offset = 0;
    let remaining = skip;

    while (tokenIndex < tokens.length) {
      const ranges = UNPADDED_NUMERIC_RANGES[tokens[tokenIndex]!]!;
      let matched = false;
      for (const { digits: width, min, max } of ranges) {
        if (offset + width > digits.length) continue;
        const piece = digits.slice(offset, offset + width);
        if (width === 2 && piece[0] === '0') continue;
        const value = Number(piece);
        if (value < min || value > max) continue;
        const branchCount = memo.get(cellKey(tokenIndex + 1, offset + width)) ?? 0;
        if (branchCount === 0) continue;
        if (remaining >= branchCount) {
          remaining -= branchCount;
          continue;
        }
        result.push(value);
        tokenIndex += 1;
        offset += width;
        matched = true;
        break;
      }
      if (!matched) {
        throw new Error('temporal-fmt-lite: internal error — enumerateValidSplits reconstruction desynced from its own count');
      }
    }

    return result;
  }

  const results: number[][] = [];
  for (let skip = 0; skip < splitCount; skip++) {
    results.push(reconstructSplit(skip));
  }
  return results;
}