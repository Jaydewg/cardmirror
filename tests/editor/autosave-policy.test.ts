import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { createSelfRefNode } from '../../src/editor/self-transclusion.js';
import {
  AUTOSAVE_DELAY_MS,
  DOCX_AUTOSAVE_IDLE_MS,
  autosaveDelayFor,
  autosaveEffect,
  hasLiveLinks,
  liveLinkCounts,
  liveLinksAppeared,
  shouldSaveOnClose,
} from '../../src/editor/autosave-policy.js';

const para = (text: string): PMNode => schema.nodes['paragraph']!.create(null, schema.text(text));
const view = (): PMNode => createSelfRefNode(schema, 'heading-1', 'Section');
const copy = (): PMNode =>
  schema.nodes['transclusion_ref']!.create({ source_ref: 'other.cmir', source_heading_id: 'h' }, [para('copied')]);
const doc = (...children: PMNode[]): PMNode => schema.nodes['doc']!.create(null, children);

describe('autosave-policy', () => {
  it('waits a long idle window for .docx, the short debounce otherwise', () => {
    expect(autosaveDelayFor('docx')).toBe(DOCX_AUTOSAVE_IDLE_MS);
    expect(autosaveDelayFor('cmir')).toBe(AUTOSAVE_DELAY_MS);
    expect(autosaveDelayFor(null)).toBe(AUTOSAVE_DELAY_MS);
    expect(DOCX_AUTOSAVE_IDLE_MS).toBeGreaterThan(AUTOSAVE_DELAY_MS);
  });

  it('counts live views and linked copies', () => {
    expect(liveLinkCounts(doc(para('a')))).toEqual({ views: 0, copies: 0 });
    expect(liveLinkCounts(doc(para('a'), view(), copy(), view()))).toEqual({ views: 2, copies: 1 });
    expect(hasLiveLinks(doc(para('a')))).toBe(false);
    expect(hasLiveLinks(doc(copy()))).toBe(true);
    expect(hasLiveLinks(null)).toBe(false);
  });

  it('flags only the first live link appearing', () => {
    const none = doc(para('a'));
    const one = doc(para('a'), view());
    const two = doc(para('a'), view(), copy());
    expect(liveLinksAppeared(none, one)).toBe(true);
    expect(liveLinksAppeared(one, two)).toBe(false);
    expect(liveLinksAppeared(one, none)).toBe(false);
    expect(liveLinksAppeared(none, none)).toBe(false);
  });

  it('autosaves .docx only without live links, and only once saved', () => {
    const plain = doc(para('a'));
    const linked = doc(para('a'), copy());
    expect(autosaveEffect({ format: 'docx', handle: '/x.docx', doc: plain })).toBe('effective');
    expect(autosaveEffect({ format: 'docx', handle: '/x.docx', doc: linked })).toBe('docx-live-links');
    expect(autosaveEffect({ format: 'cmir', handle: '/x.cmir', doc: linked })).toBe('effective');
    expect(autosaveEffect({ format: null, handle: null, doc: plain })).toBe('unsaved');
    expect(autosaveEffect({ format: 'docx', handle: null, doc: plain })).toBe('unsaved');
  });

  describe('shouldSaveOnClose', () => {
    const base = {
      autosaveOn: true,
      inPlaceSupported: true,
      recoveredDraft: false,
      format: 'docx' as const,
      handle: '/speech.docx',
      doc: doc(para('a')),
    };

    it('saves silently when autosave would have written the doc', () => {
      expect(shouldSaveOnClose(base)).toBe(true);
      expect(shouldSaveOnClose({ ...base, format: 'cmir', handle: '/speech.cmir' })).toBe(true);
    });

    it('keeps the prompt otherwise', () => {
      expect(shouldSaveOnClose({ ...base, autosaveOn: false })).toBe(false);
      expect(shouldSaveOnClose({ ...base, inPlaceSupported: false })).toBe(false);
      expect(shouldSaveOnClose({ ...base, recoveredDraft: true })).toBe(false);
      expect(shouldSaveOnClose({ ...base, handle: null })).toBe(false);
      expect(shouldSaveOnClose({ ...base, doc: doc(para('a'), view()) })).toBe(false);
    });
  });
});
