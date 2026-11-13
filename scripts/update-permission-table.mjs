// Regenerate PLUGINS.md's permission table from the plugin permission
// catalog (see tests/docs/plugins-permission-table.test.ts, which also
// fails CI when the table drifts).
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'tests/docs/plugins-permission-table.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CARDMIRROR_UPDATE_DOCS: '1' },
});
process.exit(r.status ?? 1);
