// ast.ts — Minimal PowerShell AST for dry-run file effect tracking.

export interface PsScript {
  type: 'script';
  statements: PsStatement[];
}

export type PsStatement = PsPipeline | PsBlock;

export interface PsBlock {
  type: 'block';
  keyword: string;
  body: PsStatement[];
  conditions?: PsStatement[][];
  variable?: string;
  values?: PsWord[];
  line: number;
  fuzzy: boolean;
}

export interface PsPipeline {
  type: 'pipeline';
  commands: PsCommand[];
  connector: 'statement' | 'pipeline' | 'and' | 'or';
  line: number;
}

export interface PsCommand {
  type: 'command';
  name: PsWord;
  args: PsWord[];
  redirections: PsRedirection[];
  line: number;
  fuzzy: boolean;
}

export interface PsWord {
  text: string;
  line: number;
  quoted: boolean;
  expandable: boolean;
  parameter: boolean;
  literalDollarOffsets?: number[];
  scriptBlockBody?: PsStatement[];
}

export interface PsRedirection {
  kind: 'file' | 'merge';
  op: string;
  target?: PsWord;
  line: number;
}
