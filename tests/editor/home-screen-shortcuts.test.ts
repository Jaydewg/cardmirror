// @vitest-environment jsdom
/**
 * Home-screen number shortcuts (1-9) must stand down while a modal or the
 * command bar is layered over the home screen — otherwise they fire over the
 * modal and swallow number input meant for it.
 */

import { describe, it, expect, vi, type Mock, beforeEach, afterEach } from 'vitest';
import { homeScreen, type HomeScreenCallbacks } from '../../src/editor/home-screen.js';
import { pushOverlay, popOverlay } from '../../src/editor/overlay-stack.js';

function makeCallbacks(): HomeScreenCallbacks & { newDoc: Mock<() => void> } {
  return {
    newDoc: vi.fn(),
    newSpeechDoc: vi.fn(),
    open: vi.fn(),
    openRecent: vi.fn(),
    manageQuickCards: vi.fn(),
  };
}

function press(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('home-screen number shortcuts', () => {
  let cb: ReturnType<typeof makeCallbacks>;

  beforeEach(() => {
    document.body.innerHTML = '';
    cb = makeCallbacks();
    homeScreen.mount(document.body, cb);
    homeScreen.show();
  });

  afterEach(() => {
    homeScreen.hide();
  });

  it('fires the action when the home screen is the active layer', () => {
    press('1');
    expect(cb.newDoc).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire while a modal overlay is open', () => {
    const token = pushOverlay();
    try {
      press('1');
      expect(cb.newDoc).not.toHaveBeenCalled();
    } finally {
      popOverlay(token);
    }
  });

  it('does NOT fire when focus is in a text input (e.g. the command bar)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    press('1', input);
    expect(cb.newDoc).not.toHaveBeenCalled();
  });

  it('resumes firing once the overlay closes', () => {
    const token = pushOverlay();
    press('1');
    popOverlay(token);
    press('1');
    expect(cb.newDoc).toHaveBeenCalledTimes(1);
  });
});

describe('home-screen shortcuts reflow around the gated Compress tile', () => {
  afterEach(() => homeScreen.hide());

  function mountWith(extra: Partial<HomeScreenCallbacks>) {
    document.body.innerHTML = '';
    const cb = {
      newDoc: vi.fn(),
      newSpeechDoc: vi.fn(),
      open: vi.fn(),
      openRecent: vi.fn(),
      manageQuickCards: vi.fn(),
      clean: vi.fn(),
      bulkConvert: vi.fn(),
      ...extra,
    } as HomeScreenCallbacks & { manageQuickCards: Mock<() => void> };
    homeScreen.mount(document.body, cb);
    homeScreen.show();
    return cb;
  }

  it('Compress gated OFF: key 6 runs Manage quick cards (numbers close the gap)', () => {
    // Runners: 1 New, 2 New speech, 3 Open, 4 Clean, 5 Convert, 6 Quick Cards.
    const cb = mountWith({}); // no bulkCompress supplied
    press('6');
    expect(cb.manageQuickCards).toHaveBeenCalledTimes(1);
  });

  it('Compress gated ON: key 6 runs Compress, key 7 runs Manage quick cards', () => {
    const bulkCompress = vi.fn();
    const cb = mountWith({ bulkCompress });
    press('6');
    expect(bulkCompress).toHaveBeenCalledTimes(1);
    expect(cb.manageQuickCards).not.toHaveBeenCalled();
    press('7');
    expect(cb.manageQuickCards).toHaveBeenCalledTimes(1);
  });
});

describe('Settings tile (2026-09-21)', () => {
  it('renders its own labeled group beside Learn and runs on key 9', () => {
    document.body.innerHTML = '';
    const openSettings = vi.fn();
    const cb: HomeScreenCallbacks = { newDoc: vi.fn(), newSpeechDoc: vi.fn(), open: vi.fn(), openRecent: vi.fn(), manageQuickCards: vi.fn(), clean: vi.fn(), bulkConvert: vi.fn(), openSettings };
    homeScreen.mount(document.body, cb);
    homeScreen.show();
    try {
      const groups = Array.from(document.querySelectorAll('.pmd-home-labeled'));
      const titles = groups.map((g) => g.querySelector('.pmd-home-section-title')?.textContent);
      expect(titles.slice(-2)).toEqual(['Learn', 'Settings']);
      const tile = groups[groups.length - 1]!.querySelector<HTMLButtonElement>('button.pmd-home-action')!;
      expect(tile.textContent).toContain('Settings');
      tile.click();
      expect(openSettings).toHaveBeenCalledTimes(1);
      // Runners: 1 New, 2 New speech, 3 Open, 4 Clean, 5 Convert, 6 Quick Cards, 7 Review all, 8 Manage flashcards, 9 Settings.
      press('9');
      expect(openSettings).toHaveBeenCalledTimes(2);
    } finally {
      homeScreen.hide();
    }
  });

  it('is absent, and 9 does nothing, when no callback is supplied', () => {
    document.body.innerHTML = '';
    const cb: HomeScreenCallbacks = { newDoc: vi.fn(), newSpeechDoc: vi.fn(), open: vi.fn(), openRecent: vi.fn(), manageQuickCards: vi.fn() };
    homeScreen.mount(document.body, cb);
    homeScreen.show();
    try {
      const titles = Array.from(document.querySelectorAll('.pmd-home-labeled .pmd-home-section-title')).map((h) => h.textContent);
      expect(titles).not.toContain('Settings');
      press('9');
    } finally {
      homeScreen.hide();
    }
  });
});
