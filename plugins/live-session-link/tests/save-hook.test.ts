import { describe, expect, it } from 'vitest';
import { LINK_SUMMARY } from '../src/plugin.js';
import { ADDRESS, CODE, KEY, OTHER_SERVER, ROOM, ctx, linkFor, makeFake, session } from './_fake-api.js';

const host = session('host');

describe('save hook', () => {
  it('registers on activate and unregisters on cleanup', () => {
    const f = makeFake();
    expect(f.hooks.save).toBeTypeOf('function');
    expect(f.hooks.open).toBeTypeOf('function');
    (f.cleanup as () => void)();
    expect(f.hooks.save).toBeNull();
    expect(f.hooks.open).toBeNull();
  });

  it('registers nothing without files.data', () => {
    const f = makeFake({ perms: ['collab.read'] });
    expect(f.hooks.save).toBeNull();
    expect(f.cleanup).toBeUndefined();
  });

  it('a live session that was not opted in leaves the file alone', () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE } });
    expect(f.hooks.save!(ctx())).toBeUndefined();
  });

  it('an opted-in session embeds its address; the summary never carries it', () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE } });
    f.store.set('embedSessions', [KEY]);
    const out = f.hooks.save!(ctx()) as { data: Record<string, unknown>; summary: string };
    expect(out.data).toMatchObject({ v: 2, address: ADDRESS, roomId: ROOM, title: 'Aff 1AC' });
    expect(out.summary).toBe(LINK_SUMMARY);
    expect(out.summary).not.toContain('KEY');
    expect(out.summary).not.toContain('relay.test');
  });

  it('a session joined on another server embeds THAT server’s address and key', () => {
    const f = makeFake({ sessions: { u1: session('participant', { server: OTHER_SERVER, crossServer: 'federated' }) }, codes: { u1: CODE } });
    f.store.set('embedSessions', [`${ROOM}@${OTHER_SERVER}`]);
    const out = f.hooks.save!(ctx()) as { data: Record<string, unknown> };
    expect(out.data).toMatchObject({ address: `${CODE}@${OTHER_SERVER}`, server: OTHER_SERVER, roomId: ROOM });
  });

  it('opting in is per server: the same room elsewhere is a different session', () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE } });
    f.store.set('embedSessions', [`${ROOM}@${OTHER_SERVER}`]);
    expect(f.hooks.save!(ctx())).toBeUndefined();
  });

  it('keeps the first embed time while the address is unchanged', () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE }, fileData: { u1: linkFor() } });
    f.store.set('embedSessions', [KEY]);
    const out = f.hooks.save!(ctx()) as { data: { embeddedAt: number } };
    expect(out.data.embeddedAt).toBe(1000);
  });

  it('auto-embeds for hosts only, when the setting is on', () => {
    const on = { autoEmbedHosted: true };
    expect(makeFake({ sessions: { u1: host }, codes: { u1: CODE }, settings: on }).hooks.save!(ctx())).toMatchObject({
      summary: LINK_SUMMARY,
    });
    expect(
      makeFake({ sessions: { u1: session('participant') }, codes: { u1: CODE }, settings: on }).hooks.save!(ctx()),
    ).toBeUndefined();
  });

  it('an opted-out session removes the entry', () => {
    const f = makeFake({ sessions: { u1: host }, codes: { u1: CODE }, settings: { autoEmbedHosted: true } });
    f.store.set('optOutSessions', [KEY]);
    expect(f.hooks.save!(ctx())).toBeNull();
  });

  it('an opt-out still holds when the address is unreadable (via the stored link)', () => {
    const f = makeFake({ sessions: { u1: host }, perms: ['files.data', 'collab.read'], fileData: { u1: linkFor() } });
    f.store.set('optOutSessions', [KEY]);
    expect(f.hooks.save!(ctx())).toBeNull();
  });

  it('a spectator seat, an unreadable address or an older CardMirror never touches the link', () => {
    const f = makeFake({ sessions: { u1: session('spectator') }, fileData: { u1: linkFor() } });
    f.store.set('embedSessions', [KEY]);
    expect(f.hooks.save!(ctx())).toBeUndefined();
    const g = makeFake({ sessions: { u1: host }, perms: ['files.data', 'collab.read'] });
    g.store.set('embedSessions', [KEY]);
    expect(g.hooks.save!(ctx())).toBeUndefined();
    const old = makeFake({ sessions: { u1: host }, codes: { u1: CODE }, oldHost: true, settings: { autoEmbedHosted: true } });
    expect(old.hooks.save!(ctx())).toBeUndefined();
  });

  it('with no session, a local copy keeps its link unless that session ended or was opted out', () => {
    const f = makeFake({ fileData: { u1: linkFor() } });
    expect(f.hooks.save!(ctx())).toBeUndefined();
    f.store.set('endedSessions', [`${ROOM}@${OTHER_SERVER}`]); // same room, other server: not this one
    expect(f.hooks.save!(ctx())).toBeUndefined();
    f.store.set('endedSessions', [KEY]);
    expect(f.hooks.save!(ctx())).toBeNull();
    f.store.set('endedSessions', []);
    f.store.set('optOutSessions', [KEY]);
    expect(f.hooks.save!(ctx())).toBeNull();
  });
});
