import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The dev server (`npm run dev`) serves from `/`, and production builds
// now default to `/` too — the web app lives at the domain root
// (`https://cardmirror.app`, Cloudflare Workers static assets; the old
// GitHub Pages `/cardmirror/` subpath serves only a redirect stub, see
// web-redirect/). Override with `VITE_BASE=/foo/` if deploying under a
// subpath somewhere else.
//
// `@cardcutter/browser` resolves to the separately-versioned, NOT-
// shipped card-cutter package when it's checked out alongside this
// repo. The app imports it dev-only and dynamically (see
// card-cutter-port.ts, `@vite-ignore`d + try/caught), so when the
// sibling is absent the alias just never resolves — harmless.
const cardCutterEntry = path.resolve(__dirname, '../card-cutter/src/browser.ts');
const cardCutterStub = path.resolve(__dirname, 'src/editor/card-cutter-stub.ts');

// The active brand profile (brand/<id>/brand.json; BRAND env, default
// cardreflex — see brand/README.md). HTML pages carry `__BRAND_NAME__`
// tokens and the PWA manifest reads the same profile, so the product name
// is never hard-coded in the web shell. (The renderer's TS reads the same
// profile through the generated src/brand-build.ts.)
const brandId = process.env.BRAND || 'cardreflex';
const brand = JSON.parse(
  readFileSync(path.resolve(__dirname, 'brand', brandId, 'brand.json'), 'utf8'),
) as { productName: string; description: string; themeColor: string };

export default defineConfig(({ command }) => {
  // The card-cutter engine is experimental and NOT shipped: a
  // production build always resolves `@cardcutter/browser` to the
  // in-repo no-op stub, even when the sibling package is checked out.
  // Only the dev server wires the real engine (when present).
  const cardCutterTarget =
    command === 'serve' && existsSync(cardCutterEntry) ? cardCutterEntry : cardCutterStub;

  // The installable-PWA layer (web app manifest + offline service worker) is
  // WEB-ONLY. The Electron renderer reuses THIS build with `--base=./` (see
  // apps/desktop `build:renderer`); a service worker there is unwanted and
  // misbehaves under file://, so detect that relative base and gate the plugin
  // off. PWA is also skipped for the dev server (`serve`) — it's a build-time,
  // production-only concern; test it with `npm run build && npm run preview`.
  const cliBase = (() => {
    const eq = process.argv.find((a) => a.startsWith('--base='));
    if (eq) return eq.slice('--base='.length);
    const i = process.argv.indexOf('--base');
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  const isElectronRenderer = cliBase === './';
  // `NO_PWA=1` builds without the service worker — use it for local in-place
  // iteration so a stale precache doesn't keep serving old bundles.
  const enablePWA =
    command === 'build' && !isElectronRenderer && !process.env['NO_PWA'];

  // CardMirror Lite (VITE_LITE=1): the no-AI / no-internet build
  // variant (src/editor/lite.ts). The web deployment for it ships a
  // Content-Security-Policy that makes "no outbound requests" a
  // BROWSER-ENFORCED guarantee, emitted as a Cloudflare `_headers`
  // file beside the build.
  const isLite = process.env['VITE_LITE'] === '1';
  const liteHeadersPlugin = {
    name: 'cardmirror-lite-headers',
    closeBundle() {
      if (!isLite || command !== 'build') return;
      const outDir = path.resolve(__dirname, process.env['VITE_OUT_DIR'] ?? 'dist');
      // connect-src 'self': the app may load ITSELF (and the service
      // worker then serves it offline) — and nothing else, ever.
      // 'wasm-unsafe-eval' stays off: Lite ships no wasm consumers.
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; ');
      writeFileSync(path.join(outDir, '_headers'), `/*
  Content-Security-Policy: ${csp}
`);
    },
  };

  return {
    base: process.env['VITE_BASE'] ?? '/',
    resolve: {
      // Array form: Lite swaps the endpoint modules by SPECIFIER regex
      // (string keys match specifiers, and these are imported
      // relatively — './llm-endpoints.js' — so path keys never hit).
      alias: [
        { find: '@cardcutter/browser', replacement: cardCutterTarget },
        ...(isLite
          ? [
              {
                find: /^.*\/llm-endpoints\.js$/,
                replacement: path.resolve(__dirname, 'src/editor/ai/llm-endpoints-lite.ts'),
              },
              {
                find: /^.*\/relay-endpoint\.js$/,
                replacement: path.resolve(__dirname, 'src/editor/collab/relay-endpoint-lite.ts'),
              },
            ]
          : []),
      ],
    },
    plugins: [
      liteHeadersPlugin,
      {
        // index.html / timer.html: `__BRAND_NAME__` → the profile's name.
        name: 'cardmirror:brand-html',
        transformIndexHtml: {
          order: 'pre',
          handler: (html: string) => html.replaceAll('__BRAND_NAME__', brand.productName),
        },
      },
      // Dev-only: loro-crdt's loader statically imports its .wasm as an
      // ES module, which the dev server rejects ("ESM integration
      // proposal for Wasm" unsupported). The PRODUCTION build already
      // resolves that import to a URL-exporting asset module, and the
      // loader's normalizer handles the {default: url} shape by
      // fetch+instantiate — so dev resolves the same import to `?url`.
      ...(command === 'serve'
        ? [
            {
              name: 'cardmirror:loro-wasm-url-dev',
              enforce: 'pre' as const,
              resolveId(source: string) {
                if (source.endsWith('loro_wasm_bg.wasm')) {
                  return (
                    path.resolve(__dirname, 'node_modules/loro-crdt/bundler/loro_wasm_bg.wasm') +
                    '?url'
                  );
                }
                return null;
              },
            },
          ]
        : []),
      ...(enablePWA
        ? [
          VitePWA({
            // `prompt` (not `autoUpdate`): never force-reload a running editor
            // session — a new version activates on the next launch, so unsaved
            // work is never interrupted. `injectRegister: 'auto'` injects the
            // registration into the built HTML (web only); nothing lands in the
            // Electron renderer, which never sees this plugin.
            registerType: 'prompt',
            injectRegister: 'auto',
            includeAssets: ['favicon.png', 'apple-touch-icon.png'],
            manifest: {
              name: brand.productName,
              short_name: brand.productName,
              description: brand.description,
              theme_color: brand.themeColor,
              background_color: '#ffffff',
              display: 'standalone',
              categories: ['productivity', 'education'],
              icons: [
                { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
                {
                  src: 'pwa-maskable-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
            workbox: {
              // The editor bundle is large; raise the precache cap so the main
              // chunk is cached (else the app won't open offline).
              // `wasm` = the Loro CRDT engine (~3MB): precached so a
              // persisted collab session can RESUME offline — without it,
              // a guest reopening the app on dead tournament wifi has a
              // session record they can't load (web-collab decision,
              // 2026-08-18). Collab JS chunks ride the js glob already.
              globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2,ttf,json,wasm}'],
              maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
              cleanupOutdatedCaches: true,
            },
          }),
          ]
        : []),
    ],
    server: {
      fs: { allow: [path.resolve(__dirname), path.resolve(__dirname, '../card-cutter')] },
      // Pre-transform the collab chain (and the loro wasm loader
      // behind it) on dev-server start. Without this, the renderer's
      // pairing catch-up poll dynamically imports collab-ui seconds
      // after launch and can race a COLD vite's transform pipeline —
      // one .wasm request slipped through untransformed (served
      // application/wasm, rejected by strict module-script MIME
      // checking), and Chromium caches failed module fetches,
      // poisoning every later import('collab-ui') until reload.
      warmup: {
        clientFiles: ['./src/editor/collab/collab-ui.ts'],
      },
    },
    // Second HTML entry: the floating always-on-top timer window
    // (desktop pop-out; timer.html → timer-popout.ts). Tiny by
    // construction — it pulls the timer UI + settings, never the
    // editor. Also lands in the web build as a harmless dead-end
    // page nothing links to.
    build: {
      // Lite builds land beside the normal dist (VITE_OUT_DIR=dist-lite)
      // so the two variants never clobber each other.
      ...(process.env['VITE_OUT_DIR'] ? { outDir: process.env['VITE_OUT_DIR'] } : {}),
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          timer: path.resolve(__dirname, 'timer.html'),
        },
      },
    },
    // loro-crdt's wasm loader uses top-level await, which the dev-time
    // dependency pre-bundler (esbuild, pre-es2022 targets) rejects.
    // Excluding the pair serves them as native ESM in dev — modern dev
    // browsers handle TLA fine, and production goes through rollup,
    // which already builds them (into their own lazy chunks).
    optimizeDeps: { exclude: ['loro-crdt', 'loro-prosemirror'] },
  };
});
