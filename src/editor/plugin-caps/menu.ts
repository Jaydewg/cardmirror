/**
 * `ui.contextMenu` → `api.menu`: plugin items in the editor's right-click
 * menu and the outline (nav-pane) row menu.
 *
 * Menus ask `pluginMenuEntries(target)` for the granted plugins' items
 * and append them after a separator; each item shows the plugin's name
 * as its hint (attribution). Grants are checked when the menu opens, so
 * a revoked plugin's items simply stop appearing.
 */
import type { MenuEntry } from '../context-menu-builder.js';
import { pluginDisplayName } from '../plugin-registry.js';
import { clip, type CapabilityContext } from './context.js';
import { createPluginHookRegistry } from './hook-registry.js';
import type { PluginHeadingType } from './doc-read.js';

/** What was right-clicked. */
export interface PluginMenuTarget {
  /** `text`: the editor body. `outline`: a nav-pane heading row. */
  surface: 'text' | 'outline';
  /** Session uid of the doc, or null if unknown. */
  docUid: string | null;
  /** The heading row clicked (outline), or the heading governing the
   *  selection (text) — a card's tag when inside a card. */
  headingId: string | null;
  headingType: PluginHeadingType | null;
  /** Selected text (text surface), '' otherwise. */
  selectionText: string;
}

export interface PluginMenuItem {
  label: string;
  /** When to show it: `always` (default), only with a non-empty
   *  `selection`, or only when there's a `heading` target. */
  when?: 'always' | 'selection' | 'heading';
  run(target: PluginMenuTarget): void | Promise<void>;
}

/** `ui.contextMenu` permission. */
export interface PluginMenuApi {
  /** Add an item (at most 5 per plugin). Returns a remover. */
  add(item: PluginMenuItem): () => void;
}

const PERMISSION = 'ui.contextMenu';
const MAX_ITEMS_PER_PLUGIN = 5;
const LABEL_MAX = 60;
const SELECTION_MAX = 10_000;

const items = createPluginHookRegistry<PluginMenuItem>(PERMISSION);

function applies(item: PluginMenuItem, target: PluginMenuTarget): boolean {
  if (item.when === 'selection') return target.selectionText.length > 0;
  if (item.when === 'heading') return target.headingId != null;
  return true;
}

/** The granted plugins' entries for a menu opening on a target (empty
 *  when none), preceded by a separator. `target` is a thunk so a menu
 *  pays for resolving it only when some plugin has items. */
export function pluginMenuEntries(target: () => PluginMenuTarget): MenuEntry[] {
  if (!items.any()) return [];
  const t = target();
  const frozen: PluginMenuTarget = Object.freeze({
    ...t,
    selectionText: clip(t.selectionText, SELECTION_MAX),
  });
  const out: MenuEntry[] = [];
  for (const [pluginId, item] of items.entries()) {
    if (!applies(item, frozen)) continue;
    out.push({
      kind: 'item',
      label: item.label,
      hint: pluginDisplayName(pluginId) ?? pluginId,
      action: () => {
        const report = (err: unknown): void =>
          console.error(`[plugins] ${pluginId} menu item "${item.label}" failed:`, err);
        try {
          const r = item.run(frozen);
          if (r && typeof (r as Promise<void>).catch === 'function') void (r as Promise<void>).catch(report);
        } catch (err) {
          report(err);
        }
      },
    });
  }
  return out.length > 0 ? [{ kind: 'separator' }, ...out] : [];
}

export function buildMenuApi(ctx: CapabilityContext): PluginMenuApi | undefined {
  if (!ctx.granted.has(PERMISSION)) return undefined;
  const { pluginId } = ctx;
  return Object.freeze({
    add(item: PluginMenuItem) {
      if (!item || typeof item.run !== 'function' || typeof item.label !== 'string' || !item.label.trim()) {
        throw new Error('menu.add needs { label, run }');
      }
      if (item.when !== undefined && !['always', 'selection', 'heading'].includes(item.when)) {
        throw new Error('menu.add: when must be always | selection | heading');
      }
      if (items.forPlugin(pluginId).length >= MAX_ITEMS_PER_PLUGIN) {
        throw new Error(`menu.add: at most ${MAX_ITEMS_PER_PLUGIN} items per plugin`);
      }
      // Snapshot (a getter can't change the label after validation).
      const snapshot: PluginMenuItem = Object.freeze({
        label: clip(item.label.trim(), LABEL_MAX),
        when: item.when ?? 'always',
        run: item.run,
      });
      return items.add(pluginId, snapshot);
    },
  });
}

export function resetPluginMenuForTests(): void {
  items.clear();
}
