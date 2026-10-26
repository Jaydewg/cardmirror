/**
 * Forward-only insert snapping ("Insert at cursor: headings go after the
 * current section"): a doc-level object lands at the first valid outline
 * slot at or after the caret instead of the nearest in either direction.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { insertAtCursorPos, nearestValidInsertPos } from '../../src/editor/insert-position.js';
import { settings } from '../../src/editor/settings.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const hat = (t: string) => schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text(t));
const block = (t: string) => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.create(null, Fragment.fromArray(k));
const doc = (...k: PMNode[]) => schema.nodes['doc']!.create(null, Fragment.fromArray(k));

const posOf = (d: PMNode, t: string, off = 0): number => {
  let p = -1;
  d.descendants((n, pos) => {
    if (p === -1 && n.isText && n.text === t) p = pos + off;
    return p === -1;
  });
  if (p < 0) throw new Error(`not found: ${t}`);
  return p;
};
/** Start position of the top-level child with index `i`. */
const startOf = (d: PMNode, i: number): number => {
  let p = 0;
  for (let k = 0; k < i; k++) p += d.child(k).nodeSize;
  return p;
};

// F5 one > F6 a > F6 b > F6 c, then F5 two > F6 d
const d = doc(
  hat('Hat one'), block('Block a'), card(tag('Card a1'), body('a1 body')), block('Block b'), block('Block c'),
  hat('Hat two'), block('Block d'),
);
const newHat = Fragment.from(hat('Incoming hat'));
const newCard = Fragment.from(card(tag('Incoming'), body('x')));

afterEach(() => settings.set('insertHeadingsAfterSection', false));

describe('forward snapping', () => {
  it('nearest (default): an F5 from the top of a hat section goes ABOVE that hat', () => {
    const caret = posOf(d, 'Block a', 2);
    expect(nearestValidInsertPos(d, caret, newHat)).toBe(startOf(d, 0));
  });

  it('forward: the same F5 goes after the end of the section (before Hat two)', () => {
    const caret = posOf(d, 'Block a', 2);
    expect(nearestValidInsertPos(d, caret, newHat, { forward: true })).toBe(startOf(d, 5));
  });

  it('forward from the last section falls back to the doc end', () => {
    const caret = posOf(d, 'Block d', 1);
    expect(nearestValidInsertPos(d, caret, newHat, { forward: true })).toBe(d.content.size);
  });

  it('forward: a card from inside a card goes after that card, never above it', () => {
    const caret = posOf(d, 'Card a1', 1); // in the tag, near the card's top
    expect(nearestValidInsertPos(d, caret, newCard)).toBe(startOf(d, 2)); // nearest: above
    expect(nearestValidInsertPos(d, caret, newCard, { forward: true })).toBe(startOf(d, 3));
  });

  it('a caret exactly on a heading boundary keeps that slot in forward mode', () => {
    const caret = startOf(d, 5);
    expect(nearestValidInsertPos(d, caret, newHat, { forward: true })).toBe(caret);
  });

  it('inline content is unaffected by forward mode', () => {
    const caret = posOf(d, 'a1 body', 3);
    expect(nearestValidInsertPos(d, caret, Fragment.from(schema.text('hi')), { forward: true })).toBe(caret);
  });

  it('insertAtCursorPos reads the setting', () => {
    const caret = posOf(d, 'Block a', 2);
    expect(insertAtCursorPos(d, caret, newHat)).toBe(startOf(d, 0));
    settings.set('insertHeadingsAfterSection', true);
    expect(insertAtCursorPos(d, caret, newHat)).toBe(startOf(d, 5));
  });
});
