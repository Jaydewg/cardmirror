import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The plugin's own test run: plain Node, no app setup. The contract is
// type-only (no runtime alias needed); the test helper is real code, so
// it gets an alias, matching the tsconfig `paths` entry.
export default defineConfig({
  resolve: {
    alias: {
      '@cardmirror/plugin-api/testing': fileURLToPath(new URL('../../src/plugin-sdk/testing.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
