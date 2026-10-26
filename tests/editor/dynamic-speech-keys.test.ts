// @vitest-environment jsdom
/**
 * In-speech keys (dynamic-speech/editor-plugin.ts), registered ahead of
 * read mode: Space marks without a reading marker by default, Enter and
 * the marker shortcut keep read mode's behavior, nothing happens while
 * unarmed, the off-screen gate swallows the key, and remapped keys work.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';
import { loadSpeechPreset, resetTimer, startTimer } from '../../src/editor/timer-state.js';
import { dynamicSpeechPlugin } from '../../src/editor/dynamic-speech/editor-plugin.js';
import {
  __resetDynamicSpeechForTests,
  armDynamicSpeech,
  configureDynamicSpeech,
  endDynamicSpeech,
  installDynamicSpeech,
  speechStateOf,
} from '../../src/editor/dynamic-speech/session.js';

let view: EditorView;

function mkView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const hl = schema.marks['highlight']!.create();
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag words')),
      schema.nodes['card_body']!.create(null, schema.text('body words here and more', [hl])),
    ]),
  ]);
  const v = new EditorView(el, {
    state: EditorState.create({ doc, plugins: [dynamicSpeechPlugin, readModePlugin] }),
  });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 14)));
  v.dispatch(v.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  return v;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  view.dom.dispatchEvent(evt);
  return evt;
}

const space = { key: ' ', code: 'Space' };

beforeAll(() => {
  installDynamicSpeech();
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 9, 23, 10, 0) });
  settings.set('dynamicSpeechEnterReadMode', false);
  settings.set('dynamicSpeechSpaceAlsoMarks', false);
  settings.set('dynamicSpeechRequireCursorVisible', true);
  settings.set('dynamicSpeechKeysEnabled', true);
  settings.set('dynamicSpeechAutoArm', false);
  settings.set('dynamicSpeechKeys', { timeMark: 'Space', skipClip: 'Shift-Space', undo: 'Backspace' });
  view = mkView();
  configureDynamicSpeech({ activeView: () => view });
});

afterEach(() => {
  endDynamicSpeech(false);
  resetTimer();
  __resetDynamicSpeechForTests();
  view.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function armAndRun(): void {
  loadSpeechPreset(3);
  armDynamicSpeech(view);
  startTimer();
  vi.advanceTimersByTime(6_000);
}

describe('in-speech keys', () => {
  it('unarmed: Space is read mode’s reading marker, as before', () => {
    press(space);
    expect(view.state.doc.textContent).toMatch(/Marked/);
  });

  it('armed but the clock is stopped: keys fall through to read mode', () => {
    loadSpeechPreset(3);
    armDynamicSpeech(view);
    press({ key: 'Backspace' });
    expect(speechStateOf(view)!.points).toHaveLength(0);
  });

  it('Space logs a mark and drops no reading marker by default', () => {
    armAndRun();
    expect(press(space).defaultPrevented).toBe(true);
    expect(speechStateOf(view)!.points).toHaveLength(1);
    expect(view.state.doc.textContent).not.toMatch(/Marked/);
  });

  it('with "Space also marks", it drops one too', () => {
    settings.set('dynamicSpeechSpaceAlsoMarks', true);
    armAndRun();
    press(space);
    expect(speechStateOf(view)!.points).toHaveLength(1);
    expect(view.state.doc.textContent).toMatch(/Marked/);
  });

  it('Enter and the marker shortcut keep read mode’s behavior', () => {
    armAndRun();
    press({ key: 'Enter' });
    expect(view.state.doc.textContent).toMatch(/Marked/);
    expect(speechStateOf(view)!.points).toHaveLength(0);
  });

  it('Shift+Space clips, Backspace undoes', () => {
    armAndRun();
    press({ ...space, shiftKey: true });
    expect(speechStateOf(view)!.excluded).toHaveLength(1);
    vi.advanceTimersByTime(1_100);
    press({ key: 'Backspace' });
    expect(speechStateOf(view)!.excluded).toHaveLength(0);
  });

  it('the off-screen gate swallows the key without marking', () => {
    armAndRun();
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 0, right: 0, top: 5000, bottom: 5020 });
    expect(press(space).defaultPrevented).toBe(true);
    expect(speechStateOf(view)!.points).toHaveLength(0);
    expect(view.state.doc.textContent).not.toMatch(/Marked/);
  });

  it('a remapped key works and the old one is free', () => {
    settings.set('dynamicSpeechKeys', { timeMark: 'm', skipClip: 'Shift-Space', undo: 'Backspace' });
    armAndRun();
    press({ key: 'm' });
    expect(speechStateOf(view)!.points).toHaveLength(1);
    vi.advanceTimersByTime(1_100);
    press(space);
    expect(speechStateOf(view)!.points).toHaveLength(1);
    expect(view.state.doc.textContent).toMatch(/Marked/); // back to read mode
  });

  it('keys can be switched off', () => {
    settings.set('dynamicSpeechKeysEnabled', false);
    armAndRun();
    press(space);
    expect(speechStateOf(view)!.points).toHaveLength(0);
  });
});
