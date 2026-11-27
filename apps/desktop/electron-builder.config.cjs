/**
 * electron-builder configuration = package.json `build` + the active brand
 * profile (brand/<id>/brand.json, picked by the BRAND env var; default
 * cardreflex — see brand/README.md).
 *
 * Every build script passes `--config electron-builder.config.cjs`, so the
 * product name, shortcut name, document type name and MSIX tile colour all
 * come from the profile instead of being hard-coded. `appId` stays
 * com.cardmirror.app on purpose: it keys NSIS's install registry and the
 * update path, and nobody sees it.
 *
 * Lite (VITE_LITE=1) gets its own appId and the profile's `liteName`, so it
 * still installs side by side with the standard app. CLI `-c.*` flags still
 * layer on top of all of this.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BRAND = 'cardreflex';
const brandId = process.env.BRAND || DEFAULT_BRAND;
const brandFile = path.join(__dirname, '..', '..', 'brand', brandId, 'brand.json');
if (!fs.existsSync(brandFile)) {
  throw new Error(`electron-builder.config.cjs: unknown brand "${brandId}" (${brandFile} missing)`);
}
const brand = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
const base = require('./package.json').build;
const lite = process.env.VITE_LITE === '1';

/** "CardReflex Lite" → "CardReflex-Lite" (artifact file stems). */
const stem = (name) => name.replace(/\s+/g, '-');

const productName = lite ? brand.liteName : brand.productName;

/** @type {import('electron-builder').Configuration} */
const config = {
  ...base,
  productName,
  executableName: lite ? brand.liteName : brand.executableName,
  fileAssociations: base.fileAssociations.map((a) =>
    a.ext === 'cmir' ? { ...a, name: brand.docTypeName } : a,
  ),
  nsis: {
    ...(base.nsis || {}),
    shortcutName: lite ? brand.liteName : brand.shortcutName,
  },
  linux: {
    ...base.linux,
    artifactName: `${brand.id}${lite ? '-lite' : ''}-\${version}.\${ext}`,
    ...(lite ? { executableName: `${brand.id}-lite` } : {}),
  },
  // Microsoft Store package. It is an MSIX: electron-builder just calls its
  // MSIX-capable target `appx` (config key, `--win appx`, and the fixed
  // tile folder build/appx/). `build.appx.artifactName` in package.json
  // gives the output a .msix extension, which makes makeappx write MSIX.
  appx: {
    ...(base.appx || {}),
    displayName: brand.storeDisplayName,
    backgroundColor: brand.tileBackground,
  },
};

// MSIX builds need a current Windows SDK. The default toolset
// (winCodeSign 0.0.0) bundles an old makeappx whose schema predates
// Windows 10 1903, so it rejects the manifest's desktop6 elements
// (FileSystemWriteVirtualization: "unexpected ... content model of
// Properties"). Toolset 1.1.0 uses Windows Kits 10.0.26100 (pinned,
// checksummed download). Scoped to the Store build (`--win appx`, see
// the dist:store script) so the NSIS/GitHub release keeps its proven
// toolset.
if (process.argv.includes('appx')) {
  config.toolsets = { ...(base.toolsets || {}), winCodeSign: '1.1.0' };
}

if (lite) {
  config.appId = 'com.cardmirror.lite';
  config.mac = { ...base.mac, artifactName: `${stem(brand.liteName)}-\${version}-\${arch}.\${ext}` };
  config.win = { ...base.win, artifactName: `${stem(brand.liteName)}-Setup-\${version}.\${ext}` };
}

module.exports = config;
