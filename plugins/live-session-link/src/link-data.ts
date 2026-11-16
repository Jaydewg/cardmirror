/**
 * The payload Live Session Link keeps in a `.cmir` (its `files.data`
 * entry). Files travel between people, so everything read back is
 * UNTRUSTED: `parseLinkData` accepts only the exact shape below and
 * returns null for anything else (ignored silently).
 *
 * A session is named by its SESSION ADDRESS, `<code>@<server URL>` —
 * the plugin API's portable form, identical on federated and
 * non-federated CardMirror builds (the code may carry the federation
 * `f` flag or not). The same room id on two servers is two sessions, so
 * everything this plugin remembers is keyed by `sessionKey`.
 */

/** 2: session address + server. (1 was an unreleased prototype shape
 *  that stored the bare code; it is ignored like any other junk.) */
export const LINK_DATA_VERSION = 2;
/** Code + `@` + a server URL of up to 512 chars, with room to spare. */
export const ADDRESS_MAX = 1024;
export const SERVER_MAX = 512;
export const TITLE_MAX = 200;

export interface LinkData {
  v: typeof LINK_DATA_VERSION;
  /** The session's EDIT address, `<code>@<server>`. */
  address: string;
  /** Room id inside `address` (kept for quick matching). */
  roomId: string;
  /** Server URL inside `address`, as CardMirror canonicalized it. */
  server: string;
  /** Session title when it was embedded. Display only. */
  title: string;
  /** ms since epoch. */
  embeddedAt: number;
}

/** Room id from a share code or address, any generation / flag letters
 *  — the same shape the host's `collab.roomIdOf` accepts, duplicated
 *  here so parsing needs no permission. */
const SHARE_CODE_ROOM_RE = /^(?:cmshare|cmview)\d+[a-z]*\.([0-9a-f]{16,64})\./;

/** `<kind><gen><flags>.<room>.<rest>@<server>`; flags: none, or the
 *  federation `f` (any other feature letter is one this plugin can't
 *  vouch for). */
const ADDRESS_RE = /^(cmshare|cmview)(\d+)(f?)\.([0-9a-f]{16,64})\.([A-Za-z0-9_.-]+)@(https?:\/\/[^\s@]+)$/;

export function roomIdOfCode(code: string): string | null {
  return SHARE_CODE_ROOM_RE.exec(code.trim())?.[1] ?? null;
}

export interface AddressParts {
  address: string;
  roomId: string;
  server: string;
  /** False for a view-only address. */
  edit: boolean;
  /** The code without the `f` flag or server: what a CardMirror build
   *  from before session addresses can decode. */
  plainCode: string;
}

/** Split an address. Shape only — CardMirror validates the rest. */
export function addressParts(raw: unknown): AddressParts | null {
  if (typeof raw !== 'string' || raw.length > ADDRESS_MAX) return null;
  const m = ADDRESS_RE.exec(raw);
  if (!m) return null;
  const server = m[6]!;
  // eslint-disable-next-line no-control-regex
  if (server.length > SERVER_MAX || /[\u0000-\u001f\u007f]/.test(server)) return null;
  return {
    address: raw,
    roomId: m[4]!,
    server,
    edit: m[1] === 'cmshare',
    plainCode: `${m[1]}${m[2]}.${m[4]}.${m[5]}`,
  };
}

/** What this plugin remembers a session by: room AND server. */
export function sessionKey(roomId: string, server: string): string {
  return `${roomId}@${server}`;
}

export function linkKey(link: LinkData): string {
  return sessionKey(link.roomId, link.server);
}

function clipTitle(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}

/** Only EDIT addresses are embedded; a view address would make "Join" a
 *  read-only seat, which is not what the file promises. */
export function makeLinkData(address: string, title: string | null, embeddedAt: number): LinkData | null {
  const parts = addressParts(address.trim());
  if (!parts || !parts.edit) return null;
  return {
    v: LINK_DATA_VERSION,
    address: parts.address,
    roomId: parts.roomId,
    server: parts.server,
    title: clipTitle(title),
    embeddedAt,
  };
}

export function parseLinkData(raw: unknown): LinkData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== LINK_DATA_VERSION) return null;
  const parts = addressParts(r['address']);
  if (!parts || !parts.edit) return null;
  if (r['roomId'] !== parts.roomId || r['server'] !== parts.server) return null;
  const at = r['embeddedAt'];
  return {
    v: LINK_DATA_VERSION,
    address: parts.address,
    roomId: parts.roomId,
    server: parts.server,
    title: clipTitle(r['title']),
    embeddedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0,
  };
}

/** Host part of a server URL, for messages. */
export function serverHost(server: string): string {
  const m = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(server);
  return m ? m[1]!.toLowerCase() : server;
}
