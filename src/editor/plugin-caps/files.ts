/** `files.data` → `api.files`: the plugin's own JSON inside `.cmir`
 *  working-copy saves (host side: ../plugin-file-data.ts). */
import {
  getPluginFileData,
  registerPluginOpenHook,
  registerPluginSaveHook,
  type PluginDocContext,
  type PluginOpenHook,
  type PluginSaveHook,
} from '../plugin-file-data.js';
import { targetDocUid, type CapabilityContext } from './context.js';

export type { PluginDocContext, PluginOpenHook, PluginSaveHook, PluginSaveResult } from '../plugin-file-data.js';

/** `files.data` permission: keep the plugin's own JSON inside `.cmir`
 *  working-copy saves (Save, Save As, autosave, crash journal — never
 *  exports), up to 64 KB per file. Other plugins' data is invisible. */
export interface PluginFilesApi {
  /** Called synchronously on every working-copy save of every doc.
   *  Return `{data, summary?}` to write (summary: a short ASCII notice
   *  that metadata readers can show — never secrets), `null` to remove
   *  your entry, or `undefined` to keep the stored entry unchanged.
   *  Must be fast and must not throw. One hook per plugin; registering
   *  again replaces it. Returns an unsubscribe. */
  onSave(hook: PluginSaveHook): () => void;
  /** Called once per opened doc that carries your entry (also for docs
   *  already open when the hook registers). Returns an unsubscribe. */
  onOpen(hook: PluginOpenHook): () => void;
  /** Your stored data for a doc (default: the focused doc), or null. */
  get(docUid?: string): unknown;
  /** The focused doc's identity, or null when none. */
  focusedDoc(): PluginDocContext | null;
}

export function buildFilesApi(ctx: CapabilityContext): PluginFilesApi | undefined {
  if (!ctx.granted.has('files.data')) return undefined;
  const { pluginId, deps } = ctx;
  const focusedDoc = (): PluginDocContext | null => {
    const uid = deps.getFocusedDocUid?.() ?? null;
    const ident = deps.getDocIdentity();
    if (!uid || !ident) return null;
    return { docUid: uid, docId: ident.docId, title: ident.docTitle };
  };
  return Object.freeze({
    onSave(hook: PluginSaveHook) {
      if (typeof hook !== 'function') throw new Error('files.onSave needs a function');
      return registerPluginSaveHook(pluginId, hook);
    },
    onOpen(hook: PluginOpenHook) {
      if (typeof hook !== 'function') throw new Error('files.onOpen needs a function');
      return registerPluginOpenHook(pluginId, hook);
    },
    get(docUid?: string) {
      const uid = targetDocUid(deps, docUid);
      return uid ? getPluginFileData(uid, pluginId) : null;
    },
    focusedDoc,
  });
}
