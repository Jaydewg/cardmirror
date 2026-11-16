// @vitest-environment jsdom

/**
 * Status-bar notices (toast audit part 2, 2026-08-17). Pinned:
 *  - posting shows the chip with a count and fires the companion
 *    toast once; key-coalesced repeats bump ×N and never re-toast
 *    (the save-heal heartbeat becomes one counter)
 *  - the panel lists notices with Copy / Dismiss; dismissing the last
 *    one hides the chip; Dismiss all clears; Escape closes the panel
 *  - long bodies clamp behind Show more
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/editor/toast.js', () => ({ showToast: toastSpy }));
const copySpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/editor/clipboard-write.js', () => ({ writeClipboardText: copySpy }));

import {
  postNotice,
  wireStatusNotices,
  noticeCount,
  __resetNoticesForTests,
} from '../../src/editor/status-notices.js';

const chip = () => document.getElementById('notice-chip') as HTMLButtonElement;
const panel = () => document.querySelector<HTMLElement>('.pmd-notice-panel');
const btn = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.pmd-notice-panel button')].find(
    (b) => b.textContent === label,
  );

beforeEach(() => {
  const c = document.createElement('button');
  c.id = 'notice-chip';
  c.hidden = true;
  document.body.appendChild(c);
  wireStatusNotices();
});

afterEach(() => {
  __resetNoticesForTests();
  document.body.innerHTML = '';
  toastSpy.mockClear();
  copySpy.mockClear();
});

describe('status notices', () => {
  it('posting shows the chip and toasts once; repeats coalesce without re-toasting', () => {
    postNotice({ severity: 'error', title: 'Autosave problem', body: 'It broke.', key: 'k' });
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toContain('1');
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith('It broke.');

    // The heartbeat: same key, many firings → one entry, ×N, no toasts.
    for (let i = 0; i < 5; i++) {
      postNotice({ severity: 'error', title: 'Autosave problem', body: 'It broke.', key: 'k' });
    }
    expect(noticeCount()).toBe(1);
    expect(chip().textContent).toContain('1');
    expect(toastSpy).toHaveBeenCalledTimes(1);

    chip().click();
    expect(panel()!.textContent).toContain('×6');
  });

  it('distinct notices stack; the chip displays the worst tier present', () => {
    postNotice({ severity: 'info', title: 'I', body: 'i body' });
    expect(chip().dataset['severity']).toBe('info');
    expect(chip().textContent).toContain('ⓘ');
    postNotice({ severity: 'warning', title: 'W', body: 'w body' });
    expect(chip().dataset['severity']).toBe('warning');
    expect(chip().textContent).toContain('⚠');
    postNotice({ severity: 'error', title: 'E', body: 'e body' });
    expect(noticeCount()).toBe(3);
    expect(chip().textContent).toContain('3');
    expect(chip().dataset['severity']).toBe('error');
  });

  it('Copy copies title+body; Dismiss removes; empty list hides the chip', async () => {
    postNotice({ severity: 'error', title: 'T', body: 'B' });
    chip().click();
    btn('Copy')!.click();
    await Promise.resolve();
    expect(copySpy).toHaveBeenCalledWith('T\nB');
    btn('Dismiss')!.click();
    expect(noticeCount()).toBe(0);
    expect(chip().hidden).toBe(true);
    expect(panel()).toBeNull();
  });

  it('Dismiss all clears; Escape closes the panel without dismissing', () => {
    postNotice({ severity: 'info', title: 'A', body: 'a' });
    postNotice({ severity: 'info', title: 'B', body: 'b' });
    chip().click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel()).toBeNull();
    expect(noticeCount()).toBe(2);
    chip().click();
    btn('Dismiss all')!.click();
    expect(noticeCount()).toBe(0);
    expect(chip().hidden).toBe(true);
  });

  it('long bodies clamp behind Show more', () => {
    const long = 'word '.repeat(120).trim();
    postNotice({ severity: 'error', title: 'Long', body: long, toast: false });
    expect(toastSpy).not.toHaveBeenCalled();
    chip().click();
    const bodyEl = document.querySelector<HTMLElement>('.pmd-notice-body')!;
    expect(bodyEl.textContent!.length).toBeLessThan(long.length);
    btn('Show more')!.click();
    expect(bodyEl.textContent).toBe(long);
  });
});

describe('notice actions', () => {
  it('render before Copy/Dismiss; a click dismisses, then runs; a throw is contained', () => {
    const run = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    postNotice({ severity: 'info', title: 'A', body: 'a', key: 'a', actions: [{ label: 'Join', run }] });
    postNotice({ severity: 'info', title: 'B', body: 'b', key: 'b', actions: [{ label: 'Boom', run: boom }] });
    chip().click();
    const labels = [...document.querySelectorAll('.pmd-notice-actions')].map((row) =>
      [...row.querySelectorAll('button')].map((b) => b.textContent),
    );
    expect(labels).toContainEqual(['Join', 'Copy', 'Dismiss']);
    btn('Join')!.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(noticeCount()).toBe(1);
    btn('Boom')!.click();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    expect(noticeCount()).toBe(0);
    err.mockRestore();
  });

  it('a keyed repeat replaces the actions', () => {
    const first = vi.fn();
    const second = vi.fn();
    postNotice({ severity: 'info', title: 'A', body: 'a', key: 'k', actions: [{ label: 'Go', run: first }] });
    postNotice({ severity: 'info', title: 'A', body: 'a', key: 'k', actions: [{ label: 'Go', run: second }] });
    chip().click();
    btn('Go')!.click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
