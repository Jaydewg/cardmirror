/**
 * Alphabetize a set of outline sections in place.
 *
 * The nav pane's multi-selection is a set of headings at one outline
 * level; each owns a SECTION (the heading plus everything under it, the
 * unit a nav drag moves — `computeHeadingRange`). Alphabetizing sorts
 * those sections by heading text and writes them back into the SLOTS the
 * selected sections occupied, in document order: unselected sections
 * never move, and a discontinuous selection stays discontinuous. Slots
 * are positional, so a selection spanning two blocks can carry a card
 * from one block into the other if that is where its order falls.
 *
 * One transaction, so one undo step; heading ids travel with their nodes,
 * so links, live views and numbering restarts survive.
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

export interface SectionSlot {
  from: number;
  to: number;
  /** The sort key: the heading's text. */
  text: string;
}

/** Case-insensitive, numeric-aware ("Card 2" before "Card 10"), accent-
 *  insensitive. Stable: equal keys keep document order. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareHeadingText(a: string, b: string): number {
  return collator.compare(a.trim(), b.trim());
}

/**
 * Apply the alphabetized order of `slots` to `tr`. Slots must be disjoint
 * (sections at one outline level never nest); any order is accepted.
 * Returns false (and leaves `tr` untouched) when there is nothing to do:
 * fewer than two slots, or they are already in order.
 */
export function alphabetizeSlots(tr: Transaction, slots: readonly SectionSlot[]): boolean {
  if (slots.length < 2) return false;
  const byPos = [...slots].sort((a, b) => a.from - b.from);
  for (let i = 1; i < byPos.length; i++) {
    if (byPos[i]!.from < byPos[i - 1]!.to) throw new Error('alphabetizeSlots: overlapping slots');
  }
  const sorted = [...byPos].sort((a, b) => compareHeadingText(a.text, b.text) || a.from - b.from);
  if (sorted.every((s, i) => s === byPos[i])) return false;
  const doc: PMNode = tr.doc;
  const contents = sorted.map((s) => doc.slice(s.from, s.to));
  // Back to front: each replacement only shifts positions after it, so
  // every earlier slot is still where the original document had it.
  for (let i = byPos.length - 1; i >= 0; i--) {
    const slot = byPos[i]!;
    if (sorted[i] === slot) continue;
    tr.replace(slot.from, slot.to, contents[i]!);
  }
  return true;
}
