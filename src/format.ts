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

import { TOKENS, DEFAULT_LOCALE, type TemporalLike, type FormatOptions } from './tokens.js';
import { tokenize, type Piece } from './tokenize.js';
import { MAX_FORMAT_LENGTH } from './constants.js';

const HANDLER_BY_TOKEN = new Map(TOKENS.map(([tok, fn, field]) => [tok, { fn, field }]));

// pre-tokenized format strings, keyed by formatStr — locale doesn't change the
// tokenization step, only per-token rendering, so the piece list is shared
// across locales. format strings are short hand-written literals reused across
// many calls (rendering a table of dates, say), so this avoids re-tokenizing every call
const tokenizeCache = new Map<string, Piece[]>();
const MAX_TOKENIZE_CACHE_SIZE = 500;

function getPieces(formatStr: string): Piece[] {
  let pieces = tokenizeCache.get(formatStr);
  if (pieces) return pieces;
  if (tokenizeCache.size >= MAX_TOKENIZE_CACHE_SIZE) {
    const oldestKey = tokenizeCache.keys().next().value;
    if (oldestKey !== undefined) tokenizeCache.delete(oldestKey);
  }
  pieces = tokenize(formatStr);
  // deep-freeze before caching — the same array instance goes out to every caller
  // of format() with this exact formatStr, and a caller reaching in and writing
  // pieces[0].value would poison the shared cache for every future call. frozen
  // objects make that throw (ESM is strict mode) instead of silently corrupting state
  for (const piece of pieces) Object.freeze(piece);
  Object.freeze(pieces);
  tokenizeCache.set(formatStr, pieces);
  return pieces;
}

/**
 * Format a Temporal.PlainDate, PlainTime, PlainDateTime, or ZonedDateTime
 * using a date-fns-style token string.
 *
 * @example
 * format(zdt, "MMM d, yyyy 'at' h:mm a") // "Aug 4, 2026 at 3:45 PM"
 */
export function format(temporal: TemporalLike, formatStr: string, options: FormatOptions = {}): string {
  if (formatStr.length > MAX_FORMAT_LENGTH) {
    throw new Error(
      `temporal-fmt-lite: format string exceeds maximum length of ${MAX_FORMAT_LENGTH} characters ` +
      `(got ${formatStr.length}).`
    );
  }

  // null/undefined used to leak a raw V8 TypeError from the first field read
  // ("Cannot read properties of null (reading 'year')") — every other entry point
  // validates its input with a real error, and this is the most common wrong-input mistake
  if (temporal === null || temporal === undefined) {
    throw new Error(
      `temporal-fmt-lite: format() expected a Temporal.PlainDate / PlainTime / PlainDateTime / ` +
      `ZonedDateTime (or a TemporalLike field bag), got ${String(temporal)}`
    );
  }

  const locale = options.locale ?? DEFAULT_LOCALE;
  const pieces = getPieces(formatStr);
  let result = '';

  for (const piece of pieces) {
    if (piece.kind === 'literal') {
      result += piece.value;
      continue;
    }

    const handler = HANDLER_BY_TOKEN.get(piece.value);
    if (!handler) {
      // shouldn't happen — tokenize() only emits tokens from TOKENS
      throw new Error(`temporal-fmt-lite: unknown token "${piece.value}"`);
    }

    if (temporal[handler.field] === undefined) {
      throw new Error(
        `temporal-fmt-lite: token "${piece.value}" requires "${handler.field}", ` +
        `which this Temporal object doesn't have. ` +
        `(e.g. PlainDate has no time fields, PlainTime has no date fields)`
      );
    }

    result += handler.fn(temporal, locale);
  }

  return result;
}