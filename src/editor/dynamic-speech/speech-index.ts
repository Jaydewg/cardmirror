/**
 * Dynamic speech: where the speaker is, in words. "Read so far" and
 * "still to read" are the read-aloud counts before / after a position,
 * minus whatever has been skipped or clipped. Both ride the per-doc
 * suffix table in live-read-time.ts, so a lookup is never O(doc).
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { Mapping } from 'prosemirror-transform';
import { countReadAloudSplit, type ReadAloudCounts } from '../word-count.js';
import { countBefore, countRemaining, countWholeDocCached } from '../live-read-time.js';

export interface ExcludedRange {
  from: number;
  to: number;
  counts: ReadAloudCounts;
}

const ZERO: ReadAloudCounts = { body: 0, other: 0 };

function sub(a: ReadAloudCounts, b: ReadAloudCounts): ReadAloudCounts {
  return { body: Math.max(0, a.body - b.body), other: Math.max(0, a.other - b.other) };
}
function add(a: ReadAloudCounts, b: ReadAloudCounts): ReadAloudCounts {
  return { body: a.body + b.body, other: a.other + b.other };
}

/** Build the doc's suffix table ahead of the first keypress. */
export function warmSpeechIndex(doc: PMNode): void {
  countWholeDocCached(doc);
}

/** Add [from, to) to the excluded set, merging overlaps. Returns a new,
 *  sorted list; the input is untouched (the undo stack keeps it). */
export function addExcluded(doc: PMNode, list: readonly ExcludedRange[], from: number, to: number): ExcludedRange[] {
  if (to <= from) return [...list];
  let lo = from, hi = to;
  const keep: ExcludedRange[] = [];
  for (const r of list) {
    if (r.to < lo || r.from > hi) keep.push(r);
    else { lo = Math.min(lo, r.from); hi = Math.max(hi, r.to); }
  }
  keep.push({ from: lo, to: hi, counts: countReadAloudSplit(doc, lo, hi) });
  return keep.sort((a, b) => a.from - b.from);
}

/** Map the ranges through a doc change; counts are redone only for
 *  ranges the change touched. Ranges that collapse are dropped. */
export function mapExcluded(list: readonly ExcludedRange[], mapping: Mapping, doc: PMNode): ExcludedRange[] {
  const out: ExcludedRange[] = [];
  for (const r of list) {
    const from = mapping.map(r.from, 1);
    const to = mapping.map(r.to, -1);
    if (to <= from) continue;
    const moved = to - from !== r.to - r.from;
    out.push({ from, to, counts: moved ? countReadAloudSplit(doc, from, to) : r.counts });
  }
  return out;
}

/** The part of the excluded ranges lying before `pos`. */
function excludedBefore(doc: PMNode, pos: number, list: readonly ExcludedRange[]): ReadAloudCounts {
  let total = ZERO;
  for (const r of list) {
    if (r.from >= pos) break;
    total = add(total, r.to <= pos ? r.counts : countReadAloudSplit(doc, r.from, pos));
  }
  return total;
}

function excludedTotal(list: readonly ExcludedRange[]): ReadAloudCounts {
  return list.reduce((t, r) => add(t, r.counts), ZERO);
}

export function wordsRead(doc: PMNode, pos: number, list: readonly ExcludedRange[]): ReadAloudCounts {
  return sub(countBefore(doc, pos), excludedBefore(doc, pos, list));
}

export function wordsRemaining(doc: PMNode, pos: number, list: readonly ExcludedRange[]): ReadAloudCounts {
  const after = sub(excludedTotal(list), excludedBefore(doc, pos, list));
  return sub(countRemaining(doc, pos), after);
}
