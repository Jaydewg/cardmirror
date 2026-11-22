/**
 * The companion's hub format: a document as a flat list of styled
 * paragraphs. Every path goes through it:
 *
 *   doc.read snapshot ──► paras ──► print HTML ──► PDF        (export)
 *   PDF page geometry ──► paras ──► CardMirror doc ──► html / .cmir (import)
 *   Hybrid PDF snapshot ─► paras ──┘                             (exact import)
 */

export type ParaRole =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'cite'
  | 'undertag'
  | 'body'
  /** Text outside any card. */
  | 'paragraph';

export interface Run {
  text: string;
  /** Word highlight color name (`yellow`, `cyan`, …). */
  highlight?: string;
  /** Shading (`#rrggbb`). */
  shading?: string;
  underline?: boolean;
  emphasis?: boolean;
  cite?: boolean;
  bold?: boolean;
  italic?: boolean;
  /** Point size, when it differs from the paragraph's usual size. */
  sizePt?: number;
}

export interface Para {
  role: ParaRole;
  runs: Run[];
  /** A heading's id, kept only from an exact (Hybrid PDF) source. */
  headingId?: string;
}

export const HEADING_ROLES: ReadonlySet<ParaRole> = new Set(['pocket', 'hat', 'block', 'tag', 'analytic']);

export function paraText(p: Para): string {
  return p.runs.map((r) => r.text).join('');
}

const STYLE_KEYS = ['highlight', 'shading', 'underline', 'emphasis', 'cite', 'bold', 'italic', 'sizePt'] as const;

/** Whether two runs carry the same styles (so they can merge). */
export function sameStyle(a: Run, b: Run): boolean {
  return STYLE_KEYS.every((k) => a[k] === b[k]);
}

/** Merge adjacent same-styled runs and drop empty ones. */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}
