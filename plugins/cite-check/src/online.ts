/**
 * Online checks (`net.fetch`), run only when the user asks ("Verify
 * sources"), never on edit:
 *
 *   - Crossref: a DOI must point at the cited work (title / authors /
 *     year); without a DOI, a title search looks for the work and checks
 *     the short-cite author is on it.
 *   - OpenAlex: institutions named in the quals are compared with the
 *     author's known affiliations. A clear match is a ✓; a known author
 *     whose record lists none of them is "couldn't confirm" — a warning,
 *     never "false" (records lag, names collide, journalists and
 *     think-tank authors are mostly absent).
 *   - The cited page itself (needs "*" in the granted hosts): a dead
 *     link (404/410) is an error; the page's own author / date / title
 *     metadata is compared with the cite.
 *
 * Everything goes through a small cache (api.storage) and a 3-wide
 * queue, so re-verifying a file is cheap and polite.
 */
import type { PluginCard, PluginFetchResult } from '@cardmirror/plugin-api';
import type { Confirmation, Finding } from './findings.js';
import { fold, type ParsedCite } from './parse-cite.js';
import { anchorIn } from './rules.js';

export interface NetLike {
  fetch(url: string, init?: { headers?: Record<string, string>; method?: 'GET' | 'HEAD' | 'POST'; timeoutMs?: number }): Promise<PluginFetchResult>;
}

export interface CacheLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface VerifyOptions {
  net: NetLike;
  cache: CacheLike;
  /** Optional free OpenAlex key (OpenAlex requires one beyond a small daily budget). */
  openAlexKey?: string;
  /** Optional address for Crossref's "polite pool" — sent to Crossref only. */
  contactEmail?: string;
  /** Fetch the cited pages themselves. */
  checkLinks: boolean;
}

export interface VerifyResult {
  findings: Finding[];
  confirmations: Confirmation[];
  /** Lookups that couldn't run (offline, not granted, rate-limited). */
  skipped: string[];
}

const UA = 'CiteCheck-CardMirror-Plugin/0.1';

/** Word-set similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      fold(s)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size);
}
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'are', 'its', 'university', 'institute', 'school', 'college', 'center', 'centre', 'department']);

// ── Network helpers ─────────────────────────────────────────────────

type Json = Record<string, unknown>;
type Got<T> = { ok: true; value: T } | { ok: false; reason: string };

async function getJson(net: NetLike, url: string, cache: CacheLike): Promise<Got<Json | 404>> {
  const hit = cache.get(url);
  if (hit !== undefined) return { ok: true, value: hit as Json | 404 };
  const r = await net.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, timeoutMs: 15000 });
  if (!r.ok) return { ok: false, reason: r.error };
  if (r.status === 404) {
    cache.set(url, 404);
    return { ok: true, value: 404 };
  }
  if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
  try {
    const value = JSON.parse(r.body) as Json;
    cache.set(url, value);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'bad JSON' };
  }
}

interface Work {
  title: string;
  surnames: string[];
  year: number | null;
}

function crossrefWork(msg: Json): Work {
  const title = Array.isArray(msg['title']) ? String(msg['title'][0] ?? '') : String(msg['title'] ?? '');
  const authors = Array.isArray(msg['author']) ? (msg['author'] as Json[]) : [];
  const surnames = authors.map((a) => String(a['family'] ?? a['name'] ?? '')).filter(Boolean);
  const parts = ((msg['issued'] ?? msg['published']) as Json | undefined)?.['date-parts'];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) && typeof parts[0][0] === 'number' ? (parts[0][0] as number) : null;
  return { title, surnames, year };
}

function mailto(opts: VerifyOptions): string {
  const e = opts.contactEmail?.trim();
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? `mailto=${encodeURIComponent(e)}` : '';
}

const surnameOn = (surnames: readonly string[], work: Work): boolean =>
  surnames.some((s) => work.surnames.some((w) => fold(w) === fold(s) || fold(w).endsWith(` ${fold(s)}`)));

// ── Checks ──────────────────────────────────────────────────────────

async function checkWork(card: PluginCard, p: ParsedCite, opts: VerifyOptions, res: VerifyResult): Promise<void> {
  const surnames = p.short?.surnames ?? [];
  if (p.doi) {
    const q = mailto(opts);
    const got = await getJson(opts.net, `https://api.crossref.org/works/${encodeURIComponent(p.doi)}${q ? `?${q}` : ''}`, opts.cache);
    if (!got.ok) return void res.skipped.push(`Crossref (${got.reason})`);
    if (got.value === 404) {
      res.findings.push({ ruleId: 'doi-not-found', severity: 'error', message: `DOI ${p.doi} doesn’t exist (Crossref)`, online: true, ...anchorIn(card, p.doi) });
      return;
    }
    const work = crossrefWork((got.value['message'] ?? {}) as Json);
    const problems: string[] = [];
    if (p.titleText && work.title && similarity(p.titleText, work.title) < 0.5) problems.push(`its title is “${work.title}”`);
    if (surnames.length && work.surnames.length && !surnameOn(surnames, work)) problems.push(`its authors are ${work.surnames.slice(0, 4).join(', ')}`);
    if (problems.length) {
      res.findings.push({ ruleId: 'doi-mismatch', severity: 'error', message: `DOI points to a different work: ${problems.join('; ')}`, online: true, ...anchorIn(card, p.doi) });
    } else {
      res.confirmations.push({ ruleId: 'doi-ok', message: `DOI matches “${work.title || p.doi}”` });
      const citeYear = p.short?.year ?? p.date?.year ?? null;
      if (work.year && citeYear && Math.abs(work.year - citeYear) > 1) {
        res.findings.push({ ruleId: 'year-mismatch', severity: 'warning', message: `Crossref dates this work ${work.year}, the cite says ${citeYear}`, online: true, ...anchorIn(card, p.short?.text) });
      }
    }
    return;
  }
  if (!p.titleText || p.titleText.length < 12) return;
  const q = [`query.bibliographic=${encodeURIComponent(`${p.titleText} ${surnames.join(' ')}`)}`, 'rows=3', mailto(opts)].filter(Boolean).join('&');
  const got = await getJson(opts.net, `https://api.crossref.org/works?${q}`, opts.cache);
  if (!got.ok) return void res.skipped.push(`Crossref (${got.reason})`);
  if (got.value === 404) return;
  const items = (((got.value['message'] ?? {}) as Json)['items'] ?? []) as Json[];
  const best = items.map(crossrefWork).find((w) => w.title && similarity(p.titleText!, w.title) >= 0.85);
  if (!best) return; // not in Crossref (most news / think-tank pieces aren't): no verdict
  if (surnames.length && best.surnames.length && !surnameOn(surnames, best)) {
    res.findings.push({
      ruleId: 'author-not-on-work',
      severity: 'warning',
      message: `Crossref lists “${best.title}” by ${best.surnames.slice(0, 4).join(', ')}, not ${surnames.join(' & ')}`,
      online: true,
      ...anchorIn(card, p.short?.text),
    });
  } else {
    res.confirmations.push({ ruleId: 'work-found', message: `Found in Crossref: “${best.title}”` });
  }
}

/** Institution names in quals ("Professor of Economics at Harvard
 *  University" → "Harvard University"). */
export function institutionsIn(quals: string): string[] {
  const re = /((?:[\p{Lu}][\p{L}&.'-]*\s+){0,5}(?:University|College|Institute|Institution|School|Center|Centre|Laboratory|Foundation|Hospital|Academy)(?:\s+(?:of|for|at|on)\s+(?:the\s+)?(?:[\p{Lu}][\p{L}&.'-]*\s*){1,5})?|(?:University|Institute)\s+of\s+(?:[\p{Lu}][\p{L}&.'-]*\s*){1,4})/gu;
  return [...new Set([...quals.matchAll(re)].map((m) => m[1]!.trim().replace(/[,.;]$/, '')).filter((s) => s.split(/\s+/).length >= 2))];
}

async function checkQuals(card: PluginCard, p: ParsedCite, opts: VerifyOptions, res: VerifyResult): Promise<void> {
  if (!p.authorText || !p.qualsText || p.authorText.split(/\s+/).length < 2) return;
  const claimed = institutionsIn(p.qualsText);
  if (claimed.length === 0) return;
  const key = opts.openAlexKey?.trim();
  const url = `https://api.openalex.org/authors?search=${encodeURIComponent(p.authorText)}&per-page=5${key ? `&api_key=${encodeURIComponent(key)}` : ''}`;
  const got = await getJson(opts.net, url, opts.cache);
  if (!got.ok) return void res.skipped.push(`OpenAlex (${got.reason})`);
  if (got.value === 404) return;
  const results = (got.value['results'] ?? []) as Json[];
  const want = fold(p.authorText).replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
  // Only a record whose name matches exactly can contradict the quals.
  const same = results.filter((a) => fold(String(a['display_name'] ?? '')).replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim() === want);
  if (same.length === 0) return;
  const known = new Set<string>();
  for (const a of same) {
    for (const i of (a['last_known_institutions'] ?? []) as Json[]) if (i['display_name']) known.add(String(i['display_name']));
    for (const af of (a['affiliations'] ?? []) as Json[]) {
      const inst = af['institution'] as Json | undefined;
      if (inst?.['display_name']) known.add(String(inst['display_name']));
    }
  }
  if (known.size === 0) return;
  const matched = claimed.filter((c) => [...known].some((k) => similarity(c, k) >= 0.6 || fold(k).includes(fold(c)) || fold(c).includes(fold(k))));
  if (matched.length > 0) {
    res.confirmations.push({ ruleId: 'quals-confirmed', message: `OpenAlex links ${p.authorText} to ${matched.join(', ')}` });
    return;
  }
  // A single same-named record and no overlap: worth a look, not a verdict.
  const listed = [...known].slice(0, 3).join('; ');
  res.findings.push({
    ruleId: 'quals-unconfirmed',
    severity: same.length === 1 ? 'warning' : 'info',
    message: `Couldn’t confirm “${claimed[0]}” for ${p.authorText}. OpenAlex lists: ${listed}${same.length > 1 ? ` (${same.length} people share this name)` : ''}`,
    online: true,
    ...anchorIn(card, claimed[0]),
  });
}

// ── The cited page ──────────────────────────────────────────────────

export interface PageMeta {
  authors: string[];
  date: string | null;
  title: string | null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

/** Author / date / title from a page's own metadata (citation_*,
 *  Open Graph, article:*, JSON-LD). Regex-based, so it runs anywhere. */
export function readPageMeta(html: string): PageMeta {
  const head = html.slice(0, 400_000);
  const metas = new Map<string, string[]>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, 'name') ?? attr(tag, 'property') ?? attr(tag, 'itemprop') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (!key || content === null) continue;
    metas.set(key, [...(metas.get(key) ?? []), decodeEntities(content).trim()]);
  }
  const first = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = metas.get(k)?.find(Boolean);
      if (v) return v;
    }
    return null;
  };
  let authors = [
    ...(metas.get('citation_author') ?? []),
    ...(metas.get('dc.creator') ?? []),
    ...(metas.get('parsely-author') ?? []),
    ...(metas.get('sailthru.author') ?? []),
    ...(metas.get('author') ?? []),
  ].filter((a) => a && !/^https?:/i.test(a));
  let date = first('citation_publication_date', 'citation_date', 'article:published_time', 'parsely-pub-date', 'dc.date', 'date', 'pubdate', 'datepublished');
  let title = first('citation_title', 'og:title', 'twitter:title');
  for (const s of head.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(s[1]!) as unknown;
      const nodes: Json[] = [];
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') {
          nodes.push(x as Json);
          if ((x as Json)['@graph']) walk((x as Json)['@graph']);
        }
      };
      walk(data);
      for (const n of nodes) {
        const a = n['author'];
        const names = (Array.isArray(a) ? a : a ? [a] : [])
          .map((x) => (typeof x === 'string' ? x : String((x as Json)['name'] ?? '')))
          .filter(Boolean);
        if (authors.length === 0 && names.length) authors = names;
        if (!date && typeof n['datePublished'] === 'string') date = n['datePublished'];
        if (!title && typeof n['headline'] === 'string') title = n['headline'];
      }
    } catch {
      /* malformed JSON-LD: ignore */
    }
  }
  if (!title) {
    const t = /<title[^>]*>([^<]{1,500})<\/title>/i.exec(head);
    if (t) title = decodeEntities(t[1]!).trim();
  }
  return { authors: [...new Set(authors)], date, title };
}

async function checkPage(card: PluginCard, p: ParsedCite, opts: VerifyOptions, res: VerifyResult): Promise<void> {
  const raw = p.urls[0];
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : `https://${raw}`;
  const cacheKey = `page:${url}`;
  let page = opts.cache.get(cacheKey) as { status: number; meta: PageMeta | null } | undefined;
  if (!page) {
    const r = await opts.net.fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA }, timeoutMs: 15000 });
    if (!r.ok) {
      if (r.error !== 'host-not-granted') res.skipped.push(`link (${r.error})`);
      return;
    }
    const html = /html|xml/i.test(r.headers['content-type'] ?? 'text/html');
    page = { status: r.status, meta: r.status === 200 && html ? readPageMeta(r.body) : null };
    opts.cache.set(cacheKey, page);
  }
  if (page.status === 404 || page.status === 410) {
    res.findings.push({ ruleId: 'dead-link', severity: 'error', message: `Dead link (HTTP ${page.status})`, online: true, ...anchorIn(card, raw) });
    return;
  }
  const meta = page.meta;
  if (!meta) return; // paywall / bot wall / PDF: no verdict
  const surnames = p.short?.surnames ?? [];
  if (meta.authors.length && surnames.length) {
    const on = surnames.some((s) => meta.authors.some((a) => fold(a).includes(fold(s))));
    if (!on) {
      res.findings.push({
        ruleId: 'page-author-mismatch',
        severity: 'warning',
        message: `The page lists ${meta.authors.slice(0, 3).join(', ')} as author, not ${surnames.join(' & ')}`,
        online: true,
        ...anchorIn(card, p.short?.text),
      });
    } else {
      res.confirmations.push({ ruleId: 'page-author-ok', message: `Page author matches (${meta.authors.slice(0, 2).join(', ')})` });
    }
  }
  const pageYear = meta.date ? Number(/\b(19|20)\d{2}\b/.exec(meta.date)?.[0]) : NaN;
  const citeYear = p.date?.year ?? p.short?.year ?? null;
  if (Number.isFinite(pageYear) && citeYear && pageYear !== citeYear) {
    res.findings.push({
      ruleId: 'page-date-mismatch',
      severity: 'warning',
      message: `The page says it was published ${meta.date!.slice(0, 10)}, the cite says ${citeYear}`,
      online: true,
      ...anchorIn(card, p.date?.text ?? p.short?.text),
    });
  }
  if (p.titleText && meta.title && similarity(p.titleText, meta.title) < 0.3) {
    res.findings.push({ ruleId: 'page-title-mismatch', severity: 'info', message: `The page’s title is “${meta.title}”`, online: true, ...anchorIn(card, p.titleText) });
  }
}

export async function verifyCard(card: PluginCard, parsed: ParsedCite, opts: VerifyOptions): Promise<VerifyResult> {
  const res: VerifyResult = { findings: [], confirmations: [], skipped: [] };
  if (!card.citeParagraphs.some((x) => x.trim())) return res;
  const steps: Promise<void>[] = [checkWork(card, parsed, opts, res), checkQuals(card, parsed, opts, res)];
  if (opts.checkLinks) steps.push(checkPage(card, parsed, opts, res));
  await Promise.all(steps.map((s) => s.catch(() => void res.skipped.push('a lookup failed'))));
  return res;
}

/** Run `tasks` at most `width` at a time; `onDone` after each. */
export async function pool<T>(items: readonly T[], width: number, task: (item: T) => Promise<void>, onDone?: (n: number) => void): Promise<void> {
  let next = 0;
  let done = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}
