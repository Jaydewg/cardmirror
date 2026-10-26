/**
 * The Join session dialog: a box to paste a share code or invite link into
 * — focused, so a new join is paste-and-Enter with no click first — and,
 * below it, the sessions this user can get back into, laid out like the
 * home screen's Sessions list.
 *
 * Two sources, merged by room:
 *  - SAVED sessions (collab-store session records): a copy kept on this
 *    machine, from closing with "keep", a crash, a full room or a failed
 *    resume. Rejoining resumes it, flushing any edits that never synced.
 *  - LEFT sessions (recent rooms): rooms the user left whose credentials
 *    are remembered for a week. Rejoining is a fresh join, while the room
 *    is still alive on the relay.
 * Rooms already live in this window are left out. Either kind rejoins
 * through joinSessionWithCode, which resumes when a record exists.
 */

import { relativeTime } from '../disk-conflict.js';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { isBackdropClick } from '../backdrop-click.js';
import { installModalKeys, captureFocusForDialog, armDialogFocus } from '../text-prompt.js';
import {
  listSessionRecords,
  listRecentRooms,
  deleteRecentRoom,
  type PersistedSessionRecord,
  type RecentRoomRecord,
} from './collab-store.js';
import type { SessionRole } from './session-role.js';

export interface RejoinCandidate {
  roomId: string;
  shareCode: string;
  guestPass: string | null;
  role: SessionRole;
  title: string;
  /** 'saved': a local copy to resume; 'left': a remembered room to rejoin. */
  kind: 'saved' | 'left';
  at: number;
}

export type RejoinPick =
  | { kind: 'rejoin'; shareCode: string; guestPass: string | null }
  /** What was typed or pasted into the box: a share code or an invite link. */
  | { kind: 'code'; text: string };

/** Saved sessions first-class (they hold local edits), then left rooms not
 *  already covered by a saved one; newest first; live rooms dropped. */
export function buildRejoinCandidates(
  records: readonly PersistedSessionRecord[],
  recents: readonly RecentRoomRecord[],
  isLive: (roomId: string) => boolean,
): RejoinCandidate[] {
  const out: RejoinCandidate[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (isLive(r.roomId)) continue;
    seen.add(r.roomId);
    const recent = recents.find((x) => x.roomId === r.roomId);
    out.push({
      roomId: r.roomId,
      shareCode: r.shareCode,
      guestPass: r.guestPass ?? recent?.guestPass ?? null,
      role: r.role,
      title: r.docTitle || recent?.docTitle || '',
      kind: 'saved',
      at: r.updatedAt,
    });
  }
  for (const r of recents) {
    if (seen.has(r.roomId) || isLive(r.roomId)) continue;
    out.push({
      roomId: r.roomId,
      shareCode: r.shareCode,
      guestPass: r.guestPass ?? null,
      role: r.role,
      title: r.docTitle,
      kind: 'left',
      at: r.leftAt ?? r.lastActiveAt,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function loadRejoinCandidates(isLive: (roomId: string) => boolean): Promise<RejoinCandidate[]> {
  const [records, recents] = await Promise.all([listSessionRecords(), listRecentRooms()]);
  return buildRejoinCandidates(records, recents, isLive);
}

function describe(c: RejoinCandidate): string {
  // "last here", not "left": a crash records no leave time.
  return c.kind === 'saved' ? `saved ${relativeTime(c.at)}` : `last here ${relativeTime(c.at)}`;
}

/** The dialog. Resolves with a session to rejoin, the text entered in the
 *  box, or null on cancel. With no candidates it is just the box. */
export function pickSessionToJoin(candidates: RejoinCandidate[]): Promise<RejoinPick | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-rejoin-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'Join or rejoin a session';
    dialog.appendChild(header);

    let settled = false;
    let removeKeys = (): void => {};
    const finish = (value: RejoinPick | null): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve(value);
    };

    // ── Paste box: first, and focused ─────────────────────────────────
    const entry = document.createElement('div');
    entry.className = 'pmd-rejoin-entry';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pmd-text-prompt-input pmd-rejoin-input';
    input.placeholder = 'Paste a share code or invite link';
    input.setAttribute('aria-label', 'Share code or invite link');
    input.autocomplete = 'off';
    input.spellcheck = false;
    entry.appendChild(input);
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'pmd-text-prompt-ok pmd-rejoin-join';
    join.textContent = 'Join';
    const submit = (): void => {
      const text = input.value.trim();
      if (text) finish({ kind: 'code', text });
      else input.focus();
    };
    join.addEventListener('click', submit);
    entry.appendChild(join);
    dialog.appendChild(entry);

    // ── Sessions to get back into ─────────────────────────────────────
    const section = document.createElement('div');
    section.className = 'pmd-rejoin-section';
    const heading = document.createElement('div');
    heading.className = 'pmd-rejoin-heading';
    heading.textContent = 'Recent sessions';
    section.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'pmd-home-sessions pmd-rejoin-list';
    list.setAttribute('role', 'list');
    section.appendChild(list);
    dialog.appendChild(section);

    const renderRows = (): void => {
      list.innerHTML = '';
      section.hidden = candidates.length === 0;
      for (const c of candidates) {
        // Same row as the home screen's Sessions list (same classes).
        const wrap = document.createElement('div');
        wrap.className = 'pmd-home-session pmd-rejoin-row';
        wrap.setAttribute('role', 'listitem');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pmd-home-session-open pmd-rejoin-btn';
        row.title = c.kind === 'saved' ? 'Rejoin with your saved copy (syncs your edits)' : 'Rejoin this session';
        const chip = document.createElement('span');
        chip.className = 'pmd-home-recent-format pmd-home-session-role';
        chip.textContent = c.role === 'host' ? 'HOST' : c.role === 'spectator' ? 'WATCHING' : 'JOINED';
        row.appendChild(chip);
        const name = document.createElement('span');
        name.className = 'pmd-home-recent-name';
        name.textContent = c.title || 'Collaboration session';
        name.title = name.textContent;
        row.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'pmd-home-recent-path';
        meta.textContent = describe(c);
        row.appendChild(meta);
        row.addEventListener('click', () =>
          finish({ kind: 'rejoin', shareCode: c.shareCode, guestPass: c.guestPass }),
        );
        wrap.appendChild(row);

        // Forgetting a LEFT room only drops its remembered credentials.
        // Saved copies are managed from the home screen's Sessions list,
        // whose ✕ also offers a host End.
        if (c.kind === 'left') {
          const forget = document.createElement('button');
          forget.type = 'button';
          forget.className = 'pmd-home-session-forget pmd-rejoin-forget';
          forget.textContent = '✕';
          forget.title = 'Forget this session';
          forget.setAttribute('aria-label', `Forget ${c.title || 'this session'}`);
          forget.addEventListener('click', () => {
            void deleteRecentRoom(c.roomId).catch(() => {});
            candidates = candidates.filter((x) => x.roomId !== c.roomId);
            renderRows();
            input.focus();
          });
          wrap.appendChild(forget);
        } else {
          // Same width as a ✕, so every row's time lines up.
          const spacer = document.createElement('span');
          spacer.className = 'pmd-home-session-forget pmd-rejoin-spacer';
          spacer.textContent = '✕';
          spacer.setAttribute('aria-hidden', 'true');
          wrap.appendChild(spacer);
        }
        list.appendChild(wrap);
      }
    };
    renderRows();

    const footer = document.createElement('div');
    footer.className = 'pmd-rejoin-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    footer.appendChild(cancel);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) finish(null);
    });
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        finish(null);
        return true;
      }
      // Enter in the box joins; on a row or a button it activates that.
      if (e.key === 'Enter' && document.activeElement === input) {
        submit();
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', 'Join or rejoin a session');
    // The box takes focus: paste, Enter. (After the dialog's own focus, as
    // the text prompt does.)
    setTimeout(() => input.focus(), 0);
  });
}
