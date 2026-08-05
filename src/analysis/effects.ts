// effects.ts — Side-effect types for dry-run tracking

import { posix as path } from 'node:path';
import type { IFS } from './vfs.js';
import { has_glob_chars, toPosix, isAbsolutePath } from './vfs.js';
import type {
  GitEffectUncertaintyReason,
  GitStateEffect,
  GitStateEffectInput,
} from './git-effects.js';
import type {
  ResourceEffect,
  ResourceEffectInput,
  ResourceEffectUncertaintyReason,
} from './resource-effects.js';
import {
  MAX_PROVENANCE_PARENTS,
  ProvenanceStore,
  type ProvenanceGraph,
  type ProvenanceKind,
  type ProvenanceNodeInput,
} from './provenance.js';

export type EffectType =
  | 'write' | 'append' | 'delete' | 'mkdir' | 'move'
  | 'copy' | 'chmod' | 'chown' | 'link' | 'truncate';

export type EffectCertainty = 'exact' | 'overapprox' | 'unknown';
export type ReplacementBehavior = 'replace' | 'conditional' | 'no-clobber';

export type UncertaintyReason =
  | 'unresolved-expansion'
  | 'glob-without-fs'
  | 'command-substitution'
  | 'unknown-loop-count'
  | 'uncertain-loop-values'
  | 'conditional-branch'
  | 'case-branch'
  | 'and-or-branch'
  | 'pipeline-race'
  | 'background-race'
  | 'state-widening'
  | 'unknown-command'
  | 'command-identity'
  | 'derived-path';

const PATH_UNCERTAINTY_REASONS = new Set<UncertaintyReason>([
  'unresolved-expansion',
  'glob-without-fs',
  'command-substitution',
  'derived-path',
  'state-widening',
]);

export interface FileEffect {
  type: EffectType;
  path: string;
  source?: string;       // for copy/move
  sourcePath?: string;   // resolved source path for analysis predicates
  line: number;
  command: string;       // "rm", ">", "cp", etc.
  replacement?: ReplacementBehavior; // normalized destination replacement semantics
  uncertain: boolean;    // true if path has unexpanded vars/globs
  certainty: EffectCertainty;
  uncertainty: UncertaintyReason[];
  /** Analysis-local roots in the AnalyzeResult provenance graph. */
  provenance?: number[];
}

export interface EffectInput {
  type: EffectType;
  path: string;
  source?: string;
  sourcePath?: string;
  line: number;
  command: string;
  replacement?: ReplacementBehavior;
  uncertain?: boolean;
  certainty?: EffectCertainty;
  uncertainty?: UncertaintyReason[];
  provenance?: number[];
}

export interface EffectCheckpoint {
  files: number;
  git: number;
  resources: number;
}

export interface EffectIdentitySets {
  files: Set<string>;
  git: Set<string>;
  resources: Set<string>;
}

export class EffectTracker {
  effects: FileEffect[] = [];
  gitEffects: GitStateEffect[] = [];
  resourceEffects: ResourceEffect[] = [];
  warnings: string[] = [];
  private cwd: string;
  private _vfs: IFS | null;
  private ephemeralPaths = new Set<string>();
  private intrinsicUncertainty = new WeakMap<object, Set<string>>();
  private provenanceStore = new ProvenanceStore();

  constructor(cwd: string, vfs?: IFS) {
    this.cwd = toPosix(cwd);
    this._vfs = vfs ?? null;
  }

  get vfs(): IFS | null {
    return this._vfs;
  }

  /** Replace the active branch overlay without changing accumulated effects. */
  setVfs(vfs: IFS | null): void {
    this._vfs = vfs;
  }

  /** Update the current working directory (when `cd` is simulated) */
  setCwd(newCwd: string): void {
    this.cwd = toPosix(newCwd);
  }

  getCwd(): string {
    return this.cwd;
  }

  /** Resolve a path against the current working directory (handles Windows drive paths) */
  resolvePath(p: string): string {
    const posix = toPosix(p);
    if (isAbsolutePath(p)) return path.normalize(posix);
    return path.normalize(path.join(this.cwd, posix));
  }

  isKnownDirectory(p: string): boolean {
    const resolved = this.resolvePath(p);
    if (this.vfs?.isDirectory(resolved)) return true;

    // cwd and its ancestors are known even without a filesystem snapshot.
    const prefix = resolved === '/' ? '/' : `${resolved}/`;
    return resolved === this.cwd || this.cwd.startsWith(prefix);
  }

  /**
   * Register a shell-created handle such as a process-substitution `/dev/fd`
   * path. Commands may read or write the handle, but it is not a user file
   * whose replacement belongs in the data-loss inventory.
   */
  registerEphemeralPath(p: string): string {
    const resolved = this.resolvePath(p);
    this.ephemeralPaths.add(resolved);
    return resolved;
  }

  isEphemeralPath(p: string): boolean {
    return this.ephemeralPaths.has(this.resolvePath(p));
  }

  addProvenance(input: ProvenanceNodeInput): number {
    return this.provenanceStore.add(this.withActiveProvenance(input));
  }

  withProvenance<T>(input: ProvenanceNodeInput, run: () => T): T {
    return this.provenanceStore.withNode(
      this.withActiveProvenance(input),
      run,
    );
  }

  getProvenanceGraph(): ProvenanceGraph {
    return this.provenanceStore.graph();
  }

  currentProvenance(): number[] {
    return this.provenanceStore.currentParents();
  }

  /** Check if a string contains unresolved expansions */
  static hasUncertainty(s: string): boolean {
    return EffectTracker.uncertaintyReasons(s).length > 0;
  }

  static uncertaintyReasons(s: string): UncertaintyReason[] {
    const reasons = new Set<UncertaintyReason>();
    if (/\$\(/.test(s) || /<\$\(/.test(s)) reasons.add('command-substitution');
    if (/\$[\w{(]/.test(s)) reasons.add('unresolved-expansion');
    if (has_glob_chars(s)) reasons.add('glob-without-fs');
    return [...reasons];
  }

  static hasPathUncertainty(effect: { uncertain?: boolean; uncertainty?: UncertaintyReason[] }): boolean {
    if (!effect.uncertain) return false;
    if (!effect.uncertainty) return true;
    return effect.uncertainty.some(reason => PATH_UNCERTAINTY_REASONS.has(reason));
  }

  add(
    effect: EffectInput,
    options: { updateVfs?: boolean } = {},
  ): void {
    const resolved = this.resolvePath(effect.path);
    if (this.ephemeralPaths.has(resolved)) return;
    const pathReasons = EffectTracker.uncertaintyReasons(effect.path);
    const uncertainty = [...new Set([...(effect.uncertainty ?? []), ...pathReasons])];
    const uncertain = effect.uncertain === true || uncertainty.length > 0;
    const certainty = effect.certainty ?? (uncertain ? 'unknown' : 'exact');
    const sourcePath = effect.sourcePath ?? (effect.source ? this.resolvePath(effect.source) : undefined);
    const modelNode = this.provenanceStore.add({
      kind: 'command-model',
      label: `${effect.command} predicts ${effect.type}`,
      line: effect.line,
      parents: effect.provenance && effect.provenance.length > 0
        ? effect.provenance
        : this.provenanceStore.currentParents(),
    });
    let provenance = [modelNode];
    const updatesVfs = this.vfs
      && !uncertain
      && options.updateVfs !== false
      && effectUpdatesVfs(effect.type);
    if (updatesVfs) {
      provenance = [this.provenanceStore.add({
        kind: 'vfs-transition',
        label: `${effect.type} ${resolved}`,
        line: effect.line,
        parents: provenance,
      })];
    }
    const tracked = {
      ...effect,
      path: resolved,
      sourcePath,
      uncertain,
      certainty,
      uncertainty,
      provenance,
    };
    this.attachUncertaintyProvenance(tracked, uncertainty);
    this.effects.push(tracked);
    this.rememberIntrinsicUncertainty(tracked, uncertainty);

    // Feed back into VFS so later globs see predicted changes
    if (this.vfs && !uncertain && options.updateVfs !== false) {
      const t = effect.type;
      if (t === 'write' || t === 'append' || t === 'copy' || t === 'link' || t === 'truncate') {
        this.vfs.addFile(resolved);
      } else if (t === 'mkdir') {
        this.vfs.addDirectory(resolved);
      } else if (t === 'delete') {
        this.vfs.remove(resolved);
      } else if (t === 'move') {
        if (sourcePath) this.vfs.remove(sourcePath);
        this.vfs.addFile(resolved);
      }
    }
  }

  addGit(effect: GitStateEffectInput): void {
    const uncertainty = [...new Set(effect.uncertainty ?? [])];
    const uncertain = effect.uncertain === true || uncertainty.length > 0 || effect.completeness === 'partial';
    const certainty = effect.certainty ?? (uncertain ? 'unknown' : 'exact');
    const tracked: GitStateEffect = {
      ...effect,
      kind: 'git',
      repository: { ...effect.repository },
      selection: {
        ...effect.selection,
        pathspecs: effect.selection.pathspecs ? [...effect.selection.pathspecs] : undefined,
      },
      uncertain,
      certainty,
      uncertainty,
      provenance: [this.provenanceStore.add({
        kind: 'command-model',
        label: `${effect.command} predicts ${effect.domain}/${effect.operation}`,
        line: effect.line,
        parents: effect.provenance && effect.provenance.length > 0
          ? effect.provenance
          : this.provenanceStore.currentParents(),
      })],
    };
    this.attachUncertaintyProvenance(tracked, uncertainty);
    this.gitEffects.push(tracked);
    this.rememberIntrinsicUncertainty(tracked, uncertainty);
  }

  addResource(effect: ResourceEffectInput): void {
    const uncertainty = [...new Set(effect.uncertainty ?? [])];
    const uncertain = effect.uncertain === true || uncertainty.length > 0 || effect.completeness === 'partial';
    const certainty = effect.certainty ?? (uncertain ? 'unknown' : 'exact');
    const tracked: ResourceEffect = {
      ...effect,
      kind: 'resource',
      selection: { ...effect.selection },
      uncertain,
      certainty,
      uncertainty,
      provenance: [this.provenanceStore.add({
        kind: 'command-model',
        label: `${effect.command} predicts ${effect.domain}/${effect.operation}`,
        line: effect.line,
        parents: effect.provenance && effect.provenance.length > 0
          ? effect.provenance
          : this.provenanceStore.currentParents(),
      })],
    };
    this.attachUncertaintyProvenance(tracked, uncertainty);
    this.resourceEffects.push(tracked);
    this.rememberIntrinsicUncertainty(tracked, uncertainty);
  }

  addWarning(msg: string): void {
    this.warnings.push(msg);
  }

  merge(other: EffectTracker): void {
    const provenanceIds = this.provenanceStore.importGraph(
      other.getProvenanceGraph(),
    );
    const remap = (roots: readonly number[] | undefined): number[] =>
      normalizeEffectProvenance((roots ?? [])
        .map(root => provenanceIds.get(root))
        .filter((root): root is number => root !== undefined));
    const files = other.effects.map(effect => ({
      ...effect,
      uncertainty: [...effect.uncertainty],
      provenance: remap(effect.provenance),
    }));
    const git = other.gitEffects.map(effect => ({
      ...effect,
      repository: { ...effect.repository },
      selection: {
        ...effect.selection,
        pathspecs: effect.selection.pathspecs
          ? [...effect.selection.pathspecs]
          : undefined,
      },
      uncertainty: [...effect.uncertainty],
      provenance: remap(effect.provenance),
    }));
    const resources = other.resourceEffects.map(effect => ({
      ...effect,
      selection: { ...effect.selection },
      uncertainty: [...effect.uncertainty],
      provenance: remap(effect.provenance),
    }));
    this.effects.push(...files);
    this.gitEffects.push(...git);
    this.resourceEffects.push(...resources);
    this.warnings.push(...other.warnings);
    for (const ephemeralPath of other.ephemeralPaths) {
      this.ephemeralPaths.add(ephemeralPath);
    }
    for (const [original, merged] of [
      ...other.effects.map((effect, index) => [effect, files[index]] as const),
      ...other.gitEffects.map((effect, index) => [effect, git[index]] as const),
      ...other.resourceEffects.map((effect, index) => [effect, resources[index]] as const),
    ]) {
      const intrinsic = other.intrinsicUncertainty.get(original);
      if (intrinsic) this.intrinsicUncertainty.set(merged, new Set(intrinsic));
    }
  }

  checkpoint(): EffectCheckpoint {
    return { files: this.effects.length, git: this.gitEffects.length, resources: this.resourceEffects.length };
  }

  markAllEffectsFrom(
    checkpoint: EffectCheckpoint,
    uncertainty: UncertaintyReason[],
    certainty: EffectCertainty = 'overapprox',
  ): void {
    this.markEffectsFrom(checkpoint.files, uncertainty, certainty, true);
    this.markGitEffectsFrom(checkpoint.git, uncertainty, certainty, true);
    this.markResourceEffectsFrom(checkpoint.resources, uncertainty, certainty, true);
  }

  markInheritedExecutionUncertaintyFrom(
    checkpoint: EffectCheckpoint,
    uncertainty: UncertaintyReason[],
    certainty: EffectCertainty = 'overapprox',
  ): void {
    this.markEffectsFrom(checkpoint.files, uncertainty, certainty, false);
    this.markGitEffectsFrom(checkpoint.git, uncertainty, certainty, false);
    this.markResourceEffectsFrom(checkpoint.resources, uncertainty, certainty, false);
  }

  markEffectsFrom(
    startIndex: number,
    uncertainty: UncertaintyReason[],
    certainty: EffectCertainty = 'overapprox',
    intrinsic = true,
  ): void {
    for (let i = startIndex; i < this.effects.length; i++) {
      const e = this.effects[i];
      const added = uncertainty.filter(reason => !e.uncertainty.includes(reason));
      e.uncertain = true;
      e.certainty = e.certainty === 'unknown' ? 'unknown' : certainty;
      e.uncertainty = [...new Set([...e.uncertainty, ...uncertainty])];
      this.attachUncertaintyProvenance(e, added);
      if (intrinsic) this.rememberIntrinsicUncertainty(e, uncertainty);
    }
  }

  markGitEffectsFrom(
    startIndex: number,
    uncertainty: GitEffectUncertaintyReason[],
    certainty: EffectCertainty = 'overapprox',
    intrinsic = true,
  ): void {
    for (let i = startIndex; i < this.gitEffects.length; i++) {
      const effect = this.gitEffects[i];
      const added = uncertainty.filter(reason => !effect.uncertainty.includes(reason));
      effect.uncertain = true;
      effect.certainty = effect.certainty === 'unknown' ? 'unknown' : certainty;
      effect.uncertainty = [...new Set([...effect.uncertainty, ...uncertainty])];
      this.attachUncertaintyProvenance(effect, added);
      if (intrinsic) this.rememberIntrinsicUncertainty(effect, uncertainty);
    }
  }

  markResourceEffectsFrom(
    startIndex: number,
    uncertainty: ResourceEffectUncertaintyReason[],
    certainty: EffectCertainty = 'overapprox',
    intrinsic = true,
  ): void {
    for (let i = startIndex; i < this.resourceEffects.length; i++) {
      const effect = this.resourceEffects[i];
      const added = uncertainty.filter(reason => !effect.uncertainty.includes(reason));
      effect.uncertain = true;
      effect.certainty = effect.certainty === 'unknown' ? 'unknown' : certainty;
      effect.uncertainty = [...new Set([...effect.uncertainty, ...uncertainty])];
      this.attachUncertaintyProvenance(effect, added);
      if (intrinsic) this.rememberIntrinsicUncertainty(effect, uncertainty);
    }
  }

  /**
   * A single AST operation can be reached through several abstract paths.
   * Effects are a may-happen set, so merge identical path witnesses produced
   * by that operation instead of presenting them as repeated executions.
   */
  deduplicateAllFrom(checkpoint: EffectCheckpoint): void {
    this.effects = deduplicateEffects(
      this.effects,
      checkpoint.files,
      this.intrinsicUncertainty,
      this.provenanceStore,
    );
    this.gitEffects = deduplicateEffects(
      this.gitEffects,
      checkpoint.git,
      this.intrinsicUncertainty,
      this.provenanceStore,
    );
    this.resourceEffects = deduplicateEffects(
      this.resourceEffects,
      checkpoint.resources,
      this.intrinsicUncertainty,
      this.provenanceStore,
    );
  }

  identitiesFrom(checkpoint: EffectCheckpoint): EffectIdentitySets {
    return {
      files: new Set(this.effects.slice(checkpoint.files).map(effectIdentityKey)),
      git: new Set(this.gitEffects.slice(checkpoint.git).map(effectIdentityKey)),
      resources: new Set(this.resourceEffects.slice(checkpoint.resources).map(effectIdentityKey)),
    };
  }

  removeExecutionUncertaintyFrom(
    checkpoint: EffectCheckpoint,
    identities: EffectIdentitySets,
    reasons: readonly UncertaintyReason[],
  ): void {
    const removable = new Set<string>(reasons);
    removeExecutionUncertainty(
      this.effects.slice(checkpoint.files),
      identities.files,
      removable,
      this.intrinsicUncertainty,
      this.provenanceStore,
    );
    removeExecutionUncertainty(
      this.gitEffects.slice(checkpoint.git),
      identities.git,
      removable,
      this.intrinsicUncertainty,
      this.provenanceStore,
    );
    removeExecutionUncertainty(
      this.resourceEffects.slice(checkpoint.resources),
      identities.resources,
      removable,
      this.intrinsicUncertainty,
      this.provenanceStore,
    );
  }

  private rememberIntrinsicUncertainty(
    effect: object,
    uncertainty: readonly string[],
  ): void {
    const existing = this.intrinsicUncertainty.get(effect) ?? new Set<string>();
    for (const reason of uncertainty) existing.add(reason);
    this.intrinsicUncertainty.set(effect, existing);
  }

  private attachUncertaintyProvenance(
    effect: { line: number; provenance?: number[] },
    uncertainty: readonly string[],
  ): void {
    let roots = effect.provenance ?? [];
    for (const reason of uncertainty) {
      roots = [this.provenanceStore.add({
        kind: provenanceKindForReason(reason),
        label: provenanceLabelForReason(reason),
        line: effect.line,
        parents: roots,
        reason,
      })];
    }
    effect.provenance = roots;
  }

  private withActiveProvenance(
    input: ProvenanceNodeInput,
  ): ProvenanceNodeInput {
    if (!input.parents) return input;
    return {
      ...input,
      parents: [
        ...this.provenanceStore.currentParents(),
        ...input.parents,
      ],
    };
  }
}

function deduplicateEffects<
  T extends {
    uncertain: boolean;
    certainty: EffectCertainty;
    uncertainty: readonly string[];
    provenance?: number[];
    line: number;
  },
>(
  effects: T[],
  startIndex: number,
  intrinsicUncertainty: WeakMap<object, Set<string>>,
  provenanceStore: ProvenanceStore,
): T[] {
  const prefix = effects.slice(0, startIndex);
  const unique = new Map<string, T>();
  for (const effect of effects.slice(startIndex)) {
    const key = effectIdentityKey(effect);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, effect);
      continue;
    }
    existing.uncertain ||= effect.uncertain;
    existing.certainty = joinEffectCertainty(existing.certainty, effect.certainty);
    existing.uncertainty = [...new Set([...existing.uncertainty, ...effect.uncertainty])];
    const existingRoots = normalizeEffectProvenance(existing.provenance ?? []);
    const incomingRoots = normalizeEffectProvenance(effect.provenance ?? []);
    const mergedRoots = normalizeEffectProvenance([
      ...(existing.provenance ?? []),
      ...(effect.provenance ?? []),
    ]);
    existing.provenance = sameProvenanceRoots(existingRoots, incomingRoots)
      ? mergedRoots
      : [provenanceStore.add({
        kind: 'state-join',
        label: 'merge equivalent predicted effect paths',
        line: existing.line,
        parents: mergedRoots,
      })];
    const mergedIntrinsic = new Set([
      ...(intrinsicUncertainty.get(existing) ?? []),
      ...(intrinsicUncertainty.get(effect) ?? effect.uncertainty),
    ]);
    intrinsicUncertainty.set(existing, mergedIntrinsic);
  }
  return [...prefix, ...unique.values()];
}

function effectIdentityKey(effect: object): string {
  return JSON.stringify({
    ...effect,
    uncertain: undefined,
    certainty: undefined,
    uncertainty: undefined,
    provenance: undefined,
  });
}

function removeExecutionUncertainty<
  T extends {
    uncertain: boolean;
    certainty: EffectCertainty;
    uncertainty: string[];
    provenance?: number[];
  },
>(
  effects: readonly T[],
  identities: ReadonlySet<string>,
  removable: ReadonlySet<string>,
  intrinsicUncertainty: WeakMap<object, Set<string>>,
  provenanceStore: ProvenanceStore,
): void {
  for (const effect of effects) {
    if (!identities.has(effectIdentityKey(effect))) continue;
    const intrinsic = intrinsicUncertainty.get(effect)
      ?? new Set(effect.uncertainty);
    const previousUncertainty = effect.uncertainty;
    effect.uncertainty = effect.uncertainty.filter(reason =>
      !removable.has(reason) || intrinsic.has(reason));
    const removed = new Set(
      previousUncertainty.filter(reason => !effect.uncertainty.includes(reason)),
    );
    if (removed.size > 0 && effect.provenance) {
      effect.provenance = provenanceStore.withoutReasons(
        effect.provenance,
        removed,
      );
    }
    if (effect.uncertainty.length === 0 && effect.certainty === 'overapprox') {
      effect.uncertain = false;
      effect.certainty = 'exact';
    }
  }
}

function effectUpdatesVfs(type: EffectType): boolean {
  return type === 'write'
    || type === 'append'
    || type === 'copy'
    || type === 'link'
    || type === 'truncate'
    || type === 'mkdir'
    || type === 'delete'
    || type === 'move';
}

function provenanceKindForReason(reason: string): ProvenanceKind {
  if (reason === 'state-widening') return 'state-join';
  if (reason === 'unresolved-expansion'
      || reason === 'command-substitution'
      || reason === 'derived-path'
      || reason === 'glob-without-fs') {
    return 'expansion';
  }
  if (reason === 'command-identity' || reason === 'unknown-command') {
    return 'command-model';
  }
  if (reason === 'pipeline-race' || reason === 'background-race') {
    return 'state-join';
  }
  return 'control-guard';
}

function provenanceLabelForReason(reason: string): string {
  return `precision widened: ${reason}`;
}

function normalizeEffectProvenance(ids: readonly number[]): number[] {
  return [...new Set(ids)]
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}

function sameProvenanceRoots(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length
    && left.every((id, index) => id === right[index]);
}

function joinEffectCertainty(
  left: EffectCertainty,
  right: EffectCertainty,
): EffectCertainty {
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  if (left === 'overapprox' || right === 'overapprox') return 'overapprox';
  return 'exact';
}
