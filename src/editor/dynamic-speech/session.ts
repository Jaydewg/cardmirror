/**
 * Dynamic speech: one armed session per window.
 *
 * Positions (time marks, skipped / clipped ranges, the undo stack) live
 * in the armed view's plugin state under `dynamicSpeechKey`, so they map
 * through every edit like any other decoration. This module owns the
 * rest: arming, the speaking clock (driven by timer-state, pauses
 * excluded), the key actions, the summary the displays render, and
 * saving to Speech History when the session ends.
 */

import { PluginKey, Selection, TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { settings, type DynamicSpeechAction } from '../settings.js';
import { countReadAloudSplit, type ReadAloudCounts } from '../word-count.js';
import { findEnclosingContainer } from '../live-read-time.js';
import { closeHistory } from 'prosemirror-history';
import { schema } from '../../schema/index.js';
import {
  READING_MARKER_COLOR,
  READING_MARKER_META,
  formatMarkerTime,
  isMarkerText,
} from '../reading-marker.js';
import { getTimerState, getVisibleRemainingMs, isStopwatch, startTimer, subscribeTimer, type TimerState } from '../timer-state.js';
import { showToast } from '../toast.js';
import {
  addExcluded,
  mapExcluded,
  warmSpeechIndex,
  wordsRead,
  wordsRemaining,
  type ExcludedRange,
} from './speech-index.js';
import {
  blendSources,
  equivalentWords,
  liveRate,
  otherFactor,
  pickHistory,
  predictFinish,
  type Blend,
  type FinishStatus,
  type HistoryRule,
} from './wpm-model.js';
import { addSpeechSession, listSpeechSessions, subscribeSpeechSessions, type SpeechSession } from './history-store.js';

// ─── Per-view state (lives in the plugin) ─────────────────────────

export interface SpeechPoint {
  elapsedMs: number;
  pos: number;
  /** Words read since the start, skipped / clipped words excluded. */
  body: number;
  other: number;
  kind: 'mark' | 'clip';
}

interface UndoEntry {
  pointCount: number;
  excluded: ExcludedRange[];
  /** The reading marker this press dropped, to take back out. */
  marker: { from: number; to: number } | null;
  /** Where the caret was before the press moved it on. */
  cursor: number;
}

export interface SpeechDocState {
  armed: boolean;
  startPos: number;
  startCounts: ReadAloudCounts;
  points: SpeechPoint[];
  excluded: ExcludedRange[];
  undo: UndoEntry[];
  /** Bumped when someone else's reading marker lands, so the view can
   *  start an idle timer off a marker at the top of the doc. */
  markerSeq: number;
  markerPos: number;
}

type SpeechMeta =
  | { type: 'arm'; startPos: number }
  | { type: 'disarm' }
  | {
      type: 'push';
      point: SpeechPoint | null;
      exclude: { from: number; to: number } | null;
      marker: { from: number; to: number } | null;
      cursor: number;
    }
  | { type: 'undo' };

export const dynamicSpeechKey = new PluginKey<SpeechDocState>('dynamicSpeech');

const ZERO: ReadAloudCounts = { body: 0, other: 0 };

export function initialSpeechState(): SpeechDocState {
  return { armed: false, startPos: 0, startCounts: ZERO, points: [], excluded: [], undo: [], markerSeq: 0, markerPos: 0 };
}

function mapState(s: SpeechDocState, tr: Transaction): SpeechDocState {
  const m = tr.mapping;
  return {
    ...s,
    startPos: m.map(s.startPos, -1),
    points: s.points.map((p) => ({ ...p, pos: m.map(p.pos, -1) })),
    excluded: mapExcluded(s.excluded, m, tr.doc),
    undo: s.undo.map((u) => ({
      ...u,
      excluded: mapExcluded(u.excluded, m, tr.doc),
      marker: u.marker ? { from: m.map(u.marker.from, 1), to: m.map(u.marker.to, -1) } : null,
      cursor: m.map(u.cursor, -1),
    })),
  };
}

/** The plugin's `apply`. Pure. `prevHead` is the caret before `tr`. */
export function reduceSpeechState(prev: SpeechDocState, tr: Transaction, prevHead: number): SpeechDocState {
  let s = prev;
  if (!s.armed && !tr.getMeta(dynamicSpeechKey)) return s;
  if (tr.docChanged) s = mapState(s, tr);
  const meta = tr.getMeta(dynamicSpeechKey) as SpeechMeta | undefined;
  if (!meta) {
    if (tr.docChanged && tr.getMeta(READING_MARKER_META) === true) {
      s = { ...s, markerSeq: s.markerSeq + 1, markerPos: tr.mapping.map(prevHead, -1) };
    }
    return s;
  }
  switch (meta.type) {
    case 'arm':
      return {
        ...initialSpeechState(),
        armed: true,
        startPos: meta.startPos,
        startCounts: wordsRead(tr.doc, meta.startPos, []),
        markerSeq: s.markerSeq,
      };
    case 'disarm':
      return { ...initialSpeechState(), markerSeq: s.markerSeq };
    case 'push':
      return {
        ...s,
        undo: [...s.undo, { pointCount: s.points.length, excluded: s.excluded, marker: meta.marker, cursor: meta.cursor }],
        points: meta.point ? [...s.points, meta.point] : s.points,
        excluded: meta.exclude ? addExcluded(tr.doc, s.excluded, meta.exclude.from, meta.exclude.to) : s.excluded,
      };
    case 'undo': {
      const entry = s.undo[s.undo.length - 1];
      if (!entry) return s;
      return { ...s, undo: s.undo.slice(0, -1), points: s.points.slice(0, entry.pointCount), excluded: entry.excluded };
    }
  }
}

export function speechStateOf(view: EditorView): SpeechDocState | undefined {
  return dynamicSpeechKey.getState(view.state);
}

// ─── The window's session ─────────────────────────────────────────

export interface DynamicSpeechHooks {
  /** The view a session arms against (the focused pane). */
  activeView(): EditorView | null;
  enterReadMode?(view: EditorView): void;
  docName?(view: EditorView): string | null;
}

let hooks: DynamicSpeechHooks = { activeView: () => null };

export function configureDynamicSpeech(h: DynamicSpeechHooks): void {
  hooks = h;
}

interface Run {
  view: EditorView;
  armedAt: number;
  docName: string | null;
  /** Speaking time banked at the last pause. */
  accumMs: number;
  runSince: number | null;
  durationMs: number | null;
  lastKeyAt: Partial<Record<DynamicSpeechAction, number>>;
}

let run: Run | null = null;

function speechRunning(s: TimerState): boolean {
  return s.running && s.mode === 'speech';
}

function elapsedNow(r: Run, now: number): number {
  return r.accumMs + (r.runSince !== null ? Math.max(0, now - r.runSince) : 0);
}

/** The run, if its view is still armed; a run whose view was destroyed
 *  or replaced its state ends (and saves) here. */
function liveRun(): Run | null {
  if (!run) return null;
  if (run.view.isDestroyed || !speechStateOf(run.view)?.armed) endDynamicSpeech();
  return run;
}

export function isSpeechArmed(view?: EditorView): boolean {
  const r = liveRun();
  return !!r && (view === undefined || r.view === view);
}

/** In-speech keys act only on the armed view, while the clock runs. */
export function speechKeysLive(view: EditorView): boolean {
  return isSpeechArmed(view) && settings.get('dynamicSpeechKeysEnabled') && speechRunning(getTimerState());
}

export function armDynamicSpeech(view: EditorView | null = hooks.activeView()): boolean {
  if (!view) return false;
  if (liveRun()?.view === view) return true;
  if (run) endDynamicSpeech();
  if (settings.get('dynamicSpeechEnterReadMode')) hooks.enterReadMode?.(view);
  warmSpeechIndex(view.state.doc);
  // Counting starts at the top of the unit you're in: Space means "done
  // with this card", so the card the caret sits in is read in full.
  const startPos = unitAt(view.state.doc, view.state.selection.head).from;
  view.dispatch(view.state.tr.setMeta(dynamicSpeechKey, { type: 'arm', startPos } satisfies SpeechMeta));
  const now = Date.now();
  const t = getTimerState();
  run = {
    view,
    armedAt: now,
    docName: hooks.docName?.(view) ?? null,
    accumMs: 0,
    runSince: speechRunning(t) ? now : null,
    durationMs: speechRunning(t) && !isStopwatch(t) ? getVisibleRemainingMs(t, now) : null,
    lastKeyAt: {},
  };
  syncTicker();
  notify();
  return true;
}

export function endDynamicSpeech(save = true): void {
  const r = run;
  if (!r) return;
  run = null;
  const now = Date.now();
  if (r.runSince !== null) {
    r.accumMs = elapsedNow(r, now);
    r.runSince = null;
  }
  if (!r.view.isDestroyed) {
    const ds = speechStateOf(r.view);
    if (save && ds?.armed) saveRun(r, ds, now);
    if (ds?.armed) r.view.dispatch(r.view.state.tr.setMeta(dynamicSpeechKey, { type: 'disarm' } satisfies SpeechMeta));
  }
  syncTicker();
  notify();
}

function reader1() {
  return settings.get('readers')[0];
}

function saveRun(r: Run, ds: SpeechDocState, now: number): void {
  if (ds.points.length < 2) return;
  const factor = otherFactor(reader1());
  const live = liveRate(ds.points.map((p) => ({ elapsedMs: p.elapsedMs, words: equivalentWords(p, factor) })));
  if (!live) return;
  const t = getTimerState();
  const session: SpeechSession = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: r.armedAt,
    endedAt: now,
    words: live.words,
    wpm: live.wpm,
    docName: r.docName,
    mode: r.durationMs === null || isStopwatch(t) ? 'stopwatch' : 'countdown',
    durationMs: r.durationMs ?? 0,
    elapsedMs: r.accumMs,
    points: ds.points.map((p) => ({ elapsedMs: p.elapsedMs, body: p.body, other: p.other })),
    excludedWords: ds.excluded.reduce((n, x) => n + x.counts.body + x.counts.other, 0),
  };
  addSpeechSession(session, now);
}

// ─── Actions ──────────────────────────────────────────────────────

function debounced(r: Run, action: DynamicSpeechAction, now: number): boolean {
  const last = r.lastKeyAt[action];
  if (last !== undefined && now - last < settings.get('dynamicSpeechDebounceMs')) return true;
  r.lastKeyAt[action] = now;
  return false;
}

function countsAt(doc: PMNode, pos: number, ds: SpeechDocState): ReadAloudCounts {
  const read = wordsRead(doc, pos, ds.excluded);
  return {
    body: Math.max(0, read.body - ds.startCounts.body),
    other: Math.max(0, read.other - ds.startCounts.other),
  };
}

/** The top-level child holding `pos` (cards and analytic units are
 *  top-level; so are headings and loose paragraphs). */
export function unitAt(doc: PMNode, pos: number): { from: number; to: number } {
  if (doc.childCount === 0) return { from: 0, to: 0 };
  const i = Math.min(doc.resolve(pos).index(0), doc.childCount - 1);
  let from = 0;
  for (let k = 0; k < i; k++) from += doc.child(k).nodeSize;
  return { from, to: from + doc.child(i).nodeSize };
}

/** The caret spot at the start of the next unit at or after `from`
 *  that has something to read aloud (headings are passed over), or the
 *  end of the doc. */
export function nextUnitCursor(doc: PMNode, from: number): number {
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (pos >= from) {
      const c = countReadAloudSplit(child);
      if (c.body + c.other > 0) {
        const sel = TextSelection.findFrom(doc.resolve(pos), 1, true);
        if (sel) return sel.head;
      }
    }
    pos += child.nodeSize;
  }
  return Selection.atEnd(doc).head;
}

/** Last caret spot inside the unit [from, to) — where a "read up to
 *  here" marker goes. */
function unitEndCursor(doc: PMNode, unit: { from: number; to: number }): number | null {
  const sel = Selection.findFrom(doc.resolve(unit.to), -1, true);
  return sel && sel.head > unit.from ? sel.head : null;
}

/** Move the caret to `pos` (mapped through `tr`) and bring it into view. */
function advance(tr: Transaction, pos: number): Transaction {
  const at = Math.min(tr.mapping.map(pos, 1), tr.doc.content.size);
  return tr.setSelection(Selection.near(tr.doc.resolve(at), 1)).scrollIntoView();
}

function push(
  view: EditorView,
  tr: Transaction,
  meta: Omit<Extract<SpeechMeta, { type: 'push' }>, 'type' | 'cursor'>,
  cursorBefore: number,
): void {
  const cursor = tr.mapping.map(cursorBefore, -1);
  view.dispatch(tr.setMeta(dynamicSpeechKey, { type: 'push', ...meta, cursor } satisfies SpeechMeta));
}

/** Space: done with the card (or analytic, or paragraph) the caret is
 *  in. Logs the time at its end and moves the caret to the next one. */
export function speechTimeMark(): boolean {
  const r = liveRun();
  if (!r) return false;
  const now = Date.now();
  if (debounced(r, 'timeMark', now)) return true;
  const view = r.view;
  const state = view.state;
  const ds = speechStateOf(view)!;
  const head = state.selection.head;
  const unit = unitAt(state.doc, head);
  const point: SpeechPoint = { elapsedMs: elapsedNow(r, now), pos: unit.to, ...countsAt(state.doc, unit.to, ds), kind: 'mark' };
  let tr = state.tr;
  let marker: { from: number; to: number } | null = null;
  const markAt = settings.get('dynamicSpeechSpaceAlsoMarks') ? unitEndCursor(state.doc, unit) : null;
  const fontColor = schema.marks['font_color'];
  if (markAt !== null && fontColor) {
    // "Read up to here", at the end of the card just finished.
    const node = schema.text(`Marked ${formatMarkerTime(new Date(now))}`, [fontColor.create({ color: READING_MARKER_COLOR })]);
    tr = tr.insert(markAt, node).setMeta(READING_MARKER_META, true);
    closeHistory(tr);
    marker = { from: markAt, to: markAt + node.nodeSize };
  }
  point.pos = tr.mapping.map(unit.to, 1);
  tr = advance(tr, nextUnitCursor(state.doc, unit.to));
  push(view, tr, { point, exclude: null, marker }, head);
  notify();
  return true;
}

const SKIP_PARENTS = new Set(['tag', 'analytic', 'cite_paragraph', 'block']);

/** On a tag / cite / analytic (or a block heading): skip the whole card
 *  (or block). In the body: you're here, and the rest of the card won't
 *  be read. Either way the caret moves on past it. */
export function speechSkipOrClip(): boolean {
  const r = liveRun();
  if (!r) return false;
  const now = Date.now();
  if (debounced(r, 'skipClip', now)) return true;
  const view = r.view;
  const state = view.state;
  const ds = speechStateOf(view)!;
  const container = findEnclosingContainer(state);
  const $from = state.selection.$from;
  const head = state.selection.head;
  const onHeading =
    SKIP_PARENTS.has($from.parent.type.name) || $from.marks().some((m) => m.type.name === 'cite_mark');
  let point: SpeechPoint | null = null;
  let exclude: { from: number; to: number };
  if (container && (container.label === 'Block' ? $from.parent.type.name === 'block' : onHeading)) {
    exclude = { from: container.from, to: container.to };
  } else if (container && container.label !== 'Block') {
    point = { elapsedMs: elapsedNow(r, now), pos: head, ...countsAt(state.doc, head, ds), kind: 'clip' };
    exclude = { from: head, to: container.to };
  } else {
    showToast('Put the cursor in a card to skip or clip it');
    return true;
  }
  const tr = advance(state.tr, nextUnitCursor(state.doc, exclude.to));
  push(view, tr, { point, exclude, marker: null }, head);
  notify();
  return true;
}

/** Take back the last mark / skip / clip: the marker it dropped comes
 *  out and the caret goes back to where it was. */
export function speechUndo(): boolean {
  const r = liveRun();
  if (!r) return false;
  const now = Date.now();
  if (debounced(r, 'undo', now)) return true;
  const view = r.view;
  const state = view.state;
  const entry = speechStateOf(view)!.undo.at(-1);
  if (!entry) return true;
  let tr = state.tr;
  const m = entry.marker;
  if (m && m.to > m.from && m.to <= state.doc.content.size) {
    let allMarker = true;
    state.doc.nodesBetween(m.from, m.to, (node) => {
      if (node.isText && !isMarkerText(node)) allMarker = false;
    });
    if (allMarker) tr = tr.delete(m.from, m.to).setMeta(READING_MARKER_META, true);
  }
  tr = advance(tr, entry.cursor);
  view.dispatch(tr.setMeta(dynamicSpeechKey, { type: 'undo' } satisfies SpeechMeta));
  notify();
  return true;
}

export function runSpeechAction(action: DynamicSpeechAction): boolean {
  if (action === 'timeMark') return speechTimeMark();
  if (action === 'skipClip') return speechSkipOrClip();
  return speechUndo();
}

/** A reading marker dropped at the top of the doc (before any word that
 *  is read aloud) while armed and idle starts the speech clock. */
export function onReadingMarkerPlaced(view: EditorView, pos: number): void {
  if (!isSpeechArmed(view)) return;
  const t = getTimerState();
  if (t.running || t.mode !== 'speech') return;
  const before = wordsRead(view.state.doc, pos, []);
  if (before.body + before.other === 0) startTimer();
}

// ─── Summary for the displays ─────────────────────────────────────

export interface SpeechSummary {
  active: boolean;
  /** Blended rate (body-equivalent words per minute). */
  wpm: number | null;
  /** This speech's own measured rate, once there is enough of it. */
  measuredWpm: number | null;
  /** What went into `wpm`, and which history rule picked the sessions. */
  blend: Blend | null;
  historyRule: HistoryRule;
  /** The day a "last morning" history came from. */
  historyDay: number | null;
  priorName: string | null;
  /** Time still needed at that rate. */
  liveReadMs: number | null;
  /** Countdown only. */
  status: FinishStatus | null;
  slackMs: number | null;
  stopwatch: boolean;
}

const INACTIVE: SpeechSummary = {
  active: false,
  wpm: null,
  measuredWpm: null,
  blend: null,
  historyRule: 'none',
  historyDay: null,
  priorName: null,
  liveReadMs: null,
  status: null,
  slackMs: null,
  stopwatch: false,
};

let historyCache: SpeechSession[] | null = null;
subscribeSpeechSessions(() => { historyCache = null; });

/** The blend's inputs right now, armed or not (Speech History shows
 *  what the next speech would start from). */
export function currentBlend(now: number = Date.now(), state?: SpeechDocState): Pick<
  SpeechSummary,
  'wpm' | 'measuredWpm' | 'blend' | 'historyRule' | 'historyDay' | 'priorName'
> {
  const r1 = reader1();
  const factor = otherFactor(r1);
  const live = state ? liveRate(state.points.map((p) => ({ elapsedMs: p.elapsedMs, words: equivalentWords(p, factor) }))) : null;
  historyCache ??= listSpeechSessions(now);
  const history = pickHistory(historyCache, now);
  const blend = blendSources({ live, history: history.sessions, prior: r1?.wpm ?? null });
  return {
    wpm: blend?.wpm ?? null,
    measuredWpm: live?.wpm ?? null,
    blend,
    historyRule: history.rule,
    historyDay: history.day,
    priorName: r1?.name ?? null,
  };
}

export function getSpeechSummary(now: number = Date.now()): SpeechSummary {
  const r = liveRun();
  if (!r) return INACTIVE;
  const ds = speechStateOf(r.view)!;
  const doc = r.view.state.doc;
  const factor = otherFactor(reader1());
  const rates = currentBlend(now, ds);
  const wpm = rates.wpm;
  const t = getTimerState();
  const stopwatch = isStopwatch(t);
  const base = { ...INACTIVE, ...rates, active: true, stopwatch };
  if (wpm === null) return base;
  const last = ds.points[ds.points.length - 1];
  const anchorPos = last ? last.pos : ds.startPos;
  const anchorMs = last ? last.elapsedMs : 0;
  const atAnchor = equivalentWords(wordsRemaining(doc, anchorPos, ds.excluded), factor);
  // Between presses, assume you kept reading at the blended rate — but
  // not past the end of the card you're on (the next Space says so).
  const unit = unitAt(doc, r.view.state.selection.head);
  const afterUnit = equivalentWords(wordsRemaining(doc, Math.max(unit.to, anchorPos), ds.excluded), factor);
  const since = Math.max(0, elapsedNow(r, now) - anchorMs);
  const remaining = Math.max(afterUnit, atAnchor - (wpm * since) / 60_000, 0);
  const liveReadMs = (remaining / wpm) * 60_000;
  if (stopwatch || t.mode !== 'speech') return { ...base, liveReadMs };
  const p = predictFinish({ remainingWords: remaining, wpm, timerRemainingMs: getVisibleRemainingMs(t, now) });
  return { ...base, liveReadMs, status: p?.status ?? null, slackMs: p?.slackMs ?? null };
}

// ─── Change notification ──────────────────────────────────────────

const listeners = new Set<(s: SpeechSummary) => void>();

export function subscribeSession(fn: (s: SpeechSummary) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const CHANNEL_NAME = 'cardmirror-dynspeech-v1';
let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(CHANNEL_NAME);
} catch {
  channel = null;
}

let lastSummary: SpeechSummary = INACTIVE;

/** The summary as of the last change or clock tick (cheap; displays
 *  that refresh on their own schedule read this). */
export function lastSpeechSummary(): SpeechSummary {
  return lastSummary;
}

function notify(): void {
  const summary = getSpeechSummary();
  lastSummary = summary;
  for (const fn of listeners) fn(summary);
  try {
    channel?.postMessage(summary);
  } catch {
    // Closed during teardown.
  }
}

/** For windows without an editor (the timer pop-out): the armed
 *  window's summaries. */
export function subscribeRemoteSpeechSummary(fn: (s: SpeechSummary) => void): () => void {
  if (!channel) return () => {};
  const onMessage = (e: MessageEvent): void => {
    if (e.data && typeof e.data === 'object' && 'active' in e.data) fn(e.data as SpeechSummary);
  };
  channel.addEventListener('message', onMessage);
  return () => channel?.removeEventListener('message', onMessage);
}

let ticker: ReturnType<typeof setInterval> | null = null;

/** While a session's clock runs, the finish estimate moves every second. */
function syncTicker(): void {
  const want = !!run && run.runSince !== null;
  if (want && ticker === null) ticker = setInterval(notify, 1000);
  else if (!want && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

// ─── Timer coupling ───────────────────────────────────────────────

const WINDOW_ID = Math.random().toString(36).slice(2);
const FOCUS_KEY = 'cardmirror-last-focused-window';

function noteFocus(): void {
  try {
    localStorage.setItem(FOCUS_KEY, WINDOW_ID);
  } catch {
    // No storage: focus alone decides.
  }
}

/** Auto-arm only in the window the speaker was last in — a Start from
 *  the pop-out or another window must not arm every open window. */
function ownsAutoArm(): boolean {
  if (typeof document !== 'undefined' && document.hasFocus()) return true;
  try {
    return localStorage.getItem(FOCUS_KEY) === WINDOW_ID;
  } catch {
    return false;
  }
}

/** A stop that is a Reset (not a pause): a stopwatch that stopped being
 *  one, or a countdown zeroed without having run out. */
function isResetStop(s: TimerState, prev: TimerState): boolean {
  return (prev.stopwatch && !s.stopwatch) || (!s.stopwatch && s.speechBaseRemainingMs === 0 && s.expiredMode === null);
}

/** Re-armed while stopped: a preset, a typed time, or Reset. */
function isRearm(s: TimerState, prev: TimerState): boolean {
  return (
    s.speechBaseRemainingMs !== prev.speechBaseRemainingMs ||
    s.stopwatch !== prev.stopwatch ||
    s.speechStopwatchBaseMs !== prev.speechStopwatchBaseMs ||
    (prev.expiredMode !== null && s.expiredMode === null)
  );
}

export function onTimerChange(prev: TimerState, s: TimerState, now: number = Date.now()): void {
  const was = speechRunning(prev);
  const is = speechRunning(s);
  const r = liveRun();
  if (!r) {
    if (!was && is && settings.get('dynamicSpeechAutoArm') && ownsAutoArm()) armDynamicSpeech();
    return;
  }
  if (was && !is) {
    r.accumMs = elapsedNow(r, now);
    r.runSince = null;
    if (s.mode !== 'speech' || isResetStop(s, prev)) {
      endDynamicSpeech();
      return;
    }
  } else if (!was && is) {
    r.runSince = now;
    if (r.durationMs === null && !isStopwatch(s)) r.durationMs = getVisibleRemainingMs(s, now) + r.accumMs;
  } else if (!is && (s.mode !== 'speech' || isRearm(s, prev))) {
    endDynamicSpeech();
    return;
  }
  syncTicker();
  notify();
}

/** Wire the timer and focus tracking. Called once from the editor's boot. */
export function installDynamicSpeech(): void {
  let prev = getTimerState();
  subscribeTimer((s) => {
    const p = prev;
    prev = s;
    onTimerChange(p, s);
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', noteFocus);
    if (document.hasFocus()) noteFocus();
  }
}

/** Tests only. */
export function __resetDynamicSpeechForTests(): void {
  run = null;
  historyCache = null;
  lastSummary = INACTIVE;
  syncTicker();
}
