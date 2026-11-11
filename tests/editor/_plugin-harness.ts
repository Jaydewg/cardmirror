/**
 * Test harness for plugin capabilities: register a plugin with a given
 * grant against the real registry + createPluginApi, and read back the
 * api object the plugin's commands would receive (re-minted on grant
 * changes, exactly as in the app).
 */
import type { EditorView } from 'prosemirror-view';
import { createPluginApi, type CardMirrorPluginApi, type PluginApiDeps } from '../../src/editor/plugin-api.js';
import {
  installPluginRegistry,
  registerPluginDefinition,
  regrantPlugin,
  resetPluginRegistryForTests,
  setPluginConsent,
} from '../../src/editor/plugin-registry.js';

export interface Harness {
  /** The plugin's CURRENT api (as its next command run would see it). */
  api(pluginId?: string): CardMirrorPluginApi;
  register(pluginId: string, permissions: string[], granted?: string[]): void;
  regrant(pluginId: string, granted: string[]): void;
}

/** Docs open in the fake window: uid → view (first one is focused). */
export function makeHarness(views: Record<string, EditorView | null> = {}): Harness {
  resetPluginRegistryForTests();
  const apis = new Map<string, CardMirrorPluginApi>();
  const focused = (): string | null => Object.keys(views)[0] ?? null;
  const deps: PluginApiDeps = {
    appVersion: 'test',
    getView: () => {
      const uid = focused();
      return uid ? views[uid] ?? null : null;
    },
    findViewForDocId: () => null,
    getDocIdentity: () => (focused() ? { docId: `id-${focused()}`, docTitle: `${focused()}.cmir` } : null),
    ensureDocId: () => null,
    getFocusedDocUid: focused,
    viewForUid: (uid) => views[uid] ?? null,
    docIdentityForUid: (uid) => (views[uid] ? { docId: `id-${uid}`, docTitle: `${uid}.cmir` } : null),
  };
  installPluginRegistry((pluginId, grant) => {
    const api = createPluginApi(pluginId, deps, grant);
    apis.set(pluginId, api);
    return api;
  });
  return {
    api: (pluginId = 'demo') => {
      const api = apis.get(pluginId);
      if (!api) throw new Error(`plugin ${pluginId} not registered`);
      return api;
    },
    register(pluginId, permissions, granted = permissions) {
      setPluginConsent(pluginId, granted);
      const res = registerPluginDefinition({
        id: pluginId,
        name: pluginId.toUpperCase(),
        apiVersion: 1,
        permissions,
        commands: [{ id: `${pluginId}.noop`, label: 'noop', run: () => {} }],
      });
      if (!res.ok) throw new Error(res.error);
    },
    regrant(pluginId, granted) {
      regrantPlugin(pluginId, granted);
    },
  };
}
