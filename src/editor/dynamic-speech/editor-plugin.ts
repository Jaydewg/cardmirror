/**
 * Dynamic speech in the editor: the per-view session state (mapped
 * through every edit), a tick at each time mark, dimming over skipped /
 * clipped text, and the in-speech keys. An internal ProseMirror plugin,
 * registered BEFORE read mode's so Space and Backspace reach it first
 * while a session runs; with no session armed it does nothing.
 */

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { settings, type DynamicSpeechAction } from '../settings.js';
import { foldKeyString, ribbonKeyStringFor } from '../ribbon-commands.js';
import { showToast } from '../toast.js';
import {
  dynamicSpeechKey,
  initialSpeechState,
  onReadingMarkerPlaced,
  reduceSpeechState,
  runSpeechAction,
  speechKeysLive,
  type SpeechDocState,
} from './session.js';

const decoCache = new WeakMap<SpeechDocState, DecorationSet>();

function tick(kind: 'mark' | 'clip'): HTMLElement {
  const el = document.createElement('span');
  el.className = kind === 'clip' ? 'pmd-ds-tick pmd-ds-tick-clip' : 'pmd-ds-tick';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function decorationsFor(s: SpeechDocState, doc: PMNode): DecorationSet {
  const hit = decoCache.get(s);
  if (hit) return hit;
  const decos: Decoration[] = [];
  for (const r of s.excluded) decos.push(Decoration.inline(r.from, r.to, { class: 'pmd-ds-excluded' }));
  s.points.forEach((p, i) => {
    decos.push(Decoration.widget(p.pos, () => tick(p.kind), { side: -1, key: `ds-${i}-${p.kind}`, ignoreSelection: true }));
  });
  const set = DecorationSet.create(doc, decos);
  decoCache.set(s, set);
  return set;
}

/** The in-speech action bound to this keydown, if any. */
export function speechActionFor(e: KeyboardEvent): DynamicSpeechAction | null {
  const pressed = foldKeyString(ribbonKeyStringFor(e));
  const keys = settings.get('dynamicSpeechKeys');
  for (const action of ['timeMark', 'skipClip', 'undo'] as const) {
    const k = keys[action];
    if (k && foldKeyString(k) === pressed) return action;
  }
  return null;
}

function scrollerRect(view: EditorView): { top: number; bottom: number } {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/** The caret is on screen, give or take three lines. */
export function cursorOnScreen(view: EditorView): boolean {
  let coords: { top: number; bottom: number };
  try {
    coords = view.coordsAtPos(view.state.selection.head);
  } catch {
    return true;
  }
  const line = parseFloat(getComputedStyle(view.dom).lineHeight) || 20;
  const { top, bottom } = scrollerRect(view);
  return coords.bottom >= top - 3 * line && coords.top <= bottom + 3 * line;
}

export const dynamicSpeechPlugin = new Plugin<SpeechDocState>({
  key: dynamicSpeechKey,
  state: {
    init: () => initialSpeechState(),
    apply: (tr, prev, oldState) => reduceSpeechState(prev, tr, oldState.selection.head),
  },
  props: {
    decorations(state) {
      const s = dynamicSpeechKey.getState(state);
      return s?.armed ? decorationsFor(s, state.doc) : null;
    },
    handleDOMEvents: {
      keydown(view, event) {
        if (!speechKeysLive(view)) return false;
        const action = speechActionFor(event);
        if (!action) return false;
        event.preventDefault();
        if (settings.get('dynamicSpeechRequireCursorVisible') && !cursorOnScreen(view)) {
          showToast('Cursor off-screen; marker not placed');
          return true;
        }
        runSpeechAction(action);
        return true;
      },
    },
  },
  view() {
    return {
      update(view, prevState) {
        const s = dynamicSpeechKey.getState(view.state);
        const p = dynamicSpeechKey.getState(prevState);
        if (s && p && s.armed && s.markerSeq !== p.markerSeq) onReadingMarkerPlaced(view, s.markerPos);
      },
    };
  },
});
