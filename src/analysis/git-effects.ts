import type {
  GitRepositoryContext,
  GitResetMode,
  GitResetSelection,
  GitResolutionCompleteness,
} from '../git/invocation.js';
import type { EffectCertainty, UncertaintyReason } from './effects.js';

export type GitEffectDomain = 'index' | 'worktree' | 'local-ref' | 'submodule';
export type GitEffectOperation = 'replace' | 'discard' | 'rewrite' | 'reset';
export type GitEffectMode = GitResetMode | 'unknown';
export type GitEffectExecutionMode = 'definite' | 'conditional' | 'interactive';
export type GitEffectRecoverability =
  | 'worktree-preserved'
  | 'reflog-or-orig-head'
  | 'object-database'
  | 'unknown';
export type GitEffectUncertaintyReason = UncertaintyReason
  | 'ambiguous-revision-or-path'
  | 'unknown-repository-state'
  | 'pathspec-file-contents'
  | 'argument-budget';

export interface GitStateEffect {
  kind: 'git';
  command: 'git reset';
  domain: GitEffectDomain;
  operation: GitEffectOperation;
  mode: GitEffectMode;
  selection: GitResetSelection;
  target?: string;
  repository: GitRepositoryContext;
  recoverability: GitEffectRecoverability;
  executionMode: GitEffectExecutionMode;
  completeness: Exclude<GitResolutionCompleteness, 'invalid'>;
  recurseSubmodules: boolean | 'configured';
  privileged: boolean;
  line: number;
  uncertain: boolean;
  certainty: EffectCertainty;
  uncertainty: GitEffectUncertaintyReason[];
  /** Analysis-local roots in the analyzer provenance graph. */
  provenance?: number[];
}

export type GitStateEffectInput = Omit<GitStateEffect, 'kind' | 'uncertain' | 'certainty' | 'uncertainty'> & {
  uncertain?: boolean;
  certainty?: EffectCertainty;
  uncertainty?: GitEffectUncertaintyReason[];
};
