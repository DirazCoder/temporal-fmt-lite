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

import { getTemporal, subscribeToTemporalChanges } from './temporalProvider.js';
import { canonicalCacheKey, normalizeLocaleTag } from './localeVocab.js';

export function pad(n: number, len: number): string {
  // padStart pads the whole string, sign included, so pad(-45, 4) used to
  // come out "0-45" instead of "-045" — split the sign off first.
  const negative = n < 0;
  const digits = String(Math.abs(n)).padStart(len, '0');
  return negative ? '-' + digits : digits;
}

// not every field exists on every Temporal type (PlainDate has no .hour etc) —
// callers check for undefined before formatting a token
export interface TemporalLike {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
  timeZoneId?: string;
  dayOfWeek?: number; // 1=Mon, 7=Sun, per Temporal spec
  calendarId?: string;
  toInstant?: () => unknown;
  toLocaleString?: (locale: string, options: Intl.DateTimeFormatOptions) => string;
}

export interface FormatOptions {
  /** BCP 47 locale tag, e.g. 'en-US', 'fr-FR', 'ar-EG'. Defaults to 'en-US'. */
  locale?: string;
}

export const DEFAULT_LOCALE = 'en-US';

// Intl.DateTimeFormat is expensive to construct and format() can run in a
// loop (rendering a table of dates), so cache by (locale, options).
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHE_SIZE = 500;

function getFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([canonicalCacheKey(locale), options]);
  let formatter = formatterCache.get(key);
  if (formatter) {
    return formatter;
  }
  if (formatterCache.size >= MAX_CACHE_SIZE) {
    // not real LRU, just evicts oldest insertion — fine for this key space
    const oldestKey = formatterCache.keys().next().value;
    if (oldestKey !== undefined) formatterCache.delete(oldestKey);
  }
  // Intl.DateTimeFormat throws on underscore tags like 'en_US' even though every
  // cache key here treats them the same as the hyphenated spelling, so normalize first
  formatter = new Intl.DateTimeFormat(normalizeLocaleTag(locale), options);
  formatterCache.set(key, formatter);
  return formatter;
}

// formatToParts() on a raw Temporal object only works if the engine special-cases
// native Temporal instances — a polyfill's instances don't have those internal slots,
// so the engine falls back to .valueOf(), which the polyfill throws on. probed once,
// memoized, only runs when a format string actually uses a locale-aware token
let nativeSupport: boolean | undefined;
// invalidate whenever setTemporal() swaps implementations, or this'd stay stale —
// see setTemporal() in temporalProvider.ts for the other half
subscribeToTemporalChanges(() => { nativeSupport = undefined; });

function intlSupportsNativeTemporal(): boolean {
  if (nativeSupport === undefined) {
    nativeSupport = false;
      try {
        const temporal = getTemporal();
        new Intl.DateTimeFormat('en-US', { day: 'numeric' })
          .formatToParts(temporal.PlainDate.from({ year: 1970, month: 1, day: 1 }) as Date);
        nativeSupport = true;
      } catch {
        // native Temporal absent, or present but not recognized by Intl — fall back
      }
  }
  return nativeSupport;
}

function intlPart(
  temporal: TemporalLike,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  partType: Intl.DateTimeFormatPartTypes
): string {
  // Intl throws "Mismatching Calendars" if the formatter's calendar doesn't match the
  // object's own. for iso8601 we force 'gregory' instead of leaving it unset — otherwise
  // a locale's -u-ca-* extension (e.g. 'en-u-ca-hebrew') would make MMMM/EEEE render in
  // that calendar while yyyy/dd stay ISO, silently naming a different day than the object
  // actually represents. 'gregory' not 'iso8601' — passing 'iso8601' explicitly makes
  // formatToParts() come back empty for some reason, and they agree on every numeric field
  // anyway since Temporal's iso8601 calendar is proleptic Gregorian throughout
  const calendar = temporal?.calendarId;
  const formatterOptions: Intl.DateTimeFormatOptions = {
    ...options,
    calendar: calendar && calendar !== 'iso8601' ? calendar : 'gregory',
  };

  // toLocaleString() is part of the Temporal spec itself, so polyfills implement the
  // ICU formatting internally and it works without native Intl support
  if (!intlSupportsNativeTemporal()) {
    // same underscore-tag issue getFormatter works around — toLocaleString forwards
    // the locale straight to Intl.DateTimeFormat internally
    return temporal.toLocaleString!(normalizeLocaleTag(locale), formatterOptions);
  }

  // formatToParts() throws on ZonedDateTime directly, so convert to Instant and pass
  // the zone via timeZone instead — not PlainDateTime, that drops the zone and breaks
  // 'MMMM' + 'zzz' combos
  const { toInstant, timeZoneId } = temporal;
  const isZoned = typeof toInstant === 'function' && typeof timeZoneId === 'string';
  // has to be called as temporal.toInstant() because destructuring it off breaks
  // the receiver and throws
  const intlSafeTemporal = isZoned ? temporal.toInstant!() : temporal;
  const nativeOptions: Intl.DateTimeFormatOptions = {
    ...formatterOptions,
    ...(isZoned ? { timeZone: timeZoneId } : {}),
  };

  const formatter = getFormatter(locale, nativeOptions);
  const parts = formatter.formatToParts(intlSafeTemporal as Date | number);
  const index = parts.findIndex((p) => p.type === partType);
  if (index === -1) {
    throw new Error(
      `temporal-fmt-lite: locale "${locale}" produced no "${partType}" part for this token. ` +
      `This usually means the Temporal object is missing the field the token needs.`
    );
  }
  // some locales (ja-JP) split a field across two parts, e.g. month "8" plus a counter
  // suffix "月" as a sibling literal — merge in only if there's no whitespace, so the
  // suffix gets folded in but a real separator doesn't. mirrors partValue() in
  // localeVocab.ts, which builds the vocab this needs to match for parse() to round-trip
  let value = parts[index]!.value;
  const prev = parts[index - 1];
  const next = parts[index + 1];
  if (prev?.type === 'literal' && !/\s/.test(prev.value)) value = prev.value + value;
  if (next?.type === 'literal' && !/\s/.test(next.value)) value = value + next.value;
  return value;
}

// toLocaleString() can't isolate dayPeriod alone the way formatToParts() can — hour +
// dayPeriod together returns a joined string, and dayPeriod alone resolves against a
// different set of periods entirely. day period only depends on the hour anyway, so
// route it through a plain UTC Date instead, which works the same everywhere
function dayPeriodPart(hour: number, locale: string): string {
  const date = new Date(Date.UTC(1970, 0, 1, hour));
  const formatter = getFormatter(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' });
  const part = formatter.formatToParts(date).find((p) => p.type === 'dayPeriod');
  if (!part) {
    throw new Error(`temporal-fmt-lite: locale "${locale}" produced no "dayPeriod" part for token "a".`);
  }
  return part.value;
}

type TokenHandler = (t: TemporalLike, locale: string) => string;

// longest-first since the tokenizer is greedy ("yyyy" has to be tried before "yy") —
// numeric tokens always render in ASCII digits, never locale-native (Arabic-Indic,
// Devanagari etc), since padding non-ASCII digits isn't as simple as padding "3"
export const TOKENS: Array<[string, TokenHandler, keyof TemporalLike]> = [
  ['yyyy', (t) => pad(t.year!, 4), 'year'],
  ['yy', (t) => {
    // -45 % 100 === -45, so truncating negative years to 2 digits doesn't work —
    // and Math.abs() would make 45 CE and 45 BCE render the same
    if (t.year! < 0) {
      throw new Error(
        `temporal-fmt-lite: token "yy" doesn't support negative years (got ${t.year}), ` +
        `since truncating to 2 digits would make it indistinguishable from a ` +
        `positive year. use "yyyy" instead.`
      );
    }
    return pad(t.year! % 100, 2);
  }, 'year'],
  ['MMMM', (t, locale) => intlPart(t, locale, { month: 'long' }, 'month'), 'month'],
  ['MMM', (t, locale) => intlPart(t, locale, { month: 'short' }, 'month'), 'month'],
  ['MM', (t) => pad(t.month!, 2), 'month'],
  ['M', (t) => String(t.month!), 'month'],
  ['dd', (t) => pad(t.day!, 2), 'day'],
  ['d', (t) => String(t.day!), 'day'],
  ['EEEE', (t, locale) => intlPart(t, locale, { weekday: 'long' }, 'weekday'), 'dayOfWeek'],
  ['EEE', (t, locale) => intlPart(t, locale, { weekday: 'short' }, 'weekday'), 'dayOfWeek'],
  ['HH', (t) => pad(t.hour!, 2), 'hour'],
  ['H', (t) => String(t.hour!), 'hour'],
  ['hh', (t) => pad(t.hour! % 12 || 12, 2), 'hour'],
  ['h', (t) => String(t.hour! % 12 || 12), 'hour'],
  ['mm', (t) => pad(t.minute!, 2), 'minute'],
  ['m', (t) => String(t.minute!), 'minute'],
  ['ss', (t) => pad(t.second!, 2), 'second'],
  ['s', (t) => String(t.second!), 'second'],
  ['SSS', (t) => pad(t.millisecond!, 3), 'millisecond'],
  // dayPeriod text is locale-specific (AM/PM in en-US, م/ص in ar-EG) but
  // still needs .hour on the input to compute which period it is
  ['a', (t, locale) => dayPeriodPart(t.hour!, locale), 'hour'],
  ['zzz', (t) => t.timeZoneId!, 'timeZoneId'],
];
