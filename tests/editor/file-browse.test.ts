/**
 * Folder browsing derived from the file index (file-browse.ts): the pure
 * listing shared by the index service and the palette fake. Covers the
 * navigation view (subfolders + direct files), the search view (any depth,
 * sub-paths, matching folder names), containment/validation, pins, the
 * window/total split, vanished branches, and Windows separators.
 */

import { describe, it, expect } from 'vitest';
import { makeFileEntry } from '../../src/editor/file-search.js';
import {
  deriveBrowse,
  locateInRoots,
  normalizeRelativeDirectory,
} from '../../src/editor/file-browse.js';

const entries = (sep = '/') =>
  [
    ['Warming Aff.cmir', 30],
    ['Neg/Warming Neg.docx', 20],
    ['Neg/Politics/Elections DA.cmir', 10],
    ['Neg/Politics/Deep/Fiat Solvency.cmir', 5],
    ['Aff/Advantages.cmir', 40],
  ].map(([rel, m]) => {
    const relPath = String(rel).split('/').join(sep);
    return makeFileEntry(`${sep === '/' ? '/root' : 'C:\\root'}${sep}${relPath}`, relPath, Number(m));
  });

const browse = (relDir: string, query = '', over: Partial<Parameters<typeof deriveBrowse>[0]> = {}) =>
  deriveBrowse({ entries: entries(), relDir, query, sep: '/', tiebreak: 'alphabetical', pins: [], limit: 50, ...over });

const names = (r: ReturnType<typeof deriveBrowse>) =>
  r.rows.map((row) => (row.kind === 'folder' ? `[${row.name}]` : row.name));

describe('normalizeRelativeDirectory', () => {
  it('accepts the root and clean relative paths, unifying separators', () => {
    expect(normalizeRelativeDirectory('', '/')).toBe('');
    expect(normalizeRelativeDirectory('Neg/Politics/', '/')).toBe('Neg/Politics');
    expect(normalizeRelativeDirectory('Neg\\Politics', '/')).toBe('Neg/Politics');
    expect(normalizeRelativeDirectory('./Neg', '\\')).toBe('Neg');
  });
  it('rejects escapes: .. segments, absolute paths, drive letters', () => {
    expect(normalizeRelativeDirectory('..', '/')).toBeNull();
    expect(normalizeRelativeDirectory('Neg/../..', '/')).toBeNull();
    expect(normalizeRelativeDirectory('/etc', '/')).toBeNull();
    expect(normalizeRelativeDirectory('C:\\Users', '\\')).toBeNull();
  });
});

describe('deriveBrowse — navigation view (empty query)', () => {
  it('lists subfolders A→Z then direct files, never deeper files', () => {
    expect(names(browse(''))).toEqual(['[Aff]', '[Neg]', 'Warming Aff']);
    expect(names(browse('Neg'))).toEqual(['[Politics]', 'Warming Neg']);
    expect(names(browse('Neg/Politics'))).toEqual(['[Deep]', 'Elections DA']);
  });
  it('a folder exists only while an indexed file sits beneath it', () => {
    expect(browse('Neg/Nope').valid).toBe(false);
    expect(browse('Neg').valid).toBe(true);
    expect(browse('').valid).toBe(true);
  });
  it('windows the rows but reports the full total', () => {
    const r = browse('', '', { limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBe(3);
  });
  it('honors the tiebreak for direct files', () => {
    const many = [makeFileEntry('/root/b.cmir', 'b.cmir', 1), makeFileEntry('/root/a.cmir', 'a.cmir', 2)];
    const recency = deriveBrowse({ entries: many, relDir: '', query: '', sep: '/', tiebreak: 'recency', pins: [], limit: 9 });
    expect(recency.rows.map((r) => r.kind === 'file' && r.name)).toEqual(['a', 'b']);
  });
});

describe('deriveBrowse — search view (query)', () => {
  it('finds files at any depth below the folder, each with its sub-path', () => {
    const r = browse('Neg', 'da');
    const files = r.rows.filter((row) => row.kind === 'file');
    expect(files.map((f) => f.kind === 'file' && [f.name, f.subPath])).toEqual([['Elections DA', 'Politics']]);
  });
  it('folders appear only when their name matches, before the files', () => {
    // "neg" also reaches the files INSIDE Neg through their folder path —
    // the shared matcher's secondary field — ranked below the name hit.
    expect(names(browse('', 'neg'))).toEqual(['[Neg]', 'Warming Neg', 'Elections DA', 'Fiat Solvency']);
    expect(names(browse('', 'warming'))).toEqual(['Warming Aff', 'Warming Neg']);
  });
  it('matching folders at any depth below the browsed folder appear, shallowest first, with their sub-path', () => {
    // "politics" is two levels down from the root: a folder row now, not
    // only the files inside it (2026-10-24; it used to be immediate
    // subfolders only).
    const r = browse('', 'politics');
    expect(names(r)).toEqual(['[Politics]', 'Elections DA', 'Fiat Solvency']);
    expect(r.rows[0]).toMatchObject({ kind: 'folder', relativeDirectory: 'Neg/Politics', subPath: 'Neg' });
    // From inside Neg the same folder is an immediate child (empty sub-path),
    // and its own child shows beneath it.
    const deep = browse('Neg', 'e');
    expect(names(deep).filter((n) => n.startsWith('['))).toEqual(['[Deep]']);
    expect(deep.rows[0]).toMatchObject({ kind: 'folder', relativeDirectory: 'Neg/Politics/Deep', subPath: 'Politics' });
    // The navigation view (no query) still lists only the immediate subfolders.
    expect(names(browse('Neg'))).toEqual(['[Politics]', 'Warming Neg']);
  });
  it('stays inside the browsed folder', () => {
    expect(names(browse('Aff', 'warming'))).toEqual([]);
    expect(names(browse('Neg/Politics', 'fiat'))).toEqual(['Fiat Solvency']);
  });
  it('floats pinned files above the rest', () => {
    const r = browse('', 'warming', { pins: ['/root/Neg/Warming Neg.docx'] });
    expect(names(r)).toEqual(['Warming Neg', 'Warming Aff']);
    expect(r.rows[0]!.kind === 'file' && r.rows[0]!.pinned).toBe(true);
  });
});

describe('deriveBrowse — Windows separators', () => {
  it('splits on the service separator', () => {
    const r = deriveBrowse({ entries: entries('\\'), relDir: 'Neg', query: '', sep: '\\', tiebreak: 'alphabetical', pins: [], limit: 50 });
    expect(names(r)).toEqual(['[Politics]', 'Warming Neg']);
    const politics = r.rows[0];
    expect(politics!.kind === 'folder' && politics!.relativeDirectory).toBe('Neg\\Politics');
  });
});

describe('locateInRoots', () => {
  const roots = ['/root', '/root/Neg', '/elsewhere'];
  it('picks the deepest root containing the file and returns its folder', () => {
    expect(locateInRoots('/root/Neg/Politics/Elections DA.cmir', roots, '/')).toEqual({
      root: '/root/Neg',
      relativeDirectory: 'Politics',
    });
    expect(locateInRoots('/root/Warming Aff.cmir', roots, '/')).toEqual({ root: '/root', relativeDirectory: '' });
  });
  it('is null outside every root, and a sibling with a shared prefix does not count', () => {
    expect(locateInRoots('/tmp/x.cmir', roots, '/')).toBeNull();
    expect(locateInRoots('/rootage/x.cmir', roots, '/')).toBeNull();
  });
  it('tolerates a trailing separator on the root', () => {
    expect(locateInRoots('/root/Neg/x.cmir', ['/root/'], '/')).toEqual({ root: '/root/', relativeDirectory: 'Neg' });
  });
});
