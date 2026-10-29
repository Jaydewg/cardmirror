/**
 * "Refresh File Search Index" flow (file-index-refresh.ts) with an
 * injected service client: the no-folders and no-desktop early outs, the
 * start + result toasts, the failure toast, the one-at-a-time guard, and
 * the summary wording.
 */

import { describe, it, expect } from 'vitest';
import { refreshFileSearchIndex, refreshSummary } from '../../src/editor/file-index-refresh.js';
import type { FileIndexClient } from '../../src/editor/file-search-client.js';
import type { FileIndexRefreshResult } from '../../src/editor/file-index-protocol.js';

function fakeClient(refresh: FileIndexClient['refresh']): FileIndexClient {
  const nope = () => Promise.reject(new Error('not used'));
  return {
    configure: () => Promise.resolve(),
    refresh,
    query: nope,
    browse: nope,
    locateCurrentFile: nope,
    entriesForPaths: nope,
    onChanged: () => () => {},
  };
}

const ok: FileIndexRefreshResult = { roots: 2, files: 1234, changedFiles: 3, missingRoots: [] };

function harness(client: FileIndexClient | null, roots = ['/a', '/b']) {
  const toasts: string[] = [];
  return {
    toasts,
    deps: {
      getClient: () => Promise.resolve(client),
      roots: () => roots,
      toast: (m: string) => {
        toasts.push(m);
      },
    },
  };
}

describe('refreshFileSearchIndex', () => {
  it('says so when no folders are configured, without touching the service', async () => {
    const h = harness(fakeClient(() => Promise.reject(new Error('must not be called'))), []);
    await refreshFileSearchIndex(h.deps);
    expect(h.toasts).toEqual(['No file search folders are set up — add some under Settings → Files.']);
  });

  it('says so off the desktop (no service client)', async () => {
    const h = harness(null);
    await refreshFileSearchIndex(h.deps);
    expect(h.toasts).toEqual(['File search is a desktop feature.']);
  });

  it('announces the walk, passes the roots through, and reports the result', async () => {
    let seen: string[] | null = null;
    const h = harness(
      fakeClient((roots) => {
        seen = roots;
        return Promise.resolve(ok);
      }),
    );
    await refreshFileSearchIndex(h.deps);
    expect(seen).toEqual(['/a', '/b']);
    expect(h.toasts).toEqual([
      'Refreshing file search index (2 folders)…',
      'File search index refreshed: 1234 files in 2 folders, 3 changed.',
    ]);
  });

  it('reports a failed walk instead of throwing', async () => {
    const h = harness(fakeClient(() => Promise.reject(new Error('file-index request timeout'))));
    await expect(refreshFileSearchIndex(h.deps)).resolves.toBeUndefined();
    expect(h.toasts.at(-1)).toBe('File search index refresh failed — try again, or restart CardMirror.');
  });

  it('runs one walk at a time; a second call joins the first', async () => {
    let release!: (r: FileIndexRefreshResult) => void;
    let calls = 0;
    const h = harness(
      fakeClient(
        () =>
          new Promise<FileIndexRefreshResult>((resolve) => {
            calls++;
            release = resolve;
          }),
      ),
    );
    const first = refreshFileSearchIndex(h.deps);
    await Promise.resolve(); // let the first call reach the service
    const second = refreshFileSearchIndex(h.deps);
    expect(h.toasts).toContain('File search index refresh is already running.');
    release(ok);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    // And the guard is released afterwards.
    await refreshFileSearchIndex(harness(fakeClient(() => Promise.resolve(ok))).deps);
  });
});

describe('refreshSummary', () => {
  it('pluralizes and names the no-change case', () => {
    expect(refreshSummary({ roots: 1, files: 1, changedFiles: 0, missingRoots: [] })).toBe(
      'File search index refreshed: 1 file in 1 folder, no changes.',
    );
  });

  it('points at Settings when folders are missing on disk', () => {
    expect(refreshSummary({ roots: 3, files: 40, changedFiles: 2, missingRoots: ['/x'] })).toBe(
      'File search index refreshed: 40 files in 3 folders, 2 changed. 1 folder is missing on disk — check Settings → Files.',
    );
    expect(refreshSummary({ roots: 3, files: 0, changedFiles: 0, missingRoots: ['/x', '/y'] })).toContain(
      '2 folders are missing on disk',
    );
  });
});
