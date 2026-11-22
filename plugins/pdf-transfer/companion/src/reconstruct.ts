/**
 * PDF page geometry → paras: what a reader sees on the page, rebuilt
 * into CardMirror's structure.
 *
 *   1. Style each glyph from the shapes around it: a filled box behind it
 *      is a highlight (a Word color when close to one, else shading); a
 *      thin rule just under the baseline is an underline.
 *   2. Group glyphs into lines (shared baseline), lines into paragraphs
 *      (extra vertical space, a short previous line, or a change between
 *      heading-like and text-like lines).
 *   3. Give each paragraph a role from its size and boldness, at
 *      Verbatim's sizes (the export prints at the same ones, see
 *      print-html.ts): 26pt pocket, 22pt hat, 16pt block, 13pt bold
 *      tag/analytic, a cite paragraph led by 13pt bold, body text.
 */
import { WORD_HIGHLIGHT_COLORS } from '../../../../src/editor/color-palette.js';
import type { Glyph, PageGeometry, Shape } from './geometry.js';
import { normalizeRuns, type Para, type ParaRole, type Run } from './model.js';

interface Char {
  ch: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  highlight?: string;
  shading?: string;
}

interface Line {
  chars: Char[];
  y: number;
  x0: number;
  x1: number;
  size: number;
  page: number;
  /** The text-area edges of its page. */
  pageLeft: number;
  pageRight: number;
}

const POCKET_PT = 23;
const HAT_PT = 19;
const BLOCK_PT = 14.5;
const TAG_PT = 12.4;
const UNDERTAG_MIN_PT = 11.6;

const WS = /\s/;

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null;
}

const PALETTE = WORD_HIGHLIGHT_COLORS.map((c) => ({ name: c.name, rgb: hexRgb(c.rgb)! }));

/** A fill color as a Word highlight name, or as shading when no Word color is close. */
export function classifyFill(hex: string): { highlight: string } | { shading: string } | null {
  const rgb = hexRgb(hex);
  if (!rgb) return null;
  if (rgb.every((v) => v >= 0xf0)) return null; // white-ish: paper, not a highlight
  let best: { name: string; d: number } | null = null;
  for (const p of PALETTE) {
    const d = Math.hypot(rgb[0] - p.rgb[0], rgb[1] - p.rgb[1], rgb[2] - p.rgb[2]);
    if (!best || d < best.d) best = { name: p.name, d };
  }
  // Printed colors arrive exact; keep the match tight so CardMirror's
  // default grey shading (#d2d2d2) isn't taken for Word's light grey.
  if (best && best.d <= 12) return { highlight: best.name };
  return { shading: `#${hex.replace(/^#/, '').toLowerCase()}` };
}

const BAND = 4;

/** Shapes indexed by 4pt horizontal bands, for quick lookup near a point. */
function bandIndex(shapes: Shape[]): Map<number, Shape[]> {
  const idx = new Map<number, Shape[]>();
  for (const s of shapes) {
    const lo = Math.floor(s.y0 / BAND);
    const hi = Math.floor(s.y1 / BAND);
    if (hi - lo > 60) continue; // taller than a few lines: a background or a box
    for (let b = lo; b <= hi; b++) {
      let list = idx.get(b);
      if (!list) idx.set(b, (list = []));
      list.push(s);
    }
  }
  return idx;
}

function styleGlyphs(page: PageGeometry): Char[] {
  const area = page.width * page.height;
  const shapes = page.shapes.filter((s) => (s.x1 - s.x0) * (s.y1 - s.y0) < area * 0.5);
  const idx = bandIndex(shapes);
  const order = new Map(shapes.map((s, i) => [s, i]));
  const near = (y: number): Shape[] => idx.get(Math.floor(y / BAND)) ?? [];
  return page.glyphs.map((g: Glyph): Char => {
    const cx = (g.x0 + g.x1) / 2;
    const c: Char = { ...g, underline: false };
    // Highlight: the LAST-drawn fill that covers the glyph's middle.
    const midY = g.y + 0.3 * g.size;
    let hl: Shape | null = null;
    for (const s of near(midY)) {
      if (s.kind !== 'fill') continue;
      const h = s.y1 - s.y0;
      if (h < 0.5 * g.size || h > 3 * g.size) continue;
      if (cx < s.x0 || cx > s.x1 || midY < s.y0 || midY > s.y1) continue;
      if (!hl || order.get(s)! > order.get(hl)!) hl = s;
    }
    if (hl) {
      const f = classifyFill(hl.color);
      if (f && 'highlight' in f) c.highlight = f.highlight;
      else if (f) c.shading = f.shading;
    }
    // Underline: a thin rule centered just below the baseline.
    const maxThick = Math.max(2, 0.18 * g.size);
    for (const y of [g.y - 0.3 * g.size, g.y - 0.1 * g.size, g.y]) {
      for (const s of near(y)) {
        const h = s.y1 - s.y0;
        if (h > maxThick || s.x1 - s.x0 < 0.5) continue;
        const cy = (s.y0 + s.y1) / 2;
        if (cy < g.y - 0.4 * g.size || cy > g.y + 0.05 * g.size) continue;
        if (cx >= s.x0 && cx <= s.x1) {
          c.underline = true;
          break;
        }
      }
      if (c.underline) break;
    }
    return c;
  });
}

/** Styles both neighbors share: what a synthetic space should carry. */
function commonStyle(a: Char | undefined, b: Char | undefined, at: { x: number; y: number; size: number }): Char {
  const both = <K extends keyof Char>(k: K): Char[K] | undefined => (a && b && a[k] === b[k] ? a[k] : undefined);
  return {
    ch: ' ',
    x0: at.x,
    x1: at.x,
    y: at.y,
    size: at.size,
    bold: both('bold') === true,
    italic: both('italic') === true,
    underline: both('underline') === true,
    highlight: both('highlight'),
    shading: both('shading'),
  };
}

function dominantSize(chars: Char[]): number {
  const counts = new Map<number, number>();
  for (const c of chars) {
    if (WS.test(c.ch)) continue;
    const k = Math.round(c.size * 2) / 2;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0;
  let n = -1;
  for (const [k, v] of counts) if (v > n || (v === n && k > best)) [best, n] = [k, v];
  return best;
}

function buildLines(chars: Char[], page: number): Line[] {
  const sorted = [...chars].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const groups: Char[][] = [];
  let cur: Char[] = [];
  let curY = Number.NaN;
  let curSize = 0;
  for (const c of sorted) {
    if (cur.length && Math.abs(c.y - curY) <= 0.35 * Math.max(c.size, curSize)) {
      cur.push(c);
      curSize = Math.max(curSize, c.size);
      continue;
    }
    if (cur.length) groups.push(cur);
    cur = [c];
    curY = c.y;
    curSize = c.size;
  }
  if (cur.length) groups.push(cur);

  const lines: Line[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.x0 - b.x0);
    const out: Char[] = [];
    for (const c of g) {
      const prev = out[out.length - 1];
      if (prev && !WS.test(prev.ch) && !WS.test(c.ch) && c.x0 - prev.x1 > 0.2 * Math.min(prev.size, c.size)) {
        out.push(commonStyle(prev, c, { x: prev.x1, y: prev.y, size: prev.size }));
      }
      out.push(c);
    }
    const text = out.filter((c) => !WS.test(c.ch));
    if (!text.length) continue;
    lines.push({
      chars: out,
      y: text[0]!.y,
      x0: text[0]!.x0,
      x1: text[text.length - 1]!.x1,
      size: dominantSize(out),
      page,
      pageLeft: 0,
      pageRight: 0,
    });
  }
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  for (const l of lines) {
    l.pageLeft = left;
    l.pageRight = right;
  }
  return lines;
}

const allBold = (chars: Char[]): boolean => chars.every((c) => WS.test(c.ch) || c.bold);
const headingLike = (l: Line): boolean => l.size >= BLOCK_PT || (l.size >= TAG_PT && allBold(l.chars));

function startsParagraph(prev: Line, cur: Line): boolean {
  if (headingLike(prev) !== headingLike(cur)) return true;
  if (Math.abs(prev.size - cur.size) >= 2 && (prev.size >= BLOCK_PT || cur.size >= BLOCK_PT)) return true;
  const short = prev.x1 < prev.pageRight - Math.max(3 * prev.size, 0.12 * (prev.pageRight - prev.pageLeft));
  if (prev.page !== cur.page) return short;
  const pitch = Math.max(prev.size, cur.size) * 1.15;
  if (prev.y - cur.y > pitch * 1.25 + 1) return true;
  return short;
}

function joinLines(lines: Line[]): Char[] {
  const out: Char[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const first = l.chars[0];
    if (prev && first && !WS.test(prev.ch) && !WS.test(first.ch)) {
      const before = out[out.length - 2];
      const hyphenated = prev.ch === '-' && before !== undefined && /\p{L}/u.test(before.ch) && /\p{L}/u.test(first.ch);
      if (!hyphenated) out.push(commonStyle(prev, first, { x: prev.x1, y: prev.y, size: prev.size }));
    }
    out.push(...l.chars);
  }
  // Trim edge whitespace.
  while (out.length && WS.test(out[0]!.ch)) out.shift();
  while (out.length && WS.test(out[out.length - 1]!.ch)) out.pop();
  return out;
}

type Candidate = 'pocket' | 'hat' | 'block' | 'heading' | 'cite' | 'undertag' | 'text';

interface Block {
  chars: Char[];
  size: number;
  cand: Candidate;
  /** How many leading characters are the 13pt bold cite. */
  citeLen: number;
}

function leadingCiteLength(chars: Char[]): number {
  let n = 0;
  let solid = 0;
  for (const c of chars) {
    if (WS.test(c.ch)) {
      n++;
      continue;
    }
    if (!c.bold || c.size < TAG_PT) break;
    n++;
    solid++;
  }
  // Don't swallow the space after the cite.
  while (n > 0 && WS.test(chars[n - 1]!.ch)) n--;
  return solid >= 2 ? n : 0;
}

function candidate(chars: Char[]): Block {
  const size = dominantSize(chars);
  let cand: Candidate = 'text';
  let citeLen = 0;
  if (size >= POCKET_PT) cand = 'pocket';
  else if (size >= HAT_PT) cand = 'hat';
  else if (size >= BLOCK_PT) cand = 'block';
  else if (size >= TAG_PT && allBold(chars)) cand = 'heading';
  else if ((citeLen = leadingCiteLength(chars)) > 0) cand = 'cite';
  else if (size >= UNDERTAG_MIN_PT && size < TAG_PT) cand = 'undertag';
  return { chars, size, cand, citeLen };
}

function bodySizeOf(blocks: Block[]): number {
  const text = blocks.filter((b) => b.cand === 'text').flatMap((b) => b.chars);
  return dominantSize(text) || 11;
}

const sizeOrUndefined = (size: number, base: number): number | undefined =>
  Math.abs(size - base) >= 0.75 ? Math.round(size * 2) / 2 : undefined;

function runsFor(role: ParaRole, b: Block, bodySize: number): Run[] {
  const heading = role === 'pocket' || role === 'hat' || role === 'block' || role === 'tag' || role === 'analytic';
  const runs = b.chars.map((c, i): Run => {
    const r: Run = { text: c.ch };
    if (c.highlight) r.highlight = c.highlight;
    else if (c.shading) r.shading = c.shading;
    if (c.italic) r.italic = true;
    if (heading) {
      if (c.underline) r.underline = true;
      return r;
    }
    if (role === 'cite' && i < b.citeLen) {
      r.cite = true;
      return r;
    }
    if (c.underline && c.bold && role !== 'undertag') r.emphasis = true;
    else {
      if (c.underline) r.underline = true;
      if (c.bold) r.bold = true;
    }
    if (role !== 'undertag') {
      const s = sizeOrUndefined(c.size, bodySize);
      if (s !== undefined && !WS.test(c.ch)) r.sizePt = s;
    }
    return r;
  });
  return normalizeRuns(runs);
}

export function reconstruct(pages: PageGeometry[]): Para[] {
  const lines: Line[] = [];
  pages.forEach((p, i) => lines.push(...buildLines(styleGlyphs(p), i)));
  const groups: Line[][] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && !startsParagraph(last[last.length - 1]!, l)) last.push(l);
    else groups.push([l]);
  }
  const blocks = groups.map((g) => candidate(joinLines(g))).filter((b) => b.chars.length > 0);
  const bodySize = bodySizeOf(blocks);

  const paras: Para[] = [];
  let inCard = false;
  let prevRole: ParaRole | null = null;
  blocks.forEach((b, i) => {
    let role: ParaRole;
    switch (b.cand) {
      case 'pocket':
      case 'hat':
      case 'block':
        role = b.cand;
        inCard = false;
        break;
      case 'heading': {
        const next = blocks[i + 1]?.cand;
        role = next === 'cite' || next === 'text' || next === 'undertag' ? 'tag' : 'analytic';
        inCard = true;
        break;
      }
      case 'cite':
        role = inCard ? 'cite' : 'paragraph';
        break;
      case 'undertag':
        role = prevRole === 'tag' || prevRole === 'undertag' ? 'undertag' : inCard ? 'body' : 'paragraph';
        break;
      default:
        role = inCard ? 'body' : 'paragraph';
    }
    paras.push({ role, runs: runsFor(role, b, bodySize) });
    prevRole = role;
  });
  return paras;
}
