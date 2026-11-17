/**
 * `net.fetch` → `api.net`: https requests to the hosts the plugin
 * declared in `networkHosts` and the user saw when granting
 * `net.fetch`.
 *
 * The request runs in the desktop main process (no CORS, no cookies, no
 * credentials, a generic User-Agent unless the plugin sets one), which
 * re-checks every redirect hop against the same host list and caps the
 * reply. Lite builds refuse it there too. Like every permission this is
 * a consent contract, not a sandbox: bundles run in the page.
 */
import { getElectronHost } from '../host/index.js';
import { hostAllowed } from '../plugin-permissions.js';
import { pluginNetworkHosts } from '../plugin-registry.js';
import type { CapabilityContext } from './context.js';

export interface PluginFetchInit {
  /** Default `GET`. */
  method?: 'GET' | 'HEAD' | 'POST';
  /** Request headers. `Cookie`, `Host`, `Connection`, `Content-Length`,
   *  `Transfer-Encoding` and `Proxy-*` are dropped. */
  headers?: Record<string, string>;
  /** Request body (POST only), sent as given. */
  body?: string;
  /** Default 15000, at most 30000. */
  timeoutMs?: number;
}

/** A reply of any status is `ok: true` — check `status`. `body` is the
 *  reply decoded as UTF-8 text ('' for HEAD), at most 5 MB. Errors are a
 *  growing union: treat an unknown one like `network`. */
export type PluginFetchResult =
  | {
      ok: true;
      status: number;
      /** Final URL, after redirects. */
      url: string;
      /** Reply headers, names lowercased. */
      headers: Record<string, string>;
      body: string;
    }
  | {
      ok: false;
      /** `host-not-granted`: the URL (or a redirect) leaves the granted
       *  hosts, or isn't https · `offline`: this build or host can't
       *  make requests · `too-large`: reply over 5 MB · `bad-request`:
       *  malformed URL or options. */
      error: 'host-not-granted' | 'offline' | 'timeout' | 'too-large' | 'network' | 'bad-request';
    };

/** `net.fetch` permission. */
export interface PluginNetApi {
  fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResult>;
}

export const NET_PERMISSION = 'net.fetch';
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const BODY_MAX = 1024 * 1024;

export function buildNetApi(ctx: CapabilityContext): PluginNetApi | undefined {
  if (!ctx.granted.has(NET_PERMISSION)) return undefined;
  const { pluginId } = ctx;
  return Object.freeze({
    async fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResult> {
      let parsed: URL;
      try {
        parsed = new URL(String(url));
      } catch {
        return { ok: false, error: 'bad-request' };
      }
      const o = (init && typeof init === 'object' ? init : {}) as PluginFetchInit;
      const method = typeof o.method === 'string' ? o.method.toUpperCase() : 'GET';
      if (!METHODS.has(method)) return { ok: false, error: 'bad-request' };
      if (o.body !== undefined && (typeof o.body !== 'string' || method !== 'POST' || o.body.length > BODY_MAX)) {
        return { ok: false, error: 'bad-request' };
      }
      const headers: Record<string, string> = {};
      if (o.headers && typeof o.headers === 'object') {
        for (const [k, v] of Object.entries(o.headers)) if (typeof v === 'string') headers[k] = v;
      }
      const hosts = pluginNetworkHosts(pluginId);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !hostAllowed(hosts, parsed.hostname)) {
        return { ok: false, error: 'host-not-granted' };
      }
      const host = getElectronHost();
      if (!host?.pluginFetch) return { ok: false, error: 'offline' };
      const timeoutMs = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) ? o.timeoutMs : undefined;
      return (await host.pluginFetch({
        url: parsed.href,
        method,
        headers,
        ...(o.body !== undefined ? { body: o.body } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        hosts,
      })) as PluginFetchResult;
    },
  });
}
