import type { PluginCard } from '@cardmirror/plugin-api';
import { DEFAULT_RULES, type RuleConfig, type ToggleRule } from '../src/analyze.js';
import { DEFAULT_EXCEPTIONS, DEFAULT_HEDGES, DEFAULT_NEGATIONS, DEFAULT_QUALIFIERS } from '../src/words.js';

/** `'The plan does not {solve warming}'` → the text without braces, and
 *  the braced parts as read ranges. */
export function marked(src: string): { text: string; ranges: [number, number][] } {
  let text = '';
  const ranges: [number, number][] = [];
  let open = -1;
  for (const ch of src) {
    if (ch === '{') open = text.length;
    else if (ch === '}') {
      ranges.push([open, text.length]);
      open = -1;
    } else text += ch;
  }
  return { text, ranges };
}

export function config(over: Partial<Omit<RuleConfig, 'rules'>> & { rules?: Partial<Record<ToggleRule, boolean>> } = {}): RuleConfig {
  return {
    negations: [...DEFAULT_NEGATIONS],
    qualifiers: [...DEFAULT_QUALIFIERS],
    hedges: [],
    exceptions: [...DEFAULT_EXCEPTIONS],
    gapWords: 40,
    ...over,
    rules: { ...DEFAULT_RULES, ...over.rules },
  };
}

export const ALL_HEDGES = [...DEFAULT_HEDGES];

let nextId = 1;
/** A card whose body paragraphs are written with `marked` braces. */
export function card(tag: string, ...paras: string[]): PluginCard {
  const m = paras.map(marked);
  return {
    headingId: `h${nextId++}`,
    kind: 'card',
    heading: tag,
    cite: 'Doe 24',
    citeParagraphs: ['Jane Doe 24, Professor'],
    body: m.map((x) => x.text),
    bodyRead: m.map((x) => x.ranges),
    undertags: [],
  };
}
