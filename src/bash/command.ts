// command.ts — Shell AST types and constants

// ── Word flags ──

export const W_HASDOLLAR    = 0x000001;
export const W_QUOTED       = 0x000002;
export const W_ASSIGNMENT   = 0x000004;
export const W_SPLITSPACE   = 0x000008;
export const W_NOSPLIT      = 0x000010;
export const W_NOGLOB       = 0x000020;
export const W_NOSPLIT2     = 0x000040;
export const W_TILDEEXP     = 0x000080;
export const W_DOLLARAT     = 0x000100;
export const W_DOLLARSTAR   = 0x000200;
export const W_NOCOMSUB     = 0x000400;
export const W_ASSIGNRHS    = 0x000800;
export const W_NOTILDE      = 0x001000;
export const W_ITILDE       = 0x002000;
export const W_EXPANDRHS    = 0x004000;
export const W_COMPASSIGN   = 0x008000;
export const W_ASSNBLTIN    = 0x010000;
export const W_ASSIGNARG    = 0x020000;
export const W_HASQUOTEDNULL = 0x040000;
export const W_DQUOTE       = 0x080000;
export const W_NOPROCSUB    = 0x100000;
export const W_SAWQUOTEDNULL = 0x200000;
export const W_ASSIGNASSOC  = 0x400000;
export const W_ASSIGNARRAY  = 0x800000;

// ── Command flags ──

export const CMD_WANT_SUBSHELL  = 0x01;
export const CMD_FORCE_SUBSHELL = 0x02;
export const CMD_INVERT_RETURN  = 0x04;
export const CMD_IGNORE_RETURN  = 0x08;
export const CMD_NO_FUNCTIONS   = 0x10;
export const CMD_INHIBIT_EXPANSION = 0x20;
export const CMD_NO_FORK        = 0x40;
export const CMD_TIME_PIPELINE  = 0x80;
export const CMD_TIME_POSIX     = 0x100;
export const CMD_AMPERSAND      = 0x200;
export const CMD_STDIN_REDIR    = 0x400;
export const CMD_COMMAND_BUILTIN = 0x800;

// ── Case-clause flags ──

export const CASEPAT_FALLTHROUGH = 0x01; // ;&
export const CASEPAT_TESTNEXT = 0x02;    // ;;&

// ── Conditional-expression node types ──

export const COND_AND = 1;
export const COND_OR = 2;
export const COND_UNARY = 3;
export const COND_BINARY = 4;
export const COND_TERM = 5;
export const COND_EXPR = 6;
/** Conservative recovery node for syntax outside the modeled subset. */
export const COND_UNKNOWN = 7;

export type CondNodeType =
  | typeof COND_AND
  | typeof COND_OR
  | typeof COND_UNARY
  | typeof COND_BINARY
  | typeof COND_TERM
  | typeof COND_EXPR
  | typeof COND_UNKNOWN;

// ── Redirect instruction types ──

export type RInstruction =
  | 'r_output_direction'       // >
  | 'r_input_direction'        // <
  | 'r_appending_to'           // >>
  | 'r_reading_until'          // <<
  | 'r_reading_string'         // <<<
  | 'r_duplicating_input'      // <&N
  | 'r_duplicating_output'     // >&N
  | 'r_deblank_reading_until'  // <<-
  | 'r_close_this'             // N>&- or N<&-
  | 'r_err_and_out'            // &>
  | 'r_input_output'           // <>
  | 'r_output_force'           // >|
  | 'r_append_err_and_out'     // &>>
  | 'r_duplicating_input_word' // <&WORD
  | 'r_duplicating_output_word'// >&WORD
  | 'r_move_input'             // <&N-
  | 'r_move_output'            // >&N-
  | 'r_move_input_word'        // <&WORD-
  | 'r_move_output_word';      // >&WORD-

// ── Connector constants ──

export const AND_AND  = 256;  // &&
export const OR_OR    = 257;  // ||
export const SEMI     = 59;   // ;  (ASCII)
export const NEWLINE  = 10;   // \n (ASCII)
export const AMP      = 38;   // &  (ASCII)
export const PIPE     = 124;  // |  (ASCII)
export const BAR_AND  = 258;  // |&

// ── Core AST types ──

export type CommandType =
  | 'simple' | 'for' | 'case' | 'while' | 'if' | 'connection'
  | 'function_def' | 'until' | 'group' | 'subshell' | 'arith' | 'cond' | 'arith_for';

export interface WordDesc {
  word: string;
  flags: number;
}

export type WordList = WordDesc[];

export interface Redirectee {
  dest: number;
  filename: WordDesc | null;
}

export interface Redirect {
  next: Redirect | null;
  redirector: Redirectee;
  rflags: number;
  instruction: RInstruction;
  redirectee: Redirectee;
  here_doc_eof?: string;
  here_doc_quoted?: boolean;
}

interface CommandBase {
  type: CommandType;
  flags: number;
  line: number;
  redirects: Redirect | null;
}

export interface SimpleCommand extends CommandBase {
  type: 'simple';
  words: WordList;
  assignments: WordList;
}

export interface ForCommand extends CommandBase {
  type: 'for';
  name: WordDesc;
  map_list: WordList;
  action: Command;
}

export interface PatternList {
  next: PatternList | null;
  patterns: WordList;
  action: Command | null;
  flags: number;
}

export interface CaseCommand extends CommandBase {
  type: 'case';
  word: WordDesc;
  clauses: PatternList | null;
}

export interface WhileCommand extends CommandBase {
  type: 'while' | 'until';
  test: Command;
  action: Command;
}

export interface IfCommand extends CommandBase {
  type: 'if';
  test: Command;
  true_case: Command;
  false_case: Command | null;
}

export interface Connection extends CommandBase {
  type: 'connection';
  first: Command;
  second: Command | null;
  connector: number;
}

export interface FunctionDef extends CommandBase {
  type: 'function_def';
  name: WordDesc;
  command: Command;
}

export interface GroupCommand extends CommandBase {
  type: 'group';
  command: Command;
}

export interface SubshellCommand extends CommandBase {
  type: 'subshell';
  command: Command;
}

export interface ArithCommand extends CommandBase {
  type: 'arith';
  expression: WordDesc;
}

export interface CondNode {
  flags: number;
  line: number;
  type: CondNodeType;
  op: WordDesc | null;
  left: CondNode | null;
  right: CondNode | null;
  /** Words retained only when tolerant parsing widens the expression. */
  words?: WordList;
}

export interface CondCommand extends CommandBase {
  type: 'cond';
  expression: CondNode;
}

export type Command =
  | SimpleCommand
  | ForCommand
  | CaseCommand
  | WhileCommand
  | IfCommand
  | Connection
  | FunctionDef
  | GroupCommand
  | SubshellCommand
  | ArithCommand
  | CondCommand;
