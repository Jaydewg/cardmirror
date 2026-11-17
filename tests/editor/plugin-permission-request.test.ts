// @vitest-environment jsdom
/**
 * `api.permissions.request`: the registry half (requestPluginPermission)
 * with its trigger gate, standing answers and persistence, plus the
 * api object's delegation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import {
  installPluginRegistry,
  registerPluginDefinition,
  requestPluginPermission,
  resetPluginRegistryForTests,
  runPluginCommand,
  setPluginConsent,
  setPluginManifestPermissions,
  type PermissionPromptAnswer,
  type PermissionPromptRequest,
} from '../../src/editor/plugin-registry.js';
import {
  REQUEST_WINDOW_MS,
  getPluginPermissionPrefs,
  notePluginActivation,
  resetPluginPermissionRequestsForTests,
  setPluginPermissionPrefs,
} from '../../src/editor/plugin-permission-requests.js';
import { createPluginApi, type CardMirrorPluginApi } from '../../src/editor/plugin-api.js';
import { showToast } from '../../src/editor/toast.js';

/** A stub api that shows what it was minted with. */
type StubApi = CardMirrorPluginApi & { granted: string[]; mint: number };
let mints = 0;

let answer: PermissionPromptAnswer = 'allow';
const prompts: PermissionPromptRequest[] = [];
const persisted: string[] = [];
let persistResult: 'ok' | 'fail' = 'ok';

function setup(opts: { persist?: boolean; prompt?: (r: PermissionPromptRequest) => Promise<PermissionPromptAnswer> } = {}) {
  installPluginRegistry((_id, grant) => ({ granted: [...grant.granted].sort(), mint: ++mints }) as unknown as StubApi, {
    onPermissionPrompt:
      opts.prompt ??
      (async (req) => {
        prompts.push(req);
        return answer;
      }),
    ...(opts.persist === false
      ? {}
      : {
          persistConsent: async (id: string, consented: string[]) => {
            persisted.push(`${id}:${consented.join(',')}`);
            return persistResult === 'ok' ? consented : null;
          },
        }),
  });
  setPluginConsent('thing', ['ui.dialogs']);
  setPluginManifestPermissions('thing', ['collab.join', 'future.thing', 'ui.dialogs'], {
    'collab.join': 'From the manifest',
  });
  const res = registerPluginDefinition({
    id: 'thing',
    name: 'Thing',
    apiVersion: 1,
    permissions: ['collab.join', 'ui.dialogs', 'future.thing'],
    permissionReasons: { 'collab.join': 'To join from a file' },
    commands: [{ id: 'thing.go', label: 'Go', run: () => {} }],
  });
  expect(res.ok).toBe(true);
}

beforeEach(() => {
  resetPluginRegistryForTests();
  resetPluginPermissionRequestsForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  mints = 0;
  answer = 'allow';
  prompts.length = 0;
  persisted.length = 0;
  persistResult = 'ok';
  vi.mocked(showToast).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('requestPluginPermission: when it may prompt', () => {
  it('never without a recent trigger (no prompting from timers)', async () => {
    setup();
    const r = await requestPluginPermission('thing', 'collab.join');
    expect(r.status).toBe('denied');
    expect(prompts).toEqual([]);
  });

  it('within the window after the user ran its command; not after it closes', async () => {
    setup();
    runPluginCommand('thing.go');
    vi.setSystemTime(1_000_000 + REQUEST_WINDOW_MS + 1);
    expect((await requestPluginPermission('thing', 'collab.join')).status).toBe('denied');
    expect(prompts).toEqual([]);
    runPluginCommand('thing.go');
    answer = 'not-now';
    await requestPluginPermission('thing', 'collab.join');
    expect(prompts).toHaveLength(1);
  });

  it('one prompt at a time: a second request while one is open resolves without asking', async () => {
    let release!: (a: PermissionPromptAnswer) => void;
    setup({
      prompt: (req) => {
        prompts.push(req);
        return new Promise((r) => (release = r));
      },
    });
    runPluginCommand('thing.go');
    const first = requestPluginPermission('thing', 'collab.join');
    await Promise.resolve();
    expect((await requestPluginPermission('thing', 'collab.join')).status).toBe('denied');
    expect(prompts).toHaveLength(1);
    release('not-now');
    await first;
  });

  it('never for a granted, undeclared or unsupported permission (resolves that status)', async () => {
    setup();
    runPluginCommand('thing.go');
    expect((await requestPluginPermission('thing', 'ui.dialogs')).status).toBe('granted');
    expect((await requestPluginPermission('thing', 'files.data')).status).toBe('undeclared');
    expect((await requestPluginPermission('thing', 'future.thing')).status).toBe('unsupported');
    expect(prompts).toEqual([]);
  });

  it('never with "ask again" off, or for a blocked permission', async () => {
    setup();
    runPluginCommand('thing.go');
    setPluginPermissionPrefs('thing', { askAgain: false, blocked: [] });
    expect((await requestPluginPermission('thing', 'collab.join')).status).toBe('denied');
    setPluginPermissionPrefs('thing', { askAgain: true, blocked: ['collab.join'] });
    expect((await requestPluginPermission('thing', 'collab.join')).status).toBe('denied');
    expect(prompts).toEqual([]);
  });
});

describe('requestPluginPermission: answers', () => {
  it('Allow: stores the new consent, re-mints, and resolves granted with the NEW api', async () => {
    setup();
    runPluginCommand('thing.go');
    const r = await requestPluginPermission('thing', 'collab.join');
    expect(prompts[0]).toEqual({
      pluginId: 'thing',
      name: 'Thing',
      permission: 'collab.join',
      reason: 'To join from a file', // the definition's, over the manifest's
    });
    expect(persisted).toEqual(['thing:collab.join,ui.dialogs']);
    expect(r.status).toBe('granted');
    expect((r.api as StubApi).granted).toEqual(['collab.join', 'ui.dialogs']);
    expect((r.api as StubApi).mint).toBeGreaterThan(1);
  });

  it('a reason passed to request() replaces the declared one for that prompt (sanitized)', async () => {
    setup();
    runPluginCommand('thing.go');
    answer = 'not-now';
    await requestPluginPermission('thing', 'collab.join', { reason: '  Join\n now ' });
    expect(prompts[0]!.reason).toBe('Join now');
  });

  it('a failed save keeps it denied and says so', async () => {
    setup();
    persistResult = 'fail';
    runPluginCommand('thing.go');
    const r = await requestPluginPermission('thing', 'collab.join');
    expect(r.status).toBe('denied');
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/couldn’t save that permission/));
  });

  it('without a persist hook (bundle loaded from file) the grant is session-only', async () => {
    setup({ persist: false });
    runPluginCommand('thing.go');
    expect((await requestPluginPermission('thing', 'collab.join')).status).toBe('granted');
  });

  it('"Don’t ask again" blocks the permission', async () => {
    setup();
    runPluginCommand('thing.go');
    answer = 'never';
    expect((await requestPluginPermission('thing', 'collab.join')).status).toBe('denied');
    expect(getPluginPermissionPrefs('thing').blocked).toEqual(['collab.join']);
    runPluginCommand('thing.go');
    await requestPluginPermission('thing', 'collab.join');
    expect(prompts).toHaveLength(1);
  });

  it('"Not now" to an EVENT-triggered prompt quiets event prompts; the user’s own action can still ask', async () => {
    setup();
    answer = 'not-now';
    notePluginActivation('thing', 'event');
    await requestPluginPermission('thing', 'collab.join');
    notePluginActivation('thing', 'event');
    await requestPluginPermission('thing', 'collab.join');
    expect(prompts).toHaveLength(1);
    runPluginCommand('thing.go');
    await requestPluginPermission('thing', 'collab.join');
    expect(prompts).toHaveLength(2);
  });

  it('"Not now" to a USER-triggered prompt doesn’t quiet the next one', async () => {
    setup();
    answer = 'not-now';
    runPluginCommand('thing.go');
    await requestPluginPermission('thing', 'collab.join');
    notePluginActivation('thing', 'event', Date.now() + REQUEST_WINDOW_MS + 1);
    vi.setSystemTime(Date.now() + REQUEST_WINDOW_MS + 1);
    await requestPluginPermission('thing', 'collab.join');
    expect(prompts).toHaveLength(2);
  });
});

describe('api.permissions.request (the api object)', () => {
  const deps = {
    appVersion: 't',
    getView: () => null,
    findViewForDocId: () => null,
    getDocIdentity: () => null,
    ensureDocId: () => null,
  };
  const grant = { granted: new Set<string>(), declared: ['collab.join'], name: 'Thing' };

  it('delegates to the host', async () => {
    const requestPermission = vi.fn(async () => ({ status: 'granted' as const, api: {} as CardMirrorPluginApi }));
    const api = createPluginApi('thing', { ...deps, requestPermission }, grant);
    await api.permissions!.request('collab.join', { reason: 'r' });
    expect(requestPermission).toHaveBeenCalledWith('thing', 'collab.join', { reason: 'r' });
  });

  it('without a host to ask, reports the status and itself, never prompting', async () => {
    const api = createPluginApi('thing', deps, grant);
    const r = await api.permissions!.request('collab.join');
    expect(r).toEqual({ status: 'denied', api });
  });
});
