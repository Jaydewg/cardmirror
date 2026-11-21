/**
 * CardMirror plugin SDK: the public contract between CardMirror and its
 * plugins, and the ONLY module plugin code may import.
 *
 * Plugins live outside the app (`plugins/<id>/`, or their own repos) and
 * map the module name `@cardmirror/plugin-api` to this file through their
 * tsconfig `paths`. If this contract is ever published as an npm package,
 * plugins swap that one mapping for a dependency and nothing else changes.
 *
 * Rules for this file:
 *   - TYPE-ONLY. Type imports are erased at build time, so a plugin's
 *     bundle never carries app code. Adding a runtime export here would
 *     drag app modules into every plugin bundle. Don't. (The one runtime
 *     module is the test helper, `testing.ts` — `@cardmirror/plugin-api/
 *     testing` — imported by plugin TESTS only.)
 *   - Everything exported is public API. Host-side wiring
 *     (`PluginApiDeps`, `PluginCollabBridge`, `PluginGrantContext`,
 *     `CreatePluginApi`) stays out.
 *   - Changing an exported type is an API change: additive only, unless
 *     `apiVersion` is bumped (see src/editor/plugin-permissions.ts).
 *
 * The registration global, `window.__registerCardMirrorPlugin`, is
 * declared at the bottom of this file.
 */

import type { PluginDefinition as RegistrationDefinition } from '../editor/plugin-registry.js';

// Registration: what a bundle hands `window.__registerCardMirrorPlugin`.
export type {
  PluginCommandDef,
  PluginDefinition,
  PluginSettingDef,
  PluginSettingValue,
} from '../editor/plugin-registry.js';

// The api object passed to `activate` and every command's `run`.
export type {
  CardMirrorPluginApi,
  ExtractedItem,
  ExtractedKind,
  ExtractError,
  ExtractErrorCode,
  ExtractResult,
  FlowAppInfo,
  FlowPostResult,
  JumpResult,
  PluginPermissionRequestResult,
  PluginPermissionsApi,
  PluginSettingsApi,
  PluginStorage,
} from '../editor/plugin-api.js';

// What a call through a stale api reference (permission since revoked)
// throws or rejects with. Type only: recognize it by
// `err.name === 'PluginPermissionError'`, then read `err.permission`.
export type { PluginPermissionError } from '../editor/plugin-api.js';

// Permission status (`api.permissions.status`).
export type { PermissionStatus } from '../editor/plugin-permissions.js';

// Optional namespaces, each behind a permission.
export type { PluginChoiceOption, PluginUiApi } from '../editor/plugin-api.js';
export type {
  PluginNoticeAction,
  PluginNoticeHandle,
  PluginNoticeOptions,
  PluginNoticesApi,
} from '../editor/plugin-api.js';
export type { PluginDocContext, PluginFilesApi, PluginSaveResult } from '../editor/plugin-api.js';
export type {
  PluginCollabApi,
  PluginCrossServer,
  PluginJoinOutcome,
  PluginLocalSessionRecord,
  PluginParsedAddress,
  PluginProbeResult,
  PluginServerInfo,
  PluginServerReach,
  PluginSessionAddress,
  PluginSessionInfo,
} from '../editor/plugin-api.js';
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
  PluginJumpTarget,
  PluginOutlineItem,
} from '../editor/plugin-api.js';
export type {
  PluginDocChangeEvent,
  PluginEventsApi,
  PluginFocusEvent,
  PluginSelectionEvent,
} from '../editor/plugin-api.js';
export type { PluginPanelApi, PluginPanelHandle } from '../editor/plugin-api.js';
export type { PluginMenuApi, PluginMenuItem, PluginMenuTarget } from '../editor/plugin-api.js';
export type {
  PluginAnnotateResult,
  PluginAnnotation,
  PluginAnnotationAction,
  PluginAnnotationColor,
  PluginAnnotationPart,
  PluginAnnotationSeverity,
  PluginAnnotationStyle,
  PluginAnnotationsApi,
} from '../editor/plugin-api.js';
export type { PluginFetchInit, PluginFetchResult, PluginNetApi } from '../editor/plugin-api.js';

// The one global a bundle calls to register (the desktop host installs
// it before loading plugins; feature-detect with `?.`). The registry
// declares the same member, so the two merge.
declare global {
  interface Window {
    __registerCardMirrorPlugin?: (def: RegistrationDefinition) => void;
  }
}
