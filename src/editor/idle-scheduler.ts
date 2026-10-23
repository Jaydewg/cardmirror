/**
 * Debounced idle scheduler, with a setTimeout fallback for browsers
 * that don't support `requestIdleCallback`.
 *
 * Used by the editor and multi-pane shell to push per-pause "heavy"
 * work (nav rebuild, word count, comments GC, comments column
 * render) out of a typing burst. A finite `delay` is a real quiet
 * period: the work waits `delay` ms (re-armed by each cancel +
 * reschedule), then for the next idle frame, capped at another
 * `delay` ms. requestIdleCallback alone was NOT a debounce — the
 * browser has an idle frame between nearly any two keystrokes, so
 * the O(doc) burst ran after every key (~75ms per key on a
 * 25M-character file).
 *
 * `delay: Infinity` means no quiet period and NO cap: run only on a
 * genuinely idle frame, however long that takes. Callers whose work
 * is a monolithic main-thread block (the palette's file parses) use
 * it so the work can never be forced into an active typing burst.
 */

export interface IdleHandle {
  timer: ReturnType<typeof setTimeout> | null;
  idle: number | null;
}

export function scheduleIdle(callback: () => void, delay = 200): IdleHandle {
  const handle: IdleHandle = { timer: null, idle: null };
  const hasIdle = typeof requestIdleCallback === 'function';
  if (!Number.isFinite(delay)) {
    // The fallback can't observe idleness; 1s approximates "probably
    // between bursts".
    if (hasIdle) handle.idle = requestIdleCallback(() => callback());
    else handle.timer = setTimeout(callback, 1000);
    return handle;
  }
  handle.timer = setTimeout(() => {
    handle.timer = null;
    // The IdleDeadline arg is unused — our heavy callbacks run to
    // completion regardless of how much budget the browser advertised.
    if (hasIdle) handle.idle = requestIdleCallback(() => callback(), { timeout: delay });
    else callback();
  }, delay);
  return handle;
}

export function cancelIdle(handle: IdleHandle): void {
  if (handle.timer !== null) clearTimeout(handle.timer);
  if (handle.idle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(handle.idle);
  handle.timer = null;
  handle.idle = null;
}
