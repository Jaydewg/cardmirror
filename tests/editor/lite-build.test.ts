// @vitest-environment jsdom
/**
 * CardMirror Lite gates (see src/editor/lite.ts). Pinned: the collab
 * gate closes on every host, AI commands drop from availability, the
 * pairing/plugins tabs vanish (Comments & AI reads as Comments), the
 * AI/pairing settings rows hide across every surface, and sanitize
 * force-disables the network-touching masters.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

async function withLite<T>(fn: () => Promise<T>): Promise<T> {
  vi.resetModules();
  const lite = await import('../../src/editor/lite.js');
  lite.__setLiteForTests(true);
  try {
    return await fn();
  } finally {
    lite.__setLiteForTests(null);
  }
}

afterEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('CardMirror Lite', () => {
  it('closes the collab gate on every host', async () => {
    await withLite(async () => {
      const { collabEnabled } = await import('../../src/editor/collab/collab-gate.js');
      (window as { electronAPI?: unknown }).electronAPI = {}; // even desktop
      expect(collabEnabled()).toBe(false);
      window.localStorage.setItem('pmd-collab-web', '1'); // even flagged web
      expect(collabEnabled()).toBe(false);
    });
  });

  it('drops AI commands from availability', async () => {
    await withLite(async () => {
      (window as { electronAPI?: unknown }).electronAPI = {};
      const { isRibbonCommandAvailable } = await import('../../src/editor/ribbon-availability.js');
      for (const id of [
        'aiAskAboutSelection',
        'aiCreateCite',
        'reformatAllCites',
        'translate',
        'repairText',
        'repairFormatting',
      ] as const) {
        expect(isRibbonCommandAvailable(id)).toBe(false);
      }
      // Local repair stays — it never touches a network.
      expect(isRibbonCommandAvailable('repairParagraphIntegrity')).toBe(true);
    });
  });

  it('hides the pairing/plugins tabs and renames Comments & AI', async () => {
    await withLite(async () => {
      (window as { electronAPI?: unknown }).electronAPI = {};
      const { visibleCategoryTabs } = await import('../../src/editor/settings-categories.js');
      const tabs = visibleCategoryTabs();
      expect(tabs.some((t) => t.id === 'pairing')).toBe(false);
      expect(tabs.some((t) => t.id === 'plugins')).toBe(false);
      const comments = tabs.find((t) => t.id === 'comments-ai');
      expect(comments?.label).toBe('Comments');
    });
  });

  it('stamps the edition on the About-this-install Version row', async () => {
    await withLite(async () => {
      const { getInstallInfo, appVersion } = await import('../../src/editor/install-info.js');
      const version = getInstallInfo().find((e) => e.label === 'Version');
      expect(version?.value).toBe(`${appVersion} (CardMirror Lite)`);
    });
    // Standard builds keep the bare version — no edition suffix.
    vi.resetModules();
    const { getInstallInfo, appVersion } = await import('../../src/editor/install-info.js');
    expect(getInstallInfo().find((e) => e.label === 'Version')?.value).toBe(appVersion);
  });

  it('hides AI + pairing rows and force-sanitizes the masters off', async () => {
    await withLite(async () => {
      const s = await import('../../src/editor/settings.js');
      const hiddenKeys = s.SETTING_METADATA.filter((m) => s.hiddenInLite(m)).map((m) => m.key);
      for (const k of ['aiFeaturesEnabled', 'anthropicApiKey', 'openrouterApiKey', 'clodEnabled', 'pairingEnabled', 'pluginsEnabled', 'voiceModelEngine', 'voiceCleanupEnabled']) {
        expect(hiddenKeys).toContain(k);
      }
      expect(hiddenKeys).not.toContain('theme');
      // Masters can't be smuggled in through settings import/persistence.
      s.settings.set('aiFeaturesEnabled', true as never);
      expect(s.settings.get('aiFeaturesEnabled')).toBe(false);
      s.settings.set('pairingEnabled', true as never);
      expect(s.settings.get('pairingEnabled')).toBe(false);
    });
  });
});
