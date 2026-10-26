// @vitest-environment jsdom

/**
 * Copy from read mode copies what read mode shows (read-mode-copy.ts).
 *
 * Driven through the real hooks: ProseMirror's `transformCopied` on a view
 * with the read-mode plugin (what Cmd-C runs) and
 * `serializeRangesForClipboard` (what the outline / discontinuous copies
 * run). The visibility rule itself is read mode's (`isReadModeKeptText`),
 * covered in its own tests — these pin that the copy path applies it, keeps
 * open slices valid, and stays out of the way when read mode or the setting
 * is off.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';
import { readModeCopyPlugin, readModeVisibleSlice, inlineParentOf } from '../../src/editor/read-mode-copy.js';
import { serializeRangesForClipboard } from '../../src/editor/clipboard-slice.js';

const hl = schema.marks['highlight']!.create({ color: 'yellow' });
const cite = schema.marks['cite_mark']!.create();
const t = (s: string, ...marks: ReturnType<typeof schema.text>['marks']) => schema.text(s, marks);
const tag = (s: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, t(s));
const body = (...inline: PMNode[]) => schema.nodes['card_body']!.create(null, inline);
const card = (...c: PMNode[]) => schema.nodes['card']!.createChecked(null, c);

function makeDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['block']!.create({ id: newHeadingId() }, t('Block heading')),
    schema.nodes['paragraph']!.create(null, t('loose paragraph, hidden in read mode')),
    card(
      tag('Tag one'),
      schema.nodes['undertag']!.create(null, t('undertag gone')),
      schema.nodes['cite_paragraph']!.create(null, [t('noise '), t('Smith 24', cite), t(' more noise')]),
      body(t('unread alpha '), t('READ ONE', hl), t(' unread bravo '), t('READ TWO', hl), t(' tail')),
      body(t('all of this is unread')),
    ),
    card(tag('Tag two'), body(t('skip '), t('READ THREE', hl))),
  ]);
}

/** Doc position of `needle` (start) in the doc's text. */
function posOf(doc: PMNode, needle: string, offset = 0): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText && n.text?.includes(needle)) found = pos + n.text.indexOf(needle) + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${needle}"`);
  return found;
}

const open: EditorView[] = [];
function mount(doc: PMNode, readMode: boolean): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc, plugins: [readModePlugin, readModeCopyPlugin()] }),
  });
  if (readMode) view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  open.push(view);
  return view;
}

function select(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** What Cmd-C would put on the clipboard: the selection through every transformCopied. */
function copied(view: EditorView): Slice {
  let slice = view.state.selection.content();
  view.someProp('transformCopied', (f) => {
    slice = f(slice, view);
  });
  return slice;
}

const text = (s: Slice) => s.content.textBetween(0, s.content.size, '\n', '\n');

beforeEach(() => {
  settings.set('readModeCopyVisible', true);
  settings.set('readModeParagraphIntegrity', false);
  settings.set('readModeKeepEntireCite', false);
  settings.set('readModeShowUndertags', false);
});

afterEach(() => {
  for (const v of open.splice(0)) v.destroy();
  settings.set('readModeCopyVisible', true);
});

describe('Cmd-C in read mode', () => {
  it('a whole-document copy carries only what read mode shows', () => {
    const view = mount(makeDoc(), true);
    select(view, 0, view.state.doc.content.size);
    const out = copied(view);
    expect(text(out)).toBe(['Block heading', 'Tag one', 'Smith 24', 'READ ONE READ TWO', 'Tag two', 'READ THREE'].join('\n'));
    // Structure survives: heading, two cards; the loose paragraph is gone.
    expect(out.content.childCount).toBe(3);
    expect(out.content.child(0).type.name).toBe('block');
    expect(out.content.child(1).type.name).toBe('card');
  });

  it('a selection cutting into a card keeps the slice open and drops the unread text', () => {
    const doc = makeDoc();
    const view = mount(doc, true);
    // From inside "unread alpha" to inside "all of this is unread": open at both ends, depth 2.
    select(view, posOf(doc, 'unread alpha', 3), posOf(doc, 'all of this', 6));
    const before = view.state.selection.content();
    expect([before.openStart, before.openEnd]).toEqual([2, 2]);
    const out = copied(view);
    // Paragraph integrity off: the two bodies flow into one, as on screen —
    // no return the display doesn't show. The merged body is still a
    // textblock at the end, so the open depth holds.
    expect(text(out)).toBe('READ ONE READ TWO');
    expect(out.content.firstChild!.childCount).toBe(1);
    expect(out.openStart).toBe(2);
    expect(out.openEnd).toBe(2);
    expect(out.content.firstChild!.type.name).toBe('card');
  });

  it('…and keeps each body on its own line with "preserve paragraph integrity" on', () => {
    settings.set('readModeParagraphIntegrity', true);
    const doc = makeDoc();
    const view = mount(doc, true);
    select(view, posOf(doc, 'unread alpha', 3), posOf(doc, 'all of this', 6));
    const out = copied(view);
    // Two bodies: the audible first, and the open (empty) last one kept for the depth.
    expect(out.content.firstChild!.childCount).toBe(2);
    expect(text(out)).toBe('READ ONE READ TWO\n');
    expect(out.openEnd).toBe(2);
    settings.set('readModeParagraphIntegrity', false);
  });

  it('a selection across two cards: whole-card rules in the middle, open rules at the ends', () => {
    const doc = makeDoc();
    const view = mount(doc, true);
    select(view, posOf(doc, 'unread bravo'), posOf(doc, 'READ THREE', 10));
    const out = copied(view);
    expect(text(out)).toBe('READ TWO\nTag two\nREAD THREE');
    expect(out.openStart).toBe(2);
    expect(out.openEnd).toBe(2);
  });

  it('a selection within one body keeps the highlighted runs only, spaced like the display', () => {
    const doc = makeDoc();
    const view = mount(doc, true);
    select(view, posOf(doc, 'unread alpha'), posOf(doc, ' tail') + 5);
    expect(text(copied(view))).toBe('READ ONE READ TWO');
  });

  it('copies normally with read mode off', () => {
    const doc = makeDoc();
    const view = mount(doc, false);
    select(view, 0, doc.content.size);
    expect(text(copied(view))).toBe(text(view.state.selection.content()));
    expect(text(copied(view))).toContain('all of this is unread');
  });

  it('copies normally when the setting is off, even in read mode', () => {
    settings.set('readModeCopyVisible', false);
    const doc = makeDoc();
    const view = mount(doc, true);
    select(view, 0, doc.content.size);
    expect(text(copied(view))).toContain('all of this is unread');
  });

  it('follows the other read-mode settings (keep entire cite)', () => {
    settings.set('readModeKeepEntireCite', true);
    const doc = makeDoc();
    const view = mount(doc, true);
    select(view, 0, doc.content.size);
    expect(text(copied(view))).toContain('noise Smith 24 more noise');
    settings.set('readModeKeepEntireCite', false);
  });
});

describe('command copies (outline, discontinuous) in read mode', () => {
  it('serializeRangesForClipboard reduces a block range', () => {
    const doc = makeDoc();
    const view = mount(doc, true);
    const cardPos = posOf(doc, 'Tag two') - 2; // before the card's tag: card start
    const cardNode = doc.nodeAt(cardPos)!;
    expect(cardNode.type.name).toBe('card');
    const { text: plain, html } = serializeRangesForClipboard(view, [{ from: cardPos, to: cardPos + cardNode.nodeSize }]);
    expect(plain).toBe('Tag two\nREAD THREE');
    expect(html).not.toContain('skip ');
  });

  it('serializeRangesForClipboard reduces an inline range using its paragraph kind', () => {
    const doc = makeDoc();
    const view = mount(doc, true);
    const from = posOf(doc, 'unread alpha');
    const to = posOf(doc, ' tail') + 5;
    expect(inlineParentOf(doc, from, to)?.type.name).toBe('card_body');
    expect(serializeRangesForClipboard(view, [{ from, to }]).text).toBe('READ ONE READ TWO');
    // Off: the same range copies whole.
    settings.set('readModeCopyVisible', false);
    expect(serializeRangesForClipboard(view, [{ from, to }]).text).toContain('unread alpha');
  });

  it('readModeVisibleSlice leaves an inline slice alone when its paragraph kind is unknown', () => {
    const doc = makeDoc();
    const inline = doc.slice(posOf(doc, 'unread alpha'), posOf(doc, ' tail') + 5);
    expect(inline.content.firstChild!.isInline).toBe(true);
    expect(readModeVisibleSlice(inline)).toBe(inline);
  });
});
