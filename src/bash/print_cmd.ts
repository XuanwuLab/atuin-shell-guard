// print_cmd.ts — Serialize AST back to shell syntax

import type {
  Command, SimpleCommand, ForCommand, CaseCommand, WhileCommand,
  IfCommand, Connection, FunctionDef, GroupCommand, SubshellCommand,
  Redirect, WordList, ArithCommand, CondCommand, CondNode,
} from './command.js';
import {
  AND_AND,
  OR_OR,
  SEMI,
  NEWLINE,
  AMP,
  PIPE,
  BAR_AND,
  CASEPAT_FALLTHROUGH,
  CASEPAT_TESTNEXT,
  CMD_INVERT_RETURN,
  COND_AND,
  COND_BINARY,
  COND_EXPR,
  COND_OR,
  COND_TERM,
  COND_UNARY,
  COND_UNKNOWN,
} from './command.js';

export function print_command(cmd: Command): string {
  return print_cmd(cmd, 0);
}

function indent(level: number): string {
  return '  '.repeat(level);
}

function print_cmd(cmd: Command, level: number): string {
  switch (cmd.type) {
    case 'simple':     return print_simple(cmd, level);
    case 'for':        return print_for(cmd, level);
    case 'case':       return print_case(cmd, level);
    case 'while':      return print_while(cmd, level);
    case 'until':      return print_until(cmd, level);
    case 'if':         return print_if(cmd, level);
    case 'connection': return print_connection(cmd, level);
    case 'function_def': return print_function(cmd, level);
    case 'group':      return print_group(cmd, level);
    case 'subshell':   return print_subshell(cmd, level);
    case 'arith':      return print_arith(cmd, level);
    case 'cond':       return print_cond(cmd, level);
    default:           return '<unknown>';
  }
}

function print_words(words: WordList): string {
  return words.map(w => w.word).join(' ');
}

function print_redirects(r: Redirect | null): string {
  const parts: string[] = [];
  while (r) {
    let s = '';
    const src = r.redirector.dest;
    switch (r.instruction) {
      case 'r_output_direction':
        if (src !== 1) s += src;
        s += '> ';
        break;
      case 'r_appending_to':
        if (src !== 1) s += src;
        s += '>> ';
        break;
      case 'r_input_direction':
        if (src !== 0) s += src;
        s += '< ';
        break;
      case 'r_output_force':
        if (src !== 1) s += src;
        s += '>| ';
        break;
      case 'r_input_output':
        if (src !== 0) s += src;
        s += '<> ';
        break;
      case 'r_err_and_out':
        s += '&> ';
        break;
      case 'r_append_err_and_out':
        s += '&>> ';
        break;
      case 'r_reading_until':
        s += '<< ';
        break;
      case 'r_deblank_reading_until':
        s += '<<- ';
        break;
      case 'r_reading_string':
        if (src !== 0) s += src;
        s += '<<< ';
        break;
      case 'r_duplicating_input':
        if (src !== 0) s += src;
        s += '<& ';
        break;
      case 'r_duplicating_output':
        if (src !== 1) s += src;
        s += '>& ';
        break;
      case 'r_close_this':
        s += src + '>&- ';
        break;
      default:
        s += '? ';
        break;
    }
    if (r.redirectee.filename) {
      s += r.redirectee.filename.word;
    } else if (r.redirectee.dest >= 0) {
      s += String(r.redirectee.dest);
    }
    parts.push(s);
    r = r.next;
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function print_simple(cmd: SimpleCommand, level: number): string {
  const parts: string[] = [];
  for (const a of cmd.assignments) parts.push(a.word);
  for (const w of cmd.words) parts.push(w.word);
  return indent(level) + parts.join(' ') + print_redirects(cmd.redirects);
}

function print_for(cmd: ForCommand, level: number): string {
  let s = indent(level) + 'for ' + cmd.name.word;
  if (cmd.map_list.length > 0) {
    s += ' in ' + print_words(cmd.map_list);
  }
  s += '; do\n';
  s += print_cmd(cmd.action, level + 1) + '\n';
  s += indent(level) + 'done';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_case(cmd: CaseCommand, level: number): string {
  let s = indent(level) + 'case ' + cmd.word.word + ' in\n';
  let clause = cmd.clauses;
  while (clause) {
    s += indent(level + 1) + print_words(clause.patterns) + ')\n';
    if (clause.action) {
      s += print_cmd(clause.action, level + 2) + '\n';
    }
    const terminator = (clause.flags & CASEPAT_FALLTHROUGH) !== 0
      ? ';&'
      : (clause.flags & CASEPAT_TESTNEXT) !== 0
        ? ';;&'
        : ';;';
    s += indent(level + 2) + terminator + '\n';
    clause = clause.next;
  }
  s += indent(level) + 'esac';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_while(cmd: WhileCommand, level: number): string {
  let s = indent(level) + 'while ';
  s += print_cmd(cmd.test, 0) + '; do\n';
  s += print_cmd(cmd.action, level + 1) + '\n';
  s += indent(level) + 'done';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_until(cmd: WhileCommand, level: number): string {
  let s = indent(level) + 'until ';
  s += print_cmd(cmd.test, 0) + '; do\n';
  s += print_cmd(cmd.action, level + 1) + '\n';
  s += indent(level) + 'done';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_if(cmd: IfCommand, level: number): string {
  let s = indent(level) + 'if ' + print_cmd(cmd.test, 0) + '; then\n';
  s += print_cmd(cmd.true_case, level + 1) + '\n';
  if (cmd.false_case) {
    if (cmd.false_case.type === 'if') {
      s += indent(level) + 'el' + print_cmd(cmd.false_case, 0).trimStart() + '\n';
    } else {
      s += indent(level) + 'else\n';
      s += print_cmd(cmd.false_case, level + 1) + '\n';
    }
  }
  s += indent(level) + 'fi';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_connection(cmd: Connection, level: number): string {
  const first = print_cmd(cmd.first, level);
  if (!cmd.second) {
    if (cmd.connector === AMP) return first + ' &';
    return first;
  }
  const second = print_cmd(cmd.second, level);
  switch (cmd.connector) {
    case AND_AND: return first + ' && ' + second.trimStart();
    case OR_OR:   return first + ' || ' + second.trimStart();
    case PIPE:    return first + ' | ' + second.trimStart();
    case BAR_AND: return first + ' |& ' + second.trimStart();
    case AMP:     return first + ' & ' + second.trimStart();
    case SEMI:
    case NEWLINE:
    default:      return first + '; ' + second.trimStart();
  }
}

function print_function(cmd: FunctionDef, level: number): string {
  let s = indent(level) + cmd.name.word + ' () {\n';
  s += print_cmd(cmd.command, level + 1) + '\n';
  s += indent(level) + '}';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_group(cmd: GroupCommand, level: number): string {
  let s = indent(level) + '{\n';
  s += print_cmd(cmd.command, level + 1) + '\n';
  s += indent(level) + '}';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_subshell(cmd: SubshellCommand, level: number): string {
  let s = indent(level) + '(\n';
  s += print_cmd(cmd.command, level + 1) + '\n';
  s += indent(level) + ')';
  s += print_redirects(cmd.redirects);
  return s;
}

function print_arith(cmd: ArithCommand, level: number): string {
  return indent(level)
    + '(( '
    + cmd.expression.word
    + ' ))'
    + print_redirects(cmd.redirects);
}

function print_cond(cmd: CondCommand, level: number): string {
  return indent(level)
    + '[[ '
    + print_cond_node(cmd.expression)
    + ' ]]'
    + print_redirects(cmd.redirects);
}

function print_cond_node(node: CondNode): string {
  let body: string;
  if (node.type === COND_AND || node.type === COND_OR) {
    const operator = node.type === COND_AND ? '&&' : '||';
    body = `${print_cond_node(node.left!)} ${operator} ${print_cond_node(node.right!)}`;
  } else if (node.type === COND_EXPR) {
    body = `( ${print_cond_node(node.left!)} )`;
  } else if (node.type === COND_UNARY) {
    body = `${node.op?.word ?? '-n'} ${print_cond_node(node.left!)}`;
  } else if (node.type === COND_BINARY) {
    body = `${print_cond_node(node.left!)} ${node.op?.word ?? '?'} ${print_cond_node(node.right!)}`;
  } else if (node.type === COND_TERM) {
    body = node.op?.word ?? '';
  } else if (node.type === COND_UNKNOWN) {
    body = node.words?.map(word => word.word).join(' ') || '?';
  } else {
    body = '?';
  }
  return (node.flags & CMD_INVERT_RETURN) !== 0 ? `! ${body}` : body;
}
