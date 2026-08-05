// subst.ts — Word/parameter expansion pipeline

import type { WordList } from './command.js';
import { W_QUOTED, W_NOGLOB } from './command.js';
import type { VariableEnvironment } from './variables.js';
import {
  legal_variable_starter,
  legal_variable_char,
  parse_array_reference,
} from './general.js';
import type { IFS } from '../analysis/vfs.js';
import {
  createGlobExpansionBudget,
  has_glob_chars,
  glob_expand_bounded,
} from '../analysis/vfs.js';
import { evaluateArithmeticExpression } from './arithmetic.js';
import {
  resolve_array_element,
  type ArraySubscriptExpansion,
} from './arrays.js';
import {
  MAX_SHELL_GROUP_CLOSE_CANDIDATES,
  MAX_SHELL_GROUP_PARSE_CHARS,
  parseComplete,
} from './parse.js';
import { MAX_PROVENANCE_PARENTS } from '../analysis/provenance.js';

export const MAX_BRACE_EXPANSION_RESULTS = 2000;
export const MAX_EXPANDED_WORDS = 4000;

// ── Brace expansion ──

interface BraceExpansionBudget {
  limit: number;
  produced: number;
  truncated: boolean;
}

function emit_brace_result(word: string, budget: BraceExpansionBudget): string[] {
  if (budget.produced >= budget.limit) {
    budget.truncated = true;
    return [];
  }
  budget.produced++;
  return [word];
}

function brace_expand(word: string, budget: BraceExpansionBudget): string[] {
  // Find the first unquoted comma-brace group: {a,b,c}
  // Or sequence: {1..5}
  const start = find_brace_open(word);
  if (start === -1) return emit_brace_result(word, budget);

  const end = find_brace_close(word, start);
  if (end === -1) return emit_brace_result(word, budget);

  const preamble = word.substring(0, start);
  const postamble = word.substring(end + 1);
  const body = word.substring(start + 1, end);

  // Check for sequence: {N..M}
  const seq = parse_numeric_brace_sequence(body);
  if (seq) {
    const { from, to, step } = seq;
    if (step === 0) return emit_brace_result(word, budget);
    const results: string[] = [];
    if (from <= to) {
      for (let i = from; i <= to && !budget.truncated; i += step) {
        results.push(...brace_expand(preamble + i + postamble, budget));
      }
    } else {
      for (let i = from; i >= to && !budget.truncated; i -= step) {
        results.push(...brace_expand(preamble + i + postamble, budget));
      }
    }
    return results;
  }

  // Comma-separated: {a,b,c}
  const parts = split_brace_body(body);
  if (parts.length <= 1) return emit_brace_result(word, budget); // no commas, not a brace expansion
  const results: string[] = [];
  for (const part of parts) {
    if (budget.truncated) break;
    results.push(...brace_expand(preamble + part + postamble, budget));
  }
  return results;
}

function parse_numeric_brace_sequence(body: string): { from: number; to: number; step: number } | null {
  const first = readSignedInteger(body, 0);
  if (!first) return null;
  let pos = first.end;
  if (body[pos] !== '.' || body[pos + 1] !== '.') return null;
  pos += 2;
  const second = readSignedInteger(body, pos);
  if (!second) return null;
  pos = second.end;
  let step = 1;
  if (pos < body.length) {
    if (body[pos] !== '.' || body[pos + 1] !== '.') return null;
    pos += 2;
    const third = readSignedInteger(body, pos);
    if (!third) return null;
    step = Math.abs(third.value);
    pos = third.end;
  }
  if (pos !== body.length) return null;
  return { from: first.value, to: second.value, step };
}

function readSignedInteger(s: string, start: number): { value: number; end: number } | null {
  let pos = start;
  let sign = 1;
  if (s[pos] === '-') {
    sign = -1;
    pos++;
  }
  const digitsStart = pos;
  let value = 0;
  while (pos < s.length && s[pos] >= '0' && s[pos] <= '9') {
    value = value * 10 + (s.charCodeAt(pos) - 48);
    pos++;
  }
  if (pos === digitsStart) return null;
  return { value: sign * value, end: pos };
}

function find_brace_open(word: string): number {
  let depth = 0;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '\\') { i++; continue; }
    if (word[i] === '\'' || word[i] === '"') {
      const q = word[i];
      i++;
      while (i < word.length && word[i] !== q) {
        if (word[i] === '\\' && q === '"') i++;
        i++;
      }
      continue;
    }
    if (word[i] === '{') {
      if (depth === 0) return i;
      depth++;
    }
    if (word[i] === '}') depth--;
  }
  return -1;
}

function find_brace_close(word: string, openPos: number): number {
  let depth = 1;
  for (let i = openPos + 1; i < word.length; i++) {
    if (word[i] === '\\') { i++; continue; }
    if (word[i] === '\'' || word[i] === '"') {
      const q = word[i];
      i++;
      while (i < word.length && word[i] !== q) {
        if (word[i] === '\\' && q === '"') i++;
        i++;
      }
      continue;
    }
    if (word[i] === '{') depth++;
    if (word[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function split_brace_body(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      current += body[i] + (body[i + 1] || '');
      i++;
      continue;
    }
    if (body[i] === '{') depth++;
    if (body[i] === '}') depth--;
    if (body[i] === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += body[i];
    }
  }
  parts.push(current);
  return parts;
}

// ── Tilde expansion ──

function tilde_expand_word(word: string, env: VariableEnvironment): string {
  if (!word.startsWith('~')) return word;
  const slash = word.indexOf('/');
  const user = slash === -1 ? word.substring(1) : word.substring(1, slash);
  const rest = slash === -1 ? '' : word.substring(slash);

  if (user === '' || user === (env.get_string_value('USER') ?? '')) {
    const home = env.get_string_value('HOME') ?? '/home/user';
    // Escape so a Windows-style HOME (e.g. C:\Users\foo) survives the later
    // quote_removal pass intact.
    return quote_expanded_value(home) + rest;
  }
  // Unknown user — leave as-is
  return word;
}

// ── Parameter expansion ──

interface ExpandResult {
  value: string;
  uncertain: boolean;
  provenance?: number[];
}

function param_expand(
  expr: string,
  env: VariableEnvironment,
  context?: ExpansionContext,
): ExpandResult {
  const parsed = parseParameterExpansion(expr);
  if (!parsed) return { value: '', uncertain: true, provenance: [] };

  if (parsed.kind === 'length') {
    const reference = parse_array_reference(parsed.name);
    if (reference && (reference.subscript === '@' || reference.subscript === '*')) {
      const values = env.get_array_values(reference.name);
      return {
        value: String(values.values.length),
        uncertain: values.uncertain,
        provenance: values.provenance,
      };
    }
    const expanded = parameterValue(parsed.name, env, context);
    return {
      value: String(expanded.value.length),
      uncertain: expanded.uncertain,
      provenance: expanded.provenance,
    };
  }

  const expanded = parameterValue(parsed.name, env, context);
  const val = expanded.isSet ? expanded.value : undefined;
  const valueUncertain = expanded.uncertain;
  const isSet = val !== undefined;
  const isNonNull = isSet && val !== '';

  switch (parsed.kind) {
    case 'value':
      return {
        value: val ?? '',
        uncertain: valueUncertain,
        provenance: expanded.provenance,
      };
    case 'default':
      if (parsed.checkNull ? isNonNull : isSet) {
        return {
          value: val ?? '',
          uncertain: valueUncertain,
          provenance: expanded.provenance,
        };
      }
      return expandParameterOperatorWord(parsed.word, env, context);
    case 'assignDefault':
      if (parsed.checkNull ? isNonNull : isSet) {
        return {
          value: val ?? '',
          uncertain: valueUncertain,
          provenance: expanded.provenance,
        };
      }
      {
        const assigned = expandParameterOperatorWord(parsed.word, env, context);
        const reference = parse_array_reference(parsed.name);
        if (reference) {
          env.widen_array(
            reference.name,
            env.get_array_kind(reference.name) ?? 'indexed',
            assigned.provenance,
          );
          return {
            value: assigned.value,
            uncertain: true,
            provenance: env.get_array_provenance(reference.name),
          };
        }
        env.bind_variable(
          parsed.name,
          assigned.value,
          0,
          assigned.uncertain,
          assigned.provenance,
        );
        return {
          ...assigned,
          provenance: env.get_value_provenance(parsed.name),
        };
      }
    case 'alternate':
      if (parsed.checkNull ? isNonNull : isSet) {
        const alternate = expandParameterOperatorWord(parsed.word, env, context);
        return {
          value: alternate.value,
          uncertain: valueUncertain || alternate.uncertain,
          provenance: normalizeProvenance([
            ...(expanded.provenance ?? []),
            ...(alternate.provenance ?? []),
          ]),
        };
      }
      return {
        value: '',
        uncertain: false,
        provenance: expanded.provenance,
      };
    case 'error':
      if (parsed.checkNull ? isNonNull : isSet) {
        return {
          value: val ?? '',
          uncertain: valueUncertain,
          provenance: expanded.provenance,
        };
      }
      {
        const errorWord = expandParameterOperatorWord(
          parsed.word,
          env,
          context,
        );
        return {
          value: '',
          uncertain: true,
          provenance: normalizeProvenance([
            ...(expanded.provenance ?? []),
            ...(errorWord.provenance ?? []),
          ]),
        };
      }
    case 'removePrefix':
      return {
        value: strip_prefix(val ?? '', parsed.pattern, parsed.longest),
        uncertain: valueUncertain,
        provenance: expanded.provenance,
      };
    case 'removeSuffix':
      return {
        value: strip_suffix(val ?? '', parsed.pattern, parsed.longest),
        uncertain: valueUncertain,
        provenance: expanded.provenance,
      };
    case 'replace':
      return {
        value: replace_pattern(val ?? '', parsed.pattern, parsed.replacement),
        uncertain: valueUncertain,
        provenance: expanded.provenance,
      };
  }
}

function expandParameterOperatorWord(
  word: string,
  env: VariableEnvironment,
  context?: ExpansionContext,
): ExpandResult {
  let uncertain = false;
  const provenance: number[] = [];
  const tracedContext = collectExpansionProvenance(context, provenance);
  const expanded = expand_dollar(
    word,
    env,
    value => { uncertain ||= value; },
    tracedContext,
  );
  return {
    value: string_quote_removal(expanded),
    uncertain,
    provenance: normalizeProvenance(provenance),
  };
}

function parameterValue(
  name: string,
  env: VariableEnvironment,
  context?: ExpansionContext,
): ExpandResult & { isSet: boolean } {
  const reference = parse_array_reference(name);
  if (!reference) {
    const value = env.get_string_value(name);
    return {
      value: value ?? '',
      uncertain: env.is_value_uncertain(name),
      isSet: value !== undefined,
      provenance: env.get_value_provenance(name),
    };
  }
  if (reference.subscript === '@' || reference.subscript === '*') {
    const expanded = env.get_array_values(reference.name);
    const separator = (env.get_string_value('IFS') ?? ' \t\n')[0] ?? '';
    return {
      value: expanded.values.map(element => element.value).join(separator),
      uncertain: expanded.uncertain
        || expanded.values.some(element => element.uncertain)
        || expanded.values.length > 1,
      isSet: expanded.values.length > 0,
      provenance: expanded.provenance,
    };
  }

  const resolved = resolve_array_element(
    reference,
    env,
    subscript => expandArraySubscript(subscript, env, context),
  );
  if (resolved.key === null) {
    return {
      value: `<unknown:${reference.name}[${reference.subscript}]>`,
      uncertain: true,
      isSet: true,
      provenance: env.get_array_provenance(reference.name),
    };
  }
  const element = env.get_array_element(reference.name, resolved.key);
  if (element.value === undefined && element.uncertain) {
    return {
      value: `<unknown:${reference.name}[${resolved.key}]>`,
      uncertain: true,
      isSet: true,
      provenance: normalizeProvenance([
        ...resolved.provenance,
        ...element.provenance,
      ]),
    };
  }
  return {
    value: element.value ?? '',
    uncertain: resolved.uncertain || element.uncertain,
    isSet: element.value !== undefined,
    provenance: normalizeProvenance([
      ...resolved.provenance,
      ...element.provenance,
    ]),
  };
}

function expandArraySubscript(
  subscript: string,
  env: VariableEnvironment,
  context?: ExpansionContext,
): ArraySubscriptExpansion {
  let uncertain = false;
  const provenance: number[] = [];
  const tracedContext = collectExpansionProvenance(context, provenance);
  const expanded = expand_dollar(
    subscript,
    env,
    value => { uncertain ||= value; },
    tracedContext,
  );
  return {
    word: string_quote_removal(expanded),
    uncertain,
    provenance: normalizeProvenance(provenance),
  };
}

type ParameterExpansion =
  | { kind: 'value'; name: string }
  | { kind: 'length'; name: string }
  | { kind: 'default' | 'assignDefault' | 'alternate' | 'error'; name: string; word: string; checkNull: boolean }
  | { kind: 'removePrefix' | 'removeSuffix'; name: string; pattern: string; longest: boolean }
  | { kind: 'replace'; name: string; pattern: string; replacement: string };

function parseParameterExpansion(expr: string): ParameterExpansion | null {
  if (expr.length === 0) return null;
  if (expr[0] === '#') {
    const name = expr.substring(1);
    return isParameterName(name) ? { kind: 'length', name } : null;
  }

  const nameEnd = readParameterName(expr, 0);
  if (nameEnd === 0) return null;
  const name = expr.substring(0, nameEnd);
  if (nameEnd === expr.length) return { kind: 'value', name };

  let pos = nameEnd;
  let checkNull = false;
  if (expr[pos] === ':' && pos + 1 < expr.length && isColonParameterOperator(expr[pos + 1])) {
    checkNull = true;
    pos++;
  }

  const op = expr[pos];
  const rest = expr.substring(pos + 1);
  if (op === '-') return { kind: 'default', name, word: rest, checkNull };
  if (op === '=') return { kind: 'assignDefault', name, word: rest, checkNull };
  if (op === '+') return { kind: 'alternate', name, word: rest, checkNull };
  if (op === '?') return { kind: 'error', name, word: rest, checkNull };
  if (op === '#') {
    const longest = rest[0] === '#';
    const pattern = longest ? rest.substring(1) : rest;
    return { kind: 'removePrefix', name, pattern, longest };
  }
  if (op === '%') {
    const longest = rest[0] === '%';
    const pattern = longest ? rest.substring(1) : rest;
    return { kind: 'removeSuffix', name, pattern, longest };
  }
  if (op === '/') {
    const split = splitPatternReplacement(rest);
    return { kind: 'replace', name, pattern: split.pattern, replacement: split.replacement };
  }
  return null;
}

function readShellName(s: string, start: number): number {
  if (start >= s.length || !legal_variable_starter(s[start])) return start;
  let pos = start + 1;
  while (pos < s.length && legal_variable_char(s[pos])) pos++;
  return pos;
}

function readParameterName(s: string, start: number): number {
  if (start >= s.length) return start;
  const c = s[start];
  if ((c >= '0' && c <= '9') || c === '?' || c === '!' || c === '$' || c === '#' || c === '@' || c === '*' || c === '-') {
    return start + 1;
  }
  const nameEnd = readShellName(s, start);
  if (nameEnd === start || s[nameEnd] !== '[') return nameEnd;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let position = nameEnd; position < s.length; position++) {
    const character = s[position];
    if (character === '\\' && quote !== "'") {
      position++;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '[') depth++;
    else if (character === ']') {
      depth--;
      if (depth === 0) return position + 1;
    }
  }
  return nameEnd;
}

function isParameterName(s: string): boolean {
  return readParameterName(s, 0) === s.length;
}

function isColonParameterOperator(c: string): boolean {
  return c === '-' || c === '=' || c === '+' || c === '?';
}

function splitPatternReplacement(s: string): { pattern: string; replacement: string } {
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (s[i] === '\\') {
      escaped = true;
      continue;
    }
    if (s[i] === '/') {
      return { pattern: s.substring(0, i), replacement: s.substring(i + 1) };
    }
  }
  return { pattern: s, replacement: '' };
}

function strip_suffix(str: string, pattern: string, longest: boolean): string {
  if (longest) {
    for (let i = 0; i <= str.length; i++) {
      if (glob_match(pattern, str.substring(i))) return str.substring(0, i);
    }
  } else {
    for (let i = str.length; i >= 0; i--) {
      if (glob_match(pattern, str.substring(i))) return str.substring(0, i);
    }
  }
  return str;
}

function strip_prefix(str: string, pattern: string, longest: boolean): string {
  if (longest) {
    for (let i = str.length; i >= 0; i--) {
      if (glob_match(pattern, str.substring(0, i))) return str.substring(i);
    }
  } else {
    for (let i = 0; i <= str.length; i++) {
      if (glob_match(pattern, str.substring(0, i))) return str.substring(i);
    }
  }
  return str;
}

function replace_pattern(str: string, pattern: string, replacement: string): string {
  for (let start = 0; start <= str.length; start++) {
    for (let end = start; end <= str.length; end++) {
      if (glob_match(pattern, str.substring(start, end))) {
        return str.substring(0, start) + replacement + str.substring(end);
      }
    }
  }
  return str;
}

function glob_match(pattern: string, value: string): boolean {
  const memo = new Map<string, boolean>();
  const matchAt = (pi: number, vi: number): boolean => {
    const key = pi + ':' + vi;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === pattern.length) {
      result = vi === value.length;
    } else if (pattern[pi] === '*') {
      result = false;
      for (let next = vi; next <= value.length; next++) {
        if (matchAt(pi + 1, next)) {
          result = true;
          break;
        }
      }
    } else if (pattern[pi] === '?') {
      result = vi < value.length && matchAt(pi + 1, vi + 1);
    } else if (pattern[pi] === '\\' && pi + 1 < pattern.length) {
      result = vi < value.length && pattern[pi + 1] === value[vi] && matchAt(pi + 2, vi + 1);
    } else {
      result = vi < value.length && pattern[pi] === value[vi] && matchAt(pi + 1, vi + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matchAt(0, 0);
}

// ── Word splitting ──

function word_split(value: string, ifs: string): string[] {
  if (ifs === '') return [value];
  // Default IFS splitting: split on IFS chars, collapse whitespace
  const parts: string[] = [];
  let current = '';
  let inWhitespace = false;
  for (const c of value) {
    if (ifs.includes(c)) {
      if (current || !inWhitespace) {
        if (current) parts.push(current);
        current = '';
      }
      inWhitespace = ' \t\n'.includes(c);
    } else {
      current += c;
      inWhitespace = false;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// ── Quote removal ──

/**
 * Escape a value that was produced by variable / tilde / parameter expansion
 * so that the subsequent string_quote_removal pass treats it as a literal.
 *
 * We backslash-escape the three characters quote_removal acts on (`\`, `'`,
 * `"`) so the subsequent pass treats expanded content as literal. They
 * collapse back to the original chars during quote_removal.
 *
 * Without this, a value like `C:\Windows` stored in $WINDIR would have its
 * `\W` eaten by quote_removal (backslash-escape) → `C:indows`, and values
 * containing `'` or `"` would open phantom quote sections.
 */
function quote_expanded_value(val: string): string {
  let out = '';
  for (let i = 0; i < val.length; i++) {
    const c = val.charCodeAt(i);
    // 0x22 = ", 0x27 = ', 0x5C = \
    if (c === 0x22 || c === 0x27 || c === 0x5C) out += '\\';
    out += val[i];
  }
  return out;
}

function string_quote_removal(word: string): string {
  let result = '';
  let i = 0;
  while (i < word.length) {
    if (word[i] === '\\' && i + 1 < word.length) {
      result += word[i + 1];
      i += 2;
    } else if (word[i] === '\'') {
      i++;
      while (i < word.length && word[i] !== '\'') {
        result += word[i];
        i++;
      }
      i++; // skip closing quote
    } else if (word[i] === '"') {
      i++; // skip opening quote
      while (i < word.length && word[i] !== '"') {
        if (word[i] === '\\' && i + 1 < word.length) {
          const escaped = word[i + 1];
          if (escaped === '\n') {
            i += 2;
            continue;
          }
          if ('$`"\\'.includes(escaped)) result += escaped;
          else result += `\\${escaped}`;
          i += 2;
        } else {
          result += word[i];
          i++;
        }
      }
      i++; // skip closing quote
    } else {
      result += word[i];
      i++;
    }
  }
  return result;
}

// ── Main expansion pipeline ──

export interface ExpandedWord {
  word: string;
  uncertain: boolean;
  noglob?: boolean;
  /** The word is a concrete witness selected by filesystem glob expansion. */
  globbed?: boolean;
  /** One retained representative stands for results omitted by a budget. */
  boundedRemainder?: {
    kind: 'brace' | 'word' | 'word-list';
    expression: string;
    scope: 'word' | 'list';
  };
  /** Analysis-local expansion nodes consumed by EffectTracker. */
  provenance?: number[];
}

export interface CommandSubstitutionExpansion {
  word: string;
  uncertain: boolean;
  provenance?: number[];
}

export type ProcessSubstitutionDirection = 'read' | 'write';

export type ExpansionTraceOperation =
  | 'brace'
  | 'tilde'
  | 'array'
  | 'parameter'
  | 'arithmetic'
  | 'command-substitution'
  | 'process-substitution'
  | 'word-splitting'
  | 'glob';

export interface ExpansionTrace {
  operation: ExpansionTraceOperation;
  expression: string;
  /** Value-flow roots consumed by this expansion step. */
  parents?: readonly number[];
}

export interface ExpansionContext {
  commandSubstitute?: (script: string) => CommandSubstitutionExpansion;
  processSubstitute?: (
    script: string,
    direction: ProcessSubstitutionDirection,
  ) => CommandSubstitutionExpansion;
  recordExpansion?: (trace: ExpansionTrace) => number | undefined;
}

export interface GlobExpansionWordOptions {
  maxWords?: number;
  recordExpansion?: (trace: ExpansionTrace) => number | undefined;
  onWarning?: (warning: string) => void;
}

export interface ExpandWordsOptions {
  maxWords?: number;
  onWarning?: (warning: string) => void;
  context?: ExpansionContext;
}

/** Expand a single word through the full expansion pipeline */
export function expand_word_internal(
  word: string,
  env: VariableEnvironment,
  quoted: boolean = false,
  onWarning?: (warning: string) => void,
  context?: ExpansionContext,
  maxResults: number = MAX_BRACE_EXPANSION_RESULTS,
  limitScope: 'word' | 'list' = 'word',
): ExpandedWord[] {
  const resultLimit = boundedExpansionLimit(
    maxResults,
    MAX_BRACE_EXPANSION_RESULTS,
  );
  let uncertain = false;
  const provenance: number[] = [];
  const tracedContext: ExpansionContext | undefined = context
    ? {
      ...context,
      recordExpansion: trace => {
        const id = context.recordExpansion?.(trace);
        if (id !== undefined) provenance.push(id);
        return id;
      },
    }
    : undefined;

  // 1. Brace expansion (not inside quotes)
  const braceBudget = {
    limit: Math.min(MAX_BRACE_EXPANSION_RESULTS, resultLimit),
    produced: 0,
    truncated: false,
  };
  const braceExpanded = quoted ? [word] : brace_expand(word, braceBudget);
  if (braceExpanded.length !== 1 || braceExpanded[0] !== word) {
    tracedContext?.recordExpansion?.({
      operation: 'brace',
      expression: word,
    });
  }

  const results: ExpandedWord[] = [];
  let resultLimitReached = false;
  for (const w of braceExpanded) {
    if (results.length >= resultLimit) {
      resultLimitReached = true;
      break;
    }
    // 2. Tilde expansion
    let expanded = tilde_expand_word(w, env);
    if (expanded !== w) {
      tracedContext?.recordExpansion?.({
        operation: 'tilde',
        expression: w,
        parents: env.get_value_provenance('HOME'),
      });
    }

    const arrayWords = expandStandaloneArrayWord(
      expanded,
      env,
      quoted,
      uncertain,
    );
    if (arrayWords !== null) {
      tracedContext?.recordExpansion?.({
        operation: 'array',
        expression: expanded,
        parents: (() => {
          const reference = standaloneArrayReference(expanded, quoted);
          return reference
            ? env.get_array_provenance(reference.name)
            : [];
        })(),
      });
      const roots = normalizeProvenance(provenance);
      for (const result of arrayWords) {
        if (results.length >= resultLimit) {
          resultLimitReached = true;
          break;
        }
        results.push({
          ...result,
          provenance: normalizeProvenance([
            ...(result.provenance ?? []),
            ...roots,
          ]),
        });
      }
      if (resultLimitReached) break;
      continue;
    }

    // 3-5. Parameter, command sub, arithmetic expansion
    expanded = expand_dollar(
      expanded,
      env,
      (u) => { if (u) uncertain = true; },
      tracedContext,
    );

    // 6. Quote removal
    expanded = string_quote_removal(expanded);

    // 7. Word splitting (not for quoted or assignment contexts)
    if (!quoted) {
      const ifs = env.get_string_value('IFS') ?? ' \t\n';
      const split = word_split(expanded, ifs);
      if (split.length !== 1 || split[0] !== expanded) {
        tracedContext?.recordExpansion?.({
          operation: 'word-splitting',
          expression: expanded,
          parents: normalizeProvenance([
            ...provenance,
            ...env.get_value_provenance('IFS'),
          ]),
        });
      }
      for (const s of split) {
        if (results.length >= resultLimit) {
          resultLimitReached = true;
          break;
        }
        results.push({
          word: s,
          uncertain,
          provenance: normalizeProvenance(provenance),
        });
      }
    } else {
      results.push({
        word: expanded,
        uncertain,
        provenance: normalizeProvenance(provenance),
      });
    }
  }

  if (braceBudget.truncated || resultLimitReached) {
    const scope = braceBudget.truncated
      && braceBudget.limit === MAX_BRACE_EXPANSION_RESULTS
      ? 'word'
      : limitScope;
    retainBoundedExpansionRemainder(
      results,
      word,
      braceBudget.truncated ? 'brace' : 'word',
      scope,
      provenance,
    );
    if (scope === 'word') {
      const label = braceBudget.truncated ? 'brace expansion' : 'word expansion';
      const limit = braceBudget.truncated ? braceBudget.limit : resultLimit;
      onWarning?.(`${label} truncated after ${limit} results: ${word}`);
    }
  }

  return results;
}

function expandStandaloneArrayWord(
  word: string,
  env: VariableEnvironment,
  quoted: boolean,
  inheritedUncertainty: boolean,
): ExpandedWord[] | null {
  const reference = standaloneArrayReference(word, quoted);
  if (!reference) return null;

  let doubleQuoted = false;
  if (word.startsWith('"') && word.endsWith('"') && word.length >= 2) {
    doubleQuoted = true;
  }

  const expansion = env.get_array_values(reference.name);
  const elements = [...expansion.values];
  if (expansion.uncertain) {
    elements.push({
      value: `<unknown:${reference.name}[@]>`,
      uncertain: true,
      provenance: expansion.provenance,
    });
  }
  const baseUncertainty = inheritedUncertainty || expansion.uncertain;
  const ifs = env.get_string_value('IFS') ?? ' \t\n';

  if (reference.subscript === '@') {
    if (quoted || doubleQuoted) {
      return elements.map(element => ({
        word: element.value,
        uncertain: baseUncertainty || element.uncertain,
        noglob: true,
        provenance: element.provenance,
      }));
    }
    const words: ExpandedWord[] = [];
    for (const element of elements) {
      for (const field of word_split(element.value, ifs)) {
        words.push({
          word: field,
          uncertain: baseUncertainty || element.uncertain,
          provenance: normalizeProvenance([
            ...(element.provenance ?? []),
            ...env.get_value_provenance('IFS'),
          ]),
        });
      }
    }
    return words;
  }

  const separator = ifs[0] ?? '';
  const joined = elements.map(element => element.value).join(separator);
  const joinedUncertain = baseUncertainty
    || elements.some(element => element.uncertain);
  const provenance = normalizeProvenance([
    ...expansion.provenance,
    ...env.get_value_provenance('IFS'),
  ]);
  if (quoted || doubleQuoted) {
    return [{
      word: joined,
      uncertain: joinedUncertain,
      noglob: true,
      provenance,
    }];
  }
  return word_split(joined, ifs).map(field => ({
    word: field,
    uncertain: joinedUncertain,
    provenance,
  }));
}

function standaloneArrayReference(
  word: string,
  quoted: boolean,
): ReturnType<typeof parse_array_reference> {
  let parameter = word;
  let doubleQuoted = false;
  if (word.startsWith('"') && word.endsWith('"') && word.length >= 2) {
    parameter = word.slice(1, -1);
    doubleQuoted = true;
  } else if (word.startsWith("'") && word.endsWith("'")) {
    return null;
  }
  if (quoted && !doubleQuoted) return null;
  if (!parameter.startsWith('${') || !parameter.endsWith('}')) return null;
  const reference = parse_array_reference(parameter.slice(2, -1));
  if (!reference
      || (reference.subscript !== '@' && reference.subscript !== '*')) {
    return null;
  }
  return reference;
}

/** Process all dollar expansions in a string */
function expand_dollar(
  word: string,
  env: VariableEnvironment,
  onUncertain: (u: boolean) => void,
  context?: ExpansionContext,
  mode: 'word' | 'here-document' = 'word',
): string {
  let result = '';
  let i = 0;
  let inDoubleQuote = false;

  while (i < word.length) {
    if (word[i] === '\\' && i + 1 < word.length) {
      result += word[i] + word[i + 1];
      i += 2;
      continue;
    }

    if (mode === 'word' && word[i] === '\'' && !inDoubleQuote) {
      // Single-quoted: skip everything
      const end = word.indexOf('\'', i + 1);
      if (end === -1) {
        result += word.substring(i);
        break;
      }
      result += word.substring(i, end + 1);
      i = end + 1;
      continue;
    }

    if (mode === 'word' && word[i] === '"') {
      inDoubleQuote = !inDoubleQuote;
      result += word[i];
      i++;
      continue;
    }

    if (mode === 'word'
        && !inDoubleQuote
        && (word[i] === '<' || word[i] === '>')
        && word[i + 1] === '(') {
      const end = find_matching_paren(word, i + 1);
      if (end !== -1) {
        const script = word.substring(i + 2, end);
        const direction = word[i] === '<' ? 'read' : 'write';
        context?.recordExpansion?.({
          operation: 'process-substitution',
          expression: word.substring(i, end + 1),
        });
        const substitution = context?.processSubstitute?.(script, direction);
        result += protectExpandedValue(
          substitution?.word ?? `<${direction}-process-substitution>`,
          mode,
        );
        onUncertain(substitution?.uncertain ?? true);
        i = end + 1;
        continue;
      }
    }

    if (word[i] === '$') {
      if (i + 1 >= word.length) {
        result += '$';
        i++;
        continue;
      }

      // $((expr)) — arithmetic
      if (word[i + 1] === '(' && word[i + 2] === '(') {
        const end = word.indexOf('))', i + 3);
        if (end !== -1) {
          const expr = word.substring(i + 3, end);
          const expanded = expand_dollar(
            expr,
            env,
            onUncertain,
            context,
            mode,
          );
          const arith = evaluateArithmeticExpression(expanded, env);
          context?.recordExpansion?.({
            operation: 'arithmetic',
            expression: word.substring(i, end + 2),
            parents: arith.provenance,
          });
          onUncertain(arith.uncertain);
          result += arith.value === null ? '0' : String(arith.value);
          i = end + 2;
          continue;
        }
      }

      // $(cmd) — command substitution
      if (word[i + 1] === '(') {
        const end = find_matching_paren(word, i + 1);
        if (end !== -1) {
          const cmd = word.substring(i + 2, end);
          const substitution = context?.commandSubstitute?.(cmd);
          context?.recordExpansion?.({
            operation: 'command-substitution',
            expression: word.substring(i, end + 1),
            parents: substitution?.provenance,
          });
          result += protectExpandedValue(
            substitution?.word ?? `<$(${cmd})>`,
            mode,
          );
          onUncertain(substitution?.uncertain ?? true);
          i = end + 1;
          continue;
        }
      }

      // ${...} — parameter expansion
      if (word[i + 1] === '{') {
        const end = find_matching_brace(word, i + 1);
        if (end !== -1) {
          const expr = word.substring(i + 2, end);
          const expanded = param_expand(expr, env, context);
          context?.recordExpansion?.({
            operation: 'parameter',
            expression: word.substring(i, end + 1),
            parents: expanded.provenance,
          });
          onUncertain(expanded.uncertain);
          result += protectExpandedValue(expanded.value, mode);
          i = end + 1;
          continue;
        }
      }

      // $VAR — simple variable
      if (legal_variable_starter(word[i + 1])) {
        let j = i + 1;
        while (j < word.length && legal_variable_char(word[j])) j++;
        const name = word.substring(i + 1, j);
        context?.recordExpansion?.({
          operation: 'parameter',
          expression: word.substring(i, j),
          parents: env.get_value_provenance(name),
        });
        const val = env.get_string_value(name);
        if (val !== undefined) {
          result += protectExpandedValue(val, mode);
          onUncertain(env.is_value_uncertain(name));
        } else {
          onUncertain(true);
        }
        i = j;
        continue;
      }

      // Special variables: $?, $!, $$, $#, $@, $*, $0-9
      if ('?!$#@*-'.includes(word[i + 1])) {
        const name = word[i + 1];
        context?.recordExpansion?.({
          operation: 'parameter',
          expression: word.substring(i, i + 2),
          parents: env.get_value_provenance(name),
        });
        const val = env.get_string_value(name);
        if (val === undefined && name === '?') {
          result += '<unknown-status>';
          onUncertain(true);
        } else {
          result += protectExpandedValue(val ?? '', mode);
          onUncertain(env.is_value_uncertain(name));
        }
        i += 2;
        continue;
      }

      if (word[i + 1] >= '0' && word[i + 1] <= '9') {
        const name = word[i + 1];
        context?.recordExpansion?.({
          operation: 'parameter',
          expression: word.substring(i, i + 2),
          parents: env.get_value_provenance(name),
        });
        const val = env.get_string_value(name);
        result += protectExpandedValue(val ?? '', mode);
        i += 2;
        continue;
      }

      result += '$';
      i++;
      continue;
    }

    // Backtick command substitution
    if (word[i] === '`') {
      const end = word.indexOf('`', i + 1);
      if (end !== -1) {
        const cmd = word.substring(i + 1, end);
        const substitution = context?.commandSubstitute?.(cmd);
        context?.recordExpansion?.({
          operation: 'command-substitution',
          expression: word.substring(i, end + 1),
          parents: substitution?.provenance,
        });
        result += protectExpandedValue(
          substitution?.word ?? `<$(${cmd})>`,
          mode,
        );
        onUncertain(substitution?.uncertain ?? true);
        i = end + 1;
        continue;
      }
    }

    result += word[i];
    i++;
  }

  return result;
}

function protectExpandedValue(
  value: string,
  mode: 'word' | 'here-document',
): string {
  return mode === 'word' ? quote_expanded_value(value) : value;
}

function find_matching_paren(s: string, openPos: number): number {
  let closeCandidates = 0;
  let validationBudgetExhausted = false;
  let fallback = -1;
  for (let i = openPos + 1; i < s.length; i++) {
    const character = s[i];
    if (character === '\\') {
      i++;
      continue;
    }
    if (character === ')') {
      closeCandidates++;
      fallback = i;
      const body = s.substring(openPos + 1, i);
      const withinBudget = closeCandidates <= MAX_SHELL_GROUP_CLOSE_CANDIDATES
        && body.length <= MAX_SHELL_GROUP_PARSE_CHARS;
      if (withinBudget && isCompleteNestedShellBody(body)) {
        return i;
      }
      validationBudgetExhausted ||= !withinBudget;
    }
  }
  return validationBudgetExhausted ? fallback : -1;
}

function isCompleteNestedShellBody(body: string): boolean {
  if (body.trim().length === 0) return true;
  const parsed = parseComplete(`(${body})`);
  return parsed.ast !== null
    && parsed.complete
    && !parsed.warnings.some(warning =>
      warning.includes('Parse error')
      || warning.includes('unexpected EOF')
      || warning.includes('delimited by end-of-file'));
}

function find_matching_brace(s: string, openPos: number): number {
  let depth = 1;
  for (let i = openPos + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Check if a word string has glob chars outside of quotes */
function has_unquoted_glob(word: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === '\\' && !inSingle) { i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if ((c === '*' || c === '?' || c === '[') && !inSingle && !inDouble) {
      return true;
    }
  }
  return false;
}

/** Expand a WordList through the full pipeline */
export function expand_words(
  words: WordList,
  env: VariableEnvironment,
  options: ExpandWordsOptions = {},
): ExpandedWord[] {
  const maxWords = boundedExpansionLimit(
    options.maxWords,
    MAX_EXPANDED_WORDS,
  );
  const results: ExpandedWord[] = [];
  let listLimitReached = false;
  for (let index = 0; index < words.length; index++) {
    const wd = words[index];
    if (results.length >= maxWords) {
      listLimitReached = true;
      retainBoundedExpansionRemainder(
        results,
        wd.word,
        'word-list',
        'list',
        [],
      );
      break;
    }
    const quoted = !!(wd.flags & W_QUOTED);
    const noglob = !!(wd.flags & (W_QUOTED | W_NOGLOB)) || !has_unquoted_glob(wd.word);
    const remainingWords = words.length - index - 1;
    const reservedWords = Math.min(
      remainingWords,
      Math.max(0, maxWords - results.length - 1),
    );
    const available = Math.max(
      1,
      maxWords - results.length - reservedWords,
    );
    const expanded = expand_word_internal(
      wd.word,
      env,
      quoted,
      options.onWarning,
      options.context,
      available,
      'list',
    );
    for (const ew of expanded) {
      if (noglob) ew.noglob = true;
      results.push(ew);
      if (ew.boundedRemainder?.scope === 'list') {
        listLimitReached = true;
      }
    }
  }
  if (listLimitReached) {
    options.onWarning?.(
      `word expansion truncated after ${maxWords} words`,
    );
  }
  return results;
}

/** Expand a single word, returning just the string (first result) */
export function expand_word_to_string(
  word: string,
  env: VariableEnvironment,
  onWarning?: (warning: string) => void,
  context?: ExpansionContext,
): ExpandedWord {
  const results = expand_word_internal(word, env, false, onWarning, context);
  if (results.length === 0) return { word: '', uncertain: false };
  if (results.length === 1) return results[0];
  return {
    word: results.map(result => result.word).join(' '),
    uncertain: true,
    provenance: normalizeProvenance(
      results.flatMap(result => result.provenance ?? []),
    ),
  };
}

/** Expand one shell word without brace expansion or word splitting. */
export function expand_word_unsplit_to_string(
  word: string,
  env: VariableEnvironment,
  onWarning?: (warning: string) => void,
  context?: ExpansionContext,
): ExpandedWord {
  const results = expand_word_internal(word, env, true, onWarning, context);
  if (results.length === 0) return { word: '', uncertain: false };
  if (results.length === 1) return results[0];
  return {
    word: results.map(result => result.word).join(' '),
    uncertain: results.some(result => result.uncertain),
    noglob: true,
    provenance: normalizeProvenance(
      results.flatMap(result => result.provenance ?? []),
    ),
  };
}

export function expand_here_document(
  body: string,
  env: VariableEnvironment,
  onWarning?: (warning: string) => void,
  context?: ExpansionContext,
): ExpandedWord {
  let uncertain = body.includes('\\');
  const provenance: number[] = [];
  const tracedContext: ExpansionContext | undefined = context
    ? {
      ...context,
      recordExpansion: trace => {
        const id = context.recordExpansion?.(trace);
        if (id !== undefined) provenance.push(id);
        return id;
      },
    }
    : undefined;
  const expanded = expand_dollar(
    body,
    env,
    value => { uncertain ||= value; },
    tracedContext,
    'here-document',
  );
  if (uncertain) onWarning?.('here-document expansion is not fully resolved');
  return {
    word: expanded,
    uncertain,
    noglob: true,
    provenance: normalizeProvenance(provenance),
  };
}

/** Expand glob patterns in a list of already-expanded words against a VFS */
export function glob_expand_words(
  words: ExpandedWord[],
  vfs: IFS | null,
  cwd: string,
  options: GlobExpansionWordOptions = {},
): ExpandedWord[] {
  if (!vfs) return words;
  const maxWords = Number.isSafeInteger(options.maxWords)
    && options.maxWords! > 0
    ? options.maxWords!
    : Number.MAX_SAFE_INTEGER;
  const budget = createGlobExpansionBudget();
  const results: ExpandedWord[] = [];
  for (let index = 0; index < words.length; index++) {
    const ew = words[index];
    if (ew.noglob || !has_glob_chars(ew.word)) {
      results.push(ew);
      continue;
    }
    // Preserve one slot for every remaining already-expanded source word.
    // This keeps trailing operands such as a cp destination from being
    // displaced by an earlier high-cardinality glob.
    const remainingWords = words.length - index - 1;
    const available = Math.max(
      1,
      maxWords - results.length - remainingWords,
    );
    const expansion = glob_expand_bounded(ew.word, cwd, vfs, {
      budget,
      maxMatches: available,
    });
    if (expansion.matches.length > 0 || !expansion.complete) {
      const provenance = normalizeProvenance([
        ...(ew.provenance ?? []),
        ...optionalId(options.recordExpansion?.({
          operation: 'glob',
          expression: ew.word,
        })),
      ]);
      const exactLimit = expansion.complete
        ? available
        : Math.max(0, available - 1);
      for (const match of expansion.matches.slice(0, exactLimit)) {
        results.push({
          word: match,
          uncertain: false,
          noglob: true,
          globbed: true,
          provenance,
        });
      }
      if (!expansion.complete) {
        // The unresolved original pattern soundly represents every match not
        // retained under the structural/output budget.
        results.push({
          ...ew,
          noglob: true,
          globbed: true,
          provenance,
        });
        options.onWarning?.(
          `glob expansion widened (${expansion.limitReasons.join(', ')}) for: ${ew.word}`,
        );
      }
    } else {
      // No matches: keep original (nullglob off)
      results.push(ew);
    }
  }
  return results;
}

function retainBoundedExpansionRemainder(
  results: ExpandedWord[],
  expression: string,
  kind: NonNullable<ExpandedWord['boundedRemainder']>['kind'],
  scope: NonNullable<ExpandedWord['boundedRemainder']>['scope'],
  provenance: readonly number[],
): void {
  const representative = results.pop();
  results.push({
    word: representative?.word ?? expression,
    uncertain: true,
    noglob: true,
    globbed: representative?.globbed,
    boundedRemainder: { kind, expression, scope },
    provenance: normalizeProvenance([
      ...(representative?.provenance ?? []),
      ...provenance,
    ]),
  });
}

function boundedExpansionLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function normalizeProvenance(ids: readonly number[]): number[] {
  return [...new Set(ids)]
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}

function collectExpansionProvenance(
  context: ExpansionContext | undefined,
  provenance: number[],
): ExpansionContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    recordExpansion: trace => {
      const id = context.recordExpansion?.(trace);
      if (id !== undefined) provenance.push(id);
      return id;
    },
  };
}

function optionalId(id: number | undefined): number[] {
  return id === undefined ? [] : [id];
}
