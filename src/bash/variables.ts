// variables.ts — Shell variable environment and scoping

import type { Command } from './command.js';
import { toPosix } from '../analysis/vfs.js';
import { MAX_PROVENANCE_PARENTS } from '../analysis/provenance.js';

// ── Variable attribute flags ──

export const att_exported  = 0x0001;
export const att_readonly  = 0x0002;
export const att_array     = 0x0004;
export const att_function  = 0x0008;
export const att_integer   = 0x0010;
export const att_local     = 0x0020;
export const att_assoc     = 0x0040;
export const att_trace     = 0x0080;
export const att_uppercase = 0x0100;
export const att_lowercase = 0x0200;
export const att_nameref   = 0x0800;

export const MAX_ARRAY_ELEMENTS = 128;
export const MAX_ARRAY_KEY_CHARS = 4096;
export const MAX_ARRAY_VALUE_CHARS = 16 * 1024;

export type ShellArrayKind = 'indexed' | 'associative';

export interface ShellArrayElement {
  value: string;
  uncertain: boolean;
  /** Analysis-local roots explaining the element's current value. */
  provenance?: number[];
}

export interface ShellArrayValue {
  kind: ShellArrayKind;
  entries: Map<string, ShellArrayElement>;
  unknownKeys: boolean;
}

// ── VarContext flags ──

export const VC_HASLOCAL = 0x01;
export const VC_FUNCENV  = 0x04;

export interface ShellVar {
  name: string;
  value: string;
  uncertain: boolean;
  attributes: number;
  context: number;       // scope level where defined
  array?: ShellArrayValue;
  /** Analysis-local roots explaining scalar or array-wide state. */
  provenance?: number[];
}

export interface VariableProvenanceEvent {
  kind:
    | 'bind'
    | 'array-bind'
    | 'array-widen'
    | 'declare-array'
    | 'local-bind'
    | 'state-join';
  name: string;
  key?: string;
  parents: readonly number[];
}

export type VariableProvenanceRecorder = (
  event: VariableProvenanceEvent,
) => number | undefined;

export interface FunctionDef {
  name: string;
  body: Command;
}

export interface VarContext {
  name: string;          // function name or '' for global
  scope: number;         // 0 = global
  flags: number;
  up: VarContext | null;
  table: Map<string, ShellVar>;
}

export class VariableEnvironment {
  global_context: VarContext;
  private current_context: VarContext;
  private scope_counter: number = 0;
  private provenanceRecorder?: VariableProvenanceRecorder;
  functions: Map<string, FunctionDef> = new Map();

  constructor(env?: Record<string, string>, inheritProcessEnv: boolean = true) {
    this.global_context = {
      name: '',
      scope: 0,
      flags: 0,
      up: null,
      table: new Map(),
    };
    this.current_context = this.global_context;

    // Shell-internal defaults (not from system env)
    const shellDefaults: Record<string, string> = {
      IFS: ' \t\n',
    };
    for (const [k, v] of Object.entries(shellDefaults)) {
      this.global_context.table.set(k, { name: k, value: v, uncertain: false, attributes: 0, context: 0 });
    }

    // Inherit system environment; path-like vars get toPosix for Windows compat
    const pathVars = new Set([
      'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
      'PWD', 'OLDPWD', 'TMPDIR', 'TEMP', 'TMP', 'SHELL',
    ]);
    if (inheritProcessEnv) {
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        const val = pathVars.has(k) ? toPosix(v) : v;
        this.global_context.table.set(k, { name: k, value: val, uncertain: false, attributes: 0, context: 0 });
      }
    }

    // Merge caller-provided env (overrides system + defaults)
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        this.global_context.table.set(k, { name: k, value: v, uncertain: false, attributes: 0, context: 0 });
      }
    }

    // On Windows, HOME may not be set — derive from USERPROFILE
    if (!this.global_context.table.has('HOME')) {
      const up = this.global_context.table.get('USERPROFILE')?.value;
      const hd = this.global_context.table.get('HOMEDRIVE')?.value;
      const hp = this.global_context.table.get('HOMEPATH')?.value;
      let home: string | undefined;
      if (up) home = toPosix(up);
      else if (hd && hp) home = toPosix(hd + hp);
      if (home) {
        this.global_context.table.set('HOME', {
          name: 'HOME',
          value: home,
          uncertain: false,
          attributes: 0,
          context: 0,
        });
      }
    }

  }

  get context(): VarContext {
    return this.current_context;
  }

  set_provenance_recorder(
    recorder: VariableProvenanceRecorder | undefined,
  ): void {
    this.provenanceRecorder = recorder;
  }

  snapshot(): VariableEnvironmentSnapshot {
    return {
      current: cloneContext(this.current_context),
      scopeCounter: this.scope_counter,
      functions: new Map(this.functions),
    };
  }

  restore(snapshot: VariableEnvironmentSnapshot): void {
    const contexts = new Map<number, VarContext>();
    this.current_context = restoreContextChain(snapshot.current, contexts);
    this.global_context = rootContext(this.current_context);
    this.scope_counter = snapshot.scopeCounter;
    this.functions = new Map(snapshot.functions);
  }

  /**
   * Restore a sound summary when the path budget cannot retain every branch.
   * Equal bindings remain exact; differing or absent bindings become explicit
   * uncertain placeholders rather than an arbitrary branch representative.
   */
  restore_widened(snapshots: readonly VariableEnvironmentSnapshot[]): void {
    if (snapshots.length === 0) return;
    this.restore(snapshots[0]);

    const views = snapshots.map(visibleSnapshotVariables);
    const names = new Set(views.flatMap(view => [...view.keys()]));
    for (const name of [...names].sort()) {
      const values = views.map(view => view.get(name));
      if (values.every(value => sameShellVariable(value, values[0]))) {
        const current = this.find_variable(name);
        if (current) {
          const provenance = variableProvenance(values);
          current.provenance = provenance.length === 0
            ? []
            : this.recordProvenance(
              'state-join',
              name,
              provenance,
            );
        }
        continue;
      }
      this.remove_all_bindings(name);
      const joined = joinShellVariables(name, values, this.current_context.scope);
      joined.provenance = this.recordProvenance(
        'state-join',
        name,
        variableProvenance(values),
      );
      this.current_context.table.set(name, joined);
    }

    const functionNames = new Set(snapshots.flatMap(snapshot => [...snapshot.functions.keys()]));
    for (const name of functionNames) {
      const definitions = snapshots.map(snapshot => snapshot.functions.get(name));
      const first = definitions[0];
      if (!first || definitions.some(definition => definition?.body !== first.body)) {
        this.functions.delete(name);
      }
    }
  }

  /** Reset variables before modeling a child launched with an empty environment. */
  reset_for_child_environment(): void {
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      ctx.table.clear();
      ctx = ctx.up;
    }
    this.global_context.table.set('IFS', {
      name: 'IFS',
      value: ' \t\n',
      uncertain: false,
      attributes: 0,
      context: 0,
    });
  }

  /** Return the currently visible scalar values, with inner scopes winning. */
  to_record(): Record<string, string> {
    const chain: VarContext[] = [];
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      chain.unshift(ctx);
      ctx = ctx.up;
    }
    const values = Object.create(null) as Record<string, string>;
    for (const item of chain) {
      for (const [name, variable] of item.table) values[name] = variable.value;
    }
    return values;
  }

  /** Replace inherited positional parameters before analyzing a child shell. */
  reset_positional_params(args: string[]): void {
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      for (const name of [...ctx.table.keys()]) {
        if (name === '#' || name === '@' || name === '*' || /^[0-9]+$/u.test(name)) ctx.table.delete(name);
      }
      ctx = ctx.up;
    }
    this.set_positional_params(args);
  }

  /** Save caller parameters before a source builtin installs temporary args. */
  snapshot_source_positional_params(replacementCount: number): VariableSnapshot {
    const names = new Set(['#', '@', '*']);
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      for (const name of ctx.table.keys()) {
        if (/^[1-9][0-9]*$/u.test(name)) names.add(name);
      }
      ctx = ctx.up;
    }
    for (let index = 1; index <= replacementCount; index++) {
      names.add(String(index));
    }
    return this.snapshot_variables([...names]);
  }

  /** Source arguments replace $1... while preserving the caller's $0. */
  set_source_positional_params(args: string[]): void {
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      for (const name of [...ctx.table.keys()]) {
        if (name === '#' || name === '@' || name === '*'
            || /^[1-9][0-9]*$/u.test(name)) {
          ctx.table.delete(name);
        }
      }
      ctx = ctx.up;
    }
    this.set_positional_params(args);
  }

  snapshot_variables(names: string[]): VariableSnapshot {
    const entries = new Map<string, ShellVar | null>();
    for (const name of names) {
      const v = this.find_variable(name);
      entries.set(name, v ? cloneShellVariable(v) : null);
    }
    return { entries };
  }

  restore_variables(snapshot: VariableSnapshot): void {
    for (const [name, saved] of snapshot.entries) {
      if (saved) {
        const current = this.find_variable(name);
        if (current) {
          current.value = saved.value;
          current.uncertain = saved.uncertain;
          current.attributes = saved.attributes;
          current.context = saved.context;
          current.array = saved.array ? cloneShellArray(saved.array) : undefined;
          current.provenance = cloneProvenance(saved.provenance);
        } else {
          this.global_context.table.set(name, cloneShellVariable(saved));
        }
      } else {
        this.unbind_variable(name);
      }
    }
  }

  /** Find a variable by name, walking the context chain upward */
  find_variable(name: string): ShellVar | undefined {
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      const v = ctx.table.get(name);
      if (v) return v;
      ctx = ctx.up;
    }
    return undefined;
  }

  get_array_kind(name: string): ShellArrayKind | undefined {
    return this.find_variable(name)?.array?.kind;
  }

  declare_array(
    name: string,
    kind: ShellArrayKind,
    local = false,
    provenance: readonly number[] = [],
  ): ShellVar {
    let variable = local
      ? this.current_context.table.get(name)
      : this.find_variable(name);
    if (!variable) {
      variable = {
        name,
        value: '',
        uncertain: false,
        attributes: arrayKindAttribute(kind) | (local ? att_local : 0),
        context: this.current_context.scope,
        array: emptyShellArray(kind),
        provenance: this.recordProvenance(
          'declare-array',
          name,
          provenance,
        ),
      };
      this.current_context.table.set(name, variable);
      if (local) this.current_context.flags |= VC_HASLOCAL;
      return variable;
    }
    if (variable.attributes & att_readonly) return variable;
    if (variable.array) {
      if (variable.array.kind !== kind) {
        variable.uncertain = true;
        variable.array.unknownKeys = true;
      }
      return variable;
    }

    const existing = boundedArrayElement(
      name,
      '0',
      variable.value,
      variable.uncertain,
      variable.provenance,
    );
    variable.array = emptyShellArray(kind);
    variable.array.entries.set('0', existing);
    variable.attributes &= ~(att_array | att_assoc);
    variable.attributes |= arrayKindAttribute(kind);
    if (local) variable.attributes |= att_local;
    variable.provenance = this.recordProvenance(
      'declare-array',
      name,
      [
        ...(variable.provenance ?? []),
        ...provenance,
      ],
    );
    return variable;
  }

  bind_array_element(
    name: string,
    key: string,
    value: string,
    uncertain = false,
    kind: ShellArrayKind = 'indexed',
    provenance: readonly number[] = [],
  ): ShellVar {
    let variable = this.find_variable(name)
      ?? this.declare_array(name, kind, false, provenance);
    if (variable.attributes & att_readonly) return variable;
    if (!variable.array) {
      variable = this.declare_array(name, kind, false, provenance);
    }
    if (!variable.array) return variable;
    const array = variable.array;
    if (array.kind !== kind || key.length > MAX_ARRAY_KEY_CHARS) {
      variable.uncertain = true;
      array.unknownKeys = true;
      variable.provenance = this.recordProvenance(
        'array-widen',
        name,
        [...(variable.provenance ?? []), ...provenance],
        key,
      );
      return variable;
    }
    if (!array.entries.has(key) && array.entries.size >= MAX_ARRAY_ELEMENTS) {
      variable.uncertain = true;
      array.unknownKeys = true;
      variable.provenance = this.recordProvenance(
        'array-widen',
        name,
        [...(variable.provenance ?? []), ...provenance],
        key,
      );
      return variable;
    }
    const binding = this.recordProvenance(
      'array-bind',
      name,
      provenance,
      key,
    );
    array.entries.set(
      key,
      boundedArrayElement(name, key, value, uncertain, binding),
    );
    refreshArrayScalarValue(variable);
    return variable;
  }

  widen_array(
    name: string,
    kind: ShellArrayKind = 'indexed',
    provenance: readonly number[] = [],
  ): ShellVar {
    let variable = this.find_variable(name)
      ?? this.declare_array(name, kind, false, provenance);
    if (variable.attributes & att_readonly) return variable;
    if (!variable.array) {
      variable = this.declare_array(name, kind, false, provenance);
    }
    if (!variable.array) return variable;
    variable.uncertain = true;
    variable.array.unknownKeys = true;
    variable.provenance = this.recordProvenance(
      'array-widen',
      name,
      [...(variable.provenance ?? []), ...provenance],
    );
    return variable;
  }

  get_array_element(
    name: string,
    key: string,
  ): {
    value: string | undefined;
    uncertain: boolean;
    provenance: number[];
  } {
    const variable = this.find_variable(name);
    if (!variable) {
      return { value: undefined, uncertain: false, provenance: [] };
    }
    if (!variable.array) {
      return key === '0'
        ? {
          value: variable.value,
          uncertain: variable.uncertain,
          provenance: cloneProvenance(variable.provenance),
        }
        : {
          value: undefined,
          uncertain: variable.uncertain,
          provenance: cloneProvenance(variable.provenance),
        };
    }
    if (variable.array.unknownKeys) {
      return {
        value: `<unknown:${name}[${key}]>`,
        uncertain: true,
        provenance: cloneProvenance(variable.provenance),
      };
    }
    const element = variable.array.entries.get(key);
    return {
      value: element?.value,
      uncertain: variable.uncertain
        || variable.array.unknownKeys
        || element?.uncertain === true,
      provenance: normalizeProvenance([
        ...(variable.provenance ?? []),
        ...(element?.provenance ?? []),
      ]),
    };
  }

  get_array_values(
    name: string,
  ): {
    values: ShellArrayElement[];
    uncertain: boolean;
    provenance: number[];
  } {
    const variable = this.find_variable(name);
    if (!variable) {
      return { values: [], uncertain: false, provenance: [] };
    }
    if (!variable.array) {
      return {
        values: [{
          value: variable.value,
          uncertain: variable.uncertain,
          provenance: cloneProvenance(variable.provenance),
        }],
        uncertain: variable.uncertain,
        provenance: cloneProvenance(variable.provenance),
      };
    }
    const array = variable.array;
    const values = sortedArrayEntries(array)
      .map(([, element]) => ({
        value: element.value,
        uncertain: variable.uncertain
          || array.unknownKeys
          || element.uncertain,
        provenance: normalizeProvenance([
          ...(variable.provenance ?? []),
          ...(element.provenance ?? []),
        ]),
      }));
    return {
      values,
      uncertain: variable.uncertain || array.unknownKeys,
      provenance: normalizeProvenance([
        ...(variable.provenance ?? []),
        ...values.flatMap(element => element.provenance ?? []),
      ]),
    };
  }

  get_array_max_index(name: string): bigint | null {
    const array = this.find_variable(name)?.array;
    if (!array || array.kind !== 'indexed' || array.entries.size === 0) return null;
    let maximum: bigint | null = null;
    for (const key of array.entries.keys()) {
      if (!/^[0-9]+$/u.test(key)) continue;
      const index = BigInt(key);
      if (maximum === null || index > maximum) maximum = index;
    }
    return maximum;
  }

  /** Get variable value or undefined */
  get_string_value(name: string): string | undefined {
    const variable = this.find_variable(name);
    if (!variable) return undefined;
    return variable.array
      ? variable.array.entries.get('0')?.value
      : variable.value;
  }

  get_value_provenance(name: string): number[] {
    const variable = this.find_variable(name);
    if (!variable) return [];
    if (!variable.array) return cloneProvenance(variable.provenance);
    return normalizeProvenance([
      ...(variable.provenance ?? []),
      ...(variable.array.entries.get('0')?.provenance ?? []),
    ]);
  }

  get_array_provenance(name: string): number[] {
    const variable = this.find_variable(name);
    if (!variable) return [];
    return normalizeProvenance([
      ...(variable.provenance ?? []),
      ...[...(variable.array?.entries.values() ?? [])]
        .flatMap(element => element.provenance ?? []),
    ]);
  }

  is_value_uncertain(name: string): boolean {
    const variable = this.find_variable(name);
    if (!variable) return false;
    return variable.uncertain
      || variable.array?.unknownKeys === true
      || variable.array?.entries.get('0')?.uncertain === true;
  }

  /** Bind a variable in the current scope */
  bind_variable(
    name: string,
    value: string,
    attributes: number = 0,
    uncertain = false,
    provenance: readonly number[] = [],
  ): ShellVar {
    // If it already exists in an outer scope and we're at global level, update there
    const existing = this.find_variable(name);
    if (existing?.array && !(existing.attributes & att_readonly)) {
      return this.bind_array_element(
        name,
        '0',
        value,
        uncertain,
        existing.array.kind,
        provenance,
      );
    }
    if (existing && !(existing.attributes & att_readonly)) {
      // If the variable is local in a higher scope, update it in place
      if (existing.attributes & att_local) {
        existing.value = value;
        existing.uncertain = uncertain;
        existing.provenance = this.recordProvenance(
          'bind',
          name,
          provenance,
        );
        return existing;
      }
      // If we're not in a function scope (or var exists in current scope), update in current
      const inCurrent = this.current_context.table.get(name);
      if (inCurrent) {
        if (inCurrent.attributes & att_readonly) {
          // readonly — do not modify
          return inCurrent;
        }
        inCurrent.value = value;
        inCurrent.uncertain = uncertain;
        inCurrent.provenance = this.recordProvenance(
          'bind',
          name,
          provenance,
        );
        return inCurrent;
      }
    }
    const v: ShellVar = {
      name,
      value,
      uncertain,
      attributes,
      context: this.current_context.scope,
      provenance: this.recordProvenance('bind', name, provenance),
    };
    this.current_context.table.set(name, v);
    return v;
  }

  unbind_variable(name: string): void {
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      if (ctx.table.delete(name)) return;
      ctx = ctx.up;
    }
  }

  private remove_all_bindings(name: string): void {
    let ctx: VarContext | null = this.current_context;
    while (ctx) {
      ctx.table.delete(name);
      ctx = ctx.up;
    }
  }

  /** Make a variable local to the current function scope */
  make_local_variable(
    name: string,
    value: string = '',
    uncertain = false,
    provenance: readonly number[] = [],
  ): ShellVar {
    const v: ShellVar = {
      name,
      value,
      uncertain,
      attributes: att_local,
      context: this.current_context.scope,
      provenance: this.recordProvenance(
        'local-bind',
        name,
        provenance,
      ),
    };
    this.current_context.table.set(name, v);
    this.current_context.flags |= VC_HASLOCAL;
    return v;
  }

  /** Push a new variable context for function call */
  push_var_context(funcName: string): VarContext {
    this.scope_counter++;
    const ctx: VarContext = {
      name: funcName,
      scope: this.scope_counter,
      flags: VC_FUNCENV,
      up: this.current_context,
      table: new Map(),
    };
    this.current_context = ctx;
    return ctx;
  }

  /** Pop the current context, restoring the parent */
  pop_var_context(): void {
    if (this.current_context.up) {
      this.current_context = this.current_context.up;
    }
  }

  /** Register a function definition */
  register_function(name: string, body: Command): void {
    this.functions.set(name, { name, body });
  }

  /** Look up a function */
  find_function(name: string): FunctionDef | undefined {
    return this.functions.get(name);
  }

  /** Set positional parameters ($1, $2, ..., $@, $#) */
  set_positional_params(args: string[]): void {
    for (let i = 0; i < args.length; i++) {
      this.bind_variable(String(i + 1), args[i]);
    }
    this.bind_variable('#', String(args.length));
    this.bind_variable('@', args.join(' '));
    this.bind_variable('*', args.join(' '));
  }

  private recordProvenance(
    kind: VariableProvenanceEvent['kind'],
    name: string,
    parents: readonly number[],
    key?: string,
  ): number[] {
    const normalized = normalizeProvenance(parents);
    const id = this.provenanceRecorder?.({
      kind,
      name,
      ...(key === undefined ? {} : { key }),
      parents: normalized,
    });
    return id === undefined ? normalized : [id];
  }
}

export interface VariableEnvironmentSnapshot {
  current: VarContextSnapshot;
  scopeCounter: number;
  functions: Map<string, FunctionDef>;
}

export function mergeEquivalentVariableSnapshotProvenance(
  snapshots: readonly VariableEnvironmentSnapshot[],
  recordJoin?: (name: string, parents: readonly number[]) => number | undefined,
): VariableEnvironmentSnapshot {
  const first = snapshots[0];
  if (!first) {
    throw new Error('cannot merge an empty variable snapshot set');
  }
  const merged: VariableEnvironmentSnapshot = {
    current: cloneContextSnapshot(first.current),
    scopeCounter: first.scopeCounter,
    functions: new Map(first.functions),
  };
  mergeContextProvenance(
    merged.current,
    snapshots.map(snapshot => snapshot.current),
    recordJoin,
  );
  return merged;
}

export function variableEnvironmentSnapshotKey(snapshot: VariableEnvironmentSnapshot): string {
  return JSON.stringify({
    contexts: snapshotContextKey(snapshot.current),
    scopeCounter: snapshot.scopeCounter,
    functions: [...snapshot.functions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => [name, definition.body]),
  });
}

export interface VariableSnapshot {
  entries: Map<string, ShellVar | null>;
}

interface VarContextSnapshot {
  name: string;
  scope: number;
  flags: number;
  up: VarContextSnapshot | null;
  table: Array<[string, ShellVar]>;
}

function cloneContextSnapshot(snapshot: VarContextSnapshot): VarContextSnapshot {
  return {
    name: snapshot.name,
    scope: snapshot.scope,
    flags: snapshot.flags,
    up: snapshot.up ? cloneContextSnapshot(snapshot.up) : null,
    table: snapshot.table.map(([name, variable]) => [
      name,
      cloneShellVariable(variable),
    ]),
  };
}

function mergeContextProvenance(
  target: VarContextSnapshot,
  sources: readonly VarContextSnapshot[],
  recordJoin:
    | ((name: string, parents: readonly number[]) => number | undefined)
    | undefined,
): void {
  const sourceTables = sources.map(source => new Map(source.table));
  for (const [name, variable] of target.table) {
    const candidates = sourceTables.map(table => table.get(name));
    const signatures = candidates.map(variableProvenanceSignature);
    const originsDiffer = signatures.some(signature => signature !== signatures[0]);
    const roots = variableProvenance(candidates);
    const joined = roots.length > 0 && (originsDiffer || sources.length > 1)
      ? recordJoin?.(name, roots)
      : undefined;
    variable.provenance = joined === undefined
      ? roots
      : [joined];
  }
  if (target.up) {
    mergeContextProvenance(
      target.up,
      sources
        .map(source => source.up)
        .filter((source): source is VarContextSnapshot => source !== null),
      recordJoin,
    );
  }
}

function cloneContext(ctx: VarContext): VarContextSnapshot {
  return {
    name: ctx.name,
    scope: ctx.scope,
    flags: ctx.flags,
    up: ctx.up ? cloneContext(ctx.up) : null,
    table: [...ctx.table.entries()].map(([name, value]) => [
      name,
      cloneShellVariable(value),
    ]),
  };
}

function visibleSnapshotVariables(snapshot: VariableEnvironmentSnapshot): Map<string, ShellVar> {
  const chain: VarContextSnapshot[] = [];
  let context: VarContextSnapshot | null = snapshot.current;
  while (context) {
    chain.unshift(context);
    context = context.up;
  }
  const result = new Map<string, ShellVar>();
  for (const item of chain) {
    for (const [name, variable] of item.table) result.set(name, variable);
  }
  return result;
}

function sameShellVariable(
  left: ShellVar | undefined,
  right: ShellVar | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.value === right.value
      && left.uncertain === right.uncertain
      && left.attributes === right.attributes
      && sameShellArray(left.array, right.array);
}

function intersectAttributes(values: readonly (ShellVar | undefined)[]): number {
  let attributes = values[0]?.attributes ?? 0;
  for (const value of values.slice(1)) attributes &= value?.attributes ?? 0;
  return attributes;
}

function snapshotContextKey(snapshot: VarContextSnapshot | null): unknown {
  if (!snapshot) return null;
  return {
    name: snapshot.name,
    scope: snapshot.scope,
    flags: snapshot.flags,
    up: snapshotContextKey(snapshot.up),
    table: [...snapshot.table]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, variable]) => [
        name,
        variable.value,
        variable.uncertain,
        variable.attributes,
        variable.context,
        shellArrayKey(variable.array),
      ]),
  };
}

function restoreContextChain(snapshot: VarContextSnapshot, contexts: Map<number, VarContext>): VarContext {
  const up = snapshot.up ? restoreContextChain(snapshot.up, contexts) : null;
  const ctx: VarContext = {
    name: snapshot.name,
    scope: snapshot.scope,
    flags: snapshot.flags,
    up,
    table: new Map(snapshot.table.map(([name, value]) => [
      name,
      cloneShellVariable(value),
    ])),
  };
  contexts.set(ctx.scope, ctx);
  return ctx;
}

function emptyShellArray(kind: ShellArrayKind): ShellArrayValue {
  return {
    kind,
    entries: new Map(),
    unknownKeys: false,
  };
}

function arrayKindAttribute(kind: ShellArrayKind): number {
  return kind === 'indexed' ? att_array : att_assoc;
}

function cloneShellArray(array: ShellArrayValue): ShellArrayValue {
  return {
    kind: array.kind,
    entries: new Map([...array.entries].map(([key, element]) => [
      key,
      {
        ...element,
        provenance: cloneProvenance(element.provenance),
      },
    ])),
    unknownKeys: array.unknownKeys,
  };
}

function cloneShellVariable(variable: ShellVar): ShellVar {
  return {
    ...variable,
    array: variable.array ? cloneShellArray(variable.array) : undefined,
    provenance: cloneProvenance(variable.provenance),
  };
}

function sortedArrayEntries(
  array: ShellArrayValue,
): Array<[string, ShellArrayElement]> {
  return [...array.entries].sort(([left], [right]) => {
    if (array.kind === 'associative') {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    const leftIndex = BigInt(left);
    const rightIndex = BigInt(right);
    return leftIndex < rightIndex ? -1 : leftIndex > rightIndex ? 1 : 0;
  });
}

function refreshArrayScalarValue(variable: ShellVar): void {
  variable.value = variable.array?.entries.get('0')?.value ?? '';
}

function boundedArrayElement(
  name: string,
  key: string,
  value: string,
  uncertain: boolean,
  provenance: readonly number[] = [],
): ShellArrayElement {
  if (value.length <= MAX_ARRAY_VALUE_CHARS) {
    return {
      value,
      uncertain,
      provenance: normalizeProvenance(provenance),
    };
  }
  return {
    value: `<unknown:${name}[${key}]>`,
    uncertain: true,
    provenance: normalizeProvenance(provenance),
  };
}

function sameShellArray(
  left: ShellArrayValue | undefined,
  right: ShellArrayValue | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind
      || left.unknownKeys !== right.unknownKeys
      || left.entries.size !== right.entries.size) {
    return false;
  }
  for (const [key, element] of left.entries) {
    const candidate = right.entries.get(key);
    if (!candidate
        || candidate.value !== element.value
        || candidate.uncertain !== element.uncertain) {
      return false;
    }
  }
  return true;
}

function shellArrayKey(array: ShellArrayValue | undefined): unknown {
  if (!array) return null;
  return {
    kind: array.kind,
    unknownKeys: array.unknownKeys,
    entries: sortedArrayEntries(array).map(([key, element]) => [
      key,
      element.value,
      element.uncertain,
    ]),
  };
}

function joinShellVariables(
  name: string,
  values: readonly (ShellVar | undefined)[],
  context: number,
): ShellVar {
  const defined = values.filter((value): value is ShellVar => value !== undefined);
  const arrayKind = defined[0]?.array?.kind;
  if (arrayKind && defined.every(value => value.array?.kind === arrayKind)) {
    const keys = new Set<string>();
    let unknownKeys = values.some(value =>
      value === undefined || value.uncertain || value.array?.unknownKeys === true);
    for (const value of defined) {
      const valueArray = value.array;
      if (!valueArray || valueArray.kind !== arrayKind) {
        unknownKeys = true;
        continue;
      }
      for (const key of valueArray.entries.keys()) {
        if (keys.size >= MAX_ARRAY_ELEMENTS && !keys.has(key)) {
          unknownKeys = true;
          continue;
        }
        keys.add(key);
      }
    }

    const array = emptyShellArray(arrayKind);
    array.unknownKeys = unknownKeys;
    for (const key of [...keys].sort()) {
      const elements = values.map(value => value?.array?.entries.get(key));
      const first = elements[0];
      if (first && elements.every(element =>
        element?.value === first.value
        && element.uncertain === first.uncertain)) {
        array.entries.set(key, { ...first });
      } else {
        array.entries.set(key, {
          value: `<unknown:${name}[${key}]>`,
          uncertain: true,
          provenance: normalizeProvenance(
            elements.flatMap(element => element?.provenance ?? []),
          ),
        });
      }
    }

    const result: ShellVar = {
      name,
      value: '',
      uncertain: values.some(value => value === undefined || value.uncertain),
      attributes: intersectAttributes(values) | arrayKindAttribute(arrayKind),
      context,
      array,
      provenance: variableProvenance(values),
    };
    refreshArrayScalarValue(result);
    return result;
  }

  return {
    name,
    value: `<unknown:${name}>`,
    uncertain: true,
    attributes: intersectAttributes(values) & ~(att_array | att_assoc),
    context,
    provenance: variableProvenance(values),
  };
}

function variableProvenance(
  values: readonly (ShellVar | undefined)[],
): number[] {
  return normalizeProvenance(values.flatMap(variable => [
    ...(variable?.provenance ?? []),
    ...[...(variable?.array?.entries.values() ?? [])]
      .flatMap(element => element.provenance ?? []),
  ]));
}

function variableProvenanceSignature(
  variable: ShellVar | undefined,
): string {
  if (!variable) return 'unset';
  return JSON.stringify({
    scalar: normalizeProvenance(variable.provenance ?? []),
    array: variable.array
      ? sortedArrayEntries(variable.array).map(([key, element]) => [
        key,
        normalizeProvenance(element.provenance ?? []),
      ])
      : null,
  });
}

function cloneProvenance(
  provenance: readonly number[] | undefined,
): number[] {
  return normalizeProvenance(provenance ?? []);
}

function normalizeProvenance(provenance: readonly number[]): number[] {
  return [...new Set(provenance)]
    .filter(id => Number.isInteger(id) && id >= 0)
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}

function rootContext(ctx: VarContext): VarContext {
  let current = ctx;
  while (current.up) current = current.up;
  return current;
}
