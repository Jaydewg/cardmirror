import { describe, expect, it } from 'vitest';
import { parseSnapshot, snapshotToParas, spansToRuns } from '../src/snapshot.js';
import { hybridBytes, parseHybrid } from '../src/hybrid.js';
import { printHtml } from '../src/print-html.js';
import { SNAP } from './fixtures.js';

describe('spansToRuns', () => {
  it('cuts at every edge and merges what matches', () => {
    expect(
      spansToRuns('abcdef', [
        { from: 0, to: 4, style: 'underline' },
        { from: 2, to: 6, style: 'highlight', color: 'green' },
      ]),
    ).toEqual([
      { text: 'ab', underline: true },
      { text: 'cd', underline: true, highlight: 'green' },
      { text: 'ef', highlight: 'green' },
    ]);
  });
});

describe('parseSnapshot', () => {
  it('keeps a valid snapshot', () => {
    expect(parseSnapshot(SNAP)!.cards[0]!.formatting!.body[0]).toHaveLength(3);
  });

  it('rejects non-snapshots and cleans hostile values', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ outline: 'x', cards: [] })).toBeNull();
    const dirty = parseSnapshot({
      outline: [{ type: 'evil', text: 'x' }, { type: 'tag', text: 7, id: 5 }],
      cards: [
        {
          heading: 'Hi',
          body: ['abc', 4],
          formatting: {
            body: [
              [
                { from: -5, to: 99, style: 'highlight', color: 'url(x)' },
                { from: 0, to: 1, style: 'script' },
                { from: 1.5, to: 2, style: 'bold' },
                { from: 0, to: 2, style: 'shading', color: '#ZZZ' },
              ],
            ],
          },
        },
      ],
    })!;
    expect(dirty.outline).toEqual([{ id: null, type: 'tag', level: 4, text: '' }]);
    expect(dirty.cards[0]!.body).toEqual(['abc', '']);
    expect(dirty.cards[0]!.formatting!.body[0]).toEqual([
      { from: 0, to: 3, style: 'highlight', color: 'yellow' },
      { from: 0, to: 2, style: 'shading', color: '#d2d2d2' },
    ]);
    expect(dirty.cards[0]!.formatting!.body[1]).toEqual([]);
  });
});

describe('snapshotToParas', () => {
  it('interleaves cards with the outline, in assembly order', () => {
    const paras = snapshotToParas(SNAP);
    expect(paras.map((p) => p.role)).toEqual(['pocket', 'tag', 'undertag', 'cite', 'body', 'analytic']);
    expect(paras[1]!.headingId).toBe('t1');
    expect(paras[3]!.runs[0]).toEqual({ text: 'Smith 24', cite: true });
    expect(paras[4]!.runs).toEqual([
      { text: 'The ', underline: true },
      { text: 'planet', underline: true, highlight: 'cyan' },
      { text: ' ', underline: true },
      { text: 'is', underline: true, emphasis: true },
      { text: ' warming', underline: true },
      { text: ' fast' },
    ]);
  });

  it('pairs cards by order when ids are missing', () => {
    const snap = parseSnapshot({
      ...SNAP,
      outline: SNAP.outline.map((o) => ({ ...o, id: null })),
      cards: SNAP.cards.map((c) => ({ ...c, headingId: null })),
    })!;
    expect(snapshotToParas(snap).map((p) => p.role)).toEqual(['pocket', 'tag', 'undertag', 'cite', 'body', 'analytic']);
  });
});

describe('print HTML', () => {
  it('escapes text and styles runs', () => {
    const html = printHtml(
      [
        { role: 'tag', runs: [{ text: '<b>&' }] },
        { role: 'body', runs: [{ text: 'x', highlight: 'darkBlue', emphasis: true }] },
      ],
      { title: 'A "doc"', pageSize: 'A4' },
    );
    expect(html).toContain('<title>A &#34;doc&#34;</title>');
    expect(html).toContain('<h4 class="tag">&#60;b&#62;&#38;</h4>');
    expect(html).toContain('background-color:#000080;color:#ffffff;text-decoration:underline;font-weight:bold');
    expect(html).toContain('size: A4');
  });
});

describe('Hybrid PDF envelope', () => {
  it('round-trips, without the session uid', () => {
    const r = parseHybrid(hybridBytes('1AC', SNAP));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.title).toBe('1AC');
    expect(r.doc.docUid).toBe('');
    expect(snapshotToParas(r.doc)).toEqual(snapshotToParas(SNAP));
  });

  it('defers to reconstruction for a newer version or junk', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(parseHybrid(enc({ format: 'cardmirror-hybrid-pdf', version: 2, doc: SNAP })).kind).toBe('newer');
    expect(parseHybrid(enc({ format: 'other', version: 1, doc: SNAP })).kind).toBe('invalid');
    expect(parseHybrid(new Uint8Array([0xff, 0xfe])).kind).toBe('invalid');
  });
});
