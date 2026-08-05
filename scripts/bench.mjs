import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const node = process.execPath;

function runCase(name, fn, iterations = 50, p95LimitMs = 500) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.50)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`${name.padEnd(28)} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms n=${iterations}`);
  if (p95 > p95LimitMs) {
    throw new Error(`${name} p95 ${p95.toFixed(1)}ms exceeded ${p95LimitMs}ms`);
  }
}

function nodeEval(source) {
  const result = spawnSync(node, ['--input-type=module', '--eval', source], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `node exited ${result.status}`);
  }
}

const largeBash = Array.from({ length: 500 }, (_, i) => `if true; then echo ${i}; else rm out/${i}.tmp; fi`).join('\n');
const largePowerShell = Array.from({ length: 500 }, (_, i) => `if ($true) { "ok${i}" } else { Remove-Item out/${i}.tmp }`).join('\n');
const globFiles = Array.from({ length: 1000 }, (_, i) => `/work/src/file-${i}.tmp`);

runCase('bash large script', () => {
  nodeEval(`import { analyze } from './dist/bash/index.js'; analyze(${JSON.stringify(largeBash)}, { cwd: '/work' });`);
}, 20);

runCase('powershell large script', () => {
  nodeEval(`import { analyzePowerShell } from './dist/powershell/index.js'; analyzePowerShell(${JSON.stringify(largePowerShell)}, { cwd: '/work' });`);
}, 20);

runCase('vfs glob delete', () => {
  nodeEval(`import { analyze } from './dist/bash/index.js'; analyze('rm src/*.tmp', { cwd: '/work', fs: ${JSON.stringify(globFiles)} });`);
}, 20);

runCase('hook cold process', () => {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo ok' },
    cwd: root,
  });
  const result = spawnSync(node, ['plugin/atuin-shell-guard.cjs'], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XW_ENABLE_LOG: 'false' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `hook exited ${result.status}`);
}, 20, 250);
