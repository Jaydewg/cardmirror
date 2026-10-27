/**
 * Federation addressing (relay/FEDERATION.md §1–2).
 *
 * Three copies of the same rules must agree byte-for-byte: the relay's
 * `canon_url` / `split_version_flags` (relay/tests/test_units.py pins
 * the SAME vectors), the renderer's federation/address.ts +
 * relay-protocol.ts, and the desktop main process's federation-main.ts
 * (which can't import src/). A relay IS its canonical URL, so a drift
 * here would make two parties disagree about who is who.
 */

import { describe, expect, it } from 'vitest';
import * as renderer from '../../src/editor/federation/address.js';
import * as main from '../../apps/desktop/src/federation-main.js';
import {
  IN_APP_UPDATES,
  compareAppVersions,
  flaggedVersion,
  numericVersion,
  splitVersionFlags,
  wireVersion,
} from '../../src/editor/relay-protocol.js';

const CANON: Array<[string, string]> = [
  ['https://Relay.Example.org/relay', 'https://relay.example.org/relay'],
  ['https://relay.example.org/relay/', 'https://relay.example.org/relay'],
  ['https://relay.example.org:443/relay', 'https://relay.example.org/relay'],
  ['http://relay.example.org:80/relay', 'http://relay.example.org/relay'],
  ['https://relay.example.org:8443/relay', 'https://relay.example.org:8443/relay'],
  ['HTTPS://relay.example.org//a//b/', 'https://relay.example.org/a/b'],
  ['https://relay.example.org', 'https://relay.example.org'],
  ['https://[::1]:8000/relay', 'https://[::1]:8000/relay'],
  ['  https://relay.example.org/relay  ', 'https://relay.example.org/relay'],
  ['https://relay.example.org/Relay', 'https://relay.example.org/Relay'],
];

const REJECT: unknown[] = [
  '',
  'relay.example.org',
  'ftp://relay.example.org',
  'https://user@relay.example.org/relay',
  'https://relay.example.org/relay?x=1',
  'https://relay.example.org/relay#f',
  'https://relay.example.org:99999/relay',
  'https://rel ay.example.org',
  null,
  42,
  'https://relay.example.org/re@lay',
];

describe('canonRelayUrl (relay identity)', () => {
  for (const [raw, want] of CANON) {
    it(`${JSON.stringify(raw)} → ${want}`, () => {
      expect(renderer.canonRelayUrl(raw)).toBe(want);
      expect(main.canonRelayUrl(raw)).toBe(want);
    });
  }
  for (const raw of REJECT) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(renderer.canonRelayUrl(raw)).toBeNull();
      expect(main.canonRelayUrl(raw)).toBeNull();
    });
  }
});

describe('feature-flagged code prefixes', () => {
  it('splits generation from flags', () => {
    expect(renderer.parseCodePrefix('cmshare2f')).toEqual({ kind: 'cmshare', gen: 2, flags: 'f' });
    expect(renderer.parseCodePrefix('cmshare3f')).toEqual({ kind: 'cmshare', gen: 3, flags: 'f' });
    expect(renderer.parseCodePrefix('cmk1')).toEqual({ kind: 'cmk', gen: 1, flags: '' });
    expect(renderer.parseCodePrefix('cmshare2ff')).toBeNull(); // canonical spelling only
    expect(renderer.parseCodePrefix('cmshare')).toBeNull();
    expect(renderer.parseCodePrefix('cmx1')).toBeNull();
  });
});

const KEY = 'cmk1.' + 'A'.repeat(43);
const B = 'https://relay-b.example/relay';

describe('pairing codes', () => {
  it('plain and cross-server forms round-trip (renderer and main agree)', () => {
    for (const impl of [renderer, main]) {
      expect(impl.parsePairingCode(KEY)).toEqual({ key: KEY, relay: null });
      const cross = impl.formatPairingCode(KEY, B);
      expect(cross).toBe(`cmk1f.${'A'.repeat(43)}@${B}`);
      expect(impl.parsePairingCode(cross)).toEqual({ key: KEY, relay: B });
      // The relay part is canonicalized on parse.
      expect(impl.parsePairingCode(`cmk1f.${'A'.repeat(43)}@HTTPS://Relay-B.example:443/relay/`)).toEqual({
        key: KEY,
        relay: B,
      });
    }
  });

  it('rejects malformed and unknown-flag codes', () => {
    for (const impl of [renderer, main]) {
      expect(impl.parsePairingCode(`${KEY}@${B}`)).toBeNull(); // relay without the f flag
      expect(impl.parsePairingCode(`cmk1f.${'A'.repeat(43)}`)).toBeNull(); // f without a relay
      expect(impl.parsePairingCode(`cmk1x.${'A'.repeat(43)}@${B}`)).toBeNull(); // unknown feature
      expect(impl.parsePairingCode(`cmk1f.${'A'.repeat(43)}@not a url`)).toBeNull();
      expect(impl.parsePairingCode('cmk1.')).toBeNull();
    }
  });

  it('identity is key + relay; the reader’s own relay collapses to the plain code', () => {
    const cross = renderer.formatPairingCode(KEY, B);
    // A different server: a different person, by design.
    expect(renderer.pairingIdentity(cross, 'https://relay-a.example/relay')).toBe(cross);
    expect(renderer.pairingIdentity(cross, B)).toBe(KEY);
    expect(renderer.pairingIdentity(KEY, B)).toBe(KEY);
    // Plain codes are untouched (today's comparisons are unchanged).
    expect(renderer.pairingIdentity(` ${KEY} `, null)).toBe(KEY);
    expect(renderer.pairingIdentity('garbage code', null)).toBe('garbagecode');
    expect(renderer.pairingHome(cross, B)).toBeNull();
    expect(renderer.pairingHome(cross, null)).toBe(B);
  });

  it('labels show the host next to a nickname, never the nickname alone', () => {
    expect(renderer.relayLabel(B, 'Debate Club')).toBe('Debate Club (relay-b.example)');
    expect(renderer.relayLabel(B, null)).toBe('relay-b.example');
    expect(renderer.relayLabel('https://[::1]:8000/relay')).toBe('[::1]');
    expect(renderer.relayHome64(B)).toBe(Buffer.from(B).toString('base64url'));
  });
});

describe('refusal reasons', () => {
  it('a policy refusal says why, and an unknown reason adds nothing', async () => {
    const { sendOutcomeToast } = await import('../../src/editor/pairing/relay-client.js');
    expect(renderer.refusalWhy('private-address')).toContain('RELAY_FEDERATION_ALLOW_PRIVATE');
    expect(renderer.refusalWhy('http-not-allowed')).toContain('RELAY_FEDERATION_ALLOW_HTTP');
    expect(renderer.refusalWhy('peer-not-federating')).toContain('doesn’t connect to other servers');
    expect(renderer.refusalWhy('mystery')).toBe('');
    expect(
      sendOutcomeToast('Bob', { ok: 0, fail: 1, authFail: 0, peerFail: 1, peerReason: 'private-address' }),
    ).toContain('private network address');
    // No reason from an older main process: the generic wording.
    expect(sendOutcomeToast('Bob', { ok: 0, fail: 1, authFail: 0, peerFail: 1 })).toContain(
      'doesn\'t connect to other servers, or not to that one',
    );
  });
});

describe('version flags (FEDERATION.md §2.2)', () => {
  const cases: Array<[string, string, string]> = [
    ['1.15.0-f', '1.15.0', 'f'],
    ['1.15-f', '1.15', 'f'],
    ['1.15.0', '1.15.0', ''],
    ['1.16.0-beta.2-f', '1.16.0-beta.2', 'f'],
    ['1.16.0-beta', '1.16.0-beta', ''],
    ['1.16.0-rc', '1.16.0-rc', ''],
    ['1.15.0-fx', '1.15.0', 'fx'],
  ];
  for (const [v, core, flags] of cases) {
    it(`${v} → ${core} + "${flags}"`, () => {
      expect(splitVersionFlags(v)).toEqual({ core, flags });
      expect(main.splitVersionFlags(v)).toEqual({ core, flags });
    });
  }

  it('flags never affect ordering; two-part cores read as .0', () => {
    expect(compareAppVersions('1.15.0-f', '1.15.0')).toBe(0);
    expect(compareAppVersions('1.15-f', '1.15.0')).toBe(0);
    expect(compareAppVersions('1.16.0-beta.2-f', '1.16.0')).toBeLessThan(0);
    expect(compareAppVersions('1.14.9-f', '1.15.0')).toBeLessThan(0);
  });

  it('only flag-reading relays receive flags; everyone else gets X.Y.Z', () => {
    for (const impl of [{ wireVersion, numericVersion, flaggedVersion }, main]) {
      expect(impl.numericVersion('1.15-f')).toBe('1.15.0');
      expect(impl.flaggedVersion('1.15.0')).toBe('1.15.0-f');
      expect(impl.flaggedVersion('1.15.0-f')).toBe('1.15.0-f');
      expect(impl.wireVersion('1.15.0', false)).toBe('1.15.0');
      expect(impl.wireVersion('1.15.0-f', false)).toBe('1.15.0');
      expect(impl.wireVersion('1.15.0', true)).toBe('1.15.0-f');
      expect(impl.wireVersion('1.16.0-beta.2', true)).toBe('1.16.0-beta.2-f');
    }
  });
});

describe('in-app updates', () => {
  it('a federation build never updates itself, in either process', () => {
    // A 1.15.0-f install was silently replaced by a stable release
    // without federation (2026-10-26). Renderer and main must agree.
    expect(IN_APP_UPDATES).toBe(false);
    expect(main.IN_APP_UPDATES).toBe(false);
  });
});
