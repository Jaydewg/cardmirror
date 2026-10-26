/**
 * Dynamic speech rate model (dynamic-speech/wpm-model.ts): the live
 * slope, the prior/history/live blend, the history windows, and the
 * finish-in-time thresholds.
 */

import { describe, expect, it } from 'vitest';
import {
  MODEL,
  blendSources,
  blendWpm,
  pickHistory,
  equivalentWords,
  liveRate,
  otherFactor,
  predictFinish,
  selectHistory,
  type HistoryEntry,
} from '../../src/editor/dynamic-speech/wpm-model.js';

const MIN = 60_000;
const H = 3600_000;

describe('liveRate', () => {
  it('a steady reader gives back their rate', () => {
    const pts = [1, 2, 3].map((m) => ({ elapsedMs: m * MIN, words: 250 * m }));
    expect(liveRate(pts)!.wpm).toBeCloseTo(250, 6);
    expect(liveRate(pts)!.words).toBe(750);
  });

  it('one point is words over time', () => {
    expect(liveRate([{ elapsedMs: 30_000, words: 150 }])!.wpm).toBeCloseTo(300, 6);
  });

  it('nothing before the minimum speaking time or with no words', () => {
    expect(liveRate([])).toBeNull();
    expect(liveRate([{ elapsedMs: MODEL.minLiveMs - 1, words: 20 }])).toBeNull();
    expect(liveRate([{ elapsedMs: MIN, words: 0 }])).toBeNull();
  });
});

describe('tag-word conversion', () => {
  it('tags at tagWpm cost wpm/tagWpm body words', () => {
    expect(otherFactor({ wpm: 300, tagWpm: 150 })).toBe(2);
    expect(otherFactor({ wpm: 300 })).toBe(1);
    expect(otherFactor({ wpm: 300, tagWpm: 0 })).toBe(1);
    expect(equivalentWords({ body: 100, other: 10 }, 2)).toBe(120);
  });
});

describe('blendWpm', () => {
  it('the prior dominates early, live data later', () => {
    const early = blendWpm({ live: { wpm: 400, words: 20 }, history: [], prior: 250 })!;
    const late = blendWpm({ live: { wpm: 400, words: 1500 }, history: [], prior: 250 })!;
    expect(early).toBeLessThan(280);
    expect(late).toBeGreaterThan(385);
  });

  it('history is weighted by (capped, scaled) words', () => {
    const h = (wpm: number, words: number): HistoryEntry => ({ startedAt: 0, endedAt: 1, words, wpm });
    expect(blendWpm({ live: null, history: [h(300, 300)], prior: 200 })).toBeCloseTo((150 * 200 + 150 * 300) / 300, 6);
    const capped = blendWpm({ live: null, history: [h(300, 100_000)], prior: null });
    expect(capped).toBeCloseTo(300, 6);
  });

  it('null with nothing to go on', () => {
    expect(blendWpm({ live: null, history: [], prior: null })).toBeNull();
    expect(blendWpm({ live: null, history: [], prior: 0 })).toBeNull();
  });
});

describe('selectHistory', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const at = (endedAt: number, wpm = 250): HistoryEntry => ({ startedAt: endedAt - 5 * MIN, endedAt, words: 1000, wpm });

  it('recent speaker: only the last 3 hours', () => {
    const got = selectHistory([at(now - 1 * H), at(now - 2.5 * H), at(now - 4 * H)], now);
    expect(got).toHaveLength(2);
  });

  it('spoke 4 h ago: nothing recent enough, nothing older used', () => {
    expect(selectHistory([at(now - 4 * H)], now)).toEqual([]);
  });

  it('nothing in 8 h: ±2 h around this time yesterday', () => {
    const y = now - 24 * H;
    const got = selectHistory([at(y - 1.5 * H), at(y + 1 * H), at(y - 5 * H)], now);
    expect(got.map((s) => s.endedAt)).toEqual([y - 1.5 * H, y + 1 * H]);
  });

  it('otherwise the morning of the latest day with data', () => {
    const day = new Date(2026, 9, 20);
    const t = (h: number): number => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();
    const sessions = [at(t(8)), at(t(10)), at(t(16)), at(new Date(2026, 9, 19, 9).getTime())];
    const got = selectHistory(sessions, now);
    expect(got.map((s) => s.endedAt)).toEqual([t(8), t(10)]);
  });

  it('ignores empty or future sessions', () => {
    expect(selectHistory([{ startedAt: 0, endedAt: now - H, words: 0, wpm: 200 }, at(now + H)], now)).toEqual([]);
  });
});

describe('predictFinish', () => {
  it('needed time and slack', () => {
    const p = predictFinish({ remainingWords: 500, wpm: 250, timerRemainingMs: 3 * MIN })!;
    expect(p.neededMs).toBe(2 * MIN);
    expect(p.slackMs).toBe(MIN);
    expect(p.status).toBe('ahead');
  });

  it('tight within ±max(10 s, 5%) of the time left', () => {
    const at = (slackSec: number, left = 60): string =>
      predictFinish({ remainingWords: ((left - slackSec) / 60) * 300, wpm: 300, timerRemainingMs: left * 1000 })!.status;
    expect(at(9)).toBe('tight');
    expect(at(-9)).toBe('tight');
    expect(at(11)).toBe('ahead');
    expect(at(-11)).toBe('over');
    // 5% of 6 minutes is 18 s.
    expect(at(17, 360)).toBe('tight');
    expect(at(-19, 360)).toBe('over');
  });

  it('no rate, no prediction', () => {
    expect(predictFinish({ remainingWords: 10, wpm: 0, timerRemainingMs: 1000 })).toBeNull();
  });
});

describe('where the WPM comes from', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const at = (endedAt: number, wpm = 250): HistoryEntry => ({ startedAt: endedAt - 5 * MIN, endedAt, words: 1000, wpm });

  it('pickHistory names the rule it used', () => {
    expect(pickHistory([at(now - H)], now).rule).toBe('recent');
    expect(pickHistory([at(now - 24 * H)], now).rule).toBe('yesterday');
    const morning = pickHistory([at(new Date(2026, 9, 20, 9).getTime())], now);
    expect(morning.rule).toBe('lastMorning');
    expect(morning.day).toBe(new Date(2026, 9, 20).getTime());
    expect(pickHistory([at(now - 4 * H)], now).rule).toBe('none');
    expect(pickHistory([], now).rule).toBe('none');
  });

  it('blendSources splits the blend into shares that add up', () => {
    const b = blendSources({
      live: { wpm: 300, words: 300 },
      history: [at(now - H, 200), at(now - 2 * H, 260)],
      prior: 240,
    })!;
    expect(b.prior).toEqual({ wpm: 240, share: 150 / 1450 });
    expect(b.history!.count).toBe(2);
    expect(b.history!.wpm).toBeCloseTo(230, 6);
    expect(b.history!.share).toBeCloseTo(1000 / 1450, 6);
    expect(b.live!.share).toBeCloseTo(300 / 1450, 6);
    expect(b.wpm).toBeCloseTo((150 * 240 + 1000 * 230 + 300 * 300) / 1450, 6);
  });
});
