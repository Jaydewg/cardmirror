/** `doc.annotate` → `api.annotations`: display-only marks on document
 *  text (squiggles, underlines, tints), like spellcheck's. The engine is
 *  src/editor/plugin-annotations.ts. */
import {
  ANNOTATE_PERMISSION,
  clearPluginAnnotations,
  setPluginAnnotations,
  type PluginAnnotateResult,
  type PluginAnnotation,
} from '../plugin-annotations.js';
import { targetView, type CapabilityContext } from './context.js';

export type {
  PluginAnnotateResult,
  PluginAnnotation,
  PluginAnnotationAction,
  PluginAnnotationColor,
  PluginAnnotationPart,
  PluginAnnotationSeverity,
  PluginAnnotationStyle,
} from '../plugin-annotations.js';

/** `doc.annotate` permission. Marks are never saved, synced or undoable;
 *  they map through edits until the next `set`, and vanish when the
 *  permission is revoked. Every call targets the focused doc unless
 *  `docUid` names another open one. */
export interface PluginAnnotationsApi {
  /** Replace ALL of this plugin's marks in the doc with `items` (≤ 2000).
   *  Anchors that don't resolve (heading gone, no such paragraph, match
   *  not found) are skipped and counted in `unplaced`. `hidden`: the
   *  user hid this plugin's marks in that document for the session. */
  set(items: PluginAnnotation[], opts?: { docUid?: string }): PluginAnnotateResult;
  /** Remove all of this plugin's marks from the doc. */
  clear(opts?: { docUid?: string }): void;
}

export function buildAnnotationsApi(ctx: CapabilityContext): PluginAnnotationsApi | undefined {
  if (!ctx.granted.has(ANNOTATE_PERMISSION)) return undefined;
  const { deps, pluginId } = ctx;
  const docUidOf = (opts: unknown): string | undefined => {
    const o = opts && typeof opts === 'object' ? (opts as { docUid?: unknown }) : {};
    return o.docUid != null ? String(o.docUid) : undefined;
  };
  return Object.freeze({
    set(items: PluginAnnotation[], opts?: { docUid?: string }): PluginAnnotateResult {
      const hit = targetView(deps, docUidOf(opts));
      if (!hit) return { ok: false, error: 'no-doc' };
      return setPluginAnnotations(hit.view, hit.uid, pluginId, ctx.name || pluginId, items);
    },
    clear(opts?: { docUid?: string }): void {
      const hit = targetView(deps, docUidOf(opts));
      if (hit) clearPluginAnnotations(hit.view, pluginId);
    },
  });
}
