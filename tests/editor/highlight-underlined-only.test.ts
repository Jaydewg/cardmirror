/**
 * "Highlight underlined text only" (Settings → Editing → Highlighting).
 *
 * With the setting on, a highlight / background-color paint touches only the
 * underlined or emphasized text inside the selection; a word that mixes
 * emphasis and plain underline gets just its emphasized part. Strips still
 * clear the whole selection. The painted pieces feed the gap bridger, so the
 * space between two painted words fills in when bridging is on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  applyHighlight,
  applyShading,
  setHighlightColor,
  setShadingColor,
  restrictToUnderlinedText,
} from '../../src/editor/ribbon-commands.js';
import { settings } from '../../src/editor/settings.js';

const U = () => schema.marks['underline_mark']!.create();
const UD = () => schema.marks['underline_direct']!.create();
const E = () => schema.marks['emphasis_mark']!.create();
const C = () => schema.marks['cite_mark']!.create();
const HL = (color = 'yellow') => schema.marks['highlight']!.create({ color });

function para(...runs: [string, Mark[]?][]): PMNode {
  return schema.nodes['paragraph']!.create(null, runs.map(([t, m]) => schema.text(t, m ?? [])));
}
function docOf(...runs: [string, Mark[]?][]): PMNode {
  return schema.nodes['doc']!.createChecked(null, [para(...runs)]);
}
function mask(doc: PMNode, markName: string): string {
  let out = '';
  doc.descendants((n) => {
    if (!n.isText || !n.text) return true;
    out += (n.marks.some((m) => m.type.name === markName) ? '_' : ' ').repeat(n.text.length);
    return true;
  });
  return out;
}
function select(state: EditorState, text: string): EditorState {
  const i = state.doc.textContent.indexOf(text);
  if (i < 0) throw new Error(`"${text}" not found`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + i, 1 + i + text.length)));
}
function apply(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}
function run(doc: PMNode, text: string, cmd: Command): EditorState {
  return apply(select(EditorState.create({ doc }), text), cmd);
}

const yellow = () => 'yellow';

describe('restrictToUnderlinedText', () => {
  it('keeps underlined characters and drops plain ones', () => {
    // "aa bb cc": bb underlined.
    const doc = docOf(['aa '], ['bb', [U()]], [' cc']);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 9 }])).toEqual([{ from: 4, to: 6 }]);
  });

  it('inside a word with emphasis, keeps only the emphasized part', () => {
    // "nuclear weapons": "nuc" emphasized, the rest underlined.
    const doc = docOf(['nuc', [E()]], ['lear weapons', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 16 }])).toEqual([
      { from: 1, to: 4 }, // nuc
      { from: 9, to: 16 }, // weapons — no emphasis in this word, so its underline counts
    ]);
  });

  it('the whole word decides, even the part outside the selection', () => {
    // "nuc" emphasized; select only "lear" (underlined) → nothing qualifies.
    const doc = docOf(['nuc', [E()]], ['lear', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 4, to: 8 }])).toEqual([]);
  });

  // Words follow the double-click spec (word-break.ts): letters, digits,
  // apostrophes. Punctuation and dashes split words and are never kept.
  it('an em dash splits words: emphasis in one half leaves the other half its underline', () => {
    // "nuclear—armed": "nuclear" emphasized, "—armed" underlined. Both words
    // keep; the underlined dash joining them is kept too (one piece).
    const doc = docOf(['nuclear', [E()]], ['—armed', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 14 }])).toEqual([{ from: 1, to: 14 }]);
  });

  it('a joining dash is dropped when a side is not kept, or when it is not underlined itself', () => {
    // "armed" plain → nothing to join to: just "nuclear".
    const half = docOf(['nuclear', [E()]], ['—', [U()]], ['armed']);
    expect(restrictToUnderlinedText(half, [{ from: 1, to: 14 }])).toEqual([{ from: 1, to: 8 }]);
    // Both words underlined but the dash is plain: a real seam, left alone.
    const seam = docOf(['nuclear', [U()]], ['—'], ['armed', [U()]]);
    expect(restrictToUnderlinedText(seam, [{ from: 1, to: 14 }])).toEqual([
      { from: 1, to: 8 },
      { from: 9, to: 14 },
    ]);
  });

  it('the join rule sees a neighbor outside the selection', () => {
    // Select only "—armed": the dash joins to "nuclear", which is kept though unselected.
    const doc = docOf(['nuclear', [U()]], ['—armed', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 8, to: 14 }])).toEqual([{ from: 8, to: 14 }]);
  });

  it('a hyphen behaves like the em dash', () => {
    const doc = docOf(['nuclear', [E()]], ['-', [U()]], ['armed', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 14 }])).toEqual([{ from: 1, to: 14 }]);
  });

  it('an attached comma is not part of the word and is never kept', () => {
    const doc = docOf(['weapons', [E()]], [',', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 9 }])).toEqual([{ from: 1, to: 8 }]);
    const plain = docOf(['weapons,', [U()]]);
    expect(restrictToUnderlinedText(plain, [{ from: 1, to: 9 }])).toEqual([{ from: 1, to: 8 }]);
  });

  it('apostrophes stay inside the word', () => {
    const doc = docOf(["Smith's", [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 8 }])).toEqual([{ from: 1, to: 8 }]);
    const curly = docOf(['Smith’s', [E()]], [' plan', [U()]]);
    expect(restrictToUnderlinedText(curly, [{ from: 1, to: 13 }])).toEqual([
      { from: 1, to: 8 },
      { from: 9, to: 13 },
    ]);
  });

  it('an underlined standalone dash is never kept', () => {
    const doc = docOf(['aa', [U()]], [' — ', [U()]], ['bb', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 8 }])).toEqual([
      { from: 1, to: 3 },
      { from: 6, to: 8 },
    ]);
  });

  it('never keeps whitespace, even when it is underlined', () => {
    const doc = docOf(['aa bb', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 6 }])).toEqual([
      { from: 1, to: 3 },
      { from: 4, to: 6 },
    ]);
  });

  it('counts structural underline_direct but not cite', () => {
    const doc = docOf(['aa', [UD()]], [' '], ['bb', [C()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 1, to: 6 }])).toEqual([{ from: 1, to: 3 }]);
  });

  it('paints headings, tags, cites and analytics whole — the filter is for body text', () => {
    const id = (n: number) => ({ id: `h${n}` });
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create(id(1), schema.text('Pocket')),
      schema.nodes['hat']!.create(id(2), schema.text('Hat')),
      schema.nodes['block']!.create(id(3), schema.text('Block')),
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create(id(4), schema.text('Tag words')),
        schema.nodes['cite_paragraph']!.create(null, [schema.text('Smith', [C()]), schema.text(' 2024')]),
        schema.nodes['card_body']!.create(null, [schema.text('aa '), schema.text('bb', [U()]), schema.text(' cc')]),
      ]),
      schema.nodes['analytic_unit']!.createChecked(null, [
        schema.nodes['analytic']!.create(id(5), schema.text('analytic line')),
        schema.nodes['card_body']!.create(null, [schema.text('xx '), schema.text('yy', [U()])]),
      ]),
    ]);
    const kept = restrictToUnderlinedText(doc, [{ from: 0, to: doc.content.size }]);
    const text = kept.map((r) => doc.textBetween(r.from, r.to, '|')).join('|');
    expect(text).toBe('Pocket|Hat|Block|Tag words|Smith 2024|bb|analytic line|yy');
  });

  it('clips an exempt textblock to the range like any other', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag words here')),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ]),
    ]);
    const i = doc.textContent.indexOf('words');
    const kept = restrictToUnderlinedText(doc, [{ from: 2 + i, to: 2 + i + 5 }]);
    expect(kept.map((r) => doc.textBetween(r.from, r.to))).toEqual(['words']);
  });

  it('clips to the requested range', () => {
    const doc = docOf(['abcdef', [U()]]);
    expect(restrictToUnderlinedText(doc, [{ from: 3, to: 5 }])).toEqual([{ from: 3, to: 5 }]);
  });
});

describe('Highlight underlined text only — commands', () => {
  beforeEach(() => {
    settings.set('highlightUnderlinedOnly', true);
    settings.set('autoBridgeFormattingGaps', true);
    settings.set('formattingGapClass', 'both');
  });
  afterEach(() => {
    settings.set('highlightUnderlinedOnly', false);
  });

  it('off (default): F11 over a mixed paragraph paints everything', () => {
    settings.set('highlightUnderlinedOnly', false);
    const doc = docOf(['aa '], ['bb', [U()]], [' cc']);
    const next = run(doc, 'aa bb cc', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('________');
  });

  it('on: F11 across a tag and its body paints the whole tag and only the underlined body word', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag text')),
        schema.nodes['card_body']!.create(null, [schema.text('aa '), schema.text('bb', [U()]), schema.text(' cc')]),
      ]),
    ]);
    const state = EditorState.create({ doc });
    const whole = state.apply(state.tr.setSelection(TextSelection.create(doc, 2, doc.content.size - 2)));
    const next = apply(whole, applyHighlight(yellow));
    // 'Tag text' fully painted; body: only 'bb'.
    expect(mask(next.doc, 'highlight')).toBe('________' + '   __   ');
  });

  it('on: F11 over a mixed paragraph paints only the underlined word', () => {
    const doc = docOf(['aa '], ['bb', [U()]], [' cc']);
    const next = run(doc, 'aa bb cc', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('   __   ');
  });

  it('on: two underlined words get their gap bridged (composes with bridging)', () => {
    const doc = docOf(['aa '], ['bb cc', [U()]], [' dd']);
    const next = run(doc, 'aa bb cc dd', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('   _____   ');
  });

  it('on, bridging off: the gap between the two words stays unpainted', () => {
    settings.set('autoBridgeFormattingGaps', false);
    const doc = docOf(['aa '], ['bb cc', [U()]], [' dd']);
    const next = run(doc, 'aa bb cc dd', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('   __ __   ');
  });

  it('on: an underlined em-dash pair paints whole, bridging on or off', () => {
    const doc = docOf(['nuclear—armed', [U()]]);
    expect(mask(run(doc, 'nuclear—armed', applyHighlight(yellow)).doc, 'highlight')).toBe('_____________');
    settings.set('autoBridgeFormattingGaps', false);
    expect(mask(run(doc, 'nuclear—armed', applyHighlight(yellow)).doc, 'highlight')).toBe('_____________');
  });

  it('on: an em-dash pair with emphasis in one half paints both halves and the dash', () => {
    // The old whitespace-word rule saw one emphasized word and dropped "armed".
    const doc = docOf(['nuclear', [E()]], ['—armed', [U()]]);
    const next = run(doc, 'nuclear—armed', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('_____________');
  });

  it('on: a spaced dash is gap content — bridged when bridging is on, unpainted when off', () => {
    const doc = docOf(['aa — bb', [U()]]);
    settings.set('formattingGapClass', 'whitespace');
    // Bridging on: the bridger does not bridge dashes, so the dash stays bare
    // either way; only the filter's own output is under test here.
    settings.set('autoBridgeFormattingGaps', false);
    const next = run(doc, 'aa — bb', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('__   __');
  });

  it('on: a word mixing emphasis and underline gets only the emphasized part', () => {
    // "nuc" emphasized inside "nuclear"; "weapons" plain-underlined.
    const doc = docOf(['nuc', [E()]], ['lear weapons', [U()]]);
    const next = run(doc, 'nuclear weapons', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('___     _______');
  });

  it('on: emphasis spanning the space joins the two words', () => {
    // "nuc…s" emphasized straight across "nuclear weapons" except the heads.
    const doc = docOf(['nuc', [E()]], ['lear', [U()]], [' wea', [E()]], ['pon', [U()]], ['s', [E()]]);
    const next = run(doc, 'nuclear weapons', applyHighlight(yellow));
    // nuc | lear | " " bridged (both neighbors painted) | wea | pon | s
    expect(mask(next.doc, 'highlight')).toBe('___     ___   _');
  });

  it('on: nothing underlined in the selection → the command is a no-op', () => {
    const doc = docOf(['aa bb cc']);
    const state = select(EditorState.create({ doc }), 'bb');
    expect(applyHighlight(yellow)(state)).toBe(false);
  });

  it('on: painting the same swath again strips the whole selection (toggle off)', () => {
    const doc = docOf(['aa ', [HL()]], ['bb', [U(), HL()]], [' cc', [HL()]]);
    const next = run(doc, 'aa bb cc', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('        ');
  });

  it('on: "No highlight" strips plain text too', () => {
    const doc = docOf(['aa ', [HL()]], ['bb', [U(), HL()]], [' cc', [HL()]]);
    const next = run(doc, 'aa bb cc', applyHighlight(() => null));
    expect(mask(next.doc, 'highlight')).toBe('        ');
  });

  // Removal is never stuck behind the filter: a highlight sitting on text
  // with no underline / emphasis under it comes off with the same key.
  it('on: a highlighted plain word with nothing underlined is stripped by F11', () => {
    const doc = docOf(['aa '], ['bb', [HL()]], [' cc']);
    const next = run(doc, 'bb', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('        ');
  });

  it('on: over-selecting around a plain highlighted word still strips it', () => {
    const doc = docOf(['aa '], ['bb', [HL()]], [' cc']);
    const next = run(doc, 'aa bb cc', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('        ');
  });

  it('on: a different pen color over plain highlighted text strips (nothing to repaint)', () => {
    const doc = docOf(['aa bb cc', [HL('yellow')]]);
    const next = run(doc, 'aa bb cc', applyHighlight(() => 'green'));
    expect(mask(next.doc, 'highlight')).toBe('        ');
  });

  it('on: "No highlight" over plain highlighted text with nothing underlined strips the selection', () => {
    const doc = docOf(['aa bb cc', [HL()]]);
    const next = run(doc, 'bb', applyHighlight(() => null));
    const m = mask(next.doc, 'highlight');
    expect(m.slice(3, 5)).toBe('  ');
    expect(m[0]).toBe('_');
    expect(m[7]).toBe('_');
  });

  it('on: a highlighted plain word beside an unhighlighted underlined word — paint still wins', () => {
    const doc = docOf(['aa ', [HL()]], ['bb', [U()]], [' cc']);
    const next = run(doc, 'aa bb cc', applyHighlight(yellow));
    const m = mask(next.doc, 'highlight');
    expect(m.slice(0, 3)).toBe('___');
    expect(m.slice(3, 5)).toBe('__');
    expect(m.slice(6)).toBe('  ');
  });

  it('on: inside a real card, F11 over highlighted body text with no underline anywhere strips it', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 't1' }, schema.text('Tag text')),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Smith 24', [C()])),
        schema.nodes['card_body']!.create(null, [
          schema.text('plain lead '),
          schema.text('painted words here', [HL()]),
          schema.text(' plain tail'),
        ]),
      ]),
    ]);
    // `select()` assumes one paragraph; find the text node's real position.
    let from = -1;
    doc.descendants((n, pos) => {
      if (from < 0 && n.isText && n.text === 'painted words here') from = pos;
      return from < 0;
    });
    const state = EditorState.create({ doc });
    const sel = state.apply(state.tr.setSelection(TextSelection.create(doc, from, from + 'painted words here'.length)));
    expect(mask(sel.doc, 'highlight')).toContain('_');
    const next = apply(sel, applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).not.toContain('_');
  });

  it('on: Mod-F11 over plain shaded text with nothing underlined strips the shading', () => {
    const doc = docOf(['aa bb cc', [schema.marks['shading']!.create({ color: 'FFFF00' })]]);
    const next = run(doc, 'aa bb cc', applyShading(() => '00FF00'));
    expect(mask(next.doc, 'shading')).toBe('        ');
  });

  it('on: a different color repaints only the underlined part', () => {
    const doc = docOf(['aa '], ['bb', [U(), HL('yellow')]], [' cc']);
    const next = run(doc, 'aa bb cc', applyHighlight(() => 'green'));
    expect(mask(next.doc, 'highlight')).toBe('   __   ');
    const bb = next.doc.nodeAt(4)!;
    expect(bb.marks.find((m) => m.type.name === 'highlight')!.attrs['color']).toBe('green');
  });

  it('on: background color (Mod-F11) is narrowed the same way', () => {
    const doc = docOf(['aa '], ['bb', [U()]], [' cc']);
    const next = run(doc, 'aa bb cc', applyShading(() => 'FFFF00'));
    expect(mask(next.doc, 'shading')).toBe('   __   ');
  });

  it('on: swatch picks are narrowed too', () => {
    const doc = docOf(['aa '], ['bb', [U()]], [' cc']);
    expect(mask(run(doc, 'aa bb cc', setHighlightColor('green')).doc, 'highlight')).toBe('   __   ');
    expect(mask(run(doc, 'aa bb cc', setShadingColor('c0c0c0')).doc, 'shading')).toBe('   __   ');
  });

  it('on: painting next to an already-highlighted underlined word bridges to it', () => {
    // "aa" already highlighted+underlined; paint "bb" (underlined) → gap fills.
    const doc = docOf(['aa', [U(), HL()]], [' ', [U()]], ['bb', [U()]], [' cc']);
    const next = run(doc, 'bb', applyHighlight(yellow));
    expect(mask(next.doc, 'highlight')).toBe('_____   ');
  });
});
