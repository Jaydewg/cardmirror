/**
 * The desktop MAIN process's card sharing across servers
 * (relay/FEDERATION.md §5), driven through its real IPC handlers
 * against real relays: routing (outbox vs local), the sender code a
 * cross-server recipient gets, receive-side attribution to the
 * relay-verified origin, and refusal reporting.
 *
 * Skipped unless FED_RELAYS is set (relay/tests/run_client_federation.py
 * starts the relays; `FED_RELAYS=… npx vitest run tests/desktop/pairing-federation.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { resetElectronStub, ipcHandlers } from './_electron-stub.js';
import { registerPairingIpc } from '../../apps/desktop/src/pairing-ipc.js';
import { createPairingKeystore, routingId } from '../../apps/desktop/src/pairing-crypto.js';
import { formatPairingCode } from '../../apps/desktop/src/federation-main.js';

interface RelayCfg {
  url: string;
  token: string;
}
const CFG = process.env['FED_RELAYS']
  ? (JSON.parse(process.env['FED_RELAYS']) as { a: RelayCfg; b: RelayCfg; c: RelayCfg })
  : null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ITEM = { label: 'main-process card', type: 'card', sliceJson: { content: ['m'] } };
const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-main-fed-'));
let ownCode = '';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const h = ipcHandlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(h(null, ...args)) as Promise<T>;
}

async function mailbox(r: RelayCfg, recipient: string): Promise<Array<Record<string, unknown>>> {
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

const config = (r: RelayCfg, enabled = true) => ({
  enabled,
  displayName: 'Main sender',
  schemaVersion: '1.15.0',
  minReceiverVersion: '',
  pollSeconds: 30,
  relayUrl: r.url,
  relayToken: r.token,
});

beforeAll(async () => {
  if (!CFG) return;
  resetElectronStub(dir);
  registerPairingIpc();
  ownCode = (await invoke<{ ownCode: string }>('host:pairing-configure', config(CFG.a))).ownCode;
});

afterAll(async () => {
  if (!CFG) return;
  await invoke('host:pairing-configure', config(CFG.a, false));
});

describe.skipIf(!CFG)('main-process card sharing across servers (real relays)', () => {
  it('a cross-server recipient is reached via the outbox, with a code to reply to', async () => {
    const { a, b } = CFG!;
    const bob = createPairingKeystore(path.join(dir, 'bob.json'));
    const res = await invoke<Record<string, number>>('host:pairing-send', {
      recipientCodes: [formatPairingCode(bob.ownPublicCode(), b.url)],
      item: ITEM,
    });
    expect(res).toMatchObject({ ok: 1, fail: 0, peerFail: 0 });
    const [msg] = await mailbox(b, routingId(bob.ownPublicCode()));
    expect(msg!['viaRelay']).toBe(a.url);
    const inner = bob.open(msg as never) as { senderCode: string };
    expect(inner.senderCode).toBe(formatPairingCode(ownCode, a.url));
  });

  it('a same-server recipient is the unchanged local send (plain sender code)', async () => {
    const { a } = CFG!;
    const carol = createPairingKeystore(path.join(dir, 'carol.json'));
    // Even when addressed with a cross-server code naming OUR relay.
    const res = await invoke<Record<string, number>>('host:pairing-send', {
      recipientCodes: [formatPairingCode(carol.ownPublicCode(), a.url)],
      item: ITEM,
    });
    expect(res).toMatchObject({ ok: 1, fail: 0 });
    const [msg] = await mailbox(a, routingId(carol.ownPublicCode()));
    expect(msg!['viaRelay']).toBeUndefined();
    expect((carol.open(msg as never) as { senderCode: string }).senderCode).toBe(ownCode);
  });

  it('mail from another server lands attributed to the verified relay', async () => {
    const { a, b } = CFG!;
    const dave = createPairingKeystore(path.join(dir, 'dave.json'));
    const bundle = dave.seal(
      { schemaVersion: '1.15.0', senderCode: dave.ownPublicCode(), senderName: 'Dave', item: { ...ITEM, label: 'from dave' } },
      ownCode,
    );
    const post = await fetch(`${b.url}/federation/v1/outbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, recipientCode: routingId(ownCode), recipientRelay: a.url, sentAt: Date.now(), ...bundle }),
    });
    expect(post.status).toBe(202);
    const end = Date.now() + 30_000;
    let got: { senderCode: string; senderName: string } | undefined;
    while (!got) {
      const inbox = await invoke<Array<{ label: string; senderCode: string; senderName: string }>>('host:pairing-inbox-list');
      got = inbox.find((i) => i.label === 'from dave');
      if (!got && Date.now() > end) throw new Error('not received');
      if (!got) await sleep(200);
    }
    expect(got.senderName).toBe('Dave');
    expect(got.senderCode).toBe(formatPairingCode(dave.ownPublicCode(), b.url));
  });

  it('a non-federating destination is a federation failure, not a credential decline', async () => {
    const { c } = CFG!;
    const res = await invoke<Record<string, number>>('host:pairing-send', {
      recipientCodes: [formatPairingCode('cmk1.' + 'Z'.repeat(43), c.url)],
      item: ITEM,
    });
    expect(res).toMatchObject({ ok: 0, fail: 1, peerFail: 1, authFail: 0 });
  });
});
