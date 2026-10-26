// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { schema, isSafeLinkHref } from '../../src/schema/index.js';

function parse(html: string) {
  const d = document.implementation.createHTMLDocument('t');
  d.body.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(d.body);
}
const linkOf = (doc: ReturnType<typeof parse>) => {
  let href: string | null = null;
  doc.descendants((n) => { const m = n.marks.find((x) => x.type.name === 'link'); if (m) href = String(m.attrs['href']); return true; });
  return href;
};

describe('link mark href scheme filter', () => {
  it('keeps http(s), mailto and relative hrefs', () => {
    expect(linkOf(parse('<p><a href="https://x.org/a">t</a></p>'))).toBe('https://x.org/a');
    expect(linkOf(parse('<p><a href="mailto:a@b.c">t</a></p>'))).toBe('mailto:a@b.c');
    expect(linkOf(parse('<p><a href="#fn1">t</a></p>'))).toBe('#fn1');
  });
  it('drops javascript: and data: links but keeps the text', () => {
    const doc = parse('<p><a href="javascript:alert(1)">click</a> and <a href="data:text/html,x">me</a></p>');
    expect(linkOf(doc)).toBeNull();
    expect(doc.textContent).toBe('click and me');
  });
  it('isSafeLinkHref', () => {
    expect(isSafeLinkHref(' JavaScript:1')).toBe(false);
    expect(isSafeLinkHref('HTTPS://a')).toBe(true);
    expect(isSafeLinkHref('/relative/path')).toBe(true);
  });
});
