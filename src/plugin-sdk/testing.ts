/**
 * `@cardmirror/plugin-api/testing`: a fake CardMirror plugin api for a
 * plugin's own unit tests, so a plugin can be tested without the app.
 *
 * It gates methods from the SAME table the host uses
 * (src/editor/plugin-call-rules.ts), so which methods exist under which
 * permissions, and how a revoked call fails, match the real thing. It
 * has no test-framework dependency: pass your own implementations
 * (`vi.fn(...)` works fine) for whatever a test needs to script, and
 * every other granted method is a harmless stub.
 *
 * Tests only. This module has runtime code, so never import it from a
 * plugin's bundle (`index.ts` stays type-only; this file is the one
 * exception). Its only runtime imports are two dependency-free modules.
 *
 *   const fake = createFakePluginApi({
 *     granted: ['files.data', 'collab.read'],
 *     collab: { current: () => ({ roomId, role: 'host', title: null, server: null, crossServer: 'off' }) },
 *   });
 *   plugin.activate?.(fake.api);
 *   const results = fake.save({ docUid: 'u1', docId: 'd1', title: 'a.cmir' });
 */
import { CALL_TIME_PERMISSIONS, PluginPermissionError, type PluginNamespaceKey } from '../editor/plugin-call-rules.js';
import { isKnownPermission } from '../editor/plugin-permissions.js';
import type {
  CardMirrorPluginApi,
  PermissionStatus,
  PluginCollabApi,
  PluginDocApi,
  PluginDocContext,
  PluginEventsApi,
  PluginFilesApi,
  PluginAnnotation,
  PluginAnnotationsApi,
  PluginMenuApi,
  PluginNetApi,
  PluginNoticeOptions,
  PluginNoticesApi,
  PluginPanelApi,
  PluginSaveResult,
  PluginSettingValue,
  PluginUiApi,
} from './index.js';

type SaveHook = Parameters<PluginFilesApi['onSave']>[0];
type OpenHook = Parameters<PluginFilesApi['onOpen']>[0];

/** Hook-style methods whose callbacks the fake records. */
export interface FakeHookMap {
  'files.onSave': SaveHook;
  'files.onOpen': OpenHook;
  'events.onDocChange': Parameters<PluginEventsApi['onDocChange']>[0];
  'events.onSelectionChange': Parameters<PluginEventsApi['onSelectionChange']>[0];
  'events.onFocusChange': Parameters<PluginEventsApi['onFocusChange']>[0];
  'menu.add': Parameters<PluginMenuApi['add']>[0];
}

export interface FakePluginApiOptions {
  /** Permissions granted at mint (default: `declared`). */
  granted?: readonly string[];
  /** Permissions the plugin declared (default: `granted`). Drives
   *  `permissions.status` (`undeclared` for anything not listed). */
  declared?: readonly string[];
  /** Simulate an older CardMirror that doesn't know these permissions:
   *  `status()` says `unsupported` and their methods are absent. */
  unsupported?: readonly string[];
  /** Simulate an older CardMirror that lacks individual methods, as
   *  `'namespace.method'` (e.g. `'collab.shareAddress'`). */
  omit?: readonly string[];
  appVersion?: string;
  /** Values for `api.settings.get` (declared defaults included). */
  settings?: Record<string, PluginSettingValue>;
  /** Implementations, per namespace. A granted method you don't pass is
   *  a harmless stub (null / 'unknown' / no-op; see the defaults below). */
  ui?: Partial<PluginUiApi>;
  files?: Partial<PluginFilesApi>;
  collab?: Partial<PluginCollabApi>;
  doc?: Partial<PluginDocApi>;
  events?: Partial<PluginEventsApi>;
  panel?: Partial<PluginPanelApi>;
  menu?: Partial<PluginMenuApi>;
  notices?: Partial<PluginNoticesApi>;
  annotations?: Partial<PluginAnnotationsApi>;
  net?: Partial<PluginNetApi>;
  /** How the fake user answers `api.permissions.request` prompts
   *  (default `'not-now'`). The fake prompts only for a declared,
   *  supported permission that isn't granted, like the host; it has no
   *  trigger window, so a test can call `request` any time. */
  answer?:
    | 'allow'
    | 'not-now'
    | 'never'
    | ((permission: string, reason: string | null) => 'allow' | 'not-now' | 'never');
  /** The always-present v1 members. */
  core?: Partial<Pick<CardMirrorPluginApi, 'extractSelection' | 'jumpToSource' | 'flowApps' | 'flowPost' | 'docInfo'>>;
}

export interface FakePluginApi {
  /** The CURRENT api (a granted `request` re-mints it, as the host does). */
  readonly api: CardMirrorPluginApi;
  /** Every prompt `api.permissions.request` showed, in order. */
  readonly requests: { permission: string; reason: string | null }[];
  /** Every `api.showToast` message, in order. */
  readonly toasts: string[];
  /** Every notice posted through the default `notices.post`. */
  readonly notices: PluginNoticeOptions[];
  /** The marks each doc carries through the default `annotations.set` /
   *  `clear`, keyed by `docUid` ('' = the focused doc, no `docUid`). */
  readonly annotations: Map<string, PluginAnnotation[]>;
  /** `api.storage`, as a map (values are JSON round-tripped, like the host). */
  readonly storage: Map<string, unknown>;
  /** Callbacks registered through a hook-style method (and not yet
   *  unsubscribed). Only methods you didn't implement record here. */
  hooks<K extends keyof FakeHookMap>(name: K): FakeHookMap[K][];
  /** Change the LIVE grant, as a revoke or re-grant in Settings would.
   *  Methods keep existing on this api object; calls under a withdrawn
   *  permission throw (or reject with) a `PluginPermissionError`. */
  setGranted(permissions: readonly string[]): void;
  /** Change a setting and fire `settings.onChanged` listeners. */
  setSetting(key: string, value: PluginSettingValue): void;
  /** Run the recorded `files.onSave` hooks, like a save of `ctx`. */
  save(ctx: PluginDocContext): PluginSaveResult[];
  /** Run the recorded `files.onOpen` hooks, like opening a file whose
   *  plugin data is `data`; resolves when they settle. */
  open(data: unknown, ctx: PluginDocContext): Promise<void>;
}

const ROOM_RE = /^(?:cmshare|cmview)\d+[a-z]*\.([0-9a-f]{16,64})\./;
type AnyFn = (...args: never[]) => unknown;

export function createFakePluginApi(opts: FakePluginApiOptions = {}): FakePluginApi {
  const declared = [...(opts.declared ?? opts.granted ?? [])];
  const unsupported = new Set(opts.unsupported ?? []);
  const known = (p: string): boolean => isKnownPermission(p) && !unsupported.has(p);
  const minted = new Set((opts.granted ?? declared).filter(known));
  let live = new Set(minted);
  const omit = new Set(opts.omit ?? []);
  const toasts: string[] = [];
  const notices: PluginNoticeOptions[] = [];
  const annotations = new Map<string, PluginAnnotation[]>();
  const docKey = (o?: { docUid?: string }): string => (o?.docUid != null ? String(o.docUid) : '');
  const storage = new Map<string, unknown>();
  const settings = new Map<string, PluginSettingValue>(Object.entries(opts.settings ?? {}));
  const settingListeners = new Set<(key: string, value: PluginSettingValue) => void>();
  const recorded = new Map<keyof FakeHookMap, unknown[]>();

  const record = <K extends keyof FakeHookMap>(name: K) =>
    (hook: FakeHookMap[K]): (() => void) => {
      const list = recorded.get(name) ?? [];
      list.push(hook);
      recorded.set(name, list);
      return () => {
        const i = list.indexOf(hook);
        if (i >= 0) list.splice(i, 1);
      };
    };

  const defaults: Record<PluginNamespaceKey, Record<string, AnyFn>> = {
    ui: { choose: async () => null, confirm: async () => false },
    files: {
      onSave: record('files.onSave'),
      onOpen: record('files.onOpen'),
      get: () => null,
      focusedDoc: () => null,
    },
    collab: {
      current: () => null,
      roomIdOf: (c: string) => ROOM_RE.exec(String(c ?? '').trim())?.[1] ?? null,
      localRecord: async () => null,
      server: async () => null,
      reach: async () => 'unknown',
      parseAddress: async () => null,
      probe: async () => 'unknown',
      shareCode: () => null,
      shareAddress: () => null,
      viewCode: () => null,
      viewAddress: () => null,
      join: async () => 'unavailable',
    },
    doc: {
      read: () => null,
      insert: async () => ({ ok: false, error: 'no-doc' }),
      jumpTo: async () => ({ ok: false, error: 'doc-not-open' }),
    },
    events: {
      onDocChange: record('events.onDocChange'),
      onSelectionChange: record('events.onSelectionChange'),
      onFocusChange: record('events.onFocusChange'),
    },
    panel: {
      get: () => {
        throw new Error('createFakePluginApi: pass `panel.get` (a panel handle needs a DOM element).');
      },
    },
    menu: { add: record('menu.add') },
    notices: {
      post: (n: PluginNoticeOptions) => {
        notices.push(n);
        return { clear: () => {} };
      },
    },
    annotations: {
      set: (items: PluginAnnotation[], o?: { docUid?: string }) => {
        if (!Array.isArray(items)) throw new Error('annotations.set needs an array');
        annotations.set(docKey(o), [...items]);
        return { ok: true, placed: items.length, unplaced: 0 };
      },
      clear: (o?: { docUid?: string }) => void annotations.delete(docKey(o)),
    },
    net: { fetch: async () => ({ ok: false, error: 'offline' }) },
  };

  const blocked = new Set<string>();
  const requests: { permission: string; reason: string | null }[] = [];
  let current: CardMirrorPluginApi;

  const mint = (): CardMirrorPluginApi => {
    const namespaces: Record<string, unknown> = {};
    for (const key of Object.keys(CALL_TIME_PERMISSIONS) as PluginNamespaceKey[]) {
      const rules = CALL_TIME_PERMISSIONS[key];
      const impls = (opts[key] ?? {}) as Record<string, AnyFn | undefined>;
      const ns: Record<string, unknown> = {};
      for (const [method, rule] of Object.entries(rules)) {
        if (!minted.has(rule.permission) || omit.has(`${key}.${method}`)) continue;
        const fn = impls[method] ?? defaults[key][method];
        if (!fn) continue;
        ns[method] = (...args: never[]): unknown => {
          if (!live.has(rule.permission)) {
            const err = new PluginPermissionError(rule.permission);
            if (rule.async) return Promise.reject(err);
            throw err;
          }
          return fn(...args);
        };
      }
      if (Object.keys(ns).length > 0) namespaces[key] = Object.freeze(ns);
    }

    const status = (p: string): PermissionStatus => {
      if (!declared.includes(p)) return 'undeclared';
      if (!known(p)) return 'unsupported';
      return minted.has(p) && live.has(p) ? 'granted' : 'denied';
    };

    const api = {
      ...namespaces,
      appVersion: opts.appVersion ?? 'test',
      extractSelection: opts.core?.extractSelection ?? (() => ({ ok: false, error: 'no-active-doc' })),
      jumpToSource: opts.core?.jumpToSource ?? (async () => ({ ok: false, error: 'doc-not-open' })),
      flowApps: opts.core?.flowApps ?? (async () => []),
      flowPost: opts.core?.flowPost ?? (async () => ({ ok: false, error: 'unsupported' })),
      docInfo: opts.core?.docInfo ?? (() => null),
      showToast: (message: string) => void toasts.push(String(message)),
      storage: {
        get: (key: string) => storage.get(key),
        set: (key: string, value: unknown) => {
          storage.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
        },
      },
      settings: {
        get: (key: string) => settings.get(key),
        onChanged: (cb: (key: string, value: PluginSettingValue) => void) => {
          settingListeners.add(cb);
          return () => void settingListeners.delete(cb);
        },
      },
      permissions: Object.freeze({
        has: (p: string) => minted.has(p) && live.has(p),
        list: () => [...minted].filter((p) => live.has(p)).sort(),
        status: (p: string) => status(String(p)),
        request: async (p: string, o?: { reason?: string }) => {
          const perm = String(p);
          if (status(perm) !== 'denied' || blocked.has(perm)) return { status: status(perm), api: current };
          const reason = typeof o?.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 200) : null;
          requests.push({ permission: perm, reason });
          const a = typeof opts.answer === 'function' ? opts.answer(perm, reason) : opts.answer ?? 'not-now';
          if (a === 'never') blocked.add(perm);
          if (a === 'allow') {
            minted.add(perm);
            live.add(perm);
            current = mint();
          }
          return { status: status(perm), api: current };
        },
      }),
    } as unknown as CardMirrorPluginApi;
    return api;
  };
  current = mint();

  return {
    get api() {
      return current;
    },
    requests,
    toasts,
    notices,
    annotations,
    storage,
    hooks: <K extends keyof FakeHookMap>(name: K) => [...((recorded.get(name) ?? []) as FakeHookMap[K][])],
    setGranted(permissions) {
      live = new Set(permissions.filter(known));
    },
    setSetting(key, value) {
      settings.set(key, value);
      for (const cb of [...settingListeners]) cb(key, value);
    },
    save(ctx) {
      if (!live.has('files.data')) return [];
      return (recorded.get('files.onSave') ?? []).map((h) => (h as SaveHook)(ctx));
    },
    async open(data, ctx) {
      if (!live.has('files.data')) return;
      await Promise.all((recorded.get('files.onOpen') ?? []).map((h) => (h as OpenHook)(data, ctx)));
    },
  };
}
