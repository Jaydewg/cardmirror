/**
 * The status-bar collaboration chip (`#collab-chip`) — always-loaded half.
 *
 * Owns the chip's DOM in every state:
 *   - idle (no session on the focused doc): "Connected to <server>" when
 *     this app's relay answers, so you can tell you're online before any
 *     session exists;
 *   - in a session: a label, the presence dots, and a STATUS RING around
 *     your own dot (your dot keeps its presence color; the ring carries
 *     the connection state), plus a pulsing badge while cross-server
 *     joiners wait;
 *   - ended: a red bar reading "Session ended" until clicked or until the
 *     next session.
 *
 * The lazily-loaded collab-ui computes the session model and renders
 * through `renderChipSession`; clicking a session chip calls the
 * activator collab-ui registers (the expanded panel).
 *
 * Ring states (CSS in style.css, `.pmd-ring-*`; animations use only
 * transform/opacity — compositor-cheap — and stop under
 * prefers-reduced-motion): streaming = blue with an outward ripple;
 * degraded (stream down, relay still answering — i.e. polling) = yellow;
 * reconnecting = pulsing grey; credentials rejected = red, broken ring;
 * queued edits = the ring rotates (dashed) in whatever color applies;
 * read-only = a yellow pip on the ring; joined from another server = the
 * ring is a rounded square.
 */

import { relayBaseUrl } from './collab-relay.js';
import { relayLabel, relayHost } from '../federation/address.js';
import {
  ensureRelayCapabilities,
  federationFor,
  onRelayCapabilitiesChanged,
  relayReachable,
} from '../federation/relay-capabilities.js';

export type ChipLink = 'streaming' | 'degraded' | 'reconnecting' | 'auth';

export interface ChipPeer {
  name: string;
  color: string;
  self: boolean;
  /** Joined from another server (drawn as a rounded square). */
  remote?: boolean;
  /** That server, labelled, for the tooltip. */
  server?: string;
  /** A partner admitted read-only. */
  readOnly?: boolean;
}

export interface ChipSessionModel {
  link: ChipLink;
  queued: number;
  readOnly: boolean;
  /** You reached this session through federation (it lives elsewhere). */
  remote: boolean;
  peers: ChipPeer[];
  /** Cross-server joiners waiting for a decision. */
  pendingJoins: number;
  /** You joined with a view code (a spectator: no edits, no cursor). */
  spectator?: boolean;
  /** Spectators in the room, per the relay (they post no cursor, so
   *  they are a count, not dots). */
  watchers?: number;
}

const LINK_TEXT: Record<ChipLink, string> = {
  streaming: 'Synced',
  degraded: 'Polling',
  reconnecting: 'Reconnecting…',
  auth: 'Credentials rejected',
};

/** The words for a session state (label + tooltip / panel lines). */
export function chipStateText(
  m: Pick<ChipSessionModel, 'link' | 'queued' | 'readOnly'> & Partial<Pick<ChipSessionModel, 'spectator' | 'watchers'>>,
): string {
  let text = LINK_TEXT[m.link];
  if (m.queued > 0) {
    text = m.link === 'streaming' ? `Sending ${m.queued}…` : `${text} · ${m.queued} queued`;
  }
  if (m.spectator) text = `Watching · ${text}`;
  else if (m.readOnly) text = `${text} · read-only`;
  return m.watchers ? `${text} · ${m.watchers} watching` : text;
}

const LINK_DETAIL: Record<ChipLink, string> = {
  streaming: 'Live — edits arrive as they happen.',
  degraded:
    'The live connection dropped, but the relay still answers: edits are checked for periodically.',
  reconnecting: 'Can’t reach the relay right now. Edits are saved and will send when it’s back.',
  auth: 'The relay rejected your credentials. Check Settings → Collaboration.',
};

export function chipStateDetail(link: ChipLink): string {
  return LINK_DETAIL[link];
}

/** Ring classes for your own dot (shared with the three-pane footers). */
export function ringClasses(
  m: Pick<ChipSessionModel, 'link' | 'queued' | 'readOnly' | 'remote'> & Partial<Pick<ChipSessionModel, 'spectator'>>,
): string {
  return [
    'pmd-presence-ring',
    `pmd-ring-${m.link}`,
    m.queued > 0 ? 'pmd-ring-queued' : '',
    m.readOnly || m.spectator ? 'pmd-ring-readonly' : '',
    m.remote ? 'pmd-ring-remote' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Presence dots into `container`; your own dot sits inside the status
 *  ring when `self` state is given. Rebuilds only on change. */
export function renderPresenceInto(
  container: HTMLElement,
  peers: ChipPeer[],
  self: Pick<ChipSessionModel, 'link' | 'queued' | 'readOnly' | 'remote'> | null,
): void {
  const ring = self ? ringClasses(self) : '';
  const sig =
    `${ring}\n` +
    peers.map((p) => `${p.name}\u0000${p.color}\u0000${p.self ? 1 : 0}\u0000${p.server ?? ''}\u0000${p.readOnly ? 1 : 0}`).join('\n');
  if (container.dataset['sig'] === sig) return;
  container.dataset['sig'] = sig;
  container.replaceChildren();
  for (const p of peers) {
    const dot = document.createElement('span');
    dot.className =
      'pmd-collab-presence-dot' +
      (p.self ? ' pmd-collab-presence-dot-self' : '') +
      (p.remote ? ' pmd-collab-presence-dot-remote' : '');
    dot.style.background = p.color;
    dot.title = p.self
      ? `${p.name} (you)`
      : `${p.name}${p.remote && p.server ? ` — from ${p.server}` : ''}${p.readOnly ? ' (read-only)' : ''}`;
    if (p.self && self) {
      const wrap = document.createElement('span');
      wrap.className = ring;
      wrap.title = `${p.name} (you) — ${chipStateText(self)}`;
      wrap.appendChild(dot);
      container.appendChild(wrap);
    } else {
      container.appendChild(dot);
    }
  }
}

// ── chip state ──

let sessionModel: ChipSessionModel | null = null;
let ended = false;
let activator: ((anchor: HTMLElement) => void) | null = null;

function chipEl(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('collab-chip');
}

/** Register what clicking a SESSION chip does (collab-ui: the panel). */
export function setChipActivator(fn: ((anchor: HTMLElement) => void) | null): void {
  activator = fn;
}

/** Show a session's state (null = the focused doc has no session). */
export function renderChipSession(model: ChipSessionModel | null): void {
  if (model) ended = false;
  sessionModel = model;
  render();
}

/** The session ended under you (host ended it / room gone): red bar
 *  until clicked or until the next session. */
export function markChipEnded(): void {
  ended = true;
  sessionModel = null;
  render();
}

function parts(chip: HTMLElement): { label: HTMLElement; dots: HTMLElement; badge: HTMLElement } {
  let label = chip.querySelector<HTMLElement>(':scope > .pmd-collab-chip-label');
  let dots = chip.querySelector<HTMLElement>(':scope > .pmd-collab-chip-dots');
  let badge = chip.querySelector<HTMLElement>(':scope > .pmd-collab-chip-badge');
  if (!label || !dots || !badge) {
    chip.replaceChildren();
    label = document.createElement('span');
    label.className = 'pmd-collab-chip-label';
    dots = document.createElement('span');
    dots.className = 'pmd-collab-chip-dots';
    badge = document.createElement('span');
    badge.className = 'pmd-collab-chip-badge';
    chip.append(label, dots, badge);
  }
  return { label, dots, badge };
}

function setMode(chip: HTMLElement, mode: 'session' | 'idle' | 'ended' | 'offline'): void {
  for (const m of ['session', 'idle', 'ended', 'offline']) {
    chip.classList.toggle(`pmd-collab-chip-${m}`, m === mode);
  }
}

function render(): void {
  const chip = chipEl();
  if (!chip) return;
  chip.classList.add('pmd-collab-chip');
  if (wiredChip !== chip) wireClick(chip);
  const { label, dots, badge } = parts(chip);
  if (ended) {
    chip.hidden = false;
    setMode(chip, 'ended');
    label.textContent = 'Session ended';
    chip.title = 'This co-editing session has ended — your copy is yours to keep. Click to dismiss.';
    dots.replaceChildren();
    delete dots.dataset['sig'];
    badge.hidden = true;
    chip.setAttribute('role', 'button');
    return;
  }
  const m = sessionModel;
  if (m) {
    chip.hidden = false;
    setMode(chip, 'session');
    label.textContent = chipStateText(m);
    chip.title = `${chipStateDetail(m.link)} Click for details.`;
    renderPresenceInto(dots, m.peers, m);
    badge.hidden = m.pendingJoins <= 0;
    // No stray "0" in the chip's text (screen readers, textContent).
    badge.textContent = m.pendingJoins <= 0 ? '' : m.pendingJoins > 9 ? '9+' : String(m.pendingJoins);
    badge.title = `${m.pendingJoins} waiting to join from another server`;
    chip.setAttribute('role', 'button');
    return;
  }
  // Idle: is this app's relay answering?
  dots.replaceChildren();
  delete dots.dataset['sig'];
  badge.hidden = true;
  chip.removeAttribute('role');
  const base = relayBaseUrl();
  const reachable = base ? relayReachable(base) : null;
  if (!base || reachable === null) {
    setMode(chip, 'idle'); // drop an ended / session look while hidden
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  if (reachable) {
    const fed = federationFor(base);
    const name = fed ? relayLabel(fed.url, fed.nickname) : relayHost(base);
    setMode(chip, 'idle');
    label.textContent = `Connected to ${name}`;
    chip.title = fed
      ? `Your relay (${fed.url}) — connects to other servers. Start or join a session to co-edit.`
      : `Your relay (${base}). Start or join a session to co-edit.`;
  } else {
    setMode(chip, 'offline');
    label.textContent = 'Server unreachable';
    chip.title = `Can't reach your relay (${base}) right now.`;
  }
}

/** The element the click handler is on (per element, not once: a shell
 *  that rebuilds the status bar gets a fresh, still-clickable chip). */
let wiredChip: HTMLElement | null = null;
function wireClick(chip: HTMLElement): void {
  wiredChip = chip;
  chip.addEventListener('click', () => {
    if (ended) {
      ended = false;
      render();
      return;
    }
    if (sessionModel) activator?.(chip);
  });
}

let idleWired = false;
/** Boot: keep the idle state current (relay answers / stops answering). */
export function initSessionChip(): void {
  if (idleWired) return;
  idleWired = true;
  onRelayCapabilitiesChanged(render);
  const probe = (): void => {
    const base = relayBaseUrl();
    if (base) void ensureRelayCapabilities(base).then(render);
  };
  probe();
  // Reachability is otherwise only re-read on settings changes; a slow
  // probe keeps "Connected to …" honest without chatter (cached 5 min /
  // 30 s after a miss inside ensureRelayCapabilities).
  setInterval(probe, 60_000);
}
