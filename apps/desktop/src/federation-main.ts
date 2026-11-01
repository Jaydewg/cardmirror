/**
 * Federation helpers for the main process (card sharing runs here).
 *
 * MIRRORS src/editor/federation/address.ts and the version-flag helpers
 * in src/editor/relay-protocol.ts: this tsc's rootDir excludes src/, so
 * a value import from there would break the desktop build (see the
 * header constants in pairing-ipc.ts). Parity is pinned by
 * tests/federation/address.test.ts — change both or neither.
 *
 * Plus the main-process copy of the own-relay capabilities cache
 * (relay/FEDERATION.md §3): whether the relay federates (and as what
 * URL), and whether it reads version flags.
 */

const FEDERATION_FLAG = 'f';
const BUILD_VERSION_FLAGS = 'f';
/** The update channel this build follows, or null for electron-updater's
 *  default. Federation builds (`f`) take only later `-f` releases: the
 *  release feed also carries stable builds without federation, and a
 *  1.15.0-f install (numeric manifest, default channel) was silently
 *  replaced by stable 1.16.1 (field find, 2026-10-26). */
export const UPDATE_CHANNEL: string | null = BUILD_VERSION_FLAGS.includes(FEDERATION_FLAG)
  ? FEDERATION_FLAG
  : null;
const PRERELEASE_LABELS = new Set(['alpha', 'beta', 'rc']);

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

export interface PairingAddress {
  key: string;
  relay: string | null;
}

export function parsePairingCode(raw: string): PairingAddress | null {
  const code = raw.trim().replace(/\s+/g, '');
  const at = code.indexOf('@');
  const body = at < 0 ? code : code.slice(0, at);
  const relay = at < 0 ? null : (canonRelayUrl(code.slice(at + 1)) ?? undefined);
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  const pm = /^(cmk)(\d+)([a-z]*)$/.exec(body.slice(0, dot));
  const payload = body.slice(dot + 1);
  if (!pm || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const flags = pm[3]!;
  if (flags === '') return relay === null ? { key: `cmk${pm[2]}.${payload}`, relay: null } : null;
  if (flags === FEDERATION_FLAG && typeof relay === 'string') return { key: `cmk${pm[2]}.${payload}`, relay };
  return null;
}

export function formatPairingCode(key: string, relay: string | null): string {
  if (!relay) return key;
  const dot = key.indexOf('.');
  return `${key.slice(0, dot)}${FEDERATION_FLAG}${key.slice(dot)}@${relay}`;
}

export function splitVersionFlags(v: string): { core: string; flags: string } {
  const s = v.trim();
  const m = /^(.+)-([a-z]{1,8})$/.exec(s);
  if (m && !PRERELEASE_LABELS.has(m[2]!)) return { core: m[1]!, flags: [...new Set(m[2]!)].sort().join('') };
  return { core: s, flags: '' };
}

export function numericVersion(v: string): string {
  const { core } = splitVersionFlags(v);
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(core);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? '0'}${m[4] ?? ''}` : core;
}

export function flaggedVersion(v: string): string {
  const flags = [...new Set(splitVersionFlags(v).flags + BUILD_VERSION_FLAGS)].sort().join('');
  return flags ? `${numericVersion(v)}-${flags}` : numericVersion(v);
}

export function wireVersion(v: string, relayAcceptsFlags: boolean): string {
  return relayAcceptsFlags ? flaggedVersion(v) : numericVersion(v);
}

// ── Own-relay capabilities (main process) ──

export interface MainRelayFederation {
  url: string;
  mailbox: boolean;
}

interface CapsEntry {
  at: number;
  fed: MainRelayFederation | null;
  versionFlags: boolean;
  inflight: Promise<void> | null;
}

const caps = new Map<string, CapsEntry>();

/** Refresh (at most every 5 min; 30 s after a miss) the capabilities
 *  of the relay at `base`. Never throws. */
export function ensureMainRelayCaps(base: string, force = false): Promise<void> {
  const k = base.replace(/\/+$/, '');
  if (!k) return Promise.resolve();
  const cur = caps.get(k);
  if (cur?.inflight) return cur.inflight;
  const fresh = cur && Date.now() - cur.at < (cur.fed || cur.versionFlags ? 300_000 : 30_000);
  if (fresh && !force) return Promise.resolve();
  const entry: CapsEntry = cur ?? { at: 0, fed: null, versionFlags: false, inflight: null };
  caps.set(k, entry);
  entry.inflight = (async () => {
    try {
      const res = await fetch(`${k}/capabilities`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const doc = (await res.json()) as {
          features?: Record<string, unknown>;
          federation?: { url?: unknown; protocol?: unknown };
        };
        const features = doc?.features && typeof doc.features === 'object' ? doc.features : {};
        const url = canonRelayUrl(doc?.federation?.url);
        const protocol = doc?.federation?.protocol;
        entry.versionFlags = 'client.versionFlags' in features;
        entry.fed =
          url && typeof protocol === 'number' && protocol >= 1
            ? { url, mailbox: 'federation.mailbox' in features }
            : null;
      } else if (res.status === 404) {
        entry.fed = null;
        entry.versionFlags = false;
      }
    } catch {
      /* unreachable: keep the last answer */
    }
    entry.at = Date.now();
    entry.inflight = null;
  })();
  return entry.inflight;
}

export function mainRelayFederation(base: string): MainRelayFederation | null {
  return caps.get(base.replace(/\/+$/, ''))?.fed ?? null;
}

export function mainRelayAcceptsFlags(base: string): boolean {
  return caps.get(base.replace(/\/+$/, ''))?.versionFlags ?? false;
}

/** Tests only. */
export function __resetMainRelayCapsForTests(): void {
  caps.clear();
}
