// tokenizer.ts — Tolerant PowerShell lexer.
//
// The structure follows the token boundaries used by PowerShell's
// System.Management.Automation parser: commands are built from command
// elements, file redirections are separate tokens, and expandable/verbatim
// strings preserve whether later expansion is allowed.

export type PsTokenKind =
  | 'word'
  | 'string'
  | 'parameter'
  | 'variable'
  | 'operator'
  | 'newline'
  | 'eof';

export interface PsToken {
  kind: PsTokenKind;
  text: string;
  line: number;
  quoted: boolean;
  expandable: boolean;
  literalDollarOffsets?: number[];
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r';
}

function isAsciiAlpha(c: string): boolean {
  if (c.length === 0) return false;
  const code = c.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(c: string): boolean {
  if (c.length === 0) return false;
  const code = c.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isNameChar(c: string): boolean {
  return isAsciiAlpha(c) || isAsciiDigit(c) || c === '_' || c === '?' || c === ':';
}

function isBoundary(c: string): boolean {
  return isWhitespace(c) || c === '\n' || c === ';' || c === '|' || c === '>' ||
    c === '<' || c === '{' || c === '}' || c === '(' || c === ')' || c === ',';
}

function isParameterStart(input: string, pos: number): boolean {
  const next = input[pos + 1] ?? '';
  return input[pos] === '-' && (isAsciiAlpha(next) || next === '?');
}

function isVariableStart(input: string, pos: number): boolean {
  const next = input[pos + 1] ?? '';
  return input[pos] === '$' && (isAsciiAlpha(next) || next === '_' || next === '{');
}

function isStreamDigit(c: string): boolean {
  return c >= '1' && c <= '6';
}

export function tokenize(script: string): { tokens: PsToken[]; warnings: string[] } {
  const tokens: PsToken[] = [];
  const warnings: string[] = [];
  let i = 0;
  let line = 1;

  const push = (
    kind: PsTokenKind,
    text: string,
    tokenLine: number,
    quoted = false,
    expandable = true,
    literalDollarOffsets?: number[],
  ) => {
    tokens.push({ kind, text, line: tokenLine, quoted, expandable, literalDollarOffsets });
  };

  while (i < script.length) {
    const c = script[i];
    if (isWhitespace(c)) { i++; continue; }
    if (c === '\n') { push('newline', '\n', line); line++; i++; continue; }
    if (c === '#') {
      while (i < script.length && script[i] !== '\n') i++;
      continue;
    }

    const tokenLine = line;
    const n1 = script[i + 1] ?? '';
    const n2 = script[i + 2] ?? '';
    if (c === '<' && n1 === '#') {
      i += 2;
      let terminated = false;
      while (i < script.length) {
        if (script[i] === '#' && script[i + 1] === '>') {
          i += 2;
          terminated = true;
          break;
        }
        if (script[i] === '\n') line++;
        i++;
      }
      if (!terminated) warnings.push(`unterminated block comment at line ${tokenLine}`);
      continue;
    }
    if ((c === '*' || isStreamDigit(c)) && n1 === '>' && n2 === '&' && isStreamDigit(script[i + 3] ?? '')) {
      push('operator', script.slice(i, i + 4), tokenLine);
      i += 4;
      continue;
    }
    if (c === '*' && n1 === '>' && n2 === '>') { push('operator', '*>>', tokenLine); i += 3; continue; }
    if (isStreamDigit(c) && n1 === '>' && n2 === '>') { push('operator', c + n1 + n2, tokenLine); i += 3; continue; }
    if (c === '&' && n1 === '&') { push('operator', '&&', tokenLine); i += 2; continue; }
    if (c === '|' && n1 === '|') { push('operator', '||', tokenLine); i += 2; continue; }
    if (c === '>' && n1 === '>') { push('operator', '>>', tokenLine); i += 2; continue; }
    if (c === '*' && n1 === '>') { push('operator', '*>', tokenLine); i += 2; continue; }
    if (isStreamDigit(c) && n1 === '>') { push('operator', c + n1, tokenLine); i += 2; continue; }
    if (c === ';' || c === '|' || c === '>' || c === '<' || c === '{' || c === '}' ||
        c === '(' || c === ')' || c === ',' || c === '=') {
      push('operator', c, tokenLine);
      i++;
      continue;
    }

    if (c === '@' && (n1 === '\'' || n1 === '"')) {
      const quote = n1;
      i += 2;
      while (script[i] === ' ' || script[i] === '\t' || script[i] === '\f' || script[i] === '\v') i++;
      if (script[i] === '\r' && script[i + 1] === '\n') {
        line++;
        i += 2;
      } else if (script[i] === '\n' || script[i] === '\r') {
        line++;
        i++;
      } else {
        warnings.push(`unexpected characters after here-string header at line ${tokenLine}`);
        while (i < script.length && script[i] !== '\r' && script[i] !== '\n') {
          if (script[i] === quote && script[i + 1] === '@') {
            i += 2;
            break;
          }
          i++;
        }
        push('string', '', tokenLine, true, quote === '"');
        continue;
      }
      let text = '';
      const literalDollarOffsets: number[] = [];
      let terminated = false;
      let atLineStart = true;
      while (i < script.length) {
        if (atLineStart && script[i] === quote && script[i + 1] === '@') {
          i += 2;
          terminated = true;
          break;
        }
        const ch = script[i];
        if (quote === '"' && ch === '`' && i + 1 < script.length) {
          const escaped = decodeBacktick(script[i + 1]);
          if (escaped === '$') literalDollarOffsets.push(text.length);
          text += escaped;
          if (script[i + 1] === '\n') line++;
          atLineStart = script[i + 1] === '\n' || script[i + 1] === '\r';
          i += 2;
          continue;
        }
        if (ch === '\r' && script[i + 1] === '\n') {
          text += '\r\n';
          line++;
          i += 2;
          atLineStart = true;
          continue;
        }
        if (ch === '\n' || ch === '\r') {
          line++;
          atLineStart = true;
        } else {
          atLineStart = false;
        }
        text += ch;
        i++;
      }
      if (terminated) {
        if (text.endsWith('\r\n')) text = text.slice(0, -2);
        else if (text.endsWith('\n') || text.endsWith('\r')) text = text.slice(0, -1);
      } else {
        warnings.push(`unterminated here-string at line ${tokenLine}`);
      }
      push('string', text, tokenLine, true, quote === '"', literalDollarOffsets);
      continue;
    }

    if (c === '\'' || c === '"') {
      const quote = c;
      i++;
      let text = '';
      const literalDollarOffsets: number[] = [];
      while (i < script.length) {
        const ch = script[i];
        if (ch === '\n') line++;
        if (ch === quote) {
          if (quote === '\'' && script[i + 1] === '\'') {
            text += '\'';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (quote === '"' && ch === '`' && i + 1 < script.length) {
          const escaped = decodeBacktick(script[i + 1]);
          if (escaped === '$') literalDollarOffsets.push(text.length);
          text += escaped;
          i += 2;
          continue;
        }
        text += ch;
        i++;
      }
      if (i >= script.length && script[script.length - 1] !== quote) {
        warnings.push(`unterminated ${quote === '"' ? 'double' : 'single'}-quoted string at line ${tokenLine}`);
      }
      push('string', text, tokenLine, true, quote === '"', literalDollarOffsets);
      continue;
    }

    if (isParameterStart(script, i)) {
      let text = '';
      while (i < script.length && !isBoundary(script[i])) {
        text += script[i++];
      }
      push('parameter', text, tokenLine, false, true);
      continue;
    }

    if (c === '@' && (script[i + 1] === '{' || script[i + 1] === '(')) {
      const open = script[i + 1];
      const close = open === '{' ? '}' : ')';
      let depth = 0;
      let text = '';
      let quote: string | null = null;
      while (i < script.length) {
        const ch = script[i];
        text += ch;
        if (ch === '\n') line++;
        if (quote) {
          if (quote === '\'' && ch === '\'' && script[i + 1] === '\'') {
            text += script[i + 1];
            i += 2;
            continue;
          }
          if (ch === quote) quote = null;
          i++;
          continue;
        }
        if (ch === '\'' || ch === '"') {
          quote = ch;
          i++;
          continue;
        }
        if (ch === open) depth++;
        if (ch === close) {
          depth--;
          i++;
          if (depth <= 0) break;
          continue;
        }
        i++;
      }
      push('word', text, tokenLine, false, true);
      continue;
    }

    if (isVariableStart(script, i)) {
      let text = script[i++];
      if (script[i] === '{') {
        text += script[i++];
        while (i < script.length && script[i] !== '}') {
          text += script[i++];
        }
        if (i < script.length) text += script[i++];
      } else {
        while (i < script.length && isNameChar(script[i])) {
          text += script[i++];
        }
      }
      push('variable', text, tokenLine, false, true);
      continue;
    }

    let text = '';
    const literalDollarOffsets: number[] = [];
    while (i < script.length && !isBoundary(script[i])) {
      if (script[i] === '`' && i + 1 < script.length) {
        const escaped = decodeBacktick(script[i + 1]);
        if (escaped === '$') literalDollarOffsets.push(text.length);
        text += escaped;
        i += 2;
        continue;
      }
      text += script[i++];
    }
    if (text.length > 0) {
      push('word', text, tokenLine, false, true, literalDollarOffsets);
      continue;
    }

    // Unknown punctuation: keep it as a harmless separator so parsing advances.
    push('operator', c, tokenLine);
    i++;
  }

  push('eof', '', line);
  return { tokens, warnings };
}

function decodeBacktick(value: string): string {
  switch (value) {
    case '0': return '\0';
    case 'a': return '\x07';
    case 'b': return '\b';
    case 'e': return '\x1b';
    case 'f': return '\f';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'v': return '\v';
    default: return value;
  }
}
