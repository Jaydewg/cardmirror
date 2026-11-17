import { describe, expect, it, vi } from 'vitest';
import type { PluginFetchResult } from '@cardmirror/plugin-api';
import { institutionsIn, pool, readPageMeta, similarity, verifyCard, type NetLike } from '../src/online.js';
import { parseCite } from '../src/parse-cite.js';
import { card, TODAY } from './fixtures.js';

const json = (body: unknown, status = 200): PluginFetchResult => ({
  ok: true,
  status,
  url: 'x',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const html = (body: string, status = 200): PluginFetchResult => ({
  ok: true,
  status,
  url: 'x',
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body,
});

/** A fake `net` answering by URL prefix; records every URL. */
function fakeNet(routes: [string, PluginFetchResult][]) {
  const urls: string[] = [];
  const net: NetLike = {
    fetch: vi.fn(async (url: string) => {
      urls.push(url);
      const hit = routes.find(([prefix]) => url.startsWith(prefix));
      return hit ? hit[1] : { ok: false as const, error: 'host-not-granted' as const };
    }),
  };
  return { net, urls };
}

function memCache() {
  const m = new Map<string, unknown>();
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
}

const verify = (c: ReturnType<typeof card>, net: NetLike, checkLinks = false) =>
  verifyCard(c, parseCite(c.cite, c.citeParagraphs, TODAY), { net, cache: memCache(), checkLinks });

const DOI_CITE = card(
  'Smith 21',
  'John Smith 21, Professor of Economics at Yale University, "Trade and Peace in the Modern Era," Journal of Peace Research, 2021, https://doi.org/10.1177/0022343321100',
);
const crossrefWork = (title: string, family: string[], year: number) => ({
  message: { title: [title], author: family.map((f) => ({ family: f })), issued: { 'date-parts': [[year, 3, 4]] } },
});

describe('Crossref', () => {
  it('a DOI that matches the cite is confirmed', async () => {
    const { net, urls } = fakeNet([['https://api.crossref.org/works/', json(crossrefWork('Trade and Peace in the Modern Era', ['Smith'], 2021))]]);
    const r = await verify(DOI_CITE, net);
    expect(urls[0]).toBe('https://api.crossref.org/works/10.1177%2F0022343321100');
    expect(r.findings).toEqual([]);
    expect(r.confirmations.map((c) => c.ruleId)).toEqual(['doi-ok']);
  });

  it('a DOI for a different work is an error at the DOI', async () => {
    const { net } = fakeNet([['https://api.crossref.org/works/', json(crossrefWork('Soil Microbes of Iowa', ['Nguyen', 'Park'], 2015))]]);
    const r = await verify(DOI_CITE, net);
    expect(r.findings[0]).toMatchObject({ ruleId: 'doi-mismatch', severity: 'error', match: '10.1177/0022343321100' });
    expect(r.findings[0]!.message).toMatch(/Soil Microbes of Iowa.*Nguyen, Park/);
  });

  it('a DOI Crossref doesn’t know is an error; a year off by more than one is a warning', async () => {
    const missing = fakeNet([['https://api.crossref.org/works/', json({}, 404)]]);
    expect((await verify(DOI_CITE, missing.net)).findings[0]?.ruleId).toBe('doi-not-found');
    const old = fakeNet([['https://api.crossref.org/works/', json(crossrefWork('Trade and Peace in the Modern Era', ['Smith'], 2016))]]);
    expect((await verify(DOI_CITE, old.net)).findings.map((f) => f.ruleId)).toEqual(['year-mismatch']);
  });

  it('without a DOI, a title search flags a work by someone else, and says nothing when nothing matches', async () => {
    const c = card('Doe 22', 'Jane Doe 22, Professor at MIT, "Carbon Pricing and Industrial Competitiveness Revisited," Energy Policy, 2022, https://example.com/a');
    const other = fakeNet([['https://api.crossref.org/works?', json({ message: { items: [crossrefWork('Carbon Pricing and Industrial Competitiveness Revisited', ['Roe'], 2022).message] } })]]);
    const r = await verify(c, other.net);
    expect(r.findings[0]).toMatchObject({ ruleId: 'author-not-on-work', severity: 'warning' });
    expect(other.urls[0]).toMatch(/query\.bibliographic=Carbon/);
    const none = fakeNet([['https://api.crossref.org/works?', json({ message: { items: [crossrefWork('Something else entirely', ['Roe'], 2022).message] } })]]);
    expect((await verify(c, none.net)).findings).toEqual([]);
  });

  it('sends a contact email only when one is set, and only to Crossref', async () => {
    const { net, urls } = fakeNet([['https://api.crossref.org/', json(crossrefWork('Trade and Peace in the Modern Era', ['Smith'], 2021))]]);
    await verifyCard(DOI_CITE, parseCite(DOI_CITE.cite, DOI_CITE.citeParagraphs, TODAY), {
      net,
      cache: memCache(),
      checkLinks: false,
      contactEmail: 'coach@example.edu',
    });
    expect(urls.filter((u) => u.includes('mailto='))).toEqual([expect.stringMatching(/^https:\/\/api\.crossref\.org\//)]);
  });
});

describe('OpenAlex quals', () => {
  const author = (name: string, insts: string[]) => ({
    display_name: name,
    last_known_institutions: insts.slice(0, 1).map((d) => ({ display_name: d })),
    affiliations: insts.map((d) => ({ institution: { display_name: d } })),
  });
  const routes = (results: unknown[]): [string, PluginFetchResult][] => [
    ['https://api.crossref.org/', json({}, 404)],
    ['https://api.openalex.org/authors', json({ results })],
  ];

  it('extracts institutions from quals', () => {
    expect(institutionsIn('Professor of Economics at Yale University; Fellow, Brookings Institution')).toEqual(['Yale University', 'Brookings Institution']);
    expect(institutionsIn('Senior Fellow at the Council on Foreign Relations')).toEqual([]);
    expect(institutionsIn('Lecturer, University of Oxford')).toEqual(['University of Oxford']);
  });

  it('confirms a matching affiliation', async () => {
    const { net } = fakeNet(routes([author('John Smith', ['Yale University'])]));
    const r = await verify(DOI_CITE, net);
    expect(r.confirmations.map((c) => c.ruleId)).toContain('quals-confirmed');
    expect(r.findings.filter((f) => f.ruleId.startsWith('quals'))).toEqual([]);
  });

  it('“couldn’t confirm” (never “false”) when the one same-named record lists other places', async () => {
    const { net } = fakeNet(routes([author('John Smith', ['University of Leeds']), author('Johnny Smithers', ['Yale University'])]));
    const f = (await verify(DOI_CITE, net)).findings.find((x) => x.ruleId === 'quals-unconfirmed')!;
    expect(f).toMatchObject({ severity: 'warning', match: 'Yale University' });
    expect(f.message).toMatch(/^Couldn’t confirm “Yale University” for John Smith\. OpenAlex lists: University of Leeds/);
    expect(f.message).not.toMatch(/false/i);
  });

  it('only a note when several people share the name; nothing when no record matches the name', async () => {
    const many = fakeNet(routes([author('John Smith', ['University of Leeds']), author('John Smith', ['Ohio State University'])]));
    expect((await verify(DOI_CITE, many.net)).findings.find((x) => x.ruleId === 'quals-unconfirmed')?.severity).toBe('info');
    const none = fakeNet(routes([author('Jon Smyth', ['University of Leeds'])]));
    expect((await verify(DOI_CITE, none.net)).findings.filter((x) => x.ruleId.startsWith('quals'))).toEqual([]);
  });

  it('passes the API key when set', async () => {
    const { net, urls } = fakeNet(routes([]));
    await verifyCard(DOI_CITE, parseCite(DOI_CITE.cite, DOI_CITE.citeParagraphs, TODAY), { net, cache: memCache(), checkLinks: false, openAlexKey: 'k 1' });
    expect(urls.find((u) => u.includes('openalex'))).toMatch(/&api_key=k%201$/);
  });
});

describe('the cited page', () => {
  const NEWS = card('Doe 24', 'Jane Doe 24, Reporter at Vox, "The Big Trade Story," Vox, 3/4/2024, https://www.vox.com/a');

  it('reads author / date / title from meta tags and JSON-LD', () => {
    expect(
      readPageMeta(`<html><head><title>T | Site</title>
        <meta name="citation_author" content="Doe, Jane"><meta property="article:published_time" content="2024-03-04T10:00:00Z">
        <meta property="og:title" content="The Big &amp; Trade Story"></head></html>`),
    ).toEqual({ authors: ['Doe, Jane'], date: '2024-03-04T10:00:00Z', title: 'The Big & Trade Story' });
    expect(
      readPageMeta(`<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","author":[{"name":"Rick Roe"}],"datePublished":"2019-01-02","headline":"H"}]}</script>`),
    ).toEqual({ authors: ['Rick Roe'], date: '2019-01-02', title: 'H' });
  });

  it('a 404 is a dead link', async () => {
    const { net } = fakeNet([['https://api.crossref.org/', json({}, 404)], ['https://www.vox.com/', html('gone', 404)]]);
    const r = await verify(NEWS, net, true);
    expect(r.findings).toEqual([expect.objectContaining({ ruleId: 'dead-link', severity: 'error', match: 'https://www.vox.com/a' })]);
  });

  it('flags a different author or year on the page; confirms a matching author', async () => {
    const page = `<meta name="author" content="Rick Roe"><meta property="article:published_time" content="2019-05-01">`;
    const bad = fakeNet([['https://api.crossref.org/', json({}, 404)], ['https://www.vox.com/', html(page)]]);
    expect((await verify(NEWS, bad.net, true)).findings.map((f) => f.ruleId).sort()).toEqual(['page-author-mismatch', 'page-date-mismatch']);
    const good = fakeNet([['https://api.crossref.org/', json({}, 404)], ['https://www.vox.com/', html('<meta name="author" content="Jane Doe">')]]);
    const r = await verify(NEWS, good.net, true);
    expect(r.findings).toEqual([]);
    expect(r.confirmations.map((c) => c.ruleId)).toEqual(['page-author-ok']);
  });

  it('no verdict on a paywall / bot wall, and silently skips hosts it may not reach', async () => {
    const wall = fakeNet([['https://api.crossref.org/', json({}, 404)], ['https://www.vox.com/', html('denied', 403)]]);
    expect((await verify(NEWS, wall.net, true)).findings).toEqual([]);
    const noStar = fakeNet([['https://api.crossref.org/', json({}, 404)]]);
    const r = await verify(NEWS, noStar.net, true);
    expect(r.findings).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('caches lookups', async () => {
    const { net } = fakeNet([['https://api.crossref.org/', json(crossrefWork('Trade and Peace in the Modern Era', ['Smith'], 2021))]]);
    const cache = memCache();
    const p = parseCite(DOI_CITE.cite, DOI_CITE.citeParagraphs, TODAY);
    const crossref = () => (net.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes('crossref')).length;
    await verifyCard(DOI_CITE, p, { net, cache, checkLinks: false });
    expect(crossref()).toBe(1);
    await verifyCard(DOI_CITE, p, { net, cache, checkLinks: false });
    expect(crossref()).toBe(1); // answered from the cache (failed lookups are not cached)
  });
});

describe('helpers', () => {
  it('similarity ignores case, punctuation and filler words', () => {
    expect(similarity('Trade and Peace', 'TRADE & PEACE!')).toBe(1);
    expect(similarity('Harvard University', 'Yale University')).toBe(0);
  });
  it('pool runs at most `width` at once', async () => {
    let live = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    });
    expect(peak).toBe(3);
  });
});
