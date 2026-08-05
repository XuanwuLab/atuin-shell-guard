// repl.ts — Interactive REPL: input shell commands, output JSON effects

import * as readline from 'node:readline';
import { analyze } from './index.js';
import { toPosix } from '../analysis/vfs.js';
import { postprocess } from '../analysis/postprocess.js';

let cwd = toPosix(process.cwd());

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stderr,   // prompts go to stderr so stdout stays pure JSON
  terminal: process.stdin.isTTY ?? false,
});

if (rl.terminal) {
  process.stderr.write(`ts-bash-emu repl  (cwd: ${cwd})\n`);
  process.stderr.write(`  !setcwd <path>   change working directory\n`);
  process.stderr.write(`  !cwd             show current working directory\n`);
  process.stderr.write(`  !quit / !exit    exit\n\n`);
}

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    prompt();
    return;
  }

  // Meta commands
  if (trimmed.startsWith('!')) {
    handleMeta(trimmed);
    prompt();
    return;
  }

  const result = analyze(trimmed, { cwd, realFs: true });
  const pp = postprocess(result.effects);
  const output = {
    effects: result.effects,
    gitEffects: result.gitEffects,
    resourceEffects: result.resourceEffects,
    warnings: result.warnings,
    affected: pp,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  prompt();
});

rl.on('close', () => {
  process.exit(0);
});

function handleMeta(cmd: string): void {
  const parts = cmd.split(/\s+/);
  const name = parts[0].toLowerCase();

  if (name === '!setcwd') {
    if (parts.length < 2) {
      process.stderr.write('usage: !setcwd <path>\n');
      return;
    }
    cwd = toPosix(parts[1]);
    process.stderr.write(`cwd: ${cwd}\n`);
    return;
  }

  if (name === '!cwd') {
    process.stderr.write(`${cwd}\n`);
    return;
  }

  if (name === '!quit' || name === '!exit') {
    process.exit(0);
  }

  process.stderr.write(`unknown meta command: ${name}\n`);
}

function prompt(): void {
  if (rl.terminal) {
    rl.setPrompt(`${cwd}$ `);
    rl.prompt();
  }
}

prompt();
