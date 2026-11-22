// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo } from 'prosemirror-history';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { readDocStructure } from '../../src/editor/plugin-caps/doc-read.js';
import { buildPluginInsert, PLUGIN_EDIT_META } from '../../src/editor/plugin-caps/doc-edit.js';
import { REPEAT_IGNORE_META } from '../../src/editor/repeat-last-action.js';
import { makeHarness } from './_plugin-harness.js';
import {
  registerCollabPluginSource,
  unregisterCollabPluginSource,
} from '../../src/editor/collab/collab-hooks.js';

const { nodes, marks } = schema;
const TAG_ID = 'tag-1';
const BLOCK_ID = 'block-1';

function sampleDoc(): PMNode {
  return nodes['doc']!.createChecked(null, [
    nodes['pocket']!.create({ id: newHeadingId() }, schema.text('1AC')),
    nodes['block']!.create({ id: BLOCK_ID }, schema.text('Advantage')),
    nodes['card']!.create(null, [
      nodes['tag']!.create({ id: TAG_ID }, schema.text('Warming is real')),
      nodes['cite_paragraph']!.create(null, [
        schema.text('Smith 24', [marks['cite_mark']!.create()]),
        schema.text(', professor'),
      ]),
      nodes['card_body']!.create(null, [
        schema.text('Read this ', [marks['highlight']!.create({ color: 'yellow' })]),
        schema.text('not this.'),
      ]),
    ]),
    nodes['analytic_unit']!.create(null, [
      nodes['analytic']!.create({ id: 'an-1' }, schema.text('Extend Smith')),
    ]),
  ]);
}

describe('doc.read engine', () => {
  it('returns the outline, cards and stats as plain JSON', () => {
    const s = readDocStructure(sampleDoc());
    expect(s.outline.map((o) => [o.type, o.level, o.text])).toEqual([
      ['pocket', 1, '1AC'],
      ['block', 3, 'Advantage'],
      ['tag', 4, 'Warming is real'],
      ['analytic', 4, 'Extend Smith'],
    ]);
    expect(s.cards).toEqual([
      {
        headingId: TAG_ID,
        kind: 'card',
        heading: 'Warming is real',
        cite: 'Smith 24',
        citeParagraphs: ['Smith 24, professor'],
        body: ['Read this not this.'],
        bodyRead: [[[0, 10]]],
        undertags: [],
      },
      {
        headingId: 'an-1',
        kind: 'analytic',
        heading: 'Extend Smith',
        cite: '',
        citeParagraphs: [],
        body: [],
        bodyRead: [],
        undertags: [],
      },
    ]);
    expect(s.stats.cards).toBe(1);
    expect(s.stats.readAloudWords.body).toBe(2); // "Read this" (highlighted)
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('doc.read bodyRead', () => {
  const hl = (color = 'yellow') => marks['highlight']!.create({ color });
  const card = (...paras: PMNode[]): PMNode =>
    nodes['doc']!.createChecked(null, [
      nodes['card']!.create(null, [nodes['tag']!.create({ id: 't' }, schema.text('Tag')), ...paras]),
    ]);
  const body = (...runs: PMNode[]): PMNode => nodes['card_body']!.create(null, runs);

  it('gives read ranges per body paragraph, parallel to body', () => {
    const doc = card(
      body(schema.text('The plan does '), schema.text('not', []), schema.text(' solve warming', [hl()])),
      body(schema.text('Nothing read here.')),
    );
    const [c] = readDocStructure(doc).cards;
    expect(c!.body).toEqual(['The plan does not solve warming', 'Nothing read here.']);
    expect(c!.bodyRead).toEqual([[[17, 31]], []]);
  });

  it('merges adjacent highlighted runs and leaves shaded text out', () => {
    const doc = card(
      body(
        schema.text('ab', [hl('yellow')]),
        schema.text('cd', [hl('green')]), // color change mid-word: one range
        schema.text('ef', [hl(), marks['shading']!.create()]),
        schema.text('gh', [hl()]),
      ),
    );
    expect(readDocStructure(doc).cards[0]!.bodyRead).toEqual([[[0, 4], [6, 8]]]);
  });

  it('offsets match textContent across inline atoms', () => {
    const doc = card(body(schema.text('one'), nodes['image']!.create(), schema.text('two', [hl()])));
    const c = readDocStructure(doc).cards[0]!;
    const [from, to] = c.bodyRead![0]![0]!;
    expect(c.body[0]!.slice(from, to)).toBe('two');
  });
});

describe('doc.read formatting', () => {
  const m = (name: string, attrs?: Record<string, unknown>) => marks[name]!.create(attrs ?? null);
  const card = (...paras: PMNode[]): PMNode =>
    nodes['doc']!.createChecked(null, [
      nodes['hat']!.create({ id: 'h' }, [schema.text('Hat '), schema.text('one', [m('italic')])]),
      nodes['card']!.create(null, [
        nodes['tag']!.create({ id: 't' }, [schema.text('Tag '), schema.text('X', [m('highlight', { color: 'cyan' })])]),
        ...paras,
      ]),
    ]);

  it('is absent unless asked for', () => {
    const r = readDocStructure(card(nodes['card_body']!.create(null, schema.text('x'))));
    expect(r.cards[0]!.formatting).toBeUndefined();
    expect(r.outline[0]!.formatting).toBeUndefined();
  });

  it('reports spans per part, parallel to the text fields', () => {
    const doc = card(
      nodes['cite_paragraph']!.create(null, [
        schema.text('Smith 24', [m('cite_mark')]),
        schema.text(' (prof)'),
      ]),
      nodes['card_body']!.create(null, [
        schema.text('ab', [m('underline_mark'), m('highlight', { color: 'yellow' })]),
        schema.text('cd', [m('underline_mark'), m('highlight', { color: 'green' })]),
        schema.text('ef', [m('emphasis_mark'), m('highlight', { color: 'green' })]),
        schema.text('gh', [m('highlight', { color: 'none' }), m('shading', { color: 'A0B1C2' })]),
        schema.text('ij', [m('bold')]),
      ]),
      nodes['undertag']!.create(null, schema.text('u')),
    );
    const r = readDocStructure(doc, { formatting: true });
    expect(r.outline.map((o) => o.formatting)).toEqual([
      [{ from: 4, to: 7, style: 'italic' }],
      [{ from: 4, to: 5, style: 'highlight', color: 'cyan' }],
    ]);
    const f = r.cards[0]!.formatting!;
    expect(f.heading).toEqual([{ from: 4, to: 5, style: 'highlight', color: 'cyan' }]);
    expect(f.citeParagraphs).toEqual([[{ from: 0, to: 8, style: 'cite' }]]);
    expect(f.undertags).toEqual([[]]);
    expect(f.body).toHaveLength(1);
    expect(f.body[0]).toEqual([
      { from: 0, to: 4, style: 'underline' }, // merged across the color change
      { from: 0, to: 2, style: 'highlight', color: 'yellow' },
      { from: 2, to: 6, style: 'highlight', color: 'green' }, // same color merged
      { from: 4, to: 6, style: 'emphasis' },
      { from: 6, to: 8, style: 'shading', color: '#a0b1c2' }, // 'none' highlight dropped
      { from: 8, to: 10, style: 'bold' },
    ]);
  });

  it('counts underline_direct (structural paragraphs) as underline', () => {
    const doc = nodes['doc']!.createChecked(null, [
      nodes['card']!.create(null, [
        nodes['tag']!.create({ id: 't' }, schema.text('Tag', [m('underline_direct')])),
      ]),
    ]);
    expect(readDocStructure(doc, { formatting: true }).cards[0]!.formatting!.heading).toEqual([
      { from: 0, to: 3, style: 'underline' },
    ]);
  });

  it('offsets match textContent across inline atoms', () => {
    const doc = card(
      nodes['card_body']!.create(null, [
        schema.text('one'),
        nodes['image']!.create(),
        schema.text('two', [m('italic')]),
      ]),
    );
    const c = readDocStructure(doc, { formatting: true }).cards[0]!;
    const [span] = c.formatting!.body[0]!;
    expect(c.body[0]!.slice(span!.from, span!.to)).toBe('two');
  });
});

describe('doc.edit engine', () => {
  const state = (): EditorState => EditorState.create({ doc: sampleDoc(), plugins: [history()] });

  it('inserts after a heading section, as one undo step, tagged with the plugin', () => {
    const st = state();
    const built = buildPluginInsert(st, { text: 'New tag', role: 'tag', at: { after: TAG_ID } }, 'demo');
    expect('tr' in built).toBe(true);
    if (!('tr' in built)) return;
    expect(built.tr.getMeta(PLUGIN_EDIT_META)).toBe('demo');
    expect(built.tr.getMeta(REPEAT_IGNORE_META)).toBe(true);
    const next = st.apply(built.tr);
    const tags = readDocStructure(next.doc).outline.filter((o) => o.type === 'tag').map((o) => o.text);
    expect(tags).toEqual(['Warming is real', 'New tag']);
    let undone = next;
    undo(next, (tr) => (undone = next.apply(tr)));
    expect(undone.doc.eq(st.doc)).toBe(true);
  });

  it('inserts at the end of the doc', () => {
    const st = state();
    const built = buildPluginInsert(st, { text: 'Closing block', role: 'block', at: 'end' }, 'demo');
    if (!('tr' in built)) throw new Error(built.error);
    const outline = readDocStructure(st.apply(built.tr).doc).outline;
    expect(outline[outline.length - 1]).toMatchObject({ type: 'block', text: 'Closing block' });
  });

  it('refuses unknown headings and bad requests', () => {
    expect(buildPluginInsert(state(), { text: 'x', at: { after: 'nope' } }, 'demo')).toEqual({ error: 'not-found' });
    expect(buildPluginInsert(state(), { text: 'x', role: 'table' as never }, 'demo')).toEqual({ error: 'bad-request' });
    expect(buildPluginInsert(state(), { text: 7 as never }, 'demo')).toEqual({ error: 'bad-request' });
    expect(buildPluginInsert(state(), { text: 'x'.repeat(100_001) }, 'demo')).toEqual({ error: 'bad-request' });
  });
});

describe('api.doc', () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });
  function mount(editable = true): EditorView {
    const el = document.createElement('div');
    document.body.append(el);
    view = new EditorView(el, {
      state: EditorState.create({ doc: sampleDoc(), plugins: [history()] }),
      editable: () => editable,
    });
    return view;
  }

  it('methods exist per permission', () => {
    const h = makeHarness({ d1: mount() });
    h.register('demo', ['doc.read']);
    expect(Object.keys(h.api().doc!)).toEqual(['read', 'jumpTo']);
    h.register('editor', ['doc.edit']);
    expect(Object.keys(h.api('editor').doc!)).toEqual(['insert']);
    h.register('none', ['doc.read'], []);
    expect(h.api('none').doc).toBeUndefined();
  });

  it('read targets the focused doc or a named one, null when not open', () => {
    const h = makeHarness({ d1: mount() });
    h.register('demo', ['doc.read']);
    const snap = h.api().doc!.read!()!;
    expect(snap).toMatchObject({ docUid: 'd1', docId: 'id-d1', title: 'd1.cmir' });
    expect(snap.cards).toHaveLength(2);
    expect(h.api().doc!.read!('missing')).toBeNull();
  });

  it('read passes { formatting: true } through and ignores junk options', () => {
    const h = makeHarness({ d1: mount() });
    h.register('demo', ['doc.read']);
    expect(h.api().doc!.read!(undefined, { formatting: true })!.cards[0]!.formatting).toBeDefined();
    expect(h.api().doc!.read!()!.cards[0]!.formatting).toBeUndefined();
    expect(h.api().doc!.read!(undefined, { formatting: 'yes' } as never)!.cards[0]!.formatting).toBeUndefined();
    expect(h.api().doc!.read!(undefined, 'formatting' as never)!.cards[0]!.formatting).toBeUndefined();
  });

  it('insert dispatches (deferred) and reports read mode instead of dropping silently', async () => {
    const v = mount();
    const h = makeHarness({ d1: v });
    h.register('demo', ['doc.edit']);
    expect(await h.api().doc!.insert!({ text: 'Plugin block', role: 'block', at: 'end' })).toEqual({ ok: true });
    expect(v.state.doc.lastChild!.textContent).toBe('Plugin block');
    expect(await h.api().doc!.insert!({ text: 'x', docUid: 'missing' })).toEqual({ ok: false, error: 'no-doc' });

    const ro = makeHarness({ d2: mount(false) });
    ro.register('demo', ['doc.edit']);
    expect(await ro.api().doc!.insert!({ text: 'x' })).toEqual({ ok: false, error: 'read-only' });
  });

  it('in a co-edited doc, asks the session for an undo step of its own', async () => {
    const isolateNextStep = vi.fn();
    registerCollabPluginSource({
      ownerUid: 'd1',
      plugins: () => [],
      ownsUndo: () => false,
      undo: () => false,
      redo: () => false,
      canRedo: () => false,
      isolateNextStep,
    });
    try {
      const h = makeHarness({ d1: mount() });
      h.register('demo', ['doc.edit']);
      expect(await h.api().doc!.insert!({ text: 'x', role: 'block', at: 'end' })).toEqual({ ok: true });
      expect(isolateNextStep).toHaveBeenCalledTimes(1);
    } finally {
      unregisterCollabPluginSource('d1');
    }
  });
});

describe('api.doc.jumpTo', () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });
  function mount(): EditorView {
    const el = document.createElement('div');
    document.body.append(el);
    view = new EditorView(el, { state: EditorState.create({ doc: sampleDoc() }) });
    return view;
  }

  it('selects the heading, or the start of its first cite paragraph', async () => {
    const v = mount();
    const h = makeHarness({ d1: v });
    h.register('demo', ['doc.read']);
    const doc = h.api('demo').doc!;
    expect(await doc.jumpTo!({ headingId: TAG_ID })).toEqual({ ok: true });
    expect(v.state.selection.$from.parent.type.name).toBe('tag');
    expect(await doc.jumpTo!({ headingId: TAG_ID, part: 'cite' })).toEqual({ ok: true });
    expect(v.state.selection.$from.parent.type.name).toBe('cite_paragraph');
    expect(v.state.selection.$from.parentOffset).toBe(0);
    // An analytic unit with no cite falls back to its heading.
    expect(await doc.jumpTo!({ headingId: 'an-1', part: 'cite' })).toEqual({ ok: true });
    expect(v.state.selection.$from.parent.type.name).toBe('analytic');
    // Any heading id works (a block here).
    expect(await doc.jumpTo!({ headingId: BLOCK_ID })).toEqual({ ok: true });
    expect(v.state.selection.$from.parent.type.name).toBe('block');
  });

  it('reports not-found, doc-not-open and bad-request', async () => {
    const h = makeHarness({ d1: mount() });
    h.register('demo', ['doc.read']);
    const doc = h.api('demo').doc!;
    expect(await doc.jumpTo!({ headingId: 'gone' })).toEqual({ ok: false, error: 'not-found' });
    expect(await doc.jumpTo!({ headingId: TAG_ID, docUid: 'nope' })).toEqual({ ok: false, error: 'doc-not-open' });
    expect(await doc.jumpTo!({} as never)).toEqual({ ok: false, error: 'bad-request' });
  });
});
