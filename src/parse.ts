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

import { DEFAULT_LOCALE, type FormatOptions } from './tokens.js';
import { tokenize } from './tokenize.js';
import { buildCapturingPattern, type CapturingPattern } from './parsePattern.js';
import { enumerateValidSplits, isValidTimeZone } from './pattern.js';
import { getLocaleVocab, canonicalCacheKey } from './localeVocab.js';
import { getTemporal } from './temporalProvider.js';
import { MAX_FORMAT_LENGTH, MAX_INPUT_LENGTH } from './constants.js';

// format strings are short hand-written literals reused across many calls —
// cache the compiled capturing pattern per (formatStr, locale) pair instead
// of rebuilding it every call.
const patternCache = new Map<string, CapturingPattern>();
const MAX_CACHE_SIZE = 500;

function getPattern(formatStr: string, locale: string): CapturingPattern {
  const key = JSON.stringify([canonicalCacheKey(locale), formatStr]);
  let pattern = patternCache.get(key);
  if (pattern) {
    return pattern;
  }
  if (patternCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = patternCache.keys().next().value;
    if (oldestKey !== undefined) patternCache.delete(oldestKey);
  }
  pattern = buildCapturingPattern(tokenize(formatStr), locale);
  patternCache.set(key, pattern);
  return pattern;
}

// requires an explicit `-u-ca-` extension (e.g. 'en-u-ca-hebrew') to apply a non-Gregorian
// calendar, per parse()'s own docstring — 'gregory' counts as "no calendar" so the default
// locale keeps constructing plain ISO 8601. used to key off resolvedOptions().calendar
// instead (a locale's *default* calendar, whether the caller asked for one or not), which
// broke th-TH silently: its default is 'buddhist', so plain Gregorian digits parsed 543
// years off, while format() has no matching calendar step and just prints the object's
// own ISO fields either way
const calendarCache = new Map<string, string | undefined>();
const MAX_CALENDAR_CACHE_SIZE = 500;

function resolveCalendar(locale: string): string | undefined {
  // canonicalCacheKey is memoized (localeVocab.ts), so the common path — repeated
  // parse() calls with the same locale — doesn't construct a fresh Intl.Locale per
  // call just to compute this cache key. a genuinely malformed tag still throws
  // from new Intl.Locale() the same way it always did
  const canonicalLocale = canonicalCacheKey(locale);
  if (calendarCache.has(canonicalLocale)) {
    return calendarCache.get(canonicalLocale);
  }
  if (calendarCache.size >= MAX_CALENDAR_CACHE_SIZE) {
    const oldestKey = calendarCache.keys().next().value;
    if (oldestKey !== undefined) calendarCache.delete(oldestKey);
  }
  let calendar: string | undefined;
  const parts = canonicalLocale.split('-');
  const extensionIndex = parts.indexOf('u');
  const calendarKeyIndex = extensionIndex === -1 ? -1 : parts.indexOf('ca', extensionIndex + 1);
  if (calendarKeyIndex !== -1 && calendarKeyIndex + 1 < parts.length) {
    const resolved = new Intl.DateTimeFormat(canonicalLocale).resolvedOptions().calendar;
    calendar = resolved === 'gregory' ? undefined : resolved;
  }
  calendarCache.set(canonicalLocale, calendar);
  return calendar;
}

interface Fields {
  year?: number;
  twoDigitYear?: number;
  month?: number;
  day?: number;
  hour?: number;
  hour12?: number;
  dayPeriodRaw?: string;
  isPM?: boolean;
  minute?: number;
  second?: number;
  millisecond?: number;
  timeZoneId?: string;
  weekdayExpected?: number;
  weekdayRaw?: string;
}

function assignField<T>(fields: Fields, key: keyof Fields, value: T): void {
  (fields as Record<string, T | undefined>)[key] = value;
}

function applyGroup(fields: Fields, token: string, raw: string, locale: string, formatStr: string): void {
  const vocab = getLocaleVocab(locale);
  switch (token) {
    case 'yyyy':
      assignField(fields, 'year', Number(raw));
      break;
    case 'yy':
      assignField(fields, 'twoDigitYear', Number(raw));
      break;
    case 'MM': case 'M':
      assignField(fields, 'month', Number(raw));
      break;
    case 'MMMM':
      assignField(fields, 'month', vocab.monthLong.indexOf(raw) + 1);
      break;
    case 'MMM':
      assignField(fields, 'month', vocab.monthShort.indexOf(raw) + 1);
      break;
    case 'dd': case 'd':
      assignField(fields, 'day', Number(raw));
      break;
    case 'EEEE':
      assignField(fields, 'weekdayRaw', raw);
      assignField(fields, 'weekdayExpected', vocab.weekdayLong.indexOf(raw) + 1);
      break;
    case 'EEE':
      assignField(fields, 'weekdayRaw', raw);
      assignField(fields, 'weekdayExpected', vocab.weekdayShort.indexOf(raw) + 1);
      break;
    case 'HH': case 'H':
      assignField(fields, 'hour', Number(raw));
      break;
    case 'hh': case 'h':
      assignField(fields, 'hour12', Number(raw));
      break;
    case 'mm': case 'm':
      assignField(fields, 'minute', Number(raw));
      break;
    case 'ss': case 's':
      assignField(fields, 'second', Number(raw));
      break;
    case 'SSS':
      assignField(fields, 'millisecond', Number(raw));
      break;
    case 'a': {
      // matches case-insensitively (see pattern.ts's foldCase for the 'a' token's regex
      // fragment), so the lookup here has to fold too, or "pm" would pass the regex and
      // then fail this indexOf against the exact-case vocab
      const periodIndex = vocab.dayPeriod.findIndex((p) => p.toLowerCase() === raw.toLowerCase());
      if (periodIndex < 0) throw new Error(`temporal-fmt-lite: unknown day period "${raw}" for locale "${locale}".`);
      assignField(fields, 'dayPeriodRaw', raw);
      assignField(fields, 'isPM', periodIndex === 1);
      break;
    }
    case 'zzz':
      assignField(fields, 'timeZoneId', raw);
      break;
  }
}

// emulates strptime (POSIX) for 2-digit years so the result doesn't depend
// on the current clock: 00-68 -> 2000-2068, 69-99 -> 1900-1999
// https://www.man7.org/linux//man-pages/man3/strptime.3p.html
function resolveYear(fields: Fields): number | undefined {
  if (fields.year !== undefined && fields.twoDigitYear !== undefined) {
    throw new Error(
      'temporal-fmt-lite: format string mixes "yyyy" and "yy" year representations.'
    );
  }
  if (fields.year !== undefined) return fields.year;
  if (fields.twoDigitYear !== undefined) {
    return fields.twoDigitYear <= 68 ? 2000 + fields.twoDigitYear : 1900 + fields.twoDigitYear;
  }
  return undefined;
}

function resolveHour(fields: Fields, formatStr: string, locale: string): number | undefined {
  if (fields.hour !== undefined && fields.hour12 !== undefined) {
    throw new Error(
      `temporal-fmt-lite: format string "${formatStr}" mixes a 24-hour token ("HH"/"H") with a ` +
      `12-hour token ("hh"/"h").`
    );
  }
  if (fields.hour !== undefined) {
    if (fields.dayPeriodRaw !== undefined) {
      const vocab = getLocaleVocab(locale);
      const expected = fields.hour < 12 ? vocab.dayPeriod[0] : vocab.dayPeriod[1];
      if (fields.dayPeriodRaw !== expected) {
        throw new Error(
          `temporal-fmt-lite: format string "${formatStr}" contains a day period that contradicts the 24-hour value.`
        );
      }
    }
    return fields.hour;
  }
  if (fields.hour12 !== undefined) {
    if (fields.isPM === undefined) {
      throw new Error(
        `temporal-fmt-lite: format string "${formatStr}" uses a 12-hour token ("hh"/"h") without an "a" token, ` +
        `so parse() can't tell AM from PM.`
      );
    }
    return (fields.hour12 % 12) + (fields.isPM ? 12 : 0);
  }
  return undefined;
}

/**
 * Parses `input` against `formatStr` and builds the real Temporal value it
 * describes: a `Temporal.PlainDate`, `PlainTime`, `PlainDateTime`, or
 * `ZonedDateTime` depending on which tokens are present. Returns `unknown` —
 * this package has no ambient `Temporal` types to return a real one against.
 *
 * Pass a locale tag with a `-u-ca-` extension (e.g. `'en-u-ca-hebrew'`) to
 * parse into a non-Gregorian calendar.
 *
 * Throws if `input` doesn't match `formatStr`'s shape, or if it matches but
 * describes an impossible date (e.g. Feb 30) or self-contradictory data
 * (e.g. a weekday name that doesn't match the actual date).
 *
 * @example
 * parse('yyyy-MM-dd HH:mm', '2026-08-04 15:45') // Temporal.PlainDateTime
 */
export function parse(formatStr: string, input: string, options: FormatOptions = {}): unknown | undefined {
  if (formatStr.length > MAX_FORMAT_LENGTH) {
    throw new Error(
      `temporal-fmt-lite: format string exceeds maximum length of ${MAX_FORMAT_LENGTH} characters ` +
      `(got ${formatStr.length}).`
    );
  }

  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error(
      `temporal-fmt-lite: input exceeds maximum length of ${MAX_INPUT_LENGTH} characters (got ${input.length}).`
    );
  }

  const locale = options.locale ?? DEFAULT_LOCALE;
  const calendar = resolveCalendar(locale);
  const pattern = getPattern(formatStr, locale);
  const match = pattern.regex.exec(input);
  if (!match) {
    throw new Error(`temporal-fmt-lite: no valid pattern matches the format string and input shape`);
  }

  if (pattern.groups.length === 0) {
    throw new Error(`temporal-fmt-lite: format string "${formatStr}" has no tokens — nothing to parse into a value.`);
  }

  // the regex's zzz fragment only matches a bounded zone-id *shape* (see TIME_ZONE_SHAPE
  // in pattern.ts) rather than alternating every real IANA name inline, so a shape match
  // isn't proof of a real zone yet — check each captured zzz group against the actual
  // zone list here. kept as the same "no valid pattern matches" error the inline-alternation
  // version used to throw, since from the caller's perspective this is still the regex
  // rejecting the input, just checked in two steps instead of one
  for (const { name, token } of pattern.groups) {
    if (token === 'zzz' && !isValidTimeZone(match.groups![name]!)) {
      throw new Error(`temporal-fmt-lite: no valid pattern matches the format string and input shape`);
    }
  }

  // a run of 2+ adjacent unpadded-numeric tokens with no literal separator (e.g. "Md",
  // "dM", "Hms") is captured by a single bounded digit group in the regex (see
  // buildCapturingPattern in parsePattern.ts — per-token variable-width fragments made
  // near-miss matching exponential in the number of glued tokens, a real ReDoS risk
  // closed there). each run's per-token split is resolved here: a unique valid split
  // resolves silently (same as what the old regex's own greedy match produced), 2+
  // valid splits is genuine ambiguity in the input and still throws, exactly as before
  const runValues = new Map<string, string>();
  for (const run of pattern.ambiguousRuns) {
    const runDigits = match.groups![run.groupName]!;
    const splits = enumerateValidSplits(runDigits, run.tokens);
    // the bounded digit group (\d{R,2R}) matches a wider range of raw digit strings than
    // the old per-token fragments did — it accepts anything of the right total length,
    // then this step checks whether any per-token split is actually valid. a span that
    // matched the group's width window but names no valid split (e.g. "99" against "Md" —
    // no valid month/day split) needs to be rejected the same way the old per-token regex
    // rejected it at match time
    if (splits.length === 0) {
      throw new Error(`temporal-fmt-lite: no valid pattern matches the format string and input shape`);
    }
    if (splits.length > 1) {
      throw new Error(
        `temporal-fmt-lite: "${runDigits}" in format string "${formatStr}" is ambiguous — ` +
        `${splits.length} different ways to read tokens "${run.tokens.join('')}" (with no separator ` +
        `between them) are all individually valid (e.g. ${JSON.stringify(splits[0])} vs ${JSON.stringify(splits[1])}). ` +
        `parse() won't guess; add a separator between these tokens, or use their padded form ` +
        `(e.g. "MM" instead of "M") so each one has a fixed width.`
      );
    }
    run.groupNames.forEach((name, idx) => runValues.set(name, String(splits[0]![idx])));
  }

  const fields: Fields = {};
  // per-token values for glued-run members come from the split enumeration above
  // (runValues); every other token reads its own regex group directly
  for (const { name, token } of pattern.groups) {
    const raw = runValues.get(name) ?? match.groups![name]!;
    applyGroup(fields, token, raw, locale, formatStr);
  }

  const year = resolveYear(fields);
  const hour = resolveHour(fields, formatStr, locale);
  const { month, day, minute, second, millisecond, timeZoneId, weekdayExpected, weekdayRaw } = fields;

  const hasAnyDatePart = year !== undefined || month !== undefined || day !== undefined;
  const hasFullDate = year !== undefined && month !== undefined && day !== undefined;
  if (hasAnyDatePart && !hasFullDate) {
    throw new Error(
      `temporal-fmt-lite: format string "${formatStr}" has an incomplete date — ` +
      `year, month, and day tokens must all be present together.`
    );
  }

  const hasTime = hour !== undefined || minute !== undefined || second !== undefined || millisecond !== undefined;

  if (timeZoneId !== undefined && !(hasFullDate && hasTime)) {
    throw new Error(
      `temporal-fmt-lite: format string "${formatStr}" has a "zzz" token but needs a full date and time ` +
      `to build a ZonedDateTime.`
    );
  }

  if (weekdayExpected !== undefined && !hasFullDate) {
    throw new Error(
      `temporal-fmt-lite: format string "${formatStr}" has a weekday token ("EEEE"/"EEE") but needs ` +
      `a full date to validate it against.`
    );
  }

  if (!hasFullDate && !hasTime) {
    // shouldn't happen — every token maps to a date, time, zone, or
    // weekday field, and weekday-without-date already threw above
    throw new Error(`temporal-fmt-lite: format string "${formatStr}" has no date or time tokens to parse.`);
  }

  const temporal = getTemporal();
  const timeFields = { hour: hour ?? 0, minute: minute ?? 0, second: second ?? 0, millisecond: millisecond ?? 0 };
  // omitted entirely for the default calendar (see resolveCalendar) so
  // construction stays plain ISO 8601 unless a caller's locale asks for
  // something else — Temporal calendars don't apply to time-only values.
  const calendarField = calendar ? { calendar } : {};

  // overflow: 'reject' — without it Temporal *clamps* out-of-range fields
  // (Feb 30 silently becomes Feb 28) instead of throwing, which would
  // contradict the "throws on genuinely invalid data" behavior parse() promises.
  const reject = { overflow: 'reject' as const };

  let result: unknown;
  try {
    if (timeZoneId !== undefined) {
      result = temporal.ZonedDateTime.from({ year: year!, month: month!, day: day!, ...timeFields, ...calendarField, timeZone: timeZoneId }, reject);
    } else if (hasFullDate && hasTime) {
      result = temporal.PlainDateTime.from({ year: year!, month: month!, day: day!, ...timeFields, ...calendarField }, reject);
    } else if (hasFullDate) {
      result = temporal.PlainDate.from({ year: year!, month: month!, day: day!, ...calendarField }, reject);
    } else {
      result = temporal.PlainTime.from(timeFields, reject);
    }
  } catch (err) {
    throw new Error(
      `temporal-fmt-lite: "${input}" doesn't describe a valid date/time for format "${formatStr}": ` +
      `${(err as Error).message}`
    );
  }

  if (weekdayExpected !== undefined) {
    const actual = (result as { dayOfWeek: number }).dayOfWeek;
    if (actual !== weekdayExpected) {
      const vocab = getLocaleVocab(locale);
      throw new Error(
        `temporal-fmt-lite: "${weekdayRaw}" doesn't match the actual weekday (${vocab.weekdayLong[actual - 1]}) ` +
        `for the parsed date.`
      );
    }
  }

  return result;
}