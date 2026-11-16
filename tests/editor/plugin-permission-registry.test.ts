// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import {
  installPluginRegistry,
  pluginHasPermission,
  pluginManifestDrift,
  pluginPermissionInfo,
  regrantPlugin,
  registerPluginDefinition,
  resetPluginRegistryForTests,
  runPluginCommand,
  setPluginConsent,
  setPluginManifestPermissions,
  unregisterPlugin,
  type PluginDefinition,
} from '../../src/editor/plugin-registry.js';
import { createPluginApi, type CardMirrorPluginApi, type PluginGrantContext } from '../../src/editor/plugin-api.js';

/** Records every mint so tests can see what grant each api got. */
function recordingFactory(): {
  mints: { id: string; grant: PluginGrantContext }[];
  create: (id: string, grant: PluginGrantContext) => CardMirrorPluginApi;
} {
  const mints: { id: string; grant: PluginGrantContext }[] = [];
  return {
    mints,
    create: (id, grant) => {
      mints.push({ id, grant });
      return { grant } as unknown as CardMirrorPluginApi;
    },
  };
}

function def(over: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'demo',
    name: 'Demo',
    apiVersion: 1,
    commands: [{ id: 'demo.run', label: 'Run', run: () => {} }],
    ...over,
  };
}

const lastGrant = (mints: { grant: PluginGrantContext }[]): string[] =>
  [...mints[mints.length - 1]!.grant.granted].sort();

afterEach(() => resetPluginRegistryForTests());

describe('registry permission grants', () => {
  it('a plugin that declares nothing is minted with an empty grant', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', []);
    expect(registerPluginDefinition(def()).ok).toBe(true);
    expect(lastGrant(f.mints)).toEqual([]);
    expect(f.mints[0]!.grant.name).toBe('Demo');
  });

  it('grants consented ∩ declared ∩ known', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', ['ui.dialogs', 'made.up']);
    registerPluginDefinition(def({ permissions: ['ui.dialogs', 'made.up'] }));
    expect(lastGrant(f.mints)).toEqual(['ui.dialogs']);
  });

  it('a definition cannot escalate beyond stored consent', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', []);
    registerPluginDefinition(def({ permissions: ['ui.dialogs'] }));
    expect(lastGrant(f.mints)).toEqual([]);
  });

  it('unknown and off-shape permissions are recorded or dropped, never fatal', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', ['ui.dialogs']);
    const res = registerPluginDefinition(
      def({ permissions: ['ui.dialogs', 'future.thing', 'BAD', 42 as unknown as string] }),
    );
    expect(res.ok).toBe(true);
    expect(pluginPermissionInfo('demo')).toEqual({
      declared: ['future.thing', 'ui.dialogs'],
      known: ['ui.dialogs'],
      unknown: ['future.thing'],
      granted: ['ui.dialogs'],
    });
  });

  it('a non-array permissions field is ignored (newer-plugin tolerance)', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    expect(registerPluginDefinition(def({ permissions: 'ui.dialogs' as unknown as string[] })).ok).toBe(true);
  });

  it('regrantPlugin re-mints the api the next command run receives', () => {
    const seen: CardMirrorPluginApi[] = [];
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', ['ui.dialogs']);
    registerPluginDefinition(
      def({ permissions: ['ui.dialogs'], commands: [{ id: 'demo.run', label: 'Run', run: (api) => void seen.push(api) }] }),
    );
    runPluginCommand('demo.run');
    expect(regrantPlugin('demo', []).size).toBe(0);
    runPluginCommand('demo.run');
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect([...(seen[1] as unknown as { grant: PluginGrantContext }).grant.granted]).toEqual([]);
    expect(pluginPermissionInfo('demo')!.granted).toEqual([]);
  });

  it('re-registration refreshes declared permissions against stored consent', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', ['ui.dialogs']);
    registerPluginDefinition(def());
    expect(lastGrant(f.mints)).toEqual([]);
    registerPluginDefinition(def({ permissions: ['ui.dialogs'] }));
    expect(lastGrant(f.mints)).toEqual(['ui.dialogs']);
  });
});

describe('dev-load permission requests', () => {
  it('asks when a bundle with no consent record declares supported permissions', () => {
    const onPermissionRequest = vi.fn();
    installPluginRegistry(recordingFactory().create, { onPermissionRequest });
    registerPluginDefinition(def({ permissions: ['ui.dialogs', 'made.up'] }));
    expect(onPermissionRequest).toHaveBeenCalledWith('demo', 'Demo', ['ui.dialogs'], ['made.up']);
    // Answering records consent, so a dev reload doesn't re-ask.
    regrantPlugin('demo', ['ui.dialogs']);
    registerPluginDefinition(def({ permissions: ['ui.dialogs', 'made.up'] }));
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it('never asks for an installed plugin (consent record present, even empty)', () => {
    const onPermissionRequest = vi.fn();
    installPluginRegistry(recordingFactory().create, { onPermissionRequest });
    setPluginConsent('demo', []);
    registerPluginDefinition(def({ permissions: ['ui.dialogs'] }));
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it('does not ask when only unsupported permissions are declared', () => {
    const onPermissionRequest = vi.fn();
    installPluginRegistry(recordingFactory().create, { onPermissionRequest });
    registerPluginDefinition(def({ permissions: ['made.up'] }));
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });
});

describe('activate lifecycle', () => {
  it('activates with the minted api once registered, and re-activates on regrant after cleanup', () => {
    const f = recordingFactory();
    installPluginRegistry(f.create);
    setPluginConsent('demo', []);
    const log: string[] = [];
    const seen: CardMirrorPluginApi[] = [];
    const activate = vi.fn((api: CardMirrorPluginApi) => {
      seen.push(api);
      log.push(`activate ${seen.length}`);
      const n = seen.length;
      return () => void log.push(`cleanup ${n}`);
    });
    expect(registerPluginDefinition(def({ permissions: ['ui.dialogs'], activate })).ok).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    // The api handed to activate is the one the registry just minted.
    expect((seen[0] as unknown as { grant: PluginGrantContext }).grant).toBe(f.mints[f.mints.length - 1]!.grant);
    regrantPlugin('demo', ['ui.dialogs']);
    expect(log).toEqual(['activate 1', 'cleanup 1', 'activate 2']);
    // The new activation sees the new grant.
    expect([...(seen[1] as unknown as { grant: PluginGrantContext }).grant.granted]).toEqual(['ui.dialogs']);
  });

  it('unregister runs the cleanup', () => {
    installPluginRegistry(recordingFactory().create);
    const cleanup = vi.fn();
    registerPluginDefinition(def({ activate: () => cleanup }));
    unregisterPlugin('demo');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a re-registered bundle activates its NEW activate function', () => {
    installPluginRegistry(recordingFactory().create);
    const first = vi.fn();
    const second = vi.fn();
    registerPluginDefinition(def({ activate: first }));
    registerPluginDefinition(def({ activate: second }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a throwing activate (or rejected promise) is logged and the plugin stays registered', async () => {
    installPluginRegistry(recordingFactory().create);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      registerPluginDefinition(
        def({
          activate: () => {
            throw new Error('boom');
          },
        }),
      ).ok,
    ).toBe(true);
    expect(pluginPermissionInfo('demo')).not.toBeNull();
    registerPluginDefinition(
      def({ id: 'other', commands: [], activate: (async () => { throw new Error('later'); }) as never }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('rejects a non-function activate', () => {
    installPluginRegistry(recordingFactory().create);
    const res = registerPluginDefinition(def({ activate: 'nope' as never }));
    expect(res).toEqual({ ok: false, error: 'activate must be a function' });
  });
});

describe('manifest vs definition permissions', () => {
  it('reports and warns where they disagree; silent when they agree or there is no manifest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installPluginRegistry(recordingFactory().create);
    setPluginConsent('demo', ['ui.dialogs', 'files.data']);
    setPluginManifestPermissions('demo', ['ui.dialogs', 'files.data']);
    registerPluginDefinition(def({ permissions: ['ui.dialogs', 'collab.read'] }));
    expect(pluginManifestDrift('demo')).toEqual({ onlyInManifest: ['files.data'], onlyInDefinition: ['collab.read'] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/Only in the manifest: files\.data\. Only in the definition: collab\.read/);
    resetPluginRegistryForTests();

    installPluginRegistry(recordingFactory().create);
    setPluginManifestPermissions('demo', ['ui.dialogs']);
    registerPluginDefinition(def({ permissions: ['ui.dialogs'] }));
    expect(pluginManifestDrift('demo')).toBeNull();
    resetPluginRegistryForTests();

    installPluginRegistry(recordingFactory().create); // dev load: no manifest
    registerPluginDefinition(def({ permissions: ['ui.dialogs'] }));
    expect(pluginManifestDrift('demo')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('a revoke reaches api references kept from before it', () => {
  it('the old api refuses calls once the registry withdraws the permission', async () => {
    installPluginRegistry((id, grant) =>
      createPluginApi(
        id,
        {
          appVersion: 'test',
          getView: () => null,
          findViewForDocId: () => null,
          getDocIdentity: () => null,
          ensureDocId: () => null,
          isGranted: pluginHasPermission,
        },
        grant,
      ),
    );
    let kept: CardMirrorPluginApi | null = null;
    setPluginConsent('demo', ['files.data']);
    registerPluginDefinition(
      def({
        permissions: ['files.data'],
        activate: (api) => {
          kept ??= api;
        },
      }),
    );
    expect(kept!.files!.focusedDoc()).toBeNull();
    regrantPlugin('demo', []); // revoke
    expect(() => kept!.files!.focusedDoc()).toThrow(/no longer granted/);
    expect(kept!.permissions!.has('files.data')).toBe(false);
    regrantPlugin('demo', ['files.data']); // granted again: the old reference works again
    expect(kept!.files!.focusedDoc()).toBeNull();
    unregisterPlugin('demo'); // unregistered: nothing is granted
    expect(() => kept!.files!.focusedDoc()).toThrow(/no longer granted/);
  });
});

