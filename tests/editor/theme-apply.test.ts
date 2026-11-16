// @vitest-environment jsdom
/**
 * Appearance → <html> attributes (theme-apply.ts): theme, palette,
 * accent, texture, and the "paper document" switch, plus the settings
 * boundary for the new keys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyAppearance,
  deriveCustomAccent,
  FALLBACK_TEXTURE_OPACITY,
  MAX_CUSTOM_TEXTURE_OPACITY,
  MAX_TEXTURE_OPACITY,
  imageScheme,
  rescaleIntensity,
  textureCeiling,
  maxTextureOpacity,
  resolveScheme,
  type AppearanceSettings,
} from '../../src/editor/theme-apply.js';
import { BLACK, WHITE, contrast, mix, parseCssColor, parseHex } from '../../src/editor/color-math.js';
import { PALETTE_OPTIONS } from '../../src/editor/theme-options.js';
import { settings, SETTING_METADATA, SETTINGS_DEFAULTS } from '../../src/editor/settings.js';

const base: AppearanceSettings = {
  theme: 'light',
  themeAppliesToDocument: false,
  themePalette: 'default',
  themeAccent: 'auto',
  chromeTexture: 'auto',
  chromeTextureIntensity: 40,
  chromeTextureFit: 'tile',
  themeAccentCustom: '#2563eb',
  chromeTextureCustomTones: null,
  chromeTextureMatch: 'bars',
  chromeTextureUncapped: false,
};
const DARK_PHOTO = { darkest: '#050505', lightest: '#5a5a5a' };
const BRIGHT_PHOTO = { darkest: '#9a9a9a', lightest: '#ffffff' };

function attrs(root: HTMLElement): Record<string, string | null> {
  const names = ['data-theme', 'data-theme-doc', 'data-palette', 'data-accent', 'data-texture', 'data-doc-paper', 'data-bar-scheme'];
  return Object.fromEntries(names.map((n) => [n, root.getAttribute(n)]));
}

describe('applyAppearance', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('html');
  });

  it('writes nothing themed for the stock light look', () => {
    applyAppearance(base, root);
    expect(attrs(root)).toEqual({
      'data-theme': null,
      'data-theme-doc': null,
      'data-palette': null,
      'data-accent': null,
      'data-texture': null,
      'data-doc-paper': null,
      'data-bar-scheme': null,
    });
  });

  it('keeps the pre-existing dark-mode behavior (paper doc unless applied)', () => {
    applyAppearance({ ...base, theme: 'dark' }, root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-theme-doc')).toBeNull();
    expect(root.hasAttribute('data-doc-paper')).toBe(true);

    applyAppearance({ ...base, theme: 'dark', themeAppliesToDocument: true }, root);
    expect(root.getAttribute('data-theme-doc')).toBe('dark');
    expect(root.hasAttribute('data-doc-paper')).toBe(false);
  });

  it('a light palette keeps the document paper unless apply-to-document is on', () => {
    applyAppearance({ ...base, themePalette: 'sepia' }, root);
    expect(root.getAttribute('data-palette')).toBe('sepia');
    expect(root.hasAttribute('data-doc-paper')).toBe(true);
    expect(root.getAttribute('data-theme-doc')).toBeNull();

    applyAppearance({ ...base, themePalette: 'sepia', themeAppliesToDocument: true }, root);
    expect(root.hasAttribute('data-doc-paper')).toBe(false);
    // data-theme-doc stays a dark-only signal (dark band-color rules key off it).
    expect(root.getAttribute('data-theme-doc')).toBeNull();
  });

  it('clears palette / accent / texture when switched back', () => {
    applyAppearance({ ...base, themePalette: 'slate', themeAccent: 'teal', chromeTexture: 'dots' }, root);
    expect(attrs(root)).toMatchObject({ 'data-palette': 'slate', 'data-accent': 'teal', 'data-texture': 'dots' });
    applyAppearance(base, root);
    expect(attrs(root)).toMatchObject({ 'data-palette': null, 'data-accent': null, 'data-texture': null });
  });

  it('starts from a safe placeholder opacity until the cap is measured', () => {
    applyAppearance({ ...base, chromeTextureIntensity: 100 }, root);
    expect(Number(root.style.getPropertyValue('--pmd-chrome-texture-opacity'))).toBeCloseTo(FALLBACK_TEXTURE_OPACITY);
    applyAppearance({ ...base, chromeTextureIntensity: 50 }, root);
    expect(Number(root.style.getPropertyValue('--pmd-chrome-texture-opacity'))).toBeCloseTo(FALLBACK_TEXTURE_OPACITY / 2, 2);
    applyAppearance({ ...base, chromeTexture: 'custom', chromeTextureFit: 'cover' }, root);
    expect(root.style.getPropertyValue('--pmd-chrome-texture-size')).toBe('cover');
    applyAppearance({ ...base, chromeTexture: 'grid' }, root);
    expect(root.style.getPropertyValue('--pmd-chrome-texture-size')).toBe('');
  });

  it('uncapped: 100% means the fixed ceiling, no measuring needed', () => {
    applyAppearance({ ...base, chromeTexture: 'dots', chromeTextureIntensity: 100, chromeTextureUncapped: true }, root);
    expect(Number(root.style.getPropertyValue('--pmd-chrome-texture-opacity'))).toBeCloseTo(MAX_TEXTURE_OPACITY);
    applyAppearance({ ...base, chromeTexture: 'custom', chromeTextureIntensity: 50, chromeTextureUncapped: true }, root);
    expect(Number(root.style.getPropertyValue('--pmd-chrome-texture-opacity'))).toBeCloseTo(MAX_CUSTOM_TEXTURE_OPACITY / 2, 2);
    expect(textureCeiling({ chromeTexture: 'auto', themePalette: 'default' })).toBeNull(); // default palette: no texture
    expect(textureCeiling({ chromeTexture: 'auto', themePalette: 'sepia' })).toBe(MAX_TEXTURE_OPACITY);
  });

  it('a dark image re-schemes just the bars on a light theme ("Just the bars")', () => {
    applyAppearance({ ...base, chromeTexture: 'custom', chromeTextureCustomTones: DARK_PHOTO }, root);
    expect(root.getAttribute('data-bar-scheme')).toBe('dark');
    expect(root.getAttribute('data-theme')).toBeNull();
    // Already dark: nothing to switch.
    applyAppearance({ ...base, theme: 'dark', chromeTexture: 'custom', chromeTextureCustomTones: DARK_PHOTO }, root);
    expect(root.getAttribute('data-bar-scheme')).toBeNull();
    // A bright image on dark chrome goes the other way.
    applyAppearance({ ...base, theme: 'dark', chromeTexture: 'custom', chromeTextureCustomTones: BRIGHT_PHOTO }, root);
    expect(root.getAttribute('data-bar-scheme')).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('"Whole interface" flips the page theme instead, keeping the document paper', () => {
    applyAppearance({ ...base, chromeTexture: 'custom', chromeTextureCustomTones: DARK_PHOTO, chromeTextureMatch: 'interface' }, root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-bar-scheme')).toBeNull();
    expect(root.hasAttribute('data-doc-paper')).toBe(true);
  });

  it('matching is off for "Off", bundled textures, and unmeasured images', () => {
    for (const s of [
      { ...base, chromeTexture: 'custom' as const, chromeTextureCustomTones: DARK_PHOTO, chromeTextureMatch: 'off' as const },
      { ...base, chromeTexture: 'dots' as const, chromeTextureCustomTones: DARK_PHOTO },
      { ...base, chromeTexture: 'custom' as const, chromeTextureCustomTones: null },
    ]) {
      applyAppearance(s, root);
      expect(root.getAttribute('data-bar-scheme')).toBeNull();
      expect(root.getAttribute('data-theme')).toBeNull();
    }
  });

  it('writes the derived custom accent inline, and clears it otherwise', () => {
    applyAppearance({ ...base, themeAccent: 'custom', themeAccentCustom: '#ffcc00' }, root);
    expect(root.getAttribute('data-accent')).toBe('custom');
    const a = deriveCustomAccent('#ffcc00');
    expect(root.style.getPropertyValue('--pmd-accent-custom')).toBe(a.light);
    expect(root.style.getPropertyValue('--pmd-accent-custom-dark')).toBe(a.dark);
    applyAppearance(base, root);
    expect(root.style.getPropertyValue('--pmd-accent-custom')).toBe('');
  });
});

describe('imageScheme / resolveScheme', () => {
  it('reads dark and bright images', () => {
    expect(imageScheme(DARK_PHOTO)).toBe('dark');
    expect(imageScheme(BRIGHT_PHOTO)).toBe('light');
    // Deep blacks and bright whites: neither helps, so nothing switches.
    expect(imageScheme({ darkest: '#000000', lightest: '#ffffff' })).toBeNull();
    const r = document.createElement('html');
    applyAppearance({ ...base, chromeTexture: 'custom', chromeTextureCustomTones: { darkest: '#000000', lightest: '#ffffff' } }, r);
    expect(r.getAttribute('data-bar-scheme')).toBeNull();
  });

  it('only matches a custom image with measured tones', () => {
    const custom = { ...base, chromeTexture: 'custom' as const, chromeTextureCustomTones: DARK_PHOTO };
    expect(resolveScheme(custom, false)).toEqual({ dark: false, barScheme: 'dark', imageScheme: 'dark' });
    expect(resolveScheme({ ...custom, chromeTextureMatch: 'interface' }, false)).toEqual({ dark: true, barScheme: null, imageScheme: 'dark' });
    expect(resolveScheme({ ...custom, chromeTextureMatch: 'off' }, false).imageScheme).toBeNull();
  });
});

describe('deriveCustomAccent', () => {
  const lightBgs = PALETTE_OPTIONS.map((p) => parseHex(p.light.bg)!);
  const darkBgs = PALETTE_OPTIONS.map((p) => parseHex(p.dark.bg)!);
  it.each(['#2563eb', '#ffcc00', '#ffffff', '#000000', '#00ff00', '#ff00ff', '#7a3fd1', '#1a237e', '#87ceeb'])(
    '%s meets the preset bar in light and dark',
    (hex) => {
      const a = deriveCustomAccent(hex);
      const l = parseHex(a.light)!;
      const d = parseHex(a.dark)!;
      expect(contrast(WHITE, l)).toBeGreaterThanOrEqual(4.5);
      for (const bg of lightBgs) expect(contrast(l, bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(WHITE, d)).toBeGreaterThanOrEqual(3);
      for (const bg of darkBgs) expect(contrast(d, bg)).toBeGreaterThanOrEqual(3);
    },
  );

  it('leaves a color that already passes alone, and flags a nudged one', () => {
    expect(deriveCustomAccent('#2563eb')).toMatchObject({ light: '#2563eb', adjusted: false });
    const y = deriveCustomAccent('#ffcc00');
    expect(y.adjusted).toBe(true);
    // Still recognizably the same hue: red > green > blue, like the pick.
    const [r, g, b] = parseHex(y.light)!;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});

describe('maxTextureOpacity', () => {
  const surface = parseHex('#f3f3f3')!;
  const muted = { color: parseHex('#666666')!, min: 4.5 };

  it('finds the strongest opacity that keeps every color passing', () => {
    const a = maxTextureOpacity(surface, [muted], [{ color: BLACK, coverage: 1 }], 0.35);
    expect(a).toBeGreaterThan(0.03);
    expect(contrast(muted.color, mix(surface, BLACK, a))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted.color, mix(surface, BLACK, a + 0.01))).toBeLessThan(4.5);
  });

  it('partial coverage allows proportionally more, up to the ceiling', () => {
    const full = maxTextureOpacity(surface, [muted], [{ color: BLACK, coverage: 1 }], 0.35);
    const half = maxTextureOpacity(surface, [muted], [{ color: BLACK, coverage: 0.5 }], 0.35);
    expect(half).toBeCloseTo(Math.min(0.35, full * 2), 2);
  });

  it('a light pixel under dark text costs nothing; a color failing on plain bg is skipped', () => {
    expect(maxTextureOpacity(surface, [muted], [{ color: WHITE, coverage: 1 }], 0.35)).toBe(0.35);
    const failing = { color: parseHex('#dddddd')!, min: 4.5 };
    expect(maxTextureOpacity(surface, [failing], [{ color: BLACK, coverage: 1 }], 0.35)).toBe(0.35);
  });
});

describe('parseCssColor', () => {
  it('reads the forms getComputedStyle returns', () => {
    expect(parseCssColor('rgb(243, 243, 243)')).toEqual({ rgb: [243, 243, 243], alpha: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0)')!.alpha).toBe(0);
    expect(parseCssColor(' #222')).toEqual({ rgb: [34, 34, 34], alpha: 1 });
    expect(parseCssColor('color(srgb 1 0.5 0)')!.rgb).toEqual([255, 127.5, 0]);
    expect(parseCssColor('var(--x)')).toBeNull();
  });
});

describe('appearance settings', () => {
  it('defaults leave the stock look untouched', () => {
    expect(SETTINGS_DEFAULTS.themePalette).toBe('default');
    expect(SETTINGS_DEFAULTS.themeAccent).toBe('auto');
    expect(SETTINGS_DEFAULTS.chromeTexture).toBe('auto');
  });

  it('sanitizes unknown values and clamps intensity', () => {
    const before = settings.all();
    try {
      settings.replaceAll({
        themePalette: 'neon',
        themeAccent: 42,
        chromeTexture: 'plaid',
        chromeTextureIntensity: 900,
        chromeTextureFit: 'stretch',
        chromeTextureCustomRev: 7,
        themeAccentCustom: 'blue',
        chromeTextureMatch: 'always',
        chromeTextureCustomTones: { darkest: '#00', lightest: 5 },
        chromeTextureUncapped: 'yes',
      });
      expect(settings.get('chromeTextureUncapped')).toBe(false);
      expect(settings.get('themePalette')).toBe('default');
      expect(settings.get('themeAccent')).toBe('auto');
      expect(settings.get('chromeTexture')).toBe('auto');
      expect(settings.get('chromeTextureIntensity')).toBe(100);
      expect(settings.get('chromeTextureFit')).toBe('tile');
      expect(settings.get('chromeTextureCustomRev')).toBe('');
      expect(settings.get('themeAccentCustom')).toBe(SETTINGS_DEFAULTS.themeAccentCustom);
      expect(settings.get('chromeTextureMatch')).toBe('bars');
      expect(settings.get('chromeTextureCustomTones')).toBeNull();

      settings.replaceAll({
        themePalette: 'forest',
        themeAccent: 'custom',
        themeAccentCustom: '#AABBCC',
        chromeTexture: 'linen',
        chromeTextureIntensity: -5,
        chromeTextureMatch: 'interface',
        chromeTextureCustomTones: { darkest: '#0A0A0A', lightest: '#fafafa' },
      });
      expect(settings.get('themeAccentCustom')).toBe('#aabbcc');
      expect(settings.get('chromeTextureMatch')).toBe('interface');
      expect(settings.get('chromeTextureCustomTones')).toEqual({ darkest: '#0a0a0a', lightest: '#fafafa' });
      expect(settings.get('themePalette')).toBe('forest');
      expect(settings.get('themeAccent')).toBe('custom');
      expect(settings.get('chromeTexture')).toBe('linen');
      expect(settings.get('chromeTextureIntensity')).toBe(0);
    } finally {
      settings.replaceAll(before);
    }
  });

  it('lists the pickers under Appearance → Theme & chrome', () => {
    for (const key of ['themePalette', 'themeAccent', 'chromeTexture'] as const) {
      const meta = SETTING_METADATA.find((m) => m.key === key)!;
      expect(meta.category).toBe('appearance');
      expect(meta.section).toBe('Theme & chrome');
      expect(meta.kind).toBe(key);
    }
  });

  it('main windows and the timer popout both go through applyAppearance', () => {
    const index = readFileSync(resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
    const popout = readFileSync(resolve(process.cwd(), 'src/editor/timer-popout.ts'), 'utf8');
    expect(index).not.toMatch(/function applyTheme\(/);
    expect(index).toContain('applyAppearance(s)');
    expect(index).toContain('initChromeTexture()');
    expect(popout).toContain('applyAppearance(settings.all())');
  });

  it('themes.css loads after style.css in every page that loads style.css', () => {
    for (const page of ['index.html', 'timer.html']) {
      const html = readFileSync(resolve(process.cwd(), page), 'utf8');
      const a = html.indexOf('/src/editor/style.css');
      const b = html.indexOf('/src/editor/themes.css');
      expect(a, page).toBeGreaterThan(-1);
      expect(b, page).toBeGreaterThan(a);
    }
  });
});

describe('rescaleIntensity', () => {
  it('keeps the same strength across the readable and uncapped scales', () => {
    // Readable limit at 44% of the ceiling: 70% of the readable range is
    // 0.7 × 0.44 = 31% of the ceiling, and back.
    expect(rescaleIntensity(70, true, 0.44)).toBe(31);
    expect(rescaleIntensity(31, false, 0.44)).toBe(70);
    // Past the limit, switching the cap back on clamps to the readable max.
    expect(rescaleIntensity(80, false, 0.44)).toBe(100);
  });

  it('leaves the value alone when the limit is unknown', () => {
    expect(rescaleIntensity(70, true, null)).toBe(70);
    expect(rescaleIntensity(70, false, 0)).toBe(70);
  });
});
