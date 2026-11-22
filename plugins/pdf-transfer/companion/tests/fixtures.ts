import type { PluginDocSnapshot } from '@cardmirror/plugin-api';

export const SNAP: PluginDocSnapshot = {
  docUid: 'u-1',
  docId: 'd-1',
  title: '1AC',
  outline: [
    { id: 'p1', type: 'pocket', level: 1, text: '1AC', formatting: [] },
    { id: 't1', type: 'tag', level: 4, text: 'Warming is real', formatting: [] },
    { id: 'a1', type: 'analytic', level: 4, text: 'Extend it', formatting: [] },
  ],
  cards: [
    {
      headingId: 't1',
      kind: 'card',
      heading: 'Warming is real',
      cite: 'Smith 24',
      citeParagraphs: ['Smith 24 (professor)'],
      body: ['The planet is warming fast'],
      bodyRead: [[[4, 10]]],
      undertags: ['context'],
      formatting: {
        heading: [],
        citeParagraphs: [[{ from: 0, to: 8, style: 'cite' }]],
        body: [
          [
            { from: 0, to: 21, style: 'underline' },
            { from: 4, to: 10, style: 'highlight', color: 'cyan' },
            { from: 11, to: 13, style: 'emphasis' },
          ],
        ],
        undertags: [[]],
      },
    },
    {
      headingId: 'a1',
      kind: 'analytic',
      heading: 'Extend it',
      cite: '',
      citeParagraphs: [],
      body: [],
      undertags: [],
      formatting: { heading: [], citeParagraphs: [], body: [], undertags: [] },
    },
  ],
  stats: { cards: 2, readAloudWords: { body: 1, other: 0 } },
};
