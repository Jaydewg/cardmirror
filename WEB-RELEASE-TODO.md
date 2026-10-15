# Web release TODO

Things to fix before this branch's work ships in the web edition. Each entry
was found while building desktop features. It's primarily to blame for limited access on web, including things like Chrome's File System Access API, or rather Firefox's and Safari's lack of one thereove.

## Autosave / save on close (`.docx` autosave work)

- **Close-save can be overwritten by a stalled autosave.**
  - **What happens:** `saveOnCloseIfAutosaving` in `src/editor/index.ts` waits at most `CLOSE_SAVE_SETTLE_MS` (3s) for an in-flight autosave, then saves anyway.
  - **Why it's fine on desktop:** writes to one path are queued in order (`chainDocWrite` in `apps/desktop/src/doc-writes.ts`).
  - **Why it's not on the web:** `BrowserHost.saveExisting` has no such queue to save it. A stalled autosave that finishes *after* the close-save leaves the file with the older autosave bytes, messing it up.
  - **Fix:** queue `saveExisting` calls per handle in `src/editor/host/browser-host.ts`, or make the close-save supersede the in-flight write.
- **Closing a tab doesn't save on close.**
  - **What happens:** save-on-close hooks into the Electron close request, close-to-home, and three-pane pane close/quit. A browser tab close doesn't trigger any one of these, and `beforeunload` can't wait for an async save.
  - **Why it matters more now:** `.docx` autosave waits for a 30s idle window. The flush on `visibilitychange` → hidden starts a save that a closing tab probably won't let finish. So more unsaved `.docx` work rests on the crash-recovery journal than with `.cmir`'s 5s debounce.
  - **Fix:** decide on a more robust web policy, for example a shorter `.docx` idle window on web, or a `beforeunload` prompt when a `.docx` has unsaved edits.
