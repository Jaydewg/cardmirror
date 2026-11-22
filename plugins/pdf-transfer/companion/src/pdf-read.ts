/** Read a PDF with pdf.js: the Hybrid PDF attachment when there is one,
 *  else every page's geometry for `reconstruct.ts`. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fontStyleFromName, geometryFromOperators, type FontInfo, type OpsTable, type PageGeometry } from './geometry.js';
import { HYBRID_FILENAME } from './hybrid.js';

/** The most pages read from one PDF (a long backfile is a few hundred). */
export const MAX_PAGES = 2000;

function standardFontsUrl(): string {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve('pdfjs-dist/package.json'));
  return pathToFileURL(join(pkg, 'standard_fonts')).href + '/';
}

export interface PdfContents {
  /** The Hybrid PDF attachment's bytes, when present. */
  hybrid: Uint8Array | null;
  pages: PageGeometry[];
}

export async function readPdf(bytes: Uint8Array, opts: { pages?: boolean } = {}): Promise<PdfContents> {
  const task = pdfjs.getDocument({
    // pdf.js may detach the buffer it is given: hand it a copy.
    data: bytes.slice(),
    fontExtraProperties: true,
    standardFontDataUrl: standardFontsUrl(),
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    let hybrid: Uint8Array | null = null;
    const attachments = await pdf.getAttachments();
    if (attachments) {
      for (const [id, a] of attachments) {
        if (a.filename !== HYBRID_FILENAME) continue;
        hybrid = a.content ?? (await pdf.getAttachmentContent(id));
        break;
      }
    }
    const pages: PageGeometry[] = [];
    if (opts.pages !== false) {
      const count = Math.min(pdf.numPages, MAX_PAGES);
      for (let n = 1; n <= count; n++) {
        const page = await pdf.getPage(n);
        const list = await page.getOperatorList();
        const fonts = new Map<string, FontInfo>();
        const fontFor = (loaded: string): FontInfo => {
          let f = fonts.get(loaded);
          if (!f) {
            let name: string | undefined;
            try {
              const obj = page.commonObjs.get(loaded) as { name?: string; bold?: boolean; italic?: boolean } | null;
              name = obj?.name;
            } catch {
              name = undefined;
            }
            f = fontStyleFromName(name);
            fonts.set(loaded, f);
          }
          return f;
        };
        const [x0, y0, x1, y1] = page.view as [number, number, number, number];
        pages.push(
          geometryFromOperators(list.fnArray, list.argsArray, pdfjs.OPS as unknown as OpsTable, fontFor, {
            width: x1 - x0,
            height: y1 - y0,
          }),
        );
        page.cleanup();
      }
    }
    return { hybrid, pages };
  } finally {
    await task.destroy();
  }
}
