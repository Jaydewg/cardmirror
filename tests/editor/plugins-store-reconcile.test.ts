// @vitest-environment jsdom
// Boot reconciliation for plugin leftovers (Shreeram review, 2026-07-24):
// enabled flags, `plugin:<id>` storage bags, and dot-namespaced key
// overrides must not outlive the plugin's install DIRECTORY — the one
// unambiguous "really uninstalled" signal. A plugin that merely failed
// to load is still installed and must lose nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  forgetPluginUpdateState,
  isPluginAutoUpdate,
  isPluginEnabled,
  pluginLastUpdateCheck,
  setPluginAutoUpdate,
  setPluginEnabled,
  setPluginLastUpdateCheck,
  reconcilePluginState,
} from '../../src/editor/plugins-store.js';
import { settings } from '../../src/editor/settings.js';

beforeEach(() => {
  localStorage.clear();
  settings.set('ribbonKeyOverrides', {});
  settings.set('ribbonCustomButtons', []);
});

describe('reconcilePluginState', () => {
  it('prunes flags, bags, and overrides of directory-absent plugins only', () => {
    setPluginEnabled('alive', true);
    setPluginEnabled('gone', true);
    localStorage.setItem('plugin:alive', '{"x":1}');
    localStorage.setItem('plugin:gone', '{"x":2}');
    settings.set('ribbonKeyOverrides', {
      'alive.go': 'Mod-Alt-1',
      'gone.go': 'Mod-Alt-2',
      // Static commands have no dots — must never be touched.
      openSettings: 'Mod-Alt-3',
    });

    reconcilePluginState(new Set(['alive']));

    expect(isPluginEnabled('alive')).toBe(true);
    expect(isPluginEnabled('gone')).toBe(false);
    expect(localStorage.getItem('plugin:alive')).not.toBeNull();
    expect(localStorage.getItem('plugin:gone')).toBeNull();
    const overrides = settings.get('ribbonKeyOverrides');
    expect(overrides['alive.go']).toBe('Mod-Alt-1');
    expect(overrides['gone.go']).toBeUndefined();
    expect(overrides['openSettings']).toBe('Mod-Alt-3');
  });

  it('an installed-but-not-loaded plugin keeps everything (load failure ≠ uninstall)', () => {
    setPluginEnabled('flaky', true);
    settings.set('ribbonKeyOverrides', { 'flaky.go': 'Mod-Alt-4' });
    settings.set('ribbonCustomButtons', [{ command: 'flaky.go', icon: 'star' }]);
    // 'flaky' IS in the installed set — it just never registered this session.
    reconcilePluginState(new Set(['flaky']));
    expect(isPluginEnabled('flaky')).toBe(true);
    expect(settings.get('ribbonKeyOverrides')['flaky.go']).toBe('Mod-Alt-4');
    expect(settings.get('ribbonCustomButtons')).toEqual([{ command: 'flaky.go', icon: 'star' }]);
  });

  it('unconfigures custom ribbon buttons of directory-absent plugins only', () => {
    settings.set('ribbonCustomButtons', [
      { command: 'gone.go', icon: 'star' },
      { command: 'alive.go', icon: 'flag' },
      // Static ribbon ids and setting commands have no dot prefix — never touched.
      { command: 'toggleReadMode', icon: 'check' },
      { command: 'toggle:paraIntegrity', icon: 'zap' },
    ]);
    reconcilePluginState(new Set(['alive']));
    expect(settings.get('ribbonCustomButtons')).toEqual([
      { command: 'alive.go', icon: 'flag' },
      { command: 'toggleReadMode', icon: 'check' },
      { command: 'toggle:paraIntegrity', icon: 'zap' },
    ]);
  });

  it('prunes auto-update switches and check times of directory-absent plugins only', () => {
    setPluginAutoUpdate('alive', false);
    setPluginAutoUpdate('gone', false);
    setPluginLastUpdateCheck('alive', 5);
    setPluginLastUpdateCheck('gone', 6);
    reconcilePluginState(new Set(['alive']));
    expect(isPluginAutoUpdate('alive')).toBe(false);
    expect(pluginLastUpdateCheck('alive')).toBe(5);
    expect(isPluginAutoUpdate('gone')).toBe(true);
    expect(pluginLastUpdateCheck('gone')).toBe(0);
  });

  it('reads a blob written before auto-update existed', () => {
    localStorage.setItem('pmd-plugins', JSON.stringify({ enabled: { old: true } }));
    expect(isPluginEnabled('old')).toBe(true);
    expect(isPluginAutoUpdate('old')).toBe(true);
    setPluginAutoUpdate('old', false);
    expect(isPluginEnabled('old')).toBe(true);
    forgetPluginUpdateState('old');
    expect(isPluginAutoUpdate('old')).toBe(true);
  });
});
