/**
 * "Turn <color> into Locked Highlighting" — lockHighlightColor. Lock
 * Highlighting filtered to one highlight color: runs highlighted in the
 * target color lose the highlight and gain the protected gray shading
 * (existing shading is kept); every other color is untouched. Scope is
 * the whole doc or the selection, like Standardize Highlighting.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { lockHighlightColor, getRibbonCommand } from '../../src/editor/ribbon-commands.js';
import { REFERENCE_SHADING_HEX } from '../../src/editor/create-reference.js';
import { countReadAloudSplit } from '../../src/editor/word-count.js';

const { nodes, marks } = schema;

function tag(text: string) {
  return nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(...inline: PMNode[]) {
  return nodes['card_body']!.create(null, inline);
}
function card(...children: PMNode[]) {
  return nodes['card']!.createChecked(null, children);
}
function doc(...children: PMNode[]) {
  return nodes['doc']!.createChecked(null, children);
}
const t = (text: string, ...m: Mark[]) => schema.text(text, m);
const hl = (color: string): Mark => marks['highlight']!.create({ color });
const sh = (color: string): Mark => marks['shading']!.create({ color });

function run(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

/** Every text run as { text, highlight, shading } color attrs (null = no mark). */
function runs(d: PMNode): { text: string; highlight: string | null; shading: string | null }[] {
  const out: { text: string; highlight: string | null; shading: string | null }[] = [];
  d.descendants((n) => {
    if (!n.isText) return true;
    const h = n.marks.find((m) => m.type.name === 'highlight');
    const s = n.marks.find((m) => m.type.name === 'shading');
    out.push({
      text: n.text ?? '',
      highlight: h ? String(h.attrs['color']) : null,
      shading: s ? String(s.attrs['color']) : null,
    });
    return true;
  });
  return out;
}

/** Select [offset, offset + len) inside the first card_body. */
function selectInBody(d: PMNode, offset: number, len: number): EditorState {
  let start = -1;
  d.descendants((n, p) => {
    if (start === -1 && n.type.name === 'card_body') start = p + 1;
  });
  const s = EditorState.create({ doc: d });
  return s.apply(
    s.tr.setSelection(TextSelection.create(s.doc, start + offset, start + offset + len)),
  );
}

const mixed = () =>
  doc(
    card(
      tag('T'),
      body(t('a', hl('lightGray')), t('b', hl('yellow')), t('c', hl('lightGray')), t('d')),
    ),
  );

describe('lockHighlightColor', () => {
  it('locks only runs in the target color (document scope)', () => {
    const state = EditorState.create({ doc: mixed() });
    const next = run(state, lockHighlightColor('document', () => 'lightGray'));
    expect(next).not.toBeNull();
    expect(runs(next!.doc)).toEqual([
      { text: 'T', highlight: null, shading: null },
      { text: 'a', highlight: null, shading: REFERENCE_SHADING_HEX },
      { text: 'b', highlight: 'yellow', shading: null }, // other color: untouched
      { text: 'c', highlight: null, shading: REFERENCE_SHADING_HEX },
      { text: 'd', highlight: null, shading: null }, // unmarked stays unmarked
    ]);
  });

  it('keeps existing shading instead of overwriting it', () => {
    const d = doc(card(tag('T'), body(t('a', hl('lightGray'), sh('FFFF00')))));
    const next = run(EditorState.create({ doc: d }), lockHighlightColor('document', () => 'lightGray'));
    expect(runs(next!.doc)).toEqual([
      { text: 'T', highlight: null, shading: null },
      { text: 'a', highlight: null, shading: 'FFFF00' },
    ]);
  });

  it('selection scope only touches the selection', () => {
    // Select 'a' and 'b' only; 'c' is lightGray but outside.
    const state = selectInBody(mixed(), 0, 2);
    const next = run(state, lockHighlightColor('selection', () => 'lightGray'));
    expect(runs(next!.doc)).toEqual([
      { text: 'T', highlight: null, shading: null },
      { text: 'a', highlight: null, shading: REFERENCE_SHADING_HEX },
      { text: 'b', highlight: 'yellow', shading: null },
      { text: 'c', highlight: 'lightGray', shading: null },
      { text: 'd', highlight: null, shading: null },
    ]);
  });

  it('selection scope with an empty selection is a no-op returning false', () => {
    const state = EditorState.create({ doc: mixed() }); // collapsed cursor at doc start
    let dispatched = false;
    const ok = lockHighlightColor('selection', () => 'lightGray')(state, () => { dispatched = true; });
    expect(ok).toBe(false);
    expect(dispatched).toBe(false);
  });

  it('returns false and does not dispatch when nothing matches', () => {
    const state = EditorState.create({ doc: mixed() });
    let dispatched = false;
    const ok = lockHighlightColor('document', () => 'cyan')(state, () => { dispatched = true; });
    expect(ok).toBe(false);
    expect(dispatched).toBe(false);
  });

  it('without dispatch (availability probe) returns true and changes nothing', () => {
    const state = EditorState.create({ doc: mixed() });
    expect(lockHighlightColor('document', () => 'lightGray')(state)).toBe(true);
    expect(runs(state.doc)[1]).toEqual({ text: 'a', highlight: 'lightGray', shading: null });
  });

  it('reads the target color at run time, not at build time', () => {
    let target = 'yellow';
    const cmd = lockHighlightColor('document', () => target);
    target = 'lightGray';
    const next = run(EditorState.create({ doc: mixed() }), cmd);
    expect(runs(next!.doc)[2]).toEqual({ text: 'b', highlight: 'yellow', shading: null });
    expect(runs(next!.doc)[1]).toEqual({ text: 'a', highlight: null, shading: REFERENCE_SHADING_HEX });
  });

  it('locked text drops out of the read-aloud (speech time) count', () => {
    const d = doc(card(tag('T'), body(t('gray words ', hl('lightGray')), t('yellow words', hl('yellow')))));
    expect(countReadAloudSplit(d).body).toBe(4);
    const next = run(EditorState.create({ doc: d }), lockHighlightColor('document', () => 'lightGray'));
    expect(countReadAloudSplit(next!.doc).body).toBe(2);
  });
});

describe('standardizeLockedHighlights ribbon command', () => {
  it('is wired through commandFor and uses the setting (default lightGray)', () => {
    const state = EditorState.create({ doc: mixed() });
    const next = run(state, getRibbonCommand('standardizeLockedHighlights'));
    expect(next).not.toBeNull();
    expect(runs(next!.doc).map((r) => r.shading)).toEqual([
      null,
      REFERENCE_SHADING_HEX,
      null,
      REFERENCE_SHADING_HEX,
      null,
    ]);
  });

  it('with a selection, only converts inside it', () => {
    const state = selectInBody(mixed(), 2, 1); // just 'c'
    const next = run(state, getRibbonCommand('standardizeLockedHighlights'));
    expect(runs(next!.doc).map((r) => r.highlight)).toEqual([
      null,
      'lightGray', // 'a' outside the selection: untouched
      'yellow',
      null,
      null,
    ]);
  });
});
