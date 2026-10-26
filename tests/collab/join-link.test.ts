/**
 * Invite links + guest-pass threading (web-collab Phase 3).
 *
 * Pinned:
 *  - link build/parse round-trips, pass optional, key stays in the
 *    FRAGMENT, garbage rejected
 *  - a host's session surfaces the relay-minted guest pass (and null
 *    when the relay flip is off — the dormant default)
 *  - a guest-pass rooms client authenticates with the pass as its
 *    bearer and sends no routing header
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildJoinLink, parseJoinLinkHash } from '../../src/editor/collab/join-link.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { simpleDoc } from './_loro-helpers.js';

let mock: RoomsMock;
beforeAll(async () => {
  mock = await startRoomsMock();
});
afterAll(async () => {
  await mock.close();
});

describe('join links', () => {
  const CODE = 'cmshare2.abc-DEF_123';
  const PASS = 'eyJh.eyJi.c2ln';

  it('a view (spectator) code rides the same fragment and parses', () => {
    const link = buildJoinLink({ shareCode: 'cmview1.abc-DEF_123', guestPass: PASS });
    expect(link).toContain('#join=cmview1.abc-DEF_123&pass=');
    const parts = parseJoinLinkHash(new URL(link).hash)!;
    expect(parts.shareCode).toBe('cmview1.abc-DEF_123');
    expect(parts.guestPass).toBe(PASS);
    expect(parseJoinLinkHash('#join=cmnope.x')).toBeNull();
  });

  it('builds and parses round-trip, pass included', () => {
    const link = buildJoinLink({ shareCode: CODE, guestPass: PASS });
    expect(link.startsWith('https://cardmirror.app/#')).toBe(true);
    expect(link.includes('?')).toBe(false); // fragment only — never the query
    const parsed = parseJoinLinkHash(new URL(link).hash);
    expect(parsed).toEqual({ shareCode: CODE, guestPass: PASS });
  });

  it('pass is optional; extra params tolerated; garbage rejected', () => {
    const bare = buildJoinLink({ shareCode: CODE, guestPass: null });
    expect(parseJoinLinkHash(new URL(bare).hash)).toEqual({ shareCode: CODE, guestPass: null });
    expect(parseJoinLinkHash('#join=' + encodeURIComponent(CODE) + '&x=1&pass=')).toEqual({
      shareCode: CODE,
      guestPass: null,
    });
    expect(parseJoinLinkHash('#other=1')).toBeNull();
    expect(parseJoinLinkHash('#join=notasharecode')).toBeNull();
    expect(parseJoinLinkHash('')).toBeNull();
  });
});

describe('guest-pass threading', () => {
  it('host surfaces the relay-minted pass; dormant relay yields null', async () => {
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });

    mock.setGuestPass(null); // dormant default
    const off = await CollabSession.host({ pmDoc: simpleDoc('a'), client });
    expect(off.guestPass).toBeNull();
    expect(off.session.guestPass).toBeNull();
    await off.session.stop();

    mock.setGuestPass('room-pass-1');
    const on = await CollabSession.host({ pmDoc: simpleDoc('b'), client });
    expect(on.guestPass).toBe('room-pass-1');
    expect(on.session.guestPass).toBe('room-pass-1');
    await on.session.stop();
    mock.setGuestPass(null);
  });

  it('a pass-authenticated client presents the pass as its bearer, no routing header', async () => {
    // Wire-shape check via a capturing fetch; the server-side VERDICT
    // on passes is dev_test_guest_pass.py's job.
    let captured: Headers | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response(JSON.stringify({ seq: 7 }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new RoomsClient({
        baseUrl: () => 'http://relay.test/relay',
        token: () => 'the-guest-pass',
        routingCode: () => '',
      });
      const seq = await client.postUpdate('roomX', new Uint8Array([1, 2, 3]));
      expect(seq).toBe(7);
      expect(captured!.get('Authorization')).toBe('Bearer the-guest-pass');
      expect(captured!.get('X-CardMirror-Routing')).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
