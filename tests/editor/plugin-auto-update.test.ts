// @vitest-environment jsdom
// Background plugin auto-update (src/editor/plugin-update.ts): silent
// when the new version asks for nothing new, a consent notice when it
// does, once a day per plugin, and only for plugins whose Auto-update
// switch is on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  host: {} as Record<string, unknown>,
  pluginsEnabled: true,
  lite: false,
}));

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../src/editor/status-notices.js', () => ({ postNotice: vi.fn(), clearNotice: vi.fn() }));
vi.mock('../../src/editor/plugin-permission-dialog.js', () => ({
  permissionConsentDialog: vi.fn(),
  managePluginPermissionsDialog: vi.fn(),
}));
vi.mock('../../src/editor/settings.js', () => ({
  settings: { get: (k: string) => (k === 'pluginsEnabled' ? state.pluginsEnabled : undefined), set: () => {} },
}));
vi.mock('../../src/editor/lite.js', () => ({ isLiteBuild: () => state.lite }));
vi.mock('../../src/editor/host/index.js', () => ({ getElectronHost: () => state.host }));

import {
  AUTO_UPDATE_INTERVAL_MS,
  __resetPluginAutoUpdateForTests,
  runPluginAutoUpdates,
} from '../../src/editor/plugin-update.js';
import { postNotice } from '../../src/editor/status-notices.js';
import { permissionConsentDialog } from '../../src/editor/plugin-permission-dialog.js';
import { showToast } from '../../src/editor/toast.js';
import { resetPluginRegistryForTests } from '../../src/editor/plugin-registry.js';
import { setPluginPermissionPrefs } from '../../src/editor/plugin-permission-requests.js';
import {
  isPluginAutoUpdate,
  pluginLastUpdateCheck,
  setPluginAutoUpdate,
} from '../../src/editor/plugins-store.js';

interface Installed {
  id: string;
  name: string;
  version: string;
  repo?: string;
  incompatible?: string;
  permissions?: string[];
  grantedPermissions?: string[];
  grantedNetworkHosts?: string[];
}

const T0 = 1_800_000_000_000;

/** A host whose installed plugin `thing` v1.0.0 can update to v2.0.0
 *  requesting `newPermissions`. Returns the call log. */
function mockHost(opts: {
  installed?: Partial<Installed>;
  newPermissions?: string[];
  newHosts?: string[];
  check?: Record<string, unknown>;
}): string[] {
  const calls: string[] = [];
  const installed: Installed = {
    id: 'thing',
    name: 'Thing',
    version: '1.0.0',
    repo: 'owner/thing',
    permissions: ['ui.dialogs'],
    grantedPermissions: ['ui.dialogs'],
    ...opts.installed,
  };
  state.host = {
    pluginList: () => Promise.resolve([installed]),
    pluginCheckUpdate: (id: string, repo: string) => {
      calls.push(`check:${id}:${repo}`);
      return Promise.resolve(opts.check ?? { ok: true, current: '1.0.0', latest: '2.0.0', hasUpdate: true });
    },
    pluginInstallInspect: (ref: string) => {
      calls.push(`inspect:${ref}`);
      return Promise.resolve({
        ok: true,
        pending: 'tok',
        ownerRepo: 'owner/thing',
        installedGranted: installed.grantedPermissions,
        installedGrantedNetworkHosts: installed.grantedNetworkHosts,
        plugin: {
          id: 'thing',
          name: 'Thing',
          version: '2.0.0',
          permissions: opts.newPermissions ?? ['ui.dialogs'],
          networkHosts: opts.newHosts,
        },
      });
    },
    pluginInstallCommit: (token: string, granted?: string[], hosts?: string[]) => {
      calls.push(`commit:${token}:${JSON.stringify(granted)}`);
      if (hosts?.length) calls.push(`hosts:${JSON.stringify(hosts)}`);
      return Promise.resolve({ ok: true });
    },
    pluginInstallDiscard: (token: string) => {
      calls.push(`discard:${token}`);
      return Promise.resolve();
    },
  };
  return calls;
}

const run = (at = T0): Promise<void> => runPluginAutoUpdates(() => at);
const notices = (): Array<Record<string, unknown>> =>
  vi.mocked(postNotice).mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);

beforeEach(() => {
  localStorage.clear();
  resetPluginRegistryForTests();
  __resetPluginAutoUpdateForTests();
  state.pluginsEnabled = true;
  state.lite = false;
  vi.mocked(postNotice).mockReset();
  vi.mocked(permissionConsentDialog).mockReset();
  vi.mocked(showToast).mockReset();
});

describe('silent updates', () => {
  it('installs an update that asks for nothing new, keeping the grant, and says so once', async () => {
    const calls = mockHost({});
    await run();
    expect(calls).toEqual(['check:thing:owner/thing', 'inspect:owner/thing', 'commit:tok:["ui.dialogs"]']);
    expect(permissionConsentDialog).not.toHaveBeenCalled();
    expect(notices()).toEqual([
      expect.objectContaining({
        key: 'plugin-auto-updated',
        body: 'Updated Thing v2.0.0. Restart CardMirror to use the new version.',
      }),
    ]);
  });

  it('a permission the user turned off stays off, without asking', async () => {
    setPluginPermissionPrefs('thing', { askAgain: true, blocked: [] });
    const calls = mockHost({ installed: { grantedPermissions: [] } });
    await run();
    expect(permissionConsentDialog).not.toHaveBeenCalled();
    expect(calls).toContain('commit:tok:[]');
  });

  it('a dropped permission is dropped from the grant; an id this build does not know is never granted', async () => {
    const calls = mockHost({ newPermissions: ['future.thing'] });
    await run();
    expect(calls).toContain('commit:tok:[]');
  });

  it('does nothing when the plugin is up to date', async () => {
    const calls = mockHost({ check: { ok: true, current: '1.0.0', latest: '1.0.0', hasUpdate: false } });
    await run();
    expect(calls).toEqual(['check:thing:owner/thing']);
    expect(postNotice).not.toHaveBeenCalled();
  });
});

describe('updates that add permissions', () => {
  it('are not installed: the staged release is discarded and a notice offers the review', async () => {
    const calls = mockHost({ newPermissions: ['ui.dialogs', 'collab.join'] });
    await run();
    expect(calls).toEqual(['check:thing:owner/thing', 'inspect:owner/thing', 'discard:tok']);
    expect(permissionConsentDialog).not.toHaveBeenCalled();
    const [n] = notices();
    expect(n).toMatchObject({ key: 'plugin-update-consent:thing', severity: 'info' });
    expect(String(n!['body'])).toContain('Thing v2.0.0 is available');
    expect((n!['actions'] as Array<{ label: string }>).map((a) => a.label)).toEqual(['Review update']);
  });

  it('"Review update" runs the consent dialog and commits the prior grant plus what was ticked', async () => {
    const calls = mockHost({ newPermissions: ['ui.dialogs', 'collab.join'] });
    await run();
    vi.mocked(permissionConsentDialog).mockResolvedValue(['collab.join']);
    const action = (notices()[0]!['actions'] as Array<{ run: () => void }>)[0]!;
    action.run();
    await vi.waitFor(() => expect(calls).toContain('commit:tok:["ui.dialogs","collab.join"]'));
    expect(vi.mocked(permissionConsentDialog).mock.calls[0]![0]).toMatchObject({
      mode: 'update',
      known: ['collab.join'],
      ownerRepo: 'owner/thing',
    });
    expect(notices().at(-1)).toMatchObject({ key: 'plugin-auto-updated' });
  });

  it('declining the review leaves the installed version alone', async () => {
    const calls = mockHost({ newPermissions: ['ui.dialogs', 'collab.join'] });
    await run();
    vi.mocked(permissionConsentDialog).mockResolvedValue(null);
    (notices()[0]!['actions'] as Array<{ run: () => void }>)[0]!.run();
    await vi.waitFor(() => expect(calls.filter((c) => c === 'discard:tok')).toHaveLength(2));
    expect(calls.some((c) => c.startsWith('commit:'))).toBe(false);
  });
});

describe('when it checks', () => {
  it('at most once per interval per plugin, and a failed check counts', async () => {
    const calls = mockHost({ check: { ok: false, error: 'Could not reach GitHub.' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(T0);
    await run(T0 + AUTO_UPDATE_INTERVAL_MS - 1);
    expect(calls).toEqual(['check:thing:owner/thing']);
    expect(pluginLastUpdateCheck('thing')).toBe(T0);
    expect(postNotice).not.toHaveBeenCalled();
    await run(T0 + AUTO_UPDATE_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    vi.mocked(console.warn).mockRestore();
  });

  it('skips plugins with Auto-update off, without a repo, or that need a newer app', async () => {
    setPluginAutoUpdate('thing', false);
    let calls = mockHost({});
    await run();
    expect(calls).toEqual([]);
    setPluginAutoUpdate('thing', true);
    for (const installed of [{ repo: undefined }, { incompatible: '9.0.0' }]) {
      calls = mockHost({ installed });
      await run();
      expect(calls).toEqual([]);
    }
  });

  it('does nothing with plugins switched off or in the Lite build', async () => {
    const calls = mockHost({});
    state.pluginsEnabled = false;
    await run();
    state.pluginsEnabled = true;
    state.lite = true;
    await run();
    expect(calls).toEqual([]);
  });

  it('never throws when the host does', async () => {
    mockHost({});
    state.host['pluginCheckUpdate'] = () => Promise.reject(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(run()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('the Auto-update switch', () => {
  it('defaults to on and persists when turned off', () => {
    expect(isPluginAutoUpdate('thing')).toBe(true);
    setPluginAutoUpdate('thing', false);
    expect(isPluginAutoUpdate('thing')).toBe(false);
    setPluginAutoUpdate('thing', true);
    expect(isPluginAutoUpdate('thing')).toBe(true);
  });
});

describe('net.fetch hosts', () => {
  const withNet = (newHosts: string[]) =>
    mockHost({
      installed: {
        permissions: ['net.fetch'],
        grantedPermissions: ['net.fetch'],
        grantedNetworkHosts: ['api.crossref.org'],
      },
      newPermissions: ['net.fetch'],
      newHosts,
    });

  it('an update asking for the same hosts installs silently and keeps them', async () => {
    const calls = withNet(['api.crossref.org']);
    await run();
    expect(permissionConsentDialog).not.toHaveBeenCalled();
    expect(calls).toContain('commit:tok:["net.fetch"]');
    expect(calls).toContain('hosts:["api.crossref.org"]');
  });

  it('an update asking for fewer hosts installs silently with the smaller list', async () => {
    const calls = mockHost({
      installed: {
        permissions: ['net.fetch'],
        grantedPermissions: ['net.fetch'],
        grantedNetworkHosts: ['api.crossref.org', 'api.openalex.org'],
      },
      newPermissions: ['net.fetch'],
      newHosts: ['api.crossref.org'],
    });
    await run();
    expect(calls).toContain('hosts:["api.crossref.org"]');
  });

  it('an update that adds a host is NOT installed; it posts the consent notice', async () => {
    const calls = withNet(['api.crossref.org', 'evil.example.com']);
    await run();
    expect(calls.some((c) => c.startsWith('commit:'))).toBe(false);
    expect(calls).toContain('discard:tok');
    expect(notices()).toEqual([expect.objectContaining({ key: 'plugin-update-consent:thing' })]);
  });

  it('an update that widens to any site ("*") is NOT installed', async () => {
    const calls = withNet(['*']);
    await run();
    expect(calls.some((c) => c.startsWith('commit:'))).toBe(false);
  });
});
