// @vitest-environment jsdom
/**
 * Custom chrome texture: downscale + size cap on import, storage outside
 * the settings blob, and the inline variable that applies it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory stand-in for the IndexedDB store (jsdom has no IndexedDB).
const mem = vi.hoisted(() => ({ value: null as string | null, failWrites: false }));
vi.mock('../../src/editor/web-shared-store.js', () => ({
  WebSharedStore: class {
    async load(): Promise<string | null> {
      return mem.value;
    }
    async save(v: string): Promise<void> {
      if (!mem.failWrites) mem.value = v;
    }
    onExternalChange(): () => void {
      return () => {};
    }
  },
}));

import {
  CUSTOM_TEXTURE_MAX_BYTES,
  CUSTOM_TEXTURE_MAX_SIDE,
  fitWithin,
  importChromeTexture,
  removeChromeTexture,
  syncCustomChromeTexture,
  tonesFromPixels,
} from '../../src/editor/chrome-texture-store.js';
import { settings } from '../../src/editor/settings.js';

/** Encoded size the fake encoder reports for a w×h canvas. */
let bytesPerPixel = 0.05;
const encodedSizes: { w: number; h: number }[] = [];

beforeEach(() => {
  mem.value = null;
  mem.failWrites = false;
  bytesPerPixel = 0.05;
  encodedSizes.length = 0;
  vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 2000, close: () => {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: () => {},
        imageSmoothingQuality: 'low',
        // A dark sample: mostly near-black with a few mid-gray pixels.
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i++) data.set(i % 10 === 0 ? [90, 90, 90, 255] : [10, 12, 14, 255], i * 4);
          return { data };
        },
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb) {
    encodedSizes.push({ w: this.width, h: this.height });
    const size = Math.round(this.width * this.height * bytesPerPixel);
    cb(new Blob([new Uint8Array(size)], { type: 'image/webp' }));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  settings.set('chromeTexture', 'auto');
  settings.set('chromeTextureCustomRev', '');
  settings.set('chromeTextureCustomTones', null);
  document.documentElement.style.removeProperty('--pmd-chrome-texture');
});

const photo = (): Blob => new Blob([new Uint8Array(10)], { type: 'image/jpeg' });

describe('fitWithin', () => {
  it('scales the long side down and never up', () => {
    expect(fitWithin(4000, 2000, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitWithin(500, 1000, 1600)).toEqual({ width: 500, height: 1000 });
    expect(fitWithin(300, 3000, 1600)).toEqual({ width: 160, height: 1600 });
  });
});

describe('importChromeTexture', () => {
  it('downscales to the max side, stores a data URL, and switches to custom', async () => {
    const res = await importChromeTexture(photo());
    expect(res).toMatchObject({ ok: true, width: CUSTOM_TEXTURE_MAX_SIDE, height: 800 });
    expect(mem.value).toMatch(/^data:image\/webp;base64,/);
    expect(settings.get('chromeTexture')).toBe('custom');
    expect(settings.get('chromeTextureCustomRev')).not.toBe('');
    // The image never lands in the settings blob — only its two tones.
    expect(JSON.stringify(settings.all())).not.toContain('data:image');
    expect(settings.get('chromeTextureCustomTones')).toEqual({ darkest: '#0a0c0e', lightest: '#5a5a5a' });
  });

  it('steps the size down until it fits under the byte cap', async () => {
    bytesPerPixel = 0.3; // 1600×800 → 384 KB, too big
    const res = await importChromeTexture(photo());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes).toBeLessThanOrEqual(CUSTOM_TEXTURE_MAX_BYTES);
    expect(encodedSizes.length).toBeGreaterThan(1);
    expect(encodedSizes[0]!.w).toBe(CUSTOM_TEXTURE_MAX_SIDE);
  });

  it('gives up (without switching) when even the smallest size is too big', async () => {
    bytesPerPixel = 100;
    const res = await importChromeTexture(photo());
    expect(res.ok).toBe(false);
    expect(settings.get('chromeTexture')).toBe('auto');
  });

  it('reports when storage refuses the write', async () => {
    mem.failWrites = true;
    const res = await importChromeTexture(photo());
    expect(res.ok).toBe(false);
    expect(settings.get('chromeTexture')).toBe('auto');
  });

  it('rejects non-images', async () => {
    const res = await importChromeTexture(new Blob(['x'], { type: 'text/plain' }));
    expect(res.ok).toBe(false);
  });
});

describe('applying the custom image', () => {
  it('sets the inline variable only while the texture is custom', async () => {
    await importChromeTexture(photo());
    await syncCustomChromeTexture();
    expect(document.documentElement.style.getPropertyValue('--pmd-chrome-texture')).toMatch(/^url\("data:image\/webp/);

    settings.set('chromeTexture', 'dots');
    await syncCustomChromeTexture();
    expect(document.documentElement.style.getPropertyValue('--pmd-chrome-texture')).toBe('');
  });

  it('remove clears the store and falls back to the palette texture', async () => {
    await importChromeTexture(photo());
    await removeChromeTexture();
    expect(mem.value).toBe('');
    expect(settings.get('chromeTexture')).toBe('auto');
    expect(settings.get('chromeTextureCustomTones')).toBeNull();
    await syncCustomChromeTexture();
    expect(document.documentElement.style.getPropertyValue('--pmd-chrome-texture')).toBe('');
  });
});

describe('tonesFromPixels', () => {
  const px = (...colors: number[][]): number[] => colors.flatMap((c) => [...c, 255]);

  it('takes the 1st / 99th percentile, so a stray pixel does not count', () => {
    const data = px(...Array.from({ length: 200 }, () => [128, 128, 128]), [0, 0, 0]);
    expect(tonesFromPixels(data)).toEqual({ darkest: '#808080', lightest: '#808080' });
  });

  it('a dark region does count', () => {
    const data = px(...Array.from({ length: 180 }, () => [200, 200, 200]), ...Array.from({ length: 20 }, () => [5, 5, 5]));
    expect(tonesFromPixels(data)!.darkest).toBe('#050505');
  });

  it('skips transparent pixels; null when nothing is visible', () => {
    expect(tonesFromPixels([0, 0, 0, 0, 255, 255, 255, 255])).toEqual({ darkest: '#ffffff', lightest: '#ffffff' });
    expect(tonesFromPixels([0, 0, 0, 0])).toBeNull();
  });
});
