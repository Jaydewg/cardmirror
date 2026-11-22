/**
 * PDF page geometry from a pdf.js operator list: every glyph with its
 * exact position, size and font, and every filled or stroked shape's
 * bounding box with its color. Pure (no pdf.js import), so it is
 * testable with hand-made operator lists; `pdf-read.ts` feeds it.
 *
 * Coordinates are PDF user space: points, y grows UP, origin bottom-left.
 */

export interface Glyph {
  /** One character (ligatures are split evenly). */
  ch: string;
  x0: number;
  x1: number;
  /** Baseline. */
  y: number;
  /** Effective font size in points. */
  size: number;
  bold: boolean;
  italic: boolean;
}

export interface Shape {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** `#rrggbb`. */
  color: string;
  kind: 'fill' | 'stroke';
}

export interface PageGeometry {
  width: number;
  height: number;
  glyphs: Glyph[];
  shapes: Shape[];
}

export interface FontInfo {
  bold: boolean;
  italic: boolean;
}

/** The pdf.js `OPS` codes this reader needs (pass `pdfjs.OPS`). */
export interface OpsTable {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  setFillRGBColor: number;
  setStrokeRGBColor: number;
  setLineWidth: number;
  constructPath: number;
  fill: number;
  eoFill: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  beginText: number;
  setFont: number;
  setCharSpacing: number;
  setWordSpacing: number;
  setHScale: number;
  setTextRise: number;
  setLeading: number;
  setLeadingMoveText: number;
  moveText: number;
  setTextMatrix: number;
  nextLine: number;
  setTextRenderingMode: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
}

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];

/** m1 × m2 (apply m1, then m2), PDF row-vector convention. */
function mul(m1: M, m2: M): M {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function apply(m: M, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

const BOLD_RE = /bold|black|heavy|semibold|demi|[-,]bd\b/i;
const ITALIC_RE = /italic|oblique|[-,]it\b/i;

/** Bold / italic from a PDF font name like `ABCDEF+Calibri-BoldItalic`. */
export function fontStyleFromName(name: string | undefined): FontInfo {
  const n = (name ?? '').replace(/^[A-Z]{6}\+/, '');
  return { bold: BOLD_RE.test(n), italic: ITALIC_RE.test(n) };
}

function asMatrix(v: unknown): M | null {
  const a = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>) : null;
  return a && a.length >= 6 && a.slice(0, 6).every((n) => Number.isFinite(n)) ? (a.slice(0, 6) as M) : null;
}

interface GlyphArg {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

interface GState {
  ctm: M;
  fill: string;
  stroke: string;
  lineWidth: number;
  font: FontInfo;
  size: number;
  tc: number;
  tw: number;
  th: number;
  ts: number;
  tl: number;
  render: number;
}

export function geometryFromOperators(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  OPS: OpsTable,
  fontFor: (loadedName: string) => FontInfo,
  page: { width: number; height: number },
): PageGeometry {
  const glyphs: Glyph[] = [];
  const shapes: Shape[] = [];
  let g: GState = {
    ctm: IDENTITY,
    fill: '#000000',
    stroke: '#000000',
    lineWidth: 1,
    font: { bold: false, italic: false },
    size: 0,
    tc: 0,
    tw: 0,
    th: 1,
    ts: 0,
    tl: 0,
    render: 0,
  };
  const stack: GState[] = [];
  let tm: M = IDENTITY;
  let tlm: M = IDENTITY;

  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokes = new Set([OPS.stroke, OPS.closeStroke]);

  const moveText = (tx: number, ty: number): void => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };

  const show = (items: unknown): void => {
    if (!Array.isArray(items) || g.size === 0) return;
    const boldByRender = g.render === 2 || g.render === 6;
    for (const it of items) {
      if (typeof it === 'number') {
        // TJ kerning: thousandths of an em, subtracted from the advance.
        tm = mul([1, 0, 0, 1, (-it / 1000) * g.size * g.th, 0], tm);
        continue;
      }
      if (!it || typeof it !== 'object') continue;
      const glyph = it as GlyphArg;
      const w0 = (typeof glyph.width === 'number' ? glyph.width : 0) / 1000;
      const advance = (w0 * g.size + g.tc + (glyph.isSpace ? g.tw : 0)) * g.th;
      const trm = mul([g.size * g.th, 0, 0, g.size, 0, g.ts], mul(tm, g.ctm));
      const [x0, y] = apply(trm, 0, 0);
      const [x1] = apply(mul(tm, g.ctm), advance, g.ts);
      const size = Math.hypot(trm[2], trm[3]);
      const text = typeof glyph.unicode === 'string' ? glyph.unicode : '';
      const chars = [...text];
      if (chars.length && size > 0) {
        const step = (x1 - x0) / chars.length;
        chars.forEach((ch, i) =>
          glyphs.push({
            ch,
            x0: x0 + step * i,
            x1: x0 + step * (i + 1),
            y,
            size,
            bold: g.font.bold || boldByRender,
            italic: g.font.italic,
          }),
        );
      }
      tm = mul([1, 0, 0, 1, advance, 0], tm);
    }
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    const args = (argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push({ ...g });
        break;
      case OPS.restore:
        g = stack.pop() ?? g;
        break;
      case OPS.transform: {
        const m = asMatrix(args);
        if (m) g.ctm = mul(m, g.ctm);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...g });
        const m = asMatrix(args[0]);
        if (m) g.ctm = mul(m, g.ctm);
        break;
      }
      case OPS.paintFormXObjectEnd:
        g = stack.pop() ?? g;
        break;
      case OPS.setFillRGBColor:
        if (typeof args[0] === 'string') g.fill = args[0].toLowerCase();
        break;
      case OPS.setStrokeRGBColor:
        if (typeof args[0] === 'string') g.stroke = args[0].toLowerCase();
        break;
      case OPS.setLineWidth:
        if (typeof args[0] === 'number') g.lineWidth = args[0];
        break;
      case OPS.constructPath: {
        const paint = args[0] as number;
        const isFill = fills.has(paint);
        const isStroke = strokes.has(paint);
        if (!isFill && !isStroke) break;
        const mm = args[2] as ArrayLike<number> | null | undefined;
        if (!mm || mm.length < 4 || ![0, 1, 2, 3].every((k) => Number.isFinite(mm[k]))) break;
        const corners = [
          apply(g.ctm, mm[0]!, mm[1]!),
          apply(g.ctm, mm[2]!, mm[1]!),
          apply(g.ctm, mm[0]!, mm[3]!),
          apply(g.ctm, mm[2]!, mm[3]!),
        ];
        let x0 = Math.min(...corners.map((c) => c[0]));
        let x1 = Math.max(...corners.map((c) => c[0]));
        let y0 = Math.min(...corners.map((c) => c[1]));
        let y1 = Math.max(...corners.map((c) => c[1]));
        if (isStroke) {
          const half = (g.lineWidth * Math.hypot(g.ctm[0], g.ctm[1])) / 2;
          x0 -= half;
          x1 += half;
          y0 -= half;
          y1 += half;
        }
        shapes.push({ x0, y0, x1, y1, color: isFill ? g.fill : g.stroke, kind: isFill ? 'fill' : 'stroke' });
        break;
      }
      case OPS.beginText:
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case OPS.setFont:
        if (typeof args[0] === 'string') g.font = fontFor(args[0]);
        if (typeof args[1] === 'number') g.size = args[1];
        break;
      case OPS.setCharSpacing:
        g.tc = Number(args[0]) || 0;
        break;
      case OPS.setWordSpacing:
        g.tw = Number(args[0]) || 0;
        break;
      case OPS.setHScale:
        g.th = (Number(args[0]) || 100) / 100;
        break;
      case OPS.setTextRise:
        g.ts = Number(args[0]) || 0;
        break;
      case OPS.setLeading:
        g.tl = Number(args[0]) || 0;
        break;
      case OPS.setTextRenderingMode:
        g.render = Number(args[0]) || 0;
        break;
      case OPS.setLeadingMoveText:
        g.tl = -(Number(args[1]) || 0);
        moveText(Number(args[0]) || 0, Number(args[1]) || 0);
        break;
      case OPS.moveText:
        moveText(Number(args[0]) || 0, Number(args[1]) || 0);
        break;
      case OPS.setTextMatrix: {
        const m = asMatrix(args[0]) ?? asMatrix(args);
        if (m) {
          tm = m;
          tlm = m;
        }
        break;
      }
      case OPS.nextLine:
        moveText(0, -g.tl);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        show(args[0]);
        break;
      case OPS.nextLineShowText:
        moveText(0, -g.tl);
        show(args[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        g.tw = Number(args[0]) || 0;
        g.tc = Number(args[1]) || 0;
        moveText(0, -g.tl);
        show(args[2]);
        break;
    }
  }
  return { width: page.width, height: page.height, glyphs, shapes };
}
