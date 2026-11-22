# PDF Export & Import

Export CardMirror documents to PDF with their highlighting, and import PDFs back as cards.

The plugin works together with **CardMirror PDF**, a small companion app (in [`companion/`](companion/)). The plugin reads the document and asks the companion to do the work. The companion opens file dialogs, prints the PDF, and reads PDFs back into CardMirror. The plugin uses only the plugin API: `doc.read`, `ui.dialogs` and `flowPost`.

## Using it

1. Start CardMirror PDF and keep its small window open.
2. In CardMirror, run **Export to PDF** or **Import PDF** from the command palette, or bind them to ribbon buttons.

**Export to PDF** asks where to save. The PDF looks like a Verbatim document:

| Part | Size |
| --- | --- |
| Pockets | 26pt |
| Hats | 22pt |
| Blocks | 16pt |
| Tags and analytics | 13pt bold |
| Cites | 13pt bold |
| Card text | 11pt |

Highlights keep their colors. Shading, underlining, emphasis, bold and italic carry over too. The text in the PDF is real text that you can select.

**Import PDF** first asks where the content goes:

- **New document.** The companion saves a `.cmir` next to the PDF. It asks for the name first. Then it opens the file in CardMirror.
- **Into the open document.** The cards are added at the cursor. If that document already has content, the dialog lists *New document* first.

The first import into an open document shows CardMirror's prompt for apps that send content. Choose **Always Allow** so you aren't asked again.

### Settings

- **Hybrid PDF** (off by default) embeds the document inside every exported PDF, so importing that PDF later is exact. Anyone who has the PDF can extract the document from it.
- **Page size** is Letter or A4.

## How import reads a PDF

- **A Hybrid PDF** carries the document itself, so import uses that.
- **Any other PDF** is rebuilt from what's on the page:
  - A colored box behind text becomes a highlight. Word's 15 highlight colors are recognized, and any other color becomes shading.
  - A thin line under text becomes an underline. Underlined bold text in a card becomes emphasis.
  - Lines become paragraphs where there's extra space, where the previous line ends short, or where heading text changes to plain text.
  - Each paragraph's role comes from its size and boldness, at the sizes in the table above. A bold heading followed by a cite or card text becomes a tag. Otherwise it becomes an analytic.

  PDFs exported by this plugin come back the same way they went out. PDFs from Verbatim through Word usually import well. Other layouts, such as two columns or headers and footers, may need cleanup.

## Limits

- **Paragraphs outside cards are left out of exports.** `doc.read` doesn't report them. That includes text above the first tag that isn't a pocket, hat or block.
- **Undertags move.** Within a card, they come back right after the tag.
- **Scanned PDFs (images of text) need OCR first.**
- **Very large documents can't be added to an open document.** CardMirror accepts up to 2 MB of HTML per insert, so import those as a new document.
- **Opening the new `.cmir`:**
  - On Linux, the companion launches CardMirror's own command again with the file, and CardMirror opens it in the running window.
  - On macOS and Windows, it asks the system to open the file, which needs the `.cmir` file association that the CardMirror installer sets up.
  - If opening fails, the message names the saved file so you can open it yourself.
- **Desktop app only.** Plugins don't load in the web version.

## Hybrid PDF format

A Hybrid PDF is an ordinary PDF with one embedded file, `cardmirror-doc.json`:

```json
{
  "format": "cardmirror-hybrid-pdf",
  "version": 1,
  "title": "1AC",
  "doc": { "outline": [], "cards": [] }
}
```

`doc` is the plugin API's `doc.read` snapshot, taken with `{ formatting: true }`. Its session-only `docUid` is blanked. Readers must ignore fields they don't know. A reader that meets a higher `version` falls back to reading the page. The format only grows: fields are added, never repurposed.

## Development

The plugin and the companion are separate packages.

```sh
# The plugin (tools come from the repo's root node_modules)
npm test && npm run typecheck && npm run build    # → dist/plugin.js

# The companion (its own dependencies: pdfjs-dist, pdf-lib)
cd companion
npm install
npm test && npm run typecheck
npm start    # builds dist/main.js, runs it with apps/desktop's Electron
```

- The companion talks to CardMirror over the cardmirror-bridge handshake (PLUGINS.md sections 4 and 5).
  - Its bridge id is `cardmirror-pdf`.
  - `CARDMIRROR_BRIDGE_DIR` points both apps at another bridge folder, for testing.
- The plugin ↔ companion protocol is in [`src/protocol.ts`](src/protocol.ts).
  - `/export` and `/import` start a job and answer right away, and the plugin polls `/status`. `flowPost` times out after 3 seconds, which a file dialog would always exceed.
- The companion bundles CardMirror's own schema, its import back end (`assembleDoc`) and its `.cmir` writer. What it builds is therefore exactly what CardMirror would build.
- `npm run check:plugins` at the repo root covers the plugin, not the companion.
