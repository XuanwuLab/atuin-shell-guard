/**
 * Bounded, deterministic provenance graph for local analyzer diagnostics.
 *
 * Node ids are analysis-local. They are intentionally compact references,
 * not globally unique identifiers, and must never be interpreted without the
 * graph returned by the same analyze() call.
 */

export const MAX_PROVENANCE_NODES = 512;
export const MAX_PROVENANCE_PARENTS = 8;
export const MAX_PROVENANCE_LABEL_CHARS = 240;
export const MAX_RENDERED_PROVENANCE_NODES = 32;

export type ProvenanceKind =
  | 'ast-command'
  | 'expansion'
  | 'variable-binding'
  | 'command-model'
  | 'control-guard'
  | 'state-join'
  | 'stream-flow'
  | 'vfs-transition'
  | 'filesystem-observation'
  | 'budget';

export interface ProvenanceNode {
  id: number;
  kind: ProvenanceKind;
  label: string;
  line?: number;
  parents: number[];
  /** Stable machine-readable cause when the node explains imprecision. */
  reason?: string;
}

export interface ProvenanceGraph {
  nodes: ProvenanceNode[];
  truncated: boolean;
}

export interface ProvenanceNodeInput {
  kind: ProvenanceKind;
  label: string;
  line?: number;
  parents?: readonly number[];
  reason?: string;
}

export class ProvenanceStore {
  private readonly nodes: ProvenanceNode[] = [];
  private readonly nodeIdsByKey = new Map<string, number>();
  private readonly context: number[] = [];
  private budgetNodeId: number | null = null;
  private truncated = false;

  add(input: ProvenanceNodeInput): number {
    if (this.budgetNodeId !== null) {
      this.truncated = true;
      return this.budgetNodeId;
    }
    const parents = this.normalizeParents(
      input.parents ?? this.currentParents(),
    );
    const line = positiveLine(input.line)
      ?? [...parents].reverse()
        .map(parent => this.nodes[parent]?.line)
        .find(parentLine => parentLine !== undefined);
    const normalized: Omit<ProvenanceNode, 'id'> = {
      kind: input.kind,
      label: normalizeLabel(input.label),
      ...(line === undefined ? {} : { line }),
      parents,
      ...(input.reason ? { reason: normalizeLabel(input.reason) } : {}),
    };
    const key = JSON.stringify(normalized);
    const existing = this.nodeIdsByKey.get(key);
    if (existing !== undefined) return existing;

    // Reserve the final slot for one stable truncation witness.
    if (this.nodes.length >= MAX_PROVENANCE_NODES - 1) {
      return this.getBudgetNode(parents);
    }

    const id = this.nodes.length;
    this.nodes.push({ id, ...normalized });
    this.nodeIdsByKey.set(key, id);
    return id;
  }

  withNode<T>(input: ProvenanceNodeInput, run: () => T): T {
    const id = this.add(input);
    this.context.push(id);
    try {
      return run();
    } finally {
      this.context.pop();
    }
  }

  currentParents(): number[] {
    const current = this.context[this.context.length - 1];
    return current === undefined ? [] : [current];
  }

  graph(): ProvenanceGraph {
    return {
      nodes: this.nodes.map(node => ({
        ...node,
        parents: [...node.parents],
      })),
      truncated: this.truncated,
    };
  }

  /** Import another analysis-local graph and return its id remapping. */
  importGraph(graph: ProvenanceGraph): Map<number, number> {
    const remapped = new Map<number, number>();
    for (const node of [...graph.nodes].sort((left, right) => left.id - right.id)) {
      const id = this.add({
        kind: node.kind,
        label: node.label,
        line: node.line,
        parents: node.parents
          .map(parent => remapped.get(parent))
          .filter((parent): parent is number => parent !== undefined),
        reason: node.reason,
      });
      remapped.set(node.id, id);
    }
    this.truncated ||= graph.truncated;
    return remapped;
  }

  /**
   * Bypass explanation nodes whose uncertainty was later proven to be common
   * to every abstract path and removed from an effect.
   */
  withoutReasons(
    roots: readonly number[],
    reasons: ReadonlySet<string>,
  ): number[] {
    const result: number[] = [];
    const pending = [...roots];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.nodes[id];
      if (!node) continue;
      if (node.reason && reasons.has(node.reason)) {
        pending.unshift(...node.parents);
      } else {
        result.push(id);
      }
    }
    return normalizeIds(result, MAX_PROVENANCE_PARENTS);
  }

  private normalizeParents(parents: readonly number[]): number[] {
    return normalizeIds(
      parents.filter(id =>
        Number.isInteger(id) && id >= 0 && id < this.nodes.length),
      MAX_PROVENANCE_PARENTS,
    );
  }

  private getBudgetNode(parents: readonly number[]): number {
    this.truncated = true;
    if (this.budgetNodeId !== null) return this.budgetNodeId;

    const id = this.nodes.length;
    const node: ProvenanceNode = {
      id,
      kind: 'budget',
      label: `provenance truncated after ${MAX_PROVENANCE_NODES} nodes`,
      parents: normalizeIds(parents, MAX_PROVENANCE_PARENTS),
      reason: 'provenance-budget',
    };
    this.nodes.push(node);
    this.nodeIdsByKey.set(JSON.stringify({
      kind: node.kind,
      label: node.label,
      parents: node.parents,
      reason: node.reason,
    }), id);
    this.budgetNodeId = id;
    return id;
  }
}

export function renderProvenance(
  graph: ProvenanceGraph,
  roots: readonly number[],
  maxNodes = MAX_RENDERED_PROVENANCE_NODES,
): string[] {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const pending = normalizeIds(roots, MAX_PROVENANCE_PARENTS)
    .map(id => ({ id, depth: 0 }));
  const visited = new Set<number>();
  const lines: string[] = [];
  let reachedBudget = false;

  while (pending.length > 0 && lines.length < Math.max(0, maxNodes)) {
    const current = pending.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const node = nodeById.get(current.id);
    if (!node) continue;
    reachedBudget ||= node.kind === 'budget';
    const line = node.line === undefined ? '' : ` at line ${node.line}`;
    lines.push(`${'  '.repeat(Math.min(current.depth, 8))}<- ${node.kind}${line}: ${node.label}`);
    pending.unshift(...node.parents.map(id => ({
      id,
      depth: current.depth + 1,
    })));
  }

  if (pending.length > 0 || reachedBudget) {
    lines.push('<- provenance truncated');
  }
  return lines;
}

function normalizeLabel(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim() || '(unspecified)';
  if (normalized.length <= MAX_PROVENANCE_LABEL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PROVENANCE_LABEL_CHARS - 1)}…`;
}

function normalizeIds(ids: readonly number[], limit: number): number[] {
  return [...new Set(ids)].sort((left, right) => left - right).slice(0, limit);
}

function positiveLine(line: number | undefined): number | undefined {
  return line !== undefined && Number.isInteger(line) && line > 0
    ? line
    : undefined;
}
