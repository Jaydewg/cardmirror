// @vitest-environment jsdom

/**
 * Microsoft Store installs: the Store delivers updates, so Settings →
 * General → About this install shows a note instead of the auto-check
 * toggle and the Check-for-updates button (which would drive
 * electron-updater against a read-only package). A regular desktop
 * install keeps both controls.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

// Same host stub as the other settings-modal tests: named members win,
// everything else is a benign async no-op.
const hostState = vi.hoisted(() => {
  const state = { host: {} as Record<string, unknown> };
  const proxiedHost = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state.host) return state.host[prop];
        if (prop === 'kind') return 'electron';
        return () => Promise.resolve(undefined);
      },
    },
  );
  return Object.assign(state, { proxiedHost });
});

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../src/editor/benchmark-ui.js', () => ({ launchBenchmarkOverlay: vi.fn() }));
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => hostState.proxiedHost,
  getHost: () => hostState.proxiedHost,
  isWindowsHost: () => false,
}));

import { openSettings, closeSettings } from '../../src/editor/settings-ui.js';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

// closeSettings() only — wiping document.body would detach the
// singleton modal's DOM, and the next openSettings() reuses it.
afterEach(() => {
  closeSettings();
  hostState.host = {};
});

function installSection(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.pmd-install-info-section');
  expect(el, 'About this install rendered').not.toBeNull();
  return el!;
}

function hasUpdateButton(section: HTMLElement): boolean {
  return Array.from(section.querySelectorAll('button')).some((b) =>
    /check for updates/i.test(b.textContent ?? ''),
  );
}

describe('About this install: update controls by install channel', () => {
  it('Store install: no update toggle or button, a Store note instead', () => {
    hostState.host = { isStoreBuild: () => true };
    openSettings({ category: 'general' });
    const section = installSection();
    expect(hasUpdateButton(section)).toBe(false);
    expect(section.querySelector('.pmd-install-info-launch-toggle')).toBeNull();
    expect(section.textContent).toMatch(/delivered by the Microsoft Store/);
  });

  it('regular desktop install: keeps the toggle and the button, no Store note', () => {
    hostState.host = { isStoreBuild: () => false };
    openSettings({ category: 'general' });
    const section = installSection();
    expect(hasUpdateButton(section)).toBe(true);
    expect(section.querySelector('.pmd-install-info-launch-toggle')).not.toBeNull();
    expect(section.textContent).not.toMatch(/Microsoft Store/);
  });
});
