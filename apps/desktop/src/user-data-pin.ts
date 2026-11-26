/**
 * Pin the packaged app's userData folder to its pre-rebrand name.
 *
 * Electron derives userData from the product name, so renaming the product
 * (CardMirror → CardReflex, brand/README.md) would otherwise move every
 * user's settings, plugins, journals, history and the Fast Paste discovery
 * file to a new, empty folder, and Verbatim would stop finding the bridge.
 * The folder name is an internal identifier like appId: it never changes
 * with the brand.
 *
 * Imported FIRST by main.ts for its side effect, so the path is set before
 * any module (or crashReporter) reads it. Dev runs (`electron .`) keep
 * Electron's default, so development never touches real user data. The
 * Microsoft Store build resolves to the same real %APPDATA% folder because
 * its manifest turns file-system write virtualization off.
 */
import { app } from 'electron';
import * as path from 'node:path';
import { LITE_BUILD } from './lite-build.js';

/** The userData folder names every release has used. */
export const USER_DATA_DIR_NAME = LITE_BUILD ? 'CardMirror Lite' : 'CardMirror';

if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR_NAME));
}
