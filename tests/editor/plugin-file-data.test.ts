// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import {
  adoptPluginFileData,
  collectPluginFileData,
  forgetPluginFileData,
  getPluginFileData,
  registerPluginOpenHook,
  registerPluginSaveHook,
  resetPluginFileDataForTests,
  setUnclaimedPluginDataListener,
} from '../../src/editor/plugin-file-data.js';
import {
  installPluginRegistry,
  regrantPlugin,
  registerPluginDefinition,
  resetPluginRegistryForTests,
  setPluginConsent,
} from '../../src/editor/plugin-registry.js';
import { createPluginApi } from '../../src/editor/plugin-api.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const ctx = { docUid: 'u1', docId: 'd1', title: 'Aff.cmir' };

/** Register a plugin `id` that holds files.data (unless `granted` is false). */
function registerPlugin(id: string, granted = true): void {
  setPluginConsent(id, granted ? ['files.data'] : []);
  registerPluginDefinition({
    id,
    name: id.toUpperCase(),
    apiVersion: 1,
    permissions: ['files.data'],
    commands: [{ id: `${id}.noop`, label: 'noop', run: () => {} }],
  });
}

beforeEach(() => {
  resetPluginFileDataForTests();
  resetPluginRegistryForTests();
  installPluginRegistry((pluginId, grant) =>
    createPluginApi(
      pluginId,
      {
        appVersion: 't',
        getView: () => null,
        findViewForDocId: () => null,
        getDocIdentity: () => ({ docId: 'd1', docTitle: 'Aff.cmir' }),
        ensureDocId: () => null,
        getFocusedDocUid: () => 'u1',
      },
      grant,
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('collectPluginFileData (save)', () => {
  it('keeps entries of plugins that are absent or not granted', () => {
    registerPlugin('denied', false);
    adoptPluginFileData(ctx, {
      other: { name: 'Other', data: { a: 1 } },
      denied: { name: 'Denied', data: 2 },
    });
    registerPluginSaveHook('denied', () => ({ data: 'overwritten?' }));
    expect(collectPluginFileData(ctx)).toEqual({
      other: { name: 'Other', data: { a: 1 } },
      denied: { name: 'Denied', data: 2 },
    });
  });

  it('a granted hook writes, null removes, undefined keeps', () => {
    registerPlugin('alpha');
    registerPlugin('beta');
    registerPlugin('gamma');
    adoptPluginFileData(ctx, {
      beta: { name: 'BETA', data: 'old' },
      gamma: { name: 'GAMMA', data: 'keep me' },
    });
    registerPluginSaveHook('alpha', (c) => ({ data: { doc: c.docId }, summary: 'hi' }));
    registerPluginSaveHook('beta', () => null);
    registerPluginSaveHook('gamma', () => undefined);
    expect(collectPluginFileData(ctx)).toEqual({
      alpha: { name: 'ALPHA', data: { doc: 'd1' }, summary: 'hi' },
      gamma: { name: 'GAMMA', data: 'keep me' },
    });
    // The result becomes the stored state.
    expect(getPluginFileData('u1', 'beta')).toBeNull();
  });

  it('a throwing, async, or unsavable hook leaves the stored entry alone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerPlugin('thrower');
    registerPlugin('asyncy');
    registerPlugin('cyclic');
    adoptPluginFileData(ctx, {
      thrower: { name: 'T', data: 1 },
      asyncy: { name: 'A', data: 2 },
      cyclic: { name: 'C', data: 3 },
    });
    registerPluginSaveHook('thrower', () => {
      throw new Error('boom');
    });
    registerPluginSaveHook('asyncy', (() => Promise.resolve({ data: 9 })) as never);
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    registerPluginSaveHook('cyclic', () => ({ data: loop }));
    const out = collectPluginFileData(ctx)!;
    expect(out['thrower']!.data).toBe(1);
    expect(out['asyncy']!.data).toBe(2);
    expect(out['cyclic']!.data).toBe(3);
  });

  it('returns undefined (no field) when nothing is stored or written', () => {
    expect(collectPluginFileData(ctx)).toBeUndefined();
  });

  it('a revoked plugin stops writing immediately', () => {
    registerPlugin('alpha');
    registerPluginSaveHook('alpha', () => ({ data: 'new' }));
    expect(collectPluginFileData(ctx)!['alpha']!.data).toBe('new');
    regrantPlugin('alpha', []);
    registerPluginSaveHook('alpha', () => ({ data: 'newer' }));
    expect(collectPluginFileData(ctx)!['alpha']!.data).toBe('new');
  });
});

describe('open hooks', () => {
  it('fire once per doc for the plugin whose data it carries', async () => {
    registerPlugin('alpha');
    const hook = vi.fn();
    registerPluginOpenHook('alpha', hook);
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: { x: 1 } }, other: { name: 'O', data: 0 } });
    await tick();
    await tick();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ x: 1 }, ctx);
  });

  it('fire for already-open docs when the plugin registers late', async () => {
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: 'late' } });
    await tick();
    registerPlugin('alpha');
    const hook = vi.fn();
    registerPluginOpenHook('alpha', hook);
    await tick();
    expect(hook).toHaveBeenCalledWith('late', ctx);
  });

  it('do not fire without the permission', async () => {
    registerPlugin('alpha', false);
    const hook = vi.fn();
    registerPluginOpenHook('alpha', hook);
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: 1 } });
    await tick();
    expect(hook).not.toHaveBeenCalled();
  });

  it('hand the plugin a copy, not the stored object', async () => {
    registerPlugin('alpha');
    registerPluginOpenHook('alpha', (data) => {
      (data as { x: number }).x = 99;
    });
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: { x: 1 } } });
    await tick();
    expect(getPluginFileData('u1', 'alpha')).toEqual({ x: 1 });
  });

  it('forget drops a closed doc', () => {
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: 1 } });
    forgetPluginFileData('u1');
    expect(getPluginFileData('u1', 'alpha')).toBeNull();
  });
});

describe('unclaimed data', () => {
  it('reports entries no granted plugin can read, once per doc — even if the listener comes later', async () => {
    registerPlugin('alpha');
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: 1 }, ghost: { name: 'Ghost', data: 2 } });
    await tick();
    const listener = vi.fn();
    setUnclaimedPluginDataListener(listener);
    await tick();
    setUnclaimedPluginDataListener(listener);
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(ctx, [{ id: 'ghost', name: 'Ghost' }]);
  });
});

describe('api.files', () => {
  it('exists only with files.data, and reads only the plugin’s own entry', () => {
    registerPlugin('alpha');
    adoptPluginFileData(ctx, { alpha: { name: 'A', data: 'mine' }, beta: { name: 'B', data: 'theirs' } });
    const deps = {
      appVersion: 't',
      getView: () => null,
      findViewForDocId: () => null,
      getDocIdentity: () => ({ docId: 'd1', docTitle: 'Aff.cmir' }),
      ensureDocId: () => null,
      getFocusedDocUid: () => 'u1',
    };
    const without = createPluginApi('alpha', deps, { granted: new Set(), declared: ['files.data'], name: 'A' });
    expect(without.files).toBeUndefined();
    const api = createPluginApi('alpha', deps, { granted: new Set(['files.data']), declared: ['files.data'], name: 'A' });
    expect(api.files!.get()).toBe('mine');
    expect(api.files!.focusedDoc()).toEqual(ctx);
  });
});
