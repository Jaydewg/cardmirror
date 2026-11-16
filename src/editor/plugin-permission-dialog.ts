/**
 * Plugin permission UI: the consent dialog (install / update / dev-load)
 * and the per-plugin permissions modal (Settings → Plugins → shield).
 *
 * Same modal vocabulary and plumbing as `confirmDialog` (overlay stack,
 * modal key capture, focus arm/restore) so it behaves like every other
 * in-DOM dialog. All plugin-supplied text goes through `textContent`.
 */
import { isBackdropClick } from './backdrop-click.js';
import { popOverlay, pushOverlay } from './overlay-stack.js';
import { PLUGIN_PERMISSIONS, type PluginPermissionInfo } from './plugin-permissions.js';
import { armDialogFocus, captureFocusForDialog, installModalKeys } from './text-prompt.js';

/** The honesty line every consent surface carries: permissions gate the
 *  supported API, not what the bundle's code can reach. */
export const FULL_ACCESS_NOTE =
  'This plugin runs with full access to CardMirror and your documents. ' +
  'Permissions control which CardMirror features it is allowed to use.';

function infoFor(permission: string): PluginPermissionInfo {
  return (
    PLUGIN_PERMISSIONS[permission] ?? { label: permission, description: '', sensitivity: 'low' }
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One permission's label + description (+ a "sensitive" badge). When
 *  `control` is given (management modal) it leads the row. */
function permissionRow(permission: string, control?: HTMLInputElement): HTMLElement {
  const info = infoFor(permission);
  const row = el(control ? 'label' : 'li', 'pmd-plugin-perm-row');
  if (control) row.append(control);
  const text = el('span', 'pmd-plugin-perm-text');
  const title = el('span', 'pmd-plugin-perm-label', info.label);
  if (info.sensitivity === 'high') {
    title.append(' ', el('span', 'pmd-plugin-perm-badge', 'Sensitive'));
  }
  text.append(title);
  if (info.description) text.append(el('span', 'pmd-plugin-perm-desc', info.description));
  row.append(text);
  row.dataset.permission = permission;
  return row;
}

function unsupportedBlock(unknown: readonly string[]): HTMLElement | null {
  if (unknown.length === 0) return null;
  const wrap = el('div', 'pmd-plugin-perm-unsupported');
  wrap.append(
    el('div', 'pmd-plugin-perm-subhead', 'Not supported by this version of CardMirror (won’t be granted):'),
  );
  const ul = el('ul', 'pmd-plugin-perm-list');
  for (const p of unknown) ul.append(el('li', 'pmd-plugin-perm-unknown', p));
  wrap.append(ul);
  return wrap;
}

/** Shared modal shell. `build` fills the body; resolves with whatever
 *  `finish` is called with (Esc / backdrop / Cancel → `cancelValue`). */
function openModal<T>(opts: {
  title: string;
  okLabel: string;
  cancelLabel: string;
  cancelValue: T;
  okValue: () => T;
  build: (body: HTMLElement) => void;
}): Promise<T> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = el('div', 'pmd-route-overlay');
    const dialog = el('div', 'pmd-route-dialog pmd-text-prompt-dialog pmd-plugin-perm-dialog');
    dialog.append(el('div', 'pmd-route-header', opts.title));
    const body = el('div', 'pmd-plugin-perm-body');
    opts.build(body);
    dialog.append(body);

    let settled = false;
    let removeKeys = (): void => {};
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve(value);
    };
    const buttons = el('div', 'pmd-text-prompt-buttons');
    const cancelBtn = el('button', 'pmd-route-cancel', opts.cancelLabel);
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => finish(opts.cancelValue));
    const okBtn = el('button', 'pmd-text-prompt-ok', opts.okLabel);
    okBtn.type = 'button';
    okBtn.addEventListener('click', () => finish(opts.okValue()));
    buttons.append(cancelBtn, okBtn);
    dialog.append(buttons);

    overlay.append(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) finish(opts.cancelValue);
    });
    // Esc declines. Enter is deliberately NOT bound to OK: granting
    // access should take a deliberate click, not a stray keypress.
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        finish(opts.cancelValue);
        return true;
      }
      return false;
    });
    document.body.append(overlay);
    armDialogFocus(dialog, 'alertdialog', opts.title);
  });
}

export interface PermissionConsentOptions {
  /** install: fresh install · update: an update ADDS permissions (list
   *  only the added ones) · dev: a bundle loaded from file. */
  mode: 'install' | 'update' | 'dev';
  name: string;
  version?: string;
  author?: string;
  /** The real source repo (main-derived, not manifest-controlled). */
  ownerRepo?: string;
  /** Permissions to ask for that this build supports. */
  known: readonly string[];
  /** Requested but unsupported here — listed, never granted. */
  unknown: readonly string[];
}

/** Ask the user to consent. Resolves true on Allow/Install/Update. */
export function permissionConsentDialog(opts: PermissionConsentOptions): Promise<boolean> {
  const v = opts.version ? ` v${opts.version}` : '';
  const title =
    opts.mode === 'install'
      ? `Install ${opts.name}${v}?`
      : opts.mode === 'update'
        ? `Update ${opts.name} to${v}?`
        : `Allow ${opts.name} (loaded from file) to use CardMirror features?`;
  const okLabel =
    opts.mode === 'install' ? 'Install' : opts.mode === 'update' ? 'Update' : 'Allow for this session';
  const cancelLabel = opts.mode === 'dev' ? 'Don’t allow' : 'Cancel';
  return openModal<boolean>({
    title,
    okLabel,
    cancelLabel,
    cancelValue: false,
    okValue: () => true,
    build: (body) => {
      if (opts.mode !== 'dev') {
        body.append(
          el(
            'p',
            'pmd-text-prompt-detail',
            `By ${opts.author ?? 'an unknown author'}` +
              (opts.ownerRepo ? ` · github.com/${opts.ownerRepo}` : ''),
          ),
        );
      }
      if (opts.known.length > 0) {
        body.append(
          el(
            'div',
            'pmd-plugin-perm-subhead',
            opts.mode === 'update' ? 'This version asks for new permissions:' : 'It asks to:',
          ),
        );
        const ul = el('ul', 'pmd-plugin-perm-list');
        for (const p of opts.known) ul.append(permissionRow(p));
        body.append(ul);
      }
      const unsupported = unsupportedBlock(opts.unknown);
      if (unsupported) body.append(unsupported);
      body.append(el('p', 'pmd-text-prompt-detail pmd-plugin-perm-note', FULL_ACCESS_NOTE));
    },
  });
}

/** Settings → Plugins → shield: review and change one plugin's grant.
 *  Resolves with the new consented list, or null on Cancel. */
export function managePluginPermissionsDialog(opts: {
  name: string;
  known: readonly string[];
  unknown: readonly string[];
  granted: readonly string[];
}): Promise<string[] | null> {
  const boxes = new Map<string, HTMLInputElement>();
  return openModal<string[] | null>({
    title: `${opts.name}: permissions`,
    okLabel: 'Save',
    cancelLabel: 'Cancel',
    cancelValue: null,
    okValue: () => [...boxes].filter(([, box]) => box.checked).map(([p]) => p),
    build: (body) => {
      if (opts.known.length === 0) {
        body.append(
          el('p', 'pmd-text-prompt-detail', 'This plugin asks for no permissions this version supports.'),
        );
      } else {
        const list = el('div', 'pmd-plugin-perm-list');
        for (const p of opts.known) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'pmd-settings-toggle';
          box.checked = opts.granted.includes(p);
          box.setAttribute('aria-label', infoFor(p).label);
          boxes.set(p, box);
          list.append(permissionRow(p, box));
        }
        body.append(list);
        body.append(
          el(
            'p',
            'pmd-text-prompt-detail',
            'Changes apply the next time the plugin runs a command. A plugin can see that a permission is off, and may ask you to turn it back on here.',
          ),
        );
      }
      const unsupported = unsupportedBlock(opts.unknown);
      if (unsupported) body.append(unsupported);
      body.append(el('p', 'pmd-text-prompt-detail pmd-plugin-perm-note', FULL_ACCESS_NOTE));
    },
  });
}
