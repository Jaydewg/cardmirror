/**
 * "Refresh File Search Index" — the user-invoked, immediate re-walk of
 * every file search folder (unbound by default; run it from Search
 * Everything).
 *
 * The index otherwise refreshes itself only when the palette opens (a
 * delayed revalidation walk) and when the folder list changes in
 * Settings. This command is the escape hatch for the in-between moments:
 * a document saved to a search folder from Word or Finder, a cloud sync
 * that just landed, a folder renamed on disk. It forces the service to
 * walk every root right now, waits for the walk to finish, and reports
 * what it found in a toast (files indexed, files changed, folders that
 * no longer exist on disk).
 *
 * Deps are injectable so the flow is unit-testable without a service.
 */

import { settings } from './settings.js';
import { showToast } from './toast.js';
import { getFileIndexClient, type FileIndexClient } from './file-search-client.js';
import type { FileIndexRefreshResult } from './file-index-protocol.js';

export interface RefreshFileSearchIndexDeps {
  getClient: () => Promise<FileIndexClient | null>;
  roots: () => string[];
  toast: (message: string, opts?: { durationMs?: number }) => void;
}

const defaultDeps: RefreshFileSearchIndexDeps = {
  getClient: getFileIndexClient,
  roots: () => settings.get('fileSearchRoots'),
  toast: (message, opts) => showToast(message, opts),
};

let inFlight: Promise<void> | null = null;

/** Run the refresh (at most one at a time — a second invocation while a
 *  walk is running just says so and joins it). */
export function refreshFileSearchIndex(deps: RefreshFileSearchIndexDeps = defaultDeps): Promise<void> {
  if (inFlight) {
    deps.toast('File search index refresh is already running.');
    return inFlight;
  }
  inFlight = run(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(deps: RefreshFileSearchIndexDeps): Promise<void> {
  const roots = deps.roots();
  if (roots.length === 0) {
    deps.toast('No file search folders are set up — add some under Settings → Files.');
    return;
  }
  const client = await deps.getClient();
  if (!client) {
    deps.toast('File search is a desktop feature.');
    return;
  }
  // Short-lived: a large library's walk takes seconds, and the result
  // toast lands on top of this one when it is quick.
  deps.toast(`Refreshing file search index (${plural(roots.length, 'folder')})…`, { durationMs: 1200 });
  let result: FileIndexRefreshResult;
  try {
    result = await client.refresh(roots);
  } catch {
    deps.toast('File search index refresh failed — try again, or restart CardMirror.');
    return;
  }
  deps.toast(refreshSummary(result));
}

/** The result toast's text. */
export function refreshSummary(r: FileIndexRefreshResult): string {
  const change = r.changedFiles === 0 ? 'no changes' : `${r.changedFiles} changed`;
  let msg = `File search index refreshed: ${plural(r.files, 'file')} in ${plural(r.roots, 'folder')}, ${change}.`;
  const missing = r.missingRoots.length;
  if (missing > 0) {
    msg += ` ${missing === 1 ? '1 folder is' : `${missing} folders are`} missing on disk — check Settings → Files.`;
  }
  return msg;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
