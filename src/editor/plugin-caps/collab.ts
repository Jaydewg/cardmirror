/** `collab.*` permissions → `api.collab` (host side: the bridge built in
 *  index.ts over collab-ui).
 *
 *  SERVERS AND SESSION ADDRESSES. A co-editing server is named by its
 *  canonical URL. A session ADDRESS is `<code>@<server URL>` — the same
 *  form on federated and non-federated builds. Addresses the api hands
 *  out always carry the plain code (no federation `f` flag); addresses it
 *  accepts may carry the flag or not. Plugins store and pass addresses;
 *  every method that takes a code also takes an address, and a plain
 *  code (no `@`) means "on your server". What changes between builds is
 *  only which servers are reachable (`reach`) and each session's
 *  `crossServer` state, never the surface.
 *
 *  CODES vs ADDRESSES. A code (`shareCode` / `viewCode`) is what a person
 *  pastes into this build's join box — show it to people. An address
 *  (`shareAddress` / `viewAddress`) is the portable machine form — store
 *  it and hand it back to the api. They can differ: on a federated build
 *  a session open to other servers has a code that already names its
 *  server (`cmshare2f.…@url`), while its address is always plain code +
 *  server.
 *
 *  GROWING UNIONS. Result types here (`PluginJoinOutcome`,
 *  `PluginProbeResult`, `PluginServerReach`, `PluginCrossServer`) may
 *  gain values in later builds; each documents how to read a value a
 *  plugin doesn't know. */
import { canonRelayUrl } from '../collab/server-address.js';
import { targetDocUid, type CapabilityContext } from './context.js';

/** How `api.collab.join` ended. May grow: treat a value you don't know
 *  as a failure. */
export type PluginJoinOutcome =
  | 'joined'
  | 'ended'
  | 'invalid'
  | 'needs-update'
  | 'cancelled'
  | 'unavailable'
  | 'failed'
  /** The session's server can't be reached from this build (e.g. a
   *  session on another server, on a build without federation). */
  | 'unreachable';

/** `<share-or-view code>@<canonical server URL>`. */
export type PluginSessionAddress = string;

/** A co-editing server. `url` is its identity; `nickname` is display
 *  only (never compare or trust it). */
export interface PluginServerInfo {
  url: string;
  /** Host part of `url` — show it next to any nickname. */
  host: string;
  nickname: string | null;
}

/** A code or address resolved to its session (no network). */
export interface PluginParsedAddress {
  /** The portable form, `<code>@<server>`. */
  address: PluginSessionAddress;
  /** The code without flags or server suffix. */
  code: string;
  roomId: string;
  /** Canonical server URL. */
  server: string;
  /** True for a view-only code. */
  view: boolean;
}

/** Whether this build can open sessions on a server:
 *  `home` — your own server; `federated` — another server this build
 *  reaches through federation; `unreachable` — no route from this build;
 *  `unknown` — can't tell (no server configured, offline). May grow:
 *  treat a value you don't know as `unknown`. */
export type PluginServerReach = 'home' | 'federated' | 'unreachable' | 'unknown';

/** Whether a live session is open to people on other servers:
 *  `federated` — yes; its codes name its server (`…f.…@url`);
 *  `off` — this build supports it, but this session stays on your server;
 *  `unsupported` — this build has no cross-server sessions.
 *  May grow: treat a value you don't know as `off` (don't assume people
 *  on other servers can join). */
export type PluginCrossServer = 'federated' | 'off' | 'unsupported';

/** A live session's public facts — never its key. */
export interface PluginSessionInfo {
  roomId: string;
  role: 'host' | 'participant' | 'spectator';
  /** The session's published title, when known. */
  title: string | null;
  /** Canonical URL of the session's server. Filled in only with
   *  `collab.server`; null otherwise or when unknown. */
  server: string | null;
  /** Whether people on other servers can join this session. */
  crossServer: PluginCrossServer;
}

/** Whether a share code's session still exists (`collab.probe`).
 *  `unreachable`: it's on a server this build can't reach, so liveness
 *  can't be checked — NOT a sign that it ended. May grow: treat a value
 *  you don't know as `unknown`. */
export type PluginProbeResult = 'live' | 'ended' | 'unknown' | 'unreachable';

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
 *  `collab.server` → server / reach / parseAddress (and `server` on
 *  `current()`); `collab.probe` → probe; `collab.shareCode` → shareCode /
 *  shareAddress; `collab.viewCode` → viewCode / viewAddress;
 *  `collab.join` → join. */
export interface PluginCollabApi {
  /** The live session of a doc (default: the focused doc), or null. */
  current?(docUid?: string): PluginSessionInfo | null;
  /** Room id inside a code or address (no network), or null if malformed. */
  roomIdOf?(codeOrAddress: string): string | null;
  /** This machine's record of the room, or null if it was never in it.
   *  (Joining a room with a record resumes it, keeping unsent edits.) */
  localRecord?(roomId: string): Promise<PluginLocalSessionRecord | null>;
  /** This machine's co-editing server, or null when none is configured. */
  server?(): Promise<PluginServerInfo | null>;
  /** Can this build open sessions on `serverUrl`? */
  reach?(serverUrl: string): Promise<PluginServerReach>;
  /** Resolve a code or address (a plain code → your server). Null when
   *  malformed, or when a plain code meets no configured server. */
  parseAddress?(codeOrAddress: string): Promise<PluginParsedAddress | null>;
  /** Ask the session's server whether the session behind a code or
   *  address still exists, without joining it or showing you as present.
   *  `unknown` when it can't tell; `unreachable` for a server this build
   *  can't reach. Results are cached per session for a minute. */
  probe?(codeOrAddress: string): Promise<PluginProbeResult>;
  /** The EDIT share code of a doc's live session (default: focused doc):
   *  what a person pastes to join on this build. Null without a session
   *  or in a spectator seat. Synchronous, so a `files.onSave` hook can use
   *  it. Store `shareAddress` instead. */
  shareCode?(docUid?: string): string | null;
  /** The EDIT session address (`code@server`) of a doc's live session;
   *  null as for `shareCode`, or when the server is unknown. Synchronous.
   *  An address names its server. */
  shareAddress?(docUid?: string): PluginSessionAddress | null;
  /** The VIEW-ONLY code of a doc's live session — holders can watch, not
   *  edit: what a person pastes to watch on this build. Null without a
   *  session. */
  viewCode?(docUid?: string): string | null;
  /** The VIEW-ONLY session address of a doc's live session. Null without
   *  a session or a known server. */
  viewAddress?(docUid?: string): PluginSessionAddress | null;
  /** Join from a code or address. `intoDoc`: a clean doc (by session uid)
   *  the session replaces while keeping its file, so saving writes the
   *  live copy back; omitted — or no longer open — → a new session doc.
   *  Only one join per plugin at a time. */
  join?(codeOrAddress: string, opts?: { intoDoc?: string }): Promise<PluginJoinOutcome>;
}

/** Host side of `collab.*` (implemented in the editor, which owns the
 *  lazily loaded collab module). The optional members are optional so
 *  older test doubles keep compiling; a missing one hides its method. */
export interface PluginCollabBridge {
  /** Session facts, `server` included (the api strips it without
   *  `collab.server`). A missing or unknown `crossServer` reads as
   *  `'off'` — never a claim that other servers can join. */
  sessionInfo(docUid: string): PluginSessionInfo | null;
  editShareCode(docUid: string): string | null;
  editAddress?(docUid: string): string | null;
  viewCode?(docUid: string): string | null;
  viewAddress?(docUid: string): string | null;
  localRecord(roomId: string): Promise<PluginLocalSessionRecord | null>;
  server?(): Promise<PluginServerInfo | null>;
  reach?(serverUrl: string): Promise<PluginServerReach>;
  parseAddress?(raw: string): Promise<PluginParsedAddress | null>;
  probe?(codeOrAddress: string): Promise<PluginProbeResult>;
  join(codeOrAddress: string, intoDocUid: string | null): Promise<PluginJoinOutcome>;
}

/** Room id from a share code or address, any generation / flag letters
 *  (`cmshare2f.<room>.<key>.<ver>@home` included). */
const SHARE_CODE_ROOM_RE = /^(?:cmshare|cmview)\d+[a-z]*\.([0-9a-f]{16,64})\./;
export const PROBE_CACHE_MS = 60_000;

const PROBE_RESULTS: ReadonlySet<string> = new Set(['live', 'ended', 'unknown', 'unreachable']);
const REACH_RESULTS: ReadonlySet<string> = new Set(['home', 'federated', 'unreachable', 'unknown']);
const CROSS_SERVER: ReadonlySet<string> = new Set(['federated', 'off', 'unsupported']);

/** Cache key for a probe: the session, as far as it can be named
 *  without the network (a plain code's server is "self"; an invalid
 *  server keys on its raw text, which only ever misses). */
function probeKey(trimmed: string, roomId: string): string {
  const at = trimmed.indexOf('@');
  if (at < 0) return `|${roomId}`;
  const raw = trimmed.slice(at + 1);
  return `${canonRelayUrl(raw) ?? `?${raw}`}|${roomId}`;
}

export function buildCollabApi(ctx: CapabilityContext): PluginCollabApi | undefined {
  const { deps, granted } = ctx;
  const bridge = deps.collab;
  const read = granted.has('collab.read');
  const server = granted.has('collab.server');
  const code = granted.has('collab.shareCode');
  const view =
    granted.has('collab.viewCode') &&
    (typeof bridge?.viewCode === 'function' || typeof bridge?.viewAddress === 'function');
  const join = granted.has('collab.join');
  const probe = granted.has('collab.probe') && typeof bridge?.probe === 'function';
  if (!bridge || !(read || server || code || view || join || probe)) return undefined;
  let joining = false;
  const api: PluginCollabApi = {};
  if (read) {
    api.current = (docUid) => {
      const uid = targetDocUid(deps, docUid);
      const info = uid ? bridge.sessionInfo(uid) : null;
      if (!info) return null;
      return {
        roomId: info.roomId,
        role: info.role,
        title: info.title,
        server: server ? info.server ?? null : null,
        crossServer: CROSS_SERVER.has(info.crossServer) ? info.crossServer : 'off',
      };
    };
    api.roomIdOf = (c) => SHARE_CODE_ROOM_RE.exec(String(c ?? '').trim())?.[1] ?? null;
    api.localRecord = (roomId) => bridge.localRecord(String(roomId));
  }
  if (server) {
    if (bridge.server) {
      const get = bridge.server.bind(bridge);
      api.server = async () => {
        const s = await get().catch(() => null);
        return s ? { url: s.url, host: s.host, nickname: s.nickname ?? null } : null;
      };
    }
    if (bridge.reach) {
      const get = bridge.reach.bind(bridge);
      api.reach = async (url) => {
        const r = await get(String(url ?? '')).catch((): PluginServerReach => 'unknown');
        return REACH_RESULTS.has(r) ? r : 'unknown';
      };
    }
    if (bridge.parseAddress) {
      const get = bridge.parseAddress.bind(bridge);
      api.parseAddress = async (raw) => {
        const p = await get(String(raw ?? '')).catch(() => null);
        return p ? { address: p.address, code: p.code, roomId: p.roomId, server: p.server, view: p.view } : null;
      };
    }
  }
  if (probe) {
    // Per api object (so per plugin, reset on re-mint): one request in
    // flight per session, answers reused for PROBE_CACHE_MS — a burst of
    // opens can't hammer a server.
    const cache = new Map<string, { at: number; result: PluginProbeResult }>();
    const inFlight = new Map<string, Promise<PluginProbeResult>>();
    api.probe = (c) => {
      const trimmed = String(c ?? '').trim();
      const roomId = SHARE_CODE_ROOM_RE.exec(trimmed)?.[1];
      if (!roomId) return Promise.resolve('unknown');
      const key = probeKey(trimmed, roomId);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return Promise.resolve(hit.result);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const run = bridge.probe!(trimmed)
        .catch((): PluginProbeResult => 'unknown')
        .then((result) => {
          const clean: PluginProbeResult = PROBE_RESULTS.has(result) ? result : 'unknown';
          // Don't pin a transient failure for a whole minute.
          if (clean !== 'unknown') cache.set(key, { at: Date.now(), result: clean });
          return clean;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, run);
      return run;
    };
  }
  if (code) {
    api.shareCode = (docUid) => {
      const uid = targetDocUid(deps, docUid);
      return uid ? bridge.editShareCode(uid) : null;
    };
    if (bridge.editAddress) {
      const get = bridge.editAddress.bind(bridge);
      api.shareAddress = (docUid) => {
        const uid = targetDocUid(deps, docUid);
        return uid ? get(uid) : null;
      };
    }
  }
  if (view) {
    if (bridge.viewCode) {
      const get = bridge.viewCode.bind(bridge);
      api.viewCode = (docUid) => {
        const uid = targetDocUid(deps, docUid);
        return uid ? get(uid) : null;
      };
    }
    if (bridge.viewAddress) {
      const get = bridge.viewAddress.bind(bridge);
      api.viewAddress = (docUid) => {
        const uid = targetDocUid(deps, docUid);
        return uid ? get(uid) : null;
      };
    }
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
