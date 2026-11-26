// @vitest-environment jsdom
/**
 * Web Collaboration tab visibility (web-collab Phase 3): the pairing
 * tab is electronOnly, EXCEPT on a browser host with the collab gate
 * open — where it surfaces carrying only its non-electronOnly rows
 * (account linking + self-host relay), never the card-sharing set.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';

type WinStub = { electronAPI?: unknown };

async function loadTabs(): Promise<() => { id: string }[]> {
  vi.resetModules();
  const mod = await import('../../src/editor/settings-categories.js');
  return mod.visibleCategoryTabs;
}

afterEach(() => {
  delete (window as unknown as WinStub).electronAPI;
  window.localStorage.clear();
});

describe('Collaboration tab on web', () => {
  it('present on a desktop-layout browser host (2026-08-19 soft launch)', async () => {
    delete (window as unknown as WinStub).electronAPI;
    const tabs = (await loadTabs())();
    expect(tabs.some((t) => t.id === 'pairing')).toBe(true);
    // Other electronOnly tabs stay hidden — only pairing opens on web.
    expect(tabs.some((t) => t.id === 'plugins')).toBe(false);
  });

  it('hidden in the mobile shell (gate closed there)', async () => {
    delete (window as unknown as WinStub).electronAPI;
    window.localStorage.setItem('pmd-settings', JSON.stringify({ mobileLayout: 'mobile' }));
    const tabs = (await loadTabs())();
    expect(tabs.some((t) => t.id === 'pairing')).toBe(false);
  });

  it('always present on Electron', async () => {
    (window as unknown as WinStub).electronAPI = {};
    const tabs = (await loadTabs())();
    expect(tabs.some((t) => t.id === 'pairing')).toBe(true);
  });

  it('web-visible pairing rows: everything except the desktop-only cadence knob', async () => {
    vi.resetModules();
    delete (window as unknown as WinStub).electronAPI;
    const { SETTING_METADATA } = await import('../../src/editor/settings.js');
    const webRows = SETTING_METADATA.filter(
      (m) => m.category === 'pairing' && !m.electronOnly && !m.windowsOnly,
    ).map((m) => m.key);
    // Phase 4: the contacts system + master toggle surface on web; only
    // the poll-cadence knob stays desktop (web uses a fixed cadence).
    expect(webRows).toEqual([
      'pairingEnabled',
      'pairingOwnCode',
      'pairingDisplayName',
      'pairingPartners',
      'pairingGroups',
      'pairingBlockedCodes',
      'pairingReceiveFlash',
      'pairingRelayUrl',
      'pairingRelayToken',
    ]);
  });
});
