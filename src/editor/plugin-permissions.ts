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
 * The id-shape sanitizer (and PLUGIN_API_VERSION, in plugin-registry.ts)
 * are copied into apps/desktop/src/plugin-manager.ts, since main can't
 * import renderer modules. tests/editor/plugin-permissions.test.ts
 * ("main/renderer parity") fails the moment the copies drift.
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
  'ui.notices': {
    label: 'Post notices in the status bar',
    description:
      'Leave a notice under the status-bar \u24d8 chip, optionally with up to two buttons. Its notices are always labeled with the plugin\u2019s name.',
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
      'See whether a document is in a live co-editing session, and that session\u2019s room and title. Never the session\u2019s key.',
    sensitivity: 'medium',
  },
  'collab.server': {
    label: 'See which co-editing server you use',
    description:
      'See the address of the server your co-editing sessions run on, and whether a session on another server can be reached from here.',
    sensitivity: 'low',
  },
  'collab.probe': {
    label: 'Check if a session is still live',
    description:
      'Ask the session\u2019s server whether the session behind a share code still exists, without joining it or showing you as present.',
    sensitivity: 'low',
  },
  'collab.shareCode': {
    label: 'Read your session share codes',
    description:
      'Read the share code of a live session you are in. Anyone who gets that code can join and edit the session.',
    sensitivity: 'high',
  },
  'collab.viewCode': {
    label: 'Read your sessions\u2019 view-only links',
    description:
      'Read the view-only link of a live session you are in. Anyone who gets that link can watch the session, but not edit it.',
    sensitivity: 'medium',
  },
  'collab.join': {
    label: 'Join co-editing sessions',
    description:
      'Join a live co-editing session from a share code. Joining connects to the session\u2019s server and shows you as present in that session.',
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
  'doc.annotate': {
    label: 'Mark text in your documents',
    description:
      'Underline or tint text in your open documents, like spellcheck does, with a note labeled with the plugin\u2019s name. Marks are only shown to you: they are never saved, shared or added to your document.',
    sensitivity: 'low',
  },
  'net.fetch': {
    label: 'Connect to websites',
    description:
      'Send requests to the websites listed here and read their replies. What it sends can include text from your documents.',
    sensitivity: 'high',
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

/** `networkHosts` (manifest + definition): where `net.fetch` may
 *  connect. Each entry is an exact hostname (`api.crossref.org`: at
 *  least one dot, letters in the last label, so no IP literals and no
 *  `localhost` — loopback is `flowPost`'s job) or `"*"`, any https site.
 *  Copied into apps/desktop/src/plugin-manager.ts (parity-tested). */
export const NETWORK_HOST_RE =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ANY_HOST = '*';
export const MAX_NETWORK_HOSTS = 16;

/** Normalize an untrusted `networkHosts` list: lowercase, trimmed, valid
 *  shape only, deduplicated, capped, sorted (`"*"` first). Never throws;
 *  off-shape entries are dropped (never fatal — a newer plugin may use
 *  a shape this build doesn't know). */
export function sanitizeNetworkHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const h of raw) {
    if (out.size >= MAX_NETWORK_HOSTS) break;
    if (typeof h !== 'string') continue;
    const host = h.trim().toLowerCase();
    if (host === ANY_HOST || NETWORK_HOST_RE.test(host)) out.add(host);
  }
  return [...out].sort((a, b) => (a === ANY_HOST ? -1 : b === ANY_HOST ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/** Whether `hostname` is covered by a (sanitized) host list. */
export function hostAllowed(hosts: readonly string[], hostname: string): boolean {
  const h = hostname.toLowerCase();
  return hosts.includes(ANY_HOST) || hosts.includes(h);
}

/** `a ∩ b` for host lists (`"*"` in one side admits all of the other). */
export function intersectHosts(a: readonly string[], b: readonly string[]): string[] {
  const left = sanitizeNetworkHosts(a);
  const right = sanitizeNetworkHosts(b);
  return sanitizeNetworkHosts(
    left.filter((h) => (h === ANY_HOST ? right.includes(ANY_HOST) : hostAllowed(right, h))).concat(
      left.includes(ANY_HOST) ? right : [],
    ),
  );
}

/** Longest reason a plugin may give for one permission. */
export const PERMISSION_REASON_MAX = 200;

/** Normalize an untrusted `permissionReasons` map (manifest or
 *  definition): one plain-text line per permission the plugin declares,
 *  control characters and runs of whitespace collapsed, capped at
 *  PERMISSION_REASON_MAX. Keys not in `declared`, non-string values and
 *  empty strings are dropped; anything that isn't a plain object yields
 *  {}. A separate map rather than objects inside `permissions` on
 *  purpose: older builds drop non-string `permissions` entries, which
 *  would lose the permission itself. */
export function sanitizePermissionReasons(raw: unknown, declared: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const p of declared) {
    if (!Object.prototype.hasOwnProperty.call(raw, p)) continue;
    const v = (raw as Record<string, unknown>)[p];
    if (typeof v !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const text = v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, PERMISSION_REASON_MAX);
    if (text) out[p] = text;
  }
  return out;
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
