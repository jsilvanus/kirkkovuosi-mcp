/**
 * Kirkkovuosikalenteri connector: wraps the public JSON API of
 * kirkkovuosikalenteri.fi (Finnish) and kyrkoarskalendern.fi (Swedish),
 * the ELCF's church year calendar. Knows nothing about MCP or OAuth.
 *
 * Endpoints used (WordPress REST API, no authentication):
 *   /wp-json/kirkkovuosi/v1/day/{fi|sv}/{D.M.YYYY}   everything for a date
 *   /wp-json/liturgicalColors/v1/{year}/{month}      colour of each day of a month
 *   /wp-json/wp/v2/search?search=…                   site search
 *
 * Texts © Kirkkohallitus; Bible texts Raamattu (1992) © Kirkkohallitus.
 */

export interface ConnectorContext {
  accessToken?: string;
  userId?: string;
}

export type Language = 'fi' | 'sv';

export type Section = 'texts' | 'lectionary' | 'prayers' | 'hymns';
export const SECTIONS: Section[] = ['texts', 'lectionary', 'prayers', 'hymns'];

export interface ConnectorOptions {
  baseUrl?: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  /** How long responses are cached in memory (default 6 h; the site's data changes rarely). */
  cacheTtlMs?: number;
  userAgent?: string;
}

export interface Passage {
  reference: string;
  text: string;
  /** Psalms: the text with cadence marks ("*" pause, "_x_" syllable where the cadence starts). */
  chant?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Today's date (YYYY-MM-DD) in Finland. */
export function todayInFinland(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ─── HTML → text ────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * HTML → plain text with line breaks. The second half-verse of psalms stays
 * indented by two spaces. With `chant`, the cadence marks are kept.
 */
export function htmlToText(html: string | null | undefined, { chant = false } = {}): string {
  if (!html) return '';
  const s = decodeEntities(html
    .replace(/\r/g, '')
    .replace(/<span class="kadenssi-underline">([^<]*)<\/span>/g, chant ? '_$1_' : '$1')
    .replace(/\s*<span class="kadenssi-star">\*<\/span>/g, chant ? ' *' : '')
    .replace(/<br\s*\/?>\s*\n?/g, '\n')
    .replace(/<\/p>\s*<p[^>]*>/g, '\n\n')
    .replace(/<\/?(p|div|h\d)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, ''));
  return s
    .split('\n')
    .map(line => {
      const normalised = line.replace(/ /g, '  ');
      const indented = /^\s{2,}\S/.test(normalised);
      return (indented ? '  ' : '') + normalised.replace(/\s+/g, ' ').trim();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function passage(reference: string | undefined, html: string | undefined): Passage | null {
  if (!reference) return null;
  const text = htmlToText(html);
  const chant = htmlToText(html, { chant: true });
  return { reference: decodeEntities(reference).trim(), text, ...(chant !== text ? { chant } : {}) };
}

// ─── Raw API shapes (only what we read) ─────────────────────────────────────

interface RawItem { verse?: string; text?: string }
interface RawLiturgicalDay {
  title?: string;
  subtitle?: string;
  url?: string;
  period?: string;
  description?: string;
  color?: string | null;
  candles?: string | null;
  bible_texts?: string;
  hymns?: { group_name?: string; hymns?: { number?: string; name?: string; url?: string }[] }[];
  alternative_sermon_texts?: { bible_verse?: string; bible_text?: string }[] | false;
  first_liturgical_volume?: Record<string, Record<string, string>[]>;
  second_liturgical_volume?: Record<string, Record<string, string>[]>;
  third_liturgical_volume?: Record<string, Record<string, string>[]>;
  lectionary?: Record<string, RawItem[] | false>;
  daily_prayers?: RawItem[];
}
interface RawDay {
  day_title?: string;
  day_url?: string;
  day_volume?: string;
  color?: string | null;
  candles?: string | null;
  liturgical_days?: RawLiturgicalDay[];
}

// ─── Conversion ─────────────────────────────────────────────────────────────

const VOLUMES = { 1: 'first_liturgical_volume', 2: 'second_liturgical_volume', 3: 'third_liturgical_volume' } as const;

function volumePassages(list: Record<string, string>[] | undefined, n: 1 | 2 | 3): Passage[] {
  return (list ?? []).map(x => passage(x[`passage_${n}_verse`], x[`passage_${n}_text`])).filter((p): p is Passage => p !== null);
}

function yearCycle(volume: Record<string, Record<string, string>[]> | undefined) {
  return {
    firstReading: volumePassages(volume?.['passages-1'], 1),
    secondReading: volumePassages(volume?.['passages-2'], 2),
    gospel: volumePassages(volume?.gospels, 3),
  };
}

const LECTIONARY_FIELDS: Record<string, string> = {
  eve: 'firstVespers', morning: 'morning', noon: 'noon', evening: 'evening',
  psalms: 'dayPsalm', week: 'weekPsalm', apocrypha: 'apocrypha',
};

function lectionary(raw: RawLiturgicalDay['lectionary']) {
  const out: Record<string, Passage[]> = {};
  for (const [field, name] of Object.entries(LECTIONARY_FIELDS)) {
    const list = raw?.[field];
    out[name] = Array.isArray(list) ? list.map(x => passage(x.verse, x.text)).filter((p): p is Passage => p !== null) : [];
  }
  return out;
}

function convertDay(raw: RawLiturgicalDay, sections: Set<Section>, activeCycle: number | null) {
  const day: Record<string, unknown> = {
    title: raw.title ?? null,
    subtitle: raw.subtitle || null,
    period: raw.period ?? null,
    url: raw.url ?? null,
    color: raw.color || null,
    candles: raw.candles || null,
    description: htmlToText(raw.description) || null,
  };
  if (sections.has('texts')) {
    day.psalmAndVerse = htmlToText(raw.bible_texts) || null;
    const cycles: Record<string, ReturnType<typeof yearCycle>> = {};
    for (const n of [1, 2, 3] as const) cycles[n] = yearCycle(raw[VOLUMES[n]]);
    day.activeYearCycle = activeCycle;
    day.yearCycles = cycles;
    day.alternativeSermonTexts = (raw.alternative_sermon_texts || [])
      .map(x => passage(x.bible_verse, x.bible_text))
      .filter((p): p is Passage => p !== null);
  }
  if (sections.has('lectionary')) day.lectionary = lectionary(raw.lectionary);
  if (sections.has('prayers')) day.prayers = (raw.daily_prayers ?? []).map(p => htmlToText(p.verse)).filter(Boolean);
  if (sections.has('hymns')) {
    day.hymns = (raw.hymns ?? []).map(g => ({
      group: g.group_name ?? null,
      hymns: (g.hymns ?? []).map(h => ({ number: h.number ?? null, name: h.name ?? null, url: h.url ?? null })),
    }));
  }
  return day;
}

const COLOR_CLASSES: Record<string, string> = {
  white: 'valkoinen', green: 'vihreä', red: 'punainen', black: 'musta', violet: 'violetti', purple: 'violetti', blue: 'sininen',
};

// ─── Connector ──────────────────────────────────────────────────────────────

export class KirkkovuosikalenteriConnector {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();

  constructor(options: ConnectorOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://www.kirkkovuosikalenteri.fi';
    this.fetchImpl = options.fetch ?? fetch;
    this.ttl = options.cacheTtlMs ?? 6 * 3_600_000;
    this.userAgent = options.userAgent ?? 'kirkkovuosi-mcp (github.com/jsilvanus/kirkkovuosi-mcp)';
  }

  private async get(path: string): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;
    const res = await this.fetchImpl(this.baseUrl + path, {
      headers: { accept: 'application/json', 'user-agent': this.userAgent },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error(`Kirkkovuosikalenteri answered ${res.status} with non-JSON content.`); }
    if (!res.ok) {
      if ((value as { code?: string })?.code === 'no_calendar_day') return null;
      const message = (value as { message?: string })?.message;
      throw new Error(`Kirkkovuosikalenteri answered ${res.status}${message ? ': ' + message : ''}`);
    }
    this.cache.set(path, { expires: Date.now() + this.ttl, value });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  /** Everything the calendar has for a date: holy days, texts, weekly lectionary, prayers, hymns. */
  async day(date: string | undefined, language: Language = 'fi', sections: Section[] = SECTIONS, _context: ConnectorContext = {}): Promise<unknown> {
    const iso = date ?? todayInFinland();
    if (!validDate(iso)) throw new Error('Invalid date. Use YYYY-MM-DD.');
    const [y, m, d] = iso.split('-').map(Number);
    const raw = await this.get(`/wp-json/kirkkovuosi/v1/day/${language}/${d}.${m}.${y}`) as RawDay;
    if (!raw?.day_title) {
      throw new Error(`Kirkkovuosikalenteri has no data for ${iso}. It covers roughly the church years 2022–2035.`);
    }
    const activeCycle = Number(raw.day_volume?.match(/volume-(\d)/)?.[1]) || null;
    const wanted = new Set(sections);
    return {
      date: iso,
      language,
      title: raw.day_title.replace(/\s+/g, ' '),
      url: raw.day_url ?? null,
      activeYearCycle: activeCycle,
      color: raw.color || null,
      candles: raw.candles || null,
      liturgicalDays: (raw.liturgical_days ?? []).map(ld => convertDay(ld, wanted, activeCycle)),
      source: language === 'sv' ? 'Kyrkoårskalendern (kyrkoarskalendern.fi)' : 'Kirkkovuosikalenteri (kirkkovuosikalenteri.fi)',
    };
  }

  /**
   * The weekly lectionary of a date, with this evening's vespers. Saturday has no
   * vespers of its own: the evening before a Sunday or feast is its first vespers
   * (the site's `eve` of the next date), and a Sunday's own evening its second
   * vespers. The site files Saturday's `evening` under the week, which in some
   * years is followed by a different Sunday or feast, so `tonight` is taken from
   * the next date.
   */
  async lectionary(date: string | undefined, language: Language = 'fi', context: ConnectorContext = {}): Promise<unknown> {
    const iso = date ?? todayInFinland();
    const day = await this.day(iso, language, ['lectionary'], context) as {
      liturgicalDays: { title: string | null; lectionary: Record<string, Passage[]> }[];
    };
    const nextIso = new Date(Date.parse(iso + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    let next: typeof day | null = null;
    try {
      next = await this.day(nextIso, language, ['lectionary'], context) as typeof day;
    } catch { /* the next date is outside the calendar */ }
    const feast = next?.liturgicalDays.find(ld => ld.lectionary.firstVespers?.length);
    const own = day.liturgicalDays.find(ld => ld.lectionary.firstVespers?.length);
    const tonight = feast
      ? { vespers: 'first', of: feast.title, date: nextIso, passages: feast.lectionary.firstVespers }
      : own
        ? { vespers: 'second', of: own.title, date: iso, passages: own.lectionary.evening }
        : { vespers: null, of: day.liturgicalDays[0]?.title ?? null, date: iso, passages: day.liturgicalDays[0]?.lectionary.evening ?? [] };
    return { ...day, tonight };
  }

  /**
   * The liturgical colour of every day of a month. A day can have two colours
   * (Holy Saturday: black, then white for the Easter Vigil). `marked`: the site
   * adds a "background" highlight to some days in its calendar view. Its meaning
   * is undocumented (in April 2026: 2.–4.4. and 6.4., but not Easter Day).
   */
  async liturgicalColors(year: number, month: number, _context: ConnectorContext = {}): Promise<unknown> {
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('Give year and month (1–12).');
    const raw = await this.get(`/wp-json/liturgicalColors/v1/${year}/${month}`) as { start?: string; classNames?: string[]; rendering?: string }[];
    const days = new Map<string, { date: string; colors: string[]; colorsEn: string[]; marked: boolean }>();
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (!entry.start) continue;
      const day = days.get(entry.start) ?? { date: entry.start, colors: [], colorsEn: [], marked: false };
      days.set(entry.start, day);
      if (entry.rendering === 'background') day.marked = true;
      const cls = (entry.classNames ?? []).find(c => c.startsWith('liturgical-color--'));
      // "liturgical-color--black_liturgical-color--white" → black, white
      for (const key of cls ? cls.split('_').map(c => c.replace('liturgical-color--', '')) : []) {
        day.colorsEn.push(key);
        day.colors.push(COLOR_CLASSES[key] ?? key);
      }
    }
    return { year, month, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }

  /** Search the calendar's pages and holy days. */
  async search(query: string, language: Language = 'fi', _context: ConnectorContext = {}): Promise<unknown> {
    const q = query.trim();
    if (!q) throw new Error('Query is required.');
    const lang = language === 'sv' ? '&lang=sv' : '';
    const raw = await this.get(`/wp-json/wp/v2/search?search=${encodeURIComponent(q)}&per_page=20${lang}`) as { title?: string; url?: string; subtype?: string }[];
    return {
      query: q,
      results: (Array.isArray(raw) ? raw : []).map(r => ({ title: decodeEntities(r.title ?? ''), url: r.url ?? null, type: r.subtype ?? null })),
    };
  }
}
