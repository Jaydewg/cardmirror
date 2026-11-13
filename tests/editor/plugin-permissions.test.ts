import { describe, expect, it } from 'vitest';
import {
  MAX_PERMISSIONS,
  PERMISSION_ID_RE,
  PLUGIN_PERMISSIONS,
  isKnownPermission,
  permissionStatus,
  resolveGrant,
  sanitizePermissionList,
  splitKnown,
} from '../../src/editor/plugin-permissions.js';
import {
  MAX_PERMISSIONS as MAIN_MAX_PERMISSIONS,
  PERMISSION_ID_RE as MAIN_PERMISSION_ID_RE,
  PLUGIN_API_VERSION as MAIN_PLUGIN_API_VERSION,
  sanitizePermissionList as mainSanitize,
} from '../../apps/desktop/src/plugin-manager.js';
import { PLUGIN_API_VERSION } from '../../src/editor/plugin-registry.js';

describe('sanitizePermissionList', () => {
  it('keeps well-formed ids, sorted and deduplicated', () => {
    expect(sanitizePermissionList(['ui.dialogs', 'files.data', 'ui.dialogs'])).toEqual([
      'files.data',
      'ui.dialogs',
    ]);
  });
  it('drops off-shape entries instead of rejecting the list', () => {
    expect(
      sanitizePermissionList(['ui.dialogs', 'UI.dialogs', 'nodots', 'a.', '.b', 'ui.dia-logs', 7, null, {}]),
    ).toEqual(['ui.dialogs']);
  });
  it('treats non-arrays as empty', () => {
    expect(sanitizePermissionList(undefined)).toEqual([]);
    expect(sanitizePermissionList('ui.dialogs')).toEqual([]);
    expect(sanitizePermissionList({ 0: 'ui.dialogs' })).toEqual([]);
  });
  it('caps the list length', () => {
    const many = Array.from({ length: 100 }, (_, i) => `ns.p${String.fromCharCode(97 + (i % 26))}x${'y'.repeat(i)}`);
    expect(sanitizePermissionList(many)).toHaveLength(MAX_PERMISSIONS);
  });
});

describe('main/renderer parity (main keeps copies; they must never drift)', () => {
  it('same apiVersion, id shape and list cap', () => {
    expect(MAIN_PLUGIN_API_VERSION).toBe(PLUGIN_API_VERSION);
    expect(MAIN_PERMISSION_ID_RE.source).toBe(PERMISSION_ID_RE.source);
    expect(MAIN_PERMISSION_ID_RE.flags).toBe(PERMISSION_ID_RE.flags);
    expect(MAIN_MAX_PERMISSIONS).toBe(MAX_PERMISSIONS);
  });
  it('same sanitizer output on every vector', () => {
    const vectors: unknown[] = [
      ['ui.dialogs', 'Bad', 'collab.shareCode', 'x.y.z', 'ui.dialogs', 3],
      Object.keys(PLUGIN_PERMISSIONS),
      ['UI.dialogs', 'nodots', 'a.', '.b', 'ui.dia-logs', 'a.b.', 'a..b', null, {}, ['ui.dialogs']],
      Array.from({ length: 80 }, (_, i) => `ns.p${'q'.repeat(i)}`),
      undefined,
      'ui.dialogs',
      { 0: 'ui.dialogs' },
    ];
    for (const v of vectors) expect(mainSanitize(v)).toEqual(sanitizePermissionList(v));
  });
});

describe('catalog helpers', () => {
  it('knows ui.dialogs and nothing made up', () => {
    expect(isKnownPermission('ui.dialogs')).toBe(true);
    expect(isKnownPermission('made.up')).toBe(false);
    expect(isKnownPermission('toString')).toBe(false); // no prototype leaks
  });
  it('splitKnown separates supported from unsupported', () => {
    expect(splitKnown(['made.up', 'ui.dialogs'])).toEqual({ known: ['ui.dialogs'], unknown: ['made.up'] });
  });
});

describe('resolveGrant', () => {
  it('is consented ∩ declared ∩ known', () => {
    expect([...resolveGrant(['ui.dialogs', 'made.up'], ['ui.dialogs', 'made.up'])]).toEqual(['ui.dialogs']);
  });
  it('a definition cannot widen consent', () => {
    expect([...resolveGrant([], ['ui.dialogs'])]).toEqual([]);
  });
  it('consent cannot conjure an undeclared permission', () => {
    expect([...resolveGrant(['ui.dialogs'], [])]).toEqual([]);
  });
});

describe('permissionStatus', () => {
  const granted = new Set(['ui.dialogs']);
  it('reports granted / denied / unsupported / undeclared', () => {
    expect(permissionStatus('ui.dialogs', ['ui.dialogs'], granted)).toBe('granted');
    expect(permissionStatus('ui.dialogs', ['ui.dialogs'], new Set())).toBe('denied');
    expect(permissionStatus('made.up', ['made.up'], granted)).toBe('unsupported');
    expect(permissionStatus('ui.dialogs', [], granted)).toBe('undeclared');
  });
});
