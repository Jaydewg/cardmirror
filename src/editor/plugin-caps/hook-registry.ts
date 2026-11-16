/**
 * Per-plugin hook registry gated by a permission AT CALL TIME.
 *
 * Every hook-style capability (file save/open hooks, doc events, menu
 * items) needs the same three things: register per plugin with an
 * unsubscribe, skip plugins that no longer hold the permission (revoked
 * or unregistered — checked when the hook would run, so there is no
 * teardown to forget), and never let one plugin's throw break the
 * dispatcher. This is that, once.
 */
import { pluginHasPermission } from '../plugin-registry.js';

export interface PluginHookRegistry<H> {
  /** Register `hook` for `pluginId`. With `onePerPlugin`, it replaces the
   *  plugin's previous hook. Returns an unsubscribe. */
  add(pluginId: string, hook: H): () => void;
  /** Granted hooks, in registration order (plugin, hook). */
  entries(): [string, H][];
  /** Granted hooks of one plugin. */
  forPlugin(pluginId: string): H[];
  /** True when any granted hook is registered — the dispatch fast path. */
  any(): boolean;
  /** Run `fn` for each granted hook; a throw is logged with the plugin id
   *  and never stops the others. */
  each(fn: (pluginId: string, hook: H) => void, what: string): void;
  clear(): void;
}

export function createPluginHookRegistry<H>(
  permission: string,
  opts: { onePerPlugin?: boolean } = {},
): PluginHookRegistry<H> {
  const hooks = new Map<string, H[]>();
  const granted = (pluginId: string): boolean => pluginHasPermission(pluginId, permission);
  const reg: PluginHookRegistry<H> = {
    add(pluginId, hook) {
      const list = opts.onePerPlugin ? [] : hooks.get(pluginId) ?? [];
      list.push(hook);
      hooks.set(pluginId, list);
      return () => {
        const cur = hooks.get(pluginId);
        if (!cur) return;
        const i = cur.indexOf(hook);
        if (i >= 0) cur.splice(i, 1);
        if (cur.length === 0) hooks.delete(pluginId);
      };
    },
    entries() {
      const out: [string, H][] = [];
      for (const [pluginId, list] of hooks) {
        if (!granted(pluginId)) continue;
        for (const h of list) out.push([pluginId, h]);
      }
      return out;
    },
    forPlugin(pluginId) {
      return granted(pluginId) ? [...(hooks.get(pluginId) ?? [])] : [];
    },
    any() {
      for (const pluginId of hooks.keys()) if (granted(pluginId)) return true;
      return false;
    },
    each(fn, what) {
      for (const [pluginId, hook] of reg.entries()) {
        try {
          fn(pluginId, hook);
        } catch (err) {
          console.error(`[plugins] ${pluginId} ${what} failed:`, err);
        }
      }
    },
    clear() {
      hooks.clear();
    },
  };
  return reg;
}
