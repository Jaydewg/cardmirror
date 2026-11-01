/**
 * Pairing identifiers.
 *
 * A machine's shareable pairing CODE is its X25519 public key, minted
 * and held by the main process (see apps/desktop/src/pairing-crypto.ts) — not
 * generated here. This module only provides local group ids and code
 * normalization for the settings UI.
 */

import { pairingHome, pairingIdentity, parsePairingCode } from '../federation/address.js';
import { selfRelayUrl } from '../federation/self.js';

const ALPHABET ='23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 chars, no look-alikes

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    // Non-crypto fallback (e.g. an exotic test env). Codes are addresses,
    // not secrets, so this is acceptable degradation.
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Normalize a pasted partner code: trim and collapse internal spaces.
 *  Case is preserved — the payload after `cmk1.` is base64url, which is
 *  case-sensitive.
 *
 *  Federation: the result is also an IDENTITY normal form (see
 *  federation/address.ts `pairingIdentity`), so every existing
 *  `normalizePairingCode(a) === normalizePairingCode(b)` comparison
 *  means "same person". A cross-server code (`cmk1f.<key>@<relay>`)
 *  naming this app's own relay collapses to the plain code; one naming
 *  another relay keeps its relay — the same key there is a different
 *  contact, by design. Plain codes come back exactly as before. */
export function normalizePairingCode(raw: string): string {
  return pairingIdentity(raw, selfRelayUrl());
}

/** Light shape check for blind-entry surfaces (the Send pill's code
 *  prompts): every real code starts with the `cmk1.` version prefix
 *  (or is a well-formed cross-server `cmk1f.…@<relay>` code).
 *  The settings editors stay permissive (a visible input the user can
 *  fix); this exists to stop a typo becoming a contact from a modal. */
export function looksLikePairingCode(normalized: string): boolean {
  if (normalized.startsWith('cmk1.') && normalized.length > 'cmk1.'.length) return true;
  return parsePairingCode(normalized) !== null;
}

/** The relay a stored contact code lives on, when it isn't this app's
 *  own relay (for labels: "Bob · relay-b.example"). */
export function pairingCodeRelay(code: string): string | null {
  return pairingHome(code, selfRelayUrl());
}

/** A purely local id for a group (never leaves this machine). */
export function generateGroupId(): string {
  return `grp-${randomChars(8).toLowerCase()}`;
}
