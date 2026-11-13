# Cardmirror Plugins

The new reference page for Cardmirror Plugins. (It's moved here because reference-docs is gitignored.) The published contract for CardMirror plugins and for flowing apps.
The sources of truth are `src/editor/plugin-api.ts`,
`src/editor/plugin-registry.ts`, `apps/desktop/src/plugin-manager.ts`,
`apps/desktop/src/bridge-handshake.ts`, and
`apps/desktop/src/fast-paste-bridge.ts`.

Stability: **sections 4 and 5 (the cardmirror-bridge handshake and the
HTTP routes) are FROZEN** — flowing apps ship against them, and changes
must stay backward compatible. **Sections 1 to 3 and 6 (the renderer
plugin API) are a DRAFT**: v1 plugins are full-trust code (see the
install model below), and a future sandboxed v2 may change this surface
— write plugins against it with that expectation.

Audience: plugin authors and authors of flowing apps. Sections 1 to 3
and 6 cover renderer plugins. Sections 4 and 5 cover cross-app
integration over HTTP.

## 1. Plugin packaging

A plugin is one GitHub repository. Each release attaches two assets:

- `cardmirror-plugin.json` - the manifest.
- `plugin.js` - the built bundle. Only the released bundle loads. The
  repo source format does not matter.

### Manifest fields

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | string | yes | Lowercase. Must match `^[a-z0-9][a-z0-9-]*$`. Cannot be a Windows reserved device name (`con`, `prn`, `aux`, `nul`, `comN`, `lptN`). |
| `name` | string | yes | Display name. |
| `version` | string | yes | Semver, for example `0.1.0` or `0.2.0-beta.1`. |
| `permissions` | list | No | A list of permissions that the plugin asks for on startup.
| `description` | string | no | One line for the Plugins tab. Also shown on your plugin's card in the Browse-plugins picker when it is listed in the public directory. |
| `author` | string | no | Shown in the consent prompt. |
| `apiVersion` | number | yes | Must be `1`. |
| `minAppVersion` | string | no | Oldest CardMirror version that the plugin supports. Compared as plain semver — read the note below before setting it. |
| `repo` | string | never in your release | The installer stamps `owner/repo` into the saved manifest. Update checks read it. Do not set it yourself. |
| `grantedPermissions` | list | never | The permissions that the client grants.

Example 1 (permissions-less):

```json
{
  "id": "cardmirror-ebb",
  "name": "ebb Flow Integration",
  "version": "0.1.0",
  "description": "Send to flow, send extension, and inverse search for ebb.",
  "author": "smodi",
  "apiVersion": 1,
  "minAppVersion": "0.1.0-beta.18"
}
```

Example 2 (with permissions):
```json
{
  "id": "live-session-link",
  "name": "Live Session Link",
  "version": "0.1.0",
  "description": "…",
  "author": "CardMirror",
  "apiVersion": 1,
  "permissions": ["collab.join", "collab.probe", "collab.read", "collab.server", "collab.shareCode", "files.data", "ui.dialogs", "ui.notices"]
}
```

> **About `minAppVersion`:** Use this only for breaking changes to the *core* API (the members every plugin gets without a permission), and only when that change exists in every CardMirror build you target. If the feature you need sits behind a permission, do **not** set or raise `minAppVersion`. Declare the permission and feature-detect at run time (`api.ui?.choose(...)`, `api.permissions?.status(p)`). A build that doesn't know a permission (upstream included) reports it as unknown and leaves the namespace off; it doesn't fail.
>
> Version numbers aren't comparable across builds, which is why permissions are the safer gate:
>
> - **Fork vs upstream.** Fork patch numbers count days since the minor's anchor month, so fork `1.17.32` outranks every upstream `1.17.x`. A fork-only minimum also lets in upstream `1.18.0`, which may not have the feature at all.
> - **Federation builds.** `1.17.32-f` is read as a semver prerelease, so it sorts *below* `1.17.32`. A plugin pinned to `1.17.32` is refused on the federated build of the same release.

### The curated allowlist

Plugins run with full access to CardMirror and the user's documents, so
the GitHub installer only accepts repositories on a curated allowlist.
The check runs in the main process — the renderer cannot route around
it. The list itself is served by the CardMirror relay at
`GET /plugin-allowlist` (ungated; response
`{ "schema": 1, "repos": ["owner/repo", ...] }`) and consulted fresh on
each install attempt, so listing a new plugin is a server-side change —
no app release. The last fetched list is cached on disk for offline
installs, and a baked-in floor (`PLUGIN_INSTALL_ALLOWLIST` in
`apps/desktop/src/plugin-manager.ts`) covers a machine that has never
reached the relay. An empty or malformed server response is treated as
a failed fetch (cache/baked fallback), never as "block everything". To
get a plugin listed, contact the CardMirror maintainer.

Self-hosted relays serve the same endpoint (see `relay/README.md`):
the fetch goes to whichever relay the client is configured to use, so
a self-hosting operator curates their own users' allowlist via
`RELAY_PLUGIN_ALLOWLIST` on their relay. Its default matches the app's
baked list, so an unconfigured self-hosted relay changes nothing.

Separately from the allowlist, the relay serves a **public plugin
directory** at `GET /plugin-directory` (since 1.4.0) — the browsable,
maintainer-curated subset of the allowlist that appears in the app's
Browse-plugins picker, each entry carrying the name, `description`,
`author`, and `version` from the repo's latest-release manifest.
Allowlisted-but-unlisted plugins stay installable by `owner/repo`;
the directory only controls what is advertised.

Users who understand the trust model can unlock arbitrary-repo installs
from the developer console with `__plugins('community-on')` (persisted;
`__plugins('community-off')` reverts, `__plugins('status')` reports).
The "Load plugin from file..." developer path below is independent of
the allowlist.

### Install flow

1. The user pastes a GitHub URL or an `owner/repo` shorthand into the
   Plugins settings tab — or (since 1.4.0) picks the plugin from the
   Browse list, which fills the same role. Both continue identically.
2. The main process checks the allowlist, fetches the latest GitHub
   release, and downloads the two assets. Each asset must be 5 MiB or
   less.
3. The app validates the manifest and applies the version gates below.
4. The app checks for an id collision. If a different repository
   already owns the id, install fails and asks the user to uninstall
   the existing plugin first.
5. The app stages the release in memory and asks for consent. The
   dialog shows the manifest's name/version/author AND the actual
   `owner/repo` the release came from (which a manifest cannot spoof).
   Nothing touches disk before consent; declining a reinstall leaves
   the existing installed version untouched.
6. On consent, the app writes both files into `userData/plugins/<id>/`
   with an atomic write (tmp file, then rename).
7. The user enables the plugin in the Plugins tab. Enabled plugins
   load from disk at each launch and work offline.

A developer path exists: "Load plugin from file..." in the Plugins tab
loads a local `plugin.js` without an install.

### Uninstall

Uninstalling removes the install directory, the plugin's enabled flag
and storage bag, the user's key overrides for its commands, AND its
live registration — palette rows, keybinding rows, and hotkeys vanish
immediately. One caveat: bundle code that already executed this
session cannot be unloaded; with its commands deregistered it is inert
and fully gone on the next launch. As a backstop, launch reconciles
stored state against the install directories on disk, so a plugin
folder deleted outside the app also gets its leftovers pruned (a
plugin that merely fails to LOAD is still installed and loses
nothing).

### Version gates

- `apiVersion` must equal `1`. Install rejects any other value.
  Registration rejects it again at load time (section 2).
- If `minAppVersion` is newer than the app version, install fails with
  "This plugin needs CardMirror `<minAppVersion>` or newer."
- Both gates also run at every app launch, not only at install. An
  installed plugin that fails the `minAppVersion` gate does not load
  (the app refuses to serve its bundle) but stays LISTED in the
  Plugins tab, marked "needs CardMirror `<version>` or newer" with its
  toggle disabled — it can still be uninstalled.
- The comparison is plain semver. Anything after a `-` counts as a
  prerelease, so a federation build (`1.17.32-f`) sorts below
  `1.17.32`, and fork and upstream numbers don't line up (see the
  note under the manifest fields).
- At run time, check for features, not the version string: test for
  the namespace or method you need (`api.ui?.…`,
  `api.permissions?.status(p)`) and explain to the user what's
  missing.

## 2. Registration

The bundle self-registers. Call the window global once at load:

```js
window.__registerCardMirrorPlugin?.({ /* PluginDefinition */ });
```

The definition types, verbatim from `src/editor/plugin-registry.ts`:

```ts
export const PLUGIN_API_VERSION = 1;

export interface PluginCommandDef {
  /** Must start with `<pluginId>.` */
  id: string;
  label: string;
  keywords?: readonly string[];
  defaultKey?: string | string[] | null;
  run: (api: CardMirrorPluginApi) => void | Promise<void>;
}

export type PluginSettingValue = boolean | string | number;

export interface PluginSettingDef {
  key: string;
  label: string;
  /** `text` renders a single-line input; `multiline` a full-width
   *  textarea (for list-shaped values — one entry per line by
   *  convention). Both hold a plain string value. */
  type: 'boolean' | 'text' | 'multiline' | 'number' | 'select';
  /** Must match `type`; for `select`, must be one of `options`. */
  default: PluginSettingValue;
  /** Required for `select` (the choices), forbidden otherwise. */
  options?: readonly string[];
  /** Muted helper line rendered under the control. */
  description?: string;
}

export interface PluginDefinition {
  id: string;
  name: string;
  apiVersion: number;
  commands: PluginCommandDef[];
  settings?: PluginSettingDef[];
}
```

Rules:

- `id` must match the manifest `id`.
- Every command `id` must start with `<pluginId>.`, for example
  `cardmirror-ebb.sendToFlow`.
- Command ids must be unique, both inside the definition and across
  all registered plugins.
- Every command needs a non-empty `label` and a `run` function.
- Each registered plugin receives one `CardMirrorPluginApi` object,
  minted for its plugin id. Registered commands appear in the command
  palette and the keymap, and (since 0.1.0-beta.22) users can bind
  them to custom ribbon buttons — uninstalling the plugin unconfigures
  any buttons bound to its commands.

### Declared settings (since 0.1.0-beta.22)

The optional `settings` array declares user-configurable settings.
CardMirror renders the controls: an enabled plugin that declared
settings gets a gear on its row in Settings → Plugins, which opens a
modal with one control per entry (checkbox, text field, multiline
textarea, number field, or dropdown). Changes apply immediately —
there is no save step. The `multiline` type (since 1.4.0) renders a
full-width textarea for list-shaped values — one entry per line by
convention; its value is a plain string, and a plugin adopting it
should set `minAppVersion` to `1.4.0`.

- `key` must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` and be unique within
  the plugin.
- Values persist in the plugin's storage bag under the reserved
  `__settings` key, so they survive restarts and are removed with the
  plugin on uninstall.
- Read values with `api.settings.get(key)` (section 3). A stored value
  that no longer matches the declared type — or, for `select`, is no
  longer among `options` — reads as the declared `default`.
- The gear only appears while the plugin is enabled: a disabled
  plugin's bundle never ran, so its declared settings are unknown to
  the host.

### Failure behavior

Registration never throws and never crashes the app. The registry
rejects a bad definition, writes a console warning, and shows the
toast "Plugin failed to load: `<reason>`". Rejection reasons:

- `apiVersion` is not `1`.
- The plugin id is missing, or a plugin with that id is already
  registered.
- `commands` is not an array.
- A command id lacks the `<pluginId>.` prefix, or is a duplicate.
- A command lacks a `label` or a `run` function.
- A declared setting is off-shape: bad or duplicate `key`, missing
  `label`, unknown `type`, a `default` that doesn't match `type`, a
  `select` without a non-empty `options` list (or whose `default`
  isn't among them), or `options` on a non-`select` type. One bad
  setting rejects the whole registration.

A `run` function that throws, or that returns a rejected promise, does
not crash the app. The registry logs the error and shows a toast with
the plugin name.

## 3. The capability API

Each command's `run` receives one `api` argument. The full surface,
verbatim from `src/editor/plugin-api.ts`:

```ts
export type ExtractedKind =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'undertag'
  | 'cite';

export interface ExtractedItem {
  kind: ExtractedKind;
  text: string;
  /** Opaque provenance token (see plugin-source-token.ts). */
  source: string;
}

export interface ExtractResult {
  ok: true;
  docId: string;
  docTitle: string;
  items: ExtractedItem[];
}

export type ExtractErrorCode = 'no-heading-at-cursor' | 'no-active-doc' | 'empty-selection';
export interface ExtractError {
  ok: false;
  error: ExtractErrorCode;
}

export type JumpResult =
  | { ok: true }
  | { ok: false; error: 'doc-not-open' | 'not-found' | 'bad-request'; docTitle?: string };

export interface FlowAppInfo {
  id: string;
  app: string;
  appVersion: string;
  schema: number;
  kind: 'flow';
  /** A session file exists AND the app answered /ping just now. */
  running: boolean;
}

export type FlowPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: 'no-such-app' | 'app-not-running' | 'timeout' | 'bad-response' | 'unsupported' };

export interface PluginStorage {
  get(key: string): unknown;
  /** `__settings` is reserved for declared-setting values (section 2). */
  set(key: string, value: unknown): void;
}

export interface PluginSettingsApi {
  get(key: string): boolean | string | number | undefined;
  onChanged(cb: (key: string, value: boolean | string | number) => void): () => void;
}

export interface CardMirrorPluginApi {
  readonly appVersion: string;
  extractSelection(): ExtractResult | ExtractError;
  jumpToSource(token: string): Promise<JumpResult>;
  flowApps(): Promise<FlowAppInfo[]>;
  flowPost(appId: string, route: string, body: unknown): Promise<FlowPostResult>;
  docInfo(): { docId: string; docTitle: string } | null;
  showToast(message: string): void;
  storage: PluginStorage;
  settings: PluginSettingsApi;
}
```

### Methods

- `appVersion` - the CardMirror version string, for display and
  logging. Don't parse it to decide what's supported, because fork,
  upstream and federation builds number differently. Feature-detect
  instead.
- `extractSelection()` - synchronous typed extraction from the focused
  document (rules below). If the document has no `docId` yet, the call
  mints and stamps one.
- `jumpToSource(token)` - scroll to and select the source of an
  extracted item. The resolver tries the focused document first, then
  every open window. `doc-not-open` carries `docTitle` so you can tell
  the user which document to open.
- `flowApps()` - every REGISTERED flowing app from the handshake
  directory (section 4), each with a `running` flag from a liveness
  ping. Closed apps are listed with `running: false` — selection UIs
  must not require an app to be running; a send to one fails at
  runtime with `app-not-running`.
- `flowPost(appId, route, body)` - a brokered loopback POST to a
  flowing app. The main process reads the target's handshake files,
  attaches the token header, and applies a timeout. Plugins never see
  tokens or sockets. `unsupported` means the desktop host surface is
  absent. The `ok` field shows transport success only. Read the
  `status` field for the HTTP result.
- `docInfo()` - `docId` and `docTitle` of the focused document, or
  `null` when there is none or the doc has no id yet.
- `showToast(message)` - a transient notification in the app.
- `storage` - per-plugin persistent key-value storage. Values must be
  JSON-serializable. The `__settings` key is reserved (section 2).
- `settings` (since 0.1.0-beta.22) - values of the settings declared in
  the definition. `get(key)` returns the current value (the declared
  default when the user hasn't set it) or `undefined` for undeclared
  keys. `onChanged(cb)` fires when the user changes a value in the
  settings modal and returns an unsubscribe function — most plugins
  can skip it and read lazily in each command's `run`.

### Permissions

Everything beyond the members above is behind a permission. A plugin
lists the permissions it wants in both `cardmirror-plugin.json` and its
registered definition. The user consents at install, and the plugin gets
only the permissions in both lists that the user allowed and this build
supports. Each namespace method exists only with its permission, and the
permission is checked again on every call: a call through an `api` object
kept from before a revoke throws, or for a method returning a promise
rejects, with an error whose `name` is `'PluginPermissionError'`.
Feature-detect with `api.ns?.method` and explain gaps with
`api.permissions?.status(p)`.

<!-- permission-table:start -->
<!-- Generated from src/editor/plugin-permissions.ts and src/editor/plugin-call-rules.ts. Do not edit by hand: run `npm run docs:permissions`. -->

| Permission | Sensitivity | Shown to the user as | Unlocks |
| --- | --- | --- | --- |
| `collab.join` | high | Join co-editing sessions | `collab.join` |
| `collab.probe` | low | Check if a session is still live | `collab.probe` |
| `collab.read` | medium | See your live co-editing sessions | `collab.current`, `collab.roomIdOf`, `collab.localRecord` |
| `collab.server` | low | See which co-editing server you use | `collab.server`, `collab.reach`, `collab.parseAddress` |
| `collab.shareCode` | high | Read your session share codes | `collab.shareCode`, `collab.shareAddress` |
| `collab.viewCode` | medium | Read your sessions’ view-only links | `collab.viewCode`, `collab.viewAddress` |
| `doc.edit` | high | Add content to your documents | `doc.insert` |
| `doc.events` | low | Notice when you edit or switch documents | `events.onDocChange`, `events.onSelectionChange`, `events.onFocusChange` |
| `doc.read` | medium | Read your open documents | `doc.read` |
| `files.data` | medium | Store its own data in your documents | `files.onSave`, `files.onOpen`, `files.get`, `files.focusedDoc` |
| `ui.contextMenu` | low | Add right-click menu items | `menu.add` |
| `ui.dialogs` | low | Show dialogs | `ui.choose`, `ui.confirm` |
| `ui.notices` | low | Post notices in the status bar | `notices.post` |
| `ui.panel` | low | Show a side panel | `panel.get` |

<!-- permission-table:end -->

### Extraction rules

The selection rule:

- An explicit selection wins. Extraction walks only the selected range.
- A collapsed cursor expands to the enclosing heading section: from
  the nearest enclosing heading to the next heading of the same or a
  shallower level.
- A cursor above all headings returns `no-heading-at-cursor`. Core
  does not guess.
- A range that yields no items returns `empty-selection`.
- No focused document returns `no-active-doc`.

The item rules, in document order:

- Pocket, hat, block, tag, and analytic nodes emit their full text.
- Cite paragraphs emit the short cite only, with kind `cite`.
- Undertags always emit, with kind `undertag`. The plugin decides what
  to do with them: skip, treat as header, or treat as extension.
- Card bodies and loose paragraphs never emit. This rule is deliberate
  and has no override.
- Whitespace in each item collapses to single spaces. Empty items are
  dropped.

Heading attribution per item: pocket, hat, block, tag, and analytic
items carry their own heading UUID. An undertag or cite inside a card
carries the UUID of the parent card's tag or analytic. A top-level
undertag carries the UUID of the nearest preceding heading.

### The source token

Each extracted item carries one provenance string in `source`. The
current format starts with the `cmsrc1` prefix. The token is opaque:

- Store it.
- Pass it back verbatim, to `jumpToSource` or to the `/jump` route.
- Never parse it and never build one. Only CardMirror mints and parses
  tokens. A future format change bumps the prefix, and old tokens stay
  valid.

## 4. The cardmirror-bridge handshake

This section and section 5 are the frozen cross-app contract. Flowing
apps build against this file format and these routes. Changes require
a schema bump.

Each debate app announces its local HTTP endpoint in a shared
directory. The directory per platform:

- macOS: `~/Library/Application Support/cardmirror-bridge/`
- Windows: `%APPDATA%/cardmirror-bridge/`
- Linux: `$XDG_DATA_HOME/cardmirror-bridge/` (fallback
  `~/.local/share/cardmirror-bridge/`)

Each app writes TWO files, atomically (write a tmp file, then rename
it into place):

- `<appId>.json` — the IDENTITY file. Written on launch, **never
  deleted**. This is what app pickers list, so a closed app stays
  selectable in a peer's settings.
- `<appId>.session.json` — the SESSION file. Written on launch with a
  fresh token, **deleted on quit**. Its absence means the app isn't
  running right now.

CardMirror writes `cardmirror.json` / `cardmirror.session.json` with
`kind: "editor"`. Flowing apps register with `kind: "flow"`. The file
name (without the suffix) is the app id and must match
`^[a-z0-9][a-z0-9-]*$`.

Identity file, schema 1:

```json
{
  "schema": 1,
  "app": "ebb",
  "appVersion": "0.3.0",
  "kind": "flow"
}
```

Session file:

```json
{
  "port": 17700,
  "token": "hoyfR3k9vXqLmZ2wN8cT1bUj",
  "pid": 12345
}
```

Rules:

- The token is random and rotates each session — which is WHY the
  session data lives in its own deleted-on-quit file: a kept combined
  file would advertise a dead or wrong endpoint.
- Every request between apps carries the target's token in the
  `X-Bridge-Token` header. The receiver must compare it in constant
  time.
- Liveness: a reader sends `GET /ping` with the token before it trusts
  a session file. A stale session from a crashed process fails the
  ping and reads as "registered but not running" — never as absent.
  Sending to a registered app with no live session fails with
  `app-not-running`; a dead connection is a runtime error, not a
  reason to hide the app from selection.
- Before SENDING, check the session file's `pid` is still alive (e.g.
  `kill(pid, 0)`; treat EPERM as alive) and map a dead pid to
  `app-not-running` without touching the port. A dead writer proves
  the file is stale — whatever answers that port now is not the app
  that wrote it. This is cheaper than a ping and catches what a ping
  cannot (any process answers a knock); a crashed-and-relaunched app
  self-heals by writing a fresh session file, and pid recycling merely
  degrades the check to a plain failed send.
- Create the directory `0700` and write both files `0600` where the
  platform supports modes — session tokens must not be readable by
  other users on a shared machine.
- Bind the endpoint to `127.0.0.1` only. Never bind `0.0.0.0`.
- Compatibility: a reader should tolerate a combined single
  `<appId>.json` carrying `port`/`token` (the pre-split shape) by
  treating those fields as the session. Writers must produce the
  two-file form.

## 5. CardMirror's HTTP routes for flowing apps

CardMirror serves these routes on the port in `cardmirror.json`. All
routes require the token, in `X-Bridge-Token` or in the legacy
`X-FDP-Token` header. A request with an `Origin` or `Referer` header
is rejected with 403; those requests come from browser pages.

### Identity and consent (since 0.1.0-beta.23)

Every route EXCEPT `/ping` also requires an **`X-App-Id`** header: a
stable identifier for the sending app matching
`^[a-z0-9][a-z0-9-]{0,63}$` (use your bridge identity-file id, e.g.
`X-App-Id: ebb`). New routes added to this surface inherit this
requirement by default unless explicitly classed as discovery.

The user picks the overall policy in Settings → Plugins → External
apps: **Ask for each app** (the default — everything below describes
this mode), **Allow all** (every sender accepted, identification
optional — the pre-identity behavior, kept so legacy senders like old
Fast Debate Paste builds still work when the user opts into it), or
**Block all**. Clients MUST still send `X-App-Id` — the default mode
rejects requests without it.

The first request from an app raises a consent prompt in CardMirror
naming the app (name + version come from its registered identity file
when present, else the raw id): **Always Allow / Allow Once / Deny**.
Always/Deny are remembered and manageable under Settings → Plugins →
External apps; dismissing records nothing and asks again next time.
One decision covers the whole gated surface — a denied app can
neither insert nor jump. This is consent UX for cooperating local
apps, not a security boundary: identity is self-declared, and any
same-user process is inside the trust line regardless.

While the prompt is open, requests are **queued** (up to 10 per app,
arrival order) and answered with:

```json
{ "ok": true, "inserted": false, "pending": "consent" }
```

(`jumped` instead of `inserted` on `/jump`.) Do not retry — if the
user allows, the queued actions apply immediately, so their click is
the redo; if they deny or dismiss, the queue is discarded. Show
something neutral like "waiting for approval in CardMirror".

Consent-layer errors, all HTTP 200 with `ok: false`:

| Error | Meaning | Client behavior |
| --- | --- | --- |
| `unidentified` | No/invalid `X-App-Id`. CardMirror also tells its own user the sending app needs an update. | Terminal. Ship the header. |
| `inserts-disabled` | The user turned off "Accept inserts from external apps". | Terminal; surface it, don't retry. |
| `not-allowed` | The user denied this app (or its consent queue overflowed). | Terminal; surface it, don't retry. |

Never fall back to alternative delivery (keystroke synthesis etc.) on
these errors — that would bypass a decision the user made on purpose.
Reserve fallbacks for transport-level failures (connection refused,
timeout).

`/ping` stays identity-free — discovery has to work before identity
exists — and deliberately content-free: it must never grow doc
titles, paths, or previews. Anything content-bearing belongs behind
an identified, consented route.

### GET /ping

Liveness and capability probe. Response, schema 2:

```json
{
  "ok": true,
  "app": "cardmirror",
  "appVersion": "0.1.0-beta.18",
  "schema": 2,
  "hasActiveDoc": true
}
```

`schema: 2` signals that `/jump` is available.

### GET /docs (since 0.1.0-beta.23)

Every open document across every CardMirror window and pane — the
address book for doc-targeted inserts. Identified + consented (doc
titles are content; one per-app decision covers docs/insert/jump).

```json
{ "ok": true, "docs": [
  { "target": "u-3f9c…", "title": "1AC — Ports.cmir", "focusedWindow": true, "isSpeech": false },
  { "target": "u-88a1…", "title": null, "focusedWindow": false, "isSpeech": true }
] }
```

`target` is an opaque, SESSION-SCOPED token (it does not survive a
CardMirror restart — re-list rather than persisting it). `title` is
null for never-saved docs. `isSpeech` marks the doc currently
designated as the speech doc (at most one, across all windows) — a
client offering a "send to the speech doc" mode should re-list and
target it at send time rather than caching, since the designation
moves. While consent is pending the response is
`{ "ok": true, "docs": null, "pending": "consent" }` — re-query after
the user decides.

### POST /insert

Insert text into a document. This route predates the plugin API;
since 0.1.0-beta.23 it also requires `X-App-Id` and consent (see
above). The full wire contract is in `cardmirror-integration-spec.md`
in this folder. In short: the body is
`{ "text": "...", "role": "...", "newParagraph": true, "omitted": false }`,
and the response is `{ "ok": true, "inserted": true, "docTitle": "..." }`
or `{ "ok": false, "error": "no-target-doc" | "doc-readonly" | "bad-request" }`
— plus the consent-layer responses above.

**Roles** (since 0.1.0-beta.23; older CardMirrors degrade unknown
roles to `card` silently, so the failure mode against an old build is
wrong FORMAT, not an error):

| `role` | Result |
| --- | --- |
| `card` (default), `body`, `cite` | Body paragraphs at the cursor (the pre-role behavior). |
| `inline` | Bare characters at the cursor (`newParagraph: false` semantics). |
| `pocket` / `hat` / `block` | One doc-level heading per line of `text`, each with a fresh heading id. |
| `tag` | One new card per line, headed by that tag. |
| `analytic` | One new analytic_unit per line, headed by that analytic. |

Heading roles never insert at a raw caret — they snap to the nearest
outline slot a drag-and-drop would use (so a mid-card cursor can't
split the card) — and a heading role outranks `newParagraph`.

**Rich payloads** (since 1.5.0, additive): the body may carry an
optional `"html": "<...>"` field (2 MiB max) alongside `text`. A
rich-aware CardMirror parses it through the document schema in an
inert DOM — only schema-valid content survives, so scripts and
unknown markup are simply dropped — and inserts the result with full
fidelity: CardMirror-native HTML (the app's own serialization format,
which is what a copy from CardMirror produces) round-trips structure,
highlight colors, and cite/underline marks exactly. Whole cards and
headings snap to the nearest valid outline slot like the heading
roles; purely inline content follows `newParagraph`. **`text` remains
required** — it is the fallback rendered by an older CardMirror
(which ignores `html`) and by a rich-aware one when the html parses
to nothing, so always send a faithful plain-text version. When `html`
is used, `role` and `citeTokens` are ignored: the markup carries its
own structure and marks.

**Cite emphasis** (since 1.3.0, additive): a role-`cite` text insert
may include `"citeTokens": ["Smith", "24"]` — verbatim substrings of
the first line styled with the cite mark on arrival. Ignored by older
CardMirrors and when `html` is used.

**Targeting.** Two modes, the caller's choice per request:

- **Doc-targeted** (since 0.1.0-beta.23): include
  `"target": "<token from GET /docs>"` in the body. The text lands in
  that exact document — the right pane of a three-pane window, a
  background window, anywhere — without CardMirror needing or taking
  focus. A closed-since-listed doc answers
  `{ "ok": false, "error": "target-not-found" }`; never a fallback to
  a doc the caller didn't name.
- **Legacy / focus-follow** (no `target`): the focused CardMirror
  window's active pane, else the most recently focused window's (so a
  flow app can send while it holds focus itself). An app steering by
  window (an OS-window target picker) should activate that window
  before calling — focus is the only window-addressing this mode has.
  Never an arbitrary window.

### POST /jump

Inverse search: jump to the source of an extracted item. Requires
`X-App-Id` and consent (see above) — jump steers the user's editor
and steals focus, so a denied app can't do it either. Send the
stored source token, verbatim:

```json
{ "source": "cmsrc1.eyJkb2NJZCI6..." }
```

On success, CardMirror focuses the right window, scrolls to the
source, and selects it:

```json
{ "ok": true }
```

Error responses:

| Error | HTTP status | Meaning | Extra field |
| --- | --- | --- | --- |
| `doc-not-open` | 200 | The token's document is not open in any window. | `docTitle` - show "open `<docTitle>` first". |
| `not-found` | 200 | The document is open, but the heading and the text anchor both failed to resolve. | none |
| `bad-request` | 400 | The body is not JSON, `source` is missing, or the token does not parse. | none |

Example `doc-not-open` response:

```json
{ "ok": false, "error": "doc-not-open", "docTitle": "AT - Cap K" }
```

Any other path returns 404 with `{ "ok": false, "error": "bad-request" }`.

## 6. A minimal example plugin

`plugin.js` - registers one command. The command extracts the
selection and toasts the item count:

```js
// plugin.js - complete example bundle
window.__registerCardMirrorPlugin?.({
  id: 'item-counter',
  name: 'Item Counter',
  apiVersion: 1,
  settings: [
    {
      key: 'tags-only',
      label: 'Count tags only',
      type: 'boolean',
      default: false,
      description: 'Ignore every extracted kind except tags.',
    },
  ],
  commands: [
    {
      id: 'item-counter.countSelection',
      label: 'Count extracted items',
      keywords: ['count', 'extract'],
      defaultKey: null,
      run(api) {
        const result = api.extractSelection();
        if (!result.ok) {
          api.showToast('Extraction failed: ' + result.error);
          return;
        }
        const items = api.settings.get('tags-only')
          ? result.items.filter((i) => i.kind === 'tag')
          : result.items;
        const n = items.length;
        api.showToast(
          'Extracted ' + n + (n === 1 ? ' item from "' : ' items from "') +
            result.docTitle + '"',
        );
      },
    },
  ],
});
```

`cardmirror-plugin.json`:

```json
{
  "id": "item-counter",
  "name": "Item Counter",
  "version": "0.1.0",
  "description": "Count the items that selection extraction returns.",
  "author": "you",
  "apiVersion": 1,
  "minAppVersion": "0.1.0-beta.18"
}
```

To test it, open Settings, then Plugins, then "Load plugin from
file...", and pick `plugin.js`. Run "Count extracted items" from the
command palette.
