/**
 * Pin the app's userData folder to the one every earlier release used.
 *
 * Electron names userData after the packaged package.json. electron-builder
 * keeps `productName` inside the `build` block, so the packaged package.json
 * has none, and Electron falls back to `name`: "@cardmirror/desktop". Every
 * release so far (standard and Lite, on every OS, packaged or `electron .`)
 * has therefore kept its settings, plugins, journals, history and the Fast
 * Paste discovery file in:
 *
 *   Windows  %APPDATA%\@cardmirror\desktop
 *   macOS    ~/Library/Application Support/@cardmirror/desktop
 *   Linux    ~/.config/@cardmirror/desktop
 *
 * Pinning it here means a future product name or package name change (the
 * CardReflex rebrand, brand/README.md) can never move users to a new, empty
 * folder. The path is an internal identifier like appId: it never changes
 * with the brand. The Microsoft Store build reaches the same real %APPDATA%
 * folder because its manifest turns file-system write virtualization off.
 *
 * Imported FIRST by main.ts for its side effect, so the path is set before
 * any module (or crashReporter) reads it.
 */
import { app } from 'electron';
import * as path from 'node:path';

/** The userData path segments (under appData) every release has used. */
export const USER_DATA_DIR_SEGMENTS = ['@cardmirror', 'desktop'] as const;

app.setPath('userData', path.join(app.getPath('appData'), ...USER_DATA_DIR_SEGMENTS));
