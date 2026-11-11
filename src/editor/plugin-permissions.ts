/**
 * Plugin permissions — the extension mechanism for the plugin API.
 *
 * The problem: Right now plugins recieve limited user-facing functionality -- some
 * 
 * The API grows by PERMISSION, not by `apiVersion`: a plugin lists the
 * permissions it wants (manifest + registration), the user will instead consent at
 * install (and of course again when an update requests more), main persists the
 * granted set beside the install, and the registry mints each plugin's
 * api object with only the namespaces it was granted. A plugin that
 * declares nothing gets exactly the v1 surface (plus `api.permissions`).
 *
 * Compatibility rules for backwards and forwards compatibility:
 *   - Unknown permission strings are DROPPED, never rejected — a plugin
 *     built for a newer CardMirror still loads here with whatever this
 *     build supports, and the UI flatly lists the rest as unsupported.
 *   - `apiVersion` stays 1; bump it only for a breaking change (in line with semver).
 *
 * Permissions are a consent + supported-API contract, NOT a sandbox:
 * bundles run in the renderer's main world. The consent copy says so.
 *
 * The id-shape sanitizer is duplicated in apps/desktop/src/plugin-manager.ts
 * (main can't import renderer modules) — keep the two in sync.
 */

/** `namespace.action` (one or more dotted segments). */
export const PERMISSION_ID_RE = /^[a-z]+(\.[a-z][a-zA-Z]*)+$/;
/** Hard cap on how many permission strings one plugin may declare. This can 
 * be raised in the future, but this is set so that plugins can't attempt to declare
 * an insane amount of permissions.
*/
export const MAX_PERMISSIONS = 32;

export type PermissionSensitivity = 'low' | 'medium' | 'high';

export interface PluginPermissionInfo {
  /** Short name for the consent list. */
  label: string;
  /** One plain-language sentence on what granting it allows. */
  description: string;
  sensitivity: PermissionSensitivity;
}

/** Every permission THIS build implements. Adding an entry here is how
 *  the plugin API grows; anything not listed is "unsupported" here. */
export const PLUGIN_PERMISSIONS: Readonly<Record<string, PluginPermissionInfo>> = Object.freeze({
  'ui.dialogs': {
    label: 'Show dialogs',
    description:
      'Ask you to choose between options or confirm an action. Its dialogs are always labeled with the plugin’s name.',
    sensitivity: 'low',
  },
  'files.data': {
    label: 'Store its own data in your documents',
    description:
      'Save a small amount of its own data inside the .cmir files you save, and read it back when such a file is opened. Data from other plugins is never visible to it.',
    sensitivity: 'medium',
  },
  'collab.read': {
    label: 'See your live co-editing sessions',
    description:
      'See whether a document is in a live co-editing session, and that session\u2019s room, title and relay. Never the session\u2019s key.',
    sensitivity: 'medium',
  },
  'collab.shareCode': {
    label: 'Read your session share codes',
    description:
      'Read the share code of a live session you are in. Anyone who gets that code can join and edit the session.',
    sensitivity: 'high',
  },
  'collab.join': {
    label: 'Join co-editing sessions',
    description:
      'Join a live co-editing session from a share code. Joining connects to the relay and shows you as present in that session.',
    sensitivity: 'high',
  },
  'doc.read': {
    label: 'Read your open documents',
    description:
      'Read the outline, cards (tags, cites, card text) and word counts of documents you have open.',
    sensitivity: 'medium',
  },
  'doc.edit': {
    label: 'Add content to your documents',
    description:
      'Insert cards, headings and text into your open documents. Each insert is a single step you can undo; nothing is added in read mode.',
    sensitivity: 'high',
  },
  'doc.events': {
    label: 'Notice when you edit or switch documents',
    description:
      'Be told when a document changes, when the selection moves, or when you switch documents (not what changed).',
    sensitivity: 'low',
  },
  'ui.panel': {
    label: 'Show a side panel',
    description:
      'Show its own panel at the right edge of the window. The panel’s tab always shows the plugin’s name, and you can hide it at any time.',
    sensitivity: 'low',
  },
  'ui.contextMenu': {
    label: 'Add right-click menu items',
    description:
      'Add up to 5 items to the right-click menus of the editor and the outline, each labeled with the plugin’s name.',
    sensitivity: 'low',
  },
});

export function isKnownPermission(p: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, p);
}

/** This sanitizer normalizes an untrusted permission list: strings of the right format
 *  only, deduplicated, capped, sorted. Never throws; anything that isn't
 *  an array yields []. */
export function sanitizePermissionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const p of raw) {
    if (out.size >= MAX_PERMISSIONS) break;
    if (typeof p === 'string' && PERMISSION_ID_RE.test(p)) out.add(p);
  }
  return [...out].sort();
}

/** Split a (sanitized) list into what this build supports and what it
 *  doesn't, for back/forwards compatibility. */
export function splitKnown(list: readonly string[]): { known: string[]; unknown: string[] } {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const p of list) (isKnownPermission(p) ? known : unknown).push(p);
  return { known, unknown };
}

/** Why a plugin does or doesn't have a permission:
 *  - `granted`     — active now;
 *  - `denied`      — declared and supported, but the user declined or
 *                    revoked it (fix: Settings → Plugins);
 *  - `unsupported` — declared, but this CardMirror doesn't implement it
 *                    (fix: update CardMirror);
 *  - `undeclared`  — the running definition never asked for it. 
 * Here for feature detection for clients -- while they can do process of elimination,
 * extensions can suggest, or elegantly actively probe if a feature is in namespace. */
export type PermissionStatus = 'granted' | 'denied' | 'unsupported' | 'undeclared';

export function permissionStatus(
  permission: string,
  declared: readonly string[],
  granted: ReadonlySet<string>,
): PermissionStatus {
  if (!declared.includes(permission)) return 'undeclared';
  if (!isKnownPermission(permission)) return 'unsupported';
  return granted.has(permission) ? 'granted' : 'denied';
}

/** The effective grant: supported here ∩ consented by the user ∩
 *  declared by the running definition. A definition can never widen
 *  what the user agreed to, and consent can't conjure a permission the
 *  bundle didn't ask for. */
export function resolveGrant(
  consented: readonly string[],
  declared: readonly string[],
): ReadonlySet<string> {
  const ok = new Set(sanitizePermissionList(consented));
  return new Set(sanitizePermissionList(declared).filter((p) => ok.has(p) && isKnownPermission(p)));
}
