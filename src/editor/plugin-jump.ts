/**
 * Shared jump resolution for plugin provenance tokens — used by
 * api.jumpToSource (local window) and the inbound /jump host.
 * Resolution order per spec 4.3: heading UUID, then text anchor.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { collectHeadings } from './headings.js';
import { resolveDescriptor } from './learn-anchor.js';
import { parseSourceToken, type SourcePayload } from './plugin-source-token.js';
import { scrollToHeadingId } from './precise-scroll.js';
import type { JumpResult } from './plugin-api.js';

export function resolveJumpInView(view: EditorView, payload: SourcePayload): boolean {
  const { doc } = view.state;
  if (payload.headingId) {
    const entry = collectHeadings(doc, { skipCite: true }).find(
      (h) => h.id === payload.headingId,
    );
    if (entry) {
      select(view, entry.pos + 1, payload.headingId);
      return true;
    }
  }
  if (payload.anchor) {
    const r = resolveDescriptor(doc, payload.anchor);
    // Never land inside a `self_ref` or `transclusion_ref`: their children
    // are read-only mirrored text, so a match there is a coincidence, not
    // the real source. Treat it as unresolved and fall through to not-found.
    if (r && !inMirroredContent(doc, r.from)) {
      select(view, r.from);
      return true;
    }
  }
  return false;
}

/** True when `pos` sits inside a `self_ref` or `transclusion_ref` mirror
 *  subtree. */
export function inMirroredContent(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'self_ref' || $pos.node(d).type.name === 'transclusion_ref') {
      return true;
    }
  }
  return false;
}

function select(view: EditorView, pos: number, headingId?: string): void {
  const tr = view.state.tr;
  tr.setSelection(TextSelection.create(tr.doc, Math.min(pos, tr.doc.content.size)));
  view.dispatch(tr);
  // Route through the nav-pane precise-scroll path when a heading id is
  // known and rendered; fall back to a plain scroll (anchor-only jumps,
  // or a headless/test DOM where the element isn't present).
  if (!headingId || !scrollToHeadingId(view, headingId)) {
    view.dispatch(view.state.tr.scrollIntoView());
  }
  view.focus();
}

/** `api.doc.jumpTo`: select a heading by its id (`part: 'heading'`), or
 *  the start of the first cite paragraph of the card / analytic unit it
 *  heads (`part: 'cite'`; falls back to the heading when the unit has
 *  no cite). Headings inside live views and linked copies don't count —
 *  `doc.read` never reports them, so their ids are not the plugin's. */
export function jumpToHeadingInView(
  view: EditorView,
  headingId: string,
  part: 'heading' | 'cite' = 'heading',
): boolean {
  const { doc } = view.state;
  let headPos = -1;
  doc.descendants((node, pos) => {
    if (headPos >= 0) return false;
    const t = node.type.name;
    if (t === 'self_ref' || t === 'transclusion_ref') return false;
    if (node.isTextblock) {
      if (node.attrs['id'] === headingId) headPos = pos;
      return false;
    }
    return true;
  });
  if (headPos < 0) return false;
  if (part === 'cite') {
    const $head = doc.resolve(headPos);
    const unit = $head.parent;
    if (unit.type.name === 'card' || unit.type.name === 'analytic_unit') {
      let citePos = -1;
      unit.forEach((child, offset) => {
        if (citePos < 0 && child.type.name === 'cite_paragraph') citePos = $head.start() + offset;
      });
      if (citePos >= 0) {
        select(view, citePos + 1);
        return true;
      }
    }
  }
  select(view, headPos + 1, headingId);
  return true;
}

/** Resolve a token against THIS window's doc. 'not-mine' = valid token
 *  for a different docId (the caller escalates to the main-process
 *  broadcast). */
export function jumpToTokenInView(
  view: EditorView,
  currentDocId: string | null,
  token: string,
): JumpResult | 'not-mine' {
  const payload = parseSourceToken(token);
  if (!payload) return { ok: false, error: 'bad-request' };
  if (!currentDocId || currentDocId !== payload.docId) return 'not-mine';
  if (resolveJumpInView(view, payload)) return { ok: true };
  return { ok: false, error: 'not-found', docTitle: payload.docTitle };
}
