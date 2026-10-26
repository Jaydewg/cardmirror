/**
 * File → Open Recent / Rejoin Recent Session payload (menu-recents.ts):
 * mirrors the home screen's Recent and Sessions lists — reopenable
 * recents only, saved session records with the role spelled out, both
 * capped like the home lists, sessions hidden while the gate is closed.
 */
import { describe, expect, it } from 'vitest';
import { buildMenuRecents, MENU_RECENTS_MAX, roleWord } from '../../src/editor/menu-recents.js';
import type { RecentFile } from '../../src/editor/recents-store.js';
import type { PersistedSessionRecord } from '../../src/editor/collab/collab-store.js';

const rf = (filename: string, handle: string | null): RecentFile => ({ handle, filename, format: 'cmir', lastOpenedAt: 1 });
const rec = (roomId: string, role: PersistedSessionRecord['role'], docTitle: string): PersistedSessionRecord =>
  ({ roomId, role, docTitle } as PersistedSessionRecord);

describe('buildMenuRecents', () => {
  it('lists reopenable recents by filename and skips handle-less (web) entries', () => {
    const p = buildMenuRecents([rf('Aff.cmir', '/d/Aff.cmir'), rf('Web.cmir', null), rf('Neg.docx', '/d/Neg.docx')], []);
    expect(p.files).toEqual([
      { label: 'Aff.cmir', handle: '/d/Aff.cmir' },
      { label: 'Neg.docx', handle: '/d/Neg.docx' },
    ]);
  });

  it('spells out the role on each saved session; null records (gate closed) → none', () => {
    const p = buildMenuRecents([], [rec('r1', 'host', 'Aff Updates'), rec('r2', 'participant', ''), rec('r3', 'spectator', 'Neg')]);
    expect(p.sessions.map((s) => s.label)).toEqual([
      'Aff Updates — hosting',
      'Collaboration session — joined',
      'Neg — watching',
    ]);
    expect(p.sessions[2]).toMatchObject({ roomId: 'r3', role: 'spectator' });
    expect(buildMenuRecents([], null).sessions).toEqual([]);
    expect(roleWord('host')).toBe('hosting');
  });

  it('caps both lists like the home screen', () => {
    const files = Array.from({ length: 14 }, (_, i) => rf(`f${i}.cmir`, `/d/f${i}.cmir`));
    const recs = Array.from({ length: 14 }, (_, i) => rec(`r${i}`, 'participant', `t${i}`));
    const p = buildMenuRecents(files, recs);
    expect(p.files).toHaveLength(MENU_RECENTS_MAX);
    expect(p.sessions).toHaveLength(MENU_RECENTS_MAX);
  });
});
