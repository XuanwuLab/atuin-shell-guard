// postprocess.ts — Observe pre-command local data threatened by predicted effects
//
// The analyzer predicts operations. This module resolves exact destructive
// targets against the real filesystem, without changing it, and produces the
// bounded metadata inventory consumed by policy.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type {
  EffectType,
  FileEffect,
  ReplacementBehavior,
} from './effects.js';
import { EffectTracker } from './effects.js';
import { isCatastrophicPath } from './path-policy.js';
import {
  MAX_PROVENANCE_LABEL_CHARS,
  MAX_PROVENANCE_NODES,
  MAX_PROVENANCE_PARENTS,
  ProvenanceStore,
  type ProvenanceGraph,
} from './provenance.js';
import { toNative } from './vfs.js';

type PostProcessEffect = Pick<FileEffect, 'type' | 'path' | 'uncertain'> & Partial<FileEffect>;

export type DestructiveMode =
  | 'delete-entry'
  | 'replace-content'
  | 'truncate-content'
  | 'replace-destination';

export type TargetKind =
  | 'regular-file'
  | 'directory'
  | 'symlink'
  | 'character-device'
  | 'block-device'
  | 'fifo'
  | 'socket'
  | 'other';

export type ExecutionCertainty = 'definite' | 'conditional';

export interface DestructiveTarget {
  effectIndex: number;
  effectType: EffectType;
  path: string;
  mode: DestructiveMode;
  executionCertainty: ExecutionCertainty;
}

export interface AffectedFile {
  path: string;
  createdAt: Date;
  modifiedAt: Date;
  size: number;
  operations: DestructiveMode[];
  executionCertainty: ExecutionCertainty;
  disposable: boolean;
  /** Bounded indexes into the FileEffect array passed to postprocess(). */
  effectIndexes: number[];
  effectIndexesTruncated: boolean;
  /** Roots in PostProcessResult.provenance when observation tracing is enabled. */
  provenance?: number[];
}

export interface ExtensionGroup {
  extension: string;
  files: AffectedFile[];       // bounded factual samples
  policyFiles: AffectedFile[]; // bounded non-disposable samples
  totalCount: number;
  totalSize: number;
  policyCount: number;
  policySize: number;
  definitePolicyCount: number;
  definitePolicySize: number;
  conditionalPolicyCount: number;
  conditionalPolicySize: number;
  disposable: boolean;
}

export interface SpecialTargetObservation {
  effectIndex: number;
  path: string;
  kind: TargetKind;
  operation: DestructiveMode;
  executionCertainty: ExecutionCertainty;
  safeSink: boolean;
  provenance?: number[];
}

export interface MetadataUnavailableObservation {
  effectIndex: number;
  path: string;
  operation: DestructiveMode;
  executionCertainty: ExecutionCertainty;
  error: string;
  provenance?: number[];
}

export interface PostProcessResult {
  groups: ExtensionGroup[];
  oldest: AffectedFile[];
  largest: AffectedFile[];
  policyOldest: AffectedFile[];
  policyLargest: AffectedFile[];
  definitePolicyOldest: AffectedFile[];
  conditionalPolicyOldest: AffectedFile[];
  totalFileCount: number;
  totalSize: number;
  policyFileCount: number;
  policyTotalSize: number;
  definitePolicyFileCount: number;
  definitePolicyTotalSize: number;
  conditionalPolicyFileCount: number;
  conditionalPolicyTotalSize: number;
  specialTargets: SpecialTargetObservation[];
  metadataUnavailable: MetadataUnavailableObservation[];
  visitedEntries: number;
  maxDepthReached: number;
  budgetExhausted: boolean;
  budgetExhaustedCertainty?: ExecutionCertainty;
  /** Analyze graph extended with bounded filesystem-observation nodes. */
  provenance?: ProvenanceGraph;
}

export interface PostProcessOptions {
  maxFiles?: number;
  maxVisitedEntries?: number;
  maxDepth?: number;
  maxElapsedMs?: number;
  clock?: () => number;
  /** Graph corresponding to the supplied effects; enables local observation tracing. */
  provenance?: ProvenanceGraph;
}

interface MutableAffectedFile extends Omit<AffectedFile, 'operations'> {
  operations: Set<DestructiveMode>;
  effectIndexes: number[];
}

interface WalkBudget {
  startedAt: number;
  maxFiles: number;
  maxVisitedEntries: number;
  maxDepth: number;
  maxElapsedMs: number;
  clock: () => number;
  visitedEntries: number;
  maxDepthReached: number;
  exhausted: boolean;
  exhaustedCertainty?: ExecutionCertainty;
  provenance?: ObservationProvenanceContext;
}

interface ObservationProvenanceContext {
  store: ProvenanceStore;
  effectRoots: number[][];
}

const MAX_FILES = 10000;
const MAX_VISITED_ENTRIES = 20000;
const MAX_DEPTH = 128;
const MAX_WALK_ELAPSED_MS = 2000;
const MAX_PER_GROUP = 10;
const MAX_OBSERVATIONS = 50;
const MAX_EFFECT_INDEXES_PER_OBSERVATION = 8;
const DISPOSABLE_DIRS = new Set(['node_modules', '.git']);
const FILE_EXTENSION_IGNORE_LIST = new Set([
  // Churny generated files remain factual observations but are excluded from
  // the initial policy counters to preserve the existing threshold policy.
  'tmp', 'temp', 'log', 'lock', 'pid', 'sock', 'swp', 'swo', 'swn', 'part', 'cache',
  'bak', 'old', 'orig', 'rej',
  'pyc', 'pyo', 'class',
  'o', 'obj', 'lo', 'd', 'map',
  'exe', 'dll', 'lib', 'so', 'dylib', 'a', 'la',
  'pdb', 'ilk', 'exp', 'idb', 'ipdb',
]);
/**
 * Inspect exact pre-command targets whose contents or destination entries may
 * be destroyed. No command is executed and no filesystem state is changed.
 */
export function postprocess(
  effects: PostProcessEffect[],
  options: PostProcessOptions = {},
): PostProcessResult {
  const files = new Map<string, MutableAffectedFile>();
  const specialTargets: SpecialTargetObservation[] = [];
  const metadataUnavailable: MetadataUnavailableObservation[] = [];
  const budget: WalkBudget = {
    startedAt: (options.clock ?? Date.now)(),
    maxFiles: boundedOption(options.maxFiles, MAX_FILES),
    maxVisitedEntries: boundedOption(options.maxVisitedEntries, MAX_VISITED_ENTRIES),
    maxDepth: boundedOption(options.maxDepth, MAX_DEPTH),
    maxElapsedMs: boundedOption(options.maxElapsedMs, MAX_WALK_ELAPSED_MS),
    clock: options.clock ?? Date.now,
    visitedEntries: 0,
    maxDepthReached: 0,
    exhausted: false,
    provenance: makeObservationProvenance(effects, options.provenance),
  };

  const targets = selectDestructiveTargets(effects);
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const target = targets[targetIndex];
    if (target.mode === 'delete-entry' && isCatastrophicPath(target.path)) continue;
    if (!consumeVisitBudget(budget, files.size, target.executionCertainty)) {
      if (targets.slice(targetIndex + 1).some(item => item.executionCertainty === 'definite')) {
        markBudgetExhausted(budget, 'definite');
      }
      break;
    }
    observeTarget(target, files, specialTargets, metadataUnavailable, budget);
    if (budget.exhausted) {
      if (targets.slice(targetIndex + 1).some(item => item.executionCertainty === 'definite')) {
        markBudgetExhausted(budget, 'definite');
      }
      break;
    }
  }

  const found = [...files.values()].map(finalizeAffectedFile);
  const policyFiles = found.filter(file => !file.disposable);
  const definitePolicyFiles = policyFiles.filter(file => file.executionCertainty === 'definite');
  const conditionalPolicyFiles = policyFiles.filter(file => file.executionCertainty === 'conditional');
  const groups = groupByExtension(found);
  const totalSize = sumSizes(found);
  const policyTotalSize = sumSizes(policyFiles);

  return {
    groups,
    oldest: oldest(found),
    largest: largest(found),
    policyOldest: oldest(policyFiles),
    policyLargest: largest(policyFiles),
    definitePolicyOldest: oldest(definitePolicyFiles),
    conditionalPolicyOldest: oldest(conditionalPolicyFiles),
    totalFileCount: found.length,
    totalSize,
    policyFileCount: policyFiles.length,
    policyTotalSize,
    definitePolicyFileCount: definitePolicyFiles.length,
    definitePolicyTotalSize: sumSizes(definitePolicyFiles),
    conditionalPolicyFileCount: conditionalPolicyFiles.length,
    conditionalPolicyTotalSize: sumSizes(conditionalPolicyFiles),
    specialTargets,
    metadataUnavailable,
    visitedEntries: budget.visitedEntries,
    maxDepthReached: budget.maxDepthReached,
    budgetExhausted: budget.exhausted,
    budgetExhaustedCertainty: budget.exhaustedCertainty,
    ...(budget.provenance
      ? { provenance: budget.provenance.store.graph() }
      : {}),
  };
}

function makeObservationProvenance(
  effects: readonly PostProcessEffect[],
  graph: ProvenanceGraph | undefined,
): ObservationProvenanceContext | undefined {
  if (!graph || !isBoundedProvenanceGraph(graph)) return undefined;
  const store = new ProvenanceStore();
  const remapped = store.importGraph(graph);
  return {
    store,
    effectRoots: effects.map(effect =>
      normalizeProvenance((effect.provenance ?? [])
        .map(root => remapped.get(root))
        .filter((root): root is number => root !== undefined))),
  };
}

function isBoundedProvenanceGraph(graph: ProvenanceGraph): boolean {
  return graph.nodes.length <= MAX_PROVENANCE_NODES
    && graph.nodes.every(node =>
      Number.isInteger(node.id)
      && node.id >= 0
      && node.label.length <= MAX_PROVENANCE_LABEL_CHARS
      && (node.reason === undefined
        || node.reason.length <= MAX_PROVENANCE_LABEL_CHARS)
      && node.parents.length <= MAX_PROVENANCE_PARENTS
      && node.parents.every(parent =>
        Number.isInteger(parent) && parent >= 0));
}

export function selectDestructiveTargets(effects: PostProcessEffect[]): DestructiveTarget[] {
  const targets: DestructiveTarget[] = [];
  const targetIndexes = new Map<string, number>();
  for (let effectIndex = 0; effectIndex < effects.length; effectIndex++) {
    const effect = effects[effectIndex];
    if (EffectTracker.hasPathUncertainty(effect)) continue;
    const target = destructiveTarget(effect, effectIndex);
    if (!target) continue;
    const targetKey = `${target.mode}\0${target.effectType}\0${target.path}`;
    const existingIndex = targetIndexes.get(targetKey);
    if (existingIndex !== undefined) {
      if (target.executionCertainty === 'definite') {
        targets[existingIndex].executionCertainty = 'definite';
      }
      continue;
    }
    targetIndexes.set(targetKey, targets.length);
    targets.push(target);
  }
  return targets;
}

function destructiveTarget(effect: PostProcessEffect, effectIndex: number): DestructiveTarget | null {
  const replacement = replacementBehavior(effect);
  const executionCertainty = effectExecutionCertainty(effect, replacement);
  switch (effect.type) {
    case 'delete':
      return { effectIndex, effectType: effect.type, path: effect.path, mode: 'delete-entry', executionCertainty };
    case 'write':
      if (replacement === 'no-clobber') return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: 'replace-content', executionCertainty };
    case 'truncate':
      if (replacement === 'no-clobber') return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: 'truncate-content', executionCertainty };
    case 'copy':
    case 'move':
      if (replacement === 'no-clobber') return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: 'replace-destination', executionCertainty };
    case 'link':
      if (replacement !== 'replace' && replacement !== 'conditional') return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: 'replace-destination', executionCertainty };
    default:
      return null;
  }
}

function replacementBehavior(effect: PostProcessEffect): ReplacementBehavior {
  if (effect.replacement) return effect.replacement;
  return effect.type === 'link' ? 'no-clobber' : 'replace';
}

function effectExecutionCertainty(
  effect: PostProcessEffect,
  replacement: ReplacementBehavior,
): ExecutionCertainty {
  if (replacement === 'conditional') return 'conditional';
  if (effect.uncertain) return 'conditional';
  return 'definite';
}

function observeTarget(
  target: DestructiveTarget,
  files: Map<string, MutableAffectedFile>,
  specialTargets: SpecialTargetObservation[],
  metadataUnavailable: MetadataUnavailableObservation[],
  budget: WalkBudget,
): void {
  const nativePath = toNative(target.path);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(nativePath);
  } catch (error: unknown) {
    recordMetadataError(
      nativePath,
      target,
      error,
      metadataUnavailable,
      budget.provenance,
    );
    return;
  }

  if (lstat.isSymbolicLink()) {
    if (followsDestination(target.effectType, target.mode)) {
      let followed: fs.Stats;
      try {
        followed = fs.statSync(nativePath);
      } catch (error: unknown) {
        if (!isMissingError(error)) {
          recordMetadataError(
            nativePath,
            target,
            error,
            metadataUnavailable,
            budget.provenance,
          );
        }
        return;
      }
      observeStat(nativePath, followed, target, files, specialTargets, metadataUnavailable, budget);
      return;
    }
    recordSpecial(
      nativePath,
      'symlink',
      target,
      specialTargets,
      false,
      budget.provenance,
    );
    return;
  }

  observeStat(nativePath, lstat, target, files, specialTargets, metadataUnavailable, budget);
}

function followsDestination(effectType: EffectType, mode: DestructiveMode): boolean {
  return mode === 'replace-content'
    || mode === 'truncate-content'
    || (mode === 'replace-destination' && effectType === 'copy');
}

function observeStat(
  path: string,
  stat: fs.Stats,
  target: DestructiveTarget,
  files: Map<string, MutableAffectedFile>,
  specialTargets: SpecialTargetObservation[],
  metadataUnavailable: MetadataUnavailableObservation[],
  budget: WalkBudget,
): void {
  const kind = targetKind(stat);
  if (kind === 'regular-file') {
    addAffectedFile(
      path,
      stat,
      target.mode,
      target.executionCertainty,
      target.effectIndex,
      files,
      budget,
    );
    return;
  }
  if (kind === 'directory') {
    if (target.mode === 'delete-entry') {
      recordSpecial(
        path,
        kind,
        target,
        specialTargets,
        false,
        budget.provenance,
      );
      walkDeletedDirectory(path, target, files, specialTargets, metadataUnavailable, budget, 0);
    } else {
      recordSpecial(
        path,
        kind,
        target,
        specialTargets,
        false,
        budget.provenance,
      );
    }
    return;
  }
  recordSpecial(
    path,
    kind,
    target,
    specialTargets,
    target.mode !== 'delete-entry' && isKnownNullSink(path, kind),
    budget.provenance,
  );
}

function walkDeletedDirectory(
  dir: string,
  target: DestructiveTarget,
  files: Map<string, MutableAffectedFile>,
  specialTargets: SpecialTargetObservation[],
  metadataUnavailable: MetadataUnavailableObservation[],
  budget: WalkBudget,
  depth: number,
): void {
  if (budget.exhausted) return;
  budget.maxDepthReached = Math.max(budget.maxDepthReached, depth);
  if (depth >= budget.maxDepth) {
    markBudgetExhausted(budget, target.executionCertainty);
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error: unknown) {
    recordMetadataError(
      dir,
      target,
      error,
      metadataUnavailable,
      budget.provenance,
    );
    return;
  }

  for (const entry of entries) {
    if (!consumeVisitBudget(budget, files.size, target.executionCertainty)) return;
    const full = nodePath.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch (error: unknown) {
      recordMetadataError(
        full,
        target,
        error,
        metadataUnavailable,
        budget.provenance,
      );
      continue;
    }

    const kind = targetKind(stat);
    if (kind === 'regular-file') {
      addAffectedFile(
        full,
        stat,
        target.mode,
        target.executionCertainty,
        target.effectIndex,
        files,
        budget,
      );
    } else if (kind === 'directory') {
      walkDeletedDirectory(full, target, files, specialTargets, metadataUnavailable, budget, depth + 1);
    } else {
      recordSpecial(
        full,
        kind,
        target,
        specialTargets,
        false,
        budget.provenance,
      );
    }
    if (budget.exhausted) return;
  }
}

function consumeVisitBudget(
  budget: WalkBudget,
  fileCount: number,
  executionCertainty: ExecutionCertainty,
): boolean {
  if (budget.visitedEntries >= budget.maxVisitedEntries
      || fileCount >= budget.maxFiles
      || budget.clock() - budget.startedAt >= budget.maxElapsedMs) {
    markBudgetExhausted(budget, executionCertainty);
    return false;
  }
  budget.visitedEntries++;
  return true;
}

function addAffectedFile(
  path: string,
  stat: fs.Stats,
  operation: DestructiveMode,
  executionCertainty: ExecutionCertainty,
  effectIndex: number,
  files: Map<string, MutableAffectedFile>,
  budget: WalkBudget,
): void {
  if (files.size >= budget.maxFiles) {
    markBudgetExhausted(budget, executionCertainty);
    return;
  }
  const provenance = recordFilesystemObservation(
    budget.provenance,
    effectIndex,
    `observed regular file for ${operation}: ${path} (${stat.size} bytes)`,
  );
  const existing = files.get(path);
  if (existing) {
    existing.operations.add(operation);
    if (executionCertainty === 'definite') existing.executionCertainty = 'definite';
    if (!existing.effectIndexes.includes(effectIndex)) {
      if (existing.effectIndexes.length < MAX_EFFECT_INDEXES_PER_OBSERVATION) {
        existing.effectIndexes.push(effectIndex);
        existing.effectIndexes.sort((left, right) => left - right);
      } else {
        existing.effectIndexesTruncated = true;
      }
    }
    existing.provenance = normalizeProvenance([
      ...(existing.provenance ?? []),
      ...optionalProvenance(provenance),
    ]);
    return;
  }
  const createdAt = stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
  files.set(path, {
    path,
    createdAt,
    modifiedAt: stat.mtime,
    size: stat.size,
    operations: new Set([operation]),
    executionCertainty,
    disposable: isDisposableAffectedFile(path),
    effectIndexes: [effectIndex],
    effectIndexesTruncated: false,
    ...(provenance === undefined ? {} : { provenance: [provenance] }),
  });
}

function markBudgetExhausted(budget: WalkBudget, executionCertainty: ExecutionCertainty): void {
  budget.exhausted = true;
  if (budget.exhaustedCertainty !== 'definite') {
    budget.exhaustedCertainty = executionCertainty;
  }
}

function finalizeAffectedFile(file: MutableAffectedFile): AffectedFile {
  return {
    ...file,
    operations: [...file.operations].sort(),
  };
}

function recordSpecial(
  path: string,
  kind: TargetKind,
  target: DestructiveTarget,
  observations: SpecialTargetObservation[],
  safeSink: boolean,
  provenanceContext: ObservationProvenanceContext | undefined,
): void {
  const existing = observations.find(item =>
    item.path === path
    && item.kind === kind
    && item.operation === target.mode
    && item.executionCertainty === target.executionCertainty);
  if (existing) {
    const provenance = recordFilesystemObservation(
      provenanceContext,
      target.effectIndex,
      `observed ${kind} for ${target.mode}: ${path}`,
    );
    existing.provenance = normalizeProvenance([
      ...(existing.provenance ?? []),
      ...optionalProvenance(provenance),
    ]);
    return;
  }

  let replaceIndex = -1;
  if (observations.length >= MAX_OBSERVATIONS) {
    if (kind !== 'block-device'
        || target.executionCertainty !== 'definite') {
      return;
    }
    replaceIndex = observations.findIndex(item =>
      item.kind !== 'block-device'
      || item.executionCertainty !== 'definite');
    if (replaceIndex < 0) return;
  }

  const provenance = recordFilesystemObservation(
    provenanceContext,
    target.effectIndex,
    `observed ${kind} for ${target.mode}: ${path}`,
  );
  const observation: SpecialTargetObservation = {
    effectIndex: target.effectIndex,
    path,
    kind,
    operation: target.mode,
    executionCertainty: target.executionCertainty,
    safeSink,
    ...(provenance === undefined ? {} : { provenance: [provenance] }),
  };
  if (observations.length < MAX_OBSERVATIONS) {
    observations.push(observation);
    return;
  }

  // Preserve raw block-device evidence even when lower-severity observations
  // have filled the reporting sample.
  observations[replaceIndex] = observation;
}

function recordMetadataError(
  path: string,
  target: DestructiveTarget,
  error: unknown,
  observations: MetadataUnavailableObservation[],
  provenanceContext: ObservationProvenanceContext | undefined,
): void {
  if (isMissingError(error) || observations.length >= MAX_OBSERVATIONS) return;
  const message = errorMessage(error);
  const provenance = recordFilesystemObservation(
    provenanceContext,
    target.effectIndex,
    `metadata unavailable for ${target.mode}: ${path} (${message})`,
  );
  observations.push({
    effectIndex: target.effectIndex,
    path,
    operation: target.mode,
    executionCertainty: target.executionCertainty,
    error: message,
    ...(provenance === undefined ? {} : { provenance: [provenance] }),
  });
}

function recordFilesystemObservation(
  context: ObservationProvenanceContext | undefined,
  effectIndex: number,
  label: string,
): number | undefined {
  if (!context) return undefined;
  return context.store.add({
    kind: 'filesystem-observation',
    label,
    parents: context.effectRoots[effectIndex] ?? [],
  });
}

function optionalProvenance(id: number | undefined): number[] {
  return id === undefined ? [] : [id];
}

function normalizeProvenance(ids: readonly number[]): number[] {
  return [...new Set(ids)]
    .filter(id => Number.isInteger(id) && id >= 0)
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}

function targetKind(stat: fs.Stats): TargetKind {
  if (stat.isFile()) return 'regular-file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'other';
}

function isKnownNullSink(path: string, kind: TargetKind): boolean {
  if (kind !== 'character-device' || process.platform === 'win32') return false;
  if (nodePath.normalize(path) === '/dev/null') return true;
  try {
    return nodePath.normalize(fs.realpathSync(path)) === '/dev/null';
  } catch {
    return false;
  }
}

function isMissingError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isDisposableAffectedFile(path: string): boolean {
  const ext = nodePath.extname(path).slice(1).toLowerCase();
  if (FILE_EXTENSION_IGNORE_LIST.has(ext)) return true;
  return path.split(/[\\/]+/).some(segment => DISPOSABLE_DIRS.has(segment));
}

function groupByExtension(found: AffectedFile[]): ExtensionGroup[] {
  const groups = new Map<string, {
    files: AffectedFile[];
    policyFiles: AffectedFile[];
    totalCount: number;
    totalSize: number;
    policyCount: number;
    policySize: number;
    definitePolicyCount: number;
    definitePolicySize: number;
    conditionalPolicyCount: number;
    conditionalPolicySize: number;
  }>();
  for (const file of found) {
    const extension = nodePath.extname(file.path) || '(no ext)';
    let group = groups.get(extension);
    if (!group) {
      group = {
        files: [],
        policyFiles: [],
        totalCount: 0,
        totalSize: 0,
        policyCount: 0,
        policySize: 0,
        definitePolicyCount: 0,
        definitePolicySize: 0,
        conditionalPolicyCount: 0,
        conditionalPolicySize: 0,
      };
      groups.set(extension, group);
    }
    group.totalCount++;
    group.totalSize += file.size;
    if (group.files.length < MAX_PER_GROUP) group.files.push(file);
    if (!file.disposable) {
      group.policyCount++;
      group.policySize += file.size;
      if (file.executionCertainty === 'definite') {
        group.definitePolicyCount++;
        group.definitePolicySize += file.size;
      } else {
        group.conditionalPolicyCount++;
        group.conditionalPolicySize += file.size;
      }
      if (group.policyFiles.length < MAX_PER_GROUP) group.policyFiles.push(file);
    }
  }

  return [...groups].map(([extension, group]) => ({
    extension,
    ...group,
    disposable: group.policyCount === 0,
  })).sort((a, b) => b.totalSize - a.totalSize);
}

function sumSizes(files: AffectedFile[]): number {
  let total = 0;
  for (const file of files) total += file.size;
  return total;
}

function oldest(files: AffectedFile[]): AffectedFile[] {
  return [...files]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, MAX_PER_GROUP);
}

function largest(files: AffectedFile[]): AffectedFile[] {
  return [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_PER_GROUP);
}

function boundedOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
