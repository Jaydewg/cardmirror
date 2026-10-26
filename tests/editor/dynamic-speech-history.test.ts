// @vitest-environment jsdom
/**
 * Saved dynamic-speech sessions (dynamic-speech/history-store.ts):
 * newest first, pruned after 5 days, add / remove / clear.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  HISTORY_KEEP_MS,
  addSpeechSession,
  clearSpeechSessions,
  listSpeechSessions,
  removeSpeechSession,
  subscribeSpeechSessions,
  type SpeechSession,
} from '../../src/editor/dynamic-speech/history-store.js';

const now = Date.UTC(2026, 9, 23, 12);

function session(id: string, endedAt: number): SpeechSession {
  return {
    id,
    startedAt: endedAt - 300_000,
    endedAt,
    words: 1200,
    wpm: 240,
    docName: 'aff.cmir',
    mode: 'countdown',
    durationMs: 360_000,
    elapsedMs: 300_000,
    points: [{ elapsedMs: 300_000, body: 1100, other: 100 }],
    excludedWords: 0,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('speech history store', () => {
  it('lists newest first', () => {
    addSpeechSession(session('a', now - 3000), now);
    addSpeechSession(session('b', now - 1000), now);
    expect(listSpeechSessions(now).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('prunes sessions older than 5 days, on write and on read', () => {
    addSpeechSession(session('old', now - HISTORY_KEEP_MS - 1), now - HISTORY_KEEP_MS);
    addSpeechSession(session('new', now), now);
    expect(listSpeechSessions(now).map((s) => s.id)).toEqual(['new']);
    addSpeechSession(session('aging', now - HISTORY_KEEP_MS + 10), now);
    expect(listSpeechSessions(now + 20).map((s) => s.id)).toEqual(['new']);
  });

  it('remove, clear, and listeners', () => {
    const seen: number[] = [];
    const off = subscribeSpeechSessions((items) => seen.push(items.length));
    addSpeechSession(session('a', now), now);
    addSpeechSession(session('b', now), now);
    removeSpeechSession('a');
    expect(listSpeechSessions(now).map((s) => s.id)).toEqual(['b']);
    clearSpeechSessions();
    expect(listSpeechSessions(now)).toEqual([]);
    off();
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('cardmirror-speech-history-v1', '{not json');
    expect(listSpeechSessions(now)).toEqual([]);
    localStorage.setItem('cardmirror-speech-history-v1', JSON.stringify([{ id: 1 }, session('ok', now)]));
    expect(listSpeechSessions(now).map((s) => s.id)).toEqual(['ok']);
  });
});
