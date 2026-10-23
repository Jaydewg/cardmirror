/**
 * No two built-in commands may share a default key: buildRibbonKeymap has no
 * collision check for the static set, so the later-registered command wins
 * silently (audit item 25: Subscript and Zoom In both claimed Mod-=).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RIBBON_KEYS, foldKeyString } from '../../src/editor/ribbon-commands.js';

describe('DEFAULT_RIBBON_KEYS', () => {
  it('assigns each default chord to exactly one command', () => {
    const owners = new Map<string, string[]>();
    for (const [id, spec] of Object.entries(DEFAULT_RIBBON_KEYS)) {
      const keys = Array.isArray(spec) ? spec : spec ? [spec] : [];
      for (const k of keys) {
        const f = foldKeyString(k);
        owners.set(f, [...(owners.get(f) ?? []), id]);
      }
    }
    const dupes = [...owners.entries()].filter(([, ids]) => ids.length > 1);
    expect(dupes, JSON.stringify(dupes)).toEqual([]);
  });
});
