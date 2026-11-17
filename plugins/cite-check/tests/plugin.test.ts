// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PluginDocSnapshot, PluginFetchResult, PluginPanelHandle } from '@cardmirror/plugin-api';
import { createFakePluginApi, type FakePluginApiOptions } from '@cardmirror/plugin-api/testing';
import manifest from '../cardmirror-plugin.json';
import { createPlugin, PERMISSION_REASONS, PLUGIN_ID, PLUGIN_NAME, PLUGIN_NETWORK_HOSTS, PLUGIN_PERMISSIONS } from '../src/plugin.js';
import { card } from './fixtures.js';

const GOOD_CARD = card('Doe 24', 'Jane Doe 24, Professor of Law at Yale University, "A Proper Title Here," Yale Law Journal, 3/4/2024, https://www.yalelawjournal.org/a');
const VAGUE_CARD = card('Roe 24', 'Rick Roe 24, Freelance writer, "Another Proper Title," Medium, 2024, https://rick.medium.com/p');
const NO_CITE = card('', []);

function snapshot(cards = [GOOD_CARD, VAGUE_CARD, NO_CITE]): PluginDocSnapshot {
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
  return { def, fake, panel, jumpTo, cleanup, cmd };
}

describe('manifest and definition agree', () => {
  it('same id, name, permissions, reasons and network hosts', () => {
    const def = createPlugin();
    expect(manifest.id).toBe(def.id);
    expect(manifest.name).toBe(def.name);
    expect([...manifest.permissions].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect([...(def.permissions ?? [])].sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    expect([...manifest.networkHosts].sort()).toEqual([...PLUGIN_NETWORK_HOSTS].sort());
    expect([...(def.networkHosts ?? [])].sort()).toEqual([...PLUGIN_NETWORK_HOSTS].sort());
    expect(manifest.permissionReasons).toEqual(PERMISSION_REASONS);
    expect(Object.keys(PERMISSION_REASONS).sort()).toEqual([...PLUGIN_PERMISSIONS].sort());
    for (const r of Object.values(PERMISSION_REASONS)) expect(r.length).toBeLessThanOrEqual(200);
  });
});

describe('marking problems', () => {
  it('marks errors and warnings on activate; info only with the setting on', () => {
    const { fake } = setup();
    const marks = fake.annotations.get('d1')!;
    expect(marks.map((m) => [m.headingId, m.key, m.severity])).toEqual(
      expect.arrayContaining([
        [VAGUE_CARD.headingId, 'vague-quals', 'warning'],
        [NO_CITE.headingId, 'no-cite', 'error'],
      ]),
    );
    expect(marks.find((m) => m.headingId === GOOD_CARD.headingId)).toBeUndefined();
    expect(marks.some((m) => m.severity === 'info')).toBe(false);
    const vague = marks.find((m) => m.key === 'vague-quals')!;
    expect(vague).toMatchObject({ part: 'cite', index: 0, match: 'Freelance writer' });
    expect(vague.actions?.map((a) => a.label)).toEqual(['Ignore for this card', 'Show in Cite Check']);

    const info = setup({ settings: { markInfo: true } });
    expect(info.fake.annotations.get('d1')!.some((m) => m.severity === 'info')).toBe(true); // Medium: self-published
  });

  it('re-checks on every doc change, and not at all with “Check as I edit” off', () => {
    let cards = [GOOD_CARD];
    const { fake } = setup({ snap: () => snapshot(cards) });
    expect(fake.annotations.get('d1')).toEqual([]);
    cards = [GOOD_CARD, NO_CITE];
    for (const h of fake.hooks('events.onDocChange')) h({ docUid: 'd1', fromCollaborator: false });
    expect(fake.annotations.get('d1')!.map((m) => m.key)).toEqual(['no-cite']);

    const off = setup({ settings: { autoCheck: false } });
    expect(off.fake.annotations.size).toBe(0);
  });

  it('cleanup unsubscribes every hook', () => {
    const { fake, cleanup } = setup();
    expect(fake.hooks('events.onDocChange')).toHaveLength(1);
    expect(fake.hooks('menu.add')).toHaveLength(2);
    cleanup();
    expect(fake.hooks('events.onDocChange')).toHaveLength(0);
    expect(fake.hooks('menu.add')).toHaveLength(0);
    expect(fake.hooks('files.onSave')).toHaveLength(0);
  });
});

describe('ignoring', () => {
  it('an ignored finding disappears, is saved with the file, and comes back on open', async () => {
    const { fake } = setup();
    const vague = fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')!;
    vague.actions![0]!.run();
    expect(fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')).toBeUndefined();
    const saved = fake.save({ docUid: 'd1', docId: 'id1', title: 'aff.cmir' });
    expect(saved).toEqual([
      { data: { v: 1, ignored: [`${VAGUE_CARD.headingId}:vague-quals`] }, summary: 'Cite Check: 1 ignored finding' },
    ]);

    const again = setup();
    expect(again.fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')).toBeTruthy();
    await again.fake.open(saved[0]!.data, { docUid: 'd1', docId: 'id1', title: 'aff.cmir' });
    expect(again.fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')).toBeUndefined();
    // Unknown versions are ignored rather than misread.
    const third = setup();
    await third.fake.open({ v: 99, ignored: [`${VAGUE_CARD.headingId}:vague-quals`] }, { docUid: 'd1', docId: 'id1', title: 'a' });
    expect(third.fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')).toBeTruthy();
  });

  it('“Restore ignored” brings them back; a doc with nothing ignored saves no entry', () => {
    const { fake, cmd } = setup();
    expect(fake.save({ docUid: 'd1', docId: 'id1', title: 'a' })).toEqual([null]);
    fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')!.actions![0]!.run();
    void cmd('restore');
    expect(fake.toasts.at(-1)).toBe('Restored 1 ignored finding.');
    expect(fake.annotations.get('d1')!.find((m) => m.key === 'vague-quals')).toBeTruthy();
  });
});

describe('panel', () => {
  it('lists problems by card; rows jump to the tag or the cite', async () => {
    const { panel, jumpTo, cmd } = setup();
    await cmd('panel');
    const text = panel.el.textContent!;
    expect(text).toContain('Cites in aff.cmir');
    expect(text).toContain('Vague quals: “Freelance writer”');
    expect(text).toContain('Card has no cite');
    expect(text).not.toContain(GOOD_CARD.heading); // no problems → not listed
    const tag = [...panel.el.querySelectorAll<HTMLButtonElement>('.cc-card-head')].find((b) => b.textContent!.includes(VAGUE_CARD.heading))!;
    tag.click();
    expect(jumpTo).toHaveBeenLastCalledWith({ headingId: VAGUE_CARD.headingId, part: 'heading', docUid: 'd1' });
    const msg = [...panel.el.querySelectorAll<HTMLButtonElement>('.cc-msg')].find((b) => b.textContent!.startsWith('Vague'))!;
    msg.click();
    expect(jumpTo).toHaveBeenLastCalledWith({ headingId: VAGUE_CARD.headingId, part: 'cite', docUid: 'd1' });
  });

  it('filters, and its Ignore buttons work', async () => {
    const { panel, cmd, fake } = setup();
    await cmd('panel');
    const select = panel.el.querySelector('select')!;
    select.value = 'error';
    select.dispatchEvent(new Event('change'));
    expect(panel.el.textContent).not.toContain('Vague quals');
    expect(panel.el.textContent).toContain('Card has no cite');
    panel.el.querySelector<HTMLButtonElement>('.cc-ignore')!.click();
    expect(panel.el.textContent).toContain('1 ignored');
    expect(fake.annotations.get('d1')!.find((m) => m.key === 'no-cite')).toBeUndefined();
  });

  it('explains a missing panel or read permission instead of failing', async () => {
    const noPanel = setup({ granted: PLUGIN_PERMISSIONS.filter((p) => p !== 'ui.panel'), declared: PLUGIN_PERMISSIONS });
    await noPanel.cmd('panel');
    expect(noPanel.fake.toasts.at(-1)).toMatch(/Show a side panel.*Settings → Plugins/);
    const noRead = setup({ granted: PLUGIN_PERMISSIONS.filter((p) => p !== 'doc.read'), declared: PLUGIN_PERMISSIONS });
    await noRead.cmd('check');
    expect(noRead.fake.toasts.at(-1)).toMatch(/Read your open documents/);
  });
});

describe('verify sources', () => {
  const crossref404: PluginFetchResult = { ok: true, status: 404, url: 'x', headers: {}, body: '' };
  const page = (status: number): PluginFetchResult => ({ ok: true, status, url: 'x', headers: { 'content-type': 'text/html' }, body: '' });

  it('runs online checks, merges the results into the marks and posts one notice', async () => {
    const fetch = vi.fn(async (url: string) => (url.includes('medium.com') ? page(404) : url.includes('crossref') ? crossref404 : page(200)));
    const { fake, cmd, panel } = setup({ net: { fetch } });
    await cmd('verify');
    const marks = fake.annotations.get('d1')!;
    expect(marks.find((m) => m.key === 'dead-link')).toMatchObject({ headingId: VAGUE_CARD.headingId, severity: 'error' });
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]).toMatchObject({ key: 'verify:d1', severity: 'warning' });
    expect(fake.notices[0]!.body).toMatch(/^Verified 2 cites: 1 errors/);
    // The notice's button opens the panel.
    fake.notices[0]!.actions![0]!.run();
    expect(panel.handle.isVisible()).toBe(true);
    // Online findings survive an edit that leaves the cite alone…
    for (const h of fake.hooks('events.onDocChange')) h({ docUid: 'd1', fromCollaborator: false });
    expect(fake.annotations.get('d1')!.find((m) => m.key === 'dead-link')).toBeTruthy();
  });

  it('drops a card’s online results when its cite changes', async () => {
    let cards = [VAGUE_CARD];
    const fetch = vi.fn(async (url: string) => (url.includes('medium.com') ? page(404) : crossref404));
    const { fake, cmd } = setup({ net: { fetch }, snap: () => snapshot(cards) });
    await cmd('verify');
    expect(fake.annotations.get('d1')!.find((m) => m.key === 'dead-link')).toBeTruthy();
    cards = [{ ...VAGUE_CARD, citeParagraphs: [VAGUE_CARD.citeParagraphs[0]!.replace('rick.medium.com/p', 'example.org/fixed')] }];
    for (const h of fake.hooks('events.onDocChange')) h({ docUid: 'd1', fromCollaborator: false });
    expect(fake.annotations.get('d1')!.find((m) => m.key === 'dead-link')).toBeUndefined();
  });

  it('asks for net.fetch when it was turned off, and stops politely when refused', async () => {
    const fetch = vi.fn(async () => crossref404);
    const asked = setup({ granted: PLUGIN_PERMISSIONS.filter((p) => p !== 'net.fetch'), declared: PLUGIN_PERMISSIONS, answer: 'allow', net: { fetch } });
    await asked.cmd('verify');
    expect(asked.fake.requests.map((r) => r.permission)).toEqual(['net.fetch']);
    expect(asked.fake.requests[0]!.reason).toMatch(/Verify sources/);
    expect(fetch).toHaveBeenCalled();

    const refused = setup({ granted: PLUGIN_PERMISSIONS.filter((p) => p !== 'net.fetch'), declared: PLUGIN_PERMISSIONS, answer: 'not-now' });
    await refused.cmd('verify');
    expect(refused.fake.toasts.at(-1)).toMatch(/Connect to websites/);
  });

  it('the right-click “Verify this cite” checks only that card', async () => {
    const fetch = vi.fn(async (_url: string) => crossref404);
    const { fake } = setup({ net: { fetch } });
    const item = fake.hooks('menu.add').find((m) => m.label === 'Verify this cite')!;
    expect(item.when).toBe('heading');
    await item.run({ surface: 'text', docUid: 'd1', headingId: GOOD_CARD.headingId, headingType: 'tag', selectionText: '' });
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(fake.notices[0]!.body).toMatch(/^Verified 1 cite:/);
    expect(fetch.mock.calls.every(([u]) => !String(u).includes('medium.com'))).toBe(true);
  });
});

describe('basics', () => {
  it('names itself consistently', () => {
    expect(createPlugin().commands.every((c) => c.label.startsWith(`${PLUGIN_NAME}:`))).toBe(true);
  });
});
