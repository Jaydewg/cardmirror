// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
const settingsState = vi.hoisted(() => ({ values: { pluginPanelWidth: 320 } as Record<string, unknown> }));
vi.mock('../../src/editor/settings.js', () => ({
  PLUGIN_PANEL_MIN_WIDTH: 220,
  PLUGIN_PANEL_MAX_WIDTH: 640,
  settings: {
    get: (k: string) => settingsState.values[k],
    set: (k: string, v: unknown) => {
      settingsState.values[k] = v;
    },
  },
}));

import { makeHarness } from './_plugin-harness.js';
import {
  notifyPluginDocChanged,
  notifyPluginFocusChanged,
  notifyPluginSelectionChanged,
  resetPluginEventsForTests,
  DOC_CHANGE_DEBOUNCE_MS,
  SELECTION_DEBOUNCE_MS,
} from '../../src/editor/plugin-caps/events.js';
import { pluginMenuEntries, resetPluginMenuForTests, type PluginMenuTarget } from '../../src/editor/plugin-caps/menu.js';
import { resetPluginPanelsForTests } from '../../src/editor/plugin-caps/panel.js';
import { closeContextMenu, isContextMenuOpen, showContextMenu } from '../../src/editor/context-menu-builder.js';
import { unregisterPlugin } from '../../src/editor/plugin-registry.js';

const flushMicrotasks = (): Promise<void> => new Promise((r) => queueMicrotask(r));

beforeEach(() => {
  resetPluginEventsForTests();
  resetPluginMenuForTests();
  resetPluginPanelsForTests();
  document.body.innerHTML = '';
});
afterEach(() => vi.useRealTimers());

describe('doc.events', () => {
  it('debounces doc changes per doc and reports whether all came from a collaborator', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.register('demo', ['doc.events']);
    const seen: unknown[] = [];
    h.api().events!.onDocChange((e) => seen.push(e));
    notifyPluginDocChanged('d1', true);
    notifyPluginDocChanged('d1', false);
    notifyPluginDocChanged('d2', true);
    vi.advanceTimersByTime(DOC_CHANGE_DEBOUNCE_MS);
    expect(seen).toEqual([
      { docUid: 'd1', fromCollaborator: false },
      { docUid: 'd2', fromCollaborator: true },
    ]);
  });

  it('debounces selection changes', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.register('demo', ['doc.events']);
    const cb = vi.fn();
    h.api().events!.onSelectionChange(cb);
    for (let i = 0; i < 5; i++) notifyPluginSelectionChanged('d1');
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('focus fires only on an actual switch, reading the uid after the current task', async () => {
    const h = makeHarness();
    h.register('demo', ['doc.events']);
    const cb = vi.fn();
    h.api().events!.onFocusChange(cb);
    let uid = 'old';
    notifyPluginFocusChanged(() => uid);
    uid = 'new'; // assigned after the view swap, before the microtask
    await flushMicrotasks();
    notifyPluginFocusChanged(() => uid);
    await flushMicrotasks();
    expect(cb.mock.calls).toEqual([[{ docUid: 'new' }]]);
  });

  it('a revoked plugin stops hearing events; a throwing listener never stops others', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = makeHarness();
    h.register('a', ['doc.events']);
    h.register('b', ['doc.events']);
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    h.api('a').events!.onDocChange(a);
    h.api('b').events!.onDocChange(b);
    notifyPluginDocChanged('d1', false);
    vi.advanceTimersByTime(DOC_CHANGE_DEBOUNCE_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    h.regrant('b', []);
    notifyPluginDocChanged('d1', false);
    vi.advanceTimersByTime(DOC_CHANGE_DEBOUNCE_MS);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('ui.contextMenu', () => {
  const target: PluginMenuTarget = {
    surface: 'text',
    docUid: 'd1',
    headingId: null,
    headingType: null,
    selectionText: '',
  };

  it('costs nothing without items (the target thunk is never called)', () => {
    const thunk = vi.fn(() => target);
    expect(pluginMenuEntries(thunk)).toEqual([]);
    expect(thunk).not.toHaveBeenCalled();
  });

  it('adds attributed items after a separator, filtered by `when`, run with the target', () => {
    const h = makeHarness();
    h.register('demo', ['ui.contextMenu']);
    const run = vi.fn();
    h.api().menu!.add({ label: 'Always', run });
    h.api().menu!.add({ label: 'Needs selection', when: 'selection', run });
    h.api().menu!.add({ label: 'Needs heading', when: 'heading', run });
    const entries = pluginMenuEntries(() => ({ ...target, selectionText: 'hi' }));
    expect(entries[0]).toEqual({ kind: 'separator' });
    const labels = entries.slice(1).map((e) => (e.kind === 'item' ? [e.label, e.hint] : null));
    expect(labels).toEqual([
      ['Always', 'DEMO'],
      ['Needs selection', 'DEMO'],
    ]);
    const first = entries[1]!;
    if (first.kind === 'item') first.action();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ selectionText: 'hi', docUid: 'd1' }));
  });

  it('caps items per plugin and drops a revoked plugin’s items', () => {
    const h = makeHarness();
    h.register('demo', ['ui.contextMenu']);
    for (let i = 0; i < 5; i++) h.api().menu!.add({ label: `i${i}`, run: () => {} });
    expect(() => h.api().menu!.add({ label: 'sixth', run: () => {} })).toThrow(/at most 5/);
    h.regrant('demo', []);
    expect(pluginMenuEntries(() => target)).toEqual([]);
  });
});

describe('ui.panel', () => {
  const column = (): HTMLElement | null => document.getElementById('plugin-panel');

  it('host frames the panel: hidden until shown, tab names the plugin, plugin renders into el', () => {
    const h = makeHarness();
    h.register('demo', ['ui.panel']);
    const panel = h.api().panel!.get({ title: 'Stats' });
    expect(column()!.hidden).toBe(true);
    expect(panel.isVisible()).toBe(false);
    panel.el.textContent = 'rendered by the plugin';
    const vis = vi.fn();
    panel.onVisibilityChange(vis);
    panel.show();
    expect(column()!.hidden).toBe(false);
    expect(panel.isVisible()).toBe(true);
    expect(vis).toHaveBeenLastCalledWith(true);
    const tab = column()!.querySelector('.pmd-plugin-panel-tab')!;
    expect(tab.querySelector('.pmd-plugin-panel-tab-label')!.textContent).toBe('Stats');
    expect(tab.querySelector('.pmd-plugin-panel-tab-owner')!.textContent).toBe('DEMO');
    expect(column()!.textContent).toContain('rendered by the plugin');
    // Same handle on a second get.
    expect(h.api().panel!.get()).toBe(panel);
    column()!.querySelector<HTMLButtonElement>('.pmd-plugin-panel-close')!.click();
    expect(panel.isVisible()).toBe(false);
    expect(vis).toHaveBeenLastCalledWith(false);
  });

  it('two plugins get two tabs; one shows at a time', () => {
    const h = makeHarness();
    h.register('a', ['ui.panel']);
    h.register('b', ['ui.panel']);
    const pa = h.api('a').panel!.get();
    const pb = h.api('b').panel!.get();
    pa.show();
    expect([pa.isVisible(), pb.isVisible()]).toEqual([true, false]);
    pb.show();
    expect([pa.isVisible(), pb.isVisible()]).toEqual([false, true]);
    expect(column()!.querySelectorAll('.pmd-plugin-panel-tab')).toHaveLength(2);
  });

  it('is torn down when the plugin loses ui.panel or unregisters', () => {
    const h = makeHarness();
    h.register('a', ['ui.panel']);
    h.register('b', ['ui.panel']);
    const pa = h.api('a').panel!.get();
    h.api('b').panel!.get();
    pa.el.textContent = 'secret';
    pa.show();
    const vis = vi.fn();
    pa.onVisibilityChange(vis);
    h.regrant('a', []);
    expect(vis).toHaveBeenLastCalledWith(false);
    expect(pa.el.textContent).toBe('');
    expect(column()!.querySelectorAll('.pmd-plugin-panel-tab')).toHaveLength(1);
    pa.show(); // stale handle: no-op
    expect(pa.isVisible()).toBe(false);
    unregisterPlugin('b');
    expect(column()!.querySelectorAll('.pmd-plugin-panel-tab')).toHaveLength(0);
    expect(column()!.hidden).toBe(true);
  });

  it('a stale api object cannot recreate a panel after revoke', () => {
    const h = makeHarness();
    h.register('a', ['ui.panel']);
    const stale = h.api('a');
    h.regrant('a', []);
    expect(() => stale.panel!.get()).toThrow(/not granted/);
  });
});

describe('context-menu builder', () => {
  it('tidies separators, closes before running an action, and closes on request', () => {
    const order: string[] = [];
    showContextMenu(10, 10, [
      { kind: 'separator' },
      { kind: 'item', label: 'One', action: () => order.push(isContextMenuOpen() ? 'open' : 'closed') },
      { kind: 'separator' },
      { kind: 'separator' },
      { kind: 'item', label: 'Two', hint: 'Plugin', action: () => {} },
      { kind: 'separator' },
    ]);
    const menu = document.querySelector('.pmd-nav-context-menu')!;
    expect([...menu.children].map((c) => c.className)).toEqual([
      'pmd-nav-context-item',
      'pmd-nav-context-separator',
      'pmd-nav-context-item',
    ]);
    (menu.children[0] as HTMLButtonElement).click();
    expect(order).toEqual(['closed']);
    showContextMenu(0, 0, [{ kind: 'item', label: 'x', action: () => {} }]);
    expect(isContextMenuOpen()).toBe(true);
    closeContextMenu();
    expect(isContextMenuOpen()).toBe(false);
  });
});
