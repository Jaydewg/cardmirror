/**
 * Paras → a standalone HTML page for Chromium to print. Verbatim's look,
 * at the sizes `reconstruct.ts` reads back: pocket 26pt, hat 22pt,
 * block 16pt, tag/analytic 13pt bold, cite 13pt bold, undertag 12pt,
 * body 11pt. Keep the two files in step.
 */
import { WORD_HIGHLIGHT_COLORS } from '../../../../src/editor/color-palette.js';
import type { Para, ParaRole, Run } from './model.js';
import type { PageSize } from '../../src/protocol.js';

export const SIZES_PT = {
  pocket: 26,
  hat: 22,
  block: 16,
  tag: 13,
  analytic: 13,
  cite: 13,
  undertag: 12,
  body: 11,
} as const;

const HIGHLIGHT_RGB = new Map(WORD_HIGHLIGHT_COLORS.map((c) => [c.name, `#${c.rgb}`]));

export function highlightCss(name: string): string {
  return HIGHLIGHT_RGB.get(name) ?? '#ffff00';
}

const TAGS: Record<ParaRole, string> = {
  pocket: 'h1',
  hat: 'h2',
  block: 'h3',
  tag: 'h4',
  analytic: 'h4',
  cite: 'p',
  undertag: 'p',
  body: 'p',
  paragraph: 'p',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Dark highlights need light text to stay readable. */
const DARK_HIGHLIGHTS = new Set(['blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkGray', 'black']);

function runHtml(r: Run): string {
  const css: string[] = [];
  if (r.highlight) {
    css.push(`background-color:${highlightCss(r.highlight)}`);
    if (DARK_HIGHLIGHTS.has(r.highlight)) css.push('color:#ffffff');
  } else if (r.shading) {
    css.push(`background-color:${r.shading}`);
  }
  if (r.underline || r.emphasis) css.push('text-decoration:underline');
  if (r.bold || r.emphasis || r.cite) css.push('font-weight:bold');
  if (r.italic) css.push('font-style:italic');
  if (r.cite) css.push(`font-size:${SIZES_PT.cite}pt`);
  else if (r.sizePt) css.push(`font-size:${r.sizePt}pt`);
  const text = escapeHtml(r.text);
  return css.length ? `<span style="${css.join(';')}">${text}</span>` : text;
}

function paraHtml(p: Para): string {
  const tag = TAGS[p.role];
  const inner = p.runs.map(runHtml).join('') || '&#8203;';
  return `<${tag} class="${p.role}">${inner}</${tag}>`;
}

export function printHtml(paras: readonly Para[], opts: { title: string; pageSize: PageSize }): string {
  const css = `
@page { size: ${opts.pageSize === 'A4' ? 'A4' : 'letter'}; margin: 0.75in; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: Calibri, Carlito, "Liberation Sans", Arial, sans-serif; font-size: ${SIZES_PT.body}pt; line-height: 1.15; color: #000; background: #fff; }
h1, h2, h3, h4, p { margin: 0 0 6pt; break-inside: auto; }
h1, h2, h3, h4 { font-weight: bold; break-after: avoid; }
h1.pocket { font-size: ${SIZES_PT.pocket}pt; margin-top: 18pt; }
h2.hat { font-size: ${SIZES_PT.hat}pt; margin-top: 14pt; }
h3.block { font-size: ${SIZES_PT.block}pt; margin-top: 12pt; }
h4.tag, h4.analytic { font-size: ${SIZES_PT.tag}pt; margin-top: 10pt; }
p.cite { break-after: avoid; }
p.undertag { font-size: ${SIZES_PT.undertag}pt; }
`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title><style>${css}</style></head>
<body>
${paras.map(paraHtml).join('\n')}
</body></html>
`;
}
