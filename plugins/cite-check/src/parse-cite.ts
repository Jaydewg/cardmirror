/**
 * Split a debate cite into its parts. The reference format is
 * CardMirror's own cite style (src/editor/ai/cite-creator.ts):
 *
 *   First Last YY, quals, "Title," Publication, mm/dd/yyyy, URL
 *
 * Real cites drift from it: brackets or dashes after the short cite,
 * quals before or without the full name, missing titles, DOIs instead
 * of URLs. The parser is deliberately forgiving: anything it can't find
 * is null/empty, and every rule treats "not found" as a possible
 * omission, never as proof.
 *
 * Offsets aren't needed: every `*Text` field is an exact substring of
 * the cite paragraph, so a mark can anchor on it by `match`.
 */

export interface ShortCite {
  /** The short cite as written ("Smith & Jones 24"). */
  text: string;
  /** The names part, without the date ("Smith & Jones"). */
  names: string;
  /** Surnames, in order ("et al." dropped). */
  surnames: string[];
  etAl: boolean;
  /** The date part as written ("24", "9/23", "2019"), or null. */
  dateText: string | null;
  /** Year, when the date part pins one (2-digit years are read as the
   *  most recent year ending in those digits that isn't in the future). */
  year: number | null;
  month: number | null;
  day: number | null;
  /** Says outright there is no date ("n.d.", "ND", "no date"). */
  noDate: boolean;
}

export interface CiteDate {
  text: string;
  year: number;
  month: number | null;
  day: number | null;
}

export interface ParsedCite {
  short: ShortCite | null;
  /** The whole cite text (all cite paragraphs, space-joined). */
  full: string;
  /** The cite after the short cite, separators trimmed. */
  rest: string;
  /** The author's full name as written after the short cite, if any. */
  authorText: string | null;
  qualsText: string | null;
  titleText: string | null;
  publicationText: string | null;
  /** First publication date found after the short cite. */
  date: CiteDate | null;
  /** An "accessed / retrieved" date, when that's the only date. */
  accessedOnly: boolean;
  urls: string[];
  doi: string | null;
  /** Looks like a book or chapter (publisher, ISBN, pages). */
  bookLike: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Lowercase, strip diacritics and curly quotes. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

/** The year a 2-digit (or 1-digit) cite year means, given today. */
export function expandYear(digits: string, today: Date): number {
  const n = Number(digits);
  if (digits.length === 4) return n;
  const now = today.getFullYear();
  const century = Math.floor(now / 100) * 100;
  const y = century + n;
  return y > now ? y - 100 : y;
}

const SHORT_DATE_RE = /(?:^|\s)('?)(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}|\d{1,2})([a-z])?\s*$/i;
const NO_DATE_RE = /(?:^|\s)(n\.?\s?d\.?|no date|undated)\s*$/i;

export function parseShortCite(raw: string, today = new Date()): ShortCite | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let names = text;
  let dateText: string | null = null;
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let noDate = false;
  const nd = NO_DATE_RE.exec(text);
  const m = nd ? null : SHORT_DATE_RE.exec(text);
  if (nd) {
    noDate = true;
    names = text.slice(0, nd.index).trim();
  } else if (m) {
    dateText = m[2]!;
    names = text.slice(0, m.index).trim();
    if (dateText.includes('/')) {
      const [mo, d, y] = dateText.split('/');
      month = Number(mo);
      day = Number(d);
      year = y ? expandYear(y, today) : null;
    } else {
      year = expandYear(dateText, today);
    }
  }
  names = names.replace(/[,;:(\[]+$/, '').trim();
  const etAl = /\bet\.?\s*al\.?/i.test(names);
  const surnames = names
    .replace(/\bet\.?\s*al\.?/gi, '')
    .split(/\s*(?:&|\band\b|,)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    // "Mary Ann Smith" in a short cite: the surname is the last word.
    .map((s) => s.split(/\s+/).pop()!)
    .filter((s) => /\p{L}/u.test(s));
  return { text, names, surnames, etAl, dateText, year, month, day, noDate };
}

const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE_PATTERNS: { re: RegExp; read(m: RegExpExecArray, today: Date): CiteDate | null }[] = [
  {
    // 2024-03-07
    re: /\b(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/,
    read: (m) => ({ text: m[0], year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    // 3/7/2024, 03/07/24
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/,
    read: (m, today) => ({ text: m[0], year: expandYear(m[3]!, today), month: Number(m[1]), day: Number(m[2]) }),
  },
  {
    // March 7, 2024 / Mar. 7 2024
    re: new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'),
    read: (m) => ({ text: m[0], year: Number(m[3]), month: MONTHS[m[1]!.slice(0, 3).toLowerCase()] ?? null, day: Number(m[2]) }),
  },
  {
    // 7 March 2024
    re: new RegExp(`\\b(\\d{1,2})\\s+${MONTH_NAME},?\\s+(\\d{4})\\b`, 'i'),
    read: (m) => ({ text: m[0], year: Number(m[3]), month: MONTHS[m[2]!.slice(0, 3).toLowerCase()] ?? null, day: Number(m[1]) }),
  },
  {
    // March 2024
    re: new RegExp(`\\b${MONTH_NAME},?\\s+(\\d{4})\\b`, 'i'),
    read: (m) => ({ text: m[0], year: Number(m[2]), month: MONTHS[m[1]!.slice(0, 3).toLowerCase()] ?? null, day: null }),
  },
  {
    // a bare year
    re: /\b(1[89]\d{2}|20\d{2})\b/,
    read: (m) => ({ text: m[0], year: Number(m[1]), month: null, day: null }),
  },
];

/** Earliest date in `text`, by position, valid month/day only. */
export function findDate(text: string, today = new Date()): (CiteDate & { index: number }) | null {
  let best: (CiteDate & { index: number }) | null = null;
  for (const p of DATE_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const d = p.read(m, today);
    if (!d) continue;
    if (d.month !== null && (d.month < 1 || d.month > 12)) continue;
    if (d.day !== null && (d.day < 1 || d.day > 31)) continue;
    if (!best || m.index < best.index) best = { ...d, index: m.index };
  }
  return best;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'“”]+/gi;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>“”]+)/i;
const TITLE_RE = /["“]([^"“”]{3,}?)["”]/;
const ACCESSED_RE = /\b(?:date\s+)?(?:last\s+)?(?:accessed|retrieved|visited|DOA)\b[:\s]*/i;
const BOOK_RE = /\b(?:press|publish(?:er|ing|ed by)|isbn|pp?\.\s*\d|pgs?\.?\s*\d|ch(?:apter|\.)\s*\d|edition|ed\.\s|eds\.|vol\.)/i;

function trimUrl(u: string): string {
  return u.replace(/[.,;:!?)\]}]+$/, '');
}

/** Words that open a quals clause rather than continue a name. */
const QUAL_START = /^(?:is|was|a|an|the|professor|prof|dr|director|senior|fellow|former|ph\.?d|md|jd|editor|reporter|writer|author|researcher|analyst|lecturer|associate|assistant|chair|president|ceo|founder)\b/i;

export function parseCite(shortCiteText: string, citeParagraphs: readonly string[], today = new Date()): ParsedCite {
  const full = citeParagraphs.join(' ').replace(/\s+/g, ' ').trim();
  let short = parseShortCite(shortCiteText, today);
  // No cite-styled run: try the start of the cite ("Smith 24, ...").
  if (!short && full) {
    const lead = /^([^,;:(\[—–-]{2,60}?\s(?:'?\d{1,2}\/\d{1,2}|'?\d{4}|'?\d{1,2}))(?=[\s,;:(\[—–-]|$)/.exec(full);
    if (lead) short = parseShortCite(lead[1]!, today);
  }
  // Where the short cite ends, and any full name written BEFORE its
  // date ("Adrien Rose & Christian Wilson 24, …" — CardMirror's own
  // format, where the cite-styled runs "Rose & … Wilson 24" aren't one
  // contiguous string).
  let rest = full;
  let nameBefore: string | null = null;
  if (short) {
    const head = fold(full.slice(0, 160));
    const at = head.indexOf(fold(short.text));
    if (at >= 0) {
      rest = full.slice(at + short.text.length);
      const before = full.slice(0, at).trim();
      if (before) nameBefore = `${before} ${short.names}`.trim();
    } else if (short.dateText) {
      const esc = short.dateText.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const m = new RegExp(`(^|\\s)'?${esc}[a-z]?(?=[\\s,;:(\\[\\u2014\\u2013-]|$)`, 'i').exec(full.slice(0, 160));
      const last = short.surnames[short.surnames.length - 1];
      if (m && last && fold(full.slice(0, m.index)).includes(fold(last))) {
        nameBefore = full.slice(0, m.index).trim();
        rest = full.slice(m.index + m[0].length);
      }
    }
  }
  rest = rest.replace(/^[\s,;:.(\[—–-]+/, '').replace(/[\s)\]]+$/, '');

  const urls = [...rest.matchAll(URL_RE)].map((m) => trimUrl(m[0]));
  const doiMatch = DOI_RE.exec(rest);
  const doi = doiMatch ? trimUrl(doiMatch[1]!) : null;
  // Everything before the first URL / DOI is the descriptive part.
  const cut = Math.min(
    ...[rest.search(URL_RE), doiMatch ? rest.search(/\bdoi[:\s]|\b10\.\d{4,9}\//i) : -1].filter((i) => i >= 0),
    rest.length,
  );
  const desc = rest.slice(0, cut);

  const title = TITLE_RE.exec(desc);
  const titleText = title ? title[1]!.replace(/[,.]\s*$/, '').trim() : null;
  const titleAt = title ? title.index : -1;

  // Author name: a run of capitalized words leading the rest that
  // contains one of the short-cite surnames.
  const isNameLike = (s: string): boolean => {
    const w = s.trim().split(/\s+/);
    return (
      w.length >= 1 &&
      w.length <= 9 &&
      w.every((x) => /^[\p{Lu}][\p{L}.'’-]*$|^(?:&|and|et|al\.?|de|van|von|der|la|le|da|del|bin|al|el)$/u.test(x))
    );
  };
  let authorText: string | null = nameBefore && isNameLike(nameBefore) && nameBefore.split(/\s+/).length > (short?.surnames.length ?? 0) ? nameBefore : null;
  let afterAuthor = desc;
  if (!authorText && short && short.surnames.length > 0) {
    const firstClause = desc.split(/[,;(\[]/)[0] ?? '';
    const words = firstClause.trim().split(/\s+/);
    const folded = short.surnames.map(fold);
    const nameLike = words.length <= 7 && words.every((w) => /^[\p{Lu}][\p{L}.'’-]*$|^(?:&|and|de|van|von|der|la|le|da|del|bin|al|el)$/u.test(w));
    if (nameLike && words.some((w) => folded.includes(fold(w.replace(/[.,]$/, ''))))) {
      authorText = firstClause.trim();
      afterAuthor = desc.slice(desc.indexOf(authorText) + authorText.length).replace(/^[\s,;:—–-]+/, '');
    }
  }

  // Quals: after the name, up to the title; without a title, the first
  // clause that isn't a date (a guess — rules treat it gently).
  let qualsText: string | null = null;
  if (titleAt >= 0) {
    const start = authorText ? desc.indexOf(afterAuthor) : 0;
    const q = desc.slice(Math.max(0, start), titleAt).replace(/^[\s,;:—–-]+|[\s,;:(\[—–-]+$/g, '');
    qualsText = q || null;
  } else if (afterAuthor) {
    const first = afterAuthor.split(/\s*[;,]\s*(?=[A-Z0-9"“])/)[0]?.trim() ?? '';
    qualsText = first && !findDate(first, today) && (authorText || QUAL_START.test(first)) ? first.replace(/[,;.]$/, '') : null;
  }
  if (qualsText && qualsText.length < 2) qualsText = null;

  let publicationText: string | null = null;
  if (title) {
    const after = desc.slice(titleAt + title[0].length).replace(/^[\s,;:.]+/, '');
    const pub = after.split(/\s*[,;]\s*/)[0]?.trim() ?? '';
    publicationText = pub && !findDate(pub, today) ? pub : null;
  }

  // Dates: skip an "accessed" date when another date exists.
  const accessed = ACCESSED_RE.exec(rest);
  const dateHaystack = accessed ? rest.slice(0, accessed.index) + ' '.repeat(rest.length - accessed.index) : rest;
  // URL text is not a date source (…/2019/05/… often is, but unreliably).
  const noUrls = dateHaystack.replace(URL_RE, (u) => ' '.repeat(u.length));
  let found = findDate(noUrls, today);
  let accessedOnly = false;
  if (!found && accessed) {
    found = findDate(rest.slice(accessed.index), today);
    accessedOnly = found !== null;
  }
  const date = found ? { text: found.text, year: found.year, month: found.month, day: found.day } : null;

  return {
    short,
    full,
    rest,
    authorText,
    qualsText,
    titleText,
    publicationText,
    date,
    accessedOnly,
    urls,
    doi,
    bookLike: BOOK_RE.test(rest),
  };
}

/** Hostname of a cite URL (www. stripped), or null. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
