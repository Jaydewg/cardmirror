// @vitest-environment jsdom
/**
 * Undo of a MULTI-MOVE reorder in a session (Alphabetize, a section drag).
 *
 * Loro's UndoManager cannot undo a step holding two or more moves on a
 * MovableList: it loses items, or panics in movable_list_apply_delta.rs and
 * poisons the doc ("recursive use of an object" on every later call). Found
 * 2026-10-29: Alphabetize Selected Headings, then Ctrl+Z, killed the session.
 * The binding now commits one move per step and groups the steps
 * (cardmirrorMove in the loro-prosemirror patch); the undo guard keeps the
 * manager from merging them back. Pinned here, at the app's DEFAULT merge
 * interval, so the grouping, not a zero interval, is what holds them apart:
 *  - the Loro bug itself still exists (a canary for a future upgrade);
 *  - one undo restores an alphabetized order exactly, one redo re-sorts;
 *  - random permutations and section reorders undo in one keypress;
 *  - typing right after the reorder is its own step;
 *  - a partner's edit survives the undo, and peers converge.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin } from 'loro-prosemirror';
import { LoroDoc, LoroMap, UndoManager } from 'loro-crdt';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { alphabetizeSlots, type SectionSlot } from '../../src/editor/alphabetize-headings.js';
import { createUndoGuard, type UndoGuard } from '../../src/editor/collab/undo-guard.js';
import { createLoroPeers, settle, docOf, cardNode, findText, type LoroPeer } from './_loro-helpers.js';

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}

interface Rig {
  peers: LoroPeer[];
  guards: UndoGuard[];
}
async function rig(seed: PMNode, n = 1): Promise<Rig> {
  globalThis.__CM_MOVABLE_LIST__ = true;
  const guards: UndoGuard[] = [];
  const views: Array<EditorView | null> = [];
  const peers = await createLoroPeers(seed, n, (ldoc: LoroDoc) => {
    // As collab-ui builds it: the manager's default merge interval.
    const um = new UndoManager(ldoc, {});
    const idx = guards.length;
    const g = createUndoGuard({ doc: ldoc, undoManager: um, getView: () => views[idx] ?? null, onBlocked: () => {} });
    guards.push(g);
    return [LoroUndoPlugin({ doc: ldoc as never, undoManager: um }), g.plugin];
  });
  peers.forEach((p, i) => (views[i] = p.view));
  await settle();
  return { peers, guards };
}
async function sync(peers: LoroPeer[]): Promise<void> {
  for (let r = 0; r < 3; r++) {
    const blobs = peers.map((p) => p.exportAll());
    peers.forEach((p) => blobs.forEach((b) => p.import(b)));
    await settle();
  }
}
async function press(r: Rig, i: number, key: 'undo' | 'redo'): Promise<boolean> {
  const v = r.peers[i]!.view;
  const ran = r.guards[i]![key](v.state, (tr) => v.dispatch(tr), v);
  await settle(6);
  return ran;
}

/** Top-level outline: block titles and card tags, in order. */
const outline = (d: PMNode): string[] => {
  const out: string[] = [];
  d.forEach((n) => out.push(n.type.name === 'block' ? `# ${n.textContent}` : n.firstChild!.textContent));
  return out;
};
const block = (text: string): PMNode => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
/** The outline the binding has written to Loro — what a peer would see. */
const loroOutline = (ldoc: LoroDoc): string[] => {
  const seed = schema.nodeFromJSON(docJSON(ldoc));
  return outline(seed);
};
function docJSON(ldoc: LoroDoc): unknown {
  const conv = (m: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { type: m['nodeName'] };
    const attrs = m['attributes'] as Record<string, unknown> | undefined;
    if (attrs && Object.keys(attrs).length) out['attrs'] = attrs;
    const kids = m['children'] as unknown[] | undefined;
    if (kids?.length) {
      out['content'] = kids.flatMap((k) =>
        typeof k === 'string' ? (k ? [{ type: 'text', text: k }] : []) : [conv(k as Record<string, unknown>)],
      );
    }
    return out;
  };
  return conv(ldoc.getMap('doc').toJSON() as Record<string, unknown>);
}

/** Every top-level child as one slot, keyed by its heading text. */
function topLevelSlots(d: PMNode): SectionSlot[] {
  const slots: SectionSlot[] = [];
  d.forEach((n, pos) => {
    const head = n.type.name === 'block' ? n : n.firstChild!;
    slots.push({ from: pos, to: pos + n.nodeSize, text: head.textContent });
  });
  return slots;
}
/** Sections: each block with the cards under it. */
function sectionSlots(d: PMNode): SectionSlot[] {
  const slots: SectionSlot[] = [];
  d.forEach((n, pos) => {
    if (n.type.name === 'block') slots.push({ from: pos, to: pos + n.nodeSize, text: n.textContent });
    else slots[slots.length - 1]!.to = pos + n.nodeSize;
  });
  return slots;
}
function alphabetize(v: EditorView, slots: SectionSlot[]): void {
  const tr = v.state.tr;
  expect(alphabetizeSlots(tr, slots)).toBe(true);
  v.dispatch(tr);
}

const TAGS = ['Kilo', 'Delta', 'Hotel', 'Alpha', 'Juliet', 'Echo', 'Charlie', 'India', 'Bravo', 'Foxtrot'];
const cardsDoc = (): PMNode => docOf(...TAGS.map((t) => cardNode(t, [`${t} body`])));

describe('undo of a multi-move reorder (one move per undo step)', () => {
  it('canary: Loro still cannot undo a step holding two moves', () => {
    // When a loro-crdt upgrade makes this pass, cardmirrorMove can go.
    const doc = new LoroDoc();
    const list = doc.getMovableList('l');
    for (let i = 0; i < 3; i++) list.insertContainer(i, new LoroMap()).set('v', i);
    doc.commit();
    const um = new UndoManager(doc, { mergeInterval: 0 });
    list.move(2, 0);
    list.move(2, 1);
    doc.commit();
    um.undo();
    expect(list.length, 'an item is lost').toBe(2);
  });

  it('Alphabetize, one undo restores the order, one redo re-sorts', async () => {
    const r = await rig(cardsDoc());
    const [A] = r.peers as [LoroPeer];
    const sorted = [...TAGS].sort();
    alphabetize(A.view, topLevelSlots(A.doc()));
    await settle();
    expect(outline(A.doc())).toEqual(sorted);
    expect(loroOutline(A.ldoc)).toEqual(sorted);

    expect(await press(r, 0, 'undo')).toBe(true);
    expect(outline(A.doc())).toEqual(TAGS);
    expect(loroOutline(A.ldoc)).toEqual(TAGS);
    expect(A.doc().textContent).toContain('Juliet body');

    expect(await press(r, 0, 'redo')).toBe(true);
    expect(outline(A.doc())).toEqual(sorted);
    expect(loroOutline(A.ldoc)).toEqual(sorted);
    A.destroy();
  });

  it('random permutations: each undone by one keypress, nothing lost', async () => {
    const r = await rig(cardsDoc());
    const [A] = r.peers as [LoroPeer];
    let seed = 20261029;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 40; round++) {
      const before = A.doc();
      const kids: PMNode[] = [];
      before.forEach((n) => kids.push(n));
      for (let i = kids.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [kids[i], kids[j]] = [kids[j]!, kids[i]!];
      }
      A.view.dispatch(A.view.state.tr.replace(0, before.content.size, new Slice(Fragment.from(kids), 0, 0)));
      await settle();
      expect(await press(r, 0, 'undo')).toBe(true);
      expect(outline(A.doc()), `round ${round}`).toEqual(outline(before));
      expect(loroOutline(A.ldoc), `round ${round}`).toEqual(outline(before));
    }
    A.destroy();
  });

  it('sections (a block and its cards) reorder and undo as one', async () => {
    const seed = docOf(
      block('Zulu'),
      cardNode('Z one', ['z1']),
      cardNode('Z two', ['z2']),
      block('Mike'),
      cardNode('M one', ['m1']),
      block('Alpha'),
      cardNode('A one', ['a1']),
      cardNode('A two', ['a2']),
      cardNode('A three', ['a3']),
    );
    const r = await rig(seed);
    const [A] = r.peers as [LoroPeer];
    const original = outline(A.doc());
    alphabetize(A.view, sectionSlots(A.doc()));
    await settle();
    expect(outline(A.doc())).toEqual(['# Alpha', 'A one', 'A two', 'A three', '# Mike', 'M one', '# Zulu', 'Z one', 'Z two']);
    await press(r, 0, 'undo');
    expect(outline(A.doc())).toEqual(original);
    expect(loroOutline(A.ldoc)).toEqual(original);
    A.destroy();
  });

  it('typing right after the reorder is its own step', async () => {
    const r = await rig(cardsDoc());
    const [A] = r.peers as [LoroPeer];
    alphabetize(A.view, topLevelSlots(A.doc()));
    await settle();
    const at = findText(A.doc(), 'Echo body').to;
    A.view.dispatch(A.view.state.tr.insertText(' typed', at));
    await settle();
    await press(r, 0, 'undo');
    expect(A.doc().textContent).not.toContain('typed');
    expect(outline(A.doc()), 'the reorder still stands').toEqual([...TAGS].sort());
    await press(r, 0, 'undo');
    expect(outline(A.doc())).toEqual(TAGS);
    A.destroy();
  });

  it("a partner's edit survives the undo; peers converge", async () => {
    const r = await rig(cardsDoc(), 2);
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    alphabetize(A.view, topLevelSlots(A.doc()));
    await settle();
    await sync(r.peers);
    expect(outline(B.doc())).toEqual([...TAGS].sort());
    const at = findText(B.doc(), 'Hotel body').to;
    B.view.dispatch(B.view.state.tr.insertText(' «B»', at));
    await settle();
    await sync(r.peers);
    await press(r, 0, 'undo');
    await sync(r.peers);
    for (const p of r.peers) {
      expect(outline(p.doc())).toEqual(TAGS);
      expect(p.doc().textContent).toContain('Hotel body «B»');
    }
    expect(A.doc().eq(B.doc())).toBe(true);
    for (const p of r.peers) p.destroy();
  });
});
