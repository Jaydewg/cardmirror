/**
 * Send-outcome messaging (relay-client.ts): credential DECLINES (401/403
 * counted by the main process as `authFail`) must name the fix (set up a
 * relay) instead of the misleading "couldn't reach", and must never read
 * as "subscription required". With no relay configured at all, the main
 * process reports `noRelay` and the toast says so.
 */
import { describe, it, expect } from 'vitest';
import { sendOutcomeToast } from '../../src/editor/pairing/relay-client.js';

describe('sendOutcomeToast', () => {
  it('all delivered → the plain success toast', () => {
    expect(sendOutcomeToast('Aki', { ok: 2, fail: 0, authFail: 0 })).toBe('Sent to Aki ✓');
  });

  it('plain failures keep the existing outage wording', () => {
    expect(sendOutcomeToast('Aki', { ok: 0, fail: 2, authFail: 0 })).toBe("Couldn't reach Aki");
    expect(sendOutcomeToast('Aki', { ok: 1, fail: 1, authFail: 0 })).toBe('Sent to Aki (1 failed)');
  });

  it('a credential decline names the fix and never says subscription', () => {
    const msg = sendOutcomeToast('Aki', { ok: 0, fail: 1, authFail: 1 });
    expect(msg).toMatch(/declined your credentials/);
    expect(msg).toMatch(/Settings → Collaboration/);
    expect(msg).toMatch(/set up a relay/);
    expect(msg).not.toMatch(/subscription|Debate Decoded|membership/i);
  });

  it('no relay configured → says so instead of "couldn\'t reach"', () => {
    const msg = sendOutcomeToast('Aki', { ok: 0, fail: 2, authFail: 0, noRelay: true });
    expect(msg).toMatch(/^No relay set up\./);
    expect(msg).toMatch(/Settings → Collaboration/);
  });

  it('a partial decline scopes the count instead of blaming the whole send', () => {
    const msg = sendOutcomeToast('team', { ok: 3, fail: 1, authFail: 1 });
    expect(msg).toMatch(/for 1 recipient/);
  });

  it('declines outrank the generic outage wording when both occurred', () => {
    const msg = sendOutcomeToast('team', { ok: 0, fail: 3, authFail: 2 });
    expect(msg).toMatch(/declined your credentials/);
    expect(msg).toMatch(/for 2 recipient/);
  });
});
