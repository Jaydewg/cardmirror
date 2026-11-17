/**
 * Highlight Check: flags highlighting that changes what a card says.
 *
 * Reads each card's text and what is read aloud in it (`doc.read`,
 * `PluginCard.bodyRead`), runs the rules in analyze.ts, squiggles the
 * problems in the card (`doc.annotate`) and lists them in a side panel
 * (`ui.panel`) whose rows jump to the card (`doc.jumpTo`). Checking is
 * on demand (a command, or the panel's Re-check); "Re-check as I edit"
 * turns on live refresh (`doc.events`). "Ignore" choices travel with the
 * .cmir (`files.data`). Every optional namespace is feature-detected:
 * the plugin degrades to whatever it was granted.
 */
import type {
  CardMirrorPluginApi,
  PluginAnnotation,
  PluginCard,
  PluginDefinition,
  PluginPanelHandle,
} from '@cardmirror/plugin-api';
import { analyzeCard, DEFAULT_RULES, occurrenceOf, type Finding, type RuleConfig, type ToggleRule } from './analyze.js';
import { renderPanel, countBySeverity, type PanelCard, type PanelFilter, type PanelFinding } from './panel.js';
import { DEFAULT_EXCEPTIONS, DEFAULT_HEDGES, DEFAULT_NEGATIONS, DEFAULT_QUALIFIERS, fold, parseList } from './words.js';

export const PLUGIN_ID = 'highlight-check';
export const PLUGIN_NAME = 'Highlight Check';
/** Must equal `permissions` in cardmirror-plugin.json (a test checks). */
export const PLUGIN_PERMISSIONS = ['doc.annotate', 'doc.events', 'doc.read', 'files.data', 'ui.panel'];

export const PERMISSION_REASONS: Record<string, string> = {
  'doc.read': 'To read your cards and see which words are highlighted.',
  'doc.annotate': 'To underline suspicious highlighting, like spellcheck.',
  'ui.panel': 'To list every finding in one place.',
  'doc.events': 'To re-check as you edit, when you turn that on.',
  'files.data': 'To remember findings you chose to ignore, inside the file.',
};

const SAVE_VERSION = 1;
const MAX_MARKS = 2000;
const NEEDS_NEWER = `${PLUGIN_NAME} needs a newer CardMirror: this one doesn’t tell plugins what’s highlighted.`;

/** Setting key → the rule it switches. */
const RULE_SETTINGS: [key: string, rule: ToggleRule, label: string, description: string][] = [
  ['checkReported', 'reported', 'Dropped attributions', '“Critics claim”, “the myth that” … left out, so a view the author rejects reads as theirs.'],
  ['checkConditions', 'condition', 'Dropped conditions', '“If”, “unless” … left out, so a conditional reads as a flat claim.'],
  ['checkNumbers', 'number', 'Numbers', 'Part of a number read, or its unit (%, million) or limit (“less than”) left out.'],
  ['checkDated', 'dated', 'Dated wording', '“Used to”, “formerly” … left out, so something past reads as current.'],
  ['checkConcessions', 'concession', 'Concessions', '“While X, Y” with X read and none of Y.'],
  ['checkQuestions', 'question', 'Questions', 'Part of a question read as if it were a claim.'],
  ['checkStitched', 'stitched', 'Stitched sentences', 'The middles of two sentences read as one claim.'],
  ['checkBrackets', 'brackets', 'Brackets and ellipses (note)', 'Bracketed or cut text inside what is read.'],
  ['checkGaps', 'gap', 'Long skips (note)', 'Many unread words between two read ones.'],
  ['checkLetterPicks', 'letter-pick', 'Letters picked from inside words (note)', 'e.g. “rapist” read out of “therapist”.'],
  ['checkTag', 'tag', 'Tag stronger than the read text (note)', 'The tag says “will” while the read text says “may”.'],
];

interface CardResult {
  card: PluginCard;
  findings: Finding[];
}

interface DocResult {
  docUid: string;
  title: string;
  cards: CardResult[];
  /** The build doesn't report `bodyRead`. */
  unsupported: boolean;
  /** Edited since this check. */
  stale: boolean;
}

function settingString(api: CardMirrorPluginApi, key: string): unknown {
  return api.settings.get(key);
}

export function ruleConfig(api: CardMirrorPluginApi): RuleConfig {
  const rules = { ...DEFAULT_RULES };
  for (const [key, rule] of RULE_SETTINGS) {
    const v = api.settings.get(key);
    if (typeof v === 'boolean') rules[rule] = v;
  }
  const gap = api.settings.get('gapWords');
  return {
    negations: parseList(settingString(api, 'negations'), DEFAULT_NEGATIONS),
    qualifiers: parseList(settingString(api, 'qualifiers'), DEFAULT_QUALIFIERS),
    hedges: api.settings.get('checkHedges') === true ? parseList(settingString(api, 'hedges'), DEFAULT_HEDGES) : [],
    exceptions: parseList(settingString(api, 'exceptions'), DEFAULT_EXCEPTIONS),
    rules,
    gapWords: typeof gap === 'number' && gap > 0 ? Math.round(gap) : 40,
  };
}

/** A finding's text, for annotations and ignore keys. */
function sourceText(card: PluginCard, f: Finding): string {
  return f.part === 'heading' ? card.heading : card.body[f.index] ?? '';
}

/** Stable across edits elsewhere and highlight changes: the rule, the
 *  flagged words and the start of their sentence. */
export function ignoreKeyOf(card: PluginCard, f: Finding): string | null {
  if (!card.headingId) return null;
  const text = sourceText(card, f);
  const words = fold(text.slice(f.from, f.to)).replace(/\s+/g, ' ');
  const sentence = fold(text.slice(f.context.from, f.context.to)).replace(/\s+/g, ' ').slice(0, 60);
  return `${card.headingId}|${f.ruleId}|${words}|${sentence}`.slice(0, 190);
}

export function toAnnotations(
  result: DocResult,
  ignored: ReadonlySet<string>,
  opts: { markInfo: boolean; actions: (card: CardResult, f: Finding, key: string) => PluginAnnotation['actions'] },
): PluginAnnotation[] {
  const out: PluginAnnotation[] = [];
  for (const c of result.cards) {
    const id = c.card.headingId;
    if (!id) continue;
    for (const f of c.findings) {
      if (f.severity === 'info' && !opts.markInfo) continue;
      const key = ignoreKeyOf(c.card, f)!;
      if (ignored.has(key)) continue;
      const text = sourceText(c.card, f);
      const match = text.slice(f.from, f.to);
      if (!match) continue;
      out.push({
        headingId: id,
        part: f.part,
        index: f.index,
        match,
        occurrence: occurrenceOf(text, match, f.from),
        severity: f.severity,
        message: f.message,
        key: f.ruleId,
        actions: opts.actions(c, f, key),
      });
      if (out.length >= MAX_MARKS) return out;
    }
  }
  return out;
}

/** The plugin's state across activations (the api object is re-minted
 *  on every permission change; results and ignores persist). */
class HighlightChecker {
  api!: CardMirrorPluginApi;
  private results = new Map<string, DocResult>();
  private ignored = new Map<string, Set<string>>();
  private panel: PluginPanelHandle | null = null;
  private filter: PanelFilter = 'all';
  private focusHeadingId: string | null = null;

  live(): boolean {
    return this.api.settings.get('liveRefresh') === true && !!this.api.events;
  }

  focusedUid(): string | null {
    return this.api.files?.focusedDoc()?.docUid ?? this.api.doc?.read?.()?.docUid ?? null;
  }

  /** Check one doc (default: focused), mark it, refresh the panel. */
  check(docUid?: string): DocResult | null {
    const snap = this.api.doc?.read?.(docUid);
    if (!snap) return null;
    const cfg = ruleConfig(this.api);
    let unsupported = false;
    const cards: CardResult[] = [];
    for (const card of snap.cards) {
      const findings = analyzeCard(card, cfg);
      if (findings === null) {
        unsupported = true;
        break;
      }
      if (findings.length) cards.push({ card, findings });
    }
    const result: DocResult = { docUid: snap.docUid, title: snap.title, cards: unsupported ? [] : cards, unsupported, stale: false };
    this.results.set(snap.docUid, result);
    this.mark(result);
    if (this.panel?.isVisible() && snap.docUid === this.focusedUid()) this.render();
    return result;
  }

  /** Forget a doc's results and remove its marks. */
  clear(docUid: string): void {
    this.results.delete(docUid);
    this.api.annotations?.clear({ docUid });
    if (this.panel?.isVisible()) this.render();
  }

  /** A doc changed: re-check it (live) or note the panel is stale. */
  changed(docUid: string): void {
    const r = this.results.get(docUid);
    if (!r) return;
    if (this.live()) {
      this.check(docUid);
      return;
    }
    if (!r.stale) {
      r.stale = true;
      if (this.panel?.isVisible() && docUid === this.focusedUid()) this.render();
    }
  }

  private ignoredIn(docUid: string): Set<string> {
    let s = this.ignored.get(docUid);
    if (!s) this.ignored.set(docUid, (s = new Set()));
    return s;
  }

  private mark(result: DocResult): void {
    const annotations = this.api.annotations;
    if (!annotations) return;
    const items = toAnnotations(result, this.ignoredIn(result.docUid), {
      markInfo: this.api.settings.get('markInfo') === true,
      actions: (c, _f, key) => [
        { label: 'Ignore here', run: () => this.ignore(result.docUid, key) },
        { label: `Show in ${PLUGIN_NAME}`, run: () => void this.showPanel(c.card.headingId) },
      ],
    });
    try {
      annotations.set(items, { docUid: result.docUid });
    } catch (err) {
      console.error(`[${PLUGIN_ID}] annotations.set failed:`, err);
    }
  }

  ignore(docUid: string, key: string): void {
    this.ignoredIn(docUid).add(key);
    const r = this.results.get(docUid);
    if (r) this.mark(r); // re-mark from the last check; no re-read needed
    if (this.panel?.isVisible()) this.render();
  }

  restoreIgnored(docUid: string): number {
    const n = this.ignoredIn(docUid).size;
    this.ignored.delete(docUid);
    const r = this.results.get(docUid);
    if (r) this.mark(r);
    if (this.panel?.isVisible()) this.render();
    return n;
  }

  // ── Panel ──────────────────────────────────────────────────────────

  showPanel(focusHeadingId?: string | null): boolean {
    const panelApi = this.api.panel;
    if (!panelApi) {
      this.explain('ui.panel', 'Show a side panel');
      return false;
    }
    this.panel = panelApi.get({ title: 'Highlighting' });
    this.focusHeadingId = focusHeadingId ?? null;
    this.panel.show();
    this.render();
    return true;
  }

  render(): void {
    if (!this.panel) return;
    const uid = this.focusedUid();
    const result = uid ? this.results.get(uid) : undefined;
    const ignored = uid ? this.ignoredIn(uid) : new Set<string>();
    const cards: PanelCard[] = (result?.cards ?? []).map((c) => ({
      headingId: c.card.headingId,
      heading: c.card.heading,
      findings: c.findings
        .map((f): PanelFinding => ({
          ...f,
          text: sourceText(c.card, f),
          read: f.part === 'heading' ? [] : c.card.bodyRead?.[f.index] ?? [],
          ignoreKey: ignoreKeyOf(c.card, f),
        }))
        .filter((f) => !f.ignoreKey || !ignored.has(f.ignoreKey)),
    }));
    const blocked = !this.api.doc?.read
      ? `${PLUGIN_NAME} needs “Read your open documents”. Allow it with the shield in Settings → Plugins.`
      : !uid
        ? 'Open a document to check its highlighting.'
        : result?.unsupported
          ? NEEDS_NEWER
          : null;
    renderPanel(
      this.panel.el,
      {
        title: result ? `Highlighting in ${result.title}` : PLUGIN_NAME,
        cards,
        checked: !!result,
        stale: !!result?.stale,
        live: this.live(),
        filter: this.filter,
        ignoredCount: ignored.size,
        blocked,
        focusHeadingId: this.focusHeadingId,
      },
      {
        jump: (headingId) => void this.api.doc?.jumpTo?.({ headingId, ...(uid ? { docUid: uid } : {}) }),
        ignore: (key) => uid && this.ignore(uid, key),
        recheck: () => {
          if (!this.check()) this.explain('doc.read', 'Read your open documents');
          this.render();
        },
        setFilter: (f) => {
          this.filter = f;
          this.render();
        },
        restoreIgnored: () => uid && this.restoreIgnored(uid),
      },
    );
    this.focusHeadingId = null;
  }

  // ── Persistence of ignores (files.data) ────────────────────────────

  saveData(docUid: string): { data: unknown; summary: string } | null {
    const set = this.ignored.get(docUid);
    if (!set || set.size === 0) return null;
    return {
      data: { v: SAVE_VERSION, ignored: [...set].sort() },
      summary: `${PLUGIN_NAME}: ${set.size} ignored finding${set.size === 1 ? '' : 's'}`,
    };
  }

  loadData(docUid: string, data: unknown): void {
    const d = data as { v?: unknown; ignored?: unknown } | null;
    if (!d || d.v !== SAVE_VERSION || !Array.isArray(d.ignored)) return;
    const set = this.ignoredIn(docUid);
    for (const k of d.ignored) if (typeof k === 'string' && k.length <= 200) set.add(k);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  explain(permission: string, label: string): void {
    const status = this.api.permissions?.status(permission);
    this.api.showToast(
      status === 'denied'
        ? `${PLUGIN_NAME} needs “${label}”. Allow it with the shield in Settings → Plugins.`
        : `${PLUGIN_NAME} needs a newer CardMirror for this.`,
    );
  }

  /** Counts after ignores (tests, toasts). */
  counts(docUid: string): Record<'error' | 'warning' | 'info', number> {
    const r = this.results.get(docUid);
    const ignored = this.ignoredIn(docUid);
    return countBySeverity(
      (r?.cards ?? []).map((c) => ({
        headingId: c.card.headingId,
        heading: '',
        findings: c.findings
          .filter((f) => !ignored.has(ignoreKeyOf(c.card, f) ?? ''))
          .map((f) => ({ ...f, text: '', read: [], ignoreKey: null })),
      })),
    );
  }

  result(docUid: string): DocResult | undefined {
    return this.results.get(docUid);
  }
}

export function createPlugin(): PluginDefinition & { checker: HighlightChecker } {
  const checker = new HighlightChecker();
  const runCheck = (api: CardMirrorPluginApi): void => {
    checker.api = api;
    const r = checker.check();
    if (!r) return checker.explain('doc.read', 'Read your open documents');
    if (api.panel) {
      checker.showPanel();
      return;
    }
    if (r.unsupported) return api.showToast(NEEDS_NEWER);
    const c = checker.counts(r.docUid);
    api.showToast(
      c.error + c.warning + c.info === 0
        ? 'No suspicious highlighting found.'
        : `${c.error} red, ${c.warning} amber, ${c.info} notes. Right-click a mark for details.`,
    );
  };
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    apiVersion: 1,
    permissions: [...PLUGIN_PERMISSIONS],
    permissionReasons: { ...PERMISSION_REASONS },
    checker,
    settings: [
      {
        key: 'liveRefresh',
        label: 'Re-check as I edit',
        type: 'boolean',
        default: false,
        description: 'Off: marks and the panel update when you run Check highlighting or press Re-check.',
      },
      {
        key: 'markInfo',
        label: 'Also underline notes',
        type: 'boolean',
        default: false,
        description: 'Notes (blue) always show in the panel.',
      },
      ...RULE_SETTINGS.map(([key, rule, label, description]) => ({
        key,
        label,
        type: 'boolean' as const,
        default: DEFAULT_RULES[rule],
        description,
      })),
      {
        key: 'checkHedges',
        label: 'Dropped hedges (note)',
        type: 'boolean',
        default: false,
        description: '“May”, “might”, “could” … left out. Common, so off by default.',
      },
      { key: 'gapWords', label: 'Long skip: unread words in a row', type: 'number', default: 40 },
      {
        key: 'negations',
        label: 'Words that reverse a claim (red)',
        type: 'multiline',
        default: DEFAULT_NEGATIONS.join('\n'),
        description: 'One per line; phrases allowed. Words ending in n’t always count. Empty = off.',
      },
      {
        key: 'qualifiers',
        label: 'Words that limit a claim (amber)',
        type: 'multiline',
        default: DEFAULT_QUALIFIERS.join('\n'),
        description: 'One per line; phrases allowed. Empty = off.',
      },
      {
        key: 'hedges',
        label: 'Hedges',
        type: 'multiline',
        default: DEFAULT_HEDGES.join('\n'),
        description: 'Used when “Dropped hedges” is on.',
      },
      {
        key: 'exceptions',
        label: 'Never flag these phrases',
        type: 'multiline',
        default: DEFAULT_EXCEPTIONS.join('\n'),
        description: 'Dropping them doesn’t change the claim (“not only”, “no doubt” …).',
      },
    ],
    commands: [
      {
        id: `${PLUGIN_ID}.check`,
        label: `${PLUGIN_NAME}: Check highlighting`,
        keywords: ['highlight', 'shady', 'negation', 'evidence', 'ethics', 'misrepresent'],
        run: runCheck,
      },
      {
        id: `${PLUGIN_ID}.panel`,
        label: `${PLUGIN_NAME}: Show panel`,
        keywords: ['highlight', 'shady'],
        run: (api) => {
          checker.api = api;
          checker.showPanel();
        },
      },
      {
        id: `${PLUGIN_ID}.clear`,
        label: `${PLUGIN_NAME}: Clear marks`,
        keywords: ['highlight', 'squiggle'],
        run: (api) => {
          checker.api = api;
          const uid = checker.focusedUid();
          if (uid) checker.clear(uid);
        },
      },
      {
        id: `${PLUGIN_ID}.restore`,
        label: `${PLUGIN_NAME}: Restore ignored findings in this document`,
        run: (api) => {
          checker.api = api;
          const uid = checker.focusedUid();
          if (!uid) return;
          const n = checker.restoreIgnored(uid);
          api.showToast(n ? `Restored ${n} ignored finding${n === 1 ? '' : 's'}.` : 'Nothing was ignored here.');
        },
      },
    ],
    activate(api) {
      checker.api = api;
      const offs: (() => void)[] = [];
      if (api.files) {
        offs.push(
          api.files.onOpen((data, ctx) => {
            checker.loadData(ctx.docUid, data);
            if (checker.live()) checker.check(ctx.docUid);
          }),
        );
        offs.push(api.files.onSave((ctx) => checker.saveData(ctx.docUid)));
      }
      if (api.events) {
        offs.push(api.events.onDocChange((e) => checker.changed(e.docUid)));
        offs.push(
          api.events.onFocusChange((e) => {
            if (e.docUid && checker.live() && !checker.result(e.docUid)) checker.check(e.docUid);
            checker.render();
          }),
        );
      }
      offs.push(
        api.settings.onChanged((key) => {
          // New rules apply to a doc already checked; turning live on checks now.
          const uid = checker.focusedUid();
          if (uid && (checker.result(uid) || (key === 'liveRefresh' && checker.live()))) checker.check(uid);
          else checker.render();
        }),
      );
      if (checker.live()) checker.check();
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
