/**
 * The Cite Check panel: findings grouped by card, plus the online ✓s.
 * Plain DOM inside the host's panel `el`; colors come from the app's
 * theme variables (`--pmd-c-*`), so it follows dark mode. All text goes
 * through textContent.
 */
import type { Confirmation, Finding, Severity } from './findings.js';

export interface PanelCard {
  headingId: string | null;
  heading: string;
  short: string;
  findings: Finding[];
  confirmations: Confirmation[];
}

export type PanelFilter = 'all' | 'error' | 'warning';

export interface PanelModel {
  title: string;
  cards: PanelCard[];
  filter: PanelFilter;
  ignoredCount: number;
  /** Verify progress, or null when idle. */
  verifying: { done: number; total: number } | null;
  /** One line under the header (e.g. what couldn't be checked). */
  note: string | null;
  /** Why the panel can't show anything (missing permission, no doc). */
  blocked: string | null;
  /** Scroll this card into view after rendering. */
  focusHeadingId: string | null;
}

export interface PanelHandlers {
  jump(headingId: string, part: 'heading' | 'cite'): void;
  ignore(headingId: string, ruleId: string): void;
  recheck(): void;
  verify(): void;
  setFilter(filter: PanelFilter): void;
  restoreIgnored(): void;
}

const CSS = `
.cc-root { font-size: 13px; color: var(--pmd-c-text, inherit); display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.cc-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cc-title { font-weight: 600; flex: 1 1 100%; overflow-wrap: anywhere; }
.cc-counts { flex: 1 1 auto; color: var(--pmd-c-text-muted, #666); }
.cc-btn { font: inherit; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--pmd-c-border, #ccc); background: var(--pmd-c-surface, transparent); color: inherit; cursor: pointer; }
.cc-btn:hover { background: var(--pmd-c-hover, rgba(127,127,127,.12)); }
.cc-btn:disabled { opacity: .5; cursor: default; }
.cc-note { color: var(--pmd-c-text-muted, #666); font-size: 12px; }
.cc-card { border-top: 1px solid var(--pmd-c-border, #ddd); padding-top: 6px; }
.cc-card.cc-focus { outline: 2px solid var(--pmd-c-accent, #2563eb); outline-offset: 2px; border-radius: 3px; }
.cc-card-head { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.cc-card-head:hover .cc-tag { text-decoration: underline; }
.cc-tag { font-weight: 600; }
.cc-short { color: var(--pmd-c-text-muted, #666); margin-left: 4px; }
.cc-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.cc-item { display: flex; gap: 6px; align-items: baseline; }
.cc-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; transform: translateY(-1px); }
.cc-dot.cc-error { background: var(--pmd-c-plugin-mark-red, #d32f2f); }
.cc-dot.cc-warning { background: var(--pmd-c-plugin-mark-amber, #d97706); }
.cc-dot.cc-info { background: var(--pmd-c-plugin-mark-blue, #2563eb); }
.cc-msg { flex: 1; background: none; border: 0; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.cc-msg:hover { text-decoration: underline; }
.cc-ignore { flex: none; font-size: 11px; padding: 0 5px; }
.cc-ok { color: var(--pmd-c-plugin-mark-green, #15803d); font-size: 12px; }
.cc-empty { color: var(--pmd-c-text-muted, #666); padding: 8px 0; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SEVERITY_LABEL: Record<Severity, string> = { error: 'Error', warning: 'Warning', info: 'Note' };

export function countBySeverity(cards: readonly PanelCard[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const card of cards) for (const x of card.findings) c[x.severity]++;
  return c;
}

export function renderPanel(root: HTMLElement, model: PanelModel, h: PanelHandlers): void {
  root.replaceChildren();
  const style = el('style');
  style.textContent = CSS;
  const wrap = el('div', 'cc-root');
  root.append(style, wrap);

  const head = el('div', 'cc-head');
  head.append(el('div', 'cc-title', model.title));
  wrap.append(head);
  if (model.blocked) {
    wrap.append(el('div', 'cc-empty', model.blocked));
    return;
  }
  const counts = countBySeverity(model.cards);
  head.append(el('span', 'cc-counts', `${counts.error} errors · ${counts.warning} warnings · ${counts.info} notes`));
  const filter = el('select', 'cc-btn');
  filter.setAttribute('aria-label', 'Show');
  for (const [value, label] of [
    ['all', 'All'],
    ['warning', 'Errors + warnings'],
    ['error', 'Errors only'],
  ] as const) {
    const o = el('option', undefined, label);
    o.value = value;
    o.selected = model.filter === value;
    filter.append(o);
  }
  filter.addEventListener('change', () => h.setFilter(filter.value as PanelFilter));
  const recheck = el('button', 'cc-btn', 'Re-check');
  recheck.type = 'button';
  recheck.addEventListener('click', () => h.recheck());
  const verify = el('button', 'cc-btn', model.verifying ? `Verifying ${model.verifying.done}/${model.verifying.total}…` : 'Verify sources');
  verify.type = 'button';
  verify.disabled = model.verifying !== null;
  verify.title = 'Look the cites up online: Crossref, OpenAlex and the cited pages';
  verify.addEventListener('click', () => h.verify());
  head.append(filter, recheck, verify);
  if (model.note) wrap.append(el('div', 'cc-note', model.note));
  if (model.ignoredCount > 0) {
    const note = el('div', 'cc-note', `${model.ignoredCount} ignored. `);
    const restore = el('button', 'cc-btn cc-ignore', 'Restore');
    restore.type = 'button';
    restore.addEventListener('click', () => h.restoreIgnored());
    note.append(restore);
    wrap.append(note);
  }

  const keep = (s: Severity): boolean => model.filter === 'all' || (model.filter === 'warning' ? s !== 'info' : s === 'error');
  let shown = 0;
  let focusEl: HTMLElement | null = null;
  for (const card of model.cards) {
    const findings = card.findings.filter((x) => keep(x.severity));
    const oks = model.filter === 'all' ? card.confirmations : [];
    if (findings.length === 0 && oks.length === 0) continue;
    shown++;
    const box = el('section', 'cc-card');
    const top = el('button', 'cc-card-head');
    top.type = 'button';
    top.append(el('span', 'cc-tag', card.heading || '(untitled card)'));
    if (card.short) top.append(el('span', 'cc-short', card.short));
    const id = card.headingId;
    if (id) top.addEventListener('click', () => h.jump(id, 'heading'));
    else top.disabled = true;
    box.append(top);
    const list = el('ul', 'cc-list');
    for (const x of findings) {
      const li = el('li', 'cc-item');
      const dot = el('span', `cc-dot cc-${x.severity}`);
      dot.title = SEVERITY_LABEL[x.severity];
      dot.setAttribute('aria-label', SEVERITY_LABEL[x.severity]);
      const msg = el('button', 'cc-msg', x.message);
      msg.type = 'button';
      if (id) msg.addEventListener('click', () => h.jump(id, x.part === 'heading' ? 'heading' : 'cite'));
      li.append(dot, msg);
      if (id) {
        const ig = el('button', 'cc-btn cc-ignore', 'Ignore');
        ig.type = 'button';
        ig.title = 'Hide this finding for this card (saved with the file)';
        ig.addEventListener('click', () => h.ignore(id, x.ruleId));
        li.append(ig);
      }
      list.append(li);
    }
    for (const ok of oks) list.append(el('li', 'cc-ok', `✓ ${ok.message}`));
    box.append(list);
    if (id && id === model.focusHeadingId) {
      box.classList.add('cc-focus');
      focusEl = box;
    }
    wrap.append(box);
  }
  if (shown === 0) wrap.append(el('div', 'cc-empty', model.cards.length ? 'No cite problems found.' : 'No cards in this document.'));
  focusEl?.scrollIntoView?.({ block: 'nearest' });
}
