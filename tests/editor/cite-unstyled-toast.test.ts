// @vitest-environment jsdom
/**
 * A cite that ends up with no `cite_mark` must never be silent — it
 * reads as body text to shrink and the cite style. Both the "tokens
 * listed but none located" and the "no tokens listed at all" replies
 * toast, with wording that says which happened.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { applyCiteToSelection, buildCiteTransaction, citeLeftUnstyled } from '../../src/editor/ai/cite-creator.js';
import { showToast } from '../../src/editor/toast.js';

const RAW = 'Smith, John. 2024. Some Article.';
function view(): EditorView {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['card_body']!.create(null, schema.text(RAW)),
    ]),
  ]);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state: EditorState.create({ doc }) });
}
const from = (v: EditorView) => v.state.doc.firstChild!.child(0).nodeSize + 2;

describe('unstyled-cite toast', () => {
  beforeEach(() => vi.mocked(showToast).mockClear());

  it('no tokens in the reply → toast saying the AI named none', () => {
    const v = view();
    applyCiteToSelection(v, from(v), from(v) + RAW.length, { cite: 'Smith 24 — John Smith', tokens: [] });
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast).mock.calls[0]![0]).toMatch(/named no author\/date/);
  });

  it('tokens that cannot be located → the existing locate toast', () => {
    const v = view();
    applyCiteToSelection(v, from(v), from(v) + RAW.length, { cite: 'Smith 24 — John Smith', tokens: ['Jones 99'] });
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast).mock.calls[0]![0]).toMatch(/couldn’t be located/);
  });

  it('a located token → no toast', () => {
    const v = view();
    applyCiteToSelection(v, from(v), from(v) + RAW.length, { cite: 'Smith 24 — John Smith', tokens: ['Smith 24'] });
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });

  it('citeLeftUnstyled mirrors the three cases', () => {
    const v = view();
    const build = (tokens: string[]) => buildCiteTransaction(v.state, from(v), from(v) + RAW.length, { cite: 'Smith 24 — John Smith', tokens })!;
    expect(citeLeftUnstyled({ cite: '', tokens: [] }, build([]))).toBe(true);
    expect(citeLeftUnstyled({ cite: '', tokens: ['Jones 99'] }, build(['Jones 99']))).toBe(true);
    expect(citeLeftUnstyled({ cite: '', tokens: ['Smith 24'] }, build(['Smith 24']))).toBe(false);
  });
});
