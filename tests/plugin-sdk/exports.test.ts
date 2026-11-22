/**
 * Every type a plugin can meet in the API must be nameable from the SDK
 * (`@cardmirror/plugin-api`), or authors can't annotate their own code
 * (a `files.onSave` hook, a snapshot helper). This test scans the
 * modules behind the API for exported types and fails when one is
 * neither re-exported by src/plugin-sdk/index.ts nor listed below as
 * host-side wiring.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCES = [
  ...readdirSync('src/editor/plugin-caps').map((f) => `src/editor/plugin-caps/${f}`),
  'src/editor/plugin-api.ts',
  'src/editor/plugin-file-data.ts',
  'src/editor/plugin-registry.ts',
  'src/editor/plugin-permissions.ts',
  'src/editor/plugin-call-rules.ts',
].filter((f) => f.endsWith('.ts'));

/** Host-side types: never handed to a plugin, so not public API. */
const HOST_ONLY = new Set([
  'CallRule',
  'CapabilityContext',
  'CreatePluginApi',
  'PermissionPromptAnswer',
  'PermissionPromptRequest',
  'PermissionSensitivity',
  'PluginApiDeps',
  'PluginCollabBridge',
  'PluginGrantContext',
  'PluginHookRegistry',
  'PluginNamespaceKey',
  'PluginPermissionInfo',
]);

function declaredTypes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of SOURCES) {
    for (const m of readFileSync(file, 'utf8').matchAll(/^export (?:interface|type) ([A-Z][A-Za-z0-9]*)/gm)) {
      out.set(m[1]!, file);
    }
  }
  return out;
}

function sdkExports(): Set<string> {
  const sdk = readFileSync('src/plugin-sdk/index.ts', 'utf8');
  const out = new Set<string>();
  for (const block of sdk.matchAll(/export type \{([^}]*)\}/g)) {
    for (const name of block[1]!.split(',')) {
      const n = name.trim();
      if (n) out.add(n);
    }
  }
  return out;
}

describe('plugin SDK exports', () => {
  it('re-exports every public type behind the plugin API', () => {
    const sdk = sdkExports();
    const missing = [...declaredTypes()]
      .filter(([name]) => !sdk.has(name) && !HOST_ONLY.has(name))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing, 'export these from src/plugin-sdk/index.ts, or list them in HOST_ONLY').toEqual([]);
  });

  it('never re-exports a host-only type', () => {
    const leaked = [...sdkExports()].filter((n) => HOST_ONLY.has(n));
    expect(leaked).toEqual([]);
  });
});
