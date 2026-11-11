/**
 * Plugin console gates.
 *
 * Community installs: the GitHub installer only accepts repos on main's
 * curated allowlist (`PLUGIN_INSTALL_ALLOWLIST` in
 * apps/desktop/src/plugin-manager.ts): plugins are FULL-TRUST code, so
 * arbitrary-repo installs stay behind a deliberate, undiscoverable step —
 * `window.__plugins('community-on')` from the console, same pattern as
 * the card-cutter switch. The flag persists as a setting and is re-armed
 * into MAIN each boot; main holds the enforcement, the renderer only
 * requests the unlock. The dev "Load plugin from file…" path is
 * independent of this gate.
 *
 * Permission Demo: `window.__plugins('perm-demo-on')` registers the
 * built-in dev fixture (plugin-permission-demo.ts); off by default so
 * its command is invisible. Also persisted, and re-registered at boot by
 * initPlugins once installed plugins have loaded.
 */

import { settings } from './settings.js';
import { getElectronHost } from './host/index.js';
import { isPermissionDemoRegistered, syncPermissionDemo } from './plugin-permission-demo.js';

export type PluginsConsoleCommand =
  | 'community-on'
  | 'community-off'
  | 'perm-demo-on'
  | 'perm-demo-off'
  | 'status';

declare global {
  interface Window {
    __plugins?: (cmd: PluginsConsoleCommand) => string;
  }
}

const USAGE =
  "usage: __plugins('community-on' | 'community-off' | 'perm-demo-on' | 'perm-demo-off' | 'status')";

export function installPluginCommunityGate(): void {
  const arm = (): void => {
    void getElectronHost()?.pluginCommunityInstalls(
      settings.get('pluginCommunityInstalls') === true,
    );
  };

  window.__plugins = (cmd) => {
    if (cmd === 'status') {
      const community = settings.get('pluginCommunityInstalls')
        ? 'community plugin installs: ON'
        : 'community plugin installs: off (curated list only)';
      const demo = settings.get('pluginPermissionDemo')
        ? `permission demo: ON (${isPermissionDemoRegistered() ? 'registered' : 'not registered — plugins off?'})`
        : 'permission demo: off';
      return `${community}\n${demo}`;
    }
    if (cmd === 'perm-demo-on' || cmd === 'perm-demo-off') {
      const on = cmd === 'perm-demo-on';
      settings.set('pluginPermissionDemo', on);
      if (!on) {
        syncPermissionDemo(false);
        return 'permission demo disabled; its consent is forgotten (the next perm-demo-on asks again).';
      }
      return syncPermissionDemo(true)
        ? "permission demo ENABLED — answer the consent prompt, then run 'Permission Demo: Ask' " +
            "from the command palette. Disable with __plugins('perm-demo-off')."
        : 'permission demo flag set, but the plugin system is not running — ' +
            'turn on Plugins in Settings and restart CardMirror.';
    }
    if (cmd !== 'community-on' && cmd !== 'community-off') return USAGE;
    const on = cmd === 'community-on';
    settings.set('pluginCommunityInstalls', on);
    arm();
    return on
      ? 'community plugin installs ENABLED — the installer now accepts any GitHub repo. ' +
          'Plugins run with full access to CardMirror and your documents; only install sources you trust. ' +
          "Disable with __plugins('community-off')."
      : 'community plugin installs disabled (curated list only).';
  };

  arm();
}
