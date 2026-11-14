import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_BURST_MS } from '../src/plugin.js';
import {
  ADDRESS,
  CODE,
  KEY,
  OTHER_ADDRESS,
  OTHER_SERVER,
  ROOM,
  ctx,
  flush,
  linkFor,
  makeFake,
  session,
} from './_fake-api.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

const open = async (f: ReturnType<typeof makeFake>, data: unknown = linkFor(), c = ctx()) => {
  await f.hooks.open!(data, c);
  await flush();
};

const ELSEWHERE = `${CODE}@${OTHER_SERVER}`;
const F_ELSEWHERE = `cmshare2f.${ROOM}.KEYKEYKEY.1.17.0@${OTHER_SERVER}`;

describe('open hook', () => {
  it('offers Join in a notice (no modal) once the probe says live', async () => {
    const f = makeFake();
    await open(f);
    expect(f.probe).toHaveBeenCalledWith(ADDRESS);
    expect(f.notices).toHaveLength(1);
    const n = f.notices[0]!;
    expect(n.key).toBe(KEY);
    expect(n.toast).toBe(true);
    expect(n.body).toContain('Aff 1AC');
    expect(n.body).not.toContain('Couldn’t check');
    expect(n.actions!.map((a) => a.label)).toEqual(['Join', 'Don’t ask for this file']);
    expect(f.choose).not.toHaveBeenCalled();
  });

  it('says so when liveness is unknown, but still offers Join', async () => {
    const f = makeFake({ probe: async () => 'unknown' });
    await open(f);
    expect(f.notices[0]!.body).toContain('Couldn’t check');
    expect(f.notices[0]!.actions).toHaveLength(2);
  });

  it('an ended session gets a quiet notice, no Join, and is remembered by room AND server', async () => {
    const f = makeFake({ probe: async () => 'ended' });
    await open(f);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]!.toast).toBe(false);
    expect(f.notices[0]!.actions).toBeUndefined();
    expect(f.store.get('endedSessions')).toEqual([KEY]);
  });

  describe('a session on another server', () => {
    for (const [label, address] of [
      ['plain@server', ELSEWHERE],
      ['federated f@server', F_ELSEWHERE],
    ] as const) {
      it(`(${label}) is never "ended": names both servers, offers no Join, keeps the link`, async () => {
        const f = makeFake({ probe: async () => 'unreachable', fileData: { u1: linkFor(address) } });
        await open(f, linkFor(address));
        expect(f.probe).toHaveBeenCalledWith(address);
        const n = f.notices[0]!;
        expect(n.body).toContain('other.example');
        expect(n.body).toContain('connected to relay.test');
        expect(n.actions!.map((a) => a.label)).toEqual(['Don’t ask for this file']);
        expect(f.store.get('endedSessions')).toBeUndefined();
        expect(f.hooks.save!(ctx())).toBeUndefined(); // the link stays
      });
    }

    it('without collab.server it still says "a different server"', async () => {
      const f = makeFake({
        perms: ['files.data', 'collab.read', 'collab.probe', 'collab.join', 'ui.notices'],
        probe: async () => 'unreachable',
      });
      await open(f, linkFor(ELSEWHERE));
      expect(f.notices[0]!.body).toContain('a different co-editing server');
    });

    it('the same room on two servers is two sessions (each offered)', async () => {
      const f = makeFake({ probe: async (a) => (a.includes(OTHER_SERVER) ? 'unreachable' : 'live') });
      await open(f, linkFor(ADDRESS), ctx({ docUid: 'u1', docId: 'd1' }));
      await open(f, linkFor(ELSEWHERE), ctx({ docUid: 'u2', docId: 'd1' }));
      expect(f.notices.map((n) => n.key)).toEqual([KEY, `${ROOM}@${OTHER_SERVER}`]);
    });
  });

  describe('on a CardMirror from before session addresses', () => {
    it('probes and joins with the plain code', async () => {
      const f = makeFake({ oldHost: true });
      await open(f, linkFor(F_ELSEWHERE));
      expect(f.probe).toHaveBeenCalledWith(CODE);
      f.notices[0]!.actions![0]!.run();
      await flush();
      expect(f.join).toHaveBeenCalledWith(CODE, { intoDoc: 'u1' });
    });

    it('never concludes "ended" (it can\'t tell which server answered)', async () => {
      const f = makeFake({ oldHost: true, probe: async () => 'ended', fileData: { u1: linkFor() } });
      await open(f);
      expect(f.store.get('endedSessions')).toBeUndefined();
      expect(f.notices[0]!.body).toContain('Couldn’t check');
      expect(f.hooks.save!(ctx())).toBeUndefined();
    });
  });

  it('stays quiet for: junk data, a live doc, quiet docs, ended sessions, and core-handled records', async () => {
    const junk = makeFake();
    await open(junk, { v: 1, address: 'nope' });
    const live = makeFake({ sessions: { u1: session('participant') } });
    await open(live);
    const quiet = makeFake();
    quiet.store.set('quietDocs', ['d1']);
    await open(quiet);
    const ended = makeFake();
    ended.store.set('endedSessions', [KEY]);
    await open(ended);
    const core = makeFake({ localRecord: async () => ({ docId: 'd1', role: 'host' }) });
    await open(core);
    for (const f of [junk, live, quiet, ended, core]) expect(f.notices).toHaveLength(0);
    for (const f of [junk, live, quiet, ended, core]) expect(f.probe).not.toHaveBeenCalled();
    // A record from a DIFFERENT doc doesn't count: core won't prompt for this file.
    const elsewhere = makeFake({ localRecord: async () => ({ docId: 'other-doc', role: 'participant' }) });
    await open(elsewhere);
    expect(elsewhere.notices).toHaveLength(1);
  });

  it('offers a file + session once per app run (reload / recovery re-fire under a new uid)', async () => {
    const f = makeFake();
    await open(f);
    await open(f, linkFor(), ctx({ docUid: 'u-reloaded' }));
    expect(f.notices).toHaveLength(1);
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it('a burst of opens toasts once; notices are still one per session', async () => {
    const f = makeFake();
    await open(f);
    await open(f, linkFor(OTHER_ADDRESS), ctx({ docUid: 'u2', docId: 'd2' }));
    expect(f.notices.map((n) => n.toast)).toEqual([true, false]);
    vi.setSystemTime(1_000_000 + TOAST_BURST_MS);
    await open(f, linkFor(), ctx({ docUid: 'u3', docId: 'd3' }));
    expect(f.notices.map((n) => n.toast)).toEqual([true, false, true]);
  });

  it('Join joins the address into the opened doc and records the outcome', async () => {
    const f = makeFake();
    await open(f);
    f.notices[0]!.actions![0]!.run();
    await flush();
    expect(f.join).toHaveBeenCalledWith(ADDRESS, { intoDoc: 'u1' });
    expect(f.store.get('embedSessions')).toEqual([KEY]);
  });

  it('a Join that finds the session ended marks it and says so', async () => {
    const f = makeFake({ join: async () => 'ended' });
    await open(f);
    f.notices[0]!.actions![0]!.run();
    await flush();
    expect(f.store.get('endedSessions')).toEqual([KEY]);
    expect(f.toasts.at(-1)).toMatch(/ended/);
  });

  it('a Join that turns out unreachable explains, and marks nothing', async () => {
    const f = makeFake({ join: async () => 'unreachable' });
    await open(f);
    f.notices[0]!.actions![0]!.run();
    await flush();
    expect(f.toasts.at(-1)).toMatch(/Can’t join.*relay\.test/);
    expect(f.store.get('endedSessions')).toBeUndefined();
    expect(f.store.get('embedSessions')).toBeUndefined();
  });

  it('“Don’t ask for this file” quiets that docId', async () => {
    const f = makeFake();
    await open(f);
    f.notices[0]!.actions![1]!.run();
    expect(f.store.get('quietDocs')).toEqual(['d1']);
  });

  it('without ui.notices: one plain toast pointing at the command, never a dialog', async () => {
    const f = makeFake({
      perms: ['files.data', 'collab.read', 'collab.probe', 'collab.join', 'ui.dialogs'],
    });
    await open(f);
    expect(f.toasts).toHaveLength(1);
    expect(f.toasts[0]).toContain('Join live session from this file');
    expect(f.choose).not.toHaveBeenCalled();
  });

  it('without collab.probe it treats liveness as unknown', async () => {
    const f = makeFake({
      perms: ['files.data', 'collab.read', 'collab.join', 'ui.notices'],
    });
    await open(f);
    expect(f.notices[0]!.body).toContain('Couldn’t check');
  });
});
