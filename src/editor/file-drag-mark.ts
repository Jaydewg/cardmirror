/**
 * The app mark in the status bar's bottom-right corner: a drag
 * handle for the focused document's file. Drag it into Slack, Mail,
 * Teams, Finder or Explorer and the OS receives the saved file — the
 * cross-platform counterpart of the macOS title-bar proxy icon (which
 * Windows and Linux lack). A click reveals the file in the file manager.
 *
 * Desktop only: the web build has no file paths, so the mark stays
 * hidden there (and on a packaged shell too old to start a native drag).
 * Dimmed while the focused doc has no file on disk — untitled, a
 * recovered draft, the home screen — because what travels is the file
 * as saved.
 *
 * The drag itself is Electron's `webContents.startDrag`, which must be
 * triggered from the renderer's own `dragstart` (see `host:drag-file-out`
 * in main.ts); the mark image doubles as the drag icon (Windows insists
 * on one).
 */

/** The status-bar glyph and the drag icon: the active brand's small mark,
 *  48 px, transparent ground (brand/<id>/generated/file-mark-48.png, via
 *  scripts/apply-brand.mjs). */
import { BRAND, FILE_MARK_DATA_URL } from '../brand-build.js';

export { FILE_MARK_DATA_URL };

export interface FileDragHost {
  /** False on a packaged shell whose preload predates the drag surface. */
  canDragFileOut(): boolean;
  dragFileOut(path: string, iconDataUrl: string): void;
  showItemInFolder?(path: string): Promise<void>;
}

export interface FileDragMarkState {
  hidden: boolean;
  /** Shown but dimmed and inert: no file on disk to hand out. */
  inert: boolean;
  title: string;
}

export const DRAG_TITLE = 'Drag to share this file · Click to show it in its folder';
export const INERT_TITLE = 'Save the document to share its file from here';

/** Pure: what the mark should show for a host + the focused doc's handle
 *  (the absolute path on desktop; null when there is no file). */
export function fileDragMarkState(host: FileDragHost | null, handle: unknown): FileDragMarkState {
  if (!host || !host.canDragFileOut()) return { hidden: true, inert: true, title: '' };
  const path = typeof handle === 'string' && handle.length > 0 ? handle : null;
  return path
    ? { hidden: false, inert: false, title: DRAG_TITLE }
    : { hidden: false, inert: true, title: INERT_TITLE };
}

/** Wire the mark element. Returns the sync function the window-title
 *  path calls with the focused doc's handle on every identity change. */
export function installFileDragMark(
  el: HTMLElement,
  getHost: () => FileDragHost | null,
): (handle: unknown) => void {
  let currentPath: string | null = null;
  el.style.backgroundImage = `url("${FILE_MARK_DATA_URL}")`;
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    // Electron: cancel the DOM drag and start the native one from here.
    e.preventDefault();
    const host = getHost();
    if (!host || !currentPath) return;
    host.dragFileOut(currentPath, FILE_MARK_DATA_URL);
  });
  el.addEventListener('click', () => {
    const host = getHost();
    if (!host || !currentPath) return;
    void host.showItemInFolder?.(currentPath);
  });
  return (handle: unknown): void => {
    const state = fileDragMarkState(getHost(), handle);
    currentPath = state.hidden || state.inert ? null : (handle as string);
    el.hidden = state.hidden;
    if (state.inert) el.dataset['inert'] = 'true';
    else delete el.dataset['inert'];
    el.title = state.title;
    el.setAttribute('aria-label', state.title || `${BRAND.productName}`);
    el.setAttribute('aria-disabled', state.inert ? 'true' : 'false');
  };
}
