/**
 * Small abstract domains shared by the shell analyzers.
 *
 * Finite witnesses are retained even after a value widens to unknown. This
 * lets later stages preserve useful exact effects while also carrying an
 * explicit unknown remainder.
 */

import { MAX_PROVENANCE_PARENTS } from './provenance.js';

export const DEFAULT_ABSTRACT_VALUE_LIMIT = 8;
export const DEFAULT_ABSTRACT_STREAM_LIMIT = 8;
export const DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT = 16 * 1024;

export interface AbstractStringValue {
  kind: 'finite' | 'unknown';
  values: readonly string[];
  mayBeUnset: boolean;
  reasons: readonly string[];
}

export interface AbstractStatus {
  maySucceed: boolean;
  mayFail: boolean;
  exactCodes: readonly number[];
  mayHaveOtherFailureCode: boolean;
}

export interface AbstractStream {
  value: AbstractStringValue;
  mayHaveTrailingNewline: boolean;
  /** Analysis-local value-flow roots; excluded from semantic state identity. */
  provenance: readonly number[];
}

/**
 * Non-local shell control is independent from command success/failure.
 * `levels` mirrors Bash's break/continue counters and is consumed one
 * enclosing loop at a time.
 */
export type ControlTransfer =
  | { kind: 'none' }
  | { kind: 'break' | 'continue'; levels: number }
  | { kind: 'return' | 'exit'; status: AbstractStatus };

export interface ExecutionOutcome {
  status: AbstractStatus;
  stdout: AbstractStream;
  control: ControlTransfer;
}

export function normalControl(): ControlTransfer {
  return { kind: 'none' };
}

export function finiteStringValue(
  values: Iterable<string>,
  mayBeUnset = false,
): AbstractStringValue {
  return {
    kind: 'finite',
    values: normalizeStrings(values),
    mayBeUnset,
    reasons: [],
  };
}

export function exactStringValue(value: string): AbstractStringValue {
  return finiteStringValue([value]);
}

export function unsetStringValue(): AbstractStringValue {
  return finiteStringValue([], true);
}

export function unknownStringValue(
  reason: string,
  witnesses: Iterable<string> = [],
  mayBeUnset = false,
): AbstractStringValue {
  return {
    kind: 'unknown',
    values: normalizeStrings(witnesses),
    mayBeUnset,
    reasons: [reason],
  };
}

export function joinStringValues(
  values: readonly AbstractStringValue[],
  reason: string,
  limit = DEFAULT_ABSTRACT_VALUE_LIMIT,
): AbstractStringValue {
  if (values.length === 0) return unsetStringValue();

  const witnesses = normalizeStrings(values.flatMap(value => value.values));
  const widened = witnesses.length > limit;
  const unknown = widened || values.some(value => value.kind === 'unknown');
  const reasons = normalizeStrings([
    ...values.flatMap(value => value.reasons),
    ...(unknown && values.length > 1 ? [reason] : []),
  ]);

  return {
    kind: unknown ? 'unknown' : 'finite',
    values: witnesses.slice(0, limit),
    mayBeUnset: values.some(value => value.mayBeUnset),
    reasons,
  };
}

export function exactStatus(code: number): AbstractStatus {
  const normalized = normalizeStatusCode(code);
  return {
    maySucceed: normalized === 0,
    mayFail: normalized !== 0,
    exactCodes: [normalized],
    mayHaveOtherFailureCode: false,
  };
}

export function successStatus(): AbstractStatus {
  return exactStatus(0);
}

export function failureStatus(): AbstractStatus {
  return {
    maySucceed: false,
    mayFail: true,
    exactCodes: [],
    mayHaveOtherFailureCode: true,
  };
}

export function unknownStatus(): AbstractStatus {
  return {
    maySucceed: true,
    mayFail: true,
    exactCodes: [0],
    mayHaveOtherFailureCode: true,
  };
}

export function joinStatuses(statuses: readonly AbstractStatus[]): AbstractStatus {
  if (statuses.length === 0) return unknownStatus();
  return {
    maySucceed: statuses.some(status => status.maySucceed),
    mayFail: statuses.some(status => status.mayFail),
    exactCodes: normalizeNumbers(statuses.flatMap(status => status.exactCodes)),
    mayHaveOtherFailureCode: statuses.some(status => status.mayHaveOtherFailureCode),
  };
}

export function successfulStatusPart(status: AbstractStatus): AbstractStatus {
  return status.maySucceed ? successStatus() : failureStatus();
}

export function failureStatusPart(status: AbstractStatus): AbstractStatus {
  if (!status.mayFail) return successStatus();
  return {
    maySucceed: false,
    mayFail: true,
    exactCodes: status.exactCodes.filter(code => code !== 0),
    mayHaveOtherFailureCode: status.mayHaveOtherFailureCode,
  };
}

export function pipelineStatus(
  statuses: readonly AbstractStatus[],
  pipefail: boolean,
): AbstractStatus {
  if (statuses.length === 0) return unknownStatus();
  if (!pipefail) return statuses[statuses.length - 1];

  let laterMaySucceed = true;
  let mayFail = false;
  let mayHaveOtherFailureCode = false;
  const failureCodes: number[] = [];
  for (let index = statuses.length - 1; index >= 0; index--) {
    const status = statuses[index];
    if (laterMaySucceed && status.mayFail) {
      mayFail = true;
      failureCodes.push(...status.exactCodes.filter(code => code !== 0));
      mayHaveOtherFailureCode ||= status.mayHaveOtherFailureCode;
    }
    laterMaySucceed &&= status.maySucceed;
  }
  const maySucceed = laterMaySucceed;
  const exactCodes = normalizeNumbers([
    ...(maySucceed ? [0] : []),
    ...failureCodes,
  ]);
  return {
    maySucceed,
    mayFail,
    exactCodes,
    mayHaveOtherFailureCode,
  };
}

/** Bash logical negation itself returns only status 0 or 1. */
export function invertStatus(status: AbstractStatus): AbstractStatus {
  const exactCodes: number[] = [];
  if (status.mayFail) exactCodes.push(0);
  if (status.maySucceed) exactCodes.push(1);
  return {
    maySucceed: status.mayFail,
    mayFail: status.maySucceed,
    exactCodes,
    mayHaveOtherFailureCode: false,
  };
}

export function statusAsString(status: AbstractStatus): AbstractStringValue {
  const values = status.exactCodes.map(String);
  if (status.mayHaveOtherFailureCode) {
    return unknownStringValue('unknown-exit-code', values);
  }
  return finiteStringValue(values);
}

export function emptyStream(
  provenance: readonly number[] = [],
): AbstractStream {
  return {
    value: exactStringValue(''),
    mayHaveTrailingNewline: false,
    provenance: normalizeProvenance(provenance),
  };
}

export function exactStream(
  value: string,
  charLimit = DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
  provenance: readonly number[] = [],
): AbstractStream {
  if (value.length > charLimit) {
    return {
      value: unknownStringValue(
        'stream-character-budget',
        [value.slice(0, charLimit)],
      ),
      mayHaveTrailingNewline: true,
      provenance: normalizeProvenance(provenance),
    };
  }
  return {
    value: exactStringValue(value),
    mayHaveTrailingNewline: value.endsWith('\n'),
    provenance: normalizeProvenance(provenance),
  };
}

export function unknownStream(
  reason: string,
  provenance: readonly number[] = [],
): AbstractStream {
  return {
    value: unknownStringValue(reason),
    mayHaveTrailingNewline: true,
    provenance: normalizeProvenance(provenance),
  };
}

export function appendStreams(
  left: AbstractStream,
  right: AbstractStream,
  reason = 'stream-concatenation',
  limit = DEFAULT_ABSTRACT_STREAM_LIMIT,
): AbstractStream {
  const candidates: string[] = [];
  let widened = false;
  for (const leftValue of left.value.values) {
    for (const rightValue of right.value.values) {
      if (candidates.length >= limit) {
        widened = true;
        break;
      }
      const candidate = leftValue + rightValue;
      if (candidate.length > DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT) {
        candidates.push(candidate.slice(0, DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT));
        widened = true;
        break;
      }
      candidates.push(candidate);
    }
    if (widened) break;
  }
  const unknown = widened
    || left.value.kind === 'unknown'
    || right.value.kind === 'unknown';
  return {
    value: {
      kind: unknown ? 'unknown' : 'finite',
      values: normalizeStrings(candidates).slice(0, limit),
      mayBeUnset: left.value.mayBeUnset || right.value.mayBeUnset,
      reasons: normalizeStrings([
        ...left.value.reasons,
        ...right.value.reasons,
        ...(unknown ? [reason] : []),
      ]),
    },
    mayHaveTrailingNewline: widened
      ? true
      : right.value.values.length === 0
        ? left.mayHaveTrailingNewline || right.mayHaveTrailingNewline
        : right.mayHaveTrailingNewline,
    provenance: normalizeProvenance([
      ...left.provenance,
      ...right.provenance,
    ]),
  };
}

export function joinStreams(
  streams: readonly AbstractStream[],
  reason = 'stream-join',
  limit = DEFAULT_ABSTRACT_STREAM_LIMIT,
): AbstractStream {
  if (streams.length === 0) return emptyStream();
  const value = joinStringValues(
    streams.map(stream => stream.value),
    reason,
    limit,
  );
  return {
    value,
    mayHaveTrailingNewline: streams.some(stream => stream.mayHaveTrailingNewline),
    provenance: normalizeProvenance(
      streams.flatMap(stream => stream.provenance),
    ),
  };
}

/** Bash command substitution removes every trailing newline from stdout. */
export function stripTrailingNewlines(stream: AbstractStream): AbstractStream {
  return {
    value: {
      ...stream.value,
      values: normalizeStrings(
        stream.value.values.map(value => value.replace(/\n+$/u, '')),
      ),
    },
    mayHaveTrailingNewline: false,
    provenance: [...stream.provenance],
  };
}

function normalizeStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function normalizeNumbers(values: Iterable<number>): number[] {
  return [...new Set([...values].map(normalizeStatusCode))].sort((a, b) => a - b);
}

function normalizeProvenance(provenance: readonly number[]): number[] {
  return [...new Set(provenance)]
    .filter(id => Number.isInteger(id) && id >= 0)
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}

function normalizeStatusCode(code: number): number {
  if (!Number.isFinite(code)) return 1;
  return Math.trunc(code) & 0xff;
}
