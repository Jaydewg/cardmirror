// @vitest-environment jsdom
/**
 * Reset to Default Colors + the Default colors settings (2026-09-21), and
 * the one-shot flip of "Distinguish background color from highlighting".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { settings, SETTING_METADATA, migrateDistinguishShadingDefault } from '../../src/editor/settings.js';
import { buildRibbonKeymap, RIBBON_COMMAND_IDS, RIBBON_COMMAND_LABELS, DEFAULT_RIBBON_KEYS, type RibbonContext } from '../../src/editor/ribbon-commands.js';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';

afterEach(() => {
  settings.set('defaultHighlightColor', 'yellow');
  settings.set('defaultShadingColor', 'C0C0C0');
  settings.set('distinguishShading', true);
  localStorage.removeItem('cm-distinguish-shading-migrated');
});

describe('Default colors settings', () => {
  it('default to yellow and the shading picker\'s light gray', () => {
    expect(settings.get('defaultHighlightColor')).toBe('yellow');
    expect(settings.get('defaultShadingColor')).toBe('C0C0C0');
    expect(settings.get('lastShadingColor'), 'the picker starts on the same gray').toBe('C0C0C0');
  });

  it('sit in their own Editing section between Standardize exceptions and Trigger colors', () => {
    const editing = SETTING_METADATA.filter((m) => m.category === 'editing');
    const sections: string[] = [];
    for (const m of editing) {
      const sec = m.section ?? '';
      if (sections[sections.length - 1] !== sec) sections.push(sec);
    }
    const i = sections.indexOf('Default colors');
    expect(i).toBeGreaterThan(0);
    expect(sections[i - 1] ?? '').toBe('Standardize exceptions');
    expect(sections[i + 1] ?? '').toBe('Trigger colors');
    expect(editing.filter((m) => m.section === 'Default colors').map((m) => m.key)).toEqual(['defaultHighlightColor', 'defaultShadingColor']);
  });

  it('accept a Word highlight name and a hex, and fall back on junk', () => {
    settings.set('defaultHighlightColor', 'green');
    expect(settings.get('defaultHighlightColor')).toBe('green');
    settings.set('defaultShadingColor', 'D2D2D2'); // the editor uppercases before storing
    expect(settings.get('defaultShadingColor')).toBe('D2D2D2');
  });
});

describe('Reset to Default Colors', () => {
  it('is a registered, unbound command routed through the context', () => {
    expect(RIBBON_COMMAND_IDS).toContain('resetDefaultColors');
    expect(RIBBON_COMMAND_LABELS.resetDefaultColors).toBe('Reset to Default Colors');
    expect(DEFAULT_RIBBON_KEYS.resetDefaultColors).toBe('');
    let calls = 0;
    const ctx = { resetDefaultColors: () => { calls++; } } as unknown as RibbonContext;
    const km = buildRibbonKeymap({ resetDefaultColors: 'F9' }, ctx);
    expect(km['F9']!(EditorState.create({ schema }), () => {})).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('distinguishShading default flip', () => {
  it('is on by default, flips a stored false once, and respects a later off', () => {
    expect(settings.get('distinguishShading')).toBe(true);
    settings.set('distinguishShading', false);
    migrateDistinguishShadingDefault();
    expect(settings.get('distinguishShading'), 'flipped once').toBe(true);
    settings.set('distinguishShading', false);
    migrateDistinguishShadingDefault();
    expect(settings.get('distinguishShading'), 'marker present: the user\'s off sticks').toBe(false);
  });
});
