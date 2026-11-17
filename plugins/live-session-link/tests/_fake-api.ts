/**
 * The Live Session Link test rig, on the SDK's fake api
 * (`@cardmirror/plugin-api/testing`): that fake gates methods exactly like
 * CardMirror does; this file scripts sessions, codes, file data, probe and
 * join, and keeps the vi.fn mocks the tests assert on.
 */
import { vi } from 'vitest';
import type {
  PluginDocContext,
  PluginJoinOutcome,
  PluginLocalSessionRecord,
  PluginProbeResult,
  PluginServerReach,
  PluginSessionInfo,
} from '@cardmirror/plugin-api';
import { createFakePluginApi } from '@cardmirror/plugin-api/testing';
import { createLiveSessionLinkPlugin, PLUGIN_PERMISSIONS } from '../src/plugin.js';

export const ROOM = '0123456789abcdef';
export const CODE = `cmshare2.${ROOM}.KEYKEYKEY.1.17.0`;
export const OTHER_ROOM = 'fedcba9876543210';
export const OTHER_CODE = `cmshare2.${OTHER_ROOM}.KEY2.1.17.0`;
/** This machine's server in the fake. */
export const SERVER = 'https://relay.test/relay';
export const OTHER_SERVER = 'https://other.example/relay';
export const ADDRESS = `${CODE}@${SERVER}`;
export const OTHER_ADDRESS = `${OTHER_CODE}@${SERVER}`;
/** What the plugin keys this room by. */
export const KEY = `${ROOM}@${SERVER}`;

export const linkFor = (address = ADDRESS) => {
  const at = address.indexOf('@');
  return {
    v: 2,
    address,
    roomId: /\.([0-9a-f]{16,64})\./.exec(address)![1]!,
    server: address.slice(at + 1),
    title: 'Aff 1AC',
    embeddedAt: 1000,
  };
};

export const session = (role: PluginSessionInfo['role'] = 'host', over: Partial<PluginSessionInfo> = {}): PluginSessionInfo => ({
  roomId: ROOM,
  role,
  title: 'Aff 1AC',
  server: SERVER,
  crossServer: 'unsupported',
  ...over,
});

export interface FakeOptions {
  perms?: string[];
  /** Live session per doc uid (default: none). */
  sessions?: Record<string, PluginSessionInfo>;
  /** Edit code per doc uid. */
  codes?: Record<string, string>;
  /** Stored plugin data per doc uid. */
  fileData?: Record<string, unknown>;
  focused?: PluginDocContext | null;
  probe?: (codeOrAddress: string) => Promise<PluginProbeResult>;
  join?: (code: string, opts?: { intoDoc?: string }) => Promise<PluginJoinOutcome>;
  localRecord?: (roomId: string) => Promise<PluginLocalSessionRecord | null>;
  /** `collab.reach` (default: like a build without federation — your
   *  server is `home`, every other one `unreachable`). */
  reach?: (serverUrl: string) => Promise<PluginServerReach>;
  confirm?: boolean;
  settings?: Record<string, boolean | string | number>;
  /** This machine's server (default SERVER; null = none configured). */
  myServer?: string | null;
  /** Simulate a CardMirror from before session addresses: no
   *  collab.server / shareAddress, and `collab.server` is unsupported. */
  oldHost?: boolean;
}

export function makeFake(opts: FakeOptions = {}) {
  const perms = opts.perms ?? PLUGIN_PERMISSIONS;
  const sessions = opts.sessions ?? {};
  const codes = opts.codes ?? {};
  const fileData = opts.fileData ?? {};
  const focused = opts.focused === undefined ? { docUid: 'u1', docId: 'd1', title: 'file.cmir' } : opts.focused;
  const focusedUid = (uid?: string) => uid ?? focused?.docUid ?? null;

  const probe = vi.fn(opts.probe ?? (async () => 'live' as const));
  const join = vi.fn(opts.join ?? (async () => 'joined' as const));
  const localRecord = vi.fn(opts.localRecord ?? (async () => null));
  const confirm = vi.fn(async (_message: string, _opts?: unknown) => opts.confirm ?? true);
  const choose = vi.fn(async () => null);
  const myServer = opts.myServer === undefined ? SERVER : opts.myServer;
  const reach = vi.fn(
    opts.reach ?? (async (url: string): Promise<PluginServerReach> => (url === myServer ? 'home' : 'unreachable')),
  );
  // Like the host: a session's server is visible only with collab.server.
  const serverVisible = !opts.oldHost && perms.includes('collab.server');

  // The SDK's fake gates every method by the host's own rule table; this
  // file only scripts what the tests need.
  const fake = createFakePluginApi({
    declared: PLUGIN_PERMISSIONS,
    granted: perms,
    // An older CardMirror: no session addresses, so no collab.server and
    // no shareAddress.
    unsupported: opts.oldHost ? ['collab.server'] : [],
    omit: opts.oldHost ? ['collab.shareAddress'] : [],
    settings: { autoEmbedHosted: false, ...opts.settings },
    ui: { confirm, choose },
    files: {
      get: (uid?: string) => fileData[focusedUid(uid) ?? ''] ?? null,
      focusedDoc: () => focused,
    },
    collab: {
      current: (uid?: string) => {
        const s = sessions[focusedUid(uid) ?? ''];
        return s ? { ...s, server: serverVisible ? s.server : null } : null;
      },
      localRecord,
      server: async () => (myServer ? { url: myServer, host: new URL(myServer).hostname, nickname: null } : null),
      reach,
      shareCode: (uid?: string) => codes[focusedUid(uid) ?? ''] ?? null,
      shareAddress: (uid?: string) => {
        const id = focusedUid(uid) ?? '';
        const code = codes[id];
        const s = sessions[id];
        return code && s?.server ? `${code}@${s.server}` : null;
      },
      probe,
      join,
    },
  });

  const plugin = createLiveSessionLinkPlugin();
  const cleanup = plugin.activate?.(fake.api);
  const command = (suffix: string) => plugin.commands.find((c) => c.id === `live-session-link.${suffix}`)!;
  return {
    api: fake.api,
    plugin,
    cleanup,
    store: fake.storage,
    toasts: fake.toasts,
    notices: fake.notices,
    /** The plugin's registered save / open hooks (null once removed). */
    hooks: {
      get save() {
        return fake.hooks('files.onSave')[0] ?? null;
      },
      get open() {
        return fake.hooks('files.onOpen')[0] ?? null;
      },
    },
    probe,
    join,
    reach,
    localRecord,
    confirm,
    choose,
    fileData,
    sessions,
    codes,
    run: (suffix: string) => command(suffix).run(fake.api),
  };
}

export const ctx = (over: Partial<PluginDocContext> = {}): PluginDocContext => ({
  docUid: 'u1',
  docId: 'd1',
  title: 'file.cmir',
  ...over,
});

/** Let queued promise callbacks run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
