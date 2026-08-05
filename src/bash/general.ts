// general.ts — Shell-language utility functions

/** Check if character can start a variable name (letter or _) */
export function legal_variable_starter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

/** Check if character can appear in a variable name (letter, digit, or _) */
export function legal_variable_char(c: string): boolean {
  return legal_variable_starter(c) || (c >= '0' && c <= '9');
}

/** Check if a word is a variable assignment (name=value) */
export function assignment_word(word: string): boolean {
  return parseAssignment(word) !== null;
}

/** Extract the variable name from an assignment word */
export function assignment_name(word: string): string {
  return parseAssignment(word)?.target ?? word;
}

/** Extract the value from an assignment word */
export function assignment_value(word: string): string {
  return parseAssignment(word)?.value ?? '';
}

export type AssignmentOperator = '=' | '+=';

export function assignment_operator(word: string): AssignmentOperator {
  return parseAssignment(word)?.operator ?? '=';
}

export interface ArrayReference {
  name: string;
  subscript: string;
}

interface ParsedAssignment {
  target: string;
  operator: AssignmentOperator;
  value: string;
}

function parseAssignment(word: string): ParsedAssignment | null {
  if (word.length === 0 || !legal_variable_starter(word[0])) return null;
  let position = 1;
  while (position < word.length && legal_variable_char(word[position])) position++;
  if (word[position] === '[') {
    const end = readArrayReferenceEnd(word, position);
    if (end === null) return null;
    position = end;
  }

  let operator: AssignmentOperator;
  if (word.startsWith('+=', position)) {
    operator = '+=';
  } else if (word[position] === '=') {
    operator = '=';
  } else {
    return null;
  }
  return {
    target: word.substring(0, position),
    operator,
    value: word.substring(position + operator.length),
  };
}

export function parse_array_reference(value: string): ArrayReference | null {
  if (value.length === 0 || !legal_variable_starter(value[0])) return null;
  let position = 1;
  while (position < value.length && legal_variable_char(value[position])) position++;
  if (value[position] !== '[') return null;

  const start = position;
  const end = readArrayReferenceEnd(value, start);
  if (end !== value.length) return null;
  return {
    name: value.substring(0, start),
    subscript: value.substring(start + 1, end - 1),
  };
}

function readArrayReferenceEnd(value: string, start: number): number | null {
  let position = start;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (; position < value.length; position++) {
    const character = value[position];
    if (character === '\\' && quote !== "'") {
      position++;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '[') depth++;
    else if (character === ']') {
      depth--;
      if (depth === 0) return position + 1;
    }
  }
  return null;
}

export function assignment_base_name(word: string): string {
  const reference = parse_array_reference(assignment_name(word));
  return reference?.name ?? assignment_name(word);
}

/** Extract a colon-separated unit from a path string */
export function extract_colon_unit(path: string, index: number): [string, number] | null {
  if (index >= path.length) return null;
  const end = path.indexOf(':', index);
  if (end === -1) {
    return [path.substring(index), path.length];
  }
  return [path.substring(index, end), end + 1];
}
