/**
 * File-index service core (2026-07-30) — the out-of-process owner of the
 * palette's file index + search. Exercised against real temp dirs: scan
 * discovery, windowed ranked queries (shared matcher), exclusion/format
 * filters, pin flag/partition split, prune-on-configure, change
 * notifications on revalidation, disk persistence round-trips, and the
 * folder browse / current-file location derived from the index.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createFileIndexCore, type FileIndexQuery } from '../../apps/desktop/src/file-index-core.js';

let tmp: string;
let dataDir: string;
let rootA: string;
let changed: string[];

function write(p: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeCore() {
  // revalidateDelayMs 0: tests flush revalidation via idle(), never by
  // waiting out the production launch-burst delay.
  return createFileIndexCore({
    dataDir,
    onChanged: (root) => changed.push(root),
    revalidateDelayMs: 0,
  });
}

function q(over: Partial<FileIndexQuery> = {}): FileIndexQuery {
  return {
    query: '',
    roots: [rootA],
    exclusions: [],
    formats: 'both',
    tiebreak: 'alphabetical',
    pins: [],
    partitionPins: true,
    limit: 50,
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fdx-'));
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  rootA = path.join(tmp, 'rootA');
  write(path.join(rootA, 'Warming Aff.cmir'));
  write(path.join(rootA, 'Neg', 'Warming Neg.docx'));
  write(path.join(rootA, 'Neg', '~$Warming Neg.docx')); // Word lock file — skipped
  write(path.join(rootA, 'notes.txt')); // not openable — skipped
  changed = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('file-index core', () => {
  it('scans a cold root, notifies, and answers ranked queries', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    expect(changed).toEqual([rootA]);

    const res = await core.query(q());
    expect(res.total).toBe(2);
    expect(res.rows.map((r) => r.name)).toEqual(['Warming Aff', 'Warming Neg']);
    expect(res.rows[0]!.relPath).toBe('Warming Aff.cmir');
  });

  it('windows the ranked list and reports the full total', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const res = await core.query(q({ limit: 1 }));
    expect(res.rows).toHaveLength(1);
    expect(res.total).toBe(2);
  });

  it('filters exclusions and formats service-side', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const excluded = await core.query(q({ exclusions: [path.join(rootA, 'Neg')] }));
    expect(excluded.rows.map((r) => r.name)).toEqual(['Warming Aff']);
    const docxOnly = await core.query(q({ formats: 'docx' }));
    expect(docxOnly.rows.map((r) => r.name)).toEqual(['Warming Neg']);
  });

  it('applies folder priority to queries and folder search', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const folderPriority = { highest: [], preferred: [path.join(rootA, 'Neg')] };
    const res = await core.query(q({ query: 'warming', folderPriority }));
    expect(res.rows.map((r) => r.name)).toEqual(['Warming Neg', 'Warming Aff']);
    const browsed = await core.browse({
      roots: [rootA],
      location: { root: rootA, relativeDirectory: '' },
      query: 'warming',
      exclusions: [],
      formats: 'both',
      tiebreak: 'alphabetical',
      folderPriority,
      pins: [],
      limit: 50,
    });
    expect(browsed.rows.filter((r) => r.kind === 'file').map((r) => r.name)).toEqual([
      'Warming Neg',
      'Warming Aff',
    ]);
  });

  it('flags pins always; partitions only when asked', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const pin = path.join(rootA, 'Neg', 'Warming Neg.docx');
    const partitioned = await core.query(q({ pins: [pin] }));
    expect(partitioned.rows.map((r) => r.name)).toEqual(['Warming Neg', 'Warming Aff']);
    expect(partitioned.rows[0]!.pinned).toBe(true);
    const flat = await core.query(q({ pins: [pin], partitionPins: false }));
    expect(flat.rows.map((r) => r.name)).toEqual(['Warming Aff', 'Warming Neg']);
    expect(flat.rows[1]!.pinned).toBe(true);
  });

  it('entriesForPaths serves pin mtimes, omitting excluded paths', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const aff = path.join(rootA, 'Warming Aff.cmir');
    const neg = path.join(rootA, 'Neg', 'Warming Neg.docx');
    const all = await core.entriesForPaths({ paths: [aff, neg], roots: [rootA], exclusions: [] });
    expect(all.map((e) => e.path).sort()).toEqual([aff, neg].sort());
    const excl = await core.entriesForPaths({
      paths: [aff, neg],
      roots: [rootA],
      exclusions: [path.join(rootA, 'Neg')],
    });
    expect(excl.map((e) => e.path)).toEqual([aff]);
  });

  it('persists to disk and a fresh core answers without a rescan', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();

    const reborn = makeCore();
    // No configure: a pure query must be answerable from the disk index.
    const res = await reborn.query(q());
    expect(res.total).toBe(2);
  });

  it('configure prunes departed roots from memory AND disk', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    await core.configure([]); // root removed from settings
    await core.idle();

    const reborn = makeCore();
    const res = await reborn.query(q());
    expect(res.total).toBe(0);
    const onDisk = JSON.parse(
      await fsp.readFile(path.join(dataDir, 'cmir-file-index.json'), 'utf8'),
    ) as { roots: Record<string, unknown[]> };
    expect(Object.keys(onDisk.roots)).toEqual([]);
  });

  it('revalidation notices new files and notifies again', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    changed = [];

    write(path.join(rootA, 'Fresh Add.cmir'));
    await core.configure([rootA]); // the palette-open cadence
    await core.idle();
    expect(changed).toEqual([rootA]);
    const res = await core.query(q());
    expect(res.total).toBe(3);
  });

  it('refresh re-walks a cached root at once, counts the change, and notifies', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    changed = [];

    write(path.join(rootA, 'Fresh Add.cmir'));
    fs.rmSync(path.join(rootA, 'Neg', 'Warming Neg.docx'));
    const r = await core.refresh([rootA]);
    expect(r).toEqual({ roots: 1, files: 2, changedFiles: 2, missingRoots: [] });
    expect(changed).toEqual([rootA]);
    const res = await core.query(q({ query: 'fresh' }));
    expect(res.rows.map((x) => x.name)).toEqual(['Fresh Add']);
    await core.idle();
  });

  it('refresh with nothing changed reports no changes and stays quiet', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    changed = [];

    const r = await core.refresh([rootA]);
    expect(r.changedFiles).toBe(0);
    expect(r.files).toBe(2);
    expect(changed).toEqual([]);
    await core.idle();
  });

  it('refresh scans a cold root (every file counts as new) and flags a missing one', async () => {
    const core = makeCore();
    const gone = path.join(tmp, 'moved-away');
    const r = await core.refresh([rootA, gone]);
    expect(r.roots).toBe(2);
    expect(r.files).toBe(2);
    expect(r.changedFiles).toBe(2);
    expect(r.missingRoots).toEqual([gone]);
    expect(changed).toEqual([rootA]); // the missing root is reported, not walked
    // The listing is persisted: a fresh core answers without a rescan.
    const again = makeCore();
    const res = await again.query(q());
    expect(res.total).toBe(2);
    await core.idle();
    await again.idle();
  });

  it('refresh prunes departed roots like configure does', async () => {
    const rootB = path.join(tmp, 'rootB');
    write(path.join(rootB, 'Other.cmir'));
    const core = makeCore();
    await core.configure([rootA, rootB]);
    await core.idle();

    const r = await core.refresh([rootA]);
    expect(r.roots).toBe(1);
    const res = await core.query(q({ roots: [rootA, rootB] }));
    expect(res.rows.map((x) => x.name)).not.toContain('Other');
    await core.idle();
  });

  it('refresh keeps the cached listing of a root that is missing on disk', async () => {
    const rootB = path.join(tmp, 'rootB');
    write(path.join(rootB, 'Other.cmir'));
    const core = makeCore();
    await core.configure([rootA, rootB]);
    await core.idle();
    changed = [];

    fs.renameSync(rootB, path.join(tmp, 'rootB-unplugged'));
    const r = await core.refresh([rootA, rootB]);
    expect(r.missingRoots).toEqual([rootB]);
    expect(r.files).toBe(3); // rootB's cached entry still counts
    expect(changed).toEqual([]);
    const res = await core.query(q({ roots: [rootA, rootB] }));
    expect(res.rows.map((x) => x.name)).toContain('Other');
    await core.idle();
  });

  it('browses a root: subfolders then direct files, and steps into a folder', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const b = (relativeDirectory: string, query = '') =>
      core.browse({ ...q(), location: { root: rootA, relativeDirectory }, query });
    const top = await b('');
    expect(top.valid).toBe(true);
    expect(top.rows.map((r) => (r.kind === 'folder' ? `[${r.name}]` : r.name))).toEqual(['[Neg]', 'Warming Aff']);
    const neg = await b('Neg');
    expect(neg.rows.map((r) => (r.kind === 'folder' ? `[${r.name}]` : r.name))).toEqual(['Warming Neg']);
    // Search-this-folder reaches below the root and reports the sub-path.
    const found = await b('', 'warming neg');
    expect(found.rows.map((r) => (r.kind === 'file' ? [r.name, r.subPath] : r.name))).toEqual([['Warming Neg', 'Neg']]);
  });

  it('refuses a root outside the configured set and any escape from a root', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const other = path.join(tmp, 'other');
    expect((await core.browse({ ...q(), location: { root: other, relativeDirectory: '' }, query: '' })).valid).toBe(false);
    expect((await core.browse({ ...q(), location: { root: rootA, relativeDirectory: '..' }, query: '' })).valid).toBe(false);
    expect((await core.browse({ ...q(), location: { root: rootA, relativeDirectory: path.join('Neg', '..', '..') }, query: '' })).valid).toBe(false);
    expect((await core.browse({ ...q(), location: { root: rootA, relativeDirectory: 'Nope' }, query: '' })).valid).toBe(false);
  });

  it('a folder disappears from the browser when its files are excluded', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const res = await core.browse({
      ...q(),
      exclusions: [path.join(rootA, 'Neg')],
      location: { root: rootA, relativeDirectory: '' },
      query: '',
    });
    expect(res.rows.map((r) => r.kind)).toEqual(['file']);
  });

  it('locates the open document in the deepest root, or says why not', async () => {
    const core = makeCore();
    await core.configure([rootA]);
    await core.idle();
    const neg = path.join(rootA, 'Neg', 'Warming Neg.docx');
    expect(await core.locateCurrentFile({ filePath: neg, roots: [rootA], exclusions: [] })).toEqual({
      ok: true,
      location: { root: rootA, relativeDirectory: 'Neg' },
    });
    expect(await core.locateCurrentFile({ filePath: neg, roots: [rootA, path.join(rootA, 'Neg')], exclusions: [] })).toEqual({
      ok: true,
      location: { root: path.join(rootA, 'Neg'), relativeDirectory: '' },
    });
    expect(await core.locateCurrentFile({ filePath: path.join(tmp, 'x.cmir'), roots: [rootA], exclusions: [] })).toEqual({
      ok: false,
      reason: 'outside-roots',
    });
    expect(await core.locateCurrentFile({ filePath: neg, roots: [rootA], exclusions: [path.join(rootA, 'Neg')] })).toEqual({
      ok: false,
      reason: 'excluded',
    });
  });
});
