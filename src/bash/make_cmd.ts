// make_cmd.ts — AST node constructors

import type {
  WordDesc, WordList, Redirect, Redirectee, RInstruction,
  SimpleCommand, ForCommand, CaseCommand, WhileCommand,
  IfCommand, Connection, FunctionDef, GroupCommand,
  SubshellCommand, Command, PatternList, ArithCommand, CondCommand,
  CondNode, CondNodeType,
} from './command.js';
import { CMD_WANT_SUBSHELL, SEMI, W_ASSIGNMENT } from './command.js';
import { assignment_word } from './general.js';

let current_line = 1;

export function set_line_number(n: number): void {
  current_line = n;
}

export function get_line_number(): number {
  return current_line;
}

export function make_word(word: string, flags: number = 0): WordDesc {
  return { word, flags };
}

export function make_word_list(word: WordDesc, prev: WordList = []): WordList {
  return [...prev, word];
}

export function make_simple_command(): SimpleCommand {
  return {
    type: 'simple',
    flags: 0,
    line: current_line,
    redirects: null,
    words: [],
    assignments: [],
  };
}

export function add_element_to_simple_command(cmd: SimpleCommand, word: WordDesc): void {
  cmd.words.push(word);
}

/** Separate leading assignments from command words */
export function clean_simple_command(cmd: SimpleCommand): SimpleCommand {
  const words: WordList = [];
  const assignments: WordList = [];
  let pastCommand = false;
  for (const w of cmd.words) {
    if (!pastCommand && assignment_word(w.word)) {
      w.flags |= W_ASSIGNMENT;
      assignments.push(w);
    } else {
      pastCommand = true;
      words.push(w);
    }
  }
  cmd.words = words;
  cmd.assignments = assignments;
  return cmd;
}

export function make_for_command(
  name: WordDesc,
  map_list: WordList,
  action: Command,
  lineno: number,
): ForCommand {
  return {
    type: 'for',
    flags: 0,
    line: lineno,
    redirects: null,
    name,
    map_list,
    action,
  };
}

export function make_if_command(
  test: Command,
  true_case: Command,
  false_case: Command | null,
): IfCommand {
  return {
    type: 'if',
    flags: 0,
    line: current_line,
    redirects: null,
    test,
    true_case,
    false_case,
  };
}

export function make_while_command(test: Command, action: Command): WhileCommand {
  return {
    type: 'while',
    flags: 0,
    line: current_line,
    redirects: null,
    test,
    action,
  };
}

export function make_until_command(test: Command, action: Command): WhileCommand {
  return {
    type: 'until',
    flags: 0,
    line: current_line,
    redirects: null,
    test,
    action,
  };
}

export function make_case_command(
  word: WordDesc,
  clauses: PatternList | null,
  lineno: number,
): CaseCommand {
  return {
    type: 'case',
    flags: 0,
    line: lineno,
    redirects: null,
    word,
    clauses,
  };
}

export function make_pattern_list(
  patterns: WordList,
  action: Command | null,
): PatternList {
  return {
    next: null,
    patterns,
    action,
    flags: 0,
  };
}

export function make_group_command(command: Command): GroupCommand {
  return {
    type: 'group',
    flags: 0,
    line: current_line,
    redirects: null,
    command,
  };
}

export function make_subshell_command(command: Command): SubshellCommand {
  return {
    type: 'subshell',
    flags: 0,
    line: current_line,
    redirects: null,
    command,
  };
}

export function make_arith_command(
  expression: WordDesc,
  line: number = current_line,
): ArithCommand {
  return {
    type: 'arith',
    flags: 0,
    line,
    redirects: null,
    expression,
  };
}

export function make_cond_node(
  type: CondNodeType,
  op: WordDesc | null,
  left: CondNode | null,
  right: CondNode | null,
  line: number = current_line,
): CondNode {
  return {
    flags: 0,
    line,
    type,
    op,
    left,
    right,
  };
}

export function make_cond_command(
  expression: CondNode,
  line: number = current_line,
): CondCommand {
  return {
    type: 'cond',
    flags: 0,
    line,
    redirects: null,
    expression,
  };
}

export function make_function_def(name: WordDesc, command: Command): FunctionDef {
  return {
    type: 'function_def',
    flags: 0,
    line: current_line,
    redirects: null,
    name,
    command,
  };
}

export function command_connect(
  first: Command,
  second: Command | null,
  connector: number,
): Connection {
  return {
    type: 'connection',
    flags: 0,
    line: first.line,
    redirects: null,
    first,
    second,
    connector,
  };
}

/**
 * Apply `&` to the final command in a semicolon list. This mirrors Bash's
 * parser fixup for `a; b &`, where only `b` is asynchronous.
 */
export function connect_async_list(
  command: Command,
  command2: Command | null,
  connector: number,
): Command {
  if (command.type !== 'connection'
      || !command.second
      || (command.flags & CMD_WANT_SUBSHELL) !== 0
      || command.connector !== SEMI) {
    return command_connect(command, command2, connector);
  }

  let parent = command;
  let tail = command.second;
  while (tail.type === 'connection'
      && tail.second
      && (tail.flags & CMD_WANT_SUBSHELL) === 0
      && tail.connector === SEMI) {
    parent = tail;
    tail = tail.second;
  }
  parent.second = command_connect(tail, command2, connector);
  return command;
}

export function make_redirectee(dest: number): Redirectee;
export function make_redirectee(filename: WordDesc): Redirectee;
export function make_redirectee(arg: number | WordDesc): Redirectee {
  if (typeof arg === 'number') {
    return { dest: arg, filename: null };
  }
  return { dest: -1, filename: arg };
}

export function make_redirection(
  source: Redirectee,
  instruction: RInstruction,
  redirectee: Redirectee,
  rflags: number = 0,
): Redirect {
  return {
    next: null,
    redirector: source,
    rflags,
    instruction,
    redirectee,
    here_doc_eof: undefined,
  };
}

/** Append a redirect to the end of a redirect chain */
export function append_redirect(existing: Redirect | null, newRedir: Redirect): Redirect {
  if (!existing) return newRedir;
  let tail = existing;
  while (tail.next) tail = tail.next;
  tail.next = newRedir;
  return existing;
}
