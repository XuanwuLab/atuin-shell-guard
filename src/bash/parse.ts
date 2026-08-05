// parse.ts — Lexer + recursive-descent parser for shell syntax

import type {
  Command, WordList, Redirect, RInstruction,
  PatternList, CondNode,
} from './command.js';
import {
  W_ASSIGNMENT, W_QUOTED,
  AND_AND, OR_OR, SEMI, AMP, PIPE, BAR_AND,
  CASEPAT_FALLTHROUGH, CASEPAT_TESTNEXT,
  CMD_INVERT_RETURN,
  COND_AND, COND_OR, COND_UNARY, COND_BINARY, COND_TERM,
  COND_EXPR, COND_UNKNOWN,
} from './command.js';
import {
  make_word, make_simple_command, add_element_to_simple_command,
  clean_simple_command, make_for_command, make_if_command,
  make_while_command, make_until_command, make_case_command,
  make_pattern_list, make_group_command, make_subshell_command,
  make_function_def, command_connect, connect_async_list, make_redirection,
  make_redirectee, append_redirect, set_line_number, make_arith_command,
  make_cond_node, make_cond_command,
} from './make_cmd.js';
import { assignment_word } from './general.js';

// ── Token types ──

const enum TokenType {
  WORD = 0,
  ASSIGNMENT_WORD,
  NUMBER,
  // Reserved words
  IF, THEN, ELSE, ELIF, FI,
  CASE, ESAC, IN,
  FOR, WHILE, UNTIL, DO, DONE,
  FUNCTION,
  SELECT, COPROC, BANG, TIME,
  // Operators
  AND_AND,      // &&
  OR_OR,        // ||
  GREATER_GREATER, // >>
  LESS_LESS,    // <<
  LESS_AND,     // <&
  GREATER_AND,  // >&
  SEMI_SEMI,    // ;;
  SEMI_AND,     // ;&
  SEMI_SEMI_AND,// ;;&
  LESS_LESS_MINUS, // <<-
  LESS_LESS_LESS,  // <<<
  AND_GREATER,  // &>
  AND_GREATER_GREATER, // &>>
  LESS_GREATER, // <>
  GREATER_BAR,  // >|
  BAR_AND,      // |&
  // Structural
  NEWLINE,
  SEMI,         // ;
  AMP,          // &
  PIPE,         // |
  LPAREN,       // (
  RPAREN,       // )
  LBRACE,       // {
  RBRACE,       // }
  COND_END,     // ]]
  EOF,
  ERROR,
}

interface Token {
  type: TokenType;
  value: string;
  line: number;
  quoted?: boolean;
}

function token_word_flags(token: Token): number {
  return token.quoted ? W_QUOTED : 0;
}

function is_all_digits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
  }
  return true;
}

function starts_with_windows_drive_prefix(s: string): boolean {
  if (s.length < 2) return false;
  const c = s[0];
  return ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) && s[1] === ':';
}

function strip_leading_tabs(s: string): string {
  let pos = 0;
  while (pos < s.length && s[pos] === '\t') pos++;
  return s.substring(pos);
}

function strip_quoting_chars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "'" && c !== '"' && c !== '\\') out += c;
  }
  return out;
}

// Reserved word lookup
const RESERVED_WORDS: Record<string, TokenType> = {
  'if': TokenType.IF, 'then': TokenType.THEN, 'else': TokenType.ELSE,
  'elif': TokenType.ELIF, 'fi': TokenType.FI, 'case': TokenType.CASE,
  'esac': TokenType.ESAC, 'for': TokenType.FOR, 'while': TokenType.WHILE,
  'until': TokenType.UNTIL, 'do': TokenType.DO, 'done': TokenType.DONE,
  'in': TokenType.IN, 'function': TokenType.FUNCTION,
  'select': TokenType.SELECT, 'coproc': TokenType.COPROC,
  '!': TokenType.BANG, 'time': TokenType.TIME,
  '{': TokenType.LBRACE, '}': TokenType.RBRACE,
};

const CONDITIONAL_UNARY_OPERATORS = new Set([
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-n', '-o',
  '-p', '-r', '-s', '-t', '-u', '-v', '-w', '-x', '-z', '-G', '-L',
  '-O', '-S', '-N', '-R',
]);

const CONDITIONAL_BINARY_OPERATORS = new Set([
  '=', '==', '!=', '=~', '<', '>',
  '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef',
]);

export const MAX_SHELL_GROUP_CLOSE_CANDIDATES = 128;
export const MAX_SHELL_GROUP_PARSE_CHARS = 64 * 1024;

// ── Lexer ──

class Lexer {
  private input: string;
  private pos: number = 0;
  private line: number = 1;
  private pushback: Token[] = [];
  private _allowReserved: boolean = true;
  private _conditionalExpression: boolean = false;
  private conditionalEndSeen: boolean = false;
  private conditionalWordTokens: Token[] = [];
  private pendingHereDocs: Array<{
    redirect: Redirect;
    eof: string;
    strip: boolean;
    quoted: boolean;
  }> = [];
  warnings: string[] = [];

  constructor(input: string) {
    this.input = input;
  }

  get currentLine(): number { return this.line; }

  set allowReserved(v: boolean) { this._allowReserved = v; }

  set conditionalExpression(value: boolean) {
    this._conditionalExpression = value;
    if (value) {
      this.conditionalEndSeen = false;
      this.conditionalWordTokens = [];
    }
  }

  get hasSeenConditionalEnd(): boolean { return this.conditionalEndSeen; }

  takeConditionalWords(): WordList {
    const words = this.conditionalWordTokens.map(token =>
      make_word(token.value, token_word_flags(token)));
    this.conditionalWordTokens = [];
    return words;
  }

  private shell_getc(): string {
    if (this.pos >= this.input.length) return '';
    const c = this.input[this.pos++];
    if (c === '\n') this.line++;
    return c;
  }

  private shell_ungetc(): void {
    if (this.pos > 0) {
      this.pos--;
      if (this.input[this.pos] === '\n') this.line--;
    }
  }

  private peek_char(): string {
    if (this.pos >= this.input.length) return '';
    return this.input[this.pos];
  }

  /** Read a dollar expansion after the leading '$' has been consumed. */
  private read_dollar_expansion(): string | null {
    const after = this.peek_char();
    if (after === '(') {
      this.shell_getc();
      if (this.peek_char() === '(') {
        this.shell_getc();
        let expansion = '$((';
        let depth = 1;
        while (depth > 0) {
          const character = this.shell_getc();
          if (character === '') break;
          expansion += character;
          if (character === '(' && this.peek_char() === '(') depth++;
          if (character === ')' && this.peek_char() === ')') {
            depth--;
            if (depth === 0) {
              expansion += this.shell_getc();
              break;
            }
          }
        }
        return expansion;
      }
      return this.read_shell_command_group('$(');
    }

    if (after === '{') {
      this.shell_getc();
      let expansion = '${';
      let depth = 1;
      while (depth > 0) {
        const character = this.shell_getc();
        if (character === '') break;
        expansion += character;
        if (character === '{') depth++;
        if (character === '}') depth--;
      }
      return expansion;
    }
    return null;
  }

  /** Read a legacy command substitution after its opening backtick. */
  private read_backtick_word(): string {
    let word = '`';
    while (true) {
      const character = this.shell_getc();
      if (character === '' || character === '`') {
        word += character;
        return word;
      }
      if (character === '\\') {
        word += '\\' + this.shell_getc();
        continue;
      }
      word += character;
    }
  }

  /**
   * Read a process substitution after `<(` or `>(` has been consumed.
   * Bash lexes the complete construct as part of one word, including spaces
   * and shell operators in the nested command.
   */
  private read_process_substitution(marker: '<' | '>'): string {
    return this.read_shell_command_group(`${marker}(`);
  }

  private read_shell_command_group(prefix: '$(' | '<(' | '>('): string {
    let word = prefix;
    let closeCandidates = 0;
    let validationBudgetExhausted = false;
    let fallback: { position: number; line: number; word: string } | null = null;
    while (true) {
      const character = this.shell_getc();
      if (character === '') {
        if (fallback) {
          this.pos = fallback.position;
          this.line = fallback.line;
          this.warnings.push(validationBudgetExhausted
            ? `${prefix} close matching widened after ${MAX_SHELL_GROUP_CLOSE_CANDIDATES} candidates or ${MAX_SHELL_GROUP_PARSE_CHARS} characters`
            : `unexpected EOF while proving the matching ')' in ${prefix}`);
          return fallback.word;
        }
        this.warnings.push(`unexpected EOF while looking for matching ')' in ${prefix}`);
        return word;
      }
      word += character;
      if (character === '\\') {
        const escaped = this.shell_getc();
        word += escaped;
        if (escaped === '') {
          this.warnings.push(`unexpected EOF while looking for matching ')' in ${prefix}`);
          return word;
        }
        continue;
      }
      if (character === ')') {
        closeCandidates++;
        const body = word.slice(prefix.length, -1);
        const withinBudget = closeCandidates <= MAX_SHELL_GROUP_CLOSE_CANDIDATES
          && body.length <= MAX_SHELL_GROUP_PARSE_CHARS;
        if (withinBudget && this.isCompleteShellGroupBody(body)) {
          return word;
        }
        validationBudgetExhausted ||= !withinBudget;
        fallback = {
          position: this.pos,
          line: this.line,
          word,
        };
      }
    }
  }

  private isCompleteShellGroupBody(body: string): boolean {
    if (body.trim().length === 0) return true;
    const parser = new Parser(`(${body})`);
    const ast = parser.parse();
    if (!ast || !parser.consumedAllInput) return false;
    return !parser.warnings.some(warning =>
      warning.includes('Parse error')
      || warning.includes('unexpected EOF')
      || warning.includes('delimited by end-of-file'));
  }

  /**
   * Try to read the rest of `(( expression ))` after the first opening
   * parenthesis token. On failure, restore the lexer so ordinary nested
   * subshell parsing sees the second parenthesis.
   */
  tryReadArithmeticCommand(): string | null {
    if (this.pushback.length > 0 || this.peek_char() !== '(') return null;
    const savedPosition = this.pos;
    const savedLine = this.line;
    this.shell_getc();

    let expression = '';
    let nestedParentheses = 0;
    let quote: "'" | '"' | '`' | null = null;
    while (true) {
      const character = this.shell_getc();
      if (character === '') {
        this.pos = savedPosition;
        this.line = savedLine;
        return null;
      }
      if (character === '\\' && quote !== "'") {
        expression += character;
        const escaped = this.shell_getc();
        if (escaped === '') {
          this.pos = savedPosition;
          this.line = savedLine;
          return null;
        }
        expression += escaped;
        continue;
      }
      if (character === '$' && quote !== "'") {
        const expansion = this.read_dollar_expansion();
        if (expansion !== null) {
          expression += expansion;
          continue;
        }
      }
      if (quote !== null) {
        expression += character;
        if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character;
        expression += character;
        continue;
      }
      if (character === '(') {
        nestedParentheses++;
        expression += character;
        continue;
      }
      if (character === ')') {
        if (nestedParentheses > 0) {
          nestedParentheses--;
          expression += character;
          continue;
        }
        if (this.peek_char() === ')') {
          this.shell_getc();
          return expression;
        }
        this.pos = savedPosition;
        this.line = savedLine;
        return null;
      }
      expression += character;
    }
  }

  unget_token(tok: Token): void {
    this.pushback.push(tok);
  }

  next_token(): Token {
    if (this.pushback.length > 0) {
      return this.pushback.pop()!;
    }
    return this.read_token();
  }

  /** Gather any pending here-documents after a newline */
  private gather_here_documents(): void {
    for (const hd of this.pendingHereDocs) {
      const body = this.read_here_doc(hd.eof, hd.strip);
      // Store the here-doc body on the redirect. We use the redirectee filename word.
      if (hd.redirect.redirectee.filename) {
        hd.redirect.redirectee.filename.word = body;
      }
    }
    this.pendingHereDocs = [];
  }

  private read_here_doc(eof: string, strip: boolean): string {
    let body = '';
    while (true) {
      let line = '';
      while (true) {
        const c = this.shell_getc();
        if (c === '') {
          this.warnings.push(`here-document delimited by end-of-file (wanted '${eof}')`);
          return body;
        }
        if (c === '\n') break;
        line += c;
      }
      let checkLine = line;
      if (strip) {
        checkLine = strip_leading_tabs(line);
      }
      if (checkLine === eof) break;
      body += line + '\n';
    }
    return body;
  }

  private skip_whitespace_and_comments(): void {
    while (true) {
      const c = this.peek_char();
      if (c === ' ' || c === '\t') {
        this.shell_getc();
      } else if (c === '#') {
        // Skip to end of line
        while (true) {
          const ch = this.shell_getc();
          if (ch === '\n' || ch === '') {
            if (ch === '\n') this.shell_ungetc();
            break;
          }
        }
      } else {
        break;
      }
    }
  }

  private read_token(): Token {
    this.skip_whitespace_and_comments();

    const startLine = this.line;
    const c = this.shell_getc();

    if (c === '') return { type: TokenType.EOF, value: '', line: startLine };

    // ── Newline ──
    if (c === '\n') {
      this.gather_here_documents();
      return { type: TokenType.NEWLINE, value: '\n', line: startLine };
    }

    // ── Two-character operators ──
    const c2 = this.peek_char();

    if (c === '&' && c2 === '&') { this.shell_getc(); return { type: TokenType.AND_AND, value: '&&', line: startLine }; }
    if (c === '|' && c2 === '|') { this.shell_getc(); return { type: TokenType.OR_OR, value: '||', line: startLine }; }
    if (c === '|' && c2 === '&') { this.shell_getc(); return { type: TokenType.BAR_AND, value: '|&', line: startLine }; }
    if (c === ';' && c2 === ';') {
      this.shell_getc();
      if (this.peek_char() === '&') {
        this.shell_getc();
        return { type: TokenType.SEMI_SEMI_AND, value: ';;&', line: startLine };
      }
      return { type: TokenType.SEMI_SEMI, value: ';;', line: startLine };
    }
    if (c === ';' && c2 === '&') { this.shell_getc(); return { type: TokenType.SEMI_AND, value: ';&', line: startLine }; }

    // ── Redirections ──
    if (c === '>' && c2 === '>') { this.shell_getc(); return { type: TokenType.GREATER_GREATER, value: '>>', line: startLine }; }
    if (c === '>' && c2 === '|') { this.shell_getc(); return { type: TokenType.GREATER_BAR, value: '>|', line: startLine }; }
    if (c === '>' && c2 === '&') { this.shell_getc(); return { type: TokenType.GREATER_AND, value: '>&', line: startLine }; }
    if (c === '<' && c2 === '<') {
      this.shell_getc();
      const c3 = this.peek_char();
      if (c3 === '-') { this.shell_getc(); return { type: TokenType.LESS_LESS_MINUS, value: '<<-', line: startLine }; }
      if (c3 === '<') { this.shell_getc(); return { type: TokenType.LESS_LESS_LESS, value: '<<<', line: startLine }; }
      return { type: TokenType.LESS_LESS, value: '<<', line: startLine };
    }
    if (c === '<' && c2 === '&') { this.shell_getc(); return { type: TokenType.LESS_AND, value: '<&', line: startLine }; }
    if (c === '<' && c2 === '>') { this.shell_getc(); return { type: TokenType.LESS_GREATER, value: '<>', line: startLine }; }
    if (c === '&' && c2 === '>') {
      this.shell_getc();
      if (this.peek_char() === '>') {
        this.shell_getc();
        return { type: TokenType.AND_GREATER_GREATER, value: '&>>', line: startLine };
      }
      return { type: TokenType.AND_GREATER, value: '&>', line: startLine };
    }

    // ── Single-character tokens ──
    if (c === '|') return { type: TokenType.PIPE, value: '|', line: startLine };
    if (c === '&') return { type: TokenType.AMP, value: '&', line: startLine };
    if (c === ';') return { type: TokenType.SEMI, value: ';', line: startLine };
    if (c === '>' && c2 !== '(') return { type: TokenType.WORD, value: '>', line: startLine };
    if (c === '<' && c2 !== '(') return { type: TokenType.WORD, value: '<', line: startLine };
    if (c === '(') return { type: TokenType.LPAREN, value: '(', line: startLine };
    if (c === ')') return { type: TokenType.RPAREN, value: ')', line: startLine };

    // ── Word reading ──
    // Push back the character so word reading starts fresh
    this.shell_ungetc();
    const ch = this.shell_getc();
    let word = '';
    let isNum = true;
    let quoted = false;

    // Start with the character we already consumed
    word += ch;
    if (ch < '0' || ch > '9') isNum = false;

    // Handle quotes at start
    if (ch === '\'' || ch === '"') {
      quoted = true;
      this.shell_ungetc();
      word = '';
      // Fall through to word reading below
    } else if (ch === '\\') {
      // Backslash at start of word
      quoted = true;
      const next = this.shell_getc();
      if (next === '\n') {
        // Line continuation — skip and re-read
        return this.read_token();
      }
      word = '\\' + next;
    } else if (ch === '$') {
      word = this.read_dollar_expansion() ?? '$';
    } else if (ch === '`') {
      quoted = true;
      word = this.read_backtick_word();
    } else if ((ch === '<' || ch === '>') && this.peek_char() === '(') {
      this.shell_getc();
      word = this.read_process_substitution(ch);
    }

    // Continue reading word
    if (ch === '\'' || ch === '"') {
      // Start over with quote handling
    }

    while (true) {
      const nc = this.peek_char();
      const startsProcessSubstitution = (nc === '<' || nc === '>')
        && this.input[this.pos + 1] === '(';
      if (startsProcessSubstitution) {
        this.shell_getc();
        this.shell_getc();
        word += this.read_process_substitution(nc);
        isNum = false;
        continue;
      }
      if (nc === '' || nc === ' ' || nc === '\t' || nc === '\n'
          || nc === '|' || nc === '&' || nc === ';'
          || nc === ')' || nc === '(' || nc === '#') {
        break;
      }
      // Redirect chars break the word if at start of a redirect context
      if ((nc === '>' || nc === '<') && word.length > 0) {
        // Check if this is a digit>file redirect
        if (is_all_digits(word)) {
          // This is a file descriptor number before a redirect
          break;
        }
        break;
      }
      if (nc === '}' && this._allowReserved && word === '') {
        this.shell_getc();
        word = '}';
        break;
      }

      this.shell_getc();

      if (nc === '\\') {
        // Windows drive-letter heuristic: when the word so far is a drive
        // prefix (e.g. `C:`, `C:\foo`), treat the backslash as a literal
        // path separator rather than a shell escape. On Windows we accept
        // both `/` and `\` as separators — applied at the lex stage so
        // `cd C:\test\bin` survives to the cd builtin intact.
        //
        // Key difference from a standard escape: we do NOT consume the
        // next character, so the outer loop still sees word terminators
        // like `;` or space after the backslash (e.g. `cd C:\; foo`).
        if (starts_with_windows_drive_prefix(word)) {
          word += '\\\\'; // stored \\ → quote_removal → literal \
          continue;
        }
        quoted = true;
        const escaped = this.shell_getc();
        if (escaped === '\n') continue; // line continuation
        word += '\\' + escaped;
        continue;
      }

      if (nc === '\'') {
        quoted = true;
        word += '\'';
        while (true) {
          const qc = this.shell_getc();
          if (qc === '') { this.warnings.push('unexpected EOF while looking for matching `\'\'`'); break; }
          if (qc === '\'') { word += qc; break; }
          word += qc;
        }
        continue;
      }

      if (nc === '"') {
        quoted = true;
        word += '"';
        while (true) {
          const qc = this.shell_getc();
          if (qc === '') { this.warnings.push('unexpected EOF while looking for matching `"`'); break; }
          if (qc === '"') { word += qc; break; }
          if (qc === '\\') {
            const esc = this.shell_getc();
            word += '\\' + esc;
            continue;
          }
          word += qc;
        }
        continue;
      }

      if (nc === '$') {
        const expansion = this.read_dollar_expansion();
        if (expansion !== null) {
          word += expansion;
          continue;
        }
      }

      if (nc === '`') {
        quoted = true;
        word += this.read_backtick_word();
        continue;
      }

      word += nc;
      if (nc < '0' || nc > '9') isNum = false;
    }

    if (word === '') return this.read_token(); // skip empty

    if (this._conditionalExpression) {
      if (word === ']]') {
        this.conditionalEndSeen = true;
        return { type: TokenType.COND_END, value: word, line: startLine };
      }
      if (word === '!') {
        return { type: TokenType.BANG, value: word, line: startLine };
      }
      const type = isNum && word.length > 0 ? TokenType.NUMBER : TokenType.WORD;
      const token = { type, value: word, line: startLine, quoted };
      this.conditionalWordTokens.push(token);
      return token;
    }

    // ── Check for reserved words ──
    if (this._allowReserved) {
      const rw = RESERVED_WORDS[word];
      if (rw !== undefined) {
        return { type: rw, value: word, line: startLine };
      }
    }

    // ── Check for assignment word ──
    if (assignment_word(word)) {
      return { type: TokenType.ASSIGNMENT_WORD, value: word, line: startLine, quoted };
    }

    // ── NUMBER or WORD ──
    const tt = isNum && word.length > 0 ? TokenType.NUMBER : TokenType.WORD;
    return { type: tt, value: word, line: startLine, quoted };
  }

  /** Register a here-document to be collected at the next newline */
  registerHereDoc(redirect: Redirect, eof: string, strip: boolean, quoted: boolean): void {
    this.pendingHereDocs.push({ redirect, eof, strip, quoted });
  }
}

// ── Parser (recursive descent) ──

export class Parser {
  private lexer: Lexer;
  private _consumedAllInput = false;
  warnings: string[] = [];

  constructor(input: string) {
    this.lexer = new Lexer(input);
  }

  get consumedAllInput(): boolean {
    return this._consumedAllInput;
  }

  parse(): Command | null {
    this._consumedAllInput = false;
    try {
      const cmd = this.parse_compound_list();
      // Consume optional trailing terminators
      this.skip_newlines();
      const tok = this.lexer.next_token();
      if (tok.type !== TokenType.EOF) {
        this.lexer.unget_token(tok);
      } else {
        this._consumedAllInput = true;
      }
      this.warnings.push(...this.lexer.warnings);
      return cmd;
    } catch (e: unknown) {
      this.warnings.push(...this.lexer.warnings);
      this.warnings.push('Parse error: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }

  private peek(): Token {
    const tok = this.lexer.next_token();
    this.lexer.unget_token(tok);
    return tok;
  }

  private expect(type: TokenType, what: string): Token {
    const tok = this.lexer.next_token();
    if (tok.type !== type) {
      throw new Error(`Expected ${what} but got '${tok.value}' (line ${tok.line})`);
    }
    return tok;
  }

  private skip_newlines(): void {
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type !== TokenType.NEWLINE) {
        this.lexer.unget_token(tok);
        return;
      }
    }
  }

  /** compound_list → newline_list list1 (terminator newline_list list1)* */
  private parse_compound_list(): Command {
    this.skip_newlines();
    let cmd = this.parse_list1();
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type === TokenType.NEWLINE || tok.type === TokenType.SEMI) {
        this.skip_newlines();
        const next = this.peek();
        if (this.is_command_start(next)) {
          const right = this.parse_list1();
          cmd = command_connect(cmd, right, SEMI);
        }
      } else if (tok.type === TokenType.AMP) {
        this.skip_newlines();
        const next = this.peek();
        const right = this.is_command_start(next) ? this.parse_list1() : null;
        cmd = connect_async_list(cmd, right, AMP);
      } else {
        this.lexer.unget_token(tok);
        break;
      }
    }
    return cmd;
  }

  /** list1 → pipeline_command ((AND_AND|OR_OR) newline_list pipeline_command)* */
  private parse_list1(): Command {
    let cmd = this.parse_pipeline_command();
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type === TokenType.AND_AND) {
        this.skip_newlines();
        const right = this.parse_pipeline_command();
        cmd = command_connect(cmd, right, AND_AND);
      } else if (tok.type === TokenType.OR_OR) {
        this.skip_newlines();
        const right = this.parse_pipeline_command();
        cmd = command_connect(cmd, right, OR_OR);
      } else {
        this.lexer.unget_token(tok);
        break;
      }
    }
    return cmd;
  }

  /** pipeline_command → BANG? pipeline */
  private parse_pipeline_command(): Command {
    const tok = this.lexer.next_token();
    if (tok.type === TokenType.BANG) {
      const cmd = this.parse_pipeline();
      cmd.flags |= CMD_INVERT_RETURN;
      return cmd;
    }
    if (tok.type === TokenType.TIME) {
      // Just skip 'time' — not relevant for dry-run
      return this.parse_pipeline_command();
    }
    this.lexer.unget_token(tok);
    return this.parse_pipeline();
  }

  /** pipeline → command (('|'|'|&') newline_list command)* */
  private parse_pipeline(): Command {
    let cmd = this.parse_command();
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type === TokenType.PIPE) {
        this.skip_newlines();
        const right = this.parse_command();
        cmd = command_connect(cmd, right, PIPE);
      } else if (tok.type === TokenType.BAR_AND) {
        this.skip_newlines();
        const right = this.parse_command();
        cmd = command_connect(cmd, right, BAR_AND);
      } else {
        this.lexer.unget_token(tok);
        break;
      }
    }
    return cmd;
  }

  /** command → shell_command redirect_list? | function_def | simple_command */
  private parse_command(): Command {
    const tok = this.peek();

    // Shell commands
    if (tok.type === TokenType.IF) return this.parse_if_command_with_redirects();
    if (tok.type === TokenType.FOR) return this.parse_for_command_with_redirects();
    if (tok.type === TokenType.WHILE) return this.parse_while_command_with_redirects();
    if (tok.type === TokenType.UNTIL) return this.parse_until_command_with_redirects();
    if (tok.type === TokenType.CASE) return this.parse_case_command_with_redirects();
    if (tok.type === TokenType.LBRACE) return this.parse_group_command_with_redirects();
    if (tok.type === TokenType.LPAREN) {
      const start = this.lexer.next_token();
      const expression = this.lexer.tryReadArithmeticCommand();
      if (expression !== null) {
        set_line_number(start.line);
        return this.parse_shell_command_with_redirects(() =>
          make_arith_command(make_word(expression, W_QUOTED), start.line));
      }
      this.lexer.unget_token(start);
      return this.parse_subshell_with_redirects();
    }
    if (tok.type === TokenType.FUNCTION) return this.parse_function_def();
    if (tok.type === TokenType.WORD && tok.value === '[[') {
      return this.parse_cond_command_with_redirects();
    }

    // Check for function definition: WORD () compound_command
    if (tok.type === TokenType.WORD || tok.type === TokenType.ASSIGNMENT_WORD) {
      return this.parse_simple_command_or_function();
    }

    // NUMBER could be fd redirect or just a word
    if (tok.type === TokenType.NUMBER) {
      return this.parse_simple_command_or_function();
    }

    throw new Error(`Unexpected token '${tok.value}' at line ${tok.line}`);
  }

  private parse_shell_command_with_redirects(parseFn: () => Command): Command {
    const cmd = parseFn();
    cmd.redirects = this.parse_redirect_list(cmd.redirects);
    return cmd;
  }

  private parse_if_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_if_command());
  }

  private parse_for_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_for_command());
  }

  private parse_while_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_while_command());
  }

  private parse_until_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_until_command());
  }

  private parse_case_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_case_command());
  }

  private parse_group_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_group_command());
  }

  private parse_subshell_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_subshell());
  }

  private parse_cond_command_with_redirects(): Command {
    return this.parse_shell_command_with_redirects(() => this.parse_cond_command());
  }

  // ── [[ conditional expression ]] ──

  private parse_cond_command(): Command {
    const start = this.lexer.next_token();
    if (start.type !== TokenType.WORD || start.value !== '[[') {
      throw new Error(`Expected '[[' but got '${start.value}' (line ${start.line})`);
    }
    set_line_number(start.line);
    this.lexer.conditionalExpression = true;
    let expression: CondNode;
    try {
      expression = this.parse_cond_or();
      this.expect(TokenType.COND_END, ']]');
      this.lexer.takeConditionalWords();
    } catch (error: unknown) {
      if (!this.lexer.hasSeenConditionalEnd) {
        let token: Token;
        do {
          token = this.lexer.next_token();
        } while (token.type !== TokenType.COND_END && token.type !== TokenType.EOF);
      }
      expression = make_cond_node(
        COND_UNKNOWN,
        null,
        null,
        null,
        start.line,
      );
      expression.words = this.lexer.takeConditionalWords();
      this.warnings.push(
        `conditional expression at line ${start.line} widened to unknown: `
        + (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      this.lexer.conditionalExpression = false;
    }
    return make_cond_command(expression, start.line);
  }

  private parse_cond_or(): CondNode {
    let node = this.parse_cond_and();
    while (true) {
      const token = this.lexer.next_token();
      if (token.type !== TokenType.OR_OR) {
        this.lexer.unget_token(token);
        return node;
      }
      node = make_cond_node(
        COND_OR,
        null,
        node,
        this.parse_cond_and(),
        token.line,
      );
    }
  }

  private parse_cond_and(): CondNode {
    let node = this.parse_cond_term();
    while (true) {
      const token = this.lexer.next_token();
      if (token.type !== TokenType.AND_AND) {
        this.lexer.unget_token(token);
        return node;
      }
      node = make_cond_node(
        COND_AND,
        null,
        node,
        this.parse_cond_term(),
        token.line,
      );
    }
  }

  private parse_cond_term(): CondNode {
    this.skip_newlines();
    const token = this.lexer.next_token();

    if (token.type === TokenType.LPAREN) {
      const nested = this.parse_cond_or();
      this.expect(TokenType.RPAREN, ')');
      this.skip_newlines();
      return make_cond_node(COND_EXPR, null, nested, null, token.line);
    }

    if (token.type === TokenType.BANG) {
      const nested = this.parse_cond_term();
      nested.flags ^= CMD_INVERT_RETURN;
      return nested;
    }

    const first = this.conditionalTokenWord(token);
    if (!first) {
      throw new Error(
        `Unexpected token '${token.value}' in conditional expression (line ${token.line})`,
      );
    }

    if (CONDITIONAL_UNARY_OPERATORS.has(first.word)) {
      const operandToken = this.lexer.next_token();
      const operand = this.conditionalTokenWord(operandToken);
      if (!operand) {
        throw new Error(
          `Expected operand for '${first.word}' but got '${operandToken.value}' `
          + `(line ${operandToken.line})`,
        );
      }
      this.skip_newlines();
      const term = make_cond_node(
        COND_TERM,
        operand,
        null,
        null,
        operandToken.line,
      );
      return make_cond_node(
        COND_UNARY,
        first,
        term,
        null,
        token.line,
      );
    }

    const left = make_cond_node(COND_TERM, first, null, null, token.line);
    const operatorToken = this.lexer.next_token();
    if (operatorToken.type === TokenType.COND_END
        || operatorToken.type === TokenType.AND_AND
        || operatorToken.type === TokenType.OR_OR
        || operatorToken.type === TokenType.RPAREN) {
      this.lexer.unget_token(operatorToken);
      return make_cond_node(
        COND_UNARY,
        make_word('-n'),
        left,
        null,
        token.line,
      );
    }

    const operator = this.conditionalTokenWord(operatorToken);
    if (!operator || !CONDITIONAL_BINARY_OPERATORS.has(operator.word)) {
      throw new Error(
        `Expected conditional binary operator but got '${operatorToken.value}' `
        + `(line ${operatorToken.line})`,
      );
    }
    const rightToken = this.lexer.next_token();
    const rightWord = this.conditionalTokenWord(rightToken);
    if (!rightWord) {
      throw new Error(
        `Expected right operand for '${operator.word}' but got '${rightToken.value}' `
        + `(line ${rightToken.line})`,
      );
    }
    this.skip_newlines();
    return make_cond_node(
      COND_BINARY,
      operator,
      left,
      make_cond_node(COND_TERM, rightWord, null, null, rightToken.line),
      token.line,
    );
  }

  private conditionalTokenWord(token: Token): ReturnType<typeof make_word> | null {
    if (token.type === TokenType.WORD || token.type === TokenType.NUMBER) {
      return make_word(token.value, token_word_flags(token));
    }
    if (token.type === TokenType.BANG) return make_word('!');
    return null;
  }

  // ── if_command ──

  private parse_if_command(): Command {
    const startLine = this.lexer.currentLine;
    this.expect(TokenType.IF, 'if');
    set_line_number(startLine);
    const test = this.parse_compound_list();
    this.expect(TokenType.THEN, 'then');
    const true_case = this.parse_compound_list();
    let false_case: Command | null = null;

    const tok = this.lexer.next_token();
    if (tok.type === TokenType.ELIF) {
      this.lexer.unget_token({ type: TokenType.IF, value: 'if', line: tok.line });
      false_case = this.parse_if_command();
    } else if (tok.type === TokenType.ELSE) {
      false_case = this.parse_compound_list();
      this.expect(TokenType.FI, 'fi');
    } else if (tok.type === TokenType.FI) {
      // no else
    } else {
      throw new Error(`Expected 'elif', 'else', or 'fi' but got '${tok.value}' (line ${tok.line})`);
    }

    return make_if_command(test, true_case, false_case);
  }

  // ── for_command ──

  private parse_for_command(): Command {
    const startLine = this.lexer.currentLine;
    this.expect(TokenType.FOR, 'for');
    set_line_number(startLine);
    this.lexer.allowReserved = false;
    const nameTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    const name = make_word(nameTok.value, token_word_flags(nameTok));

    const map_list: WordList = [];

    const sep = this.lexer.next_token();
    if (sep.type === TokenType.IN) {
      // Read word list until ; or newline
      this.lexer.allowReserved = false;
      while (true) {
        const wt = this.lexer.next_token();
        if (wt.type === TokenType.SEMI || wt.type === TokenType.NEWLINE) break;
        if (wt.type === TokenType.EOF) break;
        map_list.push(make_word(wt.value, token_word_flags(wt)));
      }
      this.lexer.allowReserved = true;
      this.skip_newlines();
    } else if (sep.type === TokenType.SEMI || sep.type === TokenType.NEWLINE) {
      // for VAR; do ... — iterate over $@ (placeholder)
      this.skip_newlines();
    } else {
      this.lexer.unget_token(sep);
      this.skip_newlines();
    }

    this.expect(TokenType.DO, 'do');
    const action = this.parse_compound_list();
    this.expect(TokenType.DONE, 'done');

    return make_for_command(name, map_list, action, startLine);
  }

  // ── while_command ──

  private parse_while_command(): Command {
    this.expect(TokenType.WHILE, 'while');
    const test = this.parse_compound_list();
    this.expect(TokenType.DO, 'do');
    const action = this.parse_compound_list();
    this.expect(TokenType.DONE, 'done');
    return make_while_command(test, action);
  }

  // ── until_command ──

  private parse_until_command(): Command {
    this.expect(TokenType.UNTIL, 'until');
    const test = this.parse_compound_list();
    this.expect(TokenType.DO, 'do');
    const action = this.parse_compound_list();
    this.expect(TokenType.DONE, 'done');
    return make_until_command(test, action);
  }

  // ── case_command ──

  private parse_case_command(): Command {
    const startLine = this.lexer.currentLine;
    this.expect(TokenType.CASE, 'case');
    set_line_number(startLine);
    this.lexer.allowReserved = false;
    const wordTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    const word = make_word(wordTok.value, token_word_flags(wordTok));

    this.skip_newlines();
    this.expect(TokenType.IN, 'in');
    this.skip_newlines();

    let clauses: PatternList | null = null;
    let lastClause: PatternList | null = null;

    while (true) {
      const tok = this.peek();
      if (tok.type === TokenType.ESAC) {
        this.lexer.next_token();
        break;
      }

      // Parse pattern: WORD ('|' WORD)* ')'
      const patterns: WordList = [];
      // Optional leading (
      const maybeParen = this.lexer.next_token();
      if (maybeParen.type !== TokenType.LPAREN) {
        this.lexer.unget_token(maybeParen);
      }

      this.lexer.allowReserved = false;
      while (true) {
        const pt = this.lexer.next_token();
        patterns.push(make_word(pt.value, token_word_flags(pt)));
        const sep = this.lexer.next_token();
        if (sep.type === TokenType.PIPE) continue;
        if (sep.value === ')') break;
        this.lexer.unget_token(sep);
        break;
      }
      this.lexer.allowReserved = true;

      // Parse action (compound_list until ;; or esac)
      this.skip_newlines();
      let action: Command | null = null;
      const next = this.peek();
      if (next.type !== TokenType.SEMI_SEMI && next.type !== TokenType.SEMI_AND
          && next.type !== TokenType.SEMI_SEMI_AND && next.type !== TokenType.ESAC) {
        action = this.parse_compound_list();
      }

      const clause = make_pattern_list(patterns, action);
      if (lastClause) lastClause.next = clause;
      else clauses = clause;
      lastClause = clause;

      // Consume ;;, ;&, or ;;&
      const termTok = this.lexer.next_token();
      if (termTok.type === TokenType.SEMI_SEMI || termTok.type === TokenType.SEMI_AND
          || termTok.type === TokenType.SEMI_SEMI_AND) {
        if (termTok.type === TokenType.SEMI_AND) {
          clause.flags |= CASEPAT_FALLTHROUGH;
        } else if (termTok.type === TokenType.SEMI_SEMI_AND) {
          clause.flags |= CASEPAT_TESTNEXT;
        }
        this.skip_newlines();
      } else if (termTok.type === TokenType.ESAC) {
        break;
      } else {
        this.lexer.unget_token(termTok);
        // Try to see if next is ESAC
        this.skip_newlines();
        const check = this.peek();
        if (check.type === TokenType.ESAC) {
          this.lexer.next_token();
          break;
        }
      }
    }

    return make_case_command(word, clauses, startLine);
  }

  // ── group_command ──

  private parse_group_command(): Command {
    this.expect(TokenType.LBRACE, '{');
    const cmd = this.parse_compound_list();
    this.expect(TokenType.RBRACE, '}');
    return make_group_command(cmd);
  }

  // ── subshell ──

  private parse_subshell(): Command {
    this.expect(TokenType.LPAREN, '(');
    const cmd = this.parse_compound_list();
    this.expect(TokenType.RPAREN, ')');
    return make_subshell_command(cmd);
  }

  // ── function_def ──

  private parse_function_def(): Command {
    this.expect(TokenType.FUNCTION, 'function');
    this.lexer.allowReserved = false;
    const nameTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    const name = make_word(nameTok.value, token_word_flags(nameTok));

    // Optional ()
    const tok = this.lexer.next_token();
    if (tok.type === TokenType.LPAREN) {
      this.expect(TokenType.RPAREN, ')');
      this.skip_newlines();
    } else {
      this.lexer.unget_token(tok);
      this.skip_newlines();
    }

    const body = this.parse_command();
    return make_function_def(name, body);
  }

  // ── simple_command or word() function ──

  private parse_simple_command_or_function(): Command {
    const first = this.lexer.next_token();
    // Check if this is a function definition: WORD '(' ')' compound_command
    if (first.type === TokenType.WORD) {
      const tok2 = this.lexer.next_token();
      if (tok2.type === TokenType.LPAREN) {
        const tok3 = this.lexer.next_token();
        if (tok3.type === TokenType.RPAREN) {
          this.skip_newlines();
          const name = make_word(first.value, token_word_flags(first));
          const body = this.parse_command();
          return make_function_def(name, body);
        }
        this.lexer.unget_token(tok3);
      }
      this.lexer.unget_token(tok2);
    }
    this.lexer.unget_token(first);
    return this.parse_simple_command();
  }

  // ── simple_command ──

  private parse_simple_command(): Command {
    const cmd = make_simple_command();
    cmd.line = this.lexer.currentLine;
    set_line_number(cmd.line);

    while (true) {
      const tok = this.lexer.next_token();

      // Check for redirect without explicit fd (must be before WORD check
      // since single > and < are returned as WORD tokens)
      if (this.is_redirect_token(tok)) {
        this.lexer.unget_token(tok);
        cmd.redirects = this.parse_single_redirect(cmd.redirects, -1);
        continue;
      }

      if (tok.type === TokenType.WORD || tok.type === TokenType.ASSIGNMENT_WORD
          || tok.type === TokenType.NUMBER) {
        // Check if followed by a redirect (NUMBER > file)
        if (tok.type === TokenType.NUMBER || (tok.type === TokenType.WORD && is_all_digits(tok.value))) {
          const next = this.peek();
          if (this.is_redirect_start(next)) {
            const fd = parseInt(tok.value, 10);
            cmd.redirects = this.parse_single_redirect(cmd.redirects, fd);
            continue;
          }
        }
        const flags = token_word_flags(tok) | (tok.type === TokenType.ASSIGNMENT_WORD ? W_ASSIGNMENT : 0);
        add_element_to_simple_command(cmd, make_word(tok.value, flags));
        continue;
      }

      // End of simple command
      this.lexer.unget_token(tok);
      break;
    }

    return clean_simple_command(cmd);
  }

  // ── Redirections ──

  private is_redirect_start(tok: Token): boolean {
    return this.is_redirect_token(tok);
  }

  private is_redirect_token(tok: Token): boolean {
    switch (tok.type) {
      case TokenType.GREATER_GREATER:
      case TokenType.LESS_LESS:
      case TokenType.LESS_LESS_MINUS:
      case TokenType.LESS_LESS_LESS:
      case TokenType.LESS_AND:
      case TokenType.GREATER_AND:
      case TokenType.AND_GREATER:
      case TokenType.AND_GREATER_GREATER:
      case TokenType.LESS_GREATER:
      case TokenType.GREATER_BAR:
        return true;
      default:
        if (tok.type === TokenType.WORD && (tok.value === '>' || tok.value === '<')) return true;
        return false;
    }
  }

  private parse_redirect_list(existing: Redirect | null): Redirect | null {
    while (true) {
      const tok = this.peek();
      // Check for N> pattern
      if ((tok.type === TokenType.NUMBER || (tok.type === TokenType.WORD && is_all_digits(tok.value)))) {
        const next_next = this.lexer.next_token();
        const after = this.peek();
        this.lexer.unget_token(next_next);
        if (this.is_redirect_token(after)) {
          this.lexer.next_token(); // consume the number
          const fd = parseInt(next_next.value, 10);
          existing = this.parse_single_redirect(existing, fd);
          continue;
        }
        break;
      }
      if (!this.is_redirect_token(tok)) break;
      existing = this.parse_single_redirect(existing, -1);
    }
    return existing;
  }

  private parse_single_redirect(existing: Redirect | null, fd: number): Redirect {
    const opTok = this.lexer.next_token();
    let instruction: RInstruction;
    const defaultInFd = fd >= 0 ? fd : 0;
    const defaultOutFd = fd >= 0 ? fd : 1;

    switch (opTok.type) {
      case TokenType.GREATER_GREATER:
        instruction = 'r_appending_to';
        break;
      case TokenType.LESS_LESS:
        instruction = 'r_reading_until';
        break;
      case TokenType.LESS_LESS_MINUS:
        instruction = 'r_deblank_reading_until';
        break;
      case TokenType.LESS_LESS_LESS:
        instruction = 'r_reading_string';
        break;
      case TokenType.LESS_AND:
        instruction = 'r_duplicating_input';
        break;
      case TokenType.GREATER_AND:
        instruction = 'r_duplicating_output';
        break;
      case TokenType.AND_GREATER:
        instruction = 'r_err_and_out';
        break;
      case TokenType.AND_GREATER_GREATER:
        instruction = 'r_append_err_and_out';
        break;
      case TokenType.LESS_GREATER:
        instruction = 'r_input_output';
        break;
      case TokenType.GREATER_BAR:
        instruction = 'r_output_force';
        break;
      default:
        // Single > or <
        if (opTok.value === '>') {
          instruction = 'r_output_direction';
        } else {
          instruction = 'r_input_direction';
        }
        break;
    }

    // Read the target word
    this.lexer.allowReserved = false;
    const targetTok = this.lexer.next_token();
    this.lexer.allowReserved = true;

    // Handle here-docs
    if (instruction === 'r_reading_until' || instruction === 'r_deblank_reading_until') {
      const strip = instruction === 'r_deblank_reading_until';
      // Determine the EOF marker (strip quotes)
      let eof = targetTok.value;
      const quoted = eof.includes("'") || eof.includes('"') || eof.includes('\\');
      eof = strip_quoting_chars(eof);

      const source = make_redirectee(defaultInFd);
      const redir_target = make_redirectee(make_word(targetTok.value, token_word_flags(targetTok)));
      const redir = make_redirection(source, instruction, redir_target);
      redir.here_doc_eof = eof;
      redir.here_doc_quoted = quoted;

      this.lexer.registerHereDoc(redir, eof, strip, quoted);

      return append_redirect(existing, redir);
    }

    // Handle >&N, <&N (fd duplication)
    if (instruction === 'r_duplicating_input' || instruction === 'r_duplicating_output') {
      if (targetTok.value === '-') {
        const src_fd = instruction === 'r_duplicating_input' ? defaultInFd : defaultOutFd;
        const source = make_redirectee(src_fd);
        const redir = make_redirection(source, 'r_close_this', make_redirectee(-1));
        return append_redirect(existing, redir);
      }
      if (is_all_digits(targetTok.value)) {
        const src_fd = instruction === 'r_duplicating_input' ? defaultInFd : defaultOutFd;
        const source = make_redirectee(src_fd);
        const redir = make_redirection(source, instruction, make_redirectee(parseInt(targetTok.value, 10)));
        return append_redirect(existing, redir);
      }
      // Word: >&WORD
      const newInstr: RInstruction = instruction === 'r_duplicating_input'
        ? 'r_duplicating_input_word'
        : 'r_duplicating_output_word';
      const src_fd = instruction === 'r_duplicating_input' ? defaultInFd : defaultOutFd;
      const source = make_redirectee(src_fd);
      const redir = make_redirection(source, newInstr, make_redirectee(make_word(targetTok.value, token_word_flags(targetTok))));
      return append_redirect(existing, redir);
    }

    // Normal redirect to filename
    const isOutput = instruction === 'r_output_direction' || instruction === 'r_appending_to'
      || instruction === 'r_output_force' || instruction === 'r_err_and_out'
      || instruction === 'r_append_err_and_out';
    const srcFd = isOutput ? defaultOutFd : defaultInFd;

    const source = make_redirectee(srcFd);
    const redirectee = make_redirectee(make_word(targetTok.value, token_word_flags(targetTok)));
    const redir = make_redirection(source, instruction, redirectee);
    return append_redirect(existing, redir);
  }

  // ── Helpers ──

  private is_command_start(tok: Token): boolean {
    switch (tok.type) {
      case TokenType.WORD:
      case TokenType.ASSIGNMENT_WORD:
      case TokenType.NUMBER:
      case TokenType.IF:
      case TokenType.FOR:
      case TokenType.WHILE:
      case TokenType.UNTIL:
      case TokenType.CASE:
      case TokenType.LBRACE:
      case TokenType.LPAREN:
      case TokenType.FUNCTION:
      case TokenType.BANG:
      case TokenType.TIME:
        return true;
      default:
        return false;
    }
  }
}

/** Parse a shell script into an AST */
export function parse(input: string): { ast: Command | null; warnings: string[] } {
  const parser = new Parser(input);
  const ast = parser.parse();
  return { ast, warnings: parser.warnings };
}

/** Internal grouping helper: require the parser to consume the complete input. */
export function parseComplete(
  input: string,
): { ast: Command | null; warnings: string[]; complete: boolean } {
  const parser = new Parser(input);
  const ast = parser.parse();
  return {
    ast,
    warnings: parser.warnings,
    complete: parser.consumedAllInput,
  };
}
