/**
 * Stored `.cmir` bytes → `.docx` bytes through the SAME export pipeline the
 * ordinary save uses: `transformForExport`, then `flattenSelfRefs` (Word has
 * no live-window concept, so each self_ref window is materialized as real
 * cards), then `toDocx`.
 *
 * Shared by the recovery sidebar (journal → .docx, in place or Save As) and
 * Bulk Convert. Both used to run `parseNative → toDocx` directly, which
 * exported every live view as an empty paragraph — an in-place recovery
 * save overwrote the user's real file with the live views gone. The
 * "unread" red is never baked: these outputs are working files, not Word
 * exports (see bakesUnreadRedOnSave). (Audit items 11 and 19, 2026-10-08.)
 */

import { parseNative, toDocx } from '../index.js';
import { transformForExport, bakesUnreadRedOnSave } from '../export/transform-for-export.js';
import { flattenSelfRefs } from './self-transclusion.js';
import { newHeadingId } from '../schema/index.js';

export async function nativeBytesToDocx(
  bytes: Uint8Array,
  opts: {
    bodyFont: string;
    /** The "mark unread after marker" setting; only consulted to confirm
     *  it does NOT bake (working copy). Passed so the rule lives in one place. */
    markUnreadAfterMarker: boolean;
    generator?: { application: string; version: string };
  },
): Promise<Uint8Array> {
  const parsed = parseNative(bytes);
  const exportDoc = transformForExport(parsed.doc, {
    includeComments: true,
    includeAnalytics: true,
    includeUndertags: true,
    readMode: false,
    markedCardsOnly: false,
    markUnreadAfterMarker: bakesUnreadRedOnSave('docx', true, opts.markUnreadAfterMarker),
  });
  const docxNode = flattenSelfRefs(exportDoc, newHeadingId);
  return toDocx(docxNode, {
    ...(parsed.threads.length > 0 ? { threads: parsed.threads } : {}),
    defaultFont: opts.bodyFont,
    ...(opts.generator ? { generator: opts.generator } : {}),
  });
}
