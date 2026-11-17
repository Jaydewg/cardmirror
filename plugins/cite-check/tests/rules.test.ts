import { describe, expect, it } from 'vitest';
import type { PluginCard } from '@cardmirror/plugin-api';
import { parseCite } from '../src/parse-cite.js';
import { checkCard, checkDocument, DEFAULT_VAGUE_TERMS, isVagueQuals, type RuleConfig } from '../src/rules.js';
import { DEFAULT_SOURCE_RULES, parseDomainList } from '../src/sources.js';
import { card, GOOD, TODAY } from './fixtures.js';

const cfg = (over: Partial<RuleConfig> = {}): RuleConfig => ({
  today: TODAY,
  vagueTerms: DEFAULT_VAGUE_TERMS,
  sourceRules: DEFAULT_SOURCE_RULES,
  trusted: [],
  maxAgeYears: 0,
  ...over,
});

function run(c: PluginCard, config = cfg()) {
  return checkCard(c, parseCite(c.cite, c.citeParagraphs, TODAY), config);
}
const ids = (c: PluginCard, config?: RuleConfig) => run(c, config).map((f) => f.ruleId);
const serious = (c: PluginCard) => run(c).filter((f) => f.severity !== 'info');

const STD = (quals: string, extra = '"A Proper Title Here," The Atlantic, 3/4/2024, https://www.theatlantic.com/x') =>
  card('Doe 24', `Jane Doe 24, ${quals}, ${extra}`);

describe('good cites', () => {
  it.each(GOOD)('$short raises no error or warning', ({ short, full }) => {
    expect(serious(card(short, full))).toEqual([]);
  });
});

describe('structure and dates', () => {
  it('a card with no cite is an error on its heading; an analytic is fine', () => {
    expect(run(card('', []))).toEqual([{ ruleId: 'no-cite', severity: 'error', message: 'Card has no cite', part: 'heading' }]);
    expect(run(card('', ['  ']))).toHaveLength(1);
    expect(run(card('', [], { kind: 'analytic' }))).toEqual([]);
  });

  it('no short cite, no date, n.d.', () => {
    expect(ids(card('', 'Jane Doe, Professor at MIT, "Title is long," Journal, 2024'))).toContain('no-short-cite');
    expect(ids(card('Doe', 'Doe, Professor at MIT, "Title is long," Journal, 2024'))).toContain('no-date');
    const nd = run(card('Doe n.d.', 'Doe n.d., Professor at MIT, "Title is long," Journal, https://mit.edu/a'));
    expect(nd.find((f) => f.ruleId === 'no-date')?.message).toMatch(/no date/);
  });

  it('future dates and short-cite / full-date mismatches', () => {
    expect(ids(STD('Professor at MIT', '"Title is long," Journal, 3/4/2027, https://mit.edu/a'))).toContain('future-date');
    const mismatch = run(card('Doe 21', 'Jane Doe 21, Professor at MIT, "Title is long," Journal, 3/4/2019, https://mit.edu/a'));
    expect(mismatch.find((f) => f.ruleId === 'date-mismatch')).toMatchObject({ severity: 'warning', match: 'Doe 21' });
    expect(ids(card('Doe 3/4', 'Jane Doe 3/4, Professor at MIT, "Title is long," Journal, 3/5/2026, https://mit.edu/a'))).toContain(
      'date-mismatch',
    );
    expect(ids(card('Doe 3/4', 'Jane Doe 3/4, Professor at MIT, "Title is long," Journal, 3/4/2026, https://mit.edu/a'))).not.toContain(
      'date-mismatch',
    );
  });

  it('old evidence only when asked', () => {
    const c = card('Doe 99', 'Jane Doe 99, Professor at MIT, "Title is long," Journal, 1999, https://mit.edu/a');
    expect(ids(c)).not.toContain('old-evidence');
    expect(ids(c, cfg({ maxAgeYears: 10 }))).toContain('old-evidence');
  });

  it('a short-cite author missing from the full cite', () => {
    const f = run(card('Smith 24', 'Smith 24 — Jane Doe, Professor at MIT, "Title is long," Journal, 2024, https://mit.edu/a'));
    expect(f.find((x) => x.ruleId === 'author-not-in-cite')).toMatchObject({ severity: 'warning', match: 'Smith 24' });
    const g = run(card('Smith 24', ['Smith 24', 'Jane Doe, Professor at MIT, "Title is long," Journal, 2024, https://mit.edu/a']));
    expect(g.map((x) => x.ruleId)).toContain('author-not-in-cite');
    // Named before the date or after it: both count.
    expect(ids(card('Doe 24', 'Jane Doe 24, Professor at MIT, "Title is long," Journal, 2024, https://mit.edu/a'))).not.toContain('author-not-in-cite');
    expect(ids(card('Doe 24', 'Doe 24 (Jane Doe, Professor at MIT, "Title is long," Journal, 2024, https://mit.edu/a)'))).not.toContain('author-not-in-cite');
  });
});

describe('quals', () => {
  it('missing quals', () => {
    expect(ids(card('Doe 24', 'Jane Doe 24, "A Proper Title Here," The Atlantic, 2024, https://theatlantic.com/x'))).toContain('no-quals');
  });

  it('vague quals are flagged at the quals text; specific ones are not', () => {
    const f = run(STD('Freelance writer'));
    expect(f.find((x) => x.ruleId === 'vague-quals')).toMatchObject({ severity: 'warning', part: 'cite', index: 0, match: 'Freelance writer' });
    for (const ok of ['Staff writer at The Atlantic', 'Professor of Law', 'PhD in Economics', 'Senior Fellow, Brookings Institution']) {
      expect(ids(STD(ok))).not.toContain('vague-quals');
    }
    expect(isVagueQuals('Expert', DEFAULT_VAGUE_TERMS)).toBe(true);
    expect(isVagueQuals('Political commentator', DEFAULT_VAGUE_TERMS)).toBe(true);
    expect(isVagueQuals('Commentator for the BBC', DEFAULT_VAGUE_TERMS)).toBe(false);
  });

  it('“no quals” / unknown, students, staff bylines', () => {
    expect(ids(STD('no quals available'))).toContain('quals-none');
    expect(run(STD('High school student at Lincoln')).find((x) => x.ruleId === 'student-quals')?.severity).toBe('info');
    const staff = card('Staff 24', 'Staff 24, "A Proper Title Here," Reuters, 2024, https://reuters.com/a');
    expect(ids(staff)).toContain('org-author');
    expect(ids(staff)).not.toContain('no-quals');
  });
});

describe('sources and links', () => {
  it('flags weak sources by URL, with severity per category', () => {
    const sev = (url: string) =>
      run(STD('Professor at MIT', `"A Proper Title Here," Site, 2024, ${url}`)).find((f) => f.ruleId === 'source')?.severity;
    expect(sev('https://en.wikipedia.org/wiki/Trade')).toBe('warning');
    expect(sev('https://chatgpt.com/share/abc')).toBe('error');
    expect(sev('https://chatgpt.com/')).toBeUndefined(); // only share links
    expect(sev('https://theonion.com/x')).toBe('error');
    expect(sev('https://bit.ly/3x')).toBe('warning');
    expect(sev('https://jane.medium.com/post')).toBe('info');
    expect(sev('https://www.google.com/search?q=trade')).toBe('warning');
    expect(sev('https://www.nature.com/articles/x')).toBeUndefined();
  });

  it('uses the user’s untrusted and trusted lists (trusted wins)', () => {
    const c = STD('Professor at MIT', '"A Proper Title Here," Site, 2024, https://blog.example.org/a');
    const untrusted = parseDomainList('example.org  # partisan blog\n\nbad entry here', 'warning', 'on your list');
    expect(run(c, cfg({ sourceRules: [...untrusted, ...DEFAULT_SOURCE_RULES] })).find((f) => f.ruleId === 'source')?.message).toBe(
      'Source: partisan blog',
    );
    const w = STD('Professor at MIT', '"A Proper Title Here," Site, 2024, https://en.wikipedia.org/wiki/X');
    expect(ids(w, cfg({ trusted: parseDomainList('wikipedia.org', 'info', '') }))).not.toContain('source');
  });

  it('flags a source named without a URL, local links and missing links', () => {
    expect(run(STD('Professor at MIT', '"A Proper Title Here," Wikipedia, 2024')).find((f) => f.ruleId === 'source')?.match).toBe('Wikipedia');
    expect(ids(STD('Professor at MIT', '"A Proper Title Here," Notes, 2024, file:///C:/Users/me/a.pdf'))).toContain('local-link');
    expect(ids(STD('Professor at MIT', '"A Proper Title Here," Journal, 2024'))).toContain('no-link');
  });
});

describe('across the document', () => {
  const both = (a: PluginCard, b: PluginCard) =>
    checkDocument([a, b].map((c) => ({ card: c, parsed: parseCite(c.cite, c.citeParagraphs, TODAY) })));

  it('the same source cited two ways', () => {
    const a = card('Doe 24', 'Jane Doe 24, Professor at MIT, "Title is long," Journal, 2024, https://www.example.com/a?utm_source=x');
    const b = card('Roe 23', 'Rick Roe 23, Professor at MIT, "Title is long," Journal, 2023, https://example.com/a/');
    const r = both(a, b);
    expect(r.get(0)?.[0]).toMatchObject({ ruleId: 'source-cited-differently', match: 'Doe 24' });
    expect(r.get(1)?.[0]?.message).toMatch(/“Doe 24”/);
  });

  it('one short cite for two sources', () => {
    const a = card('Doe 24', 'Jane Doe 24, Professor at MIT, "First title here," Journal, 2024, https://a.example/1');
    const b = card('Doe 24', 'Jane Doe 24, Professor at MIT, "Second title here," Journal, 2024, https://a.example/2');
    expect(both(a, b).get(0)?.map((f) => f.ruleId)).toEqual(['short-cite-collision']);
  });

  it('one author, one year, very different quals', () => {
    const a = card('Doe 24', 'Jane Doe 24, Professor of Economics at MIT, "First title here," Journal, 2024, https://a.example/1');
    const b = card('Doe 24b', 'Jane Doe 24b, Retired dentist in Ohio, "Second title here," Journal, 2024, https://a.example/2');
    expect(both(a, b).get(0)?.find((f) => f.ruleId === 'inconsistent-quals')).toBeTruthy();
    const c = card('Doe 24b', 'Jane Doe 24b, Professor of Economics, MIT, "Second title here," Journal, 2024, https://a.example/2');
    expect(both(a, c).get(0)?.find((f) => f.ruleId === 'inconsistent-quals')).toBeUndefined();
  });
});
