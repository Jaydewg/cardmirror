// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../src/editor/settings.js', () => ({
  settings: {
    get: (k: string) => settingsState.values[k] ?? false,
    set: (k: string, v: unknown) => {
      settingsState.values[k] = v;
    },
  },
}));
vi.mock('../../src/editor/host/index.js', () => ({ getElectronHost: () => null }));

import { installPluginCommunityGate } from '../../src/editor/plugin-community-gate.js';
import {
  installPluginRegistry,
  pluginCommandIds,
  resetPluginRegistryForTests,
} from '../../src/editor/plugin-registry.js';
import { PERMISSION_DEMO_ID } from '../../src/editor/plugin-permission-demo.js';
import type { CardMirrorPluginApi } from '../../src/editor/plugin-api.js';

const DEMO_CMD = `${PERMISSION_DEMO_ID}.ask`;

beforeEach(() => {
  settingsState.values = {};
  resetPluginRegistryForTests();
});
afterEach(() => {
  delete window.__plugins;
});

describe('permission demo console flag', () => {
  it('is invisible by default', () => {
    installPluginRegistry(() => ({}) as CardMirrorPluginApi);
    installPluginCommunityGate();
    expect(pluginCommandIds()).not.toContain(DEMO_CMD);
    expect(window.__plugins!('status')).toContain('permission demo: off');
  });

  it('perm-demo-on registers it through the consent prompt; off removes it and forgets consent', () => {
    const onPermissionRequest = vi.fn();
    installPluginRegistry(() => ({}) as CardMirrorPluginApi, { onPermissionRequest });
    installPluginCommunityGate();

    expect(window.__plugins!('perm-demo-on')).toMatch(/ENABLED/);
    expect(settingsState.values['pluginPermissionDemo']).toBe(true);
    expect(pluginCommandIds()).toContain(DEMO_CMD);
    expect(onPermissionRequest).toHaveBeenCalledWith(
      PERMISSION_DEMO_ID,
      'Permission Demo (dev)',
      ['doc.edit', 'doc.events', 'doc.read', 'ui.contextMenu', 'ui.dialogs', 'ui.panel'],
      ['future.thing'],
    );
    // Repeating "on" while registered doesn't stack prompts.
    window.__plugins!('perm-demo-on');
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);

    window.__plugins!('perm-demo-off');
    expect(settingsState.values['pluginPermissionDemo']).toBe(false);
    expect(pluginCommandIds()).not.toContain(DEMO_CMD);

    // Consent was forgotten, so switching it back on asks again.
    window.__plugins!('perm-demo-on');
    expect(onPermissionRequest).toHaveBeenCalledTimes(2);
  });

  it('says so when the plugin system is not running', () => {
    installPluginCommunityGate(); // no registry installed
    expect(window.__plugins!('perm-demo-on')).toMatch(/not running/);
    expect(pluginCommandIds()).not.toContain(DEMO_CMD);
  });

  it('unknown commands print usage', () => {
    installPluginCommunityGate();
    expect(window.__plugins!('nope' as never)).toMatch(/^usage:/);
  });
});
