import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CompanionService, fileStem, serve, type CompanionHost } from '../src/service.js';
import { parseNative } from '../../../../src/native/index.js';
import { readPdf } from '../src/pdf-read.js';
import { makeHybrid, parseHybrid } from '../src/hybrid.js';
import { SNAP } from './fixtures.js';

async function textPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) =>
    page.drawText(l, { x: 72, y: 700 - i * 30, size: i === 0 ? 13 : 11, font: i === 0 ? bold : reg }),
  );
  return doc.save();
}

interface FakeHost extends CompanionHost {
  files: Map<string, Uint8Array>;
  html: string[];
  opened: string[];
  inserts: Record<string, unknown>[];
}

function host(over: Partial<CompanionHost> & { insertReply?: Record<string, unknown> } = {}): FakeHost {
  const files = new Map<string, Uint8Array>();
  const html: string[] = [];
  const opened: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  return {
    files,
    html,
    opened,
    inserts,
    appVersion: '0.1.0',
    chooseSavePdf: async (name) => `/out/${name}`,
    chooseOpenPdf: async () => '/in/case.pdf',
    chooseSaveCmir: async (p) => p,
    renderPdf: async (h) => {
      html.push(h);
      return textPdf(['Rendered']);
    },
    readFile: async (f) => files.get(f)!,
    writeFile: async (f, b) => void files.set(f, b),
    openInCardmirror: async (f) => (opened.push(f), true),
    findCardmirror: async () => ({ port: 1, token: 't', pid: 0 }),
    request: async (_ep, _m, _route, body) => {
      inserts.push(body as Record<string, unknown>);
      return { status: 200, body: over.insertReply ?? { ok: true, inserted: true } };
    },
    ...over,
  };
}

async function run(svc: CompanionService, route: string, body: Record<string, unknown>) {
  const start = svc.handle('POST', route, { v: 1, ...body }).body as { ok: boolean; job?: string; error?: string };
  if (!start.ok) return { start, status: null };
  await svc.current;
  return { start, status: svc.handle('POST', '/status', { v: 1, job: start.job }).body as Record<string, unknown> };
}

describe('fileStem', () => {
  it('makes a title safe for a file name', () => {
    expect(fileStem('1AC: Ports/Trade.cmir')).toBe('1AC Ports Trade');
    expect(fileStem('  ')).toBe('Document');
  });
});

describe('export', () => {
  it('prints the snapshot and writes the PDF', async () => {
    const h = host();
    const { status } = await run(new CompanionService(h, 'tok'), '/export', { title: '1AC.cmir', snapshot: SNAP, pageSize: 'Letter', hybrid: false });
    expect(status).toEqual({ ok: true, state: 'done', message: 'Saved 1AC.pdf.', path: '/out/1AC.pdf' });
    expect(h.html[0]).toContain('Warming is real');
    expect((await readPdf(h.files.get('/out/1AC.pdf')!, { pages: false })).hybrid).toBeNull();
  });

  it('embeds the document in a Hybrid PDF', async () => {
    const h = host();
    await run(new CompanionService(h, 'tok'), '/export', { title: '1AC', snapshot: SNAP, pageSize: 'A4', hybrid: true });
    const { hybrid } = await readPdf(h.files.get('/out/1AC.pdf')!, { pages: false });
    expect(parseHybrid(hybrid!).kind).toBe('ok');
  });

  it('cancels quietly, refuses bad input, and runs one job at a time', async () => {
    const svc = new CompanionService(host({ chooseSavePdf: async () => null }), 'tok');
    expect((await run(svc, '/export', { snapshot: SNAP })).status).toEqual({ ok: true, state: 'cancelled' });
    expect(svc.handle('POST', '/export', { v: 1, snapshot: 'nope' }).body).toEqual({ ok: false, error: 'bad-request' });
    expect(svc.handle('POST', '/export', { v: 9, snapshot: SNAP }).body).toEqual({ ok: false, error: 'unsupported-version' });
    let release!: (v: string | null) => void;
    const slow = new CompanionService(host({ chooseSavePdf: () => new Promise((r) => (release = r)) }), 'tok');
    expect(slow.handle('POST', '/export', { v: 1, snapshot: SNAP }).body).toMatchObject({ ok: true });
    expect(slow.handle('POST', '/import', { v: 1, mode: 'new' }).body).toEqual({ ok: false, error: 'busy' });
    release(null);
    await slow.current;
    expect(slow.handle('POST', '/import', { v: 1, mode: 'new' }).body).toMatchObject({ ok: true });
  });
});

describe('import', () => {
  it('writes a new .cmir next to the PDF and opens it', async () => {
    const h = host();
    h.files.set('/in/case.pdf', await textPdf(['Warming is real', 'The planet warms.']));
    const { status } = await run(new CompanionService(h, 'tok'), '/import', { mode: 'new' });
    expect(status).toMatchObject({ ok: true, state: 'done', path: '/in/case.cmir', message: 'Imported 1 card from case.pdf.' });
    expect(h.opened).toEqual(['/in/case.cmir']);
    const doc = parseNative(h.files.get('/in/case.cmir')!).doc;
    expect(doc.child(0).type.name).toBe('card');
  });

  it('uses a Hybrid PDF exactly, keeping heading ids in a new doc', async () => {
    const h = host();
    h.files.set('/in/case.pdf', await makeHybrid(await textPdf(['ignored']), '1AC', SNAP));
    const { status } = await run(new CompanionService(h, 'tok'), '/import', { mode: 'new' });
    expect(status!['message']).toBe('Imported 2 cards from case.pdf (exact, from a Hybrid PDF).');
    const doc = parseNative(h.files.get('/in/case.cmir')!).doc;
    expect(doc.child(1).firstChild!.attrs['id']).toBe('t1');
  });

  it('inserts into the target document through /insert', async () => {
    const h = host();
    h.files.set('/in/case.pdf', await textPdf(['Warming is real', 'The planet warms.']));
    const { status } = await run(new CompanionService(h, 'tok'), '/import', { mode: 'insert', target: 'u-1' });
    expect(status).toMatchObject({ state: 'done', message: 'Imported 1 card from case.pdf.' });
    expect(h.inserts[0]).toMatchObject({ target: 'u-1', newParagraph: true, text: 'Warming is real\nThe planet warms.' });
    expect(String(h.inserts[0]!['html'])).toContain('pmd-card');
  });

  it('explains consent and refusals', async () => {
    const pdf = await textPdf(['Warming is real', 'The planet warms.']);
    const consent = host({ insertReply: { ok: true, inserted: false, pending: 'consent' } });
    consent.files.set('/in/case.pdf', pdf);
    const c = await run(new CompanionService(consent, 'tok'), '/import', { mode: 'insert', target: 'u-1' });
    expect(c.status).toMatchObject({ state: 'done', message: expect.stringMatching(/^Allow “CardMirror PDF”/) });
    const closed = host({ insertReply: { ok: false, error: 'target-not-found' } });
    closed.files.set('/in/case.pdf', pdf);
    const r = await run(new CompanionService(closed, 'tok'), '/import', { mode: 'insert', target: 'u-1' });
    expect(r.status).toMatchObject({ state: 'failed', message: expect.stringMatching(/was closed/) });
  });

  it('fails clearly on a PDF without text', async () => {
    const h = host();
    const empty = await PDFDocument.create();
    empty.addPage();
    h.files.set('/in/case.pdf', await empty.save());
    const { status } = await run(new CompanionService(h, 'tok'), '/import', { mode: 'new' });
    expect(status).toMatchObject({ state: 'failed', message: expect.stringMatching(/no text to import/) });
  });

  it('refuses an insert without a target', () => {
    const svc = new CompanionService(host(), 'tok');
    expect(svc.handle('POST', '/import', { v: 1, mode: 'insert' }).body).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('HTTP', () => {
  const get = (port: number, route: string, headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });

  it('needs the token and refuses browser requests', async () => {
    const { server, port } = await serve(new CompanionService(host(), 'secret'));
    try {
      expect(await get(port, '/ping', { 'X-Bridge-Token': 'secret' })).toBe(200);
      expect(await get(port, '/ping', { 'X-Bridge-Token': 'nope!!' })).toBe(401);
      expect(await get(port, '/ping', {})).toBe(401);
      expect(await get(port, '/ping', { 'X-Bridge-Token': 'secret', Origin: 'https://evil.example' })).toBe(403);
    } finally {
      server.close();
    }
  });
});
