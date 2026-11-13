/** `ui.notices` → `api.notices`: plugin-labeled status-bar notices,
 *  optionally with buttons. The quiet alternative to a modal: the notice
 *  waits under the ⓘ chip until the user acts on or dismisses it. */
import { pluginHasPermission } from '../plugin-registry.js';
import { clearNotice, postNotice } from '../status-notices.js';
import { clip, type CapabilityContext } from './context.js';

export interface PluginNoticeAction {
  label: string;
  /** Runs after the notice is dismissed — only if the plugin still holds
   *  `ui.notices` then. A throw is logged. */
  run: () => void;
}

export interface PluginNoticeOptions {
  /** Coalescing key, unique within this plugin: posting the same key
   *  again updates that notice (×N) instead of adding one, and never
   *  toasts again. ≤ 64 chars. */
  key: string;
  title: string;
  body: string;
  severity?: 'info' | 'warning';
  /** Also flash a toast at the cursor (first post of a key only).
   *  Default true. */
  toast?: boolean;
  /** Up to 2 buttons. */
  actions?: PluginNoticeAction[];
}

export interface PluginNoticeHandle {
  /** Remove the notice (no-op when the user already dismissed it). */
  clear(): void;
}

/** `ui.notices` permission. Every notice title carries the plugin's name. */
export interface PluginNoticesApi {
  post(opts: PluginNoticeOptions): PluginNoticeHandle;
}

const PERMISSION = 'ui.notices';
const NOTICE_KEY_MAX = 64;
const NOTICE_TITLE_MAX = 120;
const NOTICE_BODY_MAX = 2000;
const NOTICE_NAME_MAX = 80;
const NOTICE_ACTION_LABEL_MAX = 40;
export const NOTICE_MAX_ACTIONS = 2;

export function buildNoticesApi(ctx: CapabilityContext): PluginNoticesApi | undefined {
  if (!ctx.granted.has(PERMISSION)) return undefined;
  const name = clip(ctx.name || ctx.pluginId, NOTICE_NAME_MAX);
  return Object.freeze({
    post(opts: PluginNoticeOptions): PluginNoticeHandle {
      if (!opts || typeof opts !== 'object') throw new Error('notices.post needs an options object');
      const key = opts.key;
      if (typeof key !== 'string' || !key || key.length > NOTICE_KEY_MAX) {
        throw new Error('notices.post needs a non-empty key (at most 64 chars)');
      }
      const raw: unknown[] = Array.isArray(opts.actions) ? opts.actions : [];
      if (raw.length > NOTICE_MAX_ACTIONS) {
        throw new Error(`notices.post takes at most ${NOTICE_MAX_ACTIONS} actions`);
      }
      const actions = raw.map((entry) => {
        const a = (entry ?? {}) as Partial<PluginNoticeAction>;
        const run = a.run;
        if (typeof run !== 'function') throw new Error('each notice action needs a run function');
        const label = clip(a.label, NOTICE_ACTION_LABEL_MAX);
        if (!label) throw new Error('each notice action needs a label');
        return {
          label,
          run: () => {
            // Revoked or unregistered since posting: the button is inert
            // (same call-time check as every hook-style capability).
            if (!pluginHasPermission(ctx.pluginId, PERMISSION)) return;
            try {
              run();
            } catch (err) {
              console.error(`[plugins] ${ctx.pluginId} notice action failed:`, err);
            }
          },
        };
      });
      // Namespaced so a plugin can neither collide with nor clear core's
      // keyed notices (or another plugin's).
      const fullKey = `plugin:${ctx.pluginId}:${key}`;
      postNotice({
        key: fullKey,
        severity: opts.severity === 'warning' ? 'warning' : 'info',
        // Attribution: a plugin notice must never pass for a CardMirror one.
        title: `[${name}] ${clip(opts.title, NOTICE_TITLE_MAX)}`,
        body: clip(opts.body, NOTICE_BODY_MAX),
        toast: opts.toast !== false,
        actions,
      });
      return Object.freeze({ clear: () => clearNotice(fullKey) });
    },
  });
}
