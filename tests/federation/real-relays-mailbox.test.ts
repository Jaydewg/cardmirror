/**
 * Cross-server CARD SHARING against real relays (relay/FEDERATION.md
 * §5), through the app's actual web mailbox (the renderer twin of the
 * desktop main process's pairing-ipc — same routing rules) and the real
 * desktop keystore on the other end.
 *
 * Skipped unless FED_RELAYS is set (see real-relays.test.ts;
 * relay/tests/run_client_federation.py runs both files).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}
(globalThis as Record<string, unknown>)['window'] = {
  localStorage: makeStorage(),
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as Record<string, unknown>)['document'] = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
};

import { createPairingKeystore, routingId } from '../../apps/desktop/src/pairing-crypto.js';
import { webOwnPublicCode } from '../../src/editor/pairing/web-pairing-crypto.js';
import {
  webPairingConfigure,
  webPairingSend,
  __resetWebMailboxForTests,
} from '../../src/editor/pairing/web-mailbox.js';
import { inboxStore } from '../../src/editor/pairing/inbox-store.js';
import { settings } from '../../src/editor/settings.js';
import { appVersion } from '../../src/editor/install-info.js';
import { formatPairingCode } from '../../src/editor/federation/address.js';
import { ensureRelayCapabilities } from '../../src/editor/federation/relay-capabilities.js';

interface RelayCfg {
  url: string;
  token: string;
}
const CFG = process.env['FED_RELAYS']
  ? (JSON.parse(process.env['FED_RELAYS']) as { a: RelayCfg; b: RelayCfg; c: RelayCfg })
  : null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ITEM = { label: 'Cross-server card', type: 'card', sliceJson: { content: ['x'] } };

function useRelay(r: RelayCfg): void {
  settings.set('pairingRelayUrl', r.url);
  settings.set('pairingRelayToken', r.token);
}

async function waitMessages(r: RelayCfg, recipient: string): Promise<Array<Record<string, unknown>>> {
  const end = Date.now() + 30_000;
  for (;;) {
    const res = await fetch(`${r.url}/messages?recipient=${encodeURIComponent(recipient)}`, {
      headers: { Authorization: `Bearer ${r.token}` },
    });
    const data = (await res.json()) as { messages?: Array<Record<string, unknown>> };
    if (data.messages?.length) return data.messages;
    if (Date.now() > end) throw new Error('no delivery');
    await sleep(200);
  }
}

beforeAll(async () => {
  if (!CFG) return;
  for (const r of [CFG.a, CFG.b, CFG.c]) await ensureRelayCapabilities(r.url);
});

afterAll(async () => {
  if (!CFG) return;
  await webPairingConfigure({ enabled: false, displayName: '', schemaVersion: appVersion, pollSeconds: 1, relayUrl: '', relayToken: '' });
  __resetWebMailboxForTests();
});

describe.skipIf(!CFG)('federated card sharing (real relays)', () => {
  it('web sender on A → recipient on B: routed via the outbox, sender re-addressable', async () => {
    const { a, b } = CFG!;
    useRelay(a);
    const bob = createPairingKeystore(path.join(mkdtempSync(path.join(os.tmpdir(), 'cm-fed-')), 'bob.json'));
    const res = await webPairingSend({
      recipientCodes: [formatPairingCode(bob.ownPublicCode(), b.url)],
      item: ITEM,
    });
    expect(res).toMatchObject({ ok: 1, fail: 0, peerFail: 0, deferred: 0 });
    const [msg] = await waitMessages(b, routingId(bob.ownPublicCode()));
    expect(msg!['viaRelay']).toBe(a.url); // relay-verified origin
    const inner = bob.open(msg as never) as { senderCode: string; item: { label: string } };
    expect(inner.item.label).toBe(ITEM.label);
    // A cross-server recipient gets the code to reply to across servers.
    expect(inner.senderCode).toBe(formatPairingCode(await webOwnPublicCode(), a.url));
  });

  it('recipient side: mail from another server is attributed to the verified relay', async () => {
    const { a, b } = CFG!;
    useRelay(a);
    await webPairingConfigure({
      enabled: true,
      displayName: 'Alice',
      schemaVersion: appVersion,
      pollSeconds: 1,
      relayUrl: '',
      relayToken: '',
    });
    const me = await webOwnPublicCode();
    // A desktop user on B sends through B's outbox (claiming a PLAIN
    // sender code — the receiver must still label them as B's).
    const carol = createPairingKeystore(path.join(mkdtempSync(path.join(os.tmpdir(), 'cm-fed-')), 'carol.json'));
    const bundle = carol.seal(
      { schemaVersion: appVersion, senderCode: carol.ownPublicCode(), senderName: 'Carol', item: { ...ITEM, label: 'from carol' } },
      me,
    );
    const post = await fetch(`${b.url}/federation/v1/outbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, recipientCode: routingId(me), recipientRelay: a.url, sentAt: Date.now(), ...bundle }),
    });
    expect(post.status).toBe(202);
    const end = Date.now() + 30_000;
    while (!inboxStore.list().some((i) => i.label === 'from carol')) {
      if (Date.now() > end) throw new Error('not received');
      await sleep(200);
    }
    const got = inboxStore.list().find((i) => i.label === 'from carol')!;
    expect(got.senderName).toBe('Carol');
    expect(got.senderCode).toBe(formatPairingCode(carol.ownPublicCode(), b.url));
  });

  it('refusals are reported as federation failures, not credential declines', async () => {
    const { a, b, c } = CFG!;
    const someone = formatPairingCode('cmk1.' + 'Q'.repeat(43), c.url);
    useRelay(a);
    // A non-federating destination.
    expect(await webPairingSend({ recipientCodes: [someone], item: ITEM })).toMatchObject({
      ok: 0,
      fail: 1,
      peerFail: 1,
      authFail: 0,
    });
    // Our own relay doesn't federate: nothing is sent at all.
    useRelay(c);
    const toB = formatPairingCode('cmk1.' + 'R'.repeat(43), b.url);
    expect(await webPairingSend({ recipientCodes: [toB], item: ITEM })).toMatchObject({
      ok: 0,
      fail: 1,
      peerFail: 1,
    });
  });
});
