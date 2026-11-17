import { describe, expect, it } from 'vitest';
import manifest from '../cardmirror-plugin.json';
import { createLiveSessionLinkPlugin, PLUGIN_ID, PLUGIN_NAME, PLUGIN_PERMISSIONS } from '../src/plugin.js';

// CardMirror grants only permissions listed in BOTH the manifest and the
// registered definition, so a mismatch silently withholds one.
describe('manifest and definition agree', () => {
  it('same id, name and permissions', () => {
    const def = createLiveSessionLinkPlugin();
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(def.id).toBe(PLUGIN_ID);
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect([...manifest.permissions].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect([...(def.permissions ?? [])].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
  });
});
