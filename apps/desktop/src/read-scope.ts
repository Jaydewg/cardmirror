/**
 * Read-scope registry for `host:read-file-at-path`.
 *
 * That IPC reads any `.cmir`/`.docx` by absolute path with no dialog — the
 * primitive behind "open recent" and the file-search open path, but also the
 * one a runaway plugin would use to sweep every debate file on disk (review
 * item, PR #25). Main now only serves paths it has independent reason to
 * believe the USER put in play:
 *
 *   - under a configured library root (`fileSearchRoots`, mirrored from the
 *     renderer at boot + on change);
 *   - under a directory the user picked in a main-side dialog this session;
 *   - a file the user picked / saved / opened via the OS this session; or
 *   - a file granted in a PAST session (persisted journal, LRU-capped) —
 *     this is what keeps recents reopenable across restarts.
 *
 * Every grant originates in main (dialogs, OS open events, argv, spawn
 * payloads) except the roots mirror and the one-shot legacy-recents import,
 * which arrive from the renderer. A hostile renderer could re-scope itself
 * through those — accepted: plugins are full-trust in the renderer, so this
 * boundary is defense-in-depth against QUIET bulk reads, not a sandbox. The
 * moves it leaves an attacker (rewriting the user's visible File-search
 * folders, or re-granting one file at a time) leave tracks.
 *
 * Comparisons are realpath-canonical (symlinks resolved) and
 * case-insensitive on Windows/macOS.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const JOURNAL_NAME = 'granted-reads.json';
const JOURNAL_CAP = 500;

const grantedFiles = new Set<string>();
const grantedDirs = new Set<string>();
let libraryRoots: string[] = [];

let journalLoaded: Promise<void> | null = null;
let journalPaths: string[] = []; // LRU, newest last
let journalExists = false;
let saveTimer: NodeJS.Timeout | null = null;

function journalPath(): string {
  return path.join(app.getPath('userData'), JOURNAL_NAME);
}

function fold(p: string): string {
  const norm = path.normalize(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm.toLowerCase()
    : norm;
}

async function realOrRaw(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

function loadJournalOnce(): Promise<void> {
  if (!journalLoaded) {
    journalLoaded = (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(journalPath(), 'utf8')) as {
          paths?: unknown;
        };
        journalExists = true;
        if (Array.isArray(raw.paths)) {
          journalPaths = raw.paths.filter((p): p is string => typeof p === 'string');
        }
      } catch {
        journalExists = false;
      }
    })();
  }
  return journalLoaded;
}

function scheduleJournalSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void (async () => {
      try {
        const finalPath = journalPath();
        const tmp = `${finalPath}.tmp`;
        await fs.writeFile(
          tmp,
          JSON.stringify({ version: 1, paths: journalPaths.slice(-JOURNAL_CAP) }, null, 2),
          { mode: 0o600 },
        );
        await fs.rename(tmp, finalPath);
        journalExists = true;
      } catch {
        /* best-effort — session grants still work */
      }
    })();
  }, 1000);
}

function rememberInJournal(folded: string): void {
  const i = journalPaths.indexOf(folded);
  if (i !== -1) journalPaths.splice(i, 1);
  journalPaths.push(folded);
  if (journalPaths.length > JOURNAL_CAP) journalPaths.splice(0, journalPaths.length - JOURNAL_CAP);
  scheduleJournalSave();
}

/** A single file the user put in play (dialog pick, OS open, save,
 *  spawn payload). Persisted so it stays reopenable in later sessions. */
export function grantReadPath(p: string): void {
  if (typeof p !== 'string' || !p) return;
  const folded = fold(p);
  grantedFiles.add(folded);
  void loadJournalOnce().then(() => rememberInJournal(folded));
  // Also grant the canonical form when it differs (symlinked pick).
  void realOrRaw(p).then((real) => {
    const rf = fold(real);
    if (rf !== folded) {
      grantedFiles.add(rf);
      void loadJournalOnce().then(() => rememberInJournal(rf));
    }
  });
}

/** A directory the user picked — its whole subtree is in play for this
 *  session (folder-scan features enumerate inside it). Not persisted:
 *  a directory grant is a broad power, so it must be re-established by
 *  an actual user pick each session. */
export function grantReadDir(d: string): void {
  if (typeof d !== 'string' || !d) return;
  grantedDirs.add(fold(d));
  void realOrRaw(d).then((real) => grantedDirs.add(fold(real)));
}

/** Mirror of the renderer's `defaultSpeechDocFolder` setting: the one
 *  folder the app writes into without a per-file dialog. */
let writeFolders: string[] = [];
export function setWriteFolders(folders: string[]): void {
  writeFolders = (Array.isArray(folders) ? folders : []).filter(
    (f): f is string => typeof f === 'string' && f.length > 0,
  );
}

/** Document / archive extensions `write-file-at-path` may produce. */
const WRITE_EXTS = new Set(['.cmir', '.docx', '.zip']);

/** May `write-file-at-path` write `p`? Only a document or zip, and only
 *  inside a folder the user put in play: a library root, a directory
 *  picked this session (bulk convert / cleaner destinations), or the
 *  configured speech-doc folder. Everything else — startup folders,
 *  LaunchAgents, arbitrary bytes anywhere — is refused, so a compromised
 *  renderer can't turn this channel into a file drop. (Security report
 *  2026-10-08.) */
export async function isWriteAllowed(p: string): Promise<boolean> {
  if (typeof p !== 'string' || !p) return false;
  if (!WRITE_EXTS.has(path.extname(p).toLowerCase())) return false;
  await loadJournalOnce();
  const candidates = new Set<string>([fold(p), fold(await realOrRaw(p))]);
  const bases: string[] = [];
  for (const r of [...libraryRoots, ...writeFolders]) {
    bases.push(fold(r));
    bases.push(fold(await realOrRaw(r)));
  }
  bases.push(...grantedDirs);
  for (const c of candidates) {
    if (bases.some((b) => c !== b && within(c, b))) return true;
  }
  return false;
}

/** Mirror of the renderer's `fileSearchRoots` setting. */
export function setLibraryRoots(roots: string[]): void {
  libraryRoots = (Array.isArray(roots) ? roots : []).filter(
    (r): r is string => typeof r === 'string' && r.length > 0,
  );
}

/** One-shot import of the renderer's pre-existing recents (paths only),
 *  accepted ONLY while no grant journal exists — i.e., the first boot
 *  after this boundary shipped. Afterwards the channel is dead, so it
 *  can't be used to mint grants. */
export async function grantLegacyRecents(paths: string[]): Promise<boolean> {
  await loadJournalOnce();
  if (journalExists) return false;
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 24)) {
    if (typeof p === 'string' && p) grantReadPath(p);
  }
  scheduleJournalSave(); // writes the journal → closes the one-shot window
  return true;
}

function within(folded: string, base: string): boolean {
  return folded === base || folded.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** Is `p` served by `read-file-at-path`? Checks the canonical (realpath)
 *  form against roots, session dir grants, and file grants (session +
 *  journal). */
export async function isReadAllowed(p: string): Promise<boolean> {
  await loadJournalOnce();
  const candidates = new Set<string>([fold(p), fold(await realOrRaw(p))]);
  const bases: string[] = [];
  for (const r of libraryRoots) {
    bases.push(fold(r));
    bases.push(fold(await realOrRaw(r)));
  }
  bases.push(...grantedDirs);
  for (const c of candidates) {
    if (grantedFiles.has(c)) return true;
    if (journalPaths.includes(c)) return true;
    if (bases.some((b) => within(c, b))) return true;
  }
  return false;
}

/** Test hook: wipe all state (session + journal cache). */
export function resetReadScopeForTests(): void {
  writeFolders = [];
  grantedFiles.clear();
  grantedDirs.clear();
  libraryRoots = [];
  journalLoaded = null;
  journalPaths = [];
  journalExists = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
