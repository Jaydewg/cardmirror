// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/text-prompt.js', () => ({
  confirmDialog: vi.fn(() => Promise.resolve(true)),
  promptForRouteChoice: vi.fn(() => Promise.resolve('b')),
}));

import { createPluginApi, type PluginGrantContext } from '../../src/editor/plugin-api.js';
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
      uid === 'focused' ? { roomId: 'ab'.repeat(8), role: 'host' as const, title: 'Aff', relayHost: 'relay.test' } : null,
    ),
    editShareCode: vi.fn((uid: string) => (uid === 'focused' ? 'cmshare2.abababababababab.KEY.1.0.0' : null)),
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
    expect(Object.keys(mint(['collab.shareCode']).collab!)).toEqual(['shareCode']);
    expect(Object.keys(mint(['collab.join']).collab!)).toEqual(['join']);
  });

  it('defaults to the focused doc and never exposes the key through current()', () => {
    const api = mint(['collab.read', 'collab.shareCode']);
    const info = api.collab!.current!();
    expect(info).toEqual({ roomId: 'ab'.repeat(8), role: 'host', title: 'Aff', relayHost: 'relay.test' });
    expect(JSON.stringify(info)).not.toContain('KEY');
    expect(api.collab!.shareCode!()).toBe('cmshare2.abababababababab.KEY.1.0.0');
    expect(api.collab!.shareCode!('other')).toBeNull();
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
