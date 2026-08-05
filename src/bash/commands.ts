// commands.ts — Known command specifications for dry-run effect tracking

import { posix as path } from 'node:path';
import * as fs from 'node:fs';
import type {
  EffectTracker,
  EffectType,
  ReplacementBehavior,
} from '../analysis/effects.js';
import { isAbsolutePath, toNative, toPosix } from '../analysis/vfs.js';
import { analyzeGitArgs } from '../git/effects.js';

export interface CommandHandlerContext {
  env: Record<string, string | undefined>;
  privileged: boolean;
}

type CommandHandler = (
  args: string[],
  tracker: EffectTracker,
  line: number,
  context: CommandHandlerContext,
) => void;

interface ParsedArgs {
  flags: Set<string>;
  rest: string[];
}

interface CommandSpec {
  name: string;
  knownFlags: string;
  apply(
    args: ParsedArgs,
    rawArgs: string[],
    tracker: EffectTracker,
    line: number,
    context: CommandHandlerContext,
  ): void;
}

function parseFlags(args: string[], knownFlags: string): ParsedArgs {
  const flags = new Set<string>();
  const rest: string[] = [];
  let positional = false;

  for (const arg of args) {
    if (positional) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      positional = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
      for (let i = 1; i < arg.length; i++) {
        if (knownFlags.includes(arg[i])) flags.add(arg[i]);
      }
      continue;
    }
    if (arg.startsWith('--')) continue;
    rest.push(arg);
  }

  return { flags, rest };
}

function addCommandSpec(spec: CommandSpec): [string, CommandHandler] {
  return [
    spec.name,
    (args, tracker, line, context) => spec.apply(parseFlags(args, spec.knownFlags), args, tracker, line, context),
  ];
}

function destinationForSource(dest: string, source: string, tracker: EffectTracker): string {
  const resolvedDest = tracker.resolvePath(dest);
  if (dest.endsWith('/') || tracker.vfs?.isDirectory(resolvedDest)) {
    return path.join(dest, path.basename(source));
  }
  return dest;
}

const COMMAND_SPECS: CommandSpec[] = [
  {
    name: 'rm',
    knownFlags: 'rRfid',
    apply({ flags, rest }, rawArgs, tracker, line) {
      const recursive = flags.has('r') || flags.has('R') || rawArgs.includes('--recursive');
      const dirFlag = flags.has('d') || rawArgs.includes('--dir');
      for (const p of rest) {
        if (p.length === 0) {
          tracker.addWarning(`rm: cannot remove an empty path (line ${line})`);
          continue;
        }
        if (!recursive && !dirFlag && tracker.vfs) {
          const resolved = tracker.resolvePath(p);
          if (tracker.vfs.isDirectory(resolved)) {
            tracker.addWarning(`rm: cannot remove '${p}': Is a directory (line ${line})`);
            continue;
          }
        }
        tracker.add({ type: 'delete', path: p, line, command: 'rm', uncertain: false });
      }
    },
  },
  {
    name: 'rmdir',
    knownFlags: 'p',
    apply({ rest }, _rawArgs, tracker, line) {
      for (const p of rest) {
        if (tracker.vfs) {
          const resolved = tracker.resolvePath(p);
          if (!tracker.vfs.exists(resolved)) {
            tracker.addWarning(`rmdir: failed to remove '${p}': No such directory (line ${line})`);
            continue;
          }
          if (!p.endsWith('/') && tracker.vfs.isSymbolicLink(resolved)) {
            tracker.addWarning(`rmdir: failed to remove '${p}': Not a directory (line ${line})`);
            continue;
          }
          if (!tracker.vfs.isDirectory(resolved)) {
            tracker.addWarning(`rmdir: failed to remove '${p}': Not a directory (line ${line})`);
            continue;
          }
          if (tracker.vfs.readdir(resolved).length > 0) {
            tracker.addWarning(`rmdir: failed to remove '${p}': Directory not empty (line ${line})`);
            continue;
          }
        }
        tracker.add({ type: 'delete', path: p, line, command: 'rmdir', uncertain: false });
      }
    },
  },
  {
    name: 'mkdir',
    knownFlags: 'pm',
    apply({ rest }, _rawArgs, tracker, line) {
      for (const p of rest) tracker.add({ type: 'mkdir', path: p, line, command: 'mkdir', uncertain: false });
    },
  },
  {
    name: 'cp',
    knownFlags: 'rRfailpTun',
    apply({ rest }, rawArgs, tracker, line) {
      if (rest.length < 2) return;
      const dest = rest[rest.length - 1];
      const replacement = replacementBehavior(rawArgs, 'cp');
      for (let i = 0; i < rest.length - 1; i++) {
        tracker.add({
          type: 'copy',
          path: destinationForSource(dest, rest[i], tracker),
          source: rest[i],
          line,
          command: 'cp',
          replacement,
          uncertain: false,
        });
      }
    },
  },
  {
    name: 'mv',
    knownFlags: 'fiTnu',
    apply({ rest }, rawArgs, tracker, line) {
      if (rest.length < 2) return;
      const dest = rest[rest.length - 1];
      const replacement = replacementBehavior(rawArgs, 'mv');
      for (let i = 0; i < rest.length - 1; i++) {
        tracker.add({
          type: 'move',
          path: destinationForSource(dest, rest[i], tracker),
          source: rest[i],
          line,
          command: 'mv',
          replacement,
          uncertain: false,
        });
      }
    },
  },
  {
    name: 'tee',
    knownFlags: 'ai',
    apply({ flags, rest }, _rawArgs, tracker, line) {
      const effectType: EffectType = flags.has('a') ? 'append' : 'write';
      for (const p of rest) tracker.add({ type: effectType, path: p, line, command: 'tee', uncertain: false });
    },
  },
  {
    name: 'chmod',
    knownFlags: 'Rf',
    apply({ rest }, _rawArgs, tracker, line) {
      for (let i = 1; i < rest.length; i++) {
        tracker.add({ type: 'chmod', path: rest[i], line, command: 'chmod', uncertain: false });
      }
    },
  },
  {
    name: 'chown',
    knownFlags: 'Rf',
    apply({ rest }, _rawArgs, tracker, line) {
      for (let i = 1; i < rest.length; i++) {
        tracker.add({ type: 'chown', path: rest[i], line, command: 'chown', uncertain: false });
      }
    },
  },
  {
    name: 'ln',
    knownFlags: 'sfiTn',
    apply({ flags, rest }, rawArgs, tracker, line) {
      if (rest.length < 2) return;
      const replacement = linkReplacementBehavior(rawArgs);
      const dest = rest[rest.length - 1];
      const noTargetDirectory = flags.has('T')
        || flags.has('n')
        || rawArgs.includes('--no-target-directory')
        || rawArgs.includes('--no-dereference');
      for (let i = 0; i < rest.length - 1; i++) {
        tracker.add({
          type: 'link',
          path: noTargetDirectory ? dest : destinationForSource(dest, rest[i], tracker),
          source: rest[i],
          line,
          command: 'ln',
          replacement,
          uncertain: false,
        });
      }
    },
  },
  {
    name: 'install',
    knownFlags: 'dDm',
    apply({ flags, rest }, _rawArgs, tracker, line) {
      if (flags.has('d')) {
        for (const p of rest) tracker.add({ type: 'mkdir', path: p, line, command: 'install', uncertain: false });
      } else if (rest.length >= 2) {
        const dest = rest[rest.length - 1];
        if (flags.has('D')) {
          tracker.add({
            type: 'mkdir',
            path: path.dirname(dest),
            line,
            command: 'install -D',
            uncertain: false,
          });
        }
        for (let i = 0; i < rest.length - 1; i++) {
          tracker.add({
            type: 'copy',
            path: destinationForSource(dest, rest[i], tracker),
            source: rest[i],
            line,
            command: 'install',
            replacement: 'replace',
            uncertain: false,
          });
        }
      }
    },
  },
  {
    name: 'sed',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      let inPlace = false;
      const files: string[] = [];
      let skipNext = false;
      for (const arg of rawArgs) {
        if (skipNext) { skipNext = false; continue; }
        if (arg === '-i' || arg.startsWith('-i')) {
          inPlace = true;
        } else if (arg === '-e' || arg === '-f') {
          skipNext = true;
        } else if (!arg.startsWith('-')) {
          files.push(arg);
        }
      }
      if (!inPlace || files.length === 0) return;
      const startIdx = files.length > 1 ? 1 : 0;
      for (let i = startIdx; i < files.length; i++) {
        tracker.add({ type: 'write', path: files[i], line, command: 'sed -i', uncertain: false });
      }
    },
  },
  {
    name: 'dd',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      for (const arg of rawArgs) {
        if (arg.startsWith('of=')) {
          tracker.add({ type: 'write', path: arg.substring(3), line, command: 'dd', uncertain: false });
        }
      }
    },
  },
  {
    name: 'truncate',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      for (const target of truncateTargets(rawArgs)) {
        tracker.add({
          type: 'truncate',
          path: target,
          line,
          command: 'truncate',
          replacement: 'replace',
          uncertain: false,
        });
      }
    },
  },
  {
    name: 'curl',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      for (let i = 0; i < rawArgs.length; i++) {
        if ((rawArgs[i] === '-o' || rawArgs[i] === '--output') && i + 1 < rawArgs.length) {
          tracker.add({ type: 'write', path: rawArgs[i + 1], line, command: 'curl', uncertain: false });
          i++;
        }
      }
    },
  },
  {
    name: 'wget',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      for (let i = 0; i < rawArgs.length; i++) {
        if ((rawArgs[i] === '-O' || rawArgs[i] === '--output-document') && i + 1 < rawArgs.length) {
          tracker.add({ type: 'write', path: rawArgs[i + 1], line, command: 'wget', uncertain: false });
          i++;
        }
      }
    },
  },
  {
    name: 'rsync',
    knownFlags: 'avzrhHPS',
    apply({ rest }, rawArgs, tracker, line) {
      if (commandOptionEnabled(rawArgs, 'n', '--dry-run', RSYNC_SHORT_OPTIONS_WITH_VALUES, RSYNC_LONG_OPTIONS_WITH_VALUES)) return;
      if (commandOptionEnabled(rawArgs, '', '--list-only', RSYNC_SHORT_OPTIONS_WITH_VALUES, RSYNC_LONG_OPTIONS_WITH_VALUES)) return;
      const operands = rest.filter(arg => !arg.includes('='));
      if (operands.length < 2) return;
      const dest = operands[operands.length - 1];
      for (let i = 0; i < operands.length - 1; i++) {
        tracker.add({
          type: 'copy',
          path: destinationForSource(dest, operands[i], tracker),
          source: operands[i],
          line,
          command: rawArgs.includes('--delete') ? 'rsync --delete' : 'rsync',
          replacement: 'conditional',
          uncertain: false,
        });
      }
      if (rawArgs.includes('--delete')) {
        tracker.add({ type: 'delete', path: dest, line, command: 'rsync --delete', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
      }
      if (rawArgs.includes('--remove-source-files')) {
        for (let i = 0; i < operands.length - 1; i++) {
          tracker.add({ type: 'delete', path: operands[i], line, command: 'rsync --remove-source-files', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
        }
      }
      const backupDir = optionValue(rawArgs, '--backup-dir');
      if (backupDir) {
        tracker.add({ type: 'mkdir', path: backupDir, line, command: 'rsync --backup-dir', uncertain: false });
      }
    },
  },
  {
    name: 'tar',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      const invocation = parseTarInvocation(rawArgs);
      if (invocation.operation === 'extract' && !invocation.invalid && !invocation.exitsEarly && !invocation.toStdout) {
        const entries = invocation.archive ? listTarEntries(tracker.resolvePath(invocation.archive)) : [];
        if (entries.length > 0) {
          for (const entry of entries) tracker.add({ type: 'write', path: path.join(invocation.dest, entry), line, command: 'tar', uncertain: false });
        } else {
          tracker.add({ type: 'write', path: path.join(invocation.dest, '<archive-contents>'), line, command: 'tar', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
        }
      }
    },
  },
  {
    name: 'unzip',
    knownFlags: 'oqn',
    apply(_parsed, rawArgs, tracker, line) {
      const invocation = parseUnzipInvocation(rawArgs);
      if (invocation.invalid || invocation.nonWriting || !invocation.archive) return;
      const entries = listZipEntries(tracker.resolvePath(invocation.archive));
      if (entries.length > 0) {
        for (const entry of entries) tracker.add({ type: 'write', path: path.join(invocation.dest, entry), line, command: 'unzip', uncertain: false });
      } else {
        tracker.add({ type: 'write', path: path.join(invocation.dest, '<archive-contents>'), line, command: 'unzip', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
      }
    },
  },
  {
    name: 'python',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePythonLike(rawArgs, tracker, line, 'python');
    },
  },
  {
    name: 'python3',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePythonLike(rawArgs, tracker, line, 'python3');
    },
  },
  {
    name: 'pip',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePipLike(rawArgs, tracker, line, 'pip');
    },
  },
  {
    name: 'pip3',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePipLike(rawArgs, tracker, line, 'pip3');
    },
  },
  {
    name: 'find',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseFindDeleteInvocation(rawArgs);
      if (!invocation.deletes || invocation.exitsEarly || invocation.invalid) return;
      for (const root of invocation.roots) {
        tracker.addResource({
          domain: 'local-filesystem-selection',
          operation: 'delete',
          command: 'find -delete',
          selection: { kind: 'derived', root: tracker.resolvePath(root) },
          executionMode: 'definite',
          recoverability: 'unknown',
          completeness: 'complete',
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: 'unknown',
          uncertainty: ['derived-selection'],
        });
      }
    },
  },
  {
    name: 'xargs',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseXargsInvocation(rawArgs);
      if (invocation.exitsEarly || invocation.invalid || invocation.commandIndex === undefined) return;
      const childCommand = rawArgs[invocation.commandIndex];
      if (!isRmExecutable(childCommand)) return;
      const rmArgs = rawArgs.slice(invocation.commandIndex + 1);
      if (hasEarlyExitOption(rmArgs, new Set(['--help', '--version']))) return;
      const explicit = positionalOperands(rmArgs);
      if (explicit.length > 0) {
        for (const target of explicit) tracker.add({ type: 'delete', path: target, line, command: 'xargs rm', uncertain: false });
      }
      tracker.addResource({
        domain: 'local-filesystem-selection',
        operation: 'delete',
        command: 'xargs rm',
        selection: { kind: 'stdin', root: tracker.getCwd() },
        executionMode: rawArgs.includes('-p') || rawArgs.includes('--interactive') ? 'interactive' : 'conditional',
        recoverability: 'unknown',
        completeness: 'partial',
        privileged: context.privileged,
        line,
        uncertain: true,
        certainty: 'unknown',
        uncertainty: ['stdin-selection'],
      });
    },
  },
  {
    name: 'perl',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handleInPlaceScript(rawArgs, tracker, line, 'perl');
    },
  },
  {
    name: 'awk',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handleInPlaceScript(rawArgs, tracker, line, 'awk');
    },
  },
  {
    name: 'make',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseMakeInvocation(rawArgs);
      if (invocation.invalid) return;
      if (invocation.goals.some(arg => arg === 'clean' || arg.endsWith(':clean'))) {
        if (!invocation.nonExecuting) {
          tracker.addResource({
            domain: 'local-filesystem-selection',
            operation: 'delete',
            command: 'make clean',
            selection: { kind: 'derived', root: resolveMakeCwd(tracker.getCwd(), invocation.directories), target: 'clean' },
            executionMode: 'conditional',
            recoverability: 'unknown',
            completeness: 'partial',
            privileged: context.privileged,
            line,
            uncertain: true,
            certainty: 'unknown',
            uncertainty: ['derived-selection'],
          });
        }
      }
      if (invocation.goals.includes('install') && !invocation.nonExecuting) {
        const destdir = assignmentArg(rawArgs, 'DESTDIR') || assignmentArg(rawArgs, 'PREFIX') || '/usr/local';
        tracker.add({ type: 'mkdir', path: destdir, line, command: 'make install', uncertain: destdir === '/usr/local' && !rawArgs.some(arg => arg.startsWith('PREFIX=') || arg.startsWith('DESTDIR=')) });
      }
    },
  },
  {
    name: 'cmake',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      const installIndex = rawArgs.indexOf('--install');
      if (installIndex < 0) return;
      const source = rawArgs[installIndex + 1] ?? '.';
      const prefix = optionValue(rawArgs, '--prefix');
      tracker.add({
        type: 'copy',
        path: path.join(prefix ?? '<cmake-install-prefix>', '<install-contents>'),
        source,
        line,
        command: 'cmake --install',
        replacement: 'conditional',
        uncertain: true,
        certainty: 'unknown',
        uncertainty: ['derived-path'],
      });
    },
  },
  {
    name: 'npm',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePackageManager(rawArgs, tracker, line, 'npm');
    },
  },
  {
    name: 'yarn',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePackageManager(rawArgs, tracker, line, 'yarn');
    },
  },
  {
    name: 'pnpm',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line) {
      handlePackageManager(rawArgs, tracker, line, 'pnpm');
    },
  },
  {
    name: 'git',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      const analyzed = analyzeGitArgs(rawArgs, {
        cwd: tracker.getCwd(),
        env: context.env,
        privileged: context.privileged,
        line,
      });
      for (const warning of analyzed.warnings) tracker.addWarning(`${warning} (line ${line})`);
      for (const effect of analyzed.effects) tracker.addGit(effect);
      for (const effect of analyzed.resourceEffects) tracker.addResource(effect);
      const invocation = analyzed.invocation;
      if (invocation.completeness === 'invalid' || invocation.exitsEarly || invocation.queryOnly
          || !invocation.subcommand) return;
      const commandArgs = invocation.args;
      if (invocation.subcommand === 'reset') return;
      if (invocation.subcommand === 'clean') return;
      if ((invocation.subcommand === 'checkout' || invocation.subcommand === 'restore') && commandArgs.includes('--')) {
        const sep = commandArgs.indexOf('--');
        for (const target of commandArgs.slice(sep + 1)) {
          tracker.add({ type: 'write', path: target, line, command: `git ${invocation.subcommand}`, uncertain: false });
        }
        return;
      }
      if (invocation.subcommand !== 'clone') return;
      const rest = commandArgs.filter(arg => !arg.startsWith('-'));
      if (rest.length >= 2) {
        tracker.add({ type: 'mkdir', path: rest[rest.length - 1], line, command: 'git clone', uncertain: false });
      } else if (rest.length === 1) {
        const url = rest[0];
        const base = url.split('/').pop()?.replace(/\.git$/, '') || url;
        tracker.add({ type: 'mkdir', path: base, line, command: 'git clone', uncertain: true, uncertainty: ['derived-path'] });
      }
    },
  },
  {
    name: 'docker',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      if (isDockerComposeVolumeRemoval(rawArgs)) {
        tracker.addResource({
          domain: 'docker-volume',
          operation: 'delete',
          command: 'docker compose down -v',
          selection: { kind: 'unknown' },
          executionMode: 'definite',
          recoverability: 'unknown',
          completeness: 'partial',
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: 'unknown',
          uncertainty: ['unknown-selection', 'external-resource-state'],
        });
      }
      if (rawArgs[0] === 'run') {
        for (const mount of dockerBindMounts(rawArgs.slice(1), tracker)) {
          if (mount.readOnly) continue;
          tracker.addResource({
            domain: 'container-bind-mount',
            operation: 'expose',
            command: 'docker run bind mount',
            selection: { kind: 'named', root: mount.hostPath },
            executionMode: 'config-dependent',
            recoverability: 'domain-dependent',
            completeness: 'complete',
            privileged: context.privileged,
            line,
            uncertain: true,
            certainty: 'unknown',
            uncertainty: ['configuration-dependent', 'external-resource-state'],
          });
        }
      }
    },
  },
  {
    name: 'kubectl',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      const located = findSubcommand(rawArgs, KUBECTL_GLOBAL_OPTIONS_WITH_VALUES);
      if (!located) return;
      if (located.name !== 'delete' && located.name !== 'apply') return;
      const commandArgs = rawArgs.slice(located.index + 1);
      const mode = parseKubectlInvocationMode(commandArgs, located.name);
      if (mode.invalid || mode.exitsEarly || isNonWritingKubectlDryRun(mode.dryRun)) return;
      if (located.name === 'delete') {
        tracker.addResource({
          domain: 'kubernetes',
          operation: 'delete',
          command: 'kubectl delete',
          selection: { kind: 'unknown' },
          executionMode: 'definite',
          recoverability: 'domain-dependent',
          completeness: 'partial',
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: 'unknown',
          uncertainty: ['unknown-selection', 'external-resource-state'],
        });
      } else if (located.name === 'apply') {
        tracker.add({ type: 'write', path: '<kubernetes-resources>', line, command: 'kubectl apply', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
      }
    },
  },
  {
    name: 'helm',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseHelmUninstallInvocation(rawArgs);
      if (invocation && !invocation.exitsEarly && !invocation.invalid) {
        const release = invocation.releases.length === 1 ? invocation.releases[0] : undefined;
        tracker.addResource({
          domain: 'helm',
          operation: 'uninstall',
          command: 'helm uninstall',
          selection: { kind: 'named', target: release },
          executionMode: 'definite',
          recoverability: 'domain-dependent',
          completeness: 'complete',
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: 'unknown',
          uncertainty: ['external-resource-state'],
        });
      } else if (!invocation && rawArgs[0] === 'upgrade' && rawArgs.includes('--install')) {
        tracker.add({ type: 'write', path: '<helm-release>', line, command: 'helm upgrade --install', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
      }
    },
  },
  {
    name: 'terraform',
    knownFlags: '',
    apply(_parsed, rawArgs, tracker, line, context) {
      if (rawArgs[0] === 'destroy') {
        if (rawArgs.includes('-help') || rawArgs.includes('--help')) return;
        tracker.addResource({
          domain: 'terraform',
          operation: 'destroy',
          command: 'terraform destroy',
          selection: { kind: 'unknown' },
          executionMode: 'definite',
          recoverability: 'domain-dependent',
          completeness: 'partial',
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: 'unknown',
          uncertainty: ['unknown-selection', 'external-resource-state'],
        });
      } else if (rawArgs[0] === 'apply') {
        tracker.add({ type: 'write', path: '<terraform-managed-resources>', line, command: 'terraform apply', uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
      }
    },
  },
];

function handlePythonLike(rawArgs: string[], tracker: EffectTracker, line: number, command: string): void {
  if (rawArgs[0] !== '-m' || rawArgs[1] !== 'pip' || rawArgs[2] !== 'install') return;
  handlePipLike(rawArgs.slice(2), tracker, line, `${command} -m pip`);
}

function handlePipLike(rawArgs: string[], tracker: EffectTracker, line: number, command: string): void {
  if (rawArgs[0] !== 'install') return;
  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if ((arg === '--target' || arg === '-t' || arg === '--prefix') && i + 1 < rawArgs.length) {
      tracker.add({ type: 'mkdir', path: rawArgs[i + 1], line, command: `${command} install`, uncertain: false });
      i++;
    }
  }
}

function handleInPlaceScript(rawArgs: string[], tracker: EffectTracker, line: number, command: string): void {
  const inPlace = rawArgs.some(arg => arg === '-i' || arg.startsWith('-i') || arg === '-pi' || arg.startsWith('-pi'));
  if (!inPlace) return;
  const files = rawArgs.filter(arg => !arg.startsWith('-') && !arg.includes('{') && !arg.includes('$'));
  const start = files.length > 1 ? 1 : 0;
  for (let i = start; i < files.length; i++) {
    tracker.add({ type: 'write', path: files[i], line, command: `${command} -i`, uncertain: false });
  }
}

function handlePackageManager(rawArgs: string[], tracker: EffectTracker, line: number, command: string): void {
  const installLike = rawArgs.length === 0 || rawArgs[0] === 'install' || rawArgs[0] === 'i' || rawArgs[0] === 'add';
  if (!installLike) return;
  tracker.add({ type: 'mkdir', path: 'node_modules', line, command: `${command} install`, uncertain: false });
}

function replacementBehavior(
  rawArgs: string[],
  command: 'cp' | 'mv',
): ReplacementBehavior {
  let behavior: ReplacementBehavior = 'replace';
  let update = false;
  for (const arg of rawArgs) {
    if (arg === '--') break;
    if (arg === '--no-clobber') {
      behavior = 'no-clobber';
      continue;
    }
    if (arg === '--interactive') {
      behavior = 'conditional';
      continue;
    }
    if (arg === '--force') {
      if (command === 'mv') behavior = 'replace';
      continue;
    }
    if (arg === '--update' || arg.startsWith('--update=')) {
      const mode = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : 'older';
      if (mode === 'none' || mode === 'none-fail') behavior = 'no-clobber';
      else if (mode !== 'all') update = true;
      continue;
    }
    if (!arg.startsWith('-') || arg.startsWith('--') || arg === '-') continue;
    for (const flag of arg.slice(1)) {
      if (flag === 'n') behavior = 'no-clobber';
      else if (flag === 'i') behavior = 'conditional';
      else if (flag === 'f' && command === 'mv') behavior = 'replace';
      else if (flag === 'u') update = true;
    }
  }
  return update && behavior === 'replace' ? 'conditional' : behavior;
}

function linkReplacementBehavior(rawArgs: string[]): ReplacementBehavior {
  let behavior: ReplacementBehavior = 'no-clobber';
  for (const arg of rawArgs) {
    if (arg === '--') break;
    if (arg === '--force' || arg === '--backup' || arg.startsWith('--backup=')) {
      behavior = 'replace';
      continue;
    }
    if (arg === '--interactive') {
      behavior = 'conditional';
      continue;
    }
    if (!arg.startsWith('-') || arg.startsWith('--') || arg === '-') continue;
    for (const flag of arg.slice(1)) {
      if (flag === 'f' || flag === 'b') behavior = 'replace';
      else if (flag === 'i') behavior = 'conditional';
    }
  }
  return behavior;
}

function truncateTargets(args: string[]): string[] {
  if (args.includes('--help') || args.includes('--version')) return [];
  const targets: string[] = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) {
      targets.push(arg);
      continue;
    }
    if (arg === '--') {
      positional = true;
      continue;
    }
    if (arg === '--size' || arg === '--reference' || arg === '-s' || arg === '-r') {
      i++;
      continue;
    }
    if (arg.startsWith('--size=') || arg.startsWith('--reference=')) continue;
    if (/^-[sr].+/.test(arg)) continue;
    if (arg.startsWith('-')) continue;
    targets.push(arg);
  }
  return targets;
}

interface DockerBindMount {
  hostPath: string;
  readOnly: boolean;
}

function dockerBindMounts(args: string[], tracker: EffectTracker): DockerBindMount[] {
  const mounts: DockerBindMount[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-v' || arg === '--volume') && args[i + 1]) {
      const mount = parseDockerVolumeSpec(args[++i], tracker);
      if (mount) mounts.push(mount);
      continue;
    }
    if (arg.startsWith('--volume=')) {
      const mount = parseDockerVolumeSpec(arg.slice('--volume='.length), tracker);
      if (mount) mounts.push(mount);
      continue;
    }
    if (arg === '--mount' && args[i + 1]) {
      const mount = parseDockerMountSpec(args[++i], tracker);
      if (mount) mounts.push(mount);
      continue;
    }
    if (arg.startsWith('--mount=')) {
      const mount = parseDockerMountSpec(arg.slice('--mount='.length), tracker);
      if (mount) mounts.push(mount);
    }
  }
  return mounts;
}

function parseDockerVolumeSpec(spec: string, tracker: EffectTracker): DockerBindMount | null {
  const separator = /^[A-Za-z]:[\\/]/.test(spec) ? spec.indexOf(':', 2) : spec.indexOf(':');
  if (separator <= 0) return null;
  const source = spec.slice(0, separator);
  if (!isDockerHostPath(source)) return null;
  const destinationAndOptions = spec.slice(separator + 1);
  const finalSeparator = destinationAndOptions.lastIndexOf(':');
  const options = finalSeparator < 0 ? '' : destinationAndOptions.slice(finalSeparator + 1);
  return {
    hostPath: tracker.resolvePath(source),
    readOnly: dockerMountOptionsReadOnly(options),
  };
}

function parseDockerMountSpec(spec: string, tracker: EffectTracker): DockerBindMount | null {
  const fields = spec.split(',');
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (const field of fields) {
    const equals = field.indexOf('=');
    if (equals < 0) switches.add(field.toLowerCase());
    else values.set(field.slice(0, equals).toLowerCase(), field.slice(equals + 1));
  }
  if ((values.get('type') ?? '').toLowerCase() !== 'bind') return null;
  const source = values.get('source') ?? values.get('src');
  if (!source || !isDockerHostPath(source)) return null;
  return {
    hostPath: tracker.resolvePath(source),
    readOnly: switches.has('readonly') || switches.has('ro'),
  };
}

function isDockerHostPath(source: string): boolean {
  return isAbsolutePath(source)
    || source === '.'
    || source === '..'
    || source.startsWith('./')
    || source.startsWith('../')
    || source.includes('/')
    || source.includes('\\');
}

function dockerMountOptionsReadOnly(options: string): boolean {
  return options.split(',').some(option => option.toLowerCase() === 'ro' || option.toLowerCase() === 'readonly');
}

function optionValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1];
    if (arg.startsWith(name + '=')) return arg.slice(name.length + 1);
  }
  return undefined;
}

function commandOptionEnabled(
  args: string[],
  shortName: string,
  longName: string,
  shortOptionsWithValues: Set<string>,
  longOptionsWithValues: Set<string>,
): boolean {
  let enabled = false;
  for (let argIndex = 0; argIndex < args.length; argIndex++) {
    const arg = args[argIndex];
    if (arg === '--') break;
    if (arg === longName) {
      enabled = true;
      continue;
    }
    if (arg === `--no-${longName.slice(2)}`) {
      enabled = false;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const option = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && longOptionsWithValues.has(option)) argIndex++;
      continue;
    }
    if (!arg.startsWith('-') || arg.length < 2) continue;
    const cluster = arg.slice(1);
    for (let i = 0; i < cluster.length; i++) {
      const flag = cluster[i];
      if (flag === shortName) enabled = true;
      if (!shortOptionsWithValues.has(flag)) continue;
      if (i === cluster.length - 1) argIndex++;
      break;
    }
  }
  return enabled;
}

const RSYNC_SHORT_OPTIONS_WITH_VALUES = new Set(['@', 'B', 'e', 'f', 'M', 'T']);
const RSYNC_LONG_OPTIONS_WITH_VALUES = new Set([
  '--address', '--backup-dir', '--block-size', '--bwlimit', '--cc', '--checksum-choice', '--checksum-seed',
  '--chmod', '--chown', '--compare-dest', '--compress-choice', '--compress-level', '--compress-threads',
  '--contimeout', '--copy-as', '--copy-dest', '--debug', '--early-input', '--exclude', '--exclude-from',
  '--files-from', '--filter', '--groupmap', '--iconv', '--include', '--include-from', '--info', '--link-dest',
  '--log-file', '--log-file-format', '--max-alloc', '--max-delete', '--max-size', '--min-size', '--modify-window',
  '--only-write-batch', '--out-format', '--outbuf', '--partial-dir', '--password-file', '--port', '--protocol',
  '--read-batch', '--remote-option', '--rsh', '--rsync-path', '--skip-compress', '--sockopts', '--stderr',
  '--stop-after', '--stop-at', '--suffix', '--temp-dir', '--timeout', '--usermap', '--write-batch',
  '--zc', '--zl', '--zt',
]);

interface LocatedSubcommand {
  name: string;
  index: number;
}

function isDockerComposeVolumeRemoval(args: string[]): boolean {
  if (args[0] !== 'compose' || args[1] !== 'down') return false;
  let removesVolumes = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--help' || arg === '-h') return false;
    if (arg === '-v' || arg === '--volumes') removesVolumes = true;
  }
  return removesVolumes;
}

interface HelmUninstallInvocation {
  releases: string[];
  exitsEarly: boolean;
  invalid: boolean;
}

const HELM_UNINSTALL_LONG_OPTIONS_WITH_VALUES = new Set([
  '--burst-limit', '--cascade', '--description', '--kube-apiserver', '--kube-as-group', '--kube-as-user',
  '--kube-ca-file', '--kube-context', '--kube-tls-server-name', '--kube-token', '--kubeconfig', '--namespace',
  '--qps', '--timeout',
]);
const HELM_UNINSTALL_SHORT_OPTIONS_WITH_VALUES = new Set(['n']);

function parseHelmUninstallInvocation(args: string[]): HelmUninstallInvocation | null {
  if (args[0] !== 'uninstall' && args[0] !== 'delete') return null;
  const result: HelmUninstallInvocation = { releases: [], exitsEarly: false, invalid: false };
  let positional = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (positional) {
      result.releases.push(arg);
      continue;
    }
    if (arg === '--') {
      positional = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.exitsEarly = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.exitsEarly = true;
      continue;
    }
    if (arg.startsWith('--dry-run=')) {
      const value = arg.slice('--dry-run='.length).toLowerCase();
      if (value === 'true' || value === '1') result.exitsEarly = true;
      else if (value !== 'false' && value !== '0') result.invalid = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && HELM_UNINSTALL_LONG_OPTIONS_WITH_VALUES.has(name)) {
        if (args[i + 1] === undefined) result.invalid = true;
        else i++;
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const flag = cluster[j];
        if (flag === 'h') result.exitsEarly = true;
        if (!HELM_UNINSTALL_SHORT_OPTIONS_WITH_VALUES.has(flag)) continue;
        if (j === cluster.length - 1) {
          if (args[i + 1] === undefined) result.invalid = true;
          else i++;
        }
        break;
      }
      continue;
    }
    result.releases.push(arg);
  }
  if (result.releases.length === 0) result.invalid = true;
  return result;
}

function findSubcommand(args: string[], optionsWithValues: Set<string>): LocatedSubcommand | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      const name = args[i + 1];
      return name ? { name, index: i + 1 } : null;
    }
    if (!arg.startsWith('-') || arg === '-') return { name: arg, index: i };

    const optionName = arg.split('=', 1)[0];
    if (optionsWithValues.has(optionName) && !arg.includes('=')) i++;
    if (arg.length > 2) {
      const shortOption = arg.slice(0, 2);
      if (optionsWithValues.has(shortOption)) continue;
    }
  }
  return null;
}

const KUBECTL_GLOBAL_SHORT_OPTIONS_WITH_VALUES = new Set(['n', 's', 'v']);
const KUBECTL_GLOBAL_LONG_OPTIONS_WITH_VALUES = new Set([
  '--as', '--as-group', '--as-uid', '--as-user-extra', '--cache-dir', '--certificate-authority',
  '--client-certificate', '--client-key', '--cluster', '--context', '--kubeconfig', '--kuberc', '--namespace',
  '--password', '--profile', '--profile-output', '--request-timeout', '--server',
  '--storage-driver-buffer-duration', '--storage-driver-db', '--storage-driver-host', '--storage-driver-password',
  '--storage-driver-table', '--storage-driver-user', '--tls-server-name', '--token', '--user', '--username',
  '--vmodule',
]);
const KUBECTL_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  ...[...KUBECTL_GLOBAL_SHORT_OPTIONS_WITH_VALUES].map(option => `-${option}`),
  ...KUBECTL_GLOBAL_LONG_OPTIONS_WITH_VALUES,
]);

const KUBECTL_DELETE_SHORT_OPTIONS_WITH_VALUES = new Set(['f', 'k', 'l', 'o']);
const KUBECTL_DELETE_LONG_OPTIONS_WITH_VALUES = new Set([
  '--field-selector', '--filename', '--grace-period', '--kustomize', '--output', '--raw', '--selector', '--timeout',
]);
const KUBECTL_APPLY_SHORT_OPTIONS_WITH_VALUES = new Set(['f', 'k', 'l', 'o']);
const KUBECTL_APPLY_LONG_OPTIONS_WITH_VALUES = new Set([
  '--field-manager', '--filename', '--grace-period', '--kustomize', '--output', '--prune-allowlist', '--selector',
  '--subresource', '--template', '--timeout',
]);

interface KubectlInvocationMode {
  dryRun?: string;
  invalid: boolean;
  exitsEarly: boolean;
  hasTarget: boolean;
}

function parseKubectlInvocationMode(args: string[], command: 'delete' | 'apply'): KubectlInvocationMode {
  const commandShortOptions = command === 'delete'
    ? KUBECTL_DELETE_SHORT_OPTIONS_WITH_VALUES
    : KUBECTL_APPLY_SHORT_OPTIONS_WITH_VALUES;
  const commandLongOptions = command === 'delete'
    ? KUBECTL_DELETE_LONG_OPTIONS_WITH_VALUES
    : KUBECTL_APPLY_LONG_OPTIONS_WITH_VALUES;
  const result: KubectlInvocationMode = { invalid: false, exitsEarly: false, hasTarget: false };
  let positionalCount = 0;
  let selector = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionalCount += args.length - i - 1;
      break;
    }
    if (arg === '--help' || arg === '-h') {
      result.exitsEarly = true;
      continue;
    }
    if (arg === '--dry-run') {
      // kubectl gives the otherwise string-valued flag a no-operand client mode.
      result.dryRun = 'unchanged';
      continue;
    }
    if (arg.startsWith('--dry-run=')) {
      result.dryRun = arg.slice('--dry-run='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (name === '--all') selector = true;
      if (equals < 0 && (KUBECTL_GLOBAL_LONG_OPTIONS_WITH_VALUES.has(name) || commandLongOptions.has(name))) {
        if (i + 1 >= args.length) result.invalid = true;
        else {
          if (name === '--filename' || name === '--kustomize' || name === '--raw') result.hasTarget = true;
          if (name === '--selector' || name === '--field-selector') selector = true;
          i++;
        }
      } else if (equals >= 0) {
        if (name === '--filename' || name === '--kustomize' || name === '--raw') result.hasTarget = true;
        if (name === '--selector' || name === '--field-selector') selector = true;
      }
      continue;
    }
    if (!arg.startsWith('-') || arg.length < 2) {
      positionalCount++;
      continue;
    }

    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (!KUBECTL_GLOBAL_SHORT_OPTIONS_WITH_VALUES.has(flag) && !commandShortOptions.has(flag)) continue;
      if (flag === 'f' || flag === 'k') result.hasTarget = true;
      if (flag === 'l') selector = true;
      if (j === cluster.length - 1) {
        if (i + 1 >= args.length) result.invalid = true;
        else i++;
      }
      break;
    }
  }
  if (result.dryRun !== undefined && !isValidKubectlDryRun(result.dryRun)) result.invalid = true;
  result.hasTarget ||= command === 'delete'
    ? positionalCount >= 2 || (positionalCount >= 1 && selector)
    : false;
  if (!result.exitsEarly && !result.hasTarget) result.invalid = true;
  return result;
}

function isValidKubectlDryRun(value: string): boolean {
  return value === 'unchanged' || value === 'client' || value === 'server' || value === 'none'
    || value === '1' || value === 't' || value === 'T'
    || value === 'true' || value === 'TRUE' || value === 'True'
    || value === '0' || value === 'f' || value === 'F'
    || value === 'false' || value === 'FALSE' || value === 'False';
}

function isNonWritingKubectlDryRun(value: string | undefined): boolean {
  return value === 'unchanged' || value === 'client' || value === 'server'
    || value === '1' || value === 't' || value === 'T'
    || value === 'true' || value === 'TRUE' || value === 'True';
}

const MAKE_SHORT_OPTIONS_WITH_REQUIRED_VALUES = new Set(['C', 'E', 'f', 'I', 'o', 'W']);
const MAKE_SHORT_OPTIONS_WITH_OPTIONAL_VALUES = new Set(['j', 'l', 'O']);
const MAKE_LONG_OPTIONS_WITH_VALUES = new Set([
  '--assume-new', '--assume-old', '--directory', '--eval', '--file', '--include-dir', '--makefile',
  '--new-file', '--old-file', '--what-if',
]);

export interface MakeInvocation {
  goals: string[];
  directories: string[];
  nonExecuting: boolean;
  invalid: boolean;
}

export function parseMakeInvocation(args: string[]): MakeInvocation {
  const result: MakeInvocation = { goals: [], directories: [], nonExecuting: false, invalid: false };
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) {
      if (!isMakeAssignment(arg)) result.goals.push(arg);
      continue;
    }
    if (arg === '--') {
      positional = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '--just-print' || arg === '--recon'
        || arg === '--question' || arg === '--touch' || arg === '--help' || arg === '--version') {
      result.nonExecuting = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && MAKE_LONG_OPTIONS_WITH_VALUES.has(name)) {
        const operand = args[i + 1];
        if (operand === undefined) result.invalid = true;
        else {
          if (name === '--directory') result.directories.push(operand);
          i++;
        }
      } else if (equals >= 0 && name === '--directory') {
        result.directories.push(arg.slice(equals + 1));
      }
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (!isMakeAssignment(arg)) result.goals.push(arg);
      continue;
    }
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === 'n' || flag === 'q' || flag === 't') result.nonExecuting = true;
      if (MAKE_SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(flag)) {
        const attached = cluster.slice(j + 1);
        let operand = attached;
        if (!attached) {
          operand = args[i + 1] ?? '';
          if (operand === '') result.invalid = true;
          else i++;
        }
        if (flag === 'C' && operand) result.directories.push(operand);
        break;
      }
      if (MAKE_SHORT_OPTIONS_WITH_OPTIONAL_VALUES.has(flag) && j < cluster.length - 1) break;
    }
  }
  return result;
}

function isMakeAssignment(arg: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?::|\+|\?|!)?=/.test(arg);
}

export function resolveMakeCwd(cwd: string, directories: string[]): string {
  let resolved = cwd;
  for (const directory of directories) {
    const normalized = toPosix(directory);
    resolved = isAbsolutePath(directory)
      ? path.normalize(normalized)
      : path.normalize(path.join(resolved, normalized));
  }
  return resolved;
}

type TarOperation = 'extract' | 'list' | 'create' | 'append' | 'update' | 'concatenate' | 'compare' | 'delete' | 'test-label';

interface TarInvocation {
  operation: TarOperation | null;
  invalid: boolean;
  exitsEarly: boolean;
  toStdout: boolean;
  archive?: string;
  dest: string;
}

const TAR_SHORT_OPERATIONS = new Map<string, TarOperation>([
  ['x', 'extract'], ['t', 'list'], ['c', 'create'], ['r', 'append'],
  ['u', 'update'], ['A', 'concatenate'], ['d', 'compare'],
]);

const TAR_LONG_OPERATIONS = new Map<string, TarOperation>([
  ['--extract', 'extract'], ['--get', 'extract'], ['--list', 'list'], ['--create', 'create'],
  ['--append', 'append'], ['--update', 'update'], ['--concatenate', 'concatenate'],
  ['--catenate', 'concatenate'], ['--compare', 'compare'], ['--diff', 'compare'], ['--delete', 'delete'],
  ['--test-label', 'test-label'],
]);

const TAR_SHORT_OPTIONS_WITH_VALUES = new Set(['b', 'C', 'f', 'F', 'g', 'H', 'I', 'K', 'L', 'N', 'T', 'V', 'X']);
const TAR_LONG_OPTIONS_WITH_VALUES = new Set([
  '--add-file', '--after-date', '--blocking-factor', '--checkpoint-action', '--directory', '--exclude',
  '--exclude-from', '--exclude-ignore', '--exclude-ignore-recursive', '--exclude-tag', '--exclude-tag-all',
  '--exclude-tag-under', '--file', '--files-from', '--format', '--group', '--group-map', '--hole-detection',
  '--index-file', '--info-script', '--label', '--level', '--listed-incremental', '--mode', '--mtime',
  '--new-volume-script', '--newer', '--newer-mtime', '--no-quote-chars', '--owner', '--owner-map',
  '--pax-option', '--quote-chars', '--quoting-style', '--record-size', '--rmt-command', '--rsh-command', '--sort',
  '--sparse-version', '--starting-file', '--strip-components', '--suffix', '--tape-length', '--to-command',
  '--transform', '--use-compress-program', '--volno-file', '--warning', '--xattrs-exclude', '--xattrs-include',
  '--xform',
]);
const TAR_EARLY_EXIT_LONG_OPTIONS = new Set(['--help', '--show-defaults', '--usage', '--version']);

function parseTarInvocation(args: string[]): TarInvocation {
  const result: TarInvocation = { operation: null, invalid: false, exitsEarly: false, toStdout: false, dest: '.' };
  let options = true;

  const setOperation = (operation: TarOperation) => {
    if (result.operation) result.invalid = true;
    else result.operation = operation;
  };

  const applyShortFlag = (flag: string) => {
    const operation = TAR_SHORT_OPERATIONS.get(flag);
    if (operation) setOperation(operation);
    if (flag === 'O') result.toStdout = true;
    if (flag === '?') result.exitsEarly = true;
  };

  const applyOptionValue = (flag: string, value: string | undefined) => {
    if (value === undefined) {
      result.invalid = true;
      return;
    }
    if (flag === 'f' || flag === '--file') result.archive = value;
    else if (flag === 'C' || flag === '--directory') result.dest = value;
  };

  let start = 0;
  const traditional = args[0] !== undefined && !args[0].startsWith('-') && /^[A-Za-z?]+$/.test(args[0]);
  if (traditional) {
    const valueFlags: string[] = [];
    for (const flag of args[0]) {
      applyShortFlag(flag);
      if (TAR_SHORT_OPTIONS_WITH_VALUES.has(flag)) valueFlags.push(flag);
    }
    start = 1;
    for (const flag of valueFlags) applyOptionValue(flag, args[start++]);
  }

  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options) continue;

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const inlineValue = equals < 0 ? undefined : arg.slice(equals + 1);
      const operation = TAR_LONG_OPERATIONS.get(name);
      if (operation) {
        setOperation(operation);
        if (inlineValue !== undefined) result.invalid = true;
      }
      if (name === '--to-stdout') {
        result.toStdout = true;
        if (inlineValue !== undefined) result.invalid = true;
      }
      if (TAR_EARLY_EXIT_LONG_OPTIONS.has(name)) result.exitsEarly = true;
      if (TAR_LONG_OPTIONS_WITH_VALUES.has(name)) {
        const value = inlineValue ?? args[++i];
        applyOptionValue(name, value);
      }
      continue;
    }

    if (!arg.startsWith('-')) continue;
    if (arg === '-') continue;
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      applyShortFlag(flag);
      if (!TAR_SHORT_OPTIONS_WITH_VALUES.has(flag)) continue;

      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      applyOptionValue(flag, value);
      break;
    }
  }
  return result;
}

interface UnzipInvocation {
  archive?: string;
  dest: string;
  invalid: boolean;
  nonWriting: boolean;
}

const UNZIP_NEGATABLE_MODIFIER_FLAGS = new Set([
  'a', 'b', 'B', 'C', 'D', 'E', 'F', 'i', 'j', 'J', 'K', 'L', 'M', 'N', 'o', 'q', 'r', 's', 'S',
  'U', 'V', 'W', 'X', 'Y', '2', '$', ':', '^',
]);

function parseUnzipInvocation(args: string[]): UnzipInvocation {
  const result: UnzipInvocation = { dest: '.', invalid: false, nonWriting: false };
  if (args[0]?.startsWith('-Z')) {
    result.nonWriting = true;
    return result;
  }

  let cflag = false;
  let fflag = false;
  let tflag = false;
  let timestampFlag = false;
  let uflag = false;
  let overwriteNone = false;
  let vflag = 0;
  let zflag = 0;
  let negative = 0;
  let help = false;
  let destinationSeen = false;
  let passwordSeen = false;
  let i = 0;

  const enableUnlessNegated = (): boolean => {
    if (negative) {
      negative = 0;
      return false;
    }
    return true;
  };
  const updateCount = (value: number, verbose = false): number => {
    if (negative) {
      const updated = Math.max(value - negative, 0);
      negative = 0;
      return updated;
    }
    return verbose ? (value ? value + 1 : 2) : value + 1;
  };

  for (; i < args.length && args[i].startsWith('-'); i++) {
    const cluster = args[i].slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === '-') {
        negative++;
        continue;
      }
      if (flag === 'c' || flag === 'p') {
        cflag = enableUnlessNegated();
        continue;
      }
      if (flag === 'f') {
        if (negative) {
          negative = 0;
          fflag = false;
          uflag = false;
        } else {
          fflag = true;
          uflag = true;
        }
        continue;
      }
      if (flag === 'l') {
        vflag = updateCount(vflag);
        continue;
      }
      if (flag === 'n') {
        overwriteNone = enableUnlessNegated();
        continue;
      }
      if (flag === 't') {
        tflag = enableUnlessNegated();
        continue;
      }
      if (flag === 'T') {
        timestampFlag = enableUnlessNegated();
        continue;
      }
      if (flag === 'u') {
        uflag = enableUnlessNegated();
        continue;
      }
      if (flag === 'v') {
        vflag = updateCount(vflag, true);
        continue;
      }
      if (flag === 'z') {
        zflag = updateCount(zflag);
        continue;
      }
      if (flag === 'h') {
        help = true;
        continue;
      }
      if (flag === 'Z') {
        result.invalid = true;
        continue;
      }
      if (flag === 'd') {
        if (negative || destinationSeen) {
          result.invalid = true;
          continue;
        }
        const attached = cluster.slice(j + 1);
        if (attached) {
          result.dest = attached;
        } else {
          const value = args[i + 1];
          if (value === undefined || value.startsWith('-')) result.invalid = true;
          else {
            result.dest = value;
            i++;
          }
        }
        destinationSeen = true;
        break;
      }
      if (flag === 'P') {
        if (negative) {
          result.invalid = true;
          continue;
        }
        if (!passwordSeen) {
          const attached = cluster.slice(j + 1);
          if (!attached) {
            const value = args[i + 1];
            if (value === undefined || value.startsWith('-')) result.invalid = true;
            else i++;
          }
          passwordSeen = true;
          break;
        }
        continue;
      }
      if (UNZIP_NEGATABLE_MODIFIER_FLAGS.has(flag)) negative = 0;
      // Info-ZIP's e/x options are intentional no-ops and do not consume
      // a preceding minus operator. Unknown platform options stay conservative.
    }
  }

  if (i < args.length) result.archive = args[i++];
  for (; i < args.length; i++) {
    const arg = args[i];
    if (destinationSeen || !arg.startsWith('-d')) continue;
    const attached = arg.slice(2);
    if (attached) result.dest = attached;
    else if (i + 1 < args.length) result.dest = args[++i];
    else result.invalid = true;
    destinationSeen = true;
  }

  if ((cflag && (tflag || uflag)) || (tflag && uflag) || (fflag && overwriteNone)) {
    result.invalid = true;
  }
  result.nonWriting = help || cflag || tflag || timestampFlag || vflag > 0 || zflag > 0;
  return result;
}

function assignmentArg(args: string[], name: string): string | undefined {
  const prefix = name + '=';
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

interface FindDeleteInvocation {
  roots: string[];
  deletes: boolean;
  exitsEarly: boolean;
  invalid: boolean;
}

const FIND_EXPRESSIONS_WITH_ONE_OPERAND = new Set([
  '-amin', '-anewer', '-atime', '-cmin', '-cnewer', '-ctime', '-fstype', '-gid', '-group',
  '-ilname', '-iname', '-inum', '-ipath', '-iregex', '-iwholename', '-links', '-lname', '-maxdepth',
  '-mindepth', '-mmin', '-mnewer', '-mtime', '-name', '-newer', '-path', '-perm', '-printf',
  '-regex', '-samefile', '-size', '-type', '-uid', '-user', '-wholename', '-xtype', '-fprint', '-fprint0',
  '-fls', '-regextype', '-files0-from',
]);
const FIND_EXPRESSIONS_WITH_TWO_OPERANDS = new Set(['-fprintf']);
const FIND_VARIABLE_OPERAND_EXPRESSIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function parseFindDeleteInvocation(args: string[]): FindDeleteInvocation {
  const result: FindDeleteInvocation = { roots: [], deletes: false, exitsEarly: false, invalid: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--help' || arg === '--version') {
      result.exitsEarly = true;
      return result;
    }
    if (arg === '-H' || arg === '-L' || arg === '-P' || /^-O\d+$/.test(arg)) {
      i++;
      continue;
    }
    if (arg === '-D') {
      if (args[i + 1] === undefined) result.invalid = true;
      else i += 2;
      continue;
    }
    break;
  }

  while (i < args.length && !isFindExpressionStart(args[i])) result.roots.push(args[i++]);
  if (result.roots.length === 0) result.roots.push('.');

  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '--version') {
      result.exitsEarly = true;
      continue;
    }
    if (arg === '-delete') {
      result.deletes = true;
      continue;
    }
    if (FIND_VARIABLE_OPERAND_EXPRESSIONS.has(arg)) {
      let terminated = false;
      while (++i < args.length) {
        if (args[i] === ';' || args[i] === '+') {
          terminated = true;
          break;
        }
      }
      if (!terminated) result.invalid = true;
      continue;
    }
    const dynamicNewer = /^-newer[A-Za-z]{2}$/.test(arg);
    const operands = dynamicNewer || FIND_EXPRESSIONS_WITH_ONE_OPERAND.has(arg)
      ? 1
      : FIND_EXPRESSIONS_WITH_TWO_OPERANDS.has(arg)
        ? 2
        : 0;
    if (operands > 0) {
      if (i + operands >= args.length) result.invalid = true;
      i += operands;
    }
  }
  return result;
}

function isFindExpressionStart(arg: string): boolean {
  return arg.startsWith('-') || arg === '!' || arg === '(' || arg === ')' || arg === ',';
}

interface XargsInvocation {
  commandIndex?: number;
  exitsEarly: boolean;
  invalid: boolean;
}

const XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES = new Set([
  '--arg-file', '--delimiter', '--eof-str', '--max-args', '--max-chars', '--max-lines', '--max-procs',
  '--process-slot-var', '--replace-str',
]);
const XARGS_LONG_OPTIONS_WITH_OPTIONAL_VALUES = new Set(['--eof', '--replace']);
const XARGS_SHORT_OPTIONS_WITH_REQUIRED_VALUES = new Set(['a', 'd', 'E', 'I', 'L', 'n', 'P', 's', 'S']);
const XARGS_SHORT_OPTIONS_WITH_OPTIONAL_VALUES = new Set(['e', 'i', 'l']);

function parseXargsInvocation(args: string[]): XargsInvocation {
  const result: XargsInvocation = { exitsEarly: false, invalid: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      if (args[i + 1] === undefined) result.invalid = true;
      else result.commandIndex = i + 1;
      return result;
    }
    if (arg === '--help' || arg === '--version') {
      result.exitsEarly = true;
      return result;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES.has(name)) {
        if (args[i + 1] === undefined) result.invalid = true;
        else i++;
      } else if (equals < 0 && XARGS_LONG_OPTIONS_WITH_OPTIONAL_VALUES.has(name)) {
        // GNU optional long arguments are accepted only with '='.
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const flag = cluster[j];
        if (XARGS_SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(flag)) {
          if (j === cluster.length - 1) {
            if (args[i + 1] === undefined) result.invalid = true;
            else i++;
          }
          break;
        }
        if (XARGS_SHORT_OPTIONS_WITH_OPTIONAL_VALUES.has(flag)) break;
      }
      if (result.invalid) return result;
      continue;
    }
    result.commandIndex = i;
    return result;
  }
  return result;
}

function isRmExecutable(command: string): boolean {
  let basename = path.basename(toPosix(command));
  if (basename.toLowerCase().endsWith('.exe')) basename = basename.slice(0, -4).toLowerCase();
  return basename === 'rm';
}

function hasEarlyExitOption(args: string[], earlyExitOptions: Set<string>): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (earlyExitOptions.has(arg)) return true;
  }
  return false;
}

function positionalOperands(args: string[]): string[] {
  const operands: string[] = [];
  let positional = false;
  for (const arg of args) {
    if (!positional && arg === '--') {
      positional = true;
      continue;
    }
    if (positional || !arg.startsWith('-') || arg === '-') operands.push(arg);
  }
  return operands;
}

function listTarEntries(archivePath: string): string[] {
  try {
    const fd = fs.openSync(toNative(archivePath), 'r');
    try {
      const entries: string[] = [];
      const header = Buffer.alloc(512);
      let offset = 0;
      while (fs.readSync(fd, header, 0, 512, offset) === 512) {
        if (header.every(byte => byte === 0)) break;
        const name = readNullTerminated(header, 0, 100);
        const prefix = readNullTerminated(header, 345, 155);
        const fullName = sanitizeArchiveEntry(prefix ? `${prefix}/${name}` : name);
        const sizeText = readNullTerminated(header, 124, 12).trim();
        const size = Number.parseInt(sizeText, 8);
        if (fullName && !fullName.endsWith('/')) entries.push(fullName);
        const dataSize = Number.isFinite(size) ? size : 0;
        offset += 512 + Math.ceil(dataSize / 512) * 512;
      }
      return entries;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function listZipEntries(archivePath: string): string[] {
  try {
    const data = fs.readFileSync(toNative(archivePath));
    const entries: string[] = [];
    let i = 0;
    while (i + 46 <= data.length) {
      if (data.readUInt32LE(i) !== 0x02014b50) {
        i++;
        continue;
      }
      const method = data.readUInt16LE(i + 10);
      const nameLen = data.readUInt16LE(i + 28);
      const extraLen = data.readUInt16LE(i + 30);
      const commentLen = data.readUInt16LE(i + 32);
      const name = sanitizeArchiveEntry(data.slice(i + 46, i + 46 + nameLen).toString('utf8'));
      if (method !== 0 && method !== 8) return [];
      if (name && !name.endsWith('/')) entries.push(name);
      i += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } catch {
    return [];
  }
}

function readNullTerminated(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const limit = end >= start && end < start + length ? end : start + length;
  return buffer.slice(start, limit).toString('utf8');
}

function sanitizeArchiveEntry(entry: string): string {
  const normalized = path.normalize(entry.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) return '';
  return normalized;
}

export const COMMAND_HANDLERS: Map<string, CommandHandler> = new Map(COMMAND_SPECS.map(addCommandSpec));
