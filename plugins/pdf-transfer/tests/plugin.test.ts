import { describe, expect, it } from 'vitest';
import { createFakePluginApi, type FakePluginApiOptions } from '@cardmirror/plugin-api/testing';
import type { CardMirrorPluginApi, FlowAppInfo, FlowPostResult, PluginDocSnapshot } from '@cardmirror/plugin-api';
import manifest from '../cardmirror-plugin.json';
import {
  createPlugin,
  exportPdf,
  importPdf,
  PLUGIN_PERMISSIONS,
  SETTING_HYBRID,
  SETTING_PAGE_SIZE,
  type PluginTiming,
} from '../src/plugin.js';
import { COMPANION_APP_ID, type JobState } from '../src/protocol.js';

const timing: PluginTiming = { sleep: async () => {}, now: () => 0 };

const snapshot = (over: Partial<PluginDocSnapshot> = {}): PluginDocSnapshot => ({
  docUid: 'u-1',
  docId: 'd-1',
  title: '1AC.cmir',
  outline: [{ id: 't', type: 'tag', level: 4, text: 'Tag', formatting: [] }],
  cards: [
    {
      headingId: 't',
      kind: 'card',
      heading: 'Tag',
      cite: 'Smith 24',
      citeParagraphs: ['Smith 24'],
      body: ['Body'],
      bodyRead: [[]],
      undertags: [],
      formatting: { heading: [], citeParagraphs: [[]], body: [[]], undertags: [] },
    },
  ],
  stats: { cards: 1, readAloudWords: { body: 0, other: 0 } },
  ...over,
});

const app = (running = true): FlowAppInfo => ({
  id: COMPANION_APP_ID,
  app: 'CardMirror PDF',
  appVersion: '0.1.0',
  schema: 1,
  kind: 'flow',
  running,
});

/** A fake companion: records posts, answers starts with a job and
 *  `/status` with the scripted states, in order. */
function companion(states: { state: JobState; message?: string }[], start?: unknown) {
  const posts: { route: string; body: unknown }[] = [];
  let i = 0;
  const flowPost = async (_id: string, route: string, body: unknown): Promise<FlowPostResult> => {
    posts.push({ route, body });
    if (route === '/status') return { ok: true, status: 200, body: { ok: true, ...states[Math.min(i++, states.length - 1)] } };
    return { ok: true, status: 200, body: start ?? { ok: true, job: 'j1' } };
  };
  return { posts, flowPost };
}

function fake(
  opts: FakePluginApiOptions & {
    snap?: PluginDocSnapshot | null;
    apps?: FlowAppInfo[];
    flowPost?: CardMirrorPluginApi['flowPost'];
  },
) {
  const reads: unknown[] = [];
  return {
    reads,
    ...createFakePluginApi({
      granted: PLUGIN_PERMISSIONS,
      ...opts,
      doc: {
        read: (_uid?: string, o?: { formatting?: boolean }) => {
          reads.push(o);
          return opts.snap === undefined ? snapshot() : opts.snap;
        },
        ...opts.doc,
      },
      core: { flowApps: async () => opts.apps ?? [app()], flowPost: opts.flowPost, ...opts.core },
    }),
  };
}

describe('manifest and definition agree', () => {
  it('same id, name and permissions', () => {
    const def = createPlugin();
    expect(manifest.id).toBe(def.id);
    expect(manifest.name).toBe(def.name);
    expect([...manifest.permissions].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect([...(def.permissions ?? [])].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect(manifest.permissionReasons).toEqual(def.permissionReasons);
  });

  it('command ids are prefixed and settings declared', () => {
    const def = createPlugin();
    expect(def.commands.map((c) => c.id)).toEqual(['pdf-transfer.export', 'pdf-transfer.import']);
    expect(def.settings?.map((s) => s.key)).toEqual([SETTING_HYBRID, SETTING_PAGE_SIZE]);
  });
});

describe('export', () => {
  it('reads with formatting, starts a job and reports the result', async () => {
    const c = companion([{ state: 'choosing' }, { state: 'working' }, { state: 'done', message: 'Saved 1AC.pdf' }]);
    const f = fake({ flowPost: c.flowPost, settings: { [SETTING_HYBRID]: true, [SETTING_PAGE_SIZE]: 'A4' } });
    await exportPdf(f.api, timing);
    expect(f.reads).toEqual([{ formatting: true }]);
    expect(c.posts[0]).toMatchObject({
      route: '/export',
      body: { v: 1, title: '1AC.cmir', pageSize: 'A4', hybrid: true, snapshot: { docUid: 'u-1' } },
    });
    expect(c.posts.slice(1).every((p) => p.route === '/status')).toBe(true);
    expect(f.toasts).toEqual(['Saved 1AC.pdf']);
  });

  it('says nothing when the user cancels the save dialog', async () => {
    const c = companion([{ state: 'cancelled' }]);
    const f = fake({ flowPost: c.flowPost });
    await exportPdf(f.api, timing);
    expect(f.toasts).toEqual([]);
  });

  it('asks for the companion when it is missing or closed', async () => {
    const missing = fake({ apps: [] });
    await exportPdf(missing.api, timing);
    expect(missing.toasts[0]).toMatch(/needs the CardMirror PDF app/);
    const closed = fake({ apps: [app(false)] });
    await exportPdf(closed.api, timing);
    expect(closed.toasts[0]).toMatch(/Start the CardMirror PDF app/);
  });

  it('refuses an empty or missing document without contacting the companion', async () => {
    const c = companion([{ state: 'done' }]);
    const none = fake({ snap: null, flowPost: c.flowPost });
    await exportPdf(none.api, timing);
    expect(none.toasts).toEqual(['Open a document to export it.']);
    const empty = fake({ snap: snapshot({ outline: [], cards: [] }), flowPost: c.flowPost });
    await exportPdf(empty.api, timing);
    expect(empty.toasts[0]).toMatch(/no headings or cards/);
    expect(c.posts).toEqual([]);
  });

  it('warns but still exports on a build without formatting', async () => {
    const c = companion([{ state: 'done', message: 'ok' }]);
    const s = snapshot();
    delete s.cards[0]!.formatting;
    const f = fake({ snap: s, flowPost: c.flowPost });
    await exportPdf(f.api, timing);
    expect(f.toasts).toEqual([expect.stringMatching(/too old to export highlighting/), 'ok']);
  });

  it('explains a denied doc.read', async () => {
    const f = createFakePluginApi({ declared: PLUGIN_PERMISSIONS, granted: ['ui.dialogs'] });
    await exportPdf(f.api, timing);
    expect(f.toasts[0]).toMatch(/Settings → Plugins/);
  });

  it('maps a busy companion and transport failures to messages', async () => {
    const busy = fake({ flowPost: companion([], { ok: false, error: 'busy' }).flowPost });
    await exportPdf(busy.api, timing);
    expect(busy.toasts[0]).toMatch(/still busy/);
    const down = fake({ flowPost: async () => ({ ok: false, error: 'timeout' }) });
    await exportPdf(down.api, timing);
    expect(down.toasts[0]).toMatch(/didn't answer \(timeout\)/);
  });
});

describe('import', () => {
  it('offers a new document first when the open one has content', async () => {
    const seen: string[][] = [];
    const c = companion([{ state: 'done', message: 'Imported' }]);
    const f = fake({
      flowPost: c.flowPost,
      ui: {
        choose: async (o) => {
          seen.push(o.choices.map((x) => x.value));
          return 'insert';
        },
      },
    });
    await importPdf(f.api, timing);
    expect(seen).toEqual([['new', 'insert']]);
    expect(c.posts[0]).toEqual({ route: '/import', body: { v: 1, mode: 'insert', target: 'u-1' } });
  });

  it('offers this document first when it is empty', async () => {
    const seen: string[][] = [];
    const c = companion([{ state: 'done' }]);
    const f = fake({
      snap: snapshot({ outline: [], cards: [] }),
      flowPost: c.flowPost,
      ui: {
        choose: async (o) => {
          seen.push(o.choices.map((x) => x.value));
          return 'new';
        },
      },
    });
    await importPdf(f.api, timing);
    expect(seen).toEqual([['insert', 'new']]);
    expect(c.posts[0]!.body).toEqual({ v: 1, mode: 'new' });
  });

  it('goes to a new document with no open doc, and does nothing on cancel', async () => {
    const c = companion([{ state: 'done' }]);
    const none = fake({ snap: null, flowPost: c.flowPost });
    await importPdf(none.api, timing);
    expect(c.posts[0]!.body).toEqual({ v: 1, mode: 'new' });
    const c2 = companion([{ state: 'done' }]);
    const cancel = fake({ flowPost: c2.flowPost, ui: { choose: async () => null } });
    await importPdf(cancel.api, timing);
    expect(c2.posts).toEqual([]);
  });

  it('never inserts into an open document without asking', async () => {
    const c = companion([{ state: 'done' }]);
    const f = fake({ granted: ['doc.read'], declared: PLUGIN_PERMISSIONS, flowPost: c.flowPost });
    await importPdf(f.api, timing);
    expect(c.posts[0]!.body).toEqual({ v: 1, mode: 'new' });
  });
});
