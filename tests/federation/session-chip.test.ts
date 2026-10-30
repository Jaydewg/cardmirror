// @vitest-environment jsdom
/**
 * The status-bar session chip and its expanded panel (session-chip.ts,
 * session-panel.ts): the status ring states, the waiting-joiner badge,
 * the "Session ended" bar, and the panel's join-request actions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  chipStateText,
  minimalChipParts,
  markChipEnded,
  renderChipSession,
  ringClasses,
  setChipActivator,
  type ChipSessionModel,
} from '../../src/editor/collab/session-chip.js';
import { closeSessionPanel, toggleSessionPanel } from '../../src/editor/collab/session-panel.js';
import type { JoinRequestWatcher, JoinRow } from '../../src/editor/federation/collab-federation.js';

const base: ChipSessionModel = {
  link: 'streaming',
  queued: 0,
  readOnly: false,
  remote: false,
  peers: [
    { name: 'Me', color: 'rgb(200, 30, 30)', self: true },
    { name: 'Partner', color: 'rgb(30, 30, 200)', self: false },
  ],
  pendingJoins: 0,
};

function chip(): HTMLElement {
  return document.getElementById('collab-chip')!;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="collab-chip" class="status-segment" hidden></div>';
  closeSessionPanel();
});

describe('session chip', () => {
  it('your dot keeps its color inside a status ring', () => {
    renderChipSession(base);
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toBe('Synced');
    const ring = chip().querySelector('.pmd-presence-ring')!;
    expect(ring.className).toBe('pmd-presence-ring pmd-ring-streaming');
    expect((ring.firstElementChild as HTMLElement).style.background).toBe('rgb(200, 30, 30)');
    // Partners' dots are plain.
    expect(chip().querySelectorAll('.pmd-collab-chip-dots > .pmd-collab-presence-dot')).toHaveLength(1);
  });

  it('maps every state to a label and ring', () => {
    const cases: Array<[Partial<ChipSessionModel>, string, string[]]> = [
      [{ link: 'streaming', queued: 2 }, 'Sending 2…', ['pmd-ring-streaming', 'pmd-ring-queued']],
      [{ link: 'degraded' }, 'Polling', ['pmd-ring-degraded']],
      [{ link: 'degraded', queued: 3 }, 'Polling · 3 queued', ['pmd-ring-degraded', 'pmd-ring-queued']],
      [{ link: 'reconnecting' }, 'Reconnecting…', ['pmd-ring-reconnecting']],
      [{ link: 'auth' }, 'Credentials rejected', ['pmd-ring-auth']],
      [{ readOnly: true }, 'Synced · read-only', ['pmd-ring-readonly']],
      [{ remote: true }, 'Synced', ['pmd-ring-remote']],
    ];
    for (const [over, text, classes] of cases) {
      const m = { ...base, ...over };
      expect(chipStateText(m)).toBe(text);
      for (const c of classes) expect(ringClasses(m)).toContain(c);
    }
  });

  it('a partner from another server is a rounded square, with their server in the tooltip', () => {
    renderChipSession({
      ...base,
      peers: [
        base.peers[0]!,
        { name: 'Avery', color: 'rgb(0, 128, 0)', self: false, remote: true, server: 'Westside (laptop2.example)' },
      ],
    });
    const dot = chip().querySelector<HTMLElement>('.pmd-collab-chip-dots > .pmd-collab-presence-dot')!;
    expect(dot.classList.contains('pmd-collab-presence-dot-remote')).toBe(true);
    expect(dot.title).toBe('Avery — from Westside (laptop2.example)');
  });

  it('waiting joiners show a badge; no stray text when none', () => {
    renderChipSession({ ...base, pendingJoins: 2 });
    const badge = chip().querySelector<HTMLElement>('.pmd-collab-chip-badge')!;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    renderChipSession({ ...base, pendingJoins: 0 });
    expect(badge.hidden).toBe(true);
    expect(chip().textContent).toBe('Synced');
  });

  it('an ended session is a red bar until clicked; clicking a live chip opens the panel', () => {
    const activate = vi.fn();
    setChipActivator(activate);
    renderChipSession(base);
    chip().click();
    expect(activate).toHaveBeenCalledTimes(1);
    markChipEnded();
    expect(chip().textContent).toBe('Session ended');
    expect(chip().classList.contains('pmd-collab-chip-ended')).toBe(true);
    chip().click(); // dismiss
    expect(chip().classList.contains('pmd-collab-chip-ended')).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    // A new session clears it too.
    markChipEnded();
    renderChipSession(base);
    expect(chip().textContent).toBe('Synced');
  });
});

describe('spectators on the chip', () => {
  it('a listed spectator gets the spectator pip and says so on hover', () => {
    renderChipSession({
      ...base,
      peers: [base.peers[0]!, { name: 'Sam', color: 'rgb(0, 0, 0)', self: false, spectator: true }],
    });
    const dot = chip().querySelector<HTMLElement>('.pmd-collab-chip-dots > .pmd-collab-presence-dot')!;
    expect(dot.classList.contains('pmd-collab-presence-dot-spectator')).toBe(true);
    expect(dot.title).toBe('Sam (spectating)');
  });

  it('a spectator the relay won\'t list sees the minimal line instead', () => {
    const m: ChipSessionModel = {
      ...base,
      spectator: true,
      minimal: true,
      watchers: 3,
      peers: [base.peers[0]!, base.peers[1]!, { name: 'Ed', color: 'rgb(1, 1, 1)', self: false }],
    };
    expect(minimalChipParts(m)).toEqual(['Watching', '5 people', '3 spectating', 'Online']);
    renderChipSession(m);
    expect(chip().classList.contains('pmd-collab-chip-minimal')).toBe(true);
    expect([...chip().querySelectorAll('.pmd-collab-chip-seg')].map((e) => e.textContent)).toEqual(minimalChipParts(m));
    expect(chip().querySelectorAll('.pmd-collab-chip-line')).toHaveLength(5);
    expect(chip().querySelectorAll('.pmd-collab-presence-dot')).toHaveLength(0);
    expect(minimalChipParts({ ...m, link: 'reconnecting' })[3]).toBe('Offline');
    // Back to a normal session: the minimal class goes away.
    renderChipSession(base);
    expect(chip().classList.contains('pmd-collab-chip-minimal')).toBe(false);
  });
});

describe('session panel', () => {
  function fakeWatcher(rows: JoinRow[]): JoinRequestWatcher & { decide: ReturnType<typeof vi.fn>; defer: ReturnType<typeof vi.fn> } {
    return {
      poke: vi.fn(),
      rows: () => rows,
      onChange: () => () => {},
      decide: vi.fn(async () => {}),
      defer: vi.fn(),
      review: async () => {},
      dispose: vi.fn(),
    };
  }

  it('lists people, waiting joiners (with Accept/Read-only/Decline/Later) and admitted remotes', () => {
    renderChipSession(base);
    const watcher = fakeWatcher([
      { requestId: 'r1', name: 'Bob', server: 'Beta (relay-b.example)', state: 'pending', mode: null, deferred: false },
      { requestId: 'r2', name: 'Cy', server: 'Gamma (relay-c.example)', state: 'approved', mode: 'read', deferred: false },
    ]);
    const leave = vi.fn();
    toggleSessionPanel(chip(), {
      model: () => ({ ...base, pendingJoins: 1 }),
      role: 'host',
      homeLabel: 'Alpha (relay-a.example)',
      watcher,
      codes: () => ({
        current: 'cmshare2.x.k.1.0.0',
        classic: 'cmshare2.x.k.1.0.0',
        cross: 'cmshare2f.x.k.1.0.0@https://relay-a.example/relay',
      }),
      copy: vi.fn(),
      leave,
    });
    const panel = document.querySelector<HTMLElement>('.pmd-collab-panel')!;
    expect(panel.textContent).toContain('Hosted on Alpha (relay-a.example).');
    expect(panel.textContent).toContain('In this session · 2');
    expect(panel.textContent).toContain('Waiting to join · 1');
    expect(panel.textContent).toContain('Beta (relay-b.example)');
    expect(panel.textContent).toContain('From other servers');
    const click = (label: string): void => {
      const b = [...panel.querySelectorAll('button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no ${label}`);
      b.click();
    };
    click('Read-only');
    expect(watcher.decide).toHaveBeenCalledWith('r1', 'read');
    click('Later');
    expect(watcher.defer).toHaveBeenCalledWith('r1');
    click('Allow editing');
    expect(watcher.decide).toHaveBeenCalledWith('r2', 'write');
    click('End session');
    expect(leave).toHaveBeenCalled();
    expect(document.querySelector('.pmd-collab-panel-closing')).not.toBeNull();
  });

  it('Copy code is a split button whose dropdown lists every form of the code', () => {
    document.body.innerHTML = '<div id="collab-chip" class="status-segment" hidden></div>';
    renderChipSession(base);
    const copy = vi.fn();
    toggleSessionPanel(chip(), {
      model: () => ({ ...base, remote: false }),
      role: 'participant',
      homeLabel: 'relay-a.example',
      watcher: null,
      // Cross-server codes switched on: Copy code gives the f form.
      codes: () => ({
        current: 'cmshare2f.x.k.1.0.0@https://relay-a.example/relay',
        classic: 'cmshare2.x.k.1.0.0',
        cross: 'cmshare2f.x.k.1.0.0@https://relay-a.example/relay',
      }),
      copy,
      leave: vi.fn(),
    });
    const panel = (): HTMLElement => document.querySelector<HTMLElement>('.pmd-collab-panel:not(.pmd-collab-panel-closing)')!;
    expect(panel().querySelector('.pmd-collab-panel-menu')).toBeNull(); // closed at rest
    const toggle = panel().querySelector<HTMLElement>('.pmd-collab-panel-split-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    const items = [...panel().querySelectorAll<HTMLElement>('.pmd-collab-panel-menu-item')];
    expect(items.map((i) => i.querySelector('.pmd-collab-panel-menu-title')!.firstChild!.textContent)).toEqual([
      'Classic code (cmshare2)',
      'Cross-server code',
    ]);
    // The default is marked; each shows its code.
    expect(items[1]!.textContent).toContain('Copy code');
    expect(items[0]!.querySelector('.pmd-collab-panel-menu-code')!.textContent).toBe('cmshare2.x.k.1.0.0');
    // Escape closes the dropdown first, not the panel.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel().querySelector('.pmd-collab-panel-menu')).toBeNull();
    panel().querySelector<HTMLElement>('.pmd-collab-panel-split-toggle')!.click();
    panel().querySelector<HTMLElement>('.pmd-collab-panel-menu-item')!.click();
    expect(copy).toHaveBeenCalledWith('classic');
  });

  it('spectators: a count beside the header, listed ones tagged, unlisted ones in italics; no End for everyone', () => {
    document.body.innerHTML = '<div id="collab-chip" class="status-segment" hidden></div>';
    const leave = vi.fn();
    toggleSessionPanel(chip(), {
      model: () => ({
        ...base,
        spectator: true,
        watchers: 3,
        peers: [{ ...base.peers[0]!, spectator: true }, base.peers[1]!, { name: 'Sam', color: 'rgb(9, 9, 9)', self: false, spectator: true }],
      }),
      role: 'spectator',
      homeLabel: null,
      watcher: null,
      codes: () => ({ current: 'cmview1.x.k', classic: 'cmview1.x.k', cross: null }),
      copy: vi.fn(),
      leave,
      // Offered by mistake: the panel must still not show it to a spectator.
      endForEveryone: vi.fn(),
    });
    const panel = document.querySelector<HTMLElement>('.pmd-collab-panel')!;
    const head = panel.querySelector<HTMLElement>('.pmd-collab-panel-section')!;
    expect(head.textContent).toBe('In this session · 1 · 3 spectating');
    expect(panel.querySelectorAll('.pmd-collab-panel-tag-spectator')).toHaveLength(2);
    expect(panel.querySelector('.pmd-collab-panel-unlisted')!.textContent).toBe(
      '1 more person is spectating without being listed',
    );
    const labels = [...panel.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Copy view code');
    expect(labels).toContain('Stop watching');
    expect(labels).not.toContain('▾'); // no Leave ▾ → End for everyone
    expect(panel.textContent).not.toContain('End for everyone');
  });

  it('the host gets End session ▾ → Leave session (keeps it running); End stays the main action', () => {
    document.body.innerHTML = '<div id="collab-chip" class="status-segment" hidden></div>';
    const leave = vi.fn();
    const leaveKeepRunning = vi.fn();
    toggleSessionPanel(chip(), {
      model: () => base,
      role: 'host',
      homeLabel: null,
      watcher: null,
      codes: () => ({ current: 'cmshare2.x.k.1.0.0', classic: 'cmshare2.x.k.1.0.0', cross: null }),
      copy: vi.fn(),
      leave,
      leaveKeepRunning,
    });
    const panel = (): HTMLElement => document.querySelector<HTMLElement>('.pmd-collab-panel:not(.pmd-collab-panel-closing)')!;
    const leaveSplit = panel().querySelector<HTMLElement>('.pmd-collab-panel-leave')!;
    expect(leaveSplit.firstElementChild!.textContent).toBe('End session');
    const toggle = leaveSplit.querySelector<HTMLElement>('.pmd-collab-panel-split-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('Leave without ending');
    toggle.click();
    const item = panel().querySelector<HTMLElement>('.pmd-collab-panel-menu-item')!;
    expect(item.querySelector('.pmd-collab-panel-menu-title')!.textContent).toBe('Leave session');
    expect(item.querySelector('.pmd-collab-panel-menu-danger')).toBeNull(); // leaving isn't destructive
    expect(panel().textContent).not.toContain('End for everyone');
    item.click();
    expect(leaveKeepRunning).toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it('a spectator the relay won\'t list gets the minimal panel', () => {
    document.body.innerHTML = '<div id="collab-chip" class="status-segment" hidden></div>';
    const leave = vi.fn();
    toggleSessionPanel(chip(), {
      model: () => ({ ...base, spectator: true, minimal: true, watchers: 2 }),
      role: 'spectator',
      homeLabel: null,
      watcher: null,
      codes: () => ({ current: 'cmview1.x.k', classic: 'cmview1.x.k', cross: null }),
      copy: vi.fn(),
      leave,
    });
    const panel = document.querySelector<HTMLElement>('.pmd-collab-panel')!;
    expect(panel.querySelector('.pmd-collab-panel-status')!.textContent).toBe('Watching · 3 people · 2 spectating · Online');
    expect(panel.querySelector('.pmd-collab-panel-section')).toBeNull(); // nobody listed
    const buttons = [...panel.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Stop watching']);
    buttons[0]!.click();
    expect(leave).toHaveBeenCalled();
  });
});
