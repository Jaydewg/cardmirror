// @vitest-environment jsdom
/**
 * Clipboard HTML must be parsed in an INERT document, never the live one:
 * `innerHTML` on a live-page element runs `<img onerror>` handlers from the
 * clipboard (security report 2026-10-08). Guards the re-parse fallback in
 * paste-plugin.ts.
 */
import { describe, expect, it } from 'vitest';
import { reparseClipboardStructuralSlice } from '../../src/editor/paste-plugin.js';

function clipboardEvent(html: string): ClipboardEvent {
  return { clipboardData: { getData: (t: string) => (t === 'text/html' ? html : '') } } as unknown as ClipboardEvent;
}

describe('reparseClipboardStructuralSlice', () => {
  it('never creates elements in the live document', () => {
    const live = document.createElement;
    let liveCreates = 0;
    document.createElement = ((...args: Parameters<typeof live>) => {
      liveCreates++;
      return live.apply(document, args);
    }) as typeof document.createElement;
    try {
      const slice = reparseClipboardStructuralSlice(
        clipboardEvent('<h4 class="pmd-tag">Tag</h4><p class="pmd-card-body">body <img src="x" onerror="window.__pwned=1"></p>'),
      );
      expect(slice).not.toBeNull();
      expect(slice!.content.firstChild?.type.name).toBe('tag');
      expect(liveCreates).toBe(0);
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    } finally {
      document.createElement = live;
    }
  });

  it('still returns null for empty clipboard HTML', () => {
    expect(reparseClipboardStructuralSlice(clipboardEvent(''))).toBeNull();
  });
});
