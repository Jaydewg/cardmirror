/**
 * Extract Card (extract-card.ts): copy the selected body text into a new
 * card directly after the source, under copies of the source's tag (new
 * id) and cite line(s). Source untouched, selection unchanged; refuses
 * outside one card's body text, with no selection, and in read mode.
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildExtractCardTransaction, extractCard } from '../../src/editor/extract-card.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';
import { showToast } from '../../src/editor/toast.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  getRibbonCommand,
} from '../../src/editor/ribbon-commands.js';

const m = (name: string) => schema.marks[name]!.create();
const t = (text: string, ...marks: ReturnType<typeof m>[]) => schema.text(text, marks);
const tag = (text: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
const analytic = (text: string) => schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(text));
const cite = (...inl: PMNode[]) => schema.nodes['cite_paragraph']!.create(null, inl);
const body = (...inl: PMNode[]) => schema.nodes['card_body']!.create(null, inl);
const undertag = (text: string) => schema.nodes['undertag']!.create(null, schema.text(text));
const card = (...ch: PMNode[]) => schema.nodes['card']!.createChecked(null, ch);
const unit = (...ch: PMNode[]) => schema.nodes['analytic_unit']!.createChecked(null, ch);
const doc = (...ch: PMNode[]) => schema.nodes['doc']!.createChecked(null, ch);

/** Position of `needle`'s first char in the doc text. */
function posOf(d: PMNode, needle: string): number {
  let found = -1;
  d.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(needle)) found = pos + node.text!.indexOf(needle);
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${needle}"`);
  return found;
}
function stateWith(d: PMNode, from: number, to: number, plugins: EditorState['plugins'] = []): EditorState {
  const s = EditorState.create({ doc: d, plugins });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
}
const outline = (d: PMNode) => d.content.content.map((n) => `${n.type.name}:${n.firstChild!.textContent}`);
const children = (n: PMNode) => n.content.content.map((c) => `${c.type.name}=${c.textContent}`);

const source = () =>
  card(
    tag('Original tag'),
    cite(t('Smith 24', m('cite_mark')), t(' — John Smith')),
    cite(t('Journal of Things, p. 4')),
    body(t('First body paragraph with '), t('underlined', m('underline_mark')), t(' words.')),
    body(t('Second body paragraph.')),
  );

describe('buildExtractCardTransaction', () => {
  it('copies tag, both cites and the selected span into a new card right after the source', () => {
    const d = doc(source(), card(tag('Next card'), body(t('next'))));
    const from = posOf(d, 'underlined');
    const to = from + 'underlined words.'.length;
    const state = stateWith(d, from, to);
    const tr = buildExtractCardTransaction(state)!;
    expect(tr).not.toBeNull();
    const after = tr.doc;
    expect(outline(after)).toEqual(['card:Original tag', 'card:Original tag', 'card:Next card']);
    const extracted = after.child(1);
    expect(children(extracted)).toEqual([
      'tag=Original tag',
      'cite_paragraph=Smith 24 — John Smith',
      'cite_paragraph=Journal of Things, p. 4',
      'card_body=underlined words.',
    ]);
    // Formatting travels; the cite mark too.
    expect(extracted.child(3).firstChild!.marks.map((x) => x.type.name)).toEqual(['underline_mark']);
    expect(extracted.child(1).firstChild!.marks.map((x) => x.type.name)).toEqual(['cite_mark']);
    // Source untouched.
    expect(after.child(0).eq(d.child(0))).toBe(true);
    // Fresh heading id.
    expect(extracted.firstChild!.attrs['id']).not.toBe(d.child(0).firstChild!.attrs['id']);
    expect(typeof extracted.firstChild!.attrs['id']).toBe('string');
    // Selection unchanged.
    expect([tr.selection.from, tr.selection.to]).toEqual([from, to]);
    expect(tr.scrolledIntoView).toBe(false);
  });

  it('a selection across two body paragraphs keeps them as two paragraphs, each clipped', () => {
    const d = doc(source());
    const from = posOf(d, 'words.');
    const to = posOf(d, 'Second body') + 'Second'.length;
    const tr = buildExtractCardTransaction(stateWith(d, from, to))!;
    expect(children(tr.doc.child(1)).slice(3)).toEqual(['card_body=words.', 'card_body=Second']);
  });

  it('refuses: empty selection, selection reaching into the cite or tag, spanning two cards, doc-level paragraph', () => {
    const d = doc(source(), card(tag('Next card'), body(t('next body'))), schema.nodes['paragraph']!.create(null, t('loose')));
    const body1 = posOf(d, 'First body');
    expect(buildExtractCardTransaction(stateWith(d, body1, body1))).toBeNull();
    expect(buildExtractCardTransaction(stateWith(d, posOf(d, 'p. 4'), body1 + 5))).toBeNull();
    expect(buildExtractCardTransaction(stateWith(d, posOf(d, 'Original'), body1 + 5))).toBeNull();
    expect(buildExtractCardTransaction(stateWith(d, posOf(d, 'Second'), posOf(d, 'next body') + 4))).toBeNull();
    const loose = posOf(d, 'loose');
    expect(buildExtractCardTransaction(stateWith(d, loose, loose + 5))).toBeNull();
  });

  it('refuses when the selection crosses an undertag between body paragraphs', () => {
    const d = doc(card(tag('T'), body(t('alpha text')), undertag('note'), body(t('beta text'))));
    expect(buildExtractCardTransaction(stateWith(d, posOf(d, 'alpha'), posOf(d, 'beta') + 4))).toBeNull();
  });

  it('a card without a cite extracts tag + body only', () => {
    const d = doc(card(tag('T'), body(t('alpha text'))));
    const tr = buildExtractCardTransaction(stateWith(d, posOf(d, 'alpha'), posOf(d, 'alpha') + 5))!;
    expect(children(tr.doc.child(1))).toEqual(['tag=T', 'card_body=alpha']);
  });

  it('analytic units: the analytic line stands in for the tag', () => {
    const d = doc(unit(analytic('An analytic'), cite(t('Doe 25', m('cite_mark'))), body(t('analytic body text'))));
    const from = posOf(d, 'body text');
    const tr = buildExtractCardTransaction(stateWith(d, from, from + 4))!;
    expect(outline(tr.doc)).toEqual(['analytic_unit:An analytic', 'analytic_unit:An analytic']);
    expect(children(tr.doc.child(1))).toEqual(['analytic=An analytic', 'cite_paragraph=Doe 25', 'card_body=body']);
    expect(tr.doc.child(1).firstChild!.attrs['id']).not.toBe(d.child(0).firstChild!.attrs['id']);
  });

  it('a numbering restart on the source is not copied', () => {
    const src = schema.nodes['card']!.createChecked({ numRole: 'number', numRestart: true }, [tag('T'), body(t('alpha text'))]);
    const d = doc(src);
    const tr = buildExtractCardTransaction(stateWith(d, posOf(d, 'alpha'), posOf(d, 'alpha') + 5))!;
    expect(tr.doc.child(1).attrs['numRole']).toBe('number');
    expect(tr.doc.child(1).attrs['numRestart']).toBe(false);
  });
});

describe('extractCard command', () => {
  it('dispatches and toasts; is a no-op in read mode', () => {
    vi.mocked(showToast).mockClear();
    const d = doc(source());
    const from = posOf(d, 'Second');
    let state = stateWith(d, from, from + 6, [readModePlugin]);
    let dispatched = 0;
    expect(extractCard()(state, () => dispatched++)).toBe(true);
    expect(dispatched).toBe(1);
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.stringMatching(/new card below/), expect.anything());

    state = state.apply(state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
    expect(readModePlugin.getState(state)?.on).toBe(true);
    expect(extractCard()(state, () => dispatched++)).toBe(false);
    expect(dispatched).toBe(1);
  });

  it('is registered, labeled and bound to Alt-Shift-F8', () => {
    expect(RIBBON_COMMAND_IDS).toContain('extractCard');
    expect(RIBBON_COMMAND_LABELS['extractCard']).toBe('Extract Card');
    expect(DEFAULT_RIBBON_KEYS['extractCard']).toBe('Alt-Shift-F8');
    const d = doc(source());
    const from = posOf(d, 'Second');
    expect(getRibbonCommand('extractCard')(stateWith(d, from, from + 6), () => {})).toBe(true);
  });
});
