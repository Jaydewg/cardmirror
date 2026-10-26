// @vitest-environment jsdom
/**
 * Spectator sessions (view-only, 2026-10-24).
 *
 * Pinned:
 *  - a spectator's editor refuses local document changes (the lock
 *    plugin) while the binding's remote imports still land
 *  - a spectator session posts NOTHING: no updates, no presence, no
 *    snapshots — even when a local change is forced past the view
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

    await spectator.stop();
    await sleep(100);
    expect(hostWatchers).toEqual([0, 1, 0]);
    await host.stop();
    hostView.destroy();
    specView.destroy();
  }, 15_000);
});
