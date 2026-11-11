// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import {
  installPluginRegistry,
  pluginPermissionInfo,
  regrantPlugin,
  registerPluginDefinition,
  resetPluginRegistryForTests,
  runPluginCommand,
  setPluginConsent,
  type PluginDefinition,
} from '../../src/editor/plugin-registry.js';
import type { CardMirrorPluginApi, PluginGrantContext } from '../../src/editor/plugin-api.js';

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
