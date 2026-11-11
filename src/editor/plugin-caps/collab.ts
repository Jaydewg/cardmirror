/** `collab.read` / `collab.shareCode` / `collab.join` → `api.collab`
 *  (host side: the bridge built in index.ts over collab-ui). */
import { targetDocUid, type CapabilityContext } from './context.js';

/** How `api.collab.join` ended. */
export type PluginJoinOutcome =
  | 'joined'
  | 'ended'
  | 'invalid'
  | 'needs-update'
  | 'cancelled'
  | 'unavailable'
  | 'failed';

/** A live session's public facts — never its key. */
export interface PluginSessionInfo {
  roomId: string;
  role: 'host' | 'participant' | 'spectator';
  /** The session's published title, when known. */
  title: string | null;
  /** Relay host (e.g. "relay.example.org"), when known. */
  relayHost: string | null;
}

/** This machine's saved record of a session (it was in that room before). */
export interface PluginLocalSessionRecord {
  /** The docId of the doc that held the session here. When it equals an
   *  opened file's docId, CardMirror itself offers Rejoin / Leave for that
   *  file — a plugin shouldn't prompt as well. */
  docId: string | null;
  role: 'host' | 'participant' | 'spectator';
}

/** `collab.*` permissions. Each method exists only with its permission:
 *  `collab.read` → current / roomIdOf / localRecord;
 *  `collab.shareCode` → shareCode; `collab.join` → join. */
export interface PluginCollabApi {
  /** The live session of a doc (default: the focused doc), or null. */
  current?(docUid?: string): PluginSessionInfo | null;
  /** Room id inside a share code (no network), or null if malformed. */
  roomIdOf?(code: string): string | null;
  /** This machine's record of the room, or null if it was never in it.
   *  (Joining a room with a record resumes it, keeping unsent edits.) */
  localRecord?(roomId: string): Promise<PluginLocalSessionRecord | null>;
  /** The EDIT share code of a doc's live session (default: focused doc);
   *  null without a session or in a spectator seat. Synchronous, so a
   *  `files.onSave` hook can use it. */
  shareCode?(docUid?: string): string | null;
  /** Join from a share code. `intoDoc`: a clean doc (by session uid) the
   *  session replaces while keeping its file, so saving writes the live
   *  copy back; omitted → a new session doc. Only one join per plugin at
   *  a time. */
  join?(code: string, opts?: { intoDoc?: string }): Promise<PluginJoinOutcome>;
}

/** Host side of `collab.*` (implemented in the editor, which owns the
 *  lazily loaded collab module). */
export interface PluginCollabBridge {
  sessionInfo(docUid: string): PluginSessionInfo | null;
  editShareCode(docUid: string): string | null;
  localRecord(roomId: string): Promise<PluginLocalSessionRecord | null>;
  join(code: string, intoDocUid: string | null): Promise<PluginJoinOutcome>;
}

/** Room id from a share code, any generation / flag letters
 *  (`cmshare2f.<room>.<key>.<ver>@home` included). */
const SHARE_CODE_ROOM_RE = /^(?:cmshare|cmview)\d+[a-z]*\.([0-9a-f]{16,64})\./;

export function buildCollabApi(ctx: CapabilityContext): PluginCollabApi | undefined {
  const { deps, granted } = ctx;
  const bridge = deps.collab;
  const read = granted.has('collab.read');
  const code = granted.has('collab.shareCode');
  const join = granted.has('collab.join');
  if (!bridge || !(read || code || join)) return undefined;
  let joining = false;
  const api: PluginCollabApi = {};
  if (read) {
    api.current = (docUid) => {
      const uid = targetDocUid(deps, docUid);
      return uid ? bridge.sessionInfo(uid) : null;
    };
    api.roomIdOf = (c) => SHARE_CODE_ROOM_RE.exec(String(c ?? '').trim())?.[1] ?? null;
    api.localRecord = (roomId) => bridge.localRecord(String(roomId));
  }
  if (code) {
    api.shareCode = (docUid) => {
      const uid = targetDocUid(deps, docUid);
      return uid ? bridge.editShareCode(uid) : null;
    };
  }
  if (join) {
    api.join = async (c, opts) => {
      if (joining) return 'failed';
      joining = true;
      try {
        return await bridge.join(String(c ?? '').trim(), opts?.intoDoc != null ? String(opts.intoDoc) : null);
      } finally {
        joining = false;
      }
    };
  }
  return Object.freeze(api);
}
