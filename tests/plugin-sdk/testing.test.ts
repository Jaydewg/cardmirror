/**
 * The SDK's test helper (`@cardmirror/plugin-api/testing`): gates exactly
 * like the host (same rule table), fails revoked calls the same way, and
 * stays free of app code so a plugin's tests can run anywhere.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFakePluginApi } from '../../src/plugin-sdk/testing.js';
import { CALL_TIME_PERMISSIONS } from '../../src/editor/plugin-call-rules.js';
import { PLUGIN_PERMISSIONS } from '../../src/editor/plugin-permissions.js';

const ALL = Object.keys(PLUGIN_PERMISSIONS);
const ctx = { docUid: 'u1', docId: 'd1', title: 'a.cmir' };

describe('createFakePluginApi', () => {
  it('exposes exactly the host rule table\'s methods for the granted permissions', () => {
    const api = createFakePluginApi({ granted: ALL }).api as unknown as Record<string, Record<string, unknown>>;
    for (const [ns, rules] of Object.entries(CALL_TIME_PERMISSIONS)) {
      expect(Object.keys(api[ns] ?? {}).sort(), ns).toEqual(Object.keys(rules).sort());
    }
    const none = createFakePluginApi().api;
    expect(none.collab).toBeUndefined();
    expect(none.permissions!.list()).toEqual([]);
  });

  it('per-method permissions, like the host', () => {
    const { api } = createFakePluginApi({ granted: ['collab.read'] });
    expect(Object.keys(api.collab!).sort()).toEqual(['current', 'localRecord', 'roomIdOf']);
    expect(api.collab!.roomIdOf!('cmshare2.0123456789abcdef.KEY.1.0.0@https://x.test')).toBe('0123456789abcdef');
  });

  it('a revoke refuses calls on the same api object (sync throws, async rejects)', async () => {
    const fake = createFakePluginApi({ granted: ['ui.dialogs', 'files.data'] });
    const { api } = fake;
    fake.setGranted(['files.data']);
    const pending = api.ui!.confirm('ok?');
    await expect(pending).rejects.toMatchObject({ name: 'PluginPermissionError', permission: 'ui.dialogs' });
    expect(api.files!.get()).toBeNull();
    fake.setGranted([]);
    expect(() => api.files!.get()).toThrow(/no longer granted/);
    expect(api.permissions!.status('files.data')).toBe('denied');
    expect(api.permissions!.has('files.data')).toBe(false);
  });

  it('simulates older builds: unknown permissions and missing methods', () => {
    const { api } = createFakePluginApi({
      granted: ['collab.server', 'collab.shareCode'],
      unsupported: ['collab.server'],
      omit: ['collab.shareAddress'],
    });
    expect(api.permissions!.status('collab.server')).toBe('unsupported');
    expect(api.permissions!.status('collab.join')).toBe('undeclared');
    expect(Object.keys(api.collab!)).toEqual(['shareCode']);
    expect(createFakePluginApi({ declared: ['made.up'] }).api.permissions!.status('made.up')).toBe('unsupported');
  });

  it('uses your implementations and records hooks you didn\'t implement', async () => {
    const opened: unknown[] = [];
    const fake = createFakePluginApi({
      granted: ['files.data', 'collab.probe', 'ui.notices'],
      collab: { probe: async () => 'live' },
    });
    const off = fake.api.files!.onSave(() => ({ data: { v: 1 }, summary: 's' }));
    fake.api.files!.onOpen((data) => void opened.push(data));
    expect(fake.save(ctx)).toEqual([{ data: { v: 1 }, summary: 's' }]);
    await fake.open({ x: 1 }, ctx);
    expect(opened).toEqual([{ x: 1 }]);
    off();
    expect(fake.hooks('files.onSave')).toHaveLength(0);
    await expect(fake.api.collab!.probe!('c')).resolves.toBe('live');
    fake.api.notices!.post({ key: 'k', title: 't', body: 'b' });
    expect(fake.notices).toEqual([{ key: 'k', title: 't', body: 'b' }]);
  });

  it('storage round-trips through JSON; settings fire onChanged; toasts are recorded', () => {
    const fake = createFakePluginApi({ settings: { auto: false } });
    const obj = { a: [1] };
    fake.api.storage.set('k', obj);
    obj.a.push(2);
    expect(fake.api.storage.get('k')).toEqual({ a: [1] });
    const seen: unknown[] = [];
    fake.api.settings.onChanged((k, v) => void seen.push([k, v]));
    fake.setSetting('auto', true);
    expect(fake.api.settings.get('auto')).toBe(true);
    expect(seen).toEqual([['auto', true]]);
    fake.api.showToast('hi');
    expect(fake.toasts).toEqual(['hi']);
  });

  it('carries no app code: its runtime imports are the two dependency-free modules', () => {
    const runtimeImports = (file: string) =>
      [...readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    expect(runtimeImports('src/plugin-sdk/testing.ts').sort()).toEqual([
      '../editor/plugin-call-rules.js',
      '../editor/plugin-permissions.js',
    ]);
    expect(runtimeImports('src/editor/plugin-call-rules.ts')).toEqual([]);
    expect(runtimeImports('src/editor/plugin-permissions.ts')).toEqual([]);
    // The contract itself stays type-only.
    expect(runtimeImports('src/plugin-sdk/index.ts')).toEqual([]);
  });
});
