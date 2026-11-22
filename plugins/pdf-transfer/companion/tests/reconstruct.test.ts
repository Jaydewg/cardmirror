import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { readPdf } from '../src/pdf-read.js';
import { classifyFill, reconstruct } from '../src/reconstruct.js';
import { fontStyleFromName } from '../src/geometry.js';
import { makeHybrid, parseHybrid } from '../src/hybrid.js';
import { snapshotToParas } from '../src/snapshot.js';
import { paraText } from '../src/model.js';
import { SNAP } from './fixtures.js';

interface Seg {
  text: string;
  size?: number;
  bold?: boolean;
  highlight?: [number, number, number];
  underline?: boolean;
}

/** Draw lines of styled segments, top-down, like a printed debate doc. */
async function makePdf(lines: { segs: Seg[]; gapBefore?: number }[], pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const perPage = Math.ceil(lines.length / pages);
  let page: PDFPage | null = null;
  let y = 0;
  lines.forEach((line, i) => {
    if (i % perPage === 0) {
      page = doc.addPage([612, 792]);
      y = 720;
    }
    const size = Math.max(...line.segs.map((s) => s.size ?? 11));
    y -= (line.gapBefore ?? 0) + size * 1.15;
    let x = 72;
    for (const s of line.segs) {
      const font: PDFFont = s.bold ? bold : reg;
      const sz = s.size ?? 11;
      const w = font.widthOfTextAtSize(s.text, sz);
      if (s.highlight) {
        page!.drawRectangle({ x, y: y - 0.25 * sz, width: w, height: sz * 1.15, color: rgb(...s.highlight) });
      }
      page!.drawText(s.text, { x, y, size: sz, font });
      if (s.underline) {
        page!.drawRectangle({ x, y: y - 0.15 * sz, width: w, height: 0.7, color: rgb(0, 0, 0) });
      }
      x += w;
    }
  });
  return doc.save();
}

const YELLOW: [number, number, number] = [1, 1, 0];
const CYAN: [number, number, number] = [0, 1, 1];

describe('classifyFill', () => {
  it('maps fills to Word highlights, shading or nothing', () => {
    expect(classifyFill('#ffff00')).toEqual({ highlight: 'yellow' });
    expect(classifyFill('#00fff8')).toEqual({ highlight: 'cyan' });
    expect(classifyFill('#d2d2d2')).toEqual({ shading: '#d2d2d2' });
    expect(classifyFill('#ffffff')).toBeNull();
  });
});

describe('fontStyleFromName', () => {
  it('reads bold and italic from subset names', () => {
    expect(fontStyleFromName('ABCDEF+Calibri-BoldItalic')).toEqual({ bold: true, italic: true });
    expect(fontStyleFromName('Carlito')).toEqual({ bold: false, italic: false });
    expect(fontStyleFromName('Arial,Bold')).toEqual({ bold: true, italic: false });
  });
});

describe('reconstruct', () => {
  it('rebuilds headings, cards, highlight and underline from a page', async () => {
    const pdf = await makePdf([
      { segs: [{ text: '1AC', size: 26, bold: true }] },
      { segs: [{ text: 'Warming is real', size: 13, bold: true }], gapBefore: 10 },
      { segs: [{ text: 'Smith 24', size: 13, bold: true }, { text: ' (Professor of Climate)' }], gapBefore: 6 },
      {
        segs: [
          { text: 'The ' },
          { text: 'planet', highlight: YELLOW, underline: true },
          { text: ' is ' },
          { text: 'warming', highlight: CYAN, underline: true, bold: true },
          { text: ' fast.' },
        ],
        gapBefore: 6,
      },
      { segs: [{ text: 'Extend the card', size: 13, bold: true }], gapBefore: 10 },
      { segs: [{ text: 'Second analytic', size: 13, bold: true }], gapBefore: 10 },
    ]);
    const { pages, hybrid } = await readPdf(new Uint8Array(pdf));
    expect(hybrid).toBeNull();
    const paras = reconstruct(pages);
    expect(paras.map((p) => [p.role, paraText(p)])).toEqual([
      ['pocket', '1AC'],
      ['tag', 'Warming is real'],
      ['cite', 'Smith 24 (Professor of Climate)'],
      ['body', 'The planet is warming fast.'],
      ['analytic', 'Extend the card'],
      ['analytic', 'Second analytic'],
    ]);
    expect(paras[2]!.runs[0]).toEqual({ text: 'Smith 24', cite: true });
    const body = paras[3]!.runs;
    expect(body.find((r) => r.text === 'planet')).toEqual({ text: 'planet', highlight: 'yellow', underline: true });
    expect(body.find((r) => r.text === 'warming')).toEqual({ text: 'warming', highlight: 'cyan', emphasis: true });
    expect(body.filter((r) => r.highlight).map((r) => r.text)).toEqual(['planet', 'warming']);
  });

  it('joins wrapped lines into one paragraph, across a page break', async () => {
    const long = 'word '.repeat(19).trim(); // fills most of the line
    const pdf = await makePdf(
      [
        { segs: [{ text: 'Tag', size: 13, bold: true }] },
        { segs: [{ text: long + ' and' }], gapBefore: 6 },
        { segs: [{ text: long + ' more' }] }, // wrapped: no extra gap
        { segs: [{ text: 'end of it.' }] }, // page 2: still the same paragraph
        { segs: [{ text: 'A new paragraph.' }], gapBefore: 6 },
      ],
      2,
    );
    const paras = reconstruct((await readPdf(new Uint8Array(pdf))).pages);
    expect(paras.map((p) => p.role)).toEqual(['tag', 'body', 'body']);
    expect(paraText(paras[1]!)).toBe(`${long} and ${long} more end of it.`);
  });

  it('reads a Hybrid PDF attachment exactly', async () => {
    const plain = await makePdf([{ segs: [{ text: 'whatever is printed' }] }]);
    const hybrid = await makeHybrid(new Uint8Array(plain), '1AC', SNAP);
    const read = await readPdf(hybrid, { pages: false });
    expect(read.hybrid).not.toBeNull();
    const env = parseHybrid(read.hybrid!);
    expect(env.kind).toBe('ok');
    if (env.kind === 'ok') expect(snapshotToParas(env.doc)).toEqual(snapshotToParas(SNAP));
  });
});
