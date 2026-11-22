/**
 * PLUGINS.md's permission table is GENERATED from the catalog
 * (src/editor/plugin-permissions.ts) and the call-time rule table
 * (src/editor/plugin-call-rules.ts), between the
 * `<!-- permission-table:start -->` / `:end` markers, and its section-3
 * API surface is COPIED from src/editor/plugin-api.ts between the
 * `<!-- api-surface:start -->` / `:end` markers. This test fails when
 * either drifts; `npm run docs:permissions` rewrites both blocks.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALL_TIME_PERMISSIONS } from '../../src/editor/plugin-call-rules.js';
import { PLUGIN_PERMISSIONS } from '../../src/editor/plugin-permissions.js';

const DOC = 'PLUGINS.md';
const START = '<!-- permission-table:start -->';
const END = '<!-- permission-table:end -->';
const SURFACE_START = '<!-- api-surface:start -->';
const SURFACE_END = '<!-- api-surface:end -->';
const API_SOURCE = 'src/editor/plugin-api.ts';

/** plugin-api.ts from the core types through the end of
 *  `CardMirrorPluginApi`, fenced. */
function apiSurface(): string {
  const src = readFileSync(API_SOURCE, 'utf8');
  const from = src.indexOf('export type ExtractedKind =');
  const iface = src.indexOf('export interface CardMirrorPluginApi {');
  const to = src.indexOf('\n}\n', iface);
  if (from < 0 || iface < 0 || to < 0) throw new Error(`${API_SOURCE}: surface anchors moved`);
  return [
    SURFACE_START,
    `<!-- Copied from ${API_SOURCE}. Do not edit by hand: run \`npm run docs:permissions\`. -->`,
    '',
    '```ts',
    src.slice(from, to + 2).trimEnd(),
    '```',
    '',
    SURFACE_END,
  ].join('\n');
}

/** Check (or, with CARDMIRROR_UPDATE_DOCS=1, rewrite) one generated block. */
function syncBlock(start: string, end: string, want: string): void {
  const doc = readFileSync(DOC, 'utf8');
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  expect(a, `${DOC} needs the ${start} marker`).toBeGreaterThanOrEqual(0);
  expect(b, `${DOC} needs the ${end} marker`).toBeGreaterThan(a);
  const current = doc.slice(a, b + end.length);
  if (process.env['CARDMIRROR_UPDATE_DOCS'] === '1' && current !== want) {
    writeFileSync(DOC, doc.slice(0, a) + want + doc.slice(b + end.length));
    return;
  }
  expect(current).toBe(want);
}

function permissionTable(): string {
  const unlocks = new Map<string, string[]>();
  for (const [ns, rules] of Object.entries(CALL_TIME_PERMISSIONS)) {
    for (const [method, rule] of Object.entries(rules)) {
      const list = unlocks.get(rule.permission) ?? [];
      list.push(`\`${ns}.${method}\``);
      unlocks.set(rule.permission, list);
    }
  }
  const rows = Object.entries(PLUGIN_PERMISSIONS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, info]) => `| \`${id}\` | ${info.sensitivity} | ${info.label} | ${(unlocks.get(id) ?? []).join(', ')} |`);
  return [
    START,
    '<!-- Generated from src/editor/plugin-permissions.ts and src/editor/plugin-call-rules.ts. Do not edit by hand: run `npm run docs:permissions`. -->',
    '',
    '| Permission | Sensitivity | Shown to the user as | Unlocks |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    END,
  ].join('\n');
}

describe('PLUGINS.md permission table', () => {
  it('matches the catalog (run `npm run docs:permissions` to regenerate)', () => {
    syncBlock(START, END, permissionTable());
  });

  it('section 3 matches plugin-api.ts (run `npm run docs:permissions` to regenerate)', () => {
    syncBlock(SURFACE_START, SURFACE_END, apiSurface());
  });

  it('every catalog permission unlocks at least one method', () => {
    const table = permissionTable();
    for (const id of Object.keys(PLUGIN_PERMISSIONS)) {
      expect(table, id).toMatch(new RegExp(`\\| \`${id.replace('.', '\\.')}\` \\|[^\\n]*\\| \`[a-z]+\\.[a-zA-Z]+\``));
    }
  });
});
