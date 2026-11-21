// Release one plugin package from plugins/<id>/ as a GitHub release on
// its own public repo — the shape the in-app installer and its update
// checks read (PLUGINS.md §1): the repo's LATEST release attaches
// cardmirror-plugin.json and plugin.js.
//
//   node scripts/release-plugin.mjs <id|dir> [--repo owner/name] [--publish] [--skip-checks]
//
// Dry run by default: validates the manifest, runs the plugin's test /
// typecheck / build, checks the target repo, and prints what it would
// publish. --publish creates the release (needs GITHUB_TOKEN or
// GH_TOKEN with contents:write on the target repo). The release is
// created as a draft, the two assets are uploaded, and only then is it
// published — GitHub's releases/latest skips drafts, so clients never
// see a release without its assets.
//
// The target repo comes from --repo or `"releaseRepo"` in the plugin's
// package.json. It is deliberately NOT in the manifest: the installer
// stamps `repo` there itself.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const ASSETS = ['cardmirror-plugin.json', 'plugin.js'];
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // mirrors plugin-manager.ts
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// Release semver only: a `-prerelease` suffix is refused because a
// GitHub release marked prerelease is invisible to releases/latest, and
// one that isn't marked would sort BELOW the same plain version.
const RELEASE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(msg) {
  console.error(`release-plugin: ${msg}`);
  process.exit(1);
}

// ── Arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.startsWith('--repo')));
for (const f of flags) {
  if (!['--publish', '--skip-checks'].includes(f)) fail(`unknown flag ${f}`);
}
let repoFlag = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--repo') repoFlag = args[++i] ?? fail('--repo needs owner/name');
  else if (a.startsWith('--repo=')) repoFlag = a.slice('--repo='.length);
  else if (!a.startsWith('--')) positional.push(a);
}
if (positional.length !== 1) {
  fail('usage: node scripts/release-plugin.mjs <id|dir> [--repo owner/name] [--publish] [--skip-checks]');
}
const publish = flags.has('--publish');

const dir = existsSync(join(positional[0], 'package.json'))
  ? resolve(positional[0])
  : resolve('plugins', positional[0]);
if (!existsSync(join(dir, 'package.json'))) fail(`no plugin package at ${dir}`);

// ── Manifest ───────────────────────────────────────────────────────────
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    return fail(`can't read ${p}: ${err.message}`);
  }
};
const pkg = readJson(join(dir, 'package.json'));
const manifest = readJson(join(dir, 'cardmirror-plugin.json'));

const problems = [];
if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) problems.push('`id` must match ^[a-z0-9][a-z0-9-]*$');
if (typeof manifest.name !== 'string' || !manifest.name.trim()) problems.push('`name` is required');
if (manifest.apiVersion !== 1) problems.push('`apiVersion` must be 1');
if (typeof manifest.version !== 'string' || !RELEASE_SEMVER_RE.test(manifest.version)) {
  problems.push(
    `\`version\` must be a plain release version like 1.2.3 (got ${JSON.stringify(manifest.version)}); ` +
      'prerelease versions never reach users through releases/latest',
  );
}
for (const key of ['repo', 'grantedPermissions']) {
  if (key in manifest) problems.push(`\`${key}\` must not be in a released manifest (the app writes it)`);
}
if (manifest.permissionReasons && typeof manifest.permissionReasons === 'object') {
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const k of Object.keys(manifest.permissionReasons)) {
    if (!perms.includes(k)) problems.push(`permissionReasons.${k} is for a permission the plugin doesn't request`);
  }
}
if (problems.length) fail(`cardmirror-plugin.json:\n  ${problems.join('\n  ')}`);
if (basename(dir) !== manifest.id && basename(dir) !== '_template') {
  console.warn(`release-plugin: note: folder "${basename(dir)}" differs from id "${manifest.id}"`);
}

const repo = repoFlag ?? pkg.releaseRepo;
if (!repo) fail(`no target repo: pass --repo owner/name or set "releaseRepo" in ${join(dir, 'package.json')}`);
if (!REPO_RE.test(repo) || /OWNER|REPO/.test(repo)) fail(`"${repo}" is not an owner/name repo`);
const tag = `v${manifest.version}`;

// ── Build ──────────────────────────────────────────────────────────────
if (!flags.has('--skip-checks')) {
  for (const step of ['test', 'typecheck', 'build']) {
    if (!pkg.scripts?.[step]) fail(`package.json has no "${step}" script`);
    console.log(`\n── ${basename(dir)}: npm run ${step}`);
    const r = spawnSync('npm', ['run', step], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail(`${step} failed`);
  }
}
const assetPaths = ASSETS.map((name) => join(dir, 'dist', name));
for (const p of assetPaths) {
  if (!existsSync(p)) fail(`missing ${p} — run the build (or drop --skip-checks)`);
  if (statSync(p).size > MAX_ASSET_BYTES) fail(`${p} is over 5 MiB; the installer would refuse it`);
}
const builtManifest = readJson(assetPaths[0]);
if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) {
  fail('dist/cardmirror-plugin.json differs from cardmirror-plugin.json — rebuild');
}

// ── GitHub ─────────────────────────────────────────────────────────────
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const headers = (extra = {}) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cardmirror-release-plugin',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...extra,
});
async function gh(method, url, body, extraHeaders) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

/** Plain-semver compare of release versions (all prerelease-free here). */
function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const repoInfo = await gh('GET', `/repos/${repo}`);
if (repoInfo.status === 404) fail(`${repo} not found (create it first, public, with at least one commit)`);
if (repoInfo.status !== 200) fail(`GitHub said ${repoInfo.status} for ${repo}: ${repoInfo.json?.message ?? ''}`);
if (repoInfo.json.private) fail(`${repo} is private — the installer only reads public releases`);

const existing = await gh('GET', `/repos/${repo}/releases/tags/${tag}`);
if (existing.status === 200) fail(`${repo} already has a release ${tag} — bump "version" in cardmirror-plugin.json`);

const latest = await gh('GET', `/repos/${repo}/releases/latest`);
let latestVersion = null;
if (latest.status === 200) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(latest.json.tag_name ?? '');
  latestVersion = m ? m[1] : null;
  if (latestVersion && cmp(manifest.version, latestVersion) <= 0) {
    fail(`${manifest.version} is not newer than the latest release (${latest.json.tag_name}); clients would not update`);
  }
}

// Release notes: the plugin's CHANGELOG.md section for this version, if any.
let notes = `${manifest.name} ${tag}`;
const changelogPath = join(dir, 'CHANGELOG.md');
if (existsSync(changelogPath)) {
  const lines = readFileSync(changelogPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${manifest.version.replace(/\./g, '\\.')}\\b`).test(l));
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    notes = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() || notes;
  }
}

console.log(`
Plugin:   ${manifest.name} (${manifest.id})
Version:  ${manifest.version}${latestVersion ? ` (latest release: ${latestVersion})` : ' (first release)'}
Repo:     https://github.com/${repo}
Tag:      ${tag}
Assets:   ${assetPaths.map((p) => `${basename(p)} (${statSync(p).size} bytes)`).join(', ')}
Notes:
${notes.replace(/^/gm, '  ')}
`);

if (!publish) {
  console.log('Dry run — nothing published. Re-run with --publish to create the release.');
  process.exit(0);
}
if (!token) fail('--publish needs GITHUB_TOKEN or GH_TOKEN (contents: write on the target repo)');

const created = await gh('POST', `/repos/${repo}/releases`, {
  tag_name: tag,
  name: `${manifest.name} ${tag}`,
  body: notes,
  draft: true,
  prerelease: false,
});
if (created.status !== 201) {
  fail(`creating the release failed (${created.status}): ${created.json?.message ?? ''}${
    created.json?.errors ? ` ${JSON.stringify(created.json.errors)}` : ''
  }`);
}
const releaseId = created.json.id;
for (const p of assetPaths) {
  const name = basename(p);
  const up = await gh(
    'POST',
    `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    new Uint8Array(readFileSync(p)),
    { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/javascript' },
  );
  if (up.status !== 201) {
    fail(`uploading ${name} failed (${up.status}): ${up.json?.message ?? ''} — the draft release is left on ${repo} for you to delete`);
  }
}
const live = await gh('PATCH', `/repos/${repo}/releases/${releaseId}`, { draft: false, make_latest: 'true' });
if (live.status !== 200) fail(`publishing the draft failed (${live.status}): ${live.json?.message ?? ''}`);
console.log(`Published ${live.json.html_url}`);
console.log('Installed copies with Auto-update on pick it up within a day (or via "Check for updates").');
