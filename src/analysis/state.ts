import type { EffectTracker, UncertaintyReason } from './effects.js';
import type { ShellFlags } from '../bash/flags.js';
import {
  mergeEquivalentVariableSnapshotProvenance,
  variableEnvironmentSnapshotKey,
  type VariableEnvironment,
  type VariableEnvironmentSnapshot,
  type VariableProvenanceEvent,
} from '../bash/variables.js';
import type {
  AbstractStatus,
  AbstractStream,
  ControlTransfer,
} from './abstract.js';
import {
  emptyStream,
  joinStreams,
  joinStatuses,
  normalControl,
  successStatus,
} from './abstract.js';
import type { IFS } from './vfs.js';

export const MAX_SHELL_PATHS = 64;

export type AbstractFdTarget =
  | { kind: 'external'; channel: 'stdin' | 'stdout' | 'stderr' }
  | { kind: 'capture' }
  | { kind: 'input'; stream: AbstractStream }
  | { kind: 'file'; path: string; mode: 'read' | 'write' | 'append' | 'read-write' }
  | { kind: 'closed' }
  | { kind: 'unknown'; reason: string };

export interface AbstractIoState {
  fds: Record<string, AbstractFdTarget>;
  capture: AbstractStream;
}

export interface ShellStateSnapshot {
  env: VariableEnvironmentSnapshot;
  flags: ShellFlags;
  cwd: string;
  vfs: IFS | null;
  lastStatus: AbstractStatus;
  control: ControlTransfer;
  io: AbstractIoState;
  pathUncertainty: UncertaintyReason[];
}

export interface AnalysisState {
  env: VariableEnvironment;
  flags: ShellFlags;
  tracker: EffectTracker;
  lastStatus: AbstractStatus;
  control: ControlTransfer;
  io: AbstractIoState;
  nestedDepth: number;
  privileged: boolean;
  runtime: AnalysisRuntime;
}

export interface AnalysisRuntime {
  statementCount: number;
  functionDepth: number;
  sourceDepth: number;
  processSubstitutionCount: number;
  loopDepth: number;
  halted: boolean;
  warnings: Set<string>;
  alternatives: ShellStateSnapshot[];
  pathUncertainty: UncertaintyReason[];
  vfsSelectionUncertainty: UncertaintyReason[];
  lastCommandSubstitutionStatus: AbstractStatus | null;
}

export function makeAnalysisState(
  env: VariableEnvironment,
  flags: ShellFlags,
  tracker: EffectTracker,
  nestedDepth = 0,
): AnalysisState {
  env.set_provenance_recorder(event =>
    recordVariableProvenance(tracker, event));
  return {
    env,
    flags,
    tracker,
    lastStatus: successStatus(),
    control: normalControl(),
    io: makeDefaultIoState(),
    nestedDepth,
    privileged: false,
    runtime: {
      statementCount: 0,
      functionDepth: 0,
      sourceDepth: 0,
      processSubstitutionCount: 0,
      loopDepth: 0,
      halted: false,
      warnings: new Set(),
      alternatives: [],
      pathUncertainty: [],
      vfsSelectionUncertainty: [],
      lastCommandSubstitutionStatus: null,
    },
  };
}

function recordVariableProvenance(
  tracker: EffectTracker,
  event: VariableProvenanceEvent,
): number | undefined {
  // `$?` is rebound after every command. Its defining AST node is already a
  // precise origin, so avoid spending a separate graph node until it is read.
  if (event.kind === 'bind'
      && event.name === '?'
      && event.parents.length === 0) {
    return tracker.currentProvenance()[0];
  }
  const subject = event.key === undefined
    ? event.name
    : `${event.name}[${event.key}]`;
  const kind = event.kind === 'state-join'
    ? 'state-join'
    : 'variable-binding';
  const action = event.kind === 'state-join'
    ? 'join'
    : event.kind === 'array-widen'
      ? 'widen'
      : event.kind === 'declare-array'
        ? 'declare'
        : 'bind';
  return tracker.addProvenance({
    kind,
    label: `${action} ${subject}`,
    ...(event.parents.length === 0 ? {} : { parents: event.parents }),
  });
}

export function captureShellState(state: AnalysisState): ShellStateSnapshot {
  return {
    env: state.env.snapshot(),
    flags: { ...state.flags },
    cwd: state.tracker.getCwd(),
    vfs: state.tracker.vfs?.clone() ?? null,
    lastStatus: state.lastStatus,
    control: cloneControl(state.control),
    io: cloneIoState(state.io),
    pathUncertainty: [...state.runtime.pathUncertainty],
  };
}

export function restoreShellState(
  state: AnalysisState,
  snapshot: ShellStateSnapshot,
): void {
  state.env.restore(snapshot.env);
  state.flags = { ...snapshot.flags };
  state.tracker.setCwd(snapshot.cwd);
  state.tracker.setVfs(snapshot.vfs?.clone() ?? null);
  state.lastStatus = snapshot.lastStatus;
  state.control = cloneControl(snapshot.control);
  state.io = cloneIoState(snapshot.io);
  state.runtime.pathUncertainty = [...snapshot.pathUncertainty];
}

/** Consume the current disjunction, or materialize the current concrete path. */
export function takeShellStates(state: AnalysisState): ShellStateSnapshot[] {
  if (state.runtime.alternatives.length === 0) return [captureShellState(state)];
  const alternatives = state.runtime.alternatives;
  state.runtime.alternatives = [];
  return alternatives;
}

/**
 * Install bounded path alternatives and restore a representative only as an
 * implementation cursor. The alternatives remain authoritative.
 */
export function installShellStates(
  state: AnalysisState,
  snapshots: readonly ShellStateSnapshot[],
): AbstractStatus {
  const deduplicated = deduplicateShellStates(snapshots, state.tracker);
  const bounded = deduplicated.length <= MAX_SHELL_PATHS
    ? deduplicated
    : widenShellStateGroups(
      state,
      deduplicated,
    );
  if (bounded.length === 0) {
    const fallback = captureShellState(state);
    restoreShellState(state, fallback);
    state.runtime.alternatives = [];
    return fallback.lastStatus;
  }

  restoreShellState(state, bounded[0]);
  state.runtime.alternatives = bounded.length > 1 ? bounded : [];
  return joinStatuses(bounded.map(snapshot => snapshot.lastStatus));
}

export function appendPathUncertainty(
  snapshot: ShellStateSnapshot,
  reason: UncertaintyReason,
): ShellStateSnapshot {
  return {
    ...snapshot,
    pathUncertainty: [...new Set([...snapshot.pathUncertainty, reason])],
  };
}

/**
 * Once all feasible paths have the same shell state, their old control-flow
 * guards no longer make subsequent commands conditional. Effects already
 * emitted on those paths keep their own uncertainty.
 */
export function collapseEquivalentShellStates(
  snapshots: readonly ShellStateSnapshot[],
  retainedUncertainty: readonly UncertaintyReason[],
  tracker?: EffectTracker,
): ShellStateSnapshot[] {
  if (snapshots.length < 2) return [...snapshots];
  const normalized = snapshots.map(snapshot => ({
    ...snapshot,
    pathUncertainty: [...retainedUncertainty],
  }));
  const deduplicated = deduplicateShellStates(normalized, tracker);
  return deduplicated.length === 1 ? deduplicated : [...snapshots];
}

function deduplicateShellStates(
  snapshots: readonly ShellStateSnapshot[],
  tracker?: EffectTracker,
): ShellStateSnapshot[] {
  const grouped = new Map<string, ShellStateSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = shellStateKey(snapshot);
    const group = grouped.get(key);
    if (group) group.push(snapshot);
    else grouped.set(key, [snapshot]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      if (group.length === 1) return group[0];
      return {
        ...group[0],
        env: mergeEquivalentVariableSnapshotProvenance(
          group.map(snapshot => snapshot.env),
          tracker
            ? (name, parents) => tracker.addProvenance({
              kind: 'state-join',
              label: `join equivalent ${name} bindings`,
              ...(parents.length === 0 ? {} : { parents }),
            })
            : undefined,
        ),
        io: joinIoStates(group.map(snapshot => snapshot.io)),
      };
    });
}

function widenShellStateGroups(
  state: AnalysisState,
  snapshots: readonly ShellStateSnapshot[],
): ShellStateSnapshot[] {
  const groups = new Map<string, ShellStateSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = controlWideningKey(snapshot.control);
    const group = groups.get(key);
    if (group) group.push(snapshot);
    else groups.set(key, [snapshot]);
  }
  const widened = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => widenShellStates(state, group));
  if (!state.runtime.warnings.has('shell-path-budget')) {
    state.runtime.warnings.add('shell-path-budget');
    state.tracker.addWarning(
      `Bash branch state widened after ${MAX_SHELL_PATHS} alternatives`,
    );
  }
  return widened;
}

function widenShellStates(
  state: AnalysisState,
  snapshots: readonly ShellStateSnapshot[],
): ShellStateSnapshot {
  state.env.restore_widened(snapshots.map(snapshot => snapshot.env));
  const cwd = snapshots.every(snapshot => snapshot.cwd === snapshots[0].cwd)
    ? snapshots[0].cwd
    : '/<unknown-cwd>';
  state.tracker.setCwd(cwd);
  if (cwd !== snapshots[0].cwd) {
    state.env.bind_variable('PWD', cwd, 0, true);
  }

  const flags = { ...snapshots[0].flags };
  for (const key of Object.keys(flags) as Array<keyof ShellFlags>) {
    if (snapshots.some(snapshot => snapshot.flags[key] !== flags[key])) {
      // Expanding a glob without a VFS yields an explicit unknown target;
      // leaving noglob enabled could instead hide the filesystem selection.
      flags[key] = key === 'noglob' ? false : flags[key];
    }
  }
  state.flags = flags;

  const vfsKey = snapshots[0].vfs?.stateKey() ?? 'none';
  const vfs = snapshots.every(snapshot => (snapshot.vfs?.stateKey() ?? 'none') === vfsKey)
    ? snapshots[0].vfs?.clone() ?? null
    : null;
  state.tracker.setVfs(vfs);

  const status = joinStatuses(snapshots.map(snapshot => snapshot.lastStatus));
  state.lastStatus = status;
  state.control = joinControls(snapshots.map(snapshot => snapshot.control));
  state.io = joinIoStates(snapshots.map(snapshot => snapshot.io));
  state.runtime.pathUncertainty = [
    ...new Set([
      ...snapshots.flatMap(snapshot => snapshot.pathUncertainty),
      'state-widening' as const,
    ]),
  ];
  return captureShellState(state);
}

function shellStateKey(snapshot: ShellStateSnapshot): string {
  return JSON.stringify({
    env: variableEnvironmentSnapshotKey(snapshot.env),
    flags: snapshot.flags,
    cwd: snapshot.cwd,
    vfs: snapshot.vfs?.stateKey() ?? null,
    status: snapshot.lastStatus,
    control: snapshot.control,
    io: ioStateKey(snapshot.io),
    uncertainty: [...snapshot.pathUncertainty].sort(),
  });
}

function controlWideningKey(control: ControlTransfer): string {
  if (control.kind === 'break' || control.kind === 'continue') {
    return `${control.kind}:${control.levels}`;
  }
  return control.kind;
}

function joinControls(controls: readonly ControlTransfer[]): ControlTransfer {
  const first = controls[0] ?? normalControl();
  if (first.kind === 'return' || first.kind === 'exit') {
    return {
      kind: first.kind,
      status: joinStatuses(controls
        .filter((control): control is Extract<ControlTransfer, { kind: 'return' | 'exit' }> =>
          control.kind === first.kind)
        .map(control => control.status)),
    };
  }
  return cloneControl(first);
}

function cloneControl(control: ControlTransfer): ControlTransfer {
  if (control.kind === 'return' || control.kind === 'exit') {
    return { kind: control.kind, status: control.status };
  }
  if (control.kind === 'break' || control.kind === 'continue') {
    return { kind: control.kind, levels: control.levels };
  }
  return { kind: control.kind };
}

export function makeDefaultIoState(): AbstractIoState {
  return {
    fds: {
      0: { kind: 'external', channel: 'stdin' },
      1: { kind: 'external', channel: 'stdout' },
      2: { kind: 'external', channel: 'stderr' },
    },
    capture: emptyStream(),
  };
}

export function cloneIoState(io: AbstractIoState): AbstractIoState {
  return {
    fds: Object.fromEntries(
      Object.entries(io.fds).map(([fd, target]) => [fd, cloneFdTarget(target)]),
    ),
    capture: cloneStream(io.capture),
  };
}

function joinIoStates(states: readonly AbstractIoState[]): AbstractIoState {
  if (states.length === 0) return makeDefaultIoState();
  const fds: Record<string, AbstractFdTarget> = {};
  const fdKeys = new Set(states.flatMap(state => Object.keys(state.fds)));
  for (const fd of [...fdKeys].sort((left, right) => Number(left) - Number(right))) {
    fds[fd] = joinFdTargets(states.map(state =>
      state.fds[fd] ?? { kind: 'closed' }));
  }
  return {
    fds,
    capture: joinStreams(states.map(state => state.capture), 'stream-state-widening'),
  };
}

function joinFdTargets(targets: readonly AbstractFdTarget[]): AbstractFdTarget {
  const first = targets[0] ?? { kind: 'closed' };
  if (targets.every(target => fdTargetKey(target) === fdTargetKey(first))) {
    if (first.kind === 'input') {
      return {
        kind: 'input',
        stream: joinStreams(
          targets
            .filter((target): target is Extract<AbstractFdTarget, { kind: 'input' }> =>
              target.kind === 'input')
            .map(target => target.stream),
          'fd-input-provenance-join',
        ),
      };
    }
    return cloneFdTarget(first);
  }
  if (targets.every((target): target is Extract<AbstractFdTarget, { kind: 'input' }> =>
    target.kind === 'input')) {
    return {
      kind: 'input',
      stream: joinStreams(targets.map(target => target.stream), 'fd-input-join'),
    };
  }
  return { kind: 'unknown', reason: 'fd-state-join' };
}

export function cloneFdTarget(target: AbstractFdTarget): AbstractFdTarget {
  if (target.kind === 'input') {
    return { kind: target.kind, stream: cloneStream(target.stream) };
  }
  return { ...target };
}

function cloneStream(stream: AbstractStream): AbstractStream {
  return {
    value: {
      ...stream.value,
      values: [...stream.value.values],
      reasons: [...stream.value.reasons],
    },
    mayHaveTrailingNewline: stream.mayHaveTrailingNewline,
    provenance: [...stream.provenance],
  };
}

function fdTargetKey(target: AbstractFdTarget): string {
  if (target.kind !== 'input') return JSON.stringify(target);
  return JSON.stringify({
    kind: target.kind,
    stream: streamStateKey(target.stream),
  });
}

function ioStateKey(io: AbstractIoState): object {
  return {
    fds: Object.fromEntries(
      Object.entries(io.fds).map(([fd, target]) => [
        fd,
        target.kind === 'input'
          ? { kind: target.kind, stream: streamStateKey(target.stream) }
          : target,
      ]),
    ),
    capture: streamStateKey(io.capture),
  };
}

function streamStateKey(stream: AbstractStream): object {
  return {
    value: stream.value,
    mayHaveTrailingNewline: stream.mayHaveTrailingNewline,
  };
}
