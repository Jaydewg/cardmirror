/**
 * Server identity + session addresses (src/editor/collab/server-address.ts).
 *
 * The CANON / REJECT vectors are the server-federation branch's
 * tests/federation/address.test.ts vectors, verbatim: a server IS its
 * canonical URL, so this copy must agree byte-for-byte with federation's
 * (and the relay's `canon_url`).
 */
import { describe, expect, it } from 'vitest';
import {
  canonRelayUrl,
  formatSessionAddress,
  parseCodePrefix,
  parseSessionAddress,
  relayHost,
  splitRelaySuffix,
} from '../../src/editor/collab/server-address.js';

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

describe('canonRelayUrl (server identity, federation vectors)', () => {
  for (const [raw, want] of CANON) {
    it(`${JSON.stringify(raw)} → ${want}`, () => expect(canonRelayUrl(raw)).toBe(want));
  }
  for (const raw of REJECT) {
    it(`rejects ${JSON.stringify(raw)}`, () => expect(canonRelayUrl(raw)).toBeNull());
  }
  it('relayHost keeps IPv6 brackets and drops the port', () => {
    expect(relayHost('https://[::1]:8000/relay')).toBe('[::1]');
    expect(relayHost('https://relay.example.org:8443/relay')).toBe('relay.example.org');
  });
});

describe('code prefixes and the server suffix', () => {
  it('splits generation from flags, canonical spelling only', () => {
    expect(parseCodePrefix('cmshare2f')).toEqual({ kind: 'cmshare', gen: 2, flags: 'f' });
    expect(parseCodePrefix('cmshare2ff')).toBeNull();
    expect(parseCodePrefix('cmx1')).toBeNull();
  });
  it('splits at the first @ and canonicalizes the server', () => {
    expect(splitRelaySuffix('a.b')).toEqual({ body: 'a.b', relay: null });
    expect(splitRelaySuffix('a.b@HTTPS://X.example/')).toEqual({ body: 'a.b', relay: 'https://x.example' });
    expect(splitRelaySuffix('a.b@not a url')).toEqual({ body: 'a.b', relay: undefined });
  });
});

describe('session addresses', () => {
  const ROOM = '0123456789abcdef';
  const KEY = 'A'.repeat(43);
  const PLAIN = `cmshare2.${ROOM}.${KEY}.1.17.0`;
  const SELF = 'https://self.example/relay';
  const OTHER = 'https://other.example/relay';

  it('a plain code belongs to the reader\'s server', () => {
    expect(parseSessionAddress(PLAIN, SELF)).toEqual({
      address: `${PLAIN}@${SELF}`,
      code: PLAIN,
      roomId: ROOM,
      server: SELF,
      view: false,
    });
    expect(parseSessionAddress(PLAIN, null)).toBeNull(); // no server to resolve to
  });

  it('plain@server and f-code@server name the same session (flag normalized away)', () => {
    const a = parseSessionAddress(`${PLAIN}@${OTHER}`, SELF);
    const b = parseSessionAddress(`cmshare2f.${ROOM}.${KEY}.1.17.0@HTTPS://Other.example:443/relay/`, SELF);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ code: PLAIN, server: OTHER, address: `${PLAIN}@${OTHER}` });
  });

  it('view codes and v1 codes parse; view is flagged', () => {
    expect(parseSessionAddress(`cmview1.${ROOM}.${KEY}@${OTHER}`, SELF)).toMatchObject({ view: true, roomId: ROOM });
    expect(parseSessionAddress(`cmshare1.${ROOM}.${KEY}`, SELF)).toMatchObject({ view: false, server: SELF });
  });

  it('tolerates whitespace from wrapped pastes', () => {
    expect(parseSessionAddress(` ${PLAIN}\n@${OTHER} `, SELF)?.address).toBe(`${PLAIN}@${OTHER}`);
  });

  it('refuses f without a server, unknown flags, bad servers, pairing codes and junk', () => {
    expect(parseSessionAddress(`cmshare2f.${ROOM}.${KEY}.1.17.0`, SELF)).toBeNull();
    expect(parseSessionAddress(`cmshare2x.${ROOM}.${KEY}.1.17.0@${OTHER}`, SELF)).toBeNull();
    expect(parseSessionAddress(`${PLAIN}@not a url`, SELF)).toBeNull();
    expect(parseSessionAddress(`cmk1.${KEY}@${OTHER}`, SELF)).toBeNull();
    expect(parseSessionAddress(`cmshare2.NOTHEX.${KEY}.1.17.0`, SELF)).toBeNull();
    expect(parseSessionAddress('garbage', SELF)).toBeNull();
    expect(parseSessionAddress(42, SELF)).toBeNull();
    expect(parseSessionAddress(`${PLAIN}@https://x.example/${'a'.repeat(1100)}`, SELF)).toBeNull();
  });

  it('formatSessionAddress pins a plain code to a server', () => {
    expect(formatSessionAddress(PLAIN, OTHER)).toBe(`${PLAIN}@${OTHER}`);
    expect(formatSessionAddress(PLAIN, null)).toBeNull();
    expect(formatSessionAddress('garbage', OTHER)).toBeNull();
  });
});
