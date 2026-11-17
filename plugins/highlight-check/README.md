# Highlight Check

A first-party CardMirror plugin. It flags highlighting that changes what a
card says. "Read" here means what the reader says out loud: highlighted
text that isn't shaded, the same rule as the read-aloud word count.

## Install

In CardMirror, open Settings → Plugins, enter
`Jaydewg/cardmirror-plugin-highlight-check` and choose **Install**.
Updates come from that repo's releases.

## Source

The plugin is developed in
[Jaydewg/cardmirror](https://github.com/Jaydewg/cardmirror) under
`plugins/highlight-check/`. The `cardmirror-plugin-highlight-check` repo
mirrors that folder and hosts the releases. Building and testing need the
full CardMirror repo, because the plugin's types come from its
`src/plugin-sdk/`. Send issues and changes there.

## What it does

Run **Highlight Check: Check highlighting**. Problems get squiggles in the
card text and are listed in a side panel. Each row shows its sentence with
the read text in bold and the problem words underlined. Click a row to jump
to the card. Hover a squiggle to read the note, or right-click it to
**Ignore here** or **Show in Highlight Check**.

Checking is on demand: use the command or the panel's **Re-check** button.
When the document changes after a check, the panel says so. Turn on
**Re-check as I edit** in the plugin's settings to keep it current.

**Red: the read text may say the opposite of the card**

- A dropped negation: "The plan does ~~not~~ solve warming". Words ending in
  "n't" count too. A negation is only flagged when something after it in the
  same clause is read, so "caused by humans, ~~not the sun~~" is fine.
- Half a word: **does**n't, **can**not, un**likely**, **hope**less,
  non-**violent**.
- A dropped attribution: "~~Critics claim~~ the plan causes war", "~~it is a
  myth that~~ sanctions work".
- A dropped condition: "~~Unless funding increases,~~ the program collapses".
- Numbers: part of a number (**1**5%), a dropped unit (15~~%~~, 3
  ~~billion~~), or a dropped limit (~~less than~~ 10%).

**Amber: the read text may claim more than, or something other than, the card**

- A dropped qualifier: "Sanctions ~~rarely~~ work", ~~seldom~~, ~~few~~,
  ~~some~~, ~~in some cases~~ …
- Dated wording: "Russia ~~used to~~ dominate the region".
- A concession read without the point: "While **the plan is popular**,
  ~~it fails to solve~~".
- Part of a question read as a claim.
- The middles of two sentences read as one claim.
- "The idea that …", "proponents" … dropped, so check that the read text is
  the author's own view.

**Notes (blue)**: brackets or ellipses inside read text (on). Also
available, off by default: dropped hedges (may, might, could …), long skips,
letters picked from inside words ("the**rapist**"), and a tag that says
"will" when the read text says "may". Notes always show in the panel. They
are underlined only when **Also underline notes** is on.

Phrases like "not only", "no doubt" and "whether or not" are never flagged.
The negation, qualifier, hedge and exception lists are editable in the
plugin's settings, and each other rule can be switched off. Ignored findings
are saved inside the .cmir, so they travel with the file.

## Permissions

| Permission | Why |
| --- | --- |
| `doc.read` | Read the cards and which words are highlighted (`PluginCard.bodyRead`). |
| `doc.annotate` | Squiggle the problems, like spellcheck. |
| `ui.panel` | List every finding in one place. |
| `doc.events` | Re-check as you edit (only when that's on), and note when a checked document changed. |
| `files.data` | Save ignored findings inside the file. |

It needs a CardMirror whose `doc.read` reports `bodyRead`. On older builds
the panel says it needs a newer CardMirror, and nothing is marked.

## Build, test, dev-load

```sh
npm run build      # dist/plugin.js + cardmirror-plugin.json beside it
npm test           # vitest, tests/
npm run typecheck
```

These use the CardMirror repo's installed tools, so run `npm ci` at the repo
root first. To try it, open Settings → Plugins → **Load plugin from file…**,
pick `dist/plugin.js`, and allow the permissions.

## Layout

- `src/analyze.ts`: the rules. Pure functions over a card's text and read
  ranges, with no DOM and no api.
- `src/words.ts`: the word lists.
- `src/panel.ts`: the side panel (plain DOM, theme colors).
- `src/plugin.ts`: commands, settings, marks, ignores, live refresh.
