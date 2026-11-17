// @vitest-environment jsdom

/**
 * The texture Intensity slider's right-click menu: the one way to let a
 * texture go past the readability cap (`chromeTextureUncapped`). Pins:
 * - a right-click (or the keyboard menu key) opens it, a Ctrl+click
 *   doesn't (context-menu-gate);
 * - the item toggles the setting both ways;
 * - Escape closes only the menu — the Settings dialog, which owns Escape
 *   through a document-capture handler, stays open;
 * - while uncapped, the row says so and offers a way back.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
// benchmark-ui transitively imports editor/index.ts, whose module body
// wires the real app's DOM at import time — fatal in a bare jsdom.
vi.mock('../../src/editor/benchmark-ui.js', () => ({ launchBenchmarkOverlay: vi.fn() }));
const host = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'kind') return 'electron';
          return () => Promise.resolve({});
        },
      },
    ),
);
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => host,
  getHost: () => host,
  isWindowsHost: () => false,
}));

import { openSettings, closeSettings } from '../../src/editor/settings-ui.js';
import { settings } from '../../src/editor/settings.js';

// jsdom lacks ResizeObserver (the modal's tab-strip arrows use one).
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

beforeEach(() => {
  settings.set('chromeTexture', 'dots');
  settings.set('chromeTextureUncapped', false);
});
afterEach(() => {
  closeSettings();
  settings.set('chromeTexture', 'auto');
  settings.set('chromeTextureUncapped', false);
});

function open(): HTMLElement {
  openSettings({ category: 'appearance' });
  const row = document.querySelector<HTMLElement>('.pmd-texture-intensity');
  expect(row).not.toBeNull();
  return row!;
}
function contextMenu(target: Element, init: MouseEventInit = { button: 2 }): void {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init }));
}
const menu = (): HTMLElement | null => document.querySelector('.pmd-texture-uncap-menu');
const dialogOpen = (): boolean =>
  (document.querySelector('.pmd-settings-overlay') as HTMLElement | null)?.style.display !== 'none';

describe('Intensity slider right-click menu', () => {
  it('right-click (and the keyboard menu key) open it; Ctrl+click does not', () => {
    const row = open();
    const slider = row.querySelector('input[type=range]')!;
    contextMenu(slider, { button: 2, ctrlKey: true });
    expect(menu()).toBeNull();
    contextMenu(slider, { button: 0 }); // Menu key / Shift+F10
    expect(menu()).not.toBeNull();
    contextMenu(slider);
    expect(document.querySelectorAll('.pmd-texture-uncap-menu')).toHaveLength(1);
    const item = menu()!.querySelector('[role=menuitemcheckbox]')!;
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(item);
  });

  it('toggles the setting, and the row announces it with a way back', () => {
    const row = open();
    const note = document.querySelector<HTMLElement>('.pmd-texture-uncap-note')!;
    expect(note.hidden).toBe(true);

    contextMenu(row);
    menu()!.querySelector<HTMLButtonElement>('[role=menuitemcheckbox]')!.click();
    expect(settings.get('chromeTextureUncapped')).toBe(true);
    expect(menu()).toBeNull();
    expect(note.hidden).toBe(false);
    expect(row.querySelector('.pmd-texture-intensity-value')!.textContent).toContain('past readable');

    contextMenu(row);
    expect(menu()!.querySelector('[role=menuitemcheckbox]')!.getAttribute('aria-checked')).toBe('true');
    menu()!.querySelector<HTMLButtonElement>('[role=menuitemcheckbox]')!.click();
    expect(settings.get('chromeTextureUncapped')).toBe(false);

    settings.set('chromeTextureUncapped', true);
    note.querySelector<HTMLButtonElement>('.pmd-texture-uncap-off')!.click();
    expect(settings.get('chromeTextureUncapped')).toBe(false);
    expect(note.hidden).toBe(true);
  });

  it('Escape closes just the menu, not the Settings dialog', async () => {
    const row = open();
    contextMenu(row);
    await new Promise((r) => setTimeout(r, 0)); // listeners attach after the opening event
    const item = menu()!.querySelector('[role=menuitemcheckbox]')!;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(menu()).toBeNull();
    expect(dialogOpen()).toBe(true);
    expect(document.activeElement).toBe(row.querySelector('input[type=range]'));
    // With no menu open, Escape is the dialog's again.
    row.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(dialogOpen()).toBe(false);
  });
});
