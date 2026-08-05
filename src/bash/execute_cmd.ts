// execute_cmd.ts — Dry-run AST walker and command dispatch

import type {
  Command, SimpleCommand, ForCommand, CaseCommand, WhileCommand,
  IfCommand, Connection, FunctionDef, GroupCommand, SubshellCommand,
  PatternList, Redirect, WordDesc, ArithCommand, CondCommand, CondNode,
} from './command.js';
import {
  AMP,
  AND_AND,
  BAR_AND,
  CASEPAT_FALLTHROUGH,
  CASEPAT_TESTNEXT,
  CMD_AMPERSAND,
  CMD_INVERT_RETURN,
  COND_AND,
  COND_BINARY,
  COND_EXPR,
  COND_OR,
  COND_TERM,
  COND_UNARY,
  COND_UNKNOWN,
  OR_OR,
  PIPE,
  W_QUOTED,
} from './command.js';
import type { VariableEnvironment } from './variables.js';
import type {
  EffectIdentitySets,
  EffectTracker,
  UncertaintyReason,
} from '../analysis/effects.js';
import type {
  AbstractFdTarget,
  AnalysisState,
  ShellStateSnapshot,
} from '../analysis/state.js';
import {
  appendPathUncertainty,
  captureShellState,
  cloneFdTarget,
  cloneIoState,
  collapseEquivalentShellStates,
  installShellStates,
  makeAnalysisState,
  MAX_SHELL_PATHS,
  restoreShellState,
  takeShellStates,
} from '../analysis/state.js';
import type {
  AbstractStatus,
  AbstractStream,
  ControlTransfer,
} from '../analysis/abstract.js';
import {
  appendStreams,
  DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
  emptyStream,
  exactStatus,
  exactStream,
  failureStatusPart,
  failureStatus,
  invertStatus,
  joinStreams,
  joinStatuses,
  normalControl,
  pipelineStatus,
  stripTrailingNewlines,
  successStatus,
  successfulStatusPart,
  unknownStream,
  unknownStatus,
} from '../analysis/abstract.js';
import { COMMAND_HANDLERS, parseMakeInvocation, resolveMakeCwd } from './commands.js';
import {
  expand_here_document,
  expand_words,
  expand_word_to_string,
  expand_word_unsplit_to_string,
  glob_expand_words,
  MAX_EXPANDED_WORDS,
} from './subst.js';
import type {
  CommandSubstitutionExpansion,
  ExpandedWord,
  ExpansionContext,
  ExpansionTrace,
  ProcessSubstitutionDirection,
} from './subst.js';
import { parse } from './parse.js';
import { is_write_redirect, is_append_redirect, redirect_target_filename } from './redir.js';
import {
  assignment_base_name,
  assignment_name,
  assignment_operator,
  assignment_value,
  parse_array_reference,
} from './general.js';
import { apply_set_flag, apply_set_option } from './flags.js';
import type { ShellFlags } from './flags.js';
import { isAbsolutePath, toNative, toPosix } from '../analysis/vfs.js';
import {
  resolveBashCommandString,
  resolveInvocation,
  type ResolvedInvocation,
} from './invocation.js';
import * as fs from 'node:fs';
import { posix as path } from 'node:path';
import { evaluateTestBuiltin } from './test_builtin.js';
import { evaluateArithmeticExpression } from './arithmetic.js';
import { resolve_array_element } from './arrays.js';

const MAX_NESTED_SCRIPT_DEPTH = 4;
const MAX_EVAL_SCRIPT_CHARS = 64 * 1024;
const MAX_SOURCE_SCRIPT_BYTES = 128 * 1024;
const MAX_SOURCE_PATH_CHARS = 16 * 1024;
const MAX_SOURCE_PATH_ENTRIES = 64;
const MAX_PROCESS_SUBSTITUTIONS = 64;
const MAX_PROCESS_SUBSTITUTION_SCRIPT_CHARS = 64 * 1024;
const MAX_COMMAND_SUBSTITUTION_SCRIPT_CHARS = 64 * 1024;
const MAX_EXEC_STATEMENTS = 10000;
const MAX_FUNCTION_CALL_DEPTH = 64;
const EXECUTION_GUARD_REASONS = new Set<UncertaintyReason>([
  'conditional-branch',
  'case-branch',
  'and-or-branch',
  'unknown-loop-count',
  'uncertain-loop-values',
  'pipeline-race',
  'background-race',
  'unknown-command',
]);

/** Main dispatch — switch on command type */
export function execute_command(
  cmd: Command,
  tracker: EffectTracker,
  env: VariableEnvironment,
  flags: ShellFlags,
): AbstractStatus {
  return execute_command_state(cmd, makeAnalysisState(env, flags, tracker));
}

export function execute_command_state(cmd: Command, state: AnalysisState): AbstractStatus {
  if (state.runtime.alternatives.length > 0) {
    return executeAcrossShellStates(cmd, state);
  }
  return executeCommandConcrete(cmd, state);
}

function executeCommandConcrete(
  cmd: Command,
  state: AnalysisState,
  ignoreAsync = false,
  countStep = true,
): AbstractStatus {
  return state.tracker.withProvenance({
    kind: 'ast-command',
    label: describeAstCommand(cmd),
    line: cmd.line,
  }, () => executeCommandConcreteTraced(
    cmd,
    state,
    ignoreAsync,
    countStep,
  ));
}

function executeCommandConcreteTraced(
  cmd: Command,
  state: AnalysisState,
  ignoreAsync: boolean,
  countStep: boolean,
): AbstractStatus {
  if (state.control.kind !== 'none') return state.lastStatus;
  const before = state.tracker.checkpoint();
  const inheritedUncertainty = [...state.runtime.pathUncertainty];
  const asynchronous = !ignoreAsync && (cmd.flags & CMD_AMPERSAND) !== 0;
  const savedFds = asynchronous ? null : cloneIoState(state.io).fds;
  let status: AbstractStatus;
  if (countStep && !enterExecutionStep(state)) {
    status = unknownStatus();
  } else if (asynchronous) {
    status = executeBackgroundCommand(cmd, state);
  } else if (!collect_redirect_effects(cmd.redirects, state)) {
    status = failureStatus();
  } else {
    status = dispatchCommand(cmd, state);
  }
  if (!asynchronous && (cmd.flags & CMD_INVERT_RETURN)
      && (state.control.kind === 'none' || state.runtime.alternatives.length > 0)) {
    status = invertAlternativeStatuses(state, status);
  }
  const result = setLastStatus(state, status);
  if (inheritedUncertainty.length > 0) {
    state.tracker.markInheritedExecutionUncertaintyFrom(
      before,
      inheritedUncertainty,
    );
  }
  if (savedFds) restoreFileDescriptors(state, savedFds);
  return result;
}

function describeAstCommand(cmd: Command): string {
  switch (cmd.type) {
    case 'simple': {
      const words = [...cmd.assignments, ...cmd.words]
        .map(word => word.word)
        .join(' ');
      return words || 'redirect-only simple command';
    }
    case 'arith':
      return `(( ${cmd.expression.word} ))`;
    case 'cond':
      return '[[ conditional expression ]]';
    case 'function_def':
      return `function ${cmd.name.word}`;
    default:
      return `${cmd.type} command`;
  }
}

function dispatchCommand(cmd: Command, state: AnalysisState): AbstractStatus {
  const { env } = state;
  let status: AbstractStatus;
  switch (cmd.type) {
    case 'simple':
      status = execute_simple_command(cmd, state);
      break;
    case 'for':
      status = execute_for_command(cmd, state);
      break;
    case 'case':
      status = execute_case_command(cmd, state);
      break;
    case 'while':
      status = execute_while_command(cmd, state);
      break;
    case 'until':
      status = execute_until_command(cmd, state);
      break;
    case 'if':
      status = execute_if_command(cmd, state);
      break;
    case 'connection':
      status = execute_connection(cmd, state);
      break;
    case 'function_def':
      register_function(cmd, env);
      status = successStatus();
      break;
    case 'group':
      status = execute_group_command(cmd, state);
      break;
    case 'subshell':
      status = execute_subshell(cmd, state);
      break;
    case 'arith':
      status = execute_arith_command(cmd, state);
      break;
    case 'cond':
      status = execute_cond_command(cmd, state);
      break;
  }
  return status;
}

function executeAcrossShellStates(
  cmd: Command,
  state: AnalysisState,
): AbstractStatus {
  const before = state.tracker.checkpoint();
  const inputs = takeShellStates(state);
  const outputs: ShellStateSnapshot[] = [];
  const pathIdentities: EffectIdentitySets[] = [];
  for (const input of inputs) {
    restoreShellState(state, input);
    state.runtime.alternatives = [];
    if (input.control.kind !== 'none') {
      pathIdentities.push(emptyEffectIdentities());
      outputs.push(input);
      continue;
    }
    const pathBefore = state.tracker.checkpoint();
    executeCommandConcrete(cmd, state);
    pathIdentities.push(state.tracker.identitiesFrom(pathBefore));
    outputs.push(...takeShellStates(state));
  }
  state.tracker.deduplicateAllFrom(before);
  const commonIdentities = intersectEffectIdentities(pathIdentities);
  const executionGuardReasons = isDirectLeafEffectCommand(cmd, inputs)
    ? new Set(
      inputs.flatMap(input => input.pathUncertainty)
        .filter(reason => EXECUTION_GUARD_REASONS.has(reason)),
    )
    : new Set<UncertaintyReason>();
  state.tracker.removeExecutionUncertaintyFrom(
    before,
    commonIdentities,
    [...executionGuardReasons],
  );
  const retainedUncertainty = commonPathUncertainty(
    inputs.map(input => input.pathUncertainty),
  ).filter(reason => reason !== 'pipeline-race' && reason !== 'background-race');
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      retainedUncertainty,
      state.tracker,
    ),
  );
}

function isDirectLeafEffectCommand(
  cmd: Command,
  inputs: readonly ShellStateSnapshot[],
): boolean {
  if (cmd.type !== 'simple') return false;
  const commandName = cmd.words[0]?.word;
  if (commandName && inputs.some(input => input.env.functions.has(commandName))) {
    return false;
  }
  return cmd.redirects !== null
    || (commandName !== undefined && COMMAND_HANDLERS.has(commandName));
}

function invertAlternativeStatuses(
  state: AnalysisState,
  fallback: AbstractStatus,
): AbstractStatus {
  if (state.runtime.alternatives.length === 0) {
    return setLastStatus(state, invertStatus(fallback));
  }
  const outputs: ShellStateSnapshot[] = [];
  for (const snapshot of takeShellStates(state)) {
    restoreShellState(state, snapshot);
    if (snapshot.control.kind === 'none') {
      setLastStatus(state, invertStatus(snapshot.lastStatus));
    }
    outputs.push(captureShellState(state));
  }
  return installShellStates(state, outputs);
}

function execute_simple_command(
  cmd: SimpleCommand,
  state: AnalysisState,
): AbstractStatus {
  const { env } = state;
  state.runtime.lastCommandSubstitutionStatus = null;
  const expanded = expandSimpleCommandWords(cmd, state);
  const hasCommand = expanded.length > 0;
  const temporaryAssignments = cmd.assignments.length > 0 && hasCommand
    ? env.snapshot_variables(cmd.assignments.map(a => assignment_base_name(a.word)))
    : null;

  // Bash expands ordinary command words before applying prefix assignments.
  // Assignment RHS expansion is then left-to-right without field splitting.
  for (const a of cmd.assignments) {
    const target = assignment_name(a.word);
    const rawValue = assignment_value(a.word);
    const value = expand_word_unsplit_to_string(
      rawValue,
      env,
      expansionWarning(state),
      expansionContext(state),
    );
    applyShellAssignment(
      target,
      assignment_operator(a.word),
      value,
      state,
    );
  }

  if (!hasCommand) {
    // Assignment-only command
    return state.runtime.lastCommandSubstitutionStatus ?? successStatus();
  }

  try {
    return execute_simple_command_body(cmd, state, expanded);
  } finally {
    if (temporaryAssignments) {
      mapShellStates(state, () => {
        env.restore_variables(temporaryAssignments);
        return captureShellState(state);
      });
    }
  }
}

function applyShellAssignment(
  target: string,
  operator: '=' | '+=',
  value: ExpandedWord,
  state: AnalysisState,
): void {
  const reference = parse_array_reference(target);
  if (!reference) {
    const previousProvenance = operator === '+='
      ? state.env.get_value_provenance(target)
      : [];
    const assigned = operator === '+='
      ? (state.env.get_string_value(target) ?? '') + value.word
      : value.word;
    state.env.bind_variable(
      target,
      assigned,
      0,
      value.uncertain,
      [...previousProvenance, ...(value.provenance ?? [])],
    );
    return;
  }

  const resolved = resolve_array_element(
    reference,
    state.env,
    subscript => expand_word_unsplit_to_string(
      subscript,
      state.env,
      expansionWarning(state),
      expansionContext(state),
    ),
  );
  if (resolved.key === null) {
    state.env.widen_array(
      reference.name,
      resolved.kind,
      [...resolved.provenance, ...(value.provenance ?? [])],
    );
    return;
  }
  const previous = state.env.get_array_element(reference.name, resolved.key);
  const assigned = operator === '+='
    ? (previous.value ?? '') + value.word
    : value.word;
  state.env.bind_array_element(
    reference.name,
    resolved.key,
    assigned,
    value.uncertain || resolved.uncertain || previous.uncertain,
    resolved.kind,
    [
      ...resolved.provenance,
      ...(operator === '+=' ? previous.provenance : []),
      ...(value.provenance ?? []),
    ],
  );
}

function execute_cond_command(
  cmd: CondCommand,
  state: AnalysisState,
): AbstractStatus {
  return execute_cond_node(cmd.expression, state);
}

function execute_arith_command(
  cmd: ArithCommand,
  state: AnalysisState,
): AbstractStatus {
  const expanded = expand_word_unsplit_to_string(
    cmd.expression.word,
    state.env,
    expansionWarning(state),
    expansionContext(state),
  );
  const evaluated = evaluateArithmeticExpression(expanded.word, state.env);
  if (expanded.uncertain || evaluated.uncertain || evaluated.value === null) {
    warnOnce(
      state,
      `arithmetic-command-${cmd.line}`,
      `arithmetic command at line ${cmd.line} widened to unknown`,
    );
    return unknownStatus();
  }
  return conditional_boolean_status(evaluated.value !== 0n);
}

function execute_cond_node(
  node: CondNode,
  state: AnalysisState,
): AbstractStatus {
  let status: AbstractStatus;
  if (node.type === COND_AND || node.type === COND_OR) {
    status = execute_cond_logical(node, state);
  } else if (node.type === COND_EXPR && node.left) {
    status = execute_cond_node(node.left, state);
  } else if (node.type === COND_UNARY) {
    status = evaluate_cond_unary(node, state);
  } else if (node.type === COND_BINARY) {
    status = evaluate_cond_binary(node, state);
  } else if (node.type === COND_TERM) {
    const value = expand_cond_word(node.op, state);
    status = value.uncertain
      ? unknownStatus()
      : conditional_boolean_status(value.word.length > 0);
    setLastStatus(state, status);
  } else if (node.type === COND_UNKNOWN) {
    status = execute_unknown_cond(node, state);
  } else {
    status = unknownStatus();
    setLastStatus(state, status);
  }

  if ((node.flags & CMD_INVERT_RETURN) !== 0) {
    return invertAlternativeStatuses(state, status);
  }
  return status;
}

function execute_cond_logical(
  node: CondNode,
  state: AnalysisState,
): AbstractStatus {
  const before = state.tracker.checkpoint();
  execute_cond_node(node.left!, state);
  const candidates: Array<{
    input: ShellStateSnapshot;
    entryStatus: AbstractStatus;
    executeRight: boolean;
    route: 'skip' | 'execute';
  }> = [];
  for (const input of takeShellStates(state)) {
    if (node.type === COND_AND) {
      if (input.lastStatus.mayFail) {
        candidates.push({
          input,
          entryStatus: failureStatusPart(input.lastStatus),
          executeRight: false,
          route: 'skip',
        });
      }
      if (input.lastStatus.maySucceed) {
        candidates.push({
          input,
          entryStatus: successfulStatusPart(input.lastStatus),
          executeRight: true,
          route: 'execute',
        });
      }
    } else {
      if (input.lastStatus.maySucceed) {
        candidates.push({
          input,
          entryStatus: successfulStatusPart(input.lastStatus),
          executeRight: false,
          route: 'skip',
        });
      }
      if (input.lastStatus.mayFail) {
        candidates.push({
          input,
          entryStatus: failureStatusPart(input.lastStatus),
          executeRight: true,
          route: 'execute',
        });
      }
    }
  }

  const retainedUncertainty = commonPathUncertainty(
    candidates.map(candidate => candidate.input.pathUncertainty),
  );
  const conditional = new Set(candidates.map(candidate => candidate.route)).size > 1;
  const outputs: ShellStateSnapshot[] = [];
  for (const candidate of candidates) {
    const input = conditional
      ? appendPathUncertainty(candidate.input, 'and-or-branch')
      : candidate.input;
    restoreShellState(state, input);
    state.runtime.alternatives = [];
    setLastStatus(state, candidate.entryStatus);
    if (candidate.executeRight && node.right) {
      execute_cond_node(node.right, state);
    }
    outputs.push(...takeShellStates(state));
  }
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      retainedUncertainty,
      state.tracker,
    ),
  );
}

function evaluate_cond_unary(
  node: CondNode,
  state: AnalysisState,
): AbstractStatus {
  const operator = node.op?.word ?? '';
  const operand = expand_cond_word(node.left?.op ?? null, state);
  let status: AbstractStatus;
  if (operand.uncertain) {
    status = unknownStatus();
  } else if (operator === '-n') {
    status = conditional_boolean_status(operand.word.length > 0);
  } else if (operator === '-z') {
    status = conditional_boolean_status(operand.word.length === 0);
  } else if (operator === '-v') {
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u.test(operand.word)) {
      status = unknownStatus();
    } else {
      const variable = state.env.find_variable(operand.word);
      status = variable?.uncertain
        ? unknownStatus()
        : conditional_boolean_status(variable !== undefined);
    }
  } else if (operator === '-o') {
    const flags = state.flags as unknown as Record<string, boolean>;
    status = Object.prototype.hasOwnProperty.call(flags, operand.word)
      ? conditional_boolean_status(flags[operand.word])
      : unknownStatus();
  } else {
    status = evaluateTestBuiltin(
      'test',
      [operator, operand.word],
      state.tracker.vfs,
      state.tracker.getCwd(),
    );
  }
  setLastStatus(state, status);
  return status;
}

function evaluate_cond_binary(
  node: CondNode,
  state: AnalysisState,
): AbstractStatus {
  const operator = node.op?.word ?? '';
  const left = expand_cond_word(node.left?.op ?? null, state);
  const right = expand_cond_word(node.right?.op ?? null, state);
  let status: AbstractStatus;
  if (left.uncertain || right.uncertain) {
    status = unknownStatus();
  } else if (operator === '=' || operator === '==' || operator === '!=') {
    const matched = match_cond_pattern(
      left.word,
      right.word,
      node.right?.op ?? null,
    );
    status = matched === null
      ? unknownStatus()
      : conditional_boolean_status(operator === '!=' ? !matched : matched);
  } else if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(operator)) {
    status = evaluate_cond_integer_binary(left.word, operator, right.word);
  } else {
    // Locale ordering, regex, and file identity/time comparisons need richer
    // abstract domains; operand expansions still run before widening.
    status = unknownStatus();
  }
  setLastStatus(state, status);
  return status;
}

function expand_cond_word(
  word: WordDesc | null,
  state: AnalysisState,
): ExpandedWord {
  if (!word) return { word: '', uncertain: true };
  return expand_word_unsplit_to_string(
    word.word,
    state.env,
    expansionWarning(state),
    expansionContext(state),
  );
}

function match_cond_pattern(
  value: string,
  pattern: string,
  patternWord: WordDesc | null,
): boolean | null {
  if (!patternWord) return null;
  const quoteMode = conditional_word_quote_mode(patternWord);
  if (quoteMode === 'mixed') return null;
  if (quoteMode === 'quoted') return value === pattern;
  if (/(^|[^\\])[?*+@!]\(/u.test(patternWord.word)
      || !hasSupportedCaseBrackets(pattern)) {
    return null;
  }
  return matchCasePattern(pattern, value);
}

function conditional_word_quote_mode(
  word: WordDesc,
): 'unquoted' | 'quoted' | 'mixed' {
  if ((word.flags & W_QUOTED) === 0) return 'unquoted';
  let quote: "'" | '"' | null = null;
  let quoted = false;
  let unquoted = false;
  for (let index = 0; index < word.word.length; index++) {
    const char = word.word[index];
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      quoted = true;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (quote === null && char === '\\') {
      quoted = true;
      index++;
      continue;
    }
    if (quote === null) unquoted = true;
    else quoted = true;
  }
  return quoted && unquoted ? 'mixed' : (quoted ? 'quoted' : 'unquoted');
}

function evaluate_cond_integer_binary(
  left: string,
  operator: string,
  right: string,
): AbstractStatus {
  const lhs = parse_cond_integer(left);
  const rhs = parse_cond_integer(right);
  if (lhs === null || rhs === null) return unknownStatus();
  if (operator === '-eq') return conditional_boolean_status(lhs === rhs);
  if (operator === '-ne') return conditional_boolean_status(lhs !== rhs);
  if (operator === '-lt') return conditional_boolean_status(lhs < rhs);
  if (operator === '-le') return conditional_boolean_status(lhs <= rhs);
  if (operator === '-gt') return conditional_boolean_status(lhs > rhs);
  return conditional_boolean_status(lhs >= rhs);
}

function conditional_boolean_status(value: boolean): AbstractStatus {
  return value ? successStatus() : exactStatus(1);
}

function parse_cond_integer(value: string): bigint | null {
  if (!/^[+-]?[0-9]+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function execute_unknown_cond(
  node: CondNode,
  state: AnalysisState,
): AbstractStatus {
  const before = state.tracker.checkpoint();
  const parent = captureShellState(state);
  const guarded = appendPathUncertainty(parent, 'and-or-branch');
  restoreShellState(state, guarded);
  state.runtime.alternatives = [];
  for (const word of node.words ?? []) expand_cond_word(word, state);
  setLastStatus(state, unknownStatus());
  const expanded = takeShellStates(state);

  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  setLastStatus(state, unknownStatus());
  const skipped = captureShellState(state);
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      [skipped, ...expanded],
      parent.pathUncertainty,
      state.tracker,
    ),
  );
}

function expandSimpleCommandWords(
  cmd: SimpleCommand,
  state: AnalysisState,
): ExpandedWord[] {
  const { tracker, env, flags } = state;
  const expanded0 = limitExpandedWords(
    expand_words(
      cmd.words,
      env,
      {
        maxWords: MAX_EXPANDED_WORDS,
        onWarning: expansionWarning(state),
        context: expansionContext(state),
      },
    ),
    state,
    cmd.line,
    'word expansion',
  );
  const expanded = limitExpandedWords(
    flags.noglob
      ? expanded0
      : glob_expand_words(
        expanded0,
        tracker.vfs,
        tracker.getCwd(),
        {
          maxWords: MAX_EXPANDED_WORDS,
          recordExpansion: trace =>
            tracker.addProvenance(expansionProvenance(trace)),
          onWarning: expansionWarning(state),
        },
      ),
    state,
    cmd.line,
    flags.noglob ? 'word expansion' : 'glob expansion',
  );
  return expanded;
}

function execute_simple_command_body(
  cmd: SimpleCommand,
  state: AnalysisState,
  expanded: ExpandedWord[],
): AbstractStatus {
  const { tracker } = state;
  if (expanded.length === 0) return successStatus();

  const invocation = resolveInvocation(expanded.map(word => word.word), { cwd: tracker.getCwd() });
  for (const warning of invocation.warnings) {
    tracker.addWarning(`${warning} (line ${cmd.line})`);
  }
  if (invocation.exitsEarly) return successStatus();
  if (invocation.completeness === 'invalid') return failureStatus();
  if (invocation.completeness !== 'complete' || invocation.queryOnly || !invocation.commandName) {
    return unknownStatus();
  }

  const anyUncertain = expanded.some(w => w.uncertain);
  const vfsSelectionUncertain = expanded.some(word => word.globbed)
    && state.runtime.vfsSelectionUncertainty.length > 0;
  const before = tracker.checkpoint();
  const expansionRoots = [
    ...new Set(expanded.flatMap(word => word.provenance ?? [])),
  ];
  const run = () =>
    executeResolvedInvocation(invocation, state, cmd.line, anyUncertain);
  const status = expansionRoots.length === 0
    ? run()
    : tracker.withProvenance({
      kind: 'expansion',
      label: 'resolved command arguments',
      line: cmd.line,
      parents: expansionRoots,
    }, run);

  if (anyUncertain) {
    tracker.markAllEffectsFrom(before, ['unresolved-expansion'], 'unknown');
  }
  if (invocation.identityConfidence === 'path-basename'
      || invocation.wrapperChain.some(frame => frame.identityConfidence === 'path-basename')) {
    tracker.markAllEffectsFrom(before, ['command-identity'], 'overapprox');
  }
  if (vfsSelectionUncertain) {
    tracker.markAllEffectsFrom(
      before,
      state.runtime.vfsSelectionUncertainty,
      'overapprox',
    );
  }
  return anyUncertain || vfsSelectionUncertain ? unknownStatus() : status;
}

function executeResolvedInvocation(
  invocation: ResolvedInvocation,
  state: AnalysisState,
  line: number,
  uncertainArguments: boolean,
): AbstractStatus {
  const isolatesChild = invocation.wrapperChain.some(frame => frame.name !== 'command');
  if (!isolatesChild) {
    return dispatchResolvedInvocation(invocation, state, line, uncertainArguments);
  }

  return executeWithShellLocalIsolation(state, () => {
    if (invocation.clearEnvironment) state.env.reset_for_child_environment();
    for (const [name, value] of Object.entries(invocation.envOverlay)) {
      if (value === undefined) state.env.unbind_variable(name);
      else state.env.bind_variable(name, value);
    }
    state.tracker.setCwd(invocation.cwd);
    state.env.bind_variable('PWD', invocation.cwd);
    const childState = invocation.privileged && !state.privileged
      ? { ...state, privileged: true }
      : state;
    return dispatchResolvedInvocation(invocation, childState, line, uncertainArguments);
  });
}

function dispatchResolvedInvocation(
  invocation: ResolvedInvocation,
  state: AnalysisState,
  line: number,
  uncertainArguments: boolean,
): AbstractStatus {
  const { tracker } = state;
  const cmdName = invocation.commandName!;
  const args = invocation.args;

  if (!invocation.bypassFunctions) {
    const functionStatus = executeFunction(cmdName, args, state, line);
    if (functionStatus) return functionStatus;
  }

  const allowsShellBuiltins = invocation.identityConfidence === 'bare-name'
    && invocation.wrapperChain.every(frame => frame.name === 'command');
  if (allowsShellBuiltins) {
    const outputBuiltinStatus = executeOutputBuiltin(
      cmdName,
      args,
      state,
      uncertainArguments,
    );
    if (outputBuiltinStatus) return outputBuiltinStatus;
  }
  if (allowsShellBuiltins) {
    const builtinStatus = executeStatefulBuiltin(
      cmdName,
      args,
      state,
      line,
      uncertainArguments,
    );
    if (builtinStatus) return builtinStatus;
    if ((cmdName === 'test' || cmdName === '[') && !uncertainArguments) {
      return evaluateTestBuiltin(cmdName, args, tracker.vfs, tracker.getCwd());
    }
  }

  if (cmdName === 'true' || cmdName === ':') return successStatus();
  if (cmdName === 'false') return exactStatus(1);

  if (cmdName === 'true' || cmdName === 'false' || cmdName === ':' || cmdName === 'test'
      || cmdName === '[' || cmdName === 'read' || cmdName === 'return'
      || cmdName === 'exit' || cmdName === 'break' || cmdName === 'continue'
      || cmdName === 'shift' || cmdName === 'wait' || cmdName === 'trap'
      || cmdName === 'touch'
      || cmdName === 'pushd' || cmdName === 'popd' || cmdName === 'alias'
      || cmdName === 'type' || cmdName === 'which' || cmdName === 'hash'
      || cmdName === 'builtin' || cmdName === 'let'
      || cmdName === 'getopts') {
    // Known commands with no file effects (redirects handled separately)
    return unknownStatus();
  }

  const nestedScript = packageOrMakeScript(cmdName, args, tracker.getCwd());
  if (nestedScript) {
    const nestedStatus = executeNestedScript(nestedScript.script, state, line, nestedScript.label, [], nestedScript.cwd);
    // Make recipe effects are useful exact evidence, but parsing one recipe is
    // not a complete model of prerequisites, includes, or Make expansion.
    if (cmdName !== 'make') return nestedStatus;
  }

  const shellStatus = executeShellCommand(cmdName, args, state, line);
  if (shellStatus) return shellStatus;

  // Check known external command handlers
  const handler = COMMAND_HANDLERS.get(cmdName);
  if (handler) {
    handler(args, tracker, line, {
      env: state.env.to_record(),
      privileged: state.privileged,
    });
    if (cmdName === 'tee') emitToFd(state, 1, readFromFd(state, 0));
    else emitUnknownOutputIfRouted(state, cmdName);
    return unknownStatus();
  }

  // Unknown command — no file effects (redirects still tracked)
  emitUnknownOutputIfRouted(state, cmdName);
  return unknownStatus();
}

function executeOutputBuiltin(
  cmdName: string,
  args: string[],
  state: AnalysisState,
  uncertainArguments: boolean,
): AbstractStatus | null {
  if (cmdName === 'echo') {
    const output = modelEchoOutput(args, uncertainArguments);
    emitToFd(state, 1, output);
    return successStatus();
  }
  if (cmdName === 'printf') {
    if (args[0] === '-v') {
      const name = args[1];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        return failureStatus();
      }
      const output = traceStreamFlow(
        state,
        modelPrintfOutput(args.slice(2), uncertainArguments),
        `bind printf output to ${name}`,
      );
      if (output.value.kind === 'finite'
          && output.value.values.length === 1
          && !output.value.mayBeUnset) {
        state.env.bind_variable(
          name,
          output.value.values[0],
          0,
          false,
          output.provenance,
        );
        return successStatus();
      }
      state.env.bind_variable(name, '<printf>', 0, true, output.provenance);
      return unknownStatus();
    }
    const printfArgs = args[0] === '--' ? args.slice(1) : args;
    if (printfArgs.length === 0) return failureStatus();
    const output = modelPrintfOutput(printfArgs, uncertainArguments);
    emitToFd(state, 1, output);
    return output.value.kind === 'unknown' ? unknownStatus() : successStatus();
  }
  if (cmdName === 'cat') {
    const operands = args.filter(arg => arg === '-' || !arg.startsWith('-'));
    const output = operands.length === 0 || operands.every(arg => arg === '-')
      ? readFromFd(state, 0)
      : unknownStream('cat-file-content');
    emitToFd(state, 1, output);
    return unknownStatus();
  }
  return null;
}

function modelEchoOutput(
  args: readonly string[],
  uncertainArguments: boolean,
): AbstractStream {
  if (uncertainArguments) return unknownStream('echo-arguments');
  let newline = true;
  let index = 0;
  while (index < args.length && /^-[nEe]+$/u.test(args[index])) {
    if (args[index].includes('n')) newline = false;
    if (args[index].includes('e') || args[index].includes('E')) {
      return unknownStream('echo-escape-mode');
    }
    index++;
  }
  const values = args.slice(index);
  if (values.some(value => value.includes('\\'))) {
    return unknownStream('echo-escape-portability');
  }
  return exactStream(values.join(' ') + (newline ? '\n' : ''));
}

function modelPrintfOutput(
  args: readonly string[],
  uncertainArguments: boolean,
): AbstractStream {
  if (uncertainArguments || args.length === 0) {
    return unknownStream('printf-arguments');
  }
  const rendered = renderPrintf(args[0], args.slice(1));
  return rendered === null
    ? unknownStream('printf-format')
    : exactStream(rendered);
}

function renderPrintf(format: string, args: readonly string[]): string | null {
  let output = '';
  let argumentIndex = 0;
  while (true) {
    const before = argumentIndex;
    for (let index = 0; index < format.length; index++) {
      const char = format[index];
      if (char === '\\') {
        const escape = decodePrintfEscape(format, index);
        if (!escape) return null;
        output += escape.value;
        index = escape.end;
        continue;
      }
      if (char !== '%') {
        output += char;
        continue;
      }
      if (format[index + 1] === '%') {
        output += '%';
        index++;
        continue;
      }
      const conversion = format[index + 1];
      if (conversion !== 's' && conversion !== 'b' && conversion !== 'c') {
        return null;
      }
      const value = args[argumentIndex++] ?? '';
      if (conversion === 's') output += value;
      else if (conversion === 'c') output += value.slice(0, 1);
      else {
        const decoded = decodePrintfString(value);
        if (decoded === null) return null;
        output += decoded;
      }
      index++;
    }
    if (output.length > DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT) return null;
    if (argumentIndex >= args.length || argumentIndex === before) break;
  }
  return output;
}

function decodePrintfString(value: string): string | null {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') {
      output += value[index];
      continue;
    }
    const escape = decodePrintfEscape(value, index);
    if (!escape) return null;
    output += escape.value;
    index = escape.end;
  }
  return output;
}

function decodePrintfEscape(
  value: string,
  slashIndex: number,
): { value: string; end: number } | null {
  const code = value[slashIndex + 1];
  if (code === undefined) return null;
  const simple: Record<string, string> = {
    '\\': '\\',
    a: '\u0007',
    b: '\b',
    e: '\u001b',
    E: '\u001b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
  };
  if (code in simple) return { value: simple[code], end: slashIndex + 1 };
  if (code === '0') {
    const digits = value.slice(slashIndex + 2).match(/^[0-7]{1,3}/u)?.[0] ?? '';
    return {
      value: String.fromCodePoint(Number.parseInt(digits || '0', 8)),
      end: slashIndex + 1 + digits.length,
    };
  }
  if (code === 'x') {
    const digits = value.slice(slashIndex + 2).match(/^[0-9a-fA-F]{1,2}/u)?.[0];
    if (!digits) return null;
    return {
      value: String.fromCodePoint(Number.parseInt(digits, 16)),
      end: slashIndex + 1 + digits.length,
    };
  }
  return { value: code, end: slashIndex + 1 };
}

function executeFunction(cmdName: string, args: string[], state: AnalysisState, line: number): AbstractStatus | null {
  const func = state.env.find_function(cmdName);
  if (!func) return null;
  if (state.runtime.functionDepth >= MAX_FUNCTION_CALL_DEPTH) {
    warnOnce(state, `function-depth:${cmdName}`, `${cmdName} at line ${line} skipped after function call depth ${MAX_FUNCTION_CALL_DEPTH}`);
    return unknownStatus();
  }
  const inheritedUncertainty = [...state.runtime.pathUncertainty];
  state.runtime.functionDepth++;
  state.env.push_var_context(cmdName);
  state.env.set_positional_params(args);
  try {
    const fallbackStatus = execute_command_state(func.body, state);
    if (state.runtime.alternatives.length === 0) {
      setLastStatus(state, fallbackStatus);
    }
    const outputs: ShellStateSnapshot[] = [];
    for (const outcome of takeShellStates(state)) {
      restoreShellState(state, outcome);
      if (outcome.control.kind === 'return') {
        state.control = normalControl();
        setLastStatus(state, outcome.control.status);
      }
      state.env.pop_var_context();
      outputs.push(captureShellState(state));
    }
    return installShellStates(
      state,
      collapseEquivalentShellStates(
        outputs,
        inheritedUncertainty,
        state.tracker,
      ),
    );
  } finally {
    state.runtime.functionDepth--;
  }
}

function executeStatefulBuiltin(
  cmdName: string,
  args: string[],
  state: AnalysisState,
  line: number,
  uncertainArguments: boolean,
): AbstractStatus | null {
  const { tracker, env, flags } = state;
  if (cmdName === 'break' || cmdName === 'continue') {
    return executeLoopControlBuiltin(cmdName, args, state, uncertainArguments);
  }
  if (cmdName === 'return') {
    if (state.runtime.functionDepth === 0
        && state.runtime.sourceDepth === 0) {
      return exactStatus(2);
    }
    const status = controlTransferStatus(args, state.lastStatus, uncertainArguments);
    state.control = { kind: 'return', status };
    return status;
  }
  if (cmdName === 'exit') {
    const status = controlTransferStatus(args, state.lastStatus, uncertainArguments);
    state.control = { kind: 'exit', status };
    return status;
  }
  if (cmdName === 'read') {
    return executeReadBuiltin(args, state, uncertainArguments);
  }
  if (cmdName === 'cd') {
    if (args.length > 0) {
      const dir = args[0];
      if (dir === '-') {
        const oldpwd = env.get_string_value('OLDPWD') ?? tracker.getCwd();
        const current = env.get_string_value('PWD') ?? tracker.getCwd();
        env.bind_variable('OLDPWD', current);
        env.bind_variable('PWD', oldpwd);
        tracker.setCwd(oldpwd);
      } else {
        const current = env.get_string_value('PWD') ?? tracker.getCwd();
        env.bind_variable('OLDPWD', current);
        const resolved = isAbsolutePath(dir) ? toPosix(dir) : tracker.resolvePath(dir);
        env.bind_variable('PWD', resolved);
        tracker.setCwd(resolved);
      }
    }
    return unknownStatus();
  }
  if (cmdName === 'export') {
    for (const arg of args) {
      if (arg.includes('=')) env.bind_variable(assignment_name(arg), assignment_value(arg));
    }
    return successStatus();
  }
  if (cmdName === 'local' || cmdName === 'declare' || cmdName === 'typeset') {
    const arrayKind = declarationArrayKind(args);
    for (const arg of args) {
      if (arg.startsWith('-')) continue;
      const target = arg.includes('=') ? assignment_name(arg) : arg;
      const reference = parse_array_reference(target);
      if (arrayKind || reference) {
        env.declare_array(
          reference?.name ?? target,
          arrayKind ?? 'indexed',
          true,
        );
        if (arg.includes('=')) {
          applyShellAssignment(
            target,
            assignment_operator(arg),
            {
              word: assignment_value(arg),
              uncertain: uncertainArguments,
            },
            state,
          );
        }
      } else if (arg.includes('=')) {
        env.make_local_variable(target, assignment_value(arg), uncertainArguments);
      } else {
        env.make_local_variable(arg, '');
      }
    }
    return successStatus();
  }
  if (cmdName === 'readonly') {
    for (const arg of args) {
      if (arg.includes('=')) env.bind_variable(assignment_name(arg), assignment_value(arg));
    }
    return successStatus();
  }
  if (cmdName === 'unset') return successStatus();
  if (cmdName === 'set') {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === '--') break;
      if (arg === '-o' || arg === '+o') {
        const enable = arg[0] === '-';
        if (i + 1 < args.length) {
          apply_set_option(flags, args[i + 1], enable);
          i += 2;
          continue;
        }
      }
      if (arg.startsWith('-') || arg.startsWith('+')) {
        const enable = arg[0] === '-';
        for (let j = 1; j < arg.length; j++) apply_set_flag(flags, arg[j], enable);
      }
      i++;
    }
    return successStatus();
  }
  if (cmdName === 'source' || cmdName === '.') {
    return executeSourceBuiltin(args, state, line, uncertainArguments);
  }
  if (cmdName === 'eval') {
    return executeEvalBuiltin(args, state, line, uncertainArguments);
  }
  return null;
}

function declarationArrayKind(
  args: readonly string[],
): 'indexed' | 'associative' | null {
  let kind: 'indexed' | 'associative' | null = null;
  for (const arg of args) {
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') continue;
    for (const flag of arg.slice(1)) {
      if (flag === 'a') kind = 'indexed';
      if (flag === 'A') kind = 'associative';
    }
  }
  return kind;
}

interface SourceInvocation {
  filename: string;
  args: string[];
  searchPath?: string;
}

type SourceResolution =
  | { kind: 'ready'; path: string; script: string }
  | { kind: 'missing'; path?: string }
  | { kind: 'unknown'; path?: string; reason: string };

function executeSourceBuiltin(
  args: string[],
  state: AnalysisState,
  line: number,
  uncertainArguments: boolean,
): AbstractStatus {
  if (uncertainArguments) {
    warnOnce(
      state,
      `source-unresolved:${line}`,
      `source at line ${line} has unresolved arguments; sourced effects were not analyzed`,
    );
    return unknownStatus();
  }

  const invocation = parseSourceInvocation(args);
  if (!invocation) return exactStatus(2);
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      `source-depth:${line}`,
      `source at line ${line} skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`,
    );
    return unknownStatus();
  }

  const resolved = resolveSourceScript(invocation, state);
  if (resolved.kind === 'missing') {
    warnOnce(
      state,
      `source-missing:${line}:${invocation.filename}`,
      `source at line ${line} could not read ${resolved.path ?? invocation.filename}`,
    );
    return exactStatus(1);
  }
  if (resolved.kind === 'unknown') {
    warnOnce(
      state,
      `source-unavailable:${line}:${invocation.filename}:${resolved.reason}`,
      `source at line ${line} was not analyzed${resolved.path ? ` from ${resolved.path}` : ''}: ${resolved.reason}`,
    );
    return unknownStatus();
  }
  if (resolved.script.length === 0) return successStatus();

  const parsed = parse(resolved.script);
  if (parsed.warnings.length > 0) {
    warnOnce(
      state,
      `source-parse:${line}:${resolved.path}`,
      `source ${resolved.path} at line ${line} produced ${parsed.warnings.length} parser warning(s); details omitted`,
    );
  }
  if (!parsed.ast) return unknownStatus();

  const caller = captureShellState(state);
  const savedPositional = invocation.args.length > 0
    ? state.env.snapshot_source_positional_params(invocation.args.length)
    : null;
  if (savedPositional) {
    state.env.set_source_positional_params(invocation.args);
  }

  const before = state.tracker.checkpoint();
  const warningStart = state.tracker.warnings.length;
  const warningKeysBefore = new Set(state.runtime.warnings);
  state.nestedDepth++;
  state.runtime.sourceDepth++;
  try {
    execute_command_state(parsed.ast, state);
  } finally {
    state.runtime.sourceDepth--;
    state.nestedDepth--;
  }
  const nestedWarningCount = state.tracker.warnings.length - warningStart;
  state.runtime.warnings = warningKeysBefore;
  if (nestedWarningCount > 0) {
    state.tracker.warnings.splice(warningStart, nestedWarningCount);
    warnOnce(
      state,
      `source-inner-warning:${line}:${resolved.path}`,
      `source ${resolved.path} produced ${nestedWarningCount} analyzer warning(s); details omitted`,
    );
  }

  const outcomes: ShellStateSnapshot[] = [];
  for (const outcome of takeShellStates(state)) {
    restoreShellState(state, outcome);
    state.runtime.alternatives = [];
    if (state.control.kind === 'return') {
      const returnStatus = state.control.status;
      state.control = normalControl();
      setLastStatus(state, returnStatus);
    }
    if (savedPositional) {
      state.env.restore_variables(savedPositional);
    }
    outcomes.push(captureShellState(state));
  }

  if (parsed.warnings.length === 0) {
    return installShellStates(
      state,
      collapseEquivalentShellStates(
        outcomes,
        caller.pathUncertainty,
        state.tracker,
      ),
    );
  }

  state.tracker.markAllEffectsFrom(before, ['unknown-command'], 'overapprox');
  const uncertainOutcomes = outcomes.map(outcome =>
    appendPathUncertainty(outcome, 'unknown-command'));
  restoreShellState(state, caller);
  state.runtime.alternatives = [];
  setLastStatus(state, unknownStatus());
  uncertainOutcomes.push(
    appendPathUncertainty(captureShellState(state), 'unknown-command'),
  );
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      uncertainOutcomes,
      caller.pathUncertainty,
      state.tracker,
    ),
  );
}

function parseSourceInvocation(args: readonly string[]): SourceInvocation | null {
  let searchPath: string | undefined;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      index++;
      break;
    }
    if (arg === '-p') {
      if (args[index + 1] === undefined) return null;
      searchPath = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith('-p') && arg.length > 2) {
      searchPath = arg.slice(2);
      index++;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') return null;
    break;
  }
  const filename = args[index];
  if (filename === undefined) return null;
  return {
    filename,
    args: args.slice(index + 1),
    ...(searchPath === undefined ? {} : { searchPath }),
  };
}

function resolveSourceScript(
  invocation: SourceInvocation,
  state: AnalysisState,
): SourceResolution {
  const { filename } = invocation;
  if (filename.length > MAX_SOURCE_PATH_CHARS) {
    return { kind: 'unknown', reason: `source filename exceeds ${MAX_SOURCE_PATH_CHARS} characters` };
  }
  const vfs = state.tracker.vfs;
  if (!vfs) {
    return { kind: 'unknown', reason: 'filesystem contents are unavailable' };
  }

  if (isAbsolutePath(filename) || filename.includes('/') || filename.includes('\\')) {
    return readSourceCandidate(state.tracker.resolvePath(filename), state);
  }

  let pathValue = invocation.searchPath;
  const explicitPath = pathValue !== undefined;
  if (!explicitPath) {
    if (state.env.is_value_uncertain('PATH')) {
      return { kind: 'unknown', reason: 'PATH is unresolved' };
    }
    pathValue = state.env.get_string_value('PATH');
  }
  if (pathValue !== undefined && pathValue.length > MAX_SOURCE_PATH_CHARS) {
    return { kind: 'unknown', reason: `source search path exceeds ${MAX_SOURCE_PATH_CHARS} characters` };
  }

  const entries = pathValue === undefined
    ? []
    : (pathValue.length === 0 ? ['.'] : pathValue.split(':'));
  const truncated = entries.length > MAX_SOURCE_PATH_ENTRIES;
  const seen = new Set<string>();
  for (const entry of entries.slice(0, MAX_SOURCE_PATH_ENTRIES)) {
    const directory = resolveSourcePathEntry(entry, state);
    if (directory === null) {
      return { kind: 'unknown', reason: `source search entry ${entry} is unresolved` };
    }
    const candidate = state.tracker.resolvePath(path.join(directory, filename));
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const result = readSourceCandidate(candidate, state);
    if (result.kind === 'ready' || result.kind === 'unknown') return result;
  }
  if (truncated) {
    return {
      kind: 'unknown',
      reason: `source search stopped after ${MAX_SOURCE_PATH_ENTRIES} PATH entries`,
    };
  }
  if (explicitPath) return { kind: 'missing' };

  const cwdCandidate = state.tracker.resolvePath(filename);
  if (seen.has(cwdCandidate)) return { kind: 'missing', path: cwdCandidate };
  return readSourceCandidate(cwdCandidate, state);
}

function resolveSourcePathEntry(
  entry: string,
  state: AnalysisState,
): string | null {
  const value = entry.length === 0 ? '.' : entry;
  if (!value.startsWith('~')) return value;
  if (value !== '~' && !value.startsWith('~/')) return null;
  if (state.env.is_value_uncertain('HOME')) return null;
  const home = state.env.get_string_value('HOME');
  if (!home) return null;
  return value === '~' ? home : path.join(home, value.slice(2));
}

function readSourceCandidate(
  candidate: string,
  state: AnalysisState,
): SourceResolution {
  const result = state.tracker.vfs!.readTextFile(
    candidate,
    MAX_SOURCE_SCRIPT_BYTES,
  );
  if (result.kind === 'text') {
    return { kind: 'ready', path: candidate, script: result.text };
  }
  if (result.reason === 'missing'
      || result.reason === 'directory'
      || result.reason === 'unreadable') {
    return { kind: 'missing', path: candidate };
  }
  const reasons: Record<typeof result.reason, string> = {
    'special-file': 'path is a non-regular file and was not read',
    'overlay-content-unknown': 'predicted file contents are unknown',
    'too-large': `file exceeds the ${MAX_SOURCE_SCRIPT_BYTES}-byte source budget`,
    'not-utf8': 'file is not valid UTF-8 text',
    'nul-byte': 'file contains NUL bytes',
    'changed-during-read': 'file changed while it was being read',
  };
  return { kind: 'unknown', path: candidate, reason: reasons[result.reason] };
}

function executeEvalBuiltin(
  args: string[],
  state: AnalysisState,
  line: number,
  uncertainArguments: boolean,
): AbstractStatus {
  if (uncertainArguments) {
    warnOnce(
      state,
      `eval-unresolved:${line}`,
      `eval at line ${line} has unresolved arguments; nested effects were not analyzed`,
    );
    return unknownStatus();
  }

  let words = args;
  if (words[0] === '--') {
    words = words.slice(1);
  } else if (words[0]?.startsWith('-') && words[0] !== '-') {
    return exactStatus(2);
  }
  if (words.length === 0) return successStatus();

  const script = words.join(' ');
  if (script.length === 0) return successStatus();
  if (script.length > MAX_EVAL_SCRIPT_CHARS) {
    warnOnce(
      state,
      `eval-size:${line}`,
      `eval at line ${line} skipped because its expanded input exceeds ${MAX_EVAL_SCRIPT_CHARS} characters`,
    );
    return unknownStatus();
  }
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      `eval-depth:${line}`,
      `eval at line ${line} skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`,
    );
    return unknownStatus();
  }

  const parsed = parse(script);
  for (const warning of parsed.warnings) {
    warnOnce(
      state,
      `eval-parse:${line}:${warning}`,
      `eval at line ${line}: ${warning}`,
    );
  }
  if (!parsed.ast) return unknownStatus();

  const fallback = parsed.warnings.length > 0
    ? captureShellState(state)
    : null;
  const before = state.tracker.checkpoint();
  state.nestedDepth++;
  let status: AbstractStatus;
  try {
    // eval is a special builtin: its commands share variables, cwd, functions,
    // options, descriptors, and the branch-local VFS with the current shell.
    status = execute_command_state(parsed.ast, state);
  } finally {
    state.nestedDepth--;
  }
  if (!fallback) return status;

  state.tracker.markAllEffectsFrom(before, ['unknown-command'], 'overapprox');
  const outcomes = takeShellStates(state).map(outcome =>
    appendPathUncertainty(outcome, 'unknown-command'));
  restoreShellState(state, fallback);
  state.runtime.alternatives = [];
  setLastStatus(state, unknownStatus());
  outcomes.push(appendPathUncertainty(captureShellState(state), 'unknown-command'));
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outcomes,
      fallback.pathUncertainty,
      state.tracker,
    ),
  );
}

function executeReadBuiltin(
  args: string[],
  state: AnalysisState,
  uncertainArguments: boolean,
): AbstractStatus {
  const names: string[] = [];
  let raw = false;
  let supported = !uncertainArguments;
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') options = false;
    else if (options && arg === '-r') raw = true;
    else if (options && arg.startsWith('-')) supported = false;
    else names.push(arg);
  }
  const targets = names.length > 0 ? names : ['REPLY'];
  const input = readFromFd(state, 0);
  if (!supported || input.value.kind === 'unknown'
      || input.value.values.length !== 1) {
    for (const name of targets) {
      state.env.bind_variable(
        name,
        '<stdin>',
        0,
        true,
        input.provenance,
      );
    }
    return unknownStatus();
  }

  const source = input.value.values[0];
  const newline = source.indexOf('\n');
  const line = newline >= 0 ? source.slice(0, newline) : source;
  if (!raw && line.includes('\\')) {
    for (const name of targets) {
      state.env.bind_variable(
        name,
        '<stdin>',
        0,
        true,
        input.provenance,
      );
    }
    return unknownStatus();
  }
  bindReadLine(state, targets, line, input.provenance);
  return newline >= 0 ? successStatus() : exactStatus(1);
}

function bindReadLine(
  state: AnalysisState,
  targets: readonly string[],
  line: string,
  provenance: readonly number[],
): void {
  if (targets.length === 1 && targets[0] === 'REPLY') {
    state.env.bind_variable(targets[0], line, 0, false, provenance);
    return;
  }
  const ifs = state.env.get_string_value('IFS') ?? ' \t\n';
  const fieldProvenance = [
    ...provenance,
    ...state.env.get_value_provenance('IFS'),
  ];
  const fields = ifs.length === 0
    ? [line]
    : line.trim().length === 0
      ? []
      : line.trim().split(new RegExp(`[${escapeRegExpClass(ifs)}]+`, 'u'));
  for (let index = 0; index < targets.length; index++) {
    const value = index === targets.length - 1
      ? fields.slice(index).join(' ')
      : fields[index] ?? '';
    state.env.bind_variable(
      targets[index],
      value,
      0,
      false,
      fieldProvenance,
    );
  }
}

function escapeRegExpClass(value: string): string {
  return value.replace(/[\\\]^-]/gu, '\\$&');
}

function executeLoopControlBuiltin(
  kind: 'break' | 'continue',
  args: string[],
  state: AnalysisState,
  uncertainArguments: boolean,
): AbstractStatus {
  if (state.runtime.loopDepth === 0) return successStatus();

  if (uncertainArguments) {
    const base = captureShellState(state);
    const outputs: ShellStateSnapshot[] = [];
    const retainedDepth = Math.min(state.runtime.loopDepth, MAX_SHELL_PATHS - 1);
    for (let levels = 1; levels <= retainedDepth; levels++) {
      restoreShellState(state, base);
      const status = successStatus();
      state.control = { kind, levels };
      setLastStatus(state, status);
      outputs.push(captureShellState(state));
    }
    if (state.runtime.loopDepth > retainedDepth) {
      restoreShellState(state, base);
      const status = successStatus();
      state.control = { kind, levels: state.runtime.loopDepth };
      setLastStatus(state, status);
      outputs.push(captureShellState(state));
    }
    // Invalid dynamic operands can fail without a usable transfer target.
    restoreShellState(state, base);
    state.control = normalControl();
    setLastStatus(state, failureStatus());
    outputs.push(captureShellState(state));
    installShellStates(state, outputs);
    return unknownStatus();
  }

  const parsed = parseLoopControlLevels(args[0]);
  if (parsed === null) {
    const status = failureStatus();
    state.control = { kind: 'exit', status };
    return status;
  }
  const levels = parsed <= 0
    ? state.runtime.loopDepth
    : Math.min(parsed, state.runtime.loopDepth);
  const status = parsed <= 0 ? failureStatus() : successStatus();
  state.control = {
    kind: parsed <= 0 ? 'break' : kind,
    levels,
  };
  return status;
}

function parseLoopControlLevels(value: string | undefined): number | null {
  if (value === undefined) return 1;
  if (!/^[+-]?\d+$/u.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(parsed);
  } catch {
    return null;
  }
}

function controlTransferStatus(
  args: string[],
  fallback: AbstractStatus,
  uncertainArguments: boolean,
): AbstractStatus {
  if (args.length === 0) return fallback;
  if (uncertainArguments || !/^[+-]?\d+$/u.test(args[0])) return unknownStatus();
  try {
    return exactStatus(Number(BigInt(args[0]) & 0xffn));
  } catch {
    return unknownStatus();
  }
}

function executeNestedScript(
  script: string,
  state: AnalysisState,
  line: number,
  label: string,
  args: string[] = [],
  cwd?: string,
): AbstractStatus {
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    state.tracker.addWarning(`${label} at line ${line} skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`);
    return unknownStatus();
  }
  const parsed = parse(script);
  if (!parsed.ast) {
    for (const warning of parsed.warnings) state.tracker.addWarning(`${label}: ${warning}`);
    return unknownStatus();
  }
  const ast = parsed.ast;
  const before = state.tracker.checkpoint();
  return executeWithShellLocalIsolation(state, () => {
    if (cwd !== undefined) {
      state.tracker.setCwd(cwd);
      state.env.bind_variable('PWD', cwd);
    }
    state.env.functions.clear();
    state.env.reset_positional_params(args);
    state.flags = { ...state.flags };
    state.nestedDepth++;
    try {
      const status = execute_command_state(ast, state);
      state.tracker.markAllEffectsFrom(before, ['unknown-command'], 'overapprox');
      for (const warning of parsed.warnings) state.tracker.addWarning(`${label}: ${warning}`);
      return status;
    } finally {
      state.nestedDepth--;
    }
  });
}

function expansionContext(state: AnalysisState): ExpansionContext {
  const recordExpansion = (trace: ExpansionTrace): number =>
    state.tracker.addProvenance(expansionProvenance(trace));
  return {
    recordExpansion,
    commandSubstitute: script => state.tracker.withProvenance(
      expansionProvenance({
        operation: 'command-substitution',
        expression: `$(${script})`,
      }),
      () => executeCommandSubstitution(script, state),
    ),
    processSubstitute: (script, direction) =>
      state.tracker.withProvenance(
        expansionProvenance({
          operation: 'process-substitution',
          expression: `${direction === 'read' ? '<' : '>'}(${script})`,
        }),
        () => executeProcessSubstitution(script, direction, state),
      ),
  };
}

function expansionProvenance(trace: ExpansionTrace): {
  kind: 'expansion';
  label: string;
  parents?: readonly number[];
} {
  return {
    kind: 'expansion',
    label: `${trace.operation}: ${trace.expression}`,
    ...(trace.parents && trace.parents.length > 0
      ? { parents: trace.parents }
      : {}),
  };
}

function executeProcessSubstitution(
  script: string,
  direction: ProcessSubstitutionDirection,
  state: AnalysisState,
): CommandSubstitutionExpansion {
  if (script.trim().length === 0) return { word: '', uncertain: false };

  state.runtime.processSubstitutionCount++;
  const sequence = state.runtime.processSubstitutionCount;
  const handle = state.tracker.registerEphemeralPath(
    `/dev/fd/${63 + sequence}`,
  );
  if (sequence > MAX_PROCESS_SUBSTITUTIONS) {
    warnOnce(
      state,
      'process-substitution-budget',
      `process substitution skipped after ${MAX_PROCESS_SUBSTITUTIONS} expansions`,
    );
    return { word: handle, uncertain: true };
  }
  if (script.length > MAX_PROCESS_SUBSTITUTION_SCRIPT_CHARS) {
    warnOnce(
      state,
      'process-substitution-size',
      `process substitution skipped above ${MAX_PROCESS_SUBSTITUTION_SCRIPT_CHARS} characters`,
    );
    return { word: handle, uncertain: true };
  }
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      'process-substitution-depth',
      `process substitution skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`,
    );
    return { word: handle, uncertain: true };
  }

  const parsed = parse(script);
  if (!parsed.ast) {
    for (const warning of parsed.warnings) {
      state.tracker.addWarning(`process substitution: ${warning}`);
    }
    return { word: handle, uncertain: true };
  }

  const parent = captureShellState(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  if (direction === 'read') {
    setFdTarget(state, 1, {
      kind: 'unknown',
      reason: 'process-substitution-output',
    });
  } else {
    setFdTarget(state, 0, {
      kind: 'unknown',
      reason: 'process-substitution-input',
    });
  }
  state.control = normalControl();
  state.nestedDepth++;
  try {
    execute_command_state(parsed.ast, state);
  } finally {
    state.nestedDepth--;
  }
  const childOutcomes = takeShellStates(state);
  const vfsOutcomes = [parent, ...childOutcomes];
  const firstVfsKey = vfsOutcomes[0].vfs?.stateKey() ?? 'none';
  const commonVfs = vfsOutcomes.every(outcome =>
    (outcome.vfs?.stateKey() ?? 'none') === firstVfsKey);

  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  if (!commonVfs) {
    state.tracker.setVfs(null);
    state.runtime.vfsSelectionUncertainty = [
      ...new Set([
        ...state.runtime.vfsSelectionUncertainty,
        'background-race' as const,
      ]),
    ];
    warnOnce(
      state,
      'process-substitution-vfs-race',
      'process substitution VFS effects race with the surrounding command',
    );
  }
  for (const warning of parsed.warnings) {
    state.tracker.addWarning(`process substitution: ${warning}`);
  }
  return { word: handle, uncertain: false };
}

function executeCommandSubstitution(
  script: string,
  state: AnalysisState,
): CommandSubstitutionExpansion {
  if (script.trim().length === 0) {
    state.runtime.lastCommandSubstitutionStatus = successStatus();
    return { word: '', uncertain: false };
  }
  if (script.length > MAX_COMMAND_SUBSTITUTION_SCRIPT_CHARS) {
    warnOnce(
      state,
      'command-substitution-size',
      `command substitution skipped above ${MAX_COMMAND_SUBSTITUTION_SCRIPT_CHARS} characters`,
    );
    state.runtime.lastCommandSubstitutionStatus = unknownStatus();
    return { word: '<$(oversized-command-substitution)>', uncertain: true };
  }
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      'command-substitution-depth',
      `command substitution skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`,
    );
    state.runtime.lastCommandSubstitutionStatus = unknownStatus();
    return { word: `<$(${script})>`, uncertain: true };
  }

  const parsed = parse(script);
  if (!parsed.ast) {
    for (const warning of parsed.warnings) {
      state.tracker.addWarning(`command substitution: ${warning}`);
    }
    state.runtime.lastCommandSubstitutionStatus = unknownStatus();
    return { word: `<$(${script})>`, uncertain: true };
  }

  const parent = captureShellState(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  setFdTarget(state, 1, { kind: 'capture' });
  state.io.capture = emptyStream();
  state.control = normalControl();

  state.nestedDepth++;
  try {
    execute_command_state(parsed.ast, state);
  } finally {
    state.nestedDepth--;
  }
  const childOutcomes = takeShellStates(state);
  const status = joinStatuses(
    childOutcomes.map(outcome => outcome.lastStatus),
  );
  const stdout = joinStreams(
    childOutcomes.map(outcome =>
      stripTrailingNewlines(outcome.io.capture)),
    'command-substitution-output-join',
  );
  const vfsKey = childOutcomes[0]?.vfs?.stateKey() ?? 'none';
  const commonVfs = childOutcomes.every(outcome =>
    (outcome.vfs?.stateKey() ?? 'none') === vfsKey);

  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  if (commonVfs) {
    state.tracker.setVfs(childOutcomes[0]?.vfs?.clone() ?? null);
  } else {
    state.tracker.setVfs(null);
    state.runtime.vfsSelectionUncertainty = [
      ...new Set([
        ...state.runtime.vfsSelectionUncertainty,
        'command-substitution' as const,
      ]),
    ];
    warnOnce(
      state,
      'command-substitution-vfs-join',
      'command substitution VFS alternatives widened to an unknown selection',
    );
  }
  state.runtime.lastCommandSubstitutionStatus = status;
  for (const warning of parsed.warnings) {
    state.tracker.addWarning(`command substitution: ${warning}`);
  }

  if (stdout.value.kind === 'finite'
      && stdout.value.values.length === 1
      && !stdout.value.mayBeUnset) {
    return {
      word: stdout.value.values[0],
      uncertain: false,
      provenance: [...stdout.provenance],
    };
  }
  return {
    word: stdout.value.values.length === 1
      ? stdout.value.values[0]
      : `<$(${script})>`,
    uncertain: true,
    provenance: [...stdout.provenance],
  };
}

function executeShellCommand(
  cmdName: string,
  args: string[],
  state: AnalysisState,
  line: number,
): AbstractStatus | null {
  const base = baseName(cmdName).toLowerCase();
  if (base === 'bash' || base === 'sh' || base === 'zsh') {
    const resolved = resolveBashCommandString(args);
    for (const warning of resolved.warnings) state.tracker.addWarning(`${warning} (line ${line})`);
    if (resolved.script !== undefined) {
      return executeNestedScript(resolved.script, state, line, `${base} -c`, resolved.args);
    }
    return unknownStatus();
  }
  if (base === 'cmd' || base === 'cmd.exe') {
    const cIndex = args.findIndex(arg => arg.toLowerCase() === '/c');
    if (cIndex >= 0) {
      return executeNestedScript(args.slice(cIndex + 1).join(' '), state, line, 'cmd /c');
    }
  }
  return null;
}

function packageOrMakeScript(
  cmdName: string,
  args: string[],
  cwd: string,
): { script: string; label: string; cwd?: string } | null {
  const base = baseName(cmdName).toLowerCase();
  const packageScript = packageScriptName(base, args);
  if (packageScript) {
    const script = readPackageScript(cwd, packageScript);
    if (script) return { script, label: `${base} run ${packageScript}` };
  }
  if (base === 'make') {
    const invocation = parseMakeInvocation(args);
    if (invocation.invalid || invocation.nonExecuting) return null;
    const makeCwd = resolveMakeCwd(cwd, invocation.directories);
    for (const target of invocation.goals) {
      const script = readMakeTarget(makeCwd, target);
      if (script) return { script, label: `make ${target}`, cwd: makeCwd };
    }
  }
  return null;
}

function packageScriptName(command: string, args: string[]): string | null {
  if (command === 'npm') {
    if ((args[0] === 'run' || args[0] === 'run-script') && args[1]) return args[1];
    return null;
  }
  if (command === 'pnpm') {
    if (args[0] === 'run' && args[1]) return args[1];
    return null;
  }
  if (command === 'yarn') {
    if (args[0] === 'run' && args[1]) return args[1];
    if (args[0] && !['install', 'add', 'remove'].includes(args[0]) && !args[0].startsWith('-')) return args[0];
  }
  return null;
}

function readPackageScript(cwd: string, name: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(toNative(path.join(cwd, 'package.json')), 'utf8')) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.[name];
    return typeof script === 'string' ? script : null;
  } catch {
    return null;
  }
}

function readMakeTarget(cwd: string, target: string): string | null {
  try {
    const content = fs.readFileSync(toNative(path.join(cwd, 'Makefile')), 'utf8');
    const lines = content.split(/\r?\n/u);
    const commands: string[] = [];
    let inTarget = false;
    for (const line of lines) {
      if (!inTarget) {
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).trim().split(/\s+/u).includes(target)) inTarget = true;
        continue;
      }
      if (line.startsWith('\t')) {
        commands.push(line.slice(1));
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith('#')) break;
    }
    return commands.length > 0 ? commands.join('\n') : null;
  } catch {
    return null;
  }
}

function baseName(command: string): string {
  const slash = Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\'));
  return slash >= 0 ? command.slice(slash + 1) : command;
}

function execute_for_command(
  cmd: ForCommand,
  state: AnalysisState,
): AbstractStatus {
  const { tracker, env, flags } = state;
  // Expand the map_list (then glob-expand if VFS available)
  const expanded0 = limitExpandedWords(
    expand_words(
      cmd.map_list,
      env,
      {
        maxWords: MAX_EXPANDED_WORDS,
        onWarning: expansionWarning(state),
        context: expansionContext(state),
      },
    ),
    state,
    cmd.line,
    'for loop expansion',
  );
  const expanded = limitExpandedWords(
    flags.noglob
      ? expanded0
      : glob_expand_words(
        expanded0,
        tracker.vfs,
        tracker.getCwd(),
        {
          maxWords: MAX_EXPANDED_WORDS,
          recordExpansion: trace =>
            tracker.addProvenance(expansionProvenance(trace)),
          onWarning: expansionWarning(state),
        },
      ),
    state,
    cmd.line,
    flags.noglob ? 'for loop expansion' : 'for loop glob expansion',
  );
  const uncertain = expanded.some(w => w.uncertain);
  const vfsSelectionUncertain = expanded.some(word => word.globbed)
    && state.runtime.vfsSelectionUncertainty.length > 0;

  if (expanded.length === 0 && cmd.map_list.length === 0) {
    // for VAR; do — iterate over $@ — walk body once with uncertain
    const before = tracker.checkpoint();
    state.runtime.loopDepth++;
    let status: AbstractStatus;
    try {
      status = execute_command_state(cmd.action, state);
      finishForLoopControls(state);
    } finally {
      state.runtime.loopDepth--;
    }
    tracker.markAllEffectsFrom(before, ['uncertain-loop-values']);
    return status;
  }

  const before = tracker.checkpoint();
  let status = successStatus();
  state.runtime.loopDepth++;
  try {
    // A concrete expanded list retains Bash's exact finite iteration count.
    for (const item of expanded) {
      mutateShellStates(state, () => {
        env.bind_variable(
          cmd.name.word,
          item.word,
          0,
          item.uncertain,
          item.provenance,
        );
      });
      status = execute_command_state(cmd.action, state);
      consumeCurrentLoopContinues(state);
    }
    finishForLoopControls(state);
  } finally {
    state.runtime.loopDepth--;
  }

  // If any values were uncertain, mark all effects from this loop
  if (uncertain) {
    tracker.markAllEffectsFrom(before, ['uncertain-loop-values']);
    tracker.addWarning(`for loop at line ${cmd.line} has uncertain iteration values`);
  }
  if (vfsSelectionUncertain) {
    tracker.markAllEffectsFrom(
      before,
      state.runtime.vfsSelectionUncertainty,
      'overapprox',
    );
  }
  return uncertain || vfsSelectionUncertain ? unknownStatus() : status;
}

function consumeCurrentLoopContinues(state: AnalysisState): void {
  mapShellStates(state, snapshot => {
    if (snapshot.control.kind !== 'continue' || snapshot.control.levels > 1) {
      return snapshot;
    }
    return withLoopControl(state, snapshot, normalControl());
  });
}

function finishForLoopControls(state: AnalysisState): void {
  mapShellStates(state, snapshot => {
    const control = snapshot.control;
    if (control.kind !== 'break' && control.kind !== 'continue') return snapshot;
    return withLoopControl(
      state,
      snapshot,
      control.levels <= 1
        ? normalControl()
        : { kind: control.kind, levels: control.levels - 1 },
    );
  });
}

function execute_case_command(
  cmd: CaseCommand,
  state: AnalysisState,
): AbstractStatus {
  const subject = expand_word_unsplit_to_string(
    cmd.word.word,
    state.env,
    expansionWarning(state),
    expansionContext(state),
  );
  const clauses = caseClauses(cmd.clauses);
  const staticPatterns = clauses.map(clause =>
    clause.patterns.map(pattern => resolveStaticCasePattern(pattern, state)));
  if (subject.uncertain
      || staticPatterns.some(patterns => patterns.some(pattern => !pattern))) {
    return executeCaseConservatively(cmd, state);
  }

  let clauseIndex = findMatchingCaseClause(
    staticPatterns as ResolvedCasePattern[][],
    subject.word,
    0,
  );
  let status = successStatus();
  while (clauseIndex >= 0) {
    const clause = clauses[clauseIndex];
    if (clause.action) {
      status = execute_command_state(clause.action, state);
    } else {
      status = successStatus();
      mutateShellStates(state, () => {
        setLastStatus(state, status);
      });
    }
    if ((clause.flags & CASEPAT_FALLTHROUGH) !== 0) {
      clauseIndex = clauseIndex + 1 < clauses.length ? clauseIndex + 1 : -1;
      continue;
    }
    if ((clause.flags & CASEPAT_TESTNEXT) !== 0) {
      clauseIndex = findMatchingCaseClause(
        staticPatterns as ResolvedCasePattern[][],
        subject.word,
        clauseIndex + 1,
      );
      continue;
    }
    break;
  }
  return status;
}

interface ResolvedCasePattern {
  pattern: string;
  literal: boolean;
}

function caseClauses(head: PatternList | null): PatternList[] {
  const clauses: PatternList[] = [];
  for (let clause = head; clause; clause = clause.next) clauses.push(clause);
  return clauses;
}

function resolveStaticCasePattern(
  word: WordDesc,
  state: AnalysisState,
): ResolvedCasePattern | null {
  const raw = word.word;
  if (/[$`{}]/u.test(raw) || /(^|[^\\])[?*+@!]\(/u.test(raw)) return null;
  if ((raw.startsWith("'") && raw.endsWith("'"))
      || (raw.startsWith('"') && raw.endsWith('"'))) {
    const expanded = expand_word_unsplit_to_string(
      raw,
      state.env,
      expansionWarning(state),
    );
    return expanded.uncertain
      ? null
      : { pattern: expanded.word, literal: true };
  }
  if (raw.includes("'") || raw.includes('"') || raw.startsWith('~')) {
    return null;
  }
  if (!hasSupportedCaseBrackets(raw)) return null;
  return { pattern: raw, literal: false };
}

function hasSupportedCaseBrackets(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '\\') {
      index++;
      continue;
    }
    if (pattern[index] !== '[') continue;
    const end = pattern.indexOf(']', index + 1);
    if (end < 0) continue;
    const body = pattern.slice(index + 1, end).replace(/^[!^]/u, '');
    if (body.length === 0 || body.startsWith(']')
        || body.includes('\\') || body.includes('-') || body.includes('[:')
        || body.includes('[.') || body.includes('[=')) {
      return false;
    }
    index = end;
  }
  return true;
}

function findMatchingCaseClause(
  patternsByClause: readonly (readonly ResolvedCasePattern[])[],
  subject: string,
  start: number,
): number {
  for (let index = start; index < patternsByClause.length; index++) {
    if (patternsByClause[index].some(pattern =>
      pattern.literal
        ? pattern.pattern === subject
        : matchCasePattern(pattern.pattern, subject))) {
      return index;
    }
  }
  return -1;
}

function matchCasePattern(pattern: string, value: string): boolean {
  const memo = new Map<string, boolean>();
  const matchAt = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched: boolean;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === '*') {
      matched = matchAt(patternIndex + 1, valueIndex)
        || (valueIndex < value.length
          && matchAt(patternIndex, valueIndex + 1));
    } else if (pattern[patternIndex] === '?') {
      matched = valueIndex < value.length
        && matchAt(patternIndex + 1, valueIndex + 1);
    } else if (pattern[patternIndex] === '\\'
        && patternIndex + 1 < pattern.length) {
      matched = valueIndex < value.length
        && pattern[patternIndex + 1] === value[valueIndex]
        && matchAt(patternIndex + 2, valueIndex + 1);
    } else if (pattern[patternIndex] === '[') {
      const bracket = matchCaseBracket(pattern, patternIndex, value[valueIndex]);
      matched = bracket !== null
        ? valueIndex < value.length
          && bracket.matches
          && matchAt(bracket.end + 1, valueIndex + 1)
        : valueIndex < value.length
          && pattern[patternIndex] === value[valueIndex]
          && matchAt(patternIndex + 1, valueIndex + 1);
    } else {
      matched = valueIndex < value.length
        && pattern[patternIndex] === value[valueIndex]
        && matchAt(patternIndex + 1, valueIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return matchAt(0, 0);
}

function matchCaseBracket(
  pattern: string,
  start: number,
  value: string | undefined,
): { matches: boolean; end: number } | null {
  const end = pattern.indexOf(']', start + 1);
  if (end < 0) return null;
  let index = start + 1;
  const negate = pattern[index] === '!' || pattern[index] === '^';
  if (negate) index++;
  let matches = false;
  while (index < end) {
    const first = pattern[index] === '\\' && index + 1 < end
      ? pattern[++index]
      : pattern[index];
    matches ||= value === first;
    index++;
  }
  return { matches: negate ? !matches : matches, end };
}

function executeCaseConservatively(
  cmd: CaseCommand,
  state: AnalysisState,
): AbstractStatus {
  const patternEffects = state.tracker.checkpoint();
  let executablePattern = false;
  for (const clause of caseClauses(cmd.clauses)) {
    for (const pattern of clause.patterns) {
      executablePattern ||= pattern.word.includes('$(')
        || pattern.word.includes('`');
      expand_word_unsplit_to_string(
        pattern.word,
        state.env,
        expansionWarning(state),
        expansionContext(state),
      );
    }
  }
  state.tracker.markAllEffectsFrom(patternEffects, ['case-branch']);
  if (executablePattern) {
    state.tracker.setVfs(null);
    state.runtime.vfsSelectionUncertainty = [
      ...new Set([
        ...state.runtime.vfsSelectionUncertainty,
        'case-branch' as const,
      ]),
    ];
  }

  const clauses = caseClauses(cmd.clauses);
  if (clauses.length === 0) return successStatus();
  const base = appendPathUncertainty(captureShellState(state), 'case-branch');
  const finalOutputs: ShellStateSnapshot[] = [
    caseNoMatchSnapshot(state, base),
  ];
  let testNextInputs: ShellStateSnapshot[] = [];
  let fallthroughInputs: ShellStateSnapshot[] = [];
  const actionEffects = state.tracker.checkpoint();

  for (const clause of clauses) {
    const inputs = boundShellSnapshots(state, [
      base,
      ...testNextInputs,
      ...fallthroughInputs,
    ]);
    const clauseOutputs: ShellStateSnapshot[] = [];
    for (const input of inputs) {
      restoreShellState(state, input);
      state.runtime.alternatives = [];
      if (input.control.kind !== 'none') {
        clauseOutputs.push(input);
      } else if (clause.action) {
        execute_command_state(clause.action, state);
        clauseOutputs.push(...takeShellStates(state));
      } else {
        setLastStatus(state, successStatus());
        clauseOutputs.push(captureShellState(state));
      }
    }

    const normalOutputs = clauseOutputs.filter(
      output => output.control.kind === 'none',
    );
    finalOutputs.push(...clauseOutputs.filter(
      output => output.control.kind !== 'none',
    ));
    fallthroughInputs = [];
    if ((clause.flags & CASEPAT_FALLTHROUGH) !== 0) {
      fallthroughInputs = normalOutputs;
    } else if ((clause.flags & CASEPAT_TESTNEXT) !== 0) {
      finalOutputs.push(...normalOutputs);
      testNextInputs = boundShellSnapshots(state, [
        ...testNextInputs,
        ...normalOutputs,
      ]);
    } else {
      finalOutputs.push(...normalOutputs);
    }
  }
  finalOutputs.push(...fallthroughInputs);
  state.tracker.deduplicateAllFrom(actionEffects);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      boundShellSnapshots(state, finalOutputs),
      base.pathUncertainty.filter(reason => reason !== 'case-branch'),
      state.tracker,
    ),
  );
}

function caseNoMatchSnapshot(
  state: AnalysisState,
  base: ShellStateSnapshot,
): ShellStateSnapshot {
  restoreShellState(state, base);
  state.runtime.alternatives = [];
  setLastStatus(state, successStatus());
  return captureShellState(state);
}

function boundShellSnapshots(
  state: AnalysisState,
  snapshots: readonly ShellStateSnapshot[],
): ShellStateSnapshot[] {
  if (snapshots.length === 0) return [];
  installShellStates(state, snapshots);
  return takeShellStates(state);
}

function execute_while_command(
  cmd: WhileCommand,
  state: AnalysisState,
): AbstractStatus {
  return execute_while_or_until(cmd, state, false);
}

function execute_until_command(
  cmd: WhileCommand,
  state: AnalysisState,
): AbstractStatus {
  return execute_while_or_until(cmd, state, true);
}

function execute_while_or_until(
  cmd: WhileCommand,
  state: AnalysisState,
  until: boolean,
): AbstractStatus {
  const before = state.tracker.checkpoint();
  const outputs: ShellStateSnapshot[] = [];

  state.runtime.loopDepth++;
  try {
    execute_command_state(cmd.test, state);
    for (const tested of takeShellStates(state)) {
      if (tested.control.kind !== 'none') {
        outputs.push(finishSingleLoopPath(
          state,
          tested,
          successStatus(),
          true,
        ));
        continue;
      }

      const status = tested.lastStatus;
      const mayEnter = until ? status.mayFail : status.maySucceed;
      const mayExit = until ? status.maySucceed : status.mayFail;
      if (mayExit) {
        const exitInput = mayEnter
          ? appendPathUncertainty(tested, 'unknown-loop-count')
          : tested;
        outputs.push(asLoopExit(state, exitInput, successStatus()));
      }
      if (!mayEnter) continue;

      const entryStatus = until
        ? failureStatusPart(status)
        : successfulStatusPart(status);
      // One body transfer summarizes one-or-more iterations. Even a known
      // true test can repeat beyond the retained abstract execution.
      const bodyInput = appendPathUncertainty(tested, 'unknown-loop-count');
      restoreShellState(state, bodyInput);
      state.runtime.alternatives = [];
      state.control = normalControl();
      setLastStatus(state, entryStatus);
      execute_command_state(cmd.action, state);
      for (const bodyOutput of takeShellStates(state)) {
        outputs.push(finishSingleLoopPath(
          state,
          bodyOutput,
          bodyOutput.lastStatus,
          false,
        ));
      }
    }
  } finally {
    state.runtime.loopDepth--;
  }

  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      commonPathUncertainty(outputs.map(output => output.pathUncertainty)),
      state.tracker,
    ),
  );
}

function finishSingleLoopPath(
  state: AnalysisState,
  snapshot: ShellStateSnapshot,
  status: AbstractStatus,
  fromTest: boolean,
): ShellStateSnapshot {
  const control = snapshot.control;
  if (control.kind === 'none') return asLoopExit(state, snapshot, status);
  if (control.kind === 'break') {
    if (control.levels <= 1) {
      return asLoopExit(
        state,
        withoutPathUncertainty(snapshot, 'unknown-loop-count'),
        status,
      );
    }
    return withLoopControl(state, snapshot, {
      kind: control.kind,
      levels: control.levels - 1,
    });
  }
  if (control.kind === 'continue') {
    if (control.levels <= 1) {
      const resumed = fromTest
        ? appendPathUncertainty(snapshot, 'unknown-loop-count')
        : snapshot;
      return asLoopExit(state, resumed, status);
    }
    return withLoopControl(state, snapshot, {
      kind: control.kind,
      levels: control.levels - 1,
    });
  }
  return snapshot;
}

function withoutPathUncertainty(
  snapshot: ShellStateSnapshot,
  reason: UncertaintyReason,
): ShellStateSnapshot {
  return {
    ...snapshot,
    pathUncertainty: snapshot.pathUncertainty.filter(item => item !== reason),
  };
}

function asLoopExit(
  state: AnalysisState,
  snapshot: ShellStateSnapshot,
  status: AbstractStatus,
): ShellStateSnapshot {
  restoreShellState(state, snapshot);
  state.runtime.alternatives = [];
  state.control = normalControl();
  setLastStatus(state, status);
  return captureShellState(state);
}

function withLoopControl(
  state: AnalysisState,
  snapshot: ShellStateSnapshot,
  control: ControlTransfer,
): ShellStateSnapshot {
  restoreShellState(state, snapshot);
  state.runtime.alternatives = [];
  state.control = control;
  return captureShellState(state);
}

function execute_if_command(
  cmd: IfCommand,
  state: AnalysisState,
): AbstractStatus {
  execute_command_state(cmd.test, state);
  const thenCandidates: GuardedCandidate[] = [];
  const elseCandidates: GuardedCandidate[] = [];
  for (const snapshot of takeShellStates(state)) {
    if (snapshot.lastStatus.maySucceed) {
      thenCandidates.push({
        input: snapshot,
        entryStatus: successfulStatusPart(snapshot.lastStatus),
        action: cmd.true_case,
        route: 'then',
      });
    }
    if (snapshot.lastStatus.mayFail) {
      elseCandidates.push({
        input: snapshot,
        entryStatus: failureStatusPart(snapshot.lastStatus),
        action: cmd.false_case,
        resultStatus: successStatus(),
        route: 'else',
      });
    }
  }
  return executeGuardedCandidates(
    state,
    [...thenCandidates, ...elseCandidates],
    'conditional-branch',
  );
}

function execute_connection(
  cmd: Connection,
  state: AnalysisState,
): AbstractStatus {
  if (cmd.connector === PIPE || cmd.connector === BAR_AND) {
    return executePipeline(cmd, state);
  }
  if (cmd.connector === AMP) {
    const asyncFirst = (cmd.first.flags & CMD_AMPERSAND) !== 0
      ? cmd.first
      : { ...cmd.first, flags: cmd.first.flags | CMD_AMPERSAND };
    execute_command_state(asyncFirst, state);
    return cmd.second
      ? execute_command_state(cmd.second, state)
      : successStatus();
  }

  const firstStatus = execute_command_state(cmd.first, state);

  if (!cmd.second) return firstStatus;
  if (cmd.connector === AND_AND) {
    const candidates: GuardedCandidate[] = [];
    for (const snapshot of takeShellStates(state)) {
      if (snapshot.lastStatus.mayFail) {
        candidates.push({
          input: snapshot,
          entryStatus: failureStatusPart(snapshot.lastStatus),
          action: null,
          resultStatus: failureStatusPart(snapshot.lastStatus),
          route: 'skip',
        });
      }
      if (snapshot.lastStatus.maySucceed) {
        candidates.push({
          input: snapshot,
          entryStatus: successfulStatusPart(snapshot.lastStatus),
          action: cmd.second,
          route: 'execute',
        });
      }
    }
    return executeGuardedCandidates(state, candidates, 'and-or-branch');
  }
  if (cmd.connector === OR_OR) {
    const candidates: GuardedCandidate[] = [];
    for (const snapshot of takeShellStates(state)) {
      if (snapshot.lastStatus.maySucceed) {
        candidates.push({
          input: snapshot,
          entryStatus: successfulStatusPart(snapshot.lastStatus),
          action: null,
          resultStatus: successfulStatusPart(snapshot.lastStatus),
          route: 'skip',
        });
      }
      if (snapshot.lastStatus.mayFail) {
        candidates.push({
          input: snapshot,
          entryStatus: failureStatusPart(snapshot.lastStatus),
          action: cmd.second,
          route: 'execute',
        });
      }
    }
    return executeGuardedCandidates(state, candidates, 'and-or-branch');
  }
  return execute_command_state(cmd.second, state);
}

function executePipeline(
  cmd: Connection,
  state: AnalysisState,
): AbstractStatus {
  const parent = captureShellState(state);
  const segments = flattenPipeline(cmd);
  const segmentStatuses: AbstractStatus[] = [];
  const filesystemOutcomes: ShellStateSnapshot[] = [parent];
  let pipelineInput: AbstractStream | null = null;

  for (const segment of segments) {
    restoreShellState(state, parent);
    state.runtime.alternatives = [];
    if (pipelineInput) {
      setFdTarget(state, 0, { kind: 'input', stream: pipelineInput });
    }
    setFdTarget(state, 1, { kind: 'capture' });
    state.io.capture = emptyStream();
    const savedSelectionUncertainty = state.runtime.vfsSelectionUncertainty;
    state.runtime.vfsSelectionUncertainty = [
      ...new Set([...savedSelectionUncertainty, 'pipeline-race' as const]),
    ];
    let status: AbstractStatus;
    try {
      status = executeWithShellLocalIsolation(
        state,
        () => execute_command_state(
          segment.pipeStderr
            ? withStderrPipeRedirect(segment.command)
            : segment.command,
          state,
        ),
      );
    } finally {
      state.runtime.vfsSelectionUncertainty = savedSelectionUncertainty;
    }
    segmentStatuses.push(status);
    const segmentOutcomes = takeShellStates(state);
    pipelineInput = joinStreams(
      segmentOutcomes.map(outcome => outcome.io.capture),
      'pipeline-output-join',
    );
    filesystemOutcomes.push(...segmentOutcomes);
    if (filesystemOutcomes.length > MAX_SHELL_PATHS) {
      installShellStates(state, filesystemOutcomes);
      filesystemOutcomes.splice(0, filesystemOutcomes.length, ...takeShellStates(state));
    }
  }

  const status = pipelineStatus(segmentStatuses, parent.flags.pipefail);
  const outputs = restoreParentShellWithFilesystemOutcomes(
    state,
    parent,
    filesystemOutcomes,
    status,
    'pipeline-race',
    pipelineInput ?? emptyStream(),
  );
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      parent.pathUncertainty,
      state.tracker,
    ),
  );
}

interface PipelineSegment {
  command: Command;
  pipeStderr: boolean;
}

function flattenPipeline(command: Command): PipelineSegment[] {
  if (command.type !== 'connection'
      || (command.connector !== PIPE && command.connector !== BAR_AND)
      || !command.second) {
    return [{ command, pipeStderr: false }];
  }
  const left = flattenPipeline(command.first);
  const right = flattenPipeline(command.second);
  left[left.length - 1] = {
    ...left[left.length - 1],
    pipeStderr: command.connector === BAR_AND,
  };
  return [...left, ...right];
}

function withStderrPipeRedirect(command: Command): Command {
  const redirect: Redirect = {
    next: null,
    redirector: { dest: 2, filename: null },
    rflags: 0,
    instruction: 'r_duplicating_output',
    redirectee: { dest: 1, filename: null },
  };
  return {
    ...command,
    redirects: appendClonedRedirect(command.redirects, redirect),
  };
}

function appendClonedRedirect(
  redirects: Redirect | null,
  appended: Redirect,
): Redirect {
  if (!redirects) return appended;
  const head: Redirect = {
    ...redirects,
    redirector: { ...redirects.redirector },
    redirectee: {
      ...redirects.redirectee,
      filename: redirects.redirectee.filename
        ? { ...redirects.redirectee.filename }
        : null,
    },
    next: null,
  };
  let source = redirects.next;
  let target = head;
  while (source) {
    target.next = {
      ...source,
      redirector: { ...source.redirector },
      redirectee: {
        ...source.redirectee,
        filename: source.redirectee.filename
          ? { ...source.redirectee.filename }
          : null,
      },
      next: null,
    };
    target = target.next;
    source = source.next;
  }
  target.next = appended;
  return head;
}

function executeBackgroundCommand(
  cmd: Command,
  state: AnalysisState,
): AbstractStatus {
  const parent = captureShellState(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  executeCommandConcrete(cmd, state, true, false);
  const childOutcomes = takeShellStates(state);
  const status = successStatus();
  const outputs = restoreParentShellWithFilesystemOutcomes(
    state,
    parent,
    [parent, ...childOutcomes],
    status,
    'background-race',
  );
  installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      parent.pathUncertainty,
      state.tracker,
    ),
  );
  return status;
}

function restoreParentShellWithFilesystemOutcomes(
  state: AnalysisState,
  parent: ShellStateSnapshot,
  filesystemOutcomes: readonly ShellStateSnapshot[],
  status: AbstractStatus,
  uncertainty: 'pipeline-race' | 'background-race',
  routedOutput?: AbstractStream,
): ShellStateSnapshot[] {
  const outputs: ShellStateSnapshot[] = [];
  for (const filesystemOutcome of filesystemOutcomes) {
    restoreShellState(state, filesystemOutcome);
    const vfs = state.tracker.vfs?.clone() ?? null;
    state.env.restore(parent.env);
    state.flags = { ...parent.flags };
    state.tracker.setCwd(parent.cwd);
    state.tracker.setVfs(vfs);
    state.control = parent.control;
    state.io = cloneIoState(parent.io);
    if (routedOutput) emitToFd(state, 1, routedOutput);
    else state.io.capture = filesystemOutcome.io.capture;
    state.runtime.pathUncertainty = [
      ...new Set([
        ...parent.pathUncertainty,
        ...filesystemOutcome.pathUncertainty,
        uncertainty,
      ]),
    ];
    setLastStatus(state, status);
    outputs.push(captureShellState(state));
  }
  return outputs;
}

function intersectEffectIdentities(
  identities: readonly EffectIdentitySets[],
): EffectIdentitySets {
  if (identities.length === 0) return emptyEffectIdentities();
  return {
    files: intersectSets(identities.map(identity => identity.files)),
    git: intersectSets(identities.map(identity => identity.git)),
    resources: intersectSets(identities.map(identity => identity.resources)),
  };
}

function emptyEffectIdentities(): EffectIdentitySets {
  return { files: new Set(), git: new Set(), resources: new Set() };
}

function intersectSets(sets: readonly ReadonlySet<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]].filter(value =>
    sets.slice(1).every(set => set.has(value))));
}

function register_function(cmd: FunctionDef, env: VariableEnvironment): void {
  env.register_function(cmd.name.word, cmd.command);
}

function execute_group_command(
  cmd: GroupCommand,
  state: AnalysisState,
): AbstractStatus {
  return execute_command_state(cmd.command, state);
}

function execute_subshell(
  cmd: SubshellCommand,
  state: AnalysisState,
): AbstractStatus {
  // Shell-local changes are isolated; branch-local filesystem overlays escape.
  return executeWithShellLocalIsolation(
    state,
    () => execute_command_state(cmd.command, state),
  );
}

interface GuardedCandidate {
  input: ShellStateSnapshot;
  entryStatus: AbstractStatus;
  action: Command | null;
  resultStatus?: AbstractStatus;
  route: string;
}

function executeGuardedCandidates(
  state: AnalysisState,
  candidates: readonly GuardedCandidate[],
  uncertainty: 'conditional-branch' | 'case-branch' | 'and-or-branch' | 'unknown-loop-count',
): AbstractStatus {
  const before = state.tracker.checkpoint();
  const retainedUncertainty = commonPathUncertainty(
    candidates.map(candidate => candidate.input.pathUncertainty),
  );
  const routes = new Set(candidates.map(candidate => candidate.route));
  const conditional = routes.size > 1;
  const outputs: ShellStateSnapshot[] = [];
  for (const candidate of candidates) {
    if (candidate.input.control.kind !== 'none') {
      outputs.push(candidate.input);
      continue;
    }
    const input = conditional
      ? appendPathUncertainty(candidate.input, uncertainty)
      : candidate.input;
    restoreShellState(state, input);
    state.runtime.alternatives = [];
    setLastStatus(state, candidate.entryStatus);
    if (candidate.action) {
      execute_command_state(candidate.action, state);
    } else {
      setLastStatus(state, candidate.resultStatus ?? candidate.entryStatus);
    }
    outputs.push(...takeShellStates(state));
  }
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      retainedUncertainty,
      state.tracker,
    ),
  );
}

function mutateShellStates(
  state: AnalysisState,
  mutate: () => void,
): void {
  mapShellStates(state, snapshot => {
    if (snapshot.control.kind === 'none') mutate();
    return captureShellState(state);
  });
}

function mapShellStates(
  state: AnalysisState,
  map: (snapshot: ShellStateSnapshot) => ShellStateSnapshot,
): void {
  const outputs: ShellStateSnapshot[] = [];
  for (const snapshot of takeShellStates(state)) {
    restoreShellState(state, snapshot);
    state.runtime.alternatives = [];
    outputs.push(map(snapshot));
  }
  installShellStates(state, outputs);
}

function executeWithShellLocalIsolation(
  state: AnalysisState,
  execute: () => AbstractStatus,
): AbstractStatus {
  const parent = captureShellState(state);
  const fallbackStatus = execute();
  if (state.runtime.alternatives.length === 0) {
    setLastStatus(state, fallbackStatus);
  }
  const childOutcomes = takeShellStates(state);
  const outputs: ShellStateSnapshot[] = [];
  for (const child of childOutcomes) {
    restoreShellState(state, child);
    const childVfs = state.tracker.vfs?.clone() ?? null;
    const childStatus = child.lastStatus;
    const childUncertainty = [...child.pathUncertainty];
    const childCapture = child.io.capture;
    state.env.restore(parent.env);
    state.flags = { ...parent.flags };
    state.tracker.setCwd(parent.cwd);
    state.tracker.setVfs(childVfs);
    state.control = normalControl();
    state.io = cloneIoState(parent.io);
    state.io.capture = childCapture;
    state.runtime.pathUncertainty = childUncertainty;
    setLastStatus(state, childStatus);
    outputs.push(captureShellState(state));
  }
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      parent.pathUncertainty,
      state.tracker,
    ),
  );
}

function commonPathUncertainty(
  reasons: readonly (readonly UncertaintyReason[])[],
): UncertaintyReason[] {
  if (reasons.length === 0) return [];
  return reasons[0].filter(reason =>
    reasons.slice(1).every(candidate => candidate.includes(reason)));
}

function setLastStatus(state: AnalysisState, status: AbstractStatus): AbstractStatus {
  state.lastStatus = status;
  if (!status.mayHaveOtherFailureCode && status.exactCodes.length === 1) {
    state.env.bind_variable('?', String(status.exactCodes[0]));
  } else {
    state.env.unbind_variable('?');
  }
  return status;
}

/** Collect file effects from a redirect chain */
function collect_redirect_effects(
  redir: Redirect | null,
  state: AnalysisState,
): boolean {
  const { tracker, env } = state;
  let r = redir;
  while (r) {
    let expandedTarget: ExpandedWord | null = null;
    if (redirectExpandsTarget(r)) {
      const filename = redirect_target_filename(r);
      if (filename !== null) {
        expandedTarget = expand_word_to_string(
          filename,
          env,
          expansionWarning(state),
          expansionContext(state),
        );
        if (expandedTarget.word.length === 0) {
          tracker.addWarning('redirect: empty target');
          return false;
        }
      }
    }
    if (is_write_redirect(r)) {
      if (expandedTarget) {
        if (tracker.isKnownDirectory(expandedTarget.word)) {
          tracker.addWarning(`redirect: ${expandedTarget.word}: Is a directory`);
          return false;
        }
        const effectType = is_append_redirect(r) ? 'append' : 'write';
        const opSymbol = effectType === 'append' ? '>>' : '>';
        tracker.add({
          type: effectType,
          path: expandedTarget.word,
          line: 0, // redirect doesn't have its own line
          command: opSymbol,
          uncertain: expandedTarget.uncertain,
          provenance: expandedTarget.provenance,
          // Redirect opening below owns truncation/append content semantics.
        }, { updateVfs: false });
      }
    }
    if (!applyFdRedirect(r, expandedTarget, state)) return false;
    r = r.next;
  }
  return true;
}

function redirectExpandsTarget(redir: Redirect): boolean {
  return redir.instruction === 'r_output_direction'
    || redir.instruction === 'r_appending_to'
    || redir.instruction === 'r_input_direction'
    || redir.instruction === 'r_input_output'
    || redir.instruction === 'r_output_force'
    || redir.instruction === 'r_err_and_out'
    || redir.instruction === 'r_append_err_and_out'
    || redir.instruction === 'r_reading_string'
    || redir.instruction === 'r_duplicating_input_word'
    || redir.instruction === 'r_duplicating_output_word'
    || redir.instruction === 'r_move_input_word'
    || redir.instruction === 'r_move_output_word';
}

function applyFdRedirect(
  redir: Redirect,
  expandedTarget: ExpandedWord | null,
  state: AnalysisState,
): boolean {
  const destination = redir.redirector.dest;
  switch (redir.instruction) {
    case 'r_output_direction':
    case 'r_output_force':
      return setFileFd(state, destination, expandedTarget, 'write');
    case 'r_appending_to':
      return setFileFd(state, destination, expandedTarget, 'append');
    case 'r_err_and_out':
    case 'r_append_err_and_out': {
      const mode = redir.instruction === 'r_append_err_and_out'
        ? 'append'
        : 'write';
      if (!expandedTarget) return false;
      const target: AbstractFdTarget = expandedTarget.uncertain
        ? { kind: 'unknown', reason: 'redirect-target-expansion' }
        : makeFileFdTarget(state, expandedTarget.word, mode);
      setFdTarget(state, 1, target);
      setFdTarget(state, 2, target);
      return true;
    }
    case 'r_input_direction':
      return setFileFd(state, destination, expandedTarget, 'read');
    case 'r_input_output':
      return setFileFd(state, destination, expandedTarget, 'read-write');
    case 'r_reading_until':
    case 'r_deblank_reading_until': {
      const body = redir.redirectee.filename?.word ?? '';
      const expanded = redir.here_doc_quoted
        ? { word: body, uncertain: false }
        : expand_here_document(
          body,
          state.env,
          expansionWarning(state),
          expansionContext(state),
        );
      const stream = expanded.uncertain
        ? unknownStream(
          'here-document-expansion',
          expanded.provenance ?? [],
        )
        : exactStream(
          expanded.word,
          DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
          expanded.provenance ?? [],
        );
      setFdTarget(state, destination, { kind: 'input', stream });
      return true;
    }
    case 'r_reading_string': {
      const stream = expandedTarget && !expandedTarget.uncertain
        ? exactStream(
          `${expandedTarget.word}\n`,
          DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
          expandedTarget.provenance ?? [],
        )
        : unknownStream(
          'here-string-expansion',
          expandedTarget?.provenance ?? [],
        );
      setFdTarget(state, destination, { kind: 'input', stream });
      return true;
    }
    case 'r_close_this':
      setFdTarget(state, destination, { kind: 'closed' });
      return true;
    case 'r_duplicating_input':
    case 'r_duplicating_output':
      duplicateFd(state, destination, redir.redirectee.dest, false);
      return true;
    case 'r_move_input':
    case 'r_move_output':
      duplicateFd(state, destination, redir.redirectee.dest, true);
      return true;
    case 'r_duplicating_input_word':
    case 'r_duplicating_output_word':
      return duplicateExpandedFd(state, destination, expandedTarget, false);
    case 'r_move_input_word':
    case 'r_move_output_word':
      return duplicateExpandedFd(state, destination, expandedTarget, true);
  }
}

function setFileFd(
  state: AnalysisState,
  destination: number,
  target: ExpandedWord | null,
  mode: Extract<AbstractFdTarget, { kind: 'file' }>['mode'],
): boolean {
  if (!target) return false;
  const fdTarget: AbstractFdTarget = target.uncertain
    ? { kind: 'unknown', reason: 'redirect-target-expansion' }
    : makeFileFdTarget(state, target.word, mode);
  setFdTarget(state, destination, fdTarget);
  return true;
}

function makeFileFdTarget(
  state: AnalysisState,
  target: string,
  mode: Extract<AbstractFdTarget, { kind: 'file' }>['mode'],
): AbstractFdTarget {
  const resolved = state.tracker.resolvePath(target);
  if (state.tracker.isEphemeralPath(resolved)) {
    return {
      kind: 'unknown',
      reason: 'process-substitution-handle',
    };
  }
  if (mode === 'write') {
    state.tracker.vfs?.updateTextFile(resolved, '', 'truncate');
  } else if (mode === 'append' || mode === 'read-write') {
    state.tracker.vfs?.updateTextFile(resolved, '', 'append');
  }
  return { kind: 'file', path: resolved, mode };
}

function duplicateExpandedFd(
  state: AnalysisState,
  destination: number,
  target: ExpandedWord | null,
  move: boolean,
): boolean {
  if (!target) return false;
  if (target.uncertain) {
    setFdTarget(state, destination, {
      kind: 'unknown',
      reason: 'redirect-fd-expansion',
    });
    return true;
  }
  if (target.word === '-') {
    setFdTarget(state, destination, { kind: 'closed' });
    return true;
  }
  if (!/^\d+$/u.test(target.word)) {
    setFdTarget(state, destination, {
      kind: 'unknown',
      reason: 'redirect-fd-target',
    });
    return false;
  }
  duplicateFd(state, destination, Number.parseInt(target.word, 10), move);
  return true;
}

function duplicateFd(
  state: AnalysisState,
  destination: number,
  source: number,
  move: boolean,
): void {
  setFdTarget(
    state,
    destination,
    cloneFdTarget(state.io.fds[String(source)] ?? {
      kind: 'unknown',
      reason: 'unbound-fd',
    }),
    `${move ? 'move' : 'duplicate'} fd ${source} to fd ${destination}`,
  );
  if (move) setFdTarget(state, source, { kind: 'closed' });
}

function setFdTarget(
  state: AnalysisState,
  fd: number,
  target: AbstractFdTarget,
  flowLabel?: string,
): void {
  const cloned = cloneFdTarget(target);
  if (cloned.kind === 'input') {
    cloned.stream = traceStreamFlow(
      state,
      cloned.stream,
      flowLabel ?? `bind input stream to fd ${fd}`,
    );
  }
  state.io.fds[String(fd)] = cloned;
}

function restoreFileDescriptors(
  state: AnalysisState,
  fds: Record<string, AbstractFdTarget>,
): void {
  mapShellStates(state, () => {
    state.io.fds = Object.fromEntries(
      Object.entries(fds).map(([fd, target]) => [fd, cloneFdTarget(target)]),
    );
    return captureShellState(state);
  });
}

function readFromFd(state: AnalysisState, fd: number): AbstractStream {
  const target = state.io.fds[String(fd)];
  if (target?.kind === 'input') {
    return traceStreamFlow(state, target.stream, `read from fd ${fd}`);
  }
  if (target?.kind === 'closed') {
    return traceStreamFlow(state, emptyStream(), `read closed fd ${fd}`);
  }
  const reason = target?.kind === 'file'
    ? 'file-input'
    : target?.kind === 'unknown'
      ? target.reason
      : 'inherited-input';
  return traceStreamFlow(
    state,
    unknownStream(reason),
    `read unknown stream from fd ${fd}`,
  );
}

function emitToFd(
  state: AnalysisState,
  fd: number,
  stream: AbstractStream,
): void {
  const target = state.io.fds[String(fd)];
  if (target?.kind === 'capture') {
    const routed = traceStreamFlow(
      state,
      stream,
      `write fd ${fd} to captured stream`,
    );
    state.io.capture = appendStreams(state.io.capture, routed);
  } else if (target?.kind === 'file') {
    if (target.mode === 'write' || target.mode === 'append') {
      state.tracker.vfs?.updateTextFile(
        target.path,
        exactStreamValue(stream),
        'append',
      );
    } else if (target.mode === 'read-write') {
      state.tracker.vfs?.updateTextFile(target.path, null, 'truncate');
    }
  } else if (target?.kind === 'unknown') {
    const routed = traceStreamFlow(
      state,
      stream,
      `write fd ${fd} through unknown route`,
    );
    state.io.capture = appendStreams(
      state.io.capture,
      unknownStream(target.reason, routed.provenance),
      'unknown-fd-route',
    );
  }
}

function traceStreamFlow(
  state: AnalysisState,
  stream: AbstractStream,
  label: string,
): AbstractStream {
  const root = state.tracker.addProvenance({
    kind: 'stream-flow',
    label,
    ...(stream.provenance.length === 0
      ? {}
      : { parents: stream.provenance }),
  });
  return {
    ...stream,
    provenance: [root],
  };
}

function exactStreamValue(stream: AbstractStream): string | null {
  return stream.value.kind === 'finite'
    && stream.value.values.length === 1
    && !stream.value.mayBeUnset
    ? stream.value.values[0]
    : null;
}

function emitUnknownOutputIfRouted(
  state: AnalysisState,
  command: string,
): void {
  const target = state.io.fds['1'];
  if (target?.kind === 'capture'
      || target?.kind === 'unknown'
      || target?.kind === 'file') {
    emitToFd(state, 1, unknownStream(`stdout:${command}`));
  }
}

function enterExecutionStep(state: AnalysisState): boolean {
  if (state.runtime.halted) return false;
  state.runtime.statementCount++;
  if (state.runtime.statementCount <= MAX_EXEC_STATEMENTS) return true;
  state.runtime.halted = true;
  warnOnce(state, 'statement-budget', `Bash analysis stopped after ${MAX_EXEC_STATEMENTS} commands`);
  return false;
}

function expansionWarning(state: AnalysisState): (warning: string) => void {
  return warning => warnOnce(state, `expansion:${warning}`, warning);
}

function limitExpandedWords(words: ExpandedWord[], state: AnalysisState, line: number, context: string): ExpandedWord[] {
  if (words.length <= MAX_EXPANDED_WORDS) return words;
  warnOnce(state, `expanded-words:${context}:${line}`, `${context} at line ${line} truncated after ${MAX_EXPANDED_WORDS} words`);
  return words.slice(0, MAX_EXPANDED_WORDS).map(word => ({ ...word, uncertain: true }));
}

function warnOnce(state: AnalysisState, key: string, message: string): void {
  if (state.runtime.warnings.has(key)) return;
  state.runtime.warnings.add(key);
  state.tracker.addWarning(message);
}
