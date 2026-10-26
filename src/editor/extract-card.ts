/**
 * Extract Card.
 *
 * Mid-read, a passage inside a long card turns out to deserve a card of
 * its own. With body text selected, the command builds a new card — a
 * copy of the source card's tag (fresh heading id), copies of its cite
 * line(s), then the selected text — and inserts it directly after the
 * source card. The source is untouched (the text is COPIED, not moved),
 * the selection and caret stay where they were, and nothing scrolls; a
 * toast is the only cue. Analytic units work the same way with the
 * analytic line standing in for the tag.
 *
 * Scope: the selection must be non-empty and lie entirely within
 * card_body paragraphs of ONE card / analytic unit. Reaching into the
 * tag, a cite, an undertag, a table or a neighbouring card refuses
 * rather than guessing. Read mode refuses outright.
 */

import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { newHeadingId } from '../schema/ids.js';
import { readModePlugin } from './read-mode-plugin.js';
import { showToast } from './toast.js';

const CONTAINER_TYPES = new Set(['card', 'analytic_unit']);

/** The transaction Extract Card would dispatch, or null when the
 *  selection is not extractable (see the module comment). Pure; exported
 *  for tests and for callers that want to compose it. */
export function buildExtractCardTransaction(state: EditorState): Transaction | null {
  const sel = state.selection;
  if (sel.empty) return null;
  const $from = sel.$from;
  const $to = sel.$to;
  if ($from.depth < 2 || $to.depth < 2) return null;
  const container = $from.node(1);
  if (!CONTAINER_TYPES.has(container.type.name)) return null;
  // Same container at both ends.
  if ($to.before(1) !== $from.before(1)) return null;

  const containerStart = $from.before(1);
  const heading = container.firstChild;
  if (!heading) return null;
  const cites: PMNode[] = [];
  const bodies: PMNode[] = [];
  let childStart = containerStart + 1;
  let valid = true;
  container.forEach((child) => {
    const childEnd = childStart + child.nodeSize;
    if (child.type.name === 'cite_paragraph') cites.push(child.copy(child.content));
    // Children overlapping the selection must all be body paragraphs.
    const overlaps = childStart < sel.to && childEnd > sel.from;
    if (overlaps) {
      if (child.type.name !== 'card_body') {
        valid = false;
      } else {
        const contentStart = childStart + 1;
        const a = Math.max(0, sel.from - contentStart);
        const b = Math.min(child.content.size, sel.to - contentStart);
        if (b > a) bodies.push(child.type.create(child.attrs, child.content.cut(a, b)));
      }
    }
    childStart = childEnd;
  });
  if (!valid || bodies.length === 0) return null;

  const newHeading = heading.type.create({ ...heading.attrs, id: newHeadingId() }, heading.content, heading.marks);
  // Numbering: keep the role (a numbered card's extract is numbered
  // too) but never a restart — the copy continues the sequence.
  const attrs = 'numRestart' in container.attrs ? { ...container.attrs, numRestart: false } : container.attrs;
  const extracted = container.type.createChecked(attrs, [newHeading, ...cites, ...bodies]);

  const tr = state.tr.insert($from.after(1), extracted);
  // The insertion sits after every selected position, so the mapped
  // selection is the original one; set it explicitly so a later
  // `scrollIntoView` is never implied and the caret cannot drift.
  tr.setSelection(sel.map(tr.doc, tr.mapping));
  return tr;
}

/** Ribbon command. False (no-op) in read mode and whenever the
 *  selection is not extractable. */
export function extractCard(): Command {
  return (state, dispatch) => {
    if (readModePlugin.getState(state)?.on) return false;
    const tr = buildExtractCardTransaction(state);
    if (!tr) return false;
    if (dispatch) {
      dispatch(tr);
      const what = state.selection.$from.node(1).type.name === 'analytic_unit' ? 'analytic' : 'card';
      showToast(`Extracted to a new ${what} below.`, { durationMs: 2200 });
    }
    return true;
  };
}
