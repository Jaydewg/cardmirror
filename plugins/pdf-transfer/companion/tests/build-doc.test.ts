// @vitest-environment jsdom
// jsdom only for the /insert round trip (CardMirror's parser needs a DOM);
// the companion itself serializes through its fake DOM.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../../../../src/schema/index.js';
import { parseNative } from '../../../../src/native/index.js';
import { buildExternalRichInsertTransaction } from '../../../../src/editor/external-insert.js';
import { buildDoc, docCmir, docHtml, docText } from '../src/build-doc.js';
import { snapshotToParas } from '../src/snapshot.js';
import type { Para } from '../src/model.js';
import { SNAP } from './fixtures.js';

const marksOf = (doc: ReturnType<typeof buildDoc>, text: string): string[] => {
  let out: string[] = [];
  doc.descendants((n) => {
    if (n.isText && n.text === text) out = n.marks.map((m) => (m.attrs['color'] ? `${m.type.name}:${m.attrs['color']}` : m.type.name));
  });
  return out;
};

describe('buildDoc', () => {
  it('assembles cards the way an import does', () => {
    const doc = buildDoc(snapshotToParas(SNAP), { keepIds: true });
    expect(doc.content.content.map((n) => n.type.name)).toEqual(['pocket', 'card', 'analytic_unit']);
    const card = doc.child(1);
    expect(card.content.content.map((n) => n.type.name)).toEqual(['tag', 'undertag', 'cite_paragraph', 'card_body']);
    expect(card.firstChild!.attrs['id']).toBe('t1');
    expect(marksOf(doc, 'Smith 24')).toEqual(['cite_mark']);
    expect(marksOf(doc, 'planet')).toEqual(['underline_mark', 'highlight:cyan']);
    expect(marksOf(doc, 'is')).toEqual(['emphasis_mark']);
  });

  it('mints fresh ids unless told to keep them', () => {
    const doc = buildDoc(snapshotToParas(SNAP), { keepIds: false });
    expect(doc.child(1).firstChild!.attrs['id']).not.toBe('t1');
  });

  it('puts text before the first heading in plain paragraphs and drops empty ones', () => {
    const paras: Para[] = [
      { role: 'paragraph', runs: [{ text: 'Intro', bold: true, sizePt: 8 }] },
      { role: 'body', runs: [{ text: '   ' }] },
      { role: 'tag', runs: [{ text: 'T', underline: true }] },
      { role: 'body', runs: [{ text: 'b', shading: '#a0b1c2' }] },
    ];
    const doc = buildDoc(paras, { keepIds: false });
    expect(doc.content.content.map((n) => n.type.name)).toEqual(['paragraph', 'card']);
    expect(marksOf(doc, 'Intro').sort()).toEqual(['bold', 'font_size']);
    expect(marksOf(doc, 'T')).toEqual(['underline_direct']);
    expect(marksOf(doc, 'b')).toEqual(['shading:A0B1C2']);
  });
});

describe('outputs', () => {
  const doc = buildDoc(snapshotToParas(SNAP), { keepIds: false });

  it('HTML inserts through CardMirror’s /insert parser unchanged', () => {
    const html = docHtml(doc);
    expect(html).toContain('pmd-card');
    const empty = schema.nodes['doc']!.createChecked(null, [schema.nodes['paragraph']!.create()]);
    let state = EditorState.create({ doc: empty });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    const tr = buildExternalRichInsertTransaction(state, { html, newParagraph: true });
    expect(tr).not.toBeNull();
    const inserted = tr!.doc;
    // Everything we built arrives, in order (the empty starting paragraph aside).
    const names = inserted.content.content.map((n) => n.type.name).filter((n) => n !== 'paragraph');
    expect(names).toEqual(['pocket', 'card', 'analytic_unit']);
    expect(inserted.textContent).toBe(doc.textContent);
    expect(marksOf(inserted, 'planet')).toEqual(marksOf(doc, 'planet'));
  });

  it('text fallback has one line per paragraph', () => {
    expect(docText(snapshotToParas(SNAP)).split('\n')).toHaveLength(6);
  });

  it('.cmir bytes open in CardMirror', () => {
    const back = parseNative(docCmir(doc, '0.1.0'));
    expect(back.doc.eq(doc)).toBe(true);
  });
});
