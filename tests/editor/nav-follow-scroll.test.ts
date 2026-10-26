// @vitest-environment jsdom

/**
 * `navFollowScroll` (PR #109): scrolling the editor re-lights the nav
 * pane on the section at the top of the viewport once the caret has
 * scrolled out of sight. It is highlight-only — whether the PANE scrolls
 * to show the lit row stays `navFollowCursor`'s decision, the same switch
 * every other highlight change honors. The merge dropped the PR's
 * unconditional pane scroll for that reason; these pin both halves.
 *
 * jsdom has no layout, so the editor geometry the feature reads
 * (`coordsAtPos`, `posAtCoords`, the editor's bounding box) is stubbed
 * per test, and the list geometry is stubbed the same way
 * nav-follow-cursor.test.ts does so a pane scroll, when due, is a
 * visible `scrollTop` write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { settings } from '../../src/editor/settings.js';

const ROW_H = 20;
const VIEWPORT_H = 40;

const node = (name: string, attrs: Record<string, unknown> | null, content?: PMNode | PMNode[]): PMNode =>
  schema.nodes[name]!.create(attrs, content);
const heading = (name: string, text: string): PMNode =>
  node(name, { id: newHeadingId() }, schema.text(text));
const card = (tagText: string, bodyText: string): PMNode =>
  node('card', null, [heading('tag', tagText), node('card_body', null, schema.text(bodyText))]);

function makeDoc(): PMNode {
  return node('doc', null, [
    heading('pocket', 'Pocket'),
    heading('block', 'Block one'),
    card('Tag one', 'body one'),
    card('Tag two', 'body two'),
    heading('block', 'Block two'),
    card('Tag three', 'body three'),
    heading('block', 'Block three'),
    card('Tag four', 'body four'),
  ]);
}

function inCardBody(doc: PMNode, n: number): number {
  let seen = 0;
  let found = -1;
  doc.descendants((child, pos) => {
    if (child.type.name !== 'card_body') return true;
    seen++;
    if (seen === n && found < 0) found = pos + 1;
    return false;
  });
  return found;
}

function stubListGeometry(listEl: HTMLElement): number[] {
  Object.defineProperty(HTMLLIElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLLIElement) {
      const parent = this.parentElement;
      return parent ? Array.prototype.indexOf.call(parent.children, this) * ROW_H : 0;
    },
  });
  Object.defineProperty(HTMLLIElement.prototype, 'offsetHeight', { configurable: true, get: () => ROW_H });
  Object.defineProperty(listEl, 'clientHeight', { configurable: true, get: () => VIEWPORT_H });
  Object.defineProperty(listEl, 'scrollHeight', {
    configurable: true,
    get: () => listEl.children.length * ROW_H,
  });
  const writes: number[] = [];
  let value = 0;
  Object.defineProperty(listEl, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      writes.push(v);
      value = v;
    },
  });
  return writes;
}

interface Harness {
  panel: NavigationPanel;
  view: EditorView;
  scroller: HTMLElement;
  writes: number[];
  highlighted(): string | null;
  /** Where the editor believes the caret is drawn (viewport px). */
  caretAt(top: number): void;
  /** What `posAtCoords` resolves at the top of the viewport. */
  topShows(pos: number): void;
  scroll(): void;
}

const open: Harness[] = [];

function setup(): Harness {
  const scroller = document.createElement('div');
  const host = document.createElement('div');
  scroller.appendChild(host);
  document.body.appendChild(scroller);
  const view = new EditorView(host, { state: EditorState.create({ doc: makeDoc() }) });
  // Editor box fills a 0–600 viewport; the scroller is the same box.
  const box = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) };
  scroller.getBoundingClientRect = () => box as DOMRect;
  view.dom.getBoundingClientRect = () => box as DOMRect;
  let caretTop = 100;
  let topPos = 1;
  view.coordsAtPos = () => ({ top: caretTop, bottom: caretTop + 20, left: 10, right: 11 });
  view.posAtCoords = () => ({ pos: topPos, inside: topPos });

  const panel = new NavigationPanel(document.createElement('div'));
  panel.attach(view);
  const listEl = (panel as unknown as { listEl: HTMLElement }).listEl;
  const writes = stubListGeometry(listEl);
  const h: Harness = {
    panel,
    view,
    scroller,
    writes,
    highlighted: () => listEl.querySelector('.pmd-nav-item-selected')?.textContent ?? null,
    caretAt: (top) => {
      caretTop = top;
    },
    topShows: (pos) => {
      topPos = pos;
    },
    scroll: () => scroller.dispatchEvent(new Event('scroll', { bubbles: false })),
  };
  open.push(h);
  return h;
}

function putCursor(h: Harness, pos: number): void {
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, pos)));
  h.panel.setCaretHeading(h.view.state.selection.from);
}

beforeEach(() => {
  // The feature coalesces per frame; run the frame synchronously.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  settings.set('navMaxLevel', 4); // every row rendered
  settings.set('navFollowCursor', false);
  settings.set('navFollowScroll', true);
});

afterEach(() => {
  for (const h of open.splice(0)) {
    h.panel.destroy();
    h.view.destroy();
    h.scroller.remove();
  }
  delete (HTMLLIElement.prototype as unknown as Record<string, unknown>)['offsetTop'];
  delete (HTMLLIElement.prototype as unknown as Record<string, unknown>)['offsetHeight'];
  settings.set('navFollowCursor', false);
  settings.set('navFollowScroll', false);
  vi.unstubAllGlobals();
});

describe('navFollowScroll highlight', () => {
  it('lights the section at the top of the viewport once the caret is off screen', () => {
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    expect(h.highlighted()).toContain('Tag one');
    h.caretAt(-500); // scrolled away above
    h.topShows(inCardBody(h.view.state.doc, 4));
    h.scroll();
    expect(h.highlighted()).toContain('Tag four');
  });

  it("keeps the caret's section while the caret is still on screen", () => {
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    h.caretAt(300); // visible
    h.topShows(inCardBody(h.view.state.doc, 4));
    h.scroll();
    expect(h.highlighted()).toContain('Tag one');
  });

  it('does nothing with the setting off', () => {
    settings.set('navFollowScroll', false);
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    h.caretAt(-500);
    h.topShows(inCardBody(h.view.state.doc, 4));
    h.scroll();
    expect(h.highlighted()).toContain('Tag one');
  });

  it('ignores scrolls of elements that do not contain the editor', () => {
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    h.caretAt(-500);
    h.topShows(inCardBody(h.view.state.doc, 4));
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.dispatchEvent(new Event('scroll'));
    other.remove();
    expect(h.highlighted()).toContain('Tag one');
  });
});

describe('navFollowScroll and the pane itself', () => {
  it('does not scroll the pane when navFollowCursor is off (the merge fixup)', () => {
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    h.writes.length = 0;
    h.caretAt(-500);
    h.topShows(inCardBody(h.view.state.doc, 4)); // row 8, far below the 0–40 viewport
    h.scroll();
    expect(h.highlighted()).toContain('Tag four');
    expect(h.writes).toEqual([]);
  });

  it('scrolls the pane to the lit row when navFollowCursor is on', () => {
    settings.set('navFollowCursor', true);
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    h.writes.length = 0;
    h.caretAt(-500);
    h.topShows(inCardBody(h.view.state.doc, 4));
    h.scroll();
    expect(h.highlighted()).toContain('Tag four');
    expect(h.writes).toEqual([8 * ROW_H - VIEWPORT_H]);
  });

  it('stops listening after destroy', () => {
    const h = setup();
    putCursor(h, inCardBody(h.view.state.doc, 1));
    h.caretAt(-500);
    h.topShows(inCardBody(h.view.state.doc, 4));
    h.panel.destroy();
    expect(() => h.scroll()).not.toThrow();
  });
});
