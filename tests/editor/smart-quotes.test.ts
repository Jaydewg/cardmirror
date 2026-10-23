import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import {
  smartQuotesPlugin,
  smartQuotesKey,
  curlFor,
} from '../../src/editor/smart-quotes-plugin.js';
import { settings } from '../../src/editor/settings.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const cardBody = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.createChecked(null, k);
const doc = (...k: PMNode[]) => schema.nodes['doc']!.createChecked(null, k);

function bodyEnd(d: PMNode): number {
  let end = 0;
  d.descendants((node, pos) => {
    if (node.type.name === 'card_body') end = pos + 1 + node.content.size;
  });
  return end;
}
function bodyText(d: PMNode): string {
  let out = '';
  d.descendants((node) => {
    if (node.type.name === 'card_body') out = node.textContent;
  });
  return out;
}

/** Type `char` at the end of a single card_body containing `body`, driving the
 *  plugin's handlers against a minimal fake view. */
function typeAtBodyEnd(body: string, char: string) {
  const d = doc(card(tag('T'), cardBody(body)));
  const plugin = smartQuotesPlugin();
  let state = EditorState.create({ doc: d, plugins: [plugin] });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: unknown) {
      state = state.apply(tr as never);
    },
  } as never;
  const end = bodyEnd(d);
  const ret = propsOf(plugin).handleTextInput(view, end, end, char);
  return { view: view as { state: EditorState; dispatch: (tr: unknown) => void }, plugin, ret };
}

/** PM types the plugin's prop callbacks with a `this` context that's awkward to
 *  satisfy from a test; cast to plain callables (runtime ignores `this`). */
function propsOf(plugin: ReturnType<typeof smartQuotesPlugin>) {
  return plugin.props as unknown as {
    handleTextInput: (v: unknown, from: number, to: number, text: string) => boolean;
    handleKeyDown: (v: unknown, e: unknown) => boolean;
  };
}

const BS = { key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe('curlFor', () => {
  it('opens after a block start, whitespace, bracket, dash, or opening quote', () => {
    for (const prev of ['', ' ', '\t', '(', '[', '—', '–', '‘', '"']) {
      expect(curlFor('"', prev)).toBe('“');
      expect(curlFor("'", prev)).toBe('‘');
    }
  });
  it('closes (and apostrophes) after a letter, digit, or closing punctuation', () => {
    for (const prev of ['a', 'n', '5', '.', ')']) {
      expect(curlFor('"', prev)).toBe('”');
      expect(curlFor("'", prev)).toBe('’');
    }
  });
});

describe('smart quotes plugin', () => {
  it('curls based on the preceding character when enabled', () => {
    settings.set('smartQuotes', true);
    expect(bodyText(typeAtBodyEnd('hello ', '"').view.state.doc)).toBe('hello “'); // space → open
    expect(bodyText(typeAtBodyEnd('hello', '"').view.state.doc)).toBe('hello”'); // letter → close
    expect(bodyText(typeAtBodyEnd('hello', "'").view.state.doc)).toBe('hello’'); // apostrophe
    expect(bodyText(typeAtBodyEnd('em—', '"').view.state.doc)).toBe('em—“'); // em-dash → open
  });

  it('a digit typed after an opening single quote flips it to an apostrophe', () => {
    settings.set('smartQuotes', true);
    expect(bodyText(typeAtBodyEnd('Smith ‘', '2').view.state.doc)).toBe('Smith ’2'); // cite year
    expect(typeAtBodyEnd('a “', '2').ret).toBe(false); // double quotes untouched
  });

  it('the digit flip has its own toggle (on by default) under Smart quotes', () => {
    settings.set('smartQuotes', true);
    settings.set('smartQuoteDatesAsApostrophes', false);
    try {
      expect(typeAtBodyEnd('Smith ‘', '2').ret).toBe(false);
    } finally {
      settings.set('smartQuoteDatesAsApostrophes', true);
    }
  });

  it('does nothing when the setting is off', () => {
    settings.set('smartQuotes', false);
    const { ret, view } = typeAtBodyEnd('hello', '"');
    expect(ret).toBe(false);
    expect(bodyText(view.state.doc)).toBe('hello'); // untouched
  });

  it('Backspace right after a curl reverts to the straight character', () => {
    settings.set('smartQuotes', true);
    const { plugin, view } = typeAtBodyEnd('hello', '"'); // → hello”
    expect(bodyText(view.state.doc)).toBe('hello”');
    expect(smartQuotesKey.getState(view.state)!.undo).not.toBeNull();
    const handled = propsOf(plugin).handleKeyDown(view, BS);
    expect(handled).toBe(true);
    expect(bodyText(view.state.doc)).toBe('hello"'); // straight ASCII quote restored
  });

  it('Backspace does NOT revert once another edit intervenes', () => {
    settings.set('smartQuotes', true);
    const { plugin, view } = typeAtBodyEnd('hi', "'"); // → hi’
    view.dispatch(view.state.tr.insertText('x')); // intervening edit closes the window
    expect(smartQuotesKey.getState(view.state)!.undo).toBeNull();
    const handled = propsOf(plugin).handleKeyDown(view, BS);
    expect(handled).toBe(false);
  });
});
