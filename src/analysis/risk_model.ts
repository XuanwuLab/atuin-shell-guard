// risk_model.ts — Risk classifier for dry-run analyses
import { EffectTracker, type FileEffect } from './effects.js';
import type { GitStateEffect } from './git-effects.js';
import type { ResourceEffect } from './resource-effects.js';
import type {
  DestructiveMode,
  ExecutionCertainty,
  TargetKind,
} from './postprocess.js';
import {
  isCatastrophicPath as pathIsCatastrophic,
  isSystemPath as pathIsSystem,
  isUnresolvedCatastrophicDelete,
  toPosixForPolicy,
} from './path-policy.js';
import {
  DIRECT_RISK_POLICY,
  normalizeReasonCodes,
  REASON_CODE_SEVERITY,
  RISK_REASON_CODES,
  type DirectRiskCode,
  type ReasonCode,
} from './risk-codes.js';
import {
  evaluateEffectPredicates,
  evaluateGitEffectPredicates,
  evaluateResourceEffectPredicates,
  hasUnresolvedLocalPath,
} from './predicates.js';

// ── Types ──

export type Severity = 'safe' | 'risky' | 'critical';
export type Decision = 'pass' | 'block' | 'stop';
export { DIRECT_RISK_POLICY };
export { RISK_REASON_CODES };
export type { DirectRiskCode, ReasonCode };

export interface SampleFile {
  path: string;
  size?: number;
  createdAt?: string;
  modifiedAt?: string;
  operations?: DestructiveMode[];
  executionCertainty?: ExecutionCertainty;
  disposable?: boolean;
}

export interface ClassifyResult {
  severity: Severity;
  reasonCodes: ReasonCode[];
}

export interface DecideResult {
  decision: Decision;
  severity: Severity;
  reasonCodes: ReasonCode[];
}

export interface AffectedGroup {
  extension: string;
  totalCount: number;
  totalSize: number;
  files: SampleFile[];
  policyFiles?: SampleFile[];
  policyCount?: number;
  policySize?: number;
  definitePolicyCount?: number;
  definitePolicySize?: number;
  conditionalPolicyCount?: number;
  conditionalPolicySize?: number;
  disposable?: boolean;
}

export interface SpecialTargetInfo {
  path: string;
  kind: TargetKind;
  operation: DestructiveMode;
  executionCertainty: ExecutionCertainty;
  safeSink: boolean;
}

export interface MetadataUnavailableInfo {
  path: string;
  operation: DestructiveMode;
  executionCertainty: ExecutionCertainty;
  error: string;
}

export interface AffectedInfo {
  totalFileCount: number;
  totalSize: number;
  budgetExhausted: boolean;
  policyFileCount?: number;
  policyTotalSize?: number;
  definitePolicyFileCount?: number;
  definitePolicyTotalSize?: number;
  conditionalPolicyFileCount?: number;
  conditionalPolicyTotalSize?: number;
  budgetExhaustedCertainty?: ExecutionCertainty;
  visitedEntries?: number;
  maxDepthReached?: number;
  oldest?: SampleFile[];
  largest?: SampleFile[];
  policyOldest?: SampleFile[];
  policyLargest?: SampleFile[];
  definitePolicyOldest?: SampleFile[];
  conditionalPolicyOldest?: SampleFile[];
  groups?: AffectedGroup[];
  specialTargets?: SpecialTargetInfo[];
  metadataUnavailable?: MetadataUnavailableInfo[];
}

export interface Analysis {
  available: boolean;
  effects?: FileEffect[];
  effectsTotal?: number;
  gitEffects?: GitStateEffect[];
  gitEffectsTotal?: number;
  resourceEffects?: ResourceEffect[];
  resourceEffectsTotal?: number;
  warnings?: string[];
  affected?: AffectedInfo;
  error?: string;
}

export interface ClassifyOpts {
  platform?: string;
  now?: number;
}

export interface RenderReasonCodesDetailedOptions {
  maxReasons?: number;
  maxPathsPerReason?: number;
  maxAffectedGroups?: number;
  maxFilesPerGroup?: number;
  platform?: string;
}

// ── Thresholds ──

export const OLD_FILE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;        // 30 days
export const LARGE_TOTAL_SIZE_THRESHOLD_BYTES = 100 * 1024 * 1024;     // 100 MB
export const MANY_FILES_CRITICAL = 1000;
export const MANY_FILES_RISKY = 100;

// ── Sensitive extensions ──

export const SENSITIVE_EXTENSIONS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
  'jpg', 'jpeg', 'png',
  'heic', 'heif', 'raw', 'cr2', 'nef', 'arw', 'psd', 'ai',
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'mpeg', 'mpg', 'm4v', '3gp',
  'zip', 'rar', '7z',
  'vmdk', 'vhd', 'vhdx', 'vdi', 'iso', 'img',
]);

// ── Path helpers ──

export function toPosixForMatch(p: string): string {
  return toPosixForPolicy(p);
}

export function posixToNative(p: string, platform?: string): string {
  const plat = platform === undefined ? process.platform : platform;
  if (plat !== 'win32') return p;
  if (!p || typeof p !== 'string') return p;
  if (/^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:$/.test(p)) return p;
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (!m) return p;
  const drive = m[1].toUpperCase();
  const rest = m[2] ? m[2].replace(/\//g, '\\') : '';
  return rest ? drive + ':\\' + rest : drive + ':\\';
}

export function isSystemPath(p: string, platform: string = process.platform): boolean {
  return pathIsSystem(p, platform);
}

export function isCatastrophicPath(p: string, platform: string = process.platform): boolean {
  return pathIsCatastrophic(p, platform);
}

export function getExtension(p: string): string {
  if (!p) return '';
  const posix = toPosixForMatch(p);
  const base = posix.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1);
}

export function isSensitiveExtension(p: string): boolean {
  return SENSITIVE_EXTENSIONS.has(getExtension(p));
}

// ── Severity helpers ──

export const SEVERITY_RANK: Record<Severity, number> = { safe: 0, risky: 1, critical: 2 };

function higher(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ── Main classifier ──

export function classifyAnalysis(analysis: Analysis | null | undefined, opts?: ClassifyOpts): ClassifyResult {
  const options = opts || {};
  const platform = options.platform === undefined ? process.platform : options.platform;
  const now = options.now === undefined ? Date.now() : options.now;

  const reasonCodes = new Set<ReasonCode>();
  let severity: Severity = 'safe';

  const bump = (code: ReasonCode) => {
    const level = REASON_CODE_SEVERITY[code];
    severity = higher(severity, level);
    reasonCodes.add(code);
  };

  if (!analysis || !analysis.available) return { severity: 'safe', reasonCodes: [] };

  for (const code of evaluateEffectPredicates(analysis.effects, { platform })) {
    bump(code);
  }

  const aff = analysis.affected || {} as AffectedInfo;

  const policyCount = numberOr(aff.policyFileCount, aff.totalFileCount);
  const definiteCount = numberOr(aff.definitePolicyFileCount, policyCount);

  // Rule: many real files. Conditional-only inventories are capped at risky.
  if (definiteCount >= MANY_FILES_CRITICAL
      || (aff.budgetExhausted && aff.budgetExhaustedCertainty !== 'conditional')) {
    bump(RISK_REASON_CODES.AFFECTED_FILE_COUNT_CRITICAL);
  } else if (policyCount >= MANY_FILES_CRITICAL || aff.budgetExhausted) {
    bump(RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT);
  } else if (definiteCount >= MANY_FILES_RISKY) {
    bump(RISK_REASON_CODES.AFFECTED_FILE_COUNT_RISKY);
  } else if (policyCount >= MANY_FILES_RISKY) {
    bump(RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT);
  }

  // Rule: sensitive extension on real files
  for (const g of aff.groups || []) {
    const ext = (g.extension || '').replace(/^\./, '').toLowerCase();
    if (!ext || !SENSITIVE_EXTENSIONS.has(ext)) continue;
    const cnt = numberOr(g.policyCount, g.totalCount);
    if (cnt <= 0) continue;
    const definite = numberOr(g.definitePolicyCount, cnt);
    bump(definite > 0
      ? RISK_REASON_CODES.SENSITIVE_EXTENSION
      : RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION);
  }

  // Rule: total size > 100 MB
  const policyTotalSize = numberOr(aff.policyTotalSize, aff.totalSize);
  const definiteTotalSize = numberOr(aff.definitePolicyTotalSize, policyTotalSize);
  if (definiteTotalSize >= LARGE_TOTAL_SIZE_THRESHOLD_BYTES) {
    bump(RISK_REASON_CODES.AFFECTED_TOTAL_SIZE);
  } else if (policyTotalSize >= LARGE_TOTAL_SIZE_THRESHOLD_BYTES) {
    bump(RISK_REASON_CODES.CONDITIONAL_AFFECTED_TOTAL_SIZE);
  }

  // Rule: file older than 30 days
  const definiteOldMatches = oldFiles(
    aff.definitePolicyOldest ?? aff.policyOldest ?? aff.oldest,
    now,
  );
  if (definiteOldMatches.length > 0) {
    bump(RISK_REASON_CODES.OLD_AFFECTED_FILE);
  }

  const conditionalOldMatches = oldFiles(aff.conditionalPolicyOldest, now);
  if (definiteOldMatches.length === 0 && conditionalOldMatches.length > 0) {
    bump(RISK_REASON_CODES.CONDITIONAL_OLD_AFFECTED_FILE);
  }

  for (const target of aff.specialTargets || []) {
    if (target.safeSink || target.kind === 'directory' || target.kind === 'symlink' || target.kind === 'other') continue;
    if (target.kind === 'block-device'
        && target.operation !== 'delete-entry'
        && target.executionCertainty === 'definite') {
      bump(RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE);
    } else {
      bump(RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT);
    }
  }

  if ((aff.metadataUnavailable?.length ?? 0) > 0) {
    bump(RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION);
  }

  for (const code of evaluateGitEffectPredicates(analysis.gitEffects)) {
    bump(code);
  }
  for (const code of evaluateResourceEffectPredicates(analysis.resourceEffects)) {
    bump(code);
  }

  return { severity, reasonCodes: normalizeReasonCodes(reasonCodes) };
}

function oldFiles(files: SampleFile[] | undefined, now: number): SampleFile[] {
  const matches: SampleFile[] = [];
  for (const f of files || []) {
    const ts = Date.parse(f.createdAt || '');
    if (!Number.isFinite(ts)) continue;
    if (now - ts >= OLD_FILE_THRESHOLD_MS) matches.push(f);
  }
  return matches;
}

function numberOr(value: number | undefined, fallback: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return fallback;
  return 0;
}

// ── Rendering ──

interface RenderedReason {
  text: string;
  paths?: SampleFile[];
}

export function renderReasonCodes(
  reasonCodes: readonly ReasonCode[] | undefined,
  analysis: Analysis,
  max?: number,
): string[] {
  const limit = max === undefined ? 5 : max;
  return materializeReasonCodes(reasonCodes, analysis)
    .slice(0, limit)
    .map(reason => {
      const first = reason.paths?.[0];
      return first?.path ? `${reason.text} (${first.path})` : reason.text;
    });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

export function renderReasonCodesDetailed(
  reasonCodes: readonly ReasonCode[] | undefined,
  analysis: Analysis,
  opts?: RenderReasonCodesDetailedOptions,
): string {
  const o = opts || {};
  const maxReasons = o.maxReasons === undefined ? 10 : o.maxReasons;
  const maxPaths = o.maxPathsPerReason === undefined ? 10 : o.maxPathsPerReason;
  const affectedMetadata = indexAffectedMetadata(analysis.affected, o.platform);

  const out: string[] = [];
  for (const reason of materializeReasonCodes(reasonCodes, analysis, o.platform).slice(0, maxReasons)) {
    out.push('- ' + reason.text);
    if (reason.paths && reason.paths.length) {
      for (const p of reason.paths.slice(0, maxPaths)) {
        out.push('    * ' + renderFileMetadata(withAffectedMetadata(p, affectedMetadata, o.platform), o.platform));
      }
      if (reason.paths.length > maxPaths) {
        out.push(`    * ... and ${reason.paths.length - maxPaths} more`);
      }
    }
  }
  const affected = renderAffectedFiles(analysis.affected, o);
  if (affected.length > 0) {
    if (out.length > 0) out.push('');
    out.push(...affected);
  }
  return out.join('\n');
}

function materializeReasonCodes(
  reasonCodes: readonly ReasonCode[] | undefined,
  analysis: Analysis,
  platform: string = process.platform,
): RenderedReason[] {
  const rendered: RenderedReason[] = [];
  for (const code of normalizeReasonCodes(reasonCodes ?? [])) {
    rendered.push(...materializeReasonCode(code, analysis, platform));
  }
  return dedupeRenderedReasons(rendered);
}

function materializeReasonCode(
  code: ReasonCode,
  analysis: Analysis,
  platform: string,
): RenderedReason[] {
  const affected = analysis.affected ?? {} as AffectedInfo;
  switch (code) {
    case RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION:
      return renderMatchingEffects(
        analysis.effects,
        effect => effect.type === 'delete'
          && !EffectTracker.hasPathUncertainty(effect)
          && isCatastrophicPath(effect.path, platform),
        '**Danger:** attempts to delete filesystem root',
        platform,
      );
    case RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION:
      return renderMatchingEffects(
        analysis.effects,
        effect => effect.type === 'delete'
          && !effect.uncertain
          && !EffectTracker.hasPathUncertainty(effect)
          && isSystemPath(effect.path, platform),
        '**Danger:** attempts to delete a protected system path',
        platform,
      );
    case RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE:
      return renderMatchingEffects(
        analysis.effects,
        effect => effect.type === 'delete'
          && EffectTracker.hasPathUncertainty(effect)
          && isUnresolvedCatastrophicDelete(effect.path, platform),
        '**Danger:** may delete a broad unresolved path',
        platform,
      );
    case RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE:
      return (affected.specialTargets ?? [])
        .filter(target =>
          target.kind === 'block-device'
          && target.operation !== 'delete-entry'
          && target.executionCertainty === 'definite')
        .map(target => ({
          text: '**Danger:** may write raw data to a block device',
          paths: [pathSample(target.path, platform)],
        }));
    case RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION:
      return renderOpaqueLocalSelections(analysis, platform);
    case RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT:
      return (affected.specialTargets ?? [])
        .filter(target =>
          !target.safeSink
          && target.kind !== 'directory'
          && target.kind !== 'symlink'
          && target.kind !== 'other'
          && !(target.kind === 'block-device'
            && target.operation !== 'delete-entry'
            && target.executionCertainty === 'definite'))
        .map(target => ({
          text: target.operation === 'delete-entry'
            ? `May remove a ${target.kind} filesystem entry`
            : `May produce an external side effect through a ${target.kind}`,
          paths: [pathSample(target.path, platform)],
        }));
    case RISK_REASON_CODES.AFFECTED_FILE_COUNT_CRITICAL: {
      const policyCount = numberOr(affected.policyFileCount, affected.totalFileCount);
      const definiteCount = numberOr(affected.definitePolicyFileCount, policyCount);
      return [{
        text: affected.budgetExhausted
          ? `**Danger:** may destroy or replace more than ${policyCount} files`
          : `**Danger:** may destroy or replace ${definiteCount} files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform),
      }];
    }
    case RISK_REASON_CODES.AFFECTED_FILE_COUNT_RISKY: {
      const policyCount = numberOr(affected.policyFileCount, affected.totalFileCount);
      const definiteCount = numberOr(affected.definitePolicyFileCount, policyCount);
      return [{
        text: `May destroy or replace ${definiteCount} files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform),
      }];
    }
    case RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT: {
      const policyCount = numberOr(affected.policyFileCount, affected.totalFileCount);
      return [{
        text: `May conditionally destroy or replace at least ${policyCount} files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform),
      }];
    }
    case RISK_REASON_CODES.SENSITIVE_EXTENSION:
      return renderSensitiveExtensions(affected, platform, true);
    case RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION:
      return renderSensitiveExtensions(affected, platform, false);
    case RISK_REASON_CODES.AFFECTED_TOTAL_SIZE: {
      const policyTotalSize = numberOr(affected.policyTotalSize, affected.totalSize);
      const definiteTotalSize = numberOr(affected.definitePolicyTotalSize, policyTotalSize);
      const mb = Math.round(definiteTotalSize / (1024 * 1024));
      return [{
        text: `**Danger:** may destroy or replace up to ${mb} MB of files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform),
      }];
    }
    case RISK_REASON_CODES.CONDITIONAL_AFFECTED_TOTAL_SIZE: {
      const policyTotalSize = numberOr(affected.policyTotalSize, affected.totalSize);
      const mb = Math.round(policyTotalSize / (1024 * 1024));
      return [{
        text: `May conditionally destroy or replace up to ${mb} MB of files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform),
      }];
    }
    case RISK_REASON_CODES.OLD_AFFECTED_FILE: {
      const files = affected.definitePolicyOldest ?? affected.policyOldest ?? affected.oldest;
      const ageDays = fileAgeDays(files?.[0]);
      return [{
        text: ageDays === undefined
          ? '**Danger:** may destroy or replace old files'
          : `**Danger:** may destroy or replace old files created ${ageDays} days ago`,
        paths: sampleFiles(files, platform),
      }];
    }
    case RISK_REASON_CODES.CONDITIONAL_OLD_AFFECTED_FILE: {
      const files = affected.conditionalPolicyOldest;
      const ageDays = fileAgeDays(files?.[0]);
      return [{
        text: ageDays === undefined
          ? 'May conditionally destroy or replace old files'
          : `May conditionally destroy or replace old files created ${ageDays} days ago`,
        paths: sampleFiles(files, platform),
      }];
    }
    case RISK_REASON_CODES.GIT_WORKTREE_DISCARD:
      return renderGitWorktreeRisks(analysis, platform);
    case RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION:
      return renderExternalResourceRisks(analysis, platform);
    case RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE:
      return (analysis.resourceEffects ?? [])
        .filter(effect => effect.domain === 'container-bind-mount')
        .map(effect => ({
          text: 'A container may modify files through a writable host bind mount',
          paths: effect.selection.root
            ? [pathSample(effect.selection.root, platform)]
            : undefined,
        }));
  }
  return [];
}

function renderMatchingEffects(
  effects: FileEffect[] | undefined,
  matches: (effect: FileEffect) => boolean,
  text: string,
  platform: string,
): RenderedReason[] {
  return (effects ?? [])
    .filter(matches)
    .map(effect => ({ text, paths: [pathSample(effect.path, platform)] }));
}

function renderOpaqueLocalSelections(analysis: Analysis, platform: string): RenderedReason[] {
  const rendered: RenderedReason[] = [];
  for (const effect of analysis.effects ?? []) {
    if (!EffectTracker.hasPathUncertainty(effect)
        || !hasUnresolvedLocalPath(effect)
        || (effect.type === 'delete' && isUnresolvedCatastrophicDelete(effect.path, platform))) {
      continue;
    }
    rendered.push({
      text: 'Could not enumerate a destructive local target',
      paths: [pathSample(effect.path, platform)],
    });
  }
  for (const observation of analysis.affected?.metadataUnavailable ?? []) {
    rendered.push({
      text: 'Could not inspect a destructive local target',
      paths: [pathSample(observation.path, platform)],
    });
  }
  for (const effect of analysis.resourceEffects ?? []) {
    if (effect.domain !== 'local-filesystem-selection') continue;
    rendered.push({
      text: `${effect.command} may delete files selected from derived or runtime input; exact targets are unavailable`,
      paths: effect.selection.root
        ? [pathSample(effect.selection.root, platform)]
        : undefined,
    });
  }
  return rendered;
}

function renderSensitiveExtensions(
  affected: AffectedInfo,
  platform: string,
  definiteOnly: boolean,
): RenderedReason[] {
  const rendered: RenderedReason[] = [];
  for (const group of affected.groups ?? []) {
    const extension = (group.extension || '').replace(/^\./, '').toLowerCase();
    if (!extension || !SENSITIVE_EXTENSIONS.has(extension)) continue;
    const count = numberOr(group.policyCount, group.totalCount);
    const definiteCount = numberOr(group.definitePolicyCount, count);
    if (count <= 0 || (definiteOnly ? definiteCount <= 0 : definiteCount > 0)) continue;
    rendered.push({
      text: count > 1
        ? `${definiteOnly ? '**Danger:** May' : 'May conditionally'} destroy or replace ${count} potentially important user files (.${extension})`
        : `${definiteOnly ? '**Danger:** May' : 'May conditionally'} destroy or replace potentially important user data (.${extension})`,
      paths: sampleFiles(group.policyFiles ?? group.files, platform),
    });
  }
  return rendered;
}

function renderGitWorktreeRisks(analysis: Analysis, platform: string): RenderedReason[] {
  const rendered: RenderedReason[] = [];
  for (const effect of analysis.gitEffects ?? []) {
    if (effect.command !== 'git reset' || effect.domain !== 'worktree') continue;
    const submodules = effect.recurseSubmodules === true ? ', including active submodules' : '';
    let text: string | undefined;
    if (effect.mode === 'hard') {
      text = `Git hard reset may discard uncommitted worktree changes${submodules}; repository dirty state was not inspected`;
    } else if (effect.mode === 'merge') {
      text = `Git merge reset may replace staged worktree state${submodules}; repository state was not inspected`;
    } else if (effect.mode === 'keep') {
      text = `Git keep reset may update worktree and index state${submodules}; local worktree changes should be preserved or make Git abort`;
    } else if (effect.mode === 'unknown') {
      text = 'Partially resolved Git reset arguments may select a worktree-discarding mode';
    }
    if (text) {
      rendered.push({
        text,
        paths: [pathSample(effect.repository.workTree ?? effect.repository.cwd, platform)],
      });
    }
  }
  for (const effect of analysis.resourceEffects ?? []) {
    if (effect.domain !== 'git-worktree') continue;
    rendered.push({
      text: 'Git clean may delete untracked or ignored worktree files; exact targets were not inspected',
      paths: effect.selection.root
        ? [pathSample(effect.selection.root, platform)]
        : undefined,
    });
  }
  return rendered;
}

function renderExternalResourceRisks(analysis: Analysis, platform: string): RenderedReason[] {
  const rendered: RenderedReason[] = [];
  for (const effect of analysis.resourceEffects ?? []) {
    const target = effect.selection.target ? ` (${effect.selection.target})` : '';
    let text: string | undefined;
    if (effect.domain === 'docker-volume') {
      text = 'Docker Compose may delete persistent volumes; the Docker resource state was not inspected';
    } else if (effect.domain === 'kubernetes') {
      text = `kubectl may delete Kubernetes resources${target}; cluster state was not inspected`;
    } else if (effect.domain === 'helm') {
      text = `Helm may uninstall a release${target}; cluster release state was not inspected`;
    } else if (effect.domain === 'terraform') {
      text = 'Terraform may destroy managed resources; backend and plan state were not inspected';
    }
    if (text) {
      rendered.push({
        text,
        paths: effect.selection.root
          ? [pathSample(effect.selection.root, platform)]
          : undefined,
      });
    }
  }
  return rendered;
}

function pathSample(path: string, platform: string): SampleFile {
  return { path: posixToNative(path, platform) };
}

function sampleFiles(files: SampleFile[] | undefined, platform: string): SampleFile[] {
  return (files ?? []).slice(0, 10).map(file => ({
    ...file,
    path: posixToNative(file.path, platform),
  }));
}

function fileAgeDays(file: SampleFile | undefined): number | undefined {
  const createdAt = Date.parse(file?.createdAt || '');
  if (!Number.isFinite(createdAt)) return undefined;
  const elapsed = Date.now() - createdAt;
  if (elapsed < 0) return undefined;
  return Math.floor(elapsed / (24 * 60 * 60 * 1000));
}

function dedupeRenderedReasons(reasons: RenderedReason[]): RenderedReason[] {
  const seen = new Set<string>();
  const deduped: RenderedReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.text}\0${reason.paths?.map(path => path.path).join('\0') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reason);
  }
  return deduped;
}

function indexAffectedMetadata(
  affected: AffectedInfo | undefined,
  platform?: string,
): Map<string, SampleFile> {
  const indexed = new Map<string, SampleFile>();
  const samples = [
    ...(affected?.oldest || []),
    ...(affected?.largest || []),
    ...(affected?.policyOldest || []),
    ...(affected?.policyLargest || []),
    ...(affected?.definitePolicyOldest || []),
    ...(affected?.conditionalPolicyOldest || []),
    ...(affected?.groups || []).flatMap(group => group.files),
    ...(affected?.groups || []).flatMap(group => group.policyFiles || []),
  ];
  for (const sample of samples) {
    indexed.set(sample.path, sample);
    indexed.set(posixToNative(sample.path, platform), sample);
  }
  return indexed;
}

function withAffectedMetadata(
  file: SampleFile,
  indexed: Map<string, SampleFile>,
  platform?: string,
): SampleFile {
  const metadata = indexed.get(file.path) ?? indexed.get(posixToNative(file.path, platform));
  if (!metadata) return file;
  return {
    path: file.path,
    size: file.size ?? metadata.size,
    createdAt: file.createdAt ?? metadata.createdAt,
    modifiedAt: file.modifiedAt ?? metadata.modifiedAt,
    operations: file.operations ?? metadata.operations,
    executionCertainty: file.executionCertainty ?? metadata.executionCertainty,
    disposable: file.disposable ?? metadata.disposable,
  };
}

function renderAffectedFiles(
  affected: AffectedInfo | undefined,
  opts: RenderReasonCodesDetailedOptions,
): string[] {
  if (!affected) return [];
  const count = Number.isFinite(affected.totalFileCount) && affected.totalFileCount >= 0
    ? affected.totalFileCount
    : 0;
  const size = Number.isFinite(affected.totalSize) && affected.totalSize >= 0
    ? formatBytes(affected.totalSize)
    : 'size unavailable';
  const countLabel = affected.budgetExhausted ? `at least ${count}` : String(count);
  const out = [`Affected files found on disk: ${countLabel}, total size ${size}`];
  const policyCount = numberOr(affected.policyFileCount, count);
  const policySize = numberOr(affected.policyTotalSize, affected.totalSize);
  if (policyCount !== count || policySize !== affected.totalSize) {
    out.push(`- Policy-relevant files: ${policyCount}, total size ${formatBytes(policySize)}`);
  }
  if (count === 0) {
    out.push('- No regular-file extension or creation-time metadata was found.');
    return out;
  }

  const groups = affected.groups || [];
  const maxGroups = opts.maxAffectedGroups === undefined ? 10 : opts.maxAffectedGroups;
  const maxFiles = opts.maxFilesPerGroup === undefined ? 10 : opts.maxFilesPerGroup;
  for (const group of groups.slice(0, maxGroups)) {
    const extension = group.extension === '(no ext)' || !group.extension
      ? '(no extension)'
      : group.extension.startsWith('.') ? group.extension : `.${group.extension}`;
    const groupCount = Number.isFinite(group.totalCount) && group.totalCount >= 0
      ? group.totalCount
      : group.files.length;
    const groupSize = Number.isFinite(group.totalSize) && group.totalSize >= 0
      ? formatBytes(group.totalSize)
      : 'size unavailable';
    out.push(`- Extension ${extension}: ${groupCount} ${groupCount === 1 ? 'file' : 'files'}, total size ${groupSize}`);
    for (const file of group.files.slice(0, maxFiles)) {
      out.push('    * ' + renderFileMetadata(file, opts.platform));
    }
    if (groupCount > Math.min(group.files.length, maxFiles)) {
      out.push(`    * ... and ${groupCount - Math.min(group.files.length, maxFiles)} more`);
    }
  }
  if (groups.length > maxGroups) {
    out.push(`- ... and ${groups.length - maxGroups} more extensions`);
  }
  return out;
}

function renderFileMetadata(file: SampleFile, platform?: string): string {
  const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0
    ? formatBytes(file.size)
    : 'unavailable';
  const createdAt = formatCreatedAt(file.createdAt);
  const operations = file.operations && file.operations.length > 0
    ? `, operations ${file.operations.join('/')}`
    : '';
  const certainty = file.executionCertainty === 'conditional' ? ', conditional' : '';
  return `${posixToNative(file.path, platform)}, size ${size}, created ${createdAt}${operations}${certainty}`;
}

function formatCreatedAt(value: string | undefined): string {
  if (!value) return 'unavailable';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(value);
}

// ── Top-level decision ──

export function decide(analysis: Analysis | null | undefined, opts?: ClassifyOpts): DecideResult {
  if (!analysis || !analysis.available) {
    return { decision: 'pass', severity: 'safe', reasonCodes: [] };
  }
  const classified = classifyAnalysis(analysis, opts);
  const decision = classified.severity === 'critical' ? 'stop' : 'pass';
  return {
    decision,
    severity: classified.severity,
    reasonCodes: classified.reasonCodes,
  };
}
