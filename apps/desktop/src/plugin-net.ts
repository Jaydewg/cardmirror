/**
 * `api.net.fetch` (plugin permission `net.fetch`), main-process half.
 *
 * The renderer (src/editor/plugin-caps/net.ts) checks the URL against
 * the plugin's granted hosts and hands the request here with that host
 * list. This side:
 *   - refuses everything on Lite builds ("no internet" is a property of
 *     the process, not a promise of the UI);
 *   - re-checks https + host on the first URL and on EVERY redirect hop
 *     (followed by hand, at most 5);
 *   - sends no cookies or credentials (Node's fetch has no cookie jar)
 *     and a generic User-Agent unless the plugin sets one;
 *   - drops hop-by-hop / identity headers, caps the reply at 5 MB, and
 *     times out (default 15 s, at most 30 s) across all hops.
 * No Electron import, so it unit-tests in plain Node.
 *
 * The host-list shape (`NETWORK_HOST_RE`, `sanitizeNetworkHosts`) is a
 * copy of src/editor/plugin-permissions.ts — main can't import renderer
 * modules; tests/editor/plugin-permissions.test.ts ("main/renderer
 * parity") fails if they drift.
 */
import { LITE_BUILD } from './lite-build.js';

export const NETWORK_HOST_RE =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ANY_HOST = '*';
export const MAX_NETWORK_HOSTS = 16;

export function sanitizeNetworkHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const h of raw) {
    if (out.size >= MAX_NETWORK_HOSTS) break;
    if (typeof h !== 'string') continue;
    const host = h.trim().toLowerCase();
    if (host === ANY_HOST || NETWORK_HOST_RE.test(host)) out.add(host);
  }
  return [...out].sort((a, b) => (a === ANY_HOST ? -1 : b === ANY_HOST ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/** `granted ∩ requested` for host lists (`"*"` admits all of the other
 *  side) — consent can never reach beyond what the manifest asked for. */
export function intersectHosts(granted: unknown, requested: unknown): string[] {
  const left = sanitizeNetworkHosts(granted);
  const right = sanitizeNetworkHosts(requested);
  const allowed = (hosts: string[], h: string): boolean => hosts.includes(ANY_HOST) || hosts.includes(h);
  return sanitizeNetworkHosts(
    left
      .filter((h) => (h === ANY_HOST ? right.includes(ANY_HOST) : allowed(right, h)))
      .concat(left.includes(ANY_HOST) ? right : []),
  );
}

export type PluginFetchResult =
  | { ok: true; status: number; url: string; headers: Record<string, string>; body: string }
  | { ok: false; error: 'host-not-granted' | 'offline' | 'timeout' | 'too-large' | 'network' | 'bad-request' };

export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const REQUEST_BODY_MAX = 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_HEADERS = 32;
const HEADER_VALUE_MAX = 8192;
const DEFAULT_USER_AGENT = 'CardMirror-Plugin/1';
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/;
const DROPPED_HEADERS = new Set(['cookie', 'cookie2', 'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function urlAllowed(url: URL, hosts: string[]): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const h = url.hostname.toLowerCase();
  return hosts.includes(ANY_HOST) || hosts.includes(h);
}

interface Deps {
  fetch: typeof globalThis.fetch;
  lite: boolean;
}

export async function pluginFetch(
  raw: unknown,
  deps: Deps = { fetch: (...a) => globalThis.fetch(...a), lite: LITE_BUILD },
): Promise<PluginFetchResult> {
  if (deps.lite) return { ok: false, error: 'offline' };
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad-request' };
  const req = raw as Record<string, unknown>;
  const hosts = sanitizeNetworkHosts(req['hosts']);
  let url: URL;
  try {
    url = new URL(String(req['url']));
  } catch {
    return { ok: false, error: 'bad-request' };
  }
  if (!urlAllowed(url, hosts)) return { ok: false, error: 'host-not-granted' };
  let method = typeof req['method'] === 'string' ? req['method'].toUpperCase() : 'GET';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return { ok: false, error: 'bad-request' };
  let body: string | undefined;
  if (req['body'] !== undefined) {
    if (typeof req['body'] !== 'string' || method !== 'POST' || req['body'].length > REQUEST_BODY_MAX) {
      return { ok: false, error: 'bad-request' };
    }
    body = req['body'];
  }
  const headers: Record<string, string> = {};
  const rawHeaders = req['headers'];
  if (rawHeaders && typeof rawHeaders === 'object') {
    let n = 0;
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (n >= MAX_HEADERS) break;
      const lower = name.toLowerCase();
      if (!HEADER_NAME_RE.test(name) || DROPPED_HEADERS.has(lower) || lower.startsWith('proxy-')) continue;
      if (typeof value !== 'string' || value.length > HEADER_VALUE_MAX || /[\r\n\0]/.test(value)) continue;
      headers[lower] = value;
      n++;
    }
  }
  if (!headers['user-agent']) headers['user-agent'] = DEFAULT_USER_AGENT;
  const t = req['timeoutMs'];
  const timeoutMs =
    typeof t === 'number' && Number.isFinite(t)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(t)))
      : DEFAULT_TIMEOUT_MS;

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      res = await deps.fetch(url.href, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        credentials: 'omit',
        signal: ctl.signal,
      });
      if (!REDIRECTS.has(res.status)) break;
      const location = res.headers.get('location');
      if (!location) break;
      if (hop >= MAX_REDIRECTS) return { ok: false, error: 'network' };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, error: 'network' };
      }
      if (!urlAllowed(next, hosts)) return { ok: false, error: 'host-not-granted' };
      void res.body?.cancel().catch(() => {});
      // 303 (and 301/302 after a POST) turn into a GET, per fetch.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      url = next;
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      outHeaders[name.toLowerCase()] = value;
    });
    let text = '';
    if (method !== 'HEAD' && res.body) {
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > FETCH_MAX_BYTES) {
        void res.body.cancel().catch(() => {});
        return { ok: false, error: 'too-large' };
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > FETCH_MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return { ok: false, error: 'too-large' };
        }
        chunks.push(value);
      }
      const all = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.byteLength;
      }
      text = new TextDecoder('utf-8').decode(all);
    }
    return { ok: true, status: res.status, url: url.href, headers: outHeaders, body: text };
  } catch {
    return { ok: false, error: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
