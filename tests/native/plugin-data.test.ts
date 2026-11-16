import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gunzipSync as zlibGunzip } from 'node:zlib';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { parseNative, serializeNative, serializeNativeAsync } from '../../src/native/index.js';
import {
  gunzip,
  gzip,
  readGzipComment,
  withGzipComment,
} from '../../src/native/codec.js';
import {
  PLUGIN_DATA_MAX_BYTES,
  gzipCommentForBag,
  sanitizePluginBag,
  sanitizeSummary,
} from '../../src/native/plugin-data.js';
import { stampDocId } from '../../src/docid.js';

const doc = (): PMNode =>
  schema.nodes['doc']!.createChecked(null, [schema.nodes['paragraph']!.create(null, schema.text('Hello'))]);

const bag = {
  'live-session-link': { name: 'Live Session Link', data: { code: 'cmshare2.abc.def.1' }, summary: 'Live session: Aff @ relay.example' },
};

const envelope = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(gunzip(bytes))) as Record<string, unknown>;

describe('plugins field in .cmir', () => {
  it('round-trips through sync and async serialize, written before doc', async () => {
    for (const bytes of [serializeNative(doc(), { plugins: bag }), await serializeNativeAsync(doc(), { plugins: bag })]) {
      const env = envelope(bytes);
      const keys = Object.keys(env);
      expect(keys.indexOf('plugins')).toBeLessThan(keys.indexOf('doc'));
      expect(parseNative(bytes).plugins).toEqual(bag);
    }
  });

  it('is absent (no field, no header comment) when no plugin data is given', () => {
    const bytes = serializeNative(doc());
    expect('plugins' in envelope(bytes)).toBe(false);
    expect(readGzipComment(bytes)).toBeNull();
    expect(parseNative(bytes).plugins).toEqual({});
  });

  it('drops bad ids, bad entries and oversized data, keeping the rest', () => {
    const parsed = sanitizePluginBag({
      ok: { name: 'OK', data: [1, 2] },
      'Bad Id': { name: 'x', data: 1 },
      noname: { data: 1 },
      nodata: { name: 'n' },
      huge: { name: 'H', data: 'x'.repeat(PLUGIN_DATA_MAX_BYTES + 10) },
      notobj: 'str',
    });
    expect(Object.keys(parsed)).toEqual(['ok']);
    expect(sanitizePluginBag('nope')).toEqual({});
    expect(sanitizePluginBag([1])).toEqual({});
  });

  it('a file from an older build (no field) still parses', () => {
    const legacy = new TextEncoder().encode(
      JSON.stringify({ format: 'cardmirror-doc', formatVersion: 1, createdBy: 'x', createdAt: 'y', doc: doc().toJSON() }),
    );
    expect(parseNative(legacy).plugins).toEqual({});
  });

  it('summaries are ASCII-only and capped', () => {
    expect(sanitizeSummary('café — live\n\tnow')).toBe('caf live now');
    expect(sanitizeSummary('x'.repeat(500))!.length).toBe(200);
    expect(sanitizeSummary('éé')).toBeUndefined();
    expect(gzipCommentForBag({})).toBeUndefined();
  });
});

describe('gzip header comment', () => {
  const payload = new TextEncoder().encode('{"hello":"world"}');

  it('is readable by fflate, node:zlib and system gzip, and readable back', () => {
    const gz = withGzipComment(gzip(payload), 'CardMirror: Live session: Aff');
    expect(readGzipComment(gz)).toBe('CardMirror: Live session: Aff');
    expect(new TextDecoder().decode(gunzip(gz))).toBe('{"hello":"world"}');
    expect(new TextDecoder().decode(zlibGunzip(gz))).toBe('{"hello":"world"}');
    expect(execFileSync('gzip', ['-dc'], { input: gz }).toString()).toBe('{"hello":"world"}');
  });

  it('replaces an existing comment, and removing it restores the plain bytes', () => {
    const plain = gzip(payload);
    const once = withGzipComment(plain, 'first');
    const twice = withGzipComment(once, 'second');
    expect(readGzipComment(twice)).toBe('second');
    expect(withGzipComment(twice, undefined)).toEqual(plain);
  });

  it('non-ASCII is replaced, never written raw', () => {
    expect(readGzipComment(withGzipComment(gzip(payload), 'café'))).toBe('caf?');
  });

  it('serialize writes the plugin summaries into the comment', () => {
    expect(readGzipComment(serializeNative(doc(), { plugins: bag }))).toBe(
      'CardMirror: Live session: Aff @ relay.example',
    );
  });

  it('stampDocId keeps the comment and the plugins field', async () => {
    const bytes = serializeNative(doc(), { plugins: bag });
    const stamped = await stampDocId(bytes, 'cmir', 'doc-123');
    expect(readGzipComment(stamped)).toBe(readGzipComment(bytes));
    const parsed = parseNative(stamped);
    expect(parsed.docId).toBe('doc-123');
    expect(parsed.plugins).toEqual(bag);
  });
});
