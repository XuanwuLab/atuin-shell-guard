import { EffectTracker, type FileEffect } from './effects.js';
import type { GitStateEffect } from './git-effects.js';
import type { ResourceEffect } from './resource-effects.js';
import {
  normalizeReasonCodes,
  RISK_REASON_CODES,
  type ReasonCode,
} from './risk-codes.js';
import {
  isCatastrophicPath,
  isSystemPath,
  isUnresolvedCatastrophicDelete,
} from './path-policy.js';

export interface PredicateOptions {
  platform?: string;
}

export function evaluateEffectPredicates(
  effects: FileEffect[] | undefined,
  opts?: PredicateOptions,
): ReasonCode[] {
  const platform = opts?.platform ?? process.platform;
  const reasonCodes: ReasonCode[] = [];

  for (const effect of effects ?? []) {
    if (EffectTracker.hasPathUncertainty(effect)) {
      if (effect.type === 'delete' && isUnresolvedCatastrophicDelete(effect.path, platform)) {
        reasonCodes.push(RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE);
      } else if (hasUnresolvedLocalPath(effect)) {
        reasonCodes.push(RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION);
      }
      continue;
    }

    if (effect.type === 'delete') {
      if (isCatastrophicPath(effect.path, platform)) {
        reasonCodes.push(RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION);
      } else if (!effect.uncertain && isSystemPath(effect.path, platform)) {
        reasonCodes.push(RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION);
      }
    }
  }

  return normalizeReasonCodes(reasonCodes);
}

export function evaluateGitEffectPredicates(
  effects: GitStateEffect[] | undefined,
): ReasonCode[] {
  const reasonCodes: ReasonCode[] = [];
  for (const effect of effects ?? []) {
    if (effect.command !== 'git reset' || effect.domain !== 'worktree') continue;
    if (effect.mode === 'hard' || effect.mode === 'merge' || effect.mode === 'keep' || effect.mode === 'unknown') {
      reasonCodes.push(RISK_REASON_CODES.GIT_WORKTREE_DISCARD);
    }
  }
  return normalizeReasonCodes(reasonCodes);
}

export function evaluateResourceEffectPredicates(
  effects: ResourceEffect[] | undefined,
): ReasonCode[] {
  const reasonCodes: ReasonCode[] = [];
  for (const effect of effects ?? []) {
    switch (effect.domain) {
      case 'git-worktree':
        reasonCodes.push(RISK_REASON_CODES.GIT_WORKTREE_DISCARD);
        break;
      case 'local-filesystem-selection':
        reasonCodes.push(RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION);
        break;
      case 'docker-volume':
      case 'kubernetes':
      case 'helm':
      case 'terraform':
        reasonCodes.push(RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION);
        break;
      case 'container-bind-mount':
        reasonCodes.push(RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE);
        break;
    }
  }
  return normalizeReasonCodes(reasonCodes);
}

export function hasUnresolvedLocalPath(effect: FileEffect): boolean {
  if (!['delete', 'write', 'truncate', 'copy', 'move', 'link'].includes(effect.type)) return false;
  return effect.uncertainty.some(item =>
    item === 'unresolved-expansion'
    || item === 'glob-without-fs'
    || item === 'command-substitution'
    || item === 'derived-path');
}
