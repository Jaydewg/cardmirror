/**
 * Folder browsing derived from the file index — the pure, separator-
 * agnostic half shared by the index service (`file-index-core.ts`, native
 * `path.sep`) and the palette test fake (`/`). Nothing here touches the
 * filesystem: a "folder" exists only while an indexed file sits beneath it,
 * so the browser can never show more than the file search already can.
 *
 * Two views over one directory:
 *   - empty query → the navigation view: this directory's immediate
 *     subfolders (A→Z), then its direct files ranked by the tiebreak;
 *   - a query → search-this-folder: folders at ANY depth beneath the
 *     directory whose NAME matches every token (shallowest first, then
 *     A→Z, each carrying the sub-path it lives in — 2026-10-24: they used
 *     to be the immediate subfolders only), then every file beneath the
 *     directory (any depth) ranked by the shared file matcher, each
 *     carrying its sub-path.
 * Pinned files float above the rest in both views, as `f`-mode does.
 */

import {
  matchesAllTokens,
  searchFiles,
  tokenizeQuery,
  type FileEntry,
  type FileTiebreak,
  type FolderPriority,
} from './file-search.js';
import type { FileBrowseResult, FileBrowseRow } from './file-index-protocol.js';

/** Validate + normalize a directory relative to a root: '' is the root
 *  itself; `..` segments, absolute paths and drive letters are rejected
 *  (null). Separators are unified to `sep`; empty and `.` segments drop. */
export function normalizeRelativeDirectory(rel: string, sep: string): string | null {
  if (/^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return null;
  return parts.join(sep);
}

/** `relPath` split into segments below `relDir`, or null when the file is
 *  not beneath it. `relDir` must already be normalized (see above). */
function segmentsBelow(relPath: string, relDir: string, sep: string): string[] | null {
  if (relDir === '') return relPath.split(sep).filter(Boolean);
  const prefix = relDir + sep;
  if (!relPath.startsWith(prefix)) return null;
  return relPath.slice(prefix.length).split(sep).filter(Boolean);
}

export interface BrowseInput {
  /** Visible entries of the ONE root being browsed (already exclusion- and
   *  format-filtered by the caller). */
  entries: readonly FileEntry[];
  /** Normalized directory relative to that root ('' = the root). */
  relDir: string;
  query: string;
  sep: string;
  tiebreak: FileTiebreak;
  folderPriority?: FolderPriority;
  pins: readonly string[];
  limit: number;
}

export function deriveBrowse(input: BrowseInput): FileBrowseResult {
  const { entries, relDir, sep, tiebreak, limit } = input;
  const tokens = tokenizeQuery(input.query);
  const pins = new Set(input.pins);

  const folders = new Map<string, { name: string; relativeDirectory: string; subPath: string; depth: number }>();
  const candidates: Array<{ entry: FileEntry; subPath: string }> = [];
  let anyBelow = false;
  for (const entry of entries) {
    const parts = segmentsBelow(entry.relPath, relDir, sep);
    if (!parts || parts.length === 0) continue;
    anyBelow = true;
    if (parts.length === 1) {
      candidates.push({ entry, subPath: '' });
      continue;
    }
    // Every directory on the file's path below relDir is a folder; the
    // navigation view shows only the immediate ones, the search view any
    // depth (keyed by its full relative directory, so two "Politics"
    // folders under different parents are two rows).
    const depthLimit = tokens.length > 0 ? parts.length - 1 : 1;
    for (let d = 1; d <= depthLimit; d++) {
      const below = parts.slice(0, d).join(sep);
      const relativeDirectory = relDir ? relDir + sep + below : below;
      if (!folders.has(relativeDirectory)) {
        folders.set(relativeDirectory, {
          name: parts[d - 1]!,
          relativeDirectory,
          subPath: parts.slice(0, d - 1).join(sep),
          depth: d,
        });
      }
    }
    // Only the search view reaches past the immediate children.
    if (tokens.length > 0) candidates.push({ entry, subPath: parts.slice(0, -1).join(sep) });
  }
  // A directory is real only while the index holds a file beneath it — the
  // palette walks upward when a branch has vanished.
  if (relDir !== '' && !anyBelow) return { rows: [], total: 0, valid: false };

  const folderRows: FileBrowseRow[] = [...folders.values()]
    .filter((f) => tokens.length === 0 || matchesAllTokens(f.name.toLowerCase(), '', tokens))
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.relativeDirectory.localeCompare(b.relativeDirectory, undefined, { sensitivity: 'base' }),
    )
    .map((f) => ({ kind: 'folder' as const, name: f.name, relativeDirectory: f.relativeDirectory, subPath: f.subPath }));

  const subPathOf = new Map(candidates.map((c) => [c.entry.path, c.subPath]));
  const ranked = searchFiles(candidates.map((c) => c.entry), input.query, tiebreak, input.folderPriority);
  const ordered = pins.size === 0
    ? ranked
    : [...ranked.filter((f) => pins.has(f.path)), ...ranked.filter((f) => !pins.has(f.path))];
  const fileRows: FileBrowseRow[] = ordered.map((f) => ({
    kind: 'file' as const,
    path: f.path,
    relPath: f.relPath,
    name: f.name,
    mtimeMs: f.mtimeMs,
    pinned: pins.has(f.path),
    subPath: subPathOf.get(f.path) ?? '',
  }));

  const rows = [...folderRows, ...fileRows];
  return { rows: rows.slice(0, Math.max(0, limit)), total: rows.length, valid: true };
}

/** Deepest of `roots` containing `filePath`, with the file's directory
 *  relative to it — pure string containment on `sep`, so the palette fake
 *  and the service agree. `null` when no root contains the file. */
export function locateInRoots(
  filePath: string,
  roots: readonly string[],
  sep: string,
): { root: string; relativeDirectory: string } | null {
  let best: { root: string; rel: string } | null = null;
  for (const root of roots) {
    const base = root.replace(/[\\/]+$/, '');
    if (!filePath.startsWith(base + sep)) continue;
    if (!best || base.length > best.root.length) best = { root, rel: filePath.slice(base.length + 1) };
  }
  if (!best) return null;
  const at = best.rel.lastIndexOf(sep);
  return { root: best.root, relativeDirectory: at < 0 ? '' : best.rel.slice(0, at) };
}

/**
 * The ROOTS-level search: `deriveBrowse` over every root with the root as
 * the directory, rows tagged with their root, folders (all roots) before
 * files (all roots), roots in the configured order. An empty query yields
 * nothing — the palette lists the roots itself for the navigation view.
 */
export function deriveBrowseAcrossRoots(
  roots: readonly string[],
  entriesFor: (root: string) => readonly FileEntry[],
  input: Omit<BrowseInput, 'entries' | 'relDir'>,
): FileBrowseResult {
  if (tokenizeQuery(input.query).length === 0) return { rows: [], total: 0, valid: true };
  const folderRows: FileBrowseRow[] = [];
  const fileRows: FileBrowseRow[] = [];
  for (const root of roots) {
    const r = deriveBrowse({ ...input, entries: entriesFor(root), relDir: '', limit: Number.MAX_SAFE_INTEGER });
    for (const row of r.rows) (row.kind === 'folder' ? folderRows : fileRows).push({ ...row, root });
  }
  const rows = [...folderRows, ...fileRows];
  return { rows: rows.slice(0, Math.max(0, input.limit)), total: rows.length, valid: true };
}
