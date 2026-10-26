/**
 * Cross-server share codes (relay/FEDERATION.md §2.1): `cmshare1f` /
 * `cmshare2f` = the existing generations + the `f` flag + `@<home>`.
 *
 * The compatibility contract: plain codes are byte-identical to before
 * (and still the default), every pre-federation parser REJECTS an `f`
 * code cleanly instead of misreading it, and a future `cmshare3` can
 * take the flag without new grammar.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeShareCode,
  encodeShareCode,
  stripShareCodeHome,
} from '../../src/editor/collab/collab-crypto.js';
import { roomIdFromShareCode } from '../../src/editor/collab/collab-prefetch.js';
import { parseRoomInvite } from '../../src/editor/pairing/room-invite.js';
import { parseJoinLinkHash, buildJoinLink } from '../../src/editor/collab/join-link.js';

const ROOM = 'ab'.repeat(16);
const KEY = new Uint8Array(32).map((_, i) => i * 7);
const HOME = 'https://relay-a.example/relay';

/** The share-code parser every pre-federation build ships (verbatim
 *  logic of the 1.15.0 decodeShareCode's prefix/shape checks). */
function oldParserAccepts(code: string): boolean {
  const parts = code.trim().split('.');
  const v2 = parts.length >= 4 && parts[0] === 'cmshare2';
  if (!v2 && (parts.length !== 3 || parts[0] !== 'cmshare1')) return false;
  return /^[0-9a-f]{16,64}$/.test(parts[1]!);
}

describe('cross-server share codes', () => {
  it('plain codes are unchanged', () => {
    const v1 = encodeShareCode(ROOM, KEY);
    const v2 = encodeShareCode(ROOM, KEY, '1.0.0');
    expect(v1.startsWith('cmshare1.')).toBe(true);
    expect(v2.startsWith('cmshare2.')).toBe(true);
    expect(decodeShareCode(v1)).toEqual({ roomId: ROOM, keyBytes: KEY });
    expect(decodeShareCode(v2)).toEqual({ roomId: ROOM, keyBytes: KEY, minVersion: '1.0.0' });
    expect(encodeShareCode(ROOM, KEY, undefined, null)).toBe(v1);
  });

  it('f codes round-trip with their home', () => {
    const f1 = encodeShareCode(ROOM, KEY, undefined, HOME);
    const f2 = encodeShareCode(ROOM, KEY, '1.0.0', HOME);
    expect(f1).toBe(`cmshare1f.${ROOM}.${encodeShareCode(ROOM, KEY).split('.')[2]}@${HOME}`);
    expect(f2.startsWith('cmshare2f.') && f2.endsWith(`.1.0.0@${HOME}`)).toBe(true);
    expect(decodeShareCode(f1)).toEqual({ roomId: ROOM, keyBytes: KEY, home: HOME });
    expect(decodeShareCode(f2)).toEqual({ roomId: ROOM, keyBytes: KEY, minVersion: '1.0.0', home: HOME });
    // Home canonicalized on read.
    expect(decodeShareCode(f1.replace(HOME, 'HTTPS://Relay-A.example:443/relay/'))?.home).toBe(HOME);
    expect(stripShareCodeHome(f2)).toBe(encodeShareCode(ROOM, KEY, '1.0.0'));
    expect(stripShareCodeHome(encodeShareCode(ROOM, KEY))).toBe(encodeShareCode(ROOM, KEY));
  });

  it('rejects mismatched flags, bad homes, and unknown features', () => {
    const v1 = encodeShareCode(ROOM, KEY);
    const f1 = encodeShareCode(ROOM, KEY, undefined, HOME);
    expect(decodeShareCode(`${v1}@${HOME}`)).toBeNull(); // home without the f flag
    expect(decodeShareCode(f1.split('@')[0]!)).toBeNull(); // f flag without a home
    expect(decodeShareCode(f1.replace(HOME, 'ftp://x'))).toBeNull();
    expect(decodeShareCode(f1.replace('cmshare1f', 'cmshare1x'))).toBeNull();
    expect(decodeShareCode(f1.replace('cmshare1f', 'cmshare3f'))).toBeNull(); // unknown generation
  });

  it('every pre-federation parser rejects f codes (the fence)', () => {
    expect(oldParserAccepts(encodeShareCode(ROOM, KEY))).toBe(true);
    expect(oldParserAccepts(encodeShareCode(ROOM, KEY, '1.0.0'))).toBe(true);
    expect(oldParserAccepts(encodeShareCode(ROOM, KEY, undefined, HOME))).toBe(false);
    expect(oldParserAccepts(encodeShareCode(ROOM, KEY, '1.0.0', HOME))).toBe(false);
    // The 1.15.0 invite classifier too.
    const oldInvite = (c: string): boolean => /^cmshare[12]\./.test(c);
    expect(oldInvite(encodeShareCode(ROOM, KEY, '1.0.0', HOME))).toBe(false);
  });

  it('light parsers (invite rows, prefetch, join links) read f codes', () => {
    const f2 = encodeShareCode(ROOM, KEY, '1.0.0', HOME);
    expect(roomIdFromShareCode(f2)).toBe(ROOM);
    expect(roomIdFromShareCode(encodeShareCode(ROOM, KEY, undefined, HOME))).toBe(ROOM);
    expect(parseRoomInvite({ type: 'room-invite', sliceJson: { shareCode: f2, title: 'T' } })).toEqual({
      shareCode: f2,
      title: 'T',
    });
    const link = buildJoinLink({ shareCode: f2, guestPass: null });
    expect(parseJoinLinkHash(link.slice(link.indexOf('#')))).toEqual({ shareCode: f2, guestPass: null });
  });
});
