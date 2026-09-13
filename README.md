# temporal-fmt-lite

Format Temporal dates with date-fns-style tokens. Just `format()` and `parse()`, nothing else.

This is a frozen, stripped-down copy of [`temporal-fmt`](https://github.com/DirazCoder/temporal-fmt) — same two functions, same locales, ~7x smaller, and it's staying that way. See [why](#why) below.

No deps. Works natively on Node 26+. Bring a polyfill if you're older.

Locale stuff (month/weekday names) needs Node 20+ either way. Haven't tested below that.

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

Calling `setTemporal()` again just overwrites whatever was set before.

## Usage

```js
import { format } from 'temporal-fmt-lite';

const date = Temporal.PlainDate.from('2026-08-04');
format(date, 'yyyy-MM-dd');           // "2026-08-04"
format(date, 'MMMM d, yyyy');         // "August 4, 2026"

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

parse('yyyy-MM-dd HH:mm', '2026-08-04 15:45');    // PlainDateTime
parse('yyyy-MM', '2026-08-04T15:45:30');          // throws, shape doesn't match
parse('yyyy-MM-dd', '2026-02-30');                // throws, Feb 30 isn't a day
```

You'll need an `instanceof` check (or a type guard in TS) to know what you got back, since the return type depends on the format string.

It actually builds the date rather than just pattern-matching, so it'll also catch a weekday that doesn't match the date:

```js
parse('EEEE, yyyy-MM-dd', 'Tuesday, 2026-08-04');  // fine, that's really a Tuesday
parse('EEEE, yyyy-MM-dd', 'Monday, 2026-08-04');   // throws, it's not
```

Some gotchas:

- **`yy` (2-digit year)** works like old-school strptime: `00–68` → `2000–2068`, `69–99` → `1900–1999`. Yes it's arbitrary, but it means `yy` doesn't need some external reference date to resolve.
- **Mixing `hh`/`h` with `HH`/`H`, or using `hh`/`h` without an `a` token, throws.** It won't guess which one you meant even if they'd agree on the hour anyway. Just pick one.
- **`MMMM`/`MMM` name matching only really knows 12-month calendars.** It's built off 12 Gregorian reference dates, so calendars with leap months (Hebrew, for instance) aren't fully covered by name. Numeric `yyyy-MM-dd` is fine regardless.

## Locales

Pass a BCP 47 tag as the third arg and month/weekday/AM-PM names localize. Default is `'en-US'`.

```js
format(date, 'MMMM d, yyyy', { locale: 'fr-FR' });   // "août 4, 2026"
format(date, 'EEEE d MMMM', { locale: 'ar-EG' });    // Arabic names
format(dt, 'h:mm a', { locale: 'ja-JP' });            // "3:45 午後"
```

`a` matches AM/PM case-insensitively when parsing — `pm`, `Pm`, `PM`, whatever.

The name-based tokens (`MMMM`, `MMM`, `EEEE`, `EEE`, `a`) go through `Intl.DateTimeFormat`, so non-Gregorian calendars work too as long as your Temporal object already has one:

```js
const hebrewDate = date.withCalendar('hebrew');
format(hebrewDate, 'MMMM d, yyyy');   // "Av 21, 5786"
```

Same deal for parsing:

```js
parse('MMMM d, yyyy','août 4, 2026', { locale: 'fr-FR' });
parse('h:mm a', '3:45 午後', { locale: 'ja-JP' });
parse('yyyy-MM-dd', '5786-11-21', { locale: 'en-u-ca-hebrew' }); // -u-ca- picks the calendar
```

**One thing that's non-negotiable: numbers always come out as plain 0-9 digits, no matter the locale.** Not a bug. Stuff that reads these values back — logs, APIs, filenames — wants boring ASCII digits, and the padding logic doesn't play nice with Arabic-Indic or Devanagari numerals anyway. If you want localized digits, run them through `Intl.NumberFormat` yourself.

## Tokens

| Token | Meaning            | Example |
|-------|--------------------|---------|
| yyyy  | 4-digit year       | 2026    |
| yy    | 2-digit year       | 26      |
| MMMM  | full month name    | August  |
| MMM   | short month name   | Aug     |
| MM    | 2-digit month      | 08      |
| M     | month              | 8       |
| dd    | 2-digit day        | 04      |
| d     | day                | 4       |
| EEEE  | full weekday       | Tuesday |
| EEE   | short weekday      | Tue     |
| HH    | 2-digit hour (24h) | 15      |
| H     | hour (24h)         | 15      |
| hh    | 2-digit hour (12h) | 03      |
| h     | hour (12h)         | 3       |
| mm    | 2-digit minute     | 45      |
| m     | minute             | 45      |
| ss    | 2-digit second     | 30      |
| s     | second             | 30      |
| SSS   | milliseconds       | 000     |
| a     | AM/PM              | PM      |
| zzz   | IANA time zone id  | America/New_York |

That's all of them, and there won't be more. Use a token your input doesn't support — `HH` on a plain date, say — and it throws a real error instead of quietly giving you `undefined`.

## Why

`temporal-fmt` started as just `format()` and `parse()`. Then it grew a CLI, IDE tooling, a plugin sandbox, business calendars, holiday calendars, recurrence rules, a timezone subsystem... all useful on their own, but together they turned a 200KB install into several megabytes for anyone who just wanted `'yyyy-MM-dd'`. Numbers are in [dirazcoder/temporal-fmt#9](https://github.com/DirazCoder/temporal-fmt/issues/9) if you want them.

This package is that original surface, pulled back out — same `format()`/`parse()` behavior as `temporal-fmt` v0.8.2, rebuilt on the current internals (fixed a ReDoS in some glued-token format strings, a couple parsing edge cases, and a crash on `null` input along the way). Nothing added after v0.8.2 made the cut.

**What that means:**

- No new tokens, functions, or options, ever. If it's not in this README it's not sneaking in later.
- Only security/correctness fixes get backported, and only ones that don't change existing behavior — just make broken edge cases work the way the docs already claimed.
- No LTS promise. This is small and done, not a growing product. If you outgrow it and need the CLI, recurrence rules, business calendars, whatever — go to `temporal-fmt` itself. Since this package's API is a subset of that one's, migrating is just adding stuff, not rewriting.

## Known limitations

- Numbers are always Western digits, see the locale section above.
- Locale tokens need Node 20+. Untested below that.
- You have to hook up Temporal yourself unless you're on Node 26+.
- On native Temporal (Node 26+), locale name tokens (`MMMM`/`MMM`/`EEEE`/`EEE`) can get the wrong month or weekday for dates before ~1582 CE. That's ICU defaulting to the Julian calendar before its Gregorian cutover date, not a bug here — Temporal itself is proleptic Gregorian throughout. See [tc39/ecma402#1003](https://github.com/tc39/ecma402/issues/1003) if you care. Numeric tokens don't go through ICU so they're unaffected.
- Gluing two unpadded numeric tokens together with nothing between them (`Md`, `dM`, `Hm`) is ambiguous sometimes, and `parse()` throws instead of guessing. `"121"` against `yyyy-Md` could be month 1/day 21 or month 12/day 1 — both valid, no way to pick. Inputs that aren't ambiguous still work fine (`"85"` against `yyyy-Md` only has one valid reading). Fix: zero-pad (`MM`/`dd`) or stick a separator in there.

  Also: `Md` alone with no `yyyy` always throws, ambiguous or not — `parse()` needs year+month+day to build a date, period.
- A format string with a ton of glued numeric tokens back to back (like `'Md'.repeat(13)`) gets rejected outright instead of compiled, because that shape causes exponential regex backtracking on near-miss input. Add separators or use padded tokens and it's fine.

## License

Apache-2.0
