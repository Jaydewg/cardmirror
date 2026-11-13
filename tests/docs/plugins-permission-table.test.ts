/**
 * PLUGINS.md's permission table is GENERATED from the catalog
 * (src/editor/plugin-permissions.ts) and the call-time rule table
 * (src/editor/plugin-call-rules.ts), between the
 * `<!-- permission-table:start -->` / `:end` markers. This test fails
 * when the doc drifts; `npm run docs:permissions` rewrites the block.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALL_TIME_PERMISSIONS } from '../../src/editor/plugin-call-rules.js';
import { PLUGIN_PERMISSIONS } from '../../src/editor/plugin-permissions.js';

const DOC = 'PLUGINS.md';
const START = '<!-- permission-table:start -->';
const END = '<!-- permission-table:end -->';

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
    const doc = readFileSync(DOC, 'utf8');
    const start = doc.indexOf(START);
    const end = doc.indexOf(END);
    expect(start, `${DOC} needs the ${START} marker`).toBeGreaterThanOrEqual(0);
    expect(end, `${DOC} needs the ${END} marker`).toBeGreaterThan(start);
    const current = doc.slice(start, end + END.length);
    const want = permissionTable();
    if (process.env['CARDMIRROR_UPDATE_DOCS'] === '1' && current !== want) {
      writeFileSync(DOC, doc.slice(0, start) + want + doc.slice(end + END.length));
      return;
    }
    expect(current).toBe(want);
  });

  it('every catalog permission unlocks at least one method', () => {
    const table = permissionTable();
    for (const id of Object.keys(PLUGIN_PERMISSIONS)) {
      expect(table, id).toMatch(new RegExp(`\\| \`${id.replace('.', '\\.')}\` \\|[^\\n]*\\| \`[a-z]+\\.[a-zA-Z]+\``));
    }
  });
});
