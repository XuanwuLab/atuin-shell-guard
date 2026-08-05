import { posix as path } from 'node:path';
import type { AbstractStatus } from '../analysis/abstract.js';
import {
  exactStatus,
  failureStatus,
  invertStatus,
  successStatus,
  unknownStatus,
} from '../analysis/abstract.js';
import type { IFS } from '../analysis/vfs.js';
import { isAbsolutePath, toPosix } from '../analysis/vfs.js';

/**
 * Evaluate the deterministic subset of Bash's `test`/`[` builtin.
 *
 * Unsupported filesystem predicates stay unknown unless an analysis
 * filesystem is available. Syntax errors use Bash's status 2.
 */
export function evaluateTestBuiltin(
  command: 'test' | '[',
  rawArgs: readonly string[],
  vfs: IFS | null,
  cwd: string,
): AbstractStatus {
  let args = [...rawArgs];
  if (command === '[') {
    if (args[args.length - 1] !== ']') return exactStatus(2);
    args = args.slice(0, -1);
  }
  return evaluateTestArgs(args, vfs, cwd);
}

function evaluateTestArgs(
  args: readonly string[],
  vfs: IFS | null,
  cwd: string,
): AbstractStatus {
  if (args.length === 0) return failureStatus();
  if (args[0] === '!') {
    if (args.length === 1) return successStatus();
    return invertStatus(evaluateTestArgs(args.slice(1), vfs, cwd));
  }
  if (args.length === 1) return args[0].length > 0 ? successStatus() : failureStatus();

  if (args.length === 2) {
    const [operator, operand] = args;
    if (operator === '-n') return operand.length > 0 ? successStatus() : failureStatus();
    if (operator === '-z') return operand.length === 0 ? successStatus() : failureStatus();
    return evaluateFileUnary(operator, operand, vfs, cwd);
  }

  if (args.length === 3) {
    const [left, operator, right] = args;
    if (operator === '-a') {
      return left.length > 0 && right.length > 0 ? successStatus() : failureStatus();
    }
    if (operator === '-o') {
      return left.length > 0 || right.length > 0 ? successStatus() : failureStatus();
    }
    return evaluateBinary(left, operator, right);
  }

  return unknownStatus();
}

function evaluateFileUnary(
  operator: string,
  operand: string,
  vfs: IFS | null,
  cwd: string,
): AbstractStatus {
  if (!['-a', '-e', '-f', '-d', '-h', '-L'].includes(operator)) return unknownStatus();
  if (!vfs) return unknownStatus();

  const posix = toPosix(operand);
  const target = isAbsolutePath(operand) ? path.normalize(posix) : path.normalize(path.join(cwd, posix));
  if (operator === '-a' || operator === '-e') return boolStatus(vfs.exists(target));
  if (operator === '-f') return boolStatus(vfs.isFile(target));
  if (operator === '-d') return boolStatus(vfs.isDirectory(target));
  return boolStatus(vfs.isSymbolicLink(target));
}

function evaluateBinary(left: string, operator: string, right: string): AbstractStatus {
  if (operator === '=' || operator === '==') return boolStatus(left === right);
  if (operator === '!=') return boolStatus(left !== right);

  if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(operator)) {
    const lhs = parseInteger(left);
    const rhs = parseInteger(right);
    if (lhs === null || rhs === null) return exactStatus(2);
    if (operator === '-eq') return boolStatus(lhs === rhs);
    if (operator === '-ne') return boolStatus(lhs !== rhs);
    if (operator === '-lt') return boolStatus(lhs < rhs);
    if (operator === '-le') return boolStatus(lhs <= rhs);
    if (operator === '-gt') return boolStatus(lhs > rhs);
    return boolStatus(lhs >= rhs);
  }

  return unknownStatus();
}

function parseInteger(value: string): bigint | null {
  if (!/^[+-]?[0-9]+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function boolStatus(value: boolean): AbstractStatus {
  return value ? successStatus() : exactStatus(1);
}
