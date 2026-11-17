// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/text-prompt.js', () => ({
  confirmDialog: vi.fn(() => Promise.resolve(true)),
  promptForRouteChoice: vi.fn(() => Promise.resolve('b')),
}));

vi.mock('../../src/editor/status-notices.js', () => ({
  postNotice: vi.fn(),
  clearNotice: vi.fn(),
}));
const hasPermission = vi.hoisted(() => ({ value: true }));
vi.mock('../../src/editor/plugin-registry.js', async (orig) => ({
  ...(await orig<typeof import('../../src/editor/plugin-registry.js')>()),
  pluginHasPermission: () => hasPermission.value,
}));

import { createPluginApi, type PluginGrantContext } from '../../src/editor/plugin-api.js';
import { clearNotice, postNotice } from '../../src/editor/status-notices.js';
import { confirmDialog, promptForRouteChoice } from '../../src/editor/text-prompt.js';

const deps = {
  appVersion: '0.1.0-test',
  getView: () => null,
  findViewForDocId: () => null,
  getDocIdentity: () => null,
  ensureDocId: () => null,
};

const V1_KEYS = [
  'appVersion',
  'docInfo',
  'extractSelection',
  'flowApps',
  'flowPost',
  'jumpToSource',
  'settings',
  'showToast',
  'storage',
];

function grant(granted: string[], declared: string[] = granted, name = 'Demo Plugin'): PluginGrantContext {
  return { granted: new Set(granted), declared, name };
}

beforeEach(() => {
  vi.mocked(confirmDialog).mockClear();
  vi.mocked(promptForRouteChoice).mockClear();
});

describe('api surface by grant', () => {
  it('without grants: exactly the v1 keys plus `permissions`', () => {
    const api = createPluginApi('demo', deps);
    expect(Object.keys(api).sort()).toEqual([...V1_KEYS, 'permissions'].sort());
    expect(api.ui).toBeUndefined();
    expect(api.permissions!.list()).toEqual([]);
  });

  it('`ui` appears only with ui.dialogs granted', () => {
    expect(createPluginApi('demo', deps, grant([], ['ui.dialogs'])).ui).toBeUndefined();
    expect(createPluginApi('demo', deps, grant(['ui.dialogs'])).ui).toBeDefined();
  });

  it('permissions.status explains a missing permission', () => {
    const api = createPluginApi('demo', deps, grant([], ['ui.dialogs', 'made.up']));
    expect(api.permissions!.has('ui.dialogs')).toBe(false);
    expect(api.permissions!.status('ui.dialogs')).toBe('denied');
    expect(api.permissions!.status('made.up')).toBe('unsupported');
    expect(api.permissions!.status('files.data')).toBe('undeclared');
    const granted = createPluginApi('demo', deps, grant(['ui.dialogs']));
    expect(granted.permissions!.status('ui.dialogs')).toBe('granted');
  });

  it('the grant snapshot cannot be mutated by the plugin', () => {
    const set = new Set(['ui.dialogs']);
    const api = createPluginApi('demo', deps, { granted: set, declared: ['ui.dialogs'], name: 'Demo' });
    set.clear(); // caller-side mutation after minting
    expect(api.permissions!.has('ui.dialogs')).toBe(true);
    api.permissions!.list().push('collab.shareCode');
    expect(api.permissions!.list()).toEqual(['ui.dialogs']);
    expect(Object.isFrozen(api.permissions)).toBe(true);
  });
});

describe('ui.dialogs', () => {
  it('choose labels the dialog with the plugin name and returns the value', async () => {
    const api = createPluginApi('demo', deps, grant(['ui.dialogs']));
    const res = await api.ui!.choose({
      message: 'Join?',
      choices: [
        { value: 'a', label: 'Join' },
        { value: 'b', label: 'Keep local', description: 'Stay offline' },
      ],
    });
    expect(res).toBe('b');
    const arg = vi.mocked(promptForRouteChoice).mock.calls[0]![0];
    expect(arg.message).toBe('[Demo Plugin] Join?');
    expect(arg.choices.map((c) => c.value)).toEqual(['a', 'b']);
  });

  it('choose caps text and rejects bad choice lists', async () => {
    const api = createPluginApi('demo', deps, grant(['ui.dialogs']));
    await api.ui!.choose({ message: 'x'.repeat(5000), choices: [{ value: 'a', label: 'y'.repeat(500) }] });
    const arg = vi.mocked(promptForRouteChoice).mock.calls[0]![0];
    expect(arg.message.length).toBeLessThan(330);
    expect(arg.choices[0]!.label.length).toBeLessThanOrEqual(80);
    await expect(api.ui!.choose({ message: 'm', choices: [] })).rejects.toThrow(/at least one/);
    await expect(
      api.ui!.choose({ message: 'm', choices: [{ value: 'a', label: '1' }, { value: 'a', label: '2' }] }),
    ).rejects.toThrow(/unique/);
    await expect(
      api.ui!.choose({
        message: 'm',
        choices: Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, label: `${i}` })),
      }),
    ).rejects.toThrow(/at most 9/);
  });

  it('confirm titles the dialog with the plugin name', async () => {
    const api = createPluginApi('demo', deps, grant(['ui.dialogs']));
    expect(await api.ui!.confirm('Sure?', { okLabel: 'Yes' })).toBe(true);
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith('Sure?', {
      title: '[Demo Plugin]',
      okLabel: 'Yes',
      cancelLabel: undefined,
    });
  });
});

describe('collab.*', () => {
  const bridge = {
    sessionInfo: vi.fn((uid: string) =>
      uid === 'focused'
        ? {
            roomId: 'ab'.repeat(8),
            role: 'host' as const,
            title: 'Aff',
            server: 'https://relay.test/relay',
            crossServer: 'unsupported' as const,
          }
        : null,
    ),
    editShareCode: vi.fn((uid: string) => (uid === 'focused' ? 'cmshare2.abababababababab.KEY.1.0.0' : null)),
    editAddress: vi.fn((uid: string) =>
      uid === 'focused' ? 'cmshare2.abababababababab.KEY.1.0.0@https://relay.test/relay' : null,
    ),
    viewCode: vi.fn((uid: string) => (uid === 'focused' ? 'cmview1.abababababababab.KEY.1.0.0' : null)),
    viewAddress: vi.fn((uid: string) => (uid === 'focused' ? 'cmview1.abababababababab.KEY.1.0.0@https://relay.test/relay' : null)),
    server: vi.fn(async () => ({ url: 'https://relay.test/relay', host: 'relay.test', nickname: null })),
    reach: vi.fn(async (url: string) => (url === 'https://relay.test/relay' ? ('home' as const) : ('weird' as never))),
    parseAddress: vi.fn(async (raw: string) =>
      raw.startsWith('cmshare')
        ? {
            address: 'cmshare2.abababababababab.KEY.1.0.0@https://relay.test/relay',
            code: 'cmshare2.abababababababab.KEY.1.0.0',
            roomId: 'ab'.repeat(8),
            server: 'https://relay.test/relay',
            view: false,
            extra: 'dropped',
          }
        : null,
    ),
    localRecord: vi.fn(async () => ({ docId: 'd1', role: 'participant' as const })),
    join: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'joined' as const;
    }),
  };
  const collabDeps = { ...deps, getFocusedDocUid: () => 'focused', collab: bridge };
  const mint = (perms: string[]) =>
    createPluginApi('demo', collabDeps, { granted: new Set(perms), declared: perms, name: 'Demo' });

  it('is absent without any collab permission, or without a host bridge', () => {
    expect(mint([]).collab).toBeUndefined();
    expect(
      createPluginApi('demo', deps, { granted: new Set(['collab.read']), declared: ['collab.read'], name: 'D' }).collab,
    ).toBeUndefined();
  });

  it('exposes only the methods each permission grants', () => {
    expect(Object.keys(mint(['collab.read']).collab!).sort()).toEqual(['current', 'localRecord', 'roomIdOf']);
    expect(Object.keys(mint(['collab.server']).collab!).sort()).toEqual(['parseAddress', 'reach', 'server']);
    expect(Object.keys(mint(['collab.shareCode']).collab!).sort()).toEqual(['shareAddress', 'shareCode']);
    expect(Object.keys(mint(['collab.viewCode']).collab!).sort()).toEqual(['viewAddress', 'viewCode']);
    expect(Object.keys(mint(['collab.join']).collab!)).toEqual(['join']);
  });

  it('hides address methods a bridge lacks (older hosts)', () => {
    const { editAddress: _a, viewCode: _c, viewAddress: _v, server: _s, reach: _r, parseAddress: _p, ...old } = bridge;
    const api = createPluginApi(
      'demo',
      { ...collabDeps, collab: old },
      {
        granted: new Set(['collab.server', 'collab.shareCode', 'collab.viewCode']),
        declared: ['collab.server', 'collab.shareCode', 'collab.viewCode'],
        name: 'D',
      },
    );
    expect(Object.keys(api.collab!)).toEqual(['shareCode']);
  });

  it('defaults to the focused doc and never exposes the key through current()', () => {
    const api = mint(['collab.read', 'collab.shareCode']);
    const info = api.collab!.current!();
    // No collab.server: the session's server stays hidden.
    expect(info).toEqual({ roomId: 'ab'.repeat(8), role: 'host', title: 'Aff', server: null, crossServer: 'unsupported' });
    expect(JSON.stringify(info)).not.toContain('KEY');
    expect(api.collab!.shareCode!()).toBe('cmshare2.abababababababab.KEY.1.0.0');
    expect(api.collab!.shareCode!('other')).toBeNull();
    expect(api.collab!.shareAddress!()).toBe('cmshare2.abababababababab.KEY.1.0.0@https://relay.test/relay');
    expect(api.collab!.shareAddress!('other')).toBeNull();
  });

  it('collab.server reveals the server: on current(), server(), reach() and parseAddress()', async () => {
    const api = mint(['collab.read', 'collab.server']);
    expect(api.collab!.current!()!.server).toBe('https://relay.test/relay');
    expect(await api.collab!.server!()).toEqual({ url: 'https://relay.test/relay', host: 'relay.test', nickname: null });
    expect(await api.collab!.reach!('https://relay.test/relay')).toBe('home');
    expect(await api.collab!.reach!('https://elsewhere.test')).toBe('unknown'); // junk from the host → unknown
    const parsed = await api.collab!.parseAddress!('cmshare2.abababababababab.KEY.1.0.0');
    expect(parsed).toEqual({
      address: 'cmshare2.abababababababab.KEY.1.0.0@https://relay.test/relay',
      code: 'cmshare2.abababababababab.KEY.1.0.0',
      roomId: 'ab'.repeat(8),
      server: 'https://relay.test/relay',
      view: false,
    });
    expect(await api.collab!.parseAddress!('garbage')).toBeNull();
  });

  it('collab.viewCode hands out the view code and address, never the edit code', () => {
    const api = mint(['collab.viewCode']);
    expect(api.collab!.viewCode!()).toBe('cmview1.abababababababab.KEY.1.0.0');
    expect(api.collab!.viewAddress!()).toBe('cmview1.abababababababab.KEY.1.0.0@https://relay.test/relay');
    expect(api.collab!.shareCode).toBeUndefined();
    expect(api.collab!.shareAddress).toBeUndefined();
  });

  it('crossServer passes known values through and never claims "federated" for junk', () => {
    const junk = {
      ...bridge,
      sessionInfo: () => ({ roomId: 'ab'.repeat(8), role: 'host' as const, title: null, server: null, crossServer: 'weird' as never }),
    };
    const api = createPluginApi('demo', { ...collabDeps, collab: junk }, { granted: new Set(['collab.read']), declared: ['collab.read'], name: 'D' });
    expect(api.collab!.current!()!.crossServer).toBe('off');
    expect(mint(['collab.read']).collab!.current!()!.crossServer).toBe('unsupported');
  });

  it('roomIdOf parses every code generation, including federation flags', () => {
    const api = mint(['collab.read']);
    const room = '0123456789abcdef';
    expect(api.collab!.roomIdOf!(`cmshare1.${room}.KEY`)).toBe(room);
    expect(api.collab!.roomIdOf!(`cmshare2.${room}.KEY.1.17.0`)).toBe(room);
    expect(api.collab!.roomIdOf!(`cmshare2f.${room}.KEY.1.17.0@https://relay.test/relay`)).toBe(room);
    expect(api.collab!.roomIdOf!(`cmview1.${room}.KEY`)).toBe(room);
    expect(api.collab!.roomIdOf!('cmk1.KEY')).toBeNull();
    expect(api.collab!.roomIdOf!('garbage')).toBeNull();
  });

  it('runs one join at a time per plugin', async () => {
    const api = mint(['collab.join']);
    const [a, b] = await Promise.all([
      api.collab!.join!('cmshare1.x.y', { intoDoc: 'focused' }),
      api.collab!.join!('cmshare1.x.y'),
    ]);
    expect([a, b]).toEqual(['joined', 'failed']);
    expect(bridge.join).toHaveBeenCalledTimes(1);
    expect(bridge.join).toHaveBeenCalledWith('cmshare1.x.y', 'focused');
  });
});

describe('ui.notices', () => {
  const mint = (perms: string[]) =>
    createPluginApi('demo', deps, { granted: new Set(perms), declared: perms, name: 'Demo Plugin' });
  beforeEach(() => {
    vi.mocked(postNotice).mockClear();
    vi.mocked(clearNotice).mockClear();
    hasPermission.value = true;
  });

  it('is present only with ui.notices granted', () => {
    expect(mint([]).notices).toBeUndefined();
    expect(mint(['ui.dialogs']).notices).toBeUndefined();
    expect(Object.keys(mint(['ui.notices']).notices!)).toEqual(['post']);
  });

  it('labels the title, namespaces the key, clips text and clears by key', () => {
    const handle = mint(['ui.notices']).notices!.post({
      key: 'room-1',
      title: 'Live session',
      body: 'x'.repeat(5000),
      toast: false,
    });
    const input = vi.mocked(postNotice).mock.calls[0]![0];
    expect(input.title).toBe('[Demo Plugin] Live session');
    expect(input.key).toBe('plugin:demo:room-1');
    expect(input.body.length).toBe(2000);
    expect(input.toast).toBe(false);
    expect(input.severity).toBe('info');
    handle.clear();
    expect(clearNotice).toHaveBeenCalledWith('plugin:demo:room-1');
  });

  it('caps actions at 2 and wraps them (grant re-checked when clicked)', () => {
    const api = mint(['ui.notices']);
    const run = vi.fn();
    expect(() =>
      api.notices!.post({
        key: 'k',
        title: 't',
        body: 'b',
        actions: [1, 2, 3].map((n) => ({ label: `A${n}`, run })),
      }),
    ).toThrow(/at most 2/);
    expect(() => api.notices!.post({ key: '', title: 't', body: 'b' })).toThrow(/key/);
    api.notices!.post({ key: 'k', title: 't', body: 'b', actions: [{ label: 'Join', run }] });
    const action = vi.mocked(postNotice).mock.calls[0]![0].actions![0]!;
    expect(action.label).toBe('Join');
    action.run();
    expect(run).toHaveBeenCalledTimes(1);
    hasPermission.value = false; // revoked after posting
    action.run();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('collab.probe', () => {
  const room = '0123456789abcdef';
  const code = `cmshare2.${room}.KEY.1.0.0`;
  const makeBridge = (impl: (c: string) => Promise<'live' | 'ended' | 'unknown' | 'unreachable'>) => ({
    sessionInfo: () => null,
    editShareCode: () => null,
    localRecord: async () => null,
    join: async () => 'joined' as const,
    probe: vi.fn(impl),
  });
  const mint = (bridge: ReturnType<typeof makeBridge>, perms = ['collab.probe']) =>
    createPluginApi('demo', { ...deps, collab: bridge }, { granted: new Set(perms), declared: perms, name: 'D' });

  it('exists only with collab.probe (and a bridge that can probe)', () => {
    const bridge = makeBridge(async () => 'live');
    expect(mint(bridge, ['collab.read']).collab!.probe).toBeUndefined();
    expect(Object.keys(mint(bridge).collab!)).toEqual(['probe']);
    const { probe: _omit, ...old } = bridge;
    expect(
      createPluginApi('demo', { ...deps, collab: old }, { granted: new Set(['collab.probe']), declared: ['collab.probe'], name: 'D' }).collab,
    ).toBeUndefined();
  });

  it('shares one request per room in flight and caches definite answers', async () => {
    const bridge = makeBridge(async () => 'ended');
    const api = mint(bridge);
    const [a, b] = await Promise.all([api.collab!.probe!(code), api.collab!.probe!(` ${code} `)]);
    expect([a, b]).toEqual(['ended', 'ended']);
    expect(await api.collab!.probe!(code)).toBe('ended');
    expect(bridge.probe).toHaveBeenCalledTimes(1);
  });

  it('caches per server: the same room on two servers is two sessions', async () => {
    const bridge = makeBridge(async (c) => (c.includes('@https://b.test') ? 'unreachable' : 'live'));
    const api = mint(bridge);
    expect(await api.collab!.probe!(`${code}@https://a.test`)).toBe('live');
    expect(await api.collab!.probe!(`${code}@https://b.test`)).toBe('unreachable');
    expect(await api.collab!.probe!(`${code}@HTTPS://B.test:443/`)).toBe('unreachable'); // same server: cached
    expect(await api.collab!.probe!(code)).toBe('live'); // plain = your server, its own entry
    expect(bridge.probe).toHaveBeenCalledTimes(3);
    // Path case is part of a server's identity: a different server.
    expect(await api.collab!.probe!(`${code}@https://a.test/Relay`)).toBe('live');
    expect(await api.collab!.probe!(`${code}@https://a.test/relay`)).toBe('live');
    expect(bridge.probe).toHaveBeenCalledTimes(5);
  });

  it('does not cache unknown, maps failures and junk to unknown, skips malformed codes', async () => {
    let answer: unknown = 'unknown';
    const bridge = makeBridge(async () => answer as 'unknown');
    const api = mint(bridge);
    expect(await api.collab!.probe!(code)).toBe('unknown');
    answer = 'weird';
    expect(await api.collab!.probe!(code)).toBe('unknown');
    bridge.probe.mockImplementationOnce(async () => {
      throw new Error('net');
    });
    expect(await api.collab!.probe!(code)).toBe('unknown');
    expect(bridge.probe).toHaveBeenCalledTimes(3);
    expect(await api.collab!.probe!('garbage')).toBe('unknown');
    expect(bridge.probe).toHaveBeenCalledTimes(3);
  });
});
