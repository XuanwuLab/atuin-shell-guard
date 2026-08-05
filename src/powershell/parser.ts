// parser.ts — PowerShell command parser for dry-run analysis.
//
// This mirrors the reference Parser.ParseInput shape closely enough for the
// dry-run domain: ScriptBlockAst -> statement blocks, PipelineAst -> command
// elements, CommandAst -> command elements plus FileRedirectionAst entries.

import type { PsBlock, PsCommand, PsPipeline, PsRedirection, PsScript, PsStatement, PsWord } from './ast.js';
import { tokenize, type PsToken, type PsTokenKind } from './tokenizer.js';

interface ParseResult {
  ast: PsScript;
  warnings: string[];
}

export function parsePowerShell(script: string): ParseResult {
  const { tokens, warnings } = tokenize(script);
  const parser = new Parser(tokens, warnings);
  return parser.parseScript();
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: PsToken[],
    private readonly warnings: string[],
  ) {}

  parseScript(): ParseResult {
    const statements = this.parseStatementList(false);
    return { ast: { type: 'script', statements }, warnings: this.warnings };
  }

  private parseStatementList(stopOnRightBrace: boolean): PsStatement[] {
    const statements: PsStatement[] = [];
    while (!this.at('eof')) {
      this.skipSeparators();
      if (stopOnRightBrace && this.peek().text === '}') break;
      if (this.at('eof')) break;
      const startPos = this.pos;
      const stmt = this.parseStatement();
      if (stmt) statements.push(stmt);
      if (this.pos === startPos) {
        this.warnUnexpectedAndAdvance();
      }
      this.skipSeparators();
    }
    return statements;
  }

  private parseStatement(): PsStatement | null {
    if (this.peek().text === '}') return null;
    if (this.peek().text === ')') return null;
    const keyword = this.peekWordLower();
    if (keyword === 'if' || keyword === 'elseif' || keyword === 'else' ||
        keyword === 'foreach' || keyword === 'for' || keyword === 'while' ||
        keyword === 'do' || keyword === 'switch' || keyword === 'try' ||
        keyword === 'catch' || keyword === 'finally') {
      return this.parseBlock(keyword);
    }
    if (this.peek().text === '(') return this.parseParenthesizedStatement();
    if (this.peek().text === '{') return this.parseBareScriptBlock();
    return this.parsePipeline('statement');
  }

  private parseParenthesizedStatement(): PsBlock {
    const line = this.peek().line;
    const tokens = this.captureBalanced('(', ')');
    const eofLine = tokens[tokens.length - 1]?.line ?? line;
    const inner = new Parser([
      ...tokens,
      { kind: 'eof', text: '', line: eofLine, quoted: false, expandable: false },
    ], this.warnings).parseScript();
    return { type: 'block', keyword: 'subexpression', body: inner.ast.statements, line, fuzzy: true };
  }

  private parseBlock(keyword: string): PsBlock {
    const start = this.advance();
    if (keyword === 'if') return this.parseIfBlock(start.line);
    if (keyword === 'try') return this.parseTryBlock(start.line);
    if (keyword === 'do') return this.parseDoBlock(start.line);
    if (keyword === 'switch') return this.parseSwitchBlock(start.line);
    let variable: string | undefined;
    let values: PsWord[] | undefined;
    let conditions: PsStatement[][] | undefined;
    if (keyword !== 'else' && this.peek().text === '(') {
      const condition = this.captureBalanced('(', ')');
      if (keyword === 'foreach') {
        const parsed = this.parseForeachCondition(condition);
        variable = parsed.variable;
        values = parsed.values;
      } else {
        conditions = [this.parseCapturedStatements(condition, start.line)];
      }
    }
    const body = this.peek().text === '{' ? this.parseBraceBody() : [];
    return { type: 'block', keyword, body, conditions, variable, values, line: start.line, fuzzy: true };
  }

  private parseTryBlock(line: number): PsBlock {
    const body = this.peek().text === '{' ? this.parseBraceBody() : [];
    while (true) {
      this.skipSeparators();
      const keyword = this.peekWordLower();
      if (keyword !== 'catch' && keyword !== 'finally') break;
      this.advance();
      if (this.peek().text === '(') this.skipBalanced('(', ')');
      if (this.peek().text === '{') body.push(...this.parseBraceBody());
    }
    return { type: 'block', keyword: 'try', body, line, fuzzy: true };
  }

  private parseDoBlock(line: number): PsBlock {
    const body = this.peek().text === '{' ? this.parseBraceBody() : [];
    let conditions: PsStatement[][] | undefined;
    this.skipSeparators();
    const keyword = this.peekWordLower();
    if (keyword === 'while' || keyword === 'until') {
      this.advance();
      if (this.peek().text === '(') {
        conditions = [this.parseCapturedStatements(this.captureBalanced('(', ')'), line)];
      }
    }
    return { type: 'block', keyword: 'do', body, conditions, line, fuzzy: true };
  }

  private parseSwitchBlock(line: number): PsBlock {
    let conditions: PsStatement[][] | undefined;
    if (this.peek().text === '(') {
      conditions = [this.parseCapturedStatements(this.captureBalanced('(', ')'), line)];
    }
    const body: PsStatement[] = [];
    if (this.peek().text !== '{') return { type: 'block', keyword: 'switch', body, conditions, line, fuzzy: true };
    this.expectOperator('{');
    while (!this.at('eof') && this.peek().text !== '}') {
      this.skipSeparators();
      if (this.peek().text === '{') {
        body.push(...this.parseBraceBody());
      } else {
        this.advance();
      }
    }
    this.expectOperator('}');
    return { type: 'block', keyword: 'switch', body, conditions, line, fuzzy: true };
  }

  private parseIfBlock(line: number): PsBlock {
    const conditions: PsStatement[][] = [];
    if (this.peek().text === '(') {
      conditions.push(this.parseCapturedStatements(this.captureBalanced('(', ')'), line));
    }
    const body = this.peek().text === '{' ? this.parseBraceBody() : [];
    while (true) {
      this.skipSeparators();
      const keyword = this.peekWordLower();
      if (keyword === 'elseif') {
        const elseif = this.advance();
        if (this.peek().text === '(') {
          conditions.push(this.parseCapturedStatements(this.captureBalanced('(', ')'), elseif.line));
        }
        if (this.peek().text === '{') body.push(...this.parseBraceBody());
        continue;
      }
      if (keyword === 'else') {
        this.advance();
        if (this.peek().text === '{') body.push(...this.parseBraceBody());
      }
      break;
    }
    return { type: 'block', keyword: 'if', body, conditions, line, fuzzy: true };
  }

  private parseCapturedStatements(tokens: PsToken[], line: number): PsStatement[] {
    const eofLine = tokens[tokens.length - 1]?.line ?? line;
    return new Parser([
      ...tokens,
      { kind: 'eof', text: '', line: eofLine, quoted: false, expandable: false },
    ], this.warnings).parseScript().ast.statements;
  }

  private parseForeachCondition(tokens: PsToken[]): { variable?: string; values?: PsWord[] } {
    let variable: string | undefined;
    const values: PsWord[] = [];
    let inValues = false;
    for (const token of tokens) {
      if (!inValues && token.kind === 'variable') {
        variable = token.text;
        continue;
      }
      if (!inValues && token.kind === 'word' && token.text.toLowerCase() === 'in') {
        inValues = true;
        continue;
      }
      if (inValues && this.isCommandElement(token)) {
        values.push(this.wordFrom(token));
      }
    }
    return { variable, values };
  }

  private parseBareScriptBlock(): PsBlock {
    const line = this.peek().line;
    return { type: 'block', keyword: 'scriptblock', body: this.parseBraceBody(), line, fuzzy: true };
  }

  private parseBraceBody(): PsStatement[] {
    this.expectOperator('{');
    const body = this.parseStatementList(true);
    this.expectOperator('}');
    return body;
  }

  private parsePipeline(connector: PsPipeline['connector']): PsPipeline | null {
    const commands: PsCommand[] = [];
    const first = this.parseCommand();
    if (!first) return null;
    commands.push(first);

    while (this.peek().text === '|') {
      this.advance();
      const command = this.parseCommand();
      if (command) commands.push(command);
    }

    const line = commands[0]?.line ?? this.peek().line;
    const pipeline: PsPipeline = { type: 'pipeline', commands, connector, line };

    if (this.peek().text === '&&' || this.peek().text === '||') {
      const op = this.advance().text;
      const next = this.parsePipeline(op === '&&' ? 'and' : 'or');
      if (next) {
        return {
          type: 'pipeline',
          commands: [...pipeline.commands, ...next.commands],
          connector: next.connector,
          line,
        };
      }
    }

    return pipeline;
  }

  private parseCommand(): PsCommand | null {
    while (this.peek().text === ',') this.advance();
    const nameToken = this.peek();
    if (!this.isCommandElement(nameToken)) return null;
    const name = this.wordFrom(this.advance());
    const args: PsWord[] = [];
    const redirections: PsRedirection[] = [];

    while (!this.at('eof') && !this.isStatementBoundary(this.peek())) {
      const token = this.peek();
      if (this.isMergingRedirectionOperator(token.text)) {
        const op = this.advance();
        redirections.push({ kind: 'merge', op: op.text, line: op.line });
        continue;
      }
      if (this.isRedirectionOperator(token.text)) {
        const op = this.advance();
        const target = this.isCommandElement(this.peek()) ? this.wordFrom(this.advance()) : this.emptyWord(op.line);
        redirections.push({ kind: 'file', op: op.text, target, line: op.line });
        continue;
      }
      if (token.text === ',') {
        args.push({ text: ',', line: token.line, quoted: false, expandable: false, parameter: false });
        this.advance();
        continue;
      }
      if (this.isCommandElement(token) || token.text === '=') {
        args.push(this.wordFrom(this.advance()));
        continue;
      }
      if (token.text === '(') {
        this.skipBalanced('(', ')');
        args.push({ text: '<expression>', line: token.line, quoted: false, expandable: true, parameter: false });
        continue;
      }
      if (token.text === '{') {
        const scriptBlockBody = this.parseBraceBody();
        args.push({ text: '<scriptblock>', line: token.line, quoted: false, expandable: false, parameter: false, scriptBlockBody });
        continue;
      }
      this.advance();
    }

    return { type: 'command', name, args, redirections, line: name.line, fuzzy: false };
  }

  private skipBalanced(open: string, close: string): void {
    this.captureBalanced(open, close);
  }

  private captureBalanced(open: string, close: string): PsToken[] {
    const tokens: PsToken[] = [];
    let depth = 0;
    const start = this.peek();
    while (!this.at('eof')) {
      const t = this.advance();
      if (t.text === open) depth++;
      if (t.text === close) {
        depth--;
        if (depth <= 0) return tokens;
      }
      if (depth > 0 && t.text !== open) {
        tokens.push(t);
      }
    }
    if (depth > 0) this.warnings.push(`expected '${close}' for '${open}' at line ${start.line}`);
    return tokens;
  }

  private skipSeparators(): void {
    while (this.peek().kind === 'newline' || this.peek().text === ';') this.advance();
  }

  private isStatementBoundary(token: PsToken): boolean {
    if (token.kind === 'newline' || token.kind === 'eof') return true;
    return token.text === ';' || token.text === '|' || token.text === '}' || token.text === '&&' || token.text === '||';
  }

  private isCommandElement(token: PsToken): boolean {
    return token.kind === 'word' || token.kind === 'string' || token.kind === 'parameter' || token.kind === 'variable';
  }

  private isRedirectionOperator(op: string): boolean {
    if (op === '>' || op === '>>' || op === '*>' || op === '*>>') return true;
    if (op.length === 2 && op[1] === '>' && op[0] >= '1' && op[0] <= '6') return true;
    if (op.length === 3 && op[1] === '>' && op[2] === '>' && op[0] >= '1' && op[0] <= '6') return true;
    return false;
  }

  private isMergingRedirectionOperator(op: string): boolean {
    return op.length === 4 && (op[0] === '*' || (op[0] >= '1' && op[0] <= '6')) &&
      op[1] === '>' && op[2] === '&' && op[3] >= '1' && op[3] <= '6';
  }

  private wordFrom(token: PsToken): PsWord {
    return {
      text: token.text,
      line: token.line,
      quoted: token.quoted,
      expandable: token.expandable,
      parameter: token.kind === 'parameter',
      literalDollarOffsets: token.literalDollarOffsets,
    };
  }

  private emptyWord(line: number): PsWord {
    return { text: '', line, quoted: false, expandable: false, parameter: false };
  }

  private expectOperator(text: string): void {
    if (this.peek().text === text) {
      this.advance();
      return;
    }
    this.warnings.push(`expected '${text}' at line ${this.peek().line}`);
  }

  private warnUnexpectedAndAdvance(): void {
    const token = this.peek();
    if (token.kind === 'eof') return;
    this.warnings.push(`unexpected token '${token.text}' at line ${token.line}`);
    this.advance();
  }

  private peekWordLower(): string {
    const token = this.peek();
    if (token.kind !== 'word') return '';
    return token.text.toLowerCase();
  }

  private at(kind: PsTokenKind): boolean {
    return this.peek().kind === kind;
  }

  private peek(): PsToken {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): PsToken {
    const token = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }
}
