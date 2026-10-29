// @vitest-environment jsdom
/**
 * The undo CHAIN in a co-editing session: a step a partner has built on is
 * skipped and the undo carries on to the steps before it, instead of that
 * one step walling off everything older (the first undo guard reversed a
 * blocked step with redo(), which put it straight back on top of the
 * stack — every later Ctrl+Z retried it). Also: container-creating edits
 * get undo steps of their own, so a skip never drags along the unrelated
 * typing that shared their second, and steps a partner simply overwrote
 * are passed over without spending a keypress.
 *
 * Real Loro peers, the session's plugin stack, the app's merge interval.
 */
import { describe, it, expect, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin } from 'loro-prosemirror';
import { UndoManager, type LoroDoc } from 'loro-crdt';
import { headingIdGuardPlugin } from '../../src/editor/heading-id-guard.js';
import { cardNumberingPlugin } from '../../src/editor/numbering-plugin.js';
import { collabInvariantHealPlugin } from '../../src/editor/collab/collab-invariants.js';
import { causalMarkHealPlugin } from '../../src/editor/collab/causal-mark-heal.js';
import { collabRepairPlugin } from '../../src/editor/collab/collab-repair.js';
import { createUndoGuard, undoSkippedMessage, type UndoGuard } from '../../src/editor/collab/undo-guard.js';
import { enterMidTag } from '../../src/editor/tag-keymap.js';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { dragController } from '../../src/editor/drag-controller.js';
import { collectHeadings, computeHeadingRange } from '../../src/editor/headings.js';
import { createLoroPeers, settle, sleep, docOf, cardNode, findText, type LoroPeer } from './_loro-helpers.js';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
(document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}

const text = (d: PMNode): string[] => {
  const out: string[] = [];
  d.descendants((n) => {
    if (n.isTextblock) {
      out.push(n.textContent);
      return false;
    }
    return true;
  });
  return out;
};
async function sync(peers: LoroPeer[]): Promise<void> {
  for (let r = 0; r < 3; r++) {
    const blobs = peers.map((p) => p.exportAll());
    peers.forEach((p) => blobs.forEach((b) => p.import(b)));
    await settle();
  }
}
interface Rig {
  peers: LoroPeer[];
  ums: UndoManager[];
  guards: UndoGuard[];
  notices: string[];
}
/** `mergeInterval` 0 = every edit its own step; omit for the app default. */
async function rig(mergeInterval?: number, seed?: PMNode): Promise<Rig> {
  globalThis.__CM_MOVABLE_LIST__ = true;
  const ums: UndoManager[] = [];
  const guards: UndoGuard[] = [];
  const notices: string[] = [];
  const views: Array<EditorView | null> = [];
  const peers = await createLoroPeers(
    seed ?? docOf(cardNode('Alpha', ['alpha body']), cardNode('Bravo', ['bravo body']), cardNode('Charlie', ['charlie body'])),
    2,
    (ldoc: LoroDoc) => {
      const idx = ums.length;
      const um = new UndoManager(ldoc, mergeInterval === undefined ? {} : { mergeInterval });
      ums.push(um);
      const g = createUndoGuard({
        doc: ldoc,
        undoManager: um,
        getView: () => views[idx] ?? null,
        onBlocked: (m) => notices.push(m),
        onSkipped: (m) => notices.push(m),
        ...(mergeInterval === undefined ? {} : { mergeInterval }),
      });
      guards.push(g);
      return [
        headingIdGuardPlugin,
        cardNumberingPlugin,
        LoroUndoPlugin({ doc: ldoc as never, undoManager: um }),
        g.plugin,
        collabInvariantHealPlugin(),
        causalMarkHealPlugin(ldoc),
        collabRepairPlugin(() => idx === 0),
      ];
    },
  );
  peers.forEach((p, i) => (views[i] = p.view));
  await settle();
  return { peers, ums, guards, notices };
}
async function typeAfter(r: Rig, i: number, anchor: string, s: string): Promise<void> {
  const v = r.peers[i]!.view;
  v.dispatch(v.state.tr.insertText(s, findText(v.state.doc, anchor).to));
  await settle();
  r.peers[i]!.ldoc.commit();
}
async function press(r: Rig, i: number, which: 'undo' | 'redo' = 'undo'): Promise<boolean> {
  const v = r.peers[i]!.view;
  const ran = r.guards[i]![which](v.state, (tr) => v.dispatch(tr), v);
  await settle(10);
  await sync(r.peers);
  await settle(4);
  return ran;
}
/** A splits its first tag after three characters (Enter mid-tag). */
async function splitFirstTag(r: Rig): Promise<void> {
  const v = r.peers[0]!.view;
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2 + 3)));
  enterMidTag(v.state, (tr) => v.dispatch(tr));
  await settle();
}
/** B types at the end of the document's first tag. */
async function partnerTypesInFirstTag(r: Rig, s: string): Promise<void> {
  const vb = r.peers[1]!.view;
  let end = -1;
  vb.state.doc.descendants((n, pos) => {
    if (end < 0 && n.type.name === 'tag') end = pos + 1 + n.content.size;
    return end < 0;
  });
  vb.dispatch(vb.state.tr.insertText(s, end));
  await settle();
}
const converged = (r: Rig): boolean => r.peers[0]!.doc().eq(r.peers[1]!.doc());

describe('undo chain in a co-editing session', () => {
  it('a card I inserted that a partner edited is skipped; the edits before it still undo', async () => {
    const r = await rig(0);
    const [A] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'Alpha', ' a1');
    A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Delta', ['delta body'])));
    await settle();
    await sync(r.peers);
    await typeAfter(r, 1, 'delta body', ' <b>');
    await sync(r.peers);
    await typeAfter(r, 0, 'charlie body', ' a3');
    await sync(r.peers);

    await press(r, 0); // a3
    expect(text(A.doc())).toContain('charlie body');
    expect(r.notices).toEqual([]);

    await press(r, 0); // the card insert is skipped → a1 is undone, same keypress
    expect(text(A.doc()), 'the step before the skipped one was undone').toContain('Alpha');
    expect(text(A.doc()), "the partner's card and typing stay").toContain('delta body <b>');
    expect(r.notices).toEqual([undoSkippedMessage(1)]);
    expect(r.guards[0]!.stats.skipped).toBe(1);
    expect(r.ums[0]!.canUndo(), 'the skipped step is gone, not parked on top').toBe(false);
    expect(converged(r)).toBe(true);

    // The step that WAS undone is redoable; the skipped one is not.
    await press(r, 0, 'redo');
    expect(text(A.doc())).toContain('Alpha a1');
    expect(text(A.doc())).toContain('delta body <b>');
    expect(r.ums[0]!.canRedo()).toBe(false);
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('an Enter-split a partner typed into is skipped; the split and their typing stay', async () => {
    const r = await rig(0);
    const [A] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'bravo body', ' a1');
    await splitFirstTag(r);
    await sync(r.peers);
    await partnerTypesInFirstTag(r, ' <b>');
    await sync(r.peers);

    await press(r, 0);
    expect(text(A.doc()).slice(0, 2), 'the split stands, with the partner text').toEqual(['Alp <b>', 'ha']);
    expect(text(A.doc()), 'the edit before the split was undone').toContain('bravo body');
    expect(r.notices).toEqual([undoSkippedMessage(1)]);
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('two blocked steps in a row are both skipped in one keypress', async () => {
    const r = await rig(0);
    const [A] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'charlie body', ' early');
    for (const name of ['Delta', 'Echo']) {
      A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode(name, [`${name} body`])));
      await settle();
    }
    await sync(r.peers);
    await typeAfter(r, 1, 'Delta body', ' <b1>');
    await typeAfter(r, 1, 'Echo body', ' <b2>');
    await sync(r.peers);

    await press(r, 0);
    expect(text(A.doc())).toContain('Delta body <b1>');
    expect(text(A.doc())).toContain('Echo body <b2>');
    expect(text(A.doc()), 'the oldest edit is reached').toContain('charlie body');
    expect(r.notices).toEqual([undoSkippedMessage(2)]);
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('a skip with nothing left behind it says so and leaves the document alone', async () => {
    const r = await rig(0);
    const [A] = r.peers as [LoroPeer, LoroPeer];
    A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Delta', ['delta body'])));
    await settle();
    await sync(r.peers);
    await typeAfter(r, 1, 'delta body', ' <b>');
    await sync(r.peers);
    const before = A.doc();
    await press(r, 0);
    expect(A.doc().eq(before)).toBe(true);
    expect(r.notices).toEqual([undoSkippedMessage(1)]);
    expect(r.ums[0]!.canUndo()).toBe(false);
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('a step the partner overwrote is passed over without spending a keypress', async () => {
    const r = await rig(0);
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'Alpha', ' first');
    await typeAfter(r, 0, 'bravo body', ' SECOND');
    await sync(r.peers);
    const bravo = findText(B.view.state.doc, 'bravo body SECOND');
    // No character in common with what it replaces: the binding's text diff
    // would otherwise keep a shared letter alive as MY character.
    B.view.dispatch(B.view.state.tr.insertText('XYZ', bravo.from, bravo.to));
    await settle();
    await sync(r.peers);

    await press(r, 0);
    expect(text(A.doc())).toContain('XYZ');
    expect(text(A.doc()), 'one press reached the edit before the dead one').toContain('Alpha');
    expect(r.notices, 'nothing was lost, so nothing is announced').toEqual([]);
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('a container edit gets a step of its own at the app merge interval', async () => {
    const r = await rig(); // Loro default: edits within a second merge
    const [A] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'charlie body', ' early');
    await sleep(1150); // a real pause: 'early' is its own step
    await typeAfter(r, 0, 'bravo body', ' before');
    await sleep(120);
    await splitFirstTag(r);
    await sleep(120);
    await typeAfter(r, 0, 'alpha body', ' after');
    await sync(r.peers);
    await partnerTypesInFirstTag(r, ' <b>');
    await sync(r.peers);

    await press(r, 0);
    expect(text(A.doc()), 'only the typing after the split').toContain('alpha body');
    expect(text(A.doc())).toContain('bravo body before');
    expect(r.notices).toEqual([]);

    await press(r, 0); // split is skipped; the typing before it is undone
    expect(text(A.doc()).slice(0, 2)).toEqual(['Alp <b>', 'ha']);
    expect(text(A.doc())).toContain('bravo body');
    expect(text(A.doc())).toContain('charlie body early');
    expect(r.notices).toEqual([undoSkippedMessage(1)]);

    await press(r, 0);
    expect(text(A.doc())).toContain('charlie body');
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  }, 20000);

  it('merging resumes after an isolated step', async () => {
    const r = await rig();
    const [A] = r.peers as [LoroPeer, LoroPeer];
    A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Delta', ['delta body'])));
    await settle();
    await sleep(60);
    await typeAfter(r, 0, 'delta body', ' x1'); // not merged INTO the insert
    await sleep(60);
    await typeAfter(r, 0, 'x1', ' x2');
    await sleep(60);
    await typeAfter(r, 0, 'x2', ' x3');
    await sync(r.peers);

    await press(r, 0);
    expect(text(A.doc()), 'x1, x2 and x3 merged into one step, apart from the insert').toContain('delta body');
    await press(r, 0);
    expect(text(A.doc()), 'then the untouched card itself').not.toContain('delta body');
    expect(r.ums[0]!.canUndo()).toBe(false);
    expect(r.notices).toEqual([]);
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  }, 20000);

  it('undoing my section drag keeps a card the partner added after it', async () => {
    // A drags a section (a block and its card) to the end, B adds a card
    // right after it, A undoes the drag. Before the binding split moves into
    // one undo step each, the drag was two moves in ONE step, Loro's undo of
    // it deleted B's card on every peer, and the guard wrote it back after
    // Bravo. Now nothing is deleted: B's card stays where B put it, at the end.
    const block = (t: string): PMNode => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
    const r = await rig(
      0,
      docOf(block('One'), cardNode('Alpha', ['alpha body']), block('Two'), cardNode('Bravo', ['bravo body']), block('Three'), cardNode('Charlie', ['charlie body'])),
    );
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'charlie body', ' early');
    {
      const d = A.doc();
      const entry = collectHeadings(d).find((e) => e.type === 'block' && e.text === 'Two')!;
      const range = computeHeadingRange(d, entry)!;
      dragController.begin({ view: A.view, items: [{ from: range.from, to: range.to, id: entry.id, type: 'block', level: 3, label: 'Two' }] });
      dragController.setHoverTarget({ view: A.view, insertPos: d.content.size });
      expect(dragController.commit()).toBe(true);
    }
    await settle();
    await sync(r.peers);
    B.view.dispatch(B.view.state.tr.insert(B.view.state.doc.content.size, cardNode('Partner', ['partner body'])));
    await settle();
    await sync(r.peers);
    const tags = (d: PMNode): string[] => text(d).filter((t) => /^[A-Z]/.test(t));
    expect(tags(A.doc())).toEqual(['One', 'Alpha', 'Three', 'Charlie', 'Two', 'Bravo', 'Partner']);

    await press(r, 0);
    expect(tags(A.doc()), 'the drag is undone and the partner card is kept where it was put').toEqual([
      'One',
      'Alpha',
      'Two',
      'Bravo',
      'Three',
      'Charlie',
      'Partner',
    ]);
    expect(text(A.doc())).toContain('partner body');
    expect(r.notices, 'nothing was lost, so nothing is announced').toEqual([]);
    expect(r.guards[0]!.stats.rescued, 'the undo removed nothing to rescue').toBe(0);
    expect(r.ums[0]!.canRedo(), 'the drag can be redone').toBe(true);
    expect(converged(r)).toBe(true);

    await press(r, 0); // the chain continues past it
    expect(text(A.doc())).toContain('charlie body');
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('a move gets an undo step of its own at the app merge interval', async () => {
    const r = await rig();
    const [A] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 0, 'charlie body', ' typed');
    await sleep(120);
    const first = A.doc().child(0);
    const tr = A.view.state.tr.delete(0, first.nodeSize);
    tr.insert(tr.doc.content.size, first);
    A.view.dispatch(tr); // Bravo, Charlie, Alpha
    await settle();
    await sync(r.peers);

    await press(r, 0);
    expect(text(A.doc()).filter((t) => /^[A-Z]/.test(t)), 'only the move').toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(text(A.doc()), 'the typing before it is still there').toContain('charlie body typed');
    await press(r, 0);
    expect(text(A.doc())).toContain('charlie body');
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  }, 20000);

  it('KNOWN LIMIT: a skip rebuilds the card, so the partner can no longer undo their edits inside it', async () => {
    // Loro cannot drop a step without running it, and running this one
    // deletes the card; the guard then writes the card back as NEW
    // containers. The partner's text is all there, but their undo steps
    // pointed at the old containers: Loro passes over them as dead. (The
    // first guard paid this on EVERY blocked keypress; a skip pays it once.)
    // Lifting it needs a way to discard a step unexecuted, which Loro's
    // undo manager does not offer.
    const r = await rig(0);
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    await typeAfter(r, 1, 'charlie body', ' b0');
    A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Delta', ['delta body'])));
    await settle();
    await sync(r.peers);
    await typeAfter(r, 1, 'delta body', ' <b>');
    await sync(r.peers);
    await press(r, 0); // skipped
    expect(text(B.doc()), 'nothing of the partner is lost').toContain('delta body <b>');
    await press(r, 1);
    expect(text(B.doc()), "B's typing in the rebuilt card is not undoable…").toContain('delta body <b>');
    expect(text(B.doc()), '…the press reaches their older edit instead').toContain('charlie body');
    expect(converged(r)).toBe(true);
    for (const p of r.peers) p.destroy();
  });
});
