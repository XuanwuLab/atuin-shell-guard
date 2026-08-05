import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function run(label, args) {
  console.log(`=== ${label} ===`);
  const result = spawnSync(node, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('Type-check', ['./node_modules/typescript/bin/tsc', '--noEmit']);
run('Lint', ['./node_modules/eslint/bin/eslint.js', '.']);
run('Bash unit tests', ['--import', 'tsx', 'src/bash/__tests__/test.ts']);
run('PowerShell unit tests', ['--import', 'tsx', 'src/powershell/__tests__/test.ts']);
run('Build', ['./node_modules/typescript/bin/tsc']);
run('Bundle bash-emu', ['scripts/bundle.mjs', 'bash']);
run('Bundle plugin', ['scripts/bundle.mjs', 'plugin']);
run('E2E tests', ['scripts/e2e.mjs']);
run('Plugin tests', ['plugin_test_harness/plugin_test.mjs']);

console.log('=== Done ===');
