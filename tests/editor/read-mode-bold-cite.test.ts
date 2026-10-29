// @vitest-environment jsdom
/**
 * "Read mode: treat bold as a cite" (readModeBoldCites, default on).
 *
 * A paragraph right after a tag / undertag with no underline or emphasis
 * anywhere and some bold text shows its bold runs in read mode, as if
 * they were cite-marked — a cite paragraph on bold alone, a card body only
 * when the bold includes a digit. The display plugin, Convert Cards to
 * Read Mode and the read-mode export all agree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE, isReadModeKeptText } from '../../src/editor/read-mode-plugin.js';
import { isBoldCiteParagraph, readKeptMarks } from '../../src/editor/read-mode-rules.js';
import { convertCard } from '../../src/editor/convert-cards-to-read-mode.js';
import { transformForExport } from '../../src/export/transform-for-export.js';
import { settings } from '../../src/editor/settings.js';

const B = () => schema.marks['bold']!.create();
const U = () => schema.marks['underline_mark']!.create();
const E = () => schema.marks['emphasis_mark']!.create();
const C = () => schema.marks['cite_mark']!.create();
const HL = () => schema.marks['highlight']!.create({ color: 'yellow' });

const tag = (t = 'Tag') => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const undertag = (...c: PMNode[]) => schema.nodes['undertag']!.create(null, c);
const cite = (...c: PMNode[]) => schema.nodes['cite_paragraph']!.create(null, c);
const body = (...c: PMNode[]) => schema.nodes['card_body']!.create(null, c);
const card = (...c: PMNode[]) => schema.nodes['card']!.createChecked(null, c);
const docOf = (...c: PMNode[]) => schema.nodes['doc']!.createChecked(null, c);
const t = (s: string, ...m: ReturnType<typeof B>[]) => schema.text(s, m);

const open: EditorView[] = [];
function readModeView(doc: PMNode): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc, plugins: [readModePlugin] }) });
  view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  open.push(view);
  return view;
}
function classOf(view: EditorView, needle: string): string | null {
  for (const el of view.dom.querySelectorAll('.pmd-rm-keep, .pmd-rm-hide')) {
    if (el.textContent?.includes(needle)) return el.classList.contains('pmd-rm-keep') ? 'keep' : 'hide';
  }
  return null;
}

afterEach(() => {
  for (const v of open.splice(0)) v.destroy();
  settings.set('readModeBoldCites', true);
  settings.set('readModeKeepEntireCite', false);
});

describe('isBoldCiteParagraph / readKeptMarks', () => {
  it('a bold cite paragraph after a tag qualifies on bold alone', () => {
    const p = cite(t('Smith', B()), t(', professor of things'));
    expect(isBoldCiteParagraph(p, tag())).toBe(true);
    expect(readKeptMarks(p, tag())).toEqual(['cite_mark', 'highlight', 'bold']);
  });

  it('a card body after a tag needs a digit in the bold', () => {
    expect(isBoldCiteParagraph(body(t('Smith 2024', B()), t(' writes')), tag())).toBe(true);
    expect(isBoldCiteParagraph(body(t('Smith', B()), t(' writes')), tag())).toBe(false);
    expect(readKeptMarks(body(t('Smith', B())), tag())).toEqual(['highlight']);
  });

  it('after an undertag counts too; after a body or with no sibling does not', () => {
    const p = cite(t('Smith 24', B()));
    expect(isBoldCiteParagraph(p, undertag(t('under')))).toBe(true);
    expect(isBoldCiteParagraph(p, body(t('x')))).toBe(false);
    expect(isBoldCiteParagraph(p, null)).toBe(false);
  });

  it('any underline or emphasis in the paragraph disqualifies it', () => {
    expect(isBoldCiteParagraph(cite(t('Smith 24', B()), t(' said', U())), tag())).toBe(false);
    expect(isBoldCiteParagraph(cite(t('Smith 24', B()), t(' said', E())), tag())).toBe(false);
  });

  it('no bold, or a table, or the setting off → not a bold cite', () => {
    expect(isBoldCiteParagraph(cite(t('Smith 24')), tag())).toBe(false);
    settings.set('readModeBoldCites', false);
    expect(isBoldCiteParagraph(cite(t('Smith 24', B())), tag())).toBe(false);
  });

  it('isReadModeKeptText follows it when given the sibling, and not without', () => {
    const p = cite(t('Smith 24', B()), t(' filler'));
    expect(isReadModeKeptText(p.child(0), p, tag())).toBe(true);
    expect(isReadModeKeptText(p.child(1), p, tag())).toBe(false);
    expect(isReadModeKeptText(p.child(0), p)).toBe(false);
  });
});

describe('display plugin', () => {
  it('shows the bold runs of a hand-bolded cite and still hides its plain filler', () => {
    const view = readModeView(docOf(card(tag(), cite(t('Smith 2024', B()), t(', an expert, writes')), body(t('body')))));
    expect(classOf(view, 'Smith 2024')).toBe('keep');
    expect(classOf(view, 'an expert')).toBe('hide');
    expect(classOf(view, 'body')).toBe('hide');
  });

  it('shows a bold cite typed into a body paragraph when the bold has a digit', () => {
    const view = readModeView(docOf(card(tag(), body(t('Smith 2024', B()), t(' explains')), body(t('rest')))));
    expect(classOf(view, 'Smith 2024')).toBe('keep');
    expect(classOf(view, 'explains')).toBe('hide');
  });

  it('a bolded statistic in a body (no digit-free bold, but underlined text present) stays hidden', () => {
    const view = readModeView(docOf(card(tag(), body(t('40%', B()), t(' of states ', U()), t('agree')))));
    expect(classOf(view, '40%')).toBe('hide');
  });

  it('a second paragraph after the cite is not in the cite slot', () => {
    const view = readModeView(docOf(card(tag(), cite(t('Real', C())), body(t('Bold 2024', B()), t(' body')))));
    expect(classOf(view, 'Bold 2024')).toBe('hide');
  });

  it('the setting off restores the old behavior', () => {
    settings.set('readModeBoldCites', false);
    const view = readModeView(docOf(card(tag(), cite(t('Smith 2024', B()), t(' filler')))));
    expect(classOf(view, 'Smith 2024')).toBe('hide');
  });

  it('"keep entire cite" treats the bold run as the run that unlocks the whole cite', () => {
    settings.set('readModeKeepEntireCite', true);
    const view = readModeView(docOf(card(tag(), cite(t('Smith 2024', B()), t(', an expert')))));
    expect(classOf(view, 'an expert')).toBe('keep');
  });

  it('highlights inside a bold cite still show; a real cite is unaffected', () => {
    const view = readModeView(
      docOf(card(tag(), cite(t('Smith 2024', B()), t(' key phrase', HL()), t(' tail')), body(t('b')))),
    );
    expect(classOf(view, 'key phrase')).toBe('keep');
    expect(classOf(view, 'tail')).toBe('hide');
  });
});

describe('Convert Cards to Read Mode and export agree with the display', () => {
  it('convertCard keeps the bold cite runs', () => {
    const c = card(tag(), cite(t('Smith 2024', B()), t(', an expert')), body(t('plain '), t('read', HL())));
    const out = convertCard(c);
    expect(out.child(1).type.name).toBe('cite_paragraph');
    expect(out.child(1).textContent).toBe('Smith 2024');
    expect(out.child(2).textContent).toBe('read');
  });

  it('convertCard drops a bold body cite without a digit, like the display', () => {
    const c = card(tag(), body(t('Smith', B()), t(' writes')), body(t('read', HL())));
    const out = convertCard(c);
    expect(out.textContent).toBe('Tagread');
  });

  it('read-mode export keeps the bold cite', () => {
    const doc = docOf(card(tag(), cite(t('Smith 2024', B()), t(', an expert')), body(t('plain '), t('read', HL()))));
    const out = transformForExport(doc, { includeComments: false, includeAnalytics: false, includeUndertags: false, readMode: true });
    const c = out.firstChild!;
    expect(c.child(1).type.name).toBe('cite_paragraph');
    expect(c.child(1).textContent).toBe('Smith 2024');
    settings.set('readModeBoldCites', false);
    const off = transformForExport(doc, { includeComments: false, includeAnalytics: false, includeUndertags: false, readMode: true });
    expect(off.firstChild!.childCount).toBe(2); // tag + body; the cite has nothing kept
  });
});
