import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type {
  Command,
  CondNode,
  Redirect,
  SimpleCommand,
  WordDesc,
  WordList,
} from '../bash/command.js';
import {
  CMD_INVERT_RETURN,
  COND_AND,
  COND_BINARY,
  COND_EXPR,
  COND_OR,
  COND_TERM,
  COND_UNARY,
  COND_UNKNOWN,
} from '../bash/command.js';
import { assignment_name, assignment_value } from '../bash/general.js';
import { analyze as analyzeBash } from '../bash/index.js';
import { parse as parseBash } from '../bash/parse.js';
import { print_command } from '../bash/print_cmd.js';
import {
  expand_words,
  expand_word_to_string,
  MAX_EXPANDED_WORDS,
} from '../bash/subst.js';
import {
  resolveBashCommandString,
  resolveInvocation,
  type ResolvedInvocation,
} from '../bash/invocation.js';
import { VariableEnvironment } from '../bash/variables.js';
import { analyzePowerShell } from '../powershell/index.js';
import { postprocess } from '../analysis/postprocess.js';
import type {
  AffectedFile,
  DestructiveMode,
  ExecutionCertainty,
  ExtensionGroup,
} from '../analysis/postprocess.js';
import { toNative, toPosix } from '../analysis/vfs.js';
import type { ShellKind } from './hook-protocol.js';
import { powerShellAnalysisEnabled } from './platform.js';
import { getCloudReviewSetting, getInstallationId } from './user-config.js';
import {
  decide as riskDecide,
  isCatastrophicPath,
  isSystemPath,
  renderReasonCodes,
  renderReasonCodesDetailed,
  type Analysis,
  type Decision,
  type DecideResult,
  type ReasonCode,
  type SampleFile,
} from '../analysis/risk_model.js';

const VER = '1.0.0';
const PLUGIN_ROOT = process.env['CODEBUDDY_PLUGIN_ROOT'] || __dirname;
const LOG_FILE = path.join(PLUGIN_ROOT, 'protector_log.txt');
const ENABLE_LOG = (process.env['XW_ENABLE_LOG'] === 'true');
const MAX_AFFECTED_SAMPLES = 10;
const MAX_FORWARD_EFFECTS = 50;
const MAX_FORWARD_GIT_EFFECTS = 50;
const MAX_FORWARD_RESOURCE_EFFECTS = 50;
const MAX_FORWARD_CONVERSATION_ID_BYTES = 256;
const SHELL_GUARD_DEFAULT_URL = 'https://shell-guard.atuin.tencent.com';
const SHELL_GUARD_REVIEW_PATH = '/v1/xw_review_bash';
const SHELL_GUARD_TIMEOUT_MS = readPositiveInt(process.env['XW_SHELL_GUARD_TIMEOUT_MS'], 60000);

interface AffectedSample {
  path: string;
  createdAt?: string;
  modifiedAt?: string;
  size?: number;
  operations?: DestructiveMode[];
  executionCertainty?: ExecutionCertainty;
  disposable?: boolean;
}
interface ShellInvocation {
  script: string;
  cwd: string;
  shell: ShellKind;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  privileged?: boolean;
}
interface CachedPowerShellFile { mtimeMs: number; size: number; script: string }
interface ShellEffects {
  effects: ReturnType<typeof analyzeBash>['effects'];
  gitEffects: ReturnType<typeof analyzeBash>['gitEffects'];
  resourceEffects: ReturnType<typeof analyzeBash>['resourceEffects'];
  warnings: string[];
}
interface BashReviewRequest {
  version: string;
  conversation_id?: string;
  platform: string;
  cwd: string;
  command: string;
  shell: ShellKind;
  severity: string;
  reasonCodes: ReasonCode[];
  analysis: Analysis & { effectsTruncated?: boolean; gitEffectsTruncated?: boolean; resourceEffectsTruncated?: boolean };
}
interface BashReviewResponse {
  decision?: Decision;
  need_update?: unknown;
}

const POWERSHELL_FILE_CACHE = new Map<string, CachedPowerShellFile>();
const MAX_NESTED_SHELL_DEPTH = 4;

export interface ProtectResult {
  decision: Decision;
  severity: string;
  reasonCodes: ReasonCode[];
  detail: string;
  analysis: Analysis;
  needUpdate?: boolean;
}

export function log(msg: string): void {
  if (ENABLE_LOG) {
    try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch {
      // Logging must never affect hook decisions.
    }
  }
}

export function analyzeBashCommand(command: string, cwd?: string): Analysis {
  return analyzeCommand(command, cwd, 'bash');
}

export function analyzeCommand(command: string, cwd?: string, shell: ShellKind = 'bash'): Analysis {
  if (shell === 'powershell' && !powerShellAnalysisEnabled()) {
    return { available: false, error: 'PowerShell guard analysis is available only on Windows' };
  }
  try {
    const resolvedCwd = toPosix(cwd ?? process.cwd());
    const result = analyzeShellEffects(command, resolvedCwd, shell, 0);
    return buildAnalysis(result);
  } catch (err: unknown) {
    log(`shell analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function analyzeProtectedCommand(command: string, cwd?: string, shell: ShellKind = 'bash'): Analysis {
  if (shell !== 'bash') return analyzeCommand(command, cwd, shell);
  const resolvedCwd = toPosix(cwd ?? process.cwd());
  const effects: ReturnType<typeof analyzeBash>['effects'] = [];
  const gitEffects: ReturnType<typeof analyzeBash>['gitEffects'] = [];
  const resourceEffects: ReturnType<typeof analyzeBash>['resourceEffects'] = [];
  const warnings: string[] = [];
  let successfulAnalyzers = 0;
  const failures: string[] = [];
  const secondaryPowerShellCommand = powerShellAnalysisEnabled()
    ? commandForSecondaryPowerShell(command)
    : null;
  const candidates: Array<{ shell: ShellKind; script: string }> = [
    { shell: 'bash', script: command },
    ...(secondaryPowerShellCommand === null
      ? []
      : [{ shell: 'powershell' as const, script: secondaryPowerShellCommand }]),
  ];

  for (const candidate of candidates) {
    try {
      const result = analyzeShellEffects(candidate.script, resolvedCwd, candidate.shell, 0);
      successfulAnalyzers++;
      effects.push(...result.effects);
      gitEffects.push(...result.gitEffects);
      resourceEffects.push(...result.resourceEffects);
      warnings.push(...(candidate.shell === 'powershell'
        ? result.warnings.map(w => `powershell: ${w}`)
        : result.warnings));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${candidate.shell}: ${message}`);
      log(`protected ${candidate.shell} analysis failed: ${message}`);
    }
  }

  if (successfulAnalyzers === 0) {
    return { available: false, error: failures.join('; ') || 'shell analysis failed' };
  }

  warnings.push(...failures.map(failure => `analysis failed: ${failure}`));
  return buildAnalysis({
    effects: dedupeEffects(effects),
    gitEffects: dedupeGitEffects(gitEffects),
    resourceEffects: dedupeResourceEffects(resourceEffects),
    warnings,
  });
}

function commandForSecondaryPowerShell(command: string): string | null {
  const parsed = parseBash(command);
  let candidate = command;
  if (parsed.ast && stripBashHereDocuments(parsed.ast)) {
    candidate = print_command(parsed.ast);
  }
  return candidate.trim().length > 0 && shouldRunSecondaryPowerShell(candidate) ? candidate : null;
}

function shouldRunSecondaryPowerShell(command: string): boolean {
  // Bash-only compound syntax can send the tolerant PowerShell parser down
  // paths that add noise or never make progress. The Bash analyzer covers it.
  if (/\b(?:then|fi|esac|done)\b/.test(command)) return false;
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(command)) return false;
  if (/(^|[;&|]\s*)!?\s*(?:\(\(|\[\[)/.test(command)) return false;
  if (/(^|[;&|]\s*)\([^)]*(?:&&|\|\||;)[^)]*\)/.test(command)) return false;
  if (/(^|[;&|]\s*)\{[^}]*(?:&&|\|\||;)[^}]*\}/.test(command)) return false;
  return true;
}

function stripBashHereDocuments(command: Command): boolean {
  const filtered = withoutHereDocumentRedirects(command.redirects);
  command.redirects = filtered.redirects;
  let found = filtered.found;
  switch (command.type) {
    case 'simple':
    case 'arith':
    case 'cond':
      break;
    case 'connection':
      found = stripBashHereDocuments(command.first) || found;
      if (command.second) found = stripBashHereDocuments(command.second) || found;
      break;
    case 'if':
      found = stripBashHereDocuments(command.test) || found;
      found = stripBashHereDocuments(command.true_case) || found;
      if (command.false_case) found = stripBashHereDocuments(command.false_case) || found;
      break;
    case 'for':
    case 'while':
    case 'until':
      found = stripBashHereDocuments(command.action) || found;
      if (command.type === 'while' || command.type === 'until') {
        found = stripBashHereDocuments(command.test) || found;
      }
      break;
    case 'case': {
      let clause = command.clauses;
      while (clause) {
        if (clause.action) found = stripBashHereDocuments(clause.action) || found;
        clause = clause.next;
      }
      break;
    }
    case 'function_def':
      found = stripBashHereDocuments(command.command) || found;
      break;
    case 'group':
    case 'subshell':
      found = stripBashHereDocuments(command.command) || found;
      break;
  }
  return found;
}

function withoutHereDocumentRedirects(redirect: Redirect | null): { redirects: Redirect | null; found: boolean } {
  let head: Redirect | null = null;
  let tail: Redirect | null = null;
  let found = false;
  let current = redirect;
  while (current) {
    const next = current.next;
    current.next = null;
    if (current.instruction === 'r_reading_until' || current.instruction === 'r_deblank_reading_until') {
      found = true;
    } else if (!head) {
      head = tail = current;
    } else {
      tail!.next = current;
      tail = current;
    }
    current = next;
  }
  return { redirects: head, found };
}

function buildAnalysis(result: ShellEffects): Analysis {
  const affected = postprocess(result.effects);
  const rawEffects = result.effects.map(e => ({
    type: e.type,
    path: e.path,
    source: e.source,
    sourcePath: e.sourcePath,
    line: e.line,
    command: e.command,
    replacement: e.replacement,
    uncertain: !!e.uncertain,
    certainty: e.certainty,
    uncertainty: e.uncertainty,
  }));
  const rawGitEffects = result.gitEffects.map(effect => ({
    ...stripLocalProvenance(effect),
    repository: { ...effect.repository },
    selection: {
      ...effect.selection,
      pathspecs: effect.selection.pathspecs ? [...effect.selection.pathspecs] : undefined,
    },
    uncertainty: [...effect.uncertainty],
  }));
  const rawResourceEffects = result.resourceEffects.map(effect => ({
    ...stripLocalProvenance(effect),
    selection: { ...effect.selection },
    uncertainty: [...effect.uncertainty],
  }));
  return {
    available: true,
    effects: rawEffects,
    effectsTotal: rawEffects.length,
    gitEffects: rawGitEffects,
    gitEffectsTotal: rawGitEffects.length,
    resourceEffects: rawResourceEffects,
    resourceEffectsTotal: rawResourceEffects.length,
    warnings: result.warnings.slice(0, 20),
    affected: {
      totalFileCount: affected.totalFileCount,
      totalSize: affected.totalSize,
      policyFileCount: affected.policyFileCount,
      policyTotalSize: affected.policyTotalSize,
      definitePolicyFileCount: affected.definitePolicyFileCount,
      definitePolicyTotalSize: affected.definitePolicyTotalSize,
      conditionalPolicyFileCount: affected.conditionalPolicyFileCount,
      conditionalPolicyTotalSize: affected.conditionalPolicyTotalSize,
      budgetExhausted: affected.budgetExhausted,
      budgetExhaustedCertainty: affected.budgetExhaustedCertainty,
      visitedEntries: affected.visitedEntries,
      maxDepthReached: affected.maxDepthReached,
      oldest: sampleAffected(affected.oldest),
      largest: sampleAffected(affected.largest),
      policyOldest: sampleAffected(affected.policyOldest),
      policyLargest: sampleAffected(affected.policyLargest),
      definitePolicyOldest: sampleAffected(affected.definitePolicyOldest),
      conditionalPolicyOldest: sampleAffected(affected.conditionalPolicyOldest),
      groups: sampleGroups(affected.groups),
      // Observation-to-effect links are local provenance and are not part of
      // the cloud-review payload or policy input.
      specialTargets: affected.specialTargets.map(target => ({
        path: target.path,
        kind: target.kind,
        operation: target.operation,
        executionCertainty: target.executionCertainty,
        safeSink: target.safeSink,
      })),
      metadataUnavailable: affected.metadataUnavailable.map(observation => ({
        path: observation.path,
        operation: observation.operation,
        executionCertainty: observation.executionCertainty,
        error: observation.error,
      })),
    },
  };
}

function dedupeEffects(effects: ReturnType<typeof analyzeBash>['effects']): ReturnType<typeof analyzeBash>['effects'] {
  const seen = new Set<string>();
  const deduped: ReturnType<typeof analyzeBash>['effects'] = [];
  for (const effect of effects) {
    // The safety decision cares about the predicted filesystem mutation, not
    // which parser recognized it first.
    const key = [
      effect.type,
      effect.path,
      effect.sourcePath ?? effect.source ?? '',
      effect.replacement ?? '',
      effect.line,
      effect.uncertain ? '1' : '0',
      (effect.uncertainty ?? []).join(','),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(effect);
  }
  return deduped;
}

function dedupeGitEffects(
  effects: ReturnType<typeof analyzeBash>['gitEffects'],
): ReturnType<typeof analyzeBash>['gitEffects'] {
  const seen = new Set<string>();
  const deduped: ReturnType<typeof analyzeBash>['gitEffects'] = [];
  for (const effect of effects) {
    const key = [
      effect.command,
      effect.domain,
      effect.operation,
      effect.mode,
      effect.repository.cwd,
      effect.repository.gitDir ?? '',
      effect.repository.workTree ?? '',
      effect.repository.bare ? '1' : '0',
      effect.repository.forcedBare ? '1' : '0',
      effect.repository.confidence,
      effect.selection.kind,
      effect.selection.pathspecFile ?? '',
      (effect.selection.pathspecs ?? []).join('\0'),
      effect.target ?? '',
      effect.line,
      effect.recoverability,
      effect.executionMode,
      String(effect.recurseSubmodules),
      effect.privileged ? '1' : '0',
      effect.completeness,
      effect.certainty,
      effect.uncertain ? '1' : '0',
      effect.uncertainty.join(','),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(effect);
  }
  return deduped;
}

function dedupeResourceEffects(
  effects: ReturnType<typeof analyzeBash>['resourceEffects'],
): ReturnType<typeof analyzeBash>['resourceEffects'] {
  const seen = new Set<string>();
  const deduped: ReturnType<typeof analyzeBash>['resourceEffects'] = [];
  for (const effect of effects) {
    const key = [
      effect.domain,
      effect.operation,
      effect.command,
      effect.selection.kind,
      effect.selection.root ?? '',
      effect.selection.target ?? '',
      effect.executionMode,
      effect.recoverability,
      effect.completeness,
      effect.privileged ? '1' : '0',
      effect.line,
      effect.certainty,
      effect.uncertain ? '1' : '0',
      effect.uncertainty.join(','),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(effect);
  }
  return deduped;
}

function analyzeShellEffects(
  command: string,
  cwd: string,
  shell: ShellKind,
  depth: number,
  env?: Record<string, string>,
  inheritEnv: boolean = true,
  args?: string[],
): ShellEffects {
  if (shell === 'powershell' && !powerShellAnalysisEnabled()) {
    return {
      effects: [],
      gitEffects: [],
      resourceEffects: [],
      warnings: ['PowerShell guard analysis skipped because the host is not Windows'],
    };
  }
  const primaryResult = shell === 'powershell'
    ? analyzePowerShell(command, { cwd, env, inheritEnv, args, realFs: true })
    : analyzeBash(command, { cwd, env, inheritEnv, args, realFs: true });
  const result = {
    effects: [...primaryResult.effects],
    gitEffects: [...primaryResult.gitEffects],
    resourceEffects: [...primaryResult.resourceEffects],
    warnings: [...primaryResult.warnings],
  };
  if (depth >= MAX_NESTED_SHELL_DEPTH) {
    result.warnings.push(`nested shell analysis stopped after depth ${MAX_NESTED_SHELL_DEPTH}`);
    return result;
  }
  for (const invocation of extractNestedShellInvocations(command, cwd, shell, env, inheritEnv, args)) {
    const nested = analyzeShellEffects(
      invocation.script,
      invocation.cwd,
      invocation.shell,
      depth + 1,
      invocation.env,
      invocation.inheritEnv,
      invocation.args,
    );
    result.effects.push(...nested.effects);
    result.gitEffects.push(...nested.gitEffects);
    result.resourceEffects.push(...nested.resourceEffects);
    result.warnings.push(...nested.warnings.map(w => `${invocation.shell}: ${w}`));
  }
  return result;
}

function extractNestedShellInvocations(
  command: string,
  cwd: string,
  shell: ShellKind,
  env?: Record<string, string>,
  inheritEnv: boolean = true,
  args?: string[],
): ShellInvocation[] {
  return shell === 'powershell'
    ? extractPowerShellNestedShells(command, cwd, env, inheritEnv, args)
    : extractBashNestedShells(command, cwd, env, inheritEnv, args);
}

function extractBashNestedShells(
  command: string,
  cwd: string,
  initialEnv?: Record<string, string>,
  inheritEnv: boolean = true,
  args?: string[],
): ShellInvocation[] {
  const parsed = parseBash(command);
  if (!parsed.ast) return [];
  const env = new VariableEnvironment({ ...initialEnv, PWD: cwd }, inheritEnv);
  if (args) env.set_positional_params(args);
  return collectShellScripts(parsed.ast, new Map(), env);
}

function collectShellScripts(command: Command, functions: Map<string, Command>, env: VariableEnvironment): ShellInvocation[] {
  switch (command.type) {
    case 'simple': {
      const restore = applyAssignments(command, env);
      try {
        const substitutions = [
          ...commandSubstitutionsInWords(command.assignments, currentCwd(env)),
          ...commandSubstitutionsInWords(command.words, currentCwd(env)),
          ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ];
        const words = expandSimpleWords(command, env);
        const invocation = resolveInvocation(words, { cwd: currentCwd(env) });
        if (invocation.completeness !== 'complete' || invocation.queryOnly
            || invocation.exitsEarly || !invocation.commandName) {
          return substitutions;
        }
        const allowsShellBuiltins = invocation.identityConfidence === 'bare-name'
          && invocation.wrapperChain.every(frame => frame.name === 'command');
        if (allowsShellBuiltins && invocation.commandName === 'cd') {
          applyCd([invocation.commandName, ...invocation.args], env);
          return substitutions;
        }
        const functionBody = invocation.bypassFunctions
          ? undefined
          : functions.get(invocation.commandName);
        if (functionBody) return [...substitutions, ...collectShellScripts(functionBody, functions, env)];
        return [
          ...substitutions,
          ...extractShellFromInvocation(invocation, env, hereDocBody(command.redirects)),
        ];
      } finally {
        restore();
      }
    }
    case 'connection':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.first, functions, env),
        ...(command.second ? collectShellScripts(command.second, functions, env) : []),
      ];
    case 'if':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.test, functions, env),
        ...collectShellScripts(command.true_case, functions, env),
        ...(command.false_case ? collectShellScripts(command.false_case, functions, env) : []),
      ];
    case 'for':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...commandSubstitutionsInWords(command.map_list, currentCwd(env)),
        ...collectForShellScripts(command.name.word, command.map_list, command.action, functions, env),
      ];
    case 'while':
    case 'until':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.test, functions, env),
        ...collectShellScripts(command.action, functions, env),
      ];
    case 'case': {
      const found: ShellInvocation[] = [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...commandSubstitutionsInWords([command.word], currentCwd(env)),
      ];
      let clause = command.clauses;
      while (clause) {
        found.push(...commandSubstitutionsInWords(clause.patterns, currentCwd(env)));
        if (clause.action) found.push(...collectShellScripts(clause.action, functions, env));
        clause = clause.next;
      }
      return found;
    }
    case 'function_def': {
      functions.set(command.name.word, command.command);
      return [];
    }
    case 'group':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.command, functions, env),
      ];
    case 'subshell': {
      const snapshot = env.snapshot();
      try {
        return [
          ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
          ...collectShellScripts(command.command, functions, env),
        ];
      } finally {
        env.restore(snapshot);
      }
    }
    case 'arith':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...commandSubstitutionsInWords([command.expression], currentCwd(env)),
      ];
    case 'cond':
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectConditionalShellScripts(command.expression, env).invocations,
      ];
  }
}

type ConditionalTruth = 'true' | 'false' | 'unknown';

interface ConditionalShellScripts {
  invocations: ShellInvocation[];
  truth: ConditionalTruth;
}

function collectConditionalShellScripts(
  node: CondNode,
  env: VariableEnvironment,
): ConditionalShellScripts {
  let result: ConditionalShellScripts;
  if (node.type === COND_AND || node.type === COND_OR) {
    result = collectConditionalLogicalShellScripts(node, env);
  } else if (node.type === COND_EXPR && node.left) {
    result = collectConditionalShellScripts(node.left, env);
  } else if (node.type === COND_TERM) {
    const operand = inspectConditionalWord(node.op, env);
    result = {
      invocations: operand.invocations,
      truth: operand.exact
        ? conditionalTruth(operand.value.length > 0)
        : 'unknown',
    };
  } else if (node.type === COND_UNARY) {
    result = collectConditionalUnaryShellScripts(node, env);
  } else if (node.type === COND_BINARY) {
    result = collectConditionalBinaryShellScripts(node, env);
  } else if (node.type === COND_UNKNOWN) {
    result = {
      invocations: commandSubstitutionsInWords(
        node.words ?? [],
        currentCwd(env),
      ),
      truth: 'unknown',
    };
  } else {
    result = { invocations: [], truth: 'unknown' };
  }

  return (node.flags & CMD_INVERT_RETURN) !== 0
    ? { ...result, truth: invertConditionalTruth(result.truth) }
    : result;
}

function collectConditionalLogicalShellScripts(
  node: CondNode,
  env: VariableEnvironment,
): ConditionalShellScripts {
  if (!node.left || !node.right) {
    return { invocations: [], truth: 'unknown' };
  }
  const left = collectConditionalShellScripts(node.left, env);
  if (node.type === COND_AND && left.truth === 'false') return left;
  if (node.type === COND_OR && left.truth === 'true') return left;

  const right = collectConditionalShellScripts(node.right, env);
  let truth: ConditionalTruth;
  if (node.type === COND_AND) {
    truth = left.truth === 'true'
      ? right.truth
      : right.truth === 'false' ? 'false' : 'unknown';
  } else {
    truth = left.truth === 'false'
      ? right.truth
      : right.truth === 'true' ? 'true' : 'unknown';
  }
  return {
    invocations: [...left.invocations, ...right.invocations],
    truth,
  };
}

function collectConditionalUnaryShellScripts(
  node: CondNode,
  env: VariableEnvironment,
): ConditionalShellScripts {
  const operand = inspectConditionalWord(node.left?.op ?? null, env);
  let truth: ConditionalTruth = 'unknown';
  if (operand.exact) {
    const operator = node.op?.word ?? '';
    if (operator === '-n') truth = conditionalTruth(operand.value.length > 0);
    else if (operator === '-z') truth = conditionalTruth(operand.value.length === 0);
    else if (operator === '-v'
        && /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u.test(operand.value)) {
      const variable = env.find_variable(operand.value);
      truth = variable?.uncertain
        ? 'unknown'
        : conditionalTruth(variable !== undefined);
    }
  }
  return { invocations: operand.invocations, truth };
}

function collectConditionalBinaryShellScripts(
  node: CondNode,
  env: VariableEnvironment,
): ConditionalShellScripts {
  const left = inspectConditionalWord(node.left?.op ?? null, env);
  const right = inspectConditionalWord(node.right?.op ?? null, env);
  let truth: ConditionalTruth = 'unknown';
  if (left.exact && right.exact) {
    const operator = node.op?.word ?? '';
    if ((operator === '=' || operator === '==' || operator === '!=')
        && !hasUnquotedConditionalPattern(node.right?.op?.word ?? '')
        && !hasConditionalPatternValue(right.value)) {
      const equal = left.value === right.value;
      truth = conditionalTruth(operator === '!=' ? !equal : equal);
    } else if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(operator)) {
      truth = compareConditionalIntegers(left.value, operator, right.value);
    }
  }
  return {
    invocations: [...left.invocations, ...right.invocations],
    truth,
  };
}

function inspectConditionalWord(
  word: WordDesc | null,
  env: VariableEnvironment,
): {
  invocations: ShellInvocation[];
  value: string;
  exact: boolean;
} {
  if (!word) return { invocations: [], value: '', exact: false };
  const expanded = expand_word_to_string(word.word, env);
  return {
    invocations: commandSubstitutionInvocations(
      word.word,
      currentCwd(env),
      false,
    ),
    value: expanded.word,
    exact: !expanded.uncertain,
  };
}

function hasUnquotedConditionalPattern(word: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < word.length; index++) {
    const char = word[index];
    if (char === '\\' && quote !== "'") {
      index++;
      continue;
    }
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (quote !== null) continue;
    if (char === '*' || char === '?' || char === '[') return true;
    if ('@+!'.includes(char) && word[index + 1] === '(') return true;
  }
  return false;
}

function hasConditionalPatternValue(value: string): boolean {
  return value.includes('*')
    || value.includes('?')
    || value.includes('[')
    || /(?:^|[^\\])[@+!]\(/u.test(value);
}

function compareConditionalIntegers(
  left: string,
  operator: string,
  right: string,
): ConditionalTruth {
  if (!/^[+-]?[0-9]+$/u.test(left) || !/^[+-]?[0-9]+$/u.test(right)) {
    return 'unknown';
  }
  try {
    const lhs = BigInt(left);
    const rhs = BigInt(right);
    if (operator === '-eq') return conditionalTruth(lhs === rhs);
    if (operator === '-ne') return conditionalTruth(lhs !== rhs);
    if (operator === '-lt') return conditionalTruth(lhs < rhs);
    if (operator === '-le') return conditionalTruth(lhs <= rhs);
    if (operator === '-gt') return conditionalTruth(lhs > rhs);
    return conditionalTruth(lhs >= rhs);
  } catch {
    return 'unknown';
  }
}

function conditionalTruth(value: boolean): ConditionalTruth {
  return value ? 'true' : 'false';
}

function invertConditionalTruth(value: ConditionalTruth): ConditionalTruth {
  if (value === 'true') return 'false';
  if (value === 'false') return 'true';
  return 'unknown';
}

function commandSubstitutionsInWords(words: WordList, cwd: string): ShellInvocation[] {
  return words.flatMap(word => commandSubstitutionInvocations(word.word, cwd, false));
}

function commandSubstitutionsInRedirects(redirect: Redirect | null, cwd: string): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  let current = redirect;
  while (current) {
    const body = current.redirectee.filename?.word;
    if (body !== undefined) {
      const hereDocument = current.instruction === 'r_reading_until' || current.instruction === 'r_deblank_reading_until';
      if (!hereDocument || !current.here_doc_quoted) {
        invocations.push(...commandSubstitutionInvocations(body, cwd, hereDocument));
      }
    }
    current = current.next;
  }
  return invocations;
}

function commandSubstitutionInvocations(text: string, cwd: string, hereDocument: boolean): ShellInvocation[] {
  return extractCommandSubstitutionScripts(text, hereDocument).map(script => ({ script, cwd, shell: 'bash' }));
}

function extractCommandSubstitutionScripts(text: string, hereDocument: boolean): string[] {
  const scripts: string[] = [];
  let quote: 'single' | 'double' | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (!hereDocument && quote === 'single') {
      if (c === '\'') quote = null;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1] ?? '';
      if (!hereDocument || next === '$' || next === '`' || next === '\\' || next === '\n') {
        i += Math.min(2, text.length - i);
      } else {
        i++;
      }
      continue;
    }
    if (!hereDocument && c === '\'' && quote !== 'double') {
      quote = 'single';
      i++;
      continue;
    }
    if (!hereDocument && c === '"') {
      quote = quote === 'double' ? null : quote === null ? 'double' : quote;
      i++;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {
        i += 3;
        continue;
      }
      const end = findCommandSubstitutionEnd(text, i);
      if (end === null) break;
      scripts.push(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = findBacktickEnd(text, i);
      if (end === null) break;
      scripts.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return scripts;
}

function findCommandSubstitutionEnd(text: string, start: number): number | null {
  let quote: 'single' | 'double' | null = null;
  let depth = 1;
  let i = start + 2;
  while (i < text.length) {
    const c = text[i];
    if (quote === 'single') {
      if (c === '\'') quote = null;
      i++;
      continue;
    }
    if (c === '\\') {
      i += Math.min(2, text.length - i);
      continue;
    }
    if (c === '\'' && quote !== 'double') {
      quote = 'single';
      i++;
      continue;
    }
    if (c === '"') {
      quote = quote === 'double' ? null : quote === null ? 'double' : quote;
      i++;
      continue;
    }
    if (c === '`') {
      const end = findBacktickEnd(text, i);
      if (end === null) return null;
      i = end + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const nested = findCommandSubstitutionEnd(text, i);
      if (nested === null) return null;
      i = nested + 1;
      continue;
    }
    if (quote === null && c === '(') {
      depth++;
    } else if (quote === null && c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

function findBacktickEnd(text: string, start: number): number | null {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += Math.min(2, text.length - i);
      continue;
    }
    if (text[i] === '`') return i;
    i++;
  }
  return null;
}

function applyAssignments(command: SimpleCommand, env: VariableEnvironment): () => void {
  const snapshot = command.assignments.length > 0 && command.words.length > 0
    ? env.snapshot_variables(command.assignments.map(assignment => assignment_name(assignment.word)))
    : null;
  for (const assignment of command.assignments) {
    const name = assignment_name(assignment.word);
    const rawValue = assignment_value(assignment.word);
    const expanded = expand_word_to_string(rawValue, env);
    env.bind_variable(name, expanded.word);
  }
  return () => {
    if (snapshot) env.restore_variables(snapshot);
  };
}

function expandSimpleWords(command: SimpleCommand, env: VariableEnvironment): string[] {
  return expand_words(command.words, env, {
    maxWords: MAX_EXPANDED_WORDS,
  }).map(word => word.word);
}

function collectForShellScripts(
  name: string,
  mapList: WordList,
  action: Command,
  functions: Map<string, Command>,
  env: VariableEnvironment,
): ShellInvocation[] {
  const items = expand_words(mapList, env, {
    maxWords: MAX_EXPANDED_WORDS,
  }).map(word => word.word);
  const snapshot = env.snapshot_variables([name]);
  const invocations: ShellInvocation[] = [];
  try {
    for (const item of items) {
      env.bind_variable(name, item);
      invocations.push(...collectShellScripts(action, functions, env));
    }
  } finally {
    env.restore_variables(snapshot);
  }
  return invocations;
}

function applyCd(words: string[], env: VariableEnvironment): void {
  const target = words[1];
  if (!target || EffectTrackerLike.hasUncertainty(target)) return;
  const oldPwd = currentCwd(env);
  const next = target === '-'
    ? env.get_string_value('OLDPWD') ?? oldPwd
    : resolveAgainst(oldPwd, target);
  env.bind_variable('OLDPWD', oldPwd);
  env.bind_variable('PWD', next);
}

function currentCwd(env: VariableEnvironment): string {
  return env.get_string_value('PWD') ?? process.cwd();
}

function resolveAgainst(cwd: string, target: string): string {
  const posixTarget = toPosix(target);
  if (posixTarget.startsWith('/') || isWindowsDriveAbsolute(posixTarget)) return path.posix.normalize(posixTarget);
  return path.posix.normalize(path.posix.join(cwd, posixTarget));
}

function isWindowsDriveAbsolute(value: string): boolean {
  return value.length >= 2 && value[0] === '/' && isAsciiAlpha(value[1]) && (value.length === 2 || value[2] === '/');
}

function isAsciiAlpha(value: string): boolean {
  if (value.length === 0) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const EffectTrackerLike = {
  hasUncertainty(value: string): boolean {
    return value.includes('$') || value.includes('*') || value.includes('?');
  },
};

function extractShellFromInvocation(
  invocation: ResolvedInvocation,
  parentEnv?: VariableEnvironment,
  stdinScript?: string,
): ShellInvocation[] {
  if (invocation.completeness !== 'complete' || invocation.queryOnly
      || invocation.exitsEarly || !invocation.commandName) return [];

  const scripts: ShellInvocation[] = [];
  const executable = powerShellAnalysisEnabled()
    ? invocation.commandName.toLowerCase()
    : invocation.commandName;
  const shell = shellKindForExecutable(executable);
  if (!shell) return scripts;

  const context = childInvocationContext(invocation, parentEnv);
  const makeInvocation = (script: string, targetShell: ShellKind, args?: string[]): ShellInvocation => ({
    script,
    cwd: invocation.cwd,
    shell: targetShell,
    args,
    ...context,
    privileged: invocation.privileged,
  });
  const args = invocation.args;

  if (executable === 'cmd') {
    const cmdIndex = args.findIndex(word => word.toLowerCase() === '/c');
    if (cmdIndex >= 0) scripts.push(makeInvocation(args.slice(cmdIndex + 1).join(' '), 'bash'));
    return scripts;
  }

  if (executable === 'bash' || executable === 'sh' || executable === 'zsh') {
    const resolved = resolveBashCommandString(args);
    if (resolved.script !== undefined) {
      scripts.push(makeInvocation(resolved.script, 'bash', resolved.args));
    }
    return scripts;
  }

  for (let j = 0; j < args.length; j++) {
    const arg = args[j].toLowerCase();
    if (arg === '-command' || arg === '-c') {
      const script = args.slice(j + 1).join(' ');
      if (script === '-' && stdinScript && stdinScript.length > 0) {
        scripts.push(makeInvocation(stdinScript, shell));
      } else if (script.length > 0) {
        scripts.push(makeInvocation(script, shell));
      }
      break;
    }
    if (arg === '-encodedcommand' || arg === '-enc' || arg === '-e') {
      const encoded = args[j + 1];
      if (encoded !== undefined) {
        const decoded = decodePowerShellCommand(encoded);
        if (decoded.length > 0) scripts.push(makeInvocation(decoded, 'powershell'));
      }
      break;
    }
    if (shell === 'powershell' && (arg === '-file' || arg === '-f')) {
      const filePath = args[j + 1];
      if (filePath !== undefined && filePath !== '-') {
        const loaded = readPowerShellFile(invocation.cwd, filePath, args.slice(j + 2));
        if (loaded) scripts.push({ ...loaded, ...context, privileged: invocation.privileged });
      }
      break;
    }
  }
  return scripts;
}

function shellKindForExecutable(executable: string): ShellKind | null {
  if (executable === 'pwsh' || executable === 'pwsh.exe' || executable === 'powershell' || executable === 'powershell.exe') return 'powershell';
  if (executable === 'bash' || executable === 'bash.exe' || executable === 'sh' || executable === 'sh.exe' || executable === 'zsh' || executable === 'zsh.exe') return 'bash';
  if (executable === 'wsl' || executable === 'wsl.exe') return 'bash';
  if (executable === 'cmd' || executable === 'cmd.exe') return 'bash';
  return null;
}

function childInvocationContext(
  invocation: ResolvedInvocation,
  parentEnv?: VariableEnvironment,
): Pick<ShellInvocation, 'env' | 'inheritEnv'> {
  const hasUnset = Object.values(invocation.envOverlay).some(value => value === undefined);
  let inheritEnv = parentEnv === undefined && !invocation.clearEnvironment && !hasUnset;
  let env: Record<string, string>;

  if (parentEnv) env = invocation.clearEnvironment ? emptyEnvironmentRecord() : parentEnv.to_record();
  else if (inheritEnv) env = emptyEnvironmentRecord();
  else env = invocation.clearEnvironment
      ? emptyEnvironmentRecord()
      : new VariableEnvironment().to_record();

  for (const [name, value] of Object.entries(invocation.envOverlay)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  env['PWD'] = invocation.cwd;

  if (parentEnv) inheritEnv = false;
  return { env, inheritEnv };
}

function emptyEnvironmentRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function extractPowerShellNestedShells(
  command: string,
  cwd: string,
  env?: Record<string, string>,
  inheritEnv: boolean = true,
  args?: string[],
): ShellInvocation[] {
  const parsed = analyzePowerShell(command, { cwd, env, inheritEnv, args });
  const invocations: ShellInvocation[] = [];
  const shellEnv = new VariableEnvironment(env, inheritEnv);
  collectPowerShellAstInvocations(parsed.ast.statements, cwd, shellEnv, invocations);
  return invocations;
}

function collectPowerShellAstInvocations(
  statements: import('../powershell/ast.js').PsStatement[],
  cwd: string,
  env: VariableEnvironment,
  invocations: ShellInvocation[],
): void {
  for (const statement of statements) {
    if (statement.type === 'block') {
      collectPowerShellAstInvocations(statement.body, cwd, env, invocations);
      continue;
    }
    for (const command of statement.commands) {
      const words = [command.name.text, ...command.args.map(arg => arg.text)];
      const resolved = resolveInvocation(words, { cwd });
      invocations.push(...extractShellFromInvocation(resolved, env));
    }
  }
}

function hereDocBody(redirect: Redirect | null): string | undefined {
  let current = redirect;
  while (current) {
    if ((current.instruction === 'r_reading_until' || current.instruction === 'r_deblank_reading_until') &&
        current.redirectee.filename?.word !== undefined) {
      return current.redirectee.filename.word;
    }
    current = current.next;
  }
  return undefined;
}

function readPowerShellFile(cwd: string, filePath: string, args: string[]): ShellInvocation | null {
  const resolved = resolveAgainst(cwd, filePath);
  const normalizedCwd = path.posix.normalize(cwd);
  if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd.endsWith('/') ? normalizedCwd : normalizedCwd + '/')) {
    return null;
  }
  try {
    const nativePath = toNative(resolved);
    const stat = fs.statSync(nativePath);
    if (!stat.isFile()) return null;
    const cached = POWERSHELL_FILE_CACHE.get(resolved);
    const script = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
      ? cached.script
      : fs.readFileSync(nativePath, 'utf8');
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      POWERSHELL_FILE_CACHE.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, script });
    }
    return {
      script,
      cwd: path.posix.dirname(resolved),
      shell: 'powershell',
      args,
    };
  } catch {
    return null;
  }
}

function decodePowerShellCommand(encoded: string): string {
  try {
    return trimTrailingNuls(Buffer.from(encoded, 'base64').toString('utf16le'));
  } catch {
    return '';
  }
}

function trimTrailingNuls(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '\0') end--;
  return value.slice(0, end);
}

export function protect(command: string, cwd?: string, shell: ShellKind = 'bash'): ProtectResult {
  const analysis = analyzeProtectedCommand(command, cwd, shell);
  const verdict: DecideResult = riskDecide(analysis);
  return buildProtectResult(verdict, analysis);
}

export async function protectWithReview(command: string, cwd?: string, shell: ShellKind = 'bash'): Promise<ProtectResult> {
  const result = protect(command, cwd, shell);
  return reviewProtectResult(result, command, cwd, shell);
}

export async function reviewProtectResult(
  result: ProtectResult,
  command: string,
  cwd?: string,
  shell: ShellKind = 'bash',
  conversationId?: string,
): Promise<ProtectResult> {
  const reviewEnabled = cloudReviewEnabled();
  const localResult = applyOfflineRiskPolicy(result, reviewEnabled);
  if (localResult.severity === 'safe' || !reviewEnabled) {
    return applyBlockSuppression(localResult, command);
  }

  const wireConversationId = conversationIdForWire(conversationId);
  const review = await callBashReview({
    version: VER,
    ...(wireConversationId === undefined ? {} : { conversation_id: wireConversationId }),
    platform: process.platform,
    cwd: cwd ?? process.cwd(),
    command,
    shell,
    severity: result.severity,
    reasonCodes: result.reasonCodes,
    analysis: trimAnalysisForWire(result.analysis),
  });
  if (review?.decision === 'pass') {
    if (result.decision !== 'pass') log(`cloud review pass overruled local ${result.decision}`);
    return {
      ...result,
      decision: 'pass',
      detail: '',
    };
  }
  if (review?.decision === 'block' || review?.decision === 'stop') {
    // A valid cloud verdict is authoritative for reviewable Guardrail operations.
    return applyBlockSuppression({
      ...result,
      decision: review.decision,
      detail: renderReasonCodesDetailed(result.reasonCodes, result.analysis, {
        platform: process.platform,
      }),
      needUpdate: review.need_update === true,
    }, command);
  }
  return applyBlockSuppression(result, command);
}

/**
 * A final command-level block may be deliberately suppressed only by an exact
 * risk-ID declaration on the command's first physical line. Stops are never
 * suppressible. The comparison is set-based so ID order is not significant,
 * while duplicates, missing IDs, and extra IDs are rejected.
 */
export function applyBlockSuppression(
  result: ProtectResult,
  command: string,
): ProtectResult {
  if (result.decision !== 'block') return result;

  const declaredIds = parseSuppressionRiskIds(command);
  const currentIds = normalizedRiskIds(result.reasonCodes);
  if (
    declaredIds === null
    || currentIds.length === 0
    || declaredIds.length !== currentIds.length
    || declaredIds.some((id, index) => id !== currentIds[index])
  ) {
    return result;
  }

  return {
    ...result,
    decision: 'pass',
    detail: '',
  };
}

function parseSuppressionRiskIds(command: string): number[] | null {
  const newline = command.indexOf('\n');
  const firstLineWithPossibleCr = newline < 0 ? command : command.slice(0, newline);
  const firstLine = firstLineWithPossibleCr.endsWith('\r')
    ? firstLineWithPossibleCr.slice(0, -1)
    : firstLineWithPossibleCr;
  const match = /^# atuin-suppress-warning: ([1-9]\d*(?:,[1-9]\d*)*)$/.exec(firstLine);
  if (!match) return null;

  const ids = match[1].split(',').map(value => Number(value));
  if (ids.some(id => !Number.isSafeInteger(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids.sort((left, right) => left - right);
}

function normalizedRiskIds(reasonCodes: readonly ReasonCode[]): number[] {
  return [...new Set(reasonCodes.filter(code => Number.isSafeInteger(code)))]
    .sort((left, right) => left - right);
}

/**
 * When cloud review is disabled by configuration, risky observations fail
 * closed as a command-level block. Critical local evidence remains a stronger
 * stop.
 */
export function applyOfflineRiskPolicy(
  result: ProtectResult,
  reviewEnabled: boolean = cloudReviewEnabled(),
): ProtectResult {
  if (reviewEnabled || result.severity !== 'risky' || result.decision !== 'pass') return result;
  return {
    ...result,
    decision: 'block',
    detail: renderReasonCodesDetailed(result.reasonCodes, result.analysis, {
      platform: process.platform,
    }),
  };
}

function buildProtectResult(verdict: DecideResult, analysis: Analysis): ProtectResult {
  const detail = verdict.decision !== 'pass'
    ? renderReasonCodesDetailed(verdict.reasonCodes, analysis, {
        platform: process.platform,
      })
    : '';
  return {
    decision: verdict.decision,
    severity: verdict.severity,
    reasonCodes: verdict.reasonCodes,
    detail,
    analysis,
  };
}

async function callBashReview(payload: BashReviewRequest): Promise<BashReviewResponse | null> {
  try {
    const body = await postToShellGuard(SHELL_GUARD_REVIEW_PATH, payload);
    if (body?.decision === 'pass' || body?.decision === 'block' || body?.decision === 'stop') {
      return {
        decision: body.decision,
        need_update: body.need_update === true,
      };
    }
    log(`cloud review returned unexpected response: ${JSON.stringify(body)}`);
  } catch (err: unknown) {
    log(`cloud review failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

async function postToShellGuard(endpoint: string, payload: BashReviewRequest): Promise<BashReviewResponse | null> {
  const fetchFn = globalThis.fetch;
  if (!fetchFn) throw new Error('fetch is unavailable');

  const installationId = getInstallationId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHELL_GUARD_TIMEOUT_MS);
  try {
    const response = await fetchFn(shellGuardUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Accept-Encoding': 'br, gzip',
        'X-Service-Id': 'atuin',
        'User-Agent': `Atuin Shell Guard/${VER}`,
        ...(installationId ? { 'x-atuin-iid': installationId } : {}),
      },
      body: zlib.gzipSync(JSON.stringify(payload)),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text || '{}') as BashReviewResponse;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      const timeoutError = new Error(`POST ${endpoint} timed out`) as Error & { cause?: unknown };
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function trimAnalysisForWire(
  analysis: Analysis,
): Analysis & { effectsTruncated?: boolean; gitEffectsTruncated?: boolean; resourceEffectsTruncated?: boolean } {
  const effects = analysis.effects ?? [];
  let kept = effects;
  if (effects.length > MAX_FORWARD_EFFECTS) {
    const important = effects.filter(effect =>
      isSystemPath(effect.path) ||
      isCatastrophicPath(effect.path) ||
      !!effect.uncertain);
    const regular = effects.filter(effect => !important.includes(effect));
    kept = important.slice(0, MAX_FORWARD_EFFECTS);
    for (const effect of regular) {
      if (kept.length >= MAX_FORWARD_EFFECTS) break;
      kept.push(effect);
    }
  }
  const gitEffects = analysis.gitEffects ?? [];
  const keptGitEffects = gitEffects.slice(0, MAX_FORWARD_GIT_EFFECTS);
  const resourceEffects = analysis.resourceEffects ?? [];
  const keptResourceEffects = resourceEffects.slice(0, MAX_FORWARD_RESOURCE_EFFECTS);

  return {
    available: analysis.available,
    effects: kept.map(effect => ({
      type: effect.type,
      path: effect.path,
      source: effect.source,
      sourcePath: effect.sourcePath,
      line: effect.line,
      command: effect.command,
      uncertain: effect.uncertain,
      certainty: effect.certainty,
      uncertainty: [...effect.uncertainty],
    })),
    effectsTotal: analysis.effectsTotal,
    gitEffects: keptGitEffects.map(stripLocalProvenance),
    gitEffectsTotal: analysis.gitEffectsTotal,
    resourceEffects: keptResourceEffects.map(stripLocalProvenance),
    resourceEffectsTotal: analysis.resourceEffectsTotal,
    warnings: analysis.warnings,
    affected: trimAffectedForWire(analysis.affected),
    error: analysis.error,
    effectsTruncated: effects.length > kept.length,
    gitEffectsTruncated: gitEffects.length > keptGitEffects.length,
    resourceEffectsTruncated: resourceEffects.length > keptResourceEffects.length,
  };
}

function stripLocalProvenance<T extends { provenance?: number[] }>(
  effect: T,
): T {
  const copy = { ...effect };
  delete copy.provenance;
  return copy;
}

function trimAffectedForWire(affected: Analysis['affected']): Analysis['affected'] {
  if (!affected) return undefined;
  return {
    totalFileCount: affected.totalFileCount,
    totalSize: affected.totalSize,
    policyFileCount: affected.policyFileCount,
    policyTotalSize: affected.policyTotalSize,
    definitePolicyFileCount: affected.definitePolicyFileCount,
    definitePolicyTotalSize: affected.definitePolicyTotalSize,
    conditionalPolicyFileCount: affected.conditionalPolicyFileCount,
    conditionalPolicyTotalSize: affected.conditionalPolicyTotalSize,
    budgetExhausted: affected.budgetExhausted,
    budgetExhaustedCertainty: affected.budgetExhaustedCertainty,
    oldest: (affected.oldest ?? []).map(trimSampleForWire),
    largest: (affected.largest ?? []).map(trimSampleForWire),
    groups: (affected.groups ?? []).map(group => ({
      extension: group.extension,
      totalCount: group.totalCount,
      totalSize: group.totalSize,
      files: group.files.map(trimSampleForWire),
    })),
    specialTargets: (affected.specialTargets ?? [])
      .slice(0, MAX_AFFECTED_SAMPLES)
      .map(target => ({
        path: target.path,
        kind: target.kind,
        operation: target.operation,
        executionCertainty: target.executionCertainty,
        safeSink: target.safeSink,
      })),
    metadataUnavailable: (affected.metadataUnavailable ?? [])
      .slice(0, MAX_AFFECTED_SAMPLES)
      .map(observation => ({
        path: observation.path,
        operation: observation.operation,
        executionCertainty: observation.executionCertainty,
        error: observation.error,
      })),
  };
}

function trimSampleForWire(file: SampleFile): SampleFile {
  return {
    path: file.path,
    size: file.size,
    createdAt: file.createdAt,
  };
}

function cloudReviewEnabled(): boolean {
  return getCloudReviewSetting() === 'yes';
}

function conversationIdForWire(value: string | undefined): string | undefined {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_FORWARD_CONVERSATION_ID_BYTES) {
    return undefined;
  }
  return value;
}

function shellGuardUrl(endpoint: string): string {
  const base = process.env['XW_SHELL_GUARD_URL'] || SHELL_GUARD_DEFAULT_URL;
  return `${base.replace(/\/+$/, '')}${endpoint}`;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sampleAffected(list: AffectedFile[] | undefined): AffectedSample[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_AFFECTED_SAMPLES).map(f => ({
    path: f.path,
    createdAt: f.createdAt.toISOString(),
    modifiedAt: f.modifiedAt.toISOString(),
    size: f.size,
    operations: [...f.operations],
    executionCertainty: f.executionCertainty,
    disposable: f.disposable,
  }));
}

function sampleGroups(groups: ExtensionGroup[] | undefined): {
  extension: string;
  totalCount: number;
  totalSize: number;
  policyCount: number;
  policySize: number;
  definitePolicyCount: number;
  definitePolicySize: number;
  conditionalPolicyCount: number;
  conditionalPolicySize: number;
  disposable: boolean;
  files: AffectedSample[];
  policyFiles: AffectedSample[];
}[] {
  if (!Array.isArray(groups)) return [];
  return groups.map(g => ({
    extension: g.extension,
    totalCount: g.totalCount,
    totalSize: g.totalSize,
    policyCount: g.policyCount,
    policySize: g.policySize,
    definitePolicyCount: g.definitePolicyCount,
    definitePolicySize: g.definitePolicySize,
    conditionalPolicyCount: g.conditionalPolicyCount,
    conditionalPolicySize: g.conditionalPolicySize,
    disposable: g.disposable,
    files: sampleAffected(g.files),
    policyFiles: sampleAffected(g.policyFiles),
  }));
}

export { riskDecide as decide, renderReasonCodes, renderReasonCodesDetailed };
export { powerShellAnalysisEnabled } from './platform.js';
export { RISK_REASON_CODES } from '../analysis/risk_model.js';
export type { Analysis, ReasonCode };
