/**
 * Permission Demo — a built-in dev fixture for the plugin permission
 * path (consent prompt, `api.permissions.status`, `ui.dialogs`).
 *
 * Hidden by default: it registers only while the console flag is set
 * (`window.__plugins('perm-demo-on')`, persisted as the
 * `pluginPermissionDemo` setting), so its command never shows up in the
 * palette, keybindings, reference panel, or ribbon picker otherwise.
 *
 * It registers WITHOUT a consent record, exactly like a bundle loaded
 * from file, so switching it on runs the real dev-load consent prompt.
 * Switching it off forgets that consent, so the next "on" asks again —
 * handy for exercising both the Allow and Don't-allow paths.
 */
import type { PluginDefinition } from './plugin-registry.js';
import { forgetPluginConsent, registeredPlugins, unregisterPlugin } from './plugin-registry.js';

export const PERMISSION_DEMO_ID = 'permission-demo';

export const PERMISSION_DEMO_DEFINITION: PluginDefinition = {
  id: PERMISSION_DEMO_ID,
  name: 'Permission Demo (dev)',
  apiVersion: 1,
  // Every supported permission it exercises, plus one this build doesn't
  // know, so the consent dialog shows both sections.
  permissions: [
    'ui.dialogs',
    'ui.panel',
    'ui.contextMenu',
    'doc.read',
    'doc.events',
    'doc.edit',
    'future.thing',
  ],
  commands: [
    {
      id: `${PERMISSION_DEMO_ID}.ask`,
      label: 'Permission Demo: Ask',
      keywords: ['permission demo', 'dev'],
      run: async (api) => {
        const dialogs = api.permissions?.status('ui.dialogs') ?? 'unknown';
        const future = api.permissions?.status('future.thing') ?? 'unknown';
        if (!api.ui) {
          api.showToast(`No dialogs — ui.dialogs is ${dialogs}; future.thing is ${future}.`);
          return;
        }
        const pick = await api.ui.choose({
          message: 'Pick one',
          detail: `ui.dialogs: ${dialogs}\nfuture.thing: ${future}`,
          choices: [
            { value: 'a', label: 'Option A', description: 'The first one' },
            { value: 'b', label: 'Option B' },
          ],
        });
        api.showToast(`You picked: ${pick ?? 'cancel'}`);
      },
    },
    {
      id: `${PERMISSION_DEMO_ID}.panel`,
      label: 'Permission Demo: Show Panel',
      keywords: ['permission demo', 'dev', 'panel'],
      run: (api) => {
        if (!api.panel) {
          api.showToast(`No panel \u2014 ui.panel is ${api.permissions?.status('ui.panel') ?? 'unknown'}.`);
          return;
        }
        const panel = api.panel.get({ title: 'Doc stats' });
        if (!demoWired) {
          demoWired = true;
          // Live stats: doc.read on every doc.events change / focus switch.
          const render = (): void => {
            const snap = api.doc?.read?.();
            panel.el.textContent = snap
              ? `${snap.title}: ${snap.outline.length} headings, ${snap.cards.length} cards, ` +
                `${snap.stats.readAloudWords.body + snap.stats.readAloudWords.other} read-aloud words`
              : api.doc?.read
                ? 'No document focused.'
                : `doc.read is ${api.permissions?.status('doc.read') ?? 'unknown'}.`;
          };
          const keep = (off: (() => void) | undefined): void => {
            if (off) demoDisposers.push(off);
          };
          keep(api.events?.onDocChange(render));
          keep(api.events?.onFocusChange(render));
          keep(api.menu?.add({
            label: 'Count words in selection',
            when: 'selection',
            run: (t) => api.showToast(`${t.selectionText.trim().split(/\s+/).length} words selected`),
          }));
          keep(api.menu?.add({
            label: 'Insert demo block after this heading',
            when: 'heading',
            run: async (t) => {
              const res = await api.doc?.insert?.({
                text: 'Inserted by Permission Demo',
                role: 'block',
                at: t.headingId ? { after: t.headingId } : 'cursor',
                docUid: t.docUid ?? undefined,
              });
              api.showToast(res ? (res.ok ? 'Inserted (Ctrl+Z undoes it)' : `Insert refused: ${res.error}`) : 'doc.edit not granted');
            },
          }));
          render();
        }
        panel.show();
      },
    },
  ],
};

/** The demo wires its panel listeners and menu items once per "on";
 *  `perm-demo-off` removes them so a later "on" starts clean. */
let demoWired = false;
const demoDisposers: (() => void)[] = [];

export function isPermissionDemoRegistered(): boolean {
  return registeredPlugins().some((p) => p.id === PERMISSION_DEMO_ID);
}

/** Register or remove the demo. Returns false when `on` was asked but
 *  the plugin system isn't running (plugins off, web build, or the
 *  registry hasn't booted). Goes through the window global so the
 *  host's keymap/ribbon rebuild hook fires, same as a real bundle. */
export function syncPermissionDemo(on: boolean): boolean {
  if (!on) {
    for (const off of demoDisposers.splice(0)) off();
    demoWired = false;
    unregisterPlugin(PERMISSION_DEMO_ID);
    forgetPluginConsent(PERMISSION_DEMO_ID);
    return true;
  }
  const register = typeof window === 'undefined' ? undefined : window.__registerCardMirrorPlugin;
  if (typeof register !== 'function') return false;
  if (!isPermissionDemoRegistered()) register(PERMISSION_DEMO_DEFINITION);
  return true;
}
