/**
 * Reading-position marker — the schema-level half.
 *
 * A marker is the red run `Marked h:mm` the marker command drops where you
 * stopped reading (Verbatim's red-text convention; see
 * editor/reading-marker.ts for the command itself). What makes a run a
 * marker is NOT its color — plenty of red text is just red text (Verbatim
 * files, hand-colored body, the "unread after a marker" red that a `.docx`
 * export bakes in) — but the `role: 'marker'` attr on its `font_color`
 * mark. Builds before that attr drop it on load and see plain red text,
 * which is exactly how they treated markers anyway.
 *
 * `reading_marker` is the marker as a first-class inline ATOM node. It is
 * DORMANT: the schema knows it (so a file that carries one opens here),
 * the exporter writes it as a red run, the detectors count it — but
 * nothing creates one yet. Once the fleet has this schema, the command can
 * switch to inserting the node and markers delete/arrow-over as a unit.
 *
 * `normalizeReadingMarkers` runs on every doc that comes off disk (native
 * load, `.docx` import): legacy red `Marked h:mm` text becomes a marker,
 * and anything carrying the role that no longer reads as a marker (typed
 * into, half deleted) loses it — so a card is "marked" only while a real
 * marker sits in it.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';

/** Verbatim red — the marker's text color, and the signal read mode uses
 *  to keep the marker visible. Hex without `#` (OOXML / `font_color`). */
export const READING_MARKER_COLOR = 'FF0000';

/** `font_color.role` value on a marker run. */
export const READING_MARKER_ROLE = 'marker';

/** The exact text the marker command writes (`formatMarkerTime`: 12-hour,
 *  no leading zero). A role-bearing run that reads otherwise is a mangled
 *  marker and loses the role at load. */
export const READING_MARKER_TEXT_RE = /^Marked \d{1,2}:\d{2}$/;
const READING_MARKER_SCAN_RE = /Marked \d{1,2}:\d{2}/g;

/** True when a `font_color` value is the reading-marker red. */
export function isReadingMarkerColor(color: string | undefined | null): boolean {
  return (color ?? '').toUpperCase() === READING_MARKER_COLOR;
}

type MarkLike = { type: { name: string }; attrs: Record<string, unknown> };
type NodeLike = { isText: boolean; marks: readonly MarkLike[]; type: { name: string } };

/** True when a text node is a reading-position marker run (`font_color`
 *  carrying the marker role — the color alone never counts). */
export function isMarkerText(node: NodeLike): boolean {
  return (
    node.isText &&
    node.marks.some((m) => m.type.name === 'font_color' && m.attrs['role'] === READING_MARKER_ROLE)
  );
}

/** True for the (dormant) `reading_marker` atom. */
export function isMarkerNode(node: { type: { name: string } }): boolean {
  return node.type.name === 'reading_marker';
}

/** Either form of marker. */
export function isReadingMarker(node: NodeLike): boolean {
  return isMarkerText(node) || isMarkerNode(node);
}

/** The text a `reading_marker` node stands for — the same `Marked h:mm`
 *  the text form writes, so exports and plain-text readers agree. Mirrors
 *  the node's `toDOM` in nodes.ts (which can't import this module). */
export function readingMarkerNodeText(node: { attrs: Record<string, unknown> }): string {
  return `Marked ${String(node.attrs['time'] ?? '')}`;
}

/** Every marker (text run or node) between `from` and `to`, in doc order. */
export function readingMarkerRangesIn(
  doc: PMNode,
  from: number,
  to: number,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (isReadingMarker(node)) out.push({ from: pos, to: pos + node.nodeSize });
    return !node.isText && !node.isAtom;
  });
  return out;
}

/** True iff a marker (either form) sits anywhere in `node`'s subtree. */
export function containsReadingMarker(node: PMNode): boolean {
  let found = false;
  node.descendants((n) => {
    if (found) return false;
    if (isReadingMarker(n)) found = true;
    return !found;
  });
  return found;
}

/**
 * Put the marker role exactly where a marker is and nowhere else:
 *
 *  - a red run with no role whose text contains `Marked h:mm` (a file from
 *    before the role existed, a `.docx` round-trip, a marker that merged
 *    into baked unread red) gets the role on just that span;
 *  - a role-bearing run that no longer reads as exactly `Marked h:mm`
 *    (typed into, half deleted) loses the role — any intact `Marked h:mm`
 *    inside it keeps it.
 *
 * Pure; returns the same node when nothing needs fixing. Color is never
 * touched — red text stays red, it just stops counting as a marker.
 */
export function normalizeReadingMarkers(doc: PMNode): PMNode {
  const fontColor = doc.type.schema.marks['font_color'];
  if (!fontColor) return doc;
  const fixes: { from: number; to: number; color: string; role: string | null }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const fc = node.marks.find((m) => m.type.name === 'font_color');
    if (!fc) return false;
    const color = String(fc.attrs['color'] ?? '000000');
    const hasRole = fc.attrs['role'] === READING_MARKER_ROLE;
    if (!hasRole && !isReadingMarkerColor(color)) return false;
    if (hasRole && READING_MARKER_TEXT_RE.test(node.text)) return false; // already right
    if (hasRole) fixes.push({ from: pos, to: pos + node.nodeSize, color, role: null });
    for (const m of node.text.matchAll(READING_MARKER_SCAN_RE)) {
      const at = pos + (m.index ?? 0);
      fixes.push({ from: at, to: at + m[0].length, color, role: READING_MARKER_ROLE });
    }
    return false;
  });
  if (fixes.length === 0) return doc;
  // addMark of the same type replaces the run's font_color (it excludes
  // itself), and marks never move positions — apply in order, no mapping.
  const tr = new Transform(doc);
  for (const f of fixes) tr.addMark(f.from, f.to, fontColor.create({ color: f.color, role: f.role }));
  return tr.doc;
}
