/**
 * Behavior-faithful in-memory stand-in for the file-index service, for
 * palette tests. Built on the REAL matcher/filter primitives
 * (searchFiles / isPathExcluded / fileFormat / makeFileEntry) so ranked
 * order, exclusion semantics, and format filtering can't drift from the
 * service (file-index-core.ts mirrors this exact pipeline).
 */

import {
  makeFileEntry,
  searchFiles,
  isPathExcluded,
  fileFormat,
  type FileEntry,
} from '../../src/editor/file-search.js';
import type {
  FileBrowseParams,
  FileIndexClient,
  FileIndexQueryParams,
} from '../../src/editor/file-search-client.js';
import { deriveBrowse, deriveBrowseAcrossRoots, locateInRoots, normalizeRelativeDirectory } from '../../src/editor/file-browse.js';

export interface FakeFileListing {
  path: string;
  relPath: string;
  mtimeMs: number;
  size: number;
}

/** A FileIndexClient over a mutable listing array (share the array with
 *  the test's hostState so per-test rewrites are seen live). */
export function makeFakeFileIndexClient(listing: { files: FakeFileListing[] }): FileIndexClient {
  const changed = new Set<() => void>();

  function entries(params: { roots: string[]; exclusions: string[] }): FileEntry[] {
    // The fake ignores roots (the test listing IS the corpus) but honors
    // exclusions, mirroring the service's visibleEntries pipeline.
    const byPath = new Map<string, FileEntry>();
    for (const f of listing.files) {
      if (params.exclusions.length > 0 && isPathExcluded(f.path, params.exclusions)) continue;
      if (!byPath.has(f.path)) byPath.set(f.path, makeFileEntry(f.path, f.relPath, f.mtimeMs));
    }
    return [...byPath.values()];
  }

  return {
    configure: async () => {},
    refresh: async (roots: string[]) => ({
      roots: roots.length,
      files: listing.files.length,
      changedFiles: 0,
      missingRoots: [],
    }),
    query: async (params: FileIndexQueryParams) => {
      let pool = entries(params);
      if (params.formats !== 'both') {
        pool = pool.filter((f) => fileFormat(f.path) === params.formats);
      }
      const ranked = searchFiles(pool, params.query, params.tiebreak, params.folderPriority);
      const pins = new Set(params.pins);
      const ordered =
        !params.partitionPins || pins.size === 0
          ? ranked
          : [...ranked.filter((f) => pins.has(f.path)), ...ranked.filter((f) => !pins.has(f.path))];
      return {
        rows: ordered.slice(0, params.limit).map((f) => ({
          path: f.path,
          relPath: f.relPath,
          name: f.name,
          mtimeMs: f.mtimeMs,
          pinned: pins.has(f.path),
        })),
        total: ordered.length,
      };
    },
    // Browse rides the SAME pure derivation the service uses (file-browse.ts),
    // over '/' paths; only the root/exclusion plumbing is faked.
    browse: async (params: FileBrowseParams) => {
      const loc = params.location;
      if (loc === null) {
        const poolFor = (root: string) => {
          let pool = entries(params).filter((f) => f.path.startsWith(root + '/'));
          if (params.formats !== 'both') pool = pool.filter((f) => fileFormat(f.path) === params.formats);
          return pool;
        };
        return deriveBrowseAcrossRoots(params.roots, poolFor, {
          query: params.query,
          sep: '/',
          tiebreak: params.tiebreak,
          folderPriority: params.folderPriority,
          pins: params.pins,
          limit: params.limit,
        });
      }
      const relDir = normalizeRelativeDirectory(loc.relativeDirectory, '/');
      if (!params.roots.includes(loc.root) || relDir === null) {
        return { rows: [], total: 0, valid: false };
      }
      let pool = entries(params).filter((f) => f.path.startsWith(loc.root + '/'));
      if (params.formats !== 'both') pool = pool.filter((f) => fileFormat(f.path) === params.formats);
      return deriveBrowse({
        entries: pool,
        relDir,
        query: params.query,
        sep: '/',
        tiebreak: params.tiebreak,
        folderPriority: params.folderPriority,
        pins: params.pins,
        limit: params.limit,
      });
    },
    locateCurrentFile: async (args) => {
      const located = locateInRoots(args.filePath, args.roots, '/');
      if (!located) return { ok: false as const, reason: 'outside-roots' as const };
      if (isPathExcluded(args.filePath, args.exclusions)) return { ok: false as const, reason: 'excluded' as const };
      return { ok: true as const, location: located };
    },
    entriesForPaths: async (args) => {
      const wanted = new Set(args.paths);
      return entries(args)
        .filter((f) => wanted.has(f.path))
        .map((f) => ({ path: f.path, mtimeMs: f.mtimeMs }));
    },
    onChanged: (handler) => {
      changed.add(handler);
      return () => changed.delete(handler);
    },
  };
}
