/**
 * Server addressing for co-editing sessions: one surface for federated
 * and non-federated builds.
 *
 * A server IS its canonical URL (`canonRelayUrl`): two URLs name the same
 * server iff they canonicalize to the same string. A nickname is display
 * data only.
 *
 * A SESSION ADDRESS is `<share-or-view code>@<canonical server URL>`. It
 * is the plugin-facing name of a session and reads the same on every
 * build: the code may or may not carry the federation `f` flag
 * (`cmshare2.…@url` and `cmshare2f.…@url` name the same session), and a
 * plain code with no `@` belongs to the reader's own server. Each build
 * translates an address into whatever its wire format needs; plugins
 * never branch on federation.
 *
 * The URL and code-prefix grammar (`FEDERATION_FLAG`, `canonRelayUrl`,
 * `relayHost`, `CodePrefix`, `parseCodePrefix`, `splitRelaySuffix`) is
 * federation's own (src/editor/federation/address.ts), re-exported here
 * so the plugin API and federation can never disagree on what names a
 * server.
 *
 * Dependency-free on purpose (address.ts is too).
 */

import {
  FEDERATION_FLAG,
  canonRelayUrl,
  parseCodePrefix,
  relayHost,
  splitRelaySuffix,
  type CodePrefix,
} from '../federation/address.js';

export { FEDERATION_FLAG, canonRelayUrl, parseCodePrefix, relayHost, splitRelaySuffix, type CodePrefix };

// ── Session addresses ──

/** A share/view code resolved to its server, with the federation flag
 *  normalized away (`code` is what a non-federated build can decode). */
export interface ParsedSessionAddress {
  /** `<code>@<server>`: the portable form. */
  address: string;
  /** The code without flags or suffix (`cmshare2.<room>.<key>.<ver>`). */
  code: string;
  roomId: string;
  /** Canonical server URL. */
  server: string;
  /** True for a view-only (`cmview`) code. */
  view: boolean;
}

const ROOM_ID_RE = /^[0-9a-f]{16,64}$/;
const KEY_PART_RE = /^[A-Za-z0-9_-]+$/;
export const SESSION_ADDRESS_MAX = 1024;

/**
 * Parse a plain code, `code@server`, or federated `fcode@server` into a
 * session address. `selfServer` (canonical, or null when unknown) is the
 * server a plain code belongs to. Null for: no resolvable server, an `f`
 * code without a server, an unknown feature flag, a pairing (`cmk`)
 * code, or a malformed code. Shape only: the key is not decoded here.
 */
export function parseSessionAddress(raw: unknown, selfServer: string | null): ParsedSessionAddress | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, '');
  if (!s || s.length > SESSION_ADDRESS_MAX) return null;
  const { body, relay } = splitRelaySuffix(s);
  if (relay === undefined) return null;
  const parts = body.split('.');
  const prefix = parseCodePrefix(parts[0] ?? '');
  if (!prefix || prefix.kind === 'cmk') return null;
  if (prefix.flags !== '' && prefix.flags !== FEDERATION_FLAG) return null;
  if (prefix.flags === FEDERATION_FLAG && relay === null) return null;
  if (parts.length < 3 || !ROOM_ID_RE.test(parts[1]!) || !KEY_PART_RE.test(parts[2]!)) return null;
  const server = relay ?? (selfServer ? canonRelayUrl(selfServer) : null);
  if (!server) return null;
  const code = [`${prefix.kind}${prefix.gen}`, ...parts.slice(1)].join('.');
  return {
    address: `${code}@${server}`,
    code,
    roomId: parts[1]!,
    server,
    view: prefix.kind === 'cmview',
  };
}

/** `code` (plain, as this build mints it) at `server` → its address, or
 *  null when either part is unusable. */
export function formatSessionAddress(code: string, server: string | null): string | null {
  return parseSessionAddress(code, server)?.address ?? null;
}
