// @vitest-environment jsdom
/**
 * Web in-place save — the blocked-write ladder.
 *
 * Field case (ChromeOS, 2026-08-01): Chromium's swap-file write throws
 * InvalidStateError ("An operation that depends on state cached in an
 * interface object was made but the state had changed since it was read
 * from disk") saving to cloud-backed Files-app mounts (Dropbox, Google
 * Drive) — deterministically, on every retry. Before the ladder, the raw
 * DOMException surfaced in the Save-failed alert with no way forward:
 * the EMODIFIED-based changed-on-disk guard never matches browser
 * errors, and the force-retry path was an ignored no-op on web.
 *
 * The contract under test: one refresh-and-retry (getFile → pause →
 * createWritable again) for the transient variant, then a marked
 * 'EWRITEBLOCKED:' error for the deterministic one so save flows route
 * to Save-As instead of dead-ending. Non-retriable errors pass through
 * untouched — NotFoundError must keep its name for isFileGoneError's
 * rescue dialog.
 */

import { describe, it, expect, vi } from 'vitest';
import { BrowserHost } from '../../src/editor/host/browser-host.js';
import { isWriteBlockedError, isFileGoneError } from '../../src/editor/error-surface.js';

const invalidState = (): DOMException =>
  new DOMException(
    'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.',
    'InvalidStateError',
  );

/** Fake FileSystemFileHandle whose createWritable fails `failures` times
 *  before succeeding. Records every call the ladder makes. */
function fakeHandle(failures: number, err: () => DOMException = invalidState) {
  const calls = { createWritable: 0, getFile: 0, write: 0, close: 0 };
  let remaining = failures;
  return {
    calls,
    name: 'test.cmir',
    queryPermission: async () => 'granted' as const,
    getFile: async () => {
      calls.getFile++;
      return new File([''], 'test.cmir');
    },
    createWritable: async () => {
      calls.createWritable++;
      if (remaining > 0) {
        remaining--;
        throw err();
      }
      return {
        write: async () => {
          calls.write++;
        },
        close: async () => {
          calls.close++;
        },
      };
    },
  };
}

describe('isWriteBlockedError', () => {
  it('matches only the EWRITEBLOCKED marker', () => {
    expect(isWriteBlockedError(new Error('EWRITEBLOCKED: whatever Chromium said'))).toBe(true);
    expect(isWriteBlockedError(invalidState())).toBe(false); // unmarked = not yet laddered
    expect(isWriteBlockedError(new Error('EMODIFIED: changed'))).toBe(false);
    expect(isWriteBlockedError(null)).toBe(false);
  });
});

describe('BrowserHost.saveExisting ladder', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('recovers when the first write fails and the retry succeeds', async () => {
    vi.useRealTimers();
    const host = new BrowserHost();
    const h = fakeHandle(1);
    await host.saveExisting(h, bytes);
    // Refresh happened between the failure and the successful retry, plus
    // the post-save stat that records the freshness baseline.
    expect(h.calls.createWritable).toBe(2);
    expect(h.calls.getFile).toBe(2);
    expect(h.calls.write).toBe(1);
    expect(h.calls.close).toBe(1);
  });

  it('marks a deterministic refusal EWRITEBLOCKED after exactly one retry', async () => {
    const host = new BrowserHost();
    const h = fakeHandle(Infinity);
    const err = await host.saveExisting(h, bytes).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isWriteBlockedError(err)).toBe(true);
    // The original Chromium message survives inside the marker for the log.
    expect((err as Error).message).toContain('state cached in an interface object');
    expect(h.calls.createWritable).toBe(2); // one retry, not a loop
  });

  it('passes NotFoundError through untouched for the file-gone rescue', async () => {
    const host = new BrowserHost();
    const h = fakeHandle(Infinity, () => new DOMException('gone', 'NotFoundError'));
    const err = await host.saveExisting(h, bytes).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('NotFoundError');
    expect(isFileGoneError(err)).toBe(true);
    expect(isWriteBlockedError(err)).toBe(false);
    expect(h.calls.createWritable).toBe(1); // not retriable — no second attempt
  });

  it('still fails cleanly when write permission is missing', async () => {
    const host = new BrowserHost();
    const h = { ...fakeHandle(0), queryPermission: async () => 'prompt' as const };
    await expect(host.saveExisting(h, bytes)).rejects.toThrow(/write permission not granted/);
  });
});
