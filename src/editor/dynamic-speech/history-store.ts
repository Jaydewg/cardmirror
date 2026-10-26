/**
 * Saved dynamic-speech sessions, kept 5 days. localStorage (small, and
 * shared by every window); other windows hear about writes through the
 * `storage` event.
 */

import type { HistoryEntry } from './wpm-model.js';

const STORAGE_KEY = 'cardmirror-speech-history-v1';
export const HISTORY_KEEP_MS = 5 * 24 * 3600_000;

export interface SpeechSession extends HistoryEntry {
  id: string;
  docName: string | null;
  mode: 'countdown' | 'stopwatch';
  /** Countdown length; 0 for a stopwatch. */
  durationMs: number;
  /** Speaking time (pauses excluded). */
  elapsedMs: number;
  points: { elapsedMs: number; body: number; other: number }[];
  excludedWords: number;
}

type Listener = (items: SpeechSession[]) => void;
const listeners = new Set<Listener>();

function valid(e: unknown): e is SpeechSession {
  if (!e || typeof e !== 'object') return false;
  const s = e as Record<string, unknown>;
  return (
    typeof s['id'] === 'string' &&
    typeof s['startedAt'] === 'number' &&
    typeof s['endedAt'] === 'number' &&
    typeof s['words'] === 'number' &&
    typeof s['wpm'] === 'number' &&
    Array.isArray(s['points'])
  );
}

function read(): SpeechSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function write(items: SpeechSession[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage off / full: this window still sees the change below.
  }
  for (const fn of listeners) fn(items);
}

function pruned(items: SpeechSession[], now: number): SpeechSession[] {
  return items.filter((s) => now - s.endedAt <= HISTORY_KEEP_MS);
}

/** Saved sessions, newest first. Prunes on read. */
export function listSpeechSessions(now: number = Date.now()): SpeechSession[] {
  const all = read();
  const kept = pruned(all, now);
  if (kept.length !== all.length) write(kept);
  return kept.sort((a, b) => b.endedAt - a.endedAt);
}

export function addSpeechSession(s: SpeechSession, now: number = Date.now()): void {
  write(pruned([s, ...read().filter((x) => x.id !== s.id)], now));
}

export function removeSpeechSession(id: string): void {
  write(read().filter((s) => s.id !== id));
}

export function clearSpeechSessions(): void {
  write([]);
}

export function subscribeSpeechSessions(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    const items = read();
    for (const fn of listeners) fn(items);
  });
}
