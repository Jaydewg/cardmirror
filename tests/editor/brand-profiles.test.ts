// @vitest-environment jsdom
/**
 * Brand profiles (brand/README.md): the product name and logo come from
 * brand/<id>/, never from hard-coded strings.
 *
 *  - every profile carries the fields the build and the app read, and the
 *    generated icons the build copies;
 *  - the committed generated modules equal the DEFAULT profile (so a
 *    default build leaves the tree clean), which `apply-brand` reports as
 *    "already applied";
 *  - the one-time rename notice fires once, and only on an install an
 *    earlier version had already used.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const PROFILES = ['cardreflex', 'cardmirror'];
const REQUIRED = [
  'id',
  'productName',
  'liteName',
  'executableName',
  'shortcutName',
  'docTypeName',
  'lineage',
  'renamedFrom',
  'description',
  'tileBackground',
  'themeColor',
  'storeDisplayName',
];
const GENERATED = [
  'desktop/icon.png',
  'desktop/icon.ico',
  'desktop/cmir.ico',
  'desktop/cmir.icns',
  'desktop/docx.ico',
  'desktop/docx.icns',
  'desktop/icons/256x256.png',
  'public/favicon.png',
  'public/pwa-512.png',
  'file-mark-48.png',
];

describe('brand profiles', () => {
  for (const id of PROFILES) {
    it(`${id}: brand.json has every field, and the generated icons exist`, () => {
      const brand = JSON.parse(readFileSync(path.join(ROOT, 'brand', id, 'brand.json'), 'utf8'));
      for (const key of REQUIRED) expect(brand, key).toHaveProperty(key);
      expect(brand.id).toBe(id);
      // Internal identifiers never follow the brand: keeping the exe name
      // keeps existing pins and shortcuts working across the rename.
      expect(brand.executableName).toBe('cardmirror');
      for (const rel of GENERATED) {
        expect(existsSync(path.join(ROOT, 'brand', id, 'generated', rel)), rel).toBe(true);
      }
    });
  }

  it('the committed build files equal the default profile (apply-brand is a no-op)', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'apply-brand.mjs')], {
      cwd: ROOT,
      env: { ...process.env, BRAND: '' },
      encoding: 'utf8',
    });
    expect(out).toMatch(/\[apply-brand\] cardreflex: already applied/);
  });

  it('the default profile is CardReflex, credited as a CardMirror fork', async () => {
    const { BRAND } = await import('../../src/brand-build.js');
    expect(BRAND.productName).toBe('CardReflex');
    expect(BRAND.lineage).toBe('A CardMirror fork');
    expect(BRAND.renamedFrom).toBe('CardMirror');
  });
});

describe('migrateBrandRename', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  // HAD_STORED_SETTINGS is captured when settings.ts loads, so each case
  // seeds localStorage first, then imports a fresh copy of the module.
  async function load(): Promise<typeof import('../../src/editor/settings.js')> {
    return import('../../src/editor/settings.js');
  }

  it('an install an earlier version used: notice exactly once', async () => {
    localStorage.setItem('pmd-settings', '{}');
    const { migrateBrandRename } = await load();
    let notices = 0;
    migrateBrandRename('CardMirror', 'CardReflex', () => notices++);
    migrateBrandRename('CardMirror', 'CardReflex', () => notices++);
    expect(notices).toBe(1);
  });

  it('a fresh install never sees it (and never will)', async () => {
    const { migrateBrandRename } = await load();
    let notices = 0;
    migrateBrandRename('CardMirror', 'CardReflex', () => notices++);
    expect(notices).toBe(0);
    expect(localStorage.getItem('cm-brand-rename-noticed:CardMirror->CardReflex')).toBe('1');
  });

  it('no rename in the profile: nothing happens', async () => {
    localStorage.setItem('pmd-settings', '{}');
    const { migrateBrandRename } = await load();
    let notices = 0;
    migrateBrandRename(null, 'CardMirror', () => notices++);
    migrateBrandRename('CardMirror', 'CardMirror', () => notices++);
    expect(notices).toBe(0);
  });
});
