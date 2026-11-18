/**
 * Offline cite rules: pure functions over `doc.read` cards. They run on
 * every edit, so they never touch the network and stay cheap.
 *
 * Wording rule: offline checks can say a cite is incomplete, vague,
 * inconsistent or points somewhere weak. They never say quals are
 * FALSE — only an outside source contradicting them can (online.ts).
 */
import type { PluginCard } from '@cardmirror/plugin-api';
import type { Finding, Severity } from './findings.js';
import { fold, hostOf, type ParsedCite } from './parse-cite.js';
import { classifySource, SOURCE_NAME_RULES, type SourceRule } from './sources.js';

export interface RuleConfig {
  today: Date;
  /** Quals made only of these (no affiliation) read as vague. */
  vagueTerms: readonly string[];
  sourceRules: readonly SourceRule[];
  trusted: readonly SourceRule[];
  /** Flag evidence older than this many years (0 = off). */
  maxAgeYears: number;
}

export const DEFAULT_VAGUE_TERMS = [
  'writer',
  'freelance writer',
  'author',
  'contributor',
  'contributing writer',
  'guest author',
  'guest writer',
  'blogger',
  'expert',
  'journalist',
  'columnist',
  'commentator',
  'analyst',
  'staff',
  'freelancer',
  'influencer',
  'activist',
  'observer',
  'researcher',
  'scholar',
];

/** Text that names an affiliation or credential, which makes a role
 *  specific ("writer at the Atlantic", "PhD", "Professor"). */
const AFFILIATION_RE =
  /\b(?:at|for|of|with|from)\s+\S|\b(?:university|college|institute|school|center|centre|council|foundation|agency|department|ministry|bank|corporation|inc|llc|ltd|lab|laboratory|hospital|journal|times|post|news|magazine|press)\b|\b(?:ph\.?\s?d|m\.?d|j\.?d|mba|m\.?a|m\.?s|b\.?a|dphil|professor|prof|dr|fellow|director|chair|ceo|president|editor|lecturer|dean|senator|representative|secretary|ambassador|general|minister)\b/i;
const NO_QUALS_RE = /\b(?:no quals|quals? (?:not |un)available|no qualifications|unqualified|unknown|anonymous)\b|^n\/?a$/i;
const STUDENT_RE = /\b(?:student|undergrad(?:uate)?|high[- ]school(?:er)?|intern)\b/i;
const ORG_AUTHOR_RE = /^(?:staff|editors?|editorial|board|the editorial board|newsroom|team|admin|wire)$/i;
const URL_PROBLEM_RE = /\bfile:\/\/\S+|\bhttps?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)\S*/i;

/** Where a finding about `text` should anchor: the cite paragraph that
 *  contains it, else the first cite paragraph. */
export function anchorIn(card: PluginCard, text: string | null | undefined): Pick<Finding, 'part' | 'index' | 'match'> {
  if (text) {
    const i = card.citeParagraphs.findIndex((p) => p.includes(text));
    if (i >= 0) return { part: 'cite', index: i, match: text };
  }
  return card.citeParagraphs.length > 0 ? { part: 'cite', index: 0 } : { part: 'heading' };
}

/** What a finding about the short cite should anchor on. The host joins
 *  separate cite-styled runs, so for a cite highlighted in place the
 *  short cite ("Smith2020") isn't in the text: fall back to a surname. */
export function shortAnchor(card: PluginCard, short: ParsedCite['short']): string | null {
  if (!short) return null;
  const inCite = (t: string): boolean => card.citeParagraphs.some((p) => p.includes(t));
  if (inCite(short.text)) return short.text;
  return short.surnames.find(inCite) ?? short.text;
}

/** Whether a card has evidence: read-aloud (highlighted) body text, or —
 *  on hosts without `bodyRead` — any body text. A tag with nothing read
 *  under it is an empty tag or an analytic written as a tag. */
function hasEvidence(card: PluginCard): boolean {
  if (card.bodyRead) return card.bodyRead.some((ranges) => ranges.length > 0);
  return card.body.some((p) => p.trim());
}

const f = (
  card: PluginCard,
  ruleId: string,
  severity: Severity,
  message: string,
  anchorText?: string | null,
): Finding => ({ ruleId, severity, message, ...anchorIn(card, anchorText) });

function words(s: string): string[] {
  return fold(s)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function isVagueQuals(quals: string, vagueTerms: readonly string[]): boolean {
  if (AFFILIATION_RE.test(quals)) return false;
  const w = words(quals);
  if (w.length === 0 || w.length > 4) return false;
  const text = ` ${w.join(' ')} `;
  return vagueTerms.some((t) => text.includes(` ${words(t).join(' ')} `));
}

function isOrgAuthor(parsed: ParsedCite): boolean {
  return (parsed.short?.surnames ?? []).some((s) => ORG_AUTHOR_RE.test(s)) || ORG_AUTHOR_RE.test(parsed.authorText ?? '');
}

/** Calendar date of a parsed date (missing month/day → the earliest). */
function asDate(year: number, month: number | null, day: number | null): Date {
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** All offline findings for one card. */
export function checkCard(card: PluginCard, parsed: ParsedCite, cfg: RuleConfig): Finding[] {
  const out: Finding[] = [];
  const hasCiteText = card.citeParagraphs.some((p) => p.trim());
  if (!hasCiteText) {
    // Only evidence needs a cite: not analytics, empty tags, or
    // analytics written as tags.
    if (card.kind === 'card' && hasEvidence(card)) out.push({ ruleId: 'no-cite', severity: 'error', message: 'Card has no cite', part: 'heading' });
    return out;
  }
  const short = parsed.short;
  const at = shortAnchor(card, short);

  // ── The short cite ────────────────────────────────────────────────
  if (!card.cite.trim()) {
    out.push(f(card, 'no-short-cite', 'warning', 'No short cite (author + date in cite style)'));
  }
  if (short?.noDate) {
    out.push(f(card, 'no-date', 'warning', 'Cite says it has no date', at));
  } else if (short && !short.dateText) {
    out.push(f(card, 'no-date', 'warning', 'Short cite has no date', at));
  }
  if (short && short.month !== null && (short.month < 1 || short.month > 12 || (short.day ?? 1) < 1 || (short.day ?? 1) > 31)) {
    out.push(f(card, 'bad-short-date', 'warning', `“${short.dateText}” isn’t a valid date`, at));
  }

  // ── Dates ─────────────────────────────────────────────────────────
  const d = parsed.date;
  if (d && !parsed.accessedOnly) {
    const when = asDate(d.year, d.month, d.day);
    const tomorrow = new Date(cfg.today.getFullYear(), cfg.today.getMonth(), cfg.today.getDate() + 1);
    if (when > tomorrow) out.push(f(card, 'future-date', 'error', `Date ${d.text} is in the future`, d.text));
    if (short?.year !== null && short?.year !== undefined && short.dateText && !short.dateText.includes('/')) {
      if (short.year !== d.year) {
        out.push(f(card, 'date-mismatch', 'warning', `Short cite says ${short.dateText}, but the cite is dated ${d.text}`, at));
      }
    } else if (short?.month && d.month && (short.month !== d.month || (short.day && d.day && short.day !== d.day))) {
      out.push(f(card, 'date-mismatch', 'warning', `Short cite says ${short.dateText}, but the cite is dated ${d.text}`, at));
    }
    if (cfg.maxAgeYears > 0 && cfg.today.getFullYear() - d.year > cfg.maxAgeYears) {
      out.push(f(card, 'old-evidence', 'info', `Evidence is from ${d.year} (older than ${cfg.maxAgeYears} years)`, d.text));
    }
  } else if (parsed.accessedOnly) {
    out.push(f(card, 'accessed-only', 'info', 'Only an “accessed” date — no publication date'));
  } else if (parsed.rest) {
    out.push(f(card, 'no-full-date', 'info', 'No publication date in the full cite'));
  }

  // ── Author ────────────────────────────────────────────────────────
  const orgAuthor = isOrgAuthor(parsed);
  if (short && parsed.rest.length > 20 && !orgAuthor) {
    // The full name may come before the date (“Jane Doe 24, …”) or after.
    const named = fold(`${parsed.authorText ?? ''} ${parsed.rest}`);
    const missing = short.surnames.filter((s) => !named.includes(fold(s)));
    if (missing.length > 0 && missing.length === short.surnames.length) {
      out.push(
        f(card, 'author-not-in-cite', 'warning', `“${missing.join(', ')}” (short cite) isn’t named in the full cite`, at),
      );
    }
  }
  if (orgAuthor) {
    out.push(f(card, 'org-author', 'info', 'No individual author (staff / editorial byline)', at));
  }

  // ── Quals ─────────────────────────────────────────────────────────
  const quals = parsed.qualsText;
  if (!quals) {
    if (!orgAuthor && parsed.rest) out.push(f(card, 'no-quals', 'warning', 'No author qualifications'));
  } else if (NO_QUALS_RE.test(quals.trim())) {
    out.push(f(card, 'quals-none', 'warning', 'Quals say the author has none / is unknown', quals));
  } else if (isVagueQuals(quals, cfg.vagueTerms)) {
    out.push(f(card, 'vague-quals', 'warning', `Vague quals: “${quals}” (no affiliation or credential)`, quals));
  } else if (STUDENT_RE.test(quals)) {
    out.push(f(card, 'student-quals', 'info', 'Author is a student', quals));
  }

  // ── Title, source, link ───────────────────────────────────────────
  if (!parsed.titleText && parsed.rest) out.push(f(card, 'no-title', 'info', 'No title in quotes'));
  if (parsed.urls.length === 0 && !parsed.doi && !parsed.bookLike && parsed.rest) {
    out.push(f(card, 'no-link', 'info', 'No URL or DOI'));
  }
  const badLink = URL_PROBLEM_RE.exec(parsed.rest);
  if (badLink) out.push(f(card, 'local-link', 'warning', 'Link points to a local file or this computer', badLink[0]));
  for (const url of parsed.urls) {
    const host = hostOf(url);
    if (!host || !host.includes('.')) {
      out.push(f(card, 'bad-url', 'warning', 'Malformed URL', url));
      continue;
    }
    let path = '';
    try {
      path = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).pathname;
    } catch {
      /* host parsed, path didn't: match on host only */
    }
    const hit = classifySource(host, path, cfg.sourceRules, cfg.trusted);
    if (hit) out.push(f(card, 'source', hit.severity, `Source: ${hit.why}`, url));
  }
  if (parsed.urls.length === 0) {
    const named = SOURCE_NAME_RULES.find((s) => s.re.test(parsed.rest));
    if (named) {
      const m = named.re.exec(parsed.rest);
      out.push(f(card, 'source', named.severity, `Source: ${named.why}`, m?.[0]));
    }
  }
  return out;
}

/** The identity of the source a cite points at, for cross-card checks. */
export function sourceKey(parsed: ParsedCite): string | null {
  if (parsed.doi) return `doi:${parsed.doi.toLowerCase()}`;
  const url = parsed.urls[0];
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    for (const k of [...u.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid|ref$|s$)/i.test(k)) u.searchParams.delete(k);
    return `url:${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return null;
  }
}

function shortKey(parsed: ParsedCite): string | null {
  const s = parsed.short;
  if (!s || s.surnames.length === 0) return null;
  return `${s.surnames.map(fold).join('&')}|${s.year ?? s.dateText ?? ''}`;
}

function jaccard(a: string, b: string): number {
  const A = new Set(words(a).filter((w) => w.length > 2));
  const B = new Set(words(b).filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return 1;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** Cross-card findings, keyed by card index. */
export function checkDocument(cards: readonly { card: PluginCard; parsed: ParsedCite }[]): Map<number, Finding[]> {
  const out = new Map<number, Finding[]>();
  const add = (i: number, x: Finding): void => {
    const list = out.get(i) ?? [];
    list.push(x);
    out.set(i, list);
  };

  // Same source, cited two different ways.
  const bySource = new Map<string, number[]>();
  cards.forEach(({ parsed }, i) => {
    const k = sourceKey(parsed);
    if (k) bySource.set(k, [...(bySource.get(k) ?? []), i]);
  });
  for (const idx of bySource.values()) {
    const shorts = new Set(idx.map((i) => shortKey(cards[i]!.parsed)).filter(Boolean));
    if (shorts.size < 2) continue;
    for (const i of idx) {
      const others = idx
        .filter((j) => shortKey(cards[j]!.parsed) !== shortKey(cards[i]!.parsed))
        .map((j) => `“${cards[j]!.parsed.short?.text ?? '?'}”`);
      const { card, parsed } = cards[i]!;
      add(i, f(card, 'source-cited-differently', 'warning', `Same source is cited as ${[...new Set(others)].join(', ')} elsewhere`, shortAnchor(card, parsed.short)));
    }
  }

  // Same short cite, different sources (needs 24a / 24b).
  const byShort = new Map<string, number[]>();
  cards.forEach(({ parsed }, i) => {
    const k = parsed.short ? fold(parsed.short.text) : null;
    if (k && sourceKey(parsed)) byShort.set(k, [...(byShort.get(k) ?? []), i]);
  });
  for (const idx of byShort.values()) {
    const sources = new Set(idx.map((i) => sourceKey(cards[i]!.parsed)));
    if (sources.size < 2) continue;
    for (const i of idx) {
      const { card, parsed } = cards[i]!;
      add(i, f(card, 'short-cite-collision', 'info', `“${parsed.short!.text}” also names a different source here (use 24a / 24b)`, shortAnchor(card, parsed.short)));
    }
  }

  // Same author, same year, very different quals.
  const byAuthor = new Map<string, number[]>();
  cards.forEach(({ parsed }, i) => {
    if (!parsed.authorText || !parsed.qualsText) return;
    const k = `${fold(parsed.authorText)}|${parsed.short?.year ?? parsed.date?.year ?? ''}`;
    byAuthor.set(k, [...(byAuthor.get(k) ?? []), i]);
  });
  for (const idx of byAuthor.values()) {
    for (const i of idx) {
      const mine = cards[i]!.parsed.qualsText!;
      const other = idx.find((j) => j !== i && jaccard(mine, cards[j]!.parsed.qualsText!) < 0.34);
      if (other === undefined) continue;
      const { card } = cards[i]!;
      add(i, f(card, 'inconsistent-quals', 'info', `${cards[i]!.parsed.authorText} has different quals in another card: “${cards[other]!.parsed.qualsText}”`, mine));
    }
  }
  return out;
}
