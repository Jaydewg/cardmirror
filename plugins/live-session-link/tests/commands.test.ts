import { describe, expect, it } from 'vitest';
import { ADDRESS, CODE, KEY, OTHER_SERVER, flush, linkFor, makeFake, session } from './_fake-api.js';

const host = session('host', { title: 'Aff' });

describe('embed command', () => {
  it('asks first, then opts the session in by room AND server (clearing an earlier opt-out)', async () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE } });
    f.store.set('optOutSessions', [KEY]);
    await f.run('embed');
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.confirm.mock.calls[0]![0]).toMatch(/Anyone who gets a saved copy/);
    expect(f.store.get('embedSessions')).toEqual([KEY]);
    expect(f.store.get('optOutSessions')).toEqual([]);
  });

  it('declining the confirm changes nothing', async () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE }, confirm: false });
    await f.run('embed');
    expect(f.store.get('embedSessions')).toBeUndefined();
  });

  it('explains a missing session, a spectator seat, a missing permission, or an older CardMirror', async () => {
    const none = makeFake();
    await none.run('embed');
    expect(none.toasts[0]).toMatch(/isn’t in a live co-editing session/);
    const spectator = makeFake({ sessions: { u1: session('spectator') } });
    await spectator.run('embed');
    expect(spectator.toasts[0]).toMatch(/watching/);
    const noCode = makeFake({
      perms: ['files.data', 'collab.read', 'ui.dialogs'],
      sessions: { u1: host },
    });
    await noCode.run('embed');
    expect(noCode.toasts[0]).toMatch(/Read your session share codes.*Settings → Plugins/);
    const noDialogs = makeFake({
      perms: ['files.data', 'collab.read', 'collab.server', 'collab.shareCode'],
      sessions: { u1: host },
      codes: { u1: CODE },
    });
    await noDialogs.run('embed');
    expect(noDialogs.toasts[0]).toMatch(/Show dialogs/);
    expect(noDialogs.store.get('embedSessions')).toBeUndefined();
    const old = makeFake({ sessions: { u1: host }, codes: { u1: CODE }, oldHost: true });
    await old.run('embed');
    expect(old.toasts[0]).toMatch(/newer CardMirror/);
    expect(old.confirm).not.toHaveBeenCalled();
  });
});

describe('stop command', () => {
  it('opts the session out (live session or the file’s stored link)', () => {
    const live = makeFake({ sessions: { u1: host }, codes: { u1: CODE } });
    live.store.set('embedSessions', [KEY]);
    void live.run('stop');
    expect(live.store.get('embedSessions')).toEqual([]);
    expect(live.store.get('optOutSessions')).toEqual([KEY]);
    const stored = makeFake({ fileData: { u1: linkFor() } });
    void stored.run('stop');
    expect(stored.store.get('optOutSessions')).toEqual([KEY]);
    const none = makeFake();
    void none.run('stop');
    expect(none.toasts[0]).toMatch(/no live session link/);
  });
});

describe('join command', () => {
  it('probes, then joins the address into the focused doc — even for a quieted, already-offered file', async () => {
    const f = makeFake({ fileData: { u1: linkFor() } });
    f.store.set('quietDocs', ['d1']);
    await f.run('join');
    await flush();
    expect(f.probe).toHaveBeenCalledWith(ADDRESS);
    expect(f.join).toHaveBeenCalledWith(ADDRESS, { intoDoc: 'u1' });
  });

  it('does not knock on an ended session', async () => {
    const f = makeFake({ fileData: { u1: linkFor() }, probe: async () => 'ended' });
    await f.run('join');
    expect(f.join).not.toHaveBeenCalled();
    expect(f.store.get('endedSessions')).toEqual([KEY]);
  });

  it('explains a session on an unreachable server instead of joining', async () => {
    const elsewhere = linkFor(`${CODE}@${OTHER_SERVER}`);
    const f = makeFake({ fileData: { u1: elsewhere }, probe: async () => 'unreachable' });
    await f.run('join');
    expect(f.join).not.toHaveBeenCalled();
    expect(f.toasts[0]).toMatch(/on other\.example, but CardMirror is connected to relay\.test/);
    expect(f.store.get('endedSessions')).toBeUndefined();
  });

  it('explains no link, already live, or no join permission', async () => {
    const none = makeFake();
    await none.run('join');
    expect(none.toasts[0]).toMatch(/no live session link/);
    const live = makeFake({ fileData: { u1: linkFor() }, sessions: { u1: host } });
    await live.run('join');
    expect(live.toasts[0]).toMatch(/already in its live session/);
    const noJoin = makeFake({ perms: ['files.data', 'collab.read'], fileData: { u1: linkFor() } });
    await noJoin.run('join');
    expect(noJoin.toasts[0]).toMatch(/Join co-editing sessions/);
  });
});

