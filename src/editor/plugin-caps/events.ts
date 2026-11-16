/**
 * `doc.events` → `api.events`: debounced doc-change / selection / focus
 * notifications.
 *
 * Host side is three `notify*` calls from the editors' dispatch paths
 * (index.ts single-doc, multi-pane-shell per pane, setActiveView). Each
 * is a no-op unless some granted plugin is listening, so the editor
 * pays nothing when no plugin uses events.
 */
import { createPluginHookRegistry, type PluginHookRegistry } from './hook-registry.js';
import type { CapabilityContext } from './context.js';

export interface PluginDocChangeEvent {
  docUid: string;
  /** True when every change in this batch came from a co-editing
   *  partner (none typed here). */
  fromCollaborator: boolean;
}
export interface PluginSelectionEvent {
  docUid: string;
}
export interface PluginFocusEvent {
  /** The newly focused doc, or null (e.g. the home screen). */
  docUid: string | null;
}

/** `doc.events` permission. Each `on*` returns an unsubscribe. */
export interface PluginEventsApi {
  /** A doc's content changed (debounced ~250 ms per doc). */
  onDocChange(cb: (e: PluginDocChangeEvent) => void): () => void;
  /** The selection moved in a doc (debounced ~150 ms per doc). */
  onSelectionChange(cb: (e: PluginSelectionEvent) => void): () => void;
  /** A different doc took focus. */
  onFocusChange(cb: (e: PluginFocusEvent) => void): () => void;
}

const PERMISSION = 'doc.events';
export const DOC_CHANGE_DEBOUNCE_MS = 250;
export const SELECTION_DEBOUNCE_MS = 150;

const changeHooks = createPluginHookRegistry<(e: PluginDocChangeEvent) => void>(PERMISSION);
const selectionHooks = createPluginHookRegistry<(e: PluginSelectionEvent) => void>(PERMISSION);
const focusHooks = createPluginHookRegistry<(e: PluginFocusEvent) => void>(PERMISSION);

const pendingChange = new Map<string, { timer: ReturnType<typeof setTimeout>; allRemote: boolean }>();
const pendingSelection = new Map<string, ReturnType<typeof setTimeout>>();
let lastFocus: string | null | undefined;

// ── Host side ─────────────────────────────────────────────────────────

/** A transaction changed doc `uid`'s content. */
export function notifyPluginDocChanged(uid: string, fromCollaborator: boolean): void {
  if (!changeHooks.any()) return;
  const prev = pendingChange.get(uid);
  if (prev) clearTimeout(prev.timer);
  const allRemote = (prev?.allRemote ?? true) && fromCollaborator;
  const timer = setTimeout(() => {
    pendingChange.delete(uid);
    changeHooks.each((_id, cb) => cb({ docUid: uid, fromCollaborator: allRemote }), 'onDocChange');
  }, DOC_CHANGE_DEBOUNCE_MS);
  pendingChange.set(uid, { timer, allRemote });
}

/** The selection moved in doc `uid`. */
export function notifyPluginSelectionChanged(uid: string): void {
  if (!selectionHooks.any()) return;
  const prev = pendingSelection.get(uid);
  if (prev) clearTimeout(prev);
  pendingSelection.set(
    uid,
    setTimeout(() => {
      pendingSelection.delete(uid);
      selectionHooks.each((_id, cb) => cb({ docUid: uid }), 'onSelectionChange');
    }, SELECTION_DEBOUNCE_MS),
  );
}

/** The focused doc may have changed. `focusedUid` is read AFTER the
 *  current task (a doc mount assigns its session uid after the view
 *  swap), and the event fires only when the uid really differs from the
 *  last one reported — so this is safe to call liberally. */
export function notifyPluginFocusChanged(focusedUid: () => string | null): void {
  queueMicrotask(() => {
    const uid = focusedUid();
    if (uid === lastFocus) return;
    lastFocus = uid;
    focusHooks.each((_id, cb) => cb({ docUid: uid }), 'onFocusChange');
  });
}

// ── Plugin side ───────────────────────────────────────────────────────

export function buildEventsApi(ctx: CapabilityContext): PluginEventsApi | undefined {
  if (!ctx.granted.has(PERMISSION)) return undefined;
  const { pluginId } = ctx;
  const on =
    <E>(reg: PluginHookRegistry<(e: E) => void>, name: string) =>
    (cb: (e: E) => void): (() => void) => {
      if (typeof cb !== 'function') throw new Error(`events.${name} needs a function`);
      return reg.add(pluginId, cb);
    };
  return Object.freeze({
    onDocChange: on(changeHooks, 'onDocChange'),
    onSelectionChange: on(selectionHooks, 'onSelectionChange'),
    onFocusChange: on(focusHooks, 'onFocusChange'),
  });
}

export function resetPluginEventsForTests(): void {
  for (const p of pendingChange.values()) clearTimeout(p.timer);
  for (const t of pendingSelection.values()) clearTimeout(t);
  pendingChange.clear();
  pendingSelection.clear();
  changeHooks.clear();
  selectionHooks.clear();
  focusHooks.clear();
  lastFocus = undefined;
}
