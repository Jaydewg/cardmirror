/**
 * Plugin annotations — the host side of `api.annotations` (`doc.annotate`).
 *
 * One ProseMirror plugin, shared by every extension, holds each plugin's
 * marks as inline decorations tagged with its id. They are display-only:
 * never in the doc, never saved, never synced to a co-editing session,
 * never on the undo stack. A `set` resolves each anchor against the live
 * doc and REPLACES that plugin's marks there; between sets they map
 * through edits like any decoration.
 *
 * Anchors use ids a plugin already has (from `doc.read` or a menu
 * target), since plugins never see document positions: a heading id,
 * which part of its card, which paragraph of that part, and optionally
 * an exact substring. Mirrored content (live views, linked copies) is
 * never annotated — `doc.read` doesn't report it either.
 *
 * Look: the host draws a fixed set of styles in a fixed palette of theme
 * tokens (`--pmd-c-plugin-mark-*`), so a plugin can't paint something
 * that passes for document formatting (highlight, shading, cite) or for
 * CardMirror's own spellcheck. Right-click on a mark opens a small menu:
 * the plugin-labeled message(s), the plugin's own actions, and a
 * host-owned "Hide" item (per document, this session).
 */
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { registerOpenContextMenu, clearOpenContextMenu } from './context-menu-registry.js';
import { isRightClickContextMenu } from './context-menu-gate.js';
import { notePluginActivation } from './plugin-permission-requests.js';
import { onPluginGrantsChanged, pluginHasPermission } from './plugin-registry.js';

export const ANNOTATE_PERMISSION = 'doc.annotate';

export type PluginAnnotationSeverity = 'error' | 'warning' | 'info';
export type PluginAnnotationPart = 'heading' | 'cite' | 'body' | 'undertag';
export type PluginAnnotationStyle = 'squiggle' | 'underline' | 'dotted' | 'tint' | 'box';
export type PluginAnnotationColor = 'red' | 'amber' | 'blue' | 'green' | 'purple' | 'gray';

const SEVERITIES: readonly PluginAnnotationSeverity[] = ['error', 'warning', 'info'];
const PARTS: readonly PluginAnnotationPart[] = ['heading', 'cite', 'body', 'undertag'];
const STYLES: readonly PluginAnnotationStyle[] = ['squiggle', 'underline', 'dotted', 'tint', 'box'];
const COLORS: readonly PluginAnnotationColor[] = ['red', 'amber', 'blue', 'green', 'purple', 'gray'];

/** What a severity looks like when the plugin doesn't say. */
const SEVERITY_DEFAULTS: Record<PluginAnnotationSeverity, { style: PluginAnnotationStyle; color: PluginAnnotationColor }> = {
  error: { style: 'squiggle', color: 'red' },
  warning: { style: 'squiggle', color: 'amber' },
  info: { style: 'dotted', color: 'blue' },
};

const PART_NODE: Record<Exclude<PluginAnnotationPart, 'heading'>, string> = {
  cite: 'cite_paragraph',
  body: 'card_body',
  undertag: 'undertag',
};

export const ANNOTATION_MAX_ITEMS = 2000;
export const ANNOTATION_MAX_ACTIONS = 2;
const MESSAGE_MAX = 200;
const KEY_MAX = 64;
const MATCH_MAX = 1000;
const ACTION_LABEL_MAX = 40;
const NAME_MAX = 80;

export interface PluginAnnotationAction {
  label: string;
  /** Runs when the user picks it — only while the plugin still holds
   *  `doc.annotate`. A throw (or rejection) is logged. */
  run: () => void | Promise<void>;
}

/** One mark. Unknown fields are ignored, so newer plugins degrade. */
export interface PluginAnnotation {
  /** The heading the mark hangs off: `PluginCard.headingId`, an outline
   *  item's id, or a menu target's `headingId`. */
  headingId: string;
  /** `heading` = the heading itself (any heading type); the others are
   *  paragraphs of the card / analytic unit that heading starts. */
  part: PluginAnnotationPart;
  /** Which paragraph of that part, in order (default 0) — matches the
   *  index into `PluginCard.citeParagraphs` / `body` / `undertags`.
   *  Ignored for `heading`. */
  index?: number;
  /** Exact substring of that paragraph's text to mark; default: the
   *  whole paragraph. */
  match?: string;
  /** Which occurrence of `match` (default 0). */
  occurrence?: number;
  severity: PluginAnnotationSeverity;
  /** Shown on hover and in the right-click menu, labeled with the
   *  plugin's name. ≤ 200 chars. */
  message: string;
  /** Default: by severity (error/warning → squiggle, info → dotted). */
  style?: PluginAnnotationStyle;
  /** A theme color, never raw CSS. Default: by severity (error → red,
   *  warning → amber, info → blue). */
  color?: PluginAnnotationColor;
  /** The plugin's own id for the mark (≤ 64 chars); not shown. */
  key?: string;
  /** Up to 2 right-click actions. */
  actions?: PluginAnnotationAction[];
}

export type PluginAnnotateResult =
  | { ok: true; placed: number; unplaced: number }
  | { ok: false; error: 'no-doc' | 'hidden' };

/** What a decoration carries (its `spec`). */
interface MarkSpec {
  pluginId: string;
  pluginName: string;
  docUid: string;
  message: string;
  severity: PluginAnnotationSeverity;
  actions: { label: string; run: () => void }[];
}

type Meta = { kind: 'set'; pluginId: string; decos: Decoration[] } | { kind: 'clear'; pluginId: string | null };

const key = new PluginKey<DecorationSet>('pluginAnnotations');
/** docUid → plugin ids the user hid there (this session). */
const hidden = new Map<string, Set<string>>();

function clip(text: unknown, max: number): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Find the textblock with heading id `id` outside mirrored content. */
function findHeading(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    const t = node.type.name;
    if (t === 'self_ref' || t === 'transclusion_ref') return false;
    if (node.isTextblock) {
      if (node.attrs['id'] === id) found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** The doc position of text offset `offset` inside the textblock at
 *  `blockPos` (offsets count text the way `textContent` does). */
function textOffsetToPos(block: PMNode, blockPos: number, offset: number): number {
  let acc = 0;
  let out = blockPos + 1 + block.content.size;
  let done = false;
  block.forEach((child, childOffset) => {
    if (done) return;
    const len = child.isText ? child.text!.length : child.textContent.length;
    if (offset <= acc + len) {
      const start = blockPos + 1 + childOffset;
      out = child.isText ? start + (offset - acc) : start;
      done = true;
      return;
    }
    acc += len;
  });
  return out;
}

/** Resolve one anchor to a doc range, or null when it doesn't land. */
function resolveRange(
  doc: PMNode,
  headingPositions: Map<string, number>,
  a: { headingId: string; part: PluginAnnotationPart; index: number; match: string | null; occurrence: number },
): { from: number; to: number } | null {
  let headPos = headingPositions.get(a.headingId);
  if (headPos === undefined) {
    headPos = findHeading(doc, a.headingId);
    headingPositions.set(a.headingId, headPos);
  }
  if (headPos < 0) return null;
  let blockPos = headPos;
  if (a.part !== 'heading') {
    const $head = doc.resolve(headPos);
    const unit = $head.parent;
    if (unit.type.name !== 'card' && unit.type.name !== 'analytic_unit') return null;
    const want = PART_NODE[a.part];
    let seen = 0;
    blockPos = -1;
    unit.forEach((child, offset, i) => {
      if (blockPos >= 0 || i === 0 || child.type.name !== want) return;
      if (seen++ === a.index) blockPos = $head.start() + offset;
    });
    if (blockPos < 0) return null;
  }
  const block = doc.nodeAt(blockPos);
  if (!block || !block.isTextblock) return null;
  const text = block.textContent;
  if (a.match === null) {
    if (!text.trim()) return null;
    return { from: blockPos + 1, to: blockPos + 1 + block.content.size };
  }
  let at = -1;
  for (let n = 0, from = 0; n <= a.occurrence; n++) {
    at = text.indexOf(a.match, from);
    if (at < 0) return null;
    from = at + 1;
  }
  const from = textOffsetToPos(block, blockPos, at);
  const to = textOffsetToPos(block, blockPos, at + a.match.length);
  return to > from ? { from, to } : null;
}

/** Validate a plugin's list and build its decorations against `view`'s
 *  current doc. Bad entries (wrong shape, anchor not found) count as
 *  unplaced; a non-array is a programming error and throws. */
export function buildAnnotationDecorations(
  doc: PMNode,
  items: unknown,
  ctx: { pluginId: string; pluginName: string; docUid: string },
): { decos: Decoration[]; placed: number; unplaced: number } {
  if (!Array.isArray(items)) throw new Error('annotations.set needs an array');
  if (items.length > ANNOTATION_MAX_ITEMS) {
    throw new Error(`annotations.set takes at most ${ANNOTATION_MAX_ITEMS} annotations per document`);
  }
  const decos: Decoration[] = [];
  const headingPositions = new Map<string, number>();
  const pluginName = clip(ctx.pluginName, NAME_MAX);
  let unplaced = 0;
  for (const raw of items as unknown[]) {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const headingId = typeof a['headingId'] === 'string' ? a['headingId'] : '';
    const part = pick(a['part'], PARTS);
    const severity = pick(a['severity'], SEVERITIES) ?? 'info';
    const message = clip(a['message'], MESSAGE_MAX);
    const rawMatch = a['match'];
    const match = typeof rawMatch === 'string' && rawMatch ? rawMatch : null;
    // An over-long match can't be clipped (it would mark the wrong text).
    if (!headingId || !part || !message || (match !== null && match.length > MATCH_MAX)) {
      unplaced++;
      continue;
    }
    const range = resolveRange(doc, headingPositions, {
      headingId,
      part,
      index: nonNegInt(a['index']),
      match,
      occurrence: nonNegInt(a['occurrence']),
    });
    if (!range) {
      unplaced++;
      continue;
    }
    const style = pick(a['style'], STYLES) ?? SEVERITY_DEFAULTS[severity].style;
    const color = pick(a['color'], COLORS) ?? SEVERITY_DEFAULTS[severity].color;
    const rawActions: unknown[] = Array.isArray(a['actions']) ? (a['actions'] as unknown[]).slice(0, ANNOTATION_MAX_ACTIONS) : [];
    const actions: MarkSpec['actions'] = [];
    for (const entry of rawActions) {
      const act = (entry && typeof entry === 'object' ? entry : {}) as Partial<PluginAnnotationAction>;
      const run = act.run;
      const label = clip(act.label, ACTION_LABEL_MAX);
      if (typeof run !== 'function' || !label) continue;
      actions.push({ label, run: () => runAction(ctx.pluginId, run) });
    }
    const spec: MarkSpec = { pluginId: ctx.pluginId, pluginName, docUid: ctx.docUid, message, severity, actions };
    decos.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: `pmd-plugin-mark pmd-plugin-mark--${style} pmd-plugin-mark--${color}`,
          title: `[${pluginName}] ${message}`,
        },
        spec,
      ),
    );
  }
  return { decos, placed: decos.length, unplaced };
}

function runAction(pluginId: string, run: () => void | Promise<void>): void {
  // Revoked or unregistered since the mark was set: inert.
  if (!pluginHasPermission(pluginId, ANNOTATE_PERMISSION)) return;
  notePluginActivation(pluginId, 'user');
  const report = (err: unknown): void => console.error(`[plugins] ${pluginId} annotation action failed:`, err);
  try {
    const r = run();
    if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(undefined, report);
  } catch (err) {
    report(err);
  }
}

function dispatchMeta(view: EditorView, meta: Meta): void {
  view.dispatch(view.state.tr.setMeta(key, meta).setMeta('addToHistory', false));
}

/** `api.annotations.set` for one plugin on one view. */
export function setPluginAnnotations(
  view: EditorView,
  docUid: string,
  pluginId: string,
  pluginName: string,
  items: unknown,
): PluginAnnotateResult {
  if (key.get(view.state) === undefined) return { ok: false, error: 'no-doc' };
  // Validate first: a malformed call throws even where marks are hidden.
  const built = buildAnnotationDecorations(view.state.doc, items, { pluginId, pluginName, docUid });
  if (hidden.get(docUid)?.has(pluginId)) return { ok: false, error: 'hidden' };
  dispatchMeta(view, { kind: 'set', pluginId, decos: built.decos });
  return { ok: true, placed: built.placed, unplaced: built.unplaced };
}

/** `api.annotations.clear` for one plugin on one view. */
export function clearPluginAnnotations(view: EditorView, pluginId: string): void {
  if (!hasMarks(view, pluginId)) return;
  dispatchMeta(view, { kind: 'clear', pluginId });
}

function hasMarks(view: EditorView, pluginId: string | null): boolean {
  const set = key.getState(view.state);
  if (!set) return false;
  return set.find(undefined, undefined, (s: MarkSpec) => pluginId === null || s.pluginId === pluginId).length > 0;
}

/** The menu's "Hide markings from <plugin> in this document": clear
 *  them, and refuse that plugin's `set` there for the rest of the
 *  session (it answers `{ ok: false, error: 'hidden' }`). */
export function hidePluginAnnotations(view: EditorView, docUid: string, pluginId: string): void {
  let set = hidden.get(docUid);
  if (!set) hidden.set(docUid, (set = new Set()));
  set.add(pluginId);
  clearPluginAnnotations(view, pluginId);
}

function applyMeta(set: DecorationSet, tr: Transaction): DecorationSet {
  let next = set.map(tr.mapping, tr.doc);
  const meta = tr.getMeta(key) as Meta | undefined;
  if (!meta) return next;
  const mine = next.find(undefined, undefined, (s: MarkSpec) => meta.pluginId === null || s.pluginId === meta.pluginId);
  if (mine.length) next = next.remove(mine);
  if (meta.kind === 'set' && meta.decos.length) next = next.add(tr.doc, meta.decos);
  return next;
}

export function pluginAnnotationsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, set) => (tr.docChanged || tr.getMeta(key) ? applyMeta(set, tr) : set),
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
      handleDOMEvents: {
        // Right-click on a mark → its menu. Registered after spellcheck
        // (a misspelling inside a mark keeps the spelling menu) and
        // before the fallback text menu, which claims every right-click.
        contextmenu(view, event) {
          if (!isRightClickContextMenu(event)) return false;
          const set = key.getState(view.state);
          if (!set) return false;
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!coords) return false;
          const pos = coords.pos;
          const hits = set
            .find(Math.max(0, pos - 1), pos + 1)
            .filter((d) => d.from <= pos && pos <= d.to && pluginHasPermission((d.spec as MarkSpec).pluginId, ANNOTATE_PERMISSION));
          if (hits.length === 0) return false;
          event.preventDefault();
          showMarkMenu(event.clientX, event.clientY, view, hits.map((d) => d.spec as MarkSpec));
          return true;
        },
      },
    },
    view(view) {
      // A plugin that loses `doc.annotate` (revoke, unregister) loses its
      // marks in every view at once.
      const off = onPluginGrantsChanged((pluginId) => {
        if (!pluginHasPermission(pluginId, ANNOTATE_PERMISSION)) clearPluginAnnotations(view, pluginId);
      });
      return { destroy: off };
    },
  });
}

// ─── Right-click menu ──────────────────────────────────────────────

interface MenuItem {
  label: string;
  separatorBefore?: boolean;
  disabled?: boolean;
  action?: () => void;
}

let openMenuEl: HTMLElement | null = null;

function showMarkMenu(x: number, y: number, view: EditorView, specs: MarkSpec[]): void {
  closeMarkMenu();
  const items: MenuItem[] = [];
  const plugins = new Map<string, MarkSpec>();
  specs.forEach((s, i) => {
    items.push({ label: `[${s.pluginName}] ${s.message}`, disabled: true, separatorBefore: i > 0 });
    for (const act of s.actions) items.push({ label: act.label, action: act.run });
    if (!plugins.has(s.pluginId)) plugins.set(s.pluginId, s);
  });
  let first = true;
  for (const s of plugins.values()) {
    items.push({
      label: `Hide markings from ${s.pluginName} in this document`,
      separatorBefore: first,
      action: () => hidePluginAnnotations(view, s.docUid, s.pluginId),
    });
    first = false;
  }

  const menu = document.createElement('div');
  menu.className = 'pmd-nav-context-menu pmd-plugin-mark-menu';
  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement('div');
      sep.className = 'pmd-nav-context-separator';
      menu.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-nav-context-item';
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add('pmd-nav-context-item-disabled', 'pmd-plugin-mark-menu-message');
    }
    btn.addEventListener('click', () => {
      if (item.disabled || !item.action) return;
      closeMarkMenu();
      item.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, Math.max(0, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.min(y, Math.max(0, window.innerHeight - rect.height - 4))}px`;
  openMenuEl = menu;
  registerOpenContextMenu(closeMarkMenu);
  setTimeout(() => {
    window.addEventListener('mousedown', maybeCloseMarkMenu, { capture: true });
    window.addEventListener('keydown', maybeCloseMarkMenu, { capture: true });
  });
}

function closeMarkMenu(): void {
  clearOpenContextMenu(closeMarkMenu);
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  window.removeEventListener('mousedown', maybeCloseMarkMenu, { capture: true });
  window.removeEventListener('keydown', maybeCloseMarkMenu, { capture: true });
}

function maybeCloseMarkMenu(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeMarkMenu();
    return;
  }
  if (openMenuEl && !openMenuEl.contains(e.target as Node)) closeMarkMenu();
}

/** Test hook: forget hidden-per-doc choices and the open menu. */
export function resetPluginAnnotationsForTests(): void {
  hidden.clear();
  closeMarkMenu();
}
