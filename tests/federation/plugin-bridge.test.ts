// @vitest-environment jsdom
/**
 * The plugin API's `collab.*` bridge on a FEDERATION build: which servers
 * this machine reaches (from its relay's peer answers), how a plain or
 * f address on another server becomes the cross-server code the join
 * flow takes, liveness through the federation proxy without asking to
 * join, the join outcomes a cross-server admission produces, and a
 * session's public facts when the relay federates.
 *
 * Runs against the rooms mock in its opt-in federation mode (no real
 * second relay; tests/federation/real-relays*.test.ts cover those).
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { collabPluginsFor, tagCollabTransaction } from '../../src/editor/collab/collab-hooks.js';
import { settings } from '../../src/editor/settings.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import * as collabUi from '../../src/editor/collab/collab-ui.js';
import { decodeShareCode, encodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { clearPeerReachCache } from '../../src/editor/federation/collab-federation.js';
import { refreshOwnRelayFederation } from '../../src/editor/federation/self.js';
import { startRoomsMock, type MockFederation, type RoomsMock } from '../collab/_rooms-mock.js';
import { settle, simpleDoc } from '../collab/_loro-helpers.js';

const HOME = 'https://home.example/relay'; // this relay's federation identity
const OTHER = 'https://other.example/relay';
const REFUSED = 'https://refused.example/relay';
const DOWN = 'https://down.example/relay';
const ROOM = '0123456789abcdef0123456789abcdef';
const KEY = new Uint8Array(32).map((_, i) => i + 1);
const PLAIN = encodeShareCode(ROOM, KEY);
const F_OTHER = encodeShareCode(ROOM, KEY, undefined, OTHER);
const PASS_STORE = 'cm-fed-room-passes';

let mock: RoomsMock;
let fed: MockFederation;

async function federate(on: boolean): Promise<void> {
  mock.setFederation(on ? fed : null);
  await refreshOwnRelayFederation(true);
  clearPeerReachCache();
}

beforeAll(async () => {
  mock = await startRoomsMock();
  (window as unknown as { electronAPI?: unknown }).electronAPI = {};
  localStorage.setItem('pmd-collab', '1');
  settings.set('pairingRelayUrl', mock.url);
  settings.set('pairingRelayToken', mock.token);
  const chip = document.createElement('div');
  chip.id = 'collab-chip';
  chip.hidden = true;
  document.body.appendChild(chip);
  window.confirm = vi.fn(() => true);
});

afterAll(async () => {
  await mock.close();
  localStorage.removeItem('pmd-collab');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

beforeEach(async () => {
  fed = {
    url: HOME,
    nickname: 'Home',
    peers: {
      [OTHER]: { permitted: true, reachable: true, federates: true },
      [REFUSED]: { permitted: false, reachable: null, federates: null },
      [DOWN]: { permitted: true, reachable: false, federates: null },
    },
    viaRooms: {},
    joinAnswers: {},
  };
  localStorage.removeItem(PASS_STORE);
  settings.set('collabCrossServerCodes', false);
  await federate(true);
});

describe('servers', () => {
  it('names this relay by its federation identity, under either of its URLs', async () => {
    expect(await collabUi.currentServer()).toEqual({ url: HOME, host: 'home.example', nickname: 'Home' });
    expect(await collabUi.serverReach(HOME)).toBe('home');
    expect(await collabUi.serverReach(mock.url)).toBe('home');
  });

  it('reach of another server is the relay’s peer answer, cached for a minute', async () => {
    expect(await collabUi.serverReach(OTHER)).toBe('federated');
    expect(await collabUi.serverReach(REFUSED)).toBe('unreachable');
    expect(await collabUi.serverReach(DOWN)).toBe('unknown');
    await collabUi.serverReach(OTHER);
    expect(mock.federationCalls().peers.filter((u) => u === OTHER)).toHaveLength(1);
  });

  it('a relay that doesn’t federate reaches no other server, without asking it', async () => {
    await federate(false);
    const before = mock.federationCalls().peers.length;
    expect(await collabUi.serverReach(OTHER)).toBe('unreachable');
    expect(mock.federationCalls().peers).toHaveLength(before);
  });
});

describe('routing addresses', () => {
  it('an edit address on a reachable server becomes its cross-server code, plain or f', async () => {
    for (const address of [`${PLAIN}@${OTHER}`, F_OTHER]) {
      const route = await collabUi.routeSessionAddress(address);
      expect(route).toMatchObject({ kind: 'remote', roomId: ROOM, server: OTHER });
      const decoded = decodeShareCode((route as { code: string }).code)!;
      expect(decoded.home).toBe(OTHER);
      expect(decoded.roomId).toBe(ROOM);
    }
  });

  it('an unknown reach is still tried (the join flow explains a refusal)', async () => {
    expect(await collabUi.routeSessionAddress(`${PLAIN}@${DOWN}`)).toMatchObject({ kind: 'remote', server: DOWN });
  });

  it('a refused server, or a VIEW address on another server, is unreachable', async () => {
    expect(await collabUi.routeSessionAddress(`${PLAIN}@${REFUSED}`)).toEqual({ kind: 'unreachable' });
    const view = PLAIN.replace(/^cmshare/, 'cmview');
    expect(await collabUi.routeSessionAddress(`${view}@${OTHER}`)).toEqual({ kind: 'unreachable' });
  });

  it('an address naming this relay’s identity is "here", with the plain code', async () => {
    expect(await collabUi.routeSessionAddress(`${PLAIN}@${HOME}`)).toEqual({ kind: 'here', code: PLAIN, roomId: ROOM });
  });
});

describe('probing a session on another server', () => {
  const probe = () => collabUi.probeShareCode(`${PLAIN}@${OTHER}`);

  it('maps the home relay’s answers: any admission state or an unknown pass is live; 404/410 ended', async () => {
    const cases: [{ status: number; error?: string } | undefined, string][] = [
      [{ status: 401, error: 'pass-invalid' }, 'live'],
      [{ status: 403, error: 'join-pending' }, 'live'],
      [{ status: 403, error: 'join-denied' }, 'live'],
      [{ status: 200 }, 'live'],
      [{ status: 410, error: 'session ended' }, 'ended'],
      [undefined, 'ended'], // 404 no such room
      [{ status: 403, error: 'home-refused' }, 'unreachable'],
      [{ status: 409, error: 'home-not-federating' }, 'unreachable'],
      [{ status: 503, error: 'home-unreachable' }, 'unknown'],
    ];
    for (const [answer, want] of cases) {
      fed.viaRooms = answer ? { [ROOM]: answer } : {};
      expect(await probe(), JSON.stringify(answer)).toBe(want);
    }
  });

  it('without an admission it sends a fresh, well-formed pass and never stores it', async () => {
    fed.viaRooms = { [ROOM]: { status: 401, error: 'pass-invalid' } };
    await probe();
    const [, pass] = mock.federationCalls().via.at(-1)!.split('|');
    expect(pass).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(localStorage.getItem(PASS_STORE)).toBeNull();
  });

  it('with an admission for the room it uses that pass', async () => {
    const stored = 'S'.repeat(32);
    localStorage.setItem(PASS_STORE, JSON.stringify({ [ROOM]: { pass: stored, home: OTHER, mode: 'write', at: 1 } }));
    fed.viaRooms = { [ROOM]: { status: 200 } };
    expect(await probe()).toBe('live');
    expect(mock.federationCalls().via.at(-1)).toBe(`${ROOM}|${stored}`);
  });

  it('a refused server is unreachable without touching the proxy', async () => {
    const before = mock.federationCalls().via.length;
    expect(await collabUi.probeShareCode(`${PLAIN}@${REFUSED}`)).toBe('unreachable');
    expect(mock.federationCalls().via).toHaveLength(before);
  });
});

function mkView(uid: string): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view: EditorView = new EditorView(el, {
    state: EditorState.create({ doc: simpleDoc('local copy'), plugins: collabPluginsFor(uid) }),
    dispatchTransaction(tx) {
      tagCollabTransaction(tx);
      view.updateState(view.state.apply(tx));
    },
  });
  return view;
}

function depsFor(uid: string, view: EditorView) {
  return {
    getView: () => view,
    getOwnerUid: () => uid,
    refreshPlugins: () => view.updateState(view.state.reconfigure({ plugins: collabPluginsFor(uid) })),
    newSessionDoc: () => true,
  };
}

describe('joining a session on another server', () => {
  async function joinOutcome(): Promise<string[]> {
    const route = await collabUi.routeSessionAddress(`${PLAIN}@${OTHER}`);
    const code = route.kind === 'remote' ? route.code : F_OTHER;
    const outcomes: string[] = [];
    const v = mkView(`fed-join-${Math.random()}`);
    await collabUi.joinSessionWithCode(depsFor('fed-join', v), code, { report: (o) => void outcomes.push(o) });
    v.destroy();
    return outcomes;
  }

  it('a declined admission reports `declined`', async () => {
    fed.joinAnswers = { [ROOM]: { state: 'denied' } };
    expect(await joinOutcome()).toEqual(['declined']);
  });

  it('a room that ended reports `ended`', async () => {
    fed.joinAnswers = { [ROOM]: { status: 410, error: 'session ended' } };
    expect(await joinOutcome()).toEqual(['ended']);
  });

  it('no route reports `unreachable`; an expired request `failed`', async () => {
    fed.joinAnswers = { [ROOM]: { status: 403, error: 'home-refused' } };
    expect(await joinOutcome()).toEqual(['unreachable']);
    fed.joinAnswers = { [ROOM]: { state: 'expired' } };
    expect(await joinOutcome()).toEqual(['failed']);
  });
});

describe('a session on this relay when it federates', () => {
  it('is open to other servers; its code is what "Copy code" gives; its address names this relay', async () => {
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    const { session: host, shareCode } = await CollabSession.host({ pmDoc: simpleDoc('host doc'), client });
    const uid = 'fed-local';
    const v = mkView(uid);
    expect(await collabUi.joinSessionWithCode(depsFor(uid, v), shareCode)).toBe(true);
    await settle();

    const info = collabUi.sessionInfoForUid(uid)!;
    expect(info.server).toBe(HOME);
    expect(info.crossServer).toBe('federated');
    expect(collabUi.editShareCodeForUid(uid)).toBe(shareCode); // plain by default
    expect(collabUi.editAddressForUid(uid)).toBe(`${shareCode}@${HOME}`);
    settings.set('collabCrossServerCodes', true);
    expect(decodeShareCode(collabUi.editShareCodeForUid(uid)!)!.home).toBe(HOME);
    expect(collabUi.editAddressForUid(uid)).toBe(`${shareCode}@${HOME}`); // addresses stay plain

    await host.end();
    v.destroy();
  }, 30_000);
});
