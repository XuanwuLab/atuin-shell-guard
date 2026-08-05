import type {
  GitEffectExecutionMode,
  GitEffectOperation,
  GitEffectRecoverability,
  GitEffectUncertaintyReason,
  GitStateEffectInput,
} from '../analysis/git-effects.js';
import type { ResourceEffectInput } from '../analysis/resource-effects.js';
import {
  resolveGitInvocation,
  resolveGitClean,
  resolveGitReset,
  type ResolvedGitClean,
  type GitResetMode,
  type ResolvedGitInvocation,
  type ResolvedGitReset,
} from './invocation.js';

export interface AnalyzeGitArgsOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  line: number;
  privileged: boolean;
  maxArgs?: number;
}

export interface GitArgsAnalysis {
  effects: GitStateEffectInput[];
  resourceEffects: ResourceEffectInput[];
  warnings: string[];
  invocation: ResolvedGitInvocation;
  reset?: ResolvedGitReset;
  clean?: ResolvedGitClean;
}

export function analyzeGitArgs(args: string[], options: AnalyzeGitArgsOptions): GitArgsAnalysis {
  const invocation = resolveGitInvocation(args, {
    cwd: options.cwd,
    env: options.env,
    maxArgs: options.maxArgs,
  });
  const warnings = [...invocation.warnings];
  if (invocation.completeness === 'invalid' || invocation.exitsEarly || invocation.queryOnly) {
    return { effects: [], resourceEffects: [], warnings, invocation };
  }

  if (invocation.subcommand === 'clean') {
    const clean = resolveGitClean(invocation.args, { maxArgs: options.maxArgs });
    warnings.push(...clean.warnings);
    if (clean.completeness === 'invalid' || clean.exitsEarly) {
      return { effects: [], resourceEffects: [], warnings, invocation, clean };
    }
    if (invocation.context.forcedBare && invocation.context.workTree === undefined) {
      warnings.push('git clean cannot update a known bare repository without a worktree');
      return { effects: [], resourceEffects: [], warnings, invocation, clean };
    }
    if (clean.dryRun && invocation.completeness === 'complete' && clean.completeness === 'complete') {
      return { effects: [], resourceEffects: [], warnings, invocation, clean };
    }
    return {
      effects: [],
      resourceEffects: [cleanResourceEffect(invocation, clean, options)],
      warnings,
      invocation,
      clean,
    };
  }

  if (invocation.subcommand !== 'reset') {
    return { effects: [], resourceEffects: [], warnings, invocation };
  }

  const reset = resolveGitReset(invocation.args, { maxArgs: options.maxArgs });
  warnings.push(...reset.warnings);
  if (reset.completeness === 'invalid' || reset.exitsEarly) {
    return { effects: [], resourceEffects: [], warnings, invocation, reset };
  }

  if (invocation.context.forcedBare && invocation.context.workTree === undefined
      && reset.mode !== 'soft' && reset.mode !== 'patch') {
    warnings.push(`git reset --${reset.mode} cannot update a known bare repository without a worktree`);
    return { effects: [], resourceEffects: [], warnings, invocation, reset };
  }

  if (invocation.budgetExhausted || reset.budgetExhausted) {
    return {
      effects: [makeEffect(invocation, reset, options, {
        domain: 'worktree',
        operation: 'discard',
        mode: 'unknown',
        recoverability: 'unknown',
        executionMode: 'conditional',
        uncertainty: ['argument-budget', 'unknown-repository-state'],
        completeness: 'partial',
      })],
      resourceEffects: [],
      warnings,
      invocation,
      reset,
    };
  }

  return {
    effects: resetEffects(invocation, reset, options),
    resourceEffects: [],
    warnings,
    invocation,
    reset,
  };
}

function cleanResourceEffect(
  invocation: ResolvedGitInvocation,
  clean: ResolvedGitClean,
  options: AnalyzeGitArgsOptions,
): ResourceEffectInput {
  const completeness = invocation.completeness === 'partial' || clean.completeness === 'partial'
    ? 'partial'
    : 'complete';
  const executionMode = clean.interactive
    ? 'interactive'
    : clean.force > 0
      ? 'definite'
      : 'config-dependent';
  const uncertainty: ResourceEffectInput['uncertainty'] = ['derived-selection'];
  if (executionMode === 'config-dependent') uncertainty.push('configuration-dependent');
  if (completeness === 'partial' || clean.selection.kind === 'unknown') uncertainty.push('unknown-selection');
  const pathspecs = clean.selection.kind === 'pathspecs' ? clean.selection.pathspecs ?? [] : [];
  return {
    domain: 'git-worktree',
    operation: 'delete',
    command: 'git clean',
    selection: {
      kind: clean.selection.kind === 'unknown' ? 'unknown' : 'derived',
      root: invocation.context.workTree ?? invocation.context.cwd,
      target: pathspecs.length === 1 ? pathspecs[0] : undefined,
    },
    executionMode,
    recoverability: 'none',
    completeness,
    privileged: options.privileged,
    line: options.line,
    uncertain: true,
    certainty: 'unknown',
    uncertainty,
  };
}

function resetEffects(
  invocation: ResolvedGitInvocation,
  reset: ResolvedGitReset,
  options: AnalyzeGitArgsOptions,
): GitStateEffectInput[] {
  const effects: GitStateEffectInput[] = [];
  const uncertainty = resetUncertainty(reset);
  const completeness = invocation.completeness === 'partial' || reset.completeness === 'partial'
    ? 'partial'
    : 'complete';
  const conditional = completeness === 'partial' || reset.form === 'ambiguous'
    || reset.form === 'pathspec-file';
  const add = (
    domain: GitStateEffectInput['domain'],
    operation: GitEffectOperation,
    recoverability: GitEffectRecoverability,
    executionMode: GitEffectExecutionMode = conditional ? 'conditional' : 'definite',
  ): void => {
    effects.push(makeEffect(invocation, reset, options, {
      domain,
      operation,
      mode: reset.mode,
      recoverability,
      executionMode,
      uncertainty,
      completeness,
    }));
  };

  if (reset.mode === 'patch') {
    add('index', 'replace', 'worktree-preserved', 'interactive');
    return effects;
  }

  if (reset.mode === 'soft') {
    if (reset.updatesHead !== false) add('local-ref', 'rewrite', 'reflog-or-orig-head');
    return effects;
  }

  if (reset.mode === 'mixed') {
    add('index', 'replace', 'worktree-preserved');
    if (reset.updatesHead !== false) add('local-ref', 'rewrite', 'reflog-or-orig-head');
    return effects;
  }

  add('index', 'replace', reset.mode === 'keep' ? 'worktree-preserved' : 'unknown');
  add(
    'worktree',
    reset.mode === 'hard' ? 'discard' : 'replace',
    reset.mode === 'keep' ? 'worktree-preserved' : 'unknown',
    'conditional',
  );
  if (reset.updatesHead !== false) add('local-ref', 'rewrite', 'reflog-or-orig-head');
  if (reset.recurseSubmodules === true) add('submodule', 'reset', 'unknown', 'conditional');
  return effects;
}

interface MakeEffectFields {
  domain: GitStateEffectInput['domain'];
  operation: GitEffectOperation;
  mode: GitStateEffectInput['mode'];
  recoverability: GitEffectRecoverability;
  executionMode: GitEffectExecutionMode;
  uncertainty: GitEffectUncertaintyReason[];
  completeness: GitStateEffectInput['completeness'];
}

function makeEffect(
  invocation: ResolvedGitInvocation,
  reset: ResolvedGitReset,
  options: AnalyzeGitArgsOptions,
  fields: MakeEffectFields,
): GitStateEffectInput {
  const uncertain = fields.executionMode !== 'definite' || fields.completeness === 'partial'
    || fields.uncertainty.length > 0;
  return {
    command: 'git reset',
    domain: fields.domain,
    operation: fields.operation,
    mode: fields.mode,
    selection: {
      ...reset.selection,
      pathspecs: reset.selection.pathspecs ? [...reset.selection.pathspecs] : undefined,
    },
    target: reset.target,
    repository: { ...invocation.context },
    recoverability: fields.recoverability,
    executionMode: fields.executionMode,
    completeness: fields.completeness,
    recurseSubmodules: reset.recurseSubmodules,
    privileged: options.privileged,
    line: options.line,
    uncertain,
    certainty: uncertain ? 'unknown' : 'exact',
    uncertainty: [...fields.uncertainty],
  };
}

function resetUncertainty(reset: ResolvedGitReset): GitEffectUncertaintyReason[] {
  const reasons: GitEffectUncertaintyReason[] = [];
  if (reset.form === 'ambiguous') reasons.push('ambiguous-revision-or-path');
  if (reset.form === 'pathspec-file') reasons.push('pathspec-file-contents');
  if (isWorktreeMode(reset.mode)) reasons.push('unknown-repository-state');
  return reasons;
}

function isWorktreeMode(mode: GitResetMode): boolean {
  return mode === 'hard' || mode === 'merge' || mode === 'keep';
}
