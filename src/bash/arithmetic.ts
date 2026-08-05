import type { VariableEnvironment, VariableEnvironmentSnapshot } from './variables.js';
import { MAX_PROVENANCE_PARENTS } from '../analysis/provenance.js';

export const MAX_ARITHMETIC_EXPRESSION_CHARS = 16 * 1024;
export const MAX_ARITHMETIC_TOKENS = 2048;
export const MAX_ARITHMETIC_RECURSION = 128;
const MAX_ARITHMETIC_EXPONENT = 128n;

type ArithmeticError = 'syntax' | 'budget' | 'evaluation';

export interface ArithmeticEvaluation {
  value: bigint | null;
  uncertain: boolean;
  error?: ArithmeticError;
  /** Bounded roots for scalar bindings read while evaluating the expression. */
  provenance: number[];
}

type ArithmeticNode =
  | { kind: 'literal'; value: bigint }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: '+' | '-' | '!' | '~'; operand: ArithmeticNode }
  | { kind: 'update'; operator: '++' | '--'; name: string; prefix: boolean }
  | { kind: 'binary'; operator: BinaryOperator; left: ArithmeticNode; right: ArithmeticNode }
  | {
    kind: 'conditional';
    test: ArithmeticNode;
    consequent: ArithmeticNode;
    alternate: ArithmeticNode;
  }
  | {
    kind: 'assignment';
    operator: AssignmentOperator;
    name: string;
    value: ArithmeticNode;
  }
  | { kind: 'comma'; left: ArithmeticNode; right: ArithmeticNode };

type BinaryOperator =
  | '**'
  | '*' | '/' | '%'
  | '+' | '-'
  | '<<' | '>>'
  | '<' | '<=' | '>' | '>='
  | '==' | '!='
  | '&' | '^' | '|'
  | '&&' | '||';

type AssignmentOperator =
  | '='
  | '*=' | '/=' | '%='
  | '+=' | '-='
  | '<<=' | '>>='
  | '&=' | '^=' | '|=';

interface ArithmeticToken {
  kind: 'number' | 'name' | 'operator' | 'eof';
  text: string;
}

interface ArithmeticValue {
  exact: boolean;
  value: bigint;
  provenance: number[];
}

interface ArithmeticRuntime {
  remainingChars: number;
  remainingTokens: number;
  variableStack: Set<string>;
  readProvenance: number[];
}

/**
 * Evaluate the deterministic scalar subset of Bash arithmetic.
 *
 * The evaluator mutates scalar variables for assignments and updates. When a
 * value or control decision is unknown, feasible arithmetic branches are
 * joined through VariableEnvironment rather than selecting one path.
 */
export function evaluateArithmeticExpression(
  expression: string,
  env: VariableEnvironment,
): ArithmeticEvaluation {
  if (expression.trim().length === 0) {
    return { value: 0n, uncertain: false, provenance: [] };
  }
  const runtime: ArithmeticRuntime = {
    remainingChars: MAX_ARITHMETIC_EXPRESSION_CHARS,
    remainingTokens: MAX_ARITHMETIC_TOKENS,
    variableStack: new Set(),
    readProvenance: [],
  };

  let ast: ArithmeticNode;
  try {
    ast = parseArithmeticSource(expression, runtime);
  } catch (error: unknown) {
    widenPotentialArithmeticWrites(expression, env, runtime.readProvenance);
    return {
      value: null,
      uncertain: true,
      error: error instanceof ArithmeticBudgetError ? 'budget' : 'syntax',
      provenance: runtime.readProvenance,
    };
  }

  try {
    const result = evaluateArithmeticNode(ast, env, runtime, 0);
    const provenance = normalizeArithmeticProvenance([
      ...result.provenance,
      ...runtime.readProvenance,
    ]);
    return result.exact
      ? {
        value: result.value,
        uncertain: false,
        provenance,
      }
      : {
        value: null,
        uncertain: true,
        error: 'evaluation',
        provenance,
      };
  } catch (error: unknown) {
    widenPotentialArithmeticWrites(expression, env, runtime.readProvenance);
    return {
      value: null,
      uncertain: true,
      error: error instanceof ArithmeticBudgetError ? 'budget' : 'evaluation',
      provenance: runtime.readProvenance,
    };
  }
}

class ArithmeticBudgetError extends Error {}

class ArithmeticParser {
  private position = 0;
  private recursion = 0;

  constructor(private readonly tokens: ArithmeticToken[]) {}

  parse(): ArithmeticNode {
    const result = this.withDepth(() => this.parseComma());
    if (this.peek().kind !== 'eof') {
      throw new Error(`unexpected arithmetic token ${this.peek().text}`);
    }
    return result;
  }

  private parseComma(): ArithmeticNode {
    let node = this.parseAssignment();
    while (this.consume(',')) {
      node = { kind: 'comma', left: node, right: this.parseAssignment() };
    }
    return node;
  }

  private parseAssignment(): ArithmeticNode {
    const left = this.parseConditional();
    const operator = this.peek().text as AssignmentOperator;
    if (!ASSIGNMENT_OPERATORS.has(operator)) return left;
    this.next();
    if (left.kind !== 'variable') {
      throw new Error('arithmetic assignment requires a scalar variable');
    }
    return {
      kind: 'assignment',
      operator,
      name: left.name,
      value: this.withDepth(() => this.parseAssignment()),
    };
  }

  private parseConditional(): ArithmeticNode {
    const test = this.parseLogicalOr();
    if (!this.consume('?')) return test;
    const consequent = this.withDepth(() => this.parseComma());
    this.expect(':');
    const alternate = this.withDepth(() => this.parseAssignment());
    return { kind: 'conditional', test, consequent, alternate };
  }

  private parseLogicalOr(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseLogicalAnd(),
      new Set<BinaryOperator>(['||']),
    );
  }

  private parseLogicalAnd(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseBitwiseOr(),
      new Set<BinaryOperator>(['&&']),
    );
  }

  private parseBitwiseOr(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseBitwiseXor(),
      new Set<BinaryOperator>(['|']),
    );
  }

  private parseBitwiseXor(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseBitwiseAnd(),
      new Set<BinaryOperator>(['^']),
    );
  }

  private parseBitwiseAnd(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseEquality(),
      new Set<BinaryOperator>(['&']),
    );
  }

  private parseEquality(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseRelational(),
      new Set<BinaryOperator>(['==', '!=']),
    );
  }

  private parseRelational(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseShift(),
      new Set<BinaryOperator>(['<', '<=', '>', '>=']),
    );
  }

  private parseShift(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseAdditive(),
      new Set<BinaryOperator>(['<<', '>>']),
    );
  }

  private parseAdditive(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parseMultiplicative(),
      new Set<BinaryOperator>(['+', '-']),
    );
  }

  private parseMultiplicative(): ArithmeticNode {
    return this.parseLeftAssociative(
      () => this.parsePower(),
      new Set<BinaryOperator>(['*', '/', '%']),
    );
  }

  private parsePower(): ArithmeticNode {
    const left = this.parseUnary();
    if (!this.consume('**')) return left;
    return {
      kind: 'binary',
      operator: '**',
      left,
      right: this.withDepth(() => this.parsePower()),
    };
  }

  private parseUnary(): ArithmeticNode {
    const operator = this.peek().text;
    if (operator === '++' || operator === '--') {
      this.next();
      const operand = this.withDepth(() => this.parseUnary());
      if (operand.kind !== 'variable') {
        throw new Error('arithmetic update requires a scalar variable');
      }
      return { kind: 'update', operator, name: operand.name, prefix: true };
    }
    if (operator === '+' || operator === '-' || operator === '!' || operator === '~') {
      this.next();
      return {
        kind: 'unary',
        operator,
        operand: this.withDepth(() => this.parseUnary()),
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ArithmeticNode {
    const operand = this.parsePrimary();
    const operator = this.peek().text;
    if (operator !== '++' && operator !== '--') return operand;
    this.next();
    if (operand.kind !== 'variable') {
      throw new Error('arithmetic update requires a scalar variable');
    }
    return { kind: 'update', operator, name: operand.name, prefix: false };
  }

  private parsePrimary(): ArithmeticNode {
    const token = this.next();
    if (token.kind === 'number') {
      const value = parseArithmeticInteger(token.text);
      if (value === null) throw new Error('unsupported arithmetic integer');
      return { kind: 'literal', value };
    }
    if (token.kind === 'name') return { kind: 'variable', name: token.text };
    if (token.text === '(') {
      const node = this.withDepth(() => this.parseComma());
      this.expect(')');
      return node;
    }
    throw new Error(`expected arithmetic operand, got ${token.text}`);
  }

  private parseLeftAssociative(
    parseOperand: () => ArithmeticNode,
    operators: ReadonlySet<BinaryOperator>,
  ): ArithmeticNode {
    let node = parseOperand();
    while (operators.has(this.peek().text as BinaryOperator)) {
      const operator = this.next().text as BinaryOperator;
      node = {
        kind: 'binary',
        operator,
        left: node,
        right: this.withDepth(parseOperand),
      };
    }
    return node;
  }

  private withDepth<T>(fn: () => T): T {
    this.recursion++;
    if (this.recursion > MAX_ARITHMETIC_RECURSION) {
      this.recursion--;
      throw new ArithmeticBudgetError('arithmetic recursion budget exhausted');
    }
    try {
      return fn();
    } finally {
      this.recursion--;
    }
  }

  private peek(): ArithmeticToken {
    return this.tokens[this.position] ?? { kind: 'eof', text: '' };
  }

  private next(): ArithmeticToken {
    const token = this.peek();
    if (token.kind !== 'eof') this.position++;
    return token;
  }

  private consume(operator: string): boolean {
    if (this.peek().text !== operator) return false;
    this.next();
    return true;
  }

  private expect(operator: string): void {
    if (!this.consume(operator)) {
      throw new Error(`expected arithmetic operator ${operator}`);
    }
  }
}

const ASSIGNMENT_OPERATORS = new Set<AssignmentOperator>([
  '=',
  '*=', '/=', '%=',
  '+=', '-=',
  '<<=', '>>=',
  '&=', '^=', '|=',
]);

function parseArithmeticSource(
  expression: string,
  runtime: ArithmeticRuntime,
): ArithmeticNode {
  if (expression.length > runtime.remainingChars) {
    throw new ArithmeticBudgetError('arithmetic source budget exhausted');
  }
  runtime.remainingChars -= expression.length;
  return new ArithmeticParser(tokenizeArithmetic(expression, runtime)).parse();
}

function tokenizeArithmetic(
  expression: string,
  runtime: ArithmeticRuntime,
): ArithmeticToken[] {
  const tokens: ArithmeticToken[] = [];
  let position = 0;
  while (position < expression.length) {
    const character = expression[position];
    if (/\s/u.test(character)) {
      position++;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      let end = position + 1;
      while (end < expression.length && /[A-Za-z0-9_]/u.test(expression[end])) end++;
      tokens.push({ kind: 'name', text: expression.slice(position, end) });
      position = end;
    } else if (/[0-9]/u.test(character)) {
      let end = position + 1;
      while (end < expression.length && /[A-Za-z0-9_#@]/u.test(expression[end])) end++;
      tokens.push({ kind: 'number', text: expression.slice(position, end) });
      position = end;
    } else {
      const operator = readArithmeticOperator(expression, position);
      if (operator === null) {
        throw new Error(`unsupported arithmetic character ${character}`);
      }
      tokens.push({ kind: 'operator', text: operator });
      position += operator.length;
    }
    runtime.remainingTokens--;
    if (runtime.remainingTokens < 0) {
      throw new ArithmeticBudgetError('arithmetic token budget exhausted');
    }
  }
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

function readArithmeticOperator(expression: string, position: number): string | null {
  for (const operator of ARITHMETIC_OPERATORS) {
    if (expression.startsWith(operator, position)) return operator;
  }
  return null;
}

const ARITHMETIC_OPERATORS = [
  '<<=', '>>=',
  '++', '--', '**',
  '<=', '>=', '==', '!=', '&&', '||', '<<', '>>',
  '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=',
  '+', '-', '*', '/', '%', '(', ')', '<', '>', '&', '^', '|', '!', '~',
  '?', ':', '=', ',',
] as const;

function evaluateArithmeticNode(
  node: ArithmeticNode,
  env: VariableEnvironment,
  runtime: ArithmeticRuntime,
  depth: number,
): ArithmeticValue {
  if (depth > MAX_ARITHMETIC_RECURSION) {
    throw new ArithmeticBudgetError('arithmetic evaluation budget exhausted');
  }
  if (node.kind === 'literal') return exactArithmeticValue(node.value);
  if (node.kind === 'variable') {
    return readArithmeticVariable(node.name, env, runtime, depth + 1);
  }
  if (node.kind === 'unary') {
    return evaluateArithmeticUnary(
      node.operator,
      evaluateArithmeticNode(node.operand, env, runtime, depth + 1),
    );
  }
  if (node.kind === 'update') {
    return evaluateArithmeticUpdate(node, env, runtime, depth + 1);
  }
  if (node.kind === 'assignment') {
    return evaluateArithmeticAssignment(node, env, runtime, depth + 1);
  }
  if (node.kind === 'conditional') {
    const test = evaluateArithmeticNode(node.test, env, runtime, depth + 1);
    if (test.exact) {
      return withArithmeticProvenance(evaluateArithmeticNode(
        test.value !== 0n ? node.consequent : node.alternate,
        env,
        runtime,
        depth + 1,
      ), test.provenance);
    }
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => evaluateArithmeticNode(node.consequent, env, runtime, depth + 1),
        () => evaluateArithmeticNode(node.alternate, env, runtime, depth + 1),
      ],
    ), test.provenance);
  }
  if (node.kind === 'comma') {
    const left = evaluateArithmeticNode(node.left, env, runtime, depth + 1);
    if (!left.exact) {
      return withArithmeticProvenance(evaluateArithmeticBranches(
        env,
        [
          () => unknownArithmeticValue(),
          () => {
            const right = evaluateArithmeticNode(
              node.right,
              env,
              runtime,
              depth + 1,
            );
            return unknownArithmeticValue(right.provenance);
          },
        ],
      ), left.provenance);
    }
    return evaluateArithmeticNode(node.right, env, runtime, depth + 1);
  }
  return evaluateArithmeticBinary(node, env, runtime, depth + 1);
}

function evaluateArithmeticBinary(
  node: Extract<ArithmeticNode, { kind: 'binary' }>,
  env: VariableEnvironment,
  runtime: ArithmeticRuntime,
  depth: number,
): ArithmeticValue {
  const left = evaluateArithmeticNode(node.left, env, runtime, depth);
  if (node.operator === '&&') {
    if (left.exact && left.value === 0n) {
      return exactArithmeticValue(0n, left.provenance);
    }
    if (left.exact) {
      const right = evaluateArithmeticNode(node.right, env, runtime, depth);
      return withArithmeticProvenance(
        booleanArithmeticValue(right),
        left.provenance,
      );
    }
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => exactArithmeticValue(0n),
        () => booleanArithmeticValue(
          evaluateArithmeticNode(node.right, env, runtime, depth),
        ),
      ],
    ), left.provenance);
  }
  if (node.operator === '||') {
    if (left.exact && left.value !== 0n) {
      return exactArithmeticValue(1n, left.provenance);
    }
    if (left.exact) {
      const right = evaluateArithmeticNode(node.right, env, runtime, depth);
      return withArithmeticProvenance(
        booleanArithmeticValue(right),
        left.provenance,
      );
    }
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => exactArithmeticValue(1n),
        () => booleanArithmeticValue(
          evaluateArithmeticNode(node.right, env, runtime, depth),
        ),
      ],
    ), left.provenance);
  }

  if (!left.exact) {
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => {
          const right = evaluateArithmeticNode(
            node.right,
            env,
            runtime,
            depth,
          );
          return unknownArithmeticValue(right.provenance);
        },
      ],
    ), left.provenance);
  }
  const right = evaluateArithmeticNode(node.right, env, runtime, depth);
  const provenance = combineArithmeticProvenance(left, right);
  if (!right.exact) return unknownArithmeticValue(provenance);
  return applyArithmeticBinary(
    node.operator,
    left.value,
    right.value,
    provenance,
  );
}

function evaluateArithmeticUnary(
  operator: '+' | '-' | '!' | '~',
  operand: ArithmeticValue,
): ArithmeticValue {
  if (!operand.exact) return unknownArithmeticValue(operand.provenance);
  if (operator === '+') {
    return exactArithmeticValue(operand.value, operand.provenance);
  }
  if (operator === '-') {
    return exactArithmeticValue(-operand.value, operand.provenance);
  }
  if (operator === '!') {
    return exactArithmeticValue(
      operand.value === 0n ? 1n : 0n,
      operand.provenance,
    );
  }
  return exactArithmeticValue(~operand.value, operand.provenance);
}

function evaluateArithmeticUpdate(
  node: Extract<ArithmeticNode, { kind: 'update' }>,
  env: VariableEnvironment,
  runtime: ArithmeticRuntime,
  depth: number,
): ArithmeticValue {
  const old = readArithmeticVariable(node.name, env, runtime, depth);
  if (!old.exact) {
    bindUnknownArithmeticVariable(node.name, env, old.provenance);
    return unknownArithmeticValue(old.provenance);
  }
  const next = exactArithmeticValue(
    node.operator === '++' ? old.value + 1n : old.value - 1n,
    old.provenance,
  );
  env.bind_variable(node.name, String(next.value), 0, false, next.provenance);
  return node.prefix ? next : old;
}

function evaluateArithmeticAssignment(
  node: Extract<ArithmeticNode, { kind: 'assignment' }>,
  env: VariableEnvironment,
  runtime: ArithmeticRuntime,
  depth: number,
): ArithmeticValue {
  const left = node.operator === '='
    ? null
    : readArithmeticVariable(node.name, env, runtime, depth);
  const right = evaluateArithmeticNode(node.value, env, runtime, depth);
  let assigned = right;
  if (left !== null) {
    const binary = node.operator.slice(0, -1) as BinaryOperator;
    assigned = left.exact && right.exact
      ? applyArithmeticBinary(
        binary,
        left.value,
        right.value,
        combineArithmeticProvenance(left, right),
      )
      : unknownArithmeticValue(combineArithmeticProvenance(left, right));
  }
  if (assigned.exact) {
    env.bind_variable(
      node.name,
      String(assigned.value),
      0,
      false,
      assigned.provenance,
    );
  } else {
    bindUnknownArithmeticVariable(node.name, env, assigned.provenance);
  }
  return assigned;
}

function evaluateArithmeticBranches(
  env: VariableEnvironment,
  branches: Array<() => ArithmeticValue>,
): ArithmeticValue {
  const input = env.snapshot();
  const outputs: VariableEnvironmentSnapshot[] = [];
  const values: ArithmeticValue[] = [];
  for (const branch of branches) {
    env.restore(input);
    values.push(branch());
    outputs.push(env.snapshot());
  }
  env.restore_widened(outputs);
  const first = values[0];
  const provenance = normalizeArithmeticProvenance(
    values.flatMap(value => value.provenance),
  );
  return first.exact && values.every(value =>
    value.exact && value.value === first.value)
    ? exactArithmeticValue(first.value, provenance)
    : unknownArithmeticValue(provenance);
}

function applyArithmeticBinary(
  operator: BinaryOperator,
  left: bigint,
  right: bigint,
  provenance: readonly number[] = [],
): ArithmeticValue {
  if (operator === '**') {
    if (right < 0n || right > MAX_ARITHMETIC_EXPONENT) {
      return unknownArithmeticValue(provenance);
    }
    return exactArithmeticValue(left ** right, provenance);
  }
  if (operator === '*') return exactArithmeticValue(left * right, provenance);
  if (operator === '/') {
    if (right === 0n || (left === -(1n << 63n) && right === -1n)) {
      return unknownArithmeticValue(provenance);
    }
    return exactArithmeticValue(left / right, provenance);
  }
  if (operator === '%') {
    if (right === 0n) return unknownArithmeticValue(provenance);
    return exactArithmeticValue(left % right, provenance);
  }
  if (operator === '+') return exactArithmeticValue(left + right, provenance);
  if (operator === '-') return exactArithmeticValue(left - right, provenance);
  if (operator === '<<' || operator === '>>') {
    if (right < 0n || right >= 64n) {
      return unknownArithmeticValue(provenance);
    }
    return exactArithmeticValue(
      operator === '<<' ? left << right : left >> right,
      provenance,
    );
  }
  if (operator === '<') return exactArithmeticValue(left < right ? 1n : 0n, provenance);
  if (operator === '<=') return exactArithmeticValue(left <= right ? 1n : 0n, provenance);
  if (operator === '>') return exactArithmeticValue(left > right ? 1n : 0n, provenance);
  if (operator === '>=') return exactArithmeticValue(left >= right ? 1n : 0n, provenance);
  if (operator === '==') return exactArithmeticValue(left === right ? 1n : 0n, provenance);
  if (operator === '!=') return exactArithmeticValue(left !== right ? 1n : 0n, provenance);
  if (operator === '&') return exactArithmeticValue(left & right, provenance);
  if (operator === '^') return exactArithmeticValue(left ^ right, provenance);
  if (operator === '|') return exactArithmeticValue(left | right, provenance);
  return unknownArithmeticValue(provenance);
}

function booleanArithmeticValue(value: ArithmeticValue): ArithmeticValue {
  return value.exact
    ? exactArithmeticValue(
      value.value === 0n ? 0n : 1n,
      value.provenance,
    )
    : unknownArithmeticValue(value.provenance);
}

function exactArithmeticValue(
  value: bigint,
  provenance: readonly number[] = [],
): ArithmeticValue {
  return {
    exact: true,
    value: BigInt.asIntN(64, value),
    provenance: normalizeArithmeticProvenance(provenance),
  };
}

function unknownArithmeticValue(
  provenance: readonly number[] = [],
): ArithmeticValue {
  return {
    exact: false,
    value: 0n,
    provenance: normalizeArithmeticProvenance(provenance),
  };
}

function withArithmeticProvenance(
  value: ArithmeticValue,
  provenance: readonly number[],
): ArithmeticValue {
  const combined = normalizeArithmeticProvenance([
    ...provenance,
    ...value.provenance,
  ]);
  return value.exact
    ? exactArithmeticValue(value.value, combined)
    : unknownArithmeticValue(combined);
}

function combineArithmeticProvenance(
  ...values: readonly ArithmeticValue[]
): number[] {
  return normalizeArithmeticProvenance(
    values.flatMap(value => value.provenance),
  );
}

function readArithmeticVariable(
  name: string,
  env: VariableEnvironment,
  runtime: ArithmeticRuntime,
  depth: number,
): ArithmeticValue {
  const variable = env.find_variable(name);
  if (!variable) return exactArithmeticValue(0n);
  const provenance = env.get_value_provenance(name);
  runtime.readProvenance = normalizeArithmeticProvenance([
    ...runtime.readProvenance,
    ...provenance,
  ]);
  if (variable.uncertain) return unknownArithmeticValue(provenance);
  if (variable.value.length === 0) {
    return exactArithmeticValue(0n, provenance);
  }
  const parsed = parseArithmeticInteger(variable.value);
  if (parsed !== null) return exactArithmeticValue(parsed, provenance);
  if (depth > MAX_ARITHMETIC_RECURSION || runtime.variableStack.has(name)) {
    widenPotentialArithmeticWrites(variable.value, env, provenance);
    return unknownArithmeticValue(provenance);
  }

  runtime.variableStack.add(name);
  try {
    const nested = parseArithmeticSource(variable.value, runtime);
    return withArithmeticProvenance(
      evaluateArithmeticNode(nested, env, runtime, depth + 1),
      provenance,
    );
  } catch {
    widenPotentialArithmeticWrites(
      variable.value,
      env,
      normalizeArithmeticProvenance([
        ...provenance,
        ...runtime.readProvenance,
      ]),
    );
    return unknownArithmeticValue([
      ...provenance,
      ...runtime.readProvenance,
    ]);
  } finally {
    runtime.variableStack.delete(name);
  }
}

function parseArithmeticInteger(value: string): bigint | null {
  const match = /^([+-]?)(.*)$/u.exec(value);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const digits = match[2];
  try {
    if (/^0[xX][0-9A-Fa-f]+$/u.test(digits)) {
      return sign * BigInt(digits);
    }
    if (/^0[0-7]+$/u.test(digits) && digits.length > 1) {
      return sign * BigInt(`0o${digits.slice(1)}`);
    }
    if (/^(?:0|[1-9][0-9]*)$/u.test(digits)) {
      return sign * BigInt(digits);
    }
  } catch {
    return null;
  }
  return null;
}

function bindUnknownArithmeticVariable(
  name: string,
  env: VariableEnvironment,
  provenance: readonly number[] = [],
): void {
  const arrayKind = env.get_array_kind(name);
  if (arrayKind) {
    env.widen_array(name, arrayKind, provenance);
    return;
  }
  env.bind_variable(name, `<unknown:${name}>`, 0, true, provenance);
}

function widenPotentialArithmeticWrites(
  expression: string,
  env: VariableEnvironment,
  provenance: readonly number[] = [],
): void {
  const names = new Set<string>();
  for (const match of expression.matchAll(
    /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)?(?:<<=|>>=|\+\+|--|[+\-*/%&^|]?=)/gu,
  )) {
    names.add(match[1]);
  }
  for (const match of expression.matchAll(
    /(?:^|[^A-Za-z0-9_])(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)/gu,
  )) {
    names.add(match[1]);
  }
  for (const name of names) {
    bindUnknownArithmeticVariable(name, env, provenance);
  }
}

function normalizeArithmeticProvenance(
  provenance: readonly number[],
): number[] {
  return [...new Set(provenance)]
    .filter(id => Number.isInteger(id) && id >= 0)
    .sort((left, right) => left - right)
    .slice(0, MAX_PROVENANCE_PARENTS);
}
