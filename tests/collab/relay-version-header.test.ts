/**
 * Every relay request must name the running build.
 *
 * The relay cannot otherwise tell versions apart — the app version that
 * travels with a shared card lives INSIDE the sealed envelope, so the
 * server can't read it. This header is the only channel, and a planned
 * minimum-version gate depends on it being present on every call. Losing
 * it would be invisible until the gate started refusing real users, so
 * it is pinned here.
 */

import { describe, it, expect } from 'vitest';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  RELAY_CLIENT_ROUTING_HEADER,
  RELAY_CLIENT_VERSION_HEADER,
  numericVersion,
} from '../../src/editor/relay-protocol.js';
import { appVersion } from '../../src/editor/install-info.js';

/** What a relay without `client.versionFlags` is sent: the numeric
 *  version, without any feature flags the manifest carries (`1.16.1-f`
 *  → `1.16.1`). Equal to `appVersion` for a plain numeric manifest. */
const wireAppVersion = numericVersion(appVersion);

/** Capture the headers of every request the client makes. */
function recordingClient(routingCode?: () => string): {
  client: RoomsClient;
  sent: Record<string, string>[];
} {
  const sent: Record<string, string>[] = [];
  const client = new RoomsClient({
    baseUrl: () => 'https://relay.example/relay',
    token: () => 'test-token',
    ...(routingCode ? { routingCode } : {}),
    fetchImpl: (_input, init) => {
      sent.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return Promise.resolve(
        new Response(JSON.stringify({ roomId: 'room-1', seq: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
  return { client, sent };
}

describe('relay client version header', () => {
  it('is sent on a rooms request, carrying the running app version', async () => {
    const { client, sent } = recordingClient();
    await client.createRoom();
    expect(sent).toHaveLength(1);
    expect(sent[0]![RELAY_CLIENT_VERSION_HEADER]).toBe(wireAppVersion);
  });

  it('survives calls that add their own headers', async () => {
    // postUpdate passes a Content-Type through the same helper — the
    // spread must not drop the version on the way.
    const { client, sent } = recordingClient();
    await client.postUpdate('room-1', new Uint8Array([1, 2, 3]));
    expect(sent[0]!['Content-Type']).toBe('application/octet-stream');
    expect(sent[0]![RELAY_CLIENT_VERSION_HEADER]).toBe(wireAppVersion);
  });

  it('keeps sending the Authorization header alongside it', async () => {
    const { client, sent } = recordingClient();
    await client.createRoom();
    expect(sent[0]!['Authorization']).toBe('Bearer test-token');
  });

  it('names a header the relay can read (ASCII, no spaces)', () => {
    expect(RELAY_CLIENT_VERSION_HEADER).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('matches the desktop main process\'s local copy of the header name', async () => {
    // pairing-ipc.ts declares the constant locally (the desktop tsc's
    // rootDir excludes src/, so it cannot VALUE-import relay-protocol).
    // This pin is what keeps the two copies from drifting.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../apps/desktop/src/pairing-ipc.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain(`RELAY_CLIENT_VERSION_HEADER = '${RELAY_CLIENT_VERSION_HEADER}'`);
  });
});

describe('relay client routing header (entitlement machine binding)', () => {
  // The relay's machine-binding check rejects gated entitlement requests
  // whose X-CardMirror-Routing header is absent or mismatched. Once that
  // toggle flips, silently losing this header would lock every linked
  // machine out of co-editing — pinned like the version header above.

  it('is sent when a routing code is supplied', async () => {
    const { client, sent } = recordingClient(() => 'rc-machine-a');
    await client.createRoom();
    expect(sent[0]![RELAY_CLIENT_ROUTING_HEADER]).toBe('rc-machine-a');
    // ...and never displaces its neighbors.
    expect(sent[0]![RELAY_CLIENT_VERSION_HEADER]).toBe(wireAppVersion);
    expect(sent[0]!['Authorization']).toBe('Bearer test-token');
  });

  it('is omitted entirely when the code is empty or unsupplied', async () => {
    // Shared-token and self-hosted requests have no rc claim to match; a
    // blank header would FAIL the binding check rather than skip it.
    const bare = recordingClient();
    await bare.client.createRoom();
    expect(RELAY_CLIENT_ROUTING_HEADER in bare.sent[0]!).toBe(false);

    const blank = recordingClient(() => '');
    await blank.client.createRoom();
    expect(RELAY_CLIENT_ROUTING_HEADER in blank.sent[0]!).toBe(false);
  });

  it('survives calls that add their own headers', async () => {
    const { client, sent } = recordingClient(() => 'rc-machine-a');
    await client.postUpdate('room-1', new Uint8Array([1, 2, 3]));
    expect(sent[0]!['Content-Type']).toBe('application/octet-stream');
    expect(sent[0]![RELAY_CLIENT_ROUTING_HEADER]).toBe('rc-machine-a');
  });

  it('names a header the relay can read (ASCII, no spaces)', () => {
    expect(RELAY_CLIENT_ROUTING_HEADER).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('matches the desktop main process\'s local copy of the header name', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../apps/desktop/src/pairing-ipc.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain(`RELAY_CLIENT_ROUTING_HEADER = '${RELAY_CLIENT_ROUTING_HEADER}'`);
  });

  it('rides the SSE stream fetch too (separate header construction)', async () => {
    const { RoomStream } = await import('../../src/editor/collab/room-client.js');
    const seen: Record<string, string>[] = [];
    const stream = new RoomStream({
      baseUrl: () => 'https://relay.example/relay',
      token: () => 'test-token',
      routingCode: () => 'rc-machine-a',
      roomId: 'room-1',
      minBackoffMs: 1,
      maxBackoffMs: 1,
      callbacks: {
        onHello: () => {},
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
      },
      fetchImpl: (_input, init) => {
        seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
        // 410 = tombstoned: the stream stops cleanly after one request.
        return Promise.resolve(new Response(null, { status: 410 }));
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0]![RELAY_CLIENT_ROUTING_HEADER]).toBe('rc-machine-a');
    expect(seen[0]![RELAY_CLIENT_VERSION_HEADER]).toBe(wireAppVersion);
  });
});
