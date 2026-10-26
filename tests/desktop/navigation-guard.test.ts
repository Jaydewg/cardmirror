import { describe, expect, it } from 'vitest';
import { decideNavigation, decideWindowOpen } from '../../apps/desktop/src/navigation-guard.js';

describe('navigation guard', () => {
  const dev = ['http://localhost:5173'];
  it('lets the window navigate within its own origin', () => {
    expect(decideNavigation('http://localhost:5173/index.html?x=1', dev)).toEqual({ kind: 'allow' });
    expect(decideNavigation('file:///Applications/CardMirror.app/renderer/index.html', ['file:'])).toEqual({ kind: 'allow' });
  });
  it('sends http(s) and mailto elsewhere to the OS browser', () => {
    expect(decideNavigation('https://example.com/cite', dev)).toEqual({ kind: 'external', url: 'https://example.com/cite' });
    expect(decideNavigation('mailto:a@b.c', dev).kind).toBe('external');
    // A file: link in a packaged build is NOT the app's own page when it isn't ours — but we can't tell; file: is allowed only as own origin.
    expect(decideNavigation('file:///etc/passwd', dev)).toEqual({ kind: 'deny' });
  });
  it('drops script-bearing and unknown schemes', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'cardmirror://x', 'not a url']) {
      expect(decideNavigation(u, dev)).toEqual({ kind: 'deny' });
    }
  });
  it('never lets a renderer open an app window', () => {
    expect(decideWindowOpen('http://localhost:5173/', dev).kind).toBe('deny');
    expect(decideWindowOpen('https://example.com', dev)).toEqual({ kind: 'external', url: 'https://example.com' });
    expect(decideWindowOpen('javascript:1', dev).kind).toBe('deny');
  });
});
