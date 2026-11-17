import { describe, expect, it } from 'vitest';
import { analyzeCard, analyzeParagraph, occurrenceOf, type Finding } from '../src/analyze.js';
import { ALL_HEDGES, card, config, marked } from './fixtures.js';

/** [ruleId, severity, flagged text] for one marked paragraph. */
function check(src: string, cfg = config()): [string, string, string][] {
  const { text, ranges } = marked(src);
  return analyzeParagraph(text, ranges, cfg).map((f: Finding) => [f.ruleId, f.severity, text.slice(f.from, f.to)]);
}

describe('dropped negations (red)', () => {
  it('flags not / never / n’t left out of a read clause', () => {
    expect(check('{The plan does} not {solve warming}.')).toEqual([['negation', 'error', 'not']]);
    expect(check('{Sanctions} never {work}.')).toEqual([['negation', 'error', 'never']]);
    expect(check('{The plan} doesn’t {solve}.')).toEqual([['negation', 'error', 'doesn’t']]);
    expect(check('Not {all experts agree}.')).toEqual([['negation', 'error', 'Not']]);
    expect(check('{Russia is} no longer {a threat}.')).toEqual([['negation', 'error', 'no longer']]);
  });

  it('leaves alone a negation whose clause has nothing read after it', () => {
    expect(check('{Warming is caused by humans}, not the sun.')).toEqual([]);
    expect(check('{The report}, which was not peer reviewed, {found warming}.')).toEqual([]);
    expect(check('{The plan} solves the problem, not the CP.')).toEqual([]);
  });

  it('leaves alone a read negation and the exception phrases', () => {
    expect(check('{The plan does not solve warming}.')).toEqual([]);
    expect(check('not only {does the plan solve warming}, it saves lives')).toEqual([]);
    expect(check('{It is} no doubt {true}.')).toEqual([]);
  });

  it('the negation list is editable; an empty list switches it off', () => {
    expect(check('{The plan does} not {solve}.', config({ negations: [] }))).toEqual([]);
    expect(check('{The plan} fails to {solve}.', config({ negations: ['fails to'] }))).toEqual([['negation', 'error', 'fails to']]);
  });
});

describe('partial words (red)', () => {
  it('flags a stem read without the part that negates it', () => {
    expect(check('The plan {does}n’t solve.')).toEqual([['partial-word', 'error', 'doesn’t']]);
    expect(check('Warming is un{likely} to cause war.')).toEqual([['partial-word', 'error', 'unlikely']]);
    expect(check('The plan {can}not solve.')).toEqual([['partial-word', 'error', 'cannot']]);
    expect(check('The situation is {hope}less.')).toEqual([['partial-word', 'error', 'hopeless']]);
    expect(check('A non-{violent} protest.')).toEqual([['partial-word', 'error', 'non-violent']]);
  });

  it('says what was read and what was left out', () => {
    const { text, ranges } = marked('The plan {does}n’t solve.');
    expect(analyzeParagraph(text, ranges, config())[0]!.message).toBe(
      'Reads “does” out of “doesn’t”, leaving out “n’t”.',
    );
  });

  it('leaves alone abbreviation-style highlights; letter picks are opt-in', () => {
    expect(check('The {U}nited {S}tates.')).toEqual([]);
    expect(check('{econ}omic growth')).toEqual([]);
    expect(check('see the{rapist}')).toEqual([]);
    expect(check('see the{rapist}', config({ rules: { 'letter-pick': true } }))).toEqual([['letter-pick', 'info', 'therapist']]);
  });
});

describe('reported claims, conditions, numbers (red)', () => {
  it('flags a dropped attribution to people the author may be rebutting', () => {
    expect(check('Critics claim {the plan causes war}.')).toEqual([['reported', 'error', 'Critics']]);
    expect(check('It is a myth that {sanctions work}.')).toEqual([['reported', 'error', 'myth']]);
    expect(check('The idea that {deterrence fails} is common.')).toEqual([['reported', 'warning', 'The idea that']]);
  });

  it('flags a dropped condition', () => {
    expect(check('Unless funding increases, {the program collapses}.')).toEqual([['condition', 'error', 'Unless']]);
    expect(check('If {warming continues}, crops fail.')).toEqual([['condition', 'error', 'If']]);
    expect(check('{The plan fails} if Congress refuses.')).toEqual([]);
  });

  it('flags partial numbers, dropped units and dropped limits', () => {
    expect(check('Emissions fell {1}5% last year.')).toEqual([['number', 'error', '15']]);
    expect(check('Emissions fell {15}% last year.')).toEqual([['number', 'error', '%']]);
    expect(check('It costs {3} billion dollars.')).toEqual([['number', 'error', 'billion']]);
    expect(check('{It causes} less than {10% of emissions}.')).toEqual([['number', 'error', 'less than']]);
    expect(check('{It causes 10% of emissions}.')).toEqual([]);
  });

  it('a limit word that is not before a number falls back to the shorter entry', () => {
    expect(check('{The plan is} less {likely to pass}.')).toEqual([['qualifier', 'warning', 'less']]);
  });
});

describe('amber rules', () => {
  it('flags rarely / seldom and other qualifiers', () => {
    expect(check('{Sanctions} rarely {work}.')).toEqual([['qualifier', 'warning', 'rarely']]);
    expect(check('{Wars} seldom {escalate}.')).toEqual([['qualifier', 'warning', 'seldom']]);
    expect(check('In some cases {the drug causes harm}.')).toEqual([['qualifier', 'warning', 'In some cases']]);
  });

  it('flags dated phrasing', () => {
    expect(check('{Russia} used to {dominate the region}.')).toEqual([['dated', 'warning', 'used to']]);
  });

  it('flags a concession read without the main point', () => {
    expect(check('While {the plan is popular}, it fails to solve.')).toEqual([['concession', 'warning', 'While']]);
    expect(check('While the plan is popular, {it fails to solve}.')).toEqual([]);
  });

  it('flags part of a question read as a claim', () => {
    expect(check('Will {sanctions collapse the regime}?')).toEqual([['question', 'warning', 'sanctions']]);
    expect(check('{Will sanctions collapse the regime}?')).toEqual([]);
  });

  it('flags the middles of two sentences joined into one claim', () => {
    const got = check('The {economy will grow} next year. Experts warn {collapse is coming}.');
    expect(got).toEqual([['stitched', 'warning', 'collapse']]);
    expect(check('{The economy will grow}. Experts warn {collapse is coming}.')).toEqual([]);
    expect(check('Dr. {Smith says} the {plan works}.')).toEqual([]); // "Dr." doesn't end a sentence
  });
});

describe('info rules', () => {
  it('flags brackets and ellipses inside read text', () => {
    expect(check('{The [plan] works}.')).toEqual([['brackets', 'info', '[plan]']]);
    expect(check('{The plan works … forever}.')).toEqual([['brackets', 'info', '…']]);
  });

  it('hedges are off until the list is set', () => {
    expect(check('{It} may {cause war}.')).toEqual([]);
    expect(check('{It} may {cause war}.', config({ hedges: ALL_HEDGES }))).toEqual([['hedge', 'info', 'may']]);
  });

  it('gaps are opt-in', () => {
    const src = `{A} ${'x '.repeat(5)}{B}.`;
    expect(check(src, config({ rules: { gap: true }, gapWords: 5 }))).toEqual([['gap', 'info', 'B']]);
    expect(check(src, config({ gapWords: 5 }))).toEqual([]);
  });

  it('flags a tag that claims certainty over hedged read text (opt-in)', () => {
    const c = card('Sanctions will collapse the regime', '{Sanctions may collapse the regime}.');
    expect(analyzeCard(c, config())).toEqual([]);
    const [f] = analyzeCard(c, config({ rules: { tag: true } }))!;
    expect(f).toMatchObject({ ruleId: 'tag', part: 'heading', from: 10, to: 14 });
  });
});

describe('cards', () => {
  it('returns null when the build has no bodyRead, and skips analytics', () => {
    const c = card('Tag', '{The plan does} not {solve}.');
    expect(analyzeCard({ ...c, bodyRead: undefined }, config())).toBeNull();
    expect(analyzeCard({ ...c, kind: 'analytic' }, config())).toEqual([]);
  });

  it('indexes findings by body paragraph, with the sentence as context', () => {
    const c = card('Tag', '{Nothing odd here}.', 'First. {The plan does} not {solve}. Last.');
    const [f] = analyzeCard(c, config())!;
    expect(f).toMatchObject({ part: 'body', index: 1, ruleId: 'negation' });
    expect(c.body[1]!.slice(f!.context.from, f!.context.to)).toBe('The plan does not solve.');
  });

  it('an unread paragraph yields nothing', () => {
    expect(analyzeCard(card('Tag', 'The plan does not solve.'), config())).toEqual([]);
  });
});

describe('occurrenceOf', () => {
  it('counts substring hits the way the host searches', () => {
    const text = 'nothing is not what it is not';
    expect(occurrenceOf(text, 'not', text.indexOf('not ', 10))).toBe(1); // "not" in "nothing" is hit 0
    expect(occurrenceOf(text, 'not', text.lastIndexOf('not'))).toBe(2);
  });
});
