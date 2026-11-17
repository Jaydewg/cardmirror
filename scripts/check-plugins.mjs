// Test, typecheck and build every plugin package under plugins/ (each
// folder with a package.json). Plugins are standalone packages that the
// root suite doesn't run, so CI calls this. They resolve their tools
// (vitest, tsc, esbuild) from the root node_modules, so run
// `npm ci` at the root first.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'plugins';
const STEPS = ['test', 'typecheck', 'build'];

const dirs = existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, e.name, 'package.json')))
      .map((e) => join(ROOT, e.name))
      .sort()
  : [];

if (dirs.length === 0) {
  console.log('check-plugins: no plugin packages under plugins/.');
  process.exit(0);
}

const failures = [];
for (const dir of dirs) {
  const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
  for (const step of STEPS) {
    if (!scripts[step]) {
      failures.push(`${dir}: no "${step}" script`);
      continue;
    }
    console.log(`\n── ${dir}: npm run ${step}`);
    const r = spawnSync('npm', ['run', step], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) failures.push(`${dir}: ${step} failed`);
  }
}

if (failures.length) {
  console.error(`\ncheck-plugins: ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\ncheck-plugins: ${dirs.length} plugin package(s) OK.`);
