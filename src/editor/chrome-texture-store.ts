/**
 * Custom chrome-texture image: import (downscale + re-encode), persist,
 * and apply.
 *
 * The image is stored as a data URL in IndexedDB via WebSharedStore —
 * NEVER in the settings blob (localStorage), which every window parses on
 * every change and which shares a small quota with the rest of the app.
 * Settings carry only `chromeTextureCustomRev`, a stamp bumped on every
 * replace/remove; settings already sync across windows, so a rev change
 * is what tells another window to re-read the store.
 *
 * Applied as an inline `--pmd-chrome-texture: url(...)` on <html>, which
 * beats every themes.css rule; removed whenever the texture isn't custom.
 */

import { settings, type ChromeTextureTones } from './settings.js';
import { WebSharedStore } from './web-shared-store.js';
import { toHex } from './color-math.js';
import { BRAND } from '../brand-build.js';

/** Longest side, in px, of a stored image. Small images are never upscaled. */
export const CUSTOM_TEXTURE_MAX_SIDE = 1600;
/** Smallest long side the size-fitting loop will step down to. */
const MIN_SIDE = 256;
/** Hard cap on the encoded image (bytes of the binary, before base64). */
export const CUSTOM_TEXTURE_MAX_BYTES = 250 * 1024;
const QUALITY = 0.72;

const store = new WebSharedStore<string>(
  'chrome-texture',
  'cardmirror-chrome-texture',
  'background texture',
);

export type ImportResult =
  | { ok: true; bytes: number; width: number; height: number }
  | { ok: false; reason: string };

/** Scale (w, h) so the long side is at most `maxSide`, keeping aspect. */
export function fitWithin(w: number, h: number, maxSide: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxSide) return { width: w, height: h };
  const k = maxSide / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

function encode(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => {
    canvas.toBlob((webp) => {
      // Browsers without a WebP encoder hand back PNG regardless; that's
      // still fine — the size loop below handles it.
      resolve(webp);
    }, 'image/webp', QUALITY);
  });
}

/** Long side of the sample the tones are measured on. Coarse on purpose:
 *  a stray dark pixel averages away, a dark region doesn't. */
const TONE_SAMPLE_SIDE = 64;
/** Fraction of the sample ignored at each end. */
const TONE_PERCENTILE = 0.01;

/** Darkest and lightest tones of `bitmap` (1st / 99th percentile of a
 *  coarse sample, by luminance-weighted gray). Null if the canvas can't
 *  be read. */
export function measureTones(bitmap: ImageBitmap): ChromeTextureTones | null {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, TONE_SAMPLE_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
  return tonesFromPixels(data);
}

/** Percentile tones from RGBA pixel data (mostly-transparent pixels
 *  skipped — they show the bar, not the image). */
export function tonesFromPixels(data: ArrayLike<number>): ChromeTextureTones | null {
  const px: { gray: number; i: number }[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3]! < 26) continue;
    px.push({ gray: 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!, i });
  }
  if (!px.length) return null;
  px.sort((a, b) => a.gray - b.gray);
  const at = (q: number): string => {
    const { i } = px[Math.min(px.length - 1, Math.floor(q * (px.length - 1)))]!;
    return toHex([data[i]!, data[i + 1]!, data[i + 2]!]);
  };
  return { darkest: at(TONE_PERCENTILE), lightest: at(1 - TONE_PERCENTILE) };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (): void => resolve(String(r.result));
    r.onerror = (): void => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** Downscale + re-encode `file`, store it, and switch the texture to it. */
export async function importChromeTexture(file: Blob): Promise<ImportResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'That file isn\'t an image.' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: 'Couldn\'t read that image.' };
  }
  try {
    let side = Math.min(CUSTOM_TEXTURE_MAX_SIDE, Math.max(bitmap.width, bitmap.height));
    for (;;) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, side);
      const blob = await encode(bitmap, width, height);
      if (!blob) return { ok: false, reason: 'Couldn\'t process that image.' };
      if (blob.size <= CUSTOM_TEXTURE_MAX_BYTES) {
        const dataUrl = await blobToDataUrl(blob);
        await store.save(dataUrl);
        // Read back: if storage is unavailable (private mode, blocked
        // storage) say so rather than showing a texture that vanishes on
        // reload.
        const stored = await store.load();
        if (stored !== dataUrl) {
          return { ok: false, reason: `This browser didn't let ${BRAND.productName} save the image.` };
        }
        const rev = Date.now().toString(36);
        cached = { rev, url: dataUrl };
        settings.set('chromeTextureCustomTones', measureTones(bitmap));
        settings.set('chromeTextureCustomRev', rev);
        settings.set('chromeTexture', 'custom');
        return { ok: true, bytes: blob.size, width, height };
      }
      if (side <= MIN_SIDE) {
        return { ok: false, reason: 'That image is too detailed to shrink under 250 KB.' };
      }
      side = Math.max(MIN_SIDE, Math.floor(side * 0.75));
    }
  } finally {
    bitmap.close();
  }
}

/** Forget the custom image and fall back to the palette's texture. */
export async function removeChromeTexture(): Promise<void> {
  await store.save('');
  cached = { rev: '', url: '' };
  settings.set('chromeTextureCustomTones', null);
  settings.set('chromeTextureCustomRev', Date.now().toString(36));
  if (settings.get('chromeTexture') === 'custom') settings.set('chromeTexture', 'auto');
}

/** The stored custom image as a data URL, or '' when none (settings UI). */
export async function getCustomChromeTextureUrl(): Promise<string> {
  return (await store.load()) ?? '';
}

let cached: { rev: string; url: string } | null = null;
let applySeq = 0;

/** Set or clear the inline custom-texture variable to match settings. */
export async function syncCustomChromeTexture(root: HTMLElement = document.documentElement): Promise<void> {
  const seq = ++applySeq;
  if (settings.get('chromeTexture') !== 'custom') {
    root.style.removeProperty('--pmd-chrome-texture');
    return;
  }
  const rev = settings.get('chromeTextureCustomRev');
  if (!cached || cached.rev !== rev) {
    const url = (await store.load()) ?? '';
    if (seq !== applySeq) return; // a newer sync superseded this one
    cached = { rev, url };
  }
  if (cached.url) {
    root.style.setProperty('--pmd-chrome-texture', `url("${cached.url}")`);
  } else {
    root.style.removeProperty('--pmd-chrome-texture');
  }
}

/** Boot hook for a main window: apply now and on every relevant change. */
export function initChromeTexture(): void {
  let lastKey = '';
  const run = (): void => {
    const key = `${settings.get('chromeTexture')}|${settings.get('chromeTextureCustomRev')}`;
    if (key === lastKey) return;
    lastKey = key;
    void syncCustomChromeTexture();
  };
  run();
  settings.subscribe(run);
}
