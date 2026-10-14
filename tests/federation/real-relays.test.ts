// @vitest-environment jsdom
/**
 * Cross-server co-editing against REAL relays (relay/server.py), end to
 * end through the app's own transport and session layers: a host on
 * relay A, a participant on relay B reaching A only through B's
 * federation proxy (relay/FEDERATION.md §6).
 *
 * Skipped unless FED_RELAYS is set — a JSON object of three running
 * relays: { a: {url, token}, b: {url, token}, c: {url, token} } where
 * A and B federate and C does not. relay/tests/run_client_federation.py
 * starts them and runs this file.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RoomsClient, RoomsError, ROOM_PASS_HEADER } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode, encryptBlob, decryptBlob, importRoomKey } from '../../src/editor/collab/collab-crypto.js';
import {
  collabReadOnlyPlugin,
  createJoinRequestWatcher,
  remoteHomeOf,
  remoteRoomClient,
  requestRemoteAdmission,
  storedRoomPass,
} from '../../src/editor/federation/collab-federation.js';
import { refreshOwnRelayFederation } from '../../src/editor/federation/self.js';
import { settings } from '../../src/editor/settings.js';
import { relayHome64 } from '../../src/editor/federation/address.js';
import { mkView, settle, sleep, simpleDoc, docText, typeAfter } from '../collab/_loro-helpers.js';

interface RelayCfg {
  url: string;
  token: string;
}
const CFG = process.env['FED_RELAYS']
  ? (JSON.parse(process.env['FED_RELAYS']) as { a: RelayCfg; b: RelayCfg; c: RelayCfg })
  : null;

const FAST = { flushMs: 25, minBackoffMs: 50, maxBackoffMs: 400, catchUpMs: 60_000 };

function local(r: RelayCfg): RoomsClient {
  return new RoomsClient({ baseUrl: () => r.url, token: () => r.token });
}

function via(joiner: RelayCfg, home: RelayCfg, pass: () => string): RoomsClient {
  return new RoomsClient({
    baseUrl: () => `${joiner.url}/federation/v1/via/${relayHome64(home.url)}`,
    token: () => joiner.token,
    extraHeaders: () => ({ [ROOM_PASS_HEADER]: pass() }),
    federated: true,
  });
}

async function until(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

describe.skipIf(!CFG)('federated co-editing (real relays)', () => {
  it('admission, live two-way editing, read-only, and revocation', async () => {
    const { a, b } = CFG!;
    // Host on A.
    const hostClient = local(a);
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('hello from alpha'),
      client: hostClient,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    let joinNudges = 0;
    // (The host session's callbacks are fixed at construction; observe
    // join requests by listing — the nudge path is covered by the relay
    // suite's `j` frame assertions.)
    cleanup.push(() => host.stop());
    const { roomId, keyBytes } = decodeShareCode(shareCode)!;
    const key = await importRoomKey(keyBytes);

    // Joiner on B asks to join (pass + room-key-sealed intro).
    const pass = 'p'.repeat(8) + crypto.randomUUID().replace(/-/g, '');
    const joinerClient = via(b, a, () => pass);
    const intro = await encryptBlob(key, new TextEncoder().encode(JSON.stringify({ v: 1, name: 'Bob' })));
    const req = await joinerClient.requestJoin(roomId, pass, intro);
    expect(req.state).toBe('pending');
    // Before approval the room's data is closed to them.
    const early = await joinerClient.fetchUpdates(roomId, 0).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(RoomsError);
    expect((early as RoomsError).code).toBe('join-pending');

    // Host side lists it (verified origin = B) and reads the intro.
    const listed = await hostClient.listJoinRequests(roomId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.origin).toBe(b.url);
    const name = JSON.parse(new TextDecoder().decode(await decryptBlob(key, listed[0]!.blob))).name;
    expect(name).toBe('Bob');
    await hostClient.decideJoinRequest(roomId, req.requestId, 'write');
    expect((await joinerClient.joinStatus(roomId)).mode).toBe('write');

    // The joiner's session runs entirely through B's proxy.
    let accessChanges: string[] = [];
    let revoked = false;
    let ended = false;
    const joiner = await CollabSession.join({
      roomId,
      keyBytes,
      client: joinerClient,
      ...FAST,
      callbacks: {
        onAccessChanged: (m) => accessChanges.push(m),
        onRevoked: () => (revoked = true),
        onEnded: () => (ended = true),
        onJoinRequests: () => joinNudges++,
      },
    });
    const joinView = mkView([...joiner.plugins(), collabReadOnlyPlugin(() => joiner.readOnly)]);
    await settle();
    joiner.start();
    cleanup.push(() => joiner.stop());
    await until(() => docText(joinView.state.doc).includes('hello from alpha'));

    // Live, both directions (seqs assigned by A, streamed through B).
    typeAfter(joinView, 'alpha', ' + beta');
    await until(() => docText(hostView.state.doc).includes('alpha + beta'));
    typeAfter(hostView, 'beta', ' + again');
    await until(() => docText(joinView.state.doc).includes('beta + again'));
    expect(joinNudges).toBeGreaterThan(0); // hello re-syncs access

    // Downgrade to read-only, live: the access frame arrives through B.
    await hostClient.decideJoinRequest(roomId, req.requestId, 'read');
    await until(() => accessChanges.includes('read'));
    expect(joiner.readOnly).toBe(true);
    const before = docText(joinView.state.doc);
    typeAfter(joinView, 'again', ' BLOCKED'); // the editor refuses it
    expect(docText(joinView.state.doc)).toBe(before);
    // ...while the host's edits still land.
    typeAfter(hostView, 'again', ' (host)');
    await until(() => docText(joinView.state.doc).includes('again (host)'));
    await sleep(200);
    expect(docText(hostView.state.doc)).not.toContain('BLOCKED');

    // Back to editing.
    accessChanges = [];
    await hostClient.decideJoinRequest(roomId, req.requestId, 'write');
    await until(() => accessChanges.includes('write'));
    typeAfter(joinView, '(host)', ' [bob again]');
    await until(() => docText(hostView.state.doc).includes('[bob again]'));

    // Revoke: terminal for the joiner, the room lives on for the host.
    await hostClient.decideJoinRequest(roomId, req.requestId, 'revoke');
    await until(() => revoked && ended);
    typeAfter(hostView, '[bob again]', ' after');
    await sleep(100);
    expect(docText(hostView.state.doc)).toContain('[bob again] after');
  }, 60_000);

  it('the app flows: waiting dialog ↔ host prompt — read-only, decline, decide later, cancel', async () => {
    const { a, b } = CFG!;
    // This window's app is on B; the room lives on A.
    settings.set('pairingRelayUrl', b.url);
    settings.set('pairingRelayToken', b.token);
    settings.set('pairingDisplayName', 'Bob the Remote');
    expect((await refreshOwnRelayFederation(true))?.url).toBe(b.url);
    const hostClient = local(a);
    const { roomId, keyBytes } = decodeShareCode((await CollabSession.host({
      pmDoc: simpleDoc('room for the dialogs'),
      client: hostClient,
      ...FAST,
    })).shareCode)!;
    expect(remoteHomeOf(a.url)).toBe(a.url);
    expect(remoteHomeOf(b.url)).toBeNull();
    const watcher = createJoinRequestWatcher({ roomId, client: hostClient, keyBytes, docTitle: () => 'Shared Doc' });
    cleanup.push(() => watcher.dispose());
    const text = (): string => document.body.textContent ?? '';
    const click = (label: string): void => {
      const btn = [...document.querySelectorAll('button')].find((x) => x.textContent === label);
      if (!btn) throw new Error(`no "${label}" button`);
      btn.click();
    };

    // 1. Accept (read-only).
    const first = requestRemoteAdmission({ roomId, home: a.url, keyBytes, pollMs: 50 });
    await until(() => text().includes('Waiting to be let in'));
    watcher.poke();
    await until(() => text().includes('wants to join from another server'));
    expect(text()).toContain('"Bob the Remote"');
    expect(text()).toContain('Beta (127.0.0.1)'); // nickname shown WITH the host
    expect(text()).toContain('"Shared Doc"');
    click('Accept (read-only)');
    const out = await first;
    expect(out.kind).toBe('admitted');
    expect(out.kind === 'admitted' && out.mode).toBe('read');
    await until(() => !text().includes('Waiting to be let in'));
    // A rejoin reuses the stored admission: no new request, no dialog.
    expect(storedRoomPass(roomId, a.url)?.mode).toBe('read');
    const again = await requestRemoteAdmission({ roomId, home: a.url, keyBytes, pollMs: 50 });
    expect(again.kind === 'admitted' && again.mode).toBe('read');
    expect((await hostClient.listJoinRequests(roomId)).filter((r) => r.state === 'pending')).toHaveLength(0);
    // Managing an admitted participant (Review Session Join Requests).
    const reviewing = watcher.review();
    await until(() => text().includes('Joined from another server, read-only.'));
    expect(text()).toContain('Bob the Remote (Beta (127.0.0.1))');
    click('Allow editing');
    await reviewing;
    const joinerView = remoteRoomClient(roomId, a.url)!;
    expect((await joinerView.joinStatus(roomId)).mode).toBe('write');

    // 2. A second room: "Decide later", then review → Decline.
    const room2 = decodeShareCode((await CollabSession.host({
      pmDoc: simpleDoc('second'),
      client: hostClient,
      ...FAST,
    })).shareCode)!;
    const w2 = createJoinRequestWatcher({ roomId: room2.roomId, client: hostClient, keyBytes: room2.keyBytes, docTitle: () => '' });
    cleanup.push(() => w2.dispose());
    const second = requestRemoteAdmission({ roomId: room2.roomId, home: a.url, keyBytes: room2.keyBytes, pollMs: 50 });
    await until(() => text().includes('Waiting to be let in'));
    w2.poke();
    await until(() => text().includes('wants to join from another server'));
    click('Decide later');
    await sleep(150);
    w2.poke(); // deferred: no re-prompt from a nudge…
    await sleep(300);
    expect(text()).not.toContain('wants to join from another server');
    w2.review(); // …until asked
    await until(() => text().includes('wants to join from another server'));
    click('Decline');
    const declined = await second;
    expect(declined).toEqual({ kind: 'refused', message: 'The session declined your request to join.' });
    expect(storedRoomPass(room2.roomId, a.url)).toBeNull();

    // 3. The joiner cancels while waiting: the request is withdrawn.
    const room3 = decodeShareCode((await CollabSession.host({
      pmDoc: simpleDoc('third'),
      client: hostClient,
      ...FAST,
    })).shareCode)!;
    const third = requestRemoteAdmission({ roomId: room3.roomId, home: a.url, keyBytes: room3.keyBytes, pollMs: 50 });
    await until(() => text().includes('Waiting to be let in'));
    await until(async () => (await hostClient.listJoinRequests(room3.roomId)).length === 1);
    click('Cancel request');
    expect((await third).kind).toBe('cancelled');
    await until(async () => (await hostClient.listJoinRequests(room3.roomId)).length === 0);

    // 4. Someone ELSE decides while this host's prompt is open: it closes.
    const room4 = decodeShareCode((await CollabSession.host({
      pmDoc: simpleDoc('fourth'),
      client: hostClient,
      ...FAST,
    })).shareCode)!;
    const w4 = createJoinRequestWatcher({ roomId: room4.roomId, client: hostClient, keyBytes: room4.keyBytes, docTitle: () => '' });
    cleanup.push(() => w4.dispose());
    const fourth = requestRemoteAdmission({ roomId: room4.roomId, home: a.url, keyBytes: room4.keyBytes, pollMs: 50 });
    // (The relay's j nudge fires once the request exists; wait for that.)
    await until(async () => (await hostClient.listJoinRequests(room4.roomId)).length === 1);
    w4.poke();
    await until(() => text().includes('wants to join from another server'));
    const [pending] = await hostClient.listJoinRequests(room4.roomId);
    await hostClient.decideJoinRequest(room4.roomId, pending!.requestId, 'write'); // "another participant"
    w4.poke(); // the j nudge
    await until(() => !text().includes('wants to join from another server'));
    const ok4 = await fourth;
    expect(ok4.kind === 'admitted' && ok4.mode).toBe('write');
  }, 60_000);

  it('a relay without federation is never mistaken for an ended room', async () => {
    const { a, c } = CFG!;
    const client = via(c, a, () => 'x'.repeat(30));
    const err = await client.fetchUpdates('ab'.repeat(16), 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).status).toBe(501);
    expect((err as RoomsError).code).toBe('relay-not-federating');
  });

  it('a home relay’s own "no such room" still reads as gone', async () => {
    const { a, b } = CFG!;
    const client = via(b, a, () => 'y'.repeat(30));
    const err = await client.requestJoin('cd'.repeat(16), 'z'.repeat(30), new Uint8Array([1])).catch(
      (e: unknown) => e,
    );
    expect((err as RoomsError).status).toBe(404);
  });
});
