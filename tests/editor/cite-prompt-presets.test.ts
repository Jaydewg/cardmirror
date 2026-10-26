// @vitest-environment jsdom

/**
 * AI cite-creator prompt presets (ai/cite-prompt-presets.ts + the
 * settings sanitizer): up to ten named prompts, one in use, with
 * `aiCitePrompt` — what the cite creator reads — kept as a mirror of the
 * active one. Legacy single-prompt settings become one preset.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { SettingsStore, settings, MAX_CITE_PROMPT_PRESETS } from '../../src/editor/settings.js';
import {
  activateCitePromptPreset,
  activeCitePromptIndex,
  citePromptPresets,
  deleteCitePromptPreset,
  saveCitePromptPreset,
} from '../../src/editor/ai/cite-prompt-presets.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  getRibbonCommand,
} from '../../src/editor/ribbon-commands.js';

function reset(): void {
  settings.set('aiCitePromptPresets', []);
  settings.set('aiCitePromptActive', -1);
  settings.set('aiCitePrompt', '');
}
beforeEach(reset);
afterEach(reset);

describe('sanitizer', () => {
  it('a pre-preset settings file with a custom prompt becomes one active preset', () => {
    const s = new SettingsStore();
    s.replaceAll({ aiCitePrompt: 'my custom prompt' });
    expect(s.get('aiCitePromptPresets')).toEqual([{ name: 'My prompt', prompt: 'my custom prompt' }]);
    expect(s.get('aiCitePromptActive')).toBe(0);
    expect(s.get('aiCitePrompt')).toBe('my custom prompt');
  });

  it('a blank legacy prompt stays the built-in default with no presets', () => {
    const s = new SettingsStore();
    s.replaceAll({ aiCitePrompt: '  ' });
    expect(s.get('aiCitePromptPresets')).toEqual([]);
    expect(s.get('aiCitePromptActive')).toBe(-1);
    expect(s.get('aiCitePrompt')).toBe('');
  });

  it('caps the list, types each entry, defaults blank names, and re-derives the mirror', () => {
    const s = new SettingsStore();
    const raw = Array.from({ length: 14 }, (_, i) => ({ name: i === 2 ? '   ' : `P${i}`, prompt: `prompt ${i}` }));
    s.replaceAll({
      aiCitePromptPresets: [...raw, 'junk', { name: 'no prompt' }] as never,
      aiCitePromptActive: 2,
      aiCitePrompt: 'stale mirror',
    });
    const presets = s.get('aiCitePromptPresets');
    expect(presets).toHaveLength(MAX_CITE_PROMPT_PRESETS);
    expect(presets[2]).toEqual({ name: 'Preset 3', prompt: 'prompt 2' });
    expect(s.get('aiCitePrompt')).toBe('prompt 2');
  });

  it('an out-of-range active index falls back to the built-in default', () => {
    const s = new SettingsStore();
    s.replaceAll({ aiCitePromptPresets: [{ name: 'A', prompt: 'a' }], aiCitePromptActive: 7, aiCitePrompt: 'a' });
    expect(s.get('aiCitePromptActive')).toBe(-1);
    expect(s.get('aiCitePrompt')).toBe('');
  });
});

describe('preset operations', () => {
  it('save adds presets up to the cap, naming blanks, without activating', () => {
    expect(saveCitePromptPreset(null, 'Law reviews', 'LR prompt')).toBe(0);
    expect(saveCitePromptPreset(null, '   ', 'second')).toBe(1);
    expect(citePromptPresets()[1]!.name).toBe('Preset 2');
    expect(activeCitePromptIndex()).toBe(-1);
    expect(settings.get('aiCitePrompt')).toBe('');
    for (let i = 2; i < MAX_CITE_PROMPT_PRESETS; i++) expect(saveCitePromptPreset(null, `p${i}`, 'x')).toBe(i);
    expect(saveCitePromptPreset(null, 'one too many', 'x')).toBeNull();
    expect(citePromptPresets()).toHaveLength(MAX_CITE_PROMPT_PRESETS);
  });

  it('activate mirrors the chosen prompt into aiCitePrompt; -1 clears it', () => {
    saveCitePromptPreset(null, 'A', 'prompt a');
    saveCitePromptPreset(null, 'B', 'prompt b');
    expect(activateCitePromptPreset(1)).toBe(true);
    expect(settings.get('aiCitePrompt')).toBe('prompt b');
    expect(activateCitePromptPreset(-1)).toBe(true);
    expect(settings.get('aiCitePrompt')).toBe('');
    expect(activateCitePromptPreset(5)).toBe(false);
  });

  it('editing the active preset refreshes the mirror; editing another does not', () => {
    saveCitePromptPreset(null, 'A', 'prompt a');
    saveCitePromptPreset(null, 'B', 'prompt b');
    activateCitePromptPreset(0);
    saveCitePromptPreset(1, 'B2', 'prompt b2');
    expect(settings.get('aiCitePrompt')).toBe('prompt a');
    saveCitePromptPreset(0, 'A2', 'prompt a2');
    expect(settings.get('aiCitePrompt')).toBe('prompt a2');
    expect(citePromptPresets().map((p) => p.name)).toEqual(['A2', 'B2']);
  });

  it('delete: the active one falls back to the default; a later active index shifts down', () => {
    saveCitePromptPreset(null, 'A', 'a');
    saveCitePromptPreset(null, 'B', 'b');
    saveCitePromptPreset(null, 'C', 'c');
    activateCitePromptPreset(2);
    expect(deleteCitePromptPreset(0)).toBe(true);
    expect(activeCitePromptIndex()).toBe(1);
    expect(settings.get('aiCitePrompt')).toBe('c');
    expect(deleteCitePromptPreset(1)).toBe(true);
    expect(activeCitePromptIndex()).toBe(-1);
    expect(settings.get('aiCitePrompt')).toBe('');
    expect(citePromptPresets().map((p) => p.name)).toEqual(['B']);
    expect(deleteCitePromptPreset(9)).toBe(false);
  });
});

describe('ribbon commands', () => {
  const state = () => EditorState.create({ doc: schema.nodes['doc']!.create(null, [schema.nodes['paragraph']!.create()]) });

  it('ten preset commands and the built-in one are registered, labeled, and unbound', () => {
    for (let n = 1; n <= 10; n++) {
      const id = `aiCitePromptPreset${n}` as keyof typeof RIBBON_COMMAND_LABELS;
      expect(RIBBON_COMMAND_IDS).toContain(id);
      expect(RIBBON_COMMAND_LABELS[id]).toBe(`AI Cite Creator: Use Prompt Preset ${n}`);
      expect(DEFAULT_RIBBON_KEYS[id]).toBe('');
    }
    expect(RIBBON_COMMAND_LABELS['aiCitePromptDefault']).toBe('AI Cite Creator: Use Built-in Prompt');
    expect(DEFAULT_RIBBON_KEYS['aiCitePromptDefault']).toBe('');
  });

  it('a preset command switches the prompt in use; a missing preset is a no-op', () => {
    saveCitePromptPreset(null, 'News', 'news prompt');
    saveCitePromptPreset(null, 'Law', 'law prompt');
    expect(getRibbonCommand('aiCitePromptPreset2')(state(), () => {})).toBe(true);
    expect(activeCitePromptIndex()).toBe(1);
    expect(settings.get('aiCitePrompt')).toBe('law prompt');
    expect(getRibbonCommand('aiCitePromptPreset7')(state(), () => {})).toBe(true);
    expect(activeCitePromptIndex()).toBe(1); // unchanged
    expect(getRibbonCommand('aiCitePromptDefault')(state(), () => {})).toBe(true);
    expect(activeCitePromptIndex()).toBe(-1);
    expect(settings.get('aiCitePrompt')).toBe('');
  });
});
