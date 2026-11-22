/**
 * CardMirror PDF — the companion app's Electron entry. A small window
 * says it's running; the work happens in `CompanionService`, which this
 * file wires to the desktop: native dialogs, Chromium's printToPDF, the
 * file system, and CardMirror (over the cardmirror-bridge handshake).
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, readlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PageSize } from '../../src/protocol.js';
import { announce, bridgeDirPath, cardmirrorRequest, findCardmirror, retractSync, type Endpoint } from './bridge.js';
import { CompanionService, serve, type CompanionHost } from './service.js';

let lastDir: string | null = null;
let statusWindow: BrowserWindow | null = null;

function rememberDir(file: string): void {
  lastDir = path.dirname(file);
}

/** Bring the app forward so its dialog isn't hidden behind CardMirror,
 *  and parent dialogs to the status window when it's open. */
function saveDialog(opts: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  app.focus({ steal: true });
  const parent = statusWindow && !statusWindow.isDestroyed() ? statusWindow : null;
  return parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts);
}

function openDialog(opts: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  app.focus({ steal: true });
  const parent = statusWindow && !statusWindow.isDestroyed() ? statusWindow : null;
  return parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts);
}

async function renderPdf(html: string, pageSize: PageSize): Promise<Uint8Array> {
  const tmp = path.join(os.tmpdir(), `cardmirror-pdf-${randomBytes(8).toString('hex')}.html`);
  await fs.writeFile(tmp, html, { mode: 0o600 });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false },
  });
  // The page is self-contained: nothing may leave it.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) =>
    cb({ cancel: true }),
  );
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize,
    });
    return new Uint8Array(pdf);
  } finally {
    win.destroy();
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Open a file in the running CardMirror. On Linux, relaunch CardMirror's
 *  own command line with the file: its single-instance lock hands the path
 *  to the running app. Elsewhere, ask the OS (CardMirror owns .cmir). */
async function openInCardmirror(file: string, ep: Endpoint | null): Promise<boolean> {
  if (process.platform === 'linux') {
    if (!ep?.pid) return false;
    try {
      const argv = readFileSync(`/proc/${ep.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const cwd = readlinkSync(`/proc/${ep.pid}/cwd`);
      if (!argv.length) return false;
      const env = { ...process.env };
      delete env['ELECTRON_RUN_AS_NODE'];
      const child = spawn(argv[0]!, [...argv.slice(1), file], { cwd, env, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  return (await shell.openPath(file)) === '';
}

function statusPage(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>CardMirror PDF</title>
<style>
:root { color-scheme: light dark; }
body { font: 14px/1.4 system-ui, sans-serif; margin: 20px; }
h1 { font-size: 16px; margin: 0 0 8px; }
p { margin: 0 0 8px; opacity: .8; }
</style>
<h1>CardMirror PDF is running</h1>
<p>Use <b>Export to PDF</b> and <b>Import PDF</b> from CardMirror's command palette.</p>
<p>Keep this window open while you do. Closing it stops CardMirror PDF.</p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  const dir = bridgeDirPath(app.getPath('appData'));
  const token = randomBytes(24).toString('base64url');
  let endpoint: Endpoint | null = null;

  const host: CompanionHost = {
    appVersion: app.getVersion(),
    async chooseSavePdf(name) {
      const r = await saveDialog({
        title: 'Export to PDF',
        defaultPath: path.join(lastDir ?? app.getPath('documents'), name),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return null;
      rememberDir(r.filePath);
      return r.filePath.toLowerCase().endsWith('.pdf') ? r.filePath : `${r.filePath}.pdf`;
    },
    async chooseOpenPdf() {
      const r = await openDialog({
        title: 'Import PDF',
        defaultPath: lastDir ?? app.getPath('documents'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile'],
      });
      const file = r.canceled ? undefined : r.filePaths[0];
      if (!file) return null;
      rememberDir(file);
      return file;
    },
    async chooseSaveCmir(defaultPath) {
      const r = await saveDialog({
        title: 'Save the imported document',
        defaultPath,
        filters: [{ name: 'CardMirror document', extensions: ['cmir'] }],
      });
      if (r.canceled || !r.filePath) return null;
      return r.filePath.toLowerCase().endsWith('.cmir') ? r.filePath : `${r.filePath}.cmir`;
    },
    renderPdf,
    readFile: async (f) => new Uint8Array(await fs.readFile(f)),
    writeFile: (f, b) => fs.writeFile(f, b),
    async openInCardmirror(file) {
      return openInCardmirror(file, endpoint ?? (await findCardmirror(dir)));
    },
    async findCardmirror() {
      endpoint = await findCardmirror(dir);
      return endpoint;
    },
    request: (ep, method, route, body) => cardmirrorRequest(ep, method, route, body),
  };

  const service = new CompanionService(host, token);
  const { server, port } = await serve(service);
  await announce(dir, { appVersion: app.getVersion(), port, token });

  const cleanup = (): void => retractSync(dir);
  app.on('will-quit', () => {
    cleanup();
    server.close();
  });
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());

  statusWindow = new BrowserWindow({
    width: 440,
    height: 190,
    resizable: false,
    title: 'CardMirror PDF',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false },
  });
  statusWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  statusWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await statusWindow.loadURL(statusPage());
  app.on('second-instance', () => {
    if (statusWindow && !statusWindow.isDestroyed()) {
      if (statusWindow.isMinimized()) statusWindow.restore();
      statusWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
}

main().catch((err: unknown) => {
  console.error('[cardmirror-pdf]', err);
  app.exit(1);
});
