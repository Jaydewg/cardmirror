/**
 * `ui.panel` → `api.panel`: a right-side docked column the plugin draws
 * into.
 *
 * The HOST owns the frame: the column, one tab per plugin (always naming
 * the plugin, so its UI can't pass for CardMirror's), the hide button,
 * the resize handle, width persistence, and teardown when the plugin
 * loses `ui.panel` or unregisters. The PLUGIN owns only what's inside
 * its `el` — plain DOM in the page, so it inherits the theme tokens
 * (`--pmd-c-*`, dark mode) for free. (Not an iframe: plugins already run
 * with full access, so a frame would add no isolation, would lose the
 * theme, and is blocked by the Lite web build's CSP.)
 *
 * Not modal: no overlay-stack entry, so the editor keeps its keys.
 */
import { notePluginActivation } from '../plugin-permission-requests.js';
import { onPluginGrantsChanged, pluginHasPermission } from '../plugin-registry.js';
import { PLUGIN_PANEL_MAX_WIDTH, PLUGIN_PANEL_MIN_WIDTH, settings } from '../settings.js';
import { clip, type CapabilityContext } from './context.js';

const PERMISSION = 'ui.panel';
const TITLE_MAX = 40;

/** The plugin's panel. Everything is a no-op after the plugin loses
 *  `ui.panel`; call `api.panel.get()` again once it's granted. */
export interface PluginPanelHandle {
  /** Render into this. Emptied when the plugin loses the permission. */
  readonly el: HTMLElement;
  /** The tab label (the plugin's name is always shown with it). */
  setTitle(title: string): void;
  /** Open the panel column on this plugin's tab. */
  show(): void;
  /** Close the column if this plugin's tab is the one showing. */
  hide(): void;
  /** Column open AND this plugin's tab active. */
  isVisible(): boolean;
  /** Fires when `isVisible()` changes. Returns an unsubscribe. */
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
}

/** `ui.panel` permission. */
export interface PluginPanelApi {
  /** This plugin's panel (created hidden on first call; the same handle
   *  afterwards). */
  get(opts?: { title?: string }): PluginPanelHandle;
}

interface PanelEntry {
  pluginName: string;
  handle: PluginPanelHandle;
  tab: HTMLButtonElement;
  label: HTMLSpanElement;
  content: HTMLElement;
  listeners: Set<(visible: boolean) => void>;
  lastVisible: boolean;
}

const panels = new Map<string, PanelEntry>();
let column: HTMLElement | null = null;
let tabStrip: HTMLElement | null = null;
let body: HTMLElement | null = null;
let activeId: string | null = null;
let unsubscribeGrants: (() => void) | null = null;

function applyWidth(px: number): void {
  document.documentElement.style.setProperty('--pmd-plugin-panel-width', `${px}px`);
}

function clampWidth(px: number): number {
  return Math.max(PLUGIN_PANEL_MIN_WIDTH, Math.min(PLUGIN_PANEL_MAX_WIDTH, Math.round(px)));
}

/** Build the column once. Three-pane mode mounts it in the shell row
 *  (beside the comments column, like a narrow extra slot); single-doc
 *  pins it to the viewport's right edge (CSS). */
function ensureColumn(): HTMLElement {
  if (column) return column;
  column = document.createElement('aside');
  column.id = 'plugin-panel';
  column.className = 'pmd-plugin-panel';
  column.setAttribute('aria-label', 'Plugin panel');
  column.hidden = true;

  const handle = document.createElement('div');
  handle.className = 'pmd-plugin-panel-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.title = 'Drag to resize (double-click to reset)';
  installResize(handle);

  const header = document.createElement('div');
  header.className = 'pmd-plugin-panel-header';
  tabStrip = document.createElement('div');
  tabStrip.className = 'pmd-plugin-panel-tabs';
  tabStrip.setAttribute('role', 'tablist');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pmd-plugin-panel-close';
  close.title = 'Hide plugin panel';
  close.setAttribute('aria-label', 'Hide plugin panel');
  close.textContent = '×';
  close.addEventListener('click', () => setColumnVisible(false));
  header.append(tabStrip, close);

  body = document.createElement('div');
  body.className = 'pmd-plugin-panel-body';
  column.append(handle, header, body);

  applyWidth(settings.get('pluginPanelWidth'));
  (document.querySelector('.pmd-multi-shell') ?? document.body).append(column);
  unsubscribeGrants ??= onPluginGrantsChanged((id) => {
    if (panels.has(id) && !pluginHasPermission(id, PERMISSION)) removePanel(id);
  });
  return column;
}

function installResize(handle: HTMLElement): void {
  handle.addEventListener('dblclick', () => {
    applyWidth(320);
    settings.set('pluginPanelWidth', 320);
  });
  handle.addEventListener('pointerdown', (e) => {
    if (!column) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = column.getBoundingClientRect().width;
    let width = startW;
    handle.setPointerCapture?.(e.pointerId);
    document.body.classList.add('pmd-plugin-panel-resizing');
    const move = (ev: PointerEvent): void => {
      width = clampWidth(startW + (startX - ev.clientX)); // left edge: drag left = wider
      applyWidth(width);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('pmd-plugin-panel-resizing');
      settings.set('pluginPanelWidth', width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function isVisible(id: string): boolean {
  return !!column && !column.hidden && activeId === id;
}

/** Recompute every panel's visibility and notify the ones that changed. */
function syncVisibility(): void {
  for (const [id, entry] of panels) {
    const active = id === activeId;
    entry.content.hidden = !active;
    entry.tab.setAttribute('aria-selected', String(active));
    entry.tab.classList.toggle('pmd-plugin-panel-tab-active', active);
    const visible = isVisible(id);
    if (visible === entry.lastVisible) continue;
    entry.lastVisible = visible;
    for (const cb of [...entry.listeners]) {
      try {
        cb(visible);
      } catch (err) {
        console.error(`[plugins] ${id} panel visibility listener failed:`, err);
      }
    }
  }
}

function setColumnVisible(visible: boolean): void {
  if (!column) return;
  column.hidden = !visible || panels.size === 0;
  syncVisibility();
}

function activate(id: string): void {
  activeId = id;
  setColumnVisible(true);
}

function removePanel(id: string): void {
  const entry = panels.get(id);
  if (!entry) return;
  if (entry.lastVisible) {
    entry.lastVisible = false;
    for (const cb of [...entry.listeners]) {
      try {
        cb(false);
      } catch {
        /* plugin is being torn down */
      }
    }
  }
  entry.listeners.clear();
  entry.content.replaceChildren();
  entry.tab.remove();
  entry.content.remove();
  panels.delete(id);
  if (activeId === id) activeId = panels.keys().next().value ?? null;
  setColumnVisible(column ? !column.hidden : false);
}

function createPanel(ctx: CapabilityContext, title: string): PanelEntry {
  ensureColumn();
  const { pluginId } = ctx;
  const pluginName = clip(ctx.name || pluginId, TITLE_MAX);
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'pmd-plugin-panel-tab';
  tab.setAttribute('role', 'tab');
  const label = document.createElement('span');
  label.className = 'pmd-plugin-panel-tab-label';
  tab.append(label);
  tab.addEventListener('click', () => activate(pluginId));

  const content = document.createElement('div');
  content.className = 'pmd-plugin-panel-content';
  content.setAttribute('role', 'tabpanel');
  content.dataset.plugin = pluginId;
  content.hidden = true;
  // Using the panel counts as acting on the plugin: it may then ask for
  // a permission it needs (api.permissions.request).
  const used = (): void => notePluginActivation(pluginId, 'user');
  content.addEventListener('pointerdown', used, true);
  content.addEventListener('keydown', used, true);
  tabStrip!.append(tab);
  body!.append(content);

  const live = (): boolean => panels.get(pluginId)?.content === content;
  const entry: PanelEntry = {
    pluginName,
    tab,
    label,
    content,
    listeners: new Set(),
    lastVisible: false,
    handle: Object.freeze({
      el: content,
      setTitle: (t: string) => {
        if (live()) setTabTitle(entry, t);
      },
      show: () => {
        if (live() && pluginHasPermission(pluginId, PERMISSION)) activate(pluginId);
      },
      hide: () => {
        if (live() && activeId === pluginId) setColumnVisible(false);
      },
      isVisible: () => live() && isVisible(pluginId),
      onVisibilityChange: (cb: (visible: boolean) => void) => {
        if (typeof cb !== 'function') throw new Error('panel.onVisibilityChange needs a function');
        if (!live()) return () => {};
        entry.listeners.add(cb);
        return () => entry.listeners.delete(cb);
      },
    }),
  };
  setTabTitle(entry, title);
  panels.set(pluginId, entry);
  activeId ??= pluginId;
  syncVisibility();
  return entry;
}

/** Tab text is the plugin's title; the plugin's NAME is always visible
 *  beside it when the two differ (attribution). */
function setTabTitle(entry: PanelEntry, title: string): void {
  const t = clip(String(title ?? '').trim() || entry.pluginName, TITLE_MAX);
  entry.label.textContent = t;
  entry.tab.querySelector('.pmd-plugin-panel-tab-owner')?.remove();
  if (t !== entry.pluginName) {
    const owner = document.createElement('span');
    owner.className = 'pmd-plugin-panel-tab-owner';
    owner.textContent = entry.pluginName;
    entry.tab.append(owner);
  }
  entry.tab.title = `${t} — ${entry.pluginName} (plugin)`;
}

export function buildPanelApi(ctx: CapabilityContext): PluginPanelApi | undefined {
  if (!ctx.granted.has(PERMISSION)) return undefined;
  return Object.freeze({
    get(opts?: { title?: string }) {
      // Re-check at call time: a stale api object must not resurrect a
      // panel after a revoke.
      if (!pluginHasPermission(ctx.pluginId, PERMISSION)) {
        throw new Error('ui.panel is not granted');
      }
      const existing = panels.get(ctx.pluginId);
      if (existing) {
        if (opts?.title !== undefined) setTabTitle(existing, opts.title);
        return existing.handle;
      }
      return createPanel(ctx, opts?.title ?? '').handle;
    },
  });
}

export function resetPluginPanelsForTests(): void {
  for (const id of [...panels.keys()]) removePanel(id);
  column?.remove();
  column = tabStrip = body = null;
  activeId = null;
  unsubscribeGrants?.();
  unsubscribeGrants = null;
}
