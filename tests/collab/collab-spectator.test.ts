// @vitest-environment jsdom
/**
 * Spectator sessions (view-only, 2026-10-24).
 *
 * Pinned:
 *  - a spectator's editor refuses local document changes (the lock
 *    plugin) while the binding's remote imports still land
 *  - a spectator session posts no updates or snapshots — even when a
 *    local change is forced past the view
 *  - its presence: on a relay that refuses it (upstream's 403) the
 *    session marks it refused and stops posting (the minimal UI); on a
 *    relay that takes it, partners receive it stamped as a spectator's
 *  - the host learns the watcher count
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { settle, sleep, simpleDoc, docText, typeAfter, mkView } from './_loro-helpers.js';

let mock: RoomsMock;
beforeAll(async () => {
  mock = await startRoomsMock();
  mock.setViewPass('VIEW-PASS');
});
afterAll(async () => {
  await mock.close();
});

describe('spectator session', () => {
  it('sees edits, cannot make them, posts nothing; host sees the watcher count', async () => {
    const hostClient = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    const hostWatchers: number[] = [];
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('hello from host'),
      client: hostClient,
      flushMs: 20,
      minBackoffMs: 20,
      maxBackoffMs: 60,
      callbacks: { onWatchers: (n) => hostWatchers.push(n) },
    });
    expect(host.viewPass).toBe('VIEW-PASS');
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    await sleep(80);
    expect(hostWatchers).toEqual([0]);

    const decoded = decodeShareCode(shareCode)!;
    const viewerClient = new RoomsClient({ baseUrl: () => mock.url, token: () => 'VIEW-PASS', guestAuth: true });
    const spectator = await CollabSession.join({
      roomId: decoded.roomId,
      keyBytes: decoded.keyBytes,
      role: 'spectator',
      client: viewerClient,
      flushMs: 20,
      minBackoffMs: 20,
      maxBackoffMs: 60,
    });
    expect(spectator.role).toBe('spectator');
    expect(spectator.readOnly).toBe(true);
    const specView = mkView(spectator.plugins());
    await settle();
    spectator.start();
    await sleep(120);
    expect(docText(specView.state.doc)).toContain('hello from host');
    expect(hostWatchers).toEqual([0, 1]);

    // Host types → spectator sees it (remote imports pass the lock).
    typeAfter(hostView, 'hello from host', ' + more');
    await sleep(200);
    expect(docText(specView.state.doc)).toContain('hello from host + more');

    // Spectator types → refused locally, nothing reaches the room.
    const before = mock.updateCount(decoded.roomId);
    const specBefore = docText(specView.state.doc);
    typeAfter(specView, 'hello from host', ' SPECTATOR');
    expect(docText(specView.state.doc)).toBe(specBefore);
    await spectator.sendPresence(new Uint8Array([1, 2, 3]));
    spectator.flush();
    await sleep(150);
    expect(mock.updateCount(decoded.roomId)).toBe(before);
    expect(docText(hostView.state.doc)).not.toContain('SPECTATOR');
    // This mock relay refuses a spectator's presence, like upstream's.
    expect(spectator.spectatorPresence).toBe('refused');

    await spectator.stop();
    await sleep(100);
    expect(hostWatchers).toEqual([0, 1, 0]);
    await host.stop();
    hostView.destroy();
    specView.destroy();
  }, 15_000);

  it('on a relay that carries spectator presence, partners receive it stamped', async () => {
    mock.setSpectatorPresence(true);
    try {
      const hostClient = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
      const seen: Array<{ bytes: number[]; viewer: boolean }> = [];
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('watched doc'),
        client: hostClient,
        flushMs: 20,
        minBackoffMs: 20,
        maxBackoffMs: 60,
        callbacks: { onPresence: (b, viewer) => seen.push({ bytes: [...b], viewer }) },
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();
      await sleep(80);

      const decoded = decodeShareCode(shareCode)!;
      const states: string[] = [];
      const spectator = await CollabSession.join({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: 'spectator',
        client: new RoomsClient({ baseUrl: () => mock.url, token: () => 'VIEW-PASS', guestAuth: true }),
        flushMs: 20,
        minBackoffMs: 20,
        maxBackoffMs: 60,
        callbacks: { onSpectatorPresence: (st) => states.push(st) },
      });
      const specView = mkView(spectator.plugins());
      await settle();
      spectator.start();
      await sleep(120);

      await spectator.sendPresence(new Uint8Array([3, 9]));
      await sleep(120);
      expect(spectator.spectatorPresence).toBe('ok');
      expect(states).toEqual(['ok']);
      expect(seen.some((f) => f.viewer && f.bytes.join() === '3,9')).toBe(true);

      await spectator.stop();
      await host.stop();
      hostView.destroy();
      specView.destroy();
    } finally {
      mock.setSpectatorPresence(false);
    }
  }, 15_000);
});
