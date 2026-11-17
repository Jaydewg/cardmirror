// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostState = vi.hoisted(() => ({ host: {} as Record<string, unknown> }));

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../src/editor/text-prompt.js', () => ({
  confirmDialog: vi.fn(),
  captureFocusForDialog: () => () => {},
}));
vi.mock('../../src/editor/plugin-permission-dialog.js', () => ({
  permissionConsentDialog: vi.fn(),
  managePluginPermissionsDialog: vi.fn(),
}));
vi.mock('../../src/editor/settings.js', () => ({
  settings: { get: () => true, set: () => {} },
}));
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => hostState.host,
}));

import {
  installPluginRegistry,
  pluginPermissionInfo,
  registerPluginDefinition,
  resetPluginRegistryForTests,
} from '../../src/editor/plugin-registry.js';
import { renderPluginsPanel } from '../../src/editor/plugins-settings-ui.js';
import { confirmDialog } from '../../src/editor/text-prompt.js';
import {
  managePluginPermissionsDialog,
  permissionConsentDialog,
} from '../../src/editor/plugin-permission-dialog.js';
import type { CardMirrorPluginApi } from '../../src/editor/plugin-api.js';
import {
  getPluginPermissionPrefs,
  setPluginPermissionPrefs,
} from '../../src/editor/plugin-permission-requests.js';

const settled = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function mountPanel(): HTMLElement {
  window.__registerCardMirrorPlugin = (() => ({ ok: true })) as never;
  const el = document.createElement('div');
  document.body.append(el);
  renderPluginsPanel(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetPluginRegistryForTests();
  localStorage.clear();
  vi.mocked(confirmDialog).mockReset();
  vi.mocked(permissionConsentDialog).mockReset();
  vi.mocked(managePluginPermissionsDialog).mockReset();
});

describe('install with permissions', () => {
  function recordingHost(plugin: Record<string, unknown>): string[] {
    const calls: string[] = [];
    hostState.host = {
      pluginList: () => Promise.resolve([]),
      pluginInstallInspect: () =>
        Promise.resolve({ ok: true, pending: 'tok', ownerRepo: 'owner/thing', plugin }),
      pluginInstallCommit: (token: string, granted?: string[]) => {
        calls.push(`commit:${token}:${JSON.stringify(granted)}`);
        return Promise.resolve({ ok: true });
      },
      pluginInstallDiscard: (token: string) => {
        calls.push(`discard:${token}`);
        return Promise.resolve();
      },
      pluginLoad: () => Promise.resolve({ ok: true }),
    };
    return calls;
  }

  async function clickInstall(el: HTMLElement): Promise<void> {
    await settled();
    el.querySelector<HTMLInputElement>('.pmd-plugins-input')!.value = 'owner/thing';
    el.querySelector<HTMLButtonElement>('.pmd-plugins-install button')!.click();
    await settled();
  }

  it('shows the itemized consent and commits only the supported permissions', async () => {
    const calls = recordingHost({
      id: 'thing',
      name: 'Thing',
      version: '1.0.0',
      permissions: ['ui.dialogs', 'future.thing'],
    });
    vi.mocked(permissionConsentDialog).mockResolvedValue(['ui.dialogs']);
    await clickInstall(mountPanel());
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(vi.mocked(permissionConsentDialog).mock.calls[0]![0]).toMatchObject({
      mode: 'install',
      ownerRepo: 'owner/thing',
      known: ['ui.dialogs'],
      unknown: ['future.thing'],
    });
    expect(calls).toContain('commit:tok:["ui.dialogs"]');
  });

  it('commits only the permissions left ticked', async () => {
    const calls = recordingHost({
      id: 'thing',
      name: 'Thing',
      version: '1.0.0',
      permissions: ['ui.dialogs', 'collab.join'],
    });
    vi.mocked(permissionConsentDialog).mockResolvedValue(['ui.dialogs']);
    await clickInstall(mountPanel());
    expect(calls).toContain('commit:tok:["ui.dialogs"]');
  });

  it('declining the itemized consent discards the staged install', async () => {
    const calls = recordingHost({ id: 'thing', name: 'Thing', version: '1.0.0', permissions: ['ui.dialogs'] });
    vi.mocked(permissionConsentDialog).mockResolvedValue(null);
    await clickInstall(mountPanel());
    expect(calls).toEqual(['discard:tok']);
  });

  it('a plugin with no permissions keeps the original one-line consent', async () => {
    const calls = recordingHost({ id: 'thing', name: 'Thing', version: '1.0.0', author: 'A' });
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await clickInstall(mountPanel());
    expect(permissionConsentDialog).not.toHaveBeenCalled();
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toBe(
      'Install Thing v1.0.0 by A from github.com/owner/thing? This plugin runs with full access to CardMirror and your documents.',
    );
    expect(calls).toContain('commit:tok:[]');
  });
});

describe('update that adds permissions', () => {
  /** Installed v1 requests `ui.dialogs`; `granted` is what the user
   *  allowed (default: nothing — they turned it off). */
  function updateHost(newPermissions: string[], granted: string[] = []): string[] {
    const calls: string[] = [];
    hostState.host = {
      pluginList: () =>
        Promise.resolve([
          {
            id: 'thing',
            name: 'Thing',
            version: '1.0.0',
            repo: 'owner/thing',
            permissions: ['ui.dialogs'],
            grantedPermissions: granted,
          },
        ]),
      pluginCheckUpdate: () => Promise.resolve({ ok: true, latest: '2.0.0', hasUpdate: true }),
      pluginInstallInspect: () =>
        Promise.resolve({
          ok: true,
          pending: 'tok',
          ownerRepo: 'owner/thing',
          installedGranted: granted,
          plugin: { id: 'thing', name: 'Thing', version: '2.0.0', permissions: newPermissions },
        }),
      pluginInstallCommit: (token: string, granted?: string[]) => {
        calls.push(`commit:${token}:${JSON.stringify(granted)}`);
        return Promise.resolve({ ok: true });
      },
      pluginInstallDiscard: (token: string) => {
        calls.push(`discard:${token}`);
        return Promise.resolve();
      },
    };
    return calls;
  }

  async function clickUpdate(): Promise<void> {
    const el = mountPanel();
    await settled();
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'Check for updates')!.click();
    await settled();
  }

  it('reminds the user to review permissions when the plugin has any', async () => {
    updateHost(['ui.dialogs']);
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await clickUpdate();
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toBe(
      'Update Thing to v2.0.0? You can review what it’s allowed to use at any time with the shield button next to it.',
    );
  });

  it('a permission the user turned off is listed UNticked (ask again on), and stays off unless ticked', async () => {
    const calls = updateHost(['ui.dialogs']);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(permissionConsentDialog).mockResolvedValue([]);
    await clickUpdate();
    expect(vi.mocked(permissionConsentDialog).mock.calls[0]![0]).toMatchObject({
      mode: 'update',
      known: ['ui.dialogs'],
      unchecked: ['ui.dialogs'],
    });
    expect(calls).toEqual(['commit:tok:[]']);
  });

  it('with ask again off, or the permission blocked, a turned-off permission is not asked about', async () => {
    for (const prefs of [
      { askAgain: false, blocked: [] },
      { askAgain: true, blocked: ['ui.dialogs'] },
    ]) {
      vi.mocked(permissionConsentDialog).mockReset();
      const calls = updateHost(['ui.dialogs']);
      setPluginPermissionPrefs('thing', prefs);
      vi.mocked(confirmDialog).mockResolvedValue(true);
      await clickUpdate();
      expect(permissionConsentDialog).not.toHaveBeenCalled();
      expect(calls).toEqual(['commit:tok:[]']);
      document.body.innerHTML = '';
    }
  });

  it('new permissions start ticked, turned-off ones unticked; declining keeps the old version', async () => {
    const calls = updateHost(['ui.dialogs', 'collab.join']);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(permissionConsentDialog).mockResolvedValue(null);
    await clickUpdate();
    expect(vi.mocked(permissionConsentDialog).mock.calls[0]![0]).toMatchObject({
      mode: 'update',
      known: ['collab.join', 'ui.dialogs'],
      unchecked: ['ui.dialogs'],
    });
    expect(calls).toEqual(['discard:tok']);
  });

  it('accepting commits the prior grant plus the new permissions left ticked', async () => {
    const calls = updateHost(['ui.dialogs', 'collab.join'], ['ui.dialogs']);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(permissionConsentDialog).mockResolvedValue(['collab.join']);
    await clickUpdate();
    expect(calls).toEqual(['commit:tok:["ui.dialogs","collab.join"]']);
  });

  it('a new permission unticked in the update dialog is not granted', async () => {
    const calls = updateHost(['ui.dialogs', 'collab.join'], ['ui.dialogs']);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(permissionConsentDialog).mockResolvedValue([]);
    await clickUpdate();
    expect(calls).toEqual(['commit:tok:["ui.dialogs"]']);
  });

  it('an update asking for nothing new needs no extra consent', async () => {
    const calls = updateHost([]);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await clickUpdate();
    expect(permissionConsentDialog).not.toHaveBeenCalled();
    expect(calls).toEqual(['commit:tok:[]']);
  });
});

describe('shield: manage permissions', () => {
  it('appears only for plugins that request permissions, and saves through main then re-mints live', async () => {
    const setCalls: string[] = [];
    hostState.host = {
      pluginList: () =>
        Promise.resolve([
          { id: 'plain', name: 'Plain', version: '1.0.0' },
          {
            id: 'thing',
            name: 'Thing',
            version: '1.0.0',
            permissions: ['ui.dialogs'],
            grantedPermissions: ['ui.dialogs'],
          },
        ]),
      pluginSetPermissions: (id: string, granted: string[]) => {
        setCalls.push(`${id}:${JSON.stringify(granted)}`);
        return Promise.resolve({ ok: true, granted });
      },
    };
    // The plugin is live this session with ui.dialogs granted.
    installPluginRegistry(() => ({}) as CardMirrorPluginApi);
    registerPluginDefinition({
      id: 'thing',
      name: 'Thing',
      apiVersion: 1,
      permissions: ['ui.dialogs'],
      commands: [{ id: 'thing.run', label: 'Run', run: () => {} }],
    });
    setPluginPermissionPrefs('thing', { askAgain: true, blocked: ['ui.dialogs'] });
    vi.mocked(managePluginPermissionsDialog).mockResolvedValue({ granted: [], askAgain: false, blocked: [] });
    const el = mountPanel();
    await settled();
    const shields = el.querySelectorAll('.pmd-plugins-permissions');
    expect(shields).toHaveLength(1);
    (shields[0] as HTMLButtonElement).click();
    await settled();
    expect(vi.mocked(managePluginPermissionsDialog).mock.calls[0]![0]).toMatchObject({
      name: 'Thing',
      known: ['ui.dialogs'],
      granted: ['ui.dialogs'],
      askAgain: true,
      blocked: ['ui.dialogs'],
    });
    expect(setCalls).toEqual(['thing:[]']);
    expect(pluginPermissionInfo('thing')!.granted).toEqual([]);
    expect(getPluginPermissionPrefs('thing')).toEqual({ askAgain: false, blocked: [] });
  });
});
