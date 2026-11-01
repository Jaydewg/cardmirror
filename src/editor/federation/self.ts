/**
 * "My relay", federation-wise: the renderer's view of whether the
 * relay this app is configured with federates, and under what identity.
 *
 * Every federation surface reads `ownRelayFederation()` — null means
 * the relay is older or has federation off, and the surface behaves as
 * a build without federation would.
 */

import { ensureBakedRelay, relayBaseUrl } from '../collab/collab-relay.js';
import { settings } from '../settings.js';
import { formatPairingCode, parsePairingCode } from './address.js';
import {
  acceptsVersionFlags,
  ensureRelayCapabilities,
  federationFor,
  type RelayFederation,
} from './relay-capabilities.js';

export function ownRelayFederation(): RelayFederation | null {
  const base = relayBaseUrl();
  return base ? federationFor(base) : null;
}

/** This relay's canonical identity URL when it federates, else null. */
export function selfRelayUrl(): string | null {
  return ownRelayFederation()?.url ?? null;
}

/** Whether to send version flags to this app's relay. */
export function ownRelayAcceptsVersionFlags(): boolean {
  const base = relayBaseUrl();
  return base ? acceptsVersionFlags(base) : false;
}

/** (Re)read the own relay's capabilities. Safe to call often. */
export async function refreshOwnRelayFederation(force = false): Promise<RelayFederation | null> {
  await ensureBakedRelay();
  const base = relayBaseUrl();
  if (base) await ensureRelayCapabilities(base, { force });
  return ownRelayFederation();
}

/** The cross-server form of this machine's pairing code
 *  (`cmk1f.<key>@<relay>`), or null when the relay doesn't federate. */
export function ownCrossServerCode(plainCode: string): string | null {
  const self = selfRelayUrl();
  const a = parsePairingCode(plainCode);
  return self && a ? formatPairingCode(a.key, self) : null;
}

let wired = false;
/** Keep the cache current: once now, and whenever the relay settings
 *  change (a different relay may answer differently). */
export function wireOwnRelayFederation(): void {
  if (wired) return;
  wired = true;
  void refreshOwnRelayFederation();
  let last = `${settings.get('pairingRelayUrl')}\n${settings.get('pairingRelayToken')}`;
  settings.subscribe((s) => {
    const now = `${s.pairingRelayUrl}\n${s.pairingRelayToken}`;
    if (now === last) return;
    last = now;
    void refreshOwnRelayFederation(true);
  });
}
