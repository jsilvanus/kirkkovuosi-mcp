---
name: kirkkovuosikalenteri-api
description: Fetch the texts of the Finnish Lutheran church year (Sunday readings of all three year cycles, psalm, hallelujah verse, prayers, hymns, altar candles, the weekly lectionary's prayer-hour texts, liturgical colours) from the public JSON API of kirkkovuosikalenteri.fi / kyrkoarskalendern.fi. Use when an answer needs the actual Bible or prayer texts for a date and neither the anno-api MCP tools nor the kirkkovuosi-mcp tools are available.
---

# Kirkkovuosikalenteri public API

Kirkkovuosikalenteri (https://www.kirkkovuosikalenteri.fi) is the church-year calendar of the Evangelical-Lutheran Church of Finland, published by Kirkkohallitus. Its WordPress site has an open, unauthenticated JSON API. Use it to get the *texts*: every reading, psalm and prayer comes as full text (Raamattu 1992 translation), not only as references.

Prefer, in this order:
1. The anno-api MCP tools (`church_day`, `daily_lectionary`, …) or REST API (`/api/v1/date/:date`) — same texts, plus propers and rubrics, no network dependency.
2. The kirkkovuosi-mcp tools (`kvk_day`, `kvk_lectionary`, `kvk_liturgical_colors`, `kvk_search`) — this API already cleaned up (HTML removed, cycles named).
3. This API directly, as described below.

## Endpoints

| Request | Returns |
|---|---|
| `GET https://www.kirkkovuosikalenteri.fi/wp-json/kirkkovuosi/v1/day/fi/{D.M.YYYY}` | Everything for one date, in Finnish |
| `GET https://www.kirkkovuosikalenteri.fi/wp-json/kirkkovuosi/v1/day/sv/{D.M.YYYY}` | The same in Swedish (Kyrkoårskalendern) |
| `GET https://www.kirkkovuosikalenteri.fi/wp-json/liturgicalColors/v1/{YYYY}/{M}` | Liturgical colour of every date of a month |
| `GET https://www.kirkkovuosikalenteri.fi/wp-json/wp/v2/search?search={text}&per_page=20` | Site search (holy days by name) |

**Date format.** `D.M.YYYY` (`28.9.2026`); `DD.MM.YYYY` (`04.10.2026`) also works. ISO dates (`2026-09-28`) are rejected with HTTP 400 `rest_invalid_param`. Convert before calling.

**Coverage.** Roughly 2022–2035. Outside it the day endpoint answers HTTP **500** `{"code":"no_calendar_day","message":"Invalid calendar day"}` — this means "no data for this date", not a server fault; do not retry.

**"Today"** is the date in Finland (Europe/Helsinki), not UTC.

**Be polite.** One request per date answers everything for that date; cache it and do not re-fetch per field. Send a descriptive `User-Agent`. No bulk crawling.

## Day response

```jsonc
{
  "day_title": "Maanantai 28.9.2026",
  "day_url": "https://www.kirkkovuosikalenteri.fi/kalenteripaiva/…",
  "day_volume": "volume-2",          // the ACTIVE year cycle (vuosikerta): volume-1 | volume-2 | volume-3
  "color": null,                     // almost always null — use the colours endpoint
  "candles": null,                   // null at this level — see liturgical_days[].candles
  "liturgical_days": [ { … } ]       // usually one; several on e.g. Christmas Eve, Good Friday, Easter Eve
}
```

On a **weekday** `liturgical_days[0]` is the preceding Sunday or feast whose material is used that week (e.g. Monday 28.9.2026 → "18. sunnuntai helluntaista"). Treat it as "the week's holy day", not as a feast on that date. `day_title` names the actual date.

### `liturgical_days[]`

| Field | Content |
|---|---|
| `title` | Holy day name, e.g. `"18. sunnuntai helluntaista"` |
| `subtitle` | Theme, e.g. `"Kristityn vapaus"` |
| `url` | The holy day's page (`/kirkkovuosipaiva/<slug>/`) |
| `period` | Period of the church year, e.g. `"Helluntaijakso, helluntain jälkeinen aika"` |
| `description` | HTML: introduction to the day's theme |
| `color` | Always null in practice — use the colours endpoint |
| `candles` | Altar candles: `"Kuusi alttarikynttilää"` (6, main feasts), `"Neljä alttarikynttilää"` (4), `"Kaksi alttarikynttilää"` (2), `"Ei alttarikynttilöitä"` (none, e.g. Good Friday) |
| `bible_texts` | HTML: the psalm (antiphon + psalm + reference) and the hallelujah verse or, in Lent, the psalm verse (psalmilause) |
| `first_liturgical_volume`, `second_…`, `third_…` | Readings of year cycles 1, 2 and 3 (see below). Pick the one `day_volume` names |
| `alternative_sermon_texts` | `false`, or `[{ bible_verse, bible_text }]`: optional alternative sermon texts |
| `hymns` | `[{ group_name, hymns: [{ number, name, url }] }]`; groups e.g. "Alkuvirsiä", "Päivän virsiä", "Lisää virsisuosituksia". `number` is the Virsikirja number (string) |
| `daily_prayers` | `[{ verse }]`: prayers of the day, `verse` is HTML |
| `lectionary` | Weekly lectionary (viikkolektionaari) for **this date** (below) |
| `altar_image`, `post_thumbnail` | `{ full_size_url, sizes }` images; `altar_image` shows the colour and candles |

### Year-cycle readings

```jsonc
"second_liturgical_volume": {
  "passages-1": [ { "passage_1_verse": "Jes. 44:21–22", "passage_1_text": "<p><b>Jesajan kirjasta, luvusta 44</b></p><p>Muista, Jaakob, …" } ],  // 1st reading (Old Testament)
  "passages-2": [ { "passage_2_verse": "…", "passage_2_text": "…" } ],   // 2nd reading (epistle)
  "gospels":    [ { "passage_3_verse": "Mark. 2:18–22", "passage_3_text": "…" } ]  // gospel
}
```

Each is an array (normally one item). `*_verse` is the reference; `*_text` is HTML whose first bold paragraph is the reading's announcement ("Jesajan kirjasta, luvusta 44"). Year cycle = `day_volume`; do not guess it from the calendar year (2025–26 is cycle 2, 2026–27 cycle 3; the cycle changes on the 1st Sunday of Advent).

### Weekly lectionary (`lectionary`)

Each key is `false` or an array of `{ verse, text }` (reference + HTML text). The meaning depends on the weekday:

| Key | Monday–Saturday | Sunday / holy day |
|---|---|---|
| `morning` | Morning prayer: `[reading, psalm]` | `[psalm]` |
| `noon` | Midday prayer: `[psalm]` | `[psalm]` |
| `evening` | Evening prayer: `[reading, psalm]`; on **Saturday** meant as the coming Sunday's first vespers (see below) | The Sunday's second vespers: `[reading, psalm]` |
| `psalms` | The day's psalm (varies with season and weekday) | The day's psalm |
| `eve` | `false` | The Sunday's or feast's first vespers (aattoilta): reading + psalm, prayed the evening before |
| `week` | Usually `false` | The week's psalm |
| `apocrypha` | Usually `false` | Reading from the Apocrypha (e.g. Sir.) |

**Vespers.** Saturday has no vespers of its own: Saturday evening is the coming Sunday's first vespers, and the Sunday's own `evening` is its second vespers. The site stores Saturday's `evening` with the *week*, so in years where the week is followed by a different Sunday or feast (kynttilänpäivä, Marian ilmestyspäivä, mikkelinpäivä, pyhäinpäivä, or a Sunday dropped at the end of Epiphany or of the church year) it gives the wrong texts. For the evening before a Sunday or feast, fetch the **next date** and use its `eve`. Some feasts have `eve` only in the years they fall on a Sunday (loppiainen: 2. Kor. 4:3–6); the eve is the feast's own, so any year's `eve` of that feast will do.

An hour lists its reading(s) first and its psalm last. Some hours have two readings (a biblical one and one from the Apocrypha), and a reading can itself be from the Psalms, so go by position. The site writes a few psalm references without `Ps.` (`147:1–11`). The hour psalms of `morning`/`noon`/`evening` are fixed per weekday; the readings follow the week's holy day.

### Text formatting

All texts are HTML. To show them as plain text:
- `<p>` → paragraph break, `<br>` → line break; strip the other tags; decode entities (`&nbsp;`, `&#8211;`, `&#228;` …).
- Psalm lines indented with `&#8195;` (em space) are the second half of a verse; keep a small indent.
- Psalm chant marks: `<span class="kadenssi-underline">le</span>` marks the cadence syllable and `<span class="kadenssi-star">*</span>` the half-verse break. Drop them for reading; keep them (e.g. `kuu_le_ minua, *`) only if the user wants to sing the psalm.
- In `bible_texts`, `<p class="bible-place">` holds a reference.

## Colours endpoint

`GET /wp-json/liturgicalColors/v1/2026/4` returns an array of FullCalendar events:

```jsonc
[
  { "start": "2026-04-01", "end": "2026-04-02", "classNames": ["liturgical-color--purple", "d-…"] },
  { "start": "2026-04-03", "end": "2026-04-04", "classNames": ["liturgical-color--black"] },
  { "start": "2026-04-04", "end": "2026-04-05", "classNames": ["liturgical-color--black_liturgical-color--white"] },
  { "start": "2026-04-03", "end": "2026-04-04", "rendering": "background" }
]
```

- The colour is in the `liturgical-color--<name>` class: `white` valkoinen, `purple` violetti, `green` vihreä, `red` punainen, `black` musta.
- A class joined with `_` means two colours on one date (Holy Saturday: black, then white for the Easter Vigil).
- Entries with `"rendering": "background"` carry no colour; they are highlight markers (seen on some Holy Week dates). Merge all entries of a date before answering.
- `end` is exclusive.

## Search endpoint

`GET /wp-json/wp/v2/search?search=mikkelinpäivä&per_page=20` → `[{ id, title, url, type, subtype }]`. `subtype: "liturgical-day"` results are holy days; `title` is HTML-escaped (`Mikkelinp&#228;iv&#228;`). Search finds a holy day's page, not its date: to get texts, work out the date and call the day endpoint.

## Example

```js
const date = new Date('2026-09-28');
const d = `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
const res = await fetch(`https://www.kirkkovuosikalenteri.fi/wp-json/kirkkovuosi/v1/day/fi/${d}`,
  { headers: { 'User-Agent': 'my-app (contact@example.org)' } });
if (res.status === 500) throw new Error(`Kirkkovuosikalenteri has no data for ${d}`);
const day = await res.json();
const ld = day.liturgical_days[0];
const cycle = { 'volume-1': 'first', 'volume-2': 'second', 'volume-3': 'third' }[day.day_volume];
const gospel = ld[`${cycle}_liturgical_volume`].gospels[0];   // { passage_3_verse, passage_3_text }
const morning = ld.lectionary.morning;                         // [{ verse, text }, …] or false
```

## Answering the user

- Say which holy day the texts belong to, and on a weekday that they are the week's texts (e.g. "viikko 18. sunnuntain helluntaista jälkeen").
- Give the reference with every text, and the year cycle for Sunday readings.
- Quote texts as they are; do not paraphrase Scripture or the prayers.
- Credit the source: "Lähde: Kirkkovuosikalenteri, © Kirkkohallitus. Raamatun tekstit: Raamattu 1992, © Kirkkohallitus."
