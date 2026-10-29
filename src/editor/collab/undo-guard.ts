/**
 * Container-safe undo/redo for co-editing sessions.
 *
 * A CRDT undo of a container-CREATING op (Enter in the middle of a tag,
 * inserting or pasting a card, or the redo of a card deletion) deletes
 * that container — and a container delete takes every concurrent edit
 * inside it. Partner B starts typing in the half A just split off, A
 * reflexively presses Ctrl+Z, and B's typing is gone with no error:
 * the doc converges cleanly on its absence (chaos rig, 2026-09-04:
 * undo/redo at 10% of ops quadrupled lost content — 18 lost tokens + 5
 * lost heads in 20 seeds; deterministic table in the rig's notes).
 *
 * Loro's UndoManager cannot preview a step, but it can reverse one, so
 * the guard works after the fact, on a rule that needs no knowledge of
 * step boundaries (the manager MERGES nearby local changes into one
 * step, silently):
 *
 *   - A bookkeeping plugin marks a container (by its heading id) as
 *     PARTNER-TOUCHED when a remote transaction creates or changes it,
 *     and clears the mark when a local, non-undo transaction creates
 *     it or deliberately deletes it (the user's intent covers whatever
 *     the partner had done by then).
 *   - After an undo/redo lands, any heading id that vanished names a
 *     removed container. If none of them was partner-touched, the step
 *     stands.
 *   - A blocked UNDO is SKIPPED, not walled: the document is put back
 *     exactly as it was with a write the manager does not record (commit
 *     origin `UNDO_SKIP_ORIGIN`, excluded — Loro still rebases the rest of
 *     the stack over it), the step is dropped, and the undo carries on to
 *     the step before it. Reversing with `redo()` instead (the first
 *     version of this guard) left the blocked step on top of the stack
 *     for ever: every later Ctrl+Z retried it, was reversed again, and
 *     everything the user had done before it became unreachable.
 *   - COLLATERAL removals are RESCUED, and the undo stands. Loro's undo of
 *     a list move can delete a card a partner inserted beside the moved
 *     run (found 2026-10-03: drag a section, partner adds a card at its
 *     end, undo — the partner's card is gone on every peer). A container
 *     that first appeared in a REMOTE transaction was never created by
 *     any step of mine, so no undo of mine is entitled to remove it: when
 *     every partner-touched container an undo removed is of that kind,
 *     they are written back where they stood (after their nearest
 *     surviving sibling) with the same excluded commit, the rest of the
 *     undo is kept. The redo of that undo is dropped (it would re-create
 *     what the undo deleted, a second copy). Nothing is announced; nothing
 *     was lost.
 *   - A blocked REDO is still reversed (undo of the redo) and explained;
 *     it stays on the redo stack.
 *   - Container-creating and container-deleting edits are ISOLATED into
 *     undo steps of their own. The manager merges edits that land within
 *     its merge interval, so without this a skipped step would drag along
 *     the unrelated typing that happened to share its second.
 *   - A MULTI-MOVE edit (a section drag, Alphabetize) is several undo
 *     steps, one move each, popped together as one group: Loro cannot undo
 *     a step that holds two moves (it loses list items or panics — see
 *     cardmirrorMove in the binding patch). The guard keeps merging off
 *     for the batch's commits. The collateral rescue above predates this;
 *     the loss it was found on was probably this Loro bug.
 *
 * Text-only undo/redo never removes a container and is never touched;
 * the user's OWN edits inside a container never block. Session-only —
 * single-doc editing keeps ProseMirror history.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Selection, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import type { LoroDoc, UndoManager } from 'loro-crdt';
import {
  loroSyncPluginKey,
  undo as loroUndo,
  redo as loroRedo,
  cardmirrorRegisterMoveBatchHooks,
  cardmirrorUndoStep,
  cardmirrorRedoStep,
} from 'loro-prosemirror';
import { HEADING_TYPE_NAMES } from '../../schema/ids.js';

export interface UndoGuard {
  undo: Command;
  redo: Command;
  /** Install alongside the session plugins — the partner-touched ledger. */
  plugin: Plugin;
  /** Test/diagnostic counters. `unrecoverable` = a reversal was needed
   *  but the manager could no longer perform it (a new local edit had
   *  already cleared the redo stack). */
  readonly stats: { blocked: number; allowed: number; unrecoverable: number; skipped: number; rescued: number };
  dispose(): void;
}

export interface UndoGuardOptions {
  doc: LoroDoc;
  undoManager: UndoManager;
  getView: () => EditorView | null;
  /** Shown when an undo/redo is reversed (toast / notice). */
  onBlocked: (message: string) => void;
  /** Shown when an undo skipped one or more steps and carried on. */
  onSkipped?: (message: string) => void;
  /** The manager's configured merge interval (ms), restored after an
   *  isolated step. Loro's default when omitted. */
  mergeInterval?: number;
}

/** Commit origin of the guard's put-it-back write. The undo manager must
 *  exclude it (`createUndoGuard` adds the exclusion). */
export const UNDO_SKIP_ORIGIN = 'cm-undo-skip';
export const undoSkippedMessage = (n: number): string =>
  n === 1
    ? 'Skipped one undo step — a partner has edited the card it would remove.'
    : `Skipped ${n} undo steps — a partner has edited the cards they would remove.`;
/** A run of consecutive skips is bounded; past this the undo stops. */
const MAX_SKIPS_PER_UNDO = 25;

export const UNDO_BLOCKED_MESSAGE =
  "Can't undo that here — a partner has edited the card it would remove.";
export const REDO_BLOCKED_MESSAGE =
  "Can't redo that here — a partner has edited the card it would remove.";

const undoGuardKey = new PluginKey('cm-undo-guard');

/** heading id → fingerprint of the container that carries it. For a tag /
 *  analytic the container is the enclosing card / analytic unit; a
 *  pocket / hat / block is its own container. */
export function containerFingerprints(doc: PMNode): ReadonlyMap<string, string> {
  const cached = docFingerprints.get(doc);
  if (cached) return cached;
  const out = new Map<string, string>();
  doc.forEach((child) => {
    for (const [id, fp] of childFingerprints(child, doc)) out.set(id, fp);
  });
  docFingerprints.set(doc, out);
  return out;
}

/** Nodes are immutable and an edit keeps every untouched top-level child's
 *  identity, so fingerprints are cached per doc (one transaction's new doc is
 *  the next one's old doc) and per top-level child (a keystroke re-reads only
 *  the card it landed in, not every card's text). */
const docFingerprints = new WeakMap<PMNode, Map<string, string>>();
const childFingerprintCache = new WeakMap<PMNode, [string, string][]>();

function childFingerprints(child: PMNode, doc: PMNode): [string, string][] {
  const cached = childFingerprintCache.get(child);
  if (cached) return cached;
  const out: [string, string][] = [];
  const visit = (n: PMNode, parent: PMNode | null): boolean => {
    if (!HEADING_TYPE_NAMES.has(n.type.name)) return true;
    const id = n.attrs['id'];
    if (typeof id !== 'string' || !id) return true;
    const container = n.type.name === 'tag' || n.type.name === 'analytic' ? (parent ?? n) : n;
    out.push([id, `${container.type.name}|${container.childCount}|${container.textContent}`]);
    return true;
  };
  if (visit(child, doc)) child.descendants((n, _pos, parent) => visit(n, parent));
  childFingerprintCache.set(child, out);
  return out;
}

export function createUndoGuard(opts: UndoGuardOptions): UndoGuard {
  const { undoManager, getView, doc } = opts;
  const stats = { blocked: 0, allowed: 0, unrecoverable: 0, skipped: 0, rescued: 0 };
  const baseMergeInterval = opts.mergeInterval ?? 1000;
  undoManager.addExcludeOriginPrefix(UNDO_SKIP_ORIGIN);
  /** Local commits still to land with merging off (see `isolateStep`). */
  let isolating = 0;
  /** Give the next local commit an undo step of its own: merging is off
   *  for it (so it does not join the step before) and for the commit after
   *  it (so that one does not join it). */
  const isolateStep = (): void => {
    if (isolating === 0) undoManager.setMergeInterval(0);
    isolating = 2;
  };
  /** Containers (heading ids) a remote transaction touched since they last
   *  appeared or were deliberately deleted locally. */
  const partnerTouched = new Set<string>();
  /** Containers (heading ids) that first appeared in a remote transaction:
   *  a partner made them, so no undo step of mine created them. */
  const partnerCreated = new Set<string>();

  // The binding dispatches BOTH remote imports and undo/redo results with
  // the same 'non-local-updates' meta; Loro's event tells them apart
  // (by: 'import' vs a local event with origin 'undo'). This subscription
  // is registered before the view's, so it runs first, synchronously,
  // ahead of the binding's dispatch.
  let lastEventBy: string = 'local';
  /** Inside a split move batch (the binding's cardmirrorMove): its commits
   *  must stay steps of their own — Loro cannot undo a step holding two
   *  moves — so merging is off throughout and none of them counts. */
  let batching = false;
  const unregisterMoveBatch = cardmirrorRegisterMoveBatchHooks(doc, {
    begin: () => {
      batching = true;
      undoManager.setMergeInterval(0);
    },
    end: () => {
      batching = false;
      // Merging stays off until the next local commit has its own step,
      // so it does not join the batch's last one (and undo with it).
      isolating = 1;
    },
  });
  const unsubscribe = doc.subscribe((event) => {
    lastEventBy = event.by;
    if (batching) return;
    if (isolating > 0 && event.by === 'local' && event.origin !== 'undo' && event.origin !== 'redo') {
      // Excluded origins (comments, meta, the guard's own restore) never
      // become steps, so they do not count against the isolation.
      if (event.origin === UNDO_SKIP_ORIGIN) return;
      isolating--;
      if (isolating === 0) undoManager.setMergeInterval(baseMergeInterval);
    }
  });

  const plugin = new Plugin({
    key: undoGuardKey,
    state: {
      init: () => null,
      apply: (tr: Transaction, value: null, oldState: EditorState, newState: EditorState) => {
        if (!tr.docChanged) return value;
        const sync = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined;
        if (sync?.type === 'non-local-updates') {
          if (lastEventBy !== 'import') return value; // undo/redo result: marks persist
          const before = containerFingerprints(oldState.doc);
          for (const [id, fp] of containerFingerprints(newState.doc)) {
            if (before.get(id) !== fp) partnerTouched.add(id);
            if (!before.has(id)) partnerCreated.add(id);
          }
          return value;
        }
        if (sync !== undefined) return value; // the binding's own echoes
        // The guard's own put-it-back write: the containers it restores are
        // exactly as partner-touched as they were.
        if (tr.getMeta(undoGuardKey) === 'restore') return value;
        // No early-out on an empty partnerTouched: structural local edits
        // still isolate their undo step.
        const before = containerFingerprints(oldState.doc);
        const after = containerFingerprints(newState.doc);
        // A local, user-originated transaction: containers it creates or
        // deletes start clean — the intent covers the partner's prior edits.
        let structural = false;
        for (const id of after.keys())
          if (!before.has(id)) {
            partnerTouched.delete(id);
            structural = true;
          }
        for (const id of before.keys())
          if (!after.has(id)) {
            partnerTouched.delete(id);
            structural = true;
          }
        // A move (a drag, a cut-and-paste that kept its ids) changes the
        // ORDER of the containers and nothing else; it gets a step of its
        // own too, so undoing a drag never takes the typing before it.
        if (!structural && before.size === after.size) {
          const was = before.keys();
          for (const id of after.keys()) {
            if (was.next().value !== id) {
              structural = true;
              break;
            }
          }
        }
        if (structural) isolateStep();
        return value;
      },
    },
  });

  /** Put the document back to `target` with a write the undo manager does
   *  not record. Bounded to the changed span, like the binding's remote
   *  render, so positions outside it (carets, decorations) hold still. */
  const restoreDoc = (view: EditorView, target: PMNode, selection: Selection): boolean => {
    const cur = view.state.doc;
    const start = cur.content.findDiffStart(target.content);
    if (start == null) return true;
    let tr = view.state.tr;
    let applied = false;
    try {
      let { a: endA, b: endB } = cur.content.findDiffEnd(target.content)!;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      tr.replace(start, endA, target.slice(start, endB));
      applied = tr.doc.content.eq(target.content);
    } catch {
      applied = false;
    }
    if (!applied) {
      tr = view.state.tr.replace(0, cur.content.size, new Slice(Fragment.from(target.content), 0, 0));
      if (!tr.doc.content.eq(target.content)) return false;
    }
    // The caret goes back where it was, when that is still a text position.
    const size = tr.doc.content.size;
    if (selection.anchor <= size && selection.head <= size) {
      const $a = tr.doc.resolve(selection.anchor);
      const $h = tr.doc.resolve(selection.head);
      if ($a.parent.inlineContent && $h.parent.inlineContent) tr.setSelection(new TextSelection($a, $h));
    }
    tr.setMeta(undoGuardKey, 'restore');
    tr.setMeta('cmCommitOrigin', UNDO_SKIP_ORIGIN);
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
    return true;
  };

  /** Heading id of a top-level node: a heading's own, a card's tag's. */
  const topLevelHeadId = (n: PMNode): string | null => {
    const head = HEADING_TYPE_NAMES.has(n.type.name) ? n : n.firstChild;
    const id = head && HEADING_TYPE_NAMES.has(head.type.name) ? head.attrs['id'] : null;
    return typeof id === 'string' && id ? id : null;
  };

  /** Write back the top-level containers `ids` that an undo removed, each
   *  after its nearest sibling (in `docBefore`) that still exists. False
   *  when one of them was not a top-level node (the caller skips instead). */
  const rescueContainers = (view: EditorView, docBefore: PMNode, ids: string[]): boolean => {
    const wanted = new Set(ids);
    const tr = view.state.tr;
    const kids: PMNode[] = [];
    docBefore.forEach((n) => kids.push(n));
    let found = 0;
    for (let i = 0; i < kids.length; i++) {
      const id = topLevelHeadId(kids[i]!);
      if (id === null || !wanted.has(id)) continue;
      found++;
      // Insert after the nearest earlier sibling present in the document
      // as it now stands (which includes containers rescued a moment ago).
      let at = 0;
      for (let j = i - 1; j >= 0 && at === 0; j--) {
        const prevId = topLevelHeadId(kids[j]!);
        if (prevId === null) continue;
        tr.doc.forEach((n, off) => {
          if (at === 0 && topLevelHeadId(n) === prevId) at = off + n.nodeSize;
        });
      }
      try {
        tr.insert(at, kids[i]!);
      } catch {
        return false;
      }
    }
    if (found !== wanted.size) return false;
    tr.setMeta(undoGuardKey, 'restore');
    tr.setMeta('cmCommitOrigin', UNDO_SKIP_ORIGIN);
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
    return true;
  };

  /** After the step's events have reached the PM doc, compare. `skips` is
   *  how many steps this one keypress has already skipped. */
  const verify = (before: EditorState, isUndo: boolean, skips: number, attempt = 0): void => {
    const view = getView();
    if (!view) return;
    const docBefore = before.doc;
    const docAfter = view.state.doc;
    if (docAfter === docBefore && attempt < 4) {
      // Loro delivers the step's events on a microtask; the binding
      // dispatches inside that. Retry on the next tick, a few times.
      setTimeout(() => verify(before, isUndo, skips, attempt + 1), 0);
      return;
    }
    const fpBefore = containerFingerprints(docBefore);
    const fpAfter = containerFingerprints(docAfter);
    const removed = [...fpBefore.keys()].filter((id) => !fpAfter.has(id));
    if (!removed.some((id) => partnerTouched.has(id))) {
      stats.allowed++;
      if (skips > 0) (opts.onSkipped ?? opts.onBlocked)(undoSkippedMessage(skips));
      return;
    }
    const lost = removed.filter((id) => partnerTouched.has(id));
    if (isUndo && lost.every((id) => partnerCreated.has(id))) {
      // Collateral: the step never created these, yet its undo took them.
      // Keep the undo and put them back. (A redo that does the same is
      // reversed like any blocked redo.)
      setTimeout(() => {
        const v = getView();
        if (v && rescueContainers(v, docBefore, lost)) {
          // The redo of this undo would re-create what the undo deleted —
          // a second copy of every container just rescued.
          undoManager.clearRedo();
          stats.rescued++;
          stats.allowed++;
          if (skips > 0) (opts.onSkipped ?? opts.onBlocked)(undoSkippedMessage(skips));
          return;
        }
        resolveBlocked(before, isUndo, skips);
      }, 0);
      return;
    }
    resolveBlocked(before, isUndo, skips);
  };

  /** The step would remove a container a partner has built on and that it
   *  is entitled to remove (it created it): reverse a redo, skip an undo. */
  const resolveBlocked = (before: EditorState, isUndo: boolean, skips: number): void => {
    const docBefore = before.doc;
    stats.blocked++;
    if (!isUndo) {
      const reverted = cardmirrorUndoStep(undoManager);
      if (!reverted) stats.unrecoverable++;
      opts.onBlocked(REDO_BLOCKED_MESSAGE);
      return;
    }
    // SKIP. On a macrotask: the binding ignores local writes until its
    // own undo window (a setTimeout(0) armed by the undo call) has closed.
    setTimeout(() => {
      const v = getView();
      if (!v) return;
      if (!restoreDoc(v, docBefore, before.selection)) {
        // Could not rebuild the document — fall back to the reversal.
        if (!cardmirrorRedoStep(undoManager)) stats.unrecoverable++;
        opts.onBlocked(UNDO_BLOCKED_MESSAGE);
        return;
      }
      // The skipped step sits on the redo stack; redoing it would re-apply
      // an edit whose undo never stood.
      undoManager.clearRedo();
      stats.skipped++;
      const done = skips + 1;
      if (done >= MAX_SKIPS_PER_UNDO || !undoManager.canUndo()) {
        (opts.onSkipped ?? opts.onBlocked)(undoSkippedMessage(done));
        return;
      }
      // Carry on to the step before it.
      const state = v.state;
      const ran = loroUndo(state, (tr) => v.dispatch(tr), v);
      if (ran) queueMicrotask(() => verify(state, true, done));
      else (opts.onSkipped ?? opts.onBlocked)(undoSkippedMessage(done));
    }, 0);
  };

  const wrap =
    (inner: Command, isUndo: boolean): Command =>
    (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => {
      if (!dispatch) return inner(state, dispatch, view);
      const ran = inner(state, dispatch, view);
      // Check as early as the runtime allows — after Loro's event
      // microtask, before any later keystroke can clear the redo stack.
      if (ran) queueMicrotask(() => verify(state, isUndo, 0));
      return ran;
    };

  return {
    undo: wrap(loroUndo, true),
    redo: wrap(loroRedo, false),
    plugin,
    stats,
    dispose: () => {
      unsubscribe();
      unregisterMoveBatch();
    },
  };
}
