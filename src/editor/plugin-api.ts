/**
 * Public plugin API surface — the types a plugin author codes against,
 * plus `createPluginApi`, the renderer-side implementation.
 *
 * The v1 core (extract / jump / flow / storage / settings / toast) lives
 * here. Everything else is an OPTIONAL namespace behind a permission,
 * one module each under `plugin-caps/`; `createPluginApi` assembles
 * them from the `NAMESPACES` table below. To add a capability: a catalog
 * entry in plugin-permissions.ts, a `plugin-caps/<name>.ts` builder, one
 * row in `NAMESPACES`, one optional field on `CardMirrorPluginApi`.
 */
import { postNotice } from './status-notices.js';
import { getElectronHost } from './host/index.js';
import { showToast } from './toast.js';
import { extractSelection } from './plugin-extract.js';
import { jumpToTokenInView } from './plugin-jump.js';
import { getPluginSettingValue, subscribePluginSettings } from './plugin-settings.js';
import { parseSourceToken } from './plugin-source-token.js';
import { permissionStatus, type PermissionStatus } from './plugin-permissions.js';
import type { CapabilityContext, PluginApiDeps } from './plugin-caps/context.js';
import { buildUiApi, type PluginUiApi } from './plugin-caps/ui.js';
import { buildFilesApi, type PluginFilesApi } from './plugin-caps/files.js';
import { buildCollabApi, type PluginCollabApi } from './plugin-caps/collab.js';
import { buildDocApi, type PluginDocApi } from './plugin-caps/doc.js';
import { buildEventsApi, type PluginEventsApi } from './plugin-caps/events.js';
import { buildPanelApi, type PluginPanelApi } from './plugin-caps/panel.js';
import { buildMenuApi, type PluginMenuApi } from './plugin-caps/menu.js';
import { buildNoticesApi, type PluginNoticesApi } from './plugin-caps/notices.js';
import { CALL_TIME_PERMISSIONS, PluginPermissionError, type PluginNamespaceKey } from './plugin-call-rules.js';

export type { PluginApiDeps } from './plugin-caps/context.js';
export type { PluginChoiceOption, PluginUiApi } from './plugin-caps/ui.js';
export type { PluginDocContext, PluginFilesApi, PluginSaveResult } from './plugin-caps/files.js';
export type {
  PluginCollabApi,
  PluginCrossServer,
  PluginCollabBridge,
  PluginJoinOutcome,
  PluginLocalSessionRecord,
  PluginParsedAddress,
  PluginProbeResult,
  PluginServerInfo,
  PluginServerReach,
  PluginSessionAddress,
  PluginSessionInfo,
} from './plugin-caps/collab.js';
export type {
  PluginCard,
  PluginDocApi,
  PluginDocSnapshot,
  PluginDocStats,
  PluginEditError,
  PluginEditResult,
  PluginHeadingType,
  PluginInsertRequest,
  PluginInsertRole,
  PluginOutlineItem,
} from './plugin-caps/doc.js';
export type {
  PluginDocChangeEvent,
  PluginEventsApi,
  PluginFocusEvent,
  PluginSelectionEvent,
} from './plugin-caps/events.js';
export type { PluginPanelApi, PluginPanelHandle } from './plugin-caps/panel.js';
export type { PluginMenuApi, PluginMenuItem, PluginMenuTarget } from './plugin-caps/menu.js';
export type {
  PluginNoticeAction,
  PluginNoticeHandle,
  PluginNoticeOptions,
  PluginNoticesApi,
} from './plugin-caps/notices.js';

export type ExtractedKind =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'undertag'
  | 'cite';

export interface ExtractedItem {
  kind: ExtractedKind;
  text: string;
  /** Opaque provenance token (see plugin-source-token.ts). */
  source: string;
}

export interface ExtractResult {
  ok: true;
  docId: string;
  docTitle: string;
  items: ExtractedItem[];
}

export type ExtractErrorCode = 'no-heading-at-cursor' | 'no-active-doc' | 'empty-selection';
export interface ExtractError {
  ok: false;
  error: ExtractErrorCode;
}

export type JumpResult =
  | { ok: true }
  | { ok: false; error: 'doc-not-open' | 'not-found' | 'bad-request'; docTitle?: string };

export interface FlowAppInfo {
  id: string;
  app: string;
  appVersion: string;
  schema: number;
  kind: 'flow';
  /** Whether the app answered a liveness ping just now. Closed apps are
   *  LISTED (their identity registration persists) — selection never
   *  requires the app to be running; sends to a closed app fail at
   *  runtime with `app-not-running`. Keep in sync with the main-process
   *  declaration in apps/desktop/src/bridge-handshake.ts. */
  running: boolean;
}

export type FlowPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: 'no-such-app' | 'app-not-running' | 'timeout' | 'bad-response' | 'unsupported' };

export interface PluginStorage {
  get(key: string): unknown;
  /** `__settings` is reserved — it holds the values of the settings the
   *  plugin declared at registration (rendered by the host's settings
   *  modal). Writing it directly only corrupts your own settings; reads
   *  through `api.settings.get` fall back to declared defaults. */
  set(key: string, value: unknown): void;
}

export interface PluginSettingsApi {
  /** Current value of a setting DECLARED in the plugin definition's
   *  `settings` array (the declared default when the user hasn't set
   *  it); undefined for undeclared keys. */
  get(key: string): boolean | string | number | undefined;
  /** Fires when the user changes one of this plugin's settings in the
   *  settings modal. Returns an unsubscribe function. Most plugins
   *  don't need this — reading lazily via `get` when a command runs
   *  always sees the current value. */
  onChanged(cb: (key: string, value: boolean | string | number) => void): () => void;
}

/** What this plugin was granted (see plugin-permissions.ts). Absent on
 *  CardMirror builds that predate permissions — feature-detect with
 *  `api.permissions?.has('ui.dialogs')`. */
export interface PluginPermissionsApi {
  has(permission: string): boolean;
  /** Granted permissions, sorted. */
  list(): string[];
  /** Why a permission is or isn't available, so the plugin can point
   *  the user at the right fix: `denied` → Settings → Plugins (the
   *  user declined or revoked it), `unsupported` → update CardMirror,
   *  `undeclared` → the plugin's own definition never asked for it. */
  status(permission: string): PermissionStatus;
}

/**
 * The api object handed to every command's `run`, and to the
 * definition's `activate` (the place to register long-lived hooks —
 * `files.onOpen`, `events.on*` — since it runs at load and again with a
 * fresh api whenever the grant changes).
 *
 * Growing the API: optional namespaces appear only when the plugin
 * declared the matching permission (`permissions: ['ui.dialogs']` in
 * both `cardmirror-plugin.json` and the registered definition) AND the
 * user granted it. Always feature-detect — `api.ui?.choose(...)` — since
 * a user can revoke a permission at any time, and older CardMirror
 * builds have neither `permissions` nor the optional namespaces. Use
 * `api.permissions?.status(p)` to tell the user why something is
 * missing. Don't gate on `minAppVersion` or `appVersion` for these:
 * fork, upstream and federation (`-f`) version numbers aren't
 * comparable (see PLUGINS.md, "About `minAppVersion`").
 */
export interface CardMirrorPluginApi {
  readonly appVersion: string;
  extractSelection(): ExtractResult | ExtractError;
  jumpToSource(token: string): Promise<JumpResult>;
  flowApps(): Promise<FlowAppInfo[]>;
  flowPost(appId: string, route: string, body: unknown): Promise<FlowPostResult>;
  docInfo(): { docId: string; docTitle: string } | null;
  showToast(message: string): void;
  storage: PluginStorage;
  settings: PluginSettingsApi;
  /** Present on permission-aware builds (optional in the type because
   *  older hosts lack it). */
  readonly permissions?: PluginPermissionsApi;
  /** `ui.dialogs`. */
  readonly ui?: PluginUiApi;
  /** `files.data`. */
  readonly files?: PluginFilesApi;
  /** Any `collab.*` (methods per permission). Sessions are named by
   *  ADDRESS (`code@server`), the same on federated and non-federated
   *  builds. */
  readonly collab?: PluginCollabApi;
  /** `doc.read` / `doc.edit` (methods per permission). */
  readonly doc?: PluginDocApi;
  /** `doc.events`. */
  readonly events?: PluginEventsApi;
  /** `ui.panel`. */
  readonly panel?: PluginPanelApi;
  /** `ui.contextMenu`. */
  readonly menu?: PluginMenuApi;
  /** `ui.notices`. */
  readonly notices?: PluginNoticesApi;
}

/** What the registry hands `createPluginApi` for one plugin. */
export interface PluginGrantContext {
  /** Effective grant (registry-resolved). */
  granted: ReadonlySet<string>;
  /** Sanitized permissions the running definition declared. */
  declared: readonly string[];
  /** Plugin's display name — labels plugin-originated UI. */
  name: string;
}

/** Thrown (or, for a method that returns a promise, rejected with) when
 *  a plugin calls a method whose permission it no longer holds — an api
 *  reference kept from before a revoke. Plugins can recognize it by
 *  `name === 'PluginPermissionError'` and read `permission`. */
export { PluginPermissionError };

/** Optional namespaces, each built from the plugin's grant (a builder
 *  returns undefined when none of its permissions is granted). */
type OptionalNamespaces = Pick<
  CardMirrorPluginApi,
  'ui' | 'files' | 'collab' | 'doc' | 'events' | 'panel' | 'menu' | 'notices'
>;
const NAMESPACES: {
  [K in keyof OptionalNamespaces]-?: (ctx: CapabilityContext) => OptionalNamespaces[K] | undefined;
} = {
  ui: buildUiApi,
  files: buildFilesApi,
  collab: buildCollabApi,
  doc: buildDocApi,
  events: buildEventsApi,
  panel: buildPanelApi,
  menu: buildMenuApi,
  notices: buildNoticesApi,
};

// Which permission each namespace method needs (checked on every call):
// plugin-call-rules.ts, dependency-free so the SDK's test helper uses the
// very same table. The type check below fails to compile unless its
// namespace keys are exactly this file's optional namespaces.
export { CALL_TIME_PERMISSIONS };
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _rulesMatchNamespaces: SameKeys<PluginNamespaceKey, keyof OptionalNamespaces> = true;
void _rulesMatchNamespaces;

/** Wrap a namespace's methods with their call-time permission check. */
function guardNamespace(
  key: keyof OptionalNamespaces,
  ns: object,
  ctx: CapabilityContext,
  isGranted: (permission: string) => boolean,
): object {
  const rules = CALL_TIME_PERMISSIONS[key];
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(ns)) {
    if (typeof value !== 'function') {
      out[name] = value;
      continue;
    }
    const rule = Object.prototype.hasOwnProperty.call(rules, name) ? rules[name] : undefined;
    if (!rule) {
      console.error(`[plugins] ${key}.${name} has no call-time permission rule; not exposed to ${ctx.pluginId}`);
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    out[name] = (...args: unknown[]): unknown => {
      if (!isGranted(rule.permission)) {
        const err = new PluginPermissionError(rule.permission);
        if (rule.async) return Promise.reject(err);
        throw err;
      }
      return fn.apply(ns, args);
    };
  }
  return Object.freeze(out);
}

function buildNamespaces(
  ctx: CapabilityContext,
  isGranted: (permission: string) => boolean,
): OptionalNamespaces {
  const out: Record<string, unknown> = {};
  for (const [key, build] of Object.entries(NAMESPACES)) {
    const ns = (build as (c: CapabilityContext) => unknown)(ctx);
    if (ns !== undefined) {
      out[key] = guardNamespace(key as keyof OptionalNamespaces, ns as object, ctx, isGranted);
    }
  }
  return out as OptionalNamespaces;
}

/** Mint one plugin's api object. Namespaces outside `grant.granted` are
 *  simply absent, so they can't run. Without a grant context (tests, legacy callers) the
 *  plugin is treated as declaring nothing — the plain v1 surface. */
export function createPluginApi(
  pluginId: string,
  deps: PluginApiDeps,
  grant: PluginGrantContext = { granted: new Set(), declared: [], name: pluginId },
): CardMirrorPluginApi {
  const storageKey = `plugin:${pluginId}`;
  const readBag = (): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  // The minted grant decides which methods EXIST (the registry re-mints
  // the api object on any grant change). The live grant decides whether
  // a call RUNS: a reference kept from before a revoke is refused, and
  // its `permissions` answers reflect the revoke too.
  const grantSet: ReadonlySet<string> = new Set(grant.granted);
  const declared = Object.freeze([...grant.declared]);
  const live = (p: string): boolean => grantSet.has(p) && (deps.isGranted?.(pluginId, p) ?? true);
  const liveGrant = (): ReadonlySet<string> => new Set([...grantSet].filter(live));
  const displayName = grant.name || pluginId;
  const permissions: PluginPermissionsApi = Object.freeze({
    has: (p: string) => live(String(p)),
    list: () => [...liveGrant()].sort(),
    status: (p: string) => permissionStatus(String(p), declared, liveGrant()),
  });
  return {
    permissions,
    ...buildNamespaces({ pluginId, name: displayName, granted: grantSet, deps }, live),
    appVersion: deps.appVersion,
    extractSelection() {
      const view = deps.getView();
      if (!view) return { ok: false, error: 'no-active-doc' };
      const ident = deps.getDocIdentity();
      if (!ident) return { ok: false, error: 'no-active-doc' };
      // Extract against the doc's current identity FIRST, so a failed
      // extraction never mints/stamps a docId onto a pristine file.
      const res = extractSelection(view, { docId: ident.docId ?? '', docTitle: ident.docTitle });
      if (!res.ok) return res;
      if (ident.docId) return res;
      // First-ever successful extraction on an unstamped doc: mint + stamp,
      // then re-walk so the emitted tokens carry the real docId. The
      // double walk happens exactly once per document LIFETIME (the stamp
      // persists), so caching the first walk's items isn't worth the
      // staleness risk.
      const docId = deps.ensureDocId();
      if (!docId) return { ok: false, error: 'no-active-doc' };
      return extractSelection(view, { docId, docTitle: ident.docTitle });
    },
    async jumpToSource(token) {
      const payload = parseSourceToken(token);
      if (!payload) return { ok: false, error: 'bad-request' };
      const view = deps.findViewForDocId(payload.docId);
      // A matched view always carries payload.docId, so the local jump is
      // authoritative — jumpToTokenInView can't answer 'not-mine' here.
      if (view) {
        const local = jumpToTokenInView(view, payload.docId, token);
        if (local !== 'not-mine') return local;
      }
      const host = getElectronHost();
      if (host?.pluginJump) return (await host.pluginJump(token)) as JumpResult;
      return { ok: false, error: 'doc-not-open', docTitle: payload.docTitle };
    },
    async flowApps() {
      const host = getElectronHost();
      if (!host?.flowApps) return [];
      return (await host.flowApps()) as FlowAppInfo[];
    },
    async flowPost(appId, route, body) {
      const host = getElectronHost();
      if (!host?.flowPost) return { ok: false, error: 'unsupported' };
      return (await host.flowPost(appId, route, body)) as FlowPostResult;
    },
    docInfo() {
      const i = deps.getDocIdentity();
      return i && i.docId ? { docId: i.docId, docTitle: i.docTitle } : null;
    },
    showToast(message) {
      // Third-party text: attribute it to the plugin (so it can't
      // impersonate a CardMirror system message) and cap the toast;
      // anything longer lands as a durable chip notice instead of a
      // wall-of-text tooltip.
      // Labeled with the display name, like dialogs, notices and panels.
      const text = String(message);
      const attributed = `[${displayName}] ${text}`;
      if (text.length > 300) {
        postNotice({ severity: 'info', title: `Plugin: ${displayName}`, body: attributed });
      } else {
        showToast(attributed);
      }
    },
    storage: {
      get(key) {
        return readBag()[key];
      },
      set(key, value) {
        const bag = readBag();
        bag[key] = value;
        try {
          localStorage.setItem(storageKey, JSON.stringify(bag));
        } catch {
          /* quota — non-fatal */
        }
      },
    },
    settings: {
      get(key) {
        return getPluginSettingValue(pluginId, key);
      },
      onChanged(cb) {
        return subscribePluginSettings(pluginId, cb);
      },
    },
  };
}
