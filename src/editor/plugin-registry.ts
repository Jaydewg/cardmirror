/**
 * Plugin registry — the only place plugin bundles register. A bundle
 * (loaded by the desktop host) calls `window.__registerCardMirrorPlugin`
 * with a versioned definition; the registry validates it, mints the
 * plugin's capability api object, and indexes its commands so the
 * ribbon/palette/keymap chokepoints can find them. Card-cutter-port
 * precedent: if nothing registers, everything stays inert.
 */
import { showToast } from './toast.js';
import type { CardMirrorPluginApi, PluginGrantContext, PluginPermissionRequestResult } from './plugin-api.js';
import {
  intersectHosts,
  isKnownPermission,
  permissionStatus,
  sanitizeNetworkHosts,
  resolveGrant,
  sanitizePermissionList,
  sanitizePermissionReasons,
  splitKnown,
} from './plugin-permissions.js';
import {
  blockPluginPermission,
  getPluginPermissionPrefs,
  notePluginActivation,
  promptGate,
  quietEventPrompts,
  withPromptSlot,
} from './plugin-permission-requests.js';

export const PLUGIN_API_VERSION = 1;

export interface PluginCommandDef {
  /** Must start with `<pluginId>.` */
  id: string;
  label: string;
  keywords?: readonly string[];
  defaultKey?: string | string[] | null;
  run: (api: CardMirrorPluginApi) => void | Promise<void>;
}

export type PluginSettingValue = boolean | string | number;

/** A user-configurable setting a plugin declares at registration. The
 *  host renders the controls (gear on the plugin's Settings row); the
 *  plugin reads values through `api.settings`. Values persist in the
 *  plugin's storage bag, so uninstall cleanup covers them for free. */
export interface PluginSettingDef {
  key: string;
  label: string;
  /** `text` renders a single-line input; `multiline` a textarea (for
   *  list-shaped values — one entry per line by convention). Both hold
   *  a plain string value. */
  type: 'boolean' | 'text' | 'multiline' | 'number' | 'select';
  /** Must match `type`; for `select`, must be one of `options`. */
  default: PluginSettingValue;
  /** Required for `select` (the choices), forbidden otherwise. */
  options?: readonly string[];
  /** Muted helper line rendered under the control. */
  description?: string;
}

export interface PluginDefinition {
  id: string;
  name: string;
  apiVersion: number;
  commands: PluginCommandDef[];
  settings?: PluginSettingDef[];
  /** Permissions this bundle wants (see plugin-permissions.ts). Must
   *  also be listed in the manifest — the user consents to the
   *  manifest's list, and the grant is the intersection. Unknown
   *  strings are ignored, never rejected. */
  permissions?: string[];
  /** Why it wants each permission, in its own words: `{ "collab.join":
   *  "…" }`, one line (≤ 200 chars) each, for permissions it declares.
   *  Shown, marked as the plugin's text, when CardMirror asks the user.
   *  The manifest's `permissionReasons` is what install and update
   *  show; this one is used for `api.permissions.request` prompts and a
   *  bundle loaded from file. Older CardMirror builds ignore it. */
  permissionReasons?: Record<string, string>;
  /** Where `net.fetch` may connect: exact hostnames
   *  (`"api.crossref.org"`), or `"*"` for any https site. Must also be
   *  listed in the manifest's `networkHosts` — like permissions, only
   *  hosts in both count — and the user sees the list when asked for
   *  `net.fetch`. At most 16; off-shape entries are dropped. Older
   *  CardMirror builds ignore it. */
  networkHosts?: string[];
  /** Lifecycle hook: called with the plugin's api right after it
   *  registers, and AGAIN every time that api is re-minted (the user
   *  grants or revokes a permission, or the bundle re-registers). Register
   *  long-lived hooks here (`api.files?.onOpen(...)`, `api.events?...`),
   *  feature-detecting each namespace. Return a cleanup function; it runs
   *  before the next activation and when the plugin is unregistered.
   *  Older CardMirror builds ignore this field. */
  activate?: (api: CardMirrorPluginApi) => void | (() => void);
}

declare global {
  interface Window {
    __registerCardMirrorPlugin?: (def: PluginDefinition) => void;
  }
}

interface RegisteredPlugin {
  def: PluginDefinition;
  api: CardMirrorPluginApi;
  settings: PluginSettingDef[];
  /** Sanitized declared permissions (known + unknown). */
  declared: string[];
  /** Sanitized `permissionReasons` from the definition. */
  reasons: Record<string, string>;
  /** Sanitized `networkHosts` from the definition. */
  hosts: string[];
  granted: ReadonlySet<string>;
  /** The definition's `activate`, read once at registration. */
  activate: PluginDefinition['activate'] | undefined;
  /** What the last `activate` returned, run before the next one. */
  cleanup: (() => void) | null;
}

export type CreatePluginApi = (pluginId: string, grant: PluginGrantContext) => CardMirrorPluginApi;

const plugins = new Map<string, RegisteredPlugin>();
const commands = new Map<string, { pluginId: string; cmd: PluginCommandDef }>();
let makeApi: CreatePluginApi | null = null;
/** User-consented permissions per plugin id — persisted by main in the
 *  installed manifest (`grantedPermissions`) and pushed here by the host
 *  before each load; session-only for dev-loaded bundles. */
const consent = new Map<string, string[]>();
/** Installed plugins' MANIFEST permission lists (host-provided), to warn
 *  when a bundle's definition disagrees: the grant is their
 *  intersection, so a mismatch silently withholds permissions. */
const manifestPermissions = new Map<string, string[]>();
/** Installed plugins' MANIFEST `permissionReasons` (host-provided). */
const manifestReasons = new Map<string, Record<string, string>>();
/** Installed plugins' MANIFEST `networkHosts` (host-provided). */
const manifestHosts = new Map<string, string[]>();
/** The hosts the user saw when they granted `net.fetch` (installed:
 *  main's `grantedNetworkHosts`; session-only for dev loads). */
const consentHosts = new Map<string, string[]>();
/** The user's answer to a just-in-time permission prompt. */
export type PermissionPromptAnswer = 'allow' | 'not-now' | 'never';
export interface PermissionPromptRequest {
  pluginId: string;
  name: string;
  permission: string;
  /** The plugin's reason, sanitized; null when it gave none. */
  reason: string | null;
  /** For `net.fetch`: the hosts it would reach (`"*"` = any website). */
  networkHosts?: string[];
}
let permissionPromptHook: ((req: PermissionPromptRequest) => Promise<PermissionPromptAnswer>) | null = null;
/** Persist a new consent list (installed plugins: main's manifest).
 *  Resolves the stored list, or null when it couldn't be stored. Absent:
 *  session-only, like a bundle loaded from file. */
let persistConsentHook:
  | ((pluginId: string, consented: string[], networkHosts: string[]) => Promise<string[] | null>)
  | null = null;
let permissionRequestHook:
  | ((pluginId: string, name: string, known: string[], unknown: string[]) => void)
  | null = null;

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SETTING_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SETTING_TYPES = new Set(['boolean', 'text', 'multiline', 'number', 'select']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Validate + snapshot a definition's `settings` array. Same discipline
 *  as commands: every field is read exactly once, and any off-shape
 *  entry rejects the whole registration — the settings modal renders
 *  these blind, so it must be able to trust the shape. */
function validateSettings(
  def: PluginDefinition,
): { ok: true; settings: PluginSettingDef[] } | { ok: false; error: string } {
  const raw = def.settings;
  if (raw === undefined) return { ok: true, settings: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'settings must be an array' };
  const snapshots: PluginSettingDef[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (!s || typeof s !== 'object') return { ok: false, error: 'settings entries must be objects' };
    const { key, label, type, options, description } = s;
    const dflt = s.default;
    if (typeof key !== 'string' || !SETTING_KEY_RE.test(key)) {
      return { ok: false, error: `setting key "${String(key)}" is invalid` };
    }
    if (seen.has(key)) return { ok: false, error: `duplicate setting key "${key}"` };
    if (typeof label !== 'string' || !label) {
      return { ok: false, error: `setting "${key}" has no label` };
    }
    if (typeof type !== 'string' || !SETTING_TYPES.has(type)) {
      return { ok: false, error: `setting "${key}" has invalid type "${String(type)}"` };
    }
    if (description !== undefined && typeof description !== 'string') {
      return { ok: false, error: `setting "${key}" has an invalid description` };
    }
    if (type === 'select') {
      if (!isStringArray(options) || options.length === 0 || options.some((o) => !o)) {
        return { ok: false, error: `select setting "${key}" needs a non-empty options list` };
      }
      if (typeof dflt !== 'string' || !options.includes(dflt)) {
        return { ok: false, error: `select setting "${key}" default must be one of its options` };
      }
    } else {
      if (options !== undefined) {
        return { ok: false, error: `setting "${key}" has options but is not a select` };
      }
      const wanted = type === 'text' || type === 'multiline' ? 'string' : type;
      if (typeof dflt !== wanted || (type === 'number' && !Number.isFinite(dflt))) {
        return { ok: false, error: `setting "${key}" default must be a ${wanted}` };
      }
    }
    seen.add(key);
    snapshots.push({ key, label, type, default: dflt, options, description });
  }
  return { ok: true, settings: snapshots };
}

export function registerPluginDefinition(
  def: PluginDefinition,
): { ok: true } | { ok: false; error: string } {
  if (!makeApi) return { ok: false, error: 'plugin system not initialized' };
  if (!def || typeof def !== 'object') return { ok: false, error: 'bad definition' };
  if (typeof def.id !== 'string' || !def.id) return { ok: false, error: 'missing plugin id' };
  if (!PLUGIN_ID_RE.test(def.id)) return { ok: false, error: `invalid plugin id "${def.id}"` };
  if (typeof def.name !== 'string' || !def.name) return { ok: false, error: 'missing plugin name' };
  if (def.apiVersion !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `unsupported apiVersion ${String(def.apiVersion)} (this CardMirror supports ${PLUGIN_API_VERSION})`,
    };
  }
  // Ids this plugin already owns — so a re-registration (e.g. re-enable
  // re-runs the bundle) doesn't trip the global command-collision check
  // against its own previously-registered commands.
  const ownIds = new Set(
    [...commands.entries()].filter(([, e]) => e.pluginId === def.id).map(([id]) => id),
  );
  const raw = def.commands;
  const cmds = Array.isArray(raw) ? [...raw] : null;
  if (!cmds) return { ok: false, error: 'commands must be an array' };
  const seen = new Set<string>();
  const snapshots: PluginCommandDef[] = [];
  const prefix = `${def.id}.`;
  for (const c of cmds) {
    // Read every field exactly once — a stateful getter must not be able
    // to pass validation with one value and register a different one.
    const { id, label, keywords, defaultKey, run } = c;
    if (typeof id !== 'string' || !id.startsWith(prefix) || id.length === prefix.length) {
      return { ok: false, error: `command id "${String(id)}" must start with "${prefix}"` };
    }
    if (typeof label !== 'string' || !label) {
      return { ok: false, error: `command "${id}" has no label` };
    }
    if (typeof run !== 'function') {
      return { ok: false, error: `command "${id}" has no run function` };
    }
    if (keywords !== undefined && !isStringArray(keywords)) {
      return { ok: false, error: `command "${id}" has invalid keywords` };
    }
    if (
      defaultKey !== undefined &&
      defaultKey !== null &&
      typeof defaultKey !== 'string' &&
      !isStringArray(defaultKey)
    ) {
      return { ok: false, error: `command "${id}" has invalid defaultKey` };
    }
    if ((commands.has(id) && !ownIds.has(id)) || seen.has(id)) {
      return { ok: false, error: `command id "${id}" already registered` };
    }
    seen.add(id);
    snapshots.push({ id, label, keywords, defaultKey, run });
  }
  const settingsRes = validateSettings(def);
  if (!settingsRes.ok) return settingsRes;
  // Read once (same getter discipline as commands). Off-shape entries
  // are dropped, never fatal: permissions are additive, and a bundle
  // built for a newer CardMirror must still load here.
  const declared = sanitizePermissionList(def.permissions);
  const reasons = sanitizePermissionReasons(def.permissionReasons, declared);
  const hosts = sanitizeNetworkHosts(def.networkHosts);
  const activate = def.activate;
  if (activate !== undefined && typeof activate !== 'function') {
    return { ok: false, error: 'activate must be a function' };
  }
  if (plugins.has(def.id)) {
    // Already registered: an identical command-id list is a silent no-op
    // success (the re-enable path); any difference still rejects. The
    // settings snapshots ARE refreshed — the dev load-from-file loop
    // re-runs a bundle whose declared settings may have changed even
    // when its command ids haven't. Declared permissions refresh the
    // same way (re-minting the api against the stored consent).
    const same = seen.size === ownIds.size && [...seen].every((id) => ownIds.has(id));
    if (same) {
      const p = plugins.get(def.id)!;
      p.settings = settingsRes.settings;
      p.declared = declared;
      p.reasons = reasons;
      p.hosts = hosts;
      // A re-run bundle brings fresh closures: activate the new ones.
      p.activate = activate;
      mintApi(p);
      warnManifestDrift(p);
      maybeRequestPermissions(p);
      return { ok: true };
    }
    return { ok: false, error: `plugin "${def.id}" already registered` };
  }
  const entry: RegisteredPlugin = {
    def,
    api: null as unknown as CardMirrorPluginApi, // minted just below
    settings: settingsRes.settings,
    declared,
    reasons,
    hosts,
    granted: new Set(),
    activate,
    cleanup: null,
  };
  mintApi(entry);
  plugins.set(def.id, entry);
  for (const c of snapshots) commands.set(c.id, { pluginId: def.id, cmd: c });
  // Activate once it is fully registered, so hooks it installs see a
  // registered plugin holding its grant.
  activatePlugin(entry);
  warnManifestDrift(entry);
  maybeRequestPermissions(entry);
  return { ok: true };
}

/** (Re)mint a plugin's api object from its declared list and the stored
 *  consent. Commands receive `plugin.api` per run, so a re-mint takes
 *  effect on the next run. */
function mintApi(p: RegisteredPlugin): void {
  if (!makeApi) return;
  p.granted = resolveGrant(consent.get(p.def.id) ?? [], p.declared);
  p.api = makeApi(p.def.id, { granted: p.granted, declared: p.declared, name: p.def.name });
  fireGrantsChanged(p.def.id);
  // Re-mint of a registered plugin: hand the new api to `activate`. (A
  // brand-new entry is activated by the caller, after it is registered.)
  if (plugins.get(p.def.id) === p) activatePlugin(p);
}

/** Run the previous activation's cleanup, if any. */
function deactivatePlugin(p: RegisteredPlugin): void {
  const cleanup = p.cleanup;
  p.cleanup = null;
  if (!cleanup) return;
  try {
    cleanup();
  } catch (err) {
    console.error(`[plugins] ${p.def.id} cleanup failed:`, err);
  }
}

/** (Re)run the plugin's `activate` against its current api. A throw (or
 *  a rejected promise) is logged; the plugin stays registered. */
function activatePlugin(p: RegisteredPlugin): void {
  deactivatePlugin(p);
  const activate = p.activate;
  if (!activate) return;
  const report = (err: unknown): void => console.error(`[plugins] ${p.def.id} activate failed:`, err);
  try {
    const result: unknown = activate(p.api);
    if (typeof result === 'function') {
      p.cleanup = result as () => void;
    } else if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(undefined, report);
    }
  } catch (err) {
    report(err);
  }
}

/** UI hosts that own plugin-rendered surfaces (the plugin panel) tear
 *  them down when a plugin loses a permission or unregisters. Hook-style
 *  capabilities don't need this — they check the grant when they fire. */
const grantListeners = new Set<(pluginId: string) => void>();

/** Subscribe to "this plugin's effective grant may have changed"
 *  (re-mint, revoke, unregister). Returns an unsubscribe. */
export function onPluginGrantsChanged(fn: (pluginId: string) => void): () => void {
  grantListeners.add(fn);
  return () => grantListeners.delete(fn);
}

function fireGrantsChanged(pluginId: string): void {
  for (const fn of [...grantListeners]) {
    try {
      fn(pluginId);
    } catch (err) {
      console.error('[plugins] grant listener failed:', err);
    }
  }
}

/** A bundle with NO consent record (dev load-from-file, never installed
 *  through the consent flow) that declares supported permissions: let
 *  the host ask. Installed plugins always have a record (possibly []),
 *  so they're never prompted here — their consent happened at install. */
function maybeRequestPermissions(p: RegisteredPlugin): void {
  if (!permissionRequestHook || consent.has(p.def.id)) return;
  const { known, unknown } = splitKnown(p.declared);
  if (known.length === 0) return;
  try {
    permissionRequestHook(p.def.id, p.def.name, known, unknown);
  } catch (err) {
    console.error('[plugins] onPermissionRequest hook failed:', err);
  }
}

/** Record the user's consented permissions for a plugin id (and, for
 *  `net.fetch`, the hosts they consented to). The host calls this from
 *  the installed manifest BEFORE loading the bundle, so registration
 *  mints with the right grant. Omitting `networkHosts` keeps the hosts
 *  already on record. */
export function setPluginConsent(
  pluginId: string,
  consented: readonly string[],
  networkHosts?: readonly string[],
): void {
  consent.set(pluginId, sanitizePermissionList(consented));
  if (networkHosts !== undefined) consentHosts.set(pluginId, sanitizeNetworkHosts(networkHosts));
}

/** The hosts a plugin asks for: its definition's ∩ its manifest's (an
 *  installed plugin), else whichever of the two is known. */
export function pluginDeclaredNetworkHosts(pluginId: string): string[] {
  const def = plugins.get(pluginId)?.hosts;
  const manifest = manifestHosts.get(pluginId);
  if (def && manifest) return intersectHosts(def, manifest);
  return [...(def ?? manifest ?? [])];
}

/** Where `net.fetch` may connect right now: none unless `net.fetch` is
 *  granted; then the declared hosts the user consented to. */
export function pluginNetworkHosts(pluginId: string): string[] {
  if (!pluginHasPermission(pluginId, 'net.fetch')) return [];
  return intersectHosts(pluginDeclaredNetworkHosts(pluginId), consentHosts.get(pluginId) ?? []);
}

/** The hosts to record with a new consent list: none without
 *  `net.fetch`; the ones already consented to when it stays granted;
 *  else (newly granted) the declared hosts, which is what every consent
 *  surface shows beside it. */
export function nextConsentHosts(pluginId: string, consented: readonly string[]): string[] {
  if (!consented.includes('net.fetch')) return [];
  const had = consent.get(pluginId)?.includes('net.fetch') ?? false;
  const prior = consentHosts.get(pluginId);
  return had && prior ? [...prior] : pluginDeclaredNetworkHosts(pluginId);
}

/** Record an installed plugin's manifest permission list and reasons
 *  (the host calls this with `setPluginConsent`, before loading the
 *  bundle). */
export function setPluginManifestPermissions(
  pluginId: string,
  permissions: readonly string[],
  reasons?: unknown,
  networkHosts?: unknown,
): void {
  const list = sanitizePermissionList(permissions);
  manifestPermissions.set(pluginId, list);
  manifestReasons.set(pluginId, sanitizePermissionReasons(reasons, list));
  manifestHosts.set(pluginId, sanitizeNetworkHosts(networkHosts));
}

/** A plugin's reason for `permission`: the definition's, else the
 *  manifest's; null when it gave none. */
export function pluginPermissionReason(pluginId: string, permission: string): string | null {
  return plugins.get(pluginId)?.reasons[permission] ?? manifestReasons.get(pluginId)?.[permission] ?? null;
}

/** All of a registered plugin's reasons (definition over manifest). */
export function pluginPermissionReasons(pluginId: string): Record<string, string> {
  return { ...(manifestReasons.get(pluginId) ?? {}), ...(plugins.get(pluginId)?.reasons ?? {}) };
}

/**
 * `api.permissions.request(permission, { reason })`: ask the user, now,
 * for one permission the plugin declared but doesn't hold. Prompts only
 * inside a trigger window (plugin-permission-requests.ts), never for a
 * blocked permission or when the user turned off "ask again", and one
 * prompt at a time; otherwise it resolves at once. Resolves the
 * permission's status after the answer and the plugin's CURRENT api
 * (re-minted on a grant), so a command can carry on with it.
 */
export async function requestPluginPermission(
  pluginId: string,
  permission: unknown,
  opts?: { reason?: unknown },
): Promise<PluginPermissionRequestResult> {
  const p = plugins.get(pluginId);
  if (!p) throw new Error(`plugin "${pluginId}" is not registered`);
  const perm = String(permission ?? '');
  const result = (): PluginPermissionRequestResult => ({
    status: permissionStatus(perm, p.declared, p.granted),
    api: p.api,
  });
  if (result().status !== 'denied' || !isKnownPermission(perm)) return result();
  const prefs = getPluginPermissionPrefs(pluginId);
  if (!prefs.askAgain || prefs.blocked.includes(perm) || !permissionPromptHook) return result();
  const gate = promptGate(pluginId, perm);
  if (!gate.ok) return result();
  const own = typeof opts?.reason === 'string' ? sanitizePermissionReasons({ [perm]: opts.reason }, [perm])[perm] : undefined;
  const reason = own ?? pluginPermissionReason(pluginId, perm);
  const prompt = permissionPromptHook;
  const networkHosts = perm === 'net.fetch' ? pluginDeclaredNetworkHosts(pluginId) : undefined;
  let answer: PermissionPromptAnswer;
  try {
    answer = await withPromptSlot(() =>
      prompt({ pluginId, name: p.def.name, permission: perm, reason, ...(networkHosts ? { networkHosts } : {}) }),
    );
  } catch (err) {
    console.error('[plugins] permission prompt failed:', err);
    return result();
  }
  if (answer === 'never') {
    blockPluginPermission(pluginId, perm);
    return result();
  }
  if (answer !== 'allow') {
    if (gate.kind === 'event') quietEventPrompts(pluginId, perm);
    return result();
  }
  const next = sanitizePermissionList([...(consent.get(pluginId) ?? []), perm]);
  const nextHosts = nextConsentHosts(pluginId, next);
  let stored: string[] | null = next;
  if (persistConsentHook) {
    try {
      stored = await persistConsentHook(pluginId, next, nextHosts);
    } catch (err) {
      console.error('[plugins] storing a permission grant failed:', err);
      stored = null;
    }
  }
  if (!stored) {
    showToast(`${p.def.name}: couldn’t save that permission. Try again from Settings → Plugins.`);
    return result();
  }
  // The plugin may have unregistered while the prompt was open.
  if (plugins.get(pluginId) !== p) return result();
  regrantPlugin(pluginId, stored, nextHosts);
  return result();
}

/** Where a registered plugin's manifest and definition disagree about
 *  permissions, or null when they agree (or there's no manifest: a dev
 *  load-from-file runs the bundle alone). Only permissions listed in
 *  BOTH can be granted. */
export function pluginManifestDrift(
  pluginId: string,
): { onlyInManifest: string[]; onlyInDefinition: string[] } | null {
  const p = plugins.get(pluginId);
  const manifest = manifestPermissions.get(pluginId);
  if (!p || !manifest) return null;
  const onlyInManifest = manifest.filter((x) => !p.declared.includes(x));
  const onlyInDefinition = p.declared.filter((x) => !manifest.includes(x));
  return onlyInManifest.length || onlyInDefinition.length ? { onlyInManifest, onlyInDefinition } : null;
}

function warnManifestDrift(p: RegisteredPlugin): void {
  const manifestWhy = manifestReasons.get(p.def.id);
  if (manifestWhy) {
    const a = Object.keys(manifestWhy).sort().join(',');
    const b = Object.keys(p.reasons).sort().join(',');
    if (a !== b) {
      console.warn(
        `[plugins] ${p.def.id}: cardmirror-plugin.json and the registered definition give reasons for different ` +
          `permissions (manifest: ${a || 'none'}; definition: ${b || 'none'}). Install and update show the ` +
          `manifest's; permission requests show the definition's.`,
      );
    }
  }
  const mHosts = manifestHosts.get(p.def.id);
  if (mHosts && (mHosts.join(',') !== p.hosts.join(','))) {
    console.warn(
      `[plugins] ${p.def.id}: cardmirror-plugin.json and the registered definition list different networkHosts ` +
        `(manifest: ${mHosts.join(', ') || 'none'}; definition: ${p.hosts.join(', ') || 'none'}); ` +
        `net.fetch reaches only hosts in both.`,
    );
  }
  const drift = pluginManifestDrift(p.def.id);
  if (!drift) return;
  const list = (xs: string[]): string => (xs.length ? xs.join(', ') : 'none');
  console.warn(
    `[plugins] ${p.def.id}: cardmirror-plugin.json and the registered definition list different permissions; ` +
      `only those in both can be granted. Only in the manifest: ${list(drift.onlyInManifest)}. ` +
      `Only in the definition: ${list(drift.onlyInDefinition)}.`,
  );
}

/** Drop a plugin's consent record, so its next registration asks again
 *  (the dev Permission Demo's off switch). */
export function forgetPluginConsent(pluginId: string): void {
  consent.delete(pluginId);
  consentHosts.delete(pluginId);
}

/** Change a plugin's consent and re-mint its api immediately (the
 *  Settings → Plugins permissions modal, and the dev-load prompt).
 *  `networkHosts` defaults to `nextConsentHosts`. Returns the new
 *  effective grant. */
export function regrantPlugin(
  pluginId: string,
  consented: readonly string[],
  networkHosts?: readonly string[],
): ReadonlySet<string> {
  const hosts = networkHosts ?? nextConsentHosts(pluginId, sanitizePermissionList(consented));
  setPluginConsent(pluginId, consented, hosts);
  const p = plugins.get(pluginId);
  if (!p) return new Set();
  mintApi(p);
  return p.granted;
}

/** Whether a REGISTERED plugin currently holds `permission`. Hook
 *  dispatchers check this at call time, so a revoke or an unregister
 *  silences hooks the plugin registered earlier. */
export function pluginHasPermission(pluginId: string, permission: string): boolean {
  return plugins.get(pluginId)?.granted.has(permission) ?? false;
}

/** Display name of a registered plugin, or null. */
export function pluginDisplayName(pluginId: string): string | null {
  return plugins.get(pluginId)?.def.name ?? null;
}

/** Permission facts for the settings UI. `null` when the plugin isn't
 *  registered this session (disabled / failed to load) — the UI then
 *  falls back to the manifest's lists. */
export function pluginPermissionInfo(
  pluginId: string,
): {
  declared: string[];
  known: string[];
  unknown: string[];
  granted: string[];
  reasons: Record<string, string>;
  /** Hosts it asks for (definition ∩ manifest). */
  networkHosts: string[];
} | null {
  const p = plugins.get(pluginId);
  if (!p) return null;
  const { known, unknown } = splitKnown(p.declared);
  return {
    declared: [...p.declared],
    known,
    unknown,
    granted: [...p.granted].sort(),
    reasons: pluginPermissionReasons(pluginId),
    networkHosts: pluginDeclaredNetworkHosts(pluginId),
  };
}

/** Declared settings of a registered plugin — [] when it declared none
 *  or isn't registered (never loaded this session, or unregistered). */
export function pluginSettingsDefs(pluginId: string): readonly PluginSettingDef[] {
  return plugins.get(pluginId)?.settings ?? [];
}

/** Fired after any registration OR unregistration changes the command
 *  set — the host rebuilds live keymaps (views bake their keymaps at
 *  construction, and both plugin load and uninstall happen after). */
let commandsChangedHook: ((pluginId: string) => void) | null = null;

function fireCommandsChanged(pluginId: string): void {
  try {
    commandsChangedHook?.(pluginId);
  } catch (err) {
    console.error('[plugins] onCommandsChanged hook failed:', err);
  }
}

/** Remove a plugin's registration and every command it owns — the
 *  UNINSTALL half of the lifecycle, so its palette rows, keybinding
 *  rows, and hotkeys vanish immediately instead of lingering until
 *  restart. (Already-executed bundle code can't be unloaded; with its
 *  commands gone it is inert until the next launch.) Returns the
 *  removed command ids so the caller can purge their key overrides. */
export function unregisterPlugin(pluginId: string): string[] {
  const removed: string[] = [];
  for (const [id, entry] of [...commands.entries()]) {
    if (entry.pluginId === pluginId) {
      commands.delete(id);
      removed.push(id);
    }
  }
  const entry = plugins.get(pluginId);
  if (entry) deactivatePlugin(entry);
  const had = plugins.delete(pluginId);
  if (had || removed.length > 0) {
    console.log(`[plugins] unregistered ${pluginId} (${removed.length} commands)`);
    fireCommandsChanged(pluginId);
  }
  if (had) fireGrantsChanged(pluginId);
  return removed;
}

/** Install the window global. `createApi` mints one capability object
 *  per plugin id (dependency-injected so tests can stub it).
 *  `opts.onCommandsChanged` fires after each successful registration
 *  AND after every unregistration — the host uses it to rebuild live
 *  keymaps, since every editor view built before the change baked its
 *  keymap without it (initPlugins runs async after boot, so on a cold
 *  launch that is EVERY open view — without the rebuild new defaultKeys
 *  stay dead, and uninstalled ones stay live, until an unrelated
 *  reconfigure).
 *  `opts.onPermissionRequest` fires when a bundle with no consent record
 *  (dev load-from-file) declares supported permissions; the host asks
 *  the user and answers via `regrantPlugin`. */
export function installPluginRegistry(
  createApi: CreatePluginApi,
  opts: {
    onCommandsChanged?: (pluginId: string) => void;
    onPermissionRequest?: (pluginId: string, name: string, known: string[], unknown: string[]) => void;
    /** Show a just-in-time prompt (`api.permissions.request`). Absent:
     *  requests never prompt. */
    onPermissionPrompt?: (req: PermissionPromptRequest) => Promise<PermissionPromptAnswer>;
    /** Store a consent list a prompt changed (see persistConsentHook),
     *  with the `net.fetch` hosts to record beside it. */
    persistConsent?: (pluginId: string, consented: string[], networkHosts: string[]) => Promise<string[] | null>;
  } = {},
): void {
  makeApi = createApi;
  commandsChangedHook = opts.onCommandsChanged ?? null;
  permissionRequestHook = opts.onPermissionRequest ?? null;
  permissionPromptHook = opts.onPermissionPrompt ?? null;
  persistConsentHook = opts.persistConsent ?? null;
  window.__registerCardMirrorPlugin = (def) => {
    const res = registerPluginDefinition(def);
    if (res.ok) {
      const count = [...commands.values()].filter((c) => c.pluginId === def.id).length;
      console.log(`[plugins] registered ${def.id} (${count} commands)`);
      fireCommandsChanged(String(def.id));
    } else {
      console.warn(`[plugins] registration rejected: ${res.error}`);
      showToast(`Plugin failed to load: ${res.error}`);
    }
  };
}

export function pluginCommandIds(): string[] {
  return [...commands.keys()];
}
export function isPluginCommandId(id: string): boolean {
  return commands.has(id);
}
export function pluginCommandLabel(id: string): string | null {
  return commands.get(id)?.cmd.label ?? null;
}
export function pluginCommandKeywords(id: string): readonly string[] {
  return commands.get(id)?.cmd.keywords ?? [];
}
export function pluginDefaultKey(id: string): string | string[] | null {
  return commands.get(id)?.cmd.defaultKey ?? null;
}

/** Run a plugin command by id. Never throws: sync and async failures
 *  both log and toast with the plugin's name. */
export function runPluginCommand(id: string): boolean {
  const entry = commands.get(id);
  if (!entry) return false;
  const plugin = plugins.get(entry.pluginId);
  if (!plugin) return false;
  // The user ran it: the plugin may ask for a permission it needs.
  notePluginActivation(entry.pluginId, 'user');
  const report = (err: unknown): void => {
    console.error(`[plugins] ${id} failed:`, err);
    const message = err instanceof Error ? err.message : String(err);
    showToast(`${plugin.def.name}: command failed — ${message}`);
  };
  try {
    const r = entry.cmd.run(plugin.api);
    if (r && typeof (r as Promise<void>).catch === 'function') {
      void (r as Promise<void>).catch(report);
    }
  } catch (err) {
    report(err);
  }
  return true;
}

export function registeredPlugins(): { id: string; name: string }[] {
  return [...plugins.values()].map((p) => ({ id: p.def.id, name: p.def.name }));
}

export function resetPluginRegistryForTests(): void {
  plugins.clear();
  commands.clear();
  consent.clear();
  manifestPermissions.clear();
  manifestReasons.clear();
  manifestHosts.clear();
  consentHosts.clear();
  permissionPromptHook = null;
  persistConsentHook = null;
  grantListeners.clear();
  makeApi = null;
  commandsChangedHook = null;
  permissionRequestHook = null;
  if (typeof window !== 'undefined') delete window.__registerCardMirrorPlugin;
}
