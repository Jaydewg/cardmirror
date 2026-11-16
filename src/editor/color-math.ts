/**
 * Small sRGB helpers for the appearance code: parsing computed colors,
 * WCAG contrast, and mixing. Mixing is done on gamma-encoded channels,
 * which is how browsers composite `opacity` — so `mix(bg, pixel, a)` is
 * what a texture pixel at opacity `a` actually looks like on screen.
 */

/** 0–255 per channel. */
export type RGB = readonly [number, number, number];

export const BLACK: RGB = [0, 0, 0];
export const WHITE: RGB = [255, 255, 255];

export function parseHex(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  else if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

/** A computed color string (`rgb()`, `rgba()`, `color(srgb …)`, or hex)
 *  → channels + alpha. Returns null for anything else (e.g. an
 *  unresolved `var()` in an environment without a style engine). */
export function parseCssColor(css: string): { rgb: RGB; alpha: number } | null {
  const s = css.trim().toLowerCase();
  if (s.startsWith('#')) {
    const rgb = parseHex(s);
    if (!rgb) return null;
    const h = s.slice(1);
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : h.length === 4 ? parseInt(h[3]! + h[3]!, 16) / 255 : 1;
    return { rgb, alpha };
  }
  let m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
    if (ch.some((v) => !Number.isFinite(v))) return null;
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return { rgb: [ch[0]!, ch[1]!, ch[2]!], alpha: Number.isFinite(a) ? a : 1 };
  }
  m = /^color\(srgb\s+([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1]!.split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p)) * 255);
    if (ch.some((v) => !Number.isFinite(v))) return null;
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return { rgb: [ch[0]!, ch[1]!, ch[2]!], alpha: Number.isFinite(a) ? a : 1 };
  }
  return null;
}

/** WCAG relative luminance. */
export function luminance(c: RGB): number {
  const f = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `a` moved toward `b` by `t` (0 = a, 1 = b), per gamma-encoded channel. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Smallest t in [0, 1] (to ~1/256) for which `ok(t)` holds, assuming
 *  `ok` is monotone false→true. Returns 1 when even t = 1 fails. */
export function smallestPassing(ok: (t: number) => boolean): number {
  if (ok(0)) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Largest t in [0, max] (to ~max/4096) for which `ok(t)` holds,
 *  assuming `ok` is monotone true→false. 0 when even t = 0 fails. */
export function largestPassing(ok: (t: number) => boolean, max: number): number {
  if (ok(max)) return max;
  if (!ok(0)) return 0;
  let lo = 0;
  let hi = max;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
