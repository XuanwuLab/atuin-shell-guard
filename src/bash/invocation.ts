import { posix as path } from 'node:path';
import { isAbsolutePath, toPosix } from '../analysis/vfs.js';

export type InvocationCompleteness = 'complete' | 'partial' | 'invalid';
export type CommandIdentityConfidence = 'bare-name' | 'path-basename';

export interface WrapperFrame {
  name: 'command' | 'env' | 'sudo' | 'exec' | 'nohup';
  rawCommand: string;
  privileged: boolean;
  identityConfidence: CommandIdentityConfidence;
}

export interface ResolvedInvocation {
  originalCommand?: string;
  rawCommand?: string;
  commandName?: string;
  args: string[];
  cwd: string;
  envOverlay: Record<string, string | undefined>;
  clearEnvironment: boolean;
  wrapperChain: WrapperFrame[];
  bypassFunctions: boolean;
  privileged: boolean;
  completeness: InvocationCompleteness;
  queryOnly: boolean;
  exitsEarly: boolean;
  identityConfidence?: CommandIdentityConfidence;
  warnings: string[];
}

export interface ResolveInvocationOptions {
  cwd: string;
  maxWrappers?: number;
}

export interface ResolvedBashCommandString {
  script?: string;
  args: string[];
  completeness: InvocationCompleteness;
  exitsEarly: boolean;
  warnings: string[];
}

interface WrapperParse {
  target?: string[];
  completeness?: InvocationCompleteness;
  queryOnly?: boolean;
  exitsEarly?: boolean;
  warning?: string;
  cwd?: string;
  envOverlay?: Record<string, string | undefined>;
  clearEnvironment?: boolean;
  privileged?: boolean;
}

const DEFAULT_MAX_WRAPPERS = 12;

const SUDO_SHORT_OPTIONS_WITH_VALUES = new Set(['C', 'D', 'g', 'h', 'p', 'R', 'T', 'U', 'u', 'c', 'r', 't']);
const SUDO_LONG_OPTIONS_WITH_VALUES = new Set([
  '--close-from', '--chdir', '--group', '--host', '--prompt', '--chroot', '--command-timeout',
  '--other-user', '--user', '--login-class', '--role', '--type',
]);
const SUDO_SHORT_OPTIONS = new Set(['A', 'B', 'b', 'E', 'H', 'K', 'k', 'N', 'n', 'P', 'S']);
const SUDO_LONG_OPTIONS = new Set([
  '--askpass', '--bell', '--background', '--preserve-env', '--set-home', '--remove-timestamp',
  '--reset-timestamp', '--no-update', '--non-interactive', '--preserve-groups', '--stdin',
]);

export function resolveInvocation(words: string[], options: ResolveInvocationOptions): ResolvedInvocation {
  const cwd = normalizeCwd(options.cwd);
  const result: ResolvedInvocation = {
    originalCommand: words[0],
    args: [],
    cwd,
    envOverlay: Object.create(null) as Record<string, string | undefined>,
    clearEnvironment: false,
    wrapperChain: [],
    bypassFunctions: false,
    privileged: false,
    completeness: 'complete',
    queryOnly: false,
    exitsEarly: false,
    warnings: [],
  };
  let current = [...words];
  const maxWrappers = options.maxWrappers ?? DEFAULT_MAX_WRAPPERS;

  while (current.length > 0) {
    const rawCommand = current[0];
    const normalized = normalizeCommandName(rawCommand);
    const wrapperName = asWrapperName(normalized.name);
    if (!wrapperName) {
      result.rawCommand = rawCommand;
      result.commandName = normalized.name;
      result.args = current.slice(1);
      result.identityConfidence = normalized.pathQualified ? 'path-basename' : 'bare-name';
      if (normalized.pathQualified) result.bypassFunctions = true;
      return result;
    }
    if (result.wrapperChain.length >= maxWrappers) {
      result.completeness = 'partial';
      result.warnings.push(`wrapper resolution stopped after ${maxWrappers} layers`);
      return result;
    }

    const parsed = parseWrapper(wrapperName, current.slice(1), result.cwd);
    result.wrapperChain.push({
      name: wrapperName,
      rawCommand,
      privileged: parsed.privileged === true,
      identityConfidence: normalized.pathQualified ? 'path-basename' : 'bare-name',
    });
    result.bypassFunctions = true;
    result.privileged ||= parsed.privileged === true;
    if (parsed.clearEnvironment) {
      result.clearEnvironment = true;
      for (const key of Object.keys(result.envOverlay)) delete result.envOverlay[key];
    }
    if (parsed.cwd !== undefined) result.cwd = parsed.cwd;
    if (parsed.envOverlay) Object.assign(result.envOverlay, parsed.envOverlay);
    if (parsed.warning) result.warnings.push(parsed.warning);
    if (parsed.completeness) result.completeness = parsed.completeness;
    result.queryOnly ||= parsed.queryOnly === true;
    result.exitsEarly ||= parsed.exitsEarly === true;
    if (!parsed.target || parsed.completeness === 'invalid' || parsed.completeness === 'partial' || parsed.queryOnly || parsed.exitsEarly) {
      return result;
    }
    current = parsed.target;
  }
  return result;
}

export function normalizeCommandName(rawCommand: string): { name: string; pathQualified: boolean } {
  const slash = Math.max(rawCommand.lastIndexOf('/'), rawCommand.lastIndexOf('\\'));
  let name = slash >= 0 ? rawCommand.slice(slash + 1) : rawCommand;
  // Bash command names remain case-sensitive. A .exe suffix is the one clear
  // signal that Windows' case-insensitive executable naming applies.
  if (name.toLowerCase().endsWith('.exe')) name = name.slice(0, -4).toLowerCase();
  return { name, pathQualified: slash >= 0 };
}

/** Resolve Bash's invocation-time -c operand without executing option probes. */
export function resolveBashCommandString(args: string[]): ResolvedBashCommandString {
  const result: ResolvedBashCommandString = {
    args: [],
    completeness: 'complete',
    exitsEarly: false,
    warnings: [],
  };
  let wantsCommand = false;
  let i = 0;

  while (i < args.length && args[i].startsWith('--') && args[i] !== '--') {
    const option = args[i];
    if (option === '--help' || option === '--version') {
      result.exitsEarly = true;
      return result;
    }
    if (option === '--init-file' || option === '--rcfile') {
      if (args[i + 1] === undefined) return invalidBashInvocation(result, `${option} requires an operand`);
      i += 2;
      continue;
    }
    if (BASH_LONG_OPTIONS.has(option)) {
      i++;
      continue;
    }
    return partialBashInvocation(result, `unsupported Bash option ${option}`);
  }

  while (i < args.length && (args[i].startsWith('-') || args[i].startsWith('+'))) {
    const option = args[i];
    if (option === '-' || option === '--') {
      i++;
      break;
    }
    let next = i + 1;
    for (const flag of option.slice(1)) {
      if (flag === 'c') {
        wantsCommand = true;
        continue;
      }
      if (flag === 'o' || flag === 'O') {
        if (args[next] !== undefined) next++;
        continue;
      }
      if (!BASH_INVOCATION_FLAGS.has(flag)) {
        return partialBashInvocation(result, `unsupported Bash option ${option[0]}${flag}`);
      }
    }
    i = next;
  }

  if (!wantsCommand) return result;
  if (args[i] === undefined) return invalidBashInvocation(result, '-c requires a command string');
  result.script = args[i];
  // The first remaining argument is $0; only later arguments become $1...$n.
  result.args = args.length > i + 1 ? args.slice(i + 2) : [];
  return result;
}

const BASH_LONG_OPTIONS = new Set([
  '--debug', '--debugger', '--dump-po-strings', '--dump-strings', '--login',
  '--noediting', '--noprofile', '--norc', '--posix', '--pretty-print',
  '--protected', '--restricted', '--verbose', '--wordexp',
]);

const BASH_INVOCATION_FLAGS = new Set('abefhikmnprstuvxBCEHPTDls');

function invalidBashInvocation(result: ResolvedBashCommandString, warning: string): ResolvedBashCommandString {
  result.completeness = 'invalid';
  result.warnings.push(`bash: ${warning}`);
  return result;
}

function partialBashInvocation(result: ResolvedBashCommandString, warning: string): ResolvedBashCommandString {
  result.completeness = 'partial';
  result.warnings.push(`bash: ${warning}`);
  return result;
}

function asWrapperName(name: string): WrapperFrame['name'] | null {
  if (name === 'command' || name === 'env' || name === 'sudo' || name === 'exec' || name === 'nohup') return name;
  return null;
}

function parseWrapper(name: WrapperFrame['name'], args: string[], cwd: string): WrapperParse {
  switch (name) {
    case 'command': return parseCommand(args);
    case 'env': return parseEnv(args, cwd);
    case 'sudo': return parseSudo(args, cwd);
    case 'exec': return parseExec(args);
    case 'nohup': return parseNohup(args);
  }
}

function parseCommand(args: string[]): WrapperParse {
  let queryOnly = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '--help') return { exitsEarly: true };
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg.startsWith('--')) return invalid(`command: unsupported option ${arg}`);
    for (const flag of arg.slice(1)) {
      if (flag === 'v' || flag === 'V') queryOnly = true;
      else if (flag !== 'p') return invalid(`command: unsupported option -${flag}`);
    }
  }
  if (queryOnly) return { queryOnly: true };
  return { target: args.slice(i) };
}

function parseEnv(args: string[], cwd: string): WrapperParse {
  const envOverlay = Object.create(null) as Record<string, string | undefined>;
  let clearEnvironment = false;
  let nextCwd = cwd;
  let i = 0;

  for (; i < args.length;) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '-') {
      clearEnvironment = true;
      i++;
      continue;
    }
    if (!arg.startsWith('-')) break;
    if (arg === '--help' || arg === '--version') return { exitsEarly: true };
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const inline = equals < 0 ? undefined : arg.slice(equals + 1);
      if (name === '--ignore-environment') clearEnvironment = true;
      else if (name === '--null' || name === '--debug' || name === '--list-signal-handling' ||
               name === '--default-signal' || name === '--block-signal' || name === '--ignore-signal') {
        // These options do not consume a separate operand.
      } else if (name === '--split-string') {
        const value = inline ?? args[i + 1];
        if (value === undefined) return invalid('env: missing operand for --split-string');
        return partial('env: --split-string requires its own quoting and expansion grammar');
      } else if (name === '--unset' || name === '--chdir' || name === '--argv0') {
        const value = inline ?? args[++i];
        if (value === undefined) return invalid(`env: missing operand for ${name}`);
        if (name === '--unset') envOverlay[value] = undefined;
        else if (name === '--chdir') nextCwd = resolveCwd(nextCwd, value);
      } else {
        return invalid(`env: unsupported option ${name}`);
      }
      i++;
      continue;
    }

    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === 'i') {
        clearEnvironment = true;
        continue;
      }
      if (flag === '0' || flag === 'v') continue;
      if (flag !== 'a' && flag !== 'u' && flag !== 'C' && flag !== 'S') {
        return invalid(`env: unsupported option -${flag}`);
      }
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      if (value === undefined) return invalid(`env: missing operand for -${flag}`);
      if (flag === 'S') return partial('env: -S requires its own quoting and expansion grammar');
      if (flag === 'u') envOverlay[value] = undefined;
      else if (flag === 'C') nextCwd = resolveCwd(nextCwd, value);
      break;
    }
    i++;
  }

  while (i < args.length && isEnvironmentAssignment(args[i])) {
    const equals = args[i].indexOf('=');
    envOverlay[args[i].slice(0, equals)] = args[i].slice(equals + 1);
    i++;
  }
  return { target: args.slice(i), cwd: nextCwd, envOverlay, clearEnvironment };
}

function parseExec(args: string[]): WrapperParse {
  let clearEnvironment = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '--help') return { exitsEarly: true };
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg.startsWith('--')) return invalid(`exec: unsupported option ${arg}`);
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === 'c') {
        clearEnvironment = true;
        continue;
      }
      if (flag === 'l') continue;
      if (flag !== 'a') return invalid(`exec: unsupported option -${flag}`);
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      if (value === undefined) return invalid('exec: missing operand for -a');
      break;
    }
  }
  return { target: args.slice(i), clearEnvironment };
}

function parseNohup(args: string[]): WrapperParse {
  let i = 0;
  if (args[i] === '--') i++;
  else if (args[i] === '--help' || args[i] === '--version') return { exitsEarly: true };
  else if (args[i]?.startsWith('-')) return invalid(`nohup: unsupported option ${args[i]}`);
  if (i >= args.length) return invalid('nohup: missing command operand');
  return { target: args.slice(i) };
}

function parseSudo(args: string[], cwd: string): WrapperParse {
  const envOverlay = Object.create(null) as Record<string, string | undefined>;
  let nextCwd = cwd;
  let queryOnly = false;
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg === '--help' || (arg === '-h' && i + 1 >= args.length)) return { exitsEarly: true, privileged: true };
    if (arg === '--version' || arg === '-V') return { queryOnly: true, privileged: true };
    if (arg === '--remove-timestamp' || arg === '-K') return { queryOnly: true, privileged: true };
    if (arg === '--list' || arg === '--validate' || arg === '-l' || arg === '-v') {
      queryOnly = true;
      continue;
    }
    if (arg === '--edit' || arg === '-e') return { ...partial('sudo: edit mode is not a command wrapper'), privileged: true };
    if (arg === '--login' || arg === '--shell' || arg === '-i' || arg === '-s') {
      return { ...partial(`sudo: ${arg} changes shell invocation semantics`), privileged: true };
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const inline = equals < 0 ? undefined : arg.slice(equals + 1);
      if (name === '--chroot') return { ...partial('sudo: chroot execution is outside the local-path model'), privileged: true };
      if (SUDO_LONG_OPTIONS_WITH_VALUES.has(name)) {
        const value = inline ?? args[++i];
        if (value === undefined) return { ...invalid(`sudo: missing operand for ${name}`), privileged: true };
        if (name === '--chdir') nextCwd = resolveCwd(nextCwd, value);
        continue;
      }
      if (SUDO_LONG_OPTIONS.has(name)) continue;
      return { ...invalid(`sudo: unsupported option ${name}`), privileged: true };
    }

    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === 'l' || flag === 'v' || flag === 'V') {
        queryOnly = true;
        continue;
      }
      if (flag === 'e' || flag === 'i' || flag === 's') {
        return { ...partial(`sudo: -${flag} is not a direct command wrapper`), privileged: true };
      }
      if (SUDO_SHORT_OPTIONS.has(flag)) continue;
      if (!SUDO_SHORT_OPTIONS_WITH_VALUES.has(flag)) {
        return { ...invalid(`sudo: unsupported option -${flag}`), privileged: true };
      }
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      if (value === undefined) return { ...invalid(`sudo: missing operand for -${flag}`), privileged: true };
      if (flag === 'R') return { ...partial('sudo: chroot execution is outside the local-path model'), privileged: true };
      if (flag === 'D') nextCwd = resolveCwd(nextCwd, value);
      break;
    }
  }

  while (i < args.length && isEnvironmentAssignment(args[i])) {
    const equals = args[i].indexOf('=');
    envOverlay[args[i].slice(0, equals)] = args[i].slice(equals + 1);
    i++;
  }
  if (queryOnly) return { queryOnly: true, privileged: true, cwd: nextCwd, envOverlay };
  if (i >= args.length) return { ...invalid('sudo: missing command operand'), privileged: true };
  return { target: args.slice(i), privileged: true, cwd: nextCwd, envOverlay };
}

function invalid(warning: string): WrapperParse {
  return { completeness: 'invalid', warning };
}

function partial(warning: string): WrapperParse {
  return { completeness: 'partial', warning };
}

function isEnvironmentAssignment(value: string): boolean {
  return value.indexOf('=') > 0;
}

function normalizeCwd(cwd: string): string {
  const normalized = toPosix(cwd);
  return path.normalize(normalized);
}

function resolveCwd(cwd: string, target: string): string {
  const normalized = toPosix(target);
  return isAbsolutePath(target) ? path.normalize(normalized) : path.normalize(path.join(cwd, normalized));
}
