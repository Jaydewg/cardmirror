/**
 * AI cite-creator prompt presets.
 *
 * Up to `MAX_CITE_PROMPT_PRESETS` named prompts live in
 * `aiCitePromptPresets`; `aiCitePromptActive` is the index of the one in
 * use (-1 = the built-in default). `aiCitePrompt` — the setting the cite
 * creator and Reformat Every Cite have always read — is kept as a MIRROR
 * of the active preset's text ('' for the built-in), so the consumers,
 * settings backups and older builds see exactly what they did before.
 * Every write goes through here so the mirror never drifts; the settings
 * sanitizer re-derives it on load for the same reason.
 */

import { settings, MAX_CITE_PROMPT_PRESETS, type CitePromptPreset } from '../settings.js';

export { MAX_CITE_PROMPT_PRESETS };
export type { CitePromptPreset };

export function citePromptPresets(): readonly CitePromptPreset[] {
  return settings.get('aiCitePromptPresets');
}

/** Index of the preset in use, or -1 for the built-in default. */
export function activeCitePromptIndex(): number {
  return settings.get('aiCitePromptActive');
}

/** The name a new preset gets when the user leaves the field blank. */
export function defaultCitePromptPresetName(index: number): string {
  return `Preset ${index + 1}`;
}

/** Make preset `index` (or the built-in default, -1) the one in use.
 *  False, and nothing changes, when the index is out of range. */
export function activateCitePromptPreset(index: number): boolean {
  const presets = citePromptPresets();
  if (index !== -1 && !(index >= 0 && index < presets.length)) return false;
  settings.set('aiCitePromptActive', index);
  settings.set('aiCitePrompt', index >= 0 ? presets[index]!.prompt : '');
  return true;
}

/**
 * Save a preset: `index` null adds a new one (null back when the list is
 * full), otherwise replaces that slot. Returns the preset's index. The
 * mirror is refreshed when the saved preset is the active one; adding
 * does not activate — callers do that explicitly.
 */
export function saveCitePromptPreset(index: number | null, name: string, prompt: string): number | null {
  const presets = [...citePromptPresets()];
  const entry: CitePromptPreset = {
    name: name.trim() || defaultCitePromptPresetName(index ?? presets.length),
    prompt,
  };
  let at: number;
  if (index == null) {
    if (presets.length >= MAX_CITE_PROMPT_PRESETS) return null;
    presets.push(entry);
    at = presets.length - 1;
  } else {
    if (!(index >= 0 && index < presets.length)) return null;
    presets[index] = entry;
    at = index;
  }
  settings.set('aiCitePromptPresets', presets);
  if (activeCitePromptIndex() === at) settings.set('aiCitePrompt', entry.prompt);
  return at;
}

/** Remove preset `index`. Deleting the active one falls back to the
 *  built-in default; a later active index shifts down with the list. */
export function deleteCitePromptPreset(index: number): boolean {
  const presets = [...citePromptPresets()];
  if (!(index >= 0 && index < presets.length)) return false;
  presets.splice(index, 1);
  const active = activeCitePromptIndex();
  const nextActive = active === index ? -1 : active > index ? active - 1 : active;
  settings.set('aiCitePromptPresets', presets);
  settings.set('aiCitePromptActive', nextActive);
  settings.set('aiCitePrompt', nextActive >= 0 ? presets[nextActive]!.prompt : '');
  return true;
}
