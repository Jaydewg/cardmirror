/** `doc.read` / `doc.edit` → `api.doc` (methods per permission). */
import { targetDocUid, targetView, type CapabilityContext } from './context.js';
import { readDocStructure, type PluginDocStructure } from './doc-read.js';
import { runPluginInsert, type PluginEditResult, type PluginInsertRequest } from './doc-edit.js';

export type {
  PluginCard,
  PluginDocStats,
  PluginHeadingType,
  PluginOutlineItem,
} from './doc-read.js';
export type { PluginEditError, PluginEditResult, PluginInsertRequest, PluginInsertRole } from './doc-edit.js';

export interface PluginDocSnapshot extends PluginDocStructure {
  docUid: string;
  docId: string | null;
  title: string;
}

/** `doc.read` → `read`; `doc.edit` → `insert`. Every call targets the
 *  focused doc unless `docUid` names another open one. */
export interface PluginDocApi {
  /** Outline, cards and stats of a doc, or null when no such doc is open.
   *  Live views and linked copies are skipped (their content lives
   *  elsewhere). Cheap enough to call on every `events.onDocChange`. */
  read?(docUid?: string): PluginDocSnapshot | null;
  /** Insert text as cards / headings / body. One undo step per call;
   *  refused (never silently dropped) in read mode, for spectators, in
   *  live views / linked copies, and in AI-locked regions. */
  insert?(req: PluginInsertRequest & { docUid?: string }): Promise<PluginEditResult>;
}

export function buildDocApi(ctx: CapabilityContext): PluginDocApi | undefined {
  const { deps, granted, pluginId } = ctx;
  const read = granted.has('doc.read');
  const edit = granted.has('doc.edit');
  if (!read && !edit) return undefined;
  const api: PluginDocApi = {};
  if (read) {
    api.read = (docUid) => {
      const hit = targetView(deps, docUid);
      if (!hit) return null;
      const ident =
        docUid == null ? deps.getDocIdentity() : deps.docIdentityForUid?.(hit.uid) ?? null;
      return {
        docUid: hit.uid,
        docId: ident?.docId ?? null,
        title: ident?.docTitle ?? 'Untitled',
        ...readDocStructure(hit.view.state.doc),
      };
    };
  }
  if (edit) {
    api.insert = async (req) => {
      const docUid = req && req.docUid != null ? String(req.docUid) : undefined;
      const hit = targetView(deps, docUid);
      if (!hit || !targetDocUid(deps, docUid)) return { ok: false, error: 'no-doc' };
      return runPluginInsert(hit.view, hit.uid, req, pluginId);
    };
  }
  return Object.freeze(api);
}
