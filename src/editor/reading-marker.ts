/**
 * Reading-position marker.
 *
 * A red "Marked h:mm" run you drop at the cursor (Verbatim's red-text
 * convention) to find your place when you stop mid-card. It's a normal
 * editing action — bound to a rebindable shortcut and usable any time —
 * but it shines in read mode, where the keyboard is otherwise locked: there
 * Space, Enter, or the bound shortcut all drop one (see `read-mode-plugin`).
 *
 * Triggering it again while the cursor is on an existing marker removes that
 * marker (toggle). The marker is red text (the `font_color` mark at `FF0000`
 * carrying `role: 'marker'`), so it round-trips to Word like any other
 * colored run, and read mode keeps red text visible so the marker shows in
 * the mode that drops it. A card holds at most one: dropping a marker
 * removes any others in that card, so a second tap on the fresh marker
 * leaves the card clean — the way out of a card that is "secretly" marked.
 *
 * What counts as a marker, and the load-time normalization that keeps
 * stray red text from counting, live in schema/reading-marker.ts.
 */

import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { closeHistory } from 'prosemirror-history';
import { schema } from '../schema/index.js';
import {
  READING_MARKER_COLOR,
  READING_MARKER_ROLE,
  isMarkerText,
  readingMarkerRangesIn,
} from '../schema/reading-marker.js';

export {
  READING_MARKER_COLOR,
  READING_MARKER_ROLE,
  READING_MARKER_TEXT_RE,
  isReadingMarkerColor,
  isMarkerText,
  isMarkerNode,
  isReadingMarker,
  containsReadingMarker,
  normalizeReadingMarkers,
  readingMarkerNodeText,
  readingMarkerRangesIn,
} from '../schema/reading-marker.js';

/** Transaction meta flag marking a transaction as the reading-marker edit,
 *  so read mode's `filterTransaction` lets it through (the one edit read
 *  mode allows). */
export const READING_MARKER_META = 'readingMarker';

/** Meta flag on the undo/redo transactions read mode permits — those
 *  bounded to only reverse marker edits (see `read-mode-plugin`). Also
 *  passes `filterTransaction`. */
export const READ_MODE_UNDO_META = 'readModeUndo';

/** Meta flag on drag-move / dropzone / receive-pill insertions. These are
 *  position-validated by the drag controller, so read mode lets them through
 *  too — moving and shelf-inserting cards is safe even while reading. */
export const READ_MODE_DRAG_META = 'readModeDragEdit';

/** Format the marker's clock time as `h:mm` (12-hour, no leading zero on the
 *  hour, no meridiem) — e.g. `7:32`. Exported for testing. */
export function formatMarkerTime(d: Date): string {
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** If the cursor sits on (inside, or at either edge of) an existing
 *  reading-marker run, return that run's span — expanded over any adjacent
 *  marker text nodes. Otherwise null. Exported for testing. */
export function readingMarkerRunAt(state: EditorState): { from: number; to: number } | null {
  const $h = state.selection.$head;
  const parent = $h.parent;
  if (!parent.isTextblock) return null;
  const start = $h.start();
  const items: { from: number; to: number; marker: boolean }[] = [];
  parent.forEach((child, offset) => {
    items.push({ from: start + offset, to: start + offset + child.nodeSize, marker: isMarkerText(child) });
  });
  let idx = items.findIndex((it) => it.marker && $h.pos >= it.from && $h.pos <= it.to);
  if (idx < 0) return null;
  let from = items[idx]!.from;
  let to = items[idx]!.to;
  for (let i = idx - 1; i >= 0 && items[i]!.marker; i--) from = items[i]!.from;
  for (let i = idx + 1; i < items.length && items[i]!.marker; i++) to = items[i]!.to;
  return { from, to };
}

/** The stretch a marker "owns": its card or analytic unit (a card holds at
 *  most one marker), or, outside any card, just the cursor's paragraph. */
export function readingMarkerScopeAt(state: EditorState): { from: number; to: number } {
  const $h = state.selection.$head;
  for (let d = $h.depth; d > 0; d--) {
    const name = $h.node(d).type.name;
    if (name === 'card' || name === 'analytic_unit') return { from: $h.start(d), to: $h.end(d) };
  }
  return { from: $h.start(), to: $h.end() };
}

/** Build (don't dispatch) the transaction that inserts a red "Marked h:mm"
 *  marker at the cursor and places the caret after it — removing any other
 *  marker in the same card first, so a card never carries two. Returns null
 *  if the schema lacks `font_color`. Exported for testing. */
export function buildInsertReadingMarkerTransaction(
  state: EditorState,
  now: Date = new Date(),
): Transaction | null {
  const fontColor = schema.marks['font_color'];
  if (!fontColor) return null;
  const text = `Marked ${formatMarkerTime(now)}`;
  const node = schema.text(text, [
    fontColor.create({ color: READING_MARKER_COLOR, role: READING_MARKER_ROLE }),
  ]);
  const head = state.selection.head;
  const tr = state.tr;
  // Other markers in this card go first (back to front, so each range is
  // still where we found it); the cursor isn't on one — that's the toggle
  // branch — so mapping it through the deletions is exact.
  const scope = readingMarkerScopeAt(state);
  const others = readingMarkerRangesIn(state.doc, scope.from, scope.to);
  for (let i = others.length - 1; i >= 0; i--) tr.delete(others[i]!.from, others[i]!.to);
  const pos = tr.mapping.map(head);
  tr.insert(pos, node);
  tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize));
  // Don't let the (inclusive) red mark bleed into whatever's typed next.
  tr.removeStoredMark(fontColor);
  tr.setMeta(READING_MARKER_META, true);
  // Each marker is its own undo step — never grouped with a nearby edit
  // (which would make undo revert that edit too).
  closeHistory(tr);
  return tr.scrollIntoView();
}

/** Build the toggle transaction: remove the marker the cursor is on, or
 *  insert a new one at the cursor. Null only if `font_color` is missing.
 *  Exported for testing. */
export function buildToggleReadingMarkerTransaction(
  state: EditorState,
  now: Date = new Date(),
): Transaction | null {
  const run = readingMarkerRunAt(state);
  if (run) {
    const tr = state.tr.delete(run.from, run.to).setMeta(READING_MARKER_META, true);
    // Its own undo step (same reason as the insert path) — so undoing a
    // toggle-off reverses only that, never a nearby edit.
    closeHistory(tr);
    return tr.scrollIntoView();
  }
  return buildInsertReadingMarkerTransaction(state, now);
}

/** PM command form — toggle a reading-position marker at the cursor. Bound
 *  to the rebindable `toggleReadingMarker` ribbon command. */
export const toggleReadingMarkerCommand: Command = (state, dispatch) => {
  const tr = buildToggleReadingMarkerTransaction(state);
  if (!tr) return false;
  if (dispatch) dispatch(tr);
  return true;
};

/** View form — used by the read-mode keydown handler, where keymaps are
 *  dead but `handleDOMEvents` still fires. Programmatic dispatch isn't
 *  gated by `editable: false`, so this works while read mode is locked. */
export function toggleReadingMarker(view: EditorView, now: Date = new Date()): boolean {
  const tr = buildToggleReadingMarkerTransaction(view.state, now);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}
