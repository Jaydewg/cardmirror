/**
 * The permission each plugin-api namespace method needs, re-checked on
 * EVERY call (a namespace builder only decides which methods exist, at
 * mint time). Dependency-free on purpose: the host's api
 * (plugin-api.ts) and the SDK's test helper (src/plugin-sdk/testing.ts)
 * gate methods from this one table, so a plugin's tests see exactly the
 * host's rules.
 *
 * `async` marks a method that returns a promise: a refused call rejects
 * rather than throws, keeping the method's contract. A method missing
 * from this table is not exposed at all (fail closed);
 * tests/editor/plugin-api-call-time.test.ts fails on any gap or stale
 * entry.
 */

export interface CallRule {
  readonly permission: string;
  readonly async?: true;
}

const sync = (permission: string): CallRule => ({ permission });
const async = (permission: string): CallRule => ({ permission, async: true });

export type PluginNamespaceKey = 'ui' | 'files' | 'collab' | 'doc' | 'events' | 'panel' | 'menu' | 'notices';

export const CALL_TIME_PERMISSIONS: {
  readonly [K in PluginNamespaceKey]: Readonly<Record<string, CallRule>>;
} = {
  ui: { choose: async('ui.dialogs'), confirm: async('ui.dialogs') },
  files: {
    onSave: sync('files.data'),
    onOpen: sync('files.data'),
    get: sync('files.data'),
    focusedDoc: sync('files.data'),
  },
  collab: {
    current: sync('collab.read'),
    roomIdOf: sync('collab.read'),
    localRecord: async('collab.read'),
    server: async('collab.server'),
    reach: async('collab.server'),
    parseAddress: async('collab.server'),
    probe: async('collab.probe'),
    shareCode: sync('collab.shareCode'),
    shareAddress: sync('collab.shareCode'),
    viewCode: sync('collab.viewCode'),
    viewAddress: sync('collab.viewCode'),
    join: async('collab.join'),
  },
  doc: { read: sync('doc.read'), insert: async('doc.edit') },
  events: {
    onDocChange: sync('doc.events'),
    onSelectionChange: sync('doc.events'),
    onFocusChange: sync('doc.events'),
  },
  panel: { get: sync('ui.panel') },
  menu: { add: sync('ui.contextMenu') },
  notices: { post: sync('ui.notices') },
};

/** The error a refused call throws (sync) or rejects with (async). */
export class PluginPermissionError extends Error {
  readonly permission: string;
  constructor(permission: string) {
    super(`permission "${permission}" is no longer granted`);
    this.name = 'PluginPermissionError';
    this.permission = permission;
  }
}
