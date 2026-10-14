/**
 * What the app's OWN relay supports, read from `GET /relay/capabilities`
 * (relay/FEDERATION.md §3) and cached per relay URL.
 *
 * This is the forward-compatibility switch: every federation surface
 * asks `federationFor(base)` first, and an older relay — no
 * capabilities endpoint, or no `federation` block — yields null, which
 * means "behave exactly like a build without federation". The same
 * document says whether the relay reads version flags
 * (`client.versionFlags`); relays that don't get the plain numeric
 * version (see relay-protocol.ts `wireVersion`).
 *
 * Dependency-free (fetch only) so the transport layers can import it.
 */

import { canonRelayUrl } from './address.js';

export interface RelayFederation {
  /** The relay's canonical identity URL (its own claim, canonicalized). */
  url: string;
  /** Display only — never trusted, compared, or routed on. */
  nickname: string | null;
  mailbox: boolean;
  rooms: boolean;
  joinRequests: boolean;
}

interface Entry {
  at: number;
  fed: RelayFederation | null;
  versionFlags: boolean;
  /** The last fetch got an answer from the relay (any HTTP status a relay
   *  gives — 200/304/404); false after a network failure; null = unknown. */
  reachable: boolean | null;
  /** Settled at least once (a failed fetch still settles: "unknown"
   *  reads as "no federation" until a later refresh succeeds). */
  settled: boolean;
  inflight: Promise<void> | null;
}

const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function keyOf(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

function parse(doc: unknown): { fed: RelayFederation | null; versionFlags: boolean } {
  if (!doc || typeof doc !== 'object') return { fed: null, versionFlags: false };
  const d = doc as { features?: Record<string, unknown>; federation?: Record<string, unknown> };
  const features = d.features && typeof d.features === 'object' ? d.features : {};
  const versionFlags = 'client.versionFlags' in features;
  const block = d.federation;
  const url = block && typeof block === 'object' ? canonRelayUrl(block['url']) : null;
  const protocol = block && typeof block === 'object' ? block['protocol'] : undefined;
  if (!url || typeof protocol !== 'number' || protocol < 1) return { fed: null, versionFlags };
  const nick = typeof block!['nickname'] === 'string' ? (block!['nickname'] as string).trim().slice(0, 48) : '';
  return {
    versionFlags,
    fed: {
      url,
      nickname: nick || null,
      mailbox: 'federation.mailbox' in features,
      rooms: 'federation.rooms' in features,
      joinRequests: 'federation.joinRequests' in features,
    },
  };
}

/** Fetch (or reuse) the capabilities of the relay at `base`. Never
 *  throws; resolves once the cache entry has settled. */
export function ensureRelayCapabilities(
  base: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const k = keyOf(base);
  if (!k) return Promise.resolve();
  const now = Date.now();
  const cur = cache.get(k);
  if (cur?.inflight) return cur.inflight;
  if (cur && !opts.force && now - cur.at < (cur.reachable ? FRESH_MS : RETRY_MS)) {
    return Promise.resolve();
  }
  const fetchImpl = opts.fetchImpl ?? ((i: RequestInfo | URL, n?: RequestInit) => fetch(i, n));
  const entry: Entry = cur ?? { at: 0, fed: null, versionFlags: false, reachable: null, settled: false, inflight: null };
  cache.set(k, entry);
  const run = (async () => {
    let next = { fed: entry.fed, versionFlags: entry.versionFlags };
    let reachable = false;
    try {
      const res = await fetchImpl(`${k}/capabilities`, {
        // The relay serves this with max-age=300; without revalidating,
        // the HTTP cache answered for 5 minutes and an operator's change
        // (nickname, federation on/off) didn't show. `no-cache` still
        // uses the ETag, so an unchanged document is a bodyless 304.
        cache: 'no-cache',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
      });
      reachable = res.ok || res.status === 404 || res.status === 304;
      if (res.ok) next = parse(await res.json());
      else if (res.status === 404) next = { fed: null, versionFlags: false }; // pre-capabilities relay
    } catch {
      /* unreachable: keep the last known answer */
    }
    // Any field counts (nickname and feature flags included — a nickname
    // change used to leave the Settings line stale forever).
    const changed =
      JSON.stringify(next.fed) !== JSON.stringify(entry.fed) ||
      next.versionFlags !== entry.versionFlags ||
      reachable !== entry.reachable;
    entry.reachable = reachable;
    entry.fed = next.fed;
    entry.versionFlags = next.versionFlags;
    entry.at = Date.now();
    entry.settled = true;
    entry.inflight = null;
    if (changed) for (const fn of listeners) fn();
  })();
  entry.inflight = run;
  return run;
}

/** Synchronous view of the cache: the relay's federation block, or
 *  null (doesn't federate, or not known yet). */
export function federationFor(base: string): RelayFederation | null {
  return cache.get(keyOf(base))?.fed ?? null;
}

/** Whether the relay at `base` answered its last capabilities fetch
 *  (null before the first one settles). */
export function relayReachable(base: string): boolean | null {
  return cache.get(keyOf(base))?.reachable ?? null;
}

/** Whether the relay at `base` reads version flags (see wireVersion). */
export function acceptsVersionFlags(base: string): boolean {
  return cache.get(keyOf(base))?.versionFlags ?? false;
}

/** Called whenever a relay's federation answer changes (UI refresh). */
export function onRelayCapabilitiesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only. */
export function __resetRelayCapabilitiesForTests(): void {
  cache.clear();
  listeners.clear();
}
