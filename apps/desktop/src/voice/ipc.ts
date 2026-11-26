/**
 * Voice IPC wiring (voice v2). One recognition session at a time, owned
 * by the window that started it; that window receives `voice:event` /
 * `voice:level`. Audio flows renderer→main as raw PCM over a
 * fire-and-forget channel and is proxied to a forked worker process
 * that owns the recognizer (see voice/worker.ts).
 *
 * Models are a one-time download into userData (Parakeet TDT 0.6B v2
 * int8, ~640 MB, plus the 2 MB Silero VAD), so the installer stays small
 * for the many users who never enable voice. The runtime itself
 * (sherpa-onnx-node, a N-API addon) ships in the app.
 */
import { app, ipcMain, systemPreferences } from 'electron';
import { LITE_BUILD } from '../lite-build.js';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceProfile, VoiceStartOptions, VoiceStartResult, WorkerInbound } from './types';
import {
  ENGINE_DOWNLOAD_MB,
  SHERPA_VERSION,
  enginePackages,
  enginePresentAt,
  packumentUrl,
  parsePackument,
  verifyIntegrity,
} from './runtime.js';
import { BRAND } from '../brand-build.js';

let worker: ChildProcess | null = null;
let ownerWebContentsId: number | null = null;
let ownerCleanup: (() => void) | null = null;

export const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const MODEL_ARCHIVE = `${MODEL_DIR_NAME}.tar.bz2`;
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE}`;
const VAD_FILE = 'silero_vad.onnx';
const VAD_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${VAD_FILE}`;
/** Approximate download size, for the prompt. */
export const MODEL_DOWNLOAD_MB = 640;

function modelsRoot(): string {
  return process.env.CARDMIRROR_VOICE_DIR || path.join(app.getPath('userData'), 'voice-models');
}
function modelDir(): string {
  return path.join(modelsRoot(), MODEL_DIR_NAME);
}
function vadPath(): string {
  return path.join(modelsRoot(), VAD_FILE);
}
function modelPresent(): boolean {
  return ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].every((f) =>
    fs.existsSync(path.join(modelDir(), f)),
  ) && fs.existsSync(vadPath());
}

/** The speech engine (see runtime.ts) is a first-use download as well:
 *  userData/voice-engine/<version>/node_modules/{sherpa-onnx-node,
 *  sherpa-onnx-<os>-<arch>}. Versioned so an engine bump downloads
 *  fresh and the old one is swept once the new one is complete.
 *  CARDMIRROR_VOICE_ENGINE_DIR overrides the root (dev/diagnosis). */
function engineRoot(): string {
  return process.env.CARDMIRROR_VOICE_ENGINE_DIR || path.join(app.getPath('userData'), 'voice-engine');
}
function engineNodeModules(): string {
  return path.join(engineRoot(), SHERPA_VERSION, 'node_modules');
}
function enginePresent(): boolean {
  return enginePresentAt(engineNodeModules());
}
/** Everything the worker needs on disk. */
function voiceReady(): boolean {
  return enginePresent() && modelPresent();
}
/** What a download would still have to fetch. */
function pendingDownloadMB(): number {
  return (enginePresent() ? 0 : ENGINE_DOWNLOAD_MB) + (modelPresent() ? 0 : MODEL_DOWNLOAD_MB);
}

/** v1 left Vosk models (up to 1.8 GB) and a downloaded Node runtime in
 *  userData. Reclaim them once; the new model replaces both. */
function cleanupLegacyVoiceAssets(): void {
  try {
    const root = path.join(app.getPath('userData'), 'voice-models');
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('vosk-model-')) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
    }
    fs.rmSync(path.join(app.getPath('userData'), 'voice-runtime'), { recursive: true, force: true });
  } catch (err) {
    console.warn('voice: legacy asset cleanup failed', err);
  }
}

/** The bundled worker. In a packaged build the worker is forked under a
 *  plain Node (or Electron-as-Node) which has no asar support, so it
 *  cannot load from inside app.asar — electron-builder's `asarUnpack`
 *  keeps dist/voice/** on disk under app.asar.unpacked; rewrite the
 *  path there. (The speech engine itself lives in userData, outside the
 *  asar, and reaches the worker through NODE_PATH.) In dev __dirname is
 *  an ordinary directory and the replace is a no-op. */
function resolveWorkerPath(): string {
  const p = path.join(__dirname, 'worker.cjs');
  return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

/** The worker runs under Electron-as-Node by default (N-API addons load
 *  fine there). CARDMIRROR_NODE points at a real Node binary for
 *  diagnosis. */
function resolveNodeBinary(): string | null {
  const env = process.env.CARDMIRROR_NODE;
  return env && fs.existsSync(env) ? env : null;
}

function stopSession(): void {
  if (worker) console.log('voice: session stopped');
  worker?.kill();
  worker = null;
  ownerWebContentsId = null;
  ownerCleanup?.();
  ownerCleanup = null;
}

let downloadInFlight = false;

/** Stream `url` to `file` under `root`, reporting percent to `sender`. */
async function downloadFile(url: string, file: string, sender: Electron.WebContents, label: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let received = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    await new Promise<void>((resolve, reject) => out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())));
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (pct !== lastPct && !sender.isDestroyed()) {
      lastPct = pct;
      sender.send('voice:download-progress', { model: label, pct, receivedMB: Math.round(received / 1e6) });
    }
  }
  await new Promise<void>((resolve) => out.end(() => resolve()));
}

/** bsdtar (macOS, Linux, Windows 10+) autodetects bzip2 and gzip. */
async function extractArchive(archive: string, dir: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) =>
    execFile('tar', ['-xf', archive, '-C', dir], (err) => (err ? reject(err) : resolve())),
  );
}

/** Fetch the two engine packages from the npm registry: per package,
 *  the version document → its tarball, sha512-checked against the
 *  document, extracted to a staging directory and moved into place
 *  only when complete — a half-written package is never "present". */
async function downloadEngine(sender: Electron.WebContents): Promise<void> {
  const nm = engineNodeModules();
  fs.mkdirSync(nm, { recursive: true });
  for (const name of enginePackages()) {
    const dest = path.join(nm, name);
    if (fs.existsSync(path.join(dest, 'package.json'))) continue;
    const res = await fetch(packumentUrl(name), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`engine registry HTTP ${res.status} (${name})`);
    const dist = parsePackument(await res.json());
    const tgz = path.join(nm, `${name}.tgz`);
    const stage = path.join(nm, `${name}.extract`);
    try {
      await downloadFile(dist.tarball, tgz, sender, 'engine');
      await verifyIntegrity(tgz, dist.integrity);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      await extractArchive(tgz, stage); // npm tarballs unpack to package/
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(path.join(stage, 'package'), dest);
    } finally {
      fs.rmSync(tgz, { force: true });
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  // Older engine versions are dead weight once this one is complete.
  for (const entry of fs.readdirSync(engineRoot())) {
    if (entry !== SHERPA_VERSION) fs.rmSync(path.join(engineRoot(), entry), { recursive: true, force: true });
  }
}

async function downloadModelFiles(sender: Electron.WebContents): Promise<void> {
  const root = modelsRoot();
  const archive = path.join(root, MODEL_ARCHIVE);
  try {
    fs.mkdirSync(root, { recursive: true });
    await downloadFile(VAD_URL, vadPath(), sender, 'vad');
    await downloadFile(MODEL_URL, archive, sender, 'model');
    if (!sender.isDestroyed()) sender.send('voice:download-progress', { model: 'model', pct: 100, extracting: true });
    await extractArchive(archive, root);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

/** Engine first (small, and nothing works without it), then the model. */
async function downloadModel(sender: Electron.WebContents): Promise<{ ok: boolean; error?: string }> {
  if (voiceReady()) return { ok: true };
  if (downloadInFlight) return { ok: false, error: 'download-in-progress' };
  downloadInFlight = true;
  try {
    if (!enginePresent()) await downloadEngine(sender);
    if (!modelPresent()) await downloadModelFiles(sender);
    return voiceReady() ? { ok: true } : { ok: false, error: 'extract-failed' };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    downloadInFlight = false;
  }
}

export function registerVoiceIpc(): void {
  cleanupLegacyVoiceAssets();

  ipcMain.handle('host:voice-start', async (event, opts: VoiceStartOptions = {}): Promise<VoiceStartResult> => {
    const sender = event.sender;
    if (worker && ownerWebContentsId !== sender.id) return { ok: false, error: 'voice-in-use' };
    // macOS: getUserMedia can "succeed" with a silent track until the
    // OS-level microphone permission is granted. Ask first.
    if (process.platform === 'darwin') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) return { ok: false, error: 'voice-mic-denied' };
      } catch {
        return { ok: false, error: 'voice-mic-denied' };
      }
    }
    if (worker) stopSession();
    if (!voiceReady()) return { ok: false, error: 'voice-model-missing' };
    console.log(`voice: starting worker (${resolveWorkerPath()})`);

    const nodeBin = resolveNodeBinary();
    // The downloaded engine resolves like an installed package: NODE_PATH
    // is consulted after the usual node_modules walk, so a dev checkout
    // (devDependency copy) and a packaged build (download only) both work.
    const env = {
      ...process.env,
      NODE_PATH: [engineNodeModules(), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    };
    const child = fork(resolveWorkerPath(), [], {
      ...(nodeBin ? { execPath: nodeBin, env } : { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }),
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    worker = child;
    ownerWebContentsId = sender.id;

    const started = await new Promise<VoiceStartResult>((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, error: 'voice-worker-timeout' }), 90_000);
      child.once('message', (m: { type: string; modelLoadMs?: number; error?: string }) => {
        clearTimeout(timeout);
        if (m.type === 'started') resolve({ ok: true, modelLoadMs: m.modelLoadMs });
        else resolve({ ok: false, error: m.error ?? 'voice-worker-error' });
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'voice-worker-died' });
      });
      const start: WorkerInbound = {
        type: 'start',
        modelDir: modelDir(),
        vadModelPath: vadPath(),
        autoSleepSeconds: opts.autoSleepSeconds,
        profile: opts.profile ?? null,
      };
      child.send(start);
    });
    if (!started.ok) {
      console.error(`voice: worker failed to start: ${started.error}`);
      if (worker === child) stopSession();
      else child.kill();
      return started;
    }
    console.log(`voice: worker ready in ${started.modelLoadMs ?? '?'} ms`);

    child.on('message', (m: { type: string; event?: unknown; level?: unknown; error?: string }) => {
      if (sender.isDestroyed()) return;
      if (m.type === 'event') sender.send('voice:event', m.event);
      else if (m.type === 'level') sender.send('voice:level', m.level);
      else if (m.type === 'error') console.error('voice: worker error', m.error);
    });
    child.on('exit', (code) => {
      if (worker === child) {
        console.error(`voice: worker exited (code ${code})`);
        if (!sender.isDestroyed()) sender.send('voice:event', { kind: 'ended', reason: `recognizer exited (${code ?? '?'})` });
        stopSession();
      }
    });
    const onGone = (): void => {
      if (ownerWebContentsId === sender.id) stopSession();
    };
    sender.once('destroyed', onGone);
    sender.once('did-start-navigation', onGone);
    sender.once('render-process-gone', onGone);
    ownerCleanup = () => {
      sender.removeListener('destroyed', onGone);
      sender.removeListener('did-start-navigation', onGone);
      sender.removeListener('render-process-gone', onGone);
    };
    return started;
  });

  ipcMain.handle('host:voice-stop', async (event) => {
    if (ownerWebContentsId === event.sender.id) stopSession();
  });

  // Fire-and-forget PCM stream — `send`, not `invoke`.
  ipcMain.on('host:voice-audio', (event, chunk: ArrayBuffer) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    if (!(chunk instanceof ArrayBuffer)) return;
    try {
      worker.send({ type: 'audio', chunk } satisfies WorkerInbound);
    } catch {
      /* worker exited between the check and the post */
    }
  });

  ipcMain.handle('host:voice-dictation', async (event, on: boolean, opts?: { autoEndAfterMs?: number }) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    const autoEndAfterMs = typeof opts?.autoEndAfterMs === 'number' && opts.autoEndAfterMs > 0 ? opts.autoEndAfterMs : undefined;
    worker.send({ type: 'dictation', on: !!on, ...(autoEndAfterMs ? { autoEndAfterMs } : {}) } satisfies WorkerInbound);
  });

  ipcMain.handle('host:voice-profile', async (event, profile: VoiceProfile | null) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    worker.send({ type: 'profile', profile: profile ?? null } satisfies WorkerInbound);
  });

  ipcMain.handle('host:voice-calibrating', async (event, on: boolean) => {
    if (ownerWebContentsId !== event.sender.id || !worker) return;
    worker.send({ type: 'calibrating', on: !!on } satisfies WorkerInbound);
  });

  ipcMain.handle('host:voice-model-info', async () => ({
    present: voiceReady(),
    downloading: downloadInFlight,
    sizeMB: pendingDownloadMB(),
  }));

  ipcMain.handle('host:voice-download-model', async (event) =>
    LITE_BUILD ? { ok: false, error: `Model downloads are disabled in ${BRAND.liteName}.` } : downloadModel(event.sender),
  );

  ipcMain.handle('host:voice-delete-model', async () => {
    if (downloadInFlight) return { ok: false, error: 'A download is in progress.' };
    try {
      fs.rmSync(modelDir(), { recursive: true, force: true });
      fs.rmSync(vadPath(), { force: true });
      fs.rmSync(engineRoot(), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Native clipboard ops for the voice dispatcher — the same paths as
  // Mod-C/X/V, so ProseMirror slice semantics are inherited.
  ipcMain.handle('host:voice-clipboard', async (event, op: 'copy' | 'cut' | 'paste') => {
    if (op === 'copy') event.sender.copy();
    else if (op === 'cut') event.sender.cut();
    else if (op === 'paste') event.sender.paste();
  });
}
