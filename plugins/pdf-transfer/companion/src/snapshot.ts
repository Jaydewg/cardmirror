/**
 * `doc.read` snapshots: checked on the way in (they come from the plugin,
 * or from a Hybrid PDF someone sent, so they are untrusted), and turned
 * into paras.
 */
import type {
  PluginCard,
  PluginDocSnapshot,
  PluginOutlineItem,
  PluginTextSpan,
  PluginTextStyle,
} from '@cardmirror/plugin-api';
import { normalizeRuns, type Para, type ParaRole, type Run } from './model.js';

const MAX_TEXT = 200_000;
const MAX_ITEMS = 50_000;
const MAX_SPANS = 10_000;
const HEADING_TYPES = new Set(['pocket', 'hat', 'block', 'tag', 'analytic']);
const LEVELS: Record<string, number> = { pocket: 1, hat: 2, block: 3, tag: 4, analytic: 4 };
const KNOWN_STYLES = new Set<PluginTextStyle>([
  'highlight',
  'shading',
  'underline',
  'emphasis',
  'cite',
  'bold',
  'italic',
]);
const COLOR_NAME_RE = /^[A-Za-z]{1,20}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS).map(str) : []);
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length <= 128 ? v : null);

function spans(v: unknown, text: string): PluginTextSpan[] {
  if (!Array.isArray(v)) return [];
  const out: PluginTextSpan[] = [];
  for (const raw of v.slice(0, MAX_SPANS)) {
    if (!raw || typeof raw !== 'object') continue;
    const { from, to, style, color } = raw as Record<string, unknown>;
    if (typeof style !== 'string' || !KNOWN_STYLES.has(style as PluginTextStyle)) continue;
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    const a = Math.max(0, Math.min(from as number, text.length));
    const b = Math.max(a, Math.min(to as number, text.length));
    if (a === b) continue;
    const span: PluginTextSpan = { from: a, to: b, style: style as PluginTextStyle };
    if (style === 'highlight') span.color = typeof color === 'string' && COLOR_NAME_RE.test(color) ? color : 'yellow';
    if (style === 'shading') {
      const c = typeof color === 'string' ? color.toLowerCase() : '';
      span.color = HEX_RE.test(c) ? c : '#d2d2d2';
    }
    out.push(span);
  }
  return out;
}

function spanLists(v: unknown, texts: string[]): PluginTextSpan[][] {
  const list = Array.isArray(v) ? v : [];
  return texts.map((t, i) => spans(list[i], t));
}

/** A clean copy of an untrusted snapshot, or null when it isn't one. */
export function parseSnapshot(raw: unknown): PluginDocSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['outline']) || !Array.isArray(r['cards'])) return null;
  const outline: PluginOutlineItem[] = [];
  for (const o of (r['outline'] as unknown[]).slice(0, MAX_ITEMS)) {
    if (!o || typeof o !== 'object') continue;
    const item = o as Record<string, unknown>;
    const type = String(item['type']);
    if (!HEADING_TYPES.has(type)) continue;
    const text = str(item['text']);
    const clean: PluginOutlineItem = {
      id: idOrNull(item['id']),
      type: type as PluginOutlineItem['type'],
      level: LEVELS[type]!,
      text,
    };
    if (item['formatting'] !== undefined) clean.formatting = spans(item['formatting'], text);
    outline.push(clean);
  }
  const cards: PluginCard[] = [];
  for (const c of (r['cards'] as unknown[]).slice(0, MAX_ITEMS)) {
    if (!c || typeof c !== 'object') continue;
    const card = c as Record<string, unknown>;
    const heading = str(card['heading']);
    const citeParagraphs = strList(card['citeParagraphs']);
    const body = strList(card['body']);
    const undertags = strList(card['undertags']);
    const clean: PluginCard = {
      headingId: idOrNull(card['headingId']),
      kind: card['kind'] === 'analytic' ? 'analytic' : 'card',
      heading,
      cite: str(card['cite']),
      citeParagraphs,
      body,
      undertags,
    };
    const f = card['formatting'];
    if (f && typeof f === 'object') {
      const fm = f as Record<string, unknown>;
      clean.formatting = {
        heading: spans(fm['heading'], heading),
        citeParagraphs: spanLists(fm['citeParagraphs'], citeParagraphs),
        body: spanLists(fm['body'], body),
        undertags: spanLists(fm['undertags'], undertags),
      };
    }
    cards.push(clean);
  }
  return {
    docUid: str(r['docUid']).slice(0, 128),
    docId: idOrNull(r['docId']),
    title: str(r['title']).slice(0, 500) || 'Untitled',
    outline,
    cards,
    stats: { cards: cards.length, readAloudWords: { body: 0, other: 0 } },
  };
}

/** Cut `text` into runs at every span edge. */
export function spansToRuns(text: string, list: readonly PluginTextSpan[] = []): Run[] {
  if (!text) return [];
  const cuts = new Set<number>([0, text.length]);
  for (const s of list) {
    cuts.add(s.from);
    cuts.add(s.to);
  }
  const edges = [...cuts].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const runs: Run[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    const run: Run = { text: text.slice(from, to) };
    for (const s of list) {
      if (s.from > from || s.to < to) continue;
      if (s.style === 'highlight') run.highlight = s.color ?? 'yellow';
      else if (s.style === 'shading') run.shading = s.color ?? '#d2d2d2';
      else run[s.style] = true;
    }
    runs.push(run);
  }
  return normalizeRuns(runs);
}

/**
 * Snapshot → paras, in document order. The outline lists every tag and
 * analytic in order and the cards list follows the same order, so the
 * n-th tag/analytic item heads the n-th card (ids double-check it).
 * Card parts come out heading, undertags, cite paragraphs, body (the
 * order a card is assembled in): the snapshot doesn't record how
 * undertags interleave with the rest.
 * Paragraphs outside cards are not in a snapshot, so not here either.
 */
export function snapshotToParas(snap: PluginDocSnapshot): Para[] {
  const paras: Para[] = [];
  const used = new Set<number>();
  const byId = new Map<string, number>();
  snap.cards.forEach((c, i) => {
    if (c.headingId && !byId.has(c.headingId)) byId.set(c.headingId, i);
  });
  let next = 0;
  const pushCard = (card: PluginCard, role: ParaRole, headingSpans?: PluginTextSpan[]): void => {
    const f = card.formatting;
    const head: Para = { role, runs: spansToRuns(card.heading, f?.heading ?? headingSpans) };
    if (card.headingId) head.headingId = card.headingId;
    paras.push(head);
    card.undertags.forEach((t, i) => paras.push({ role: 'undertag', runs: spansToRuns(t, f?.undertags[i]) }));
    card.citeParagraphs.forEach((t, i) => paras.push({ role: 'cite', runs: spansToRuns(t, f?.citeParagraphs[i]) }));
    card.body.forEach((t, i) => paras.push({ role: 'body', runs: spansToRuns(t, f?.body[i]) }));
  };
  for (const item of snap.outline) {
    if (item.type === 'tag' || item.type === 'analytic') {
      let idx = item.id != null ? byId.get(item.id) : undefined;
      if (idx === undefined || used.has(idx)) {
        while (next < snap.cards.length && used.has(next)) next++;
        idx = next < snap.cards.length ? next : undefined;
      }
      if (idx === undefined) {
        paras.push({ role: item.type, runs: spansToRuns(item.text, item.formatting) });
        continue;
      }
      used.add(idx);
      pushCard(snap.cards[idx]!, item.type, item.formatting);
      continue;
    }
    const p: Para = { role: item.type, runs: spansToRuns(item.text, item.formatting) };
    if (item.id) p.headingId = item.id;
    paras.push(p);
  }
  // Cards the outline didn't name (shouldn't happen): keep them, at the end.
  snap.cards.forEach((c, i) => {
    if (!used.has(i)) pushCard(c, c.kind === 'analytic' ? 'analytic' : 'tag');
  });
  return paras;
}
