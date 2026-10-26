// @vitest-environment node
// Read-scope registry for host:read-file-at-path (PR #25 review): main
// only serves paths the user put in play. See read-scope.ts for the
// grant sources and the honest threat model (defense against QUIET bulk
// reads, not a renderer sandbox).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { app } from './_electron-stub.js';
import {
  grantReadPath,
  grantReadDir,
  setLibraryRoots,
  grantLegacyRecents,
  isReadAllowed,
  isWriteAllowed,
  setWriteFolders,
  resetReadScopeForTests,
} from '../../apps/desktop/src/read-scope.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-scope-'));
  (app as { __userData: string }).__userData = dir;
  resetReadScopeForTests();
});
afterEach(async () => {
  resetReadScopeForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

const touch = async (p: string): Promise<string> => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, 'x');
  return p;
};

describe('isReadAllowed', () => {
  it('denies by default — an unknown absolute path reads as missing', async () => {
    const f = await touch(path.join(dir, 'loose', 'aff.docx'));
    expect(await isReadAllowed(f)).toBe(false);
  });

  it('serves anything under a library root, including new files', async () => {
    const root = path.join(dir, 'library');
    setLibraryRoots([root]);
    const f = await touch(path.join(root, 'season', 'aff.cmir'));
    expect(await isReadAllowed(f)).toBe(true);
    expect(await isReadAllowed(path.join(dir, 'elsewhere.cmir'))).toBe(false);
  });

  it('a root prefix is a path boundary, not a string prefix', async () => {
    setLibraryRoots([path.join(dir, 'lib')]);
    const evil = await touch(path.join(dir, 'library-evil', 'aff.cmir'));
    expect(await isReadAllowed(evil)).toBe(false);
  });

  it('serves an explicitly granted file and a granted directory subtree', async () => {
    const f = await touch(path.join(dir, 'desktop', 'case.docx'));
    grantReadPath(f);
    expect(await isReadAllowed(f)).toBe(true);
    const d = path.join(dir, 'tubs');
    const inside = await touch(path.join(d, 'deep', 'neg.cmir'));
    grantReadDir(d);
    expect(await isReadAllowed(inside)).toBe(true);
  });

  it('follows symlinks to the canonical location before judging', async () => {
    if (process.platform === 'win32') return; // symlink perms are unreliable there
    const root = path.join(dir, 'library');
    setLibraryRoots([root]);
    const real = await touch(path.join(root, 'real.cmir'));
    const link = path.join(dir, 'outside-link.cmir');
    await fs.symlink(real, link);
    // A link OUTSIDE the root pointing INTO it: canonical form is inside.
    expect(await isReadAllowed(link)).toBe(true);
  });

  it('grants persist to the journal and survive a state reset (a "restart")', async () => {
    const f = await touch(path.join(dir, 'picked.docx'));
    grantReadPath(f);
    expect(await isReadAllowed(f)).toBe(true);
    // The journal save is debounced (1s) — wait it out.
    await new Promise((r) => setTimeout(r, 1300));
    resetReadScopeForTests(); // fresh process state, same userData
    expect(await isReadAllowed(f)).toBe(true); // re-loaded from the journal
  });
});

describe('grantLegacyRecents (one-shot import)', () => {
  it('imports once, then the channel is dead', async () => {
    const f = await touch(path.join(dir, 'old-recent.cmir'));
    expect(await grantLegacyRecents([f])).toBe(true);
    await new Promise((r) => setTimeout(r, 1300)); // journal write lands
    resetReadScopeForTests();
    expect(await isReadAllowed(f)).toBe(true);
    // Second import attempt (journal now exists) must refuse — this is
    // what stops the channel from minting grants forever.
    const g = await touch(path.join(dir, 'sneaky.cmir'));
    expect(await grantLegacyRecents([g])).toBe(false);
    expect(await isReadAllowed(g)).toBe(false);
  });
});

describe('write scope (host:write-file-at-path)', () => {
  it('refuses everything until a folder is in play', async () => {
    expect(await isWriteAllowed(path.join(dir, 'out', 'a.cmir'))).toBe(false);
  });
  it('allows documents and zips inside a session-picked directory, library root, or speech-doc folder', async () => {
    grantReadDir(path.join(dir, 'picked'));
    setLibraryRoots([path.join(dir, 'lib')]);
    setWriteFolders([path.join(dir, 'speech')]);
    expect(await isWriteAllowed(path.join(dir, 'picked', 'sub', 'a.cmir'))).toBe(true);
    expect(await isWriteAllowed(path.join(dir, 'lib', 'b.docx'))).toBe(true);
    expect(await isWriteAllowed(path.join(dir, 'speech', '1NC.docx'))).toBe(true);
    expect(await isWriteAllowed(path.join(dir, 'picked', 'bundle.zip'))).toBe(true);
  });
  it('refuses other extensions, paths outside the folders, and the folder itself', async () => {
    grantReadDir(path.join(dir, 'picked'));
    expect(await isWriteAllowed(path.join(dir, 'picked', 'evil.plist'))).toBe(false);
    expect(await isWriteAllowed(path.join(dir, 'picked', 'x.sh'))).toBe(false);
    expect(await isWriteAllowed(path.join(dir, 'elsewhere', 'a.cmir'))).toBe(false);
    expect(await isWriteAllowed(path.join(dir, 'picked'))).toBe(false);
    expect(await isWriteAllowed(path.join(dir, 'picked', '..', 'escape.cmir'))).toBe(false);
  });
  it('a granted FILE does not open its folder for writing', async () => {
    grantReadPath(path.join(dir, 'docs', 'open.cmir'));
    expect(await isWriteAllowed(path.join(dir, 'docs', 'other.cmir'))).toBe(false);
  });
});
