# Plugin template

A minimal, working CardMirror plugin to copy. It has one command that
asks a question through `ui.dialogs`, an `activate` that returns a
cleanup, and tests that run against the SDK's fake api.

## Start a plugin from it

1. Copy this folder to `plugins/<your-id>/` (or into its own repo, with a
   copy of `src/plugin-sdk/` that the two `paths` entries in
   `tsconfig.json` and the alias in `vitest.config.ts` point at).
2. Pick an id: lowercase letters, digits and dashes. Set it, the name and
   the permissions in **both** `cardmirror-plugin.json` and
   `src/plugin.ts`. CardMirror grants only the permissions listed in both
   places, and `tests/plugin.test.ts` checks that they match.
3. Replace the example command. The permission list and what each
   permission unlocks are in PLUGINS.md, section 3, "Permissions".

## Build, test, dev-load

```sh
npm run build      # dist/plugin.js + cardmirror-plugin.json beside it
npm test           # vitest, tests/
npm run typecheck
```

These use the CardMirror repo's installed tools; run `npm ci` at the repo
root first. CI runs all three for every folder under `plugins/`
(`npm run check:plugins` at the root).

To try it, open Settings → Plugins → **Load plugin from file…** in the
desktop app, pick `dist/plugin.js`, and allow the permissions. A
dev-loaded grant lasts until CardMirror restarts.

## Rules

- Import only from `@cardmirror/plugin-api`, and only types. The bundle
  must carry no CardMirror code. Tests may also import the fake api from
  `@cardmirror/plugin-api/testing`.
- Feature-detect every optional namespace (`api.ui?.confirm`). A user can
  revoke a permission at any time, and an older CardMirror doesn't know
  newer permissions. Use `api.permissions?.status(p)` to tell the user
  why something is missing.
- Register hooks in `activate` and return a cleanup. `activate` runs
  again, with a fresh `api`, after every permission change. A call
  through an `api` kept from before a revoke throws (or rejects with) a
  `PluginPermissionError`.
