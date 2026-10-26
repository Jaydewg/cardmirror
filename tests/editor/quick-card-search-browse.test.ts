// @vitest-environment jsdom
/**
 * Folder browsing in the palette (`/ ` and `/c `, 2026-09-18): the prefix
 * names where you start, Enter/Tab and Esc move you, the query searches the
 * folder you are in, and only a CHANGE of prefix relocates. Drives the real
 * singleton over the in-memory index fake (the same listing derivation the
 * service runs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hostState = vi.hoisted(() => ({
  files: [] as Array<{ path: string; relPath: string; mtimeMs: number; size: number }>,
}));

vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return { ...mod, getElectronHost: () => ({ readFileAtPath: async () => null }) };
});

vi.mock('../../src/editor/file-search-client.js', async () => {
  const { makeFakeFileIndexClient } = await import('./_fake-file-index.js');
  return {
    getFileIndexClient: async () => makeFakeFileIndexClient(hostState),
    setFileIndexClientForTests: () => {},
  };
});

import { quickCardSearchUI } from '../../src/editor/quick-card-search-ui.js';
import { settings } from '../../src/editor/settings.js';

function openPalette(docPath: string | null = null): void {
  quickCardSearchUI.open({ view: null, paneEl: null, runCommand: () => {}, openFilePath: () => {}, docPath });
}
const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.pmd-qcs-input')!;
function type(q: string): void {
  input().value = q;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}
function key(k: string): void {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Visible rows as "BADGE name" strings. */
const rows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.pmd-qcs-row')].map((row) =>
    `${row.querySelector('.pmd-qcs-row-badge')?.textContent ?? ''} ${row.querySelector('.pmd-qcs-row-name')?.textContent ?? ''}`.trim(),
  );
const header = (): string => document.querySelector<HTMLElement>('.pmd-qcs-browse-header')?.textContent ?? '';
const notice = (): HTMLElement => document.querySelector<HTMLElement>('.pmd-qcs-browse-notice')!;
const empty = (): string => document.querySelector('.pmd-qcs-empty')?.textContent ?? '';

const file = (relPath: string, mtimeMs: number) => ({ path: `/root/${relPath}`, relPath, mtimeMs, size: 1 });

beforeEach(() => {
  hostState.files = [
    file('Warming Aff.cmir', 30),
    file('Neg/Warming Neg.docx', 20),
    file('Neg/Politics/Elections DA.cmir', 10),
    file('Aff/Advantages.cmir', 40),
  ];
  settings.set('fileSearchRoots', ['/root']);
  settings.set('fileSearchExclusions', []);
  settings.set('fileSearchTiebreak', 'alphabetical');
});

afterEach(() => {
  if (quickCardSearchUI.isOpen()) quickCardSearchUI.close();
  document.body.innerHTML = '';
});

describe('palette folder browse', () => {
  it('a bare "/" is a prefix in progress: a hint, no rows, no everything-search flash', async () => {
    openPalette();
    await settle();
    type('/');
    await settle();
    expect(rows()).toEqual([]);
    expect(empty()).toContain('Add a space');
    expect(document.querySelector('.pmd-qcs-browse-header')?.hasAttribute('hidden')).toBe(true);
  });

  it('"/ " lists the roots; Enter steps into one, Tab into a subfolder, with the query cleared', async () => {
    openPalette();
    await settle();
    type('/ ');
    await settle();
    expect(rows()).toEqual(['ROOT root']);
    expect(header()).toContain('Browse folders');
    key('Enter');
    await settle();
    expect(rows()).toEqual(['DIR Aff', 'DIR Neg', 'CMIR Warming Aff']);
    expect(input().value).toBe('/ ');
    expect(header()).toContain('root');
    // Filter, then Tab into the matching folder: the filter is dropped.
    type('/ ne');
    await settle();
    expect(rows()[0]).toBe('DIR Neg');
    key('Tab');
    await settle();
    expect(input().value).toBe('/ ');
    expect(rows()).toEqual(['DIR Politics', 'DOCX Warming Neg']);
    expect(header()).toContain('Neg');
  });

  it('text after the prefix searches the current folder at any depth, showing the sub-path', async () => {
    openPalette();
    await settle();
    type('/ ');
    await settle();
    key('Enter'); // into /root
    await settle();
    type('/ elections');
    await settle();
    expect(rows()).toEqual(['CMIR Elections DA']);
    expect(document.querySelector('.pmd-qcs-row')?.textContent).toContain('Neg / Politics');
    // Scoped: the same query from inside Aff finds nothing.
    type('/ ');
    await settle();
    key('ArrowDown'); // 'DIR Aff' is row 0 already; make the intent explicit
    key('ArrowUp');
    key('Enter'); // into Aff
    await settle();
    type('/ elections');
    await settle();
    expect(rows()).toEqual([]);
    expect(empty()).toContain('Nothing in this folder matches');
  });

  it('at the roots level a query searches EVERY root: matching roots, then folders at any depth, then files, each led by its root', async () => {
    hostState.files = [
      ...hostState.files,
      { path: '/other/Impact/Impact Defense/ID 2026.cmir', relPath: 'Impact/Impact Defense/ID 2026.cmir', mtimeMs: 5, size: 1 },
    ];
    settings.set('fileSearchRoots', ['/root', '/other']);
    openPalette();
    await settle();
    type('/ impact');
    await settle();
    // No root is named "impact"; the folders inside /other match by name
    // (shallowest first), then the file whose path carries the token.
    expect(rows()).toEqual(['DIR Impact', 'DIR Impact Defense', 'CMIR ID 2026']);
    const metas = [...document.querySelectorAll<HTMLElement>('.pmd-qcs-row')].map((r) => r.textContent ?? '');
    expect(metas[0]).toContain('other');
    expect(metas[1]).toContain('other / Impact');
    // Tab steps into the matched folder in ITS root; the header shows it.
    key('ArrowDown');
    key('Tab');
    await settle();
    expect(header()).toContain('Impact Defense');
    // A root whose own name matches still leads the list (fresh open).
    openPalette(); // toggles closed
    await settle();
    openPalette();
    await settle();
    type('/ root');
    await settle();
    expect(rows()[0]).toBe('ROOT root');
  });

  it('Esc steps up a level, drops the query, and closes from the roots', async () => {
    openPalette();
    await settle();
    type('/ ');
    await settle();
    key('Enter'); // /root
    await settle();
    key('ArrowDown'); // DIR Neg
    key('Enter');
    await settle();
    expect(header()).toContain('Neg');
    type('/ warm');
    await settle();
    key('Escape');
    await settle();
    expect(input().value).toBe('/ ');
    expect(rows()).toEqual(['DIR Aff', 'DIR Neg', 'CMIR Warming Aff']);
    key('Escape');
    await settle();
    expect(rows()).toEqual(['ROOT root']);
    key('Escape');
    expect(quickCardSearchUI.isOpen()).toBe(false);
  });

  it('"/c " starts in the document’s folder, and typing after navigating away does not snap back', async () => {
    openPalette('/root/Neg/Politics/Elections DA.cmir');
    await settle();
    type('/c ');
    await settle();
    expect(header()).toContain('Politics');
    expect(rows()).toEqual(['CMIR Elections DA']);
    key('Escape'); // up to Neg
    await settle();
    expect(header()).toContain('Neg');
    type('/c warm');
    await settle();
    expect(header()).toContain('Neg'); // still Neg: only a prefix change relocates
    expect(rows()).toEqual(['DOCX Warming Neg']);
    // Dropping the c IS a prefix change: back to the roots — where a query
    // now searches every root (2026-10-24), each hit led by its root.
    type('/ warm');
    await settle();
    expect(rows()).toEqual(['CMIR Warming Aff', 'DOCX Warming Neg']);
    expect(document.querySelector('.pmd-qcs-row')?.textContent).toContain('root');
    type('/ ');
    await settle();
    expect(rows()).toEqual(['ROOT root']);
  });

  it('"/c " explains itself when the document has no indexed folder', async () => {
    openPalette('/elsewhere/Loose.cmir');
    await settle();
    type('/c ');
    await settle();
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toContain('not inside a file-search folder');
    expect(rows()).toEqual(['ROOT root']);
    quickCardSearchUI.close();

    openPalette(null);
    await settle();
    type('/c ');
    await settle();
    expect(notice().textContent).toContain('no saved location');
  });

  it('leaving the prefix returns to the ordinary search', async () => {
    openPalette();
    await settle();
    type('/ ');
    await settle();
    key('Enter');
    await settle();
    type('f warming');
    await settle();
    expect(document.querySelector('.pmd-qcs-browse-header')?.hasAttribute('hidden')).toBe(true);
    expect(rows().length).toBe(2);
  });
});
