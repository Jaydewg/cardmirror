// @vitest-environment jsdom

/**
 * Alphabetize Selected Headings (alphabetize-headings.ts +
 * NavigationPanel.alphabetizeSelection): the nav pane's multi-selection
 * sorts by heading text into the slots it occupies. Unselected headings
 * never move; a discontinuous selection stays discontinuous; sections
 * move whole; slots are positional across parents.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, undoDepth } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { alphabetizeSlots, compareHeadingText } from '../../src/editor/alphabetize-headings.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  getRibbonCommand,
} from '../../src/editor/ribbon-commands.js';

function card(tag: string, body = `${tag} body`): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
const block = (t: string) => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));

const open: EditorView[] = [];
function setup(...children: PMNode[]) {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state: EditorState.create({ doc, plugins: [history()] }) });
  const nav = new NavigationPanel(document.createElement('div'));
  nav.attach(view);
  nav.update(view.state.doc);
  open.push(view);
  return { view, nav };
}
afterEach(() => {
  for (const v of open.splice(0)) v.destroy();
});

function entryIds(nav: NavigationPanel, ...labels: string[]): string[] {
  const entries = [
    ...((nav as unknown as Record<string, unknown>)['liEntries'] as Map<HTMLElement, { text: string; id: string }>).values(),
  ];
  return labels.map((l) => {
    const hit = entries.find((e) => e.text === l);
    if (!hit) throw new Error(`no nav entry "${l}"`);
    return hit.id;
  });
}
function select(nav: NavigationPanel, ...labels: string[]): void {
  (nav as unknown as { selectedIds: Set<string> }).selectedIds = new Set(entryIds(nav, ...labels));
}
/** Top-level heading texts in document order (tags for cards, block text for blocks). */
function outline(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name === 'card' ? n.firstChild!.textContent : n.textContent));
  return out;
}
const selectedTexts = (nav: NavigationPanel, doc: PMNode): string[] => {
  const ids = (nav as unknown as { selectedIds: Set<string> }).selectedIds;
  const out: string[] = [];
  doc.descendants((n) => {
    if (typeof n.attrs['id'] === 'string' && ids.has(n.attrs['id'] as string)) out.push(n.textContent);
    return true;
  });
  return out;
};

describe('compareHeadingText', () => {
  it('is case-insensitive and numeric-aware', () => {
    expect(compareHeadingText('banana', 'Apple')).toBeGreaterThan(0);
    expect(compareHeadingText('Card 2', 'Card 10')).toBeLessThan(0);
    expect(compareHeadingText('  x', 'x')).toBe(0);
  });
});

describe('alphabetizeSelection', () => {
  it('sorts a contiguous selection of cards in place', () => {
    const { view, nav } = setup(card('Delta'), card('Bravo'), card('Charlie'), card('Alpha'));
    select(nav, 'Delta', 'Bravo', 'Charlie', 'Alpha');
    expect(nav.alphabetizeSelection()).toBe(true);
    expect(outline(view.state.doc)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    // Bodies travel with their tags.
    expect(view.state.doc.firstChild!.textContent).toBe('AlphaAlpha body');
  });

  it('a discontinuous selection fills only the selected slots; unselected headings stay put', () => {
    // A B C D E F G, select B, E, G (which sort G? no: texts chosen so order flips)
    const { view, nav } = setup(
      card('A'), card('Zulu'), card('C'), card('D'), card('Mike'), card('F'), card('Echo'),
    );
    select(nav, 'Zulu', 'Mike', 'Echo');
    expect(nav.alphabetizeSelection()).toBe(true);
    expect(outline(view.state.doc)).toEqual(['A', 'Echo', 'C', 'D', 'Mike', 'F', 'Zulu']);
    // The selection is the same headings, now reordered.
    expect(selectedTexts(nav, view.state.doc)).toEqual(['Echo', 'Mike', 'Zulu']);
  });

  it('blocks move with their cards', () => {
    const { view, nav } = setup(
      block('Zebra block'), card('z1'), card('z2'),
      block('Apple block'), card('a1'),
    );
    select(nav, 'Zebra block', 'Apple block');
    expect(nav.alphabetizeSelection()).toBe(true);
    expect(outline(view.state.doc)).toEqual(['Apple block', 'a1', 'Zebra block', 'z1', 'z2']);
  });

  it('slots are positional across parents: a card can move into another block', () => {
    const { view, nav } = setup(
      block('Block one'), card('Yankee'), card('Bravo'),
      block('Block two'), card('Alpha'),
    );
    nav.setMaxLevel(4); // the pane opens at block depth; show the cards to select them
    select(nav, 'Yankee', 'Bravo', 'Alpha');
    expect(nav.alphabetizeSelection()).toBe(true);
    expect(outline(view.state.doc)).toEqual(['Block one', 'Alpha', 'Bravo', 'Block two', 'Yankee']);
  });

  it('is a no-op (false) for fewer than two headings or an already-sorted selection', () => {
    const { view, nav } = setup(card('Alpha'), card('Bravo'), card('Charlie'));
    select(nav, 'Bravo');
    expect(nav.alphabetizeSelection()).toBe(false);
    select(nav, 'Alpha', 'Charlie');
    expect(nav.alphabetizeSelection()).toBe(false);
    expect(outline(view.state.doc)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('ties keep document order (stable) and ignore case', () => {
    const { view, nav } = setup(card('beta', 'first'), card('Alpha'), card('Beta', 'second'));
    select(nav, 'beta', 'Alpha', 'Beta');
    expect(nav.alphabetizeSelection()).toBe(true);
    expect(outline(view.state.doc)).toEqual(['Alpha', 'beta', 'Beta']);
    expect(view.state.doc.child(1).textContent).toBe('betafirst');
  });

  it('is one undo step', () => {
    const { view, nav } = setup(card('Charlie'), card('Bravo'), card('Alpha'));
    select(nav, 'Charlie', 'Bravo', 'Alpha');
    const before = undoDepth(view.state);
    nav.alphabetizeSelection();
    expect(undoDepth(view.state)).toBe(before + 1);
    undo(view.state, (tr) => view.dispatch(tr));
    expect(outline(view.state.doc)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });
});

describe('alphabetizeSlots (pure)', () => {
  it('rejects overlapping slots', () => {
    const doc = schema.nodes['doc']!.create(null, [card('a'), card('b')]);
    const tr = EditorState.create({ doc }).tr;
    expect(() =>
      alphabetizeSlots(tr, [
        { from: 0, to: 10, text: 'b' },
        { from: 5, to: 15, text: 'a' },
      ]),
    ).toThrow(/overlapping/);
  });
});

describe('ribbon command', () => {
  it('is registered, labeled, unbound by default, and routes to the context', () => {
    const id = 'alphabetizeSelectedHeadings' as const;
    expect(RIBBON_COMMAND_IDS).toContain(id);
    expect(RIBBON_COMMAND_LABELS[id]).toBe('Navigation Pane: Alphabetize Selected Headings');
    expect(DEFAULT_RIBBON_KEYS[id]).toBe('');
    let calls = 0;
    const cmd = getRibbonCommand(id, { alphabetizeSelectedHeadings: () => { calls++; return true; } } as never);
    const state = EditorState.create({ doc: schema.nodes['doc']!.create(null, [card('x')]) });
    expect(cmd(state, () => {})).toBe(true);
    expect(calls).toBe(1);
  });
});
