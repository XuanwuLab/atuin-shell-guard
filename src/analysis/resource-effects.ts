import type { EffectCertainty, UncertaintyReason } from './effects.js';

export type ResourceEffectDomain =
  | 'local-filesystem-selection'
  | 'git-worktree'
  | 'docker-volume'
  | 'container-bind-mount'
  | 'kubernetes'
  | 'helm'
  | 'terraform';

export type ResourceEffectOperation = 'delete' | 'destroy' | 'uninstall' | 'expose';
export type ResourceEffectExecutionMode = 'definite' | 'conditional' | 'interactive' | 'config-dependent';
export type ResourceEffectRecoverability = 'none' | 'domain-dependent' | 'unknown';
export type ResourceEffectCompleteness = 'complete' | 'partial';
export type ResourceSelectionKind = 'derived' | 'stdin' | 'named' | 'unknown';

export type ResourceEffectUncertaintyReason = UncertaintyReason
  | 'derived-selection'
  | 'stdin-selection'
  | 'unknown-selection'
  | 'configuration-dependent'
  | 'external-resource-state';

export interface ResourceSelection {
  kind: ResourceSelectionKind;
  root?: string;
  target?: string;
}

/**
 * A destructive operation whose selected local paths or external resources
 * cannot be represented soundly as exact FileEffect paths.
 */
export interface ResourceEffect {
  kind: 'resource';
  domain: ResourceEffectDomain;
  operation: ResourceEffectOperation;
  command: string;
  selection: ResourceSelection;
  executionMode: ResourceEffectExecutionMode;
  recoverability: ResourceEffectRecoverability;
  completeness: ResourceEffectCompleteness;
  privileged: boolean;
  line: number;
  uncertain: boolean;
  certainty: EffectCertainty;
  uncertainty: ResourceEffectUncertaintyReason[];
  /** Analysis-local roots in the analyzer provenance graph. */
  provenance?: number[];
}

export type ResourceEffectInput = Omit<ResourceEffect, 'kind' | 'uncertain' | 'certainty' | 'uncertainty'> & {
  uncertain?: boolean;
  certainty?: EffectCertainty;
  uncertainty?: ResourceEffectUncertaintyReason[];
};
