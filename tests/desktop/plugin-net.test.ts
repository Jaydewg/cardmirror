import { describe, expect, it, vi } from 'vitest';
import { FETCH_MAX_BYTES, intersectHosts, pluginFetch } from '../../apps/desktop/src/plugin-net.js';

type Call = { url: string; init: RequestInit };

/** A scripted fetch: one Response per call, in order. */
function scripted(...responses: (Response | (() => Response) | Error)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const req = (over: Record<string, unknown> = {}) => ({
  url: 'https://api.crossref.org/works/10.1/x',
  method: 'GET',
  headers: {},
  hosts: ['api.crossref.org'],
  ...over,
});

describe('pluginFetch (main)', () => {
  it('returns status, final url, lowercased headers and the body', async () => {
    const { fetch, calls } = scripted(new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const r = await pluginFetch(req(), { fetch, lite: false });
    expect(r).toEqual({
      ok: true,
      status: 200,
      url: 'https://api.crossref.org/works/10.1/x',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.credentials).toBe('omit');
  });

  it('a non-2xx reply is still ok:true (the plugin checks status)', async () => {
    const { fetch } = scripted(new Response('nope', { status: 404 }));
    expect(await pluginFetch(req(), { fetch, lite: false })).toMatchObject({ ok: true, status: 404, body: 'nope' });
  });

  it('Lite builds refuse everything', async () => {
    const { fetch } = scripted();
    expect(await pluginFetch(req(), { fetch, lite: true })).toEqual({ ok: false, error: 'offline' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses non-https, credentials in the URL, and hosts outside the list', async () => {
    const { fetch } = scripted();
    const deps = { fetch, lite: false };
    expect(await pluginFetch(req({ url: 'http://api.crossref.org/x' }), deps)).toEqual({ ok: false, error: 'host-not-granted' });
    expect(await pluginFetch(req({ url: 'https://u:p@api.crossref.org/x' }), deps)).toEqual({ ok: false, error: 'host-not-granted' });
    expect(await pluginFetch(req({ url: 'https://evil.example/x' }), deps)).toEqual({ ok: false, error: 'host-not-granted' });
    expect(await pluginFetch(req({ url: 'https://sub.api.crossref.org/x' }), deps)).toEqual({ ok: false, error: 'host-not-granted' });
    expect(await pluginFetch(req({ hosts: [] }), deps)).toEqual({ ok: false, error: 'host-not-granted' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('"*" allows any https host', async () => {
    const { fetch } = scripted(new Response('ok'));
    expect(await pluginFetch(req({ url: 'https://example.com/a', hosts: ['*'] }), { fetch, lite: false })).toMatchObject({
      ok: true,
    });
  });

  it('re-checks every redirect hop against the hosts', async () => {
    const ok = scripted(
      new Response(null, { status: 302, headers: { location: '/works/moved' } }),
      new Response('final'),
    );
    expect(await pluginFetch(req(), { fetch: ok.fetch, lite: false })).toMatchObject({
      ok: true,
      url: 'https://api.crossref.org/works/moved',
      body: 'final',
    });
    const off = scripted(new Response(null, { status: 301, headers: { location: 'https://tracker.example/' } }));
    expect(await pluginFetch(req(), { fetch: off.fetch, lite: false })).toEqual({ ok: false, error: 'host-not-granted' });
    const down = scripted(new Response(null, { status: 302, headers: { location: 'http://api.crossref.org/x' } }));
    expect(await pluginFetch(req(), { fetch: down.fetch, lite: false })).toEqual({ ok: false, error: 'host-not-granted' });
  });

  it('gives up after 5 redirects', async () => {
    const loop = () => new Response(null, { status: 302, headers: { location: '/again' } });
    const { fetch } = scripted(loop, loop, loop, loop, loop, loop, loop);
    expect(await pluginFetch(req(), { fetch, lite: false })).toEqual({ ok: false, error: 'network' });
  });

  it('a 303 after a POST turns into a GET without a body', async () => {
    const { fetch, calls } = scripted(
      new Response(null, { status: 303, headers: { location: '/result' } }),
      new Response('done'),
    );
    await pluginFetch(req({ method: 'POST', body: '{"q":1}', headers: { 'Content-Type': 'application/json' } }), {
      fetch,
      lite: false,
    });
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"q":1}');
    expect(calls[1]!.init.method).toBe('GET');
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it('drops identity / hop-by-hop headers and sets a generic User-Agent', async () => {
    const { fetch, calls } = scripted(new Response('x'), new Response('x'));
    await pluginFetch(
      req({
        headers: {
          Cookie: 'a=1',
          Host: 'x',
          'Proxy-Authorization': 'p',
          Connection: 'close',
          Accept: 'application/json',
          'X-Bad': 'a\r\nInjected: 1',
          'Bad Name': 'v',
        },
      }),
      { fetch, lite: false },
    );
    expect(calls[0]!.init.headers).toEqual({ accept: 'application/json', 'user-agent': 'CardMirror-Plugin/1' });
    await pluginFetch(req({ headers: { 'User-Agent': 'CiteCheck/0.1' } }), { fetch, lite: false });
    expect(calls[1]!.init.headers).toEqual({ 'user-agent': 'CiteCheck/0.1' });
  });

  it('rejects bad methods and bodies', async () => {
    const { fetch } = scripted();
    const deps = { fetch, lite: false };
    expect(await pluginFetch(req({ method: 'DELETE' }), deps)).toEqual({ ok: false, error: 'bad-request' });
    expect(await pluginFetch(req({ body: 'x' }), deps)).toEqual({ ok: false, error: 'bad-request' }); // GET + body
    expect(await pluginFetch(req({ url: 'not a url' }), deps)).toEqual({ ok: false, error: 'bad-request' });
    expect(await pluginFetch(null, deps)).toEqual({ ok: false, error: 'bad-request' });
  });

  it('caps the reply at 5 MB (declared or streamed)', async () => {
    const declared = scripted(new Response('x', { headers: { 'content-length': String(FETCH_MAX_BYTES + 1) } }));
    expect(await pluginFetch(req(), { fetch: declared.fetch, lite: false })).toEqual({ ok: false, error: 'too-large' });
    const big = new Uint8Array(FETCH_MAX_BYTES + 10);
    const streamed = scripted(new Response(new Blob([big]).stream()));
    expect(await pluginFetch(req(), { fetch: streamed.fetch, lite: false })).toEqual({ ok: false, error: 'too-large' });
  });

  it('HEAD returns no body', async () => {
    const { fetch } = scripted(new Response('ignored'));
    expect(await pluginFetch(req({ method: 'HEAD' }), { fetch, lite: false })).toMatchObject({ ok: true, body: '' });
  });

  it('times out, and maps other failures to network', async () => {
    vi.useFakeTimers();
    try {
      const hang = vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
      ) as unknown as typeof globalThis.fetch;
      const p = pluginFetch(req({ timeoutMs: 1000 }), { fetch: hang, lite: false });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await p).toEqual({ ok: false, error: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
    const { fetch } = scripted(new Error('ECONNRESET'));
    expect(await pluginFetch(req(), { fetch, lite: false })).toEqual({ ok: false, error: 'network' });
  });
});

describe('intersectHosts', () => {
  it('"*" on either side admits the other side; never widens', () => {
    expect(intersectHosts(['*'], ['a.com', 'b.org'])).toEqual(['a.com', 'b.org']);
    expect(intersectHosts(['a.com', 'c.net'], ['*'])).toEqual(['a.com', 'c.net']);
    expect(intersectHosts(['*'], ['*'])).toEqual(['*']);
    expect(intersectHosts(['a.com', 'c.net'], ['a.com'])).toEqual(['a.com']);
    expect(intersectHosts(['a.com'], [])).toEqual([]);
  });
});
