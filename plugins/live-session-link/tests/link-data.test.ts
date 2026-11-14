import { describe, expect, it } from 'vitest';
import {
  ADDRESS_MAX,
  addressParts,
  makeLinkData,
  parseLinkData,
  roomIdOfCode,
  serverHost,
  sessionKey,
} from '../src/link-data.js';
import { ADDRESS, CODE, OTHER_SERVER, ROOM, SERVER, linkFor } from './_fake-api.js';

describe('link data', () => {
  it('round-trips a made payload', () => {
    const made = makeLinkData(` ${ADDRESS} `, 'Aff 1AC', 42)!;
    expect(made).toEqual({ v: 2, address: ADDRESS, roomId: ROOM, server: SERVER, title: 'Aff 1AC', embeddedAt: 42 });
    expect(parseLinkData(JSON.parse(JSON.stringify(made)))).toEqual(made);
  });

  it('accepts plain and federated (f) addresses alike', () => {
    const f = `cmshare2f.${ROOM}.KEYKEYKEY.1.17.0@${OTHER_SERVER}`;
    expect(parseLinkData(linkFor(f))).toMatchObject({ roomId: ROOM, server: OTHER_SERVER });
    expect(addressParts(f)!.plainCode).toBe(CODE);
    expect(addressParts(ADDRESS)!.plainCode).toBe(CODE);
  });

  it('rejects anything off-shape (files are untrusted)', () => {
    expect(parseLinkData(null)).toBeNull();
    expect(parseLinkData('cmshare2…')).toBeNull();
    expect(parseLinkData([linkFor()])).toBeNull();
    expect(parseLinkData({ ...linkFor(), v: 3 })).toBeNull();
    // The unreleased v1 prototype shape (a bare code, no server) is ignored.
    expect(parseLinkData({ v: 1, code: CODE, roomId: ROOM, title: 'x', embeddedAt: 1 })).toBeNull();
    expect(parseLinkData({ ...linkFor(), v: 1 })).toBeNull();
    expect(parseLinkData({ ...linkFor(), address: 42 })).toBeNull();
    expect(parseLinkData({ ...linkFor(), roomId: 'fedcba9876543210' })).toBeNull();
    expect(parseLinkData({ ...linkFor(), server: OTHER_SERVER })).toBeNull();
    expect(parseLinkData({ ...linkFor(), address: CODE })).toBeNull(); // no server
    expect(parseLinkData({ ...linkFor(), address: ` ${ADDRESS}` })).toBeNull();
    expect(parseLinkData(linkFor(`${CODE}@${SERVER}/${'x'.repeat(ADDRESS_MAX)}`))).toBeNull();
    expect(parseLinkData(linkFor(`${CODE}@ftp://relay.test`))).toBeNull();
    expect(parseLinkData(linkFor(`cmshare2x.${ROOM}.KEY.1.17.0@${SERVER}`))).toBeNull(); // unknown flag
    // A view address would make Join a read-only seat: never embedded.
    expect(parseLinkData(linkFor(`cmview1.${ROOM}.KEY@${SERVER}`))).toBeNull();
    expect(makeLinkData(`cmview1.${ROOM}.KEY@${SERVER}`, null, 0)).toBeNull();
    expect(makeLinkData(CODE, null, 0)).toBeNull();
    expect(makeLinkData('garbage', null, 0)).toBeNull();
  });

  it('cleans the display title and tolerates a bad timestamp', () => {
    const parsed = parseLinkData({ ...linkFor(), title: `a\u0000b${'t'.repeat(500)}`, embeddedAt: 'x' })!;
    expect(parsed.title.startsWith('a b')).toBe(true);
    expect(parsed.title.length).toBe(200);
    expect(parsed.embeddedAt).toBe(0);
    expect(parseLinkData({ ...linkFor(), title: undefined })!.title).toBe('');
  });

  it('reads room ids from every code generation; keys name room AND server', () => {
    expect(roomIdOfCode(`cmshare1.${ROOM}.KEY`)).toBe(ROOM);
    expect(roomIdOfCode(`cmshare2f.${ROOM}.KEY.1.17.0@https://relay.test`)).toBe(ROOM);
    expect(roomIdOfCode('nope')).toBeNull();
    expect(sessionKey(ROOM, SERVER)).not.toBe(sessionKey(ROOM, OTHER_SERVER));
    expect(serverHost('https://[::1]:8000/relay')).toBe('[::1]');
    expect(serverHost(OTHER_SERVER)).toBe('other.example');
  });
});
