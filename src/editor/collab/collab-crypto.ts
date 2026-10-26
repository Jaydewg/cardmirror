/**
 * Collaboration-session crypto: per-room symmetric encryption and the
 * share-code format.
 *
 * Every update, snapshot, and presence blob a session sends is sealed
 * with the room's AES-256-GCM key before it leaves the client; the
 * relay stores and forwards ciphertext it cannot read (the same trust
 * envelope as card sharing's sealed boxes). The room key never reaches
 * the server — it travels only inside invites (sealed-box pairing
 * messages) or a share code the user hands over directly.
 *
 * Sealed layout: 12-byte random IV ‖ GCM ciphertext+tag. A fresh IV per
 * blob is mandatory for GCM; 12 bytes is the GCM-native size.
 *
 * Uses WebCrypto (`crypto.subtle`), available in the browser, the
 * Electron renderer, and Node ≥16 — the same code path everywhere.
 */

import { bytesToBase64, base64ToBytes } from '../../ooxml/base64.js';
import { FEDERATION_FLAG, parseCodePrefix, splitRelaySuffix } from '../federation/address.js';

export const ROOM_KEY_BYTES = 32;

const SHARE_CODE_PREFIX = 'cmshare1';
const SHARE_CODE_PREFIX_V2 = 'cmshare2';

export function generateRoomKeyBytes(): Uint8Array {
  const key = new Uint8Array(ROOM_KEY_BYTES);
  crypto.getRandomValues(key);
  return key;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ROOM_KEY_BYTES) {
    throw new Error('room key must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptBlob(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return out;
}

/** Throws on tampered or wrong-key input (GCM tag failure). */
export async function decryptBlob(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.byteLength < 13) throw new Error('sealed blob too short');
  const iv = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource),
  );
}

// --- base64 / base64url (portable: browser + Node, no Buffer) ---

// The shared helpers (native Uint8Array.toBase64 / fromBase64 where
// present): a multi-megabyte compaction snapshot used to be decoded by a
// per-character JS loop on the join path (2026-09-01 review, T14).
export { bytesToBase64, base64ToBytes };

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(b64);
}

// --- share codes ---

/** v1: `cmshare1.<roomId>.<base64url room key>` — the out-of-band
 *  invite fallback for non-partners (paste or QR). Possession of the
 *  code IS the capability to join.
 *
 *  v2: `cmshare2.<roomId>.<key>.<minVersion>` — rooms with a
 *  compatibility floor (movable rooms, >= 1.0.0). The format change is
 *  itself the fence: every pre-1.0 parser requires exactly THREE
 *  dot-parts with the literal `cmshare1` prefix, so a v2 code fails
 *  cleanly there ("that does not look like a share code") instead of
 *  joining a room whose containers the build cannot read — join-by-code
 *  bypasses the invite path's minReceiverVersion floor entirely, and an
 *  old build that slipped through crashed on the first move op
 *  (found live, 2026-08-14). Old builds cannot be taught a better
 *  message; new builds read the floor and say "update". List rooms keep
 *  minting v1 codes so old builds can still join them. */
export function encodeShareCode(
  roomId: string,
  keyBytes: Uint8Array,
  minVersion?: string,
  home?: string | null,
): string {
  // Federation (relay/FEDERATION.md §2.1): the `f` flag rides on the
  // generation — cmshare1f / cmshare2f — and the code ends `@<home>`.
  // Only minted when asked for (cross-server copy, remote invites):
  // plain codes stay the default so every older build can still join.
  const flag = home ? FEDERATION_FLAG : '';
  const tail = home ? `@${home}` : '';
  if (minVersion) {
    return `${SHARE_CODE_PREFIX_V2}${flag}.${roomId}.${toBase64Url(keyBytes)}.${minVersion}${tail}`;
  }
  return `${SHARE_CODE_PREFIX}${flag}.${roomId}.${toBase64Url(keyBytes)}${tail}`;
}

export interface DecodedShareCode {
  roomId: string;
  keyBytes: Uint8Array;
  minVersion?: string;
  /** Canonical home relay URL — present only on `f` codes. */
  home?: string;
}

export function decodeShareCode(code: string): DecodedShareCode | null {
  const { body, relay } = splitRelaySuffix(code.trim());
  const parts = body.split('.');
  const prefix = parseCodePrefix(parts[0] ?? '');
  if (!prefix || prefix.kind !== 'cmshare' || (prefix.gen !== 1 && prefix.gen !== 2)) return null;
  // Flags this build understands: none, or `f` with a valid home URL.
  if (prefix.flags === '' ? relay !== null : prefix.flags !== FEDERATION_FLAG || typeof relay !== 'string') {
    return null;
  }
  // The version itself contains dots ("1.0.0"), so a v2 code splits
  // into 4+ parts: everything past the key is the floor, rejoined.
  const v2 = prefix.gen === 2;
  if (v2 ? parts.length < 4 : parts.length !== 3) return null;
  const roomId = parts[1]!;
  if (!/^[0-9a-f]{16,64}$/.test(roomId)) return null;
  const minVersion = v2 ? parts.slice(3).join('.') : undefined;
  if (v2 && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(minVersion!)) return null;
  try {
    const keyBytes = fromBase64Url(parts[2]!);
    if (keyBytes.byteLength !== ROOM_KEY_BYTES) return null;
    const out: DecodedShareCode = v2 ? { roomId, keyBytes, minVersion } : { roomId, keyBytes };
    if (relay) out.home = relay;
    return out;
  } catch {
    return null;
  }
}

/** The same code without its home (`f` → plain), for display/storage
 *  paths that must stay readable by every build. */
export function stripShareCodeHome(code: string): string {
  const d = decodeShareCode(code);
  return d?.home ? encodeShareCode(d.roomId, d.keyBytes, d.minVersion) : code.trim();
}
