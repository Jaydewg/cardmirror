// Bundle the companion's main process. CardMirror source and the
// prosemirror packages are bundled in; electron, pdfjs-dist and pdf-lib
// stay external (resolved from node_modules at run time: pdf.js loads its
// worker and font data from its own package folder).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', 'pdf-lib'],
  // esbuild's ESM output still needs `require` for bundled CJS deps.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
