import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  formatMarkerTime,
  isReadingMarkerColor,
  readingMarkerRunAt,
  buildInsertReadingMarkerTransaction,
  buildToggleReadingMarkerTransaction,
  READING_MARKER_COLOR,
  READING_MARKER_META,
  READ_MODE_DRAG_META,
  READING_MARKER_ROLE,
  isMarkerText,
  containsReadingMarker,
  normalizeReadingMarkers,
  readingMarkerNodeText,
  readingMarkerRangesIn,
} from '../../src/editor/reading-marker.js';
import { exportDoc } from '../../src/export/index.js';
import { history } from 'prosemirror-history';
import {
  readModePlugin,
  PMD_READ_MODE_TOGGLE,
  readModeAwareUndo,
  readModeAwareRedo,
} from '../../src/editor/read-mode-plugin.js';

function tag(text: string) { return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text)); }
function cardBody(text: string) { return schema.nodes['card_body']!.create(null, schema.text(text)); }
function card(...c: any[]) { return schema.nodes['card']!.createChecked(null, c); }
function makeDoc(...c: any[]) { return schema.nodes['doc']!.createChecked(null, c); }

const NOW = new Date(2024, 0, 1, 7, 32);

function cursorAt(doc: any, text: string, offset: number): EditorState {
  let pos = -1;
  doc.descendants((n: any, p: number) => { if (n.isText && n.text === text) pos = p + offset; return true; });
  const base = EditorState.create({ doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
}

function markerText(doc: any): { text: string; color: string | undefined } | null {
  let found: { text: string; color: string | undefined } | null = null;
  doc.descendants((n: any) => {
    if (n.isText && n.text?.startsWith('Marked')) {
      const fc = n.marks.find((m: any) => m.type.name === 'font_color');
      found = { text: n.text, color: fc?.attrs['color'] };
    }
    return true;
  });
  return found;
}

describe('formatMarkerTime', () => {
  it('formats as h:mm, 12-hour, no leading zero on the hour', () => {
    expect(formatMarkerTime(new Date(2024, 0, 1, 7, 32))).toBe('7:32');
    expect(formatMarkerTime(new Date(2024, 0, 1, 19, 5))).toBe('7:05');
    expect(formatMarkerTime(new Date(2024, 0, 1, 0, 0))).toBe('12:00');
  });
});

describe('isReadingMarkerColor', () => {
  it('matches the marker red case-insensitively', () => {
    expect(isReadingMarkerColor('FF0000')).toBe(true);
    expect(isReadingMarkerColor('ff0000')).toBe(true);
    expect(isReadingMarkerColor('000000')).toBe(false);
    expect(isReadingMarkerColor(undefined)).toBe(false);
  });
});

describe('reading marker toggle', () => {
  it('inserts a red "Marked h:mm" run when the cursor is on plain text', () => {
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('hello world'))), 'hello world', 5);
    const tr = buildToggleReadingMarkerTransaction(state, NOW)!;
    const next = state.apply(tr);
    const m = markerText(next.doc);
    expect(m).toEqual({ text: 'Marked 7:32', color: READING_MARKER_COLOR });
    expect((next.storedMarks ?? []).some((mk) => mk.type.name === 'font_color')).toBe(false);
  });

  it('removes the marker when the cursor is on an existing one (toggle off)', () => {
    // Insert one, then toggle again at the caret (which lands after it).
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('hello world'))), 'hello world', 5);
    const afterInsert = state.apply(buildToggleReadingMarkerTransaction(state, NOW)!);
    expect(markerText(afterInsert.doc)).not.toBeNull();
    // Caret is right after the marker → run is detected.
    expect(readingMarkerRunAt(afterInsert)).not.toBeNull();
    const afterRemove = afterInsert.apply(buildToggleReadingMarkerTransaction(afterInsert, NOW)!);
    expect(markerText(afterRemove.doc)).toBeNull();
    // Original text is intact.
    expect(afterRemove.doc.textContent).toBe('TAGhello world');
  });

  it('readingMarkerRunAt is null when the cursor is on plain text', () => {
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('hello world'))), 'hello world', 5);
    expect(readingMarkerRunAt(state)).toBeNull();
  });

  it('buildInsertReadingMarkerTransaction always inserts (no toggle)', () => {
    const state = cursorAt(makeDoc(card(tag('TAG'), cardBody('x'))), 'x', 1);
    const next = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!);
    expect(markerText(next.doc)?.text).toBe('Marked 7:32');
  });
});

describe('read mode edit lock (filterTransaction)', () => {
  function readModeState(text: string, offset: number) {
    const doc = makeDoc(card(tag('TAG'), cardBody(text)));
    let pos = -1;
    doc.descendants((n: any, p: number) => { if (n.isText && n.text === text) pos = p + offset; return true; });
    let s = EditorState.create({ doc, plugins: [readModePlugin] });
    s = s.applyTransaction(s.tr.setSelection(TextSelection.create(s.doc, pos))).state;
    s = s.applyTransaction(s.tr.setMeta(PMD_READ_MODE_TOGGLE, true)).state;
    return s;
  }

  it('blocks a plain edit while read mode is on', () => {
    const s = readModeState('hello world', 5);
    const after = s.applyTransaction(s.tr.insertText('Z', s.selection.head)).state;
    expect(after.doc.textContent).toBe('TAGhello world'); // unchanged
  });

  it('allows a transaction flagged as the reading marker', () => {
    const s = readModeState('hello world', 5);
    const tr = s.tr.insertText('Z', s.selection.head).setMeta(READING_MARKER_META, true);
    const after = s.applyTransaction(tr).state;
    expect(after.doc.textContent).toContain('Z');
  });

  it('allows a drag/shelf edit (drag-move, dropzone, receive pill)', () => {
    const s = readModeState('hello world', 5);
    const tr = s.tr.insertText('Z', s.selection.head).setMeta(READ_MODE_DRAG_META, true);
    const after = s.applyTransaction(tr).state;
    expect(after.doc.textContent).toContain('Z');
  });

  it('allows adding a comment (a comment_range mark and nothing else)', () => {
    const s = readModeState('hello world', 5);
    const comment = schema.marks['comment_range']!;
    const tr = s.tr.addMark(s.selection.head - 3, s.selection.head + 3, comment.create({ threadId: 'c1' }));
    const after = s.applyTransaction(tr).state;
    let found = false;
    after.doc.descendants((n: any) => { if (n.marks.some((m: any) => m.type.name === 'comment_range')) found = true; return true; });
    expect(found).toBe(true);
    expect(after.doc.textContent).toBe('TAGhello world');
  });

  it('allows deleting a comment (removing its comment_range mark)', () => {
    const s0 = readModeState('hello world', 5);
    const comment = schema.marks['comment_range']!;
    const s = s0.applyTransaction(s0.tr.addMark(4, 9, comment.create({ threadId: 'c1' }))).state;
    const after = s.applyTransaction(s.tr.removeMark(4, 9, comment)).state;
    let found = false;
    after.doc.descendants((n: any) => { if (n.marks.some((m: any) => m.type.name === 'comment_range')) found = true; return true; });
    expect(found).toBe(false);
  });

  it('still blocks other mark edits (a highlight) and a comment bundled with a text edit', () => {
    const s = readModeState('hello world', 5);
    const hl = schema.marks['highlight']!.create({ color: 'yellow' });
    const painted = s.applyTransaction(s.tr.addMark(4, 9, hl)).state;
    expect(painted.doc.eq(s.doc)).toBe(true);
    const comment = schema.marks['comment_range']!;
    const mixed = s.tr.addMark(4, 9, comment.create({ threadId: 'c2' })).insertText('Z', s.selection.head);
    const after = s.applyTransaction(mixed).state;
    expect(after.doc.eq(s.doc)).toBe(true);
  });

  it('allows selection-only changes (cursor stays usable)', () => {
    const s = readModeState('hello world', 5);
    const tr = s.tr.setSelection(TextSelection.create(s.doc, s.selection.head + 2));
    const after = s.applyTransaction(tr).state;
    expect(after.selection.head).toBe(s.selection.head + 2);
  });

  it('allows edits again once read mode is off', () => {
    let s = readModeState('hello world', 5);
    s = s.applyTransaction(s.tr.setMeta(PMD_READ_MODE_TOGGLE, false)).state;
    const after = s.applyTransaction(s.tr.insertText('Z', s.selection.head)).state;
    expect(after.doc.textContent).toContain('Z');
  });
});

describe('read-mode undo/redo is bounded to markers', () => {
  function dispatchCmd(s: EditorState, cmd: typeof readModeAwareUndo): EditorState {
    let next = s;
    cmd(s, (tr) => { next = s.applyTransaction(tr).state; });
    return next;
  }

  function enterReadModeWithPreEdit(): EditorState {
    const doc = makeDoc(card(tag('TAG'), cardBody('hello')));
    let s = EditorState.create({ doc, plugins: [history(), readModePlugin] });
    let pos = -1;
    doc.descendants((n: any, p: number) => { if (n.isText && n.text === 'hello') pos = p + 5; return true; });
    s = s.applyTransaction(s.tr.setSelection(TextSelection.create(s.doc, pos))).state;
    // A normal (non-marker) edit BEFORE read mode — must never be undoable
    // from inside read mode.
    s = s.applyTransaction(s.tr.insertText(' world', s.selection.head)).state;
    expect(s.doc.textContent).toBe('TAGhello world');
    // Enter read mode, then drop a marker.
    s = s.applyTransaction(s.tr.setMeta(PMD_READ_MODE_TOGGLE, true)).state;
    s = s.applyTransaction(buildToggleReadingMarkerTransaction(s, NOW)!).state;
    expect(markerText(s.doc)).not.toBeNull();
    return s;
  }

  it('undoes the marker but stops there (never the pre-read-mode edit)', () => {
    let s = enterReadModeWithPreEdit();
    s = dispatchCmd(s, readModeAwareUndo); // removes the marker
    expect(markerText(s.doc)).toBeNull();
    expect(s.doc.textContent).toBe('TAGhello world');
    s = dispatchCmd(s, readModeAwareUndo); // blocked — does NOT undo " world"
    expect(s.doc.textContent).toBe('TAGhello world');
  });

  it('redo re-applies the undone marker', () => {
    let s = enterReadModeWithPreEdit();
    s = dispatchCmd(s, readModeAwareUndo);
    expect(markerText(s.doc)).toBeNull();
    s = dispatchCmd(s, readModeAwareRedo);
    expect(markerText(s.doc)).not.toBeNull();
  });
});

// ---- marker identity: the role, not the red -----------------------------

const red = (text: string, role: string | null = null) =>
  schema.text(text, [schema.marks['font_color']!.create({ color: READING_MARKER_COLOR, role })]);
const marker = (text = 'Marked 7:32') => red(text, READING_MARKER_ROLE);
const plain = (text: string) => schema.text(text);
function body(...inline: any[]) { return schema.nodes['card_body']!.create(null, inline); }
function markerRuns(doc: any): string[] {
  const out: string[] = [];
  doc.descendants((n: any) => { if (isMarkerText(n)) out.push(n.text); return true; });
  return out;
}

describe('a marker is the role, not the color', () => {
  it('the insert writes the role, so the run is a marker', () => {
    const state = cursorAt(makeDoc(card(tag('T'), cardBody('hello world'))), 'hello world', 5);
    const out = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!).doc;
    expect(markerRuns(out)).toEqual(['Marked 7:32']);
    expect(markerText(out)?.color).toBe(READING_MARKER_COLOR);
  });

  it('plain red text — hand-colored body, baked unread red, a Verbatim file — is not a marker', () => {
    const doc = makeDoc(card(tag('T'), body(plain('read '), red('this part is just red'), plain(' and '), red(' '))));
    expect(containsReadingMarker(doc)).toBe(false);
    expect(readingMarkerRunAt(cursorAt(doc, 'this part is just red', 3))).toBeNull();
  });

  it('a marker run does not merge with adjacent plain red (so toggle-off never eats body)', () => {
    const doc = makeDoc(card(tag('T'), body(plain('a '), marker(), red(' rest of the card'))));
    expect(doc.firstChild!.lastChild!.childCount).toBe(3);
    const state = cursorAt(doc, 'Marked 7:32', 3);
    const out = state.apply(buildToggleReadingMarkerTransaction(state, NOW)!).doc;
    expect(out.textContent).toBe('Ta  rest of the card');
  });
});

describe('one marker per card', () => {
  it('dropping a marker removes any other marker in the same card', () => {
    const doc = makeDoc(
      card(tag('T'), body(marker('Marked 1:01'), plain(' one. ')), body(plain('two '), marker('Marked 2:02'), plain(' end'))),
    );
    const state = cursorAt(doc, ' end', 2);
    const out = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!).doc;
    expect(markerRuns(out)).toEqual(['Marked 7:32']);
    expect(out.textContent).toBe('T one. two  eMarked 7:32nd');
    // Caret lands after the new marker.
    const after = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!);
    expect(after.doc.textBetween(after.selection.from - 11, after.selection.from)).toBe('Marked 7:32');
  });

  it('is bounded by the card: a marker in another card stays', () => {
    const doc = makeDoc(
      card(tag('A'), body(marker('Marked 1:01'), plain(' a'))),
      card(tag('B'), body(plain('b text'))),
    );
    const state = cursorAt(doc, 'b text', 1);
    const out = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!).doc;
    expect(markerRuns(out)).toEqual(['Marked 1:01', 'Marked 7:32']);
  });

  it('two taps leave a secretly-marked card clean', () => {
    const doc = makeDoc(card(tag('T'), body(plain('x '), marker('Marked 1:01'), plain(' y '), marker('Marked 2:02'), plain(' z'))));
    const s1 = cursorAt(doc, ' z', 1);
    const s2 = s1.apply(buildToggleReadingMarkerTransaction(s1, NOW)!); // tap 1: inserts, clears the rest
    expect(markerRuns(s2.doc)).toEqual(['Marked 7:32']);
    const s3 = s2.apply(buildToggleReadingMarkerTransaction(s2, NOW)!); // tap 2: caret is on it → remove
    expect(markerRuns(s3.doc)).toEqual([]);
    expect(s3.doc.textContent).toBe('Tx  y  z');
  });

  it('readingMarkerRangesIn reports every marker in a range, in order', () => {
    const doc = makeDoc(card(tag('T'), body(marker('Marked 1:01'), plain(' '), marker('Marked 2:02'))));
    const ranges = readingMarkerRangesIn(doc, 0, doc.content.size);
    expect(ranges.map((r) => doc.textBetween(r.from, r.to))).toEqual(['Marked 1:01', 'Marked 2:02']);
  });
});

describe('normalizeReadingMarkers (load-time)', () => {
  it('a legacy red "Marked h:mm" run becomes a marker', () => {
    const out = normalizeReadingMarkers(makeDoc(card(tag('T'), body(plain('a '), red('Marked 7:32'), plain(' b')))));
    expect(markerRuns(out)).toEqual(['Marked 7:32']);
  });

  it('red text that is not a marker is left alone — still red, never a marker', () => {
    const doc = makeDoc(card(tag('T'), body(red('all of this is red '), red(' '))));
    const out = normalizeReadingMarkers(doc);
    expect(out).toBe(doc); // untouched, same node
    expect(containsReadingMarker(out)).toBe(false);
  });

  it('a marker merged into baked unread red is carved back out; the rest stays plain red', () => {
    const out = normalizeReadingMarkers(makeDoc(card(tag('T'), body(red('Marked 7:32 and the body you never read.')))));
    expect(markerRuns(out)).toEqual(['Marked 7:32']);
    const runs: string[] = [];
    out.descendants((n: any) => { if (n.isText) runs.push(n.text); return true; });
    expect(runs).toEqual(['T', 'Marked 7:32', ' and the body you never read.']);
    expect(out.textContent).toBe('TMarked 7:32 and the body you never read.');
  });

  it('a mangled marker (typed into, half deleted) loses the role but keeps its color', () => {
    const out = normalizeReadingMarkers(makeDoc(card(tag('T'), body(marker('Marked 7:3'), plain(' '), marker('Marked 7:32xyz')))));
    expect(markerRuns(out)).toEqual(['Marked 7:32']); // the intact part of the second is still a marker
    const reds: string[] = [];
    out.descendants((n: any) => {
      if (n.isText && n.marks.some((m: any) => m.type.name === 'font_color')) reds.push(n.text);
      return true;
    });
    expect(reds).toEqual(['Marked 7:3', 'Marked 7:32', 'xyz']);
  });

  it('an intact marker is a no-op', () => {
    const doc = makeDoc(card(tag('T'), body(plain('a '), marker(), plain(' b'))));
    expect(normalizeReadingMarkers(doc)).toBe(doc);
  });
});

describe('reading_marker node (dormant)', () => {
  const node = () => schema.nodes['reading_marker']!.create({ time: '7:32' });

  it('round-trips through JSON and counts as a marker', () => {
    const doc = makeDoc(card(tag('T'), body(plain('a '), node(), plain(' b'))));
    const back = schema.nodeFromJSON(doc.toJSON());
    expect(back.eq(doc)).toBe(true);
    expect(containsReadingMarker(back)).toBe(true);
    expect(readingMarkerRangesIn(back, 0, back.content.size)).toHaveLength(1);
  });

  it('renders the same text the run form writes', () => {
    const n = node();
    // No DOM here — read the toDOM spec directly: ['span', attrs, text].
    const spec = schema.nodes['reading_marker']!.spec.toDOM!(n) as unknown as unknown[];
    expect(spec[2]).toBe(readingMarkerNodeText(n));
    expect(readingMarkerNodeText(n)).toBe('Marked 7:32');
  });

  it('exports to Word as a red run', () => {
    const doc = makeDoc(schema.nodes['paragraph']!.create(null, [plain('a '), node()]));
    const xml = exportDoc(doc).documentXml;
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).toContain('Marked 7:32');
  });

  it('dropping a text marker also removes a node marker in the card', () => {
    const doc = makeDoc(card(tag('T'), body(node(), plain(' text'))));
    const state = cursorAt(doc, ' text', 3);
    const out = state.apply(buildInsertReadingMarkerTransaction(state, NOW)!).doc;
    expect(readingMarkerRangesIn(out, 0, out.content.size)).toHaveLength(1);
    expect(markerRuns(out)).toEqual(['Marked 7:32']);
  });
});
