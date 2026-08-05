// api.ts — Programmatic entry point for embedders.
//
// Exports `bash_emu(command, cwd)` returning a plain JSON object with the
// same information the CLI renders as Markdown: predicted effects grouped
// by type, affected files on disk grouped by extension, and warnings.

import { analyze } from './index.js';
import { postprocess } from '../analysis/postprocess.js';
import { toPosix } from '../analysis/vfs.js';
import type { FileEffect, EffectType, EffectCertainty, UncertaintyReason } from '../analysis/effects.js';
import type { GitStateEffect } from '../analysis/git-effects.js';
import type { ResourceEffect } from '../analysis/resource-effects.js';
import type { AffectedFile, ExtensionGroup, PostProcessResult } from '../analysis/postprocess.js';
import type { ProvenanceGraph } from '../analysis/provenance.js';

export interface JsonAffectedFile {
  path: string;
  createdAt: string;   // ISO-8601 (Date serialized for JSON safety)
  modifiedAt: string;  // ISO-8601 last modification time
  size: number;
  effectIndexes: number[];
  effectIndexesTruncated: boolean;
  provenance: number[];
}

export interface JsonExtensionGroup {
  extension: string;
  files: JsonAffectedFile[];
  totalCount: number;
  totalSize: number;
}

export interface JsonAffected {
  groups: JsonExtensionGroup[];
  oldest: JsonAffectedFile[];
  largest: JsonAffectedFile[];
  totalFileCount: number;
  totalSize: number;
  budgetExhausted: boolean;
}

export interface JsonEffect {
  type: EffectType;
  path: string;
  source?: string;
  sourcePath?: string;
  line: number;
  command: string;
  uncertain: boolean;
  certainty: EffectCertainty;
  uncertainty: UncertaintyReason[];
  provenance: number[];
}

export interface BashEmuResult {
  timestamp: string;                              // ISO-8601 seconds precision
  effects: JsonEffect[];                          // flat, in order
  gitEffects: GitStateEffect[];
  resourceEffects: ResourceEffect[];
  effectsByType: Partial<Record<EffectType, JsonEffect[]>>;
  affected: JsonAffected;                         // always populated; zero-counts if nothing on disk
  warnings: string[];
  provenance: ProvenanceGraph;
}

export interface BashEmuOptions {
  /** Extra environment variables to inject (merged over process.env) */
  env?: Record<string, string>;
  /** Positional params ($1, $2, ...) */
  args?: string[];
}

/**
 * Dry-run a shell command/script and return a JSON-serializable summary.
 *
 * @param command  shell source string (single command or multi-line script)
 * @param cwd      working directory for resolving relative paths
 * @param opts     optional env/args overlay
 */
export function bash_emu(
  command: string,
  cwd?: string,
  opts: BashEmuOptions = {},
): BashEmuResult {
  const resolvedCwd = toPosix(cwd ?? process.cwd());

  const result = analyze(command, {
    cwd: resolvedCwd,
    env: opts.env,
    args: opts.args,
    realFs: true,
  });

  const pp = postprocess(result.effects, {
    provenance: result.provenance,
  });

  const effects: JsonEffect[] = result.effects.map(toJsonEffect);
  const effectsByType: Partial<Record<EffectType, JsonEffect[]>> = {};
  for (const e of effects) {
    let list = effectsByType[e.type];
    if (!list) { list = []; effectsByType[e.type] = list; }
    list.push(e);
  }

  return {
    timestamp: new Date().toISOString().slice(0, 19) + 'Z',
    effects,
    gitEffects: result.gitEffects,
    resourceEffects: result.resourceEffects,
    effectsByType,
    affected: toJsonAffected(pp),
    warnings: result.warnings,
    provenance: pp.provenance ?? result.provenance,
  };
}

function toJsonEffect(e: FileEffect): JsonEffect {
  const out: JsonEffect = {
    type: e.type,
    path: e.path,
    line: e.line,
    command: e.command,
    uncertain: e.uncertain,
    certainty: e.certainty,
    uncertainty: e.uncertainty,
    provenance: [...(e.provenance ?? [])],
  };
  if (e.source !== undefined) out.source = e.source;
  if (e.sourcePath !== undefined) out.sourcePath = e.sourcePath;
  return out;
}

function toJsonAffectedFile(f: AffectedFile): JsonAffectedFile {
  return {
    path: f.path,
    createdAt: f.createdAt.toISOString(),
    modifiedAt: f.modifiedAt.toISOString(),
    size: f.size,
    effectIndexes: [...f.effectIndexes],
    effectIndexesTruncated: f.effectIndexesTruncated,
    provenance: [...(f.provenance ?? [])],
  };
}

function toJsonAffected(pp: PostProcessResult): JsonAffected {
  return {
    groups: pp.groups.map((g: ExtensionGroup) => ({
      extension: g.extension,
      files: g.files.map(toJsonAffectedFile),
      totalCount: g.totalCount,
      totalSize: g.totalSize,
    })),
    oldest: pp.oldest.map(toJsonAffectedFile),
    largest: pp.largest.map(toJsonAffectedFile),
    totalFileCount: pp.totalFileCount,
    totalSize: pp.totalSize,
    budgetExhausted: pp.budgetExhausted,
  };
}
