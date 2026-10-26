// @vitest-environment jsdom
/**
 * Read mode swallows bare editing keys at the DOM level.
 *
 * The view stays EDITABLE in read mode (both layouts since 2026-07-27
 * — the caret must be placeable and Space/Enter drop reading markers),
 * with `filterTransaction` as the edit lock. But a browser-level
 * mutation still costs a parse-reject-redraw round trip and trips
 * ProseMirror's once-per-session checkCSS warning (single-pane read
 * mode deliberately resets white-space to `normal`). The plugin's
 * keydown handler must therefore preventDefault bare typing keys while
 * letting chords, navigation, and F-keys through.
 */

import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import type { Plugin } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';

function mkView(readMode: boolean, before: Plugin[] = []): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['card_body']!.create(null, schema.text('body words here')),
    ]),
  ]);
  const view = new EditorView(el, {
    state: EditorState.create({ doc, plugins: [...before, readModePlugin] }),
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)));
  if (readMode) view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  return view;
}

/** Dispatch a keydown on the view DOM; returns the event for
 *  defaultPrevented inspection. */
function press(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  view.dom.dispatchEvent(evt);
  return evt;
}

describe('read mode DOM-level key swallow', () => {
  it('bare typing keys are prevented (no browser mutation possible)', () => {
    const view = mkView(true);
    expect(press(view, { key: 'a' }).defaultPrevented).toBe(true);
    expect(press(view, { key: 'A', shiftKey: true }).defaultPrevented).toBe(true);
    expect(press(view, { key: 'Backspace' }).defaultPrevented).toBe(true);
    expect(press(view, { key: 'Delete' }).defaultPrevented).toBe(true);
    expect(press(view, { key: 'Enter' }).defaultPrevented).toBe(true);
    view.destroy();
  });

  it('chords, navigation, and F-keys pass through', () => {
    const view = mkView(true);
    expect(press(view, { key: 'c', metaKey: true }).defaultPrevented).toBe(false); // copy
    expect(press(view, { key: 'ArrowDown' }).defaultPrevented).toBe(false);
    expect(press(view, { key: 'PageDown' }).defaultPrevented).toBe(false);
    expect(press(view, { key: 'F7' }).defaultPrevented).toBe(false);
    view.destroy();
  });

  it('outside read mode nothing is swallowed', () => {
    const view = mkView(false);
    expect(press(view, { key: 'a' }).defaultPrevented).toBe(false);
    view.destroy();
  });
});

describe('bound bare keys still work in read mode', () => {
  it("a keymap registered before read mode gets a bare key first (Send to Speech's backtick)", () => {
    let runs = 0;
    const view = mkView(true, [keymap({ '`': () => { runs++; return true; } })]);
    const evt = press(view, { key: '`' });
    expect(runs).toBe(1);
    expect(evt.defaultPrevented).toBe(true); // handled, so no browser mutation either
    // An unbound bare key is still swallowed, not typed.
    expect(press(view, { key: 'a' }).defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('Tagbody words here');
    view.destroy();
  });

  it('bare Enter still drops a reading marker even when an editing keymap binds Enter', () => {
    let enterRuns = 0;
    const view = mkView(true, [keymap({ Enter: () => { enterRuns++; return true; } })]);
    press(view, { key: 'Enter' });
    expect(enterRuns).toBe(0); // the marker claimed it at the DOM level first
    expect(view.state.doc.textContent).toMatch(/Marked \d{1,2}:\d{2}/);
    view.destroy();
  });

  it('a bound editing command on a bare key is still a no-op on the document', () => {
    const view = mkView(true, [
      keymap({ x: (state, dispatch) => { dispatch?.(state.tr.insertText('X')); return true; } }),
    ]);
    expect(press(view, { key: 'x' }).defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('Tagbody words here'); // filterTransaction held
    view.destroy();
  });
});
