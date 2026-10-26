/**
 * Dynamic speech: the rate model. Pure math, no DOM.
 *
 * Rates are in BODY-EQUIVALENT words per minute: tag / cite / analytic
 * words are converted at Reader 1's `wpm / tagWpm`, so a live rate is
 * directly comparable to (and blendable with) the static `wpm` setting.
 */

import type { ReadAloudCounts, ReaderRates } from '../word-count.js';

/** Every tunable in one place. */
export const MODEL = {
  /** Weight of the static WPM, in words — grounds the first minute. */
  priorWeight: 150,
  /** History session weight = min(words, cap) × scale. */
  historyCap: 1500,
  historyScale: 0.5,
  /** No live rate before this much speaking time. */
  minLiveMs: 5_000,
  recentWindowMs: 3 * 3600_000,
  /** Latest session older than this → look at "this time yesterday". */
  staleAfterMs: 8 * 3600_000,
  yesterdaySpanMs: 2 * 3600_000,
  /** "Last morning" fallback: sessions within this of that day's first. */
  morningSpanMs: 3 * 3600_000,
  tightMinMs: 10_000,
  tightFraction: 0.05,
} as const;

/** How many body-words one tag-word costs for this reader. */
export function otherFactor(reader: ReaderRates | undefined): number {
  if (!reader || !(reader.wpm > 0)) return 1;
  const t = reader.tagWpm;
  return t != null && Number.isFinite(t) && t > 0 ? reader.wpm / t : 1;
}

export function equivalentWords(counts: ReadAloudCounts, factor: number): number {
  return counts.body + counts.other * factor;
}

export interface RatePoint {
  elapsedMs: number;
  /** Body-equivalent words read by then. */
  words: number;
}

export interface LiveRate {
  wpm: number;
  words: number;
}

/** Least-squares slope of words over minutes, with the speech start
 *  (0, 0) as an implicit first point. Null until there is enough data. */
export function liveRate(points: readonly RatePoint[]): LiveRate | null {
  const pts = [{ elapsedMs: 0, words: 0 }, ...points];
  const last = pts[pts.length - 1]!;
  if (last.elapsedMs < MODEL.minLiveMs || last.words <= 0) return null;
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.elapsedMs / 60_000; sy += p.words; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (const p of pts) {
    const dx = p.elapsedMs / 60_000 - mx;
    sxy += dx * (p.words - my);
    sxx += dx * dx;
  }
  if (sxx <= 0) return null;
  const wpm = sxy / sxx;
  if (!Number.isFinite(wpm) || wpm <= 0) return null;
  return { wpm, words: last.words };
}

export interface HistoryEntry {
  startedAt: number;
  endedAt: number;
  /** Body-equivalent words the session covered. */
  words: number;
  wpm: number;
}

/** Which history rule picked the sessions. */
export type HistoryRule = 'recent' | 'yesterday' | 'lastMorning' | 'none';

/** The sessions that say something about how fast you read right now:
 *  the last 3 h; or, if you haven't spoken in 8 h, ±2 h around this time
 *  yesterday; failing that, the morning of the latest day with data. */
export function pickHistory<T extends HistoryEntry>(
  sessions: readonly T[],
  now: number,
): { rule: HistoryRule; sessions: T[]; day: number | null } {
  const none = { rule: 'none' as const, sessions: [], day: null };
  const valid = sessions.filter((s) => s.wpm > 0 && s.words > 0 && s.endedAt <= now);
  if (valid.length === 0) return none;
  const latest = Math.max(...valid.map((s) => s.endedAt));
  if (now - latest <= MODEL.staleAfterMs) {
    const recent = valid.filter((s) => now - s.endedAt <= MODEL.recentWindowMs);
    return recent.length > 0 ? { rule: 'recent', sessions: recent, day: null } : none;
  }
  const yesterday = now - 24 * 3600_000;
  const around = valid.filter((s) => Math.abs(s.endedAt - yesterday) <= MODEL.yesterdaySpanMs);
  if (around.length > 0) return { rule: 'yesterday', sessions: around, day: null };
  const day = new Date(latest);
  day.setHours(0, 0, 0, 0);
  const sameDay = valid.filter((s) => s.startedAt >= day.getTime() && s.startedAt <= latest);
  if (sameDay.length === 0) return none;
  const first = Math.min(...sameDay.map((s) => s.startedAt));
  return {
    rule: 'lastMorning',
    sessions: sameDay.filter((s) => s.startedAt - first <= MODEL.morningSpanMs),
    day: day.getTime(),
  };
}

export function selectHistory<T extends HistoryEntry>(sessions: readonly T[], now: number): T[] {
  return pickHistory(sessions, now).sessions;
}

export interface SourceShare {
  wpm: number;
  /** Fraction of the blend, 0–1. */
  share: number;
}

/** The blend, and how much each source contributed to it. */
export interface Blend {
  wpm: number;
  live: (SourceShare & { words: number }) | null;
  history: (SourceShare & { count: number }) | null;
  prior: SourceShare | null;
}

/** Weighted mean of the static WPM, history, and the live rate. Null
 *  when there is nothing to go on. */
export function blendSources(input: {
  live: LiveRate | null;
  history: readonly HistoryEntry[];
  prior: number | null;
}): Blend | null {
  const pw = input.prior != null && input.prior > 0 ? MODEL.priorWeight : 0;
  let hw = 0, hsum = 0;
  for (const h of input.history) {
    const w = Math.min(h.words, MODEL.historyCap) * MODEL.historyScale;
    hw += w;
    hsum += w * h.wpm;
  }
  const lw = input.live ? input.live.words : 0;
  const total = pw + hw + lw;
  if (total <= 0) return null;
  const wpm = (pw * (input.prior ?? 0) + hsum + lw * (input.live?.wpm ?? 0)) / total;
  return {
    wpm,
    live: input.live && lw > 0 ? { wpm: input.live.wpm, words: input.live.words, share: lw / total } : null,
    history: hw > 0 ? { wpm: hsum / hw, count: input.history.length, share: hw / total } : null,
    prior: pw > 0 ? { wpm: input.prior!, share: pw / total } : null,
  };
}

export function blendWpm(input: Parameters<typeof blendSources>[0]): number | null {
  return blendSources(input)?.wpm ?? null;
}

export type FinishStatus = 'ahead' | 'tight' | 'over';

export interface FinishPrediction {
  neededMs: number;
  /** Time left minus time needed; negative = you won't make it. */
  slackMs: number;
  status: FinishStatus;
}

export function predictFinish(input: {
  remainingWords: number;
  wpm: number;
  timerRemainingMs: number;
}): FinishPrediction | null {
  if (!(input.wpm > 0)) return null;
  const neededMs = (Math.max(0, input.remainingWords) / input.wpm) * 60_000;
  const slackMs = input.timerRemainingMs - neededMs;
  const tol = Math.max(MODEL.tightMinMs, MODEL.tightFraction * Math.max(0, input.timerRemainingMs));
  const status: FinishStatus = slackMs > tol ? 'ahead' : slackMs < -tol ? 'over' : 'tight';
  return { neededMs, slackMs, status };
}
