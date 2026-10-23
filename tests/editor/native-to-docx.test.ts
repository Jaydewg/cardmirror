/**
 * Stored .cmir → .docx for the recovery sidebar and Bulk Convert must go
 * through the ordinary export pipeline: live views (self_ref) materialize
 * as real cards instead of exporting as empty paragraphs (audit item 11).
 */
import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createSelfRefNode } from '../../src/editor/self-transclusion.js';
import { serializeNative, fromDocxFull } from '../../src/index.js';
import { nativeBytesToDocx } from '../../src/editor/native-to-docx.js';

const block = (t: string, id: string) => schema.nodes['block']!.create({ id }, schema.text(t));
const card = (tag: string, body: string) =>
  schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);

describe('nativeBytesToDocx', () => {
  it('materializes a live view as its source cards in the .docx', async () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', 'src'),
      card('Src tag', 'source body'),
      block('Home', 'home'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    const cmir = serializeNative(doc);
    const docx = await nativeBytesToDocx(cmir, { bodyFont: 'Times New Roman', markUnreadAfterMarker: true });
    const back = await fromDocxFull(docx);
    const text = back.doc.textContent;
    // The live view under "Home" came out as the Source cards again.
    expect(text.indexOf('Home')).toBeGreaterThan(-1);
    expect(text.slice(text.indexOf('Home'))).toContain('source body');
    expect(text.match(/source body/g)?.length).toBe(2);
  });

  it('never bakes the unread red into the output (working file semantics)', async () => {
    // A doc with the reading marker + text after it would gain red runs if
    // baked; with the setting ON the pipeline must still not bake.
    const doc = schema.nodes['doc']!.create(null, [card('T', 'alpha beta')]);
    const docx = await nativeBytesToDocx(serializeNative(doc), { bodyFont: 'Times New Roman', markUnreadAfterMarker: true });
    const back = await fromDocxFull(docx);
    let red = false;
    back.doc.descendants((n) => { if (n.marks.some((m) => m.type.name === 'font_color' && m.attrs['color'] !== '000000')) red = true; return true; });
    expect(red).toBe(false);
    expect(back.doc.textContent).toContain('alpha beta');
  });
});
