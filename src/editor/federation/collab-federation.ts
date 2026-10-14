/**
 * Co-editing across servers (relay/FEDERATION.md §6) — the app side.
 *
 * Trust model: participants on the room's HOME relay trust each other
 * by default (a share code is enough, exactly as before). A participant
 * from ANOTHER relay must be let in by someone on the home relay, who
 * consciously chooses Accept, Accept (read-only), or Decline. The home
 * relay enforces that decision; this module is the two ends of it:
 *
 *   joiner  `requestRemoteAdmission` — ask, wait (cancellable), learn
 *           the mode; passes persist so a rejoin needs no new approval.
 *   home    `createJoinRequestWatcher` — on the stream's `j` nudge (and
 *           every reconnect), list pending requests and prompt.
 *
 * Plus the read-only editor clamp a read-only admission installs.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { isSyncOrigin } from '../sync-origin.js';
import { loroSyncPluginKey } from 'loro-prosemirror';
import { promptForChoice, installModalKeys, armDialogFocus, captureFocusForDialog } from '../text-prompt.js';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { settings } from '../settings.js';
import { flaggedVersion } from '../relay-protocol.js';
import { appVersion } from '../install-info.js';
import { decryptBlob, encryptBlob, importRoomKey } from '../collab/collab-crypto.js';
import { relayClientForHome } from '../collab/collab-relay.js';
import {
  RoomsError,
  RELAY_NOT_FEDERATING_STATUS,
  type JoinMode,
  type JoinRequestListing,
  type RoomsClient,
} from '../collab/room-client.js';
import { refusalWhy, relayLabel } from './address.js';
export { refusalWhy };
import { ownRelayFederation, refreshOwnRelayFederation, selfRelayUrl } from './self.js';

// ── Where a room lives ──

/** The room's home relay when it is NOT this app's own relay (i.e. the
 *  room must be reached through federation); null for a local room. */
export function remoteHomeOf(home: string | undefined | null): string | null {
  if (!home) return null;
  return home === selfRelayUrl() ? null : home;
}

// ── Room passes (joiner side), persisted per room ──

interface StoredPass {
  pass: string;
  home: string;
  /** Last mode the home relay reported (offline resume uses it). */
  mode: JoinMode | null;
  at: number;
}

const PASS_STORE_KEY = 'cm-fed-room-passes';

function readPasses(): Record<string, StoredPass> {
  try {
    const raw = localStorage.getItem(PASS_STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, StoredPass>) : {};
  } catch {
    return {};
  }
}

function writePasses(all: Record<string, StoredPass>): void {
  try {
    localStorage.setItem(PASS_STORE_KEY, JSON.stringify(all));
  } catch {
    /* storage denied: admission still works this run, rejoin re-asks */
  }
}

export function storedRoomPass(roomId: string, home: string): StoredPass | null {
  const p = readPasses()[roomId];
  return p && p.home === home && typeof p.pass === 'string' ? p : null;
}

function savePass(roomId: string, value: StoredPass): void {
  const all = readPasses();
  all[roomId] = value;
  writePasses(all);
}

/** Record the mode the home relay last reported for a stored pass. */
export function noteRoomPassMode(roomId: string, mode: JoinMode): void {
  const all = readPasses();
  const cur = all[roomId];
  if (!cur || cur.mode === mode) return;
  all[roomId] = { ...cur, mode, at: Date.now() };
  writePasses(all);
}

/** Forget a room's pass (the room is over, or the request was refused). */
export function forgetRoomPass(roomId: string): void {
  const all = readPasses();
  if (!(roomId in all)) return;
  delete all[roomId];
  writePasses(all);
}

function mintPass(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A rooms client for a remote-homed room, carrying its stored pass. */
export function remoteRoomClient(roomId: string, home: string): RoomsClient | null {
  return relayClientForHome(home, () => storedRoomPass(roomId, home)?.pass ?? '');
}

// ── Joiner: ask, wait, learn the mode ──

export type AdmissionOutcome =
  | { kind: 'admitted'; mode: JoinMode; client: RoomsClient }
  | { kind: 'cancelled' }
  | { kind: 'refused'; message: string }
  /** Not a federation answer (own-relay credentials, network): the
   *  caller words it like any other relay failure. */
  | { kind: 'error'; err: unknown }
  | { kind: 'ended' };

/** What a federation refusal means to a person. */
export function federationFailureMessage(err: unknown, homeLabel: string): string | null {
  if (!(err instanceof RoomsError)) return null;
  if (err.status === RELAY_NOT_FEDERATING_STATUS || err.code === 'relay-not-federating') {
    return `This session is on another server (${homeLabel}), and your relay doesn't connect to other servers.`;
  }
  switch (err.code) {
    case 'peer-refused':
      return `Your relay doesn't connect to ${homeLabel}${refusalWhy(err.reason)}.`;
    case 'home-refused':
      return `${homeLabel} doesn't accept connections from your relay.`;
    case 'home-not-federating':
      return `${homeLabel} doesn't connect to other servers.`;
    case 'home-unreachable':
      return `Couldn't reach ${homeLabel} — it may be offline. Try again shortly.`;
    case 'join-denied':
      return 'The session declined your request to join.';
    case 'too-many-join-requests':
      return 'That session has too many pending join requests — try again later.';
    default:
      return null;
  }
}

/** Ask the home relay to let this participant in, and wait (with a
 *  cancellable dialog) for someone there to decide. Reuses a stored
 *  admission when one exists — a rejoin needs no fresh approval. */
export async function requestRemoteAdmission(opts: {
  roomId: string;
  home: string;
  keyBytes: Uint8Array;
  pollMs?: number;
}): Promise<AdmissionOutcome> {
  const { roomId, home } = opts;
  const label = relayLabel(home);
  await refreshOwnRelayFederation();
  const fed = ownRelayFederation();
  if (!fed?.rooms || !fed.joinRequests) {
    return {
      kind: 'refused',
      message: `This session is on another server (${label}), and your relay doesn't connect to other servers.`,
    };
  }
  let stored = storedRoomPass(roomId, home);
  if (!stored) {
    stored = { pass: mintPass(), home, mode: null, at: Date.now() };
    savePass(roomId, stored);
  }
  const client = remoteRoomClient(roomId, home);
  if (!client) return { kind: 'refused', message: 'No relay connection.' };

  const fail = (err: unknown): AdmissionOutcome => {
    if (err instanceof RoomsError && (err.status === 404 || err.status === 410)) {
      forgetRoomPass(roomId);
      return { kind: 'ended' };
    }
    const msg = federationFailureMessage(err, label);
    if (err instanceof RoomsError && err.code === 'join-denied') forgetRoomPass(roomId);
    return msg ? { kind: 'refused', message: msg } : { kind: 'error', err };
  };

  // One request per pass (idempotent server-side): first try the status
  // of an existing request, else create it.
  let status;
  try {
    status = await client.joinStatus(roomId).catch(async (err: unknown) => {
      if (err instanceof RoomsError && err.code === 'pass-invalid') {
        const intro = await sealIntro(opts.keyBytes);
        return client.requestJoin(roomId, stored!.pass, intro);
      }
      throw err;
    });
  } catch (err) {
    return fail(err);
  }

  const settle = (s: { state: string; mode: JoinMode | null }): AdmissionOutcome | null => {
    if (s.state === 'approved' && s.mode) {
      savePass(roomId, { ...stored!, mode: s.mode, at: Date.now() });
      return { kind: 'admitted', mode: s.mode, client };
    }
    if (s.state === 'denied') {
      forgetRoomPass(roomId);
      return { kind: 'refused', message: 'The session declined your request to join.' };
    }
    if (s.state === 'expired' || s.state === 'withdrawn') {
      forgetRoomPass(roomId);
      return { kind: 'refused', message: 'Your join request expired before anyone answered — ask again.' };
    }
    return null;
  };
  const immediate = settle(status);
  if (immediate) return immediate;

  // Pending: wait for a decision.
  const dialog = waitingDialog(
    'Waiting to be let in',
    `This session is on another server (${label}). Someone in the session needs to accept you — ` +
      'they’ll see your name and your server.',
  );
  const base = opts.pollMs ?? 2500;
  const startedAt = Date.now();
  try {
    for (;;) {
      const wait = Date.now() - startedAt > 60_000 ? base * 2 : base;
      const cancelled = await dialog.sleep(wait);
      if (cancelled) {
        void client.withdrawJoin(roomId).catch(() => {});
        forgetRoomPass(roomId);
        return { kind: 'cancelled' };
      }
      try {
        const s = await client.joinStatus(roomId);
        const done = settle(s);
        if (done) return done;
      } catch (err) {
        if (err instanceof RoomsError && (err.status === 0 || err.status >= 500)) continue; // keep waiting
        return fail(err);
      }
    }
  } finally {
    dialog.close();
  }
}

async function sealIntro(keyBytes: Uint8Array): Promise<Uint8Array> {
  const key = await importRoomKey(keyBytes);
  const intro = {
    v: 1,
    name: settings.get('pairingDisplayName').trim().slice(0, 80),
    app: flaggedVersion(appVersion),
  };
  return encryptBlob(key, new TextEncoder().encode(JSON.stringify(intro)));
}

/** A modal "please wait" with Cancel that the caller closes. */
function waitingDialog(title: string, message: string): {
  sleep: (ms: number) => Promise<boolean>;
  close: () => void;
} {
  let cancelled = false;
  let wake: (() => void) | null = null;
  if (typeof document === 'undefined') {
    return {
      sleep: (ms) => new Promise((r) => setTimeout(() => r(cancelled), ms)),
      close: () => {},
    };
  }
  const restoreFocus = captureFocusForDialog();
  const token = pushOverlay();
  const overlay = document.createElement('div');
  overlay.className = 'pmd-route-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog';
  const header = document.createElement('div');
  header.className = 'pmd-route-header';
  header.textContent = title;
  const body = document.createElement('div');
  body.className = 'pmd-choice-prompt-detail';
  body.textContent = message;
  const buttons = document.createElement('div');
  buttons.className = 'pmd-text-prompt-buttons';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'pmd-route-cancel';
  cancelBtn.textContent = 'Cancel request';
  const cancel = (): void => {
    cancelled = true;
    wake?.();
  };
  cancelBtn.addEventListener('click', cancel);
  buttons.appendChild(cancelBtn);
  dialog.append(header, body, buttons);
  overlay.appendChild(dialog);
  const removeKeys = installModalKeys(dialog, token, (e) => {
    if (e.key === 'Escape') {
      cancel();
      return true;
    }
    return false;
  });
  document.body.appendChild(overlay);
  armDialogFocus(dialog, 'dialog', title);
  let closed = false;
  return {
    sleep: (ms) =>
      new Promise((resolve) => {
        if (cancelled) return resolve(true);
        const t = setTimeout(() => {
          wake = null;
          resolve(cancelled);
        }, ms);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve(true);
        };
      }),
    close: () => {
      if (closed) return;
      closed = true;
      popOverlay(token);
      overlay.remove();
      removeKeys();
      restoreFocus();
    },
  };
}

// ── Home side: prompt for pending requests ──

export interface JoinRequestWatcher {
  /** Re-list and prompt (the stream's `j` nudge; every reconnect). */
  poke(): void;
  /** Prompt again for requests the user put off ("Decide later"),
   *  then offer each admitted remote participant's access for change
   *  (read-only ↔ editing, or remove). Resolves when done. */
  review(): Promise<void>;
  dispose(): void;
}

/** Watches a HOME-side session's cross-server join requests and asks
 *  this participant to decide each one. Inert (poke does nothing) when
 *  the app's relay doesn't federate. Decisions made by another
 *  participant close the open prompt. */
export function createJoinRequestWatcher(opts: {
  roomId: string;
  client: RoomsClient;
  keyBytes: Uint8Array;
  docTitle: () => string;
}): JoinRequestWatcher {
  let disposed = false;
  const deferred = new Set<string>();
  let open: { requestId: string; abort: AbortController } | null = null;
  let keyP: Promise<CryptoKey> | null = null;

  const introName = async (blob: Uint8Array): Promise<string> => {
    try {
      keyP ??= importRoomKey(opts.keyBytes);
      const plain = await decryptBlob(await keyP, blob);
      const intro = JSON.parse(new TextDecoder().decode(plain)) as { name?: unknown };
      return typeof intro.name === 'string' ? intro.name.trim().slice(0, 80) : '';
    } catch {
      return ''; // not sealed with this room's key — show as unnamed
    }
  };

  const ask = async (req: JoinRequestListing): Promise<void> => {
    const name = await introName(req.blob);
    const server = relayLabel(req.origin, req.originNickname);
    const title = opts.docTitle();
    const abort = new AbortController();
    open = { requestId: req.requestId, abort };
    const choice = await promptForChoice<'write' | 'read' | 'deny'>({
      message: `${name || 'Someone'} wants to join from another server`,
      detail:
        `${name ? `"${name}"` : 'A participant'} on ${server} is asking to join` +
        `${title ? ` "${title}"` : ' this session'}. People on other servers need your OK. ` +
        'Read-only lets them follow along without editing.',
      choices: [
        { value: 'write', label: 'Accept', primary: true },
        { value: 'read', label: 'Accept (read-only)' },
        { value: 'deny', label: 'Decline' },
      ],
      cancelLabel: 'Decide later',
      signal: abort.signal,
    });
    open = null;
    if (disposed) return;
    if (choice === null) {
      if (!abort.signal.aborted) deferred.add(req.requestId);
      return;
    }
    try {
      await opts.client.decideJoinRequest(opts.roomId, req.requestId, choice);
    } catch (err) {
      // Already decided by someone else (409 closed / 404 gone) is fine.
      if (!(err instanceof RoomsError && (err.status === 404 || err.status === 409))) {
        deferred.delete(req.requestId); // ask again next round
      }
    }
  };

  // Listing and prompting are decoupled: a nudge must re-list (and close
  // the open prompt if someone else already decided it) even while this
  // participant is still looking at a prompt.
  let listing = false;
  let relist = false;
  let queue: JoinRequestListing[] = [];

  const pump = (): void => {
    if (disposed || open) return;
    const next = queue.shift();
    if (!next) return;
    void ask(next).then(() => {
      pump();
      void refresh(); // decisions change the list; catch new arrivals too
    });
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const fed = ownRelayFederation();
    if (!fed?.joinRequests) return;
    if (listing) {
      relist = true;
      return;
    }
    listing = true;
    try {
      do {
        relist = false;
        let list: JoinRequestListing[];
        try {
          list = await opts.client.listJoinRequests(opts.roomId);
        } catch {
          return; // offline / older relay — the next nudge retries
        }
        if (disposed) return;
        const pending = list.filter((r) => r.state === 'pending');
        const ids = new Set(pending.map((r) => r.requestId));
        if (open && !ids.has(open.requestId)) open.abort.abort();
        queue = pending.filter((r) => !deferred.has(r.requestId) && r.requestId !== open?.requestId);
      } while (relist && !disposed);
    } finally {
      listing = false;
    }
    pump();
  };

  return {
    poke: () => void refresh(),
    review: async () => {
      deferred.clear();
      await refresh();
      // Wait out the pending prompts first (one at a time, as ever).
      while (!disposed && (open || queue.length > 0)) await new Promise((r) => setTimeout(r, 100));
      if (disposed) return;
      let list: JoinRequestListing[];
      try {
        list = await opts.client.listJoinRequests(opts.roomId);
      } catch {
        return;
      }
      for (const req of list.filter((r) => r.state === 'approved')) {
        if (disposed) return;
        const name = (await introName(req.blob)) || 'A participant';
        const server = relayLabel(req.origin, req.originNickname);
        const editing = req.mode === 'write';
        const choice = await promptForChoice<'write' | 'read' | 'revoke'>({
          message: `${name} (${server})`,
          detail: editing
            ? 'Joined from another server and can edit.'
            : 'Joined from another server, read-only.',
          choices: [
            editing
              ? { value: 'read', label: 'Make read-only' }
              : { value: 'write', label: 'Allow editing' },
            { value: 'revoke', label: 'Remove from session' },
          ],
          cancelLabel: 'Keep as is',
        });
        if (choice === null || disposed) continue;
        try {
          await opts.client.decideJoinRequest(opts.roomId, req.requestId, choice);
        } catch {
          /* already changed elsewhere — nothing to do */
        }
      }
    },
    dispose: () => {
      disposed = true;
      open?.abort.abort();
    },
  };
}

// ── Read-only clamp ──

const readOnlyKey = new PluginKey('collabFederationReadOnly');

/** Blocks LOCAL document edits while `isReadOnly()` (a read-only
 *  admission); remote (sync-origin) transactions always pass — rejecting
 *  merged content would desync the view (see sync-origin.ts). */
export function collabReadOnlyPlugin(isReadOnly: () => boolean): Plugin {
  return new Plugin({
    key: readOnlyKey,
    filterTransaction: (tr) =>
      !isReadOnly() ||
      !tr.docChanged ||
      isSyncOrigin(tr) ||
      // The binding's own imports, even where no dispatch-site tagger
      // stamped them (local undo is clamped separately, in collab-ui).
      tr.getMeta(loroSyncPluginKey) !== undefined,
    props: { editable: () => !isReadOnly() },
  });
}

/** Re-evaluate the editable prop after an access change. */
export function refreshEditable(view: EditorView | null): void {
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(readOnlyKey, true));
}
