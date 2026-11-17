// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  FULL_ACCESS_NOTE,
  managePluginPermissionsDialog,
  permissionConsentDialog,
  permissionRequestDialog,
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
    await expect(p).resolves.toEqual(['ui.dialogs']);
    expect(document.querySelector('.pmd-route-overlay')).toBeNull();
  });

  it('every permission starts ticked; unticking one leaves it out of the grant', async () => {
    const p = permissionConsentDialog({
      mode: 'install',
      name: 'Live Link',
      known: ['ui.dialogs', 'collab.join'],
      unknown: [],
    });
    const box = (perm: string) =>
      dialog().querySelector<HTMLInputElement>(`[data-permission="${perm}"] input[type="checkbox"]`)!;
    expect(box('ui.dialogs').checked).toBe(true);
    expect(box('collab.join').checked).toBe(true);
    box('collab.join').click();
    button('Install').click();
    await expect(p).resolves.toEqual(['ui.dialogs']);
  });

  it('unticking everything still installs, with no permissions', async () => {
    const p = permissionConsentDialog({ mode: 'update', name: 'X', known: ['ui.dialogs'], unknown: [] });
    expect(dialog().textContent).toContain('Anything unticked stays off.');
    dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    button('Update').click();
    await expect(p).resolves.toEqual([]);
  });

  it('Esc declines, and Enter does NOT grant', async () => {
    const p = permissionConsentDialog({ mode: 'dev', name: 'Dev', known: ['ui.dialogs'], unknown: [] });
    press('Enter');
    expect(document.querySelector('.pmd-plugin-perm-dialog')).not.toBeNull();
    press('Escape');
    await expect(p).resolves.toBeNull();
  });

  it('shows the plugin’s reasons as its own words', async () => {
    const p = permissionConsentDialog({
      mode: 'install',
      name: 'Live Link',
      known: ['collab.join', 'ui.dialogs'],
      unknown: [],
      reasons: { 'collab.join': 'So a file can carry its live link' },
    });
    expect(dialog().querySelector('[data-permission="collab.join"] .pmd-plugin-perm-reason')!.textContent).toBe(
      'Live Link says: “So a file can carry its live link”',
    );
    expect(dialog().querySelector('[data-permission="ui.dialogs"] .pmd-plugin-perm-reason')).toBeNull();
    button('Cancel').click();
    await p;
  });

  it('`unchecked` rows start unticked and stay out unless ticked', async () => {
    const p = permissionConsentDialog({
      mode: 'update',
      name: 'X',
      known: ['collab.join', 'ui.dialogs'],
      unknown: [],
      unchecked: ['ui.dialogs'],
    });
    const box = (perm: string) =>
      dialog().querySelector<HTMLInputElement>(`[data-permission="${perm}"] input[type="checkbox"]`)!;
    expect(box('collab.join').checked).toBe(true);
    expect(box('ui.dialogs').checked).toBe(false);
    button('Update').click();
    await expect(p).resolves.toEqual(['collab.join']);
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
    await expect(p).resolves.toBeNull();
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
    const box = dialog().querySelector<HTMLInputElement>('[data-permission="ui.dialogs"] input')!;
    expect(box.checked).toBe(true);
    box.click(); // revoke
    button('Save').click();
    await expect(p).resolves.toEqual({ granted: [], askAgain: true, blocked: [] });
  });

  it('“ask again” switch and blocked permissions: unblock, or grant (which unblocks)', async () => {
    const p = managePluginPermissionsDialog({
      name: 'X',
      known: ['collab.join', 'ui.dialogs', 'ui.notices'],
      unknown: [],
      granted: [],
      askAgain: true,
      blocked: ['collab.join', 'ui.dialogs', 'ui.notices'],
    });
    const row = (perm: string) => dialog().querySelector<HTMLElement>(`[data-permission="${perm}"]`)!;
    expect(row('collab.join').textContent).toContain('You asked it not to ask for this.');
    row('collab.join').querySelector<HTMLButtonElement>('.pmd-plugin-perm-unblock')!.click();
    expect(row('collab.join').querySelector('.pmd-plugin-perm-blocked')).toBeNull();
    expect(row('collab.join').querySelector<HTMLInputElement>('input')!.checked).toBe(false); // unblock ≠ grant
    row('ui.dialogs').querySelector<HTMLInputElement>('input')!.click(); // grant
    dialog().querySelector<HTMLInputElement>('.pmd-plugin-perm-askagain input')!.click(); // ask again: off
    button('Save').click();
    await expect(p).resolves.toEqual({ granted: ['ui.dialogs'], askAgain: false, blocked: ['ui.notices'] });
  });

  it('Cancel returns null (no change)', async () => {
    const p = managePluginPermissionsDialog({ name: 'X', known: ['ui.dialogs'], unknown: [], granted: [] });
    button('Cancel').click();
    await expect(p).resolves.toBeNull();
  });
});

describe('permissionRequestDialog', () => {
  const ask = () =>
    permissionRequestDialog({ name: 'Live Link', permission: 'collab.join', reason: 'To join from this file' });

  it('names the plugin and permission, quotes its reason, and offers three answers', async () => {
    for (const [label, value] of [
      ['Allow', 'allow'],
      ['Not now', 'not-now'],
      ['Don’t ask again', 'never'],
    ] as const) {
      const p = ask();
      expect(dialog().querySelector('.pmd-route-header')!.textContent).toBe(
        'Live Link wants to: Join co-editing sessions',
      );
      expect(dialog().querySelector('.pmd-plugin-perm-reason')!.textContent).toBe(
        'Live Link says: “To join from this file”',
      );
      button(label).click();
      await expect(p).resolves.toBe(value);
    }
  });

  it('Esc is "Not now"; Enter grants nothing', async () => {
    const p = ask();
    press('Enter');
    expect(document.querySelector('.pmd-plugin-perm-dialog')).not.toBeNull();
    press('Escape');
    await expect(p).resolves.toBe('not-now');
  });

  it('without a reason, shows only CardMirror’s description', async () => {
    const p = permissionRequestDialog({ name: 'X', permission: 'ui.dialogs', reason: null });
    expect(dialog().querySelector('.pmd-plugin-perm-reason')).toBeNull();
    expect(dialog().querySelector('.pmd-plugin-perm-desc')).not.toBeNull();
    button('Not now').click();
    await p;
  });
});
