/**
 * File → Open Recent / Rejoin Recent Session (desktop, macOS menu bar).
 *
 * The native menu lives in the main process, but the recents live in the
 * renderer (localStorage) and the session records in IndexedDB — the same
 * two sources the home screen's Recent and Sessions sections render. The
 * renderer builds this compact payload from them and pushes it to main
 * whenever either store changes; main rebuilds the two submenus from it
 * and sends a pick back as a `menu-open-recent` event. Pure: no DOM, no
 * host — so the mirror is unit-testable and main trusts only strings.
 */

import type { RecentFile } from './recents-store.js';
import type { PersistedSessionRecord } from './collab/collab-store.js';
import type { SessionRole } from './collab/session-role.js';

export interface MenuRecentFile {
  /** Menu label: the filename. */
  label: string;
  /** Absolute path (the recents store's handle) — the pick's identity. */
  handle: string;
}

export interface MenuRecentSession {
  /** Menu label: the doc title with the role spelled out. */
  label: string;
  roomId: string;
  role: SessionRole;
}

export interface MenuRecentsPayload {
  files: MenuRecentFile[];
  sessions: MenuRecentSession[];
}

/** Both menus stay short, like the home screen's lists. */
export const MENU_RECENTS_MAX = 10;

export function roleWord(role: SessionRole): string {
  return role === 'host' ? 'hosting' : role === 'spectator' ? 'watching' : 'joined';
}

/** Mirror of the home screen: reopenable recents (a path handle — web
 *  entries have none and never reach a desktop menu anyway) and the saved
 *  session records, newest first as the store lists them. `records` is
 *  null when the collab gate is closed, which hides the session list. */
export function buildMenuRecents(
  recents: readonly RecentFile[],
  records: readonly PersistedSessionRecord[] | null,
): MenuRecentsPayload {
  const files: MenuRecentFile[] = [];
  for (const r of recents) {
    if (!r.handle || !r.filename) continue;
    files.push({ label: r.filename, handle: r.handle });
    if (files.length >= MENU_RECENTS_MAX) break;
  }
  const sessions: MenuRecentSession[] = [];
  for (const s of records ?? []) {
    sessions.push({
      label: `${s.docTitle || 'Collaboration session'} — ${roleWord(s.role)}`,
      roomId: s.roomId,
      role: s.role,
    });
    if (sessions.length >= MENU_RECENTS_MAX) break;
  }
  return { files, sessions };
}
