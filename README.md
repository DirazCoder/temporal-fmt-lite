# temporal-fmt-lite

Format Temporal dates with date-fns-style tokens. Just `format()` and `parse()`, nothing else.

The lite version of [`temporal-fmt`](https://github.com/DirazCoder/temporal-fmt) — same two functions, same locales, no extras. Created back when the main package was several megabytes. As of 0.9.92, `temporal-fmt` itself is down to 508KB (~88% smaller than it used to be), so the size gap is much narrower now. Use this if you genuinely only want `format()` and `parse()` and are sure you'll never need anything else — business calendars, recurrence, intervals, timezone utils, etc. If there's any chance you'll want those later, just use `temporal-fmt/format` and `temporal-fmt/parse` subpaths directly — same lean footprint, no migration needed when you grow into the rest.

No deps. Works natively on Node 26+. Bring a polyfill if you're older.

Locale stuff (month/weekday names) needs Node 20+ either way.

## Install

```sh
npm install temporal-fmt-lite
```

## Getting Temporal

**Node 26+:** you're done, it's built in.

**Older Node:** grab a polyfill like [`temporal-polyfill`](https://github.com/fullcalendar/temporal-polyfill):

```js
import 'temporal-polyfill/global'
import { format, parse } from 'temporal-fmt-lite';
```

Or set it manually if you don't want to touch globals (useful in libraries):

```js
import { Temporal } from 'temporal-polyfill/full';
import { setTemporal, format, parse } from 'temporal-fmt-lite';

setTemporal(Temporal); // do this before calling format/parse
```

## Usage

```js
import { format } from 'temporal-fmt-lite';

const date = Temporal.PlainDate.from('2026-08-04');
format(date, 'yyyy-MM-dd');            // "2026-08-04"
format(date, 'MMMM d, yyyy');          // "August 4, 2026"

const dt = Temporal.PlainDateTime.from('2026-08-04T15:45:30');
format(dt, "MMM d, yyyy 'at' h:mm a"); // "Aug 4, 2026 at 3:45 PM"

const zdt = Temporal.ZonedDateTime.from('2026-08-04T15:45:30-04:00[America/New_York]');
format(zdt, 'yyyy-MM-dd HH:mm zzz');   // "2026-08-04 15:45 America/New_York"
```

Want literal text in the output? Wrap it in single quotes, like `'at'` above. Need an actual quote character? Use `''`.

## Parsing

`parse` figures out whether you get a PlainDate, PlainTime, PlainDateTime, or ZonedDateTime based on which tokens you used:

```js
import { parse } from 'temporal-fmt-lite';

parse('yyyy-MM-dd HH:mm', '2026-08-04 15:45');   // PlainDateTime
parse('yyyy-MM', '2026-08-04T15:45:30');          // throws, shape doesn't match
parse('yyyy-MM-dd', '2026-02-30');                // throws, Feb 30 isn't a day
```

It actually builds the date rather than just pattern-matching, so it'll also catch a weekday that doesn't match the date:

```js
parse('EEEE, yyyy-MM-dd', 'Tuesday, 2026-08-04'); // fine, that's really a Tuesday
parse('EEEE, yyyy-MM-dd', 'Monday, 2026-08-04');  // throws, it's not
```

A few things worth knowing:

- **`yy` (2-digit year)** works like strptime: `00–68` → `2000–2068`, `69–99` → `1900–1999`.
- **Mixing `hh`/`h` with `HH`/`H`, or using `hh`/`h` without an `a` token, throws.** Pick one.
- **`MMMM`/`MMM` name matching only really knows 12-month calendars.** Numeric `yyyy-MM-dd` is fine regardless.

## Locales

Pass a BCP 47 tag and month/weekday/AM-PM names localize. Default is `'en-US'`.

```js
format(date, 'MMMM d, yyyy', { locale: 'fr-FR' }); // "août 4, 2026"
format(date, 'EEEE d MMMM', { locale: 'ar-EG' });  // Arabic names
format(dt, 'h:mm a', { locale: 'ja-JP' });          // "3:45 午後"
```

Same for parsing:

```js
parse('MMMM d, yyyy', 'août 4, 2026', { locale: 'fr-FR' });
parse('h:mm a', '3:45 午後', { locale: 'ja-JP' });
```

Numbers always come out as plain 0-9 digits regardless of locale. If you want localized digits, run them through `Intl.NumberFormat` yourself.

## Tokens

| Token | Meaning            | Example          |
|-------|--------------------|------------------|
| yyyy  | 4-digit year       | 2026             |
| yy    | 2-digit year       | 26               |
| MMMM  | full month name    | August           |
| MMM   | short month name   | Aug              |
| MM    | 2-digit month      | 08               |
| M     | month              | 8                |
| dd    | 2-digit day        | 04               |
| d     | day                | 4                |
| EEEE  | full weekday       | Tuesday          |
| EEE   | short weekday      | Tue              |
| HH    | 2-digit hour (24h) | 15               |
| H     | hour (24h)         | 15               |
| hh    | 2-digit hour (12h) | 03               |
| h     | hour (12h)         | 3                |
| mm    | 2-digit minute     | 45               |
| m     | minute             | 45               |
| ss    | 2-digit second     | 30               |
| s     | second             | 30               |
| SSS   | milliseconds       | 000              |
| a     | AM/PM              | PM               |
| zzz   | IANA time zone id  | America/New_York |

That's all of them, and there won't be more.

## Why

This package exists for one reason: you want `format()` and `parse()` and nothing else, and you want a hard guarantee that nothing else ever gets added. `temporal-fmt` has grown a lot since 0.8.x — CLI, IDE tooling, business calendars, recurrence rules, timezone utils — all useful, but not for everyone. And while the main package is now 508KB (down from 4MB+), this one is still smaller if that matters to you.

**What that means in practice:**

- No new tokens, functions, or options, ever.
- If you outgrow it, migrating to `temporal-fmt` is additive — the API is a strict subset, so nothing breaks.

## Known limitations

- Numbers are always Western digits (see locales section).
- Locale tokens need Node 20+.
- You have to hook up Temporal yourself unless you're on Node 26+.
- On native Temporal (Node 26+), locale name tokens can get the wrong month or weekday for dates before ~1582 CE — that's an ICU quirk.
- Gluing two unpadded numeric tokens together with nothing between them (`Md`, `dM`, `Hm`) is ambiguous and throws. Zero-pad or add a separator.

## License

Apache-2.0
