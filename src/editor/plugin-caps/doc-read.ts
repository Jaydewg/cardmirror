/**
 * `doc.read` engine: a plain-JSON structural view of one document for
 * plugins. DOM-free; built from the same helpers the nav pane and word
 * count use, so a plugin sees the outline exactly as the user does.
 *
 * Mirrored content — live views (`self_ref`) and linked copies
 * (`transclusion_ref`) — is skipped, as `extractSelection` does: those
 * nodes repeat content that lives elsewhere, and reporting it would
 * double-count cards.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { collectCiteText, collectHeadings } from '../headings.js';
import { countCards, countReadAloudSplit, isHighlightedRead } from '../word-count.js';

export type PluginHeadingType = 'pocket' | 'hat' | 'block' | 'tag' | 'analytic';

export interface PluginOutlineItem {
  /** Stable heading id (targets `doc.insert({at: {after: id}})` and
   *  `jumpToSource`); null on a heading that has none yet. */
  id: string | null;
  type: PluginHeadingType;
  /** 1 pocket · 2 hat · 3 block · 4 tag / analytic. */
  level: number;
  text: string;
  /** Direct formatting of `text`; only with `read(…, { formatting: true })`. */
  formatting?: PluginTextSpan[];
}

export interface PluginCard {
  /** The id of the card's tag (or the unit's analytic). */
  headingId: string | null;
  /** `card` = tag + evidence; `analytic` = an analytic unit. */
  kind: 'card' | 'analytic';
  /** Tag / analytic text. */
  heading: string;
  /** Cite-formatted text (the short cite), '' when none. */
  cite: string;
  /** Full cite paragraphs, in order. */
  citeParagraphs: string[];
  /** Body paragraphs, in order (plain text). */
  body: string[];
  /** What the reader reads aloud in each body paragraph: one list per
   *  entry of `body`, in the same order, of `[start, end)` character
   *  offsets into that paragraph's text. A range covers highlighted text
   *  that isn't shaded (the read-aloud word count's rule); ranges are
   *  sorted, never overlap, and adjacent runs are merged. `[]` = nothing
   *  read. Absent on builds before it existed — feature-detect with
   *  `card.bodyRead !== undefined`. */
  bodyRead?: [number, number][][];
  undertags: string[];
  /** Direct formatting of every text part above, as span lists parallel
   *  to them; only with `read(…, { formatting: true })`. */
  formatting?: PluginCardFormatting;
}

/** Styles a `PluginTextSpan` can carry. A GROWING union: a newer build may
 *  report more, so ignore values you don't know. */
export type PluginTextStyle =
  | 'highlight'
  | 'shading'
  | 'underline'
  | 'emphasis'
  | 'cite'
  | 'bold'
  | 'italic';

/** One formatted stretch of a paragraph's text: `[from, to)` character
 *  offsets into that paragraph's plain text (the matching string in the
 *  snapshot). Spans of DIFFERENT styles overlap freely; spans of the same
 *  style (and color) never overlap and adjacent ones are merged. Sorted by
 *  `from`. Only direct formatting is reported — what a paragraph's own
 *  style implies (a tag is bold, a cite paragraph is small) is not. */
export interface PluginTextSpan {
  from: number;
  to: number;
  style: PluginTextStyle;
  /** `highlight`: Word's color name (`yellow`, `cyan`, `green`, `magenta`,
   *  `blue`, `red`, `darkBlue`, `darkCyan`, `darkGreen`, `darkMagenta`,
   *  `darkRed`, `darkYellow`, `darkGray`, `lightGray`, `black`; treat an
   *  unknown name as yellow). `shading`: `#rrggbb`. Absent otherwise. */
  color?: string;
}

/** Span lists for a card's parts, parallel to `PluginCard`'s fields. */
export interface PluginCardFormatting {
  heading: PluginTextSpan[];
  citeParagraphs: PluginTextSpan[][];
  body: PluginTextSpan[][];
  undertags: PluginTextSpan[][];
}

export interface PluginReadOptions {
  /** Add `formatting` to every outline item and card. Costs a pass over
   *  every text run, so ask only when you need it. */
  formatting?: boolean;
}

export interface PluginDocStats {
  cards: number;
  /** Read-aloud words: highlighted body vs tags/analytics/cites. */
  readAloudWords: { body: number; other: number };
}

export interface PluginDocStructure {
  outline: PluginOutlineItem[];
  cards: PluginCard[];
  stats: PluginDocStats;
}

const MIRRORED = new Set(['self_ref', 'transclusion_ref']);
const HEADING_TYPES = new Set<string>(['pocket', 'hat', 'block', 'tag', 'analytic']);

export function readDocStructure(doc: PMNode, opts?: PluginReadOptions): PluginDocStructure {
  const withFormatting = opts?.formatting === true;
  const outline: PluginOutlineItem[] = collectHeadings(doc, { skipCite: true })
    // zonePos != null ⇒ inside a linked copy (collectHeadings already
    // skips live views).
    .filter((e) => e.zonePos == null && HEADING_TYPES.has(e.type))
    .map((e) => {
      const item: PluginOutlineItem = {
        id: e.id,
        type: e.type as PluginHeadingType,
        level: e.level,
        text: e.text,
      };
      if (withFormatting) {
        const node = doc.nodeAt(e.pos);
        item.formatting = node && node.isTextblock ? textSpans(node) : [];
      }
      return item;
    });

  const cards: PluginCard[] = [];
  doc.descendants((node) => {
    const type = node.type.name;
    if (MIRRORED.has(type)) return false;
    if (type !== 'card' && type !== 'analytic_unit') return true;
    const head = node.firstChild;
    const card: PluginCard = {
      headingId: typeof head?.attrs['id'] === 'string' ? (head.attrs['id'] as string) : null,
      kind: type === 'card' ? 'card' : 'analytic',
      heading: head?.textContent ?? '',
      cite: collectCiteText(node),
      citeParagraphs: [],
      body: [],
      bodyRead: [],
      undertags: [],
    };
    const fmt: PluginCardFormatting | null = withFormatting
      ? { heading: head ? textSpans(head) : [], citeParagraphs: [], body: [], undertags: [] }
      : null;
    node.forEach((child, _offset, index) => {
      if (index === 0) return; // the heading
      const name = child.type.name;
      if (name === 'cite_paragraph') {
        card.citeParagraphs.push(child.textContent);
        fmt?.citeParagraphs.push(textSpans(child));
      } else if (name === 'card_body') {
        card.body.push(child.textContent);
        card.bodyRead!.push(readRanges(child));
        fmt?.body.push(textSpans(child));
      } else if (name === 'undertag') {
        card.undertags.push(child.textContent);
        fmt?.undertags.push(textSpans(child));
      }
    });
    if (fmt) card.formatting = fmt;
    cards.push(card);
    return false; // a card never nests another card
  });

  const words = countReadAloudSplit(doc);
  return {
    outline,
    cards,
    stats: { cards: countCards(doc), readAloudWords: { body: words.body, other: words.other } },
  };
}

/** `[start, end)` offsets (into `block.textContent`) of the read-aloud
 *  text in one textblock. Offsets count text-node characters only, which
 *  is exactly what `textContent` concatenates (no inline node in the
 *  schema has `leafText`). */
export function readRanges(block: PMNode): [number, number][] {
  const out: [number, number][] = [];
  let offset = 0;
  block.descendants((node) => {
    if (!node.isText) return true;
    const len = node.text?.length ?? 0;
    if (len > 0 && isHighlightedRead(node)) {
      const last = out[out.length - 1];
      if (last && last[1] === offset) last[1] = offset + len;
      else out.push([offset, offset + len]);
    }
    offset += len;
    return false;
  });
  return out;
}

/** The styles (with colors) one text run carries. */
function runStyles(node: PMNode): { style: PluginTextStyle; color?: string }[] {
  const out: { style: PluginTextStyle; color?: string }[] = [];
  for (const m of node.marks) {
    switch (m.type.name) {
      case 'highlight': {
        const color = String(m.attrs['color'] ?? 'yellow');
        if (color !== 'none') out.push({ style: 'highlight', color });
        break;
      }
      case 'shading': {
        const hex = String(m.attrs['color'] ?? 'D2D2D2').replace(/^#/, '').toLowerCase();
        out.push({ style: 'shading', color: `#${/^[0-9a-f]{6}$/.test(hex) ? hex : 'd2d2d2'}` });
        break;
      }
      case 'underline_mark':
      case 'underline_direct':
        if (!out.some((s) => s.style === 'underline')) out.push({ style: 'underline' });
        break;
      case 'emphasis_mark':
        out.push({ style: 'emphasis' });
        break;
      case 'cite_mark':
        out.push({ style: 'cite' });
        break;
      case 'bold':
        out.push({ style: 'bold' });
        break;
      case 'italic':
        out.push({ style: 'italic' });
        break;
    }
  }
  return out;
}

/** Formatting spans of one textblock, with offsets into its
 *  `textContent` (text-node characters only, as in `readRanges`). */
export function textSpans(block: PMNode): PluginTextSpan[] {
  const out: PluginTextSpan[] = [];
  /** Open span per style+color key, extendable while runs stay adjacent. */
  const open = new Map<string, PluginTextSpan>();
  let offset = 0;
  block.descendants((node) => {
    if (!node.isText) return true;
    const len = node.text?.length ?? 0;
    if (len === 0) return false;
    for (const s of runStyles(node)) {
      const key = s.color ? `${s.style}|${s.color}` : s.style;
      const prev = open.get(key);
      if (prev && prev.to === offset) {
        prev.to = offset + len;
      } else {
        const span: PluginTextSpan =
          s.color ? { from: offset, to: offset + len, style: s.style, color: s.color }
                  : { from: offset, to: offset + len, style: s.style };
        out.push(span);
        open.set(key, span);
      }
    }
    offset += len;
    return false;
  });
  // Pushed in order of first appearance, so already sorted by `from`;
  // stable-sort anyway to keep the documented order independent of that.
  return out.sort((a, b) => a.from - b.from);
}
