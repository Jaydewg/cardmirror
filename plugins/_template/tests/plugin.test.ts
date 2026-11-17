import { describe, expect, it } from 'vitest';
import { createFakePluginApi } from '@cardmirror/plugin-api/testing';
import manifest from '../cardmirror-plugin.json';
import { createPlugin, PLUGIN_ID, PLUGIN_NAME, PLUGIN_PERMISSIONS } from '../src/plugin.js';

const hello = (api: Parameters<NonNullable<ReturnType<typeof createPlugin>['activate']>>[0]) =>
  createPlugin().commands.find((c) => c.id === `${PLUGIN_ID}.hello`)!.run(api);

describe('manifest and definition agree', () => {
  // CardMirror grants only permissions listed in BOTH, so a mismatch
  // silently withholds one. Keep them identical.
  it('same id, name and permissions', () => {
    const def = createPlugin();
    expect(manifest.id).toBe(def.id);
    expect(manifest.name).toBe(def.name);
    expect([...manifest.permissions].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect([...(def.permissions ?? [])].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
  });
});

describe('say hello', () => {
  it('asks, then toasts', async () => {
    const fake = createFakePluginApi({ granted: PLUGIN_PERMISSIONS, ui: { confirm: async () => true } });
    await hello(fake.api);
    expect(fake.toasts).toEqual([`Hello from ${PLUGIN_NAME}!`]);
  });

  it('explains a denied permission', async () => {
    const fake = createFakePluginApi({ declared: PLUGIN_PERMISSIONS, granted: [] });
    await hello(fake.api);
    expect(fake.toasts[0]).toMatch(/Settings → Plugins/);
  });

  it('explains an older CardMirror', async () => {
    const fake = createFakePluginApi({ granted: PLUGIN_PERMISSIONS, unsupported: ['ui.dialogs'] });
    await hello(fake.api);
    expect(fake.toasts[0]).toMatch(/newer CardMirror/);
  });
});

describe('activate', () => {
  it('returns a cleanup', () => {
    const cleanup = createPlugin().activate!(createFakePluginApi().api);
    expect(cleanup).toBeTypeOf('function');
    (cleanup as () => void)();
  });
});
