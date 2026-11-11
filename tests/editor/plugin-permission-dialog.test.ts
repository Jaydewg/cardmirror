// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  FULL_ACCESS_NOTE,
  managePluginPermissionsDialog,
  permissionConsentDialog,
} from '../../src/editor/plugin-permission-dialog.js';

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('.pmd-plugin-perm-dialog')!;
const press = (key: string): void => {
  dialog().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};
const button = (text: string): HTMLButtonElement =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === text)!;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('permissionConsentDialog', () => {
  it('lists supported permissions, the unsupported ones, source and the full-access note', async () => {
    const p = permissionConsentDialog({
      mode: 'install',
      name: 'Live Link',
      version: '1.0.0',
      author: 'Someone',
      ownerRepo: 'owner/live-link',
      known: ['ui.dialogs'],
      unknown: ['future.thing'],
    });
    const d = dialog();
    expect(d.querySelector('.pmd-route-header')!.textContent).toBe('Install Live Link v1.0.0?');
    expect(d.textContent).toContain('github.com/owner/live-link');
    expect(d.querySelector('[data-permission="ui.dialogs"]')!.textContent).toContain('Show dialogs');
    expect(d.querySelector('.pmd-plugin-perm-unknown')!.textContent).toBe('future.thing');
    expect(d.textContent).toContain(FULL_ACCESS_NOTE);
    button('Install').click();
    await expect(p).resolves.toBe(true);
    expect(document.querySelector('.pmd-route-overlay')).toBeNull();
  });

  it('Esc declines, and Enter does NOT grant', async () => {
    const p = permissionConsentDialog({ mode: 'dev', name: 'Dev', known: ['ui.dialogs'], unknown: [] });
    press('Enter');
    expect(document.querySelector('.pmd-plugin-perm-dialog')).not.toBeNull();
    press('Escape');
    await expect(p).resolves.toBe(false);
  });

  it('plugin-supplied text is rendered as text, never markup', async () => {
    const p = permissionConsentDialog({
      mode: 'install',
      name: '<img src=x onerror=alert(1)>',
      author: '<b>bold</b>',
      known: ['ui.dialogs'],
      unknown: [],
    });
    expect(dialog().querySelector('img')).toBeNull();
    expect(dialog().querySelector('b')).toBeNull();
    button('Cancel').click();
    await expect(p).resolves.toBe(false);
  });
});

describe('managePluginPermissionsDialog', () => {
  it('pre-checks granted permissions and returns the new selection on Save', async () => {
    const p = managePluginPermissionsDialog({
      name: 'Live Link',
      known: ['ui.dialogs'],
      unknown: ['future.thing'],
      granted: ['ui.dialogs'],
    });
    const box = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    box.click(); // revoke
    button('Save').click();
    await expect(p).resolves.toEqual([]);
  });

  it('Cancel returns null (no change)', async () => {
    const p = managePluginPermissionsDialog({ name: 'X', known: ['ui.dialogs'], unknown: [], granted: [] });
    button('Cancel').click();
    await expect(p).resolves.toBeNull();
  });
});
