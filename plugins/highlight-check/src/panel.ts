/**
 * The Highlight Check panel: findings grouped by card, each with a
 * preview of its sentence in which the read-aloud text stands out and
 * the flagged words are underlined. Plain DOM inside the host's panel
 * `el`; colors come from the app's theme variables (`--pmd-c-*`), so it
 * follows dark mode. All document text goes through textContent.
 */
import type { Finding, Severity } from './analyze.js';

export interface PanelFinding extends Finding {
  /** The text the finding's offsets point into (paragraph or tag). */
  text: string;
  /** Read ranges of that text (`[]` for the tag). */
  read: readonly (readonly [number, number])[];
  /** Ignore key, or null when the card has no heading id. */
  ignoreKey: string | null;
}

export interface PanelCard {
  headingId: string | null;
  heading: string;
  findings: PanelFinding[];
}

export type PanelFilter = 'all' | 'warning' | 'error';

export interface PanelModel {
  title: string;
  cards: PanelCard[];
  /** False = this document hasn't been checked yet. */
  checked: boolean;
  /** Edited since the last check (live refresh off). */
  stale: boolean;
  live: boolean;
  filter: PanelFilter;
  ignoredCount: number;
  /** Why nothing can be shown (permission, old build, no doc). */
  blocked: string | null;
  /** Scroll this card into view after rendering. */
  focusHeadingId: string | null;
}

export interface PanelHandlers {
  jump(headingId: string): void;
  ignore(key: string): void;
  recheck(): void;
  setFilter(filter: PanelFilter): void;
  restoreIgnored(): void;
}

const CSS = `
.hc-root { font-size: 13px; color: var(--pmd-c-text, inherit); display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.hc-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.hc-title { font-weight: 600; flex: 1 1 100%; overflow-wrap: anywhere; }
.hc-counts { flex: 1 1 auto; color: var(--pmd-c-text-muted, #666); }
.hc-btn { font: inherit; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--pmd-c-border, #ccc); background: var(--pmd-c-surface, transparent); color: inherit; cursor: pointer; }
.hc-btn:hover { background: var(--pmd-c-hover, rgba(127,127,127,.12)); }
.hc-note { color: var(--pmd-c-text-muted, #666); font-size: 12px; }
.hc-stale { color: var(--pmd-c-warning, #b45309); font-size: 12px; }
.hc-card { border-top: 1px solid var(--pmd-c-border, #ddd); padding-top: 6px; }
.hc-card.hc-focus { outline: 2px solid var(--pmd-c-accent, #2563eb); outline-offset: 2px; border-radius: 3px; }
.hc-card-head { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.hc-card-head:hover { text-decoration: underline; }
.hc-card-head:disabled { cursor: default; text-decoration: none; }
.hc-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.hc-item { display: grid; grid-template-columns: 8px 1fr auto; column-gap: 6px; align-items: baseline; }
.hc-dot { width: 8px; height: 8px; border-radius: 50%; transform: translateY(-1px); }
.hc-dot.hc-error { background: var(--pmd-c-plugin-mark-red, #d32f2f); }
.hc-dot.hc-warning { background: var(--pmd-c-plugin-mark-amber, #d97706); }
.hc-dot.hc-info { background: var(--pmd-c-plugin-mark-blue, #2563eb); }
.hc-msg { background: none; border: 0; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.hc-msg:hover { text-decoration: underline; }
.hc-msg:disabled { cursor: default; text-decoration: none; }
.hc-ignore { font-size: 11px; padding: 0 5px; }
.hc-preview { grid-column: 2 / 4; margin-top: 2px; font-size: 12px; line-height: 1.45; color: var(--pmd-c-text-muted, #666); overflow-wrap: anywhere; }
.hc-preview .hc-read { color: var(--pmd-c-text, inherit); font-weight: 600; }
.hc-preview .hc-flag { text-decoration: wavy underline; text-decoration-skip-ink: none; text-underline-offset: 2px; }
.hc-preview .hc-flag.hc-error { text-decoration-color: var(--pmd-c-plugin-mark-red, #d32f2f); }
.hc-preview .hc-flag.hc-warning { text-decoration-color: var(--pmd-c-plugin-mark-amber, #d97706); }
.hc-preview .hc-flag.hc-info { text-decoration-color: var(--pmd-c-plugin-mark-blue, #2563eb); }
.hc-empty { color: var(--pmd-c-text-muted, #666); padding: 8px 0; }
`;

const SEVERITY_LABEL: Record<Severity, string> = { error: 'May reverse the card', warning: 'Check this', info: 'Note' };
/** Longest preview before it is cut around the flagged words. */
const PREVIEW_MAX = 220;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function countBySeverity(cards: readonly PanelCard[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const card of cards) for (const f of card.findings) c[f.severity]++;
  return c;
}

/** The preview window: the finding's context, cut around the flagged
 *  words (at word boundaries) when it is long. */
export function previewWindow(f: Pick<PanelFinding, 'text' | 'from' | 'to' | 'context'>): { from: number; to: number } {
  let { from, to } = f.context;
  if (to - from <= PREVIEW_MAX) return { from, to };
  const side = Math.max(30, Math.floor((PREVIEW_MAX - (f.to - f.from)) / 2));
  from = Math.max(from, f.from - side);
  to = Math.min(to, f.to + side);
  while (from > f.context.from && /\S/.test(f.text[from - 1]!)) from++;
  while (to < f.context.to && /\S/.test(f.text[to]!)) to--;
  return { from: Math.min(from, f.from), to: Math.max(to, f.to) };
}

function renderPreview(f: PanelFinding): HTMLElement {
  const box = el('div', 'hc-preview');
  const win = previewWindow(f);
  const isRead = (i: number): boolean => f.read.some(([a, b]) => i >= a && i < b);
  const isFlag = (i: number): boolean => i >= f.from && i < f.to;
  if (win.from > f.context.from) box.append('…');
  let i = win.from;
  while (i < win.to) {
    const read = isRead(i);
    const flag = isFlag(i);
    let j = i + 1;
    while (j < win.to && isRead(j) === read && isFlag(j) === flag) j++;
    const cls = [read ? 'hc-read' : '', flag ? `hc-flag hc-${f.severity}` : ''].filter(Boolean).join(' ');
    box.append(cls ? el('span', cls, f.text.slice(i, j)) : f.text.slice(i, j));
    i = j;
  }
  if (win.to < f.context.to) box.append('…');
  box.title = 'Bold text is read aloud; the underlined words are the problem.';
  return box;
}

export function renderPanel(root: HTMLElement, model: PanelModel, h: PanelHandlers): void {
  root.replaceChildren();
  const style = el('style');
  style.textContent = CSS;
  const wrap = el('div', 'hc-root');
  root.append(style, wrap);

  const head = el('div', 'hc-head');
  head.append(el('div', 'hc-title', model.title));
  wrap.append(head);
  if (model.blocked) {
    wrap.append(el('div', 'hc-empty', model.blocked));
    return;
  }

  const counts = countBySeverity(model.cards);
  if (model.checked) {
    head.append(el('span', 'hc-counts', `${counts.error} red · ${counts.warning} amber · ${counts.info} notes`));
    const filter = el('select', 'hc-btn');
    filter.setAttribute('aria-label', 'Show');
    for (const [value, label] of [
      ['all', 'All'],
      ['warning', 'Red + amber'],
      ['error', 'Red only'],
    ] as const) {
      const o = el('option', undefined, label);
      o.value = value;
      o.selected = model.filter === value;
      filter.append(o);
    }
    filter.addEventListener('change', () => h.setFilter(filter.value as PanelFilter));
    head.append(filter);
  }
  const recheck = el('button', 'hc-btn', model.checked ? 'Re-check' : 'Check');
  recheck.type = 'button';
  recheck.addEventListener('click', () => h.recheck());
  head.append(recheck);

  if (model.live) wrap.append(el('div', 'hc-note', 'Re-checks as you edit.'));
  else if (model.stale) wrap.append(el('div', 'hc-stale', 'The document changed since this check. Re-check to update.'));
  if (model.ignoredCount > 0) {
    const note = el('div', 'hc-note', `${model.ignoredCount} ignored. `);
    const restore = el('button', 'hc-btn hc-ignore', 'Restore');
    restore.type = 'button';
    restore.addEventListener('click', () => h.restoreIgnored());
    note.append(restore);
    wrap.append(note);
  }
  if (!model.checked) {
    wrap.append(el('div', 'hc-empty', 'Not checked yet. Press Check to look for highlighting that changes what a card says.'));
    return;
  }

  const keep = (s: Severity): boolean => model.filter === 'all' || (model.filter === 'warning' ? s !== 'info' : s === 'error');
  let shown = 0;
  let focusEl: HTMLElement | null = null;
  for (const card of model.cards) {
    const findings = card.findings.filter((f) => keep(f.severity));
    if (findings.length === 0) continue;
    shown++;
    const box = el('section', 'hc-card');
    const id = card.headingId;
    const top = el('button', 'hc-card-head', card.heading || '(untitled card)');
    top.type = 'button';
    if (id) top.addEventListener('click', () => h.jump(id));
    else {
      top.disabled = true;
      top.title = 'This card has no heading id yet, so it can’t be marked or jumped to.';
    }
    box.append(top);
    const list = el('ul', 'hc-list');
    for (const f of findings) {
      const li = el('li', 'hc-item');
      const dot = el('span', `hc-dot hc-${f.severity}`);
      dot.title = SEVERITY_LABEL[f.severity];
      dot.setAttribute('aria-label', SEVERITY_LABEL[f.severity]);
      const msg = el('button', 'hc-msg', f.message);
      msg.type = 'button';
      if (id) msg.addEventListener('click', () => h.jump(id));
      else msg.disabled = true;
      li.append(dot, msg);
      const key = f.ignoreKey;
      if (key) {
        const ig = el('button', 'hc-btn hc-ignore', 'Ignore');
        ig.type = 'button';
        ig.title = 'Hide this finding (saved with the file)';
        ig.addEventListener('click', () => h.ignore(key));
        li.append(ig);
      } else {
        li.append(el('span'));
      }
      li.append(renderPreview(f));
      list.append(li);
    }
    box.append(list);
    if (id && id === model.focusHeadingId) {
      box.classList.add('hc-focus');
      focusEl = box;
    }
    wrap.append(box);
  }
  if (shown === 0) {
    wrap.append(
      el(
        'div',
        'hc-empty',
        model.cards.some((c) => c.findings.length) ? 'Nothing at this level. Pick “All” to see the rest.' : 'No suspicious highlighting found.',
      ),
    );
  }
  focusEl?.scrollIntoView?.({ block: 'nearest' });
}
