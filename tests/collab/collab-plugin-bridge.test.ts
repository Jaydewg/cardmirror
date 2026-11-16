// @vitest-environment jsdom
/**
 * The collab-ui surface the plugin API's `collab.*` permissions sit on:
 * precise join outcomes (the boolean return can't tell "joined" from
 * "that room ended"), and the per-doc session lookups (public facts and
 * the edit code — never for a spectator seat).
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { collabPluginsFor, tagCollabTransaction } from '../../src/editor/collab/collab-hooks.js';
import { settings } from '../../src/editor/settings.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import * as collabUi from '../../src/editor/collab/collab-ui.js';
import { viewCodeFromShareCode } from '../../src/editor/collab/collab-crypto.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { canonRelayUrl } from '../../src/editor/collab/server-address.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { settle, simpleDoc } from './_loro-helpers.js';

let mock: RoomsMock;

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

function mkView(uid: string): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const state = EditorState.create({ doc: simpleDoc('local copy'), plugins: collabPluginsFor(uid) });
  const view: EditorView = new EditorView(el, {
    state,
    dispatchTransaction(tx) {
      tagCollabTransaction(tx);
      view.updateState(view.state.apply(tx));
    },
  });
  return view;
}

function depsFor(uid: string, view: EditorView, newSessionDoc: () => boolean = () => true) {
  return {
    getView: () => view,
    getOwnerUid: () => uid,
    refreshPlugins: () => view.updateState(view.state.reconfigure({ plugins: collabPluginsFor(uid) })),
    newSessionDoc,
  };
}

function clickPromptButton(label: string): void {
  const btn = [...document.querySelectorAll('.pmd-route-overlay button')].find((b) => {
    const strong = b.querySelector('strong');
    return (strong ? strong.textContent : b.textContent) === label;
  }) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no prompt button labeled "${label}"`);
  btn.click();
}

async function hostRoom(): Promise<{ host: CollabSession; shareCode: string }> {
  const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
  const { session: host, shareCode } = await CollabSession.host({ pmDoc: simpleDoc('host doc'), client });
  return { host, shareCode };
}

describe('join outcomes', () => {
  it('reports invalid, cancelled, joined and ended distinctly', async () => {
    const uid = 'bridge-joiner';
    const v = mkView(uid);
    const outcomes: string[] = [];
    const report = (o: string): void => void outcomes.push(o);

    await collabUi.joinSessionWithCode(depsFor(uid, v), 'not-a-code', { report });
    const { host, shareCode } = await hostRoom();
    await collabUi.joinSessionWithCode(depsFor(uid, v, () => false), shareCode, { report });
    expect(await collabUi.joinSessionWithCode(depsFor(uid, v), shareCode, { report })).toBe(true);
    await settle();
    expect(outcomes).toEqual(['invalid', 'cancelled', 'joined']);

    // Session lookups for the joined doc: public facts + the edit code.
    const info = collabUi.sessionInfoForUid(uid)!;
    expect(info.roomId).toBe(host.roomId);
    expect(info.role).toBe('participant');
    const self = canonRelayUrl(mock.url)!;
    expect(info.server).toBe(self);
    expect(info.crossServer).toBe('unsupported');
    expect(collabUi.editShareCodeForUid(uid)).toBe(shareCode);
    // Addresses: the code plus this machine's server, edit and view.
    expect(collabUi.editAddressForUid(uid)).toBe(`${shareCode}@${self}`);
    expect(collabUi.viewCodeForUid(uid)).toBe(viewCodeFromShareCode(shareCode));
    expect(collabUi.viewAddressForUid(uid)).toBe(`${viewCodeFromShareCode(shareCode)}@${self}`);
    expect(collabUi.editAddressForUid('no-such-doc')).toBeNull();
    expect(collabUi.viewCodeForUid('no-such-doc')).toBeNull();
    expect(collabUi.viewAddressForUid('no-such-doc')).toBeNull();
    expect(collabUi.sessionInfoForUid('no-such-doc')).toBeNull();
    expect(collabUi.editShareCodeForUid('no-such-doc')).toBeNull();

    // Leave, then end the room: a second join reports `ended` (and still
    // returns true — the boolean the old callers rely on).
    const leave = collabUi.endSessionFlow(depsFor(uid, v));
    await settle();
    clickPromptButton('Leave Session');
    await leave;
    await host.end();
    outcomes.length = 0;
    expect(await collabUi.joinSessionWithCode(depsFor(uid, v), shareCode, { report })).toBe(true);
    expect(outcomes).toEqual(['ended']);
    document.getElementById('collab-chip')!.hidden = true;
    v.destroy();
  }, 30_000);

  it('a spectator seat yields no edit code', async () => {
    mock.setViewPass('VIEW-PASS'); // the mock relay mints view passes only when set
    const uid = 'bridge-spectator';
    const v = mkView(uid);
    const { host, shareCode } = await hostRoom();
    const outcomes: string[] = [];
    await collabUi.joinSessionWithCode(depsFor(uid, v), viewCodeFromShareCode(shareCode)!, {
      report: (o) => void outcomes.push(o),
    });
    await settle();
    expect(outcomes).toEqual(['joined']);
    expect(collabUi.sessionInfoForUid(uid)!.role).toBe('spectator');
    expect(collabUi.editShareCodeForUid(uid)).toBeNull();
    expect(collabUi.editAddressForUid(uid)).toBeNull();
    // A spectator still has the view address to hand on.
    expect(collabUi.viewAddressForUid(uid)).toBe(`${viewCodeFromShareCode(shareCode)}@${canonRelayUrl(mock.url)}`);
    const stop = collabUi.endSessionFlow(depsFor(uid, v));
    await settle();
    clickPromptButton('Stop Watching');
    await stop;
    await host.end();
    document.getElementById('collab-chip')!.hidden = true;
    v.destroy();
  }, 30_000);
});

describe('probeShareCode', () => {
  it('live while hosted, ended after the host ends, unknown for codes it cannot route', async () => {
    const { host, shareCode } = await hostRoom();
    expect(await collabUi.probeShareCode(shareCode)).toBe('live');
    await host.end();
    expect(await collabUi.probeShareCode(shareCode)).toBe('ended');
    expect(await collabUi.probeShareCode('not-a-code')).toBe('unknown');
  }, 30_000);
});

describe('servers and session addresses', () => {
  const OTHER = 'https://other-server.example/relay';

  it('names this machine\'s server and what this build can reach', async () => {
    const self = canonRelayUrl(mock.url)!;
    expect(await collabUi.currentServer()).toEqual({ url: self, host: new URL(self).hostname, nickname: null });
    expect(await collabUi.serverReach(`${self}/`)).toBe('home');
    expect(await collabUi.serverReach(OTHER)).toBe('unreachable');
    expect(await collabUi.serverReach('not a url')).toBe('unknown');
  });

  it('a plain code resolves to this server; f and plain addresses parse alike', async () => {
    const self = canonRelayUrl(mock.url)!;
    const { host, shareCode } = await hostRoom();
    const plain = await collabUi.parseAddressForPlugin(shareCode);
    expect(plain).toMatchObject({ code: shareCode, roomId: host.roomId, server: self, view: false });
    const fCode = shareCode.replace(/^cmshare(\d+)/, 'cmshare$1f');
    expect(await collabUi.parseAddressForPlugin(`${fCode}@${self}`)).toEqual(plain);
    expect(await collabUi.parseAddressForPlugin(`${shareCode}@${self}`)).toEqual(plain);
    expect(await collabUi.parseAddressForPlugin(fCode)).toBeNull(); // f needs a server
    await host.end();
  }, 30_000);

  it('probes by address: own server live, another server unreachable without a request', async () => {
    const self = canonRelayUrl(mock.url)!;
    const { host, shareCode } = await hostRoom();
    const fCode = shareCode.replace(/^cmshare(\d+)/, 'cmshare$1f');
    expect(await collabUi.probeShareCode(`${shareCode}@${self}`)).toBe('live');
    expect(await collabUi.probeShareCode(`${fCode}@${self}`)).toBe('live');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await collabUi.probeShareCode(`${shareCode}@${OTHER}`)).toBe('unreachable');
    expect(await collabUi.probeShareCode(`${fCode}@${OTHER}`)).toBe('unreachable');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await collabUi.routeSessionAddress(`${shareCode}@${OTHER}`)).toEqual({ kind: 'unreachable' });
    expect(await collabUi.routeSessionAddress(`${fCode}@${self}`)).toEqual({
      kind: 'here',
      code: shareCode,
      roomId: host.roomId,
    });
    expect(await collabUi.routeSessionAddress('nope')).toEqual({ kind: 'invalid' });
    await host.end();
  }, 30_000);
});
