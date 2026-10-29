// @vitest-environment jsdom
/**
 * Transclusion × co-editing convergence study.
 *
 * The extension of `loro-fuzz` to the NEW transclusion features: seeded random
 * concurrent edits across Loro-bound peers with offline partitions, but the op
 * mix now includes live views (`self_ref`), in-doc linked copies
 * (`transclusion_ref`), and — the operations most suspected of co-editing jank —
 * DETACH (unwrap a copy), UNLINK (freeze a live view to cards), delete, and
 * editing inside a copy while a peer detaches it. Each peer runs the real
 * doc-mutating plugin (the empty-zone reaper) plus the new decoration plugins
 * (self-ref re-render, numbering), so a merge-produced state that trips them is
 * exercised too.
 *
 * The in-doc linked copy + detach path is structurally the same as the shipped
 * editable-zone + detach that a user reported jank around under co-editing, so
 * this study covers that operation directly.
 *
 * Per seed we assert: peers converge to an identical doc, the doc is schema-valid,
 * the render/derive functions are total on it (numbering, projection resolution,
 * in-doc divergence — no throw), and a repair pass is idempotent + convergent.
 * A failing seed is a reproducible convergence/validity bug in the transclusion +
 * co-editing interaction. (Verified with a heavier local sweep — 60 seeds, 4
 * peers, docs reaching 80+ views — which also converged; trimmed here for CI.)
 */

import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildDocRepairTr } from '../../src/doc-repair.js';
import { repairView } from './_repair-view.js';
import { createLoroPeers, syncAll, settle, docOf, para, cardNode, type LoroPeer } from './_loro-helpers.js';
import { createSelfRefNode, isSelfRef, resolveSelfProjection, flattenSelfRefsInSlice } from '../../src/editor/self-transclusion.js';
import { isTransclusionNode, createTransclusionNode, detachSlice } from '../../src/editor/transclusion.js';
import { buildInDocCopyAttrs } from '../../src/editor/transclusion-actions.js';
import { transclusionEmptyZoneReaper, transclusionSelectionGuard } from '../../src/editor/transclusion-selection-guard.js';
import { makeSelfRefPlugin } from '../../src/editor/self-transclusion-plugin.js';
import { cardNumberingPlugin } from '../../src/editor/numbering-plugin.js';
import { computeNumbering } from '../../src/editor/numbering.js';
import { inDocDivergence } from '../../src/editor/transclusion-divergence.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['impact', 'link', 'turns', 'warrant', 'solvency', 'uniqueness'];
const pick = <T>(rnd: () => number, xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

function block(text: string, id: string): PMNode {
  return schema.nodes['block']!.create({ id }, schema.text(text));
}

/** Seed with two block-headed sections (transclusion sources) + loose text. */
function seedDoc(): PMNode {
  return docOf(
    block('Alpha section', 'alpha'),
    cardNode('A1 tag', ['A1 body with evidence text to edit concurrently here.']),
    cardNode('A2 tag', ['A2 body with more evidence text right here to churn.']),
    block('Beta section', 'beta'),
    cardNode('B1 tag', ['B1 body evidence, also edited across peers repeatedly.']),
    para('A loose resolved paragraph, edited concurrently by every peer here.'),
  );
}

/** Block heading ids currently in the doc (the transclusion sources). */
function blockIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'block' && typeof n.attrs['id'] === 'string' && n.attrs['id']) {
      ids.push(n.attrs['id'] as string);
    }
    return true;
  });
  return ids;
}

/** Valid doc-level insert positions (before each top-level child + doc end). */
function docLevelPositions(doc: PMNode): number[] {
  const out = [0];
  let acc = 0;
  doc.forEach((n) => {
    acc += n.nodeSize;
    out.push(acc);
  });
  return out;
}

/** Absolute positions of every node matching `pred` (not descending into it). */
function nodePositions(doc: PMNode, pred: (n: PMNode) => boolean): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (pred(n)) {
      out.push(pos);
      return false;
    }
    return true;
  });
  return out;
}

/** Text positions inside a `card_body` that sits inside a linked copy. */
function bodyPositionsInZones(doc: PMNode): number[] {
  const out: number[] = [];
  const walk = (node: PMNode, base: number, inZone: boolean): void => {
    node.forEach((child, offset) => {
      const pos = base + offset;
      if (child.type.name === 'card_body' && inZone) out.push(pos + 1);
      if (child.content.size) walk(child, pos + 1, inZone || isTransclusionNode(child));
    });
  };
  walk(doc, 0, false);
  return out;
}

function textblocks(doc: PMNode): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return false;
    }
    return true;
  });
  return out;
}

/** One random operation. Position races throw RangeError and are skipped; any
 *  other throw (a plugin/logic crash) propagates and fails the seed. */
function op(rnd: () => number, p: LoroPeer): void {
  const view = p.view;
  const doc = view.state.doc;
  const roll = rnd();
  try {
    if (roll < 0.26) {
      // Plain text churn in a random textblock.
      const bs = textblocks(doc);
      if (!bs.length) return;
      const b = pick(rnd, bs);
      const at = b.start + Math.floor(rnd() * Math.max(1, b.end - b.start));
      if (rnd() < 0.6) view.dispatch(view.state.tr.insertText(` ${pick(rnd, WORDS)}`, at));
      else {
        const to = Math.min(b.end, at + 1 + Math.floor(rnd() * 6));
        if (to > at) view.dispatch(view.state.tr.delete(at, to));
      }
    } else if (roll < 0.4) {
      // Insert a live view (self_ref) pointing at a block section.
      const ids = blockIds(doc);
      if (!ids.length) return;
      const at = pick(rnd, docLevelPositions(doc));
      view.dispatch(view.state.tr.insert(at, createSelfRefNode(schema, pick(rnd, ids), '↳ src')));
    } else if (roll < 0.54) {
      // Insert an in-doc linked copy of a block section.
      const ids = blockIds(doc);
      if (!ids.length) return;
      const o = buildInDocCopyAttrs(doc, pick(rnd, ids));
      if (!o.ok || !o.attrs) return;
      const at = pick(rnd, docLevelPositions(doc));
      view.dispatch(view.state.tr.insert(at, createTransclusionNode(schema, o.attrs, o.content)));
    } else if (roll < 0.66) {
      // Edit inside a linked copy (races a concurrent detach on another peer).
      const bodies = bodyPositionsInZones(doc);
      if (!bodies.length) return;
      view.dispatch(view.state.tr.insertText(` ${pick(rnd, WORDS)}`, pick(rnd, bodies)));
    } else if (roll < 0.77) {
      // Detach a linked copy → its cards spill out as loose content.
      const zs = nodePositions(doc, isTransclusionNode);
      if (!zs.length) return;
      const at = pick(rnd, zs);
      const node = doc.nodeAt(at)!;
      view.dispatch(view.state.tr.replaceRange(at, at + node.nodeSize, detachSlice(node)));
    } else if (roll < 0.88) {
      // Unlink a live view → freeze its projection to real cards.
      const ss = nodePositions(doc, isSelfRef);
      if (!ss.length) return;
      const at = pick(rnd, ss);
      const flat = flattenSelfRefsInSlice(doc.slice(at, at + 1), doc, newHeadingId);
      view.dispatch(view.state.tr.replace(at, at + 1, flat));
    } else if (roll < 0.95) {
      // Delete a zone or live view outright.
      const ns = nodePositions(doc, (n) => isTransclusionNode(n) || isSelfRef(n));
      if (!ns.length) return;
      const at = pick(rnd, ns);
      const node = doc.nodeAt(at)!;
      view.dispatch(view.state.tr.delete(at, at + node.nodeSize));
    } else {
      // Insert a fresh card at the end.
      view.dispatch(
        view.state.tr.insert(doc.content.size, cardNode(`Fuzz ${Math.floor(rnd() * 999)}`, ['body evidence'])),
      );
    }
  } catch (e) {
    if (e instanceof RangeError) return; // a position/slice race — expected under fuzz
    throw e;
  }
}

/** Assert the derive/render functions are TOTAL on `d` (no throw). A crash here
 *  is a real bug: a converged doc our plugins can't render. */
function assertRenderTotal(d: PMNode, label: string): void {
  expect(() => computeNumbering(d), `${label}: computeNumbering`).not.toThrow();
  expect(() => inDocDivergence(d), `${label}: inDocDivergence`).not.toThrow();
  d.descendants((n) => {
    if (isSelfRef(n)) {
      expect(
        () => resolveSelfProjection(d, String(n.attrs['source_heading_id'] ?? '')),
        `${label}: resolveSelfProjection`,
      ).not.toThrow();
    }
    return true;
  });
}

const peerPlugins = () => [
  transclusionSelectionGuard,
  transclusionEmptyZoneReaper,
  makeSelfRefPlugin(),
  cardNumberingPlugin,
];

describe('transclusion × co-editing convergence study (offline partitions)', () => {
  // ~3.5s a seed alone; the full suite's parallel load more than doubles
  // it, which overran a flat 120s.
  it('converges valid across 24 seeds', { timeout: 15_000 * 24 }, async () => {
    for (let seed = 1; seed <= 24; seed++) {
      const rnd = mulberry32(seed);
      const N = 3;
      const peers = await createLoroPeers(seedDoc(), N, peerPlugins);
      for (let round = 0; round < 5; round++) {
        for (const p of peers) {
          const k = 1 + Math.floor(rnd() * 4);
          for (let i = 0; i < k; i++) op(rnd, p);
        }
        await settle();
        const mode = rnd();
        if (mode < 0.3) {
          await syncAll(peers); // full sync
        } else if (mode < 0.75) {
          // Partial heal: a random subset of 2..N-1 peers (the rest partitioned).
          const shuffled = peers.map((x) => x).sort(() => rnd() - 0.5);
          const size = 2 + Math.floor(rnd() * Math.max(1, N - 2));
          await syncAll(shuffled.slice(0, size));
        }
        // else: fully offline round — everyone diverges further before healing
      }
      await syncAll(peers);
      await syncAll(peers);

      const docs = peers.map((p) => p.doc());
      for (const d of docs) {
        expect(d.eq(docs[0]!), `seed ${seed} convergence`).toBe(true);
        expect(() => d.check(), `seed ${seed} validity`).not.toThrow();
      }
      assertRenderTotal(docs[0]!, `seed ${seed}`);

      // Repair idempotence + convergence (parity with loro-fuzz).
      if (buildDocRepairTr(peers[0]!.view.state)) {
        for (const p of peers) repairView(p.view);
        await settle();
        await syncAll(peers);
        for (const p of peers) repairView(p.view);
        await settle();
        await syncAll(peers);
        const repaired = peers.map((p) => p.doc());
        for (const d of repaired) {
          expect(d.eq(repaired[0]!), `seed ${seed} post-repair convergence`).toBe(true);
          expect(() => d.check(), `seed ${seed} post-repair validity`).not.toThrow();
        }
        assertRenderTotal(repaired[0]!, `seed ${seed} post-repair`);
      }
      peers.forEach((p) => p.destroy());
    }
  });
});
