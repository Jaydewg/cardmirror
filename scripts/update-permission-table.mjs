// Regenerate PLUGINS.md's generated blocks: the permission table (from
// the permission catalog) and section 3's API surface (from
// src/editor/plugin-api.ts). See tests/docs/plugins-permission-table.test.ts,
// which also fails CI when either drifts.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'tests/docs/plugins-permission-table.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CARDMIRROR_UPDATE_DOCS: '1' },
});
process.exit(r.status ?? 1);
