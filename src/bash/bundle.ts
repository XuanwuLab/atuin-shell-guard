// bundle.ts — Single entry point for `dist/bash-emu.cjs`.
//
// Exposes a programmatic API (importable via `require('./dist/bash-emu.cjs')`)
// AND runs the CLI when the bundle is executed directly with node.
//
//   node dist/bash-emu.cjs -c 'rm -rf /tmp'           // CLI (markdown)
//   const { bash_emu } = require('./dist/bash-emu.cjs') // library (JSON)

export { bash_emu } from './api.js';
export type {
  BashEmuResult,
  BashEmuOptions,
  JsonEffect,
  JsonAffected,
  JsonAffectedFile,
  JsonExtensionGroup,
} from './api.js';

import { runCli } from './cli.js';

// Only run the CLI when this bundle is invoked directly (not required/imported).
// esbuild emits a CommonJS module: Node's CJS wrapper gives it real `require`
// and `module` bindings, so `require.main === module` is the canonical check.
if (typeof require !== 'undefined' && require.main === module) {
  runCli();
}
