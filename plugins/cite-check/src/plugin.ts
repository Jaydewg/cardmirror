/**
 * Cite Check: flags problem cites as you work.
 *
 *   - On every edit (offline, cheap): missing or vague author quals,
 *     missing / mismatched dates, short cites that don't match the full
 *     cite, missing titles / links, weak sources (AI output, satire,
 *     Wikipedia, user-generated sites, shorteners …), and the same source
 *     cited two ways in one file.
 *   - On request ("Verify sources", online): DOIs and titles against
 *     Crossref, quals against OpenAlex affiliations, and the cited pages'
 *     own author / date / title — including dead links.
 *
 * Problems are squiggled in the cite (`doc.annotate`) and listed in a
 * side panel (`ui.panel`) whose rows jump to the card (`doc.read`'s
 * `jumpTo`). "Ignore" choices travel with the .cmir (`files.data`).
 * Every optional namespace is feature-detected: the plugin degrades to
 * whatever it was granted.
 */
import type {
  CardMirrorPluginApi,
  PluginAnnotation,
  PluginCard,
  PluginDefinition,
  PluginDocSnapshot,
  PluginPanelHandle,
} from '@cardmirror/plugin-api';
import { sortFindings, type Confirmation, type Finding } from './findings.js';
import { verifyCard, pool, type CacheLike, type VerifyResult } from './online.js';
import { renderPanel, countBySeverity, type PanelCard, type PanelFilter, type PanelModel } from './panel.js';
import { fold, parseCite, type ParsedCite } from './parse-cite.js';
import { checkCard, checkDocument, DEFAULT_VAGUE_TERMS, type RuleConfig } from './rules.js';
import { DEFAULT_SOURCE_RULES, parseDomainList } from './sources.js';

export const PLUGIN_ID = 'cite-check';
export const PLUGIN_NAME = 'Cite Check';
/** Must equal `permissions` in cardmirror-plugin.json (a test checks). */
export const PLUGIN_PERMISSIONS = [
  'doc.annotate',
  'doc.events',
  'doc.read',
  'files.data',
  'net.fetch',
  'ui.contextMenu',
  'ui.notices',
  'ui.panel',
];
/** Must equal `networkHosts` in cardmirror-plugin.json (a test checks). */
export const PLUGIN_NETWORK_HOSTS = ['*', 'api.crossref.org', 'api.openalex.org'];

export const PERMISSION_REASONS: Record<string, string> = {
  'doc.read': 'To read the cites in your open documents.',
  'doc.events': 'To re-check cites as you edit.',
  'doc.annotate': 'To underline problem cites, like spellcheck.',
  'ui.panel': 'To list every cite problem in one place.',
  'ui.contextMenu': 'To add “Verify this cite” to the right-click menu.',
  'ui.notices': 'To tell you when an online check finishes.',
  'files.data': 'To remember findings you chose to ignore, inside the file.',
  'net.fetch':
    'Only when you run “Verify sources”: to look cites up on Crossref and OpenAlex and open the cited pages. It sends titles, author names and links, nothing else.',
};

const SAVE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CardResult {
  card: PluginCard;
  parsed: ParsedCite;
  /** The cite as checked: online results are dropped when it changes. */
  citeKey: string;
  findings: Finding[];
  confirmations: Confirmation[];
}

interface DocResult {
  docUid: string;
  title: string;
  cards: CardResult[];
}

type Severity = Finding['severity'];

function settingString(api: CardMirrorPluginApi, key: string): string {
  const v = api.settings.get(key);
  return typeof v === 'string' ? v : '';
}

export function ruleConfig(api: CardMirrorPluginApi, today = new Date()): RuleConfig {
  const vague = settingString(api, 'vagueTerms')
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
  const maxAge = api.settings.get('maxAgeYears');
  return {
    today,
    vagueTerms: vague.length ? vague : DEFAULT_VAGUE_TERMS,
    sourceRules: [
      ...parseDomainList(settingString(api, 'untrustedDomains'), 'warning', 'on your untrusted list'),
      ...DEFAULT_SOURCE_RULES,
    ],
    trusted: parseDomainList(settingString(api, 'trustedDomains'), 'info', ''),
    maxAgeYears: typeof maxAge === 'number' && maxAge > 0 ? maxAge : 0,
  };
}

/** Offline findings for every card of a snapshot. */
export function checkSnapshot(snap: PluginDocSnapshot, cfg: RuleConfig): DocResult {
  const cards: CardResult[] = snap.cards.map((card) => {
    const parsed = parseCite(card.cite, card.citeParagraphs, cfg.today);
    return { card, parsed, citeKey: fold(parsed.full), findings: checkCard(card, parsed, cfg), confirmations: [] };
  });
  const cross = checkDocument(cards);
  for (const [i, extra] of cross) cards[i]!.findings.push(...extra);
  return { docUid: snap.docUid, title: snap.title, cards };
}

const ignoreKey = (headingId: string, ruleId: string): string => `${headingId}:${ruleId}`;

export function toAnnotations(
  result: DocResult,
  ignored: ReadonlySet<string>,
  opts: { markInfo: boolean; actions: (card: CardResult, f: Finding) => PluginAnnotation['actions'] },
): PluginAnnotation[] {
  const out: PluginAnnotation[] = [];
  for (const c of result.cards) {
    const id = c.card.headingId;
    if (!id) continue;
    for (const f of c.findings) {
      if (ignored.has(ignoreKey(id, f.ruleId))) continue;
      if (f.severity === 'info' && !opts.markInfo) continue;
      out.push({
        headingId: id,
        part: f.part,
        ...(f.index !== undefined ? { index: f.index } : {}),
        ...(f.match ? { match: f.match } : {}),
        severity: f.severity,
        message: f.message,
        key: f.ruleId,
        actions: opts.actions(c, f),
      });
    }
  }
  return out;
}

/** The plugin's state across activations (the api object is re-minted
 *  on every permission change; the findings and ignores persist). */
class CiteChecker {
  api!: CardMirrorPluginApi;
  private results = new Map<string, DocResult>();
  /** Online results, by heading id, valid while the cite is unchanged. */
  private online = new Map<string, Map<string, { citeKey: string; result: VerifyResult }>>();
  private ignored = new Map<string, Set<string>>();
  private cache = new Map<string, { t: number; v: unknown }>();
  private panel: PluginPanelHandle | null = null;
  private filter: PanelFilter = 'all';
  private verifying: { docUid: string; done: number; total: number } | null = null;
  private note: string | null = null;
  private focusHeadingId: string | null = null;

  // ── Checking ───────────────────────────────────────────────────────

  focusedUid(): string | null {
    return this.api.files?.focusedDoc()?.docUid ?? this.api.doc?.read?.()?.docUid ?? null;
  }

  /** Re-check one doc (default: focused); returns its result. */
  check(docUid?: string): DocResult | null {
    const snap = this.api.doc?.read?.(docUid);
    if (!snap) return null;
    const result = checkSnapshot(snap, ruleConfig(this.api));
    const online = this.online.get(snap.docUid);
    if (online) {
      for (const c of result.cards) {
        const hit = c.card.headingId ? online.get(c.card.headingId) : undefined;
        if (!hit) continue;
        if (hit.citeKey !== c.citeKey) {
          online.delete(c.card.headingId!);
          continue;
        }
        c.findings.push(...hit.result.findings);
        c.confirmations.push(...hit.result.confirmations);
      }
    }
    for (const c of result.cards) c.findings = sortFindings(c.findings);
    this.results.set(snap.docUid, result);
    this.mark(result);
    if (this.panel?.isVisible() && snap.docUid === this.focusedUid()) this.render();
    return result;
  }

  private ignoredIn(docUid: string): Set<string> {
    let s = this.ignored.get(docUid);
    if (!s) this.ignored.set(docUid, (s = new Set()));
    return s;
  }

  private mark(result: DocResult): void {
    const annotations = this.api.annotations;
    if (!annotations) return;
    const markInfo = this.api.settings.get('markInfo') === true;
    const items = toAnnotations(result, this.ignoredIn(result.docUid), {
      markInfo,
      actions: (c, f) => [
        { label: 'Ignore for this card', run: () => this.ignore(result.docUid, c.card.headingId!, f.ruleId) },
        { label: 'Show in Cite Check', run: () => this.showPanel(c.card.headingId) },
      ],
    });
    try {
      annotations.set(items, { docUid: result.docUid });
    } catch (err) {
      console.error('[cite-check] annotations.set failed:', err);
    }
  }

  ignore(docUid: string, headingId: string, ruleId: string): void {
    this.ignoredIn(docUid).add(ignoreKey(headingId, ruleId));
    this.check(docUid);
    if (this.panel?.isVisible()) this.render();
  }

  restoreIgnored(docUid: string): number {
    const n = this.ignoredIn(docUid).size;
    this.ignored.delete(docUid);
    this.check(docUid);
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
    this.panel = panelApi.get({ title: 'Cite problems' });
    this.focusHeadingId = focusHeadingId ?? null;
    if (!this.results.has(this.focusedUid() ?? '')) this.check();
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
      short: c.parsed.short?.text ?? '',
      findings: c.findings.filter((f) => !c.card.headingId || !ignored.has(ignoreKey(c.card.headingId, f.ruleId))),
      confirmations: c.confirmations,
    }));
    const model: PanelModel = {
      title: result ? `Cites in ${result.title}` : PLUGIN_NAME,
      cards,
      filter: this.filter,
      ignoredCount: ignored.size,
      verifying: this.verifying && this.verifying.docUid === uid ? this.verifying : null,
      note: this.note,
      blocked: !this.api.doc?.read
        ? `${PLUGIN_NAME} needs “Read your open documents”. Allow it with the shield in Settings → Plugins.`
        : !uid
          ? 'Open a document to check its cites.'
          : null,
      focusHeadingId: this.focusHeadingId,
    };
    this.focusHeadingId = null;
    renderPanel(this.panel.el, model, {
      jump: (headingId, part) => void this.api.doc?.jumpTo?.({ headingId, part, ...(uid ? { docUid: uid } : {}) }),
      ignore: (headingId, ruleId) => uid && this.ignore(uid, headingId, ruleId),
      recheck: () => {
        this.check();
        this.render();
      },
      verify: () => void this.verify(),
      setFilter: (f) => {
        this.filter = f;
        this.render();
      },
      restoreIgnored: () => uid && this.restoreIgnored(uid),
    });
  }

  // ── Online ─────────────────────────────────────────────────────────

  private cacheFor(): CacheLike {
    return {
      get: (k) => {
        const hit = this.cache.get(k);
        if (!hit) return undefined;
        if (Date.now() - hit.t > CACHE_TTL_MS) {
          this.cache.delete(k);
          return undefined;
        }
        return hit.v;
      },
      set: (k, v) => {
        if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(k, { t: Date.now(), v });
      },
    };
  }

  /** Verify every card of the focused doc, or just `onlyHeadingId`. */
  async verify(onlyHeadingId?: string, docUid?: string): Promise<void> {
    if (this.verifying) return;
    let api = this.api;
    if (!api.net) {
      const status = api.permissions?.status('net.fetch');
      if (status === 'denied' && api.permissions?.request) {
        const r = await api.permissions.request('net.fetch', { reason: PERMISSION_REASONS['net.fetch'] });
        api = r.api;
      }
      if (!api.net) {
        this.explain('net.fetch', 'Connect to websites');
        return;
      }
    }
    const result = this.check(docUid);
    if (!result) {
      this.explain('doc.read', 'Read your open documents');
      return;
    }
    const targets = result.cards.filter(
      (c) => c.card.headingId && c.card.citeParagraphs.some((p) => p.trim()) && (!onlyHeadingId || c.card.headingId === onlyHeadingId),
    );
    if (targets.length === 0) {
      api.showToast(onlyHeadingId ? 'That card has no cite to verify.' : 'No cites to verify.');
      return;
    }
    const net = api.net!;
    const opts = {
      net,
      cache: this.cacheFor(),
      openAlexKey: settingString(api, 'openAlexKey'),
      contactEmail: settingString(api, 'contactEmail'),
      checkLinks: api.settings.get('checkLinks') !== false,
    };
    let online = this.online.get(result.docUid);
    if (!online) this.online.set(result.docUid, (online = new Map()));
    const skipped = new Set<string>();
    this.verifying = { docUid: result.docUid, done: 0, total: targets.length };
    this.note = null;
    if (this.panel?.isVisible()) this.render();
    try {
      await pool(
        targets,
        3,
        async (c) => {
          const r = await verifyCard(c.card, c.parsed, opts);
          r.skipped.forEach((s) => skipped.add(s));
          online!.set(c.card.headingId!, { citeKey: c.citeKey, result: r });
        },
        (done) => {
          if (this.verifying) this.verifying.done = done;
          if (this.panel?.isVisible()) this.render();
        },
      );
    } finally {
      this.verifying = null;
    }
    this.note = skipped.size ? `Some lookups couldn’t run: ${[...skipped].join(', ')}.` : null;
    const after = this.check(result.docUid);
    this.render();
    if (!after) return;
    const verified = after.cards.filter((c) => c.card.headingId && online!.has(c.card.headingId));
    const counts = countBySeverity(
      verified.map((c) => ({ headingId: null, heading: '', short: '', findings: c.findings.filter((f) => f.online), confirmations: [] })),
    );
    const confirmed = verified.reduce((n, c) => n + c.confirmations.length, 0);
    const summary = `${targets.length === 1 ? 'Verified 1 cite' : `Verified ${targets.length} cites`}: ${counts.error} errors, ${counts.warning} warnings, ${confirmed} confirmed.`;
    if (api.notices) {
      api.notices.post({
        key: `verify:${result.docUid}`,
        title: `Sources checked in ${result.title}`,
        body: summary + (this.note ? `\n${this.note}` : ''),
        severity: counts.error + counts.warning > 0 ? 'warning' : 'info',
        toast: true,
        actions: [{ label: 'Show problems', run: () => void this.showPanel() }],
      });
    } else {
      api.showToast(summary);
    }
  }

  // ── Persistence of ignores (files.data) ────────────────────────────

  saveData(docUid: string): { data: unknown; summary: string } | null {
    const set = this.ignored.get(docUid);
    if (!set || set.size === 0) return null;
    return {
      data: { v: SAVE_VERSION, ignored: [...set].sort() },
      summary: `Cite Check: ${set.size} ignored finding${set.size === 1 ? '' : 's'}`,
    };
  }

  loadData(docUid: string, data: unknown): void {
    const d = data as { v?: unknown; ignored?: unknown } | null;
    if (!d || d.v !== SAVE_VERSION || !Array.isArray(d.ignored)) return;
    const set = this.ignoredIn(docUid);
    for (const k of d.ignored) if (typeof k === 'string' && k.length < 200) set.add(k);
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

  /** Counts for a doc (tests, notices). */
  counts(docUid: string): Record<Severity, number> {
    const r = this.results.get(docUid);
    const ignored = this.ignoredIn(docUid);
    const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const card of r?.cards ?? []) {
      for (const f of card.findings) {
        if (card.card.headingId && ignored.has(ignoreKey(card.card.headingId, f.ruleId))) continue;
        c[f.severity]++;
      }
    }
    return c;
  }
}

export function createPlugin(): PluginDefinition & { checker: CiteChecker } {
  const checker = new CiteChecker();
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    apiVersion: 1,
    permissions: [...PLUGIN_PERMISSIONS],
    permissionReasons: { ...PERMISSION_REASONS },
    networkHosts: [...PLUGIN_NETWORK_HOSTS],
    checker,
    settings: [
      { key: 'autoCheck', label: 'Check cites as I edit', type: 'boolean', default: true },
      {
        key: 'markInfo',
        label: 'Also underline minor notes',
        type: 'boolean',
        default: false,
        description: 'Notes (no title, no link, a student author …) always show in the panel.',
      },
      {
        key: 'untrustedDomains',
        label: 'Untrusted sources',
        type: 'multiline',
        default: '',
        description: 'One domain per line, e.g. “example.com  # why”. Cites linking there get a warning.',
      },
      {
        key: 'trustedDomains',
        label: 'Trusted sources',
        type: 'multiline',
        default: '',
        description: 'One domain per line. Never flagged as a weak source.',
      },
      {
        key: 'vagueTerms',
        label: 'Vague qualifications',
        type: 'multiline',
        default: DEFAULT_VAGUE_TERMS.join('\n'),
        description: 'Quals made only of these words (with no affiliation or credential) are flagged as vague.',
      },
      {
        key: 'maxAgeYears',
        label: 'Flag evidence older than (years, 0 = off)',
        type: 'number',
        default: 0,
      },
      {
        key: 'checkLinks',
        label: 'Verify: also open the cited pages',
        type: 'boolean',
        default: true,
        description: 'Finds dead links and compares the page’s own author and date with the cite.',
      },
      {
        key: 'openAlexKey',
        label: 'OpenAlex API key (optional)',
        type: 'text',
        default: '',
        description: 'Free at openalex.org. Without one, OpenAlex allows only a few quals lookups a day.',
      },
      {
        key: 'contactEmail',
        label: 'Email for Crossref (optional)',
        type: 'text',
        default: '',
        description: 'Sent only to Crossref, which answers faster for requests that include one.',
      },
    ],
    commands: [
      {
        id: `${PLUGIN_ID}.panel`,
        label: `${PLUGIN_NAME}: Show cite problems`,
        keywords: ['cite', 'quals', 'citation', 'evidence'],
        run: (api) => {
          checker.api = api;
          checker.showPanel();
        },
      },
      {
        id: `${PLUGIN_ID}.check`,
        label: `${PLUGIN_NAME}: Check cites now`,
        keywords: ['cite', 'quals', 'citation'],
        run: (api) => {
          checker.api = api;
          const r = checker.check();
          if (!r) return checker.explain('doc.read', 'Read your open documents');
          const c = checker.counts(r.docUid);
          if (!api.panel) api.showToast(`${c.error} errors, ${c.warning} warnings, ${c.info} notes in cites.`);
          else checker.showPanel();
        },
      },
      {
        id: `${PLUGIN_ID}.verify`,
        label: `${PLUGIN_NAME}: Verify sources online`,
        keywords: ['cite', 'quals', 'doi', 'crossref', 'openalex', 'dead link'],
        run: async (api) => {
          checker.api = api;
          await checker.verify();
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
        offs.push(api.files.onOpen((data, ctx) => {
          checker.loadData(ctx.docUid, data);
          checker.check(ctx.docUid);
        }));
        offs.push(api.files.onSave((ctx) => checker.saveData(ctx.docUid)));
      }
      if (api.events) {
        offs.push(
          api.events.onDocChange((e) => {
            if (api.settings.get('autoCheck') !== false) checker.check(e.docUid);
          }),
        );
        offs.push(
          api.events.onFocusChange((e) => {
            if (!e.docUid) return;
            if (api.settings.get('autoCheck') !== false) checker.check(e.docUid);
            checker.render();
          }),
        );
      }
      if (api.menu) {
        offs.push(
          api.menu.add({
            label: 'Verify this cite',
            when: 'heading',
            run: (t) => {
              if (t.headingId) void checker.verify(t.headingId, t.docUid ?? undefined);
            },
          }),
        );
        offs.push(
          api.menu.add({
            label: 'Show cite problems',
            when: 'heading',
            run: (t) => {
              if (t.docUid) checker.check(t.docUid);
              checker.showPanel(t.headingId);
            },
          }),
        );
      }
      offs.push(
        api.settings.onChanged(() => {
          checker.check();
        }),
      );
      // First look at whatever is focused now.
      if (api.settings.get('autoCheck') !== false) checker.check();
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
