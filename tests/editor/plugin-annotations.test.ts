// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView, type Decoration, type DecorationSet } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import {
  ANNOTATION_MAX_ITEMS,
  buildAnnotationDecorations,
  hidePluginAnnotations,
  pluginAnnotationsPlugin,
  resetPluginAnnotationsForTests,
} from '../../src/editor/plugin-annotations.js';
import { makeHarness } from './_plugin-harness.js';

const { nodes, marks } = schema;
const TAG_ID = 'tag-1';
const TAG2_ID = 'tag-2';
const MIRROR_TAG = 'tag-mirror';

function card(id: string, tag: string, cites: string[], bodies: string[]): PMNode {
  return nodes['card']!.create(null, [
    nodes['tag']!.create({ id }, schema.text(tag)),
    ...cites.map((c, i) =>
      nodes['cite_paragraph']!.create(null, i === 0 ? [schema.text('Smith 24', [marks['cite_mark']!.create()]), schema.text(c)] : [schema.text(c)]),
    ),
    ...bodies.map((b) => nodes['card_body']!.create(null, schema.text(b))),
  ]);
}

function sampleDoc(): PMNode {
  return nodes['doc']!.createChecked(null, [
    card(TAG_ID, 'Warming is real', [', Freelance writer, "Title," Blog, 2024', 'second cite para'], ['one two one', 'body two']),
    card(TAG2_ID, 'Second card', [', Professor at Yale'], ['text']),
    nodes['transclusion_ref']!.create({ source_ref: 'other.cmir', source_heading_id: 'h' }, [
      card(MIRROR_TAG, 'Mirrored', [', Mirror quals'], ['mirror body']),
    ]),
  ]);
}

function makeView(doc = sampleDoc()): EditorView {
  return new EditorView(document.createElement('div'), {
    state: EditorState.create({ doc, plugins: [pluginAnnotationsPlugin()] }),
  });
}

/** Every mark in the view as [text, class, title]. */
function marksIn(view: EditorView): [string, string, string][] {
  const set = view.someProp('decorations', (f) => f(view.state)) as DecorationSet | undefined;
  return (set?.find() ?? [])
    .map((d: Decoration) => {
      const attrs = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
      return [view.state.doc.textBetween(d.from, d.to), attrs['class']!, attrs['title']!] as [string, string, string];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const views: EditorView[] = [];
/** Harness first, then views (the harness resets the registry, which
 *  would drop the views' grant listeners, as it never does in the app). */
function openViews(names: string[]): { h: ReturnType<typeof makeHarness>; v: Record<string, EditorView> } {
  const v: Record<string, EditorView> = {};
  const h = makeHarness(v);
  for (const n of names) {
    v[n] = makeView();
    views.push(v[n]!);
  }
  return { h, v };
}

function setup(perms = ['doc.annotate']) {
  const { h, v } = openViews(['a', 'b']);
  const a = v['a']!;
  const b = v['b']!;
  h.register('demo', perms);
  return { h, a, b, api: () => h.api('demo').annotations! };
}

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  resetPluginAnnotationsForTests();
});

describe('api.annotations anchoring', () => {
  it('marks a heading, a cite substring, a later cite paragraph and the nth occurrence', () => {
    const { a, api } = setup();
    const res = api().set([
      { headingId: TAG_ID, part: 'heading', severity: 'info', message: 'tag note' },
      { headingId: TAG_ID, part: 'cite', match: 'Freelance writer', severity: 'warning', message: 'Vague quals' },
      { headingId: TAG_ID, part: 'cite', index: 1, severity: 'error', message: 'second para' },
      { headingId: TAG_ID, part: 'body', match: 'one', occurrence: 1, severity: 'error', message: 'second one' },
    ]);
    expect(res).toEqual({ ok: true, placed: 4, unplaced: 0 });
    const found = marksIn(a);
    expect(found.map(([t]) => t)).toEqual(['Freelance writer', 'one', 'second cite para', 'Warming is real']);
    // The 2nd "one" (offset 8), not the first.
    const one = found.find(([t]) => t === 'one')!;
    expect(one[2]).toBe('[DEMO] second one');
  });

  it('counts anchors that do not land as unplaced (never throws for them)', () => {
    const { api } = setup();
    const res = api().set([
      { headingId: 'nope', part: 'heading', severity: 'info', message: 'x' },
      { headingId: TAG_ID, part: 'cite', index: 5, severity: 'info', message: 'x' },
      { headingId: TAG_ID, part: 'cite', match: 'not there', severity: 'info', message: 'x' },
      { headingId: TAG_ID, part: 'body', match: 'one', occurrence: 2, severity: 'info', message: 'x' },
      { headingId: TAG_ID, part: 'undertag', severity: 'info', message: 'x' },
      { headingId: TAG_ID, part: 'cite', severity: 'info', message: '' },
      { headingId: TAG_ID, part: 'bogus' as 'cite', severity: 'info', message: 'x' },
      { headingId: TAG_ID, part: 'cite', match: 'x'.repeat(2000), severity: 'info', message: 'x' },
    ]);
    expect(res).toEqual({ ok: true, placed: 0, unplaced: 8 });
  });

  it('never marks mirrored content (a linked copy)', () => {
    const { api } = setup();
    expect(api().set([{ headingId: MIRROR_TAG, part: 'cite', severity: 'info', message: 'x' }])).toEqual({
      ok: true,
      placed: 0,
      unplaced: 1,
    });
  });

  it('style and color default by severity; explicit ones apply; unknown values fall back; unknown fields ignored', () => {
    const { a, api } = setup();
    api().set([
      { headingId: TAG_ID, part: 'heading', severity: 'error', message: 'e' },
      { headingId: TAG2_ID, part: 'heading', severity: 'info', message: 'i' },
      { headingId: TAG_ID, part: 'cite', match: 'Blog', severity: 'warning', message: 'w', style: 'tint', color: 'green' },
      {
        headingId: TAG2_ID,
        part: 'cite',
        match: 'Yale',
        severity: 'warning',
        message: 'w2',
        style: 'wavy-neon' as 'tint',
        color: '#ff00ff' as 'red',
        futureField: 1,
      } as never,
    ]);
    const cls = Object.fromEntries(marksIn(a).map(([t, c]) => [t, c]));
    expect(cls['Warming is real']).toBe('pmd-plugin-mark pmd-plugin-mark--squiggle pmd-plugin-mark--red');
    expect(cls['Second card']).toBe('pmd-plugin-mark pmd-plugin-mark--dotted pmd-plugin-mark--blue');
    expect(cls['Blog']).toBe('pmd-plugin-mark pmd-plugin-mark--tint pmd-plugin-mark--green');
    expect(cls['Yale']).toBe('pmd-plugin-mark pmd-plugin-mark--squiggle pmd-plugin-mark--amber');
  });

  it('rejects a non-array and an over-cap list', () => {
    const { api } = setup();
    expect(() => api().set('x' as never)).toThrow(/array/);
    const many = Array.from({ length: ANNOTATION_MAX_ITEMS + 1 }, () => ({
      headingId: TAG_ID,
      part: 'heading' as const,
      severity: 'info' as const,
      message: 'x',
    }));
    expect(() => api().set(many)).toThrow(/at most/);
  });
});

describe('api.annotations lifecycle', () => {
  it('set replaces only this plugin’s marks; clear removes them; other plugins keep theirs', () => {
    const { h, v } = openViews(['a']);
    const a = v['a']!;
    h.register('one', ['doc.annotate']);
    h.register('two', ['doc.annotate']);
    h.api('one').annotations!.set([{ headingId: TAG_ID, part: 'heading', severity: 'info', message: 'first' }]);
    h.api('two').annotations!.set([{ headingId: TAG2_ID, part: 'heading', severity: 'info', message: 'other' }]);
    h.api('one').annotations!.set([{ headingId: TAG_ID, part: 'cite', match: 'Blog', severity: 'info', message: 'second' }]);
    expect(marksIn(a).map(([t, , title]) => [t, title])).toEqual([
      ['Blog', '[ONE] second'],
      ['Second card', '[TWO] other'],
    ]);
    h.api('one').annotations!.clear();
    expect(marksIn(a).map(([t]) => t)).toEqual(['Second card']);
  });

  it('targets another open doc by docUid, and the focused one by default', () => {
    const { a, b, api } = setup();
    api().set([{ headingId: TAG_ID, part: 'heading', severity: 'info', message: 'x' }], { docUid: 'b' });
    expect(marksIn(a)).toEqual([]);
    expect(marksIn(b)).toHaveLength(1);
    expect(api().set([], { docUid: 'missing' })).toEqual({ ok: false, error: 'no-doc' });
  });

  it('marks follow edits until the next set, and stay out of the doc and undo history', () => {
    const { a, api } = setup();
    api().set([{ headingId: TAG_ID, part: 'cite', match: 'Freelance writer', severity: 'warning', message: 'w' }]);
    const before = a.state.doc;
    a.dispatch(a.state.tr.insertText('NEW ', 2)); // inside the tag
    expect(marksIn(a).map(([t]) => t)).toEqual(['Freelance writer']);
    // Setting marks never changed the document itself.
    expect(before.eq(sampleDoc())).toBe(true);
  });

  it('revoking doc.annotate clears the plugin’s marks everywhere', () => {
    const { h, a, b, api } = setup();
    api().set([{ headingId: TAG_ID, part: 'heading', severity: 'info', message: 'x' }]);
    api().set([{ headingId: TAG_ID, part: 'heading', severity: 'info', message: 'x' }], { docUid: 'b' });
    h.regrant('demo', []);
    expect(marksIn(a)).toEqual([]);
    expect(marksIn(b)).toEqual([]);
    expect(h.api('demo').annotations).toBeUndefined();
  });

  it('a doc where the user hid the plugin’s marks answers `hidden` for the session', () => {
    const { a, api } = setup();
    api().set([{ headingId: TAG_ID, part: 'heading', severity: 'info', message: 'x' }]);
    hidePluginAnnotations(a, 'a', 'demo');
    expect(marksIn(a)).toEqual([]);
    expect(api().set([{ headingId: TAG_ID, part: 'heading', severity: 'info', message: 'x' }])).toEqual({
      ok: false,
      error: 'hidden',
    });
    // Other docs are unaffected.
    expect(api().set([], { docUid: 'b' })).toEqual({ ok: true, placed: 0, unplaced: 0 });
  });
});

describe('annotation actions', () => {
  it('run only while the plugin holds doc.annotate; at most two; a throw is contained', () => {
    const { h } = setup();
    const run = vi.fn();
    const doc = sampleDoc();
    const built = buildAnnotationDecorations(
      doc,
      [
        {
          headingId: TAG_ID,
          part: 'heading',
          severity: 'info',
          message: 'x',
          actions: [
            { label: 'Fix', run },
            {
              label: 'Boom',
              run: () => {
                throw new Error('boom');
              },
            },
            { label: 'Third', run },
          ],
        },
      ],
      { pluginId: 'demo', pluginName: 'Demo', docUid: 'a' },
    );
    const actions = (built.decos[0]!.spec as { actions: { label: string; run(): void }[] }).actions;
    expect(actions.map((x) => x.label)).toEqual(['Fix', 'Boom']);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    actions[0]!.run();
    actions[1]!.run();
    expect(run).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    h.regrant('demo', []);
    actions[0]!.run();
    expect(run).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
