/**
 * Shared plumbing for the plugin API's optional namespaces
 * (`plugin-caps/*`). Each namespace module exports a builder
 * `(ctx: CapabilityContext) => Namespace | undefined`; `createPluginApi`
 * runs them from one table, so adding a namespace never touches the
 * others.
 */
import type { PluginPermissionRequestResult } from '../plugin-api.js';
import type { EditorView } from 'prosemirror-view';
import type { PluginCollabBridge } from './collab.js';

/** What the editor hands the plugin API (wired in index.ts initPlugins). */
export interface PluginApiDeps {
  appVersion: string;
  getView(): EditorView | null;
  /** Live view of any pane in this window holding `docId` (focused or
   *  not), or null. Lets a jump land locally without the IPC hop even
   *  when the target doc is in an unfocused pane. */
  findViewForDocId(docId: string): EditorView | null;
  /** Identity of the focused doc; docId null until minted. */
  getDocIdentity(): { docId: string | null; docTitle: string } | null;
  /** Mint + stamp a docId for the focused doc; null when no doc. */
  ensureDocId(): string | null;
  /** Session uid of the focused doc; null when none. Optional so older
   *  test doubles keep compiling. */
  getFocusedDocUid?(): string | null;
  /** Live view of the doc with session uid `uid` (any pane), or null. */
  viewForUid?(uid: string): EditorView | null;
  /** Identity of the doc with session uid `uid`, or null when not open. */
  docIdentityForUid?(uid: string): { docId: string | null; docTitle: string } | null;
  /** `collab.*` host bridge; absent where co-editing isn't available. */
  collab?: PluginCollabBridge;
  /** Whether the plugin holds `permission` RIGHT NOW (the registry's
   *  live grant). Every namespace method re-checks it when called, so a
   *  reference kept from before a revoke stops working. Absent (tests,
   *  legacy callers): the minted grant is final. */
  isGranted?(pluginId: string, permission: string): boolean;
  /** `api.permissions.request` (the registry's requestPluginPermission).
   *  Absent (tests, legacy callers): requests never prompt. */
  requestPermission?(
    pluginId: string,
    permission: string,
    opts?: { reason?: string },
  ): Promise<PluginPermissionRequestResult>;
}

/** Everything a namespace builder needs about one plugin. */
export interface CapabilityContext {
  pluginId: string;
  /** Display name — labels plugin-originated UI. */
  name: string;
  /** Effective grant (registry-resolved snapshot). */
  granted: ReadonlySet<string>;
  deps: PluginApiDeps;
}

/** Cap a third-party string (ellipsis when cut). */
export function clip(text: unknown, max: number): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The doc a call targets: the given session uid, else the focused doc. */
export function targetDocUid(deps: PluginApiDeps, docUid?: string): string | null {
  return docUid != null ? String(docUid) : deps.getFocusedDocUid?.() ?? null;
}

/** The live view for a target doc (given uid, else focused), or null. */
export function targetView(deps: PluginApiDeps, docUid?: string): { uid: string; view: EditorView } | null {
  const uid = targetDocUid(deps, docUid);
  if (!uid) return null;
  const view =
    docUid == null ? deps.getView() ?? deps.viewForUid?.(uid) ?? null : deps.viewForUid?.(uid) ?? null;
  return view ? { uid, view } : null;
}
