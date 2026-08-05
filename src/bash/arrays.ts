import { evaluateArithmeticExpression } from './arithmetic.js';
import { MAX_PROVENANCE_PARENTS } from '../analysis/provenance.js';
import type { ArrayReference } from './general.js';
import type { ShellArrayKind, VariableEnvironment } from './variables.js';

export interface ArraySubscriptExpansion {
  word: string;
  uncertain: boolean;
  provenance?: number[];
}

export interface ResolvedArrayElement {
  key: string | null;
  kind: ShellArrayKind;
  uncertain: boolean;
  provenance: number[];
}

/**
 * Resolve one array element reference without executing external code.
 *
 * Indexed subscripts use the shared bounded arithmetic evaluator. Associative
 * keys receive ordinary unsplit shell expansion from the caller.
 */
export function resolve_array_element(
  reference: ArrayReference,
  env: VariableEnvironment,
  expandSubscript: (subscript: string) => ArraySubscriptExpansion,
): ResolvedArrayElement {
  const kind = env.get_array_kind(reference.name) ?? 'indexed';
  const expanded = expandSubscript(reference.subscript);
  const provenance = [...(expanded.provenance ?? [])];
  if (expanded.uncertain) {
    return { key: null, kind, uncertain: true, provenance };
  }

  if (kind === 'associative') {
    if (expanded.word.length === 0) {
      return { key: null, kind, uncertain: true, provenance };
    }
    return {
      key: expanded.word,
      kind,
      uncertain: false,
      provenance,
    };
  }

  const evaluated = evaluateArithmeticExpression(expanded.word, env);
  let arithmeticProvenance = normalizeProvenance([
    ...provenance,
    ...evaluated.provenance,
  ]);
  if (evaluated.uncertain || evaluated.value === null) {
    return {
      key: null,
      kind,
      uncertain: true,
      provenance: arithmeticProvenance,
    };
  }
  let index = evaluated.value;
  if (index < 0n) {
    if (env.get_array_values(reference.name).uncertain) {
      return {
        key: null,
        kind,
        uncertain: true,
        provenance: arithmeticProvenance,
      };
    }
    arithmeticProvenance = normalizeProvenance([
      ...arithmeticProvenance,
      ...env.get_array_provenance(reference.name),
    ]);
    const maximum = env.get_array_max_index(reference.name) ?? -1n;
    index = maximum + 1n + index;
  }
  if (index < 0n) {
    return {
      key: null,
      kind,
      uncertain: true,
      provenance: arithmeticProvenance,
    };
  }
  return {
    key: String(index),
    kind,
    uncertain: false,
    provenance: arithmeticProvenance,
  };
}

function normalizeProvenance(provenance: readonly number[]): number[] {
  return [...new Set(provenance)]
    .filter(id => Number.isInteger(id) && id >= 0)
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}
