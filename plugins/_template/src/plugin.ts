/**
 * My Plugin. Start here: rename the id and name (here AND in
 * cardmirror-plugin.json), list the permissions you need in both places,
 * and replace the example command.
 *
 * Rules of the road:
 *   - Import only types from '@cardmirror/plugin-api'. The bundle must
 *     carry no CardMirror code.
 *   - Feature-detect every optional namespace (`api.ui?.confirm`): the
 *     user can revoke a permission at any time, and older builds don't
 *     know newer ones. `api.permissions?.status(p)` says why something is
 *     missing.
 *   - Register hooks in `activate` and return a cleanup. `activate` runs
 *     again, with a fresh api, after every permission change.
 */
import type { CardMirrorPluginApi, PluginDefinition } from '@cardmirror/plugin-api';

export const PLUGIN_ID = 'my-plugin';
export const PLUGIN_NAME = 'My Plugin';
/** Must equal `permissions` in cardmirror-plugin.json (a test checks). */
export const PLUGIN_PERMISSIONS = ['ui.dialogs'];

async function sayHello(api: CardMirrorPluginApi): Promise<void> {
  if (!api.ui) {
    const status = api.permissions?.status('ui.dialogs');
    api.showToast(
      status === 'denied'
        ? `${PLUGIN_NAME} needs “Show dialogs”. Allow it in Settings → Plugins.`
        : `${PLUGIN_NAME} needs a newer CardMirror for this.`,
    );
    return;
  }
  const ok = await api.ui.confirm('Say hello?', { okLabel: 'Hello' });
  if (ok) api.showToast('Hello from My Plugin!');
}

export function createPlugin(): PluginDefinition {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    apiVersion: 1,
    permissions: [...PLUGIN_PERMISSIONS],
    commands: [
      {
        id: `${PLUGIN_ID}.hello`,
        label: `${PLUGIN_NAME}: Say hello`,
        keywords: ['example'],
        run: sayHello,
      },
    ],
    activate(api) {
      // Register hooks here (api.files?.onSave, api.events?.onFocusChange,
      // ...) and return a function that removes them.
      const off = api.settings.onChanged(() => {});
      return () => off();
    },
  };
}
