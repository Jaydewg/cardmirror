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
import { BRAND } from '../brand-build.js';

/** The honesty line every consent surface carries: permissions gate the
 *  supported API, not what the bundle's code can reach. */
export const FULL_ACCESS_NOTE =
  `This plugin runs with full access to ${BRAND.productName} and your documents. ` +
  `Permissions control which ${BRAND.productName} features it is allowed to use.`;

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

/** The plugin's own reason, quoted and attributed so it can't pass for
 *  CardMirror's description. */
function reasonLine(pluginName: string, reason: string): HTMLElement {
  return el('span', 'pmd-plugin-perm-reason', `${pluginName} says: “${reason}”`);
}

/** One permission's label + description (+ a "sensitive" badge, + the
 *  plugin's reason). When `control` is given (a checkbox) it leads the
 *  row. */
function permissionRow(
  permission: string,
  control?: HTMLInputElement,
  reason?: { pluginName: string; text: string | undefined },
): HTMLElement {
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
  if (reason?.text) text.append(reasonLine(reason.pluginName, reason.text));
  row.append(text);
  row.dataset.permission = permission;
  return row;
}

function unsupportedBlock(unknown: readonly string[]): HTMLElement | null {
  if (unknown.length === 0) return null;
  const wrap = el('div', 'pmd-plugin-perm-unsupported');
  wrap.append(
    el('div', 'pmd-plugin-perm-subhead', `Not supported by this version of ${BRAND.productName} (won’t be granted):`),
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
  /** A third button, left of Cancel. */
  extra?: { label: string; value: T };
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
    if (opts.extra) {
      const extra = opts.extra;
      const extraBtn = el('button', 'pmd-route-cancel pmd-plugin-perm-extra', extra.label);
      extraBtn.type = 'button';
      extraBtn.addEventListener('click', () => finish(extra.value));
      buttons.append(extraBtn);
    }
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
  /** The plugin's reasons (`permissionReasons`), shown as its words. */
  reasons?: Readonly<Record<string, string>>;
  /** Listed but starting UNticked — on update, permissions the user
   *  turned off before (asked again only with their "ask again" on). */
  unchecked?: readonly string[];
}

/** A ticked checkbox per permission, for the consent and manage
 *  dialogs; `boxes` collects them so OK can read the selection. */
function permissionChecklist(
  permissions: readonly string[],
  checked: (p: string) => boolean,
  boxes: Map<string, HTMLInputElement>,
  why?: { pluginName: string; reasons?: Readonly<Record<string, string>> },
): HTMLElement {
  const list = el('div', 'pmd-plugin-perm-list');
  for (const p of permissions) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pmd-settings-toggle';
    box.checked = checked(p);
    box.setAttribute('aria-label', infoFor(p).label);
    boxes.set(p, box);
    const reason = why ? { pluginName: why.pluginName, text: why.reasons?.[p] } : undefined;
    list.append(permissionRow(p, box, reason));
  }
  return list;
}

const checkedIn = (boxes: Map<string, HTMLInputElement>): string[] =>
  [...boxes].filter(([, box]) => box.checked).map(([p]) => p);

/** Ask the user to consent. Every supported permission starts ticked;
 *  the user can untick any of them before agreeing, so a plugin never
 *  runs, even briefly, with a permission the user meant to refuse.
 *  Resolves with the ticked permissions on Install / Update / Allow
 *  (possibly empty), or null on Cancel. */
export function permissionConsentDialog(opts: PermissionConsentOptions): Promise<string[] | null> {
  const v = opts.version ? ` v${opts.version}` : '';
  const title =
    opts.mode === 'install'
      ? `Install ${opts.name}${v}?`
      : opts.mode === 'update'
        ? `Update ${opts.name} to${v}?`
        : `Allow ${opts.name} (loaded from file) to use ${BRAND.productName} features?`;
  const okLabel =
    opts.mode === 'install' ? 'Install' : opts.mode === 'update' ? 'Update' : 'Allow for this session';
  const cancelLabel = opts.mode === 'dev' ? 'Don’t allow' : 'Cancel';
  const boxes = new Map<string, HTMLInputElement>();
  return openModal<string[] | null>({
    title,
    okLabel,
    cancelLabel,
    cancelValue: null,
    okValue: () => checkedIn(boxes),
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
        const off = new Set(opts.unchecked ?? []);
        body.append(
          permissionChecklist(opts.known, (p) => !off.has(p), boxes, { pluginName: opts.name, reasons: opts.reasons }),
        );
        body.append(
          el(
            'p',
            'pmd-text-prompt-detail',
            opts.mode === 'dev'
              ? `Untick anything you don’t want to allow. Your answer lasts until ${BRAND.productName} restarts.`
              : opts.mode === 'update'
                ? 'Untick anything you don’t want to allow. Anything unticked stays off. ' +
                  'Review everything it can use with the shield button in Settings → Plugins.'
                : 'Untick anything you don’t want to allow; it can ask for it later, when a feature needs it. ' +
                  'You can change this in Settings → Plugins.',
          ),
        );
      }
      const unsupported = unsupportedBlock(opts.unknown);
      if (unsupported) body.append(unsupported);
      body.append(el('p', 'pmd-text-prompt-detail pmd-plugin-perm-note', FULL_ACCESS_NOTE));
    },
  });
}

/** What the shield dialog saves. */
export interface ManagedPermissions {
  /** The new consented list. */
  granted: string[];
  /** May the plugin ask again for permissions turned off? */
  askAgain: boolean;
  /** Permissions it may never ask for ("Don't ask again"), minus any the
   *  user granted or unblocked here. */
  blocked: string[];
}

/** Settings → Plugins → shield: review and change one plugin's grant,
 *  whether it may ask again, and what it may never ask for. Resolves
 *  with the new state, or null on Cancel. */
export function managePluginPermissionsDialog(opts: {
  name: string;
  known: readonly string[];
  unknown: readonly string[];
  granted: readonly string[];
  askAgain?: boolean;
  blocked?: readonly string[];
  reasons?: Readonly<Record<string, string>>;
}): Promise<ManagedPermissions | null> {
  const boxes = new Map<string, HTMLInputElement>();
  const blocked = new Set((opts.blocked ?? []).filter((p) => opts.known.includes(p)));
  const askBox = document.createElement('input');
  askBox.type = 'checkbox';
  askBox.className = 'pmd-settings-toggle';
  askBox.checked = opts.askAgain !== false;
  return openModal<ManagedPermissions | null>({
    title: `${opts.name}: permissions`,
    okLabel: 'Save',
    cancelLabel: 'Cancel',
    cancelValue: null,
    okValue: () => {
      const granted = checkedIn(boxes);
      return {
        granted,
        askAgain: askBox.checked,
        blocked: [...blocked].filter((p) => !granted.includes(p)).sort(),
      };
    },
    build: (body) => {
      if (opts.known.length === 0) {
        body.append(
          el('p', 'pmd-text-prompt-detail', 'This plugin asks for no permissions this version supports.'),
        );
      } else {
        const list = permissionChecklist(opts.known, (p) => opts.granted.includes(p), boxes, {
          pluginName: opts.name,
          reasons: opts.reasons,
        });
        // "Don't ask again" answers: marked, with a way to undo them.
        for (const p of blocked) {
          const row = [...list.querySelectorAll<HTMLElement>('[data-permission]')].find(
            (r) => r.dataset.permission === p,
          );
          if (!row) continue;
          const mark = el('span', 'pmd-plugin-perm-blocked', 'You asked it not to ask for this. ');
          const undo = el('button', 'pmd-plugin-perm-unblock', 'Let it ask');
          undo.type = 'button';
          undo.addEventListener('click', (e) => {
            e.preventDefault(); // the row is a <label>: don't toggle the box
            blocked.delete(p);
            mark.remove();
          });
          mark.append(undo);
          row.querySelector('.pmd-plugin-perm-text')?.append(mark);
        }
        body.append(list);
        const ask = el('label', 'pmd-plugin-perm-row pmd-plugin-perm-askagain');
        ask.append(
          askBox,
          el(
            'span',
            'pmd-plugin-perm-text',
            'Let it ask again for permissions I turned off (when a feature needs one, and when it updates)',
          ),
        );
        body.append(ask);
        body.append(
          el(
            'p',
            'pmd-text-prompt-detail',
            'Changes apply the next time the plugin runs a command. A plugin can see that a permission is off, and may ask you to turn it back on.',
          ),
        );
      }
      const unsupported = unsupportedBlock(opts.unknown);
      if (unsupported) body.append(unsupported);
      body.append(el('p', 'pmd-text-prompt-detail pmd-plugin-perm-note', FULL_ACCESS_NOTE));
    },
  });
}

/** `api.permissions.request`: one permission, asked when a feature needs
 *  it. Esc / backdrop is "Not now"; Enter does nothing (granting takes
 *  a deliberate click). */
export function permissionRequestDialog(opts: {
  name: string;
  permission: string;
  reason: string | null;
}): Promise<'allow' | 'not-now' | 'never'> {
  const info = infoFor(opts.permission);
  return openModal<'allow' | 'not-now' | 'never'>({
    title: `${opts.name} wants to: ${info.label}`,
    okLabel: 'Allow',
    cancelLabel: 'Not now',
    cancelValue: 'not-now',
    okValue: () => 'allow',
    extra: { label: 'Don’t ask again', value: 'never' },
    build: (body) => {
      const ul = el('ul', 'pmd-plugin-perm-list');
      ul.append(permissionRow(opts.permission, undefined, { pluginName: opts.name, text: opts.reason ?? undefined }));
      body.append(ul);
      body.append(
        el(
          'p',
          'pmd-text-prompt-detail',
          'You can change this at any time with the shield button in Settings → Plugins.',
        ),
      );
      body.append(el('p', 'pmd-text-prompt-detail pmd-plugin-perm-note', FULL_ACCESS_NOTE));
    },
  });
}
