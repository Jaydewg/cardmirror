/**
 * The expanded session panel — what clicking the status-bar session chip
 * opens. Small by design (tooltips carry the detail): your connection
 * state, who's here, cross-server joiners waiting (Accept / Read-only /
 * Decline / Later), admitted remote participants (allow editing /
 * read-only / remove — home-server participants only, the relay enforces
 * that too), and the session actions (copy codes; leave or end → Home).
 *
 * Lazy (collab chunk). Re-rendered in place on every tick so it stays
 * live while open; closes on Escape, outside click, or an action.
 */

import { chipStateDetail, chipStateText, renderPresenceInto, type ChipSessionModel } from './session-chip.js';
import type { JoinRequestWatcher, JoinRow } from '../federation/collab-federation.js';
import type { SessionRole } from './session-role.js';

export interface SessionPanelCtx {
  model(): ChipSessionModel | null;
  role: SessionRole;
  /** Where the session lives, labelled (null = unknown). */
  homeLabel: string | null;
  watcher: JoinRequestWatcher | null;
  /** The session's code in each form: `current` is what Copy code gives;
   *  `classic` is the plain `cmshare1.` / `cmshare2.` code (no server
   *  address); `cross` names the session's server (null when this relay
   *  doesn't federate). */
  codes(): { current: string; classic: string; cross: string | null };
  copy(kind: 'current' | 'classic' | 'cross'): void;
  /** Leave (participant) or end (host), then go Home. */
  leave(): void;
  /** Participants on the session's own server only: end it for everyone
   *  anyway (confirmed by the caller) — the way out when whoever started
   *  it is gone, or you lost the host role. Absent = not offered. */
  endForEveryone?: () => void;
}

let current: { el: HTMLElement; anchor: HTMLElement; ctx: SessionPanelCtx; cleanup: () => void } | null = null;
/** The Copy code dropdown is open (survives re-renders while the panel is). */
let copyMenuOpen = false;
/** The Leave ▾ dropdown (End for everyone) is open. */
let leaveMenuOpen = false;

export function sessionPanelOpen(): boolean {
  return current !== null;
}

export function closeSessionPanel(): void {
  if (!current) return;
  const { el, cleanup } = current;
  current = null;
  cleanup();
  el.classList.add('pmd-collab-panel-closing');
  setTimeout(() => el.remove(), 120);
}

/** Toggle the panel above `anchor`. */
export function toggleSessionPanel(anchor: HTMLElement, ctx: SessionPanelCtx): void {
  if (current) {
    closeSessionPanel();
    return;
  }
  copyMenuOpen = false;
  leaveMenuOpen = false;
  const el = document.createElement('div');
  el.className = 'pmd-collab-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Co-editing session');
  document.body.appendChild(el);
  const onDown = (e: MouseEvent): void => {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || anchor.contains(t))) return;
    closeSessionPanel();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // The dropdown first, then the panel.
      if (copyMenuOpen || leaveMenuOpen) {
        copyMenuOpen = false;
        leaveMenuOpen = false;
        refreshSessionPanel();
        current?.el.querySelector<HTMLElement>('.pmd-collab-panel-split-toggle')?.focus();
        return;
      }
      closeSessionPanel();
    }
  };
  const offWatch = ctx.watcher?.onChange(() => refreshSessionPanel()) ?? (() => {});
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  current = {
    el,
    anchor,
    ctx,
    cleanup: () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      offWatch();
    },
  };
  ctx.watcher?.poke();
  refreshSessionPanel();
}

/** Re-render the open panel (status ticks, roster or request changes). */
export function refreshSessionPanel(): void {
  if (!current) return;
  const { el, anchor, ctx } = current;
  const m = ctx.model();
  if (!m) {
    closeSessionPanel();
    return;
  }
  const rows = ctx.watcher?.rows() ?? [];
  const sig = JSON.stringify([m, rows, ctx.codes(), copyMenuOpen, leaveMenuOpen]);
  if (el.dataset['sig'] !== sig) {
    el.dataset['sig'] = sig;
    el.replaceChildren(...build(m, rows, ctx));
  }
  position(el, anchor);
}

function position(el: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth || 280;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  el.style.left = `${left}px`;
  el.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, opts: { title?: string; kind?: 'primary' | 'danger' } = {}): HTMLButtonElement {
  const b = h('button', `pmd-collab-panel-btn${opts.kind ? ` pmd-collab-panel-btn-${opts.kind}` : ''}`, label);
  b.type = 'button';
  if (opts.title) b.title = opts.title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function section(title: string): HTMLElement {
  return h('div', 'pmd-collab-panel-section', title);
}

function build(m: ChipSessionModel, rows: JoinRow[], ctx: SessionPanelCtx): HTMLElement[] {
  const out: HTMLElement[] = [];

  // Status
  const head = h('div', 'pmd-collab-panel-head');
  const status = h('div', 'pmd-collab-panel-status', chipStateText(m));
  head.append(status, h('div', 'pmd-collab-panel-detail', chipStateDetail(m.link)));
  if (ctx.homeLabel) {
    head.appendChild(
      h(
        'div',
        'pmd-collab-panel-detail',
        m.remote ? `Hosted on ${ctx.homeLabel} — you joined from another server.` : `Hosted on ${ctx.homeLabel}.`,
      ),
    );
  }
  out.push(head);

  // People
  out.push(section(`In this session · ${m.peers.length}`));
  const people = h('div', 'pmd-collab-panel-list');
  for (const p of m.peers) {
    const row = h('div', 'pmd-collab-panel-row');
    const dot = h('span', 'pmd-collab-chip-dots');
    renderPresenceInto(dot, [p], p.self ? m : null);
    const name = h('span', 'pmd-collab-panel-name', p.self ? `${p.name || 'You'} (you)` : p.name || 'Someone');
    row.append(dot, name);
    if ((p.self && m.readOnly) || (!p.self && p.readOnly)) {
      row.appendChild(h('span', 'pmd-collab-panel-tag pmd-collab-panel-tag-ro', 'read-only'));
    }
    if (p.self && m.remote) row.appendChild(h('span', 'pmd-collab-panel-tag', 'other server'));
    if (!p.self && p.remote) {
      const tag = h('span', 'pmd-collab-panel-tag', 'other server');
      if (p.server) tag.title = `Joined from ${p.server}`;
      row.appendChild(tag);
    }
    people.appendChild(row);
  }
  out.push(people);

  // Waiting to join (home side)
  const pending = rows.filter((r) => r.state === 'pending');
  if (ctx.watcher && pending.length > 0) {
    out.push(section(`Waiting to join · ${pending.length}`));
    const list = h('div', 'pmd-collab-panel-list');
    for (const r of pending) {
      const row = h('div', 'pmd-collab-panel-row pmd-collab-panel-row-wrap' + (r.deferred ? ' pmd-collab-panel-row-deferred' : ''));
      const who = h('span', 'pmd-collab-panel-name', r.name || 'Someone');
      who.title = `${r.name || 'Someone'} on ${r.server}`;
      row.append(h('span', 'pmd-collab-panel-pending-dot'), who, h('span', 'pmd-collab-panel-server', r.server));
      const actions = h('div', 'pmd-collab-panel-actions');
      const w = ctx.watcher;
      actions.append(
        button('Accept', () => void w.decide(r.requestId, 'write'), { kind: 'primary' }),
        button('Read-only', () => void w.decide(r.requestId, 'read'), { title: 'Let them follow along without editing' }),
        button('Decline', () => void w.decide(r.requestId, 'deny')),
      );
      if (!r.deferred) actions.appendChild(button('Later', () => w.defer(r.requestId), { title: 'Stop asking; it stays here' }));
      row.appendChild(actions);
      list.appendChild(row);
    }
    out.push(list);
  }

  // Admitted remote participants (home side)
  const admitted = rows.filter((r) => r.state === 'approved');
  if (ctx.watcher && admitted.length > 0) {
    out.push(section('From other servers'));
    const list = h('div', 'pmd-collab-panel-list');
    for (const r of admitted) {
      const row = h('div', 'pmd-collab-panel-row pmd-collab-panel-row-wrap');
      row.append(
        h('span', 'pmd-collab-panel-remote-mark'),
        h('span', 'pmd-collab-panel-name', r.name || 'Someone'),
        h('span', 'pmd-collab-panel-server', `${r.server} · ${r.mode === 'read' ? 'read-only' : 'can edit'}`),
      );
      const actions = h('div', 'pmd-collab-panel-actions');
      const w = ctx.watcher;
      actions.append(
        r.mode === 'read'
          ? button('Allow editing', () => void w.decide(r.requestId, 'write'))
          : button('Make read-only', () => void w.decide(r.requestId, 'read')),
        button('Remove', () => void w.decide(r.requestId, 'revoke'), { kind: 'danger', title: 'They keep their copy; the session goes on without them' }),
      );
      row.appendChild(actions);
      list.appendChild(row);
    }
    out.push(list);
  }

  // Session actions
  const foot = h('div', 'pmd-collab-panel-foot');
  // Copy code — a split button: the main part copies the default form;
  // the caret opens a dropdown of every form (shown inline, beneath it).
  const codes = ctx.codes();
  const forms: { kind: 'classic' | 'cross'; title: string; code: string; hint: string }[] = [
    {
      kind: 'classic',
      title: codes.classic.startsWith('cmshare2') ? 'Classic code (cmshare2)' : 'Classic code (cmshare1)',
      code: codes.classic,
      hint: m.remote
        ? `Only for people on ${ctx.homeLabel ?? 'the session’s server'} — any CardMirror version`
        : 'For people on your server — works with every CardMirror version',
    },
  ];
  if (codes.cross !== null) {
    forms.push({
      kind: 'cross',
      title: 'Cross-server code',
      code: codes.cross,
      hint: 'For people on other servers — they’ll need your OK to join',
    });
  }
  const copy = h('div', 'pmd-collab-panel-copy');
  const split = h('div', 'pmd-collab-panel-split');
  split.appendChild(button('Copy code', () => {
    closeSessionPanel();
    ctx.copy('current');
  }, { title: forms.find((f) => f.code === codes.current)?.title ?? 'Copy the session code' }));
  if (forms.length > 1 || forms[0]!.code !== codes.current) {
    const toggle = button('▾', () => {
      copyMenuOpen = !copyMenuOpen;
      leaveMenuOpen = false;
      refreshSessionPanel();
      if (copyMenuOpen) current?.el.querySelector<HTMLElement>('.pmd-collab-panel-menu-item')?.focus();
    }, { title: 'Other forms of the code' });
    toggle.classList.add('pmd-collab-panel-split-toggle');
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', String(copyMenuOpen));
    toggle.setAttribute('aria-label', 'Choose which code to copy');
    split.appendChild(toggle);
  }
  // One row: Copy code ▾ on the left, Leave / End on the right — the
  // dropdown opens BELOW the row, so it can never push the session action
  // out of view (it used to wrap End session under the open menu).
  const actionsRow = h('div', 'pmd-collab-panel-foot-row');
  const leaveSplit = h('div', 'pmd-collab-panel-split pmd-collab-panel-leave');
  leaveSplit.appendChild(button(ctx.role === 'host' ? 'End session' : ctx.role === 'spectator' ? 'Stop watching' : 'Leave session', () => {
    closeSessionPanel();
    ctx.leave();
  }, {
    kind: 'danger',
    title: ctx.role === 'host'
      ? 'End it for everyone, keep your copy, and go to the Home screen'
      : ctx.role === 'spectator'
        ? 'Stop watching (the copy becomes yours to edit) and go to the Home screen'
        : 'Leave (you keep your copy) and go to the Home screen',
  }));
  if (ctx.role !== 'host' && ctx.endForEveryone) {
    const lt = button('▾', () => {
      leaveMenuOpen = !leaveMenuOpen;
      copyMenuOpen = false;
      refreshSessionPanel();
    }, { kind: 'danger', title: 'More ways to leave' });
    lt.classList.add('pmd-collab-panel-split-toggle');
    lt.setAttribute('aria-haspopup', 'menu');
    lt.setAttribute('aria-expanded', String(leaveMenuOpen));
    lt.setAttribute('aria-label', 'More ways to leave');
    leaveSplit.appendChild(lt);
  }
  actionsRow.append(split, leaveSplit);
  copy.appendChild(actionsRow);
  if (leaveMenuOpen && ctx.endForEveryone) {
    const menu = h('div', 'pmd-collab-panel-menu');
    menu.setAttribute('role', 'menu');
    const item = h('button', 'pmd-collab-panel-menu-item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(
      h('span', 'pmd-collab-panel-menu-title pmd-collab-panel-menu-danger', 'End for everyone…'),
      h('span', 'pmd-collab-panel-menu-hint',
        'Ends the session for everyone, not just you — for when whoever started it is gone. Everyone keeps their copy.'),
    );
    const end = ctx.endForEveryone;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      leaveMenuOpen = false;
      closeSessionPanel();
      end();
    });
    menu.appendChild(item);
    copy.appendChild(menu);
  }
  if (copyMenuOpen) {
    const menu = h('div', 'pmd-collab-panel-menu');
    menu.setAttribute('role', 'menu');
    for (const f of forms) {
      const item = h('button', 'pmd-collab-panel-menu-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      const top = h('span', 'pmd-collab-panel-menu-title', f.title);
      if (f.code === codes.current) top.appendChild(h('span', 'pmd-collab-panel-menu-default', 'Copy code'));
      item.append(top, h('span', 'pmd-collab-panel-menu-code', f.code), h('span', 'pmd-collab-panel-menu-hint', f.hint));
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        copyMenuOpen = false;
        closeSessionPanel();
        ctx.copy(f.kind);
      });
      menu.appendChild(item);
    }
    copy.appendChild(menu);
  }
  foot.appendChild(copy);
  out.push(foot);
  return out;
}
