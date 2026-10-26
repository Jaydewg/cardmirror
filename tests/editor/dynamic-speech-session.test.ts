// @vitest-environment jsdom
/**
 * Dynamic speech sessions (dynamic-speech/session.ts): auto-arm on a
 * speech start (not prep), the speaking clock across a pause, Space as
 * "done with this card" (log at its end, move to the next), words read
 * net of skips and clips, undo (the marker it dropped comes out, the
 * caret goes back), the repeat-press debounce, the WPM's sources, and
 * disarm-and-save on Reset.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import {
  loadSpeechPreset,
  pauseTimer,
  resetTimer,
  selectMode,
  startTimer,
} from '../../src/editor/timer-state.js';
import { dynamicSpeechPlugin } from '../../src/editor/dynamic-speech/editor-plugin.js';
import {
  __resetDynamicSpeechForTests,
  armDynamicSpeech,
  configureDynamicSpeech,
  endDynamicSpeech,
  getSpeechSummary,
  installDynamicSpeech,
  isSpeechArmed,
  nextUnitCursor,
  unitAt,
  speechSkipOrClip,
  speechStateOf,
  speechTimeMark,
  speechUndo,
} from '../../src/editor/dynamic-speech/session.js';
import { listSpeechSessions } from '../../src/editor/dynamic-speech/history-store.js';

const TEN = 'one two three four five six seven eight nine ten';

function card(tagText: string, body: string): PMNode {
  const hl = schema.marks['highlight']!.create();
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
    schema.nodes['card_body']!.create(null, schema.text(body, [hl])),
  ]);
}

let view: EditorView;

function mkView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const doc = schema.nodes['doc']!.createChecked(null, [
    card('Alpha tag', TEN),
    card('Beta tag', TEN),
    card('Gamma tag', TEN),
  ]);
  return new EditorView(el, { state: EditorState.create({ doc, plugins: [dynamicSpeechPlugin] }) });
}

/** Put the caret right before `needle` (the nth occurrence). */
function caretAt(needle: string, nth = 0, offset = 0): void {
  const hits: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    let i = (node.text ?? '').indexOf(needle);
    while (i >= 0) {
      hits.push(pos + i);
      i = (node.text ?? '').indexOf(needle, i + 1);
    }
    return true;
  });
  const at = hits[nth];
  if (at === undefined) throw new Error(`no ${needle}#${nth}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + offset)));
}

function ds() {
  return speechStateOf(view)!;
}

/** Where the caret lands for `needle` (its first text position). */
function posOf(needle: string, nth = 0): number {
  const hits: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isText && (node.text ?? '').includes(needle)) hits.push(pos + (node.text ?? '').indexOf(needle));
    return true;
  });
  return hits[nth]!;
}

function head(): number {
  return view.state.selection.head;
}

beforeAll(() => {
  installDynamicSpeech();
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 9, 23, 10, 0) });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  localStorage.removeItem('cardmirror-speech-history-v1');
  settings.set('dynamicSpeechEnterReadMode', false);
  settings.set('dynamicSpeechSpaceAlsoMarks', false);
  settings.set('dynamicSpeechAutoArm', true);
  settings.set('readers', [{ name: 'Reader 1', wpm: 240 }]);
  view = mkView();
  configureDynamicSpeech({ activeView: () => view, docName: () => 'aff.cmir' });
  caretAt('Alpha');
});

afterEach(() => {
  endDynamicSpeech(false);
  resetTimer();
  __resetDynamicSpeechForTests();
  view.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('arming', () => {
  it('a speech start arms the focused doc; a prep start does not', () => {
    selectMode('affPrep');
    startTimer();
    expect(isSpeechArmed()).toBe(false);
    pauseTimer();
    loadSpeechPreset(3);
    startTimer();
    expect(isSpeechArmed(view)).toBe(true);
    expect(ds().armed).toBe(true);
  });

  it('auto-arm can be turned off', () => {
    settings.set('dynamicSpeechAutoArm', false);
    loadSpeechPreset(3);
    startTimer();
    expect(isSpeechArmed()).toBe(false);
  });

  it('a window that is not the last-focused one does not arm', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    localStorage.setItem('cardmirror-last-focused-window', 'some-other-window');
    loadSpeechPreset(3);
    startTimer();
    expect(isSpeechArmed()).toBe(false);
  });
});

describe('the speaking clock', () => {
  it('excludes pauses', () => {
    loadSpeechPreset(3);
    startTimer();
    vi.advanceTimersByTime(30_000);
    caretAt('Beta');
    speechTimeMark();
    pauseTimer();
    vi.advanceTimersByTime(60_000);
    startTimer();
    vi.advanceTimersByTime(10_000);
    caretAt('Gamma');
    speechTimeMark();
    expect(ds().points.map((p) => p.elapsedMs)).toEqual([30_000, 40_000]);
  });
});

describe('marks, skips and clips', () => {
  beforeEach(() => {
    loadSpeechPreset(3);
    startTimer();
  });

  it('Space: done with this card — logged at its end, caret on to the next', () => {
    vi.advanceTimersByTime(5_000);
    caretAt('four'); // anywhere in Alpha
    speechTimeMark();
    expect(ds().points[0]).toMatchObject({ body: 10, other: 2, kind: 'mark' });
    expect(head()).toBe(posOf('Beta'));
    vi.advanceTimersByTime(5_000);
    speechTimeMark();
    expect(ds().points[1]).toMatchObject({ body: 20, other: 4 });
    expect(head()).toBe(posOf('Gamma'));
  });

  it('on a tag, skip drops the whole card and moves past it', () => {
    caretAt('Beta');
    speechSkipOrClip();
    expect(ds().points).toHaveLength(0);
    expect(ds().excluded).toHaveLength(1);
    expect(view.state.doc.textBetween(ds().excluded[0]!.from, ds().excluded[0]!.to, ' ')).toBe(`Beta tag ${TEN}`);
    expect(head()).toBe(posOf('Gamma'));
    vi.advanceTimersByTime(5_000);
    speechTimeMark();
    // Alpha and Gamma, not Beta.
    expect(ds().points[0]).toMatchObject({ body: 20, other: 4 });
  });

  it('in the body, clip marks the spot, drops the rest of the card, and moves on', () => {
    vi.advanceTimersByTime(5_000);
    caretAt('four', 1);
    speechSkipOrClip();
    expect(ds().points[0]).toMatchObject({ body: 13, other: 4, kind: 'clip' });
    const r = ds().excluded[0]!;
    expect(view.state.doc.textBetween(r.from, r.to, ' ')).toBe('four five six seven eight nine ten');
    expect(head()).toBe(posOf('Gamma'));
    vi.advanceTimersByTime(1_500);
    speechTimeMark();
    expect(ds().points[1]).toMatchObject({ body: 23, other: 6 });
  });

  it('outside any card, skip/clip does nothing', () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 0)));
    speechSkipOrClip();
    expect(ds().excluded).toHaveLength(0);
  });

  it('undo takes back the last action and puts the caret back', () => {
    caretAt('Beta');
    speechSkipOrClip();
    vi.advanceTimersByTime(1_500);
    speechTimeMark();
    speechUndo();
    expect(ds().points).toHaveLength(0);
    expect(ds().excluded).toHaveLength(1);
    expect(head()).toBe(posOf('Gamma'));
    vi.advanceTimersByTime(1_500);
    speechUndo();
    expect(ds().excluded).toHaveLength(0);
    expect(head()).toBe(posOf('Beta'));
  });

  it('with "Space also marks", a reading marker lands at the end of the finished card; undo removes it', () => {
    settings.set('dynamicSpeechSpaceAlsoMarks', true);
    caretAt('Beta');
    speechTimeMark();
    expect(view.state.doc.child(1).textContent).toMatch(/tenMarked \d+:\d\d$/);
    expect(head()).toBe(posOf('Gamma'));
    // The mark is still the end of Beta's card (the marker isn't read).
    expect(ds().points[0]).toMatchObject({ body: 20, other: 4 });
    speechUndo();
    expect(view.state.doc.textContent).not.toMatch(/Marked/);
    expect(ds().points).toHaveLength(0);
    expect(head()).toBe(posOf('Beta'));
  });

  it('a repeat press within the debounce is ignored', () => {
    speechTimeMark();
    vi.advanceTimersByTime(400);
    speechTimeMark();
    expect(ds().points).toHaveLength(1);
    vi.advanceTimersByTime(700);
    speechTimeMark();
    expect(ds().points).toHaveLength(2);
  });

  it('positions follow edits', () => {
    speechTimeMark();
    const pos = ds().points[0]!.pos;
    view.dispatch(view.state.tr.insertText('xx', 2));
    expect(ds().points[0]!.pos).toBe(pos + 2);
  });
});

describe('units', () => {
  it('a unit is a top-level child; the next one skips headings with nothing to read', () => {
    const block = schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block'));
    const doc = schema.nodes['doc']!.createChecked(null, [card('Alpha tag', TEN), block, card('Beta tag', TEN)]);
    const alpha = unitAt(doc, 3);
    expect(alpha.from).toBe(0);
    expect(alpha.to).toBe(doc.child(0).nodeSize);
    const next = nextUnitCursor(doc, alpha.to);
    expect(doc.resolve(next).parent.textContent).toBe('Beta tag');
    expect(nextUnitCursor(doc, doc.content.size)).toBe(doc.content.size - 2);
  });
});

describe('summary and ending', () => {
  it('starts from the static WPM and predicts the finish', () => {
    loadSpeechPreset(3);
    startTimer();
    const s = getSpeechSummary();
    expect(s.active).toBe(true);
    expect(s.wpm).toBeCloseTo(240, 6);
    // 30 body + 6 tag words at 240 wpm = 9 s, with 3 minutes left.
    expect(s.liveReadMs).toBeCloseTo(9_000, 0);
    expect(s.status).toBe('ahead');
    expect(s.measuredWpm).toBeNull();
    expect(s.blend).toMatchObject({ live: null, history: null, prior: { wpm: 240, share: 1 } });
    expect(s.priorName).toBe('Reader 1');
  });

  it('the measured rate and its share of the blend', () => {
    loadSpeechPreset(3);
    startTimer();
    vi.advanceTimersByTime(10_000);
    speechTimeMark();
    vi.advanceTimersByTime(10_000);
    speechTimeMark();
    const s = getSpeechSummary();
    expect(s.measuredWpm).toBeCloseTo(72, 6); // 24 words over 20 s
    expect(s.blend!.live!.words).toBe(24);
    expect(s.blend!.live!.share).toBeCloseTo(24 / (24 + 150), 6);
    expect(s.historyRule).toBe('none');
  });

  it('between presses the estimate runs down, but not past the card you are on', () => {
    loadSpeechPreset(3);
    startTimer();
    vi.advanceTimersByTime(60_000);
    const s = getSpeechSummary();
    // Still on Alpha: at least Beta + Gamma (24 words at 240) are left.
    expect(s.liveReadMs).toBeCloseTo(6_000, 0);
  });

  it('a stopwatch session has no finish', () => {
    startTimer(); // 0:00 loaded → counts up
    const s = getSpeechSummary();
    expect(s.stopwatch).toBe(true);
    expect(s.status).toBeNull();
  });

  it('Reset ends the session and saves it', () => {
    loadSpeechPreset(3);
    startTimer();
    vi.advanceTimersByTime(10_000);
    speechTimeMark();
    vi.advanceTimersByTime(10_000);
    speechTimeMark();
    resetTimer();
    expect(isSpeechArmed()).toBe(false);
    expect(ds().armed).toBe(false);
    const saved = listSpeechSessions();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ docName: 'aff.cmir', mode: 'countdown', durationMs: 180_000, elapsedMs: 20_000 });
    expect(saved[0]!.wpm).toBeCloseTo(72, 0); // 24 words over 20 s
  });

  it('a pause does not end it; loading a preset does', () => {
    loadSpeechPreset(3);
    startTimer();
    pauseTimer();
    expect(isSpeechArmed()).toBe(true);
    loadSpeechPreset(6);
    expect(isSpeechArmed()).toBe(false);
  });

  it('fewer than two marks saves nothing', () => {
    loadSpeechPreset(3);
    startTimer();
    vi.advanceTimersByTime(10_000);
    caretAt('Beta');
    speechTimeMark();
    resetTimer();
    expect(listSpeechSessions()).toHaveLength(0);
  });

  it('manual arm while idle; a reading marker at the top starts the clock', async () => {
    loadSpeechPreset(3);
    armDynamicSpeech(view);
    const { buildInsertReadingMarkerTransaction, READING_MARKER_META } = await import('../../src/editor/reading-marker.js');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const tr = buildInsertReadingMarkerTransaction(view.state)!;
    expect(tr.getMeta(READING_MARKER_META)).toBe(true);
    view.dispatch(tr);
    const { getTimerState } = await import('../../src/editor/timer-state.js');
    expect(getTimerState().running).toBe(true);
  });
});
