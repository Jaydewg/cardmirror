/**
 * Autosave policy shared by the single-doc and multi-pane layouts.
 *
 * `.cmir` autosaves ~5s after the last edit. `.docx` autosaves too, but
 * only once the user has stopped editing for a while (or leaves the
 * window): `toDocx` is expensive enough that a 5s cadence would stutter
 * typing on large debate files, so a longer idle window keeps the cost
 * out of active editing.
 *
 * Word can't hold live views / linked copies — a `.docx` write flattens
 * them. Manual Save asks first (`confirmDocxDropsLiveLinks`); autosave
 * can't, so a `.docx` doc with live links doesn't autosave at all, and
 * the user is told why in a modal (turning autosave on, or creating the
 * first live link while it's on) rather than only by the button state.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { isSelfRef } from './self-transclusion.js';
import { isTransclusionNode } from './transclusion.js';
import { promptForRouteChoice } from './text-prompt.js';

export type AutosaveFormat = 'cmir' | 'docx' | null;

/** `.cmir`: debounce after the last doc-changing edit. */
export const AUTOSAVE_DELAY_MS = 5000;
/** `.docx`: idle window after the last edit before the (expensive)
 *  Word serialize runs. Window blur / hide flushes it sooner. */
export const DOCX_AUTOSAVE_IDLE_MS = 30_000;

export function autosaveDelayFor(format: AutosaveFormat): number {
  return format === 'docx' ? DOCX_AUTOSAVE_IDLE_MS : AUTOSAVE_DELAY_MS;
}

/** Live views (`self_ref`) + linked copies (`transclusion_ref`) in `doc`.
 *  The schema only admits both at the doc's top level (and inside each
 *  other, which isn't a separately-droppable link), so a top-level scan
 *  counts exactly what a `.docx` write would flatten — cheap enough to
 *  run per transaction. */
export function liveLinkCounts(doc: PMNode | null | undefined): { views: number; copies: number } {
  const counts = { views: 0, copies: 0 };
  doc?.forEach((node) => {
    if (isSelfRef(node)) counts.views++;
    else if (isTransclusionNode(node)) counts.copies++;
  });
  return counts;
}

export function hasLiveLinks(doc: PMNode | null | undefined): boolean {
  let found = false;
  doc?.forEach((node) => {
    if (!found && (isSelfRef(node) || isTransclusionNode(node))) found = true;
  });
  return found;
}

/** True when an edit took `doc` from no live links to some — the moment a
 *  `.docx` doc's autosave stops working. Later links change nothing, so
 *  they don't re-trigger the explanation. */
export function liveLinksAppeared(prev: PMNode, next: PMNode): boolean {
  return !hasLiveLinks(prev) && hasLiveLinks(next);
}

export type AutosaveEffect =
  /** Autosave will write this doc. */
  | 'effective'
  /** Never saved — no file to write to yet. */
  | 'unsaved'
  /** `.docx` with live views / linked copies — a write would flatten them. */
  | 'docx-live-links';

/** Whether autosave (when on) actually protects a doc. */
export function autosaveEffect(file: { format: AutosaveFormat; handle: unknown; doc: PMNode | null | undefined }): AutosaveEffect {
  if (!file.handle || !file.format) return 'unsaved';
  if (file.format === 'docx' && hasLiveLinks(file.doc)) return 'docx-live-links';
  return 'effective';
}

/** Whether closing a dirty doc should save it silently instead of asking.
 *  Only when autosave is on AND would itself have written the doc: an
 *  unsaved doc needs a location, a `.docx` with live links needs the
 *  flatten decision, and a recovered draft needs the stale-overwrite
 *  check — those all keep the normal prompt. */
export function shouldSaveOnClose(opts: {
  autosaveOn: boolean;
  inPlaceSupported: boolean;
  recoveredDraft: boolean;
  format: AutosaveFormat;
  handle: unknown;
  doc: PMNode | null | undefined;
}): boolean {
  if (!opts.autosaveOn || !opts.inPlaceSupported || opts.recoveredDraft) return false;
  return autosaveEffect(opts) === 'effective';
}

function describeLinks(counts: { views: number; copies: number }): string {
  const parts: string[] = [];
  if (counts.views > 0) parts.push(counts.views === 1 ? 'a live view' : `${counts.views} live views`);
  if (counts.copies > 0) parts.push(counts.copies === 1 ? 'a linked copy' : `${counts.copies} linked copies`);
  return parts.join(' and ') || 'live links';
}

const WHY =
  'Word (.docx) files can’t hold live links. Saving to .docx turns them into plain cards, ' +
  'and the link to the source is gone for good when the .docx is reopened. Autosave never makes ' +
  'that decision for you, so it won’t save this document while it has live links. ' +
  'Save it as CardMirror (.cmir) to keep the links and autosave.';

/** Modal: the user is turning autosave ON for a `.docx` doc that has live
 *  links. Resolves 'saveAsCmir' or null (leave autosave off). */
export function explainAutosaveBlockedOnToggle(counts: { views: number; copies: number }): Promise<'saveAsCmir' | null> {
  return promptForRouteChoice<'saveAsCmir'>({
    message: 'Autosave can’t save this Word document',
    detail: `This document contains ${describeLinks(counts)}. ${WHY}`,
    choices: [
      {
        value: 'saveAsCmir',
        label: 'Save as .cmir…',
        description: 'Keep the live links; autosave turns on for the .cmir file.',
      },
    ],
    cancelLabel: 'Leave autosave off',
  });
}

/** Modal: the user just created the first live view / linked copy in a
 *  `.docx` doc with autosave on. Resolves the chosen action, or null to
 *  keep the link (autosave stays on but doesn't save until it's gone). */
export function explainAutosaveBlockedOnCreate(
  counts: { views: number; copies: number },
): Promise<'saveAsCmir' | 'undo' | 'turnOff' | null> {
  return promptForRouteChoice<'saveAsCmir' | 'undo' | 'turnOff'>({
    message: 'Autosave has stopped for this Word document',
    detail: `You just added ${describeLinks(counts)}. ${WHY}`,
    choices: [
      {
        value: 'saveAsCmir',
        label: 'Save as .cmir…',
        description: 'Keep the live link; autosave keeps working in the .cmir file.',
      },
      {
        value: 'undo',
        label: 'Undo the link',
        description: 'Remove it again; autosave carries on saving the .docx.',
      },
      {
        value: 'turnOff',
        label: 'Turn autosave off',
        description: 'Keep the link and save by hand (Save asks before flattening it).',
      },
    ],
    cancelLabel: 'Keep the link',
  });
}
