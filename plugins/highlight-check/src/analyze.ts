/**
 * The checker: pure functions over one card's text plus what is read
 * aloud in it (`PluginCard.bodyRead`). No DOM, no api.
 *
 * Every rule looks at one body paragraph at a time, split into words,
 * clauses (split at , ; : ( ) and dashes) and sentences. "Read" means
 * highlighted and not shaded, exactly what the reader says out loud.
 *
 *   error    the read text may say the opposite of the card
 *            negation · partial-word · reported (strong) · condition · number
 *   warning  the read text may claim more than, or something other than,
 *            the card: qualifier · reported (weak) · dated · concession ·
 *            question · stitched
 *   info     worth a look: brackets · hedge · gap · letter-pick · tag
 */
import {
  CONCESSIONS,
  CONDITIONS,
  DATED,
  fold,
  NEGATING_PREFIXES,
  NUMBER_LIMITS,
  NUMBER_UNITS,
  READ_HEDGES,
  REPORTED_STRONG,
  REPORTED_WEAK,
  TAG_ABSOLUTES,
  ABBREVIATIONS,
} from './words.js';

export type Severity = 'error' | 'warning' | 'info';

export type RuleId =
  | 'negation'
  | 'partial-word'
  | 'reported'
  | 'condition'
  | 'number'
  | 'qualifier'
  | 'dated'
  | 'concession'
  | 'question'
  | 'stitched'
  | 'brackets'
  | 'hedge'
  | 'gap'
  | 'letter-pick'
  | 'tag';

/** Rules the user can switch off (the rest are driven by word lists). */
export type ToggleRule = Exclude<RuleId, 'negation' | 'partial-word' | 'qualifier' | 'hedge'>;

export interface RuleConfig {
  negations: string[];
  qualifiers: string[];
  /** Empty = the hedge rule is off. */
  hedges: string[];
  exceptions: string[];
  rules: Record<ToggleRule, boolean>;
  /** The gap rule: this many unread words between two read ones. */
  gapWords: number;
}

export const DEFAULT_RULES: Record<ToggleRule, boolean> = {
  reported: true,
  condition: true,
  number: true,
  dated: true,
  concession: true,
  question: true,
  stitched: true,
  brackets: true,
  gap: false,
  'letter-pick': false,
  tag: false,
};

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  /** `body` = a body paragraph (`index` into `card.body`); `heading` =
   *  the tag (`index` 0). */
  part: 'body' | 'heading';
  index: number;
  /** The flagged text, as `[from, to)` offsets into that paragraph. */
  from: number;
  to: number;
  message: string;
  /** The sentence around it, for previews. */
  context: { from: number; to: number };
}

/** What `analyzeCard` needs of a `PluginCard`. */
export interface CardInput {
  kind: 'card' | 'analytic';
  heading: string;
  body: string[];
  bodyRead?: [number, number][][];
}

type ReadState = 'all' | 'some' | 'none';

interface Token {
  text: string;
  norm: string;
  from: number;
  to: number;
  read: ReadState;
  sentence: number;
  clause: number;
}

interface Paragraph {
  text: string;
  mask: Uint8Array;
  tokens: Token[];
  /** Per sentence: token index range [start, end) and whether it ends in "?". */
  sentences: { start: number; end: number; question: boolean }[];
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’ʼ-][\p{L}\p{N}]+)*/gu;
const CLAUSE_BREAK_RE = /[,;:()—–]|\s-\s/;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

// ── Paragraph model ───────────────────────────────────────────────────

function maskOf(length: number, ranges: readonly (readonly [number, number])[]): Uint8Array {
  const mask = new Uint8Array(length);
  for (const r of ranges) {
    const a = Math.max(0, Math.min(length, r[0] | 0));
    const b = Math.max(a, Math.min(length, r[1] | 0));
    mask.fill(1, a, b);
  }
  return mask;
}

function readState(mask: Uint8Array, from: number, to: number): ReadState {
  let n = 0;
  for (let i = from; i < to; i++) n += mask[i]!;
  return n === 0 ? 'none' : n === to - from ? 'all' : 'some';
}

function isSentenceBreak(gap: string, prev: Token | undefined, next: Token): boolean {
  if (!prev || !/[.!?]/.test(gap)) return false;
  if (/[!?]/.test(gap)) return true;
  if (!/\s/.test(gap)) return false; // "U.S", "1.5"
  // "Dr. Smith", "J. Doe", "e.g. the": not an end.
  if (prev.norm.length === 1 || ABBREVIATIONS.has(prev.norm)) return false;
  return /^[\p{Lu}\p{N}]/u.test(next.text) || /["“‘(]/.test(gap);
}

export function buildParagraph(text: string, ranges: readonly (readonly [number, number])[]): Paragraph {
  const mask = maskOf(text.length, ranges);
  const tokens: Token[] = [];
  const sentences: Paragraph['sentences'] = [];
  let sentence = 0;
  let clause = 0;
  let start = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    const prev = tokens[tokens.length - 1];
    const gap = text.slice(prev ? prev.to : 0, from);
    const tok: Token = { text: m[0], norm: fold(m[0]), from, to, read: readState(mask, from, to), sentence, clause };
    if (prev && isSentenceBreak(gap, prev, tok)) {
      sentences.push({ start, end: tokens.length, question: gap.includes('?') });
      start = tokens.length;
      tok.sentence = ++sentence;
      tok.clause = ++clause;
    } else if (prev && CLAUSE_BREAK_RE.test(gap)) {
      tok.clause = ++clause;
    }
    tokens.push(tok);
  }
  if (tokens.length > start) {
    const tail = text.slice(tokens[tokens.length - 1]!.to);
    sentences.push({ start, end: tokens.length, question: /^[^\p{L}\p{N}]*\?/u.test(tail) });
  }
  return { text, mask, tokens, sentences };
}

function sentenceSpan(p: Paragraph, s: number): { from: number; to: number } {
  const sent = p.sentences[s]!;
  const from = p.tokens[sent.start]!.from;
  const lastTo = p.tokens[sent.end - 1]!.to;
  const next = p.tokens[sent.end];
  let to = next ? next.from : p.text.length;
  // Keep the closing punctuation, drop the space before the next sentence.
  while (to > lastTo && /\s/.test(p.text[to - 1]!)) to--;
  return { from, to };
}

const isRead = (t: Token | undefined): boolean => !!t && t.read !== 'none';

function readPart(p: Paragraph, t: Token): string {
  let s = '';
  for (let i = t.from; i < t.to; i++) if (p.mask[i]) s += p.text[i];
  return s;
}

// ── Phrase matching ───────────────────────────────────────────────────

type MatchKind =
  | 'exception'
  | 'negation'
  | 'condition'
  | 'reported-strong'
  | 'reported-weak'
  | 'number-limit'
  | 'dated'
  | 'qualifier'
  | 'hedge';

interface Matcher {
  words: string[];
  kind: MatchKind;
}

/** Earlier kinds win a tie in length. */
const KIND_ORDER: MatchKind[] = [
  'exception',
  'negation',
  'condition',
  'reported-strong',
  'number-limit',
  'reported-weak',
  'dated',
  'qualifier',
  'hedge',
];

function matchersFor(cfg: RuleConfig): Matcher[] {
  const lists: [MatchKind, readonly string[], boolean][] = [
    ['exception', cfg.exceptions, true],
    ['negation', cfg.negations, true],
    ['condition', CONDITIONS, cfg.rules.condition],
    ['reported-strong', REPORTED_STRONG, cfg.rules.reported],
    ['number-limit', NUMBER_LIMITS, cfg.rules.number],
    ['reported-weak', REPORTED_WEAK, cfg.rules.reported],
    ['dated', DATED, cfg.rules.dated],
    ['qualifier', cfg.qualifiers, true],
    ['hedge', cfg.hedges, true],
  ];
  const out: Matcher[] = [];
  const seen = new Set<string>();
  for (const [kind, list, on] of lists) {
    if (!on) continue;
    for (const entry of list) {
      const words = fold(entry).split(/\s+/).filter(Boolean);
      const key = words.join(' ');
      if (!words.length || seen.has(key)) continue;
      seen.add(key);
      out.push({ words, kind });
    }
  }
  return out.sort(
    (a, b) => b.words.length - a.words.length || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

interface PhraseMatch {
  kind: MatchKind;
  start: number;
  /** Exclusive token index. */
  end: number;
}

const isNumberToken = (t: Token | undefined): boolean => !!t && /^\d/.test(t.text);

function findPhrases(p: Paragraph, matchers: Matcher[], negationsOn: boolean): PhraseMatch[] {
  const { tokens } = p;
  const out: PhraseMatch[] = [];
  let i = 0;
  while (i < tokens.length) {
    let hit: PhraseMatch | null = null;
    for (const m of matchers) {
      const k = m.words.length;
      if (i + k > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < k && ok; j++) {
        const t = tokens[i + j]!;
        ok = t.norm === m.words[j] && t.sentence === tokens[i]!.sentence;
      }
      // A number limit counts only before a number ("less than 10%");
      // otherwise a shorter entry ("less") may still match.
      if (ok && m.kind === 'number-limit' && !isNumberToken(tokens[i + k])) ok = false;
      if (ok) {
        hit = { kind: m.kind, start: i, end: i + k };
        break;
      }
    }
    if (!hit && negationsOn && tokens[i]!.norm.endsWith("n't")) hit = { kind: 'negation', start: i, end: i + 1 };
    if (hit) {
      out.push(hit);
      i = hit.end;
    } else {
      i++;
    }
  }
  return out;
}

// ── Rules ─────────────────────────────────────────────────────────────

interface Emit {
  (f: Omit<Finding, 'part' | 'index' | 'context'> & { context?: { from: number; to: number } }, sentence: number): void;
}

const quote = (s: string): string => `“${s}”`;

function phraseRule(p: Paragraph, cfg: RuleConfig, emit: Emit): void {
  const matches = findPhrases(p, matchersFor(cfg), cfg.negations.length > 0);
  for (const m of matches) {
    if (m.kind === 'exception') continue;
    const toks = p.tokens.slice(m.start, m.end);
    if (toks.some(isRead)) continue; // read, or partly read (partial-word's job)
    const first = toks[0]!;
    const last = toks[toks.length - 1]!;
    const after = p.tokens.slice(m.end);
    const sentenceScoped = m.kind === 'condition' || m.kind === 'reported-strong' || m.kind === 'reported-weak';
    let scoped: boolean;
    if (m.kind === 'number-limit') scoped = isRead(after[0]);
    else if (sentenceScoped) scoped = after.some((t) => t.sentence === last.sentence && isRead(t));
    else scoped = after.some((t) => t.clause === last.clause && isRead(t));
    if (!scoped) continue;
    const phrase = p.text.slice(first.from, last.to);
    const base = { from: first.from, to: last.to };
    switch (m.kind) {
      case 'negation':
        emit({ ...base, ruleId: 'negation', severity: 'error', message: `Leaves out ${quote(phrase)}, so the read text may say the opposite.` }, first.sentence);
        break;
      case 'condition':
        emit({ ...base, ruleId: 'condition', severity: 'error', message: `Leaves out ${quote(phrase)}, so a conditional reads as a flat claim.` }, first.sentence);
        break;
      case 'reported-strong':
        emit({ ...base, ruleId: 'reported', severity: 'error', message: `Leaves out ${quote(phrase)}: the read text may be a view the author rejects.` }, first.sentence);
        break;
      case 'reported-weak':
        emit({ ...base, ruleId: 'reported', severity: 'warning', message: `Leaves out ${quote(phrase)}: check the read text is the author’s own view.` }, first.sentence);
        break;
      case 'number-limit':
        emit({ ...base, ruleId: 'number', severity: 'error', message: `Leaves out ${quote(phrase)} before a highlighted number.` }, first.sentence);
        break;
      case 'dated':
        emit({ ...base, ruleId: 'dated', severity: 'warning', message: `Leaves out ${quote(phrase)}, so something past reads as current.` }, first.sentence);
        break;
      case 'qualifier':
        emit({ ...base, ruleId: 'qualifier', severity: 'warning', message: `Leaves out ${quote(phrase)}, so the read text claims more than the card.` }, first.sentence);
        break;
      case 'hedge':
        emit({ ...base, ruleId: 'hedge', severity: 'info', message: `Leaves out the hedge ${quote(phrase)}.` }, first.sentence);
        break;
    }
  }
}

/** "does|n't", "can|not", "un|likely", "hope|less" with only the stem read. */
function partialWordRule(p: Paragraph, cfg: RuleConfig, emit: Emit): void {
  for (const t of p.tokens) {
    if (t.read !== 'some') continue;
    const n = t.norm;
    let dropped: [number, number] | null = null;
    // Suffixes: the stem keeps at least one read character.
    const suffixes: [string, boolean][] = [
      ["n't", cfg.negations.length > 0],
      ['not', n === 'cannot'],
      ['less', n.length >= 7],
    ];
    for (const [suf, on] of suffixes) {
      if (!on || !n.endsWith(suf) || n.length - suf.length < 2) continue;
      const cut = t.to - suf.length;
      if (readState(p.mask, cut, t.to) === 'none' && readState(p.mask, t.from, cut) !== 'none') {
        dropped = [cut, t.to];
        break;
      }
    }
    // Prefixes: the rest of the word is read in full.
    if (!dropped) {
      for (const pre of [...NEGATING_PREFIXES].sort((a, b) => b.length - a.length)) {
        if (!n.startsWith(pre)) continue;
        const cut = t.from + pre.length;
        const restFrom = p.text[cut] === '-' ? cut + 1 : cut;
        if (t.to - restFrom < 3) continue;
        if (readState(p.mask, t.from, restFrom) === 'none' && readState(p.mask, restFrom, t.to) === 'all') {
          dropped = [t.from, restFrom];
          break;
        }
      }
    }
    if (dropped) {
      emit(
        {
          ruleId: 'partial-word',
          severity: 'error',
          from: t.from,
          to: t.to,
          message: `Reads ${quote(readPart(p, t))} out of ${quote(t.text)}, leaving out ${quote(p.text.slice(dropped[0], dropped[1]))}.`,
        },
        t.sentence,
      );
    } else if (cfg.rules['letter-pick'] && !p.mask[t.from]) {
      emit(
        { ruleId: 'letter-pick', severity: 'info', from: t.from, to: t.to, message: `Reads ${quote(readPart(p, t))} from inside ${quote(t.text)}.` },
        t.sentence,
      );
    }
  }
}

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

function numberRule(p: Paragraph, emit: Emit): void {
  for (const m of p.text.matchAll(NUMBER_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    let digits = 0;
    let read = 0;
    for (let i = from; i < to; i++) {
      if (!/\d/.test(p.text[i]!)) continue;
      digits++;
      read += p.mask[i]!;
    }
    if (read === 0) continue;
    const tok = p.tokens.find((t) => t.to > from) ?? p.tokens[p.tokens.length - 1];
    const sentence = tok?.sentence ?? 0;
    if (read < digits) {
      emit({ ruleId: 'number', severity: 'error', from, to, message: `Reads only part of the number ${quote(m[0])}.` }, sentence);
      continue;
    }
    // A dropped unit: "%", or "million" / "percent" right after.
    const pct = /^\s?%/.exec(p.text.slice(to));
    if (pct) {
      const at = to + pct[0].length - 1;
      if (!p.mask[at]) {
        emit({ ruleId: 'number', severity: 'error', from: at, to: at + 1, message: `Leaves out ${quote('%')} after ${quote(m[0])}.` }, sentence);
      }
      continue;
    }
    const next = p.tokens.find((t) => t.from >= to);
    if (next && next.sentence === sentence && NUMBER_UNITS.includes(next.norm) && next.read === 'none' && /^[\s-]*$/.test(p.text.slice(to, next.from))) {
      emit({ ruleId: 'number', severity: 'error', from: next.from, to: next.to, message: `Leaves out ${quote(next.text)} after ${quote(m[0])}.` }, sentence);
    }
  }
}

/** "While X, Y" with X read and none of Y. */
function concessionRule(p: Paragraph, emit: Emit): void {
  const markers = CONCESSIONS.map((c) => c.split(' ')).sort((a, b) => b.length - a.length);
  const { tokens } = p;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (i > 0 && tokens[i - 1]!.clause === t.clause) continue; // must open a clause
    const words = markers.find((w) => w.every((word, j) => tokens[i + j]?.norm === word && tokens[i + j]!.clause === t.clause));
    if (!words) continue;
    const end = i + words.length;
    if (tokens.slice(i, end).some(isRead)) continue;
    const concession = tokens.slice(end).filter((x) => x.clause === t.clause);
    const main = tokens.slice(end).filter((x) => x.sentence === t.sentence && x.clause > t.clause);
    if (!concession.some(isRead) || main.length === 0 || main.some(isRead)) continue;
    const last = tokens[end - 1]!;
    emit(
      {
        ruleId: 'concession',
        severity: 'warning',
        from: t.from,
        to: last.to,
        message: `Reads the concession after ${quote(p.text.slice(t.from, last.to))} but none of the author’s main point.`,
      },
      t.sentence,
    );
  }
}

function sentenceRules(p: Paragraph, cfg: RuleConfig, emit: Emit): void {
  const { tokens, sentences } = p;
  sentences.forEach((s, si) => {
    const toks = tokens.slice(s.start, s.end);
    const firstRead = toks.findIndex(isRead);
    if (firstRead < 0) return;
    if (cfg.rules.question && s.question && !toks.every((t) => t.read === 'all')) {
      const t = toks[firstRead]!;
      emit({ ruleId: 'question', severity: 'warning', from: t.from, to: t.to, message: 'Reads part of a question as if it were a claim.' }, si);
    }
    if (cfg.rules.stitched && si > 0) {
      const prev = tokens.slice(sentences[si - 1]!.start, sentences[si - 1]!.end);
      let lastRead = -1;
      prev.forEach((t, k) => {
        if (isRead(t)) lastRead = k;
      });
      if (lastRead >= 0 && lastRead < prev.length - 1 && firstRead > 0) {
        const t = toks[firstRead]!;
        const a = sentenceSpan(p, si - 1);
        const b = sentenceSpan(p, si);
        emit(
          {
            ruleId: 'stitched',
            severity: 'warning',
            from: t.from,
            to: t.to,
            message: 'Joins the middle of two sentences into one claim. Check it says what the card says.',
            context: { from: a.from, to: b.to },
          },
          si,
        );
      }
    }
  });
}

function bracketRule(p: Paragraph, emit: Emit): void {
  const re = /\[[^\]\n]{0,200}\]|…|\.{3}/g;
  for (const m of p.text.matchAll(re)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (readState(p.mask, from, to) === 'none') continue;
    const tok = p.tokens.find((t) => t.to > from);
    const message = m[0].startsWith('[')
      ? `The read text includes the bracketed ${quote(m[0])}. Check the card wasn’t altered.`
      : 'The read text includes an ellipsis. Check nothing that changes the meaning was cut.';
    emit({ ruleId: 'brackets', severity: 'info', from, to, message }, tok?.sentence ?? 0);
  }
}

function gapRule(p: Paragraph, cfg: RuleConfig, emit: Emit): void {
  let prev = -1;
  p.tokens.forEach((t, i) => {
    if (!isRead(t)) return;
    const skipped = prev < 0 ? 0 : i - prev - 1;
    if (prev >= 0 && skipped >= cfg.gapWords) {
      emit({ ruleId: 'gap', severity: 'info', from: t.from, to: t.to, message: `Skips ${skipped} words between highlighted words.` }, t.sentence);
    }
    prev = i;
  });
}

// ── Cards ─────────────────────────────────────────────────────────────

/** Analyze one body paragraph. */
export function analyzeParagraph(
  text: string,
  ranges: readonly (readonly [number, number])[],
  cfg: RuleConfig,
  index = 0,
): Finding[] {
  if (ranges.length === 0) return [];
  const p = buildParagraph(text, ranges);
  const out: Finding[] = [];
  const emit: Emit = (f, sentence) => {
    const context = f.context ?? (p.sentences[sentence] ? sentenceSpan(p, sentence) : { from: 0, to: text.length });
    out.push({ ...f, part: 'body', index, context });
  };
  phraseRule(p, cfg, emit);
  partialWordRule(p, cfg, emit);
  if (cfg.rules.number) numberRule(p, emit);
  if (cfg.rules.concession) concessionRule(p, emit);
  sentenceRules(p, cfg, emit);
  if (cfg.rules.brackets) bracketRule(p, emit);
  if (cfg.rules.gap && cfg.gapWords > 0) gapRule(p, cfg, emit);
  return dedupe(out);
}

/** One finding per flagged span: the most severe wins. */
function dedupe(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.part}:${f.index}:${f.from}:${f.to}`;
    const had = best.get(key);
    if (!had || SEVERITY_RANK[f.severity] < SEVERITY_RANK[had.severity]) best.set(key, f);
  }
  return [...best.values()].sort((a, b) => a.index - b.index || a.from - b.from || a.to - b.to);
}

/** Analyze a card. Null when the build doesn't report `bodyRead`. */
export function analyzeCard(card: CardInput, cfg: RuleConfig): Finding[] | null {
  if (card.bodyRead === undefined) return null;
  if (card.kind !== 'card') return [];
  const out: Finding[] = [];
  card.body.forEach((text, i) => out.push(...analyzeParagraph(text, card.bodyRead![i] ?? [], cfg, i)));
  if (cfg.rules.tag) {
    const tag = tagRule(card);
    if (tag) out.unshift(tag);
  }
  return out;
}

/** The tag claims certainty while the read text hedges. */
function tagRule(card: CardInput): Finding | null {
  const readWords = new Set<string>();
  card.body.forEach((text, i) => {
    const p = buildParagraph(text, card.bodyRead![i] ?? []);
    for (const t of p.tokens) if (t.read === 'all') readWords.add(t.norm);
  });
  const hedge = READ_HEDGES.find((h) => readWords.has(h));
  if (!hedge) return null;
  const tag = buildParagraph(card.heading, []);
  const abs = tag.tokens.find((t) => TAG_ABSOLUTES.includes(t.norm));
  if (!abs) return null;
  return {
    ruleId: 'tag',
    severity: 'info',
    part: 'heading',
    index: 0,
    from: abs.from,
    to: abs.to,
    message: `The tag says ${quote(abs.text)} but the read text hedges (${quote(hedge)}).`,
    context: { from: 0, to: card.heading.length },
  };
}

/** `occurrence` for `annotations.set`: which hit of `match` the host's
 *  search (`indexOf`, each search one character past the last hit) finds
 *  at `from`. */
export function occurrenceOf(text: string, match: string, from: number): number {
  let n = 0;
  let at = text.indexOf(match);
  while (at >= 0 && at < from) {
    n++;
    at = text.indexOf(match, at + 1);
  }
  return n;
}
