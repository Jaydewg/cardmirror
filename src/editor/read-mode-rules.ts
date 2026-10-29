/**
 * Read mode's per-paragraph keep rules — the pure part, shared by the
 * display plugin (read-mode-plugin.ts), the destructive conversions
 * (convert-cards-to-read-mode.ts, read-mode-copy.ts) and the read-mode
 * DOCX export (export/transform-for-export.ts), so every surface that
 * answers "what does read mode show?" answers it the same way. No
 * prosemirror-view here: the export runs without a view.
 *
 * A paragraph's kept marks depend on its TYPE and, for the bold-cite
 * rule, on its PREVIOUS SIBLING and its own contents — which is why
 * callers pass the sibling rather than just the paragraph.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { settings } from './settings.js';

/** Textblocks whose text read mode always shows (headings / structural
 *  labels — no rm-keep/hide decoration; block-level CSS shows them). */
export const READ_MODE_HEADING_BLOCKS = new Set(['tag', 'analytic', 'pocket', 'hat', 'block']);

/** Marks whose text a cite paragraph reads aloud: the cite mark, and —
 *  since 1.0 — highlights too, so a highlighted phrase inside a cite no
 *  longer vanishes in read mode (field find, 2026-08-14). */
export const CITE_KEPT_MARKS: readonly string[] = ['cite_mark', 'highlight'];
export const BODY_KEPT_MARKS: readonly string[] = ['highlight'];

const UNDERLINE_FAMILY = new Set(['underline_mark', 'underline_direct', 'emphasis_mark']);

/**
 * "Read mode: treat bold as a cite" (on by default). Catches the common
 * import failure where a cite was styled by hand as BOLD plain text
 * instead of the Cite character style, so read mode hid the author and
 * date the reader expected to see. A paragraph qualifies when:
 *
 *   1. it immediately follows a tag or an undertag (the cite's slot),
 *   2. it is a cite paragraph or a card body (not a table),
 *   3. nothing in it is underlined or emphasized — a paragraph with
 *      real read-aloud styling is evidence body, not a hand-bolded cite,
 *   4. some of its text is bold, and
 *   5. for a card body, some bold text contains a digit (a date, a page,
 *      a year) — the one cheap signal that bold here is a citation and
 *      not a bolded statistic. A cite paragraph already says "cite" by
 *      its style, so it skips this test.
 *
 * In a qualifying paragraph the bold runs are read aloud (kept) exactly
 * as cite-marked runs would be. Everything else about the paragraph is
 * unchanged: highlights still show, plain filler still hides, and "keep
 * entire cite" treats a bold run as the run that unlocks the whole cite.
 */
export function isBoldCiteParagraph(para: PMNode, prev: PMNode | null | undefined): boolean {
  if (!settings.get('readModeBoldCites')) return false;
  if (!prev || (prev.type.name !== 'tag' && prev.type.name !== 'undertag')) return false;
  const name = para.type.name;
  if (name !== 'cite_paragraph' && name !== 'card_body') return false;
  let anyBold = false;
  let boldDigit = false;
  let underlineFamily = false;
  para.forEach((child) => {
    if (!child.isText || !child.text) return;
    let bold = false;
    for (const m of child.marks) {
      if (UNDERLINE_FAMILY.has(m.type.name)) underlineFamily = true;
      if (m.type.name === 'bold') bold = true;
    }
    if (bold) {
      anyBold = true;
      if (/\p{N}/u.test(child.text)) boldDigit = true;
    }
  });
  if (underlineFamily || !anyBold) return false;
  return name === 'cite_paragraph' || boldDigit;
}

/** The read-aloud marks a textblock is filtered by, `'heading'` if its
 *  text is always shown, or null if it isn't read-mode content. `prev` is
 *  the textblock's previous sibling in its container (null at the start
 *  or when unknown), consulted by the bold-cite rule. */
export function readKeptMarks(
  para: PMNode,
  prev: PMNode | null | undefined,
): readonly string[] | 'heading' | null {
  const name = para.type.name;
  if (READ_MODE_HEADING_BLOCKS.has(name)) return 'heading';
  let base: readonly string[];
  if (name === 'cite_paragraph') base = CITE_KEPT_MARKS;
  else if (name === 'card_body' || name === 'paragraph' || name === 'undertag') base = BODY_KEPT_MARKS;
  else return null;
  return isBoldCiteParagraph(para, prev) ? [...base, 'bold'] : base;
}
