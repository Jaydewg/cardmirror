/**
 * The one context-menu renderer: build, position (clamped to the
 * viewport), and close-on-outside-click / Escape. Menus used to each
 * hand-roll this; callers now just describe their entries.
 *
 * Styling is the shared `.pmd-nav-context-menu` family. Only one menu is
 * open at a time, coordinated with the other menus through
 * `context-menu-registry`.
 */
import { clearOpenContextMenu, registerOpenContextMenu } from './context-menu-registry.js';

export type MenuEntry =
  | {
      kind: 'item';
      label: string;
      /** Right-aligned muted text (a shortcut, or a plugin's name). */
      hint?: string;
      disabled?: boolean;
      checked?: boolean;
      /** Tooltip. */
      title?: string;
      action: () => void;
    }
  | { kind: 'separator' };

let openMenuEl: HTMLElement | null = null;

export function isContextMenuOpen(): boolean {
  return openMenuEl !== null;
}

/** Drop leading, trailing and doubled separators. */
function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'separator' && (out.length === 0 || out[out.length - 1]!.kind === 'separator')) continue;
    out.push(e);
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'separator') out.pop();
  return out;
}

/** Show a menu at viewport point (x, y), replacing any open menu.
 *  Clicking an item closes the menu first, then runs the action. Items
 *  don't take focus (mousedown is swallowed), so the editor selection
 *  an action reads is still intact. */
export function showContextMenu(x: number, y: number, entries: readonly MenuEntry[]): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'pmd-nav-context-menu';
  for (const entry of tidy(entries)) {
    if (entry.kind === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'pmd-nav-context-separator';
      menu.append(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-nav-context-item';
    btn.textContent = entry.label;
    if (entry.title) btn.title = entry.title;
    if (entry.checked) btn.classList.add('pmd-nav-context-item-checked');
    if (entry.hint) {
      const hint = document.createElement('span');
      hint.className = 'pmd-context-item-hint';
      hint.textContent = entry.hint;
      btn.append(hint);
    }
    if (entry.disabled) {
      btn.disabled = true;
      btn.classList.add('pmd-nav-context-item-disabled');
    }
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (entry.disabled) return;
      closeContextMenu();
      entry.action();
    });
    menu.append(btn);
  }

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
  menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;

  openMenuEl = menu;
  registerOpenContextMenu(closeContextMenu);
  // Deferred: the contextmenu's own trailing events must not instantly
  // dismiss the menu.
  setTimeout(() => {
    if (openMenuEl !== menu) return;
    window.addEventListener('mousedown', onOutside, { capture: true });
    window.addEventListener('keydown', onOutside, { capture: true });
  });
}

export function closeContextMenu(): void {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  clearOpenContextMenu(closeContextMenu);
  window.removeEventListener('mousedown', onOutside, { capture: true });
  window.removeEventListener('keydown', onOutside, { capture: true });
}

function onOutside(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeContextMenu();
    return;
  }
  if (openMenuEl && !openMenuEl.contains(e.target as Node)) closeContextMenu();
}
