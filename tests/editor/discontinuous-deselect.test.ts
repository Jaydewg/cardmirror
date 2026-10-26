// @vitest-environment jsdom

/**
 * Ctrl/Cmd-click on a word that is already part of the discontinuous
 * selection removes the range that word belongs to (PR #110), instead of
 * re-adding it as a no-op. Two pieces: `selectedRangeIndexForUnit`
 * decides which range a click's word unit belongs to (the unit carries
 * the word's trailing whitespace, which must NOT count — a click on the
 * word right after a range is a plain add), and `setManualShadowSelection`
 * parks the caret at the click when the last range goes.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  wordSelectionPlugin,
  discontinuousRangeFor,
  selectedRangeIndexForUnit,
} from '../../src/editor/word-selection-plugin.js';
import {
  buildSimilarSelectionPlugin,
  setManualShadowSelection,
  getSimilarSelectionState,
} from '../../src/editor/similar-selection-plugin.js';

const ONE = 'alpha bravo charlie';
const TWO = 'delta echo foxtrot';

function makeView(): EditorView {
  const card = (text: string) =>
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
      schema.nodes['card_body']!.create(null, schema.text(text)),
    ]);
  const doc = schema.nodes['doc']!.create(null, [card(ONE), card(TWO)]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, {
    state: EditorState.create({ doc, plugins: [wordSelectionPlugin, buildSimilarSelectionPlugin()] }),
  });
}

function bodyPos(view: EditorView, index: number, offset: number): number {
  const starts: number[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === 'card_body') starts.push(pos + 1);
    return n.type.name !== 'card_body';
  });
  return starts[index]! + offset;
}

/** The word unit a Ctrl/Cmd single click at `pos` would add. */
const wordAt = (view: EditorView, pos: number) => discontinuousRangeFor(view, pos, null, 1);

describe('selectedRangeIndexForUnit', () => {
  it('finds the range a clicked word sits inside', () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    const ranges = [
      { from: b(0), to: b(5) }, // "alpha"
      { from: b(12), to: b(19) }, // "charlie"
    ];
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, b(2)))).toBe(0);
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, b(14)))).toBe(1);
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, b(7)))).toBe(-1); // "bravo"
  });

  it('a partial overlap with the word counts (a range ending mid-word)', () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    const ranges = [{ from: b(0), to: b(8) }]; // "alpha br"
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, b(9)))).toBe(0); // "bravo"
  });

  it("the unit's trailing whitespace never matches: the word after a range is an add, not a deselect", () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    // "alpha " selected, including the space the unit absorbs.
    const ranges = [{ from: b(0), to: b(6) }];
    // Click on "bravo": its unit is b(6)–b(12); the range ends exactly at b(6).
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, b(8)))).toBe(-1);
    // And a range that covers only the space after "alpha" is not a hit for "alpha" either.
    expect(selectedRangeIndexForUnit(view.state.doc, [{ from: b(5), to: b(6) }], wordAt(view, b(2)))).toBe(-1);
  });

  it('an all-whitespace unit (click on the gap) never matches', () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    const unit = { from: b(5), to: b(6) };
    expect(selectedRangeIndexForUnit(view.state.doc, [{ from: b(0), to: b(19) }], unit)).toBe(-1);
    expect(selectedRangeIndexForUnit(view.state.doc, [], wordAt(view, b(2)))).toBe(-1);
    expect(selectedRangeIndexForUnit(view.state.doc, [{ from: b(0), to: b(5) }], { from: b(2), to: b(2) })).toBe(-1);
  });

  it('works across cards', () => {
    const view = makeView();
    const ranges = [
      { from: bodyPos(view, 0, 0), to: bodyPos(view, 0, 5) },
      { from: bodyPos(view, 1, 6), to: bodyPos(view, 1, 10) }, // "echo"
    ];
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, bodyPos(view, 1, 7)))).toBe(1);
    expect(selectedRangeIndexForUnit(view.state.doc, ranges, wordAt(view, bodyPos(view, 1, 1)))).toBe(-1);
  });
});

describe('setManualShadowSelection with caretWhenEmpty', () => {
  it('removing the last range clears the shadow and parks the caret at the click', () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    setManualShadowSelection(view, [{ from: b(0), to: b(5) }]);
    expect(getSimilarSelectionState(view.state)?.matches.length).toBe(1);
    setManualShadowSelection(view, [], b(3));
    const st = getSimilarSelectionState(view.state);
    expect(st?.matches ?? []).toEqual([]);
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.from).toBe(b(3));
  });

  it('removing one of several ranges keeps the rest (and ignores the caret hint)', () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    const keep = { from: b(12), to: b(19) };
    setManualShadowSelection(view, [{ from: b(0), to: b(5) }, keep]);
    setManualShadowSelection(view, [keep], b(3));
    const st = getSimilarSelectionState(view.state);
    expect(st?.matches.map((r) => [r.from, r.to])).toEqual([[keep.from, keep.to]]);
    // The PM cursor sits inside the surviving range, as the shadow contract says.
    expect(view.state.selection.from).toBeGreaterThanOrEqual(keep.from);
    expect(view.state.selection.from).toBeLessThanOrEqual(keep.to);
  });

  it('without the hint, clearing leaves the selection where it was', () => {
    const view = makeView();
    const b = (o: number) => bodyPos(view, 0, o);
    setManualShadowSelection(view, [{ from: b(0), to: b(5) }]);
    const before = view.state.selection.from;
    setManualShadowSelection(view, []);
    expect(view.state.selection.from).toBe(before);
  });
});
