/** `doc.read` / `doc.edit` → `api.doc` (methods per permission). */
import { targetDocUid, targetView, type CapabilityContext } from './context.js';
import { readDocStructure, type PluginDocStructure, type PluginReadOptions } from './doc-read.js';
import { runPluginInsert, type PluginEditResult, type PluginInsertRequest } from './doc-edit.js';
import { jumpToHeadingInView } from '../plugin-jump.js';
import type { JumpResult } from '../plugin-api.js';

export type {
  PluginCard,
  PluginCardFormatting,
  PluginDocStats,
  PluginHeadingType,
  PluginOutlineItem,
  PluginReadOptions,
  PluginTextSpan,
  PluginTextStyle,
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
   *  elsewhere). Cheap enough to call on every `events.onDocChange`.
   *  `{ formatting: true }` adds each item's and card's direct formatting
   *  (highlight, underline, emphasis, cite, shading, bold, italic) as
   *  character spans — costlier, so ask only when you need it. Builds
   *  before it existed ignore the option: check `formatting !== undefined`. */
  read?(docUid?: string, opts?: PluginReadOptions): PluginDocSnapshot | null;
  /** Insert text as cards / headings / body. One undo step per call;
   *  refused (never silently dropped) in read mode, for spectators, in
   *  live views / linked copies, and in AI-locked regions. */
  insert?(req: PluginInsertRequest & { docUid?: string }): Promise<PluginEditResult>;
  /** Scroll to a heading (an id from `read`: `PluginOutlineItem.id`,
   *  `PluginCard.headingId`, or a menu target's `headingId`) and put the
   *  cursor there. `part: 'cite'` lands on the start of the first cite
   *  paragraph of the card it heads instead (the heading when there is
   *  none). Targets the focused doc unless `docUid` names another open
   *  one. `doc.read`. */
  jumpTo?(target: PluginJumpTarget): Promise<JumpResult>;
}

/** `doc.jumpTo`'s target. Unknown fields are ignored. */
export interface PluginJumpTarget {
  headingId: string;
  docUid?: string;
  /** Default `'heading'`. */
  part?: 'heading' | 'cite';
}

export function buildDocApi(ctx: CapabilityContext): PluginDocApi | undefined {
  const { deps, granted, pluginId } = ctx;
  const read = granted.has('doc.read');
  const edit = granted.has('doc.edit');
  if (!read && !edit) return undefined;
  const api: PluginDocApi = {};
  if (read) {
    api.read = (docUid, opts) => {
      const hit = targetView(deps, docUid);
      if (!hit) return null;
      const ident =
        docUid == null ? deps.getDocIdentity() : deps.docIdentityForUid?.(hit.uid) ?? null;
      return {
        docUid: hit.uid,
        docId: ident?.docId ?? null,
        title: ident?.docTitle ?? 'Untitled',
        ...readDocStructure(hit.view.state.doc, {
          formatting: opts != null && typeof opts === 'object' && opts.formatting === true,
        }),
      };
    };
    api.jumpTo = async (target) => {
      const t = (target && typeof target === 'object' ? target : {}) as Partial<PluginJumpTarget>;
      if (typeof t.headingId !== 'string' || !t.headingId) return { ok: false, error: 'bad-request' };
      const part = t.part === 'cite' ? 'cite' : 'heading';
      const docUid = t.docUid != null ? String(t.docUid) : undefined;
      const hit = targetView(deps, docUid);
      if (!hit) return { ok: false, error: 'doc-not-open' };
      return jumpToHeadingInView(hit.view, t.headingId, part) ? { ok: true } : { ok: false, error: 'not-found' };
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
