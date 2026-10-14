/**
 * Federation addressing (relay/FEDERATION.md §1–2): relay identity,
 * feature-flagged code prefixes, and the cross-server pairing code.
 *
 * Dependency-free on purpose — imported by the renderer's pairing and
 * collab layers alike, and mirrored by the desktop main process
 * (apps/desktop/src/federation-main.ts; parity pinned by
 * tests/federation/address.test.ts).
 *
 * A relay IS its canonical URL: two URLs name the same relay iff
 * `canonRelayUrl` maps them to the same string (the relay's `canon_url`
 * applies the identical rules). A nickname is display data only — it is
 * never compared, stored as identity, or used to route.
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

/** "Nickname (host)" when the relay has a nickname, else the host. */
export function relayLabel(url: string, nickname?: string | null): string {
  const host = relayHost(url);
  const nick = (nickname ?? '').trim();
  return nick && nick.toLowerCase() !== host ? `${nick} (${host})` : host;
}

/** base64url (no padding) of the canonical URL — the `{home64}` path
 *  segment of the federation proxy routes. */
export function relayHome64(url: string): string {
  const bytes = new TextEncoder().encode(url);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CodePrefix {
  kind: 'cmk' | 'cmshare';
  /** The format generation upstream bumps (`cmshare3`). */
  gen: number;
  /** Feature letters on top of the generation, sorted (`f`). */
  flags: string;
}

/** `cmshare2f` → {kind: 'cmshare', gen: 2, flags: 'f'}. Generation and
 *  flags are separate axes, so `cmshare3f` needs no new grammar. */
export function parseCodePrefix(prefix: string): CodePrefix | null {
  const m = /^(cmk|cmshare)(\d+)([a-z]*)$/.exec(prefix);
  if (!m) return null;
  const flags = [...new Set(m[3]!)].sort().join('');
  if (flags !== m[3]!) return null; // canonical spelling only: sorted, no repeats
  return { kind: m[1] as 'cmk' | 'cmshare', gen: Number(m[2]), flags };
}

/** Split `body@relay-url` at the FIRST `@` (no code body can contain
 *  one). `relay` is the canonical URL, or null when absent; undefined
 *  when present but invalid. */
export function splitRelaySuffix(code: string): { body: string; relay: string | null | undefined } {
  const at = code.indexOf('@');
  if (at < 0) return { body: code, relay: null };
  return { body: code.slice(0, at), relay: canonRelayUrl(code.slice(at + 1)) ?? undefined };
}

// ── Pairing codes ──

export interface PairingAddress {
  /** The plain key code `cmk1.<base64url X25519 key>` — what sealing
   *  and the routing id derive from. */
  key: string;
  /** Canonical home relay; null = "the reader's own relay". */
  relay: string | null;
}

/** Parse `cmk1.<key>` or `cmk1f.<key>@<relay-url>`. Null for anything
 *  else (unknown flags included — a future feature this build cannot
 *  honor must not be silently dropped). */
export function parsePairingCode(raw: string): PairingAddress | null {
  const code = raw.trim().replace(/\s+/g, '');
  const { body, relay } = splitRelaySuffix(code);
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  const prefix = parseCodePrefix(body.slice(0, dot));
  const payload = body.slice(dot + 1);
  if (!prefix || prefix.kind !== 'cmk' || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  if (prefix.flags === '') {
    return relay === null ? { key: `cmk${prefix.gen}.${payload}`, relay: null } : null;
  }
  if (prefix.flags === FEDERATION_FLAG && typeof relay === 'string') {
    return { key: `cmk${prefix.gen}.${payload}`, relay };
  }
  return null;
}

/** The shareable form: plain when `relay` is null, else `cmk1f.…@url`. */
export function formatPairingCode(key: string, relay: string | null): string {
  if (!relay) return key;
  const dot = key.indexOf('.');
  return `${key.slice(0, dot)}${FEDERATION_FLAG}${key.slice(dot)}@${relay}`;
}

/** Where a code's owner receives mail, relative to this reader: null =
 *  this reader's own relay. */
export function pairingHome(code: string, selfRelay: string | null): string | null {
  const a = parsePairingCode(code);
  if (!a || !a.relay || a.relay === selfRelay) return null;
  return a.relay;
}

/** Normal form for COMPARING codes: a person is their key on a relay
 *  (key + relay — the same key on another relay is someone new, by
 *  design). A code qualified with the reader's own relay is the same
 *  person as the plain code. Unparseable input passes through
 *  whitespace-stripped, preserving today's lenient comparisons. */
export function pairingIdentity(code: string, selfRelay: string | null): string {
  const a = parsePairingCode(code);
  if (!a) return code.trim().replace(/\s+/g, '');
  return a.relay && a.relay !== selfRelay ? formatPairingCode(a.key, a.relay) : a.key;
}
