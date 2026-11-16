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
 * `FEDERATION_FLAG`, `canonRelayUrl`, `relayHost`, `CodePrefix`,
 * `parseCodePrefix` and `splitRelaySuffix` are VERBATIM copies from the
 * server-federation branch's src/editor/federation/address.ts (pinned by
 * tests/collab/server-address.test.ts with that branch's vectors). When
 * federation merges, re-export them from there instead of keeping two
 * copies.
 *
 * Dependency-free on purpose.
 */

/** Feature flag letter: the code names its home relay. */
export const FEDERATION_FLAG = 'f';

/** Canonical relay URL, or null when `raw` is not a usable relay URL:
 *  http(s) only; lowercased scheme + host; default port dropped; no
 *  userinfo, query, or fragment; `//` runs collapsed; no trailing `/`.
 *  Path case is kept. */
export function canonRelayUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 512 || /[\s\u0000-\u001f]/.test(s) || s.includes('@')) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return null;
  if ((m[4] && m[4].length > 1) || (m[5] && m[5].length > 1)) return null;
  const authority = m[2]!;
  let host: string;
  let portText: string;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return null;
    host = authority.slice(1, close).toLowerCase();
    const rest = authority.slice(close + 1);
    if (rest && !rest.startsWith(':')) return null;
    portText = rest.slice(1);
    if (!host) return null;
    host = `[${host}]`;
  } else {
    const colon = authority.lastIndexOf(':');
    host = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
    portText = colon >= 0 ? authority.slice(colon + 1) : '';
    if (!host) return null;
  }
  let port: number | null = null;
  if (portText) {
    if (!/^\d+$/.test(portText)) return null;
    port = Number(portText);
    if (port > 65535) return null;
  }
  const dflt = scheme === 'https' ? 443 : 80;
  const netloc = port === null || port === dflt ? host : `${host}:${port}`;
  const path = m[3]!.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return `${scheme}://${netloc}${path}`;
}

/** The URL's host (no port, brackets kept for IPv6) — what a label
 *  shows next to a nickname so one relay can't pose as another. */
export function relayHost(url: string): string {
  const m = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:]+)/.exec(url);
  return m ? m[1]! : url;
}



export interface CodePrefix {
  /** `cmview` is the spectator twin of `cmshare` (same room + key). */
  kind: 'cmk' | 'cmshare' | 'cmview';
  /** The format generation upstream bumps (`cmshare3`). */
  gen: number;
  /** Feature letters on top of the generation, sorted (`f`). */
  flags: string;
}

/** `cmshare2f` → {kind: 'cmshare', gen: 2, flags: 'f'}. Generation and
 *  flags are separate axes, so `cmshare3f` needs no new grammar. */
export function parseCodePrefix(prefix: string): CodePrefix | null {
  const m = /^(cmk|cmshare|cmview)(\d+)([a-z]*)$/.exec(prefix);
  if (!m) return null;
  const flags = [...new Set(m[3]!)].sort().join('');
  if (flags !== m[3]!) return null; // canonical spelling only: sorted, no repeats
  return { kind: m[1] as CodePrefix['kind'], gen: Number(m[2]), flags };
}

/** Split `body@relay-url` at the FIRST `@` (no code body can contain
 *  one). `relay` is the canonical URL, or null when absent; undefined
 *  when present but invalid. */
export function splitRelaySuffix(code: string): { body: string; relay: string | null | undefined } {
  const at = code.indexOf('@');
  if (at < 0) return { body: code, relay: null };
  return { body: code.slice(0, at), relay: canonRelayUrl(code.slice(at + 1)) ?? undefined };
}


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
