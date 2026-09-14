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
// longer branch listed first (1[0-2] before [1-9]) so glued tokens like "Md" against "121"
// resolve as month=12/day=1 instead of month=1/day=21 — found via combinatorial.test.js
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

// splits a matched digit run into per-token pieces, one array per valid split
// 0 splits shouldn't happen, 1 is unambiguous, 2+ means the caller should throw instead of guessing
// recursive so a 3+ token run like "Hms" works too, not just pairs
export function enumerateValidSplits(digits: string, tokens: string[]): number[][] {
  const memo = new Map<string, number[][]>();

  function solve(tokenIndex: number, offset: number): number[][] {
    const key = `${tokenIndex}:${offset}`;
    const cached = memo.get(key);
    if (cached) {
      return cached;
    }

    if (tokenIndex === tokens.length) {
      const result = offset === digits.length ? [[]] : [];
      memo.set(key, result);
      return result;
    }

    const token = tokens[tokenIndex];
    const ranges = UNPADDED_NUMERIC_RANGES[token!];
    if (!ranges) {
      throw new Error(`temporal-fmt-lite: internal error — "${token}" is not an unpadded numeric token`);
    }

    const results: number[][] = [];
    for (const { digits: width, min, max } of ranges) {
      if (offset + width > digits.length) continue;
      const piece = digits.slice(offset, offset + width);
      if (width === 2 && piece[0] === '0') continue;
      const value = Number(piece);
      if (value < min || value > max) continue;

      for (const restSplit of solve(tokenIndex + 1, offset + width)) {
        results.push([value, ...restSplit]);
        if (results.length === 2) break;
      }
      if (results.length === 2) break;
    }

    memo.set(key, results);
    return results;
  }

  return solve(0, 0);
}
