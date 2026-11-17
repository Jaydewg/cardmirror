// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PluginCard, PluginDocSnapshot, PluginPanelHandle } from '@cardmirror/plugin-api';
import { createFakePluginApi, type FakePluginApiOptions } from '@cardmirror/plugin-api/testing';
import manifest from '../cardmirror-plugin.json';
import { createPlugin, PERMISSION_REASONS, PLUGIN_ID, PLUGIN_NAME, PLUGIN_PERMISSIONS } from '../src/plugin.js';
import { card } from './fixtures.js';

const SHADY = card('Sanctions fail', 'Experts agree that {sanctions do} not {work}.');
const RARELY = card('Wars escalate', '{Wars} rarely {escalate}.');
const CLEAN = card('Warming is real', '{Warming is real}.');

function snapshot(cards: PluginCard[] = [SHADY, RARELY, CLEAN]): PluginDocSnapshot {
  return {
    docUid: 'd1',
    docId: 'id1',
    title: 'aff.cmir',
    outline: [],
    cards,
    stats: { cards: cards.length, readAloudWords: { body: 0, other: 0 } },
  };
}

function panelStub() {
  const el = document.createElement('div');
  let visible = false;
  const handle: PluginPanelHandle = {
    el,
    setTitle: () => {},
    show: () => void (visible = true),
    hide: () => void (visible = false),
    isVisible: () => visible,
    onVisibilityChange: () => () => {},
  };
  return { el, handle };
}

function setup(opts: Partial<FakePluginApiOptions> & { snap?: () => PluginDocSnapshot } = {}) {
  const def = createPlugin();
  const snap = opts.snap ?? (() => snapshot());
  const panel = panelStub();
  const jumpTo = vi.fn(async () => ({ ok: true as const }));
  const fake = createFakePluginApi({
    granted: PLUGIN_PERMISSIONS,
    doc: { read: () => snap(), jumpTo },
    panel: { get: () => panel.handle },
    ...opts,
  });
  const cleanup = def.activate!(fake.api) as () => void;
  const cmd = (name: string) => def.commands.find((c) => c.id === `${PLUGIN_ID}.${name}`)!.run(fake.api);
  const docChange = () => fake.hooks('events.onDocChange').forEach((h) => h({ docUid: 'd1', fromCollaborator: false }));
  return { def, fake, panel, jumpTo, cleanup, cmd, docChange };
}

describe('manifest and definition agree', () => {
  it('same id, name, permissions and reasons', () => {
    const def = createPlugin();
    expect(manifest.id).toBe(def.id);
    expect(manifest.name).toBe(def.name);
    expect([...manifest.permissions].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect([...(def.permissions ?? [])].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect(manifest.permissionReasons).toEqual(PERMISSION_REASONS);
    expect(Object.keys(PERMISSION_REASONS).sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    for (const r of Object.values(PERMISSION_REASONS)) expect(r.length).toBeLessThanOrEqual(200);
  });
});

describe('checking on demand', () => {
  it('does nothing until asked, then marks and opens the panel', async () => {
    const { fake, cmd, panel } = setup();
    expect(fake.annotations.size).toBe(0);
    await cmd('check');
    const marks = fake.annotations.get('d1')!;
    expect(marks.map((m) => [m.headingId, m.key, m.severity, m.match])).toEqual([
      [SHADY.headingId, 'negation', 'error', 'not'],
      [RARELY.headingId, 'qualifier', 'warning', 'rarely'],
    ]);
    expect(panel.handle.isVisible()).toBe(true);
    expect(panel.el.textContent).toContain('1 red · 1 amber');
  });

  it('gives each mark the occurrence the host will find', async () => {
    // "not" first appears inside "nothing" (hit 0); the flagged word is hit 1.
    const c = card('T', 'There is nothing here. {The plan does} not {solve}.');
    const { fake, cmd } = setup({ snap: () => snapshot([c]) });
    await cmd('check');
    expect(fake.annotations.get('d1')![0]).toMatchObject({ part: 'body', index: 0, match: 'not', occurrence: 1 });
  });

  it('marks notes only with the setting on, but always lists them', async () => {
    const c = card('T', '{The [plan] works}.');
    const off = setup({ snap: () => snapshot([c]) });
    await off.cmd('check');
    expect(off.fake.annotations.get('d1')).toEqual([]);
    expect(off.panel.el.textContent).toContain('bracketed');
    const on = setup({ snap: () => snapshot([c]), settings: { markInfo: true } });
    await on.cmd('check');
    expect(on.fake.annotations.get('d1')!.map((m) => m.severity)).toEqual(['info']);
  });

  it('without live refresh, an edit marks the panel stale instead of re-checking', async () => {
    let cards = [SHADY];
    const { fake, cmd, panel, docChange } = setup({ snap: () => snapshot(cards) });
    await cmd('check');
    cards = [SHADY, RARELY];
    docChange();
    expect(fake.annotations.get('d1')).toHaveLength(1);
    expect(panel.el.textContent).toContain('changed since this check');
    panel.el.querySelector<HTMLButtonElement>('.hc-head .hc-btn:last-child')!.click(); // Re-check
    expect(fake.annotations.get('d1')).toHaveLength(2);
    expect(panel.el.textContent).not.toContain('changed since this check');
  });

  it('with live refresh, checks on activate and after every edit', () => {
    let cards = [CLEAN];
    const { fake, docChange } = setup({ snap: () => snapshot(cards), settings: { liveRefresh: true } });
    expect(fake.annotations.get('d1')).toEqual([]);
    cards = [CLEAN, SHADY];
    docChange();
    expect(fake.annotations.get('d1')!.map((m) => m.key)).toEqual(['negation']);
  });

  it('clear removes the marks and forgets the result', async () => {
    const { fake, cmd, panel } = setup();
    await cmd('check');
    await cmd('clear');
    expect(fake.annotations.has('d1')).toBe(false);
    expect(panel.el.textContent).toContain('Not checked yet');
  });

  it('settings switch rules off', async () => {
    const { fake, cmd } = setup({ settings: { qualifiers: '' } });
    await cmd('check');
    expect(fake.annotations.get('d1')!.map((m) => m.key)).toEqual(['negation']);
  });
});

describe('the panel', () => {
  it('previews the sentence with read text bold and the problem underlined', async () => {
    const { cmd, panel } = setup();
    await cmd('check');
    const preview = panel.el.querySelector('.hc-preview')!;
    expect(preview.textContent).toBe('Experts agree that sanctions do not work.');
    expect([...preview.querySelectorAll('.hc-read')].map((s) => s.textContent)).toEqual(['sanctions do', 'work']);
    expect(preview.querySelector('.hc-flag.hc-error')!.textContent).toBe('not');
  });

  it('rows jump to the card', async () => {
    const { cmd, panel, jumpTo } = setup();
    await cmd('check');
    panel.el.querySelector<HTMLButtonElement>('.hc-msg')!.click();
    expect(jumpTo).toHaveBeenCalledWith({ headingId: SHADY.headingId, docUid: 'd1' });
  });

  it('says so when the build has no bodyRead', async () => {
    const old = { ...SHADY, bodyRead: undefined };
    const { cmd, panel, fake } = setup({ snap: () => snapshot([old]) });
    await cmd('check');
    expect(panel.el.textContent).toContain('needs a newer CardMirror');
    expect(fake.annotations.get('d1')).toEqual([]);
  });

  it('explains a missing doc.read', async () => {
    const { cmd, fake } = setup({ declared: PLUGIN_PERMISSIONS, granted: ['ui.panel'] });
    await cmd('check');
    expect(fake.toasts[0]).toMatch(/Read your open documents/);
  });
});

describe('ignoring', () => {
  it('an ignored finding disappears, is saved with the file, and comes back on open', async () => {
    const { fake, cmd } = setup();
    await cmd('check');
    fake.annotations.get('d1')!.find((m) => m.key === 'qualifier')!.actions![0]!.run(); // Ignore here
    expect(fake.annotations.get('d1')!.map((m) => m.key)).toEqual(['negation']);
    const [saved] = fake.save({ docUid: 'd1', docId: 'id1', title: 'aff.cmir' });
    expect(saved).toMatchObject({ summary: `${PLUGIN_NAME}: 1 ignored finding` });

    const again = setup();
    await again.fake.open((saved as { data: unknown }).data, { docUid: 'd1', docId: 'id1', title: 'aff.cmir' });
    await again.cmd('check');
    expect(again.fake.annotations.get('d1')!.map((m) => m.key)).toEqual(['negation']);
    await again.cmd('restore');
    expect(again.fake.annotations.get('d1')).toHaveLength(2);
  });

  it('the ignore survives an edit elsewhere in the card', async () => {
    let cards = [RARELY];
    const { fake, cmd } = setup({ snap: () => snapshot(cards) });
    await cmd('check');
    fake.annotations.get('d1')![0]!.actions![0]!.run();
    cards = [{ ...RARELY, body: [...RARELY.body, 'More text.'], bodyRead: [...RARELY.bodyRead!, []] }];
    await cmd('check');
    expect(fake.annotations.get('d1')).toEqual([]);
  });
});

describe('activate', () => {
  it('cleanup unsubscribes every hook', () => {
    const { fake, cleanup } = setup();
    expect(fake.hooks('events.onDocChange')).toHaveLength(1);
    cleanup();
    expect(fake.hooks('events.onDocChange')).toHaveLength(0);
    expect(fake.hooks('events.onFocusChange')).toHaveLength(0);
    expect(fake.hooks('files.onSave')).toHaveLength(0);
  });
});
