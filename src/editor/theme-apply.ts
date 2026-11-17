/**
 * Appearance → <html> attributes. One place resolves the theme, palette,
 * accent, and chrome-texture settings into the attributes style.css and
 * themes.css key off, so the main windows and the timer popout stay in
 * lockstep.
 *
 *   data-theme="dark"      dark chrome (absent = light)
 *   data-theme-doc="dark"  dark theme also covers the document
 *   data-palette=X         named palette (absent = stock)
 *   data-accent=X          explicit accent (absent = palette's)
 *   data-texture=X         explicit texture (absent = palette's)
 *   data-doc-paper         chrome is themed but the document stays paper
 *   data-bar-scheme=X      the textured bars (ribbon, nav, status bar)
 *                          use the OTHER light/dark scheme than the rest,
 *                          to suit a custom image ("Just the bars")
 *   --pmd-accent-custom*   inline: the derived custom accent
 *   --pmd-chrome-texture-opacity   inline: intensity × readability cap
 *
 * Readability cap: chrome text must stay >= 4.5:1 (accent >= 3:1) over
 * the texture's most extreme pixel. Rather than a fixed opacity, the cap
 * is computed from the colors actually in use on each bar (palette,
 * light/dark, Color overrides all included), so "100%" intensity is
 * always the strongest the texture can be while every label still
 * passes. That needs the cascade, so it runs in a microtask after the
 * settings subscriber has applied everything (overrides included).
 *
 * `chromeTextureUncapped` (the Intensity slider's right-click menu) skips
 * the cap: 100% is then the fixed ceiling, readable or not.
 *
 * The custom texture image itself is applied by chrome-texture-store.ts
 * (it is async — IndexedDB), which writes `--pmd-chrome-texture` inline.
 */

import type { ChromeTexture, ChromeTextureTones, Settings } from './settings.js';
import { PALETTE_OPTIONS, PALETTE_TEXTURE } from './theme-options.js';
import {
  BLACK,
  WHITE,
  contrast,
  largestPassing,
  mix,
  parseCssColor,
  parseHex,
  smallestPassing,
  toHex,
  type RGB,
} from './color-math.js';

/** Aesthetic ceilings: never stronger than this even when contrast
 *  would allow it. The readability cap is usually lower. */
export const MAX_TEXTURE_OPACITY = 0.16;
export const MAX_CUSTOM_TEXTURE_OPACITY = 0.35;
/** Used until the readability cap can be measured (and wherever it
 *  can't be, e.g. no style engine): safe for every stock text color over
 *  a pure black or white pixel. */
export const FALLBACK_TEXTURE_OPACITY = 0.045;

/** How opaque each bundled tile's darkest pixel is, at device
 *  resolution (thin strokes are fully covered on a 2× screen). */
export const TILE_COVERAGE: Readonly<Record<'grain' | 'dots' | 'grid' | 'linen', number>> = {
  grain: 0.6,
  dots: 1,
  grid: 1,
  linen: 0.6,
};

/** The surfaces a texture is drawn on, and the scope `data-bar-scheme`
 *  re-themes (kept in sync with the selectors in style.css / themes.css). */
export const TEXTURED_BARS = '#ribbon, #status-bar, .pmd-nav-panel, .pmd-multi-nav';

/** Chrome text colors held to 4.5:1 over the texture, and the accent
 *  (icons, toggles, focus) held to 3:1. */
const GUARDED_TOKENS: readonly [token: string, min: number][] = [
  ['--pmd-c-text', 4.5],
  ['--pmd-c-text-secondary', 4.5],
  ['--pmd-c-text-muted', 4.5],
  ['--pmd-c-accent', 3],
];

export type AppearanceSettings = Pick<
  Settings,
  | 'theme'
  | 'themeAppliesToDocument'
  | 'themePalette'
  | 'themeAccent'
  | 'themeAccentCustom'
  | 'chromeTexture'
  | 'chromeTextureIntensity'
  | 'chromeTextureFit'
  | 'chromeTextureCustomTones'
  | 'chromeTextureMatch'
  | 'chromeTextureUncapped'
>;

export type Scheme = 'light' | 'dark';

export function prefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** The user's own light/dark choice, before any image matching. */
export function isUserDark(theme: Settings['theme']): boolean {
  return theme === 'dark' || (theme === 'system' && prefersDark());
}

/* ── Custom image → light/dark ─────────────────────────────────────── */

/** Gray level (0–255) of a hex color, luminance-weighted on the encoded
 *  channels — the space opacity composites in. */
function grayOf(hex: string): number {
  const c = parseHex(hex) ?? BLACK;
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** Typical light / dark chrome surface gray levels. */
const LIGHT_SURFACE_GRAY = 243;
const DARK_SURFACE_GRAY = 38;

/** Below this difference (gray levels) neither scheme clearly suits
 *  the image — e.g. a photo with deep blacks AND bright whites. */
const SCHEME_DEAD_BAND = 30;

/** The scheme an image reads best under: whichever chrome surface its
 *  far tone strays from least (a dark image strays little from a dark
 *  surface), since that's what limits how strongly it can show. Null
 *  when it's a toss-up — switching wouldn't help, so nothing switches. */
export function imageScheme(t: ChromeTextureTones): Scheme | null {
  const strayOnLight = LIGHT_SURFACE_GRAY - grayOf(t.darkest);
  const strayOnDark = grayOf(t.lightest) - DARK_SURFACE_GRAY;
  if (Math.abs(strayOnLight - strayOnDark) < SCHEME_DEAD_BAND) return null;
  return strayOnDark < strayOnLight ? 'dark' : 'light';
}

export interface SchemeResolution {
  /** The page-wide light/dark (`data-theme`). */
  dark: boolean;
  /** Set when just the textured bars use the other scheme. */
  barScheme: Scheme | null;
  /** The image's own scheme when matching is active, else null. */
  imageScheme: Scheme | null;
}

/** Resolve light/dark for the page and the bars from the user's theme
 *  and (for a custom image with matching on) the image's tones. */
export function resolveScheme(s: AppearanceSettings, userDark: boolean): SchemeResolution {
  const tones = s.chromeTexture === 'custom' && s.chromeTextureMatch !== 'off' ? s.chromeTextureCustomTones : null;
  if (!tones) return { dark: userDark, barScheme: null, imageScheme: null };
  const img = imageScheme(tones);
  if (!img) return { dark: userDark, barScheme: null, imageScheme: null };
  if (s.chromeTextureMatch === 'interface') return { dark: img === 'dark', barScheme: null, imageScheme: img };
  const base: Scheme = userDark ? 'dark' : 'light';
  return { dark: userDark, barScheme: img === base ? null : img, imageScheme: img };
}

/* ── Custom accent ─────────────────────────────────────────────────── */

const LIGHT_BGS: readonly RGB[] = PALETTE_OPTIONS.map((p) => parseHex(p.light.bg)!);
const DARK_BGS: readonly RGB[] = PALETTE_OPTIONS.map((p) => parseHex(p.dark.bg)!);

export interface CustomAccent {
  light: string;
  lightHover: string;
  dark: string;
  darkHover: string;
  /** The light variant differs from the picked color (it was nudged
   *  darker to pass). */
  adjusted: boolean;
}

/** Light and dark accents from one picked color, held to the same bar as
 *  the preset accents (tests/editor/themes-css.test.ts): white text on it
 *  >= 4.5:1 in light (3:1 in dark), and >= 3:1 against every palette
 *  background. Moves only as far as needed, keeping the hue. */
export function deriveCustomAccent(hex: string): CustomAccent {
  const pick = parseHex(hex) ?? parseHex('#2563eb')!;
  // Judge the color as it will be written (rounded to #rrggbb), so
  // rounding can't drop it a hair under the bar.
  const toward = (from: RGB, to: RGB, t: number): RGB => parseHex(toHex(mix(from, to, t)))!;

  const lightFill = (c: RGB): boolean => contrast(WHITE, c) >= 4.5;
  const lightMark = (c: RGB): boolean => LIGHT_BGS.every((b) => contrast(c, b) >= 3);
  const light = toward(pick, BLACK, smallestPassing((t) => {
    const c = toward(pick, BLACK, t);
    return lightFill(c) && lightMark(c);
  }));

  // Dark mode: a lighter shade of the pick, as the presets do, then into
  // the band where white text reads (>= 3:1) and it shows on dark
  // backgrounds (>= 3:1). Each bound is monotone along its own direction.
  const darkFill = (c: RGB): boolean => contrast(WHITE, c) >= 3;
  const darkMark = (c: RGB): boolean => DARK_BGS.every((b) => contrast(c, b) >= 3);
  let dark = toward(pick, WHITE, 0.2);
  if (!darkFill(dark)) {
    const start = dark;
    dark = toward(start, BLACK, smallestPassing((t) => darkFill(toward(start, BLACK, t))));
  } else if (!darkMark(dark)) {
    const start = dark;
    dark = toward(start, WHITE, smallestPassing((t) => darkMark(toward(start, WHITE, t))));
  }

  const lightHex = toHex(light);
  return {
    light: lightHex,
    lightHover: toHex(mix(light, BLACK, 0.15)),
    dark: toHex(dark),
    darkHover: toHex(mix(dark, WHITE, 0.15)),
    adjusted: lightHex !== toHex(pick),
  };
}

/* ── Readability cap ───────────────────────────────────────────────── */

export interface GuardedColor {
  color: RGB;
  min: number;
}

/** Strongest opacity (<= `cap`) at which every `fg` keeps its minimum
 *  contrast over `bg` with any `worst` pixel composited on top.
 *  `worst` carries each pixel's own coverage (alpha). A color that
 *  already fails on the plain background is skipped — no texture
 *  setting can fix it, and it shouldn't hide the texture. */
export function maxTextureOpacity(
  bg: RGB,
  fgs: readonly GuardedColor[],
  worst: readonly { color: RGB; coverage: number }[],
  cap: number,
): number {
  let best = cap;
  for (const { color, min } of fgs) {
    if (contrast(color, bg) < min) continue;
    for (const w of worst) {
      const a = largestPassing((x) => contrast(color, mix(bg, w.color, x * w.coverage)) >= min, best);
      best = Math.min(best, a);
    }
  }
  return best;
}

/** The texture actually drawn: resolves 'auto' to the palette's. */
export function effectiveTexture(s: Pick<AppearanceSettings, 'chromeTexture' | 'themePalette'>): ChromeTexture {
  return s.chromeTexture === 'auto' ? PALETTE_TEXTURE[s.themePalette] : s.chromeTexture;
}

function opaqueBackground(el: Element): RGB | null {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const c = parseCssColor(getComputedStyle(cur).backgroundColor);
    if (c && c.alpha >= 0.99) return c.rgb;
  }
  return null;
}

/** The fixed ceiling for the texture in use (null when none is drawn).
 *  With `chromeTextureUncapped` this is what 100% means. */
export function textureCeiling(s: Pick<AppearanceSettings, 'chromeTexture' | 'themePalette'>): number | null {
  const tex = effectiveTexture(s);
  if (tex === 'none') return null;
  return tex === 'custom' ? MAX_CUSTOM_TEXTURE_OPACITY : MAX_TEXTURE_OPACITY;
}

/** Readability cap for the current page, or null when it can't be
 *  measured (no bars in this window, or no style engine). */
export function measureTextureCap(s: AppearanceSettings, root: HTMLElement): number | null {
  const tex = effectiveTexture(s);
  if (tex === 'none') return null;
  const bars = [...root.ownerDocument.querySelectorAll<HTMLElement>(TEXTURED_BARS)];
  if (!bars.length) return null;
  const pageDark = root.getAttribute('data-theme') === 'dark';
  const cap = tex === 'custom' ? MAX_CUSTOM_TEXTURE_OPACITY : MAX_TEXTURE_OPACITY;
  let worst: { color: RGB; coverage: number }[];
  if (tex === 'custom') {
    const t = s.chromeTextureCustomTones;
    worst = t
      ? [{ color: parseHex(t.darkest)!, coverage: 1 }, { color: parseHex(t.lightest)!, coverage: 1 }]
      : [{ color: BLACK, coverage: 1 }, { color: WHITE, coverage: 1 }];
  } else {
    // Bundled tiles are black, inverted to white in dark mode (themes.css).
    worst = [{ color: pageDark ? WHITE : BLACK, coverage: TILE_COVERAGE[tex as keyof typeof TILE_COVERAGE] ?? 1 }];
  }
  let best: number | null = null;
  for (const bar of bars) {
    const bg = opaqueBackground(bar);
    if (!bg) continue;
    const cs = getComputedStyle(bar);
    const fgs: GuardedColor[] = [];
    for (const [token, min] of GUARDED_TOKENS) {
      const c = parseCssColor(cs.getPropertyValue(token));
      if (c) fgs.push({ color: c.rgb, min });
    }
    if (!fgs.length) continue;
    const a = maxTextureOpacity(bg, fgs, worst, cap);
    best = best === null ? a : Math.min(best, a);
  }
  return best;
}

/* ── Color overrides inside re-schemed bars ────────────────────────── */

const SCOPED_OVERRIDES_ID = 'pmd-bar-scheme-overrides';

/** Color overrides are inline on <html>; bars re-schemed by
 *  `data-bar-scheme` re-declare every token on themselves, which would
 *  beat those inherited overrides. Mirror them onto the bars so an
 *  override still wins everywhere. */
function syncScopedOverrides(root: HTMLElement): void {
  const doc = root.ownerDocument;
  let el = doc.getElementById(SCOPED_OVERRIDES_ID);
  const decls: string[] = [];
  if (root.hasAttribute('data-bar-scheme')) {
    for (let i = 0; i < root.style.length; i++) {
      const prop = root.style.item(i);
      if (prop.startsWith('--pmd-c-')) decls.push(`${prop}: ${root.style.getPropertyValue(prop)} !important;`);
    }
  }
  const css = decls.length ? `:root[data-bar-scheme] :is(${TEXTURED_BARS}) { ${decls.join(' ')} }` : '';
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement('style');
    el.id = SCOPED_OVERRIDES_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/* ── Readable limit, for the slider's tick ──────────────────────────── */

/** Last measured readability cap in this window (null: not measurable,
 *  or no texture). Kept even while uncapped, so the slider can show
 *  where the readable range ends. */
let readableCap: number | null = null;
const readableCapListeners = new Set<() => void>();

/** Where the readable limit sits on the uncapped scale, as a fraction of
 *  the ceiling (0–1), or null when unknown. Also the factor between the
 *  two scales: capped % × fraction = uncapped %. */
export function readableFraction(s: Pick<AppearanceSettings, 'chromeTexture' | 'themePalette'>): number | null {
  const ceiling = textureCeiling(s);
  if (readableCap === null || !ceiling) return null;
  return Math.min(1, readableCap / ceiling);
}

/** Called whenever the measured readable limit changes (palette, light/
 *  dark, overrides, image…). Returns an unsubscribe. */
export function onReadableCapChange(cb: () => void): () => void {
  readableCapListeners.add(cb);
  return () => readableCapListeners.delete(cb);
}

/** Intensity that keeps the texture's strength unchanged when switching
 *  between the readable scale and the uncapped one. Unchanged when the
 *  limit isn't known. */
export function rescaleIntensity(intensity: number, toUncapped: boolean, fraction: number | null): number {
  if (fraction === null || fraction <= 0) return intensity;
  const next = toUncapped ? intensity * fraction : intensity / fraction;
  return Math.max(0, Math.min(100, Math.round(next)));
}

let guardQueued = false;
let guardArgs: { s: AppearanceSettings; root: HTMLElement } | null = null;

function scheduleGuard(s: AppearanceSettings, root: HTMLElement): void {
  guardArgs = { s, root };
  if (guardQueued) return;
  guardQueued = true;
  queueMicrotask(() => {
    guardQueued = false;
    if (guardArgs) refreshTextureGuard(guardArgs.s, guardArgs.root);
  });
}

/** Re-measure and apply the readability cap now. Runs automatically
 *  after `applyAppearance`; exported for tests and for callers that
 *  change a token outside settings. */
export function refreshTextureGuard(s: AppearanceSettings, root: HTMLElement = document.documentElement): void {
  syncScopedOverrides(root);
  const readable = measureTextureCap(s, root);
  if (readable !== readableCap) {
    readableCap = readable;
    for (const cb of readableCapListeners) cb();
  }
  const cap = s.chromeTextureUncapped ? textureCeiling(s) : readable;
  if (cap === null) return;
  const opacity = (Math.max(0, Math.min(100, s.chromeTextureIntensity)) / 100) * cap;
  root.style.setProperty('--pmd-chrome-texture-opacity', String(Math.round(opacity * 1000) / 1000));
}

/* ── Apply ─────────────────────────────────────────────────────────── */

function setAttr(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.removeAttribute(name);
  else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

/** Write every appearance attribute for `s` onto `root` (default: <html>). */
export function applyAppearance(
  s: AppearanceSettings,
  root: HTMLElement = document.documentElement,
): void {
  const { dark, barScheme } = resolveScheme(s, isUserDark(s.theme));
  const paletted = s.themePalette !== 'default';

  setAttr(root, 'data-theme', dark ? 'dark' : null);
  setAttr(root, 'data-theme-doc', dark && s.themeAppliesToDocument ? 'dark' : null);
  setAttr(root, 'data-palette', paletted ? s.themePalette : null);
  setAttr(root, 'data-accent', s.themeAccent === 'auto' ? null : s.themeAccent);
  setAttr(root, 'data-texture', s.chromeTexture === 'auto' ? null : s.chromeTexture);
  setAttr(root, 'data-doc-paper', (dark || paletted) && !s.themeAppliesToDocument ? '' : null);
  setAttr(root, 'data-bar-scheme', barScheme);

  const accentVars = ['--pmd-accent-custom', '--pmd-accent-custom-hover', '--pmd-accent-custom-dark', '--pmd-accent-custom-dark-hover'];
  if (s.themeAccent === 'custom') {
    const a = deriveCustomAccent(s.themeAccentCustom);
    [a.light, a.lightHover, a.dark, a.darkHover].forEach((v, i) => root.style.setProperty(accentVars[i]!, v));
  } else {
    for (const v of accentVars) root.style.removeProperty(v);
  }

  // Safe placeholder until the readability cap is measured (microtask,
  // before paint); stays as-is where it can't be. Uncapped needs no
  // measuring.
  const base = (s.chromeTextureUncapped ? textureCeiling(s) : null) ?? FALLBACK_TEXTURE_OPACITY;
  const opacity = (Math.max(0, Math.min(100, s.chromeTextureIntensity)) / 100) * base;
  root.style.setProperty('--pmd-chrome-texture-opacity', String(Math.round(opacity * 1000) / 1000));
  if (s.chromeTexture === 'custom') {
    root.style.setProperty('--pmd-chrome-texture-size', s.chromeTextureFit === 'cover' ? 'cover' : 'auto');
  } else {
    root.style.removeProperty('--pmd-chrome-texture-size');
  }
  scheduleGuard(s, root);
}
