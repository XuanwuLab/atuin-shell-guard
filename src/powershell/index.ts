// index.ts — PowerShell dry-run analyzer.
//
import { posix as path } from 'node:path';
import type { FileEffect, EffectType, UncertaintyReason } from '../analysis/effects.js';
import { EffectTracker } from '../analysis/effects.js';
import type { GitStateEffect } from '../analysis/git-effects.js';
import type { ResourceEffect } from '../analysis/resource-effects.js';
import type { ProvenanceGraph } from '../analysis/provenance.js';
import type { IFS } from '../analysis/vfs.js';
import { glob_expand, glob_match_segment, has_glob_chars, RealFS, toPosix, VirtualFS } from '../analysis/vfs.js';
import { analyze as analyzeBash } from '../bash/index.js';
import type { PsCommand, PsPipeline, PsScript, PsStatement, PsWord } from './ast.js';
import { parsePowerShell } from './parser.js';
import { tokenize } from './tokenizer.js';

export interface AnalyzePowerShellOptions {
  cwd: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  args?: string[];
  fs?: string[];
  realFs?: boolean;
}

export interface AnalyzePowerShellResult {
  effects: FileEffect[];
  gitEffects: GitStateEffect[];
  resourceEffects: ResourceEffect[];
  warnings: string[];
  ast: PsScript;
  provenance: ProvenanceGraph;
}

interface PowerShellState {
  env: Map<string, string>;
  splats: Map<string, SplatBinding>;
  tracker: EffectTracker;
  pipelineInput: PipelineValue[];
  pipelineOutput: PipelineValue[];
  statementCount: number;
  budgetWarnings: Set<string>;
}

interface PipelineValue {
  text: string;
  fields: Map<string, string>;
}

interface BoundCommand {
  name: string;
  params: Map<string, string[]>;
  switches: Set<string>;
  positionals: string[];
}

interface SplatBinding {
  params: Map<string, string[]>;
  switches: Set<string>;
  positionals: string[];
}

type CommandHandler = (command: PsCommand, state: PowerShellState) => void;

const MAX_STATEMENTS = 10000;
const MAX_PIPELINE_VALUES = 2000;
const MAX_ARRAY_LITERAL_VALUES = 2000;
const MAX_FOREACH_VALUES = 2000;

const COMMAND_ALIASES = new Map<string, string>([
  ['remove-item', 'remove-item'], ['rm', 'remove-item'], ['ri', 'remove-item'], ['del', 'remove-item'], ['erase', 'remove-item'], ['rd', 'remove-item'], ['rmdir', 'remove-item'],
  ['new-item', 'new-item'], ['ni', 'new-item'],
  ['copy-item', 'copy-item'], ['copy', 'copy-item'], ['cp', 'copy-item'], ['cpi', 'copy-item'], ['ci', 'copy-item'],
  ['move-item', 'move-item'], ['move', 'move-item'], ['mv', 'move-item'], ['mi', 'move-item'],
  ['rename-item', 'rename-item'], ['ren', 'rename-item'], ['rni', 'rename-item'],
  ['set-content', 'set-content'], ['sc', 'set-content'],
  ['add-content', 'add-content'], ['ac', 'add-content'],
  ['clear-content', 'clear-content'], ['clc', 'clear-content'],
  ['out-file', 'out-file'],
  ['tee-object', 'tee-object'], ['tee', 'tee-object'],
  ['invoke-webrequest', 'invoke-webrequest'], ['iwr', 'invoke-webrequest'], ['wget', 'invoke-webrequest'], ['curl', 'invoke-webrequest'],
  ['invoke-restmethod', 'invoke-webrequest'], ['irm', 'invoke-webrequest'],
  ['foreach-object', 'foreach-object'], ['%', 'foreach-object'],
  ['get-childitem', 'get-childitem'], ['gci', 'get-childitem'], ['dir', 'get-childitem'], ['ls', 'get-childitem'],
  ['resolve-path', 'resolve-path'], ['rvpa', 'resolve-path'],
  ['test-path', 'test-path'],
  ['start-process', 'start-process'], ['saps', 'start-process'], ['start', 'start-process'],
  ['invoke-command', 'invoke-command'], ['icm', 'invoke-command'],
  ['start-job', 'start-job'], ['sajb', 'start-job'],
  ['invoke-expression', 'invoke-expression'], ['iex', 'invoke-expression'], ['&', 'invoke-expression'],
  ['compress-archive', 'compress-archive'],
  ['expand-archive', 'expand-archive'],
  ['export-csv', 'export-file'], ['epcsv', 'export-file'],
  ['export-clixml', 'export-file'],
  ['export-alias', 'export-file'],
  ['export-counter', 'export-file'],
  ['new-itemproperty', 'new-itemproperty'], ['set-itemproperty', 'set-itemproperty'], ['remove-itemproperty', 'remove-itemproperty'],
  ['save-module', 'save-module'], ['save-script', 'save-module'],
  ['install-module', 'install-module'],
  ['cd', 'set-location'], ['chdir', 'set-location'], ['sl', 'set-location'], ['set-location', 'set-location'],
]);

const PARAM_ALIASES = new Map<string, string>([
  ['pspath', 'literalpath'],
  ['lp', 'literalpath'],
  ['path', 'path'],
  ['filepath', 'filepath'],
  ['name', 'name'],
  ['itemtype', 'itemtype'],
  ['type', 'itemtype'],
  ['destination', 'destination'],
  ['literalpath', 'literalpath'],
  ['outfile', 'outfile'],
  ['destinationpath', 'destinationpath'],
  ['argumentlist', 'argumentlist'],
  ['args', 'argumentlist'],
  ['redirectstandardoutput', 'redirectstandardoutput'],
  ['rso', 'redirectstandardoutput'],
  ['redirectstandarderror', 'redirectstandarderror'],
  ['rse', 'redirectstandarderror'],
  ['redirectstandardinput', 'redirectstandardinput'],
  ['rsi', 'redirectstandardinput'],
  ['append', 'append'],
  ['recurse', 'recurse'],
  ['force', 'force'],
  ['filter', 'filter'],
  ['include', 'include'],
  ['exclude', 'exclude'],
  ['value', 'value'],
  ['target', 'value'],
  ['newname', 'newname'],
  ['file', 'path'],
  ['scope', 'scope'],
  ['nooverwrite', 'noclobber'],
]);

const SWITCH_PARAMS = new Set(['append', 'recurse', 'force', 'whatif', 'noclobber']);

const COMMAND_HANDLERS: Map<string, CommandHandler> = new Map([
  ['remove-item', handleRemoveItem],
  ['new-item', handleNewItem],
  ['copy-item', handleCopyItem],
  ['move-item', handleMoveItem],
  ['rename-item', handleRenameItem],
  ['set-content', handleSetContent],
  ['add-content', handleAddContent],
  ['clear-content', handleClearContent],
  ['out-file', handleOutFile],
  ['tee-object', handleTeeObject],
  ['invoke-webrequest', handleInvokeWebRequest],
  ['foreach-object', handleForEachObject],
  ['get-childitem', handleGetChildItem],
  ['resolve-path', handleResolvePath],
  ['test-path', handleTestPath],
  ['start-process', handleStartProcess],
  ['invoke-command', handleScriptBlockLauncher],
  ['start-job', handleScriptBlockLauncher],
  ['invoke-expression', handleInvokeExpression],
  ['compress-archive', handleCompressArchive],
  ['expand-archive', handleExpandArchive],
  ['export-file', handleExportFile],
  ['new-itemproperty', handleItemProperty],
  ['set-itemproperty', handleItemProperty],
  ['remove-itemproperty', handleItemProperty],
  ['save-module', handleSaveModule],
  ['install-module', handleInstallModule],
  ['set-location', handleSetLocation],
]);

export function analyzePowerShell(script: string, opts: AnalyzePowerShellOptions): AnalyzePowerShellResult {
  const paramBlock = readParamBlock(script);
  const parsed = parsePowerShell(script.slice(paramBlock.end));
  let vfs: IFS | undefined;
  if (opts.fs) vfs = new VirtualFS(opts.fs);
  else if (opts.realFs) vfs = new RealFS();
  const tracker = new EffectTracker(toPosix(opts.cwd), vfs);
  const env = makeEnv(opts.env, opts.inheritEnv !== false);
  env.set('pwd', tracker.getCwd());
  bindScriptArgs(paramBlock.params, opts.args ?? [], env);
  const state: PowerShellState = {
    env,
    splats: new Map(),
    tracker,
    pipelineInput: [],
    pipelineOutput: [],
    statementCount: 0,
    budgetWarnings: new Set(),
  };
  executeScript(parsed.ast, state);
  return {
    effects: tracker.effects,
    gitEffects: tracker.gitEffects,
    resourceEffects: tracker.resourceEffects,
    warnings: [...parsed.warnings, ...tracker.warnings],
    ast: parsed.ast,
    provenance: tracker.getProvenanceGraph(),
  };
}

export function parse(script: string): { ast: PsScript; warnings: string[] } {
  return parsePowerShell(script);
}

function makeEnv(overrides?: Record<string, string>, inheritProcessEnv: boolean = true): Map<string, string> {
  const env = new Map<string, string>();
  if (inheritProcessEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env.set(key.toLowerCase(), toPosix(value));
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    env.set(key.toLowerCase(), toPosix(value));
  }
  return env;
}

function executeScript(script: PsScript, state: PowerShellState): void {
  executeStatements(script.statements, state);
}

function executeStatements(statements: PsStatement[], state: PowerShellState): void {
  for (const statement of statements) executeStatement(statement, state);
}

function executeStatement(statement: PsStatement, state: PowerShellState): void {
  state.statementCount++;
  if (state.statementCount > MAX_STATEMENTS) {
    warnOnce(state, 'statement-budget', `PowerShell analysis stopped after ${MAX_STATEMENTS} statements`);
    return;
  }
  if (statement.type === 'block') {
    const start = state.tracker.checkpoint();
    for (const condition of statement.conditions ?? []) executeStatements(condition, state);
    if (statement.keyword === 'foreach') {
      executeForEachBlock(statement, state);
    } else if (statement.keyword === 'subexpression') {
      executeStatements(statement.body, state);
      return;
    } else {
      executeStatements(statement.body, state);
    }
    const reason: UncertaintyReason = statement.keyword === 'if' ? 'conditional-branch' : 'unknown-loop-count';
    state.tracker.markAllEffectsFrom(start, [reason], 'overapprox');
    return;
  }
  executePipeline(statement, state);
}

function executeForEachBlock(statement: Extract<PsStatement, { type: 'block' }>, state: PowerShellState): void {
  const variable = statement.variable ? variableName(statement.variable) : '';
  const values = limitValues(statement.values?.flatMap(word => expandValueWord(word, state)) ?? [], MAX_FOREACH_VALUES, state, 'foreach-value-budget');
  if (!variable || values.length === 0) {
    executeStatements(statement.body, state);
    return;
  }
  const previous = state.env.get(variable);
  try {
    for (const value of values) {
      state.env.set(variable, value);
      executeStatements(statement.body, state);
    }
  } finally {
    if (previous === undefined) state.env.delete(variable);
    else state.env.set(variable, previous);
  }
}

function executePipeline(pipeline: PsPipeline, state: PowerShellState): void {
  const start = state.tracker.checkpoint();
  let input: PipelineValue[] = [];
  for (const command of pipeline.commands) {
    state.pipelineInput = input;
    state.pipelineOutput = [];
    executeCommand(command, state);
    input = state.pipelineOutput;
  }
  state.pipelineInput = [];
  state.pipelineOutput = [];
  if (pipeline.connector === 'and' || pipeline.connector === 'or') {
    state.tracker.markAllEffectsFrom(start, ['and-or-branch'], 'overapprox');
  }
}

function executeCommand(command: PsCommand, state: PowerShellState): void {
  if (tryAssignment(command, state)) return;
  for (const redir of command.redirections) {
    if (redir.kind === 'merge' || !redir.target) continue;
    if (isNullRedirectTarget(redir.target)) continue;
    const target = expandWord(redir.target, state);
    if (target.length === 0) {
      state.tracker.addWarning(`redirect: empty target (line ${redir.line})`);
      return;
    }
    if (state.tracker.isKnownDirectory(target)) {
      state.tracker.addWarning(`redirect: ${target}: Is a directory (line ${redir.line})`);
      return;
    }
    const type: EffectType = redir.op.endsWith('>>') ? 'append' : 'write';
    state.tracker.add({ type, path: target, line: redir.line, command: redir.op, uncertain: EffectTracker.hasUncertainty(target) });
  }
  const evaluated = evaluateCommandWords(command, state);
  const rawName = evaluated.name.text.toLowerCase();
  const canonical = COMMAND_ALIASES.get(rawName);
  if (!canonical) return;
  const handler = COMMAND_HANDLERS.get(canonical);
  if (!handler) return;
  if (hasActiveWhatIf(evaluated, state)) return;
  handler({ ...evaluated, name: { ...evaluated.name, text: canonical } }, state);
}

function isNullRedirectTarget(word: PsWord): boolean {
  if (word.quoted || !word.expandable || word.literalDollarOffsets?.includes(0)) return false;
  return /^\$(?:null|\{null\})$/i.test(word.text);
}

function evaluateCommandWords(command: PsCommand, state: PowerShellState): PsCommand {
  const evaluate = (word: PsWord): PsWord => word.scriptBlockBody ? word : {
    ...word,
    text: expandWord(word, state),
    expandable: false,
    literalDollarOffsets: undefined,
  };
  const args: PsWord[] = [];
  for (let i = 0; i < command.args.length;) {
    const word = command.args[i];
    if (word.text.startsWith('@(') && word.text.endsWith(')')) {
      const values = parseArrayLiteral(word.text, state);
      for (let j = 0; j < values.length; j++) {
        if (j > 0) args.push({ text: ',', line: word.line, quoted: false, expandable: false, parameter: false });
        args.push({ ...word, text: values[j], expandable: false, literalDollarOffsets: undefined });
      }
      i++;
      continue;
    }
    if (word.text.startsWith('@{') && word.text.endsWith('}')) {
      parseHashtableLiteral(word.text, state);
      args.push({ ...word, text: '<hashtable>', expandable: false, literalDollarOffsets: undefined });
      i++;
      continue;
    }
    const combined = combineMemberAccess(command.args, i);
    args.push(evaluate(combined.word));
    i = combined.nextIndex;
  }
  return {
    ...command,
    name: evaluate(command.name),
    args,
  };
}

function hasActiveWhatIf(command: PsCommand, state: PowerShellState): boolean {
  for (const arg of command.args) {
    const splatName = splatVariableName(arg.text);
    if (splatName && state.splats.get(splatName)?.switches.has('whatif')) return true;
    if (!arg.parameter) continue;
    let raw = arg.text;
    while (raw.startsWith('-')) raw = raw.slice(1);
    const lower = raw.toLowerCase();
    if (lower === 'whatif') return true;
    if (!lower.startsWith('whatif:')) continue;
    const value = lower.slice('whatif:'.length);
    if (value === '$true' || value === 'true' || value === '1') return true;
  }
  return false;
}

function tryAssignment(command: PsCommand, state: PowerShellState): boolean {
  if (!command.name.text.startsWith('$')) return false;
  if (command.args[0]?.text !== '=') return false;
  const key = variableName(command.name.text);
  if (key.length === 0) return false;
  const valueWord = command.args[1];
  if (valueWord?.text.startsWith('@{') === true) {
    const table = parseHashtableLiteral(valueWord.text, state);
    state.splats.set(key, table);
    for (const [name, values] of table.params) {
      if (values[0] !== undefined) state.env.set(`${key}.${name}`, values[0]);
    }
    return true;
  }
  if (valueWord?.text.startsWith('@(') === true) {
    const values = parseArrayLiteral(valueWord.text, state);
    state.env.set(key, values.join(' '));
    for (let i = 0; i < values.length; i++) state.env.set(`${key}.${i}`, values[i]);
    return true;
  }
  const value = command.args.slice(1).map(word => expandWord(word, state)).join(' ');
  state.env.set(key, value);
  return true;
}

function handleRemoveItem(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const paths = bindPaths(bound, 'path');
  const inputs = paths.length > 0 ? paths : state.pipelineInput.map(pipelineValueText);
  for (const p of applyPathFilters(inputs, bound)) {
    for (const target of expandPathSet(p, state, !bound.params.has('literalpath'))) {
      if (warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({ type: 'delete', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    }
  }
}

function handleNewItem(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const rawPaths = bindPaths(bound, 'path');
  const paths = rawPaths.length > 0 ? rawPaths : [''];
  const itemType = firstParam(bound, 'itemtype').toLowerCase();
  const name = firstParam(bound, 'name');
  const effectType: EffectType = itemType === 'directory' || itemType === 'container' ? 'mkdir' : 'write';
  for (const p of paths) {
    const bases = name.length > 0 ? expandPathSet(p.length > 0 ? p : '.', state, !bound.params.has('literalpath')) : [p];
    for (const base of bases) {
      const target = name.length > 0 ? path.join(base, name) : base;
      if (warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({
        type: effectType,
        path: target,
        line: command.line,
        command: bound.name,
        replacement: effectType === 'write'
          ? bound.switches.has('force') ? 'replace' : 'no-clobber'
          : undefined,
        uncertain: EffectTracker.hasUncertainty(target),
      });
    }
  }
}

function handleCopyItem(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const destination = firstParam(bound, 'destination') || bound.positionals[1] || '.';
  const sources = applyPathFilters(bindPaths(bound, 'path').filter(p => p !== destination), bound);
  for (const source of sources) {
    for (const expanded of expandPathSet(source, state, !bound.params.has('literalpath'))) {
      const target = destinationForSource(destination, expanded, state.tracker);
      if (warnProviderPath(expanded, command.line, state) || warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({
        type: 'copy',
        path: target,
        source: expanded,
        line: command.line,
        command: bound.name,
        replacement: bound.switches.has('force') ? 'replace' : 'conditional',
        uncertain: EffectTracker.hasUncertainty(expanded) || EffectTracker.hasUncertainty(destination),
      });
    }
  }
}

function handleMoveItem(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const destination = firstParam(bound, 'destination') || bound.positionals[1] || '.';
  const sources = applyPathFilters(bindPaths(bound, 'path').filter(p => p !== destination), bound);
  for (const source of sources) {
    for (const expanded of expandPathSet(source, state, !bound.params.has('literalpath'))) {
      const target = destinationForSource(destination, expanded, state.tracker);
      if (warnProviderPath(expanded, command.line, state) || warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({
        type: 'move',
        path: target,
        source: expanded,
        line: command.line,
        command: bound.name,
        replacement: bound.switches.has('force') ? 'replace' : 'no-clobber',
        uncertain: EffectTracker.hasUncertainty(expanded) || EffectTracker.hasUncertainty(destination),
      });
    }
  }
}

function handleRenameItem(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const source = firstPath(bound);
  const newName = firstParam(bound, 'newname') || bound.positionals[1];
  if (!source || !newName) return;
  const destination = path.join(path.dirname(source), newName);
  if (warnProviderPath(source, command.line, state) || warnProviderPath(destination, command.line, state)) return;
  state.tracker.add({
    type: 'move',
    path: destination,
    source,
    line: command.line,
    command: bound.name,
    replacement: 'no-clobber',
    uncertain: EffectTracker.hasUncertainty(source) || EffectTracker.hasUncertainty(newName),
  });
}

function handleSetContent(command: PsCommand, state: PowerShellState): void {
  addPathEffects(bind(command, state), state, command.line, 'write');
}

function handleAddContent(command: PsCommand, state: PowerShellState): void {
  addPathEffects(bind(command, state), state, command.line, 'append');
}

function handleClearContent(command: PsCommand, state: PowerShellState): void {
  addPathEffects(bind(command, state), state, command.line, 'truncate');
}

function handleOutFile(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'filepath') || firstParam(bound, 'path') || firstParam(bound, 'literalpath') || bound.positionals[0];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  addOutputFileEffect(bound, target, state, command.line);
}

function handleTeeObject(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'filepath') || firstParam(bound, 'path') || firstParam(bound, 'literalpath') || bound.positionals[0];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: bound.switches.has('append') ? 'append' : 'write', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}

function handleInvokeWebRequest(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'outfile');
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: 'write', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}

function handleForEachObject(command: PsCommand, state: PowerShellState): void {
  const start = state.tracker.checkpoint();
  const blocks = forEachObjectBlocks(command);
  const inputs = state.pipelineInput.length > 0 ? state.pipelineInput : [scalarPipelineValue('')];
  const previousUnderscore = state.env.get('_');
  const previousPsItem = state.env.get('psitem');
  const previousUnderscoreFields = saveObjectFields(state.env, '_');
  const previousPsItemFields = saveObjectFields(state.env, 'psitem');
  try {
    for (const block of blocks.begin) executeStatements(block, state);
    for (const item of inputs) {
      bindPipelineObject(state.env, '_', item);
      bindPipelineObject(state.env, 'psitem', item);
      for (const block of blocks.process) executeStatements(block, state);
    }
    for (const block of blocks.end) executeStatements(block, state);
  } finally {
    restoreEnvValue(state.env, '_', previousUnderscore);
    restoreEnvValue(state.env, 'psitem', previousPsItem);
    restoreObjectFields(state.env, '_', previousUnderscoreFields);
    restoreObjectFields(state.env, 'psitem', previousPsItemFields);
  }
  state.tracker.markAllEffectsFrom(start, ['unknown-loop-count'], 'overapprox');
}

function forEachObjectBlocks(command: PsCommand): { begin: PsStatement[][]; process: PsStatement[][]; end: PsStatement[][] } {
  const begin: PsStatement[][] = [];
  const process: PsStatement[][] = [];
  const end: PsStatement[][] = [];
  let mode: 'begin' | 'process' | 'end' | null = null;
  for (const arg of command.args) {
    if (arg.parameter) {
      const name = canonicalParamName(arg.text);
      if (name === 'begin' || name === 'process' || name === 'end') mode = name;
      continue;
    }
    if (!arg.scriptBlockBody) continue;
    if (mode === 'begin') begin.push(arg.scriptBlockBody);
    else if (mode === 'end') end.push(arg.scriptBlockBody);
    else process.push(arg.scriptBlockBody);
    mode = null;
  }
  return { begin, process: process.length > 0 ? process : begin.length === 0 && end.length === 0 ? [] : process, end };
}

function handleGetChildItem(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const paths = bindPaths(bound, 'path');
  const candidates = paths.length > 0 ? paths : ['.'];
  for (const candidate of applyPathFilters(candidates, bound)) {
    for (const expanded of expandPathSet(candidate, state, !bound.params.has('literalpath'))) {
      pushPipelineOutput(state, pathObject(expanded));
    }
  }
}

function handleResolvePath(command: PsCommand, state: PowerShellState): void {
  handleGetChildItem(command, state);
}

function handleTestPath(_command: PsCommand, state: PowerShellState): void {
  state.pipelineOutput = [];
}

function handleStartProcess(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  for (const name of ['redirectstandardoutput', 'redirectstandarderror']) {
    const target = firstParam(bound, name);
    if (target) {
      if (warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({ type: 'write', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    }
  }
  const executable = firstParam(bound, 'filepath') || firstParam(bound, 'path') || bound.positionals[0];
  const argumentList = bound.params.get('argumentlist') ?? bound.positionals.slice(1);
  analyzeLaunchedShell(executable, argumentList, state, command.line);
}

function handleScriptBlockLauncher(command: PsCommand, state: PowerShellState): void {
  const start = state.tracker.checkpoint();
  for (const arg of command.args) {
    if (arg.scriptBlockBody) executeStatements(arg.scriptBlockBody, state);
  }
  state.tracker.markAllEffectsFrom(start, ['unknown-command'], 'overapprox');
}

function handleInvokeExpression(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const script = bound.positionals.join(' ');
  if (!script) return;
  const result = analyzePowerShell(script, { cwd: state.tracker.getCwd(), realFs: true });
  for (const effect of result.effects) {
    state.tracker.add({
      ...effect,
      line: command.line,
      command: 'invoke-expression',
      provenance: undefined,
    });
  }
  for (const effect of result.gitEffects) {
    state.tracker.addGit({ ...effect, line: command.line, provenance: undefined });
  }
  for (const effect of result.resourceEffects) {
    state.tracker.addResource({ ...effect, line: command.line, provenance: undefined });
  }
  for (const warning of result.warnings) state.tracker.addWarning(`invoke-expression: ${warning}`);
}

function handleCompressArchive(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'destinationpath') || bound.positionals[1];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: 'write', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}

function handleExpandArchive(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'destinationpath') || bound.positionals[1] || '.';
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: 'mkdir', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
  state.tracker.add({ type: 'write', path: path.join(target, '<archive-contents>'), line: command.line, command: bound.name, uncertain: true, certainty: 'unknown', uncertainty: ['derived-path'] });
}

function handleExportFile(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'path') || firstParam(bound, 'literalpath') || bound.positionals[0];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  addOutputFileEffect(bound, target, state, command.line);
}

function addOutputFileEffect(bound: BoundCommand, target: string, state: PowerShellState, line: number): void {
  if (bound.switches.has('append')) {
    state.tracker.add({ type: 'append', path: target, line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    return;
  }
  const resolved = state.tracker.resolvePath(target);
  if (bound.switches.has('noclobber') && state.tracker.vfs?.exists(resolved)) {
    state.tracker.addWarning(`${bound.name}: '${target}' already exists; -NoClobber prevents writing (line ${line})`);
    return;
  }
  state.tracker.add({
    type: 'write',
    path: target,
    line,
    command: bound.name,
    replacement: bound.switches.has('noclobber') ? 'no-clobber' : 'replace',
    uncertain: EffectTracker.hasUncertainty(target),
  });
}

function handleItemProperty(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstPath(bound);
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: command.name.text.startsWith('remove') ? 'delete' : 'write', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}

function handleSaveModule(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstParam(bound, 'path') || bound.positionals[1] || '.';
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: 'mkdir', path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}

function handleInstallModule(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const name = firstParam(bound, 'name') || bound.positionals[0] || '<module>';
  const scope = firstParam(bound, 'scope').toLowerCase();
  const home = state.env.get('home') || '~';
  const base = scope === 'allusers' ? '/usr/local/share/powershell/Modules' : path.join(home, 'Documents/PowerShell/Modules');
  const target = path.join(base, name);
  state.tracker.add({ type: 'mkdir', path: target, line: command.line, command: bound.name, uncertain: name === '<module>', certainty: name === '<module>' ? 'unknown' : 'exact', uncertainty: name === '<module>' ? ['derived-path'] : [] });
}

function handleSetLocation(command: PsCommand, state: PowerShellState): void {
  const bound = bind(command, state);
  const target = firstPath(bound);
  if (!target || EffectTracker.hasUncertainty(target)) return;
  state.tracker.setCwd(state.tracker.resolvePath(target));
  state.env.set('pwd', state.tracker.getCwd());
}

function addPathEffects(bound: BoundCommand, state: PowerShellState, line: number, type: EffectType): void {
  for (const p of applyPathFilters(bindPaths(bound, 'path'), bound)) {
    for (const target of expandPathSet(p, state, !bound.params.has('literalpath'))) {
      if (warnProviderPath(target, line, state)) continue;
      state.tracker.add({ type, path: target, line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    }
  }
}

function bind(command: PsCommand, state: PowerShellState): BoundCommand {
  const params = new Map<string, string[]>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  let i = 0;
  while (i < command.args.length) {
    const word = command.args[i];
    const splatName = splatVariableName(word.text);
    if (splatName) {
      const splat = state.splats.get(splatName);
      if (splat) mergeSplat(params, switches, positionals, splat);
      i++;
      continue;
    }
    if (word.parameter) {
      const switchParameter = parseInlineSwitchParameter(word.text);
      const switchName = canonicalParamName(switchParameter.name);
      if (SWITCH_PARAMS.has(switchName)) {
        if (switchParameter.enabled) switches.add(switchName);
        i++;
        continue;
      }
      const name = canonicalParamName(word.text);
      if (name.length === 0) {
        i++;
        continue;
      }
      const collected = collectParamValues(command.args, i + 1, state);
      if (collected.values.length > 0) {
        for (const value of collected.values) addParam(params, name, value);
        i = collected.nextIndex;
        continue;
      }
      addParam(params, name, '');
      i++;
      continue;
    }
    if (word.text !== '=' && word.text !== ',') {
      const combined = combineMemberAccess(command.args, i);
      for (const value of expandValueWord(combined.word, state)) positionals.push(value);
      i = combined.nextIndex;
      continue;
    }
    i++;
  }
  return { name: command.name.text, params, switches, positionals };
}

function collectParamValues(words: PsWord[], start: number, state: PowerShellState): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let i = start;
  let expectValue = true;
  while (i < words.length) {
    const word = words[i];
    if (word.parameter || word.text === '=') break;
    if (word.text === ',') {
      expectValue = true;
      i++;
      continue;
    }
    if (!expectValue && values.length > 0) break;
    const combined = combineMemberAccess(words, i);
    values.push(...expandValueWord(combined.word, state));
    expectValue = false;
    i = combined.nextIndex;
    if (i < words.length && words[i]?.text === ',') continue;
    break;
  }
  return { values, nextIndex: i };
}

function bindPaths(bound: BoundCommand, paramName: string): string[] {
  const explicit = bound.params.get('literalpath') ?? bound.params.get(paramName);
  if (explicit && explicit.length > 0) return explicit;
  if (bound.positionals.length === 0) return [];
  if ((bound.name === 'copy-item' || bound.name === 'move-item') && bound.positionals.length > 1) {
    return bound.positionals.slice(0, bound.positionals.length - 1);
  }
  return [bound.positionals[0]];
}

function firstPath(bound: BoundCommand): string | undefined {
  return bindPaths(bound, 'path')[0];
}

function firstParam(bound: BoundCommand, name: string): string {
  return bound.params.get(name)?.[0] ?? '';
}

function combineMemberAccess(words: PsWord[], index: number): { word: PsWord; nextIndex: number } {
  const word = words[index];
  const next = words[index + 1];
  if (word?.text.startsWith('$') && next && !next.parameter && next.text.startsWith('.')) {
    return { word: { ...word, text: word.text + next.text }, nextIndex: index + 2 };
  }
  if (word?.text.startsWith('$') && next && !next.parameter && next.text.startsWith('[')) {
    return { word: { ...word, text: word.text + next.text }, nextIndex: index + 2 };
  }
  return { word, nextIndex: index + 1 };
}

function applyPathFilters(paths: string[], bound: BoundCommand): string[] {
  const filters = [
    ...bound.params.get('filter') ?? [],
    ...bound.params.get('include') ?? [],
  ];
  const excludes = bound.params.get('exclude') ?? [];
  if (filters.length === 0 && excludes.length === 0) return paths;
  return paths.filter(candidate => {
    const name = path.basename(candidate);
    if (filters.length > 0 && !filters.some(pattern => glob_match_segment(pattern, name))) return false;
    if (excludes.some(pattern => glob_match_segment(pattern, name))) return false;
    return true;
  });
}

function addParam(params: Map<string, string[]>, name: string, value: string): void {
  let values = params.get(name);
  if (!values) {
    values = [];
    params.set(name, values);
  }
  values.push(value);
}

function mergeSplat(
  params: Map<string, string[]>,
  switches: Set<string>,
  positionals: string[],
  splat: SplatBinding,
): void {
  for (const [name, values] of splat.params) {
    for (const value of values) addParam(params, name, value);
  }
  for (const name of splat.switches) switches.add(name);
  positionals.push(...splat.positionals);
}

function canonicalParamName(raw: string): string {
  let i = 0;
  while (raw[i] === '-') i++;
  const name = raw.slice(i).toLowerCase();
  return PARAM_ALIASES.get(name) ?? name;
}

function parseInlineSwitchParameter(raw: string): { name: string; enabled: boolean } {
  const colon = raw.indexOf(':');
  if (colon < 0) return { name: raw, enabled: true };
  const value = raw.slice(colon + 1).toLowerCase();
  return {
    name: raw.slice(0, colon),
    enabled: value === '$true' || value === 'true' || value === '1',
  };
}

function expandWord(word: PsWord, state: PowerShellState): string {
  if (!word.expandable) return word.text;
  const literalDollarOffsets = new Set(word.literalDollarOffsets ?? []);
  let out = '';
  let i = 0;
  while (i < word.text.length) {
    const c = word.text[i];
    if (c !== '$' || literalDollarOffsets.has(i)) {
      out += c;
      i++;
      continue;
    }
    const subexpr = readSubexpression(word.text, i);
    if (subexpr) {
      out += expandSubexpression(subexpr.expr, state);
      i = subexpr.end;
      continue;
    }
    const read = readVariable(word.text, i);
    if (!read) {
      out += c;
      i++;
      continue;
    }
    out += state.env.get(read.name) ?? `$${read.name}`;
    i = read.end;
  }
  return out;
}

function expandValueWord(word: PsWord, state: PowerShellState): string[] {
  if (word.text.startsWith('@(') && word.text.endsWith(')')) {
    return parseArrayLiteral(word.text, state);
  }
  return [expandWord(word, state)];
}

function parseArrayLiteral(text: string, state: PowerShellState): string[] {
  const inner = text.slice(2, text.length - 1);
  const { tokens } = tokenize(inner);
  const values: string[] = [];
  for (const token of tokens) {
    if (values.length >= MAX_ARRAY_LITERAL_VALUES) {
      warnOnce(state, 'array-literal-budget', `PowerShell array literal expansion stopped after ${MAX_ARRAY_LITERAL_VALUES} values`);
      break;
    }
    if (token.kind === 'eof' || token.kind === 'newline' || token.text === ',') continue;
    if (token.kind === 'word' || token.kind === 'string' || token.kind === 'variable') {
      values.push(expandWord({
        text: token.text,
        line: token.line,
        quoted: token.quoted,
        expandable: token.expandable,
        parameter: false,
        literalDollarOffsets: token.literalDollarOffsets,
      }, state));
    }
  }
  return values;
}

function parseHashtableLiteral(text: string, state: PowerShellState): SplatBinding {
  const inner = text.slice(2, text.length - 1);
  const { tokens } = tokenize(inner);
  const params = new Map<string, string[]>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const keyToken = tokens[i];
    if (keyToken.kind === 'eof') break;
    if (keyToken.kind === 'newline' || keyToken.text === ';' || keyToken.text === ',') {
      i++;
      continue;
    }
    const key = canonicalParamName(keyToken.text);
    i++;
    if (tokens[i]?.text === '=') i++;
    const values: string[] = [];
    while (i < tokens.length && tokens[i]?.kind !== 'eof' && tokens[i]?.text !== ';') {
      const token = tokens[i];
      if (token.text !== ',') {
        values.push(...expandValueWord({
          text: token.text,
          line: token.line,
          quoted: token.quoted,
          expandable: token.expandable,
          parameter: false,
          literalDollarOffsets: token.literalDollarOffsets,
        }, state));
      }
      i++;
    }
    if (SWITCH_PARAMS.has(key) && (values.length === 0 || values[0]?.toLowerCase() !== '$false')) {
      switches.add(key);
    } else {
      for (const value of values) addParam(params, key, value);
    }
  }
  return { params, switches, positionals };
}

function readVariable(text: string, start: number): { name: string; end: number } | null {
  let i = start + 1;
  if (text[i] === '{') {
    i++;
    const nameStart = i;
    while (i < text.length && text[i] !== '}') i++;
    if (i >= text.length) return null;
    return { name: normalizeVariableName(text.slice(nameStart, i)), end: i + 1 };
  }
  const nameStart = i;
  while (i < text.length) {
    const c = text[i];
    if (!isVariableChar(c)) break;
    i++;
  }
  if (i === nameStart) return null;
  const baseName = text.slice(nameStart, i);
  if (baseName.toLowerCase().startsWith('env:')) {
    return { name: normalizeVariableName(baseName), end: i };
  }
  while (text[i] === '.') {
    i++;
    while (i < text.length && isVariableChar(text[i])) i++;
  }
  if (text[i] === '[') {
    const indexStart = i + 1;
    while (i < text.length && text[i] !== ']') i++;
    if (i < text.length) {
      const index = text.slice(indexStart, i);
      return { name: normalizeVariableName(`${baseName}.${index}`), end: i + 1 };
    }
  }
  return { name: normalizeVariableName(text.slice(nameStart, i)), end: i };
}

function normalizeVariableName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith('env:')) return lower.slice(4);
  return lower;
}

function variableName(raw: string): string {
  return normalizeVariableName(raw.startsWith('${') && raw.endsWith('}') ? raw.slice(2, raw.length - 1) : raw.slice(1));
}

function splatVariableName(raw: string): string | null {
  if (!raw.startsWith('@') || raw.startsWith('@(') || raw.startsWith('@{')) return null;
  const name = raw.slice(1);
  return name.length > 0 ? normalizeVariableName(name) : null;
}

function isVariableChar(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || c === '_' || c === ':';
}

function expandPathSet(pattern: string, state: PowerShellState, allowWildcard: boolean): string[] {
  if (!allowWildcard || !state.tracker.vfs || !has_glob_chars(pattern)) return [pattern];
  const matches = glob_expand(pattern, state.tracker.getCwd(), state.tracker.vfs);
  return matches.length > 0 ? matches : [pattern];
}

function pathObject(fullPath: string): PipelineValue {
  const fields = new Map<string, string>();
  fields.set('fullname', fullPath);
  fields.set('path', fullPath);
  fields.set('name', path.basename(fullPath));
  return { text: fullPath, fields };
}

function scalarPipelineValue(text: string): PipelineValue {
  return { text, fields: new Map() };
}

function readSubexpression(text: string, start: number): { expr: string; end: number } | null {
  if (text[start] !== '$' || text[start + 1] !== '(') return null;
  let depth = 1;
  let i = start + 2;
  const exprStart = i;
  while (i < text.length) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') {
      depth--;
      if (depth === 0) return { expr: text.slice(exprStart, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function expandSubexpression(expr: string, state: PowerShellState): string {
  const trimmed = expr.trim();
  if (trimmed.startsWith('$')) {
    const variable = readVariable(trimmed, 0);
    if (variable?.end === trimmed.length) return state.env.get(variable.name) ?? `$${variable.name}`;
  }
  const parsed = parsePowerShell(trimmed);
  for (const warning of parsed.warnings) state.tracker.addWarning(`PowerShell subexpression: ${warning}`);
  const previousInput = state.pipelineInput;
  const previousOutput = state.pipelineOutput;
  try {
    executeStatements(parsed.ast.statements, state);
  } finally {
    state.pipelineInput = previousInput;
    state.pipelineOutput = previousOutput;
  }
  return `<$(${trimmed})>`;
}

function analyzeLaunchedShell(executable: string, args: string[], state: PowerShellState, line: number): void {
  const shell = shellKindForExecutable(path.basename(executable).toLowerCase());
  if (!shell) return;
  const script = shellCommandArgument(args, shell);
  if (!script) return;
  const result = shell === 'powershell'
    ? analyzePowerShell(script, { cwd: state.tracker.getCwd(), realFs: true })
    : analyzeBash(script, { cwd: state.tracker.getCwd(), realFs: true });
  for (const effect of result.effects) {
    state.tracker.add({
      ...effect,
      line,
      command: `start-process ${shell}`,
      provenance: undefined,
    });
  }
  for (const effect of result.gitEffects) {
    state.tracker.addGit({ ...effect, line, provenance: undefined });
  }
  for (const effect of result.resourceEffects) {
    state.tracker.addResource({ ...effect, line, provenance: undefined });
  }
  for (const warning of result.warnings) state.tracker.addWarning(`${shell}: ${warning}`);
}

function shellKindForExecutable(executable: string): 'bash' | 'powershell' | null {
  if (executable === 'bash' || executable === 'bash.exe' || executable === 'sh' || executable === 'sh.exe' || executable === 'wsl' || executable === 'wsl.exe') return 'bash';
  if (executable === 'pwsh' || executable === 'pwsh.exe' || executable === 'powershell' || executable === 'powershell.exe') return 'powershell';
  return null;
}

function shellCommandArgument(args: string[], shell: 'bash' | 'powershell'): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    if (arg === '-c' || arg === '-command' || (shell === 'powershell' && arg === '-encodedcommand')) {
      if (arg === '-encodedcommand') return decodeUtf16LeBase64(args[i + 1] ?? '');
      return args.slice(i + 1).join(' ');
    }
  }
  return null;
}

function decodeUtf16LeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf16le').replace(/\0+$/u, '');
  } catch {
    return '';
  }
}

function pipelineValueText(value: PipelineValue): string {
  return value.text;
}

function pushPipelineOutput(state: PowerShellState, value: PipelineValue): void {
  if (state.pipelineOutput.length >= MAX_PIPELINE_VALUES) {
    warnOnce(state, 'pipeline-budget', `PowerShell pipeline output stopped after ${MAX_PIPELINE_VALUES} values`);
    return;
  }
  state.pipelineOutput.push(value);
}

function bindPipelineObject(env: Map<string, string>, name: string, value: PipelineValue): void {
  env.set(name, value.text);
  for (const [field, fieldValue] of value.fields) {
    env.set(`${name}.${field}`, fieldValue);
  }
}

function saveObjectFields(env: Map<string, string>, name: string): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  saved.set(`${name}.fullname`, env.get(`${name}.fullname`));
  saved.set(`${name}.path`, env.get(`${name}.path`));
  saved.set(`${name}.name`, env.get(`${name}.name`));
  return saved;
}

function restoreObjectFields(env: Map<string, string>, name: string, saved: Map<string, string | undefined>): void {
  for (const field of ['fullname', 'path', 'name']) {
    restoreEnvValue(env, `${name}.${field}`, saved.get(`${name}.${field}`));
  }
}

function limitValues(values: string[], limit: number, state: PowerShellState, key: string): string[] {
  if (values.length <= limit) return values;
  warnOnce(state, key, `PowerShell expansion stopped after ${limit} values`);
  return values.slice(0, limit);
}

function warnOnce(state: PowerShellState, key: string, message: string): void {
  if (state.budgetWarnings.has(key)) return;
  state.budgetWarnings.add(key);
  state.tracker.addWarning(message);
}

function warnProviderPath(value: string, line: number, state: PowerShellState): boolean {
  if (!isNonFilesystemProviderPath(value)) return false;
  state.tracker.addWarning(`PowerShell provider path '${value}' is not modeled as a filesystem path (line ${line})`);
  return true;
}

function isNonFilesystemProviderPath(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon <= 0) return false;
  if (colon === 1 && isAsciiAlpha(value[0])) return false;
  return true;
}

function isAsciiAlpha(value: string): boolean {
  if (value.length === 0) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function restoreEnvValue(env: Map<string, string>, name: string, previous: string | undefined): void {
  if (previous === undefined) env.delete(name);
  else env.set(name, previous);
}

function bindScriptArgs(params: string[], args: string[], env: Map<string, string>): void {
  for (let i = 0; i < params.length; i++) {
    env.set(params[i].toLowerCase(), toPosix(args[i] ?? ''));
  }
  for (let i = 0; i < args.length; i++) {
    env.set(String(i + 1), toPosix(args[i]));
  }
}

function readParamBlock(script: string): { params: string[]; end: number } {
  let i = 0;
  while (i < script.length && isWhitespace(script[i])) i++;
  if (!startsWithWord(script, i, 'param')) return { params: [], end: 0 };
  i += 'param'.length;
  while (i < script.length && isWhitespace(script[i])) i++;
  if (script[i] !== '(') return { params: [], end: 0 };
  const end = findBalanced(script, i, '(', ')');
  if (end <= i) return { params: [], end: 0 };
  const { tokens } = tokenize(script.slice(i + 1, end));
  const params: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'variable') params.push(variableName(token.text));
  }
  return { params, end: end + 1 };
}

function startsWithWord(script: string, pos: number, word: string): boolean {
  if (script.slice(pos, pos + word.length).toLowerCase() !== word) return false;
  const next = script[pos + word.length] ?? '';
  return next.length === 0 || !isVariableChar(next);
}

function findBalanced(script: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function destinationForSource(dest: string, source: string, tracker: EffectTracker): string {
  const resolvedDest = tracker.resolvePath(dest);
  if (dest.endsWith('/') || tracker.vfs?.isDirectory(resolvedDest)) {
    return path.join(dest, path.basename(source));
  }
  return dest;
}
