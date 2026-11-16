/**
 * Plugin install/update from GitHub releases (Obsidian model).
 * A plugin repo publishes two release assets: `cardmirror-plugin.json`
 * (manifest) and `plugin.js` (built bundle). Installed plugins live in
 * userData/plugins/<id>/ — one directory per plugin, next to the
 * legacy cardcutter.global.js FILE, which listInstalled skips.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MANIFEST_NAME = 'cardmirror-plugin.json';
export const BUNDLE_NAME = 'plugin.js';
/** Main can't import renderer modules, so this, `PERMISSION_ID_RE`,
 *  `MAX_PERMISSIONS` and `sanitizePermissionList` are copies of the
 *  renderer's. tests/editor/plugin-permissions.test.ts ("main/renderer
 *  parity") fails the moment they drift. */
export const PLUGIN_API_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_ID_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i; // Windows device names
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MiB per release asset

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  apiVersion: number;
  minAppVersion?: string;
  /** Source repo ("owner/repo"), stamped at install time so update
   *  checks know where the plugin came from. */
  repo?: string;
  /** Permissions the plugin asks for (src/editor/plugin-permissions.ts).
   *  Shown in the consent dialog. Off-shape entries are dropped. */
  permissions?: string[];
  /** What the user consented to — written ONLY by this module, from
   *  the renderer's consent answer, always ⊆ `permissions`. Stripped
   *  from downloaded manifests so a release can't pre-grant itself. */
  grantedPermissions?: string[];
}

// Permission-id shape (parity-tested against src/editor/plugin-permissions.ts).
// Main only guards SHAPE; which permissions exist is the renderer's catalog.
export const PERMISSION_ID_RE = /^[a-z]+(\.[a-z][a-zA-Z]*)+$/;
export const MAX_PERMISSIONS = 32;

export function sanitizePermissionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const p of raw) {
    if (out.size >= MAX_PERMISSIONS) break;
    if (typeof p === 'string' && PERMISSION_ID_RE.test(p)) out.add(p);
  }
  return [...out].sort();
}

/** `granted ∩ requested`, sanitized — consent can never exceed what the
 *  manifest asked for. */
export function intersectGrant(granted: unknown, requested: readonly string[] | undefined): string[] {
  const ask = new Set(requested ?? []);
  return sanitizePermissionList(granted).filter((p) => ask.has(p));
}

export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) {
    m = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(s);
  }
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/** Semver-ish compare good enough for x.y.z and x.y.z-beta.N. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { main: number[]; pre: (number | string)[] | null } => {
    const [main = '', pre] = v.split('-', 2);
    return {
      main: main.split('.').map((n) => parseInt(n, 10) || 0),
      pre: pre === undefined ? null : pre.split('.').map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p)),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.main[i] ?? 0) - (pb.main[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function validateManifest(
  obj: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const m = obj as Partial<PluginManifest> | null;
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest is not an object' };
  if (typeof m.id !== 'string' || !ID_RE.test(m.id) || RESERVED_ID_RE.test(m.id)) {
    return { ok: false, error: 'bad plugin id' };
  }
  if (typeof m.name !== 'string' || !m.name) return { ok: false, error: 'missing name' };
  if (typeof m.version !== 'string' || !m.version) return { ok: false, error: 'missing version' };
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    return { ok: false, error: `plugin needs apiVersion ${String(m.apiVersion)}; this CardMirror supports ${PLUGIN_API_VERSION}` };
  }
  // Permission lists are additive: they sanitize, never reject (a manifest
  // from a newer plugin must still install on this build).
  const manifest = { ...m } as PluginManifest;
  delete manifest.permissions;
  delete manifest.grantedPermissions;
  const permissions = sanitizePermissionList(m.permissions);
  if (permissions.length > 0) manifest.permissions = permissions;
  if (m.grantedPermissions !== undefined) {
    manifest.grantedPermissions = intersectGrant(m.grantedPermissions, permissions);
  }
  return { ok: true, manifest };
}

/**
 * Guard against id hijack: a second repo publishing a manifest with an
 * id already owned by an installed plugin would overwrite it. Returns an
 * error message to block, or null to allow. Same-repo reinstall (the
 * update path) is allowed; a missing stored repo on the existing install
 * (pre-repo-field manifests) can't be proven to match, so it blocks —
 * uninstall + reinstall is the recovery.
 */
export function checkInstallCollision(
  existing: PluginManifest | undefined,
  ref: string,
): string | null {
  if (!existing) return null;
  if (existing.repo && existing.repo === ref) return null;
  return `A different plugin ("${existing.repo ?? 'unknown source'}") already owns the id "${existing.id}". Uninstall it first.`;
}

async function readInstalledManifest(id: string): Promise<PluginManifest | undefined> {
  try {
    const raw = await fs.readFile(path.join(pluginDir(id), MANIFEST_NAME), 'utf8');
    const v = validateManifest(JSON.parse(raw));
    return v.ok ? v.manifest : undefined;
  } catch {
    return undefined;
  }
}

function pluginsRootDir(): string {
  return path.join(app.getPath('userData'), 'plugins');
}
function pluginDir(id: string): string {
  return path.join(pluginsRootDir(), id);
}

interface GithubAsset { name: string; browser_download_url: string; }
interface GithubRelease { tag_name: string; assets: GithubAsset[]; }

async function fetchLatestRelease(owner: string, repo: string): Promise<GithubRelease | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cardmirror' },
  });
  if (!res.ok) return null;
  return (await res.json()) as GithubRelease;
}

async function downloadAsset(release: GithubRelease, name: string): Promise<string | null> {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) return null;
  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'cardmirror' },
  });
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) return null;
  const text = await res.text();
  if (text.length > MAX_ASSET_BYTES) return null;
  return text;
}

/**
 * Curated install sources. Plugins are FULL-TRUST code (they run in the
 * renderer main world with the whole preload surface), so the GitHub
 * installer only accepts repos on this list — its current purpose is
 * delivering the ebb integration plugin. Community/arbitrary-repo installs
 * unlock via the console flag (`setCommunityInstallsUnlocked`, wired to a
 * renderer console command like the card-cutter switch); the dev
 * "Load plugin from file…" path stays as the session-only escape hatch.
 * Enforced HERE in main so the renderer can't bypass it.
 */
/**
 * Curated allowlist, three layers deep:
 *   1. The RELAY serves the authoritative list at GET /plugin-allowlist
 *      (ungated — public data), so adding a repo is a server variable
 *      edit, never an app release. Fetched fresh per install attempt
 *      (installs are rare) with a short timeout.
 *   2. The last successful fetch is cached on disk, so an offline
 *      machine keeps the most recent list.
 *   3. The BAKED list below is the floor when neither is available.
 *      Confirmed-real repos ONLY — never a guessed slug (baked entries
 *      ship in binaries; the dedicated ebb-plugin repo doesn't exist
 *      yet, so its eventual slug is added on the RELAY when known).
 * A fetched list REPLACES the baked one (that's what makes revocation
 * possible), but an empty or malformed response reads as a failed
 * fetch, not as "block everything" — a server hiccup must not brick
 * the ebb install path.
 */
export const PLUGIN_INSTALL_ALLOWLIST: ReadonlySet<string> = new Set([
  'shreerammodi/ebb',
]);
const ALLOWLIST_FETCH_TIMEOUT_MS = 4000;
const ALLOWLIST_MAX_ENTRIES = 200;
const ALLOWLIST_CACHE_NAME = 'plugin-allowlist.json';
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Injected by main at registration (pairing-ipc's relayUrl) — a getter
 *  so settings-driven self-hosted overrides stay live; null in tests. */
let relayUrlSupplier: (() => string) | null = null;
export function setAllowlistRelayUrlSupplier(fn: () => string): void {
  relayUrlSupplier = fn;
}

/** Parse a server allowlist response into a repo set, or null when the
 *  shape is wrong / empty (treated as fetch failure by the caller). */
export function parseAllowlistResponse(body: unknown): Set<string> | null {
  const repos = (body as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) return null;
  const out = new Set<string>();
  for (const r of repos.slice(0, ALLOWLIST_MAX_ENTRIES)) {
    if (typeof r === 'string' && OWNER_REPO_RE.test(r.trim())) {
      out.add(r.trim().toLowerCase());
    }
  }
  return out.size > 0 ? out : null;
}

function allowlistCachePath(): string {
  return path.join(app.getPath('userData'), ALLOWLIST_CACHE_NAME);
}

async function fetchServerAllowlist(): Promise<Set<string> | null> {
  const base = relayUrlSupplier?.();
  if (!base) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ALLOWLIST_FETCH_TIMEOUT_MS);
    const res = await fetch(`${base}/plugin-allowlist`, { signal: ctl.signal }).finally(() =>
      clearTimeout(timer),
    );
    if (!res.ok) return null;
    return parseAllowlistResponse(await res.json());
  } catch {
    return null;
  }
}

/** The effective allowlist: live server list → disk cache → baked floor. */
async function currentAllowlist(): Promise<ReadonlySet<string>> {
  const fetched = await fetchServerAllowlist();
  if (fetched) {
    try {
      const tmp = `${allowlistCachePath()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ repos: [...fetched] }, null, 2));
      await fs.rename(tmp, allowlistCachePath());
    } catch {
      /* cache write is best-effort */
    }
    return fetched;
  }
  try {
    const cached = parseAllowlistResponse(
      JSON.parse(await fs.readFile(allowlistCachePath(), 'utf8')),
    );
    if (cached) return cached;
  } catch {
    /* no cache — fall through to baked */
  }
  return PLUGIN_INSTALL_ALLOWLIST;
}

let communityInstallsUnlocked = false;
export function setCommunityInstallsUnlocked(on: boolean): void {
  communityInstallsUnlocked = on;
}

/** One entry of the relay's public plugin directory — the browsable
 *  subset of the allowlist, with display metadata the relay reads from
 *  each repo's latest-release manifest (the same file the installer
 *  fetches, so what the browser shows is what installs). */
export interface DirectoryEntry {
  repo: string;
  name?: string;
  description?: string;
  author?: string;
  version?: string;
}

const DIRECTORY_MAX_ENTRIES = 200;
const DIRECTORY_STR_MAX = 400;

function directoryString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, DIRECTORY_STR_MAX) : undefined;
}

/**
 * The relay's browsable plugin directory, filtered through the
 * effective allowlist — Browse must never offer a repo the install
 * check would then refuse. No disk cache: browsing is an online act
 * (installing needs GitHub anyway), so offline it degrades to the
 * type-a-slug path rather than showing a stale storefront.
 */
export async function fetchPluginDirectory(): Promise<
  { ok: true; plugins: DirectoryEntry[] } | { ok: false; error: string }
> {
  const base = relayUrlSupplier?.();
  if (!base) return { ok: false, error: 'No relay is configured.' };
  let raw: unknown;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ALLOWLIST_FETCH_TIMEOUT_MS);
    const res = await fetch(`${base}/plugin-directory`, { signal: ctl.signal }).finally(() =>
      clearTimeout(timer),
    );
    if (!res.ok) return { ok: false, error: `The plugin directory answered ${res.status}.` };
    raw = await res.json();
  } catch {
    return { ok: false, error: 'Could not reach the plugin directory. Are you online?' };
  }
  const list = (raw as { plugins?: unknown })?.plugins;
  if (!Array.isArray(list)) return { ok: false, error: 'The plugin directory looked malformed.' };
  const allowlist = await currentAllowlist();
  const plugins: DirectoryEntry[] = [];
  for (const item of list.slice(0, DIRECTORY_MAX_ENTRIES)) {
    const o = item as Record<string, unknown>;
    const repo = typeof o?.repo === 'string' ? o.repo.trim().toLowerCase() : '';
    if (!OWNER_REPO_RE.test(repo)) continue;
    if (!communityInstallsUnlocked && !allowlist.has(repo)) continue;
    plugins.push({
      repo,
      name: directoryString(o.name),
      description: directoryString(o.description),
      author: directoryString(o.author),
      version: directoryString(o.version),
    });
  }
  return { ok: true, plugins };
}

/** The allowlist verdict for a parsed ref — null to allow, message to block. */
export function checkInstallAllowed(
  ownerRepo: string,
  unlocked: boolean = communityInstallsUnlocked,
  allowlist: ReadonlySet<string> = PLUGIN_INSTALL_ALLOWLIST,
): string | null {
  if (unlocked) return null;
  if (allowlist.has(ownerRepo.toLowerCase())) return null;
  return 'This repository is not on the curated plugin list.';
}

/**
 * Two-phase install: `inspectFromGithub` fetches, validates, and STAGES a
 * release in memory — nothing touches disk — returning what the consent
 * dialog needs (manifest + the actual owner/repo, which the manifest cannot
 * spoof). `commitPendingInstall` writes the staged files only after the
 * renderer reports consent; `discardPendingInstall` drops them on decline.
 * The old single-call install wrote FIRST and asked after, so declining a
 * reinstall deleted the existing working version.
 */
interface PendingInstall {
  manifest: PluginManifest;
  bundleText: string;
  expiresAt: number;
  /** Installed grant at inspect time (update path); undefined = fresh. */
  previousGranted?: string[];
}
const pendingInstalls = new Map<string, PendingInstall>();
/** Consent dialogs are humans reading text; a stale token is a bug or a
 *  replay. Ten minutes is generous. */
const PENDING_TTL_MS = 10 * 60 * 1000;

function prunePendingInstalls(now: number): void {
  for (const [token, p] of pendingInstalls) {
    if (p.expiresAt <= now) pendingInstalls.delete(token);
  }
}

export async function inspectFromGithub(
  ref: string,
): Promise<
  | {
      ok: true;
      pending: string;
      plugin: PluginManifest;
      ownerRepo: string;
      /** The current install's consented permissions (update path), or
       *  undefined for a fresh install — lets the renderer re-prompt
       *  only for what an update ADDS. */
      installedGranted?: string[];
    }
  | { ok: false; error: string }
> {
  const parsed = parseRepoRef(ref);
  if (!parsed) return { ok: false, error: 'Enter a GitHub URL or owner/repo.' };
  const ownerRepo = `${parsed.owner}/${parsed.repo}`;
  const blocked = checkInstallAllowed(
    ownerRepo.toLowerCase(),
    communityInstallsUnlocked,
    await currentAllowlist(),
  );
  if (blocked) return { ok: false, error: blocked };
  let release: GithubRelease | null;
  try {
    release = await fetchLatestRelease(parsed.owner, parsed.repo);
  } catch {
    return { ok: false, error: 'Could not reach GitHub.' };
  }
  if (!release) return { ok: false, error: 'No releases found for that repository.' };
  const manifestText = await downloadAsset(release, MANIFEST_NAME).catch(() => null);
  const bundleText = await downloadAsset(release, BUNDLE_NAME).catch(() => null);
  if (!manifestText || !bundleText) {
    return { ok: false, error: `The latest release must attach ${MANIFEST_NAME} and ${BUNDLE_NAME}.` };
  }
  let manifestObj: unknown;
  try {
    manifestObj = JSON.parse(manifestText);
  } catch {
    return { ok: false, error: `${MANIFEST_NAME} is not valid JSON.` };
  }
  const v = validateManifest(manifestObj);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.manifest.minAppVersion && compareVersions(app.getVersion(), v.manifest.minAppVersion) < 0) {
    return { ok: false, error: `This plugin needs CardMirror ${v.manifest.minAppVersion} or newer.` };
  }
  const existing = await readInstalledManifest(v.manifest.id);
  const collision = checkInstallCollision(existing, ownerRepo);
  if (collision) return { ok: false, error: collision };
  // Persist the source repo so checkPluginUpdate (and the settings UI)
  // know where this install came from. Written into the saved manifest,
  // not just returned — the info must survive an app restart.
  v.manifest.repo = ownerRepo;
  // Consent is the USER's, recorded at commit — a published manifest
  // claiming a grant is ignored.
  delete v.manifest.grantedPermissions;
  const now = Date.now();
  prunePendingInstalls(now);
  const token = randomUUID();
  pendingInstalls.set(token, {
    manifest: v.manifest,
    bundleText,
    expiresAt: now + PENDING_TTL_MS,
    previousGranted: existing ? (existing.grantedPermissions ?? []) : undefined,
  });
  return {
    ok: true,
    pending: token,
    plugin: v.manifest,
    ownerRepo,
    ...(existing ? { installedGranted: existing.grantedPermissions ?? [] } : {}),
  };
}

/** Write one file via tmp + rename (so a crash never leaves it half-written). */
async function writeAtomic(finalPath: string, text: string): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, text);
  await fs.rename(tmpPath, finalPath);
}

/** Commit a staged install after the user consented. `granted` is the
 *  permission list the user agreed to (stored ∩ the manifest's request).
 *  An older renderer omits it: an update then keeps the prior consent
 *  (∩ the new request) and a fresh install grants nothing. */
export async function commitPendingInstall(
  token: string,
  granted?: unknown,
): Promise<{ ok: true; plugin: PluginManifest } | { ok: false; error: string }> {
  prunePendingInstalls(Date.now());
  const staged = pendingInstalls.get(String(token));
  if (!staged) return { ok: false, error: 'This install request expired. Try again.' };
  pendingInstalls.delete(String(token));
  const manifest: PluginManifest = { ...staged.manifest };
  const consented = granted === undefined ? (staged.previousGranted ?? []) : granted;
  const grant = intersectGrant(consented, manifest.permissions);
  if (manifest.permissions?.length || grant.length) manifest.grantedPermissions = grant;
  const dir = pluginDir(manifest.id);
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  await writeAtomic(path.join(dir, BUNDLE_NAME), staged.bundleText);
  return { ok: true, plugin: manifest };
}

/** Change an installed plugin's consented permissions (Settings →
 *  Plugins → permissions). Clamped to what its manifest requests, so
 *  this can revoke freely but will never grant beyond the original request. */
export async function setGrantedPermissions(
  id: string,
  granted: unknown,
): Promise<{ ok: true; granted: string[] } | { ok: false; error: string }> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'bad plugin id' };
  const manifest = await readInstalledManifest(id);
  if (!manifest) return { ok: false, error: 'not installed' };
  const grant = intersectGrant(granted, manifest.permissions);
  await writeAtomic(
    path.join(pluginDir(id), MANIFEST_NAME),
    JSON.stringify({ ...manifest, grantedPermissions: grant }, null, 2),
  );
  return { ok: true, granted: grant };
}

export function discardPendingInstall(token: string): void {
  pendingInstalls.delete(String(token));
}

/** A listed install, possibly flagged incompatible with this app build. */
export type InstalledPluginInfo = PluginManifest & { incompatible?: string };

export async function listInstalled(): Promise<InstalledPluginInfo[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await fs.readdir(pluginsRootDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledPluginInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // skips cardcutter.global.js
    try {
      const raw = await fs.readFile(path.join(pluginsRootDir(), e.name, MANIFEST_NAME), 'utf8');
      const v = validateManifest(JSON.parse(raw));
      if (!v.ok || v.manifest.id !== e.name) continue;
      // The version gate applies at load too, not just install: an app
      // downgrade must not boot a plugin built for a newer CardMirror.
      // Incompatible installs are LISTED (flagged) rather than hidden —
      // hidden, the plugin silently vanishes from the settings tab, which
      // reads as data loss and leaves no way to uninstall it. The load
      // path refuses on the flag; only the row's enable toggle disables.
      if (v.manifest.minAppVersion && compareVersions(app.getVersion(), v.manifest.minAppVersion) < 0) {
        out.push({ ...v.manifest, incompatible: v.manifest.minAppVersion });
        continue;
      }
      out.push(v.manifest);
    } catch {
      /* skip broken installs */
    }
  }
  return out;
}

export async function readPluginSource(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  try {
    // The load-path half of the version gate: an incompatible install is
    // listed in the UI but its bundle is never served for execution.
    const manifest = await readInstalledManifest(id);
    if (
      manifest?.minAppVersion &&
      compareVersions(app.getVersion(), manifest.minAppVersion) < 0
    ) {
      return null;
    }
    return await fs.readFile(path.join(pluginDir(id), BUNDLE_NAME), 'utf8');
  } catch {
    return null;
  }
}

export async function uninstallPlugin(id: string): Promise<void> {
  if (!ID_RE.test(id)) return;
  await fs.rm(pluginDir(id), { recursive: true, force: true });
}

export async function checkPluginUpdate(
  id: string,
  repoRef: string,
): Promise<{ ok: true; current: string; latest: string; hasUpdate: boolean } | { ok: false; error: string }> {
  const installed = (await listInstalled()).find((p) => p.id === id);
  if (!installed) return { ok: false, error: 'not installed' };
  const parsed = parseRepoRef(repoRef);
  if (!parsed) return { ok: false, error: 'bad repo ref' };
  let release: GithubRelease | null;
  try {
    release = await fetchLatestRelease(parsed.owner, parsed.repo);
  } catch {
    return { ok: false, error: 'Could not reach GitHub.' };
  }
  if (!release) return { ok: false, error: 'No releases found.' };
  const manifestText = await downloadAsset(release, MANIFEST_NAME).catch(() => null);
  if (!manifestText) return { ok: false, error: 'Release has no manifest.' };
  try {
    const latest = (JSON.parse(manifestText) as PluginManifest).version;
    return {
      ok: true,
      current: installed.version,
      latest,
      hasUpdate: compareVersions(latest, installed.version) > 0,
    };
  } catch {
    return { ok: false, error: 'Bad manifest in release.' };
  }
}
