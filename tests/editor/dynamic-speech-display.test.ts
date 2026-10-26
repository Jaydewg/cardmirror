// @vitest-environment jsdom
/**
 * Dynamic speech readouts (dynamic-speech/display.ts): the status items,
 * the "where the WPM comes from" lines, and the word count's extra
 * reader — "Live" in a session, "Dynamic" outside one (opt-in).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import { liveReaderFor, speechSourceLines, speechStatusParts } from '../../src/editor/dynamic-speech/display.js';
import { addSpeechSession } from '../../src/editor/dynamic-speech/history-store.js';
import { __resetDynamicSpeechForTests, type SpeechSummary } from '../../src/editor/dynamic-speech/session.js';

const base: SpeechSummary = {
  active: true,
  wpm: 287.4,
  measuredWpm: 301.2,
  blend: {
    wpm: 287.4,
    live: { wpm: 301.2, words: 412, share: 0.62 },
    history: { wpm: 270, count: 2, share: 0.25 },
    prior: { wpm: 250, share: 0.13 },
  },
  historyRule: 'recent',
  historyDay: null,
  priorName: 'Amy',
  liveReadMs: 161_000,
  status: 'over',
  slackMs: -12_000,
  stopwatch: false,
};

beforeEach(() => {
  localStorage.removeItem('cardmirror-speech-history-v1');
  __resetDynamicSpeechForTests();
  settings.set('readers', [{ name: 'Amy', wpm: 250, tagWpm: 125 }]);
  settings.set('dynamicSpeechIdleReadTimes', false);
});

afterEach(() => {
  settings.set('readers', [{ name: 'Reader 1', wpm: 200 }, { name: 'Reader 2', wpm: 250 }]);
});

describe('status items', () => {
  it('in the asked-for order', () => {
    expect(speechStatusParts(base, ['wpm', 'measured', 'finish', 'live'])).toEqual([
      'WPM 287',
      'Measured 301',
      'Finish −0:12',
      'Live 2:41',
    ]);
    expect(speechStatusParts({ ...base, measuredWpm: null }, ['measured'])).toEqual(['Measured —']);
    expect(speechStatusParts({ ...base, active: false }, ['wpm'])).toEqual([]);
  });

  it('the sources, each with its share', () => {
    expect(speechSourceLines(base, { inSpeech: true })).toEqual([
      'This speech: 301 WPM measured over 412 words (62%)',
      'Saved speeches: 270 WPM, 2 speeches from the last 3 hours (25%)',
      "Amy's WPM setting: 250 (13%)",
    ]);
    const idle = speechSourceLines({ ...base, blend: { ...base.blend!, live: null, history: null } }, { inSpeech: false });
    expect(idle).toEqual(['Saved speeches: none recent enough to use', "Amy's WPM setting: 250 (13%)"]);
  });
});

describe('the extra reader', () => {
  const state = EditorState.create({ schema });

  it('outside a session: nothing unless asked for, and nothing without history', () => {
    expect(liveReaderFor(state)).toBeNull();
    settings.set('dynamicSpeechIdleReadTimes', true);
    expect(liveReaderFor(state)).toBeNull();
  });

  it('"Dynamic" from saved speeches, at Reader 1’s tag/body ratio', () => {
    settings.set('dynamicSpeechIdleReadTimes', true);
    const now = Date.now();
    addSpeechSession({
      id: 'a',
      startedAt: now - 600_000,
      endedAt: now - 60_000,
      words: 1500,
      wpm: 350,
      docName: null,
      mode: 'countdown',
      durationMs: 540_000,
      elapsedMs: 540_000,
      points: [],
      excludedWords: 0,
    });
    // (150 × 250 + 750 × 350) / 900
    expect(liveReaderFor(state)).toEqual({ name: 'Dynamic', wpm: 333, tagWpm: 167 });
  });
});
