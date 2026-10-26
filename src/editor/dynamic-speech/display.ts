/**
 * Dynamic speech readouts, shared by the word-count bar, the pane
 * footers, the timer panel and Speech History so they read the same.
 */

import type { EditorState } from 'prosemirror-state';
import { settings, type DynamicSpeechItem, type ReaderConfig } from '../settings.js';
import { formatNumber } from '../word-count.js';
import { otherFactor } from './wpm-model.js';
import { currentBlend, dynamicSpeechKey, lastSpeechSummary, type SpeechSummary } from './session.js';

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "WPM 287", "Measured 301", "Finish −0:12", "Live 2:41" — in that
 *  order, for the items asked for. Empty when there is nothing to say. */
export function speechStatusParts(s: SpeechSummary, items: readonly DynamicSpeechItem[]): string[] {
  if (!s.active) return [];
  const parts: string[] = [];
  if (items.includes('wpm') && s.wpm !== null) parts.push(`WPM ${Math.round(s.wpm)}`);
  if (items.includes('measured')) parts.push(`Measured ${s.measuredWpm !== null ? Math.round(s.measuredWpm) : '—'}`);
  if (items.includes('finish') && s.slackMs !== null) {
    parts.push(`Finish ${s.slackMs >= 0 ? '+' : '−'}${formatClock(Math.abs(s.slackMs))}`);
  }
  if (items.includes('live') && s.liveReadMs !== null) parts.push(`Live ${formatClock(s.liveReadMs)}`);
  return parts;
}

export function speechStatusText(s: SpeechSummary, items: readonly DynamicSpeechItem[]): string {
  return speechStatusParts(s, items).join(' · ');
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Where the history part of the blend comes from, in words. */
export function historyRuleText(rule: SpeechSummary['historyRule'], day: number | null): string {
  if (rule === 'recent') return 'from the last 3 hours';
  if (rule === 'yesterday') return 'from around this time yesterday';
  if (rule === 'lastMorning' && day !== null) {
    return `from the morning of ${new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}`;
  }
  return '';
}

/** One line per source of the blended WPM, with its share. */
export function speechSourceLines(
  s: Pick<SpeechSummary, 'wpm' | 'blend' | 'historyRule' | 'historyDay' | 'priorName'>,
  opts: { inSpeech: boolean },
): string[] {
  const b = s.blend;
  const lines: string[] = [];
  if (opts.inSpeech) {
    lines.push(
      b?.live
        ? `This speech: ${Math.round(b.live.wpm)} WPM measured over ${formatNumber(Math.round(b.live.words))} words (${pct(b.live.share)})`
        : 'This speech: not measured yet (press Space at the end of each card)',
    );
  }
  lines.push(
    b?.history
      ? `Saved speeches: ${Math.round(b.history.wpm)} WPM, ${b.history.count} ${b.history.count === 1 ? 'speech' : 'speeches'} ${historyRuleText(s.historyRule, s.historyDay)} (${pct(b.history.share)})`
      : 'Saved speeches: none recent enough to use',
  );
  lines.push(
    b?.prior
      ? `${s.priorName ?? 'Reader 1'}'s WPM setting: ${Math.round(b.prior.wpm)} (${pct(b.prior.share)})`
      : 'No reader WPM set',
  );
  return lines;
}

/** Tooltip for a readout: the blend and what went into it. */
export function speechSourceTitle(s: SpeechSummary): string {
  if (!s.active) return '';
  const head = s.wpm !== null ? `WPM ${Math.round(s.wpm)} is a blend of:` : 'No WPM to go on yet.';
  return [head, ...speechSourceLines(s, { inSpeech: true }).map((l) => `• ${l}`)].join('\n');
}

export const STATUS_CLASSES = ['pmd-ds-ahead', 'pmd-ds-tight', 'pmd-ds-over'] as const;

export function speechStatusClass(s: SpeechSummary): string | null {
  return s.active && s.status ? `pmd-ds-${s.status}` : null;
}

/** Paint a readout element: text, status color, tooltip, hidden when empty. */
export function paintSpeechStatus(el: HTMLElement, s: SpeechSummary, items: readonly DynamicSpeechItem[]): void {
  const text = speechStatusText(s, items);
  el.textContent = text;
  el.hidden = text === '';
  el.title = text ? speechSourceTitle(s) : '';
  el.classList.remove(...STATUS_CLASSES);
  const cls = items.includes('finish') ? speechStatusClass(s) : null;
  if (cls) el.classList.add(cls);
}

/** The word count's extra reader: "Live" (the session's blended rate)
 *  for the armed doc; otherwise, with `dynamicSpeechIdleReadTimes`,
 *  "Dynamic" (saved speeches + Reader 1, no live part). Reader 1's
 *  tag/body ratio either way. */
export function liveReaderFor(state: EditorState): ReaderConfig | null {
  const armed = !!dynamicSpeechKey.getState(state)?.armed;
  let wpm: number | null = null;
  let name: string;
  if (armed) {
    if (!settings.get('dynamicSpeechWordCountItems').includes('live')) return null;
    wpm = lastSpeechSummary().wpm;
    name = 'Live';
  } else {
    if (!settings.get('dynamicSpeechIdleReadTimes')) return null;
    const b = currentBlend();
    // With no saved speeches it would only repeat Reader 1.
    if (!b.blend?.history) return null;
    wpm = b.wpm;
    name = 'Dynamic';
  }
  if (wpm === null) return null;
  const factor = otherFactor(settings.get('readers')[0]);
  return { name, wpm: Math.round(wpm), tagWpm: Math.round(wpm / factor) };
}

/** The word-count bar's own readout leaves `live` to the Live reader. */
export function wordCountItems(): DynamicSpeechItem[] {
  return settings.get('dynamicSpeechWordCountItems').filter((i) => i !== 'live');
}
