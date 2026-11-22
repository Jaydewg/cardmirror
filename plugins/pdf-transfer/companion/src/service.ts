/**
 * The companion's routes and jobs, free of Electron: everything that
 * touches the desktop (dialogs, printing, files, CardMirror) goes through
 * `CompanionHost`, so the flows are testable with fakes.
 *
 * Routes (all POST except /ping, all need the bridge token):
 *   GET  /ping     liveness, for CardMirror's flowApps()
 *   POST /export   start an export job      (ExportRequest)
 *   POST /import   start an import job      (ImportRequest)
 *   POST /status   a job's progress         (StatusRequest)
 */
import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  PROTOCOL_VERSION,
  type JobState,
  type PageSize,
  type StartResponse,
  type StatusResponse,
} from '../../src/protocol.js';
import type { PluginDocSnapshot } from '@cardmirror/plugin-api';
import { TOKEN_HEADER, type Endpoint } from './bridge.js';
import { buildDoc, docCmir, docHtml, docText } from './build-doc.js';
import { makeHybrid, parseHybrid } from './hybrid.js';
import type { Para } from './model.js';
import { readPdf } from './pdf-read.js';
import { printHtml } from './print-html.js';
import { reconstruct } from './reconstruct.js';
import { parseSnapshot, snapshotToParas } from './snapshot.js';

export interface CompanionHost {
  appVersion: string;
  chooseSavePdf(defaultName: string): Promise<string | null>;
  chooseOpenPdf(): Promise<string | null>;
  chooseSaveCmir(defaultPath: string): Promise<string | null>;
  renderPdf(html: string, pageSize: PageSize): Promise<Uint8Array>;
  readFile(file: string): Promise<Uint8Array>;
  writeFile(file: string, bytes: Uint8Array): Promise<void>;
  /** Ask CardMirror to open a file; false when that couldn't be done. */
  openInCardmirror(file: string): Promise<boolean>;
  findCardmirror(): Promise<Endpoint | null>;
  request(
    ep: Endpoint,
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** CardMirror's /insert html cap. */
export const INSERT_HTML_MAX = 2 * 1024 * 1024;
const MAX_BODY = 64 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60 * 1000;

interface Job {
  state: JobState;
  message?: string;
  path?: string;
  ended?: number;
}

export interface Reply {
  status: number;
  body: unknown;
}

const reply = (body: unknown, status = 200): Reply => ({ status, body });

/** A title made safe for a file name. */
export function fileStem(title: string): string {
  const stem = title
    .replace(/\.(cmir|docx|pdf)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return stem || 'Document';
}

const countCards = (paras: Para[]): number => paras.filter((p) => p.role === 'tag' || p.role === 'analytic').length;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export class CompanionService {
  private jobs = new Map<string, Job>();
  private seq = 0;
  /** Resolves when the current job ends (tests await it). */
  current: Promise<void> | null = null;

  constructor(
    private readonly host: CompanionHost,
    private readonly token: string,
  ) {}

  /** Check the token in constant time. */
  authorized(given: string | undefined): boolean {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  handle(method: string, route: string, body: unknown): Reply {
    if (method === 'GET' && route === '/ping') {
      return reply({ ok: true, app: 'cardmirror-pdf', appVersion: this.host.appVersion, schema: 1 });
    }
    if (method !== 'POST') return reply({ ok: false, error: 'bad-request' }, 404);
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (!Number.isInteger(b['v'])) return reply({ ok: false, error: 'bad-request' } satisfies StartResponse);
    if ((b['v'] as number) > PROTOCOL_VERSION) return reply({ ok: false, error: 'unsupported-version' });
    switch (route) {
      case '/status':
        return reply(this.status(b['job']));
      case '/export':
        return reply(this.startExport(b));
      case '/import':
        return reply(this.startImport(b));
      default:
        return reply({ ok: false, error: 'bad-request' }, 404);
    }
  }

  private status(id: unknown): StatusResponse {
    this.sweep();
    const job = typeof id === 'string' ? this.jobs.get(id) : undefined;
    if (!job) return { ok: false, error: 'no-such-job' };
    const out: StatusResponse = { ok: true, state: job.state };
    if (job.message) out.message = job.message;
    if (job.path) out.path = job.path;
    return out;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.ended && now - j.ended > JOB_TTL_MS) this.jobs.delete(id);
  }

  private busy(): boolean {
    for (const j of this.jobs.values()) if (!j.ended) return true;
    return false;
  }

  private start(run: (job: Job) => Promise<void>): StartResponse {
    if (this.busy()) return { ok: false, error: 'busy' };
    const id = `j${++this.seq}-${Date.now().toString(36)}`;
    const job: Job = { state: 'working' };
    this.jobs.set(id, job);
    this.current = run(job)
      .catch((err: unknown) => {
        job.state = 'failed';
        job.message = `CardMirror PDF: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        job.ended = Date.now();
      });
    return { ok: true, job: id };
  }

  private startExport(b: Record<string, unknown>): StartResponse {
    const snapshot = parseSnapshot(b['snapshot']);
    if (!snapshot) return { ok: false, error: 'bad-request' };
    const title = typeof b['title'] === 'string' ? b['title'] : snapshot.title;
    const pageSize: PageSize = b['pageSize'] === 'A4' ? 'A4' : 'Letter';
    const hybrid = b['hybrid'] === true;
    return this.start((job) => this.runExport(job, snapshot, title, pageSize, hybrid));
  }

  private async runExport(
    job: Job,
    snapshot: PluginDocSnapshot,
    title: string,
    pageSize: PageSize,
    hybrid: boolean,
  ): Promise<void> {
    job.state = 'choosing';
    const file = await this.host.chooseSavePdf(`${fileStem(title)}.pdf`);
    if (!file) {
      job.state = 'cancelled';
      return;
    }
    job.state = 'working';
    const html = printHtml(snapshotToParas(snapshot), { title: fileStem(title), pageSize });
    let pdf = await this.host.renderPdf(html, pageSize);
    if (hybrid) pdf = await makeHybrid(pdf, title, snapshot);
    await this.host.writeFile(file, pdf);
    job.path = file;
    job.message = `Saved ${path.basename(file)}${hybrid ? ' (Hybrid PDF)' : ''}.`;
    job.state = 'done';
  }

  private startImport(b: Record<string, unknown>): StartResponse {
    const mode = b['mode'];
    const target = b['target'];
    if (mode === 'new') return this.start((job) => this.runImport(job, { mode: 'new' }));
    if (mode === 'insert' && typeof target === 'string' && target.length > 0 && target.length <= 128) {
      return this.start((job) => this.runImport(job, { mode: 'insert', target }));
    }
    return { ok: false, error: 'bad-request' };
  }

  /** The PDF's paras, exact from a Hybrid PDF when it has one. */
  private async parasOf(bytes: Uint8Array): Promise<{ paras: Para[]; exact: boolean; note?: string }> {
    const first = await readPdf(bytes, { pages: false });
    let note: string | undefined;
    if (first.hybrid) {
      const env = parseHybrid(first.hybrid);
      if (env.kind === 'ok') return { paras: snapshotToParas(env.doc), exact: true };
      if (env.kind === 'newer') note = 'It was made by a newer CardMirror PDF, so it was rebuilt from the page instead.';
    }
    const { pages } = await readPdf(bytes);
    return { paras: reconstruct(pages), exact: false, note };
  }

  private async runImport(job: Job, dest: { mode: 'new' } | { mode: 'insert'; target: string }): Promise<void> {
    job.state = 'choosing';
    const file = await this.host.chooseOpenPdf();
    if (!file) {
      job.state = 'cancelled';
      return;
    }
    job.state = 'working';
    const name = path.basename(file);
    const { paras, exact, note } = await this.parasOf(await this.host.readFile(file));
    if (!paras.some((p) => p.runs.some((r) => r.text.trim()))) {
      job.state = 'failed';
      job.message = `${name} has no text to import. A scanned PDF needs OCR first.`;
      return;
    }
    const what = countCards(paras) > 0 ? plural(countCards(paras), 'card') : plural(paras.length, 'paragraph');
    const how = exact ? ' (exact, from a Hybrid PDF)' : '';
    const suffix = note ? ` ${note}` : '';

    if (dest.mode === 'new') {
      const dir = path.dirname(file);
      const out = await this.host.chooseSaveCmir(path.join(dir, `${fileStem(name)}.cmir`));
      if (!out) {
        job.state = 'cancelled';
        return;
      }
      await this.host.writeFile(out, docCmir(buildDoc(paras, { keepIds: exact }), this.host.appVersion));
      job.path = out;
      const opened = await this.host.openInCardmirror(out);
      job.message = opened
        ? `Imported ${what} from ${name}${how}.${suffix}`
        : `Saved ${path.basename(out)} with ${what}${how}. Open it in CardMirror.${suffix}`;
      job.state = 'done';
      return;
    }

    const html = docHtml(buildDoc(paras, { keepIds: false }));
    if (html.length > INSERT_HTML_MAX) {
      job.state = 'failed';
      job.message = `${name} is too big to add to an open document. Import it as a new document instead.`;
      return;
    }
    const ep = await this.host.findCardmirror();
    if (!ep) {
      job.state = 'failed';
      job.message = 'CardMirror PDF can’t reach CardMirror. Is it still running?';
      return;
    }
    const res = await this.host.request(ep, 'POST', '/insert', {
      text: docText(paras),
      html,
      target: dest.target,
      newParagraph: true,
    });
    const r = res.body;
    if (r['ok'] === true && r['inserted'] === true) {
      job.message = `Imported ${what} from ${name}${how}.${suffix}`;
      job.state = 'done';
      return;
    }
    if (r['ok'] === true && r['pending'] === 'consent') {
      // CardMirror holds the insert behind its consent prompt and applies
      // it on Allow by itself. Don't poll to find out: every request while
      // the prompt is open joins its small queue, and after "Allow once"
      // the next request would raise the prompt again.
      job.message = `Allow “CardMirror PDF” in CardMirror's prompt to add ${what} from ${name}. (Always Allow skips this next time.)`;
      job.state = 'done';
      return;
    }
    job.state = 'failed';
    job.message = insertError(String(r['error'] ?? `HTTP ${res.status}`));
  }
}

export function insertError(code: string): string {
  switch (code) {
    case 'target-not-found':
      return 'That document was closed, so nothing was imported.';
    case 'doc-readonly':
      return 'That document is read-only, so nothing was imported.';
    case 'inserts-disabled':
      return 'CardMirror is set to refuse content from other apps (Settings → Plugins → External apps).';
    case 'not-allowed':
      return 'CardMirror didn’t allow CardMirror PDF. Change that in Settings → Plugins → External apps.';
    default:
      return `CardMirror refused the import (${code}).`;
  }
}

/** The HTTP face of the service, bound to 127.0.0.1 on a free port. */
export function serve(service: CompanionService): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const send = (r: Reply): void => {
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    };
    // Browser pages carry Origin/Referer; local apps don't.
    if (req.headers['origin'] || req.headers['referer']) return send(reply({ ok: false, error: 'forbidden' }, 403));
    const token = req.headers[TOKEN_HEADER];
    if (!service.authorized(Array.isArray(token) ? token[0] : token)) {
      return send(reply({ ok: false, error: 'unauthorized' }, 401));
    }
    const route = (req.url ?? '/').split('?')[0]!;
    if (req.method !== 'POST') return send(service.handle(req.method ?? 'GET', route, null));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(reply({ ok: false, error: 'bad-request' }, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(reply({ ok: false, error: 'bad-request' }, 400));
      }
      send(service.handle('POST', route, body));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}
