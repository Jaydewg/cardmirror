# Live Session Link

A first-party CardMirror plugin. A saved `.cmir` can carry its live
co-editing link, so a file dropped into Slack or an email still leads back
to the session. Whoever opens it can **join** the live session or keep
working on the local copy.

## What it does

- **Embed (opt-in, per session).** Run **Live Session Link: Embed live link
  in this file** while the document is in a live session, and confirm.
  From then on, each save writes the session's edit share code into the file.
  If you turn on **Always embed the link for sessions I host** in the plugin's
  settings, every session you host gets this automatically.
- **Open.** When a file with a link opens, the plugin first checks with your
  relay whether that session still exists. If it does, a notice appears under
  the status-bar ⓘ chip with **Join** and **Don't ask for this file**. There
  are no pop-up dialogs. Dismissing the notice keeps the local copy, and the
  link stays in the file. Join replaces the view with the live copy, and saving
  then writes the live copy back to the same file.
- **Ended sessions.** When the session has ended, the notice just says so, and
  the link is removed the next time you save.
- **Sessions on another server.** When the session is on a co-editing server
  you can't reach from here, the notice names both servers and doesn't offer
  Join. The session isn't treated as ended, and the link stays in the file.
- **Stop.** **Live Session Link: Stop embedding live link** removes the link
  from the file on its next save.
- **Rejoin later.** **Live Session Link: Join live session from this file**
  joins from the focused file at any time, including after you dismissed the
  notice.

## Different servers

The file stores the session's **address**: its share code plus the server it
runs on (`cmshare2.<room>.<key>.<version>@https://relay.example/relay`).
CardMirror builds with and without federation read the address the same way,
whether or not the code carries the federation `f` flag. The plugin
identifies a session by its room *and* its server, so the same room id on two
servers counts as two sessions.

- **Your server:** the plugin checks whether the session is live and offers
  Join.
- **Another server, reachable through federation:** the same, with CardMirror
  routing the request. The notice says which server the session is on, because
  joining from another server waits for the session's host to let you in. If
  the host declines, a message says so and the link stays in the file.
- **Another server, not reachable from this build:** a notice says where the
  session is, with no Join, and the link stays in the file.
- **A CardMirror from before session addresses:** the plugin falls back to the
  plain code. It can't tell which server answered, so it never treats a
  session as ended there.

## Security

The embedded link is a **full edit code**. Anyone who gets a saved copy of the
file can join and edit the session until it ends. That's why embedding is
opt-in and asks before it starts. The question says who that covers: only
people on your server, or, for a session open to other servers, people on
linked servers as well, once the session's host lets them in. Neither the code nor the server appears in
the file's metadata summary (`gzip -l`, `exiftool`); the summary only says
that a link is present.

## Permissions

| Permission | Used for |
| --- | --- |
| `files.data` | Storing the link inside the `.cmir` |
| `collab.read` | Knowing whether a document is in a session |
| `collab.server` | Naming your server when a link points to another one |
| `collab.shareCode` | Reading the session address to embed |
| `collab.probe` | Checking whether a linked session is still live, without joining it (or that its server is out of reach) |
| `collab.join` | Joining from a file |
| `ui.notices` | The status-bar notice with Join |
| `ui.dialogs` | Confirming before the first embed |

Each missing permission disables only its own feature, and the commands tell
you which permission is missing.

## Build and dev-load

This is a standalone package. It imports only the type-only contract
`@cardmirror/plugin-api` (`src/plugin-sdk/` in the CardMirror repo), so the
bundle carries no app code. Run these from this folder:

```sh
npm run build      # dist/plugin.js + cardmirror-plugin.json beside it
npm test           # vitest, tests/ (on the SDK's fake api, @cardmirror/plugin-api/testing)
npm run typecheck
```

To use it, open Settings → Plugins → **Load plugin from file…** in the desktop
app, pick `dist/plugin.js`, and allow the permissions. A dev-loaded grant lasts
until CardMirror restarts.

The plugin needs a CardMirror build with the permission API, `activate` and
session addresses. On older builds the commands still register, and they
explain which features are unsupported. Feature detection runs on permissions,
not version numbers (see PLUGINS.md, "About `minAppVersion`").
