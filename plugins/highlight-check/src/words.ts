/**
 * The word lists the rules match. Entries are lowercase and may be
 * phrases ("no longer"); curly apostrophes are folded to straight ones
 * before matching. The lists marked "editable" are the defaults of the
 * plugin's settings of the same meaning.
 */

/** Red: leaving one of these out usually reverses the claim. Editable.
 *  (Any word ending in "n't" counts too, without being listed.) */
export const DEFAULT_NEGATIONS = [
  'not',
  'no',
  'never',
  'none',
  'nobody',
  'nothing',
  'nowhere',
  'neither',
  'nor',
  'cannot',
  'without',
  'no one',
  'no longer',
  'not necessarily',
  'hardly ever',
];

/** Amber: leaving one of these out makes the claim stronger or wider
 *  than the author's (the "rarely" / "seldom" family, plus scope words).
 *  Editable. */
export const DEFAULT_QUALIFIERS = [
  'rarely',
  'seldom',
  'hardly',
  'barely',
  'scarcely',
  'infrequently',
  'few',
  'a few',
  'little',
  'unlikely',
  'less',
  'least',
  'some',
  'only',
  'partly',
  'partially',
  'somewhat',
  'sometimes',
  'occasionally',
  'in part',
  'in some cases',
  'in certain cases',
  'a minority of',
];

/** Blue, off by default: hedges. Very common to cut, so noisy. Editable. */
export const DEFAULT_HEDGES = [
  'may',
  'might',
  'could',
  'possibly',
  'potentially',
  'perhaps',
  'likely',
  'probably',
  'in theory',
  'arguably',
];

/** Phrases whose words are never flagged: dropping them doesn't change
 *  what the card says. Editable. */
export const DEFAULT_EXCEPTIONS = [
  'not only',
  'not just',
  'not merely',
  'not simply',
  'not least',
  'not to mention',
  'not surprisingly',
  'whether or not',
  'if not',
  'if any',
  'if anything',
  'if so',
  'as if',
  'no doubt',
  'no matter',
  'nothing but',
  'none other than',
  'never mind',
  'no less than',
  'no fewer than',
  'a little',
  'little by little',
];

/** Red: attributions that mark a view the author may be rejecting. */
export const REPORTED_STRONG = [
  'critics',
  'opponents',
  'skeptics',
  'sceptics',
  'detractors',
  'some argue',
  'some claim',
  'some say',
  'some believe',
  'some contend',
  'myth',
  'misconception',
  'misperception',
  'contrary to',
  'falsely',
  'mistakenly',
  'wrongly',
  'erroneously',
  'so-called',
  'it is wrong',
  'it is false',
  'it is not true',
];

/** Amber: framings that may introduce someone else's view. */
export const REPORTED_WEAK = [
  'the claim that',
  'the notion that',
  'the idea that',
  'the belief that',
  'the assumption that',
  'the argument that',
  'proponents',
  'supporters',
];

/** Red: conditions. Dropping one turns a conditional into a flat claim. */
export const CONDITIONS = ['if', 'unless', 'only if', 'provided that', 'assuming that', 'as long as', 'so long as'];

/** Red when the next word is a highlighted number. */
export const NUMBER_LIMITS = [
  'less than',
  'fewer than',
  'up to',
  'at most',
  'no more than',
  'as few as',
  'as little as',
  'under',
  'below',
  'nearly',
  'almost',
];

/** Amber: dropping one reads something past as current. */
export const DATED = ['used to', 'formerly', 'until recently', 'previously', 'in the past', 'historically', 'once again'];

/** Amber: concession markers ("While X, Y" read as "X"). */
export const CONCESSIONS = ['while', 'although', 'though', 'even though', 'whereas', 'admittedly', 'granted', 'despite'];

/** Units that change a number's size. */
export const NUMBER_UNITS = ['million', 'billion', 'trillion', 'thousand', 'hundred', 'percent', 'per cent', 'percentage'];

/** Prefixes that negate the rest of the word ("un|likely"). */
export const NEGATING_PREFIXES = ['non', 'un', 'in', 'im', 'il', 'ir', 'dis'];
/** Suffixes that negate the rest of the word ("hope|less", "does|n't"). */
export const NEGATING_SUFFIXES = ["n't", 'not', 'less'];

/** Tag words that claim certainty (for the off-by-default tag check). */
export const TAG_ABSOLUTES = [
  'will',
  'always',
  'all',
  'every',
  'guarantees',
  'guarantee',
  'inevitably',
  'inevitable',
  'certainly',
  'definitely',
  'proves',
  'must',
];

/** Read-text words that hedge (for the tag check). */
export const READ_HEDGES = ['may', 'might', 'could', 'possibly', 'potentially', 'perhaps', 'likely', 'probably', 'some', 'sometimes'];

/** Words before a period that don't end a sentence. */
export const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'vs',
  'etc',
  'al',
  'inc',
  'co',
  'corp',
  'ltd',
  'jr',
  'sr',
  'no',
  'vol',
  'pp',
  'fig',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'e.g',
  'i.e',
  'u.s',
  'u.k',
  'u.n',
]);

/** Split a settings list (one entry per line; commas also separate). */
export function parseList(raw: unknown, fallback: readonly string[]): string[] {
  if (typeof raw !== 'string') return [...fallback];
  const out = raw
    .split(/\r?\n|,/)
    .map((s) => fold(s).trim().replace(/\s+/g, ' '))
    .filter((s) => s && !s.startsWith('#'));
  return out.length ? [...new Set(out)] : [];
}

/** Lowercase and straighten apostrophes, for matching. */
export function fold(s: string): string {
  return s.toLowerCase().replace(/[‘’ʼ]/g, "'");
}
