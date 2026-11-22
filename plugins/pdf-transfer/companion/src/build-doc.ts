/**
 * Paras → a CardMirror document, built with CardMirror's own schema and
 * importer back end (`assembleDoc`, the shared phase-(b) of .docx import
 * and smart paste), so cards come out exactly as an import would make
 * them. Then:
 *   - `docHtml`: CardMirror-native HTML for POST /insert;
 *   - `docText`: its plain-text fallback (/insert requires one);
 *   - `docCmir`: .cmir bytes for a new document.
 */
import { DOMSerializer, type Mark, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../../../../src/schema/index.js';
import { dedupeHeadingIds } from '../../../../src/schema/ids.js';
import { assembleDoc, type ParaInfo } from '../../../../src/import/importer.js';
import { repairDoc } from '../../../../src/doc-repair.js';
import { normalizeUnderlineMarks } from '../../../../src/editor/named-style-normalizer-plugin.js';
import { serializeNative } from '../../../../src/native/index.js';
import { fakeDocument, fragmentHtml } from './fake-dom.js';
import { paraText, type Para, type ParaRole, type Run } from './model.js';

const NODE_TYPE: Record<ParaRole, string> = {
  pocket: 'pocket',
  hat: 'hat',
  block: 'block',
  tag: 'tag',
  analytic: 'analytic',
  undertag: 'undertag',
  // assembleDoc slots these by their marks: cite_mark → cite_paragraph.
  cite: 'paragraph',
  body: 'paragraph',
  paragraph: 'paragraph',
};

const STRUCTURAL: ReadonlySet<ParaRole> = new Set(['pocket', 'hat', 'block', 'tag', 'analytic', 'undertag']);

function marksFor(r: Run, role: ParaRole): readonly Mark[] {
  const m = schema.marks;
  let set: readonly Mark[] = [];
  const add = (mark: Mark | undefined): void => {
    if (mark) set = mark.addToSet(set);
  };
  if (r.shading) add(m['shading']?.create({ color: r.shading.replace(/^#/, '').toUpperCase() }));
  if (r.highlight) add(m['highlight']?.create({ color: r.highlight }));
  if (r.cite) add(m['cite_mark']?.create());
  else if (r.emphasis) add(m['emphasis_mark']?.create());
  else if (r.underline) add((STRUCTURAL.has(role) ? m['underline_direct'] : m['underline_mark'])?.create());
  if (r.bold) add(m['bold']?.create());
  if (r.italic) add(m['italic']?.create());
  if (r.sizePt) add(m['font_size']?.create({ halfPoints: Math.max(2, Math.round(r.sizePt * 2)) }));
  return set;
}

function inlinesFor(p: Para): PMNode[] {
  // Line breaks and tabs inside a paragraph read as spaces.
  return p.runs
    .map((r) => ({ r, text: r.text.replace(/[\r\n\t\u000b\f]+/g, ' ') }))
    .filter(({ text }) => text.length > 0)
    .map(({ r, text }) => schema.text(text, marksFor(r, p.role)));
}

export interface BuildOptions {
  /** Keep the heading ids the paras carry (exact sources, new documents
   *  only: an insert must never bring ids that may already be in use). */
  keepIds: boolean;
}

export function buildDoc(paras: readonly Para[], opts: BuildOptions): PMNode {
  const infos: ParaInfo[] = paras
    .filter((p) => p.runs.some((r) => r.text.trim().length > 0))
    .map((p) => ({
      nodeType: NODE_TYPE[p.role],
      inlines: inlinesFor(p),
      headingId: opts.keepIds && p.headingId && STRUCTURAL.has(p.role) ? p.headingId : null,
      pStyle: null,
      indent: 0,
      spacing: null,
    }));
  const doc = dedupeHeadingIds(repairDoc(normalizeUnderlineMarks(assembleDoc(infos))));
  doc.check();
  return doc;
}

export function docHtml(doc: PMNode): string {
  const frag = DOMSerializer.fromSchema(schema).serializeFragment(doc.content, {
    document: fakeDocument as unknown as Document,
  });
  return fragmentHtml(frag);
}

export function docText(paras: readonly Para[]): string {
  return paras.map(paraText).filter((t) => t.trim()).join('\n');
}

export function docCmir(doc: PMNode, appVersion: string): Uint8Array {
  return serializeNative(doc, { appVersion: `CardMirror PDF ${appVersion}` });
}
