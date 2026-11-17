# Cite Check

A CardMirror plugin that finds problem cites before the round does.
Problems are underlined in the cite, the same way spellcheck marks
words, and listed in a side panel.

## Install

In CardMirror, open Settings → Plugins, enter
`Jaydewg/cardmirror-plugin-cite-check` and choose **Install**. Updates
come from that repo's releases.

## Source

The plugin is developed in
[Jaydewg/cardmirror](https://github.com/Jaydewg/cardmirror) under
`plugins/cite-check/`. The `cardmirror-plugin-cite-check` repo mirrors
that folder and hosts the releases. Building and testing need the full
CardMirror repo, because the plugin's types come from its
`src/plugin-sdk/`. Send issues and changes there.

## As you edit (offline)

Every card's cite is checked each time the document changes:

- **Author quals:**
  - missing quals;
  - vague quals: "Freelance writer", "Expert" or "Commentator", with
    no affiliation or credential;
  - quals that say there are none;
  - student authors (a note);
  - staff or editorial bylines;
  - the same author with very different quals in the same year
    elsewhere in the file.
- **Short cite vs. full cite:**
  - no short cite;
  - no date, or "n.d.";
  - an impossible date or a future date;
  - a year or date that disagrees with the full cite;
  - a short-cite author who isn't named in the full cite.
- **Completeness:** no title, no publication date or only an "accessed"
  date, and no URL or DOI (books are exempt).
- **Source quality:**
  - **Errors:**
    - AI chat share links;
    - satire;
    - study-help sites.
  - **Warnings:**
    - Wikipedia;
    - user-generated sites (Reddit, Quora, X, Facebook, TikTok …);
    - link shorteners;
    - search pages and private documents;
    - local-file links.
  - **Notes:**
    - self-published platforms (Medium, Substack, Blogspot …);
    - press releases;
    - videos.

  No journal, publisher or outlet is called untrustworthy by default.
  Add your own untrusted and trusted domains in the plugin's settings.
- **Across the file:** the same source cited two different ways, and one
  short cite used for two different sources (use 24a / 24b).

## Verify sources (online, only when you ask)

Run **Cite Check: Verify sources online**, the panel's **Verify
sources** button, or right-click a card's tag and choose **Verify this
cite**. Each check below either confirms the cite (shown as a ✓ in the
panel) or reports a problem.

| Check | Problem it can report | Confirmation |
| --- | --- | --- |
| **Crossref**, with a DOI | The DOI doesn't exist, points to a different work, or Crossref dates it more than a year off from the cite. | The DOI matches the cited work. |
| **Crossref**, without a DOI | A title search finds the work under different authors. | The work is found. |
| **OpenAlex** | The author's record lists none of the institutions named in the quals. This reads "Couldn't confirm 'X'. OpenAlex lists: …", never "false". | An institution in the quals matches the author's record. |
| **The cited page** | A dead link (404 or 410). The page's own author or publication year differs from the cite's. | The page's author matches. |

- **OpenAlex details:**
  - Only an exact name match is compared.
  - When several people share the name, a mismatch is only a note.
  - OpenAlex records lag behind real affiliations, and most journalists
    and think-tank authors aren't in it at all, so no record means no
    verdict.
  - OpenAlex needs a free API key beyond a small daily budget. Paste
    one into the settings.
- **Cited page details:**
  - Paywalls and bot walls give no verdict.
  - Turn this check off with **Verify: also open the cited pages**.

Results are cached for the session. A card's online results are dropped
as soon as its cite changes.

## Ignoring

Each mark's right-click menu and each panel row have **Ignore**. Ignored
findings are saved inside the `.cmir`, so they travel with the file.
**Cite Check: Restore ignored findings in this document** brings them
back.

## Permissions

| Permission | Why |
| --- | --- |
| `doc.read` | Read the cites, and jump to a card from the panel. |
| `doc.events` | Re-check as you edit. |
| `doc.annotate` | Underline problem cites. |
| `ui.panel` | The list of problems. |
| `ui.contextMenu` | **Verify this cite** and **Show cite problems** on a tag. |
| `ui.notices` | Say when verification finishes. |
| `files.data` | Keep ignored findings in the file. |
| `net.fetch` | Only for **Verify sources**. Its hosts (`networkHosts`) are `api.crossref.org`, `api.openalex.org` and `*`, because checking a cited page means opening whatever site it is on. It sends titles, author names and links, nothing else. Your email goes to Crossref only if you enter one in the settings. |

Every permission is optional. Without `doc.annotate` the panel still
works. Without `net.fetch`, verification asks for it when you run it.

## Build, test, dev-load

```sh
npm run build      # dist/plugin.js + cardmirror-plugin.json
npm test
npm run typecheck
```

To try it, open Settings → Plugins → **Load plugin from file…** and pick
`dist/plugin.js`. This needs a CardMirror with `doc.annotate`,
`doc.jumpTo` and `net.fetch`.
