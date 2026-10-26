/**
 * Tests for the Save-As pre-export transforms: include-* gates and
 * the read-mode visibility filter.
 */

import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { EditorState, TextSelection } from 'prosemirror-state';
import { transformForExport, countMarkedCards, bakesUnreadRedOnSave } from '../../src/export/transform-for-export.js';
import { buildToggleReadingMarkerTransaction, normalizeReadingMarkers } from '../../src/editor/reading-marker.js';

// ---- Doc builders ----------------------------------------------

function txt(s: string, ...markNames: string[]) {
  const marks = markNames.map((m) => {
    const t = schema.marks[m];
    if (!t) throw new Error(`unknown mark ${m}`);
    return m === 'highlight' ? t.create({ color: 'yellow' }) : t.create();
  });
  return schema.text(s, marks);
}
function paragraph(...inlines: ReturnType<typeof txt>[]) {
  return schema.nodes['paragraph']!.create(null, inlines);
}
function pocket(t: string) {
  return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(t));
}
function hat(t: string) {
  return schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text(t));
}
function tag(t: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
}
function analytic(t: string) {
  return schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(t));
}
function cardBody(...inlines: ReturnType<typeof txt>[]) {
  return schema.nodes['card_body']!.create(null, inlines);
}
function citeParagraph(...inlines: ReturnType<typeof txt>[]) {
  return schema.nodes['cite_paragraph']!.create(null, inlines);
}
function undertag(t: string) {
  return schema.nodes['undertag']!.create(null, schema.text(t));
}
function card(...children: any[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function analyticUnit(...children: any[]) {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}
function makeDoc(...children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

const ALL_ON = {
  includeComments: true,
  includeAnalytics: true,
  includeUndertags: true,
  readMode: false,
};

// ---- Tests ------------------------------------------------------

describe('transformForExport — no-op when all include-* flags are set', () => {
  it('returns an equivalent doc when nothing is filtered', () => {
    const doc = makeDoc(
      pocket('P'),
      card(tag('T'), cardBody(txt('body'))),
      analyticUnit(analytic('A'), cardBody(txt('body'))),
      undertag('UT'),
    );
    const out = transformForExport(doc, ALL_ON);
    expect(out.eq(doc)).toBe(true);
  });
});

describe('transformForExport — strip analytics', () => {
  it('drops doc-level analytic_units entirely', () => {
    const doc = makeDoc(
      card(tag('T'), cardBody(txt('body'))),
      analyticUnit(analytic('A'), cardBody(txt('au body'))),
    );
    const out = transformForExport(doc, { ...ALL_ON, includeAnalytics: false });
    expect(out.childCount).toBe(1);
    expect(out.firstChild!.type.name).toBe('card');
  });
});

describe('transformForExport — strip undertags', () => {
  it('drops doc-level undertags', () => {
    const doc = makeDoc(
      paragraph(txt('hi')),
      undertag('UT'),
      paragraph(txt('there')),
    );
    const out = transformForExport(doc, { ...ALL_ON, includeUndertags: false });
    expect(out.childCount).toBe(2);
    expect(out.child(0).textContent).toBe('hi');
    expect(out.child(1).textContent).toBe('there');
  });

  it('drops undertags inside cards', () => {
    const doc = makeDoc(card(tag('T'), undertag('UT'), cardBody(txt('body'))));
    const out = transformForExport(doc, { ...ALL_ON, includeUndertags: false });
    const c = out.firstChild!;
    expect(c.childCount).toBe(2);
    expect(c.child(0).type.name).toBe('tag');
    expect(c.child(1).type.name).toBe('card_body');
  });

  it('drops undertags inside analytic_units', () => {
    const doc = makeDoc(analyticUnit(analytic('A'), undertag('UT'), cardBody(txt('body'))));
    const out = transformForExport(doc, { ...ALL_ON, includeUndertags: false });
    const au = out.firstChild!;
    expect(au.childCount).toBe(2);
    expect(au.child(0).type.name).toBe('analytic');
    expect(au.child(1).type.name).toBe('card_body');
  });
});

describe('transformForExport — read mode', () => {
  const RM = { includeComments: false, includeAnalytics: false, includeUndertags: false, readMode: true };

  it('keeps headings and drops doc-level paragraphs with no highlights', () => {
    const doc = makeDoc(pocket('P'), paragraph(txt('no highlight here')));
    const out = transformForExport(doc, RM);
    expect(out.childCount).toBe(1);
    expect(out.firstChild!.type.name).toBe('pocket');
  });

  it('drops doc-level loose paragraphs entirely (display: none in read mode)', () => {
    const doc = makeDoc(
      paragraph(txt('before '), txt('keep me', 'highlight'), txt(' after')),
    );
    const out = transformForExport(doc, RM);
    // Doc-level body paragraphs aren't in the read-mode visible-
    // children allowlist (.ProseMirror > .pmd-paragraph etc. are
    // display:none), so they drop regardless of inner highlights.
    expect(out.childCount).toBe(0);
  });

  it('keeps tag + cite-mark text in cite_paragraph + highlighted card body', () => {
    const doc = makeDoc(
      card(
        tag('My Tag'),
        citeParagraph(txt('Author 2024', 'cite_mark'), txt(' — extra metadata')),
        cardBody(txt('lorem '), txt('important', 'highlight'), txt(' ipsum')),
      ),
    );
    const out = transformForExport(doc, RM);
    const c = out.firstChild!;
    expect(c.type.name).toBe('card');
    expect(c.childCount).toBe(3);
    expect(c.child(0).type.name).toBe('tag');
    expect(c.child(1).type.name).toBe('cite_paragraph');
    expect(c.child(1).textContent).toBe('Author 2024');
    expect(c.child(2).type.name).toBe('card_body');
    expect(c.child(2).textContent).toBe('important');
  });

  it('drops a card_body entirely when nothing inside it is highlighted', () => {
    const doc = makeDoc(card(tag('T'), cardBody(txt('plain body — no highlight'))));
    const out = transformForExport(doc, RM);
    const c = out.firstChild!;
    expect(c.childCount).toBe(1);
    expect(c.child(0).type.name).toBe('tag');
  });

  it('keeps standalone analytic_units; their bodies filter to highlighted text', () => {
    const doc = makeDoc(
      analyticUnit(
        analytic('A'),
        cardBody(txt('plain '), txt('mark', 'highlight'), txt(' plain')),
      ),
    );
    const out = transformForExport(doc, RM);
    const au = out.firstChild!;
    expect(au.type.name).toBe('analytic_unit');
    expect(au.childCount).toBe(2);
    expect(au.child(1).textContent).toBe('mark');
  });

  it('drops undertags in read mode (hidden by the read-mode CSS regardless of inner highlights)', () => {
    const undertagWithHighlight = schema.nodes['undertag']!.create(null, [
      txt('before '),
      txt('mark', 'highlight'),
      txt(' after'),
    ]);
    const doc = makeDoc(
      card(tag('T1'), undertag('plain undertag')),
      card(tag('T2'), undertagWithHighlight),
    );
    const out = transformForExport(doc, RM);
    const c1 = out.child(0);
    const c2 = out.child(1);
    // Undertags aren't in the read-mode visible-children allowlist
    // (.pmd-card > .pmd-undertag stays display:none), so they drop
    // wholesale — even when they contain highlighted text.
    expect(c1.childCount).toBe(1);
    expect(c2.childCount).toBe(1);
    expect(c2.child(0).type.name).toBe('tag');
  });

  it('merges adjacent card_bodies into a single flowing paragraph', () => {
    const doc = makeDoc(card(
      tag('T'),
      cardBody(txt('first ', 'highlight')),
      cardBody(txt('second ', 'highlight')),
      cardBody(txt('third', 'highlight')),
    ));
    const out = transformForExport(doc, RM);
    const c = out.firstChild!;
    expect(c.childCount).toBe(2);
    expect(c.child(0).type.name).toBe('tag');
    expect(c.child(1).type.name).toBe('card_body');
    expect(c.child(1).textContent).toBe('first second third');
  });

  it('inserts a separator space between consecutive kept inlines that lack natural whitespace', () => {
    const doc = makeDoc(card(
      tag('T'),
      cardBody(
        txt('before '),
        txt('Author', 'highlight'),
        txt(' some plain '),
        txt('2024', 'highlight'),
        txt(' after'),
      ),
    ));
    const out = transformForExport(doc, RM);
    const body = out.firstChild!.child(1);
    expect(body.type.name).toBe('card_body');
    expect(body.textContent).toBe('Author 2024');
  });

  it('does not insert a double space when the boundary already has whitespace', () => {
    const doc = makeDoc(card(
      tag('T'),
      cardBody(
        txt('first ', 'highlight'),  // trailing space already present
        txt(' plain text '),
        txt(' second', 'highlight'), // leading space already present
      ),
    ));
    const out = transformForExport(doc, RM);
    const body = out.firstChild!.child(1);
    // Both natural whitespace boundaries kept; no synthetic space.
    expect(body.textContent).toBe('first  second');
  });

  it('cite_paragraph between bodies breaks the merge (cite is its own block)', () => {
    const doc = makeDoc(card(
      tag('T'),
      cardBody(txt('body1', 'highlight')),
      citeParagraph(txt('Author 2024', 'cite_mark'), txt(' rest of cite')),
      cardBody(txt('body2', 'highlight')),
    ));
    const out = transformForExport(doc, RM);
    const c = out.firstChild!;
    expect(c.childCount).toBe(4);
    expect(c.child(0).type.name).toBe('tag');
    expect(c.child(1).type.name).toBe('card_body');
    expect(c.child(1).textContent).toBe('body1');
    expect(c.child(2).type.name).toBe('cite_paragraph');
    expect(c.child(2).textContent).toBe('Author 2024');
    expect(c.child(3).type.name).toBe('card_body');
    expect(c.child(3).textContent).toBe('body2');
  });

  it('undertag between bodies does NOT break the merge (undertag is invisible in read mode)', () => {
    const doc = makeDoc(card(
      tag('T'),
      cardBody(txt('body1', 'highlight')),
      undertag('plain'),
      cardBody(txt('body2', 'highlight')),
    ));
    const out = transformForExport(doc, RM);
    const c = out.firstChild!;
    expect(c.childCount).toBe(2);
    expect(c.child(1).textContent).toBe('body1 body2');
  });

  it('drops tables in read mode', () => {
    const cellPara = schema.nodes['paragraph']!.create(null, schema.text('cell'));
    const tableCell = schema.nodes['table_cell']!.create(null, [cellPara]);
    const tableRow = schema.nodes['table_row']!.create(null, [tableCell]);
    const table = schema.nodes['table']!.create(null, [tableRow]);
    const doc = makeDoc(pocket('P'), table);
    const out = transformForExport(doc, RM);
    expect(out.childCount).toBe(1);
    expect(out.firstChild!.type.name).toBe('pocket');
  });
});

// ---- marked cards -------------------------------------------------

describe('markedCardsOnly transform', () => {
  const MARKED = {
    includeComments: false,
    includeAnalytics: false,
    includeUndertags: true,
    readMode: false,
    markedCardsOnly: true,
  };
  // A reading marker is red text carrying the marker role (schema/reading-marker.ts).
  const marker = (s: string) =>
    schema.text(s, [schema.marks['font_color']!.create({ color: 'FF0000', role: 'marker' })]);

  it('keeps only marked cards, flat — drops headings, unmarked cards, analytics', () => {
    const doc = makeDoc(
      pocket('Pocket'),
      card(tag('Tag A'), cardBody(txt('plain one'))), // unmarked
      hat('Hat'),
      card(tag('Tag B'), cardBody(txt('read to '), marker('Marked 3:00'))), // marked
      analyticUnit(
        schema.nodes['analytic']!.create({ id: newHeadingId() }, marker('marked analytic')),
      ), // a marked ANALYTIC — not a card, so dropped
      card(tag('Tag C'), cardBody(txt('plain two'))), // unmarked
    );
    const out = transformForExport(doc, MARKED);
    expect(out.childCount).toBe(1);
    expect(out.firstChild!.type.name).toBe('card');
    expect(out.firstChild!.textContent).toContain('Tag B');
  });

  it('detects the marker anywhere in a card (tag, cite, undertag), not just the body', () => {
    const plain = card(tag('T0'), cardBody(txt('no marker')));
    const inTag = card(
      schema.nodes['tag']!.create({ id: newHeadingId() }, marker('Marked tag')),
      cardBody(txt('body')),
    );
    const inUndertag = card(
      tag('T2'),
      cardBody(txt('body')),
      schema.nodes['undertag']!.create(null, marker('Marked undertag')),
    );
    const inCite = card(tag('T3'), citeParagraph(marker('Marked cite')));
    const out = transformForExport(makeDoc(plain, inTag, inUndertag, inCite), MARKED);
    expect(out.childCount).toBe(3); // every card but `plain`
  });

  it('countMarkedCards counts only cards with a marker', () => {
    expect(countMarkedCards(makeDoc(card(tag('T'), cardBody(txt('plain')))))).toBe(0);
    const some = makeDoc(
      card(tag('T'), cardBody(marker('Marked'))),
      card(tag('T2'), cardBody(txt('plain'))),
      card(tag('T3'), cardBody(txt('x '), marker('Marked'))),
    );
    expect(countMarkedCards(some)).toBe(2);
  });

  it('produces an empty doc when nothing is marked', () => {
    const doc = makeDoc(
      pocket('P'),
      card(tag('T'), cardBody(txt('plain'))),
      analyticUnit(analytic('an analytic')),
    );
    expect(transformForExport(doc, MARKED).childCount).toBe(0);
  });
});

// ---- unread-after-marker red bake ---------------------------------

describe('markUnreadAfterMarker bake', () => {
  const marker = (s: string) =>
    schema.text(s, [schema.marks['font_color']!.create({ color: 'FF0000', role: 'marker' })]);

  /** Which text runs carry a red font_color mark after the transform. */
  function redRuns(doc: ReturnType<typeof makeDoc>): string[] {
    const red: string[] = [];
    doc.descendants((n) => {
      if (
        n.isText &&
        n.marks.some((m) => m.type.name === 'font_color' && (m.attrs['color'] as string).toUpperCase() === 'FF0000')
      ) {
        red.push(n.text ?? '');
      }
      return true;
    });
    return red;
  }

  const doc = makeDoc(
    card(tag('T'), cardBody(txt('before. '), marker('Marked 7:32'), txt(' after one.')), cardBody(txt('after two.'))),
  );

  it('bakes body after the marker into real red runs when on', () => {
    const out = transformForExport(doc, { ...ALL_ON, markUnreadAfterMarker: true });
    // Everything from the marker onward is red. The marker keeps its own run
    // (its role attr keeps it from merging with the baked body), so reopened
    // the baked red is just red — not more marker.
    expect(redRuns(out)).toEqual(['Marked 7:32', ' after one.', 'after two.']);
  });

  it('leaves the doc untouched when off (only the marker stays red)', () => {
    const out = transformForExport(doc, { ...ALL_ON, markUnreadAfterMarker: false });
    expect(redRuns(out)).toEqual(['Marked 7:32']);
  });
});

describe('the unread red is never baked into a working file', () => {
  const marker = (s: string) =>
    schema.text(s, [schema.marks['font_color']!.create({ color: 'FF0000', role: 'marker' })]);

  it('only an export to Word bakes it', () => {
    expect(bakesUnreadRedOnSave('docx', false, true), 'Save As → Word').toBe(true);
    expect(bakesUnreadRedOnSave('cmir', false, true), 'Save As → .cmir').toBe(false);
    expect(bakesUnreadRedOnSave('cmir', true, true), 'Save / autosave of a .cmir').toBe(false);
    expect(bakesUnreadRedOnSave('docx', true, true), 'Save in place over a .docx working file').toBe(false);
    expect(bakesUnreadRedOnSave('docx', false, false), 'setting off').toBe(false);
  });

  it('and if it were: the baked red stays plain red on reopen, so toggling the marker off removes only the marker', () => {
    // What a file saved with the red baked in looks like on reopen — the
    // export has no role attr for the body red, and load-time normalization
    // keeps it that way (the role lands on `Marked h:mm` and nowhere else).
    const baked = normalizeReadingMarkers(
      transformForExport(
        makeDoc(card(tag('T'), cardBody(txt('before. '), marker('Marked 7:32'), txt(' after one.')))),
        { ...ALL_ON, markUnreadAfterMarker: true },
      ),
    );
    expect(countMarkedCards(baked)).toBe(1);
    let markerPos = -1;
    baked.descendants((n, pos) => {
      if (markerPos < 0 && n.isText && (n.text ?? '').startsWith('Marked')) markerPos = pos + 2;
      return true;
    });
    const state = EditorState.create({ doc: baked, selection: TextSelection.create(baked, markerPos) });
    const after = state.apply(buildToggleReadingMarkerTransaction(state)!).doc;
    // The user's own text after the marker survives (it used to go with it).
    expect(after.textContent).toBe('Tbefore.  after one.');
    expect(countMarkedCards(after)).toBe(0);
  });
});
