// index.ts — Public API

export type { Command, SimpleCommand, ForCommand, CaseCommand, WhileCommand,
  IfCommand, Connection, FunctionDef, GroupCommand, SubshellCommand,
  WordDesc, WordList, Redirect, RInstruction, PatternList,
} from './command.js';
export type { FileEffect, EffectType } from '../analysis/effects.js';
export type { GitStateEffect } from '../analysis/git-effects.js';
export type { ResourceEffect } from '../analysis/resource-effects.js';
export type {
  ProvenanceGraph,
  ProvenanceKind,
  ProvenanceNode,
} from '../analysis/provenance.js';
export { renderProvenance } from '../analysis/provenance.js';
export { print_command } from './print_cmd.js';
export type { IFS } from '../analysis/vfs.js';
export { VirtualFS, RealFS, toPosix, toNative, isAbsolutePath } from '../analysis/vfs.js';
export { postprocess } from '../analysis/postprocess.js';
export type {
  AffectedFile,
  PostProcessOptions,
  PostProcessResult,
  SpecialTargetObservation,
  MetadataUnavailableObservation,
} from '../analysis/postprocess.js';

import type { Command } from './command.js';
import type { FileEffect } from '../analysis/effects.js';
import type { GitStateEffect } from '../analysis/git-effects.js';
import type { ResourceEffect } from '../analysis/resource-effects.js';
import type { ProvenanceGraph } from '../analysis/provenance.js';
import { renderProvenance } from '../analysis/provenance.js';
import { EffectTracker } from '../analysis/effects.js';
import { VariableEnvironment } from './variables.js';
import { parse as doParse } from './parse.js';
import { execute_command_state } from './execute_cmd.js';
import { default_flags } from './flags.js';
import { makeAnalysisState } from '../analysis/state.js';
import type { IFS } from '../analysis/vfs.js';
import { VirtualFS, RealFS } from '../analysis/vfs.js';

export interface AnalyzeOptions {
  /** Working directory for resolving relative paths (required) */
  cwd: string;
  /** Pre-set environment variables (merged into defaults) */
  env?: Record<string, string>;
  /** Internal child-shell support; defaults to inheriting process.env. */
  inheritEnv?: boolean;
  /** Positional parameters ($1, $2, ...) */
  args?: string[];
  /** Virtual filesystem paths for glob expansion (trailing '/' = directory) */
  fs?: string[];
  /** Use real disk for glob expansion (read-only) */
  realFs?: boolean;
}

export interface AnalyzeResult {
  effects: FileEffect[];
  gitEffects: GitStateEffect[];
  resourceEffects: ResourceEffect[];
  warnings: string[];
  ast: Command | null;
  /** Bounded local explanation graph referenced by effect.provenance. */
  provenance: ProvenanceGraph;
}

export interface ExplainObservationOptions {
  maxNodes?: number;
  /** Use PostProcessResult.provenance to include filesystem-observation nodes. */
  provenance?: ProvenanceGraph;
}

/** Parse and dry-run execute a shell script, returning predicted file effects */
export function analyze(script: string, opts: AnalyzeOptions): AnalyzeResult {
  const envVars = { ...opts.env, PWD: opts.cwd };
  const env = new VariableEnvironment(envVars, opts.inheritEnv !== false);
  if (opts.args) {
    env.set_positional_params(opts.args);
  }

  const { ast, warnings } = doParse(script);
  let vfs: IFS | undefined;
  if (opts.fs) vfs = new VirtualFS(opts.fs);
  else if (opts.realFs) vfs = new RealFS();
  const tracker = new EffectTracker(opts.cwd, vfs);

  if (ast) {
    const flags = default_flags();
    execute_command_state(ast, makeAnalysisState(env, flags, tracker));
  }

  return {
    effects: tracker.effects,
    gitEffects: tracker.gitEffects,
    resourceEffects: tracker.resourceEffects,
    warnings: [...warnings, ...tracker.warnings],
    ast,
    provenance: tracker.getProvenanceGraph(),
  };
}

/** Render one predicted file effect and its bounded local explanation chain. */
export function explainEffect(
  result: AnalyzeResult,
  effectIndex: number,
  maxNodes?: number,
): string[] {
  const effect = result.effects[effectIndex];
  if (!effect) return [];
  const line = effect.line > 0 ? ` at line ${effect.line}` : '';
  return [
    `${effect.command}${line} predicts ${effect.type} ${effect.path}`,
    ...renderProvenance(
      result.provenance,
      effect.provenance ?? [],
      maxNodes,
    ),
  ];
}

/**
 * Follow a postprocess() file/special-target observation back to the effects
 * that selected it. Observation links are local and bounded.
 */
export function explainObservation(
  result: AnalyzeResult,
  observation: {
    effectIndex?: number;
    effectIndexes?: readonly number[];
    provenance?: readonly number[];
  },
  options?: number | ExplainObservationOptions,
): string[][] {
  const maxNodes = typeof options === 'number'
    ? options
    : options?.maxNodes;
  const observationGraph = typeof options === 'number'
    ? undefined
    : options?.provenance;
  if (observationGraph && observation.provenance?.length) {
    const rendered = renderProvenance(
      observationGraph,
      observation.provenance,
      maxNodes,
    );
    if (rendered.length > 0) return [rendered];
  }
  const indexes = observation.effectIndexes
    ?? (observation.effectIndex === undefined ? [] : [observation.effectIndex]);
  return [...new Set(indexes)]
    .filter(index => Number.isInteger(index) && index >= 0)
    .map(index => explainEffect(result, index, maxNodes))
    .filter(explanation => explanation.length > 0);
}

/** Parse a shell script into an AST without executing it */
export function parse(script: string): { ast: Command | null; warnings: string[] } {
  return doParse(script);
}
