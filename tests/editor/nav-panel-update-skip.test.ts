// @vitest-environment jsdom

/**
 * `update()` skips the outline rebuild when no row changed (typing in a
 * card body), but the kept rows must still point at current positions,
 * and a heading edit must still re-render.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';

function setup() {
  const doc = schema.nodes['doc']!.create(
    null,
    ['First', 'Second'].map((t) =>
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t)),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ]),
    ),
  );
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc }) });
  const root = document.createElement('div');
  const panel = new NavigationPanel(root);
  panel.attach(view);
  panel.update(view.state.doc);
  const rows = () => [...root.querySelectorAll<HTMLLIElement>('li.pmd-nav-item')];
  return { view, panel, rows };
}

describe('NavigationPanel.update skip', () => {
  it('a body edit keeps the rows and shifts their positions', () => {
    const { view, panel, rows } = setup();
    const before = rows();
    const secondPos = Number(before[1]!.dataset['pos']);
    // Type into the FIRST card's body (after "First" tag: 1 + 7 + 1 + 1).
    view.dispatch(view.state.tr.insertText('xyz', 10));
    panel.update(view.state.doc);
    const after = rows();
    expect(after[1]).toBe(before[1]); // same element: no rebuild
    expect(Number(after[1]!.dataset['pos'])).toBe(secondPos + 3);
    expect(view.state.doc.nodeAt(Number(after[1]!.dataset['pos']))?.textContent).toBe('Second');
    panel.destroy();
    view.destroy();
  });

  it('a heading edit re-renders the row text', () => {
    const { view, panel, rows } = setup();
    view.dispatch(view.state.tr.insertText('!', 7)); // end of "First"
    panel.update(view.state.doc);
    expect(rows()[0]!.querySelector('.pmd-nav-label')?.textContent).toBe('First!');
    panel.destroy();
    view.destroy();
  });
});
