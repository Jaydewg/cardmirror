// @vitest-environment jsdom
/**
 * Inserting a received card (inbox-insert.ts): the newest inbox item lands
 * in the document and is marked READ — in the store, in the unread count,
 * and in the persisted (web) backend — while staying in the inbox. An
 * undecodable item is neither inserted nor marked read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice, Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { inboxStore, type InboxItem } from '../../src/editor/pairing/inbox-store.js';
import { insertMostRecentReceived, insertReceivedItem } from '../../src/editor/pairing/inbox-insert.js';

const STORAGE_KEY = 'pmd-pairing-inbox';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
const sliceJson = (...nodes: PMNode[]): unknown => new Slice(Fragment.fromArray(nodes), 0, 0).toJSON();

function item(id: string, tag: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    label: tag,
    type: 'card',
    sliceJson: sliceJson(card(tag, `${tag} body`)),
    senderName: 'Partner',
    senderCode: 'ABCD-1234',
    receivedAt: Date.now(),
    read: false,
    ...over,
  };
}

/** Seed the singleton the way the other pill tests do. */
function seed(items: InboxItem[]): void {
  const store = inboxStore as unknown as { items: InboxItem[]; fire: () => void };
  store.items = items;
  store.fire();
}

const open: EditorView[] = [];
function mount(): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block heading')),
    card('Existing tag', 'existing body'),
  ]);
  const view = new EditorView(host, { state: EditorState.create({ doc }) });
  open.push(view);
  return view;
}

function tagsOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'tag') out.push(n.textContent);
    return true;
  });
  return out;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const v of open.splice(0)) v.destroy();
  seed([]);
});

describe('insertMostRecentReceived', () => {
  it('inserts the newest item and marks ONLY it read, keeping it in the inbox', async () => {
    seed([item('older', 'Older card'), item('newest', 'Newest card')]);
    expect(inboxStore.unreadCount()).toBe(2);
    const view = mount();

    expect(insertMostRecentReceived(view, false)).toBe(true);
    expect(tagsOf(view.state.doc)).toContain('Newest card');
    expect(tagsOf(view.state.doc)).not.toContain('Older card');

    // Marked read, still listed; the older one stays unread.
    await Promise.resolve();
    const items = inboxStore.list();
    expect(items.map((it) => [it.id, it.read])).toEqual([
      ['older', false],
      ['newest', true],
    ]);
    expect(inboxStore.unreadCount()).toBe(1);
    // Persisted through the web backend (no Electron host in jsdom).
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as InboxItem[];
    expect(stored.find((it) => it.id === 'newest')?.read).toBe(true);
    expect(stored.find((it) => it.id === 'older')?.read).toBe(false);
  });

  it('appends at the end when asked, and marks read the same way', async () => {
    seed([item('a', 'Alpha'), item('b', 'Bravo')]);
    const view = mount();
    expect(insertMostRecentReceived(view, true)).toBe(true);
    expect(tagsOf(view.state.doc).at(-1)).toBe('Bravo');
    await Promise.resolve();
    expect(inboxStore.list().find((it) => it.id === 'b')?.read).toBe(true);
  });

  it('is a no-op on an empty inbox', () => {
    seed([]);
    const view = mount();
    expect(insertMostRecentReceived(view, false)).toBe(false);
    expect(tagsOf(view.state.doc)).toEqual(['Existing tag']);
  });
});

describe('insertReceivedItem', () => {
  it('neither inserts nor marks read an item whose slice cannot be decoded', async () => {
    const bad = item('bad', 'Broken', { sliceJson: { content: [{ type: 'no_such_node' }] } });
    seed([bad]);
    const view = mount();
    expect(insertReceivedItem(view, bad, false)).toBe(false);
    expect(tagsOf(view.state.doc)).toEqual(['Existing tag']);
    await Promise.resolve();
    expect(inboxStore.unreadCount()).toBe(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('marking read is idempotent: an already-read item does not rewrite storage', async () => {
    seed([item('r', 'Read already', { read: true })]);
    const view = mount();
    expect(insertReceivedItem(view, inboxStore.list()[0]!, false)).toBe(true);
    await Promise.resolve();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(inboxStore.unreadCount()).toBe(0);
  });
});
