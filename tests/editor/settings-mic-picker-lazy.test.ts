// @vitest-environment jsdom

/**
 * The voice-control microphone picker must NOT enumerate media devices
 * just because Settings opened. Chromium's enumerateDevices() always
 * enumerates cameras too, and in the Microsoft Store (MSIX) build Windows
 * reports that as the app accessing the camera (field report 2026-11-27).
 * The list loads only when the picker is shown or focused.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

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

const enumerateDevices = vi.fn(async () => [
  { kind: 'audioinput', deviceId: 'mic-1', label: 'USB Mic', groupId: 'g' },
  { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam', groupId: 'g' },
]);
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { enumerateDevices },
});

afterEach(() => {
  closeSettings();
  enumerateDevices.mockClear();
});

function micPicker(): HTMLSelectElement {
  const row = document.querySelector<HTMLElement>('.pmd-settings-row[data-setting-key="voiceInputDeviceId"]');
  expect(row, 'voice microphone row rendered').not.toBeNull();
  return row!.querySelector('select')!;
}

describe('voice microphone picker', () => {
  it('opening Settings does not enumerate devices (no camera access)', () => {
    openSettings({ category: 'accessibility' });
    micPicker();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it('focusing the picker loads microphones only (no cameras listed)', async () => {
    openSettings({ category: 'accessibility' });
    const select = micPicker();
    select.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 0));
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['System default', 'USB Mic']);
  });
});
