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
import { countCards, countReadAloudSplit } from '../word-count.js';

export type PluginHeadingType = 'pocket' | 'hat' | 'block' | 'tag' | 'analytic';

export interface PluginOutlineItem {
  /** Stable heading id (targets `doc.insert({at: {after: id}})` and
   *  `jumpToSource`); null on a heading that has none yet. */
  id: string | null;
  type: PluginHeadingType;
  /** 1 pocket · 2 hat · 3 block · 4 tag / analytic. */
  level: number;
  text: string;
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
  undertags: string[];
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

export function readDocStructure(doc: PMNode): PluginDocStructure {
  const outline: PluginOutlineItem[] = collectHeadings(doc, { skipCite: true })
    // zonePos != null ⇒ inside a linked copy (collectHeadings already
    // skips live views).
    .filter((e) => e.zonePos == null && HEADING_TYPES.has(e.type))
    .map((e) => ({ id: e.id, type: e.type as PluginHeadingType, level: e.level, text: e.text }));

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
      undertags: [],
    };
    node.forEach((child, _offset, index) => {
      if (index === 0) return; // the heading
      const name = child.type.name;
      if (name === 'cite_paragraph') card.citeParagraphs.push(child.textContent);
      else if (name === 'card_body') card.body.push(child.textContent);
      else if (name === 'undertag') card.undertags.push(child.textContent);
    });
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
