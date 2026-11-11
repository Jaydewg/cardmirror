/**
 * Plugin data carried in open documents — the editor half of the
 * `files.data` permission (the file half is src/native/plugin-data.ts).
 *
 * Each open doc's `plugins` bag lives here, keyed by the doc's SESSION
 * uid (single-doc `currentDocUid`, multi-pane `DocRecord.uid`):
 *   - adopted when a `.cmir` is opened (journal recovery included);
 *   - on every working-copy save, merged with what each plugin's save
 *     hook returns (null = remove my entry, undefined = keep it as is);
 *   - entries from plugins that aren't installed / enabled / granted
 *     are carried through unchanged, so a file passed between machines
 *     never loses another plugin's data.
 *
 * Open hooks fire once per (doc, plugin) for docs carrying that plugin's
 * entry — at open, or when the plugin registers its hook later (plugins
 * load asynchronously after boot). Every hook call re-checks the
 * permission, so a revoke or unregister silences hooks immediately.
 */
import {
  sanitizePluginBag,
  sanitizePluginEntry,
  type PluginFileBag,
} from '../native/plugin-data.js';
import { pluginDisplayName, pluginHasPermission } from './plugin-registry.js';
import { createPluginHookRegistry } from './plugin-caps/hook-registry.js';

export const FILES_DATA_PERMISSION = 'files.data';

export interface PluginDocContext {
  /** Session uid of the doc (stable while it's open in this window). */
  docUid: string;
  /** Persistent docId, or null for a never-saved doc. */
  docId: string | null;
  /** File name (or "Untitled"). */
  title: string;
}

/** A save hook's answer: new data (+ optional notice), `null` to remove
 *  this plugin's entry, `undefined` to leave the stored entry as is. */
export type PluginSaveResult = { data: unknown; summary?: string } | null | undefined;
export type PluginSaveHook = (ctx: PluginDocContext) => PluginSaveResult;
export type PluginOpenHook = (data: unknown, ctx: PluginDocContext) => void | Promise<void>;

const bags = new Map<string, PluginFileBag>();
const openContexts = new Map<string, PluginDocContext>();
// One hook of each kind per plugin; grants are checked when they fire.
const saveHooks = createPluginHookRegistry<PluginSaveHook>(FILES_DATA_PERMISSION, { onePerPlugin: true });
const openHooks = createPluginHookRegistry<PluginOpenHook>(FILES_DATA_PERMISSION, { onePerPlugin: true });
/** `${uid}\u0000${pluginId}` pairs whose open hook already ran. */
const openFired = new Set<string>();
/** Doc uids already reported to the unclaimed-data listener. */
const unclaimedReported = new Set<string>();
let unclaimedListener: ((ctx: PluginDocContext, entries: { id: string; name: string }[]) => void) | null =
  null;

const firedKey = (uid: string, pluginId: string): string => `${uid}\u0000${pluginId}`;

/** Host hook: told about entries no registered plugin claims, shortly
 *  after a doc opens (the host decides whether the plugin is missing or
 *  just disabled, and posts a notice). */
export function setUnclaimedPluginDataListener(
  fn: ((ctx: PluginDocContext, entries: { id: string; name: string }[]) => void) | null,
): void {
  unclaimedListener = fn;
  // Docs opened before the host installed its listener (boot opens race
  // the async plugin boot) are reported now.
  if (fn) {
    setTimeout(() => {
      for (const uid of bags.keys()) reportUnclaimed(uid);
    }, 0);
  }
}

/** Record the bag read from a just-opened file and schedule its open
 *  hooks (after the mount completes). A null/empty bag clears any data
 *  previously held for the uid. */
export function adoptPluginFileData(
  ctx: PluginDocContext,
  bag: PluginFileBag | null | undefined,
): void {
  const clean = sanitizePluginBag(bag);
  for (const key of [...openFired]) {
    if (key.startsWith(`${ctx.docUid}\u0000`)) openFired.delete(key);
  }
  unclaimedReported.delete(ctx.docUid);
  if (Object.keys(clean).length === 0) {
    bags.delete(ctx.docUid);
    openContexts.delete(ctx.docUid);
    return;
  }
  bags.set(ctx.docUid, clean);
  openContexts.set(ctx.docUid, { ...ctx });
  setTimeout(() => {
    fireOpenHooks(ctx.docUid);
    reportUnclaimed(ctx.docUid);
  }, 0);
}

/** Drop a closed doc's data. */
export function forgetPluginFileData(uid: string): void {
  bags.delete(uid);
  openContexts.delete(uid);
  unclaimedReported.delete(uid);
  for (const key of [...openFired]) if (key.startsWith(`${uid}\u0000`)) openFired.delete(key);
}

/** The bag to embed in a working-copy save of `ctx.docUid`: the stored
 *  entries, updated by every granted plugin's save hook. Also becomes
 *  the stored bag. Undefined when empty (the file gets no field). */
export function collectPluginFileData(ctx: PluginDocContext): PluginFileBag | undefined {
  const next: PluginFileBag = { ...(bags.get(ctx.docUid) ?? {}) };
  for (const [pluginId, hook] of saveHooks.entries()) {
    let result: PluginSaveResult;
    try {
      result = hook({ ...ctx });
    } catch (err) {
      console.error(`[plugins] ${pluginId} save hook failed (its stored data is kept):`, err);
      continue;
    }
    if (result === undefined) continue;
    if (result === null) {
      delete next[pluginId];
      continue;
    }
    if (typeof result !== 'object' || (result as { then?: unknown }).then) {
      console.warn(`[plugins] ${pluginId} save hook must return synchronously; ignored.`);
      continue;
    }
    const entry = sanitizePluginEntry({
      name: pluginDisplayName(pluginId) ?? pluginId,
      data: result.data,
      summary: result.summary,
    });
    if (!entry) {
      console.warn(`[plugins] ${pluginId} save hook returned unsavable data (not JSON / over 64 KB); ignored.`);
      continue;
    }
    next[pluginId] = entry;
  }
  if (Object.keys(next).length === 0) {
    bags.delete(ctx.docUid);
    return undefined;
  }
  bags.set(ctx.docUid, next);
  return next;
}

/** This plugin's stored data for a doc (as last opened / saved), or null. */
export function getPluginFileData(uid: string, pluginId: string): unknown {
  const entry = bags.get(uid)?.[pluginId];
  return entry === undefined ? null : (JSON.parse(JSON.stringify(entry.data)) as unknown);
}

/** Register a plugin's save hook (one per plugin; re-registering
 *  replaces it). Returns an unsubscribe. */
export function registerPluginSaveHook(pluginId: string, hook: PluginSaveHook): () => void {
  return saveHooks.add(pluginId, hook);
}

/** Register a plugin's open hook (one per plugin). Fires right away
 *  (async) for already-open docs carrying this plugin's data whose open
 *  hook hasn't run yet. Returns an unsubscribe. */
export function registerPluginOpenHook(pluginId: string, hook: PluginOpenHook): () => void {
  const unsubscribe = openHooks.add(pluginId, hook);
  setTimeout(() => {
    for (const uid of bags.keys()) fireOpenHooks(uid);
  }, 0);
  return unsubscribe;
}

function fireOpenHooks(uid: string): void {
  const bag = bags.get(uid);
  const ctx = openContexts.get(uid);
  if (!bag || !ctx) return;
  for (const pluginId of Object.keys(bag)) {
    const hook = openHooks.forPlugin(pluginId)[0];
    if (!hook) continue;
    const key = firedKey(uid, pluginId);
    if (openFired.has(key)) continue;
    openFired.add(key);
    const report = (err: unknown): void => console.error(`[plugins] ${pluginId} open hook failed:`, err);
    try {
      const r = hook(getPluginFileData(uid, pluginId), { ...ctx });
      if (r && typeof (r as Promise<void>).catch === 'function') void (r as Promise<void>).catch(report);
    } catch (err) {
      report(err);
    }
  }
}

function reportUnclaimed(uid: string): void {
  const bag = bags.get(uid);
  const ctx = openContexts.get(uid);
  if (!bag || !ctx || !unclaimedListener || unclaimedReported.has(uid)) return;
  unclaimedReported.add(uid);
  const entries = Object.entries(bag)
    .filter(([id]) => !pluginHasPermission(id, FILES_DATA_PERMISSION))
    .map(([id, e]) => ({ id, name: e.name }));
  if (entries.length === 0) return;
  try {
    unclaimedListener({ ...ctx }, entries);
  } catch (err) {
    console.error('[plugins] unclaimed-data listener failed:', err);
  }
}

export function resetPluginFileDataForTests(): void {
  bags.clear();
  openContexts.clear();
  saveHooks.clear();
  openHooks.clear();
  openFired.clear();
  unclaimedReported.clear();
  unclaimedListener = null;
}
