/**
 * Constants shared by every client that talks to the relay — the main
 * process (card sharing, `pairing-ipc.ts`) and the renderer (co-editing,
 * `collab/room-client.ts`) alike.
 *
 * Deliberately dependency-free: this module is imported into BOTH the
 * Electron main bundle and the renderer bundle, so it must not pull in
 * `getHost()`, the DOM, or anything Electron.
 */

/**
 * Header naming the CardMirror build behind a relay request.
 *
 * Sent on every relay call so the server can tell versions apart. It is
 * advisory only — relays that don't know the header ignore it, which is
 * why the client can start sending it well before any relay reads it.
 * Custom request headers are preflighted by browsers for the web
 * edition, but every relay implementation allows them (`allow_headers`
 * is the wildcard in all three), and the existing `Authorization`
 * header already proves that path works.
 *
 * NOTE for a future minimum-version gate: absence of this header means
 * the client predates it, NOT that the request is anonymous — every
 * build shipped before this header existed will send nothing at all.
 */
export const RELAY_CLIENT_VERSION_HEADER = 'X-CardMirror-Version';

/**
 * Header carrying this machine's routing code (the public sha256 hash of
 * its pairing key) on relay requests authenticated with an ENTITLEMENT.
 *
 * Entitlement JWTs are bearer tokens minted per machine (`/connect`
 * binds them to a routing code in their `rc` claim), but nothing at
 * request time proved the presenter WAS that machine — a copied token
 * file worked from anywhere. When the relay's machine-binding toggle is
 * on, gated requests must carry this header matching the token's claim.
 * Sent only when the effective bearer is an entitlement: shared-token
 * and self-hosted requests have no `rc` to match and omit it.
 */
export const RELAY_CLIENT_ROUTING_HEADER = 'X-CardMirror-Routing';

/**
 * First app version that seeds co-editing rooms with movable-list
 * children (identity-preserving moves; strict exactly-once under
 * concurrent same-card moves — fuzz-proven). The binding's per-room
 * inheritance keeps every room homogeneous, so this constant does two
 * jobs: builds >= it seed NEW rooms movable, and invites to movable
 * rooms carry it as their compatibility floor so older builds decline
 * cleanly instead of joining a room they cannot read.
 */
export const MOVABLE_ROOMS_MIN_VERSION = '1.0.0';

/**
 * Feature flags this BUILD carries (relay/FEDERATION.md §2.2): each
 * lowercase letter is an independent feature, appended to the version
 * as a final `-<letters>` segment — `1.15.0-f`. `f` = federation.
 * Separate from the numeric version on purpose: upstream bumps the
 * number, flags ride on top of whatever the number is.
 */
export const BUILD_VERSION_FLAGS = 'f';

const PRERELEASE_LABELS = new Set(['alpha', 'beta', 'rc']);

/** `'1.15.0-f'` → `{ core: '1.15.0', flags: 'f' }`. Flags are the final
 *  `-<letters>` segment unless it is a prerelease label; they never
 *  take part in ordering. Mirrors the relay's `split_version_flags`. */
export function splitVersionFlags(v: string): { core: string; flags: string } {
  const s = v.trim();
  const m = /^(.+)-([a-z]{1,8})$/.exec(s);
  if (m && !PRERELEASE_LABELS.has(m[2]!)) {
    return { core: m[1]!, flags: [...new Set(m[2]!)].sort().join('') };
  }
  return { core: s, flags: '' };
}

/** The numeric version normalized to `X.Y.Z[-pre]` — what every relay's
 *  version parser (old ones require three parts) understands. */
export function numericVersion(v: string): string {
  const { core } = splitVersionFlags(v);
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(core);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? '0'}${m[4] ?? ''}` : core;
}

/** This build's full version: numeric core + the build's flags (plus
 *  any flags the manifest version already carries). */
export function flaggedVersion(v: string): string {
  const flags = [...new Set(splitVersionFlags(v).flags + BUILD_VERSION_FLAGS)].sort().join('');
  return flags ? `${numericVersion(v)}-${flags}` : numericVersion(v);
}

/** The `X-CardMirror-Version` value for one relay: flags only when the
 *  relay lists `client.versionFlags` (federating relays); every other
 *  relay — old ones included — gets the plain numeric version its
 *  parser and minimum-version gate already understand. */
export function wireVersion(v: string, relayAcceptsFlags: boolean): string {
  return relayAcceptsFlags ? flaggedVersion(v) : numericVersion(v);
}

/**
 * Prerelease-aware version compare for CardMirror's version shapes
 * (`X.Y.Z`, `X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`, optionally with
 * feature flags `-f`, which are ignored). Returns <0, 0, >0.
 * A release outranks its own prereleases; unknown prerelease labels
 * rank with beta; unparseable strings rank lowest (a garbled version
 * must never unlock version-gated behavior).
 */
export function compareAppVersions(a: string, b: string): number {
  const key = (v: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(numericVersion(v));
    if (!m) return [-1, 0, 0, 0, 0, 0];
    const core = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!m[4]) return [...core, 1, 0, 0];
    const parts = m[4].split('.');
    const rank = { alpha: 0, beta: 1, rc: 2 }[parts[0]!.toLowerCase() as 'alpha'] ?? 1;
    const num = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
    return [...core, 0, rank, num];
  };
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < 6; i++) {
    if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
  }
  return 0;
}
