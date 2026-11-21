// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
const pluginFetch = vi.fn();
let hostPresent = true;
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => (hostPresent ? { pluginFetch } : null),
}));

import {
  installPluginRegistry,
  nextConsentHosts,
  pluginDeclaredNetworkHosts,
  pluginNetworkHosts,
  registerPluginDefinition,
  regrantPlugin,
  requestPluginPermission,
  resetPluginRegistryForTests,
  setPluginConsent,
  setPluginManifestPermissions,
} from '../../src/editor/plugin-registry.js';
import { createPluginApi, type CardMirrorPluginApi, type PluginApiDeps } from '../../src/editor/plugin-api.js';
import { notePluginActivation, resetPluginPermissionRequestsForTests } from '../../src/editor/plugin-permission-requests.js';

const deps: PluginApiDeps = {
  appVersion: 'test',
  getView: () => null,
  findViewForDocId: () => null,
  getDocIdentity: () => null,
  ensureDocId: () => null,
};
const apis = new Map<string, CardMirrorPluginApi>();
const prompts: { permission: string; networkHosts?: string[] }[] = [];
const persisted: { consented: string[]; hosts: string[] }[] = [];

function install(answer: 'allow' | 'not-now' = 'allow'): void {
  resetPluginRegistryForTests();
  apis.clear();
  installPluginRegistry(
    (id, grant) => {
      const api = createPluginApi(id, deps, grant);
      apis.set(id, api);
      return api;
    },
    {
      onPermissionPrompt: async (req) => {
        prompts.push({ permission: req.permission, ...(req.networkHosts ? { networkHosts: req.networkHosts } : {}) });
        return answer;
      },
      persistConsent: async (_id, consented, hosts) => {
        persisted.push({ consented, hosts });
        return consented;
      },
    },
  );
}

function register(hosts: unknown, permissions = ['net.fetch']): void {
  const res = registerPluginDefinition({
    id: 'cc',
    name: 'Cite Check',
    apiVersion: 1,
    permissions,
    networkHosts: hosts as string[],
    commands: [{ id: 'cc.noop', label: 'noop', run: () => {} }],
  });
  if (!res.ok) throw new Error(res.error);
}

beforeEach(() => {
  pluginFetch.mockReset();
  hostPresent = true;
  prompts.length = 0;
  persisted.length = 0;
  resetPluginPermissionRequestsForTests();
});
afterEach(() => resetPluginRegistryForTests());

describe('networkHosts consent (registry)', () => {
  it('effective hosts = definition ∩ manifest ∩ consented, and none without net.fetch', () => {
    install();
    setPluginConsent('cc', ['net.fetch'], ['api.crossref.org', 'api.openalex.org']);
    setPluginManifestPermissions('cc', ['net.fetch'], undefined, ['api.crossref.org', 'api.openalex.org', 'x.example']);
    register(['api.crossref.org', 'x.example', 'BAD']);
    expect(pluginDeclaredNetworkHosts('cc')).toEqual(['api.crossref.org', 'x.example']);
    expect(pluginNetworkHosts('cc')).toEqual(['api.crossref.org']);
    regrantPlugin('cc', []);
    expect(pluginNetworkHosts('cc')).toEqual([]);
  });

  it('a dev load (no manifest) uses the definition’s hosts; granting net.fetch grants what was shown', () => {
    install();
    register(['*']);
    expect(pluginNetworkHosts('cc')).toEqual([]); // not granted yet
    regrantPlugin('cc', ['net.fetch']);
    expect(pluginNetworkHosts('cc')).toEqual(['*']);
  });

  it('nextConsentHosts keeps prior hosts while net.fetch stays granted, and takes the declared ones when newly granted', () => {
    install();
    setPluginConsent('cc', ['net.fetch'], ['a.example']);
    setPluginManifestPermissions('cc', ['net.fetch', 'ui.dialogs'], undefined, ['a.example', 'b.example']);
    register(['a.example', 'b.example'], ['net.fetch', 'ui.dialogs']);
    expect(nextConsentHosts('cc', ['net.fetch', 'ui.dialogs'])).toEqual(['a.example']);
    expect(nextConsentHosts('cc', ['ui.dialogs'])).toEqual([]);
    regrantPlugin('cc', ['ui.dialogs']);
    expect(nextConsentHosts('cc', ['net.fetch'])).toEqual(['a.example', 'b.example']);
  });

  it('a just-in-time request for net.fetch shows the hosts and stores them with the grant', async () => {
    install('allow');
    setPluginConsent('cc', [], []);
    setPluginManifestPermissions('cc', ['net.fetch'], undefined, ['api.crossref.org']);
    register(['api.crossref.org']);
    notePluginActivation('cc', 'user');
    const r = await requestPluginPermission('cc', 'net.fetch');
    expect(r.status).toBe('granted');
    expect(prompts).toEqual([{ permission: 'net.fetch', networkHosts: ['api.crossref.org'] }]);
    expect(persisted).toEqual([{ consented: ['net.fetch'], hosts: ['api.crossref.org'] }]);
    expect(pluginNetworkHosts('cc')).toEqual(['api.crossref.org']);
  });
});

describe('api.net.fetch (renderer)', () => {
  function grantedApi(hosts: string[]): CardMirrorPluginApi {
    install();
    setPluginConsent('cc', ['net.fetch'], hosts);
    register(hosts);
    return apis.get('cc')!;
  }

  it('hands an allowed request to main with the live host list', async () => {
    const api = grantedApi(['api.crossref.org']);
    pluginFetch.mockResolvedValue({ ok: true, status: 200, url: 'u', headers: {}, body: 'b' });
    const r = await api.net!.fetch('https://api.crossref.org/works?q=1', {
      headers: { Accept: 'application/json', Bad: 7 as unknown as string },
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ ok: true, body: 'b' });
    expect(pluginFetch).toHaveBeenCalledWith({
      url: 'https://api.crossref.org/works?q=1',
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 5000,
      hosts: ['api.crossref.org'],
    });
  });

  it('refuses ungranted hosts and non-https without an IPC hop', async () => {
    const api = grantedApi(['api.crossref.org']);
    expect(await api.net!.fetch('https://evil.example/')).toEqual({ ok: false, error: 'host-not-granted' });
    expect(await api.net!.fetch('http://api.crossref.org/')).toEqual({ ok: false, error: 'host-not-granted' });
    expect(await api.net!.fetch('nonsense')).toEqual({ ok: false, error: 'bad-request' });
    expect(await api.net!.fetch('https://api.crossref.org/', { method: 'PUT' as 'GET' })).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(await api.net!.fetch('https://api.crossref.org/', { body: 'x' })).toEqual({ ok: false, error: 'bad-request' });
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it('answers offline without a desktop host', async () => {
    const api = grantedApi(['*']);
    hostPresent = false;
    expect(await api.net!.fetch('https://example.com/')).toEqual({ ok: false, error: 'offline' });
  });

  it('is absent without net.fetch', () => {
    install();
    setPluginConsent('cc', [], []);
    register(['*']);
    expect(apis.get('cc')!.net).toBeUndefined();
  });
});
