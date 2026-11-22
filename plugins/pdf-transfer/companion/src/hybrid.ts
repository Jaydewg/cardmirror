/**
 * Hybrid PDF: an exported PDF that also carries the document, as the
 * embedded file `cardmirror-doc.json`:
 *
 *   { "format": "cardmirror-hybrid-pdf", "version": 1,
 *     "title": "…", "doc": <doc.read snapshot, with formatting> }
 *
 * This shape is permanent: PDFs outlive builds. Readers accept any
 * `version` they know and treat a higher one as absent (the page content
 * is still there to reconstruct from). Add fields; never repurpose them.
 */
import { PDFDocument } from 'pdf-lib';
import type { PluginDocSnapshot } from '@cardmirror/plugin-api';
import { parseSnapshot } from './snapshot.js';

export const HYBRID_FILENAME = 'cardmirror-doc.json';
export const HYBRID_FORMAT = 'cardmirror-hybrid-pdf';
export const HYBRID_VERSION = 1;
const MAX_BYTES = 64 * 1024 * 1024;

export interface HybridEnvelope {
  format: typeof HYBRID_FORMAT;
  version: number;
  title: string;
  doc: PluginDocSnapshot;
}

export function hybridBytes(title: string, doc: PluginDocSnapshot): Uint8Array {
  // docUid is session-scoped: meaningless in a file, so it isn't kept.
  const envelope: HybridEnvelope = {
    format: HYBRID_FORMAT,
    version: HYBRID_VERSION,
    title,
    doc: { ...doc, docUid: '' },
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export type HybridRead =
  | { kind: 'ok'; title: string; doc: PluginDocSnapshot }
  | { kind: 'newer' }
  | { kind: 'invalid' };

export function parseHybrid(bytes: Uint8Array): HybridRead {
  if (bytes.length > MAX_BYTES) return { kind: 'invalid' };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'invalid' };
  }
  if (!raw || typeof raw !== 'object') return { kind: 'invalid' };
  const r = raw as Record<string, unknown>;
  if (r['format'] !== HYBRID_FORMAT || !Number.isInteger(r['version']) || (r['version'] as number) < 1)
    return { kind: 'invalid' };
  if ((r['version'] as number) > HYBRID_VERSION) return { kind: 'newer' };
  const doc = parseSnapshot(r['doc']);
  if (!doc) return { kind: 'invalid' };
  const title = typeof r['title'] === 'string' ? r['title'].slice(0, 500) : doc.title;
  return { kind: 'ok', title, doc };
}

/** Attach the document to a rendered PDF and set its title. */
export async function makeHybrid(pdf: Uint8Array, title: string, doc: PluginDocSnapshot): Promise<Uint8Array> {
  const out = await PDFDocument.load(pdf);
  await out.attach(hybridBytes(title, doc), HYBRID_FILENAME, {
    mimeType: 'application/json',
    description: 'CardMirror document (for exact re-import)',
  });
  return out.save();
}
