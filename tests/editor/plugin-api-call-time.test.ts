// @vitest-environment jsdom
/**
 * Call-time permission checks (plugin-api.ts CALL_TIME_PERMISSIONS).
 *
 * The minted grant decides which methods EXIST; the live grant decides
 * whether a call RUNS. An api object kept from before a revoke must stop
 * working (sync methods throw, promise methods reject), and every
 * namespace method must have a rule (a method without one isn't exposed,
 * which would silently hide a new capability).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/text-prompt.js', () => ({
  confirmDialog: vi.fn(() => Promise.resolve(true)),
  promptForRouteChoice: vi.fn(() => Promise.resolve('b')),
}));
vi.mock('../../src/editor/status-notices.js', () => ({ postNotice: vi.fn(), clearNotice: vi.fn() }));
vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import { CALL_TIME_PERMISSIONS, createPluginApi, PluginPermissionError } from '../../src/editor/plugin-api.js';
import { PLUGIN_PERMISSIONS } from '../../src/editor/plugin-permissions.js';
import { postNotice } from '../../src/editor/status-notices.js';
import { showToast } from '../../src/editor/toast.js';

const ALL = Object.keys(PLUGIN_PERMISSIONS);

/** A collab bridge with every optional member, so every method exists. */
const bridge = {
  sessionInfo: () => null,
  editShareCode: () => 'cmshare2.abababababababab.KEY.1.0.0',
  editAddress: () => null,
  viewCode: () => null,
  viewAddress: () => null,
  localRecord: async () => null,
  server: async () => null,
  reach: async () => 'unknown' as const,
  parseAddress: async () => null,
  probe: async () => 'live' as const,
  join: async () => 'joined' as const,
};

function mint(granted: string[], live: Set<string> | null = null, name = 'Demo Plugin') {
  return createPluginApi(
    'demo',
    {
      appVersion: 'test',
      getView: () => null,
      findViewForDocId: () => null,
      getDocIdentity: () => null,
      ensureDocId: () => null,
      getFocusedDocUid: () => 'u1',
      collab: bridge,
      ...(live ? { isGranted: (_id: string, p: string) => live.has(p) } : {}),
    },
    { granted: new Set(granted), declared: granted, name },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('rule coverage', () => {
  it('every method of every namespace has a call-time rule, and no rule is stale', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = mint(ALL) as unknown as Record<string, Record<string, unknown> | undefined>;
    expect(errors).not.toHaveBeenCalled();
    for (const [ns, rules] of Object.entries(CALL_TIME_PERMISSIONS)) {
      const exposed = Object.entries(api[ns] ?? {})
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k)
        .sort();
      expect(exposed, ns).toEqual(Object.keys(rules).sort());
    }
  });

  it('every rule names a permission in the catalog', () => {
    for (const rules of Object.values(CALL_TIME_PERMISSIONS)) {
      for (const rule of Object.values(rules)) expect(ALL).toContain(rule.permission);
    }
  });
});

describe('after a revoke, an old api reference is refused', () => {
  it('sync methods throw PluginPermissionError; promise methods reject with it', async () => {
    const live = new Set(ALL);
    const api = mint(ALL, live);
    expect(api.collab!.shareCode!()).toBe('cmshare2.abababababababab.KEY.1.0.0');
    await expect(api.collab!.probe!('cmshare2.abababababababab.KEY.1.0.0')).resolves.toBe('live');

    live.delete('collab.shareCode');
    live.delete('collab.probe');
    let thrown: unknown;
    try {
      api.collab!.shareCode!();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PluginPermissionError);
    expect((thrown as PluginPermissionError).name).toBe('PluginPermissionError');
    expect((thrown as PluginPermissionError).permission).toBe('collab.shareCode');
    // A promise method never throws synchronously (`.catch` chains stay safe).
    const pending = api.collab!.probe!('x');
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toMatchObject({ name: 'PluginPermissionError', permission: 'collab.probe' });
    // Methods under permissions still held keep working.
    expect(api.collab!.current!()).toBeNull();
  });

  it('`permissions` on the old reference reflects the revoke', () => {
    const live = new Set(['ui.dialogs', 'files.data']);
    const api = mint(['ui.dialogs', 'files.data'], live);
    live.delete('ui.dialogs');
    expect(api.permissions!.has('ui.dialogs')).toBe(false);
    expect(api.permissions!.has('files.data')).toBe(true);
    expect(api.permissions!.list()).toEqual(['files.data']);
    expect(api.permissions!.status('ui.dialogs')).toBe('denied');
  });

  it('a live grant never widens the minted one', () => {
    const api = mint(['ui.dialogs'], new Set(ALL));
    expect(api.collab).toBeUndefined();
    expect(api.permissions!.has('collab.join')).toBe(false);
  });

  it('without a live-grant source (tests, legacy callers), the minted grant is final', async () => {
    const api = mint(['ui.dialogs']);
    await expect(api.ui!.confirm('ok?')).resolves.toBe(true);
    expect(api.permissions!.has('ui.dialogs')).toBe(true);
  });
});

describe('showToast attribution', () => {
  it('labels with the display name, like dialogs and notices', () => {
    const api = mint([], null, 'Live Session Link');
    api.showToast('hello');
    expect(showToast).toHaveBeenCalledWith('[Live Session Link] hello');
    api.showToast('x'.repeat(400));
    expect(vi.mocked(postNotice).mock.calls.at(-1)![0]).toMatchObject({ title: 'Plugin: Live Session Link' });
  });

  it('falls back to the id when the definition has no name', () => {
    const api = mint([], null, '');
    api.showToast('hi');
    expect(showToast).toHaveBeenCalledWith('[demo] hi');
  });
});
