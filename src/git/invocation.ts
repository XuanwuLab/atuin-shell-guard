import { posix as path } from 'node:path';
import { isAbsolutePath, toPosix } from '../analysis/vfs.js';

export type GitResolutionCompleteness = 'complete' | 'partial' | 'invalid';
export type GitRepositoryContextConfidence = 'explicit' | 'environment' | 'implicit';
export type GitResetMode = 'mixed' | 'soft' | 'hard' | 'merge' | 'keep' | 'patch';
export type GitResetForm = 'mode' | 'pathspec' | 'pathspec-file' | 'patch' | 'ambiguous';
export type GitResetSelectionKind = 'all' | 'pathspecs' | 'pathspec-file' | 'unknown';
export type GitCleanIgnoredMode = 'standard' | 'include-ignored' | 'ignored-only';
export type GitCleanSelectionKind = 'all' | 'pathspecs' | 'unknown';

export interface GitRepositoryContext {
  cwd: string;
  gitDir?: string;
  workTree?: string;
  namespace?: string;
  bare: boolean;
  forcedBare: boolean;
  confidence: GitRepositoryContextConfidence;
}

export interface ResolvedGitInvocation {
  subcommand?: string;
  args: string[];
  context: GitRepositoryContext;
  pathspecFlags: string[];
  completeness: GitResolutionCompleteness;
  exitsEarly: boolean;
  queryOnly: boolean;
  budgetExhausted: boolean;
  warnings: string[];
}

export interface ResolveGitInvocationOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  maxArgs?: number;
}

export interface GitResetSelection {
  kind: GitResetSelectionKind;
  pathspecs?: string[];
  pathspecFile?: string;
  truncated?: boolean;
}

export interface ResolvedGitReset {
  mode: GitResetMode;
  form: GitResetForm;
  target?: string;
  selection: GitResetSelection;
  updatesHead: boolean | 'conditional';
  recurseSubmodules: boolean | 'configured';
  completeness: GitResolutionCompleteness;
  exitsEarly: boolean;
  budgetExhausted: boolean;
  warnings: string[];
}

export interface ResolveGitResetOptions {
  maxArgs?: number;
}

export interface GitCleanSelection {
  kind: GitCleanSelectionKind;
  pathspecs?: string[];
}

export interface ResolvedGitClean {
  dryRun: boolean;
  force: number;
  interactive: boolean;
  removeDirectories: boolean;
  ignoredMode: GitCleanIgnoredMode;
  selection: GitCleanSelection;
  completeness: GitResolutionCompleteness;
  exitsEarly: boolean;
  budgetExhausted: boolean;
  warnings: string[];
}

export interface ResolveGitCleanOptions {
  maxArgs?: number;
}

const DEFAULT_MAX_GIT_ARGS = 256;

const GIT_FLAG_OPTIONS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-lazy-fetch', '--no-replace-objects',
  '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--no-literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
]);

const GIT_QUERY_OPTIONS = new Set([
  '--html-path', '--man-path', '--info-path',
]);

const GIT_OPTIONS_WITH_SEPARATE_VALUES = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--namespace', '--work-tree', '--shallow-file',
  '--attr-source',
]);

const GIT_OPTIONS_WITH_ATTACHED_VALUES = new Set([
  '--config-env', '--git-dir', '--namespace', '--work-tree', '--attr-source',
]);

const GIT_PATHSPEC_FLAGS = new Set([
  '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs',
]);

const RESET_LONG_OPTIONS = [
  'quiet', 'no-quiet', 'refresh', 'no-refresh',
  'mixed', 'soft', 'hard', 'merge', 'keep',
  'recurse-submodules', 'no-recurse-submodules',
  'patch', 'no-patch', 'auto-advance', 'no-auto-advance',
  'unified', 'inter-hunk-context',
  'intent-to-add', 'no-intent-to-add',
  'pathspec-from-file', 'no-pathspec-from-file',
  'pathspec-file-nul', 'no-pathspec-file-nul',
] as const;

type ResetLongOptionName = typeof RESET_LONG_OPTIONS[number];

const CLEAN_LONG_OPTIONS = [
  'quiet', 'no-quiet',
  'dry-run', 'no-dry-run',
  'force', 'no-force',
  'interactive', 'no-interactive',
  'exclude',
] as const;

type CleanLongOptionName = typeof CLEAN_LONG_OPTIONS[number];

export function resolveGitInvocation(
  args: string[],
  options: ResolveGitInvocationOptions,
): ResolvedGitInvocation {
  const maxArgs = positiveBudget(options.maxArgs);
  const budgetExhausted = args.length > maxArgs;
  const input = budgetExhausted ? args.slice(0, maxArgs) : args;
  let cwd = normalizeCwd(options.cwd);
  let gitDir = options.env?.['GIT_DIR'];
  let workTree = options.env?.['GIT_WORK_TREE'];
  let namespace = options.env?.['GIT_NAMESPACE'];
  let bare = options.env?.['GIT_IMPLICIT_WORK_TREE'] === '0';
  let forcedBare = false;
  let confidence: GitRepositoryContextConfidence = gitDir !== undefined || workTree !== undefined
    ? 'environment'
    : 'implicit';
  const pathspecFlags: string[] = [];
  const warnings: string[] = [];
  const completeness: GitResolutionCompleteness = budgetExhausted ? 'partial' : 'complete';

  const invalid = (warning: string): ResolvedGitInvocation => finishGitInvocation({
    args: [], cwd, gitDir, workTree, namespace, bare, forcedBare, confidence, pathspecFlags,
    completeness: 'invalid', exitsEarly: false, queryOnly: false, budgetExhausted, warnings: [...warnings, warning],
  });

  if (budgetExhausted) warnings.push(`Git invocation resolution stopped after ${maxArgs} arguments`);

  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (!arg.startsWith('-')) {
      return finishGitInvocation({
        subcommand: arg,
        args: input.slice(i + 1),
        cwd,
        gitDir,
        workTree,
        namespace,
        bare,
        forcedBare,
        confidence,
        pathspecFlags,
        completeness,
        exitsEarly: false,
        queryOnly: false,
        budgetExhausted,
        warnings,
      });
    }

    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
      return finishGitInvocation({
        args: [], cwd, gitDir, workTree, namespace, bare, forcedBare, confidence, pathspecFlags,
        completeness, exitsEarly: true, queryOnly: true, budgetExhausted, warnings,
      });
    }
    if (arg === '--exec-path' || GIT_QUERY_OPTIONS.has(arg) || arg.startsWith('--list-cmds=')) {
      return finishGitInvocation({
        args: [], cwd, gitDir, workTree, namespace, bare, forcedBare, confidence, pathspecFlags,
        completeness, exitsEarly: true, queryOnly: true, budgetExhausted, warnings,
      });
    }
    if (arg.startsWith('--exec-path=')) continue;

    if (arg === '--bare') {
      if (gitDir === undefined) gitDir = cwd;
      bare = true;
      forcedBare = true;
      confidence = 'explicit';
      continue;
    }

    if (GIT_FLAG_OPTIONS.has(arg)) {
      if (GIT_PATHSPEC_FLAGS.has(arg)) pathspecFlags.push(arg);
      continue;
    }

    const attached = attachedLongOption(arg);
    if (attached && GIT_OPTIONS_WITH_ATTACHED_VALUES.has(attached.name)) {
      if (attached.name === '--config-env' && !validConfigEnv(attached.value)) {
        return invalid(`${attached.name} requires <name>=<envvar>`);
      }
      ({ gitDir, workTree, namespace, confidence } = applyGitContextOption(
        attached.name, attached.value, gitDir, workTree, namespace, 'explicit',
      ));
      continue;
    }

    if (GIT_OPTIONS_WITH_SEPARATE_VALUES.has(arg)) {
      const value = input[i + 1];
      if (value === undefined) {
        if (budgetExhausted) {
          warnings.push(`Git invocation budget ended before the operand for ${arg}`);
          return finishGitInvocation({
            args: [], cwd, gitDir, workTree, namespace, bare, forcedBare, confidence, pathspecFlags,
            completeness: 'partial', exitsEarly: false, queryOnly: false, budgetExhausted, warnings,
          });
        }
        return invalid(`${arg} requires an operand`);
      }
      i++;
      if (arg === '-C') {
        if (value.length > 0) cwd = resolveFrom(cwd, value);
        confidence = 'explicit';
        continue;
      }
      if (arg === '--config-env' && !validConfigEnv(value)) {
        return invalid(`${arg} requires <name>=<envvar>`);
      }
      ({ gitDir, workTree, namespace, confidence } = applyGitContextOption(
        arg, value, gitDir, workTree, namespace, confidence,
      ));
      continue;
    }

    return invalid(`unsupported Git global option ${arg}`);
  }

  if (budgetExhausted) {
    return finishGitInvocation({
      args: [], cwd, gitDir, workTree, namespace, bare, forcedBare, confidence, pathspecFlags,
      completeness: 'partial', exitsEarly: false, queryOnly: false, budgetExhausted, warnings,
    });
  }
  return invalid('Git invocation has no subcommand');
}

export function resolveGitReset(args: string[], options: ResolveGitResetOptions = {}): ResolvedGitReset {
  const maxArgs = positiveBudget(options.maxArgs);
  const budgetExhausted = args.length > maxArgs;
  const input = budgetExhausted ? args.slice(0, maxArgs) : args;
  const warnings: string[] = [];
  let completeness: GitResolutionCompleteness = budgetExhausted ? 'partial' : 'complete';
  if (budgetExhausted) warnings.push(`git reset resolution stopped after ${maxArgs} arguments`);

  let selectedMode: Exclude<GitResetMode, 'patch'> | undefined;
  let patchMode = false;
  let pathspecFile: string | undefined;
  let pathspecFileNul = false;
  let intentToAdd = false;
  let recurseSubmodules: boolean | 'configured' = 'configured';
  let unified = false;
  let interHunkContext = false;
  let autoAdvance = true;
  const beforeDash: string[] = [];
  let afterDash: string[] | null = null;

  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (afterDash !== null) {
      afterDash.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDash = [];
      continue;
    }
    if (arg === '-h' || arg === '--help' || arg === '--help-all') {
      return nonExecutingReset('mixed', warnings, budgetExhausted);
    }

    const longOption = arg.startsWith('--') ? resolveResetLongOption(arg) : null;
    if (longOption?.kind === 'ambiguous') {
      return invalidReset(warnings, budgetExhausted, `ambiguous git reset option ${longOption.option}`);
    }
    if (longOption?.kind === 'resolved') {
      const { name, attached, value } = longOption;
      const rejectValue = (): ResolvedGitReset | null => attached
        ? invalidReset(warnings, budgetExhausted, `--${name} takes no value`)
        : null;

      if (name === 'mixed' || name === 'soft' || name === 'hard' || name === 'merge' || name === 'keep') {
        const rejected = rejectValue();
        if (rejected) return rejected;
        selectedMode = name;
        continue;
      }
      if (name === 'patch' || name === 'no-patch') {
        const rejected = rejectValue();
        if (rejected) return rejected;
        patchMode = name === 'patch';
        continue;
      }
      if (name === 'quiet' || name === 'no-quiet' || name === 'refresh' || name === 'no-refresh') {
        const rejected = rejectValue();
        if (rejected) return rejected;
        continue;
      }
      if (name === 'intent-to-add' || name === 'no-intent-to-add') {
        const rejected = rejectValue();
        if (rejected) return rejected;
        intentToAdd = name === 'intent-to-add';
        continue;
      }
      if (name === 'pathspec-file-nul' || name === 'no-pathspec-file-nul') {
        const rejected = rejectValue();
        if (rejected) return rejected;
        pathspecFileNul = name === 'pathspec-file-nul';
        continue;
      }
      if (name === 'recurse-submodules' || name === 'no-recurse-submodules') {
        if (name === 'no-recurse-submodules') {
          const rejected = rejectValue();
          if (rejected) return rejected;
          recurseSubmodules = false;
          continue;
        }
        if (!attached) {
          recurseSubmodules = true;
          continue;
        }
        const parsed = parseGitBoolean(value ?? '');
        if (parsed === null) {
          return invalidReset(warnings, budgetExhausted, `bad --recurse-submodules argument ${value ?? ''}`);
        }
        recurseSubmodules = parsed;
        continue;
      }
      if (name === 'auto-advance' || name === 'no-auto-advance') {
        const rejected = rejectValue();
        if (rejected) return rejected;
        autoAdvance = name === 'auto-advance';
        continue;
      }
      if (name === 'pathspec-from-file' || name === 'no-pathspec-from-file') {
        if (name === 'no-pathspec-from-file') {
          const rejected = rejectValue();
          if (rejected) return rejected;
          pathspecFile = undefined;
          continue;
        }
        let operand = value;
        if (!attached) {
          operand = input[i + 1];
          if (operand === undefined) {
            return missingResetOperand(warnings, budgetExhausted, '--pathspec-from-file');
          }
          i++;
        }
        // Git's OPT_FILENAME treats an empty operand like an unset filename.
        pathspecFile = operand === '' ? undefined : operand;
        continue;
      }
      if (name === 'unified' || name === 'inter-hunk-context') {
        let operand = value;
        if (!attached) {
          operand = input[i + 1];
          if (operand === undefined) return missingResetOperand(warnings, budgetExhausted, `--${name}`);
          i++;
        }
        if (!validResetContextInteger(operand ?? '')) {
          return invalidReset(warnings, budgetExhausted, `--${name} requires an integer greater than or equal to -1`);
        }
        if (name === 'unified') unified = true;
        else interHunkContext = true;
        continue;
      }
    }

    if (arg === '-p') {
      patchMode = true;
      continue;
    }
    if (arg === '-q') continue;
    if (arg === '-N') {
      intentToAdd = true;
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2) {
      let consumedCluster = true;
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === 'q') continue;
        if (flag === 'p') {
          patchMode = true;
          continue;
        }
        if (flag === 'N') {
          intentToAdd = true;
          continue;
        }
        if (flag === 'U') {
          let value = arg.slice(j + 1);
          if (value.length === 0) {
            const operand = input[i + 1];
            if (operand === undefined) return missingResetOperand(warnings, budgetExhausted, '-U');
            value = operand;
            i++;
          }
          if (!validResetContextInteger(value)) {
            return invalidReset(warnings, budgetExhausted, '-U requires an integer greater than or equal to -1');
          }
          unified = true;
          j = arg.length;
          continue;
        }
        consumedCluster = false;
        break;
      }
      if (consumedCluster) continue;
      return invalidReset(warnings, budgetExhausted, `unsupported git reset option ${arg}`);
    }

    if (arg === '-U') {
      const operand = input[i + 1];
      if (operand === undefined) return missingResetOperand(warnings, budgetExhausted, '-U');
      if (!validResetContextInteger(operand)) {
        return invalidReset(warnings, budgetExhausted, '-U requires an integer greater than or equal to -1');
      }
      unified = true;
      i++;
      continue;
    }
    if (arg.startsWith('-')) return invalidReset(warnings, budgetExhausted, `unsupported git reset option ${arg}`);
    beforeDash.push(arg);
  }

  if (budgetExhausted) completeness = 'partial';
  if (pathspecFileNul && pathspecFile === undefined) {
    return invalidReset(warnings, budgetExhausted, '--pathspec-file-nul requires --pathspec-from-file');
  }
  if (patchMode && selectedMode !== undefined) {
    return invalidReset(warnings, budgetExhausted, '--patch cannot be combined with a reset mode');
  }
  if (patchMode && pathspecFile !== undefined) {
    return invalidReset(warnings, budgetExhausted, '--patch cannot be combined with --pathspec-from-file');
  }
  if (!patchMode && (unified || interHunkContext || !autoAdvance)) {
    return invalidReset(warnings, budgetExhausted, 'interactive diff options require --patch');
  }

  const positional = resolveResetPositionals(beforeDash, afterDash);
  if (positional.invalid) return invalidReset(warnings, budgetExhausted, positional.warning!);
  if (positional.ambiguous) {
    completeness = 'partial';
    warnings.push('git reset target is ambiguous between a revision and a path without repository state');
  }
  if (pathspecFile !== undefined && positional.pathspecs.length > 0) {
    return invalidReset(warnings, budgetExhausted, '--pathspec-from-file cannot be combined with command-line pathspecs');
  }

  const mode: GitResetMode = patchMode ? 'patch' : (selectedMode ?? 'mixed');
  if (!patchMode && intentToAdd && mode !== 'mixed') return invalidReset(warnings, budgetExhausted, '-N requires --mixed');

  const hasKnownPathspec = positional.pathspecs.length > 0;
  if (hasKnownPathspec && mode !== 'mixed' && mode !== 'patch') {
    return invalidReset(warnings, budgetExhausted, `--${mode} cannot be combined with pathspecs`);
  }

  let form: GitResetForm;
  let selection: GitResetSelection;
  let updatesHead: boolean | 'conditional';
  if (patchMode) {
    form = 'patch';
    selection = positional.ambiguous
      ? { kind: 'unknown' }
      : hasKnownPathspec
      ? { kind: 'pathspecs', pathspecs: positional.pathspecs }
      : { kind: 'all' };
    updatesHead = false;
  } else if (pathspecFile !== undefined) {
    form = 'pathspec-file';
    selection = { kind: 'pathspec-file', pathspecFile };
    // An empty pathspec file turns this into a mode reset; its contents are intentionally not read here.
    updatesHead = 'conditional';
    completeness = 'partial';
  } else if (positional.ambiguous) {
    form = 'ambiguous';
    selection = { kind: 'unknown' };
    updatesHead = 'conditional';
  } else if (hasKnownPathspec) {
    form = 'pathspec';
    selection = { kind: 'pathspecs', pathspecs: positional.pathspecs };
    updatesHead = false;
  } else {
    form = 'mode';
    selection = { kind: 'all' };
    updatesHead = true;
  }

  return {
    mode,
    form,
    target: positional.target,
    selection,
    updatesHead,
    recurseSubmodules,
    completeness,
    exitsEarly: false,
    budgetExhausted,
    warnings,
  };
}

export function resolveGitClean(args: string[], options: ResolveGitCleanOptions = {}): ResolvedGitClean {
  const maxArgs = positiveBudget(options.maxArgs);
  const budgetExhausted = args.length > maxArgs;
  const input = budgetExhausted ? args.slice(0, maxArgs) : args;
  const warnings: string[] = [];
  if (budgetExhausted) warnings.push(`git clean resolution stopped after ${maxArgs} arguments`);

  let dryRun = false;
  let force = 0;
  let interactive = false;
  let removeDirectories = false;
  let includeIgnored = false;
  let ignoredOnly = false;
  const pathspecs: string[] = [];
  let positional = false;

  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (positional) {
      pathspecs.push(arg);
      continue;
    }
    if (arg === '--') {
      positional = true;
      continue;
    }
    if (arg === '-h' || arg === '--help' || arg === '--help-all') {
      return nonExecutingClean(warnings, budgetExhausted);
    }

    if (arg.startsWith('--')) {
      const resolved = resolveCleanLongOption(arg);
      if (resolved?.kind === 'ambiguous') {
        return invalidClean(warnings, budgetExhausted, `ambiguous git clean option ${resolved.option}`);
      }
      if (!resolved) return invalidClean(warnings, budgetExhausted, `unsupported git clean option ${arg}`);

      const { name, attached } = resolved;
      if (name === 'exclude') {
        if (!attached) {
          if (input[i + 1] === undefined) return missingCleanOperand(warnings, budgetExhausted, '--exclude');
          i++;
        }
        continue;
      }
      if (attached) return invalidClean(warnings, budgetExhausted, `--${name} takes no value`);
      if (name === 'dry-run' || name === 'no-dry-run') dryRun = name === 'dry-run';
      else if (name === 'force') force++;
      else if (name === 'no-force') force = 0;
      else if (name === 'interactive' || name === 'no-interactive') interactive = name === 'interactive';
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const flag = cluster[j];
        if (flag === 'q') continue;
        if (flag === 'n') {
          dryRun = true;
          continue;
        }
        if (flag === 'f') {
          force++;
          continue;
        }
        if (flag === 'i') {
          interactive = true;
          continue;
        }
        if (flag === 'd') {
          removeDirectories = true;
          continue;
        }
        if (flag === 'x') {
          includeIgnored = true;
          continue;
        }
        if (flag === 'X') {
          ignoredOnly = true;
          continue;
        }
        if (flag === 'e') {
          const attached = cluster.slice(j + 1);
          if (!attached) {
            if (input[i + 1] === undefined) return missingCleanOperand(warnings, budgetExhausted, '-e');
            i++;
          }
          j = cluster.length;
          continue;
        }
        return invalidClean(warnings, budgetExhausted, `unsupported git clean option -${flag}`);
      }
      continue;
    }

    pathspecs.push(arg);
  }

  if (includeIgnored && ignoredOnly) {
    return invalidClean(warnings, budgetExhausted, '-x and -X cannot be used together');
  }

  const completeness: GitResolutionCompleteness = budgetExhausted ? 'partial' : 'complete';
  const selection: GitCleanSelection = budgetExhausted
    ? { kind: 'unknown' }
    : pathspecs.length > 0
      ? { kind: 'pathspecs', pathspecs }
      : { kind: 'all' };
  return {
    dryRun,
    force,
    interactive,
    removeDirectories: removeDirectories || pathspecs.length > 0,
    ignoredMode: ignoredOnly ? 'ignored-only' : includeIgnored ? 'include-ignored' : 'standard',
    selection,
    completeness,
    exitsEarly: false,
    budgetExhausted,
    warnings,
  };
}

interface GitInvocationFinishInput {
  subcommand?: string;
  args: string[];
  cwd: string;
  gitDir?: string;
  workTree?: string;
  namespace?: string;
  bare: boolean;
  forcedBare: boolean;
  confidence: GitRepositoryContextConfidence;
  pathspecFlags: string[];
  completeness: GitResolutionCompleteness;
  exitsEarly: boolean;
  queryOnly: boolean;
  budgetExhausted: boolean;
  warnings: string[];
}

function finishGitInvocation(input: GitInvocationFinishInput): ResolvedGitInvocation {
  return {
    subcommand: input.subcommand,
    args: input.args,
    context: {
      cwd: input.cwd,
      gitDir: input.gitDir === undefined ? undefined : resolveFrom(input.cwd, input.gitDir),
      workTree: input.workTree === undefined ? undefined : resolveFrom(input.cwd, input.workTree),
      namespace: input.namespace,
      bare: input.bare,
      forcedBare: input.forcedBare,
      confidence: input.confidence,
    },
    pathspecFlags: [...input.pathspecFlags],
    completeness: input.completeness,
    exitsEarly: input.exitsEarly,
    queryOnly: input.queryOnly,
    budgetExhausted: input.budgetExhausted,
    warnings: [...input.warnings],
  };
}

function applyGitContextOption(
  name: string,
  value: string,
  gitDir: string | undefined,
  workTree: string | undefined,
  namespace: string | undefined,
  confidence: GitRepositoryContextConfidence,
): {
  gitDir?: string;
  workTree?: string;
  namespace?: string;
  confidence: GitRepositoryContextConfidence;
} {
  if (name === '--git-dir') return { gitDir: value, workTree, namespace, confidence: 'explicit' };
  if (name === '--work-tree') return { gitDir, workTree: value, namespace, confidence: 'explicit' };
  if (name === '--namespace') return { gitDir, workTree, namespace: value, confidence: 'explicit' };
  return { gitDir, workTree, namespace, confidence };
}

interface ResetPositionals {
  target?: string;
  pathspecs: string[];
  ambiguous: boolean;
  invalid: boolean;
  warning?: string;
}

function resolveResetPositionals(beforeDash: string[], afterDash: string[] | null): ResetPositionals {
  if (afterDash !== null) {
    if (beforeDash.length > 1) {
      return { pathspecs: [], ambiguous: false, invalid: true, warning: 'too many reset targets before --' };
    }
    return {
      target: beforeDash[0],
      pathspecs: [...afterDash],
      ambiguous: false,
      invalid: false,
    };
  }
  if (beforeDash.length === 0) return { pathspecs: [], ambiguous: false, invalid: false };
  if (beforeDash.length === 1) {
    return { target: beforeDash[0], pathspecs: [], ambiguous: true, invalid: false };
  }
  return {
    target: beforeDash[0],
    pathspecs: beforeDash.slice(1),
    ambiguous: true,
    invalid: false,
  };
}

function nonExecutingReset(
  mode: GitResetMode,
  warnings: string[],
  budgetExhausted: boolean,
): ResolvedGitReset {
  return {
    mode,
    form: 'mode',
    selection: { kind: 'all' },
    updatesHead: false,
    recurseSubmodules: 'configured',
    completeness: 'complete',
    exitsEarly: true,
    budgetExhausted,
    warnings,
  };
}

function invalidReset(warnings: string[], budgetExhausted: boolean, warning: string): ResolvedGitReset {
  return {
    mode: 'mixed',
    form: 'mode',
    selection: { kind: 'unknown' },
    updatesHead: false,
    recurseSubmodules: 'configured',
    completeness: 'invalid',
    exitsEarly: false,
    budgetExhausted,
    warnings: [...warnings, warning],
  };
}

function partialReset(warnings: string[], warning: string): ResolvedGitReset {
  return {
    mode: 'mixed',
    form: 'ambiguous',
    selection: { kind: 'unknown' },
    updatesHead: 'conditional',
    recurseSubmodules: 'configured',
    completeness: 'partial',
    exitsEarly: false,
    budgetExhausted: true,
    warnings: [...warnings, warning],
  };
}

function missingResetOperand(
  warnings: string[],
  budgetExhausted: boolean,
  option: string,
): ResolvedGitReset {
  return budgetExhausted
    ? partialReset(warnings, `git reset argument budget ended before the operand for ${option}`)
    : invalidReset(warnings, false, `${option} requires an operand`);
}

type ResetLongOptionResolution =
  | { kind: 'resolved'; name: ResetLongOptionName; attached: boolean; value?: string }
  | { kind: 'ambiguous'; option: string };

function resolveResetLongOption(arg: string): ResetLongOptionResolution | null {
  if (!arg.startsWith('--')) return null;
  const equals = arg.indexOf('=');
  const option = arg.slice(2, equals < 0 ? undefined : equals);
  const attached = equals >= 0;
  const value = attached ? arg.slice(equals + 1) : undefined;
  const exact = RESET_LONG_OPTIONS.find(candidate => candidate === option);
  if (exact) return { kind: 'resolved', name: exact, attached, value };
  const matches = RESET_LONG_OPTIONS.filter(candidate => candidate.startsWith(option));
  if (matches.length === 1) return { kind: 'resolved', name: matches[0], attached, value };
  if (matches.length > 1) return { kind: 'ambiguous', option: `--${option}` };
  return null;
}

type CleanLongOptionResolution =
  | { kind: 'resolved'; name: CleanLongOptionName; attached: boolean; value?: string }
  | { kind: 'ambiguous'; option: string };

function resolveCleanLongOption(arg: string): CleanLongOptionResolution | null {
  if (!arg.startsWith('--')) return null;
  const equals = arg.indexOf('=');
  const option = arg.slice(2, equals < 0 ? undefined : equals);
  const attached = equals >= 0;
  const value = attached ? arg.slice(equals + 1) : undefined;
  const exact = CLEAN_LONG_OPTIONS.find(candidate => candidate === option);
  if (exact) return { kind: 'resolved', name: exact, attached, value };
  const matches = CLEAN_LONG_OPTIONS.filter(candidate => candidate.startsWith(option));
  if (matches.length === 1) return { kind: 'resolved', name: matches[0], attached, value };
  if (matches.length > 1) return { kind: 'ambiguous', option: `--${option}` };
  return null;
}

function nonExecutingClean(warnings: string[], budgetExhausted: boolean): ResolvedGitClean {
  return {
    dryRun: true,
    force: 0,
    interactive: false,
    removeDirectories: false,
    ignoredMode: 'standard',
    selection: { kind: 'all' },
    completeness: 'complete',
    exitsEarly: true,
    budgetExhausted,
    warnings,
  };
}

function invalidClean(warnings: string[], budgetExhausted: boolean, warning: string): ResolvedGitClean {
  return {
    dryRun: false,
    force: 0,
    interactive: false,
    removeDirectories: false,
    ignoredMode: 'standard',
    selection: { kind: 'unknown' },
    completeness: 'invalid',
    exitsEarly: false,
    budgetExhausted,
    warnings: [...warnings, warning],
  };
}

function partialClean(warnings: string[], warning: string): ResolvedGitClean {
  return {
    dryRun: false,
    force: 0,
    interactive: false,
    removeDirectories: false,
    ignoredMode: 'standard',
    selection: { kind: 'unknown' },
    completeness: 'partial',
    exitsEarly: false,
    budgetExhausted: true,
    warnings: [...warnings, warning],
  };
}

function missingCleanOperand(
  warnings: string[],
  budgetExhausted: boolean,
  option: string,
): ResolvedGitClean {
  return budgetExhausted
    ? partialClean(warnings, `git clean argument budget ended before the operand for ${option}`)
    : invalidClean(warnings, false, `${option} requires an operand`);
}

function attachedLongOption(arg: string): { name: string; value: string } | null {
  if (!arg.startsWith('--')) return null;
  const equals = arg.indexOf('=');
  if (equals < 0) return null;
  return { name: arg.slice(0, equals), value: arg.slice(equals + 1) };
}

function validConfigEnv(value: string): boolean {
  const equals = value.indexOf('=');
  return equals > 0 && equals < value.length - 1;
}

function parseGitBoolean(value: string): boolean | null {
  const normalized = value.toLowerCase();
  if (normalized === '' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  const numeric = parseGitInt(value);
  return numeric === null ? null : numeric !== 0;
}

function validResetContextInteger(value: string): boolean {
  const parsed = parseGitInt(value);
  return parsed !== null && parsed >= -1;
}

function parseGitInt(value: string): number | null {
  const match = /^([+-]?[0-9]+)([kmg])?$/iu.exec(value);
  if (!match) return null;
  const factor = match[2] === undefined
    ? 1
    : match[2].toLowerCase() === 'k'
      ? 1024
      : match[2].toLowerCase() === 'm'
        ? 1024 * 1024
        : 1024 * 1024 * 1024;
  const parsed = Number(match[1]) * factor;
  return Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647
    ? parsed
    : null;
}

function positiveBudget(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_GIT_ARGS;
}

function normalizeCwd(cwd: string): string {
  return path.normalize(toPosix(cwd));
}

function resolveFrom(cwd: string, value: string): string {
  const normalized = toPosix(value);
  return path.normalize(isAbsolutePath(value) ? normalized : path.join(cwd, normalized));
}
