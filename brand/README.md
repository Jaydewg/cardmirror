# Brand profiles

Everything users see as the product's name and logo comes from one profile
folder here. The active profile is picked at build time with the `BRAND`
environment variable (default: `cardreflex`).

```
brand/<id>/brand.json      names, shortcut name, lineage line, colours
brand/<id>/mark*.svg       source art (CardReflex: design system concept B)
brand/<id>/generated/      committed icon outputs (CI never renders images)
```

- **Change the logo:** replace `brand/<id>/mark.svg` (and `mark-small.svg`
  for 32 px and below), then run `python3 scripts/gen-brand-assets.py <id>`
  and commit `brand/<id>/generated/`.
- **Switch the active profile:** `BRAND=cardmirror npm run build` (or any
  desktop script). `scripts/apply-brand.mjs` copies the profile's generated
  icons into `apps/desktop/build/` and `public/` and writes
  `src/brand-build.ts` + `apps/desktop/src/brand-build.ts`. The committed
  copies of those files always equal the default profile, so a default
  build leaves the working tree clean.
- **Never rebranded:** `.cmir`, the `cardmirror-doc` format marker, the
  bridge directory and app id, `X-CardMirror-*` relay headers, IPC channels,
  `pmd-*` storage keys, plugin IDs/SDK names, `appId`, the `userData` folder
  (pinned to `CardMirror`), and the PolyForm Required Notice / credits.

**Microsoft Store:** the package is an **MSIX** (`npm run desktop:dist:store`;
electron-builder names its MSIX target `appx`, hence `build.appx` in
`apps/desktop/package.json`). Its identity (`JaydenWang.CardReflex`, Store ID
9PNNWSF2BC1T) is tied to the name reserved in Partner Center, and the
package's display name (`storeDisplayName`) must match a reserved name. Building the Store package
under another profile needs that name reserved for the same product first.

`brand/cardmirror/` is upstream's current identity, kept so a build can switch
back (for example with upstream's blessing) and so upstream merges stay easy.
Its `generated/` folder is a snapshot of the icons as they were before the
rebrand; it has no SVG sources.
