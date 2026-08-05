// cli.ts — CLI entry point: analyze a shell command or script file
//
// Usage:
//   tsx src/cli.ts -c 'rm -rf /tmp/build && mkdir /opt/app'
//   tsx src/cli.ts -f deploy.sh
//   tsx src/cli.ts -f deploy.sh --cwd /home/user

import * as fs from 'node:fs';
import { analyze } from './index.js';
import { postprocess } from '../analysis/postprocess.js';
import type { FileEffect } from '../analysis/effects.js';
import type { PostProcessResult, ExtensionGroup } from '../analysis/postprocess.js';
import { toPosix } from '../analysis/vfs.js';

function usage(): never {
  process.stderr.write(
    `Usage:\n  ts-bash-emu -c <command>\n  ts-bash-emu -f <file>\n\nOptions:\n  --cwd <path>   working directory (default: $PWD)\n`,
  );
  process.exit(1);
}

/** Parse argv, run analyze, print markdown to stdout. Intended for the bundled CLI. */
export function runCli(argv: string[] = process.argv.slice(2)): void {
  let script: string | null = null;
  let cwd = toPosix(process.cwd());

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c') {
      script = argv[++i];
    } else if (a === '-f') {
      const file = argv[++i];
      if (!file) usage();
      try {
        script = fs.readFileSync(file, 'utf-8');
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        process.stderr.write(`error: cannot read ${file}: ${message}\n`);
        process.exit(1);
      }
    } else if (a === '--cwd') {
      cwd = toPosix(argv[++i]);
    } else {
      usage();
    }
  }

  if (!script) usage();

  const result = analyze(script, { cwd, realFs: true });
  const pp = postprocess(result.effects);

  process.stdout.write(formatMarkdown(result.effects, result.warnings, pp));
}

// ── Formatting ──────────────────────────────────────────────

function formatMarkdown(
  effects: FileEffect[],
  warnings: string[],
  pp: PostProcessResult,
): string {
  const lines: string[] = [];

  lines.push(`*${new Date().toISOString().slice(0, 19).replace('T', ' ')}*\n`);

  // Effects summary
  lines.push('## Predicted effects\n');
  if (effects.length === 0) {
    lines.push('No file effects detected.\n');
  } else {
    const groups = groupEffects(effects);
    for (const [type, list] of groups) {
      lines.push(`### ${type} (${list.length})\n`);
      for (const e of list) {
        const src = e.source ? ` ← ${e.source}` : '';
        const unc = e.uncertain ? ' *(uncertain)*' : '';
        lines.push(`- \`${e.path}\`${src}${unc}  *(L${e.line}, ${e.command})*`);
      }
      lines.push('');
    }
  }

  // Affected files on disk
  if (pp.totalFileCount > 0) {
    lines.push('## Affected files on disk\n');
    lines.push(
      `**${fmt(pp.totalFileCount)}** files, **${fmtBytes(pp.totalSize)}** total` +
        (pp.budgetExhausted ? '  *(scan stopped at 10 000 limit)*' : '') +
        '\n',
    );
    for (const g of pp.groups) {
      lines.push(formatGroup(g));
    }

    // Top 10 oldest
    if (pp.oldest.length > 0) {
      lines.push('### Oldest files\n');
      lines.push('| Path | Created | Modified | Size |');
      lines.push('|------|---------|----------|------|');
      for (const f of pp.oldest) {
        lines.push(`| \`${f.path}\` | ${fmtDate(f.createdAt)} | ${fmtDate(f.modifiedAt)} | ${fmtBytes(f.size)} |`);
      }
      lines.push('');
    }

    // Top 10 largest
    if (pp.largest.length > 0) {
      lines.push('### Largest files\n');
      lines.push('| Path | Created | Modified | Size |');
      lines.push('|------|---------|----------|------|');
      for (const f of pp.largest) {
        lines.push(`| \`${f.path}\` | ${fmtDate(f.createdAt)} | ${fmtDate(f.modifiedAt)} | ${fmtBytes(f.size)} |`);
      }
      lines.push('');
    }
  }

  // Warnings
  if (warnings.length > 0) {
    lines.push('## Warnings\n');
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function groupEffects(effects: FileEffect[]): Map<string, FileEffect[]> {
  const m = new Map<string, FileEffect[]>();
  for (const e of effects) {
    let list = m.get(e.type);
    if (!list) { list = []; m.set(e.type, list); }
    list.push(e);
  }
  return m;
}

function formatGroup(g: ExtensionGroup): string {
  const lines: string[] = [];
  const hdr =
    g.totalCount > g.files.length
      ? `**${g.extension}** — ${g.totalCount} files, ${fmtBytes(g.totalSize)} *(showing ${g.files.length})*`
      : `**${g.extension}** — ${g.totalCount} files, ${fmtBytes(g.totalSize)}`;
  lines.push(hdr + '\n');

  lines.push('| Path | Created | Modified | Size |');
  lines.push('|------|---------|----------|------|');
  for (const f of g.files) {
    lines.push(`| \`${f.path}\` | ${fmtDate(f.createdAt)} | ${fmtDate(f.modifiedAt)} | ${fmtBytes(f.size)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
