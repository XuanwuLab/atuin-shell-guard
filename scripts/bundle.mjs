import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  bash: {
    entryPoint: 'src/bash/bundle.ts',
    outfile: 'dist/bash-emu.cjs',
  },
  plugin: {
    entryPoint: 'src/plugin/direct-hook.ts',
    outfile: 'plugin/atuin-shell-guard.cjs',
  },
};

const targetName = process.argv[2];
const target = targets[targetName];
if (!target) {
  console.error(`usage: node scripts/bundle.mjs <${Object.keys(targets).join('|')}>`);
  process.exit(2);
}

await build({
  absWorkingDir: root,
  entryPoints: [target.entryPoint],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: target.outfile,
  logLevel: 'info',
});
