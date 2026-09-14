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

// name lists for the locale-aware tokens (MMMM, MMM, EEEE, EEE, a)
// small and fixed per locale (12 months, 7 weekdays, 2 day periods) so we build once and cache

export interface LocaleVocab {
  monthLong: string[]; // index 0 = January
  monthShort: string[];
  weekdayLong: string[]; // index 0 = Monday, per Temporal's dayOfWeek numbering
  weekdayShort: string[];
  dayPeriod: string[]; // typically [AM-ish, PM-ish], deduped
}

// Intl constructors reject underscore tags like 'en_US' outright, so normalize
// to hyphens here once instead of every Intl.* call site hitting the same RangeError
export function normalizeLocaleTag(locale: string): string {
  return locale.replace(/_/g, '-');
}

// Intl treats 'en-US'/'en-us'/'en_US' as the same locale but a plain string-keyed
// Map doesn't, so mixed spellings used to fragment across cache entries everywhere.
// falls back to the raw string on a bad tag — errors should surface from the actual
// Intl call downstream, not from building a cache key. memoized since it's hot
const canonicalKeyCache = new Map<string, string>();
const MAX_CANONICAL_KEY_CACHE = 500;

export function canonicalCacheKey(locale: string): string {
  const hit = canonicalKeyCache.get(locale);
  if (hit !== undefined) return hit;
  let key: string;
  try {
    key = new Intl.Locale(normalizeLocaleTag(locale)).toString().toLowerCase();
  } catch {
    key = locale;
  }
  if (canonicalKeyCache.size >= MAX_CANONICAL_KEY_CACHE) {
    const oldestKey = canonicalKeyCache.keys().next().value;
    if (oldestKey !== undefined) canonicalKeyCache.delete(oldestKey);
  }
  canonicalKeyCache.set(locale, key);
  return key;
}

const vocabCache = new Map<string, LocaleVocab>();
const MAX_VOCAB_CACHE_SIZE = 500;

// ja-JP splits month "8" and its counter suffix "月" into two parts, but
// toLocaleString() glues them into "8月" — reading only the tagged part dropped
// the suffix here. only merges adjacent literals, since dayPeriod/weekday carry
// an extra hour part that'd get wrongly absorbed by a join-everything approach
function partValue(formatter: Intl.DateTimeFormat, date: Date, type: Intl.DateTimeFormatPartTypes): string {
  const parts = formatter.formatToParts(date);
  const index = parts.findIndex((p) => p.type === type);
  if (index === -1) {
    throw new Error(`temporal-fmt-lite: locale produced no "${type}" part while building match vocabulary.`);
  }
  let value = parts[index]!.value;
  const prev = parts[index - 1];
  const next = parts[index + 1];
  // skip whitespace literals (the separator before "AM") — only a
  // no-space suffix like ja-JP's "月" should get folded in
  if (prev?.type === 'literal' && !/\s/.test(prev.value)) value = prev.value + value;
  if (next?.type === 'literal' && !/\s/.test(next.value)) value = value + next.value;
  return value;
}

// two entries rendering identically means parse()'s indexOf lookup can never tell them
// apart — weekdays get caught by parse()'s dayOfWeek cross-check but months don't, so
// catch both here once with a clear error instead of silently resolving to the wrong month
function assertNoCollision(names: string[], label: string, locale: string): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    const prior = seen.get(names[i]!);
    if (prior !== undefined) {
      throw new Error(
        `temporal-fmt-lite: locale "${locale}" renders ${label} index ${prior} and ${i} identically ` +
        `("${names[i]}"). parse() can't reliably tell these apart for this locale/token, so this ` +
        `combination isn't supported.`
      );
    }
    seen.set(names[i]!, i);
  }
}

export function getLocaleVocab(locale: string): LocaleVocab {
  const cacheKey = canonicalCacheKey(locale);
  const cached = vocabCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const intlLocale = normalizeLocaleTag(locale);
  const monthLongFmt = new Intl.DateTimeFormat(intlLocale, { month: 'long', timeZone: 'UTC' });
  const monthShortFmt = new Intl.DateTimeFormat(intlLocale, { month: 'short', timeZone: 'UTC' });
  const monthLong: string[] = [];
  const monthShort: string[] = [];
  for (let m = 0; m < 12; m++) {
    const date = new Date(Date.UTC(2020, m, 1));
    monthLong.push(partValue(monthLongFmt, date, 'month'));
    monthShort.push(partValue(monthShortFmt, date, 'month'));
  }
  assertNoCollision(monthLong, 'MMMM month', locale);
  assertNoCollision(monthShort, 'MMM month', locale);

  const weekdayLongFmt = new Intl.DateTimeFormat(intlLocale, { weekday: 'long', timeZone: 'UTC' });
  const weekdayShortFmt = new Intl.DateTimeFormat(intlLocale, { weekday: 'short', timeZone: 'UTC' });
  const weekdayLong: string[] = [];
  const weekdayShort: string[] = [];
  // 2024-01-01 is a Monday (UTC) — walk 7 days from there for weekday names
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.UTC(2024, 0, 1 + d));
    weekdayLong.push(partValue(weekdayLongFmt, date, 'weekday'));
    weekdayShort.push(partValue(weekdayShortFmt, date, 'weekday'));
  }
  // redundant with parse()'s dayOfWeek cross-check, but gives a clearer error
  assertNoCollision(weekdayLong, 'EEEE weekday', locale);
  assertNoCollision(weekdayShort, 'EEE weekday', locale);

  const dayPeriodFmt = new Intl.DateTimeFormat(intlLocale, { hour: 'numeric', hour12: true, timeZone: 'UTC' });
  const am = partValue(dayPeriodFmt, new Date(Date.UTC(2020, 0, 1, 1)), 'dayPeriod');
  const pm = partValue(dayPeriodFmt, new Date(Date.UTC(2020, 0, 1, 13)), 'dayPeriod');
  const dayPeriod = [...new Set([am, pm])];

  const vocab: LocaleVocab = { monthLong, monthShort, weekdayLong, weekdayShort, dayPeriod };
  if (vocabCache.size >= MAX_VOCAB_CACHE_SIZE) {
    const oldestKey = vocabCache.keys().next().value;
    if (oldestKey !== undefined) vocabCache.delete(oldestKey);
  }
  vocabCache.set(cacheKey, vocab);
  return vocab;
}
