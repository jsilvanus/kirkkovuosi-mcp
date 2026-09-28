/**
 * KirkkovuosikalenteriConnector against saved API responses (no network).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KirkkovuosikalenteriConnector, htmlToText } from '../src/connector.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf-8');

function stubFetch(routes: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace('https://www.kirkkovuosikalenteri.fi', '');
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ code: 'rest_invalid_param', message: 'Väärä(t) parametri(t): day' }), { status: 400 });
    return new Response(route.body, { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const DAY_PATH = '/wp-json/kirkkovuosi/v1/day/fi/28.9.2026';

describe('KirkkovuosikalenteriConnector', () => {
  it('converts a day: holy day, texts of all cycles, lectionary, prayers and hymns', async () => {
    const { fn } = stubFetch({ [DAY_PATH]: { body: fixture('day-fi-28.9.2026.json') } });
    const c = new KirkkovuosikalenteriConnector({ fetch: fn });
    const day = await c.day('2026-09-28') as any;
    assert.equal(day.title, 'Maanantai 28.9.2026');
    assert.equal(day.activeYearCycle, 2);
    const ld = day.liturgicalDays[0];
    assert.equal(ld.title, '18. sunnuntai helluntaista');
    assert.equal(ld.candles, 'Kaksi alttarikynttilää');
    assert.equal(ld.yearCycles[2].gospel[0].reference, 'Mark. 2:18–22');
    assert.match(ld.yearCycles[1].firstReading[0].text, /^Jesajan kirjasta, luvusta 44\n\nMuista, Jaakob/);
    assert.equal(ld.lectionary.morning[0].reference, '1. Kor. 7:19–23');
    assert.equal(ld.lectionary.evening[0].reference, '1. Kor. 8:4–13');
    assert.equal(ld.lectionary.dayPsalm[0].reference, 'Ps. 138');
    assert.match(ld.lectionary.morning[1].chant, /kuu_le_ minua, \*/);
    assert.doesNotMatch(ld.lectionary.morning[1].text, /[*_]/);
    assert.ok(ld.prayers.length >= 3);
    assert.equal(ld.hymns[0].hymns[0].number, '186');
    assert.doesNotMatch(JSON.stringify(day), /<[a-z]+[ >]/, 'no HTML left');
  });

  it('limits the answer to the requested sections', async () => {
    const { fn } = stubFetch({ [DAY_PATH]: { body: fixture('day-fi-28.9.2026.json') } });
    const day = await new KirkkovuosikalenteriConnector({ fetch: fn }).day('2026-09-28', 'fi', ['lectionary']) as any;
    const ld = day.liturgicalDays[0];
    assert.ok(ld.lectionary);
    assert.equal(ld.yearCycles, undefined);
    assert.equal(ld.hymns, undefined);
  });

  it('converts the alternative sermon texts to passages (loppiainen)', async () => {
    const { fn } = stubFetch({ '/wp-json/kirkkovuosi/v1/day/fi/6.1.2025': { body: fixture('day-fi-6.1.2025.json') } });
    const day = await new KirkkovuosikalenteriConnector({ fetch: fn }).day('2025-01-06', 'fi', ['texts']) as any;
    const alt = day.liturgicalDays[0].alternativeSermonTexts;
    assert.deepEqual(alt.map((p: any) => p.reference), ['Joh. 8:12', 'Joh. 12:44–47', 'Luuk. 11:29–32']);
    assert.match(alt[0].text, /^Evankeliumista Johanneksen mukaan, luvusta 8\n\n/);
    assert.doesNotMatch(JSON.stringify(alt), /<[a-z]+[ >]|&nbsp;/);
  });

  it('gives Saturday evening the next Sunday\'s first vespers, not the site\'s week-based evening (31.1.2026)', async () => {
    const { fn } = stubFetch({
      '/wp-json/kirkkovuosi/v1/day/fi/31.1.2026': { body: fixture('day-fi-31.1.2026.json') },
      '/wp-json/kirkkovuosi/v1/day/fi/1.2.2026': { body: fixture('day-fi-1.2.2026.json') },
      '/wp-json/kirkkovuosi/v1/day/fi/2.2.2026': { status: 500, body: JSON.stringify({ code: 'no_calendar_day', message: 'Invalid calendar day' }) },
    });
    const c = new KirkkovuosikalenteriConnector({ fetch: fn });
    const sat = await c.lectionary('2026-01-31') as any;
    // The site files 4. sunnuntai loppiaisesta's eve (Hoos. 2:20–25) under this week's Saturday
    assert.equal(sat.liturgicalDays[0].lectionary.evening[0].reference, 'Hoos. 2:20–25');
    assert.equal(sat.tonight.vespers, 'first');
    assert.equal(sat.tonight.date, '2026-02-01');
    assert.match(sat.tonight.of, /^3\. sunnuntai ennen paastonaikaa/);
    assert.deepEqual(sat.tonight.passages.map((p: any) => p.reference), ['1. Moos. 6:9–22', 'Ps. 122']);
    const sun = await c.lectionary('2026-02-01') as any; // next date not covered: still answers
    assert.equal(sun.tonight.vespers, 'second');
    assert.deepEqual(sun.tonight.passages.map((p: any) => p.reference), ['2. Kor. 6:1–2', 'Ps. 8:2–10']);
  });

  it('caches responses', async () => {
    const { fn, calls } = stubFetch({ [DAY_PATH]: { body: fixture('day-fi-28.9.2026.json') } });
    const c = new KirkkovuosikalenteriConnector({ fetch: fn });
    await c.day('2026-09-28');
    await c.day('2026-09-28', 'fi', ['hymns']);
    assert.equal(calls.length, 1);
  });

  it('reports dates the calendar does not cover', async () => {
    const { fn } = stubFetch({ '/wp-json/kirkkovuosi/v1/day/fi/1.1.2040': { status: 500, body: JSON.stringify({ code: 'no_calendar_day', message: 'Invalid calendar day', data: { status: 500 } }) } });
    await assert.rejects(new KirkkovuosikalenteriConnector({ fetch: fn }).day('2040-01-01'), /no data for 2040-01-01/);
  });

  it('rejects invalid dates without calling the site', async () => {
    const { fn, calls } = stubFetch({});
    await assert.rejects(new KirkkovuosikalenteriConnector({ fetch: fn }).day('2026-02-30'), /Invalid date/);
    assert.equal(calls.length, 0);
  });

  it('passes on API errors', async () => {
    const { fn } = stubFetch({});
    await assert.rejects(new KirkkovuosikalenteriConnector({ fetch: fn }).day('2026-09-29'), /400: Väärä/);
  });

  it('maps the colour classes of a month to Finnish colour names', async () => {
    const { fn } = stubFetch({ '/wp-json/liturgicalColors/v1/2026/3': { body: fixture('colors-2026-3.json') } });
    const colors = await new KirkkovuosikalenteriConnector({ fetch: fn }).liturgicalColors(2026, 3) as any;
    assert.equal(colors.days.length, 31);
    assert.deepEqual(colors.days[0], { date: '2026-03-01', colors: ['violetti'], colorsEn: ['purple'], marked: false });
    assert.deepEqual(colors.days.find((d: any) => d.date === '2026-03-22').colors, ['valkoinen']); // Marian ilmestyspäivä
  });

  it('merges the highlight entries and splits two-colour days (Holy Week 2026)', async () => {
    const { fn } = stubFetch({ '/wp-json/liturgicalColors/v1/2026/4': { body: fixture('colors-2026-4.json') } });
    const colors = await new KirkkovuosikalenteriConnector({ fetch: fn }).liturgicalColors(2026, 4) as any;
    assert.equal(colors.days.length, 30, 'one entry per date');
    const byDate = Object.fromEntries(colors.days.map((d: any) => [d.date, d]));
    assert.deepEqual(byDate['2026-04-03'], { date: '2026-04-03', colors: ['musta'], colorsEn: ['black'], marked: true });
    assert.deepEqual(byDate['2026-04-04'].colors, ['musta', 'valkoinen']);
    assert.equal(byDate['2026-04-01'].marked, false);
  });

  it('searches the site', async () => {
    const body = JSON.stringify([{ title: 'Mikkelinp&#228;iv&#228; (Enkelien sunnuntai)', url: 'https://www.kirkkovuosikalenteri.fi/kirkkovuosipaiva/mikkelinpaiva-enkelien-sunnuntai/', subtype: 'liturgical-day' }]);
    const { fn, calls } = stubFetch({ '/wp-json/wp/v2/search?search=mikkelinp%C3%A4iv%C3%A4&per_page=20': { body } });
    const res = await new KirkkovuosikalenteriConnector({ fetch: fn }).search('mikkelinpäivä') as any;
    assert.equal(res.results[0].title, 'Mikkelinpäivä (Enkelien sunnuntai)');
    assert.equal(res.results[0].type, 'liturgical-day');
    assert.equal(calls.length, 1);
  });
});

describe('htmlToText', () => {
  it('keeps line breaks, the psalm indentation and optionally the cadence marks', () => {
    const html = '<p>Herra, kuu<span class="kadenssi-underline">le</span> minua, <span class="kadenssi-star">*</span><br />&#8195;&#8195;huomaa huokaukseni!</p>';
    assert.equal(htmlToText(html), 'Herra, kuule minua,\n  huomaa huokaukseni!');
    assert.equal(htmlToText(html, { chant: true }), 'Herra, kuu_le_ minua, *\n  huomaa huokaukseni!');
  });
});
