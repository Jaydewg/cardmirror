/**
 * Just enough of a DOM for ProseMirror's DOMSerializer (createElement[NS],
 * createTextNode, createDocumentFragment, appendChild, setAttribute[NS],
 * nodeType) to serialize CardMirror's schema in Node, then print the
 * result as HTML. The schema's toDOM specs are plain arrays, never live
 * nodes, so nothing else is reached.
 */
import { escapeHtml } from './print-html.js';

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'wbr']);

abstract class FakeNode {
  abstract readonly nodeType: number;
  childNodes: FakeNode[] = [];
  appendChild<T extends FakeNode>(child: T): T {
    if (child.nodeType === 11) {
      this.childNodes.push(...child.childNodes);
      child.childNodes = [];
    } else {
      this.childNodes.push(child);
    }
    return child;
  }
  abstract html(): string;
}

class FakeText extends FakeNode {
  readonly nodeType = 3;
  constructor(readonly text: string) {
    super();
  }
  html(): string {
    return escapeHtml(this.text);
  }
}

class FakeElement extends FakeNode {
  readonly nodeType = 1;
  private attrs = new Map<string, string>();
  constructor(readonly tagName: string) {
    super();
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }
  html(): string {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
    const tag = this.tagName.toLowerCase();
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.childNodes.map((c) => c.html()).join('')}</${tag}>`;
  }
}

class FakeFragment extends FakeNode {
  readonly nodeType = 11;
  html(): string {
    return this.childNodes.map((c) => c.html()).join('');
  }
}

export const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => new FakeText(text),
  createDocumentFragment: () => new FakeFragment(),
};

export function fragmentHtml(node: unknown): string {
  return node instanceof FakeNode ? node.html() : '';
}
