/**
 * Presence cursors (M4, in v1 by decision) + AI-lease advertisement.
 *
 * Transport: the room's presence channel — encrypted fan-out frames the
 * relay never stores (hot path at cursor-move rates; a lost frame just
 * means a briefly stale cursor). Every frame carries a 1-byte type:
 *
 *   0x01  loro EphemeralStore bytes — partner cursor/selection state.
 *         loro-prosemirror's cursor plugin does all the hard parts
 *         (PM selection → stable loro cursors → decorations); we only
 *         pipe its store's local updates out and apply remote bytes in.
 *   0x02  lease advertisement JSON — "AI is editing here" (§4.6,
 *         NON-enforcing). Raw PM positions, valid when converged and
 *         advisory always: the partner maps them through local edits
 *         and repaints on each re-broadcast (every LEASE_MS while any
 *         lease is held, cleared when none are).
 *   0x03  roster JSON — "I'm in this session" ({peer, name, relay?, ro?},
 *         or {peer, leave}). Independent of the cursor: the "who's here"
 *         dots used to come from the cursor store alone, so a partner
 *         with no selection (editor unfocused, cursors off) vanished.
 *         Sent every KEEPALIVE_MS and on reconnect; entries expire like
 *         cursors. `relay` = the relay the sender joined through (for
 *         the other-server marker — the sender's own claim), `ro` = it
 *         was admitted read-only (it can't run repairs, so the repair
 *         leader election skips it), `sp` = it's a spectator (also
 *         skipped). Older builds ignore the type; they still appear
 *         through their cursors.
 *
 * Spectators send the roster only — never a cursor or a lease ad: they
 * are listed as here, not shown as a caret. They still SEE everyone
 * else's cursors. A frame the relay stamps as a spectator's (`viewer`)
 * marks its sender a spectator whatever the frame claims, and a
 * spectator's cursor or lease frame is dropped.
 *
 * Throttling: local cursor updates coalesce to ≤1 frame per
 * CURSOR_THROTTLE_MS (trailing edge, so the final resting position
 * always ships). A 15s keepalive re-broadcast defeats the ephemeral
 * store's timeout while the user reads without moving the caret.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import { CursorEphemeralStore, LoroEphemeralCursorPlugin } from 'loro-prosemirror';
import type { PeerID } from 'loro-crdt';
import { settings } from '../settings.js';
import type { CollabSession } from './collab-session.js';
import { leasedRanges } from '../ai/edit-coordinator.js';

/** Fallback presence name when no display name is set. Desktop keeps
 *  the old 'Partner'; web guests get a STABLE per-browser 'Guest NNN'
 *  (persisted) so two link-joiners in one room are tellable apart. */
function defaultPresenceName(): string {
  try {
    if (!window.localStorage || (window as { electronAPI?: unknown }).electronAPI) {
      return 'Partner';
    }
    const existing = window.localStorage.getItem('pmd-web-guest-name');
    if (existing) return existing;
    const name = `Guest ${100 + Math.floor(Math.random() * 900)}`;
    window.localStorage.setItem('pmd-web-guest-name', name);
    return name;
  } catch {
    return 'Partner';
  }
}

const FRAME_CURSOR = 0x01;
const FRAME_LEASE = 0x02;
const FRAME_ROSTER = 0x03;
// 250ms: a cursor that repaints four times a second still reads as live
// (the trailing edge sends the final resting position), and presence
// egress scales linearly with this while a typist holds the throttle
// open (2026-07-24 egress audit).
const CURSOR_THROTTLE_MS = 250;
// Receive-side drain cadence (perf study 2026-08-06): every remote
// cursor frame used to trigger its own full editor dispatch + an
// all-peers decoration rebuild in the vendored cursor plugin — up to
// ~20/sec with five active typists, and SSE chunk bursts amplified
// rather than coalesced. One notch coarser than the send throttle:
// arrivals from N peers interleave, so the receive side sees N× the
// per-peer rate.
const CURSOR_RECEIVE_COALESCE_MS = 150;
const KEEPALIVE_MS = 15_000;
const LEASE_MS = 2_000;
const STORE_TIMEOUT_MS = 45_000;

/** Deterministic per-peer cursor color: readable on light and dark
 *  themes (fixed S/L, hue from the peer id). */
export function peerColor(peerId: string): string {
  let h = 0;
  for (const ch of peerId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 70%, 45%)`;
}

/** CursorEphemeralStore that can absorb a BATCH of remote payloads
 *  with exactly ONE listener notification at the end — the vendored
 *  cursor plugin schedules a full dispatch + decoration rebuild per
 *  notification, so per-frame apply made every arriving frame a full
 *  editor update. Presence is display-only state (nothing here touches
 *  the document CRDT); the only behavior change is remote cursors
 *  repainting on the drain cadence, and the send throttle's own
 *  comment already declares 4/sec "reads as live". */
/** CursorEphemeralStore that can absorb a BATCH of remote payloads
 *  with exactly ONE listener notification at the end — the vendored
 *  cursor plugin (via the ephemeral adapter's `subscribeBy`) schedules
 *  a full dispatch + all-peers decoration rebuild per notification, so
 *  per-frame apply made every arriving frame a full editor update.
 *  Presence is display-only state (nothing here touches the document
 *  CRDT); the only behavior change is remote cursors repainting on the
 *  drain cadence, and the send throttle's own comment already declares
 *  4/sec "reads as live".
 *
 *  NOTE the override target: the plugin subscribes through
 *  `subscribeBy` (whose implementation calls super.subscribe directly),
 *  NOT through `subscribe` — overriding the latter intercepts nothing. */
class CoalescingCursorStore extends CursorEphemeralStore {
  private readonly originals = new Set<(by: 'local' | 'import' | 'timeout') => void>();
  private suppress = false;
  private pending: 'import' | 'timeout' | null = null;
  /** getAll() memo: the vendored plugin calls getAll() once per rebuild
   *  PLUS once per peer from the default createCursor, and each call
   *  Cursor.decode()s every peer's anchor and focus (wasm) — (1+P)×2P
   *  decodes per rebuild, on every remote doc transaction (2026-09-01
   *  review, PH-A3). One decode pass per store mutation instead. */
  private allMemo: ReturnType<CursorEphemeralStore['getAll']> | null = null;

  private invalidate(): void {
    this.allMemo = null;
  }

  override getAll(): ReturnType<CursorEphemeralStore['getAll']> {
    if (this.allMemo === null) this.allMemo = super.getAll();
    return this.allMemo;
  }

  override setLocal(...args: Parameters<CursorEphemeralStore['setLocal']>): ReturnType<CursorEphemeralStore['setLocal']> {
    this.invalidate();
    return super.setLocal(...args);
  }

  override apply(...args: Parameters<CursorEphemeralStore['apply']>): ReturnType<CursorEphemeralStore['apply']> {
    this.invalidate();
    return super.apply(...args);
  }

  override subscribeBy(listener: (by: 'local' | 'import' | 'timeout') => void): () => void {
    this.originals.add(listener);
    const unsub = super.subscribeBy((by: 'local' | 'import' | 'timeout') => {
      this.invalidate(); // covers 'timeout' expiry (a removal we never see as apply/setLocal)
      if (this.suppress && by !== 'local') {
        // 'timeout' beats 'import' for the replay: expiry removes
        // peers, and a rebuild must not resurrect them under a
        // softer label.
        this.pending = this.pending === 'timeout' ? 'timeout' : by;
        return;
      }
      listener(by);
    });
    return () => {
      this.originals.delete(listener);
      unsub();
    };
  }

  /** Apply buffered remote payloads; notify subscribers once. Store
   *  notifications are synchronous within apply(), so a synchronous
   *  release window is sufficient (verified against loro-crdt 1.13). */
  applyBatch(payloads: Uint8Array[]): void {
    this.suppress = true;
    this.pending = null;
    try {
      for (const p of payloads) {
        try {
          this.apply(p);
        } catch {
          /* malformed/foreign frame — drop it alone */
        }
      }
    } finally {
      this.suppress = false;
      const by = this.pending;
      this.pending = null;
      if (by) for (const l of this.originals) l(by);
    }
  }
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

interface RosterAd {
  v: 1;
  peer: string;
  name?: string;
  /** The relay the sender joined through (canonical URL), if known. */
  relay?: string;
  /** Admitted read-only. */
  ro?: boolean;
  /** Spectator (joined with a view code). */
  sp?: boolean;
  /** Departure. */
  leave?: boolean;
}

/** One person in the room, for the "who's here" dots and the panel. */
export interface PresencePeer {
  peer: string;
  name: string;
  color: string;
  self: boolean;
  /** The relay they joined through (self-declared; null = unknown —
   *  an older build, or not announced yet). */
  relay: string | null;
  readOnly: boolean;
  /** Joined with a view code: watching, not editing. */
  spectator: boolean;
}

interface LeaseAd {
  /** Sender's loro peer id — the receiver drops its own echoes (the
   *  relay's presence fan-out includes the poster's own stream). */
  peer: string;
  /** Sender's display name for the tag ("Priya's AI"). */
  name: string;
  ranges: { from: number; to: number; label: string }[];
}

const leaseAdsKey = new PluginKey<DecorationSet>('collab-lease-ads');

export interface CursorsHandle {
  /** Announce departure to partners now (call before dispose/stop).
   *  `keepalive`: the page is unloading — let the browser finish the post. */
  farewell(opts?: { keepalive?: boolean }): void;
  /** Re-announce presence (after a stream reconnect). */
  rebroadcast(): void;
  /** Session plugins: the stock cursor plugin + the lease-ad renderer. */
  plugins(): Plugin[];
  /** Feed an incoming (decrypted) presence frame. `viewer`: the relay
   *  stamped it as a spectator's. */
  applyRemote(bytes: Uint8Array, viewer?: boolean): void;
  /** Peer ids of partners who can run repairs (self excluded): everyone
   *  on the roster or in the cursor store, minus read-only admissions
   *  and spectators.
   *  Best-effort — callers must degrade safely (the repair leader gate
   *  falls back to everyone-repairs, which idempotence makes safe). */
  visiblePeers(): string[];
  /** Everyone in the room right now — self first, then partners from the
   *  roster (whether or not their cursor is showing) plus any older
   *  builds visible only through their cursors. */
  presence(): PresencePeer[];
  /** Re-announce this peer's roster entry now (e.g. after an access
   *  change, so read-only status is current for partners). */
  announce(): void;
  dispose(): void;
}

export function installCursorPresence(
  session: CollabSession,
  getView: () => EditorView | null,
  /** What this peer announces on the roster beyond its name: the relay
   *  it joined through, whether it's read-only, and whether it's a
   *  spectator (then it sends no cursor). Read per announce. */
  identity: () => { relay: string | null; readOnly: boolean; spectator?: boolean } = () => ({
    relay: null,
    readOnly: false,
  }),
): CursorsHandle {
  const peerId = session.loroDoc.peerIdStr as PeerID;
  const store = new CoalescingCursorStore(peerId, STORE_TIMEOUT_MS);
  let disposed = false;
  /** Partners who announced themselves (see FRAME_ROSTER). */
  const roster = new Map<string, { name: string; relay: string | null; ro: boolean; sp: boolean; at: number }>();
  /** A spectator sends the roster and nothing else. */
  const watching = (): boolean => identity().spectator === true;
  const liveRoster = (): typeof roster => {
    const cutoff = Date.now() - STORE_TIMEOUT_MS;
    for (const [p, e] of roster) if (e.at < cutoff) roster.delete(p);
    return roster;
  };

  // --- outbound: cursor bytes, throttled trailing-edge ---
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingBytes: Uint8Array | null = null;
  /** Last frame actually sent — an unchanged cursor re-emitted by the
   *  store produces identical bytes, and resending them buys nothing.
   *  Cleared by the keepalive so idle-expiry refresh still goes out. */
  let lastSentBytes: Uint8Array | null = null;
  /** Local state at the moment of farewell(). The departure frame is a
   *  store DELETE, and the store's local state is our own entry — so an
   *  aborted departure (host End that failed to tombstone, keep-resumable
   *  close whose flush failed → session.start()) had nothing to
   *  re-announce until the next editor transaction. rebroadcast() restores
   *  it (knock-on audit 2026-09-02). */
  let partingLocal: ReturnType<typeof store.getLocal> = undefined;
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const unsubLocal = store.subscribeLocalUpdates((bytes: Uint8Array) => {
    if (disposed || !cursorsEnabled() || watching()) return;
    pendingBytes = bytes;
    sendTimer ??= setTimeout(() => {
      sendTimer = null;
      if (pendingBytes && !disposed && !(lastSentBytes && sameBytes(pendingBytes, lastSentBytes))) {
        lastSentBytes = pendingBytes;
        void session.sendPresence(frame(FRAME_CURSOR, pendingBytes));
      }
      pendingBytes = null;
    }, CURSOR_THROTTLE_MS);
  });

  // Keepalive: the store expires idle entries; a reading (not typing)
  // partner must not vanish. Re-setting the local state re-emits it —
  // and clears the dedupe baseline so the (byte-identical) refresh
  // frame actually reaches peers before their expiry timer fires.
  const keepalive = setInterval(() => {
    if (disposed || !cursorsEnabled() || watching()) return;
    const local = store.getLocal();
    if (local) {
      lastSentBytes = null;
      store.setLocal(local);
    }
  }, KEEPALIVE_MS);

  const user = {
    name: settings.get('pairingDisplayName').trim() || defaultPresenceName(),
    color: peerColor(peerId),
  };

  // Roster: announced regardless of the cursor (and of the cursors
  // setting, which governs the cursor overlay — being IN the session
  // isn't something to hide from its other participants).
  const sendRoster = (leave = false, opts?: { keepalive?: boolean }): void => {
    if (disposed) return;
    const id = identity();
    const ad: RosterAd = leave
      ? { v: 1, peer: peerId, leave: true }
      : {
          v: 1,
          peer: peerId,
          name: user.name,
          ...(id.relay ? { relay: id.relay } : {}),
          ...(id.readOnly ? { ro: true } : {}),
          ...(id.spectator ? { sp: true } : {}),
        };
    void session.sendPresence(frame(FRAME_ROSTER, new TextEncoder().encode(JSON.stringify(ad))), opts);
  };
  const rosterTimer = setInterval(() => sendRoster(), KEEPALIVE_MS);
  // First announcement once the session is up (install runs before start).
  const rosterKickoff = setTimeout(() => sendRoster(), 0);

  // --- inbound cursor coalescing buffer (see CURSOR_RECEIVE_COALESCE_MS) ---
  let cursorBuf: Uint8Array[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  // --- outbound: lease ads on a slow heartbeat ---
  let lastLeaseCount = 0;
  const leaseTimer = setInterval(() => {
    if (disposed || watching()) return;
    const view = getView();
    if (!view) return;
    const ranges = leasedRanges(view.state).map((r) => ({ ...r, label: 'AI' }));
    if (ranges.length === 0 && lastLeaseCount === 0) return; // nothing, and nothing to clear
    lastLeaseCount = ranges.length;
    const ad: LeaseAd = { peer: peerId, name: user.name, ranges };
    void session.sendPresence(frame(FRAME_LEASE, new TextEncoder().encode(JSON.stringify(ad))));
  }, LEASE_MS);

  // --- inbound lease rendering ---
  const applyLeaseAd = (ad: LeaseAd): void => {
    // The relay fans presence back to the poster's own stream — the
    // sender must not render its own advertisement on top of the real
    // local AI-working box (field: "partner's AI" on the running machine).
    if (ad.peer === peerId) return;
    const view = getView();
    if (!view || view.isDestroyed) return;
    const who = (ad.name || 'Partner').trim() || 'Partner';
    const decos = ad.ranges
      .filter((r) => r.from >= 0 && r.to > r.from && r.to <= view.state.doc.content.size)
      .flatMap((r) => [
        Decoration.inline(r.from, r.to, { class: 'pmd-collab-lease-ad' }),
        Decoration.widget(r.from, () => {
          const tag = document.createElement('span');
          tag.className = 'pmd-collab-lease-ad-tag';
          tag.textContent = `✦ ${who}'s ${r.label}`;
          return tag;
        }),
      ]);
    const tr = view.state.tr.setMeta(leaseAdsKey, DecorationSet.create(view.state.doc, decos));
    view.dispatch(tr);
  };

  const leaseAdsPlugin = new Plugin<DecorationSet>({
    key: leaseAdsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, prev) {
        const next = tr.getMeta(leaseAdsKey) as DecorationSet | undefined;
        if (next) return next;
        // Advisory ranges ride along with local edits between
        // re-broadcasts; each fresh ad replaces them wholesale.
        return prev.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return leaseAdsKey.getState(state);
      },
    },
  });

  const cursorEls = new Map<string, { sig: string; el: HTMLElement }>();
  const cursorElementFor = (peer: string): HTMLElement => {
    let name = 'Partner';
    let color = peerColor(peer);
    try {
      const st = (store.getAllStates() as Record<string, { user?: { name?: string; color?: string } }>)[peer];
      if (typeof st?.user?.name === 'string' && st.user.name.trim()) name = st.user.name;
      if (typeof st?.user?.color === 'string' && st.user.color) color = st.user.color;
    } catch {
      /* store shape/timing — defaults are fine */
    }
    const sig = `${name}\u0000${color}`;
    const hit = cursorEls.get(peer);
    if (hit && hit.sig === sig) return hit.el;
    const el = document.createElement('span');
    el.classList.add('ProseMirror-loro-cursor');
    el.setAttribute('style', `border-color: ${color}`);
    const label = document.createElement('div');
    label.setAttribute('style', `background-color: ${color}`);
    label.textContent = name;
    el.append(document.createTextNode('\u2060'), label, document.createTextNode('\u2060'));
    cursorEls.set(peer, { sig, el });
    return el;
  };

  return {
    plugins(): Plugin[] {
      if (!cursorsEnabled()) return [leaseAdsPlugin];
      return [
        LoroEphemeralCursorPlugin(store, {
          user,
          // Per-peer selection tint (the stock default is one fixed
          // yellow for everyone).
          createSelection: (peer) => ({
            class: 'loro-selection',
            style: `background-color: ${peerColor(peer).replace(')', ', 0.22)').replace('hsl', 'hsla')}`,
          }),
          // Memoized caret widgets: the stock createCursor built a fresh
          // <span>+<div> per peer per rebuild, so WidgetType.eq failed
          // and ProseMirror re-inserted every remote caret on every
          // remote transaction — layout churn at up to ~8Hz on a big
          // doc (2026-09-01 review, PH-A3). Same element while the
          // peer's name/color are unchanged → PM leaves it alone.
          createCursor: (peer) => cursorElementFor(peer),
        }),
        leaseAdsPlugin,
      ];
    },
    visiblePeers(): string[] {
      const ids = new Set<string>();
      try {
        for (const p of Object.keys(store.getAllStates())) ids.add(p);
      } catch {
        /* store timing — roster alone */
      }
      for (const [p, e] of liveRoster()) {
        if (e.ro || e.sp) ids.delete(p); // read-only admissions and spectators can't run repairs
        else ids.add(p);
      }
      ids.delete(peerId);
      return [...ids];
    },
    presence(): PresencePeer[] {
      const id = identity();
      const out: PresencePeer[] = [
        {
          peer: String(peerId),
          name: user.name,
          color: user.color,
          self: true,
          relay: id.relay,
          readOnly: id.readOnly,
          spectator: id.spectator === true,
        },
      ];
      const seen = new Set<string>([String(peerId)]);
      for (const [p, e] of liveRoster()) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({
          peer: p,
          name: e.name || 'Partner',
          color: peerColor(p),
          self: false,
          relay: e.relay,
          readOnly: e.ro,
          spectator: e.sp,
        });
      }
      try {
        // Older builds announce no roster — they show while their cursor does.
        const states = store.getAllStates() as Record<
          string,
          { user?: { name?: string; color?: string } }
        >;
        for (const p of Object.keys(states)) {
          if (seen.has(p)) continue;
          seen.add(p);
          const nm = states[p]?.user?.name;
          const name = (typeof nm === 'string' && nm.trim()) || 'Partner';
          out.push({ peer: p, name, color: peerColor(p), self: false, relay: null, readOnly: false, spectator: false });
        }
      } catch {
        /* store shape / timing — roster + self is safe */
      }
      return out;
    },
    announce(): void {
      sendRoster();
    },
    applyRemote(bytes: Uint8Array, viewer = false): void {
      if (disposed || bytes.length < 2) return;
      const type = bytes[0];
      const payload = bytes.subarray(1);
      // Spectators are listed, never drawn: drop any caret or lease ad a
      // relay-stamped spectator frame carries.
      if (viewer && type !== FRAME_ROSTER) return;
      if (type === FRAME_CURSOR) {
        // Buffer + trailing drain: one store batch (→ one dispatch,
        // one decoration rebuild) per window, however many frames or
        // SSE-burst fragments arrived. Expiry stays the store's timer.
        cursorBuf.push(payload);
        drainTimer ??= setTimeout(() => {
          drainTimer = null;
          if (disposed) return;
          const batch = cursorBuf;
          cursorBuf = [];
          store.applyBatch(batch);
        }, CURSOR_RECEIVE_COALESCE_MS);
      } else if (type === FRAME_LEASE) {
        try {
          applyLeaseAd(JSON.parse(new TextDecoder().decode(payload)) as LeaseAd);
        } catch {
          /* malformed — drop */
        }
      } else if (type === FRAME_ROSTER) {
        try {
          const ad = JSON.parse(new TextDecoder().decode(payload)) as RosterAd;
          if (!ad || typeof ad.peer !== 'string' || ad.peer === peerId) return; // own echo
          if (ad.leave) {
            roster.delete(ad.peer);
            return;
          }
          roster.set(ad.peer, {
            name: typeof ad.name === 'string' ? ad.name.trim().slice(0, 80) : '',
            relay: typeof ad.relay === 'string' && ad.relay ? ad.relay : null,
            ro: ad.ro === true,
            // The relay's stamp outranks the frame's own claim.
            sp: viewer || ad.sp === true,
            at: Date.now(),
          });
        } catch {
          /* malformed — drop */
        }
      }
    },
    farewell(opts: { keepalive?: boolean } = {}): void {
      sendRoster(true, opts); // leave the roster too (independent of cursors)
      // Departure frame, sent SYNCHRONOUSLY and before dispose/stop: the
      // ephemeral store's only expiry is its 45s timeout, and dispose()
      // set `disposed` before unhooking, so a leaving peer's caret and
      // presence dot lingered on every partner for up to 45s — during
      // exactly the "did they leave?" moment (2026-09-01 review, PH-A10).
      // An ephemeral delete is a payload shape old clients already apply.
      if (disposed || !cursorsEnabled() || watching()) return;
      try {
        partingLocal = store.getLocal() ?? partingLocal;
        let bytes: Uint8Array | null = null;
        const off = store.subscribeLocalUpdates((b: Uint8Array) => {
          bytes = b;
        });
        try {
          store.delete(peerId as never);
        } finally {
          off();
        }
        if (bytes) void session.sendPresence(frame(FRAME_CURSOR, bytes), opts);
      } catch {
        /* best-effort — the 45s expiry remains the backstop */
      }
    },
    rebroadcast(): void {
      // After a stream reconnect nothing re-announced presence until the
      // 15s keepalive; partners saw us absent for up to that long.
      sendRoster();
      if (disposed || !cursorsEnabled() || watching()) return;
      const local = store.getLocal() ?? partingLocal;
      partingLocal = undefined;
      if (local) {
        lastSentBytes = null;
        store.setLocal(local);
      }
    },
    dispose(): void {
      disposed = true;
      unsubLocal();
      clearInterval(keepalive);
      clearInterval(leaseTimer);
      clearInterval(rosterTimer);
      clearTimeout(rosterKickoff);
      if (sendTimer) clearTimeout(sendTimer);
      if (drainTimer) clearTimeout(drainTimer);
    },
  };
}

function cursorsEnabled(): boolean {
  return settings.get('collabShowCursors');
}
