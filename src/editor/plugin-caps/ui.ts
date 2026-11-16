/** `ui.dialogs` → `api.ui`: plugin-labeled choice / confirm dialogs. */
import { confirmDialog, promptForRouteChoice } from '../text-prompt.js';
import { clip, type CapabilityContext } from './context.js';

export interface PluginChoiceOption {
  /** Returned when this button is picked. Unique, ≤ 64 chars. */
  value: string;
  label: string;
  description?: string;
}

/** `ui.dialogs` permission. Every dialog is labeled with the plugin's
 *  name and renders plain text only. */
export interface PluginUiApi {
  /** Up to 9 two-line buttons (number keys 1-9 pick them). Resolves to
   *  the picked `value`, or null on Cancel / Esc. */
  choose(opts: {
    message: string;
    detail?: string;
    choices: PluginChoiceOption[];
    cancelLabel?: string;
  }): Promise<string | null>;
  /** OK / Cancel. Resolves true on OK. */
  confirm(message: string, opts?: { okLabel?: string; cancelLabel?: string }): Promise<boolean>;
}

/** Caps on plugin-supplied dialog text — third-party strings get the
 *  same discipline as `showToast`. */
const UI_MESSAGE_MAX = 300;
const UI_DETAIL_MAX = 2000;
const UI_LABEL_MAX = 80;
const UI_DESCRIPTION_MAX = 200;
const UI_BUTTON_LABEL_MAX = 40;
const UI_VALUE_MAX = 64;
const UI_MAX_CHOICES = 9;

function optionalLabel(text: unknown): string | undefined {
  return typeof text === 'string' && text ? clip(text, UI_BUTTON_LABEL_MAX) : undefined;
}

export function buildUiApi(ctx: CapabilityContext): PluginUiApi | undefined {
  if (!ctx.granted.has('ui.dialogs')) return undefined;
  // Attribution prefix: a plugin dialog must never pass for a CardMirror
  // system prompt (or else that could lead to system inpersonation).
  const name = clip(ctx.name || ctx.pluginId, UI_LABEL_MAX);
  return Object.freeze({
    async choose(opts: Parameters<PluginUiApi['choose']>[0]) {
      if (!opts || typeof opts !== 'object') throw new Error('ui.choose needs an options object');
      const raw: unknown[] = Array.isArray(opts.choices) ? opts.choices : [];
      if (raw.length === 0) throw new Error('ui.choose needs at least one choice');
      if (raw.length > UI_MAX_CHOICES) {
        throw new Error(`ui.choose takes at most ${UI_MAX_CHOICES} choices`);
      }
      const seen = new Set<string>();
      const choices = raw.map((entry) => {
        const c = (entry ?? {}) as Partial<PluginChoiceOption>;
        const value = c.value;
        if (typeof value !== 'string' || !value || value.length > UI_VALUE_MAX || seen.has(value)) {
          throw new Error('ui.choose choice values must be unique non-empty strings (at most 64 chars)');
        }
        seen.add(value);
        return {
          value,
          label: clip(c.label, UI_LABEL_MAX),
          description:
            c.description === undefined ? undefined : clip(c.description, UI_DESCRIPTION_MAX),
        };
      });
      return promptForRouteChoice<string>({
        message: `[${name}] ${clip(opts.message, UI_MESSAGE_MAX)}`,
        detail: opts.detail === undefined ? undefined : clip(opts.detail, UI_DETAIL_MAX),
        choices,
        cancelLabel: optionalLabel(opts.cancelLabel),
      });
    },
    confirm(message: string, opts?: { okLabel?: string; cancelLabel?: string }) {
      return confirmDialog(clip(message, UI_DETAIL_MAX), {
        title: `[${name}]`,
        okLabel: optionalLabel(opts?.okLabel),
        cancelLabel: optionalLabel(opts?.cancelLabel),
      });
    },
  });
}
