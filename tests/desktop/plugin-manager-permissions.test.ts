import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resetElectronStub } from './_electron-stub.js';
import {
  BUNDLE_NAME,
  MANIFEST_NAME,
  commitPendingInstall,
  inspectFromGithub,
  intersectGrant,
  listInstalled,
  setCommunityInstallsUnlocked,
  setGrantedPermissions,
  validateManifest,
} from '../../apps/desktop/src/plugin-manager.js';

const base = { id: 'live-link', name: 'Live Link', version: '1.0.0', apiVersion: 1 };

describe('validateManifest permission fields', () => {
  it('sanitizes permissions instead of rejecting the manifest', () => {
    const v = validateManifest({ ...base, permissions: ['ui.dialogs', 'BAD', 'future.thing', 9] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.permissions).toEqual(['future.thing', 'ui.dialogs']);
  });
  it('omits an empty permissions list and clamps grantedPermissions to it', () => {
    const none = validateManifest({ ...base, permissions: 'nope' });
    expect(none.ok && 'permissions' in none.manifest).toBe(false);
    const v = validateManifest({
      ...base,
      permissions: ['ui.dialogs'],
      grantedPermissions: ['ui.dialogs', 'collab.shareCode'],
    });
    if (v.ok) expect(v.manifest.grantedPermissions).toEqual(['ui.dialogs']);
  });
  it('intersectGrant never exceeds the request', () => {
    expect(intersectGrant(['a.b', 'c.d'], ['c.d'])).toEqual(['c.d']);
    expect(intersectGrant('a.b', ['a.b'])).toEqual([]);
    expect(intersectGrant(['a.b'], undefined)).toEqual([]);
  });
});

describe('install / update / revoke on disk', () => {
  let userData: string;
  /** What the fake GitHub release serves as its manifest. */
  let releaseManifest: Record<string, unknown>;

  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'cm-plugin-perms-'));
    resetElectronStub(userData);
    setCommunityInstallsUnlocked(true); // skip the curated allowlist
    releaseManifest = { ...base, permissions: ['ui.dialogs', 'future.thing'] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('https://api.github.com/repos/owner/live-link/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v1',
              assets: [
                { name: MANIFEST_NAME, browser_download_url: 'https://dl.test/manifest' },
                { name: BUNDLE_NAME, browser_download_url: 'https://dl.test/bundle' },
              ],
            }),
          );
        }
        if (u === 'https://dl.test/manifest') return new Response(JSON.stringify(releaseManifest));
        if (u === 'https://dl.test/bundle') return new Response('/* bundle */');
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setCommunityInstallsUnlocked(false);
    rmSync(userData, { recursive: true, force: true });
  });

  const installedManifest = (): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(userData, 'plugins', 'live-link', MANIFEST_NAME), 'utf8'));

  it('a release cannot pre-grant itself', async () => {
    releaseManifest = { ...releaseManifest, grantedPermissions: ['ui.dialogs'] };
    const ins = await inspectFromGithub('owner/live-link');
    expect(ins.ok).toBe(true);
    if (!ins.ok) return;
    expect(ins.plugin.grantedPermissions).toBeUndefined();
    expect(ins.installedGranted).toBeUndefined(); // fresh install
    // An older renderer commits without a grant → nothing granted.
    await commitPendingInstall(ins.pending);
    expect(installedManifest()['grantedPermissions']).toEqual([]);
  });

  it('commit writes the consented grant clamped to the request', async () => {
    const ins = await inspectFromGithub('owner/live-link');
    if (!ins.ok) throw new Error(ins.error);
    const r = await commitPendingInstall(ins.pending, ['ui.dialogs', 'collab.shareCode']);
    expect(r.ok).toBe(true);
    expect(installedManifest()['grantedPermissions']).toEqual(['ui.dialogs']);
    const listed = await listInstalled();
    expect(listed[0]!.grantedPermissions).toEqual(['ui.dialogs']);
  });

  it('an update from an older renderer (no grant passed) keeps the prior consent', async () => {
    const first = await inspectFromGithub('owner/live-link');
    if (!first.ok) throw new Error(first.error);
    await commitPendingInstall(first.pending, ['ui.dialogs']);
    releaseManifest = { ...releaseManifest, version: '1.1.0' };
    const second = await inspectFromGithub('owner/live-link');
    if (!second.ok) throw new Error(second.error);
    expect(second.installedGranted).toEqual(['ui.dialogs']);
    await commitPendingInstall(second.pending);
    expect(installedManifest()['grantedPermissions']).toEqual(['ui.dialogs']);
    expect(installedManifest()['version']).toBe('1.1.0');
  });

  it('setGrantedPermissions revokes freely but cannot grant beyond the request', async () => {
    const ins = await inspectFromGithub('owner/live-link');
    if (!ins.ok) throw new Error(ins.error);
    await commitPendingInstall(ins.pending, ['ui.dialogs']);
    expect(await setGrantedPermissions('live-link', [])).toEqual({ ok: true, granted: [] });
    expect(installedManifest()['grantedPermissions']).toEqual([]);
    expect(await setGrantedPermissions('live-link', ['ui.dialogs', 'collab.shareCode'])).toEqual({
      ok: true,
      granted: ['ui.dialogs'],
    });
    expect((await setGrantedPermissions('../evil', [])).ok).toBe(false);
    expect((await setGrantedPermissions('not-installed', [])).ok).toBe(false);
  });

  it('a v1 plugin without permissions installs exactly as before', async () => {
    releaseManifest = { ...base };
    const ins = await inspectFromGithub('owner/live-link');
    if (!ins.ok) throw new Error(ins.error);
    await commitPendingInstall(ins.pending, []);
    const m = installedManifest();
    expect('permissions' in m).toBe(false);
    expect('grantedPermissions' in m).toBe(false);
  });
});
