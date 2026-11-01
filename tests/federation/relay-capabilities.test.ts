/**
 * Forward compatibility (newer app → older relay): federation exists
 * for the app ONLY when its relay affirmatively says so. Every older
 * shape — no capabilities endpoint, a capabilities document without a
 * federation block, an unreachable relay — must read as "no
 * federation" (and "send the plain numeric version").
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetRelayCapabilitiesForTests,
  acceptsVersionFlags,
  ensureRelayCapabilities,
  federationFor,
  onRelayCapabilitiesChanged,
} from '../../src/editor/federation/relay-capabilities.js';

const BASE = 'https://relay.example/relay';

function fetchReturning(status: number, body?: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const FEDERATING = {
  schema: 1,
  features: {
    'client.versionFlags': {},
    'federation.mailbox': {},
    'federation.rooms': {},
    'federation.joinRequests': { modes: ['write', 'read'] },
  },
  federation: { protocol: 1, url: 'https://Relay.example/relay/', nickname: '  Debate Club  ' },
};

beforeEach(() => __resetRelayCapabilitiesForTests());

describe('own-relay capabilities', () => {
  it('a federating relay turns federation on (URL canonicalized, nickname trimmed)', async () => {
    let changes = 0;
    onRelayCapabilitiesChanged(() => changes++);
    await ensureRelayCapabilities(BASE, { fetchImpl: fetchReturning(200, FEDERATING) });
    expect(federationFor(BASE)).toEqual({
      url: 'https://relay.example/relay',
      nickname: 'Debate Club',
      mailbox: true,
      rooms: true,
      joinRequests: true,
    });
    expect(acceptsVersionFlags(BASE)).toBe(true);
    expect(changes).toBe(1);
  });

  it('an operator change (nickname) reaches the UI; fetches revalidate past the HTTP cache', async () => {
    const inits: Array<RequestInit | undefined> = [];
    let nickname = 'Old Name';
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      inits.push(init);
      return new Response(
        JSON.stringify({ ...FEDERATING, federation: { ...FEDERATING.federation, nickname } }),
        { status: 200 },
      );
    }) as typeof fetch;
    let changes = 0;
    onRelayCapabilitiesChanged(() => changes++);
    await ensureRelayCapabilities(BASE, { fetchImpl });
    expect(federationFor(BASE)?.nickname).toBe('Old Name');
    nickname = 'New Name';
    await ensureRelayCapabilities(BASE, { force: true, fetchImpl });
    expect(federationFor(BASE)?.nickname).toBe('New Name');
    expect(changes).toBe(2); // the nickname change notified listeners
    await ensureRelayCapabilities(BASE, { force: true, fetchImpl });
    expect(changes).toBe(2); // …an unchanged document doesn't
    // The relay's max-age=300 must not answer for it.
    expect(inits.every((i) => i?.cache === 'no-cache')).toBe(true);
  });

  it('a relay without capabilities (404) is a pre-federation relay', async () => {
    await ensureRelayCapabilities(BASE, { fetchImpl: fetchReturning(404) });
    expect(federationFor(BASE)).toBeNull();
    expect(acceptsVersionFlags(BASE)).toBe(false);
  });

  it('capabilities without a federation block: no federation, no flags', async () => {
    await ensureRelayCapabilities(BASE, {
      fetchImpl: fetchReturning(200, { schema: 1, features: { 'mailbox.pollMore': {} } }),
    });
    expect(federationFor(BASE)).toBeNull();
    expect(acceptsVersionFlags(BASE)).toBe(false);
  });

  it('a malformed federation block is ignored', async () => {
    for (const federation of [{ protocol: 1 }, { url: BASE }, { protocol: 0, url: BASE }, { protocol: 1, url: 'ftp://x' }]) {
      __resetRelayCapabilitiesForTests();
      await ensureRelayCapabilities(BASE, {
        fetchImpl: fetchReturning(200, { features: FEDERATING.features, federation }),
      });
      expect(federationFor(BASE)).toBeNull();
    }
  });

  it('an unreachable relay keeps the last known answer, and unknown stays off', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await ensureRelayCapabilities(BASE, { fetchImpl: down });
    expect(federationFor(BASE)).toBeNull();
    await ensureRelayCapabilities(BASE, { force: true, fetchImpl: fetchReturning(200, FEDERATING) });
    expect(federationFor(BASE)?.rooms).toBe(true);
    await ensureRelayCapabilities(BASE, { force: true, fetchImpl: down });
    expect(federationFor(BASE)?.rooms).toBe(true);
  });
});
