/**
 * themes.css structure + contrast guardrails.
 *
 * - every palette / accent has a light AND a dark block, and each dark
 *   palette block re-sets every token its light block sets (otherwise the
 *   light value leaks into dark mode — see the header of themes.css);
 * - the accent family is only derived outside the color-vision preset;
 * - the picker previews (theme-options.ts) match the CSS;
 * - WCAG contrast for chrome text, the accent, and text over the
 *   strongest bundled texture.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_ACCENTS, THEME_PALETTES } from '../../src/editor/settings.js';
import { ACCENT_OPTIONS, PALETTE_OPTIONS, PALETTE_TEXTURE } from '../../src/editor/theme-options.js';
import { MAX_TEXTURE_OPACITY, TEXTURED_BARS, TILE_COVERAGE, maxTextureOpacity } from '../../src/editor/theme-apply.js';
import { BLACK, WHITE, contrast as contrastRgb, mix as mixRgb, parseHex } from '../../src/editor/color-math.js';

const themes = readFileSync(resolve(process.cwd(), 'src/editor/themes.css'), 'utf8');
const style = readFileSync(resolve(process.cwd(), 'src/editor/style.css'), 'utf8');

/** Declarations of every top-level rule whose selector list STARTS with
 *  exactly `selector` (a `data-bar-scheme` twin may follow it), merged in
 *  source order. */
function block(css: string, selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g');
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(css))) {
    found = true;
    const body = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  if (!found) throw new Error(`no rule for ${selector}`);
  return out;
}

function lum(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const PALETTES = THEME_PALETTES.filter((p) => p !== 'default');
const ACCENTS = THEME_ACCENTS.filter((a) => a !== 'auto' && a !== 'custom');
const light = (p: string): Record<string, string> => block(themes, `:root[data-palette="${p}"]`);
const dark = (p: string): Record<string, string> => block(themes, `:root[data-theme="dark"][data-palette="${p}"]`);
const accentLight = (a: string): Record<string, string> => block(themes, `:root[data-accent="${a}"]`);
const accentDark = (a: string): Record<string, string> => block(themes, `:root[data-theme="dark"][data-accent="${a}"]`);
const stockLight = block(style, ':root');
const stockDark = block(style, ':root[data-theme="dark"]');

describe('themes.css structure', () => {
  it.each(PALETTES)('palette %s: the dark block re-sets every light token', (p) => {
    const lightKeys = Object.keys(light(p)).filter((k) => k !== '--pmd-palette-texture');
    const darkKeys = new Set(Object.keys(dark(p)));
    expect(lightKeys.filter((k) => !darkKeys.has(k))).toEqual([]);
    expect(light(p)['--pmd-accent']).toBeTruthy();
    expect(light(p)['--pmd-accent-hover']).toBeTruthy();
  });

  it.each(ACCENTS)('accent %s: light and dark variants', (a) => {
    expect(accentLight(a)['--pmd-accent']).toMatch(/^#/);
    expect(accentDark(a)['--pmd-accent']).toMatch(/^#/);
  });

  it('palettes and accents never set the accent tokens directly (only via the derivation rule)', () => {
    for (const p of PALETTES) {
      expect(light(p)['--pmd-c-accent']).toBeUndefined();
      expect(dark(p)['--pmd-c-accent']).toBeUndefined();
    }
    const derive = block(themes, ':root:not([data-cvd]):is([data-palette], [data-accent])');
    expect(derive['--pmd-c-accent']).toBe('var(--pmd-accent)');
    expect(derive['--pmd-c-focus']).toBe('var(--pmd-accent)');
  });

  it('style.css paper-restore rules key off data-doc-paper', () => {
    expect(style).not.toContain(':not([data-theme-doc="dark"])');
    expect(style.match(/:root\[data-doc-paper\]/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('every themed color block also targets the re-schemed bars (data-bar-scheme)', () => {
    const bars = `:is(${TEXTURED_BARS})`;
    /** The selector list of the rule whose list starts with `first,`. */
    const selectorList = (css: string, first: string): string => {
      const i = css.search(new RegExp(`(?:^|\\n)${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`));
      expect(i, first).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf('{', i));
    };
    const twins: [string, string, string][] = [
      [style, ':root', ':root[data-bar-scheme="light"]'],
      [style, ':root[data-theme="dark"]', ':root[data-bar-scheme="dark"]'],
      [style, ':root[data-cvd="friendly"]', ':root[data-bar-scheme="light"][data-cvd="friendly"]'],
      [style, ':root[data-theme="dark"][data-cvd="friendly"]', ':root[data-bar-scheme="dark"][data-cvd="friendly"]'],
      [themes, ':root:not([data-cvd]):is([data-palette], [data-accent])', ':root[data-bar-scheme]:not([data-cvd]):is([data-palette], [data-accent])'],
    ];
    for (const p of PALETTES) {
      twins.push([themes, `:root[data-palette="${p}"]`, `:root[data-bar-scheme="light"][data-palette="${p}"]`]);
      twins.push([themes, `:root[data-theme="dark"][data-palette="${p}"]`, `:root[data-bar-scheme="dark"][data-palette="${p}"]`]);
    }
    for (const a of [...ACCENTS, 'custom']) {
      twins.push([themes, `:root[data-accent="${a}"]`, `:root[data-bar-scheme="light"][data-accent="${a}"]`]);
      twins.push([themes, `:root[data-theme="dark"][data-accent="${a}"]`, `:root[data-bar-scheme="dark"][data-accent="${a}"]`]);
    }
    for (const [css, first, twin] of twins) {
      const list = selectorList(css, first).replace(/\s+/g, ' ');
      expect(list, first).toContain(`${twin} ${bars}`);
    }
  });

  it('the stock color tokens are split from layout values (inline --nav-width must not be reset on the bars)', () => {
    const layout = block(style, ':root');
    expect(layout['--nav-width']).toBeTruthy();
    const colorRule = /\n:root,\n:root\[data-bar-scheme="light"\][^{]*\{([^}]*)\}/.exec(style);
    expect(colorRule).toBeTruthy();
    expect(colorRule![1]).toContain('--pmd-c-text:');
    expect(colorRule![1]).not.toContain('--nav-width');
    expect(colorRule![1]).not.toContain('--pmd-ui-font');
  });

  it('bundled texture tiles stay under 1 KB each', () => {
    for (const t of ['grain', 'dots', 'grid', 'linen']) {
      const m = new RegExp(`--pmd-tex-${t}: (url\\("[^"]*"\\));`).exec(themes);
      expect(m, t).toBeTruthy();
      expect(m![1]!.length, t).toBeLessThan(1024);
    }
  });
});

describe('picker previews match the CSS', () => {
  it.each(PALETTES)('palette %s', (p) => {
    const opt = PALETTE_OPTIONS.find((o) => o.value === p)!;
    for (const [sw, css] of [[opt.light, light(p)], [opt.dark, dark(p)]] as const) {
      expect(sw.bg).toBe(css['--pmd-c-bg']);
      expect(sw.surface).toBe(css['--pmd-c-surface']);
      expect(sw.text).toBe(css['--pmd-c-text']);
      expect(sw.accent).toBe(css['--pmd-accent']);
    }
    expect(light(p)['--pmd-palette-texture']).toBe(`var(--pmd-tex-${PALETTE_TEXTURE[p]})`);
  });

  it('default palette mirrors the stock style.css tokens', () => {
    const opt = PALETTE_OPTIONS.find((o) => o.value === 'default')!;
    const norm = (h: string): string => {
      const x = h.replace('#', '').toLowerCase();
      return '#' + (x.length === 3 ? [...x].map((c) => c + c).join('') : x);
    };
    expect(opt.light.bg).toBe(norm(stockLight['--pmd-c-bg']!));
    expect(opt.light.surface).toBe(norm(stockLight['--pmd-c-surface']!));
    expect(opt.light.accent).toBe(norm(stockLight['--pmd-c-accent']!));
    expect(opt.dark.bg).toBe(norm(stockDark['--pmd-c-bg']!));
    expect(opt.dark.surface).toBe(norm(stockDark['--pmd-c-surface']!));
    expect(opt.dark.accent).toBe(norm(stockDark['--pmd-c-accent']!));
  });

  it.each(ACCENTS)('accent %s', (a) => {
    const opt = ACCENT_OPTIONS.find((o) => o.value === a)!;
    expect(opt.light).toBe(accentLight(a)['--pmd-accent']);
    expect(opt.dark).toBe(accentDark(a)['--pmd-accent']);
  });
});

describe('contrast', () => {
  const TEXT = ['--pmd-c-text', '--pmd-c-text-secondary', '--pmd-c-text-muted'];

  it.each(PALETTES)('palette %s: chrome text >= 4.5:1 on bg and surface', (p) => {
    for (const css of [light(p), dark(p)]) {
      for (const t of TEXT) {
        for (const bgKey of ['--pmd-c-bg', '--pmd-c-surface', '--pmd-c-surface-alt']) {
          expect(contrast(css[t]!, css[bgKey]!), `${p} ${t} on ${bgKey}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it.each(PALETTES)('palette %s: accent readable as a fill and as a mark', (p) => {
    const l = light(p);
    const d = dark(p);
    expect(contrast('#ffffff', l['--pmd-accent']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(l['--pmd-accent']!, l['--pmd-c-bg']!)).toBeGreaterThanOrEqual(3);
    // Dark: white-on-accent meets the stock dark blue's own bar (3:1).
    expect(contrast('#ffffff', d['--pmd-accent']!)).toBeGreaterThanOrEqual(3);
    expect(contrast(d['--pmd-accent']!, d['--pmd-c-bg']!)).toBeGreaterThanOrEqual(3);
  });

  it.each(ACCENTS)('accent %s works on every palette', (a) => {
    const al = accentLight(a)['--pmd-accent']!;
    const ad = accentDark(a)['--pmd-accent']!;
    expect(contrast('#ffffff', al)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', ad)).toBeGreaterThanOrEqual(3);
    const lightBgs = ['#ffffff', ...PALETTES.map((p) => light(p)['--pmd-c-bg']!)];
    const darkBgs = ['#1a1a1a', ...PALETTES.map((p) => dark(p)['--pmd-c-bg']!)];
    for (const bg of lightBgs) expect(contrast(al, bg), `${a} on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const bg of darkBgs) expect(contrast(ad, bg), `${a} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  /** Every light/dark token set the bars can show: stock + palettes. */
  const tokenSets = (): [string, Record<string, string>, boolean][] => [
    ['stock light', { ...stockLight, '--pmd-accent': stockLight['--pmd-c-accent']! }, false],
    ['stock dark', { ...stockLight, ...stockDark, '--pmd-accent': stockDark['--pmd-c-accent']! }, true],
    ...PALETTES.flatMap((p): [string, Record<string, string>, boolean][] => [
      [`${p} light`, light(p), false],
      [`${p} dark`, dark(p), true],
    ]),
  ];

  it('the live texture cap keeps every chrome text color >= 4.5:1 (accent 3:1) and stays visible', () => {
    for (const [name, t, isDark] of tokenSets()) {
      const fgs = [
        { color: parseHex(t['--pmd-c-text']!)!, min: 4.5 },
        { color: parseHex(t['--pmd-c-text-secondary']!)!, min: 4.5 },
        { color: parseHex(t['--pmd-c-text-muted']!)!, min: 4.5 },
        { color: parseHex(t['--pmd-accent']!)!, min: 3 },
      ];
      // Ribbon / status bar sit on surface; the nav pane on bg.
      for (const bgKey of ['--pmd-c-surface', '--pmd-c-bg']) {
        const bg = parseHex(t[bgKey]!)!;
        for (const [tile, coverage] of Object.entries(TILE_COVERAGE)) {
          const pixel = isDark ? WHITE : BLACK;
          const cap = maxTextureOpacity(bg, fgs, [{ color: pixel, coverage }], MAX_TEXTURE_OPACITY);
          const shown = mixRgb(bg, pixel, cap * coverage);
          for (const { color, min } of fgs) {
            expect(contrastRgb(color, shown), `${name} ${bgKey} ${tile}`).toBeGreaterThanOrEqual(min);
          }
          // Faint, not invisible: the darkest pixel still moves the
          // surface by a few levels.
          expect(cap * coverage, `${name} ${bgKey} ${tile}`).toBeGreaterThanOrEqual(0.04);
        }
      }
    }
  });
});
