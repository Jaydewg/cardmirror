/**
 * Shrink refuses cite lines by CONTENT, not only by node type. The cite
 * classifier retypes a paragraph from its inline content; shrink reads
 * the same signal (non-whitespace text carrying `cite_mark`), so a
 * paragraph still typed `card_body` / `paragraph` that holds a cite is
 * left alone — and the "this is a cite line" toast explains the refusal.
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { shrinkText, smartShrinkText, compileShrinkProtections } from '../../src/editor/ribbon-commands.js';
import { showToast } from '../../src/editor/toast.js';

const m = (name: string) => schema.marks[name]!.create();
const t = (text: string, ...marks: ReturnType<typeof m>[]) => schema.text(text, marks);
const tag = (text: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
const body = (...inl: PMNode[]) => schema.nodes['card_body']!.create(null, inl);
const para = (...inl: PMNode[]) => schema.nodes['paragraph']!.create(null, inl);
const card = (...ch: PMNode[]) => schema.nodes['card']!.createChecked(null, ch);
const doc = (...ch: PMNode[]) => schema.nodes['doc']!.createChecked(null, ch);

const NORMAL_PT = 11;
const effectivePt = (node: PMNode | null): number => {
  const mark = node?.marks.find((mk) => mk.type.name === 'font_size');
  return mark ? Number(mark.attrs['halfPoints']) / 2 : NORMAL_PT;
};
const protections = () => compileShrinkProtections([], '', '');
const shrink = shrinkText(effectivePt, () => NORMAL_PT, () => false, protections);
const smart = smartShrinkText(effectivePt, () => NORMAL_PT, () => false, protections);

function run(cmd: typeof shrink, d: PMNode, from: number, to = from): EditorState | null {
  let state = EditorState.create({ doc: d });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}
function ptOf(d: PMNode, needle: string): number {
  let found = NORMAL_PT;
  d.descendants((node) => {
    if (node.isText && node.text!.includes(needle)) found = effectivePt(node);
    return true;
  });
  return found;
}

/** Card whose cite line still carries the body TYPE (classifier not run). */
const staleCite = () =>
  doc(card(tag('Tag'), body(t('Smith 24', m('cite_mark')), t(' — John Smith, Journal')), body(t('Body text here that shrinks.'))));

describe('shrink skips cite lines by content', () => {
  it('caret in the card: the body shrinks, the cite-marked card_body does not', () => {
    const d = staleCite();
    const bodyStart = d.firstChild!.child(0).nodeSize + d.firstChild!.child(1).nodeSize + 2;
    const next = run(shrink, d, bodyStart + 2)!;
    expect(next).not.toBeNull();
    expect(ptOf(next.doc, 'shrinks')).toBe(8);
    expect(ptOf(next.doc, 'John Smith')).toBe(NORMAL_PT);
    expect(ptOf(next.doc, 'Smith 24')).toBe(NORMAL_PT);
  });

  it('a selection spanning the whole card leaves the cite-marked block alone', () => {
    const d = staleCite();
    const next = run(shrink, d, 3, d.content.size - 2)!; // tag text → end of body text
    expect(ptOf(next.doc, 'shrinks')).toBe(8);
    expect(ptOf(next.doc, 'John Smith')).toBe(NORMAL_PT);
  });

  it('smart shrink applies the same rule', () => {
    const d = staleCite();
    const next = run(smart, d, 3)!;
    expect(ptOf(next.doc, 'shrinks')).toBe(5);
    expect(ptOf(next.doc, 'John Smith')).toBe(NORMAL_PT);
  });

  it('a doc-level paragraph holding a cite is refused, with the cite-line toast', () => {
    vi.mocked(showToast).mockClear();
    const d = doc(para(t('Smith 24', m('cite_mark')), t(' — John Smith')));
    expect(run(shrink, d, 3)).toBeNull();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.stringMatching(/cite line/), expect.anything());
  });

  it('whitespace-only cite debris does not make a body paragraph a cite', () => {
    const d = doc(card(tag('Tag'), body(t('Body'), t(' ', m('cite_mark')), t('text that shrinks.'))));
    const next = run(shrink, d, 3)!;
    expect(ptOf(next.doc, 'shrinks')).toBe(8);
  });
});
