/**
 * Status-bar update chip — install-on-confirm (adopted 2026-07-16,
 * modeled on ebb's update UX): auto-updates never dialog. The desktop
 * main process stages downloads silently and reports chip state; this
 * module renders the chip and forwards clicks. Three states:
 *
 *   'downloading' — found and being staged; shows the percent so the
 *                 home screen and status bar say something between
 *                 "found" and "ready" (issue #104). Click = nothing.
 *   'ready'     — the update is downloaded and staged (Windows/Linux).
 *                 Click = restart now and install. Users who never
 *                 click still get it on next quit (install-on-quit
 *                 stays on as the fallback).
 *   'available' — detected but not stageable (macOS until the swap
 *                 updater lands). Click = open the release page.
 *
 * Pure DOM + host-interface module so the chip logic is testable
 * outside the index.ts app shell.
 */

export type UpdateChipState =
  | { state: 'available' | 'ready'; version: string }
  | { state: 'downloading'; version: string; percent: number };

export interface UpdateChipHost {
  getUpdateChipState(): Promise<UpdateChipState | null>;
  updateChipAction(): Promise<void>;
  onUpdateChip(handler: (payload: UpdateChipState | null) => void): () => void;
}

/** Render one chip state into the button. Exported for tests. */
export function renderUpdateChip(el: HTMLButtonElement, s: UpdateChipState | null): void {
  if (!s) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (s.state === 'ready') {
    el.textContent = `Update ${s.version} ready — restart to install`;
    el.title = 'Restart CardMirror now to finish installing the update';
  } else if (s.state === 'downloading') {
    el.textContent = `Downloading update ${s.version}… ${s.percent}%`;
    el.title = 'The update is downloading in the background; keep working';
  } else {
    el.textContent = `Update ${s.version} available`;
    el.title = 'Open the release page to download the update';
  }
}

/** Wire the chip: initial state pull (late-opened windows), live
 *  subscription, click → the main process picks the action. */
export function initUpdateChip(el: HTMLButtonElement, host: UpdateChipHost): () => void {
  el.addEventListener('click', () => {
    void host.updateChipAction().catch((err) => {
      console.warn('Update chip action failed:', err);
    });
  });
  const unsubscribe = host.onUpdateChip((s) => renderUpdateChip(el, s));
  void host
    .getUpdateChipState()
    .then((s) => renderUpdateChip(el, s))
    .catch(() => {});
  return unsubscribe;
}
