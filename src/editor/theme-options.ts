/**
 * Display metadata for the appearance pickers (settings dialog + mobile
 * settings): labels and the preview colors drawn on each swatch.
 *
 * The preview hexes mirror themes.css — the picker can't read them from
 * the cascade because only ONE palette is live on :root at a time.
 * tests/editor/themes-css.test.ts asserts they match the CSS, so editing
 * a palette in one place and not the other fails CI.
 */

import type { ChromeTexture, ThemeAccent, ThemePalette } from './settings.js';

export interface PaletteSwatch {
  /** Chrome background (`--pmd-c-bg`). */
  bg: string;
  /** Ribbon / status bar (`--pmd-c-surface`). */
  surface: string;
  /** Primary text (`--pmd-c-text`). */
  text: string;
  /** Paired accent (`--pmd-accent`). */
  accent: string;
}

export interface PaletteOption {
  value: ThemePalette;
  label: string;
  light: PaletteSwatch;
  dark: PaletteSwatch;
}

export const PALETTE_OPTIONS: readonly PaletteOption[] = [
  {
    value: 'default',
    label: 'Default',
    light: { bg: '#ffffff', surface: '#f3f3f3', text: '#222222', accent: '#2563eb' },
    dark: { bg: '#1a1a1a', surface: '#262626', text: '#e6e6e6', accent: '#5a8fff' },
  },
  {
    value: 'sepia',
    label: 'Sepia',
    light: { bg: '#fbf6ec', surface: '#efe5d2', text: '#3b2f22', accent: '#a0522d' },
    dark: { bg: '#1c1814', surface: '#2a241e', text: '#ece3d6', accent: '#c27a45' },
  },
  {
    value: 'slate',
    label: 'Slate',
    light: { bg: '#f7f9fc', surface: '#e9eef4', text: '#1e2733', accent: '#33658f' },
    dark: { bg: '#141a22', surface: '#1f2733', text: '#e3e9f1', accent: '#5a8cc6' },
  },
  {
    value: 'forest',
    label: 'Forest',
    light: { bg: '#f6f9f5', surface: '#e5ede2', text: '#1f2a1e', accent: '#2f6b3a' },
    dark: { bg: '#141a15', surface: '#1f2920', text: '#e2ebe0', accent: '#4e9a5c' },
  },
  {
    value: 'rose',
    label: 'Rosé',
    light: { bg: '#fdf7f8', surface: '#f3e4e7', text: '#33232a', accent: '#a3385a' },
    dark: { bg: '#1d1519', surface: '#2b2127', text: '#f0e3e8', accent: '#c75a7c' },
  },
];

export interface AccentOption {
  value: ThemeAccent;
  label: string;
  /** Light / dark swatch color; null for 'auto' (drawn as the palette's). */
  light: string | null;
  dark: string | null;
}

export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { value: 'auto', label: 'Palette', light: null, dark: null },
  { value: 'blue', label: 'Blue', light: '#2563eb', dark: '#5a8fff' },
  { value: 'teal', label: 'Teal', light: '#0f766e', dark: '#2a9d8f' },
  { value: 'violet', label: 'Violet', light: '#6d4fd8', dark: '#8b74e8' },
  { value: 'rose', label: 'Rose', light: '#be2f5c', dark: '#d4577c' },
  { value: 'amber', label: 'Amber', light: '#a85a06', dark: '#c27a0e' },
  { value: 'green', label: 'Green', light: '#18803d', dark: '#2f9e55' },
];

export interface TextureOption {
  value: ChromeTexture;
  label: string;
}

export const TEXTURE_OPTIONS: readonly TextureOption[] = [
  { value: 'auto', label: 'Palette' },
  { value: 'none', label: 'None' },
  { value: 'grain', label: 'Grain' },
  { value: 'dots', label: 'Dots' },
  { value: 'grid', label: 'Grid' },
  { value: 'linen', label: 'Linen' },
  { value: 'custom', label: 'Custom image' },
];

/** The texture each palette pairs with when `chromeTexture` is 'auto'
 *  (mirrors `--pmd-palette-texture` in themes.css). */
export const PALETTE_TEXTURE: Readonly<Record<ThemePalette, ChromeTexture>> = {
  default: 'none',
  sepia: 'grain',
  slate: 'grid',
  forest: 'linen',
  rose: 'dots',
};
