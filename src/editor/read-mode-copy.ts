/**
 * Copy from read mode copies what read mode shows.
 *
 * Read mode hides the unread body (and undertags, loose paragraphs,
 * images…) with decorations and CSS — the document underneath is whole,
 * so a plain copy took the whole card. With `readModeCopyVisible` on (the
 * default), a copy made while a view is in read mode is first reduced to
 * the audible content, by the same rules the display and *Convert Cards
 * to Read Mode* use (`isReadModeKeptText`, `convertCard`), so the
 * clipboard matches the screen. Both copy paths run through it: the
 * editor's own copy (`transformCopied`) and the command-built copies in
 * clipboard-slice.ts (outline Copy, discontinuous copy, Copy Current
 * Heading).
 *
 * Slices stay valid for pasting: a WHOLE card in the slice converts
 * exactly like Convert Cards to Read Mode; a card the selection cuts
 * into (an open slice) is filtered child by child with its structure
 * kept, so the open depths still describe it, and the depths are clamped
 * if a hidden node on the open path had to go. Returns follow "Read mode:
 * preserve paragraph integrity" exactly as the display does — off, a
 * card's bodies flow into one paragraph; on, each keeps its line.
 * Per-view: the other panes of a multi-doc workspace copy normally.
 */

import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { readModePlugin } from './read-mode-plugin.js';
import { AudibleInlineBuilder, convertCard } from './convert-cards-to-read-mode.js';
import { settings } from './settings.js';

/** Doc-level nodes read mode shows at all (style.css `pmd-read-mode`:
 *  everything else at doc level is `display: none`). */
const DOC_LEVEL_VISIBLE = new Set(['pocket', 'hat', 'block', 'card', 'analytic_unit', 'transclusion_ref']);
/** Textblocks whose text read mode always shows. */
const HEADINGS = new Set(['tag', 'analytic', 'pocket', 'hat', 'block']);

/** True when a copy from `view` should be reduced to read mode's content. */
export function isReadModeCopyActive(view: EditorView): boolean {
  return !!readModePlugin.getState(view.state)?.on && settings.get('readModeCopyVisible');
}

/** A heading with its images dropped (read mode hides images). */
function headingWithoutImages(node: PMNode): PMNode {
  const kept: PMNode[] = [];
  node.forEach((child) => {
    if (child.type.name !== 'image') kept.push(child);
  });
  return kept.length === node.childCount ? node : node.type.create(node.attrs, kept, node.marks);
}

/** A textblock reduced to its audible runs (separator spaces included),
 *  or null when nothing in it is audible and it may go. */
function audibleTextblock(node: PMNode, mustKeep: boolean, prev: PMNode | null): PMNode | null {
  const builder = new AudibleInlineBuilder();
  builder.addTextblock(node, prev);
  if (builder.nodes.length === 0 && !mustKeep) return null;
  return node.type.create(node.attrs, builder.nodes, node.marks);
}

/**
 * The children of a card / analytic unit the selection cuts into, each
 * reduced — the same shape `convertCard` gives a whole card, including
 * the paragraph rule: with "Read mode: preserve paragraph integrity" OFF
 * (read mode's default flow) consecutive body paragraphs join into one,
 * so the copy carries no returns the screen doesn't show; ON, each body
 * with audible text keeps its own line. Nodes on the slice's open path
 * (`onStart` / `onEnd` for this container) must survive, emptied if need
 * be, so the open depths keep meaning something.
 */
function convertContainerChildren(
  node: PMNode,
  depth: number,
  onStart: boolean,
  onEnd: boolean,
  openStart: number,
  openEnd: number,
): Fragment {
  const schema = node.type.schema;
  const separate = settings.get('readModeParagraphIntegrity');
  const out: PMNode[] = [];
  let body = new AudibleInlineBuilder();
  let bodyMustKeep = false;
  const flushBody = (): void => {
    if (body.nodes.length > 0 || bodyMustKeep) out.push(schema.nodes['card_body']!.create(null, body.nodes));
    body = new AudibleInlineBuilder();
    bodyMustKeep = false;
  };
  const addBodyParagraph = (para: PMNode, mustKeep: boolean, prev: PMNode | null): void => {
    if (!separate) {
      body.addTextblock(para, prev);
      bodyMustKeep = bodyMustKeep || mustKeep;
      return;
    }
    flushBody();
    const kept = audibleTextblock(para, mustKeep, prev);
    if (kept) out.push(kept.type.name === 'card_body' ? kept : schema.nodes['card_body']!.create(null, kept.content));
  };

  const last = node.childCount - 1;
  node.forEach((child, _offset, i) => {
    const childOnStart = onStart && i === 0 && openStart > depth;
    const childOnEnd = onEnd && i === last && openEnd > depth;
    const mustKeep = childOnStart || childOnEnd;
    const name = child.type.name;
    // The previous sibling WITHIN the slice: a cut copy only knows what
    // it carries, so a cite whose tag was left out of the selection is
    // judged without it (and so can't be a bold cite) — the same text
    // the screen shows for that cut, since the tag isn't in the copy.
    const prev = node.maybeChild(i - 1) ?? null;
    if (HEADINGS.has(name)) {
      flushBody();
      out.push(headingWithoutImages(child));
    } else if (name === 'cite_paragraph' || name === 'undertag') {
      flushBody();
      const kept = audibleTextblock(child, mustKeep, prev);
      if (kept) out.push(kept);
    } else if (name === 'card_body' || name === 'paragraph') {
      addBodyParagraph(child, mustKeep, prev);
    } else if (name === 'table' && !mustKeep) {
      // Read mode shows a table's paragraphs as body text (convertCard too).
      child.descendants((d) => {
        if (d.type.name !== 'paragraph') return true;
        addBodyParagraph(d, false, null);
        return false;
      });
    } else {
      flushBody();
      out.push(child); // a table on the open path, or an unknown block: leave it
    }
  });
  flushBody();
  return Fragment.from(out);
}

/**
 * The children of a doc-level container (the slice itself, or a
 * transclusion zone), each reduced. `depth` is the children's depth in
 * the slice; `parentOnStart` / `parentOnEnd` say whether the container
 * lies on the slice's open start / end path, so its first / last child
 * may too.
 */
function convertChildren(
  frag: Fragment,
  depth: number,
  parentOnStart: boolean,
  parentOnEnd: boolean,
  openStart: number,
  openEnd: number,
): Fragment {
  const out: PMNode[] = [];
  const last = frag.childCount - 1;
  frag.forEach((child, _offset, i) => {
    const onStart = parentOnStart && i === 0 && openStart > depth;
    const onEnd = parentOnEnd && i === last && openEnd > depth;
    const mustKeep = onStart || onEnd;
    const name = child.type.name;

    if (child.isInline) {
      out.push(child); // defensive: doc-level content is block-level
    } else if (!DOC_LEVEL_VISIBLE.has(name)) {
      // Hidden at doc level (a loose paragraph, a table, an image row…).
      if (mustKeep && child.isTextblock) out.push(child.type.create(child.attrs, undefined, child.marks));
    } else if (HEADINGS.has(name)) {
      out.push(headingWithoutImages(child));
    } else if (name === 'card' && !mustKeep) {
      out.push(convertCard(child)); // a whole card: exactly the zap
    } else if (name === 'card' || name === 'analytic_unit') {
      const children = convertContainerChildren(child, depth + 1, onStart, onEnd, openStart, openEnd);
      if (children.childCount > 0 || mustKeep) out.push(child.type.create(child.attrs, children, child.marks));
    } else {
      // transclusion_ref: a zone of cards — same rules as the doc level.
      const children = convertChildren(child.content, depth + 1, onStart, onEnd, openStart, openEnd);
      if (children.childCount > 0 || mustKeep) out.push(child.type.create(child.attrs, children, child.marks));
    }
  });
  return Fragment.from(out);
}

/** How deep the first/last-child chain of `frag` can be open. */
function maxOpen(frag: Fragment, side: 'start' | 'end'): number {
  let depth = 0;
  let node = side === 'start' ? frag.firstChild : frag.lastChild;
  while (node && !node.isLeaf && !node.isTextblock) {
    depth++;
    node = side === 'start' ? node.firstChild : node.lastChild;
  }
  if (node && node.isTextblock) depth++;
  return depth;
}

/**
 * The slice reduced to what read mode shows. `inlineParent` is the
 * textblock an inline-only slice was cut from (a range inside one
 * paragraph taken with `doc.slice(from, to)`, which carries no parents)
 * — the keep rule depends on the paragraph kind, so without it inline
 * content passes through untouched.
 */
export function readModeVisibleSlice(slice: Slice, inlineParent?: PMNode | null): Slice {
  const first = slice.content.firstChild;
  if (!first) return slice;
  if (first.isInline) {
    if (!inlineParent) return slice;
    const shell = inlineParent.type.create(inlineParent.attrs, slice.content, inlineParent.marks);
    const kept = HEADINGS.has(inlineParent.type.name) ? headingWithoutImages(shell) : audibleTextblock(shell, true, null)!;
    return new Slice(kept.content, 0, 0);
  }
  const content = convertChildren(slice.content, 0, true, true, slice.openStart, slice.openEnd);
  return new Slice(
    content,
    Math.min(slice.openStart, maxOpen(content, 'start')),
    Math.min(slice.openEnd, maxOpen(content, 'end')),
  );
}

/** The textblock an inline-only range of `doc` sits in, or null when the
 *  range spans blocks (its slice then carries the parents itself). */
export function inlineParentOf(doc: PMNode, from: number, to: number): PMNode | null {
  const $from = doc.resolve(from);
  return $from.parent.isTextblock && $from.sameParent(doc.resolve(to)) ? $from.parent : null;
}

/** `transformCopied` hook: a copy from a read-mode view carries only what
 *  read mode shows. Registered alongside the live-view flattening hook;
 *  ProseMirror runs every `transformCopied` in turn. */
export function readModeCopyPlugin(): Plugin {
  return new Plugin({
    props: {
      transformCopied(slice, view) {
        return isReadModeCopyActive(view) ? readModeVisibleSlice(slice) : slice;
      },
    },
  });
}
