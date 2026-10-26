import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { exportDoc } from '../../src/export/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocx } from '../../src/import/index.js';
import { Docx } from '../../src/ooxml/docx.js';

describe('exporter — basic structure', () => {
  it('emits a valid docx envelope', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hello')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:document');
    expect(documentXml).toContain('<w:body>');
    expect(documentXml).toContain('</w:body>');
    expect(documentXml).toContain('</w:document>');
    expect(documentXml).toContain('<w:sectPr>');
  });

  it('emits a single paragraph with text content', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hello world')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:p>');
    expect(documentXml).toContain('<w:t xml:space="preserve">hello world</w:t>');
  });

  it('escapes XML special chars in text', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('A & B < C > D')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('A &amp; B &lt; C &gt; D');
    expect(documentXml).not.toContain('A & B');
  });
});

describe('exporter — paragraph styles', () => {
  it('emits Heading1 pStyle for pocket', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it('emits Heading2 pStyle for hat', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Hat')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it('emits Heading3 pStyle for block', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:pStyle w:val="Heading3"/>');
  });

  it('emits Heading4 pStyle for tag (inside card)', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      ]),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:pStyle w:val="Heading4"/>');
  });

  it('emits Analytic pStyle for analytic inside analytic_unit', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['analytic_unit']!.create(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('Analytic')),
      ]),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:pStyle w:val="Analytic"/>');
  });

  it('emits Undertag pStyle for undertag', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['undertag']!.create(null, schema.text('Undertag')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:pStyle w:val="Undertag"/>');
  });

  it('emits no pStyle for paragraph (implicit Normal)', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('Body')),
    ]);
    const { documentXml } = exportDoc(doc);
    // Must not have a pStyle for Normal; should be a bare <w:p>...</w:p>
    expect(documentXml).not.toContain('<w:pStyle');
  });

  it('emits no pStyle for cite_paragraph (cite is run-styled, not paragraph-styled)', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['cite_paragraph']!.create(null, schema.text('Author 2024')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).not.toContain('<w:pStyle');
  });

  it('emits no pStyle for card_body', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
        schema.nodes['card_body']!.create(null, schema.text('Body')),
      ]),
    ]);
    const { documentXml } = exportDoc(doc);
    // The tag will have a pStyle, but the card_body should not.
    const headingMatches = (documentXml.match(/<w:pStyle/g) ?? []).length;
    expect(headingMatches).toBe(1);
  });
});

describe('exporter — heading bookmarks', () => {
  it('wraps headings in pmd-heading-<uuid> bookmarks', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id }, schema.text('Pocket')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:bookmarkStart w:id="0" w:name="pmd-heading-11111111-2222-3333-4444-555555555555"/>');
    expect(documentXml).toContain('<w:bookmarkEnd w:id="0"/>');
  });

  it('uses unique bookmark ids per heading', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('First')),
      schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Second')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).toContain('w:id="0"');
    expect(documentXml).toContain('w:id="1"');
  });

  it('does not emit bookmarks on non-heading paragraphs', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('Body text')),
    ]);
    const { documentXml } = exportDoc(doc);
    expect(documentXml).not.toContain('<w:bookmark');
  });
});

describe('exporter — marks → rPr', () => {
  function emitInline(marks: ReturnType<typeof schema.text>['marks'], text = 'foo'): string {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text(text, marks)),
    ]);
    return exportDoc(doc).documentXml;
  }

  it('emits rStyle for cite_mark', () => {
    const xml = emitInline([schema.marks['cite_mark']!.create()]);
    expect(xml).toContain('<w:rStyle w:val="Style13ptBold"/>');
  });

  it('emits rStyle + dual underline for underline_mark', () => {
    const xml = emitInline([schema.marks['underline_mark']!.create()]);
    expect(xml).toContain('<w:rStyle w:val="StyleUnderline"/>');
    expect(xml).toContain('<w:u w:val="single"/>');
  });

  it('emits rStyle for emphasis_mark', () => {
    const xml = emitInline([schema.marks['emphasis_mark']!.create()]);
    expect(xml).toContain('<w:rStyle w:val="Emphasis"/>');
  });

  it('emits rStyle + italic for undertag_mark', () => {
    const xml = emitInline([schema.marks['undertag_mark']!.create()]);
    expect(xml).toContain('<w:rStyle w:val="UndertagChar"/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:iCs/>');
  });

  it('emits rStyle for analytic_mark', () => {
    const xml = emitInline([schema.marks['analytic_mark']!.create()]);
    expect(xml).toContain('<w:rStyle w:val="AnalyticChar"/>');
  });

  it('emits <w:b/> for bold', () => {
    const xml = emitInline([schema.marks['bold']!.create()]);
    expect(xml).toContain('<w:b/>');
  });

  it('emits <w:b w:val="0"/> for bold_off', () => {
    const xml = emitInline([schema.marks['bold_off']!.create()]);
    expect(xml).toContain('<w:b w:val="0"/>');
    expect(xml).not.toContain('<w:b/>');
  });

  it('round-trips an un-bolded word inside a tag', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, [
          schema.text('Bold '),
          schema.text('plain', [schema.marks['bold_off']!.create()]),
        ]),
      ]),
    ]);
    const bytes = await toDocx(doc);
    const back = await fromDocx(bytes);
    // Find the tag's runs and confirm the "plain" run kept its bold_off.
    let plainMarks: string[] | null = null;
    back.descendants((n) => {
      if (n.isText && n.text === 'plain') plainMarks = n.marks.map((m) => m.type.name);
    });
    expect(plainMarks).not.toBeNull();
    expect(plainMarks!).toContain('bold_off');
  });

  it('emits <w:strike/> for strikethrough', () => {
    const xml = emitInline([schema.marks['strikethrough']!.create()]);
    expect(xml).toContain('<w:strike/>');
  });

  it('emits <w:i/><w:iCs/> for italic', () => {
    const xml = emitInline([schema.marks['italic']!.create()]);
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:iCs/>');
  });

  it('emits highlight color', () => {
    const xml = emitInline([schema.marks['highlight']!.create({ color: 'yellow' })]);
    expect(xml).toContain('<w:highlight w:val="yellow"/>');
  });

  it('emits font color (the #555555 reference sentinel)', () => {
    const xml = emitInline([schema.marks['font_color']!.create({ color: '555555' })]);
    expect(xml).toContain('<w:color w:val="555555"/>');
  });

  it('emits font size in half-points', () => {
    const xml = emitInline([schema.marks['font_size']!.create({ halfPoints: 26 })]);
    expect(xml).toContain('<w:sz w:val="26"/>');
    expect(xml).toContain('<w:szCs w:val="26"/>');
  });

  it('emits pilcrow_marker as a 6-pt size (matches Verbatim\'s encoding)', () => {
    const xml = emitInline([schema.marks['pilcrow_marker']!.create()], '¶');
    expect(xml).toContain('<w:sz w:val="12"/>');
    expect(xml).toContain('<w:szCs w:val="12"/>');
    expect(xml).toContain('¶');
  });

  it('emits shading (the protected-highlight #D2D2D2 sentinel)', () => {
    const xml = emitInline([schema.marks['shading']!.create({ color: 'D2D2D2' })]);
    expect(xml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="D2D2D2"/>');
  });

  it('emits font_family as <w:rFonts> across ascii / hAnsi / cs', () => {
    const xml = emitInline([schema.marks['font_family']!.create({ name: 'Arial' })]);
    expect(xml).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
  });

  it('emits font_family with multi-word fonts (e.g. "Times New Roman")', () => {
    const xml = emitInline([schema.marks['font_family']!.create({ name: 'Times New Roman' })]);
    expect(xml).toContain('<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>');
  });

  it('combines multiple marks correctly', () => {
    const xml = emitInline([
      schema.marks['underline_mark']!.create(),
      schema.marks['highlight']!.create({ color: 'yellow' }),
      schema.marks['bold']!.create(),
    ]);
    expect(xml).toContain('<w:rStyle w:val="StyleUnderline"/>');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('<w:highlight w:val="yellow"/>');
  });
});

describe('exporter — hyperlinks', () => {
  it('wraps a linked run in <w:hyperlink> and registers a relationship', () => {
    const url = 'https://example.com/article';
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('plain '),
        schema.text('linked', [schema.marks['link']!.create({ href: url })]),
        schema.text(' more'),
      ]),
    ]);
    const { documentXml, relsXml } = exportDoc(doc);
    expect(documentXml).toContain('<w:hyperlink');
    expect(documentXml).toMatch(/<w:hyperlink r:id="rId\d+" w:history="1"><w:r>[^]*?<w:t xml:space="preserve">linked<\/w:t><\/w:r><\/w:hyperlink>/);
    expect(relsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"');
    expect(relsXml).toContain(`Target="${url}"`);
    expect(relsXml).toContain('TargetMode="External"');
  });

  it('reuses rIds for repeated URLs', () => {
    const url = 'https://example.com';
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('a', [schema.marks['link']!.create({ href: url })]),
      ]),
      schema.nodes['paragraph']!.create(null, [
        schema.text('b', [schema.marks['link']!.create({ href: url })]),
      ]),
    ]);
    const { relsXml } = exportDoc(doc);
    const matches = relsXml.match(/Target="https:\/\/example\.com"/g);
    expect(matches).toHaveLength(1);
  });

  it('escapes ampersands in hyperlink Target so the rels XML stays well-formed', async () => {
    // Real-world URL shape (query string with multiple `&`-separated
    // parameters) that broke Word's "is this doc valid" check: raw
    // `&` in an XML attribute is malformed, Word recovers but flags
    // the doc as corrupted on open. URL taken from a debate-corpus
    // doc that reproduced the bug in production.
    const url = 'http://example.com/home.aspx?sid=56&categoryid=56&newsid=11568';
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('q', [schema.marks['link']!.create({ href: url })]),
      ]),
    ]);
    const { relsXml } = exportDoc(doc);
    // Confirm the raw `&` did NOT survive into the attribute.
    expect(relsXml).toMatch(/Target="http:\/\/example\.com\/home\.aspx\?sid=56&amp;categoryid=56&amp;newsid=11568"/);
    expect(relsXml).not.toContain('?sid=56&categoryid=');
    // And the relsXml as a whole is well-formed XML (parses without
    // entity-ref errors).
    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({ ignoreAttributes: false });
    expect(() => parser.parse(relsXml)).not.toThrow();
  });
});

describe('exporter — full docx', () => {
  it('produces a complete .docx with minimal structure', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket')),
      schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Hat')),
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Author 2024, Source')),
        schema.nodes['card_body']!.create(null, [
          schema.text('regular '),
          schema.text('underlined', [schema.marks['underline_mark']!.create()]),
          schema.text(' '),
          schema.text('highlighted', [
            schema.marks['underline_mark']!.create(),
            schema.marks['highlight']!.create({ color: 'yellow' }),
          ]),
          schema.text(' end.'),
        ]),
      ]),
    ]);
    const bytes = await toDocx(doc);
    expect(bytes.length).toBeGreaterThan(1000);

    // Reload it and check that all the parts are there.
    const reloaded = await Docx.load(bytes);
    expect(await reloaded.readText('word/document.xml')).toBeDefined();
    expect(await reloaded.readText('word/styles.xml')).toBeDefined();
    expect(await reloaded.readText('[Content_Types].xml')).toBeDefined();
    expect(await reloaded.readText('_rels/.rels')).toBeDefined();
    expect(await reloaded.readText('word/_rels/document.xml.rels')).toBeDefined();

    const docContent = await reloaded.readText('word/document.xml');
    expect(docContent).toContain('Tag');
    expect(docContent).toContain('underlined');
  });

  it('writes literal docDefaults fonts with NO latin theme attributes (preview-font regression)', async () => {
    // The latin theme attrs must stay OUT of docDefaults: OOXML gives
    // w:asciiTheme precedence over w:ascii, and the theme-aware
    // LibreOffice on preview farms (Slack/Gmail) resolves the theme
    // ref, finds no theme part in our package, and falls back to
    // Liberation Serif — never reading the literal. Re-adding them
    // re-breaks every preview. The eastAsia/cs theme refs stay so CJK
    // and complex scripts keep engine-appropriate defaults. Verbatim
    // per-machine fonts are unaffected either way (style-level
    // definitions outrank docDefaults).
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hi')),
    ]);
    // Default: Calibri, the ecosystem baseline (Debate.dotm's Normal).
    const plain = (await (await Docx.load(await toDocx(doc))).readText('word/styles.xml'))!;
    expect(plain).toContain(
      '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsiaTheme="minorEastAsia" w:cstheme="minorBidi"/>',
    );
    expect(plain).not.toContain('w:asciiTheme');
    expect(plain).not.toContain('w:hAnsiTheme');
    // The editor passes the user's display font; XML-escaped.
    const custom = (
      await (
        await Docx.load(await toDocx(doc, { defaultFont: 'Iowan & Old Style' }))
      ).readText('word/styles.xml')
    )!;
    expect(custom).toContain(
      '<w:rFonts w:ascii="Iowan &amp; Old Style" w:hAnsi="Iowan &amp; Old Style" w:eastAsiaTheme="minorEastAsia"',
    );
  });

  it('declares compatibilityMode 15 after the attached template (no Compatibility Mode banner)', async () => {
    // A docx with no declared compatibilityMode opens as Word-2007-era:
    // "[Compatibility Mode]" in the title bar, modern margin comments
    // disabled, and a Convert prompt whose re-save reflows the doc. The
    // ORDER also matters: CT_Settings is a schema-ordered sequence and
    // w:compat must follow w:attachedTemplate, or Word rejects the whole
    // package — the same failure class as the commentsExtended content
    // type below.
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hi')),
    ]);
    const bytes = await toDocx(doc);
    const settings = (await (await Docx.load(bytes)).readText('word/settings.xml'))!;
    expect(settings).toContain(
      '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>',
    );
    const templateAt = settings.indexOf('<w:attachedTemplate');
    const compatAt = settings.indexOf('<w:compat>');
    expect(templateAt).toBeGreaterThan(-1);
    expect(compatAt).toBeGreaterThan(templateAt);
    // The Verbatim-recognition payload rides in the SAME part — the
    // compat addition must not disturb it.
    const rels = await (await Docx.load(bytes)).readText('word/_rels/settings.xml.rels');
    expect(rels).toContain('Debate.dotm');
  });

  it('declares the comments parts with the exact SDK content types (Word repair regression)', async () => {
    // Word validates each part's declared content type against its
    // relationship; ANY mismatch fails the whole package with the
    // "unreadable content" repair prompt even though every part parses.
    // Field report 2026-07-23 (mac Word): every file saved with a
    // comment triggered repair-on-open because commentsExtended.xml was
    // declared as the invented "application/vnd.ms-word." type. Pin
    // both strings to the constants in the Open XML SDK
    // (WordprocessingCommentsPart / WordprocessingCommentsExPart).
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
        schema.nodes['card_body']!.create(null, [
          schema.text('commented', [
            schema.marks['comment_range']!.create({ threadId: '1' }),
          ]),
        ]),
      ]),
    ]);
    const threads = [
      {
        id: '1',
        comments: [
          {
            id: '1',
            author: 'A',
            initials: 'A',
            date: '2026-07-23T00:00:00Z',
            text: 'note',
            kind: 'human' as const,
            parentId: null,
          },
        ],
      },
    ];
    const bytes = await toDocx(doc, { threads });
    const reloaded = await Docx.load(bytes);
    const contentTypes = await reloaded.readText('[Content_Types].xml');
    expect(contentTypes).toContain(
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
    );
    expect(contentTypes).toContain(
      '<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>',
    );
    expect(contentTypes).not.toContain('vnd.ms-word.commentsExtended');
    // The wiring the content types describe: both parts present, both
    // relationships declared.
    expect(await reloaded.readText('word/comments.xml')).toContain('note');
    expect(await reloaded.readText('word/commentsExtended.xml')).toContain('commentEx');
    const rels = await reloaded.readText('word/_rels/document.xml.rels');
    expect(rels).toContain('relationships/comments"');
    expect(rels).toContain('office/2011/relationships/commentsExtended');
  });

  it('round-trips a resolved thread through w15:done', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
        schema.nodes['card_body']!.create(null, [
          schema.text('handled', [schema.marks['comment_range']!.create({ threadId: '1' })]),
          schema.text(' open', [schema.marks['comment_range']!.create({ threadId: '5' })]),
        ]),
      ]),
    ]);
    const mk = (id: string, text: string, resolved?: boolean) => ({
      id,
      comments: [
        {
          id,
          author: 'A',
          initials: 'A',
          date: '2026-08-05T00:00:00Z',
          text,
          kind: 'human' as const,
          parentId: null,
          ...(resolved ? { resolved: true } : {}),
        },
        {
          id: `${id}9`,
          author: 'B',
          initials: 'B',
          date: '2026-08-05T01:00:00Z',
          text: 'a reply',
          kind: 'human' as const,
          parentId: id,
        },
      ],
    });
    const bytes = await toDocx(doc, { threads: [mk('1', 'fixed it', true), mk('5', 'todo')] });
    const reloaded = await Docx.load(bytes);
    const ext = (await reloaded.readText('word/commentsExtended.xml'))!;
    // Resolved thread: done=1 on BOTH its comments (what Word writes);
    // open thread: done=0 throughout.
    expect((ext.match(/w15:done="1"/g) ?? []).length).toBe(2);
    expect((ext.match(/w15:done="0"/g) ?? []).length).toBe(2);

    // And back in: the importer maps done → resolved on the root only.
    const { importComments } = await import('../../src/import/comments.js');
    const threads = importComments(await reloaded.readText('word/comments.xml'), ext);
    const byId = new Map(threads.map((t) => [t.id, t]));
    expect(byId.get('1')?.comments[0]?.resolved).toBe(true);
    expect(byId.get('1')?.comments[1]?.resolved).toBeUndefined();
    expect(byId.get('5')?.comments[0]?.resolved).toBeUndefined();
  });
});

describe('image alt text round-trip', () => {
  // A 1x1 transparent PNG, base64-encoded — small enough that the
  // test stays fast but real bytes so the exporter's media-part
  // pipeline runs end-to-end.
  const ONE_BY_ONE_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  it('preserves image.attrs.alt through export → re-import', async () => {
    const alt = 'A chart showing exports rising 12% year over year.';
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.nodes['image']!.create({
          data: ONE_BY_ONE_PNG_B64,
          contentType: 'image/png',
          widthEmu: 914400,
          heightEmu: 914400,
          alt,
        }),
      ]),
    ]);
    const bytes = await toDocx(doc);
    const reimported = await fromDocx(bytes);

    let foundAlt: string | null = null;
    reimported.descendants((node) => {
      if (node.type.name === 'image') {
        foundAlt = String(node.attrs['alt'] ?? '');
        return false;
      }
      return true;
    });
    expect(foundAlt).toBe(alt);
  });

  it('emits wp:docPr@descr and pic:cNvPr@descr for the image alt', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.nodes['image']!.create({
          data: ONE_BY_ONE_PNG_B64,
          contentType: 'image/png',
          widthEmu: 914400,
          heightEmu: 914400,
          alt: 'Test alt',
        }),
      ]),
    ]);
    const bytes = await toDocx(doc);
    const reloaded = await Docx.load(bytes);
    const docXml = await reloaded.readText('word/document.xml');
    expect(docXml).toContain('descr="Test alt"');
  });
});

describe('reading marker ↔ Word', () => {
  const body = (...inline: ReturnType<typeof schema.text>[]) =>
    schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
        schema.nodes['card_body']!.create(null, inline),
      ]),
    ]);
  const markerRuns = (doc: ReturnType<typeof body>): string[] => {
    const out: string[] = [];
    doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'font_color' && m.attrs['role'] === 'marker')) out.push(n.text ?? '');
      return true;
    });
    return out;
  };

  it('a marker goes out as a plain red run (Word has no role) and comes back as a marker', async () => {
    const doc = body(
      schema.text('read to '),
      schema.text('Marked 7:32', [schema.marks['font_color']!.create({ color: 'FF0000', role: 'marker' })]),
      schema.text(' unread '),
      schema.text('verbatim red', [schema.marks['font_color']!.create({ color: 'FF0000' })]),
    );
    const bytes = await toDocx(doc);
    const xml = await (await Docx.load(bytes)).readText('word/document.xml');
    expect(xml).not.toContain('role');
    const back = await fromDocx(bytes);
    expect(markerRuns(back)).toEqual(['Marked 7:32']);
    expect(back.textContent).toContain('verbatim red');
  });
});

