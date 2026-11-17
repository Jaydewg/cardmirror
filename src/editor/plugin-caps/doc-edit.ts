/**
 * `doc.edit` engine: one plugin insert = one transaction = one undo step.
 *
 * Content goes through the same builder as the external `/insert` bridge
 * (`buildExternalInsertTransaction`), so a plugin can't produce anything
 * an external app couldn't: schema-valid nodes, fresh heading ids, cards
 * never split. Every refusal is an explicit error — never a silent drop:
 *   read mode → `read-only`, spectator seat → `spectator`, a target
 *   inside a live view / linked copy → `mirrored`, an AI-locked region →
 *   `locked`, an unknown heading → `not-found`.
 */
import { closeHistory } from 'prosemirror-history';
import { Selection, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { coordinatorBlocks } from '../ai/edit-coordinator.js';
import { collabCopresenceFor, collabPluginSourceFor } from '../collab/collab-hooks.js';
import { buildExternalInsertTransaction, type ExternalInsertRole } from '../external-insert.js';
import { collectHeadings, computeHeadingRange } from '../headings.js';
import { inMirroredContent } from '../plugin-jump.js';
import { REPEAT_IGNORE_META } from '../repeat-last-action.js';

/** Transaction meta naming the plugin that made an edit. */
export const PLUGIN_EDIT_META = 'cm-plugin-edit';
/** Largest insert one call may make. */
export const PLUGIN_INSERT_MAX_CHARS = 100_000;

export type PluginInsertRole = ExternalInsertRole;
const ROLES = new Set<string>(['pocket', 'hat', 'block', 'tag', 'analytic', 'body', 'card', 'cite', 'inline']);

export interface PluginInsertRequest {
  /** Lines become paragraphs / headings per `role`. */
  text: string;
  /** What the text becomes. Default `card` (body paragraphs). Heading
   *  roles insert a heading; `tag` / `analytic` insert a one-heading card
   *  or unit. */
  role?: PluginInsertRole;
  /** Where: the cursor (default), the end of the doc, or the end of a
   *  heading's section / card. */
  at?: 'cursor' | 'end' | { after: string };
  /** Start a new paragraph rather than joining the one at the target
   *  (body / card / cite / inline roles). Default true. */
  newParagraph?: boolean;
}

export type PluginEditError =
  | 'no-doc'
  | 'read-only'
  | 'spectator'
  | 'not-found'
  | 'mirrored'
  | 'locked'
  | 'bad-request';

export type PluginEditResult = { ok: true } | { ok: false; error: PluginEditError };

/** Build the insert against `state`. Pure: no dispatch. */
export function buildPluginInsert(
  state: EditorState,
  req: PluginInsertRequest,
  pluginId: string,
): { tr: Transaction } | { error: PluginEditError } {
  if (!req || typeof req.text !== 'string' || req.text.length > PLUGIN_INSERT_MAX_CHARS) {
    return { error: 'bad-request' };
  }
  const role = req.role ?? 'card';
  if (!ROLES.has(role)) return { error: 'bad-request' };
  const at = req.at ?? 'cursor';

  let target: Selection;
  if (at === 'cursor') {
    target = state.selection;
  } else if (at === 'end') {
    target = Selection.atEnd(state.doc);
  } else if (at && typeof at === 'object' && typeof at.after === 'string') {
    const entry = collectHeadings(state.doc, { skipCite: true }).find(
      (e) => e.id === at.after && e.zonePos == null,
    );
    if (!entry) return { error: 'not-found' };
    const range = computeHeadingRange(state.doc, entry);
    if (!range) return { error: 'not-found' };
    target = Selection.near(state.doc.resolve(range.to), -1);
  } else {
    return { error: 'bad-request' };
  }
  if (inMirroredContent(state.doc, target.from)) return { error: 'mirrored' };

  // Build at the target selection, then replay onto ONE transaction from
  // the live state (a selection change doesn't alter the doc, so the
  // builder's steps apply unchanged).
  const base = target.eq(state.selection) ? state : state.apply(state.tr.setSelection(target));
  const built = buildExternalInsertTransaction(base, {
    text: req.text,
    role,
    newParagraph: req.newParagraph !== false,
  });
  if (!built) return { error: 'bad-request' };
  let tr = state.tr;
  if (base !== state) tr.setSelection(target);
  for (const step of built.steps) tr.step(step);
  tr.setSelection(Selection.fromJSON(tr.doc, built.selection.toJSON()));
  if (coordinatorBlocks(state, tr)) return { error: 'locked' };

  tr = closeHistory(tr);
  tr.setMeta('addToHistory', true);
  tr.setMeta(REPEAT_IGNORE_META, true); // Mod-Y must not repeat a plugin's edit
  tr.setMeta(PLUGIN_EDIT_META, pluginId);
  if (at === 'cursor') tr.scrollIntoView();
  return { tr };
}

const viewDestroyed = (view: EditorView): boolean =>
  (view as unknown as { docView: unknown }).docView == null;

/** Dispatch a plugin insert into `view` (doc `uid`). Deferred one tick:
 *  a cross-view dispatch from inside a keydown handler (plugin commands
 *  run from keymaps) breaks the next Ctrl-Z — same reason as
 *  speech-doc-send. The state is read AFTER the deferral, so the edit is
 *  built against what the user sees at that moment. */
export function runPluginInsert(
  view: EditorView,
  uid: string,
  req: PluginInsertRequest,
  pluginId: string,
): Promise<PluginEditResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (viewDestroyed(view)) return resolve({ ok: false, error: 'no-doc' });
      if (!view.editable) return resolve({ ok: false, error: 'read-only' });
      if (collabCopresenceFor(uid)?.role === 'spectator') return resolve({ ok: false, error: 'spectator' });
      const built = buildPluginInsert(view.state, req, pluginId);
      if ('error' in built) return resolve({ ok: false, error: built.error });
      // A co-edited doc's undo is Loro's, which merges commits within a
      // second — isolate so this edit is its own step there too.
      collabPluginSourceFor(uid)?.isolateNextStep?.();
      view.dispatch(built.tr);
      resolve({ ok: true });
    }, 0);
  });
}
