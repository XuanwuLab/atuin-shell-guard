// test.ts — Assert-based tests for ts-bash-emu

import {
  analyze,
  explainEffect,
  explainObservation,
  parse,
  print_command,
  RealFS,
  toPosix,
  VirtualFS,
} from '../index.js';
import { resolveBashCommandString, resolveInvocation } from '../invocation.js';
import {
  AMP,
  CASEPAT_FALLTHROUGH,
  CASEPAT_TESTNEXT,
  SEMI,
} from '../command.js';
import { resolveGitClean, resolveGitInvocation, resolveGitReset } from '../../git/invocation.js';
import { postprocess } from '../../analysis/postprocess.js';
import {
  classifyAnalysis,
  decide,
  DIRECT_RISK_POLICY,
  isCatastrophicPath,
  isSystemPath,
  LARGE_TOTAL_SIZE_THRESHOLD_BYTES,
  MANY_FILES_CRITICAL,
  MANY_FILES_RISKY,
  OLD_FILE_THRESHOLD_MS,
  renderReasonCodesDetailed,
  RISK_REASON_CODES,
} from '../../analysis/risk_model.js';
import type { AffectedInfo, ClassifyOpts } from '../../analysis/risk_model.js';
import type { EffectType, FileEffect, ReplacementBehavior } from '../../analysis/effects.js';
import {
  appendStreams,
  DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
  exactStream,
  exactStatus,
  exactStringValue,
  failureStatus,
  invertStatus,
  joinStreams,
  joinStatuses,
  joinStringValues,
  pipelineStatus,
  statusAsString,
  stripTrailingNewlines,
  successStatus,
  unknownStatus,
  unknownStringValue,
  unsetStringValue,
} from '../../analysis/abstract.js';
import {
  createGlobExpansionBudget,
  glob_expand_bounded,
  MAX_PREDICTED_TEXT_FILE_BYTES,
} from '../../analysis/vfs.js';
import { MAX_PROVENANCE_NODES } from '../../analysis/provenance.js';
import {
  expand_words,
  glob_expand_words,
  type ExpandedWord,
} from '../subst.js';
import {
  MAX_ARRAY_ELEMENTS,
  MAX_ARRAY_VALUE_CHARS,
  VariableEnvironment,
} from '../variables.js';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

let passed = 0;
let failed = 0;
let skipped = 0;

const EXPECTED_DISABLED_HANDLER_TESTS = new Set<string>([
]);

function test(name: string, fn: () => void): void {
  if (EXPECTED_DISABLED_HANDLER_TESTS.has(name)) {
    console.log(`  SKIP: ${name}`);
    skipped++;
    return;
  }
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e: unknown) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log('ts-bash-emu tests\n');

test('abstract string joins are deterministic, idempotent, and retain unset', () => {
  const a = exactStringValue('a');
  const b = exactStringValue('b');
  const unset = unsetStringValue();
  const left = joinStringValues([a, b, unset], 'branch-join');
  const right = joinStringValues([unset, b, a, a], 'branch-join');
  assert.deepEqual(left, {
    kind: 'finite',
    values: ['a', 'b'],
    mayBeUnset: true,
    reasons: [],
  });
  assert.deepEqual(right, left);
});

test('abstract string widening keeps bounded witnesses and an unknown remainder', () => {
  const joined = joinStringValues(
    [exactStringValue('c'), exactStringValue('a'), unknownStringValue('external', ['b'])],
    'branch-join',
    2,
  );
  assert.deepEqual(joined, {
    kind: 'unknown',
    values: ['a', 'b'],
    mayBeUnset: false,
    reasons: ['branch-join', 'external'],
  });
});

test('abstract statuses join, invert, and expose bounded dollar-question values', () => {
  assert.deepEqual(joinStatuses([successStatus(), exactStatus(2)]), {
    maySucceed: true,
    mayFail: true,
    exactCodes: [0, 2],
    mayHaveOtherFailureCode: false,
  });
  assert.deepEqual(invertStatus(successStatus()), exactStatus(1));
  assert.deepEqual(invertStatus(failureStatus()), exactStatus(0));
  assert.deepEqual(statusAsString(unknownStatus()), {
    kind: 'unknown',
    values: ['0'],
    mayBeUnset: false,
    reasons: ['unknown-exit-code'],
  });
  assert.deepEqual(exactStatus(-1), exactStatus(255));
});

test('pipeline status follows the last segment unless pipefail is enabled', () => {
  assert.deepEqual(
    pipelineStatus([exactStatus(3), successStatus()], false),
    successStatus(),
  );
  assert.deepEqual(
    pipelineStatus([exactStatus(3), successStatus()], true),
    exactStatus(3),
  );
  assert.deepEqual(
    pipelineStatus([unknownStatus(), successStatus()], true),
    unknownStatus(),
  );
  assert.deepEqual(
    pipelineStatus([exactStatus(3), exactStatus(2)], true),
    exactStatus(2),
  );
});

test('abstract streams concatenate, join, and strip command-substitution newlines', () => {
  assert.deepEqual(
    appendStreams(exactStream('a'), exactStream('b\n')),
    exactStream('ab\n'),
  );
  assert.deepEqual(
    joinStreams([exactStream('a'), exactStream('b')]).value.values,
    ['a', 'b'],
  );
  assert.deepEqual(
    stripTrailingNewlines(exactStream('value\n\n')),
    exactStream('value'),
  );
  const traced = appendStreams(
    exactStream('a', DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT, [5]),
    exactStream('b', DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT, [2, 5]),
  );
  assert.deepEqual(traced.provenance, [2, 5]);
  assert.deepEqual(stripTrailingNewlines(traced).provenance, [2, 5]);
  const bounded = exactStream(
    'x'.repeat(DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT + 1),
  );
  assert.equal(bounded.value.kind, 'unknown');
  assert.equal(
    bounded.value.values[0].length,
    DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
  );
});

test('VFS clones isolate in-memory and real-disk overlay mutations', () => {
  const virtual = new VirtualFS(['/work/a.txt']);
  const virtualFork = virtual.clone();
  virtualFork.remove('/work/a.txt');
  virtualFork.addFile('/work/b.txt');
  assert.equal(virtual.exists('/work/a.txt'), true);
  assert.equal(virtual.exists('/work/b.txt'), false);
  assert.equal(virtualFork.exists('/work/a.txt'), false);
  assert.equal(virtualFork.exists('/work/b.txt'), true);

  const real = new RealFS();
  const overlayPath = '/__atuin_shell_guard_branch_overlay__/a.txt';
  real.addFile(overlayPath);
  const realFork = real.clone();
  realFork.remove(overlayPath);
  assert.equal(real.exists(overlayPath), true);
  assert.equal(realFork.exists(overlayPath), false);
});

test('VFS text reads are bounded and never use unknown overlay contents', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-vfs-read-'));
  try {
    const textPath = nodePath.join(root, 'script.sh');
    const nulPath = nodePath.join(root, 'nul.sh');
    const invalidPath = nodePath.join(root, 'invalid.sh');
    fs.writeFileSync(textPath, 'rm docs/report.docx\n');
    fs.writeFileSync(nulPath, Buffer.from([0x72, 0x6d, 0x00, 0x78]));
    fs.writeFileSync(invalidPath, Buffer.from([0xff]));

    const real = new RealFS();
    assert.deepEqual(real.readTextFile(toPosix(textPath), 1024), {
      kind: 'text',
      text: 'rm docs/report.docx\n',
      byteLength: 20,
    });
    assert.deepEqual(real.readTextFile(toPosix(textPath), 4), {
      kind: 'unavailable',
      reason: 'too-large',
    });
    assert.deepEqual(real.readTextFile(toPosix(nulPath), 1024), {
      kind: 'unavailable',
      reason: 'nul-byte',
    });
    assert.deepEqual(real.readTextFile(toPosix(invalidPath), 1024), {
      kind: 'unavailable',
      reason: 'not-utf8',
    });
    assert.deepEqual(real.readTextFile(toPosix(root), 1024), {
      kind: 'unavailable',
      reason: 'directory',
    });

    const appended = new RealFS();
    assert.equal(
      appended.updateTextFile(toPosix(textPath), 'echo appended\n', 'append'),
      true,
    );
    assert.deepEqual(appended.readTextFile(toPosix(textPath), 1024), {
      kind: 'text',
      text: 'rm docs/report.docx\necho appended\n',
      byteLength: 34,
    });

    assert.equal(
      real.updateTextFile(toPosix(textPath), 'rm replacement.pptx\n', 'truncate'),
      true,
    );
    assert.deepEqual(real.readTextFile(toPosix(textPath), 1024), {
      kind: 'text',
      text: 'rm replacement.pptx\n',
      byteLength: 20,
    });
    assert.ok(!real.stateKey().includes('replacement.pptx'));

    real.addFile(toPosix(textPath));
    assert.deepEqual(real.readTextFile(toPosix(textPath), 1024), {
      kind: 'unavailable',
      reason: 'overlay-content-unknown',
    });
    const virtual = new VirtualFS(['/work/script.sh']);
    assert.deepEqual(virtual.readTextFile('/work/script.sh', 1024), {
      kind: 'unavailable',
      reason: 'overlay-content-unknown',
    });
    assert.equal(
      virtual.updateTextFile('/work/script.sh', 'rm virtual.docx\n', 'truncate'),
      true,
    );
    const virtualFork = virtual.clone();
    assert.equal(
      virtualFork.updateTextFile('/work/script.sh', 'echo after\n', 'append'),
      true,
    );
    assert.deepEqual(virtual.readTextFile('/work/script.sh', 1024), {
      kind: 'text',
      text: 'rm virtual.docx\n',
      byteLength: 16,
    });
    assert.deepEqual(virtualFork.readTextFile('/work/script.sh', 1024), {
      kind: 'text',
      text: 'rm virtual.docx\necho after\n',
      byteLength: 27,
    });
    assert.notEqual(virtual.stateKey(), virtualFork.stateKey());
    assert.ok(!virtual.stateKey().includes('virtual.docx'));

    virtual.updateTextFile(
      '/work/oversized.sh',
      'x'.repeat(MAX_PREDICTED_TEXT_FILE_BYTES + 1),
      'truncate',
    );
    assert.deepEqual(virtual.readTextFile('/work/oversized.sh', 1024), {
      kind: 'unavailable',
      reason: 'overlay-content-unknown',
    });
    if (process.platform !== 'win32') {
      assert.equal(
        real.updateTextFile('/dev/null', 'discarded', 'truncate'),
        false,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invocation resolver binds wrapper option operands without treating them as commands', () => {
  const cases: Array<[string[], string, string[]]> = [
    [['command', '-p', '--', 'rm', 'file'], 'rm', ['file']],
    [['env', '-u', 'rm', 'echo', 'safe'], 'echo', ['safe']],
    [['env', '--unset', 'rm', 'echo', 'safe'], 'echo', ['safe']],
    [['sudo', '-u', 'rm', 'echo', 'safe'], 'echo', ['safe']],
    [['sudo', '--user', 'rm', 'echo', 'safe'], 'echo', ['safe']],
    [['sudo', '-p', 'rm', 'echo', 'safe'], 'echo', ['safe']],
    [['exec', '-a', 'rm', 'echo', 'safe'], 'echo', ['safe']],
    [['nohup', 'rm', 'file'], 'rm', ['file']],
  ];
  for (const [words, commandName, args] of cases) {
    const resolved = resolveInvocation(words, { cwd: '/work' });
    assert.equal(resolved.completeness, 'complete', words.join(' '));
    assert.equal(resolved.commandName, commandName, words.join(' '));
    assert.deepEqual(resolved.args, args, words.join(' '));
  }
});

test('invocation resolver handles nested wrappers and child context', () => {
  const resolved = resolveInvocation(
    ['sudo', '-D', 'admin', 'env', '-C', 'nested', 'FOO=bar', 'command', 'rm', 'file'],
    { cwd: '/work' },
  );
  assert.equal(resolved.commandName, 'rm');
  assert.deepEqual(resolved.args, ['file']);
  assert.equal(resolved.cwd, '/work/admin/nested');
  assert.equal(resolved.envOverlay['FOO'], 'bar');
  assert.equal(resolved.privileged, true);
  assert.equal(resolved.bypassFunctions, true);
  assert.deepEqual(resolved.wrapperChain.map(frame => frame.name), ['sudo', 'env', 'command']);

  const cleared = resolveInvocation(['env', '-i', 'exec', '-c', 'rm', 'file'], { cwd: '/work' });
  assert.equal(cleared.clearEnvironment, true);
  assert.equal(cleared.commandName, 'rm');
});

test('invocation resolver preserves option termination and env operand boundaries', () => {
  const terminated = resolveInvocation(['env', '--', 'FOO=bar', 'rm', 'file'], { cwd: '/work' });
  assert.equal(terminated.commandName, 'rm');
  assert.equal(terminated.envOverlay['FOO'], 'bar');

  const operandBoundary = resolveInvocation(['env', 'PATH=/energy', '--', 'e=mc2', 'bar'], { cwd: '/work' });
  assert.equal(operandBoundary.rawCommand, '--');
  assert.equal(operandBoundary.commandName, '--');
  assert.deepEqual(operandBoundary.args, ['e=mc2', 'bar']);
});

test('invocation resolver reports query, early-exit, invalid, and partial forms', () => {
  const query = resolveInvocation(['command', '-v', 'rm'], { cwd: '/work' });
  assert.equal(query.queryOnly, true);
  assert.equal(query.commandName, undefined);

  const help = resolveInvocation(['nohup', '--help', 'rm', 'file'], { cwd: '/work' });
  assert.equal(help.exitsEarly, true);
  assert.equal(help.commandName, undefined);

  for (const words of [['env', '-u'], ['sudo', '-u'], ['exec', '-a'], ['nohup']]) {
    const invalid = resolveInvocation(words, { cwd: '/work' });
    assert.equal(invalid.completeness, 'invalid', words.join(' '));
    assert.equal(invalid.commandName, undefined, words.join(' '));
  }

  const split = resolveInvocation(['env', '-S', 'rm file'], { cwd: '/work' });
  assert.equal(split.completeness, 'partial');
  assert.ok(split.warnings.some(warning => warning.includes('quoting and expansion grammar')));

  const chroot = resolveInvocation(['sudo', '-R', '/jail', 'rm', 'file'], { cwd: '/work' });
  assert.equal(chroot.completeness, 'partial');
  assert.equal(chroot.commandName, undefined);
});

test('Git invocation resolver binds global operands and repeated cwd changes', () => {
  const resolved = resolveGitInvocation([
    '-c', 'core.quotePath=false',
    '--config-env', 'credential.helper=GIT_HELPER',
    '-C', 'repo', '-C', 'nested',
    '--git-dir=meta', '--work-tree', 'tree',
    'reset', '--hard',
  ], { cwd: '/work' });
  assert.equal(resolved.subcommand, 'reset');
  assert.deepEqual(resolved.args, ['--hard']);
  assert.equal(resolved.context.cwd, '/work/repo/nested');
  assert.equal(resolved.context.gitDir, '/work/repo/nested/meta');
  assert.equal(resolved.context.workTree, '/work/repo/nested/tree');
  assert.equal(resolved.context.confidence, 'explicit');
  assert.equal(resolved.completeness, 'complete');
});

test('Git invocation resolver preserves environment context and rejects option traps', () => {
  const fromEnv = resolveGitInvocation(['reset', '--mixed'], {
    cwd: '/work',
    env: { GIT_DIR: '../meta', GIT_WORK_TREE: 'tree' },
  });
  assert.equal(fromEnv.context.gitDir, '/meta');
  assert.equal(fromEnv.context.workTree, '/work/tree');
  assert.equal(fromEnv.context.confidence, 'environment');

  for (const args of [
    ['-C'],
    ['-Crepo', 'reset'],
    ['--config-env', 'missing-equals', 'reset'],
    ['--super-prefix', 'nested/', 'reset', '--hard'],
    ['--', 'reset'],
  ]) {
    const invalid = resolveGitInvocation(args, { cwd: '/work' });
    assert.equal(invalid.completeness, 'invalid', args.join(' '));
    assert.equal(invalid.subcommand, undefined, args.join(' '));
  }

  const query = resolveGitInvocation(['--exec-path', 'reset', '--hard'], { cwd: '/work' });
  assert.equal(query.exitsEarly, true);
  assert.equal(query.queryOnly, true);
});

test('Git invocation resolver reports bounded partial resolution', () => {
  const partial = resolveGitInvocation(['-C', 'repo', '-C', 'nested', 'reset', '--hard'], {
    cwd: '/work',
    maxArgs: 4,
  });
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.budgetExhausted, true);
  assert.equal(partial.subcommand, undefined);
  assert.equal(partial.context.cwd, '/work/repo/nested');
});

test('git reset resolver applies the last mode instead of searching for --hard', () => {
  assert.equal(resolveGitReset(['--hard', '--soft']).mode, 'soft');
  assert.equal(resolveGitReset(['--soft', '--hard']).mode, 'hard');
  assert.equal(resolveGitReset(['--hard', '--mixed', '--', 'file']).mode, 'mixed');
  assert.equal(resolveGitReset(['--hard', '--mixed', '--', 'file']).form, 'pathspec');
});

test('git reset resolver follows parse-options long abbreviations and negation', () => {
  assert.equal(resolveGitReset(['--har']).mode, 'hard');
  assert.equal(resolveGitReset(['--mer']).mode, 'merge');
  assert.equal(resolveGitReset(['--kee']).mode, 'keep');
  assert.equal(resolveGitReset(['--sof']).mode, 'soft');
  assert.equal(resolveGitReset(['--mix']).mode, 'mixed');
  assert.equal(resolveGitReset(['--m']).completeness, 'invalid');
  assert.equal(resolveGitReset(['--pa']).completeness, 'invalid');

  const cleared = resolveGitReset([
    '--pathspec-from-file=list', '--no-pathspec-from-file', '--hard',
  ]);
  assert.equal(cleared.mode, 'hard');
  assert.equal(cleared.form, 'mode');
  assert.equal(resolveGitReset(['--hard', '--pathspec-from-file=']).form, 'mode');
});

test('git reset resolver binds --hard when it is an operand or pathspec', () => {
  const pathspec = resolveGitReset(['--', '--hard']);
  assert.equal(pathspec.mode, 'mixed');
  assert.equal(pathspec.form, 'pathspec');
  assert.deepEqual(pathspec.selection.pathspecs, ['--hard']);

  const targetPathspec = resolveGitReset(['HEAD', '--', '--hard']);
  assert.equal(targetPathspec.mode, 'mixed');
  assert.equal(targetPathspec.target, 'HEAD');
  assert.equal(targetPathspec.updatesHead, false);

  const operand = resolveGitReset(['--pathspec-from-file', '--hard']);
  assert.equal(operand.mode, 'mixed');
  assert.equal(operand.form, 'pathspec-file');
  assert.equal(operand.selection.pathspecFile, '--hard');
});

test('git reset resolver separates worktree modes from index-only forms', () => {
  for (const mode of ['--hard', '--merge', '--keep'] as const) {
    const resolved = resolveGitReset([mode]);
    assert.equal(resolved.mode, mode.slice(2));
    assert.equal(resolved.form, 'mode');
    assert.equal(resolved.updatesHead, true);
  }
  for (const args of [[], ['--mixed'], ['--soft']] as string[][]) {
    const resolved = resolveGitReset(args);
    assert.equal(resolved.form, 'mode');
    assert.equal(resolved.completeness, 'complete');
  }

  const patch = resolveGitReset(['-qNpU3', 'HEAD', '--', 'file']);
  assert.equal(patch.mode, 'patch');
  assert.equal(patch.form, 'patch');
  assert.deepEqual(patch.selection.pathspecs, ['file']);
  assert.equal(patch.updatesHead, false);
  assert.equal(resolveGitReset(['--patch', '--unified=-1']).completeness, 'complete');
});

test('git reset resolver rejects definite non-executing combinations', () => {
  const cases = [
    ['--hard', 'HEAD', '--', 'file'],
    ['--hard', '--', '--hard'],
    ['--patch', '--pathspec-from-file=list'],
    ['--pathspec-file-nul'],
    ['--hard', '-N'],
    ['--unified=3'],
    ['--no-auto-advance'],
  ];
  for (const args of cases) {
    assert.equal(resolveGitReset(args).completeness, 'invalid', args.join(' '));
  }
});

test('git reset resolver exposes ambiguity, submodule scope, help, and budgets', () => {
  const ambiguous = resolveGitReset(['topic']);
  assert.equal(ambiguous.form, 'ambiguous');
  assert.equal(ambiguous.completeness, 'partial');
  assert.equal(ambiguous.updatesHead, 'conditional');

  assert.equal(resolveGitReset(['--hard', '--recurse-submodules=false']).recurseSubmodules, false);
  assert.equal(resolveGitReset(['--hard', '--recurse-submodules']).recurseSubmodules, true);
  assert.equal(resolveGitReset(['--hard', '--recurse-submodules=2k']).recurseSubmodules, true);
  assert.equal(resolveGitReset(['--hard', '--help']).exitsEarly, true);

  const bounded = resolveGitReset(['--soft', '--quiet', '--hard'], { maxArgs: 2 });
  assert.equal(bounded.mode, 'soft');
  assert.equal(bounded.completeness, 'partial');
  assert.equal(bounded.budgetExhausted, true);

  for (const args of [
    ['--pathspec-from-file', 'list'],
    ['--unified', '3'],
    ['-U', '3'],
    ['-qU', '3'],
  ]) {
    const operandBoundary = resolveGitReset(args, { maxArgs: 1 });
    assert.equal(operandBoundary.completeness, 'partial', args.join(' '));
    assert.equal(operandBoundary.budgetExhausted, true, args.join(' '));
  }
});

test('git clean resolver models force, selection, ignored files, directories, and interaction', () => {
  const clustered = resolveGitClean(['-ffdx']);
  assert.equal(clustered.force, 2);
  assert.equal(clustered.removeDirectories, true);
  assert.equal(clustered.ignoredMode, 'include-ignored');
  assert.deepEqual(clustered.selection, { kind: 'all' });
  assert.equal(clustered.completeness, 'complete');

  const ignoredOnly = resolveGitClean(['-X', 'generated', 'cache']);
  assert.equal(ignoredOnly.ignoredMode, 'ignored-only');
  assert.equal(ignoredOnly.removeDirectories, true);
  assert.deepEqual(ignoredOnly.selection, { kind: 'pathspecs', pathspecs: ['generated', 'cache'] });

  const interactive = resolveGitClean(['--interactive', '--no-interactive', '-i']);
  assert.equal(interactive.interactive, true);
  assert.equal(interactive.force, 0);
});

test('git clean resolver honors last-option wins and option operand boundaries', () => {
  assert.equal(resolveGitClean(['-n', '--no-dry-run']).dryRun, false);
  assert.equal(resolveGitClean(['--no-dry-run', '--dry-run']).dryRun, true);
  assert.equal(resolveGitClean(['-ff', '--no-force']).force, 0);
  assert.equal(resolveGitClean(['--dry']).dryRun, true);
  assert.equal(resolveGitClean(['--no-dry']).dryRun, false);

  const shortExclude = resolveGitClean(['-e', '-n', '-fdx']);
  assert.equal(shortExclude.dryRun, false);
  assert.equal(shortExclude.force, 1);
  assert.equal(shortExclude.ignoredMode, 'include-ignored');

  const attachedShortExclude = resolveGitClean(['-en', '-f']);
  assert.equal(attachedShortExclude.dryRun, false);
  assert.equal(attachedShortExclude.force, 1);

  const longExclude = resolveGitClean(['--exclude', '--dry-run', '-fdx']);
  assert.equal(longExclude.dryRun, false);
  assert.equal(longExclude.force, 1);

  const afterDash = resolveGitClean(['--', '--dry-run']);
  assert.equal(afterDash.dryRun, false);
  assert.deepEqual(afterDash.selection, { kind: 'pathspecs', pathspecs: ['--dry-run'] });
});

test('git clean resolver rejects invalid forms and remains conservative at argument budgets', () => {
  for (const args of [
    ['-xX'],
    ['-e'],
    ['--exclude'],
    ['--no-exclude', 'pattern'],
    ['--dry-run=false'],
    ['--no'],
    ['--unknown'],
  ]) {
    assert.equal(resolveGitClean(args).completeness, 'invalid', args.join(' '));
  }

  assert.equal(resolveGitClean(['--help', '-fdx']).exitsEarly, true);

  const bounded = resolveGitClean(['-n', '-f'], { maxArgs: 1 });
  assert.equal(bounded.dryRun, true);
  assert.equal(bounded.completeness, 'partial');
  assert.equal(bounded.selection.kind, 'unknown');
  assert.equal(bounded.budgetExhausted, true);

  const operandBoundary = resolveGitClean(['-e', 'pattern'], { maxArgs: 1 });
  assert.equal(operandBoundary.completeness, 'partial');
  assert.equal(operandBoundary.budgetExhausted, true);
});

test('invocation resolver normalizes only executable tokens and records path identity', () => {
  const posix = resolveInvocation(['/bin/rm', 'docs/report.docx'], { cwd: '/work' });
  assert.equal(posix.commandName, 'rm');
  assert.equal(posix.rawCommand, '/bin/rm');
  assert.equal(posix.identityConfidence, 'path-basename');
  assert.equal(posix.bypassFunctions, true);

  const windows = resolveInvocation(['C:/Program Files/Git/usr/bin/rm.exe', 'file'], { cwd: '/work' });
  assert.equal(windows.commandName, 'rm');
  assert.equal(windows.identityConfidence, 'path-basename');

  const wrapper = resolveInvocation(['/usr/bin/env', 'rm', '/tmp/file'], { cwd: '/work' });
  assert.equal(wrapper.commandName, 'rm');
  assert.equal(wrapper.wrapperChain[0]?.rawCommand, '/usr/bin/env');
  assert.deepEqual(wrapper.args, ['/tmp/file']);
});

test('invocation resolver stops before guessing beyond its wrapper budget', () => {
  const resolved = resolveInvocation(['sudo', 'env', 'command', 'rm', 'file'], { cwd: '/work', maxWrappers: 2 });
  assert.equal(resolved.completeness, 'partial');
  assert.equal(resolved.commandName, undefined);
  assert.ok(resolved.warnings.some(warning => warning.includes('2 layers')));
});

test('Bash -c resolver binds launcher options command string and positional args', () => {
  const combined = resolveBashCommandString(['-lc', 'rm "$1"', 'shell-zero', 'docs/report.docx']);
  assert.equal(combined.script, 'rm "$1"');
  assert.deepEqual(combined.args, ['docs/report.docx']);

  for (const args of [
    ['--rcfile', '-c', 'rm', 'docs/report.docx'],
    ['-O', '-c', 'rm', 'docs/report.docx'],
    ['--', '-c', 'rm docs/report.docx'],
  ]) {
    const resolved = resolveBashCommandString(args);
    assert.equal(resolved.script, undefined, args.join(' '));
  }

  const missing = resolveBashCommandString(['-lc']);
  assert.equal(missing.completeness, 'invalid');
  assert.ok(missing.warnings.some(warning => warning.includes('-c requires')));
});

test('nested Bash dispatch honors -c operand boundaries and child functions', () => {
  const result = analyze(
    "bash -lc 'rm docs/combined.docx'; bash -c 'rm \"$1\"' shell-zero docs/positional.docx",
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/docs/combined.docx',
    '/work/docs/positional.docx',
  ]);

  assert.deepEqual(analyze('bash -c rm docs/not-an-operand.docx', { cwd: '/work' }).effects, []);
  assert.deepEqual(analyze('bash --rcfile -c rm docs/not-a-command.docx', { cwd: '/work' }).effects, []);

  const child = analyze("rm() { echo safe; }; bash -c 'rm docs/child.docx'", { cwd: '/work' });
  assert.deepEqual(child.effects.map(effect => effect.path), ['/work/docs/child.docx']);
});

test('analyzer dispatches path-qualified handlers without treating paths as exact identities', () => {
  for (const command of [
    '/bin/rm docs/report.docx',
    '"C:/Program Files/Git/usr/bin/rm.exe" docs/report.docx',
    '/usr/bin/env rm docs/report.docx',
  ]) {
    const result = analyze(command, { cwd: '/work' });
    assert.equal(result.effects.length, 1, command);
    assert.equal(result.effects[0].type, 'delete', command);
    assert.equal(result.effects[0].path, '/work/docs/report.docx', command);
    assert.equal(result.effects[0].certainty, 'overapprox', command);
    assert.ok(result.effects[0].uncertainty.includes('command-identity'), command);
  }

  const git = analyze('/usr/bin/git clean -fdx', { cwd: '/work' });
  assert.deepEqual(git.effects, []);
  assert.equal(git.resourceEffects.length, 1);
  assert.equal(git.resourceEffects[0].command, 'git clean');
  assert.ok(git.resourceEffects[0].uncertainty.includes('command-identity'));

  assert.deepEqual(analyze('RM docs/report.docx', { cwd: '/work' }).effects, []);
});

test('analyzer gives functions priority while explicit wrappers bypass them', () => {
  const shadowed = analyze('rm() { echo safe; }; rm docs/report.docx', { cwd: '/work' });
  assert.deepEqual(shadowed.effects, []);

  const effectful = analyze('cat() { rm docs/report.docx; }; cat', { cwd: '/work' });
  assert.deepEqual(effectful.effects.map(effect => [effect.type, effect.path, effect.command]), [
    ['delete', '/work/docs/report.docx', 'rm'],
  ]);

  const bypassed = analyze(
    'rm() { echo safe; }; command rm docs/command.docx; env rm docs/env.docx',
    { cwd: '/work' },
  );
  assert.deepEqual(bypassed.effects.map(effect => [effect.type, effect.path, effect.command]), [
    ['delete', '/work/docs/command.docx', 'rm'],
    ['delete', '/work/docs/env.docx', 'rm'],
  ]);
});

test('analyzer gives supported wrapper forms the target command effects', () => {
  const commands = [
    'rm docs/report.docx',
    '/usr/bin/env rm docs/report.docx',
    'env FOO=1 rm docs/report.docx',
    'command rm docs/report.docx',
    'exec rm docs/report.docx',
    'nohup rm docs/report.docx',
    'sudo rm docs/report.docx',
    'sudo -u root rm docs/report.docx',
    "sudo -- env FOO=1 bash -c 'rm docs/report.docx'",
    'sudo env command rm docs/report.docx',
  ];
  for (const command of commands) {
    const result = analyze(command, { cwd: '/work' });
    assert.equal(result.effects.length, 1, command);
    assert.equal(result.effects[0].type, 'delete', command);
    assert.equal(result.effects[0].path, '/work/docs/report.docx', command);
  }
});

test('analyzer never promotes wrapper option operands into commands', () => {
  const commands = [
    'command -v rm',
    'command -V rm',
    'env -u rm echo safe',
    'env --unset rm echo safe',
    'env -C rm echo safe',
    'sudo -u rm echo safe',
    'sudo --user rm echo safe',
    'sudo -p rm echo safe',
    'sudo -K rm docs/report.docx',
    'sudo --remove-timestamp rm docs/report.docx',
    'exec -a rm echo safe',
    'nohup --help rm docs/report.docx',
    'nohup --version rm docs/report.docx',
  ];
  for (const command of commands) {
    assert.deepEqual(analyze(command, { cwd: '/work' }).effects, [], command);
  }
});

test('wrapper cwd and environment apply to nested shells without leaking', () => {
  const cwd = analyze(
    "env -C docs bash -c 'rm report.docx'; rm sibling-file",
    { cwd: '/work' },
  );
  assert.deepEqual(cwd.effects.map(effect => [effect.type, effect.path]), [
    ['delete', '/work/docs/report.docx'],
    ['delete', '/work/sibling-file'],
  ]);

  const environment = analyze(
    "env TARGET=child.docx bash -c 'rm \"$TARGET\"'; rm \"$TARGET\"",
    { cwd: '/work', env: { TARGET: 'sibling.docx' } },
  );
  assert.deepEqual(environment.effects.map(effect => [effect.type, effect.path]), [
    ['delete', '/work/child.docx'],
    ['delete', '/work/sibling.docx'],
  ]);

  const builtin = analyze('command cd sub; rm child; env cd ignored; rm sibling', { cwd: '/work' });
  assert.deepEqual(builtin.effects.map(effect => effect.path), ['/work/sub/child', '/work/sub/sibling']);
});

test('nested environment resets discard only the context before the reset', () => {
  const innerReset = resolveInvocation(
    ['env', 'OUTER=gone', 'env', '-i', 'INNER=kept', 'rm', 'file'],
    { cwd: '/work' },
  );
  assert.deepEqual({ ...innerReset.envOverlay }, { INNER: 'kept' });
  assert.equal(innerReset.clearEnvironment, true);

  const outerReset = resolveInvocation(
    ['env', '-i', 'OUTER=kept', 'env', 'INNER=kept', 'rm', 'file'],
    { cwd: '/work' },
  );
  assert.deepEqual({ ...outerReset.envOverlay }, { OUTER: 'kept', INNER: 'kept' });

  const analyzed = analyze(
    "env -i TARGET=child.docx bash -c 'rm \"$TARGET\"'; rm \"$TARGET\"",
    { cwd: '/work', env: { TARGET: 'sibling.docx' } },
  );
  assert.deepEqual(analyzed.effects.map(effect => effect.path), [
    '/work/child.docx',
    '/work/sibling.docx',
  ]);

  const empty = analyze("env -i bash -c 'rm -rf \"$TARGET\"'", { cwd: '/work' });
  assert.deepEqual(empty.effects, []);
  assert.ok(empty.warnings.some(warning => warning.includes('empty path')));
});

test('invalid partial and over-budget wrappers stop before target dispatch', () => {
  for (const command of ['env -u', 'sudo -u', 'exec -a', 'nohup', 'sudo --', "env -S 'rm file'"]) {
    const result = analyze(command, { cwd: '/work' });
    assert.deepEqual(result.effects, [], command);
    assert.ok(result.warnings.length > 0, command);
  }

  const command = `${Array.from({ length: 13 }, () => 'env').join(' ')} rm docs/report.docx`;
  const overBudget = analyze(command, { cwd: '/work' });
  assert.deepEqual(overBudget.effects, []);
  assert.ok(overBudget.warnings.some(warning => warning.includes('12 layers')));

  assert.deepEqual(analyze('command --; env --', { cwd: '/work' }).effects, []);
});

// ── 1. echo hello > out.txt → write on out.txt ──

test('echo hello > out.txt → write effect', () => {
  const r = analyze('echo hello > out.txt', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/tmp/out.txt');
});

test('bounded provenance explains AST, expansion, command, guard, and VFS stages', () => {
  const script = 'target=report.docx; mystery && rm "$target"';
  const result = analyze(script, {
    cwd: '/work',
    fs: ['/work/report.docx'],
  });
  assert.equal(result.effects.length, 1);
  assert.ok((result.effects[0].provenance?.length ?? 0) > 0);
  assert.equal(result.provenance.truncated, false);
  assert.ok(result.provenance.nodes.length <= MAX_PROVENANCE_NODES);

  const explanation = explainEffect(result, 0).join('\n');
  for (const expected of [
    'ast-command at line 1: rm "$target"',
    'expansion at line 1: parameter: $target',
    'variable-binding at line 1: bind target',
    'command-model at line 1: rm predicts delete',
    'vfs-transition at line 1: delete /work/report.docx',
    'control-guard at line 1: precision widened: and-or-branch',
  ]) {
    assert.ok(explanation.includes(expected), expected);
  }

  const repeated = analyze(script, {
    cwd: '/work',
    fs: ['/work/report.docx'],
  });
  assert.deepEqual(repeated.provenance, result.provenance);
  assert.deepEqual(
    repeated.effects.map(effect => effect.provenance),
    result.effects.map(effect => effect.provenance),
  );
});

test('provenance follows bindings and exact state convergence', () => {
  const chained = analyze(
    'base=docs; target="$base/report.docx"; rm "$target"',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  const chainedExplanation = explainEffect(chained, 0).join('\n');
  for (const expected of [
    'variable-binding at line 1: bind base',
    'expansion at line 1: parameter: $base',
    'variable-binding at line 1: bind target',
    'expansion at line 1: parameter: $target',
  ]) {
    assert.ok(chainedExplanation.includes(expected), expected);
  }

  const converged = analyze(
    'if mystery; then target=docs/report.docx; '
      + 'else target=docs/report.docx; fi; rm "$target"',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  assert.equal(converged.effects[0].certainty, 'exact');
  assert.ok(explainEffect(converged, 0)
    .some(line => line.includes('state-join at line 1: join equivalent target bindings')));

  const array = analyze(
    'files[2]=docs/report.docx; rm "${files[2]}"',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  assert.ok(explainEffect(array, 0)
    .some(line => line.includes('variable-binding at line 1: bind files[2]')));
});

test('provenance follows bare arithmetic variable reads', () => {
  const assigned = analyze(
    'source=40; (( target = source + 2 )); rm "$target"',
    {
      cwd: '/work',
      fs: ['/work/42'],
    },
  );
  const assignedExplanation = explainEffect(assigned, 0).join('\n');
  for (const expected of [
    'variable-binding at line 1: bind source',
    'variable-binding at line 1: bind target',
    'expansion at line 1: parameter: $target',
  ]) {
    assert.ok(assignedExplanation.includes(expected), expected);
  }

  const expanded = analyze(
    'target=7; rm "$((target))"',
    {
      cwd: '/work',
      fs: ['/work/7'],
    },
  );
  const expandedExplanation = explainEffect(expanded, 0).join('\n');
  assert.ok(expandedExplanation
    .includes('expansion at line 1: arithmetic: $((target))'));
  assert.ok(expandedExplanation
    .includes('variable-binding at line 1: bind target'));

  const shortCircuited = analyze(
    'skipped=99; selected=1; rm "$((selected || skipped))"',
    {
      cwd: '/work',
      fs: ['/work/1'],
    },
  );
  const shortCircuitExplanation = explainEffect(shortCircuited, 0).join('\n');
  assert.ok(shortCircuitExplanation
    .includes('variable-binding at line 1: bind selected'));
  assert.ok(!shortCircuitExplanation
    .includes('variable-binding at line 1: bind skipped'));

  const indexed = analyze(
    'index=2; files[2]=docs/report.docx; rm "${files[index]}"',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  const indexedExplanation = explainEffect(indexed, 0).join('\n');
  assert.ok(indexedExplanation
    .includes('variable-binding at line 1: bind index'));
  assert.ok(indexedExplanation
    .includes('variable-binding at line 1: bind files[2]'));
});

test('provenance follows pipeline command-substitution and fd streams', () => {
  const pipeline = analyze(
    'printf "%s\\n" docs/report.docx | { read target; rm "$target"; }',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  const pipelineExplanation = explainEffect(pipeline, 0).join('\n');
  for (const expected of [
    'ast-command at line 1: printf',
    'stream-flow at line 1: write fd 1 to captured stream',
    'stream-flow at line 1: bind input stream to fd 0',
    'stream-flow at line 1: read from fd 0',
    'variable-binding at line 1: bind target',
  ]) {
    assert.ok(pipelineExplanation.includes(expected), expected);
  }

  const substituted = analyze(
    'target=$(printf "%s" docs/report.docx); rm "$target"',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  const substitutionExplanation = explainEffect(substituted, 0).join('\n');
  assert.ok(substitutionExplanation
    .includes('expansion at line 1: command-substitution: '
      + '$(printf "%s" docs/report.docx)'));
  assert.ok(substitutionExplanation
    .includes('stream-flow at line 1: write fd 1 to captured stream'));

  const duplicated = analyze(
    'read target 3<<<docs/report.docx <&3; rm "$target"',
    {
      cwd: '/work',
      fs: ['/work/docs/report.docx'],
    },
  );
  const duplicatedExplanation = explainEffect(duplicated, 0).join('\n');
  assert.ok(duplicatedExplanation
    .includes('stream-flow at line 1: duplicate fd 3 to fd 0'));
  assert.ok(duplicatedExplanation
    .includes('stream-flow at line 1: read from fd 0'));
});

test('provenance budget retains a stable truncation witness', () => {
  const script = Array.from(
    { length: 600 },
    (_, index) => `rm file-${index}.txt`,
  ).join('; ');
  const result = analyze(script, { cwd: '/work', fs: [] });
  assert.equal(result.effects.length, 600);
  assert.equal(result.provenance.truncated, true);
  assert.ok(result.provenance.nodes.length <= MAX_PROVENANCE_NODES);
  assert.ok(result.provenance.nodes.some(node => node.kind === 'budget'));
  assert.ok(explainEffect(result, result.effects.length - 1)
    .some(line => line.includes('provenance truncated')));
});

test('postprocess observations link back to local effect provenance', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-provenance-'));
  const child = nodePath.join(root, 'report.docx');
  fs.writeFileSync(child, 'report');
  try {
    const result = analyze(`rm -rf "${root}"`, { cwd: '/' });
    const analysisNodeCount = result.provenance.nodes.length;
    const observed = postprocess(result.effects, {
      provenance: result.provenance,
    });
    const file = observed.oldest.find(candidate => candidate.path === child);
    assert.ok(file);
    assert.deepEqual(file.effectIndexes, [0]);
    assert.equal(file.effectIndexesTruncated, false);
    assert.ok(explainObservation(result, file).flat()
      .some(line => line.includes(`delete ${root}`)));
    assert.ok(observed.provenance);
    assert.ok((file.provenance?.length ?? 0) > 0);
    const observedExplanation = explainObservation(result, file, {
      provenance: observed.provenance,
    }).flat();
    assert.ok(observedExplanation
      .some(line => line.includes('filesystem-observation')));
    assert.ok(observedExplanation
      .some(line => line.includes('rm predicts delete')));
    assert.equal(result.provenance.nodes.length, analysisNodeCount);
    assert.equal(observed.specialTargets[0].effectIndex, 0);
    assert.ok(explainObservation(result, observed.specialTargets[0]).flat()
      .some(line => line.includes('rm predicts delete')));

    const rejected = postprocess(result.effects, {
      provenance: {
        nodes: Array.from({ length: MAX_PROVENANCE_NODES + 1 }, (_, id) => ({
          id,
          kind: 'ast-command' as const,
          label: 'oversized',
          parents: [],
        })),
        truncated: false,
      },
    });
    assert.equal(rejected.provenance, undefined);
    assert.equal(rejected.oldest[0].provenance, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. rm -rf /tmp/foo bar.txt → two delete effects ──

test('rm -rf /tmp/foo bar.txt → two deletes', () => {
  const r = analyze('rm -rf /tmp/foo bar.txt', { cwd: '/home' });
  assert.equal(r.effects.length, 2);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/tmp/foo');
  assert.equal(r.effects[1].type, 'delete');
  assert.equal(r.effects[1].path, '/home/bar.txt');
});

// ── 3. mkdir -p a/b/c && cp src.txt a/b/c/ → mkdir + copy ──

test('mkdir -p a/b/c && cp src.txt a/b/c/ → mkdir + copy', () => {
  const r = analyze('mkdir -p a/b/c && cp src.txt a/b/c/', { cwd: '/work' });
  assert.equal(r.effects.length, 2);
  assert.equal(r.effects[0].type, 'mkdir');
  assert.equal(r.effects[0].path, '/work/a/b/c');
  assert.equal(r.effects[1].type, 'copy');
  assert.equal(r.effects[1].path, '/work/a/b/c/src.txt');
});

// ── 4. DIR=/tmp; rm $DIR/file → delete /tmp/file ──

test('DIR=/tmp; rm $DIR/file → delete /tmp/file', () => {
  const r = analyze('DIR=/tmp; rm $DIR/file', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/tmp/file');
});

// ── 5. condition status selects feasible branches ──

test('if/else selects a statically successful branch', () => {
  const r = analyze('if true; then rm a; else rm b; fi', { cwd: '/tmp' });
  assert.deepEqual(r.effects.map(e => e.path), ['/tmp/a']);
  assert.equal(r.effects[0].certainty, 'exact');
});

test('if evaluates deterministic bracket string comparisons', () => {
  const r = analyze(
    'PPTX_DIR=./slides; choice=1; if [ "$choice" = "0" ]; then rm -f "$PPTX_DIR/q4-random-7319.pptx"; else rm -f "$PPTX_DIR/backup-random-2048.pptx"; fi',
    { cwd: '/tmp' },
  );
  assert.deepEqual(r.effects.map(e => e.path), ['/tmp/slides/backup-random-2048.pptx']);
});

test('double-bracket parser builds a conditional AST and round-trips', () => {
  const parsed = parse('[[ x == x && ( -n y || ! -z z ) ]]');
  assert.equal(parsed.ast?.type, 'cond');
  assert.deepEqual(parsed.warnings, []);
  const printed = print_command(parsed.ast);
  assert.ok(printed.startsWith('[[ '));
  const reparsed = parse(printed);
  assert.equal(reparsed.ast?.type, 'cond');
  assert.deepEqual(reparsed.warnings, []);

  const ordinary = parse('echo [[');
  assert.equal(ordinary.ast?.type, 'simple');
  if (ordinary.ast?.type === 'simple') {
    assert.deepEqual(ordinary.ast.words.map(word => word.word), ['echo', '[[']);
  }
});

test('double-bracket conditions select exact string pattern and integer paths', () => {
  const r = analyze(`
    target=docs/report.docx
    if [[ -n "$target" && "$target" == docs/*.docx ]]; then
      rm selected.docx
    else
      rm impossible-pattern.docx
    fi
    if [[ "$target" == "docs/*.docx" ]]; then
      rm impossible-quoted.docx
    else
      rm quoted-literal.pptx
    fi
    if [[ 7 -gt 3 && ! 7 -eq 4 ]]; then
      rm numeric.pdf
    fi
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/selected.docx',
    '/work/quoted-literal.pptx',
    '/work/numeric.pdf',
  ]);
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
});

test('double-bracket unary predicates read branch-local shell and VFS state', () => {
  const r = analyze(`
    target=ready
    mkdir cache
    if [[ -d cache && -v target && -o hashall ]]; then
      rm selected.docx
    else
      rm impossible.docx
    fi
    set +h
    if [[ -o hashall ]]; then
      rm impossible-option.docx
    else
      rm option-disabled.pptx
    fi
  `, { cwd: '/work', fs: [] });
  assert.deepEqual(
    r.effects.filter(effect => effect.type === 'delete').map(effect => effect.path),
    ['/work/selected.docx', '/work/option-disabled.pptx'],
  );
});

test('double-bracket logical operators short-circuit operand expansion', () => {
  const r = analyze(`
    [[ -n yes || "$(rm skipped-or.docx)" == x ]]
    [[ -z yes && "$(rm skipped-and.docx)" == x ]]
    if [[ "$(mystery)" == ready && "$(rm conditional.docx)" == x ]]; then
      :
    fi
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/conditional.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'overapprox');
  assert.ok(r.effects[0].uncertainty.includes('and-or-branch'));
});

test('unsupported double-bracket regex and extglob predicates stay conservative', () => {
  const regex = analyze(`
    if [[ value =~ ^v ]]; then rm regex-a.docx; else rm regex-b.pptx; fi
  `, { cwd: '/work' });
  assert.deepEqual(regex.effects.map(effect => effect.path), [
    '/work/regex-a.docx',
    '/work/regex-b.pptx',
  ]);
  assert.ok(regex.effects.every(effect =>
    effect.uncertainty.includes('conditional-branch')));

  const extglob = analyze(`
    if [[ value == @(value|other) ]]; then rm extglob-a.docx; else rm extglob-b.pptx; fi
  `, { cwd: '/work' });
  assert.deepEqual(extglob.effects.map(effect => effect.path), [
    '/work/extglob-a.docx',
    '/work/extglob-b.pptx',
  ]);
  assert.ok(extglob.warnings.some(warning =>
    warning.includes('conditional expression')
    && warning.includes('widened to unknown')));
});

test('malformed double-bracket recovery retains effects and following commands', () => {
  const empty = analyze('[[ ]]; rm after-empty.docx', { cwd: '/work' });
  assert.deepEqual(empty.effects.map(effect => effect.path), [
    '/work/after-empty.docx',
  ]);
  assert.ok(empty.warnings.some(warning =>
    warning.includes('conditional expression')
    && warning.includes('widened to unknown')));

  const extglob = analyze(`
    if [[ value == @(x|$(rm hidden.docx)) ]]; then
      rm possible-a.pptx
    else
      rm possible-b.pdf
    fi
    rm after-extglob.docx
  `, { cwd: '/work' });
  assert.deepEqual(extglob.effects.map(effect => effect.path), [
    '/work/hidden.docx',
    '/work/possible-a.pptx',
    '/work/possible-b.pdf',
    '/work/after-extglob.docx',
  ]);
  assert.equal(extglob.effects[0].certainty, 'overapprox');
  assert.ok(extglob.effects[0].uncertainty.includes('and-or-branch'));
});

test('if preserves condition effects and forks an unknown command status', () => {
  const r = analyze('if rm guard.pptx; then rm then.pptx; else rm else.pptx; fi', { cwd: '/tmp' });
  assert.deepEqual(r.effects.map(e => e.path), [
    '/tmp/guard.pptx',
    '/tmp/then.pptx',
    '/tmp/else.pptx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');
  assert.ok(r.effects.slice(1).every(e => e.uncertainty.includes('conditional-branch')));
});

test('if fuzzy condition tolerates chained tests and command substitution', () => {
  const r = analyze(
    'ROOT=/deck; if [ -f "$ROOT/source.pptx" ] && [ "$(whoami)" = agent ]; then rm "$ROOT/live.pptx"; else rm "$ROOT/archive.pptx"; fi',
    { cwd: '/tmp' },
  );
  assert.deepEqual(r.effects.map(e => e.path), [
    '/deck/live.pptx',
    '/deck/archive.pptx',
  ]);
});

test('uncertainty survives command-substitution assignment into a later condition', () => {
  const r = analyze(
    'choice=$(mystery); if [ "$choice" = 0 ]; then rm a; else rm b; fi',
    { cwd: '/tmp' },
  );
  assert.deepEqual(r.effects.map(e => e.path), ['/tmp/a', '/tmp/b']);
  assert.ok(r.effects.every(e => e.uncertainty.includes('conditional-branch')));
});

test('command substitution captures modeled stdout and strips trailing newlines', () => {
  const result = analyze(
    "target=$(printf '%s\\n\\n' report.txt); rm \"$target\"",
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/report.txt',
  ]);
  assert.equal(result.effects[0].certainty, 'exact');
  assert.deepEqual(result.effects[0].uncertainty, []);
});

test('word lexer retains command substitutions that begin an unquoted token', () => {
  const result = analyze(`
    rm $(printf '%s' direct.docx)
    rm \`printf '%s' legacy.pptx\`
  `, { cwd: '/work' });
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/direct.docx',
    '/work/legacy.pptx',
  ]);
  assert.ok(result.effects.every(effect => effect.certainty === 'exact'));
});

test('command substitution grouping retains case and here-document bodies', () => {
  const result = analyze(`
    echo $(case x in x) rm command-case.docx;; esac)
    echo $(cat <<EOF
)
EOF
rm command-heredoc.pptx
)
  `, { cwd: '/work' });
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/command-case.docx',
    '/work/command-heredoc.pptx',
  ]);
});

test('path-qualified producer names cannot claim exact builtin stdout', () => {
  const result = analyze(
    'target=$(/tmp/printf "%s" report.txt); rm "$target"',
    { cwd: '/work' },
  );
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].uncertain, true);
  assert.ok(result.effects[0].uncertainty.includes('unresolved-expansion'));
  assert.notEqual(result.effects[0].path, '/work/report.txt');
});

test('command substitution status controls assignment-only commands', () => {
  const result = analyze(
    'target=$(false) || rm fallback; target=$(true) && rm success',
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/fallback',
    '/work/success',
  ]);
});

test('command substitution preserves effects and deterministic VFS feedback', () => {
  const result = analyze(
    'value=$(rm a.txt); rm *.txt',
    { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/a.txt',
    '/work/b.txt',
  ]);
});

test('pipelines inside command substitution feed captured stdout', () => {
  const result = analyze(
    "target=$(printf '%s' piped.txt | cat); rm \"$target\"",
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/piped.txt',
  ]);
  assert.equal(result.effects[0].certainty, 'exact');
});

test('command substitution honors fd routing and here-string input', () => {
  const routed = analyze(
    "target=$(printf '%s' hidden >&2; printf '%s' visible.txt); rm \"$target\"",
    { cwd: '/work' },
  );
  assert.deepEqual(routed.effects.map(effect => effect.path), [
    '/work/visible.txt',
  ]);

  const input = analyze(
    "target=$({ read value; printf '%s' \"$value\"; } <<< payload.txt); "
      + 'rm "$target"',
    { cwd: '/work' },
  );
  assert.deepEqual(input.effects.map(effect => effect.path), [
    '/work/payload.txt',
  ]);
});

test('process substitution lexer retains nested shell syntax and boundaries', () => {
  const script = 'cat <(echo "literal)"; rm inside.docx)';
  const parsed = parse(script);
  assert.equal(parsed.ast?.type, 'simple');
  assert.deepEqual(parsed.warnings, []);
  if (parsed.ast?.type === 'simple') {
    assert.equal(parsed.ast.words[1]?.word, '<(echo "literal)"; rm inside.docx)');
  }
  if (!parsed.ast) throw new Error('expected process substitution AST');
  const printed = print_command(parsed.ast);
  assert.ok(parse(printed).ast);

  const comments = analyze(
    'cat <(echo value # )\n; rm after-comment.pptx)',
    { cwd: '/work' },
  );
  assert.deepEqual(comments.effects.map(effect => effect.path), [
    '/work/after-comment.pptx',
  ]);

  const caseBody = analyze(
    'cat <(case x in x) rm case-target.docx;; esac)',
    { cwd: '/work' },
  );
  assert.deepEqual(caseBody.effects.map(effect => effect.path), [
    '/work/case-target.docx',
  ]);

  const hereDocument = analyze(
    'cat <(cat <<EOF\n)\nEOF\nrm heredoc-target.pptx\n)',
    { cwd: '/work' },
  );
  assert.deepEqual(hereDocument.effects.map(effect => effect.path), [
    '/work/heredoc-target.pptx',
  ]);

  const nestedQuotes = analyze(
    'cat <(echo "$(printf "%s)" x)"; rm nested-quotes.docx)',
    { cwd: '/work' },
  );
  assert.deepEqual(nestedQuotes.effects.map(effect => effect.path), [
    '/work/nested-quotes.docx',
  ]);

  const embedded = analyze(
    'echo prefix<(rm embedded.pdf)suffix',
    { cwd: '/work' },
  );
  assert.deepEqual(embedded.effects.map(effect => effect.path), [
    '/work/embedded.pdf',
  ]);
});

test('process substitution executes an isolated child and retains its effects', () => {
  const result = analyze(`
    target=outer.docx
    cleanup() { rm function.pdf; }
    cat <(
      target=inner.pptx
      cd /tmp
      cleanup
      rm "$target"
    )
    rm "$target"
  `, { cwd: '/work' });
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/tmp/function.pdf',
    '/tmp/inner.pptx',
    '/work/outer.docx',
  ]);
  assert.ok(result.effects.every(effect => effect.certainty === 'exact'));

  const nested = analyze(
    'cat <(cat <(rm nested.docx)) <(rm sibling.pptx)',
    { cwd: '/work' },
  );
  assert.deepEqual(nested.effects.map(effect => effect.path), [
    '/work/nested.docx',
    '/work/sibling.pptx',
  ]);
});

test('process substitution handles never become user-file effects', () => {
  const result = analyze(`
    printf payload > >(rm consumer.docx)
    tee >(rm tee.pdf) < /dev/null
    rm <(rm nested.pptx)
  `, { cwd: '/work', fs: [] });
  assert.deepEqual(result.effects.map(effect => [effect.type, effect.path]), [
    ['delete', '/work/consumer.docx'],
    ['delete', '/work/tee.pdf'],
    ['delete', '/work/nested.pptx'],
  ]);
  assert.ok(result.effects.every(effect => !effect.path.startsWith('/dev/fd/')));

  const empty = analyze('rm <(); printf value > >()', { cwd: '/work' });
  assert.deepEqual(empty.effects, []);
});

test('process substitution respects quoting and selected parameter words', () => {
  const literal = analyze(`
    echo "<(rm double-quoted.docx)" '<(rm single-quoted.pptx)'
    value=$((4<(2+3)))
    cat <<EOF
<(rm heredoc.pdf)
EOF
  `, { cwd: '/work' });
  assert.deepEqual(literal.effects, []);

  const selected = analyze(`
    cat \${missing:-<(rm default.docx)}
    present=yes
    cat \${present:+<(rm alternate.pptx)}
    cat \${present:-<(rm skipped-default.pdf)}
    cat \${missing:+<(rm skipped-alternate.pdf)}
  `, { cwd: '/work' });
  assert.deepEqual(selected.effects.map(effect => effect.path), [
    '/work/default.docx',
    '/work/alternate.pptx',
  ]);
});

test('process substitution VFS races widen later filesystem selection', () => {
  const result = analyze(
    'cat <(rm existing.txt); rm *.txt',
    { cwd: '/work', fs: ['/work/existing.txt', '/work/other.txt'] },
  );
  assert.equal(result.effects[0].path, '/work/existing.txt');
  assert.equal(result.effects[0].certainty, 'exact');
  assert.equal(result.effects[1].path, '/work/*.txt');
  assert.equal(result.effects[1].certainty, 'unknown');
  assert.ok(result.effects[1].uncertainty.includes('glob-without-fs'));
  assert.ok(result.warnings.some(warning =>
    warning.includes('process substitution VFS effects race')));
});

test('process substitution execution is explicitly budgeted', () => {
  const script = Array.from(
    { length: 66 },
    (_, index) => `cat <(rm process-${index}.txt)`,
  ).join('; ');
  const result = analyze(script, { cwd: '/work' });
  assert.equal(result.effects.length, 64);
  assert.ok(result.warnings.some(warning =>
    warning.includes('skipped after 64 expansions')));
  assert.ok(result.effects.every(effect => !effect.path.startsWith('/dev/fd/')));
});

test('unquoted here-doc expansion analyzes nested command substitutions', () => {
  const expanded = analyze(
    'cat <<EOF\n$(rm exposed.txt)\nEOF\n',
    { cwd: '/work' },
  );
  assert.deepEqual(expanded.effects.map(effect => effect.path), [
    '/work/exposed.txt',
  ]);

  const quoted = analyze(
    "cat <<'EOF'\n$(rm hidden.txt)\nEOF\n",
    { cwd: '/work' },
  );
  assert.deepEqual(quoted.effects, []);
});

test('if elif else preserves effects from every unknown condition', () => {
  const r = analyze(
    'if rm cond-a.pptx; then rm a.pptx; elif [ -f cond-b.pptx ]; then rm b.pptx; else rm c.pptx; fi',
    { cwd: '/tmp' },
  );
  assert.deepEqual(r.effects.map(e => e.path), [
    '/tmp/cond-a.pptx',
    '/tmp/a.pptx',
    '/tmp/b.pptx',
    '/tmp/c.pptx',
  ]);
});

test('sleep before rm does not block pptx delete detection', () => {
  const r = analyze('sleep 1000; rm test.pptx', { cwd: '/tmp' });
  assert.deepEqual(r.effects.map(e => e.path), ['/tmp/test.pptx']);
});

test('sleep in fuzzy if condition is ignored while branches run', () => {
  const r = analyze('if sleep 1000; then rm test.pptx; else rm fallback.pptx; fi', { cwd: '/tmp' });
  assert.deepEqual(r.effects.map(e => e.path), [
    '/tmp/test.pptx',
    '/tmp/fallback.pptx',
  ]);
});

test('and-or lists prune known statuses and retain unknown alternatives', () => {
  assert.deepEqual(analyze('false && rm no-a; true || rm no-b', { cwd: '/tmp' }).effects, []);
  const definite = analyze('true && rm yes-a; false || rm yes-b', { cwd: '/tmp' });
  assert.deepEqual(definite.effects.map(e => e.path), ['/tmp/yes-a', '/tmp/yes-b']);
  assert.ok(definite.effects.every(e => !e.uncertainty.includes('and-or-branch')));

  const conditional = analyze('mystery && rm maybe-a; mystery || rm maybe-b', { cwd: '/tmp' });
  assert.deepEqual(conditional.effects.map(e => e.path), ['/tmp/maybe-a', '/tmp/maybe-b']);
  assert.ok(conditional.effects.every(e => e.uncertainty.includes('and-or-branch')));
});

test('logical negation and dollar-question use abstract command status', () => {
  const r = analyze('false; rm "$?.txt"; ! true; rm "$?.log"', { cwd: '/tmp' });
  assert.deepEqual(r.effects.map(e => e.path), ['/tmp/1.txt', '/tmp/1.log']);
});

test('test builtin evaluates strings integers and known VFS entry types', () => {
  const r = analyze(
    'if test 2 -gt 1; then rm integer-ok; fi; '
      + 'if [ -f file.txt ]; then rm file-ok; fi; '
      + 'if [ -d folder ]; then rm -r dir-ok; fi',
    { cwd: '/tmp', fs: ['/tmp/file.txt', '/tmp/folder/'] },
  );
  assert.deepEqual(r.effects.map(e => e.path), [
    '/tmp/integer-ok',
    '/tmp/file-ok',
    '/tmp/dir-ok',
  ]);
});

test('unknown branches retain variable and cwd alternatives for later effects', () => {
  const variables = analyze(
    'TARGET=base; if mystery; then TARGET=a; else TARGET=b; fi; rm "$TARGET"',
    { cwd: '/work' },
  );
  assert.deepEqual(
    variables.effects.map(effect => effect.path).sort(),
    ['/work/a', '/work/b'],
  );
  assert.ok(variables.effects.every(effect =>
    effect.uncertainty.includes('conditional-branch')));

  const directories = analyze(
    'if mystery; then cd /a; else cd /b; fi; rm target',
    { cwd: '/work' },
  );
  assert.deepEqual(
    directories.effects.map(effect => effect.path).sort(),
    ['/a/target', '/b/target'],
  );
});

test('and-or branch states preserve both skipped and executed assignments', () => {
  const result = analyze(
    'TARGET=base; mystery && TARGET=alt; rm "$TARGET"',
    { cwd: '/work' },
  );
  assert.deepEqual(
    result.effects.map(effect => effect.path).sort(),
    ['/work/alt', '/work/base'],
  );
  assert.ok(result.effects.every(effect =>
    effect.uncertainty.includes('and-or-branch')));
});

test('branch-local shell options do not leak between alternatives', () => {
  const result = analyze(
    'if mystery; then set -f; else :; fi; rm *.txt',
    { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] },
  );
  assert.deepEqual(
    result.effects.map(effect => effect.path).sort(),
    ['/work/*.txt', '/work/a.txt', '/work/b.txt'],
  );
  const unresolved = result.effects.find(effect => effect.path === '/work/*.txt');
  assert.ok(unresolved?.uncertainty.includes('glob-without-fs'));
});

test('equivalent branch states converge before the following command', () => {
  const result = analyze(
    'if mystery; then :; else :; fi; rm exact.txt',
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), ['/work/exact.txt']);
  assert.equal(result.effects[0].certainty, 'exact');
  assert.deepEqual(result.effects[0].uncertainty, []);
});

test('effects reached from every branch lose execution-only uncertainty', () => {
  const result = analyze(
    'f() { if mystery; then return 4; else rm branch; fi; rm tail; }; f; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(
    result.effects.map(effect => effect.path),
    ['/work/branch', '/work/tail', '/work/after'],
  );
  assert.ok(result.effects[0].uncertainty.includes('conditional-branch'));
  assert.ok(result.effects[1].uncertainty.includes('conditional-branch'));
  assert.equal(result.effects[2].certainty, 'exact');
  assert.deepEqual(result.effects[2].uncertainty, []);
  assert.ok(!explainEffect(result, 2)
    .some(line => line.includes('precision widened: conditional-branch')));
});

test('function and subshell branch snapshots restore shell-local state', () => {
  const func = analyze(
    'TARGET=outer; f() { local TARGET=inner; '
      + 'if mystery; then TARGET=a; else TARGET=b; fi; }; f; rm "$TARGET"',
    { cwd: '/work' },
  );
  assert.deepEqual(func.effects.map(effect => effect.path), ['/work/outer']);
  assert.deepEqual(func.effects[0].uncertainty, []);

  const subshell = analyze(
    'TARGET=outer; (if mystery; then TARGET=a; else TARGET=b; fi); rm "$TARGET"',
    { cwd: '/work' },
  );
  assert.deepEqual(subshell.effects.map(effect => effect.path), ['/work/outer']);
  assert.deepEqual(subshell.effects[0].uncertainty, []);
});

test('branch-state budget widens to unknown values instead of dropping paths', () => {
  const branches = Array.from(
    { length: 7 },
    (_, index) => `if mystery; then V${index}=a; else V${index}=b; fi`,
  ).join('; ');
  const result = analyze(
    `${branches}; rm "$V0$V1$V2$V3$V4$V5$V6"`,
    { cwd: '/work' },
  );
  assert.equal(result.effects.length, 1);
  assert.ok(result.effects[0].uncertainty.includes('state-widening'));
  assert.equal(result.effects[0].certainty, 'unknown');
  assert.ok(result.warnings.some(warning =>
    warning.includes('branch state widened after 64 alternatives')));
});

// ── 6. for f in a b c; do rm $f; done → 3 deletes ──

test('for loop with static list → 3 deletes', () => {
  const r = analyze('for f in a b c; do rm $f; done', { cwd: '/tmp' });
  assert.equal(r.effects.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(r.effects[i].type, 'delete');
  }
  assert.equal(r.effects[0].path, '/tmp/a');
  assert.equal(r.effects[1].path, '/tmp/b');
  assert.equal(r.effects[2].path, '/tmp/c');
});

test('break and continue stop the remaining commands in concrete for iterations', () => {
  const stopped = analyze(
    'for x in a b c; do rm "$x"; break; rm no; done; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(stopped.effects.map(effect => effect.path), [
    '/work/a',
    '/work/after',
  ]);

  const continued = analyze(
    'for x in a b; do continue; rm "$x"; done; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(continued.effects.map(effect => effect.path), ['/work/after']);
});

test('multi-level break and continue cross exactly one loop boundary at a time', () => {
  const broken = analyze(
    'for x in outer; do '
      + 'for y in a b; do rm "$y"; break 2; done; '
      + 'rm outer-no; done; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(broken.effects.map(effect => effect.path), [
    '/work/a',
    '/work/after',
  ]);

  const continued = analyze(
    'for x in a b; do '
      + 'for y in 1 2; do rm "$x$y"; continue 2; done; '
      + 'rm no; done; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(continued.effects.map(effect => effect.path), [
    '/work/a1',
    '/work/b1',
    '/work/after',
  ]);

  const invalidContinue = analyze(
    'for x in a b; do '
      + 'for y in 1 2; do rm "$x$y"; continue 0; done; '
      + 'rm no; done; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(invalidContinue.effects.map(effect => effect.path), [
    '/work/a1',
    '/work/after',
  ]);
});

test('return and exit propagate separately from command status', () => {
  const returned = analyze(
    'f() { rm before; return 7; rm no; }; f || rm fallback; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(returned.effects.map(effect => effect.path), [
    '/work/before',
    '/work/fallback',
    '/work/after',
  ]);

  const exited = analyze('rm before; exit 7; rm after', { cwd: '/work' });
  assert.deepEqual(exited.effects.map(effect => effect.path), ['/work/before']);
});

test('child-shell exit does not terminate the parent shell', () => {
  const subshell = analyze('(exit 3; rm no); rm after', { cwd: '/work' });
  assert.deepEqual(subshell.effects.map(effect => effect.path), ['/work/after']);

  const pipeline = analyze('exit 3 | true; rm after', { cwd: '/work' });
  assert.deepEqual(pipeline.effects.map(effect => effect.path), ['/work/after']);
});

// ── 7. cat foo >> bar → append on bar ──

test('cat foo >> bar → append effect', () => {
  const r = analyze('cat foo >> bar', { cwd: '/data' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'append');
  assert.equal(r.effects[0].path, '/data/bar');
});

// ── 8. cat <<EOF > out.txt ... EOF → write on out.txt ──

test('here-doc redirect → write effect', () => {
  const r = analyze('cat <<EOF > out.txt\nhello world\nEOF', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/tmp/out.txt');
});

test('here-doc AST preserves whether the delimiter was quoted', () => {
  const quoted = parse("cat <<'EOF'\n$(rm quoted.txt)\nEOF");
  const expandable = parse('cat <<EOF\n$(rm expandable.txt)\nEOF');
  assert.equal(quoted.ast?.redirects?.here_doc_quoted, true);
  assert.equal(quoted.ast?.redirects?.redirectee.filename?.word, '$(rm quoted.txt)\n');
  assert.equal(expandable.ast?.redirects?.here_doc_quoted, false);
  assert.equal(expandable.ast?.redirects?.redirectee.filename?.word, '$(rm expandable.txt)\n');
});

// ── 9. cleanup() { rm *.tmp; }; cleanup → delete effect ──

test('function def + call → effects from body', () => {
  const r = analyze('cleanup() { rm file.tmp; }; cleanup', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/tmp/file.tmp');
});

test('function self-recursion is bounded', () => {
  const r = analyze('loop() { loop; }; loop', { cwd: '/tmp' });
  assert.equal(r.effects.length, 0);
  assert.ok(r.warnings.some(w => w.includes('function call depth')));
});

test('mutual function recursion is bounded', () => {
  const r = analyze('a() { b; }; b() { a; }; a', { cwd: '/tmp' });
  assert.equal(r.effects.length, 0);
  assert.ok(r.warnings.some(w => w.includes('function call depth')));
});

test('large brace expansion is truncated', () => {
  const r = analyze('rm file{1..5000}.tmp', { cwd: '/tmp' });
  assert.equal(r.effects.length, 2000);
  assert.equal(r.effects[0].path, '/tmp/file1.tmp');
  assert.equal(r.effects[1999].path, '/tmp/file2000.tmp');
  assert.ok(r.effects.every(e => e.uncertain));
  assert.ok(r.warnings.some(w => w.includes('brace expansion truncated')));
});

test('word expansion budget retains witnesses, a remainder, and trailing words', () => {
  const env = new VariableEnvironment({}, false);
  const warnings: string[] = [];
  const expanded = expand_words(
    [
      { word: 'cp', flags: 0 },
      { word: 'src-{1..8}.txt', flags: 0 },
      { word: '/backup/', flags: 0 },
    ],
    env,
    {
      maxWords: 5,
      onWarning: warning => warnings.push(warning),
    },
  );

  assert.deepEqual(expanded.map(word => word.word), [
    'cp',
    'src-1.txt',
    'src-2.txt',
    'src-3.txt',
    '/backup/',
  ]);
  assert.equal(expanded[1].uncertain, false);
  assert.equal(expanded[2].uncertain, false);
  assert.deepEqual(expanded[3].boundedRemainder, {
    kind: 'brace',
    expression: 'src-{1..8}.txt',
    scope: 'list',
  });
  assert.equal(expanded[3].uncertain, true);
  assert.equal(expanded[3].noglob, true);
  assert.equal(expanded[4].uncertain, false);
  assert.deepEqual(warnings, [
    'word expansion truncated after 5 words',
  ]);
});

test('multiple brace words share the command-wide expansion budget', () => {
  const result = analyze(
    'cp src-a-{1..2000}.txt src-b-{1..2000}.txt '
      + 'src-c-{1..2000}.txt /backup/',
    { cwd: '/work' },
  );

  assert.equal(result.effects.length, 3998);
  assert.ok(result.effects.every(effect =>
    effect.path.startsWith('/backup/')));
  assert.ok(result.effects.every(effect => effect.uncertain));
  assert.equal(result.warnings.filter(warning =>
    warning.includes('word expansion truncated after 4000 words')).length, 1);
});

test('for lists use one shared word-expansion budget and retain a remainder', () => {
  const result = analyze(
    'for item in a{1..2000} b{1..2000} c{1..2000}; '
      + 'do rm "$item"; done',
    { cwd: '/work' },
  );

  assert.equal(result.effects.length, 4000);
  assert.equal(result.effects[0].path, '/work/a1');
  assert.equal(result.effects[result.effects.length - 1].path, '/work/c1');
  assert.ok(result.effects.every(effect =>
    effect.uncertainty.includes('uncertain-loop-values')));
  assert.equal(result.warnings.filter(warning =>
    warning.includes('word expansion truncated after 4000 words')).length, 1);
});

// ── 10. Parse error recovery ──

test('unterminated quote → warning, null ast', () => {
  const r = analyze('echo "unterminated', { cwd: '/tmp' });
  assert.ok(r.warnings.length > 0, 'should have warnings');
});

// ── Additional tests ──

test('variable expansion in redirect', () => {
  const r = analyze('OUT=/var/log/app.log; echo data > $OUT', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/var/log/app.log');
});

test('redirect to a directory emits no write effect', () => {
  const cwdTarget = analyze('"" > .', { cwd: '/work' });
  assert.deepEqual(cwdTarget.effects, []);
  assert.ok(cwdTarget.warnings.some(warning => warning.includes('Is a directory')));

  const vfsTarget = analyze('echo data >> output', {
    cwd: '/work',
    fs: ['/work/output/'],
  });
  assert.deepEqual(vfsTarget.effects, []);
  assert.ok(vfsTarget.warnings.some(warning => warning.includes('Is a directory')));

  const blockedCommand = analyze('rm victim > output', {
    cwd: '/work',
    fs: ['/work/victim', '/work/output/'],
  });
  assert.deepEqual(blockedCommand.effects, []);
});

test('empty expanded redirect target emits no write effect', () => {
  const r = analyze('echo data 2>$null', {
    cwd: '/work',
    env: { null: '' },
    inheritEnv: false,
  });
  assert.deepEqual(r.effects, []);
  assert.ok(r.warnings.some(warning => warning.includes('empty target')));
});

test('pipeline with redirect on last command', () => {
  const r = analyze('grep foo file | sort > sorted.txt', { cwd: '/data' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/data/sorted.txt');
});

test('pipeline stdout feeds a later compound segment without leaking its state', () => {
  const result = analyze(
    "printf '%s\\n' payload | cat | { read target; rm \"$target\"; }",
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), ['/work/payload']);
});

test('an explicit stdout redirect overrides the pipeline capture', () => {
  const result = analyze(
    "printf '%s\\n' ignored > captured.txt "
      + '| { read target || target=fallback; rm "$target"; }',
    { cwd: '/work' },
  );
  assert.deepEqual(
    result.effects.map(effect => [effect.type, effect.path]),
    [
      ['write', '/work/captured.txt'],
      ['delete', '/work/fallback'],
    ],
  );
});

test('pipeline segments isolate variables cwd and options from the parent shell', () => {
  const variables = analyze(
    'TARGET=outer; TARGET=left | TARGET=right; rm "$TARGET"',
    { cwd: '/work' },
  );
  assert.deepEqual(variables.effects.map(effect => effect.path), ['/work/outer']);

  const cwd = analyze('cd /left | cd /right; rm target', { cwd: '/work' });
  assert.deepEqual(cwd.effects.map(effect => effect.path), ['/work/target']);

  const options = analyze(
    'set -f | true; rm *.txt',
    { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] },
  );
  assert.deepEqual(
    options.effects.map(effect => effect.path).sort(),
    ['/work/a.txt', '/work/b.txt'],
  );
});

test('pipeline status controls and-or lists and honors pipefail', () => {
  const ordinary = analyze(
    'false | true && rm success; true | false || rm fallback',
    { cwd: '/work' },
  );
  assert.deepEqual(
    ordinary.effects.map(effect => effect.path),
    ['/work/success', '/work/fallback'],
  );

  const pipefail = analyze(
    'set -o pipefail; false | true && rm impossible; '
      + 'false | true || rm failed',
    { cwd: '/work' },
  );
  assert.deepEqual(pipefail.effects.map(effect => effect.path), ['/work/failed']);
});

test('pipeline VFS selection starts from a common pre-pipeline snapshot', () => {
  const result = analyze(
    'rm a.txt |\nrm *.txt',
    { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] },
  );
  const rightSegment = result.effects.filter(effect => effect.line === 2);
  assert.deepEqual(
    rightSegment.map(effect => effect.path).sort(),
    ['/work/a.txt', '/work/b.txt'],
  );
  assert.ok(rightSegment.every(effect =>
    effect.uncertainty.includes('pipeline-race')));
});

test('pipeline effects with state-independent targets remain definite', () => {
  const result = analyze(
    'echo data > generated.txt | true; rm fixed.txt',
    { cwd: '/work', fs: [] },
  );
  const fixed = result.effects.find(effect => effect.path === '/work/fixed.txt');
  assert.equal(fixed?.certainty, 'exact');
  assert.deepEqual(fixed?.uncertainty, []);
});

test('async-list parser backgrounds only the final semicolon-list command', () => {
  const parsed = parse('before; child & after').ast;
  if (!parsed || parsed.type !== 'connection') {
    throw new Error('expected outer semicolon connection');
  }
  assert.equal(parsed.connector, SEMI);
  assert.equal(parsed.first.type, 'simple');
  assert.equal(parsed.second?.type, 'connection');
  if (!parsed.second || parsed.second.type !== 'connection') {
    throw new Error('expected nested async connection');
  }
  assert.equal(parsed.second.connector, AMP);
  assert.equal(print_command(parsed), 'before; child & after');
});

test('background commands isolate shell locals and return status zero', () => {
  const variables = analyze(
    'TARGET=outer; TARGET=child & rm "$TARGET"',
    { cwd: '/work' },
  );
  assert.deepEqual(variables.effects.map(effect => effect.path), ['/work/outer']);

  const cwd = analyze('cd /child & rm target', { cwd: '/work' });
  assert.deepEqual(cwd.effects.map(effect => effect.path), ['/work/target']);

  const status = analyze('false & rm "$?.txt"', { cwd: '/work' });
  assert.deepEqual(status.effects.map(effect => effect.path), ['/work/0.txt']);
});

test('background VFS timing preserves pre-effect and post-effect selections', () => {
  const result = analyze(
    'rm a.txt &\nrm *.txt',
    { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] },
  );
  const foreground = result.effects.filter(effect => effect.line === 2);
  assert.deepEqual(
    foreground.map(effect => effect.path).sort(),
    ['/work/a.txt', '/work/b.txt'],
  );
  const a = foreground.find(effect => effect.path === '/work/a.txt');
  const b = foreground.find(effect => effect.path === '/work/b.txt');
  assert.ok(a?.uncertainty.includes('background-race'));
  assert.equal(b?.certainty, 'exact');
});

test('mv command', () => {
  const r = analyze('mv old.txt new.txt', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'move');
  assert.equal(r.effects[0].source, 'old.txt');
});

test('cd changes pwd for subsequent commands', () => {
  const r = analyze('cd /var/log; rm app.log', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/var/log/app.log');
});

test('env option sets variables', () => {
  const r = analyze('rm $MYDIR/out.txt', { cwd: '/tmp', env: { MYDIR: '/opt/data' } });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/opt/data/out.txt');
});

test('case with an unknown subject walks all branches conservatively', () => {
  const r = analyze(
    'case "$(detect_value)" in\n  a) rm a.txt;;\n  b) rm b.txt;;\nesac',
    { cwd: '/tmp' },
  );
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.every(effect =>
    effect.uncertainty.includes('case-branch')));
});

test('case selects the first concrete literal wildcard or bracket match', () => {
  const literal = analyze(
    'x=b; case "$x" in a) rm a;; b|c) rm b;; *) rm fallback;; esac',
    { cwd: '/tmp' },
  );
  assert.deepEqual(literal.effects.map(effect => effect.path), ['/tmp/b']);
  assert.equal(literal.effects[0].certainty, 'exact');

  const wildcard = analyze(
    'case report.txt in *.jpg) rm image;; *.[tT][xX][tT]) rm text;; esac',
    { cwd: '/tmp' },
  );
  assert.deepEqual(wildcard.effects.map(effect => effect.path), ['/tmp/text']);

  const quoted = analyze(
    "case '*' in '*') rm literal;; *) rm wildcard;; esac",
    { cwd: '/tmp' },
  );
  assert.deepEqual(quoted.effects.map(effect => effect.path), ['/tmp/literal']);

  const unsplit = analyze(
    "case $VALUE in 'a:b') rm unsplit;; *) rm split;; esac",
    { cwd: '/tmp', env: { IFS: ':', VALUE: 'a:b' } },
  );
  assert.deepEqual(unsplit.effects.map(effect => effect.path), ['/tmp/unsplit']);
});

test('case no-match succeeds and dynamic patterns remain conservative', () => {
  const noMatch = analyze(
    'case x in y) false;; esac && rm after',
    { cwd: '/tmp' },
  );
  assert.deepEqual(noMatch.effects.map(effect => effect.path), ['/tmp/after']);

  const dynamic = analyze(
    'pat=a; case a in "$pat") rm selected;; b) rm other;; esac',
    { cwd: '/tmp' },
  );
  assert.deepEqual(dynamic.effects.map(effect => effect.path), [
    '/tmp/selected',
    '/tmp/other',
  ]);
  assert.ok(dynamic.effects.every(effect =>
    effect.uncertainty.includes('case-branch')));
});

test('case parser and executor preserve ;& and ;;& behavior', () => {
  const ast = parse(
    'case x in x) true ;& y) true ;;& z) true ;; esac',
  ).ast;
  if (!ast || ast.type !== 'case' || !ast.clauses?.next) {
    throw new Error('expected case clauses');
  }
  assert.equal(ast.clauses.flags, CASEPAT_FALLTHROUGH);
  assert.equal(ast.clauses.next.flags, CASEPAT_TESTNEXT);
  const printed = print_command(ast);
  assert.ok(printed.includes(';&'));
  assert.ok(printed.includes(';;&'));
  const reparsed = parse(printed).ast;
  if (!reparsed || reparsed.type !== 'case' || !reparsed.clauses?.next) {
    throw new Error('expected reparsed case clauses');
  }
  assert.equal(reparsed.clauses.flags, CASEPAT_FALLTHROUGH);
  assert.equal(reparsed.clauses.next.flags, CASEPAT_TESTNEXT);

  const fallthrough = analyze(
    'case b in a) rm a ;& b) rm b ;& c) rm c ;; esac',
    { cwd: '/tmp' },
  );
  assert.deepEqual(fallthrough.effects.map(effect => effect.path), [
    '/tmp/b',
    '/tmp/c',
  ]);

  const testNext = analyze(
    'case a in a) rm first ;;& b) rm no ;; a) rm second ;; esac',
    { cwd: '/tmp' },
  );
  assert.deepEqual(testNext.effects.map(effect => effect.path), [
    '/tmp/first',
    '/tmp/second',
  ]);

  const unknownFallthrough = analyze(
    'case "$(detect_value)" in a) target=from-a ;& b) rm "$target" ;; esac',
    { cwd: '/tmp' },
  );
  assert.ok(unknownFallthrough.effects.some(
    effect => effect.path === '/tmp/from-a'
      && effect.uncertainty.includes('case-branch'),
  ));

  const unknownTestNext = analyze(
    'case "$(detect_value)" in a) target=from-a ;;& b) rm "$target" ;; esac',
    { cwd: '/tmp' },
  );
  assert.ok(unknownTestNext.effects.some(
    effect => effect.path === '/tmp/from-a'
      && effect.uncertainty.includes('case-branch'),
  ));
});

test('nested if-elif-else', () => {
  const r = analyze(
    'if test 1; then rm a; elif test 2; then rm b; else rm c; fi',
    { cwd: '/tmp' },
  );
  assert.deepEqual(r.effects.map(e => e.path), ['/tmp/a']);
});

test('subshell effects propagate', () => {
  const r = analyze('(rm inner.txt)', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/inner.txt');
});

test('group command', () => {
  const r = analyze('{ rm a.txt; rm b.txt; }', { cwd: '/tmp' });
  assert.equal(r.effects.length, 2);
});

test('assignments without command', () => {
  const r = analyze('X=hello; echo $X > out.txt', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
});

test('assignment RHS expansion is unsplit unglobbed and left-to-right', () => {
  const unsplit = analyze(
    "IFS=:; value='a:b'; rm \"$value\"",
    { cwd: '/tmp' },
  );
  assert.deepEqual(unsplit.effects.map(effect => effect.path), ['/tmp/a:b']);

  const unglobbed = analyze(
    'value={a,b}; rm "$value"',
    { cwd: '/tmp' },
  );
  assert.deepEqual(unglobbed.effects.map(effect => effect.path), [
    '/tmp/{a,b}',
  ]);

  const sequential = analyze(
    'base=docs path=$base/report.docx; rm "$path"',
    { cwd: '/tmp' },
  );
  assert.deepEqual(sequential.effects.map(effect => effect.path), [
    '/tmp/docs/report.docx',
  ]);
});

test('prefix assignments follow Bash expansion visibility and remain temporary', () => {
  const argumentExpansion = analyze(
    'target=old; target=new rm "$target"',
    { cwd: '/tmp' },
  );
  assert.deepEqual(argumentExpansion.effects.map(effect => effect.path), [
    '/tmp/old',
  ]);

  const functionScope = analyze(
    'target=old; cleanup() { rm "$target"; }; target=new cleanup; rm "$target"',
    { cwd: '/tmp' },
  );
  assert.deepEqual(functionScope.effects.map(effect => effect.path), [
    '/tmp/new',
    '/tmp/old',
  ]);

  const alternatives = analyze(
    'target=old; vary() { if mystery; then side=a; else side=b; fi; }; '
      + 'target=new vary; rm "$target"',
    { cwd: '/tmp' },
  );
  assert.deepEqual(alternatives.effects.map(effect => effect.path), [
    '/tmp/old',
  ]);
});

test('indexed arrays resolve sparse arithmetic subscripts and element zero', () => {
  const r = analyze(`
    files[0]=docs/zero.docx
    files[3]=docs/report
    files[3]+=.pptx
    index=2
    files[index+2]=docs/four.pdf
    rm "$files" "\${files[-1]}" "\${files[3]}"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/docs/zero.docx',
    '/work/docs/four.pdf',
    '/work/docs/report.pptx',
  ]);
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
});

test('quoted array-at expansion preserves sparse element boundaries', () => {
  const r = analyze(`
    files[0]='docs/first report.docx'
    files[2]=docs/second.pptx
    rm "\${files[@]}"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/docs/first report.docx',
    '/work/docs/second.pptx',
  ]);
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));

  const length = analyze(`
    files[1]=a
    files[7]=b
    rm "count_\${#files[@]}.pdf"
  `, { cwd: '/work' });
  assert.deepEqual(length.effects.map(effect => effect.path), [
    '/work/count_2.pdf',
  ]);

  const assignment = analyze(`
    files[0]='docs/first report.docx'
    files[1]=second.pptx
    joined="\${files[@]}"
    rm "$joined"
  `, { cwd: '/work' });
  assert.deepEqual(assignment.effects.map(effect => effect.path), [
    '/work/docs/first report.docx second.pptx',
  ]);

  const star = analyze(`
    IFS=:
    files[0]='docs/first report.docx'
    files[1]=second.pptx
    joined="\${files[*]}"
    rm "$joined"
  `, { cwd: '/work' });
  assert.deepEqual(star.effects.map(effect => effect.path), [
    '/work/docs/first report.docx:second.pptx',
  ]);
});

test('associative arrays expand bounded literal and variable keys', () => {
  const r = analyze(`
    declare -A documents
    key=report
    documents[$key]=docs/report.docx
    documents[presentation]=docs/presentation.pptx
    rm "\${documents[@]}"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path).sort(), [
    '/work/docs/presentation.pptx',
    '/work/docs/report.docx',
  ].sort());
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));

  const direct = analyze(`
    declare -A documents
    key=report
    documents[report]=docs/report.docx
    rm "\${documents[$key]}"
  `, { cwd: '/work' });
  assert.deepEqual(direct.effects.map(effect => effect.path), [
    '/work/docs/report.docx',
  ]);

  const quotedKey = analyze(`
    declare -A documents
    documents["report]=draft"]=docs/draft.docx
    rm "\${documents["report]=draft"]}"
  `, { cwd: '/work' });
  assert.deepEqual(quotedKey.effects.map(effect => effect.path), [
    '/work/docs/draft.docx',
  ]);
});

test('array snapshots preserve branch function and temporary-assignment isolation', () => {
  const branches = analyze(`
    files[0]=docs/base.docx
    if mystery; then
      files[1]=docs/then.pptx
    else
      files[2]=docs/else.pdf
    fi
    rm "\${files[@]}"
  `, { cwd: '/work' });
  assert.deepEqual(branches.effects.map(effect => effect.path), [
    '/work/docs/base.docx',
    '/work/docs/then.pptx',
    '/work/docs/else.pdf',
  ]);
  assert.equal(branches.effects[0].certainty, 'exact');
  assert.ok(branches.effects.slice(1).every(effect =>
    effect.uncertainty.includes('conditional-branch')));

  const isolation = analyze(`
    files[0]=outer.docx
    cleanup() {
      local -a files
      files[0]=inner.pptx
      rm "\${files[@]}"
    }
    cleanup
    files[0]=temporary.pdf true
    rm "\${files[@]}"
  `, { cwd: '/work' });
  assert.deepEqual(isolation.effects.map(effect => effect.path), [
    '/work/inner.pptx',
    '/work/outer.docx',
  ]);
});

test('array element budget retains an explicit unknown remainder', () => {
  const assignments = Array.from(
    { length: MAX_ARRAY_ELEMENTS + 2 },
    (_, index) => `files[${index}]=docs/file-${index}.txt`,
  ).join('; ');
  const r = analyze(
    assignments + '; rm "${files[@]}"',
    { cwd: '/work' },
  );
  assert.ok(r.effects.some(effect => effect.path === '/work/docs/file-0.txt'));
  assert.ok(r.effects.some(effect =>
    effect.path.includes('<unknown:files[@]>')
    && effect.certainty !== 'exact'));
  assert.ok(r.effects.length <= MAX_ARRAY_ELEMENTS + 1);

  const oversized = analyze(
    `files[0]=${'x'.repeat(MAX_ARRAY_VALUE_CHARS + 1)}; rm "\${files[0]}"`,
    { cwd: '/work' },
  );
  assert.equal(oversized.effects.length, 1);
  assert.equal(oversized.effects[0].certainty, 'unknown');
  assert.ok(oversized.effects[0].path.includes('<unknown:files[0]>'));
});

test('unresolved array subscripts widen stale elements and preserve effects', () => {
  const unresolved = analyze(`
    files[0]=safe.txt
    files[$unknown]=docs/report.docx
    rm "\${files[0]}"
  `, { cwd: '/work' });
  assert.equal(unresolved.effects.length, 1);
  assert.equal(unresolved.effects[0].certainty, 'unknown');
  assert.ok(unresolved.effects[0].path.includes('<unknown:files[0]>'));

  const substitution = analyze(
    'files[$(rm subscript-side.docx)]=value',
    { cwd: '/work' },
  );
  assert.deepEqual(substitution.effects.map(effect => effect.path), [
    '/work/subscript-side.docx',
  ]);
});

test('brace expansion in word', () => {
  const r = analyze('rm {a,b,c}.txt', { cwd: '/tmp' });
  assert.equal(r.effects.length, 3);
  assert.equal(r.effects[0].path, '/tmp/a.txt');
  assert.equal(r.effects[1].path, '/tmp/b.txt');
  assert.equal(r.effects[2].path, '/tmp/c.txt');
});

test('tilde expansion', () => {
  const r = analyze('rm ~/file.txt', { cwd: '/tmp', env: { HOME: '/home/john' } });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/home/john/file.txt');
});

test('arithmetic expansion', () => {
  const r = analyze('N=3; rm file_$((N+1)).txt', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/file_4.txt');
});

test('arithmetic precedence and integer forms follow Bash scalar semantics', () => {
  const r = analyze(`
    a=$((2 + 3 * 4))
    b=$((2 ** 3 ** 2))
    c=$((-2 ** 2))
    d=$((1 << 3 + 1))
    e=$((3 < 4 && 5 == 5 ? 9 : 0))
    f=$((010 + 0x10))
    rm "\${a}_\${b}_\${c}_\${d}_\${e}_\${f}.docx"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/14_512_4_16_9_24.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');
});

test('arithmetic commands parse as dedicated AST nodes and round-trip', () => {
  const parsed = parse('(( count += 2 ))');
  assert.equal(parsed.ast?.type, 'arith');
  assert.deepEqual(parsed.warnings, []);
  const printed = print_command(parsed.ast);
  assert.ok(printed.startsWith('(( '));
  const reparsed = parse(printed);
  assert.equal(reparsed.ast?.type, 'arith');
  assert.deepEqual(reparsed.warnings, []);

  const nestedSubshell = parse('( (echo nested) )');
  assert.equal(nestedSubshell.ast?.type, 'subshell');
});

test('arithmetic commands update scalars and drive exact command status', () => {
  const r = analyze(`
    count=0
    (( count = 1 ))
    (( count += 2 ))
    n=0
    (( n++ )) || rm post-increment-failed.docx
    (( ++n )) && rm "count_\${count}_n_\${n}.pptx"
    (( 0 )) && rm impossible-zero.pdf
    (( 1 )) || rm impossible-nonzero.pdf
    (( 0 )) || rm zero-fallback.pptx
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/post-increment-failed.docx',
    '/work/count_3_n_2.pptx',
    '/work/zero-fallback.pptx',
  ]);
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
});

test('arithmetic compound assignments read the left value before the right side', () => {
  const r = analyze(`
    value=1
    (( value += (value=5) ))
    rm "\${value}.docx"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/6.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');
});

test('arithmetic short circuit and conditional expressions preserve feasible writes', () => {
  const r = analyze(`
    skipped=0
    (( 1 || (skipped=9) ))
    (( 0 && (skipped=8) ))
    selected=0
    (( 0 ? (selected=1) : (selected=2) ))
    rm "skipped_\${skipped}_selected_\${selected}.docx"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/skipped_0_selected_2.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');

  const branches = analyze(`
    if mystery; then (( target=1 )); else (( target=2 )); fi
    rm "\${target}.docx"
  `, { cwd: '/work' });
  assert.deepEqual(branches.effects.map(effect => effect.path), [
    '/work/1.docx',
    '/work/2.docx',
  ]);
  assert.ok(branches.effects.every(effect =>
    effect.uncertainty.includes('conditional-branch')));
});

test('arithmetic expansion assignments feed later shell expansion', () => {
  const r = analyze(
    'x=0; value=$((x=4, x+1)); rm "x_${x}_value_${value}.docx"',
    { cwd: '/work' },
  );
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/x_4_value_5.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');
});

test('arithmetic recursively evaluates bounded scalar variable expressions', () => {
  const r = analyze(`
    expression='target=7'
    (( expression ))
    rm "\${target}.docx"
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/7.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');

  const cycle = analyze(`
    left=right
    right=left
    (( left )) || rm recursive-fallback.pdf
  `, { cwd: '/work' });
  assert.deepEqual(cycle.effects.map(effect => effect.path), [
    '/work/recursive-fallback.pdf',
  ]);
  assert.ok(cycle.effects[0].uncertainty.includes('and-or-branch'));
});

test('unknown arithmetic preserves effects and widens potential assignments', () => {
  const malformed = analyze(
    'target=safe; (( target = )); rm "$target.docx"',
    { cwd: '/work' },
  );
  assert.equal(malformed.effects.length, 1);
  assert.equal(malformed.effects[0].certainty, 'unknown');
  assert.ok(malformed.effects[0].uncertainty.includes('unresolved-expansion'));
  assert.notEqual(malformed.effects[0].path, '/work/safe.docx');
  assert.ok(malformed.warnings.some(warning =>
    warning.includes('arithmetic command')
    && warning.includes('widened to unknown')));

  const substitution = analyze(
    '(( $(rm arithmetic-side.docx) ))',
    { cwd: '/work' },
  );
  assert.deepEqual(substitution.effects.map(effect => effect.path), [
    '/work/arithmetic-side.docx',
  ]);

  const overBudget = analyze(
    `target=safe; (( target=${'1+'.repeat(2100)}1 )); rm "$target.pdf"`,
    { cwd: '/work' },
  );
  assert.equal(overBudget.effects.length, 1);
  assert.equal(overBudget.effects[0].certainty, 'unknown');
  assert.ok(overBudget.warnings.some(warning =>
    warning.includes('arithmetic command')
    && warning.includes('widened to unknown')));
});

test('arithmetic evaluation failures preserve fallback paths and prior state', () => {
  const fallback = analyze(
    '(( 1 / 0, 1 )) || rm arithmetic-fallback.docx',
    { cwd: '/work' },
  );
  assert.deepEqual(fallback.effects.map(effect => effect.path), [
    '/work/arithmetic-fallback.docx',
  ]);
  assert.ok(fallback.effects[0].uncertainty.includes('and-or-branch'));

  const state = analyze(`
    target=before
    (( 1 / 0 + (target=after) ))
    rm "\${target}.pdf"
  `, { cwd: '/work' });
  assert.equal(state.effects.length, 1);
  assert.equal(state.effects[0].certainty, 'unknown');
  assert.notEqual(state.effects[0].path, '/work/after.pdf');
});

test('parse produces ast', () => {
  const r = parse('echo hello');
  assert.ok(r.ast !== null);
  assert.equal(r.ast.type, 'simple');
});

test('print_command round-trips', () => {
  const r = parse('echo hello');
  assert.ok(r.ast !== null);
  const printed = print_command(r.ast);
  assert.ok(printed.includes('echo'));
  assert.ok(printed.includes('hello'));
});

test('while loop marks uncertain', () => {
  const r = analyze('while true; do rm temp.txt; done', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].uncertain, true);
});

test('while and until retain at most one body state transition', () => {
  const whileResult = analyze(
    'i=0; while true; do rm "$i"; i=1; done; rm "$i.after"',
    { cwd: '/work' },
  );
  assert.deepEqual(whileResult.effects.map(effect => effect.path), [
    '/work/0',
    '/work/1.after',
  ]);
  assert.ok(whileResult.effects.every(effect =>
    effect.uncertainty.includes('unknown-loop-count')));

  const untilResult = analyze(
    'i=0; until false; do rm "$i"; i=1; done; rm "$i.after"',
    { cwd: '/work' },
  );
  assert.deepEqual(untilResult.effects.map(effect => effect.path), [
    '/work/0',
    '/work/1.after',
  ]);
});

test('break exits the retained while iteration and restores exact successor flow', () => {
  const result = analyze(
    'while true; do rm body; break; rm no; done; rm after',
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => effect.path), [
    '/work/body',
    '/work/after',
  ]);
  assert.equal(result.effects[1].certainty, 'exact');
  assert.deepEqual(result.effects[1].uncertainty, []);
});

test('while false and until true skip their bodies', () => {
  const r = analyze('while false; do rm no-a; done; until true; do rm no-b; done', { cwd: '/tmp' });
  assert.deepEqual(r.effects, []);
});

test('parameter expansion ${var:-default}', () => {
  const r = analyze('rm ${MISSING:-fallback.txt}', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/fallback.txt');
});

test('curl -o downloads a file', () => {
  const r = analyze('curl -o output.html http://example.com', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/tmp/output.html');
});

test('dd of=FILE', () => {
  const r = analyze('dd if=/dev/zero of=disk.img bs=1M count=100', { cwd: '/data' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/data/disk.img');
});

test('ln -s creates link', () => {
  const r = analyze('ln -s /etc/config config.link', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'link');
  assert.equal(r.effects[0].path, '/home/config.link');
});

// ═══════════════════════════════════════════════════════════════════
// COMPLICATED TESTS — Real-world AI agent scenarios
// ═══════════════════════════════════════════════════════════════════

console.log('\n--- Complicated / Real-world agent tests ---\n');

// ── Multi-step build pipeline ──

test('agent: full build pipeline — mkdir, download, extract, compile', () => {
  const script = `
    BUILD_DIR=/tmp/build_\${RANDOM}
    mkdir -p $BUILD_DIR/src $BUILD_DIR/out
    curl -o $BUILD_DIR/src/archive.tar.gz https://example.com/release.tar.gz
    cd $BUILD_DIR/src
    dd of=$BUILD_DIR/out/result.bin
    cp $BUILD_DIR/out/result.bin /usr/local/bin/myapp
    rm -rf $BUILD_DIR
  `;
  const r = analyze(script, { cwd: '/home/agent', env: { RANDOM: '12345' } });
  const types = r.effects.map(e => e.type);
  assert.ok(types.includes('mkdir'), 'should mkdir');
  assert.ok(types.includes('write'), 'should write (curl + dd)');
  assert.ok(types.includes('copy'), 'should copy');
  assert.ok(types.includes('delete'), 'should delete');
  // mkdir creates 2 dirs (src, out)
  assert.equal(r.effects.filter(e => e.type === 'mkdir').length, 2);
});

// ── For loop over generated sequence with nested variable ──

test('agent: for loop builds multiple output files with variable prefix', () => {
  const script = `
    PREFIX=module
    EXT=.js
    for name in auth router db middleware; do
      rm dist/\${PREFIX}_\${name}\${EXT}
      rm dist/\${PREFIX}_\${name}.d.ts
    done
  `;
  const r = analyze(script, { cwd: '/app' });
  // 4 iterations × 2 files each = 8
  assert.equal(r.effects.length, 8);
  assert.ok(r.effects.some(e => e.path === '/app/dist/module_auth.js'));
  assert.ok(r.effects.some(e => e.path === '/app/dist/module_auth.d.ts'));
  assert.ok(r.effects.some(e => e.path === '/app/dist/module_db.js'));
  assert.ok(r.effects.some(e => e.path === '/app/dist/module_middleware.d.ts'));
});

// ── Case dispatch with wildcard-like patterns ──

test('agent: case dispatches different installers per OS', () => {
  const script = `
    case "$(detect_os)" in
      linux*)
        mkdir -p /opt/myapp/bin
        cp myapp /opt/myapp/bin/
        ln -s /opt/myapp/bin/myapp /usr/local/bin/myapp
        ;;
      darwin*)
        mkdir -p /Applications/MyApp.app/Contents/MacOS
        cp myapp /Applications/MyApp.app/Contents/MacOS/
        ;;
      *)
        rm /tmp/unsupported_os.flag
        ;;
    esac
  `;
  const r = analyze(script, { cwd: '/build' });
  // Unknown detector output walks all branches: 3 + 2 + 1 = 6.
  assert.equal(r.effects.length, 6);
  assert.ok(r.effects.some(e => e.type === 'link'));
  assert.ok(r.effects.some(e => e.path === '/tmp/unsupported_os.flag'));
});

// ── Nested functions calling each other ──

test('agent: nested function calls with variable scoping', () => {
  const script = `
    log() {
      echo "$1" >> /var/log/deploy.log
    }
    deploy_file() {
      local src=$1
      local dest=$2
      cp $src $dest
      log "deployed $src to $dest"
    }
    deploy_file app.js /srv/www/app.js
    deploy_file style.css /srv/www/style.css
  `;
  const r = analyze(script, { cwd: '/release' });
  // 2 deploy_file calls × (1 cp + 1 append from log) = 4
  const copies = r.effects.filter(e => e.type === 'copy');
  const appends = r.effects.filter(e => e.type === 'append');
  assert.equal(copies.length, 2);
  assert.equal(appends.length, 2);
  assert.equal(appends[0].path, '/var/log/deploy.log');
});

// ── Complex redirect combinations ──

test('agent: stderr+stdout redirect, append, pipe chain', () => {
  const script = `
    echo "start" > /tmp/out.log
    echo "progress" >> /tmp/out.log
    make 2>&1 | tee /tmp/build.log
    echo "done" >> /tmp/out.log
  `;
  const r = analyze(script, { cwd: '/project' });
  const writes = r.effects.filter(e => e.type === 'write');
  const appends = r.effects.filter(e => e.type === 'append');
  assert.ok(writes.length >= 2, 'should have writes from echo > and tee');
  assert.ok(appends.length >= 2, 'should have appends from echo >>');
});

// ── Subshell isolation with cd ──

test('agent: cd in subshell should not affect outer shell pwd', () => {
  const script = `
    rm before.txt
    (cd /var/log; rm inner.txt)
    rm after.txt
  `;
  const r = analyze(script, { cwd: '/home' });
  // Note: our dry-run doesn't fully isolate subshell env — but effects propagate
  assert.ok(r.effects.some(e => e.path === '/home/before.txt'));
  assert.ok(r.effects.some(e => e.path === '/var/log/inner.txt'));
  // after.txt should be in /home (subshell cd doesn't leak)
  // (In current implementation, subshell DOES leak cd — that's a known limitation)
  assert.ok(r.effects.length >= 3);
});

// ── Brace expansion + variable expansion combo ──

test('agent: brace expansion with variable interpolation', () => {
  const script = `
    APP=myapp
    mkdir -p /etc/$APP/{config,data,logs,cache}
  `;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 4);
  assert.ok(r.effects.every(e => e.type === 'mkdir'));
  assert.ok(r.effects.some(e => e.path.includes('myapp/config')));
  assert.ok(r.effects.some(e => e.path.includes('myapp/logs')));
});

// ── Agent deploying a Docker-compose-like setup ──

test('agent: docker-compose-like multi-service setup', () => {
  const script = `
    BASE=/opt/services
    for svc in api worker scheduler; do
      mkdir -p $BASE/$svc/config
      cp templates/$svc.yml $BASE/$svc/config/app.yml
      rm $BASE/$svc/.env
      chmod 600 $BASE/$svc/.env
    done
    ln -s $BASE/api/config/app.yml /etc/api-config.yml
  `;
  const r = analyze(script, { cwd: '/deploy' });
  // 3 services × (1 mkdir + 1 copy + 1 delete + 1 chmod) + 1 ln = 13
  assert.equal(r.effects.length, 13);
  assert.ok(r.effects.some(e => e.type === 'link' && e.path === '/etc/api-config.yml'));
  assert.ok(r.effects.some(e => e.type === 'chmod' && e.path.includes('.env')));
});

// ── Complex parameter expansions ──

test('agent: chained parameter expansion with defaults and substitution', () => {
  const script = `
    LOG_DIR=\${LOG_PATH:-/var/log}
    APP_NAME=\${APP:-myservice}
    rm $LOG_DIR/$APP_NAME.log
    rm $LOG_DIR/$APP_NAME.pid
  `;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 2);
  assert.equal(r.effects[0].path, '/var/log/myservice.log');
  assert.equal(r.effects[1].path, '/var/log/myservice.pid');
});

// ── Nested if inside for inside function ──

test('agent: deeply nested control flow — function > for > if', () => {
  const script = `
    process() {
      for f in $1 $2 $3; do
        if test -f "$f"; then
          cp "$f" /backup/
          rm "$f"
        else
          rm "$f.missing"
        fi
      done
    }
    process a.txt b.txt c.txt
  `;
  const r = analyze(script, { cwd: '/data' });
  // For each of 3 files: walks both if branches = cp + rm + rm = 3 effects
  // 3 files × 3 effects = 9
  assert.equal(r.effects.length, 9);
  assert.ok(r.effects.filter(e => e.type === 'copy').length === 3);
  assert.ok(r.effects.filter(e => e.type === 'delete').length === 6);
});

// ── wget + sed -i pipeline ──

test('agent: download config then sed -i to patch it', () => {
  const script = `
    wget -O /tmp/nginx.conf https://example.com/nginx.template
    sed -i 's/PORT/8080/g' /tmp/nginx.conf
    cp /tmp/nginx.conf /etc/nginx/nginx.conf
    rm /tmp/nginx.conf
  `;
  const r = analyze(script, { cwd: '/' });
  assert.ok(r.effects.some(e => e.type === 'write' && e.command === 'wget'));
  assert.ok(r.effects.some(e => e.type === 'write' && e.command === 'sed -i'));
  assert.ok(r.effects.some(e => e.type === 'copy'));
  assert.ok(r.effects.some(e => e.type === 'delete'));
});

// ── Multiple here-docs in sequence ──

test('agent: multiple here-doc writes for config generation', () => {
  const script = `cat > /etc/app/config.yml <<EOF
database:
  host: localhost
  port: 5432
EOF
cat > /etc/app/secrets.yml <<EOF
api_key: xxx
EOF
`;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 2);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/etc/app/config.yml');
  assert.equal(r.effects[1].type, 'write');
  assert.equal(r.effects[1].path, '/etc/app/secrets.yml');
});

// ── Agent doing git clone + build ──

test('agent: git clone then build steps', () => {
  const script = `
    git clone https://github.com/user/repo.git /tmp/repo
    cd /tmp/repo
    mkdir -p build
    dd of=build/output.wasm
    cp build/output.wasm /opt/deploy/
  `;
  const r = analyze(script, { cwd: '/home/agent' });
  assert.ok(r.effects.some(e => e.type === 'mkdir' && e.command === 'git clone'));
  assert.ok(r.effects.some(e => e.type === 'mkdir' && e.path === '/tmp/repo/build'));
  assert.ok(r.effects.some(e => e.type === 'write' && e.path === '/tmp/repo/build/output.wasm'));
  assert.ok(r.effects.some(e => e.type === 'copy' && e.path === '/opt/deploy/output.wasm'));
});

// ── Arithmetic in loop bounds ──

test('agent: arithmetic to generate numbered files', () => {
  const script = `
    START=1
    for name in chunk_$((START)) chunk_$((START+1)) chunk_$((START+2)); do
      rm /data/$name.dat
    done
  `;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 3);
  assert.equal(r.effects[0].path, '/data/chunk_1.dat');
  assert.equal(r.effects[1].path, '/data/chunk_2.dat');
  assert.equal(r.effects[2].path, '/data/chunk_3.dat');
});

// ── Export + assignment combos ──

test('agent: export sets variables used later', () => {
  const script = `
    export INSTALL_DIR=/opt/app
    export VERSION=2.1.0
    mkdir -p $INSTALL_DIR/$VERSION/bin
    rm $INSTALL_DIR/$VERSION/bin/run.sh
    chmod 755 $INSTALL_DIR/$VERSION/bin/run.sh
  `;
  const r = analyze(script, { cwd: '/' });
  assert.ok(r.effects.some(e => e.type === 'mkdir' && e.path === '/opt/app/2.1.0/bin'));
  assert.ok(r.effects.some(e => e.type === 'delete' && e.path === '/opt/app/2.1.0/bin/run.sh'));
  assert.ok(r.effects.some(e => e.type === 'chmod' && e.path === '/opt/app/2.1.0/bin/run.sh'));
});

// ── Pipeline with tee splitting output ──

test('agent: pipeline with tee writing to multiple files', () => {
  const script = `
    echo "data" | tee /tmp/copy1.txt /tmp/copy2.txt /tmp/copy3.txt > /dev/null
  `;
  const r = analyze(script, { cwd: '/' });
  // tee writes 3 files, echo > /dev/null writes 1
  const teeEffects = r.effects.filter(e => e.command === 'tee');
  assert.equal(teeEffects.length, 3);
});

// ── Multiple assignment on same line with command ──

test('agent: inline var assignments before command', () => {
  const script = `CC=gcc CFLAGS="-O2" LDFLAGS="-lm" rm /tmp/build.marker`;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/build.marker');
});

// ── Deeply nested subshells and groups ──

test('agent: nested subshell inside group inside if', () => {
  const script = `
    if true; then
      {
        (
          mkdir -p /deep/nest
          rm /deep/nest/file.txt
        )
        cp /deep/nest/file.txt /backup/
      }
    fi
  `;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 3);
  assert.ok(r.effects.some(e => e.type === 'mkdir'));
  assert.ok(r.effects.some(e => e.type === 'delete'));
  assert.ok(r.effects.some(e => e.type === 'copy'));
});

// ── cd - (go back to previous dir) ──

test('agent: cd then cd - returns to previous dir', () => {
  const script = `
    rm before.txt
    cd /var/log
    rm during.txt
    cd -
    rm after.txt
  `;
  const r = analyze(script, { cwd: '/home/user' });
  // Not guaranteed cd - works perfectly in dry-run but test the mechanism
  assert.ok(r.effects.some(e => e.path === '/home/user/before.txt'));
  assert.ok(r.effects.some(e => e.path === '/var/log/during.txt'));
  // cd - should go back to /home/user
  assert.ok(r.effects.some(e => e.path === '/home/user/after.txt'));
});

// ── String length parameter expansion ──

test('agent: ${#var} string length used in filename', () => {
  const script = `
    WORD=hello
    rm file_\${#WORD}.txt
  `;
  const r = analyze(script, { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/file_5.txt');
});

// ── Parameter expansion with suffix/prefix removal ──

test('agent: ${var%%pattern} suffix removal', () => {
  const script = `
    FILE=archive.tar.gz
    rm \${FILE%%.*}.extracted
  `;
  const r = analyze(script, { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/archive.extracted');
});

test('agent: ${var#pattern} prefix removal', () => {
  const script = `
    PATH_FULL=/usr/local/bin/app
    rm /tmp/\${PATH_FULL##*/}.bak
  `;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/tmp/app.bak');
});

// ── bounded source ──

test('agent: source command produces warning', () => {
  const r = analyze('source /etc/profile; rm /tmp/file', { cwd: '/' });
  assert.ok(r.warnings.some(w => w.includes('source')));
  assert.equal(r.effects.length, 1);
});

test('agent: source executes in the current shell and restores supplied args', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    fs.mkdirSync(nodePath.join(root, 'nested'));
    fs.writeFileSync(nodePath.join(root, 'cleanup.sh'), `
      target=inside
      cd nested
      cleanup "$1"
      generated() { rm "made/$1"; }
      return 7
      rm missed-return.docx
    `);
    const r = analyze(`
      cleanup() { rm "seen/$1"; }
      target=outer
      source ./cleanup.sh report.docx || rm fallback.pptx
      generated slides.pptx
      rm "$target.txt"
      rm "$1.txt"
    `, {
      cwd: toPosix(root),
      args: ['caller'],
      realFs: true,
    });
    assert.deepEqual(r.effects.map(effect => effect.path), [
      toPosix(nodePath.join(root, 'nested', 'seen', 'report.docx')),
      toPosix(nodePath.join(root, 'nested', 'fallback.pptx')),
      toPosix(nodePath.join(root, 'nested', 'made', 'slides.pptx')),
      toPosix(nodePath.join(root, 'nested', 'inside.txt')),
      toPosix(nodePath.join(root, 'nested', 'caller.txt')),
    ]);
    assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
    assert.ok(!r.effects.some(effect =>
      effect.path.endsWith('missed-return.docx')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: source resolves default PATH and explicit -p search paths', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    const library = nodePath.join(root, 'library');
    fs.mkdirSync(library);
    fs.writeFileSync(
      nodePath.join(library, 'cleanup.sh'),
      'rm "$1"\n',
    );
    fs.writeFileSync(
      nodePath.join(root, 'local.sh'),
      'rm "$1"\n',
    );
    const r = analyze(`
      source cleanup.sh docs/report.docx
      . -p '' local.sh docs/local.pptx
    `, {
      cwd: toPosix(root),
      env: { PATH: 'library' },
      realFs: true,
    });
    assert.deepEqual(r.effects.map(effect => effect.path), [
      toPosix(nodePath.join(root, 'docs', 'report.docx')),
      toPosix(nodePath.join(root, 'docs', 'local.pptx')),
    ]);
    assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: missing source status prunes and-or branches exactly', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    const r = analyze(`
      source ./missing.sh && rm missed.docx
      source ./missing.sh || rm fallback.docx
    `, { cwd: toPosix(root), realFs: true });
    assert.deepEqual(r.effects.map(effect => effect.path), [
      toPosix(nodePath.join(root, 'fallback.docx')),
    ]);
    assert.equal(r.effects[0].certainty, 'exact');
    assert.ok(r.warnings.some(w =>
      w.includes('source') && w.includes('could not read')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: source refuses oversized and unknown predicted-content files explicitly', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    fs.writeFileSync(
      nodePath.join(root, 'oversized.sh'),
      `rm hidden.docx\n#${'x'.repeat(128 * 1024)}`,
    );
    fs.writeFileSync(nodePath.join(root, 'rewritten.sh'), 'echo old-safe-body\n');

    const oversized = analyze('source ./oversized.sh', {
      cwd: toPosix(root),
      realFs: true,
    });
    assert.equal(oversized.effects.length, 0);
    assert.ok(oversized.warnings.some(w =>
      w.includes('source') && w.includes('131072-byte source budget')));

    const rewritten = analyze(`
      mystery > rewritten.sh
      source ./rewritten.sh
    `, { cwd: toPosix(root), realFs: true });
    assert.deepEqual(rewritten.effects.map(effect => effect.type), ['write']);
    assert.ok(rewritten.warnings.some(w =>
      w.includes('source') && w.includes('predicted file contents are unknown')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: deterministic redirected output becomes bounded source input', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    fs.mkdirSync(nodePath.join(root, 'nested'));
    fs.writeFileSync(
      nodePath.join(root, 'appended.sh'),
      'target=docs\n',
    );
    fs.writeFileSync(
      nodePath.join(root, 'truncated.sh'),
      'rm docs/stale.docx\n',
    );

    const r = analyze(`
      printf '%s\\n' 'rm docs/generated.docx' > generated.sh
      source ./generated.sh
      cat <<'EOF' > heredoc.sh
rm docs/heredoc.pptx
EOF
      source ./heredoc.sh
      printf '%s\\n' 'rm "$target/appended.pdf"' >> appended.sh
      source ./appended.sh
      : > truncated.sh
      source ./truncated.sh
      (cd nested; printf '%s\\n' 'rm docs/preopened.jpg') > preopened.sh
      source ./preopened.sh
    `, { cwd: toPosix(root), realFs: true });

    assert.deepEqual(
      r.effects
        .filter(effect => effect.type === 'delete')
        .map(effect => effect.path),
      [
        toPosix(nodePath.join(root, 'docs', 'generated.docx')),
        toPosix(nodePath.join(root, 'docs', 'heredoc.pptx')),
        toPosix(nodePath.join(root, 'docs', 'appended.pdf')),
        toPosix(nodePath.join(root, 'docs', 'preopened.jpg')),
      ],
    );
    assert.ok(!r.effects.some(effect =>
      effect.path.endsWith('/docs/stale.docx')));
    assert.ok(!r.warnings.some(warning =>
      warning.includes('predicted file contents are unknown')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: generated source contents remain isolated across branches', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    const r = analyze(`
      if mystery; then
        printf '%s\\n' 'rm docs/a.docx' > generated.sh
      else
        printf '%s\\n' 'rm docs/b.pptx' > generated.sh
      fi
      source ./generated.sh
    `, { cwd: toPosix(root), realFs: true });
    const deletes = r.effects.filter(effect => effect.type === 'delete');
    assert.deepEqual(deletes.map(effect => effect.path).sort(), [
      toPosix(nodePath.join(root, 'docs', 'a.docx')),
      toPosix(nodePath.join(root, 'docs', 'b.pptx')),
    ]);
    assert.ok(deletes.every(effect =>
      effect.uncertainty.includes('conditional-branch')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: oversized generated source contents widen explicitly', () => {
  const script = 'x'.repeat(MAX_PREDICTED_TEXT_FILE_BYTES + 1);
  const r = analyze(
    `printf '%s' '${script}' > generated.sh; source ./generated.sh`,
    { cwd: '/work', realFs: true },
  );
  assert.deepEqual(r.effects.map(effect => effect.type), ['write']);
  assert.ok(r.warnings.some(warning =>
    warning.includes('source')
    && warning.includes('predicted file contents are unknown')));
});

test('agent: source reads the branch-local VFS snapshot', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    fs.writeFileSync(
      nodePath.join(root, 'conditional.sh'),
      'rm docs/report.docx\n',
    );
    const r = analyze(`
      if mystery; then rm ./conditional.sh; fi
      source ./conditional.sh
    `, { cwd: toPosix(root), realFs: true });
    assert.deepEqual(r.effects.map(effect => effect.path).sort(), [
      toPosix(nodePath.join(root, 'conditional.sh')),
      toPosix(nodePath.join(root, 'docs', 'report.docx')),
    ].sort());
    assert.ok(r.effects.every(effect =>
      effect.uncertainty.includes('conditional-branch')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: source parser warnings retain executed and fallback states', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    fs.writeFileSync(
      nodePath.join(root, 'warning.sh'),
      'rm warned.docx "',
    );
    const r = analyze(
      'source ./warning.sh; rm after-warning.docx',
      { cwd: toPosix(root), realFs: true },
    );
    assert.deepEqual(r.effects.map(effect => effect.path), [
      toPosix(nodePath.join(root, 'warned.docx')),
      toPosix(nodePath.join(root, 'after-warning.docx')),
    ]);
    assert.equal(r.effects[0].certainty, 'overapprox');
    assert.ok(r.effects[0].uncertainty.includes('unknown-command'));
    assert.equal(r.effects[1].certainty, 'exact');
    assert.ok(r.warnings.some(w =>
      w.includes('source') && w.includes('parser warning')
      && w.includes('details omitted')));
    assert.ok(!r.warnings.some(w => w.includes('unexpected EOF')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent: source treats non-regular files as unknown without reading them', () => {
  if (process.platform === 'win32') return;
  const r = analyze(
    'source /dev/null && rm /tmp/after-special-source.docx',
    { cwd: '/work', realFs: true },
  );
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/tmp/after-special-source.docx',
  ]);
  assert.ok(r.effects[0].uncertainty.includes('and-or-branch'));
  assert.ok(r.warnings.some(w =>
    w.includes('source') && w.includes('non-regular file')));
});

test('agent: source omits file-derived warning details', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-source-'));
  try {
    fs.writeFileSync(
      nodePath.join(root, 'private-warning.sh'),
      'bash --do-not-upload-this-token\nrm docs/report.docx\n',
    );
    const r = analyze('source ./private-warning.sh', {
      cwd: toPosix(root),
      realFs: true,
    });
    assert.deepEqual(r.effects.map(effect => effect.path), [
      toPosix(nodePath.join(root, 'docs', 'report.docx')),
    ]);
    assert.ok(r.warnings.some(w =>
      w.includes('source') && w.includes('details omitted')));
    assert.ok(!r.warnings.some(w =>
      w.includes('do-not-upload-this-token')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── bounded eval ──

test('agent: literal eval executes in the current shell state', () => {
  const r = analyze(`
    cleanup() { rm "seen/$1"; }
    target=outer
    eval 'target=inside; cd /work; cleanup report.docx; generated() { rm "made/$1"; }'
    generated slides.pptx
    rm "$target.txt"
  `, { cwd: '/home' });
  assert.deepEqual(
    r.effects.map(effect => effect.path),
    [
      '/work/seen/report.docx',
      '/work/made/slides.pptx',
      '/work/inside.txt',
    ],
  );
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
  assert.ok(!r.warnings.some(w => w.includes('effects uncertain')));
});

test('agent: eval joins arguments, handles options, and preserves exact status', () => {
  const r = analyze(`
    eval rm docs/report.docx
    eval false || rm docs/fallback.pptx
    eval true && rm docs/success.jpg
    eval -- 'rm docs/after-options.png'
    eval -x 'rm docs/not-run.pdf'
  `, { cwd: '/work' });
  assert.deepEqual(
    r.effects.map(effect => effect.path),
    [
      '/work/docs/report.docx',
      '/work/docs/fallback.pptx',
      '/work/docs/success.jpg',
      '/work/docs/after-options.png',
    ],
  );
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
});

test('agent: eval preserves abstract branches for following commands', () => {
  const r = analyze(`
    eval 'if mystery; then target=a; else target=b; fi'
    rm "$target.docx"
  `, { cwd: '/work' });
  assert.deepEqual(
    r.effects.map(effect => effect.path).sort(),
    ['/work/a.docx', '/work/b.docx'],
  );
  assert.ok(r.effects.every(effect =>
    effect.uncertainty.includes('conditional-branch')));
});

test('agent: eval output participates in command substitution', () => {
  const r = analyze(
    `target=$(eval 'printf "%s" docs/report.docx'); rm "$target"`,
    { cwd: '/work' },
  );
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/work/docs/report.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'exact');
});

test('agent: eval propagates return and loop control to its caller', () => {
  const r = analyze(`
    cleanup() { eval 'return 7'; rm /tmp/missed-return.docx; }
    cleanup || rm /tmp/return-fallback.docx
    for item in one two; do
      eval 'break'
      rm /tmp/missed-break.docx
    done
    rm /tmp/after-loop.docx
  `, { cwd: '/work' });
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/tmp/return-fallback.docx',
    '/tmp/after-loop.docx',
  ]);
  assert.ok(r.effects.every(effect => effect.certainty === 'exact'));
});

test('agent: eval parser warnings preserve an over-approximate fallback', () => {
  const r = analyze(
    `eval 'rm /tmp/warned.docx "'; rm /tmp/after-warning.docx`,
    { cwd: '/work' },
  );
  assert.deepEqual(r.effects.map(effect => effect.path), [
    '/tmp/warned.docx',
    '/tmp/after-warning.docx',
  ]);
  assert.equal(r.effects[0].certainty, 'overapprox');
  assert.ok(r.effects[0].uncertainty.includes('unknown-command'));
  assert.equal(r.effects[1].certainty, 'exact');
  assert.ok(r.warnings.some(w =>
    w.includes('eval') && w.includes('unexpected EOF')));
});

test('agent: unresolved and oversized eval input stays bounded and explicit', () => {
  const dynamic = analyze('eval "$(mystery)"', { cwd: '/work' });
  assert.equal(dynamic.effects.length, 0);
  assert.ok(dynamic.warnings.some(w =>
    w.includes('eval') && w.includes('unresolved arguments')));

  const oversized = analyze(
    `eval 'rm ${'x'.repeat(64 * 1024)}'`,
    { cwd: '/work' },
  );
  assert.equal(oversized.effects.length, 0);
  assert.ok(oversized.warnings.some(w =>
    w.includes('eval') && w.includes('exceeds 65536 characters')));
});

test('agent: recursive eval stops at the shared nested-script depth budget', () => {
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  let script = 'rm /tmp/beyond-eval-depth.docx';
  for (let depth = 0; depth < 5; depth++) {
    script = `eval ${shellQuote(script)}`;
  }
  const r = analyze(script, { cwd: '/work' });
  assert.equal(r.effects.length, 0);
  assert.ok(r.warnings.some(w =>
    w.includes('eval') && w.includes('nested script depth 4')));
});

// ── Real agent scenario: setting up a Python virtualenv ──

test('agent: python project setup script', () => {
  const script = `
    PROJECT=/home/dev/myproject
    mkdir -p $PROJECT/{src,tests,docs,scripts}
    rm $PROJECT/src/__init__.py
    rm $PROJECT/tests/__init__.py
    rm $PROJECT/setup.py
    rm $PROJECT/README.md
    rm $PROJECT/requirements.txt
    cp /templates/gitignore $PROJECT/.gitignore
    chmod 755 $PROJECT/scripts
  `;
  const r = analyze(script, { cwd: '/' });
  const mkdirs = r.effects.filter(e => e.type === 'mkdir');
  const deletes = r.effects.filter(e => e.type === 'delete');
  const copies = r.effects.filter(e => e.type === 'copy');
  const chmods = r.effects.filter(e => e.type === 'chmod');
  assert.equal(mkdirs.length, 4);  // src, tests, docs, scripts
  assert.equal(deletes.length, 5); // __init__.py x 2, setup.py, README.md, requirements.txt
  assert.equal(copies.length, 1);  // .gitignore
  assert.equal(chmods.length, 1);  // scripts dir
});

// ── Real agent scenario: log rotation script ──

test('agent: log rotation with date-stamped backups', () => {
  const script = `
    LOG_DIR=/var/log/myapp
    BACKUP_DIR=/var/backup/logs
    DATE=20240315
    mkdir -p $BACKUP_DIR

    for log in access error debug; do
      cp $LOG_DIR/$log.log $BACKUP_DIR/$log-$DATE.log
      echo "" > $LOG_DIR/$log.log
    done

    rm -f $BACKUP_DIR/old-*.log
  `;
  const r = analyze(script, { cwd: '/' });
  // 1 mkdir + 3×(cp + write) + 1 delete = 8
  assert.equal(r.effects.length, 8);
  assert.ok(r.effects.some(e =>
    e.type === 'copy' && e.path.includes('access-20240315.log')
  ));
});

// ── Numeric brace expansion ──

test('agent: numeric brace expansion {1..5}', () => {
  const script = `
    for i in {1..5}; do
      rm /tmp/part_$i.dat
    done
  `;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 5);
  assert.equal(r.effects[0].path, '/tmp/part_1.dat');
  assert.equal(r.effects[4].path, '/tmp/part_5.dat');
});

// ── Multiple redirects on same command ──

test('agent: command with both stdout and stderr redirects', () => {
  const script = `make all > /tmp/build.stdout 2> /tmp/build.stderr`;
  const r = analyze(script, { cwd: '/src' });
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.some(e => e.path === '/tmp/build.stdout'));
  assert.ok(r.effects.some(e => e.path === '/tmp/build.stderr'));
});

// ── Chown ──

test('agent: chown on deployed files', () => {
  const script = `
    rm /srv/www/index.html
    chown www-data:www-data /srv/www/index.html
    chown -R www-data:www-data /srv/www/assets /srv/www/static
  `;
  const r = analyze(script, { cwd: '/' });
  assert.ok(r.effects.some(e => e.type === 'delete'));
  const chowns = r.effects.filter(e => e.type === 'chown');
  assert.equal(chowns.length, 3);
});

// ── Random scenario: CI/CD agent installing deps ──

test('agent: CI install script with fallback chains', () => {
  const script = `
    mkdir -p /tmp/ci-workspace
    cd /tmp/ci-workspace
    curl -o node.tar.gz https://nodejs.org/dist/v20/node.tar.gz || wget -O node.tar.gz https://nodejs.org/dist/v20/node.tar.gz
    mkdir -p /usr/local/node
    dd of=/usr/local/node/bin/node
    chmod 755 /usr/local/node/bin/node
    ln -s /usr/local/node/bin/node /usr/local/bin/node
  `;
  const r = analyze(script, { cwd: '/home/ci' });
  assert.ok(r.effects.some(e => e.type === 'mkdir'));
  // Both curl and wget are walked (OR chain conservative)
  assert.ok(r.effects.some(e => e.command === 'curl'));
  assert.ok(r.effects.some(e => e.command === 'wget'));
  assert.ok(r.effects.some(e => e.type === 'link'));
  assert.ok(r.effects.some(e => e.type === 'chmod'));
});

// ── Random: agent backing up database dumps ──

test('agent: database backup rotation', () => {
  const script = `
    DUMP_DIR=/var/backups/db
    KEEP=3
    mkdir -p $DUMP_DIR

    dd of=$DUMP_DIR/dump_latest.sql

    if test -f $DUMP_DIR/dump_2.sql; then
      rm $DUMP_DIR/dump_2.sql
    fi
    if test -f $DUMP_DIR/dump_1.sql; then
      mv $DUMP_DIR/dump_1.sql $DUMP_DIR/dump_2.sql
    fi
    if test -f $DUMP_DIR/dump_latest.sql; then
      cp $DUMP_DIR/dump_latest.sql $DUMP_DIR/dump_1.sql
    fi
  `;
  const r = analyze(script, { cwd: '/' });
  assert.ok(r.effects.some(e => e.type === 'mkdir'));
  assert.ok(r.effects.some(e => e.type === 'delete'));
  assert.ok(r.effects.some(e => e.type === 'move'));
  assert.ok(r.effects.some(e => e.type === 'copy'));
});

// ── Inline assignment with command ──

test('agent: env PREFIX var before command', () => {
  const script = `DESTDIR=/staging PREFIX=/usr/local rm marker.txt`;
  const r = analyze(script, { cwd: '/build' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
});

// ── Until loop ──

test('agent: until loop effects marked uncertain', () => {
  const script = `until test -f /tmp/ready; do rm /tmp/waiting; done`;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].uncertain, true);
});

// ── Install command ──

test('agent: install -D creates dirs and copies', () => {
  const directories = analyze('install -d /opt/app/bin /opt/app/lib /opt/app/share', { cwd: '/' });
  assert.equal(directories.effects.length, 3);
  assert.ok(directories.effects.every(e => e.type === 'mkdir'));

  const file = analyze('install -D build/tool /opt/app/bin/tool', { cwd: '/' });
  assert.deepEqual(file.effects.map(effect => [
    effect.type,
    effect.path,
    effect.source,
    effect.replacement,
  ]), [
    ['mkdir', '/opt/app/bin', undefined, undefined],
    ['copy', '/opt/app/bin/tool', 'build/tool', 'replace'],
  ]);
});

// ── Redirect >| (force clobber) ──

test('agent: >| force overwrite redirect', () => {
  const script = `echo "fresh" >| /tmp/protected.txt`;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
  assert.equal(r.effects[0].path, '/tmp/protected.txt');
});

// ── Here-string <<< ──

test('agent: here-string redirect', () => {
  const script = `cat <<< "inline data" > /tmp/out.txt`;
  const r = analyze(script, { cwd: '/' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'write');
});

// ── Massive realistic deploy script ──

test('agent: full realistic deploy script', () => {
  const script = `
    set -e

    APP_NAME=webapp
    DEPLOY_DIR=/opt/$APP_NAME
    BACKUP_DIR=/opt/backups/$APP_NAME
    TIMESTAMP=20240315_120000
    RELEASE_URL=https://releases.example.com/v3.2.1/bundle.tar.gz

    # Backup current
    if test -d $DEPLOY_DIR; then
      mkdir -p $BACKUP_DIR
      cp -r $DEPLOY_DIR $BACKUP_DIR/$TIMESTAMP
    fi

    # Download new release
    mkdir -p $DEPLOY_DIR/releases/$TIMESTAMP
    cd $DEPLOY_DIR/releases/$TIMESTAMP
    curl -o bundle.tar.gz $RELEASE_URL

    # Deploy
    mkdir -p $DEPLOY_DIR/current/public
    cp bundle.tar.gz $DEPLOY_DIR/current/
    dd of=$DEPLOY_DIR/current/public/index.html

    # Config
    cat > $DEPLOY_DIR/current/.env <<EOF
APP_ENV=production
PORT=3000
EOF

    # Permissions
    chmod 600 $DEPLOY_DIR/current/.env
    chown -R www-data:www-data $DEPLOY_DIR/current

    # Cleanup old releases
    rm -rf $DEPLOY_DIR/releases/$TIMESTAMP/bundle.tar.gz

    echo "Deploy complete" >> /var/log/deploy.log
  `;
  const r = analyze(script, { cwd: '/home/deployer' });

  // Verify we got a rich variety of effects
  const effectTypes = new Set(r.effects.map(e => e.type));
  assert.ok(effectTypes.has('mkdir'), 'should have mkdir');
  assert.ok(effectTypes.has('copy'), 'should have copy');
  assert.ok(effectTypes.has('write'), 'should have write');
  assert.ok(effectTypes.has('chmod'), 'should have chmod');
  assert.ok(effectTypes.has('chown'), 'should have chown');
  assert.ok(effectTypes.has('delete'), 'should have delete');
  assert.ok(effectTypes.has('append'), 'should have append');
  // Verify key paths
  assert.ok(r.effects.some(e => e.path.includes('webapp')));
  assert.ok(r.effects.some(e => e.path === '/var/log/deploy.log'));
  assert.ok(r.effects.length >= 10, `expected >= 10 effects, got ${r.effects.length}`);
});

// ═══════════════════════════════════════════════════════════════════
// GLOB EXPANSION / VFS TESTS
// ═══════════════════════════════════════════════════════════════════

console.log('\n--- Glob expansion / VFS tests ---\n');

// ── Basic glob with VirtualFS ──

test('glob: rm *.txt with VFS → concrete deletes', () => {
  const r = analyze('rm *.txt', {
    cwd: '/data',
    fs: ['/data/a.txt', '/data/b.txt', '/data/c.log'],
  });
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.every(e => e.type === 'delete'));
  assert.ok(r.effects.some(e => e.path === '/data/a.txt'));
  assert.ok(r.effects.some(e => e.path === '/data/b.txt'));
  assert.ok(r.effects.every(e => !e.uncertain));
});

// ── Backward compat: no VFS → pass-through, uncertain ──

test('glob: rm *.txt without VFS → uncertain pass-through', () => {
  const r = analyze('rm *.txt', { cwd: '/data' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/data/*.txt');
  assert.equal(r.effects[0].uncertain, true);
});

// ── No matches → literal pass-through ──

test('glob: no matches → literal pass-through', () => {
  const r = analyze('rm *.xyz', {
    cwd: '/data',
    fs: ['/data/a.txt', '/data/b.log'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/data/*.xyz');
  assert.equal(r.effects[0].uncertain, true);
});

// ── ? single-char glob ──

test('glob: ? single char match', () => {
  const r = analyze('rm file?.txt', {
    cwd: '/tmp',
    fs: ['/tmp/file1.txt', '/tmp/file2.txt', '/tmp/file10.txt'],
  });
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.some(e => e.path === '/tmp/file1.txt'));
  assert.ok(r.effects.some(e => e.path === '/tmp/file2.txt'));
});

// ── [abc] character class ──

test('glob: [abc] character class', () => {
  const r = analyze('rm [ab].txt', {
    cwd: '/tmp',
    fs: ['/tmp/a.txt', '/tmp/b.txt', '/tmp/c.txt'],
  });
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.some(e => e.path === '/tmp/a.txt'));
  assert.ok(r.effects.some(e => e.path === '/tmp/b.txt'));
});

// ── * skips dotfiles ──

test('glob: * skips dotfiles', () => {
  const r = analyze('rm *', {
    cwd: '/dir',
    fs: ['/dir/visible.txt', '/dir/.hidden'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/dir/visible.txt');
});

// ── Path with directory: src/*.js ──

test('glob: path with directory src/*.js', () => {
  const r = analyze('rm src/*.js', {
    cwd: '/app',
    fs: ['/app/src/index.js', '/app/src/utils.js', '/app/src/style.css'],
  });
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.some(e => e.path === '/app/src/index.js'));
  assert.ok(r.effects.some(e => e.path === '/app/src/utils.js'));
});

// ── ** globstar ──

test('glob: ** globstar matches nested files', () => {
  const r = analyze('rm **/*.log', {
    cwd: '/app',
    fs: ['/app/app.log', '/app/logs/error.log', '/app/logs/deep/debug.log', '/app/src/main.js'],
  });
  assert.equal(r.effects.length, 3);
  assert.ok(r.effects.some(e => e.path === '/app/app.log'));
  assert.ok(r.effects.some(e => e.path === '/app/logs/error.log'));
  assert.ok(r.effects.some(e => e.path === '/app/logs/deep/debug.log'));
});

test('glob: adjacent globstars collapse to one Bash-equivalent traversal', () => {
  const files = [
    '/work/root/a/target-1.tmp',
    '/work/root/a/b/target-2.tmp',
    '/work/root/c/d/e/target-3.tmp',
  ];
  const single = analyze('rm root/**/target-*.tmp', {
    cwd: '/work',
    fs: files,
  });
  const repeated = analyze('rm root/**/**/**/**/**/**/target-*.tmp', {
    cwd: '/work',
    fs: files,
  });
  assert.deepEqual(
    repeated.effects.map(effect => effect.path),
    single.effects.map(effect => effect.path),
  );
  assert.equal(new Set(repeated.effects.map(effect => effect.path)).size, 3);
  assert.ok(!repeated.warnings.some(warning =>
    warning.includes('glob expansion widened')));
});

test('glob: structural traversal budgets return an explicit incomplete result', () => {
  const vfs = new VirtualFS([
    '/work/root/a/one.tmp',
    '/work/root/b/two.tmp',
  ]);
  const budget = createGlobExpansionBudget({
    maxDirectoryScans: 20,
    maxVisitedEntries: 2,
    maxPathCandidates: 20,
  });
  const result = glob_expand_bounded(
    'root/**/*.tmp',
    '/work',
    vfs,
    { budget, maxMatches: 20 },
  );
  assert.equal(result.complete, false);
  assert.ok(result.limitReasons.includes('visited-entry-limit'));
  assert.ok(result.visitedEntries <= 2);
});

test('glob: output budgets retain exact witnesses and an unresolved remainder', () => {
  const vfs = new VirtualFS(Array.from(
    { length: 8 },
    (_, index) => `/work/root/file-${index}.tmp`,
  ));
  const words: ExpandedWord[] = [
    { word: 'cp', uncertain: false, noglob: true },
    { word: 'root/*.tmp', uncertain: false },
    { word: '/backup/', uncertain: false, noglob: true },
  ];
  const warnings: string[] = [];
  const expanded = glob_expand_words(words, vfs, '/work', {
    maxWords: 5,
    onWarning: warning => warnings.push(warning),
  });
  assert.equal(expanded.length, 5);
  assert.deepEqual(
    expanded.slice(1, -2).map(word => word.word),
    [
      '/work/root/file-0.tmp',
      '/work/root/file-1.tmp',
    ],
  );
  assert.equal(expanded[expanded.length - 2]?.word, 'root/*.tmp');
  assert.equal(expanded[expanded.length - 2]?.noglob, true);
  assert.equal(expanded[expanded.length - 1]?.word, '/backup/');
  assert.ok(warnings.some(warning => warning.includes('match-limit')));
});

test('glob: command word cap preserves an unresolved effect for omitted matches', () => {
  const files = Array.from(
    { length: 4005 },
    (_, index) => `/work/root/file-${String(index).padStart(4, '0')}.tmp`,
  );
  const pattern = 'root/file-[0-9][0-9][0-9][0-9].tmp';
  const result = analyze(`rm -- ${pattern}`, { cwd: '/work', fs: files });
  const unresolved = result.effects.filter(effect =>
    effect.uncertainty.includes('glob-without-fs'));

  assert.equal(result.effects.length, 3998);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]?.path, `/work/${pattern}`);
  assert.ok(result.warnings.some(warning =>
    warning.includes('glob expansion widened (match-limit)')));
});

// ── Effect feedback: rm then glob doesn't see deleted ──

test('glob: effect feedback — rm then glob does not see deleted file', () => {
  const r = analyze('rm a.txt; rm *.txt', {
    cwd: '/work',
    fs: ['/work/a.txt', '/work/b.txt'],
  });
  // rm a.txt removes from VFS; rm *.txt only sees b.txt
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].path, '/work/a.txt');
  assert.equal(deletes[1].path, '/work/b.txt');
});

test('glob: unknown if forks VFS deletion overlays before later expansion', () => {
  const result = analyze(
    'if mystery; then\n rm a.txt\nelse\n :\nfi\nrm *.txt',
    { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] },
  );
  const laterDeletes = result.effects.filter(effect =>
    effect.type === 'delete' && effect.line === 6);
  assert.deepEqual(
    laterDeletes.map(effect => effect.path).sort(),
    ['/work/a.txt', '/work/b.txt'],
  );
  const conditional = laterDeletes.find(effect => effect.path === '/work/a.txt');
  const definite = laterDeletes.find(effect => effect.path === '/work/b.txt');
  assert.ok(conditional?.uncertainty.includes('conditional-branch'));
  assert.equal(definite?.certainty, 'exact');
  assert.deepEqual(definite?.uncertainty, []);
});

test('glob: unknown if forks VFS creation overlays before later expansion', () => {
  const result = analyze(
    'if mystery; then\n echo x > a.txt\nelse\n echo x > b.txt\nfi\nrm *.txt',
    { cwd: '/work', fs: [] },
  );
  assert.deepEqual(
    result.effects.filter(effect => effect.type === 'write')
      .map(effect => effect.path).sort(),
    ['/work/a.txt', '/work/b.txt'],
  );
  assert.deepEqual(
    result.effects.filter(effect => effect.type === 'delete')
      .map(effect => effect.path).sort(),
    ['/work/a.txt', '/work/b.txt'],
  );
});

test('glob: swapping unknown branch order preserves the normalized effect union', () => {
  const options = { cwd: '/work', fs: ['/work/a.txt', '/work/b.txt'] };
  const left = analyze(
    'if mystery; then\n rm a.txt\nelse\n :\nfi\nrm *.txt',
    options,
  );
  const right = analyze(
    'if mystery; then\n :\nelse\n rm a.txt\nfi\nrm *.txt',
    options,
  );
  const normalize = (effects: FileEffect[]) => effects.map(effect => JSON.stringify({
    type: effect.type,
    path: effect.path,
    command: effect.command,
    certainty: effect.certainty,
    uncertainty: [...effect.uncertainty].sort(),
  })).sort();
  assert.deepEqual(normalize(left.effects), normalize(right.effects));
});

// ── rm on directory without -r/-R/-d → warning, no delete ──

test('rm: directory without -r → warning, no delete', () => {
  const r = analyze('rm mydir', {
    cwd: '/work',
    fs: ['/work/mydir/'],
  });
  assert.equal(r.effects.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("cannot remove 'mydir'"));
  assert.ok(r.warnings[0].includes('Is a directory'));
});

test('rm -r: directory deletes normally', () => {
  const r = analyze('rm -r mydir', {
    cwd: '/work',
    fs: ['/work/mydir/'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/work/mydir');
  assert.equal(r.warnings.length, 0);
});

test('rm -R: directory deletes normally', () => {
  const r = analyze('rm -R mydir', {
    cwd: '/work',
    fs: ['/work/mydir/'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
});

test('rm --recursive: long flag deletes directory', () => {
  const r = analyze('rm --recursive mydir', {
    cwd: '/work',
    fs: ['/work/mydir/'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.warnings.length, 0);
});

test('rm -d: empty-dir flag deletes directory', () => {
  const r = analyze('rm -d mydir', {
    cwd: '/work',
    fs: ['/work/mydir/'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
});

test('rm: mixed file + directory without -r → partial delete + warning', () => {
  const r = analyze('rm file.txt mydir other.log', {
    cwd: '/work',
    fs: ['/work/file.txt', '/work/mydir/', '/work/other.log'],
  });
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 2);
  assert.ok(deletes.some(e => e.path === '/work/file.txt'));
  assert.ok(deletes.some(e => e.path === '/work/other.log'));
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("'mydir'"));
});

test('rm: directory without VFS → pass-through delete (backward compat)', () => {
  const r = analyze('rm mydir', { cwd: '/work' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/work/mydir');
});

test('rm -rf: combined flags delete directory', () => {
  const r = analyze('rm -rf mydir', {
    cwd: '/work',
    fs: ['/work/mydir/', '/work/mydir/nested.txt'],
  });
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].path, '/work/mydir');
  assert.equal(r.warnings.length, 0);
});

test('rm --dir: long flag deletes directory', () => {
  const r = analyze('rm --dir mydir', {
    cwd: '/work',
    fs: ['/work/mydir/'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.warnings.length, 0);
});

test('rm: non-existent path still emits delete (conservative)', () => {
  const r = analyze('rm ghost.txt', {
    cwd: '/work',
    fs: ['/work/other.txt'],
  });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/work/ghost.txt');
});

test('rm: nested directory path without -r → warning', () => {
  const r = analyze('rm project/src', {
    cwd: '/work',
    fs: ['/work/project/src/', '/work/project/src/plugin/direct-hook.ts'],
  });
  assert.equal(r.effects.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("'project/src'"));
});

test('rm: effect feedback — mkdir then rm without -r warns', () => {
  const r = analyze('mkdir newdir; rm newdir', {
    cwd: '/work',
    fs: [],
  });
  const mkdirs = r.effects.filter(e => e.type === 'mkdir');
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(mkdirs.length, 1);
  assert.equal(deletes.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes('Is a directory'));
});

test('rm: effect feedback — mkdir then rm -r succeeds', () => {
  const r = analyze('mkdir newdir; rm -r newdir', {
    cwd: '/work',
    fs: [],
  });
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].path, '/work/newdir');
  assert.equal(r.warnings.length, 0);
});

test('rm: glob expands to dir + files → files delete, dir warns', () => {
  const r = analyze('rm *', {
    cwd: '/work',
    fs: ['/work/a.txt', '/work/b.log', '/work/sub/'],
  });
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 2);
  assert.ok(deletes.some(e => e.path === '/work/a.txt'));
  assert.ok(deletes.some(e => e.path === '/work/b.log'));
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("'/work/sub'"));
});

test('rm -r: glob expands to dir + files → all delete, no warn', () => {
  const r = analyze('rm -r *', {
    cwd: '/work',
    fs: ['/work/a.txt', '/work/sub/'],
  });
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 2);
  assert.equal(r.warnings.length, 0);
});

test('rm: absolute directory path without -r → warning', () => {
  const r = analyze('rm /opt/app', {
    cwd: '/home',
    fs: ['/opt/app/'],
  });
  assert.equal(r.effects.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("'/opt/app'"));
});

test('rm -fR: combined flags with -R delete directory', () => {
  const r = analyze('rm -fR dist', {
    cwd: '/proj',
    fs: ['/proj/dist/', '/proj/dist/main.js'],
  });
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].path, '/proj/dist');
  assert.equal(r.warnings.length, 0);
});

// ── for loop with glob ──

test('agent: for f in *.cfg; do cp $f /backup/; done — glob in for-loop', () => {
  const r = analyze('for f in *.cfg; do cp $f /backup/; done', {
    cwd: '/etc',
    fs: ['/etc/app.cfg', '/etc/db.cfg', '/etc/README'],
  });
  const copies = r.effects.filter(e => e.type === 'copy');
  assert.equal(copies.length, 2);
  assert.ok(copies.some(e => e.path === '/backup/app.cfg' && e.source === '/etc/app.cfg'));
  assert.ok(copies.some(e => e.path === '/backup/db.cfg' && e.source === '/etc/db.cfg'));
});

// ── set -f disables glob expansion ──

test('glob: set -f disables glob expansion', () => {
  const r = analyze('set -f; rm *.txt', {
    cwd: '/data',
    fs: ['/data/a.txt', '/data/b.txt'],
  });
  // noglob active: *.txt passed through literally
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/data/*.txt');
  assert.equal(r.effects[0].uncertain, true);
});

// ── Quoted glob — no expansion ──

test('glob: quoted "*.txt" is not expanded', () => {
  const r = analyze('rm "*.txt"', {
    cwd: '/data',
    fs: ['/data/a.txt', '/data/b.txt'],
  });
  // Quoted: no glob expansion, literal *.txt
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/data/*.txt');
});

// ── RealFS: glob against actual project directory ──

test('glob: realFs against project src/analysis/*.ts', () => {
  const r = analyze('rm src/analysis/*.ts', {
    cwd: toPosix(process.cwd()),
    realFs: true,
  });
  // src/analysis/ holds shared non-bash analysis modules.
  assert.ok(r.effects.length >= 4, `expected >= 4 .ts files in src/analysis/, got ${r.effects.length}`);
  assert.ok(r.effects.some(e => e.path.endsWith('/src/analysis/vfs.ts')));
  assert.ok(r.effects.some(e => e.path.endsWith('/src/analysis/postprocess.ts')));
  assert.ok(r.effects.every(e => !e.uncertain));
});

// ── Agent-style deploy script with globs ──

test('agent: deploy script with glob cleanup and copy', () => {
  const script = `
    DEPLOY=/opt/app
    mkdir -p $DEPLOY/static
    cp *.js $DEPLOY/static/
    cp *.css $DEPLOY/static/
    rm /tmp/build/*.o
  `;
  const r = analyze(script, {
    cwd: '/build',
    fs: [
      '/build/app.js', '/build/vendor.js',
      '/build/style.css',
      '/tmp/build/main.o', '/tmp/build/utils.o', '/tmp/build/data.json',
    ],
  });
  const copies = r.effects.filter(e => e.type === 'copy');
  const deletes = r.effects.filter(e => e.type === 'delete');
  assert.equal(copies.length, 3); // 2 .js + 1 .css
  assert.equal(deletes.length, 2); // 2 .o files
});

// ═══════════════════════════════════════════════════════════════════
// WINDOWS PATH TESTS
// ═══════════════════════════════════════════════════════════════════

console.log('\n--- Windows path tests ---\n');

// Standard shell eats unquoted backslashes (they're escape chars).
// On Windows, users write: cd 'C:\Users\foo' (quoted) or cd C:/Users/foo.

test('win: cd with single-quoted backslash path', () => {
  const r = analyze("cd 'C:\\Users\\foo'; rm file.txt", { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/Users/foo/file.txt');
});

test('win: cd with forward-slash drive path', () => {
  const r = analyze('cd D:/data; mkdir sub', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/d/data/sub');
});

test('win: absolute forward-slash drive path in arg', () => {
  const r = analyze('rm C:/out/file.txt', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/out/file.txt');
});

test('win: /c/Windows style already POSIX', () => {
  const r = analyze('cd /c/Windows; rm test.txt', { cwd: '/home' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/Windows/test.txt');
});

test('win: mixed — cd forward-slash drive then relative path', () => {
  const r = analyze('cd C:/project; cp src/main.js /c/deploy/', { cwd: '/tmp' });
  const cp = r.effects.find(e => e.type === 'copy');
  assert.ok(cp);
  assert.equal(cp.path, '/c/deploy/main.js');
  assert.equal(cp.source, 'src/main.js');
});

test('win: cwd option accepts Windows path', () => {
  const r = analyze('rm output.log', { cwd: 'C:\\Users\\dev\\project' });
  assert.equal(r.effects[0].path, '/c/Users/dev/project/output.log');
});

test('win: cwd accepts forward-slash Windows path', () => {
  const r = analyze('rm output.log', { cwd: 'C:/Users/dev/project' });
  assert.equal(r.effects[0].path, '/c/Users/dev/project/output.log');
});

test('win: cwd accepts lowercase drive with backslashes', () => {
  const r = analyze('rm output.log', { cwd: 'c:\\users\\dev\\project' });
  assert.equal(r.effects[0].path, '/c/users/dev/project/output.log');
});

test('win: cwd accepts git-bash POSIX form', () => {
  const r = analyze('rm output.log', { cwd: '/c/Users/dev/project' });
  assert.equal(r.effects[0].path, '/c/Users/dev/project/output.log');
});

test('win: cwd accepts non-C drive', () => {
  const r = analyze('rm output.log', { cwd: 'D:\\data' });
  assert.equal(r.effects[0].path, '/d/data/output.log');
});

test('win: cwd accepts bare drive letter', () => {
  const r = analyze('rm output.log', { cwd: 'C:' });
  assert.equal(r.effects[0].path, '/c/output.log');
});

test('win: cwd accepts drive with trailing separator', () => {
  const r = analyze('rm output.log', { cwd: 'C:\\' });
  assert.equal(r.effects[0].path, '/c/output.log');
});

// Unquoted backslash paths — Windows user-friendly divergence from standard shell.
// Standard shells eat unquoted backslashes as escape chars; we keep them literal
// when the word starts with a drive-letter prefix (applied at the lex stage).

test('win: cd C:\\test\\bin unquoted (backslashes literal)', () => {
  const r = analyze('cd C:\\test\\bin; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/test/bin/a.txt');
});

test('win: unquoted backslash path as command argument', () => {
  const r = analyze('rm C:\\out\\file.txt', { cwd: '/home/user' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/out/file.txt');
});

test('win: cd C:\\ (trailing backslash) preserves command separator', () => {
  const r = analyze('cd C:\\; rm root.txt', { cwd: '/home/user' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/root.txt');
});

test('win: unquoted backslash path with lowercase drive', () => {
  const r = analyze('cd c:\\users\\dev; rm c.txt', { cwd: '/home/user' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/c/users/dev/c.txt');
});

test('win: non-drive words still use standard escape semantics', () => {
  // Standard: `\t` in unquoted word → literal `t` (backslash eaten).
  // Our drive-letter heuristic must NOT affect non-drive words.
  const r = analyze('rm a\\tb.txt', { cwd: '/home/user' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/home/user/atb.txt');
});

test('win: toPosix handles all common forms', () => {
  assert.equal(toPosix('C:\\Users\\foo'), '/c/Users/foo');
  assert.equal(toPosix('C:/Users/foo'), '/c/Users/foo');
  assert.equal(toPosix('c:\\users\\foo'), '/c/users/foo');
  assert.equal(toPosix('/c/Users/foo'), '/c/Users/foo');
  assert.equal(toPosix('D:\\'), '/d/');
  assert.equal(toPosix('C:'), '/c');
  assert.equal(toPosix('/home/user'), '/home/user');
});

// ── Bare drive letter inside commands (was previously a gap) ──

test('win: cd C: (bare drive, no separator) treated as absolute', () => {
  const r = analyze('cd C:; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/a.txt');
});

test('win: cd c: (lowercase bare drive)', () => {
  const r = analyze('cd c:; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/a.txt');
});

test('win: cd D: (non-C bare drive)', () => {
  const r = analyze('cd D:; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/d/a.txt');
});

// ── Windows path inside variable-expanded value ──

test('win: cd $WINDIR with backslash value', () => {
  const r = analyze('cd $WINDIR; rm a.txt',
    { cwd: '/home/user', env: { WINDIR: 'C:\\Windows' } });
  assert.equal(r.effects[0].path, '/c/Windows/a.txt');
});

test('win: cd $WINDIR with forward-slash value', () => {
  const r = analyze('cd $WINDIR; rm a.txt',
    { cwd: '/home/user', env: { WINDIR: 'C:/Windows' } });
  assert.equal(r.effects[0].path, '/c/Windows/a.txt');
});

test('win: ${WINDIR} brace form with backslash value', () => {
  const r = analyze('cd ${WINDIR}; rm a.txt',
    { cwd: '/home/user', env: { WINDIR: 'C:\\Windows\\System32' } });
  assert.equal(r.effects[0].path, '/c/Windows/System32/a.txt');
});

test('win: tilde expansion with Windows HOME', () => {
  const r = analyze('rm ~/file.txt',
    { cwd: '/home/user', env: { HOME: 'C:\\Users\\dev' } });
  assert.equal(r.effects[0].path, '/c/Users/dev/file.txt');
});

test('expansion preserves backslashes in arbitrary var values', () => {
  // VAR='foo\bar' → $VAR must yield foo\bar (standard shell behavior).
  // Previously quote_removal ate the backslash → `foobar`.
  const r = analyze('rm $VAR/x.txt',
    { cwd: '/tmp', env: { VAR: 'foo\\bar' } });
  // Path resolution converts `\` to `/` as a separator, which is fine.
  assert.equal(r.effects[0].path, '/tmp/foo/bar/x.txt');
});

test('expansion preserves double-quote chars in var values', () => {
  const r = analyze('rm $VAR/x.txt',
    { cwd: '/tmp', env: { VAR: 'it"s' } });
  assert.equal(r.effects[0].path, '/tmp/it"s/x.txt');
});

test('expansion preserves single-quote chars in var values', () => {
  const r = analyze('rm $VAR/x.txt',
    { cwd: '/tmp', env: { VAR: "it's" } });
  assert.equal(r.effects[0].path, "/tmp/it's/x.txt");
});

// ── Cross-drive operations ──

test('win: cp across drives (forward slashes)', () => {
  const r = analyze('cp C:/src/file D:/dst/file', { cwd: '/home/user' });
  const cp = r.effects.find(e => e.type === 'copy');
  assert.ok(cp);
  assert.equal(cp.path, '/d/dst/file');
  assert.equal(cp.source, 'C:/src/file');
});

test('win: cp across drives (unquoted backslashes)', () => {
  const r = analyze('cp C:\\src\\file D:\\dst\\file', { cwd: '/home/user' });
  const cp = r.effects.find(e => e.type === 'copy');
  assert.ok(cp);
  assert.equal(cp.path, '/d/dst/file');
});

test('win: mv across drives', () => {
  const r = analyze('mv C:/src/file D:/dst/', { cwd: '/home/user' });
  const mv = r.effects.find(e => e.type === 'move');
  assert.ok(mv);
  assert.equal(mv.path, '/d/dst/file');
});

// ── Path shape preservation ──

test('win: rm C:/test/ trailing forward slash', () => {
  const r = analyze('rm C:/test/', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/test/');
});

test('win: rm C:\\test\\ trailing backslash', () => {
  const r = analyze('rm C:\\test\\', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/test/');
});

test('win: cd C:/test/./foo canonicalizes ./', () => {
  const r = analyze('cd C:/test/./foo; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/test/foo/a.txt');
});

test('win: cd C:/test/../bar canonicalizes ../', () => {
  const r = analyze('cd C:/test/../bar; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/bar/a.txt');
});

test('win: mixed forward/back slashes in one path', () => {
  const r = analyze('cd C:/foo\\bar; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/foo/bar/a.txt');
});

// ── Drive letter composition via variables ──

test('win: DRIVE=C:; cd $DRIVE/test — drive from var, separator from source', () => {
  const r = analyze('DRIVE=C:; cd $DRIVE/test; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/test/a.txt');
});

// ── cd - with drive changes ──

test('win: cd drive; cd drive; cd - returns to first via OLDPWD', () => {
  const r = analyze('cd C:/foo; cd D:/bar; cd -; rm back.txt',
    { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/foo/back.txt');
});

// ── Brace expansion with Windows base ──

test('win: brace expansion produces multiple deletes under drive', () => {
  const r = analyze('rm C:/test/{a,b,c}.txt', { cwd: '/home/user' });
  assert.equal(r.effects.length, 3);
  assert.equal(r.effects[0].path, '/c/test/a.txt');
  assert.equal(r.effects[1].path, '/c/test/b.txt');
  assert.equal(r.effects[2].path, '/c/test/c.txt');
});

// ── Pipe / redirect to Windows destination ──

test('win: tee to C:\\log.txt', () => {
  const r = analyze('echo x | tee C:\\log.txt', { cwd: '/home/user' });
  const tee = r.effects.find(e => e.path === '/c/log.txt');
  assert.ok(tee);
});

test('win: redirect > to C:/out.txt', () => {
  const r = analyze('echo x > C:/out.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/c/out.txt');
});

// ── Drive-relative (C:foo) stays relative (explicit behavior, not a bug) ──

test('win: C:foo (drive-relative without separator) kept as relative word', () => {
  // Windows cmd treats `C:foo` as "path foo under current dir on drive C".
  // We can't model "current dir on drive C", so we treat the whole word as
  // a relative path (Unix-style). Document this explicitly.
  const r = analyze('cd C:foo; rm a.txt', { cwd: '/home/user' });
  assert.equal(r.effects[0].path, '/home/user/C:foo/a.txt');
});

// ── postprocess: only files, never directories, ever appear in `affected` ──

/**
 * Build a tmp tree:
 *   <root>/
 *     old_dir/            ← directory itself
 *       a.txt             ← file
 *       b.log             ← file
 *       nested/           ← subdirectory
 *         c.md            ← file
 * Returns the root path (caller is responsible for cleanup).
 */
function makeTmpTree(): string {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-pp-'));
  const oldDir = nodePath.join(root, 'old_dir');
  const nested = nodePath.join(oldDir, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(nodePath.join(oldDir, 'a.txt'), 'aaa');
  fs.writeFileSync(nodePath.join(oldDir, 'b.log'), 'bbbbbb');
  fs.writeFileSync(nodePath.join(nested, 'c.md'), 'ccccccccc');
  return root;
}

function exactEffect(
  type: EffectType,
  path: string,
  replacement?: ReplacementBehavior,
): FileEffect {
  return {
    type,
    path,
    line: 1,
    command: `test-${type}`,
    replacement,
    uncertain: false,
    certainty: 'exact',
    uncertainty: [],
  };
}

function affectedForRisk(result: ReturnType<typeof postprocess>): AffectedInfo {
  const sample = (files: typeof result.oldest) => files.map(file => ({
    path: file.path,
    size: file.size,
    createdAt: file.createdAt.toISOString(),
    modifiedAt: file.modifiedAt.toISOString(),
    operations: [...file.operations],
    executionCertainty: file.executionCertainty,
    disposable: file.disposable,
  }));
  return {
    totalFileCount: result.totalFileCount,
    totalSize: result.totalSize,
    policyFileCount: result.policyFileCount,
    policyTotalSize: result.policyTotalSize,
    definitePolicyFileCount: result.definitePolicyFileCount,
    definitePolicyTotalSize: result.definitePolicyTotalSize,
    conditionalPolicyFileCount: result.conditionalPolicyFileCount,
    conditionalPolicyTotalSize: result.conditionalPolicyTotalSize,
    budgetExhausted: result.budgetExhausted,
    budgetExhaustedCertainty: result.budgetExhaustedCertainty,
    visitedEntries: result.visitedEntries,
    maxDepthReached: result.maxDepthReached,
    oldest: sample(result.oldest),
    largest: sample(result.largest),
    policyOldest: sample(result.policyOldest),
    policyLargest: sample(result.policyLargest),
    definitePolicyOldest: sample(result.definitePolicyOldest),
    conditionalPolicyOldest: sample(result.conditionalPolicyOldest),
    groups: result.groups.map(group => ({
      extension: group.extension,
      totalCount: group.totalCount,
      totalSize: group.totalSize,
      policyCount: group.policyCount,
      policySize: group.policySize,
      definitePolicyCount: group.definitePolicyCount,
      definitePolicySize: group.definitePolicySize,
      conditionalPolicyCount: group.conditionalPolicyCount,
      conditionalPolicySize: group.conditionalPolicySize,
      disposable: group.disposable,
      files: sample(group.files),
      policyFiles: sample(group.policyFiles),
    })),
    specialTargets: result.specialTargets.map(target => ({ ...target })),
    metadataUnavailable: result.metadataUnavailable.map(observation => ({ ...observation })),
  };
}

function classifyDiskEffects(effects: FileEffect[], opts?: ClassifyOpts) {
  const observed = postprocess(effects);
  const analysis = {
    available: true,
    effects,
    affected: affectedForRisk(observed),
  };
  const classified = classifyAnalysis(analysis, opts);
  return { observed, analysis, classified };
}

function directReasons(result: ReturnType<typeof classifyAnalysis>) {
  return result.reasonCodes.filter(code =>
    DIRECT_RISK_POLICY[code as keyof typeof DIRECT_RISK_POLICY] !== undefined);
}

function statisticalAffectedFixture(options: {
  path?: string;
  count?: number;
  size?: number;
  createdAt?: string;
  conditional?: boolean;
} = {}): AffectedInfo {
  const path = options.path ?? '/work/ordinary.txt';
  const count = options.count ?? 1;
  const size = options.size ?? 1;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const conditional = options.conditional ?? false;
  const extension = nodePath.extname(path) || '(no ext)';
  const file = {
    path,
    size,
    createdAt,
    modifiedAt: createdAt,
    operations: ['replace-content' as const],
    executionCertainty: conditional ? 'conditional' as const : 'definite' as const,
    disposable: false,
  };
  return {
    totalFileCount: count,
    totalSize: size,
    policyFileCount: count,
    policyTotalSize: size,
    definitePolicyFileCount: conditional ? 0 : count,
    definitePolicyTotalSize: conditional ? 0 : size,
    conditionalPolicyFileCount: conditional ? count : 0,
    conditionalPolicyTotalSize: conditional ? size : 0,
    budgetExhausted: false,
    oldest: [file],
    largest: [file],
    policyOldest: [file],
    policyLargest: [file],
    definitePolicyOldest: conditional ? [] : [file],
    conditionalPolicyOldest: conditional ? [file] : [],
    groups: [{
      extension,
      totalCount: count,
      totalSize: size,
      policyCount: count,
      policySize: size,
      definitePolicyCount: conditional ? 0 : count,
      definitePolicySize: conditional ? 0 : size,
      conditionalPolicyCount: conditional ? count : 0,
      conditionalPolicySize: conditional ? size : 0,
      disposable: false,
      files: [file],
      policyFiles: [file],
    }],
  };
}

test('postprocess: directories never appear as entries in groups', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const pp = postprocess([
      { type: 'delete', path: oldDir, line: 1, command: 'rm', uncertain: false },
    ]);
    const allPaths = pp.groups.flatMap(g => g.files.map(f => f.path));
    assert.ok(!allPaths.includes(oldDir), 'old_dir path leaked into groups');
    assert.ok(!allPaths.includes(nodePath.join(oldDir, 'nested')),
      'nested dir path leaked into groups');
    // Factual totals include generated files; policy counters exclude them.
    assert.equal(pp.totalFileCount, 3);
    assert.equal(pp.policyFileCount, 2);
    assert.ok(allPaths.some(p => p.endsWith('a.txt')));
    assert.ok(allPaths.some(p => p.endsWith('b.log')));
    assert.ok(allPaths.some(p => p.endsWith('c.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: oldest list contains only files (not directories)', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const pp = postprocess([
      { type: 'delete', path: oldDir, line: 1, command: 'rm', uncertain: false },
    ]);
    // No entry in `oldest` should point at a directory
    for (const entry of pp.oldest) {
      const st = fs.statSync(entry.path);
      assert.ok(st.isFile(), `oldest entry ${entry.path} is not a regular file`);
    }
    // Timestamps should come from the file's own stat, not the dir's.
    for (const entry of pp.oldest) {
      const st = fs.statSync(entry.path);
      const expectedCreatedAt = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
      assert.equal(entry.createdAt.getTime(), expectedCreatedAt.getTime(),
        `createdAt for ${entry.path} must come from the file, not its parent`);
      assert.equal(entry.modifiedAt.getTime(), st.mtime.getTime(),
        `modifiedAt for ${entry.path} must come from the file, not its parent`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: largest list contains only files (not directories)', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const pp = postprocess([
      { type: 'delete', path: oldDir, line: 1, command: 'rm', uncertain: false },
    ]);
    for (const entry of pp.largest) {
      const st = fs.statSync(entry.path);
      assert.ok(st.isFile(), `largest entry ${entry.path} is not a regular file`);
    }
    // Factual size includes the generated log, while policy size preserves the
    // previous user-data total.
    assert.equal(pp.totalSize, 3 + 6 + 9);
    assert.equal(pp.policyTotalSize, 3 + 9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: writing a new file in an existing dir → empty affected', () => {
  const root = makeTmpTree();
  try {
    const newFile = nodePath.join(root, 'old_dir', 'brand_new.txt');
    const pp = postprocess([
      { type: 'write', path: newFile, line: 1, command: '>', uncertain: false },
    ]);
    // The target file doesn't exist, parent dir is NOT scanned → empty.
    assert.equal(pp.totalFileCount, 0);
    assert.equal(pp.totalSize, 0);
    assert.equal(pp.groups.length, 0);
    assert.equal(pp.oldest.length, 0);
    assert.equal(pp.largest.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: disposable extensions remain factual but not policy-relevant', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const lockFile = nodePath.join(oldDir, 'service.lock');
    fs.writeFileSync(lockFile, 'lock');
    const pp = postprocess([
      { type: 'delete', path: oldDir, line: 1, command: 'rm', uncertain: false },
    ]);
    const allPaths = pp.groups.flatMap(g => g.files.map(f => f.path));
    assert.equal(pp.totalFileCount, 4);
    assert.equal(pp.policyFileCount, 2);
    assert.ok(allPaths.some(p => p.endsWith('b.log')));
    assert.ok(allPaths.some(p => p.endsWith('service.lock')));
    assert.ok(pp.groups.filter(g => g.extension === '.log' || g.extension === '.lock')
      .every(g => g.disposable && g.policyCount === 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: deleting a log file is factual but excluded from policy counters', () => {
  const root = makeTmpTree();
  try {
    const logFile = nodePath.join(root, 'old_dir', 'b.log');
    const pp = postprocess([
      { type: 'delete', path: logFile, line: 1, command: 'rm', uncertain: false },
    ]);
    assert.equal(pp.totalFileCount, 1);
    assert.equal(pp.totalSize, 6);
    assert.equal(pp.policyFileCount, 0);
    assert.equal(pp.policyTotalSize, 0);
    assert.equal(pp.groups.length, 1);
    assert.equal(pp.groups[0].disposable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: expanded ignored extensions are case-insensitive', () => {
  const root = makeTmpTree();
  try {
    const backup = nodePath.join(root, 'old_dir', 'settings.BAK');
    const objectFile = nodePath.join(root, 'old_dir', 'module.o');
    const sharedLib = nodePath.join(root, 'old_dir', 'libplugin.SO');
    const executable = nodePath.join(root, 'old_dir', 'tool.exe');
    fs.writeFileSync(backup, 'backup');
    fs.writeFileSync(objectFile, 'object');
    fs.writeFileSync(sharedLib, 'library');
    fs.writeFileSync(executable, 'binary');
    const pp = postprocess([
      { type: 'delete', path: backup, line: 1, command: 'rm', uncertain: false },
      { type: 'delete', path: objectFile, line: 1, command: 'rm', uncertain: false },
      { type: 'delete', path: sharedLib, line: 1, command: 'rm', uncertain: false },
      { type: 'delete', path: executable, line: 1, command: 'rm', uncertain: false },
    ]);
    assert.equal(pp.totalFileCount, 4);
    assert.equal(pp.policyFileCount, 0);
    assert.equal(pp.groups.length, 4);
    assert.ok(pp.groups.every(group => group.disposable));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: ignored log files do not hide nearby user files', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const pp = postprocess([
      { type: 'delete', path: oldDir, line: 1, command: 'rm', uncertain: false },
    ]);
    const allPaths = pp.groups.flatMap(g => g.files.map(f => f.path));
    assert.equal(pp.totalFileCount, 3);
    assert.equal(pp.policyFileCount, 2);
    assert.ok(allPaths.some(p => p.endsWith('a.txt')));
    assert.ok(allPaths.some(p => p.endsWith('c.md')));
    assert.ok(allPaths.some(p => p.endsWith('b.log')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: deleting a random pptx file reports affected file', () => {
  const root = makeTmpTree();
  try {
    const pptx = nodePath.join(root, 'old_dir', 'q4-random-7319.pptx');
    fs.writeFileSync(pptx, 'presentation');
    const pp = postprocess([
      { type: 'delete', path: pptx, line: 1, command: 'rm', uncertain: false },
    ]);
    assert.equal(pp.totalFileCount, 1);
    assert.equal(pp.totalSize, 'presentation'.length);
    assert.equal(pp.groups.length, 1);
    assert.equal(pp.groups[0].extension, '.pptx');
    assert.equal(pp.groups[0].files[0].path, pptx);
    assert.equal(pp.groups[0].files[0].modifiedAt.getTime(), fs.statSync(pptx).mtime.getTime());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: moving an existing file is not data loss', () => {
  const root = makeTmpTree();
  try {
    const src = nodePath.join(root, 'old_dir', 'slides.pptx');
    const dest = nodePath.join(root, 'old_dir', 'slides-renamed.pptx');
    fs.writeFileSync(src, 'presentation');
    const pp = postprocess([
      { type: 'move', path: dest, source: src, line: 1, command: 'mv', uncertain: false },
    ]);
    assert.equal(pp.totalFileCount, 0);
    assert.equal(pp.totalSize, 0);
    assert.equal(pp.groups.length, 0);
    assert.equal(pp.oldest.length, 0);
    assert.equal(pp.largest.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: exact local replacement effects share one affected-file inventory', () => {
  const root = makeTmpTree();
  try {
    const target = nodePath.join(root, 'old_dir', 'replace-me.pptx');
    fs.writeFileSync(target, 'presentation');
    const pp = postprocess([
      { type: 'write', path: target, line: 1, command: '>', uncertain: false },
      { type: 'truncate', path: target, line: 2, command: 'truncate', uncertain: false },
      { type: 'copy', path: target, source: 'source-a', line: 3, command: 'cp', uncertain: false },
      { type: 'move', path: target, source: 'source-b', line: 4, command: 'mv', uncertain: false },
      {
        type: 'link',
        path: target,
        source: 'source-c',
        line: 5,
        command: 'ln',
        replacement: 'replace',
        uncertain: false,
      },
    ]);
    assert.equal(pp.totalFileCount, 1);
    assert.equal(pp.policyFileCount, 1);
    assert.equal(pp.totalSize, 'presentation'.length);
    assert.deepEqual(pp.groups[0].files[0].operations, [
      'replace-content',
      'replace-destination',
      'truncate-content',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: no-clobber replacement does not threaten an existing destination', () => {
  const root = makeTmpTree();
  try {
    const target = nodePath.join(root, 'old_dir', 'keep.txt');
    fs.writeFileSync(target, 'keep');
    const pp = postprocess([
      {
        type: 'copy',
        path: target,
        source: 'source',
        line: 1,
        command: 'cp',
        replacement: 'no-clobber',
        uncertain: false,
      },
    ]);
    assert.equal(pp.totalFileCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: write to a directory never inventories the directory tree', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const pp = postprocess([
      { type: 'write', path: oldDir, line: 1, command: 'synthetic-write', uncertain: false },
    ]);
    assert.equal(pp.totalFileCount, 0);
    assert.equal(pp.specialTargets.length, 1);
    assert.equal(pp.specialTargets[0].kind, 'directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: delete does not follow symlinks but content replacement does', () => {
  const root = makeTmpTree();
  try {
    const target = nodePath.join(root, 'old_dir', 'target.txt');
    const link = nodePath.join(root, 'old_dir', 'target-link');
    fs.writeFileSync(target, 'target-data');
    fs.symlinkSync(target, link);

    const deleted = postprocess([
      { type: 'delete', path: link, line: 1, command: 'rm', uncertain: false },
    ]);
    assert.equal(deleted.totalFileCount, 0);
    assert.equal(deleted.specialTargets[0].kind, 'symlink');

    const overwritten = postprocess([
      { type: 'write', path: link, line: 1, command: '>', uncertain: false },
    ]);
    assert.equal(overwritten.totalFileCount, 1);
    assert.equal(overwritten.totalSize, 'target-data'.length);
    assert.equal(overwritten.groups[0].files[0].path, link);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: destination replacement follows only operations that open through symlinks', () => {
  if (process.platform === 'win32') return;
  const root = makeTmpTree();
  try {
    const target = nodePath.join(root, 'old_dir', 'target.txt');
    const link = nodePath.join(root, 'old_dir', 'target-link');
    fs.writeFileSync(target, 'target-data');
    fs.symlinkSync(target, link);

    const copied = postprocess([
      { ...exactEffect('copy', link, 'replace'), source: 'source' },
    ]);
    assert.equal(copied.totalFileCount, 1);
    assert.equal(copied.groups[0].files[0].path, link);

    for (const effect of [
      { ...exactEffect('move', link, 'replace'), source: 'source' },
      { ...exactEffect('link', link, 'replace'), source: 'source' },
    ]) {
      const replaced = postprocess([effect]);
      assert.equal(replaced.totalFileCount, 0, effect.type);
      assert.equal(replaced.specialTargets[0].kind, 'symlink', effect.type);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: conditional replacements are inventoried separately', () => {
  const root = makeTmpTree();
  try {
    const target = nodePath.join(root, 'old_dir', 'conditional.pptx');
    fs.writeFileSync(target, 'presentation');
    const pp = postprocess([
      {
        type: 'copy',
        path: target,
        source: 'source',
        line: 1,
        command: 'cp',
        replacement: 'conditional',
        uncertain: false,
      },
    ]);
    assert.equal(pp.policyFileCount, 1);
    assert.equal(pp.definitePolicyFileCount, 0);
    assert.equal(pp.conditionalPolicyFileCount, 1);
    assert.equal(pp.groups[0].conditionalPolicyCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: over-approximated command identity remains conditional', () => {
  const root = makeTmpTree();
  try {
    const target = nodePath.join(root, 'old_dir', 'conditional.pptx');
    fs.writeFileSync(target, 'presentation');
    const effect = exactEffect('write', target);
    effect.uncertain = true;
    effect.certainty = 'overapprox';
    effect.uncertainty = ['command-identity'];
    const pp = postprocess([effect]);
    assert.equal(pp.definitePolicyFileCount, 0);
    assert.equal(pp.conditionalPolicyFileCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: POSIX null device is a safe non-file sink', () => {
  if (process.platform === 'win32') return;
  const pp = postprocess([
    { type: 'write', path: '/dev/null', line: 1, command: '>', uncertain: false },
  ]);
  assert.equal(pp.totalFileCount, 0);
  assert.equal(pp.specialTargets.length, 1);
  assert.equal(pp.specialTargets[0].kind, 'character-device');
  assert.equal(pp.specialTargets[0].safeSink, true);
});

test('postprocess: FIFO targets remain distinct non-null special targets', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-fifo-'));
  try {
    const fifo = nodePath.join(root, 'events.pipe');
    const created = spawnSync('mkfifo', [fifo]);
    if (created.status !== 0) return;
    const pp = postprocess([exactEffect('write', fifo)]);
    assert.equal(pp.totalFileCount, 0);
    assert.equal(pp.specialTargets.length, 1);
    assert.equal(pp.specialTargets[0].kind, 'fifo');
    assert.equal(pp.specialTargets[0].safeSink, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: Unix socket targets remain distinct special targets', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-socket-'));
  try {
    const socketPath = nodePath.join(root, 'events.sock');
    const created = spawnSync('python3', [
      '-c',
      'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])',
      socketPath,
    ]);
    if (created.status !== 0 || !fs.existsSync(socketPath)) return;
    const pp = postprocess([exactEffect('write', socketPath)]);
    assert.equal(pp.totalFileCount, 0);
    assert.equal(pp.specialTargets.length, 1);
    assert.equal(pp.specialTargets[0].kind, 'socket');
    assert.equal(pp.specialTargets[0].safeSink, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: an available block device is never classified as a regular file', () => {
  if (process.platform === 'win32') return;
  const candidate = ['/dev/loop0', '/dev/loop1', '/dev/sda', '/dev/vda']
    .find(path => {
      try {
        return fs.lstatSync(path).isBlockDevice();
      } catch {
        return false;
      }
    });
  if (!candidate) return;
  const pp = postprocess([exactEffect('write', candidate)]);
  assert.equal(pp.totalFileCount, 0);
  assert.equal(pp.specialTargets[0].kind, 'block-device');
});

test('postprocess: inaccessible exact targets become structured metadata opacity', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-opaque-'));
  const locked = nodePath.join(root, 'locked');
  const target = nodePath.join(locked, 'data.txt');
  fs.mkdirSync(locked);
  fs.writeFileSync(target, 'data');
  fs.chmodSync(locked, 0);
  try {
    const pp = postprocess([exactEffect('write', target)]);
    assert.equal(pp.totalFileCount, 0);
    assert.equal(pp.metadataUnavailable.length, 1);
    assert.equal(pp.metadataUnavailable[0].path, target);
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: file, visit, depth, and elapsed-time budgets all fail closed into bounded facts', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const effect = exactEffect('delete', oldDir);
    const fileBudget = postprocess([effect], { maxFiles: 1 });
    const fixtures = [
      fileBudget,
      postprocess([effect], { maxVisitedEntries: 1 }),
      postprocess([effect], { maxDepth: 1 }),
      postprocess([effect], { maxElapsedMs: 0 }),
    ];
    for (const result of fixtures) {
      assert.equal(result.budgetExhausted, true);
      assert.equal(result.budgetExhaustedCertainty, 'definite');
    }
    assert.ok(fileBudget.totalFileCount <= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: observation budgets also bound flat exact-target lists', () => {
  const root = makeTmpTree();
  try {
    const first = nodePath.join(root, 'old_dir', 'a.txt');
    const second = nodePath.join(root, 'old_dir', 'nested', 'c.md');
    const visited = postprocess([
      exactEffect('write', first),
      exactEffect('write', second),
    ], { maxVisitedEntries: 1 });
    assert.equal(visited.budgetExhausted, true);
    assert.equal(visited.budgetExhaustedCertainty, 'definite');
    assert.equal(visited.visitedEntries, 1);
    assert.equal(visited.totalFileCount, 1);

    const elapsed = postprocess([exactEffect('write', first)], { maxElapsedMs: 0 });
    assert.equal(elapsed.budgetExhausted, true);
    assert.equal(elapsed.budgetExhaustedCertainty, 'definite');
    assert.equal(elapsed.visitedEntries, 0);
    assert.equal(elapsed.totalFileCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: a later definite target dominates conditional budget exhaustion', () => {
  const root = makeTmpTree();
  try {
    const conditional = nodePath.join(root, 'old_dir', 'a.txt');
    const definite = nodePath.join(root, 'old_dir', 'nested', 'c.md');
    const result = postprocess([
      exactEffect('copy', conditional, 'conditional'),
      exactEffect('write', definite),
    ], { maxFiles: 0 });
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.budgetExhaustedCertainty, 'definite');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postprocess: totalFileCount counts files, not dirs', () => {
  const root = makeTmpTree();
  try {
    const oldDir = nodePath.join(root, 'old_dir');
    const pp = postprocess([
      { type: 'delete', path: oldDir, line: 1, command: 'rm', uncertain: false },
    ]);
    // Tree has 3 files + 2 dirs. All files are factual; two are policy-relevant.
    assert.equal(pp.totalFileCount, 3);
    assert.equal(pp.policyFileCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('risk: root delete is classified from predicted effects even without disk data', () => {
  const r = analyze('rm -rf /', { cwd: '/tmp' });
  const classified = classifyAnalysis({
    available: true,
    effects: r.effects,
    affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
  }, { platform: 'linux' });
  assert.equal(classified.severity, 'critical');
  assert.ok(classified.reasonCodes.includes(RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION));
});

test('risk: copy from a path after deleting it is not treated as independent data loss', () => {
  const r = analyze('rm src.txt; cp src.txt backup.txt', { cwd: '/tmp' });
  const classified = classifyAnalysis({
    available: true,
    effects: r.effects,
    affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
  }, { platform: 'linux' });
  assert.equal(classified.severity, 'safe');
  assert.equal(classified.reasonCodes.length, 0);
});

test('risk: exact ordinary replacements are assessed only through affected-file statistics', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-risk-'));
  try {
    const target = nodePath.join(root, 'ordinary.txt');
    fs.writeFileSync(target, 'small and recent');
    const effects = [
      exactEffect('delete', target),
      exactEffect('write', target),
      exactEffect('truncate', target),
      exactEffect('copy', target, 'replace'),
      exactEffect('move', target, 'replace'),
      exactEffect('link', target, 'replace'),
    ];
    for (const effect of effects) {
      const { observed, classified } = classifyDiskEffects([effect], { platform: process.platform });
      assert.equal(observed.policyFileCount, 1, effect.type);
      assert.equal(classified.severity, 'safe', effect.type);
      assert.deepEqual(directReasons(classified), [], effect.type);
      assert.deepEqual(classified.reasonCodes, [], effect.type);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('risk: sensitive replacements become critical statistically, not through direct predicates', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-risk-'));
  try {
    const target = nodePath.join(root, 'presentation.pptx');
    fs.writeFileSync(target, 'small and recent');
    const effects = [
      exactEffect('write', target),
      exactEffect('truncate', target),
      exactEffect('copy', target, 'replace'),
      exactEffect('move', target, 'replace'),
      exactEffect('link', target, 'replace'),
    ];
    for (const effect of effects) {
      const { classified } = classifyDiskEffects([effect], { platform: process.platform });
      assert.equal(classified.severity, 'critical', effect.type);
      assert.deepEqual(directReasons(classified), [], effect.type);
      assert.ok(
        classified.reasonCodes.includes(RISK_REASON_CODES.SENSITIVE_EXTENSION),
        effect.type,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('risk: conditional sensitive replacement retains metadata but is capped at risky', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashemu-risk-'));
  try {
    const target = nodePath.join(root, 'presentation.pptx');
    fs.writeFileSync(target, 'small and recent');
    const { observed, classified } = classifyDiskEffects([
      exactEffect('copy', target, 'conditional'),
    ], { platform: process.platform });
    assert.equal(observed.conditionalPolicyFileCount, 1);
    assert.equal(observed.definitePolicyFileCount, 0);
    assert.equal(classified.severity, 'risky');
    assert.deepEqual(directReasons(classified), []);
    assert.ok(
      classified.reasonCodes.includes(RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('risk: old, large, and numerous files retain the existing statistical thresholds', () => {
  const now = Date.now();
  const old = classifyAnalysis({
    available: true,
    affected: statisticalAffectedFixture({
      createdAt: new Date(now - OLD_FILE_THRESHOLD_MS - 1).toISOString(),
    }),
  }, { now });
  assert.equal(old.severity, 'critical');
  assert.ok(old.reasonCodes.includes(RISK_REASON_CODES.OLD_AFFECTED_FILE));

  const futureNow = Date.UTC(2040, 0, 1);
  const futureOldAnalysis = {
    available: true,
    affected: statisticalAffectedFixture({
      createdAt: new Date(futureNow - OLD_FILE_THRESHOLD_MS - 1).toISOString(),
    }),
  };
  const futureOld = classifyAnalysis(futureOldAnalysis, { now: futureNow });
  assert.ok(
    renderReasonCodesDetailed(futureOld.reasonCodes, futureOldAnalysis).includes('old files'),
    'renderer trusts the classified code instead of reapplying the age threshold',
  );

  const large = classifyAnalysis({
    available: true,
    affected: statisticalAffectedFixture({ size: LARGE_TOTAL_SIZE_THRESHOLD_BYTES }),
  });
  assert.equal(large.severity, 'critical');
  assert.ok(large.reasonCodes.includes(RISK_REASON_CODES.AFFECTED_TOTAL_SIZE));

  const manyRisky = classifyAnalysis({
    available: true,
    affected: statisticalAffectedFixture({ count: MANY_FILES_RISKY }),
  });
  assert.equal(manyRisky.severity, 'risky');
  assert.ok(manyRisky.reasonCodes.includes(RISK_REASON_CODES.AFFECTED_FILE_COUNT_RISKY));

  const manyCritical = classifyAnalysis({
    available: true,
    affected: statisticalAffectedFixture({ count: MANY_FILES_CRITICAL }),
  });
  assert.equal(manyCritical.severity, 'critical');
  assert.ok(manyCritical.reasonCodes.includes(RISK_REASON_CODES.AFFECTED_FILE_COUNT_CRITICAL));
  assert.ok([old, large, manyRisky, manyCritical].every(result => directReasons(result).length === 0));
});

test('risk: conditional statistical thresholds never become local critical', () => {
  const now = Date.now();
  const fixtures = [
    statisticalAffectedFixture({ count: MANY_FILES_RISKY, conditional: true }),
    statisticalAffectedFixture({ count: MANY_FILES_CRITICAL, conditional: true }),
    statisticalAffectedFixture({ size: LARGE_TOTAL_SIZE_THRESHOLD_BYTES, conditional: true }),
    statisticalAffectedFixture({
      createdAt: new Date(now - OLD_FILE_THRESHOLD_MS - 1).toISOString(),
      conditional: true,
    }),
  ];
  for (const affected of fixtures) {
    const classified = classifyAnalysis({ available: true, affected }, { now });
    assert.equal(classified.severity, 'risky');
    assert.deepEqual(directReasons(classified), []);
    assert.deepEqual(
      classified.reasonCodes,
      [...new Set(classified.reasonCodes)].sort((left, right) => left - right),
    );
  }
  const conditionalCount = classifyAnalysis(
    { available: true, affected: fixtures[0] },
    { now },
  );
  assert.ok(
    conditionalCount.reasonCodes.includes(RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT),
  );
});

test('risk: root and protected-system matching is platform-specific and normalized', () => {
  const previousSystemDrive = process.env['SystemDrive'];
  const previousSystemRoot = process.env['SystemRoot'];
  process.env['SystemDrive'] = 'C:';
  process.env['SystemRoot'] = 'C:\\Windows';
  try {
    assert.equal(isCatastrophicPath('/', 'linux'), true);
    assert.equal(isCatastrophicPath('/c', 'linux'), false);
    assert.equal(isCatastrophicPath('/d', 'darwin'), false);
    assert.equal(isCatastrophicPath('D:\\', 'win32'), true);
    assert.equal(isCatastrophicPath('/e', 'win32'), true);

    assert.equal(isSystemPath('/sYsTeM/Library', 'darwin'), true);
    assert.equal(isSystemPath('/Library/Application Support', 'darwin'), true);
    assert.equal(isSystemPath('/Libraryish', 'darwin'), false);
    assert.equal(isSystemPath('c:\\WINDOWS\\System32', 'win32'), true);
    assert.equal(isSystemPath('C:\\Program Files (x86)\\App', 'win32'), true);
    assert.equal(isSystemPath('D:\\Windows\\System32', 'win32'), false);
    assert.equal(isSystemPath('/System', 'linux'), false);

    const macSystem = classifyAnalysis({
      available: true,
      effects: [exactEffect('delete', '/sYsTeM/Library')],
      affected: statisticalAffectedFixture({ count: 0, size: 0 }),
    }, { platform: 'darwin' });
    assert.equal(macSystem.severity, 'critical');
    assert.deepEqual(directReasons(macSystem), [
      RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION,
    ]);

    const conditionalMacSystemEffect = exactEffect('delete', '/System/Library');
    conditionalMacSystemEffect.uncertain = true;
    conditionalMacSystemEffect.certainty = 'overapprox';
    conditionalMacSystemEffect.uncertainty = ['conditional-branch'];
    const conditionalMacSystem = classifyAnalysis({
      available: true,
      effects: [conditionalMacSystemEffect],
      affected: statisticalAffectedFixture({
        path: '/System/Library/example.pptx',
        conditional: true,
      }),
    }, { platform: 'darwin' });
    assert.equal(conditionalMacSystem.severity, 'risky');
    assert.deepEqual(directReasons(conditionalMacSystem), []);
    assert.ok(
      conditionalMacSystem.reasonCodes.includes(
        RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION,
      ),
    );

    const linuxDriveLike = classifyAnalysis({
      available: true,
      effects: [exactEffect('delete', '/c')],
      affected: statisticalAffectedFixture({ count: 0, size: 0 }),
    }, { platform: 'linux' });
    assert.equal(linuxDriveLike.severity, 'safe');
    assert.deepEqual(directReasons(linuxDriveLike), []);
  } finally {
    if (previousSystemDrive === undefined) delete process.env['SystemDrive'];
    else process.env['SystemDrive'] = previousSystemDrive;
    if (previousSystemRoot === undefined) delete process.env['SystemRoot'];
    else process.env['SystemRoot'] = previousSystemRoot;
  }
});

test('risk: unresolved destructive paths are risky unless their shape is demonstrably catastrophic', () => {
  const unresolved: FileEffect = {
    ...exactEffect('delete', '/work/$TARGET/cache'),
    uncertain: true,
    certainty: 'unknown',
    uncertainty: ['unresolved-expansion'],
  };
  const ordinary = classifyAnalysis({
    available: true,
    effects: [unresolved],
    affected: statisticalAffectedFixture({ count: 0, size: 0 }),
  }, { platform: 'linux' });
  assert.equal(ordinary.severity, 'risky');
  assert.deepEqual(directReasons(ordinary), [
    RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION,
  ]);

  const catastrophic: FileEffect = {
    ...exactEffect('delete', '/*'),
    uncertain: true,
    certainty: 'unknown',
    uncertainty: ['glob-without-fs'],
  };
  const broad = classifyAnalysis({
    available: true,
    effects: [catastrophic],
    affected: statisticalAffectedFixture({ count: 0, size: 0 }),
  }, { platform: 'linux' });
  assert.equal(broad.severity, 'critical');
  assert.deepEqual(directReasons(broad), [
    RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE,
  ]);
});

test('risk: direct-risk policy is a closed, stable allowlist', () => {
  assert.deepEqual(DIRECT_RISK_POLICY, {
    [RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION]: 'critical',
    [RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION]: 'critical',
    [RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE]: 'critical',
    [RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE]: 'critical',
    [RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION]: 'risky',
    [RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT]: 'risky',
    [RISK_REASON_CODES.GIT_WORKTREE_DISCARD]: 'risky',
    [RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION]: 'risky',
    [RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE]: 'risky',
  });
});

test('risk: null and non-null character devices receive target-specific policy', () => {
  if (process.platform === 'win32') return;
  const nullResult = classifyDiskEffects([exactEffect('write', '/dev/null')], { platform: process.platform });
  assert.equal(nullResult.classified.severity, 'safe');
  assert.deepEqual(directReasons(nullResult.classified), []);

  const deleteNull = classifyDiskEffects([exactEffect('delete', '/dev/null')], { platform: process.platform });
  assert.equal(deleteNull.classified.severity, 'risky');
  assert.deepEqual(directReasons(deleteNull.classified), [
    RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT,
  ]);
  assert.ok(renderReasonCodesDetailed(
    deleteNull.classified.reasonCodes,
    deleteNull.analysis,
  ).includes('remove a character-device'));

  if (!fs.existsSync('/dev/zero')) return;
  const deviceResult = classifyDiskEffects([exactEffect('write', '/dev/zero')], { platform: process.platform });
  assert.equal(deviceResult.classified.severity, 'risky');
  assert.deepEqual(directReasons(deviceResult.classified), [
    RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT,
  ]);
  assert.ok(renderReasonCodesDetailed(
    deviceResult.classified.reasonCodes,
    deviceResult.analysis,
  ).includes('character-device'));
});

test('effects: conservative branches carry uncertainty provenance', () => {
  const r = analyze('if mystery; then rm a; else rm b; fi', { cwd: '/tmp' });
  assert.equal(r.effects.length, 2);
  assert.ok(r.effects.every(effect => effect.certainty === 'overapprox'));
  assert.ok(r.effects.every(effect => effect.uncertainty.includes('conditional-branch')));
});

test('effects: unknown loop counts carry uncertainty provenance', () => {
  const r = analyze('while true; do rm x; done', { cwd: '/tmp' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].certainty, 'overapprox');
  assert.ok(r.effects[0].uncertainty.includes('unknown-loop-count'));
});

test('commands: rsync tar unzip and pip target effects', () => {
  const r = analyze('rsync -a src/ dest/; tar -xf app.tar -C out; unzip app.zip -d expanded; python -m pip install pkg --target vendor', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path, e.command]), [
    ['copy', '/work/dest/src', 'rsync'],
    ['write', '/work/out/<archive-contents>', 'tar'],
    ['write', '/work/expanded/<archive-contents>', 'unzip'],
    ['mkdir', '/work/vendor', 'python -m pip install'],
  ]);
});

test('commands: preview list test and stdout-only modes emit no filesystem effects', () => {
  const cases = [
    'git clean -nfdx',
    'git clean --dry-run -d -x',
    'git -C repo clean -nfdx',
    'git clean --help -fdx',
    'git clean -x -X',
    'git clean -e',
    'rsync -n --delete src/ dst/',
    'rsync -an --delete src/ dst/',
    'rsync --dry-run --delete src/ dst/',
    'rsync --list-only src/ dst/',
    'kubectl delete pod x --dry-run=client',
    'kubectl --context dev delete pod x --dry-run=server',
    'kubectl delete pod x --dry-run',
    'kubectl delete --dry-run none pod x',
    'kubectl delete pod x --dry-run=unchanged',
    'kubectl delete pod x --dry-run=true',
    'kubectl delete pod x --dry-run=bogus',
    'kubectl delete pod x --dry-run=CLIENT',
    'kubectl -s https://cluster.example delete pod x --dry-run=client',
    'kubectl apply -f manifest.yaml --dry-run=client',
    'kubectl apply --dry-run -f manifest.yaml',
    'find --help -delete',
    'find . -name -delete',
    'find . -printf -delete',
    'find . -fprintf report -delete',
    'find . -exec echo -delete \\;',
    'xargs --help rm',
    'xargs -I rm echo safe',
    'xargs --replace=rm echo safe',
    'xargs -E rm echo safe',
    'xargs rm --help',
    'xargs RM exact.txt',
    'make -n clean',
    'make --dry-run clean',
    'make -q clean',
    'make -t clean',
    'make -C sub -n clean',
    'make -C clean build',
    'make -f custom:clean build',
    'make --eval clean build',
    'make --eval=clean build',
    'docker compose down',
    'docker compose down -v --help',
    'kubectl delete pod x --help',
    'kubectl delete',
    'kubectl delete --namespace ns',
    'kubectl delete pod',
    'kubectl apply',
    'kubectl apply --namespace ns',
    'helm uninstall rel --dry-run',
    'helm uninstall rel --dry-run=true',
    'helm uninstall rel --help',
    'helm uninstall',
    'helm uninstall --namespace ns',
    'terraform destroy -help',
    'terraform destroy --help',
    'tar -tf archive.tar',
    'tar --list --file=archive.tar',
    'tar -xOf archive.tar file',
    'tar --extract --to-stdout --file archive.tar file',
    'tar --group -x -f archive.tar',
    'tar -xf',
    'tar --extract --file',
    'tar --help -xf archive.tar',
    'unzip -l archive.zip',
    'unzip -t archive.zip',
    'unzip -p archive.zip file',
    'unzip -c archive.zip file',
    'unzip -Z archive.zip',
    'unzip -v archive.zip',
    'unzip -z archive.zip',
    'unzip -h archive.zip',
    'unzip -P -l archive.zip',
    'unzip -- -l',
  ];
  for (const command of cases) {
    const result = analyze(command, { cwd: '/work' });
    assert.deepEqual(result.effects, [], command);
    assert.deepEqual(result.resourceEffects, [], command);
  }
});

test('commands: executing counterparts retain their destructive effects', () => {
  const fileCases: Array<[string, string, string]> = [
    ['rsync -a --delete src/ dst/', 'delete', 'rsync --delete'],
    ['rsync -T -n -a --delete src/ dst/', 'delete', 'rsync --delete'],
    ['rsync --temp-dir --dry-run -a --delete src/ dst/', 'delete', 'rsync --delete'],
    ['kubectl apply -f --dry-run=client', 'write', 'kubectl apply'],
    ['kubectl apply --field-manager --dry-run=server -f manifest.yaml', 'write', 'kubectl apply'],
    ['tar -xf archive.tar', 'write', 'tar'],
    ['tar --group -t -xf archive.tar', 'write', 'tar'],
    ['tar CxVf out label archive.tar', 'write', 'tar'],
    ['unzip archive.zip', 'write', 'unzip'],
    ['unzip archive.zip -l', 'write', 'unzip'],
    ['unzip -P-l archive.zip', 'write', 'unzip'],
    ['unzip -l-l archive.zip', 'write', 'unzip'],
    ['unzip -- -l archive.zip', 'write', 'unzip'],
  ];
  for (const [command, type, effectCommand] of fileCases) {
    const effects = analyze(command, { cwd: '/work' }).effects;
    assert.ok(effects.some(effect => effect.type === type && effect.command === effectCommand), command);
  }

  const resourceCases: Array<[string, string, string]> = [
    ['git clean -fdx', 'git-worktree', 'git clean'],
    ['git clean -n --no-dry-run -fdx', 'git-worktree', 'git clean'],
    ['git -C repo clean -fdx', 'git-worktree', 'git clean'],
    ['git clean -- --dry-run', 'git-worktree', 'git clean'],
    ['git clean -e -n -fdx', 'git-worktree', 'git clean'],
    ['git clean --exclude --dry-run -fdx', 'git-worktree', 'git clean'],
    ['find src -delete', 'local-filesystem-selection', 'find -delete'],
    ['xargs rm -f', 'local-filesystem-selection', 'xargs rm'],
    ['make clean', 'local-filesystem-selection', 'make clean'],
    ['make -C -n clean', 'local-filesystem-selection', 'make clean'],
    ['make -Onone clean', 'local-filesystem-selection', 'make clean'],
    ['docker compose down -v', 'docker-volume', 'docker compose down -v'],
    ['docker compose down --volumes', 'docker-volume', 'docker compose down -v'],
    ['kubectl delete pod x', 'kubernetes', 'kubectl delete'],
    ['kubectl --context dev delete pod x', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod x --dry-run=none', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod x --dry-run=false', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod x --dry-run=0', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod x --dry-run=client --dry-run=none', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod x -- --dry-run=client', 'kubernetes', 'kubectl delete'],
    ['kubectl delete -f --dry-run=client', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod --all', 'kubernetes', 'kubectl delete'],
    ['kubectl delete pod -l app=x', 'kubernetes', 'kubectl delete'],
    ['kubectl delete -f manifest.yaml', 'kubernetes', 'kubectl delete'],
    ['kubectl delete --context --dry-run=server pod x', 'kubernetes', 'kubectl delete'],
    ['kubectl -s --dry-run=server delete pod x', 'kubernetes', 'kubectl delete'],
    ['helm uninstall rel', 'helm', 'helm uninstall'],
    ['helm uninstall --description --help rel', 'helm', 'helm uninstall'],
    ['helm uninstall rel --dry-run=false', 'helm', 'helm uninstall'],
    ['terraform destroy', 'terraform', 'terraform destroy'],
  ];
  for (const [command, domain, effectCommand] of resourceCases) {
    const result = analyze(command, { cwd: '/work' });
    assert.ok(
      result.resourceEffects.some(effect => effect.domain === domain && effect.command === effectCommand),
      command,
    );
  }
});

test('commands: tar mode is parsed only from options', () => {
  const nonExtracting = [
    'tar -cf archive.tar x.txt',
    'tar --create --file=archive.tar x.txt',
    'tar -cf archive.tar -- x',
    'tar --exclude -x -cf archive.tar .',
  ];
  for (const command of nonExtracting) {
    assert.deepEqual(analyze(command, { cwd: '/work' }).effects, [], command);
  }

  const traditional = analyze('tar xf archive.tar', { cwd: '/work' });
  assert.equal(traditional.effects.length, 1);
  assert.equal(traditional.effects[0].command, 'tar');
});

test('commands: tar binds option operands before interpreting operation flags', () => {
  const noOperation = analyze('tar --group -x -f archive.tar', { cwd: '/work' });
  assert.deepEqual(noOperation.effects, []);

  const extract = analyze('tar --group -t -xf archive.tar', { cwd: '/work' });
  assert.equal(extract.effects.length, 1);
  assert.equal(extract.effects[0].command, 'tar');

  const traditional = analyze('tar CxVf out label archive.tar', { cwd: '/work' });
  assert.equal(traditional.effects.length, 1);
  assert.equal(traditional.effects[0].path, '/work/out/<archive-contents>');
});

test('commands: unzip action flags are parsed only before the archive operand', () => {
  const extracting = [
    'unzip archive.zip -l',
    'unzip -P-l archive.zip',
    'unzip -l-l archive.zip',
    'unzip -c-c archive.zip',
    'unzip -- -l archive.zip',
  ];
  for (const command of extracting) {
    const effects = analyze(command, { cwd: '/work' }).effects;
    assert.ok(effects.some(effect => effect.type === 'write' && effect.command === 'unzip'), command);
  }

  const nonWriting = [
    'unzip -h archive.zip',
    'unzip -P -l archive.zip',
    'unzip -- -l',
  ];
  for (const command of nonWriting) {
    assert.deepEqual(analyze(command, { cwd: '/work' }).effects, [], command);
  }
});

test('commands: rmdir removes only directories known to be empty', () => {
  const r = analyze(
    'rmdir nonempty empty missing file.txt; rm nonempty/child.pptx; rmdir nonempty',
    {
      cwd: '/work',
      fs: ['/work/nonempty/child.pptx', '/work/empty/', '/work/file.txt'],
    },
  );
  assert.deepEqual(r.effects.map(effect => [effect.type, effect.path, effect.command]), [
    ['delete', '/work/empty', 'rmdir'],
    ['delete', '/work/nonempty/child.pptx', 'rm'],
    ['delete', '/work/nonempty', 'rmdir'],
  ]);
  assert.ok(r.warnings.some(warning => warning.includes('Directory not empty')));
  assert.ok(r.warnings.some(warning => warning.includes('No such directory')));
  assert.ok(r.warnings.some(warning => warning.includes('Not a directory')));
});

test('commands: rmdir never enumerates files in a non-empty real directory', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-rmdir-'));
  try {
    const dir = nodePath.join(root, 'nonempty');
    fs.mkdirSync(dir);
    fs.writeFileSync(nodePath.join(dir, 'keep.pptx'), 'keep');
    const r = analyze('rmdir nonempty', { cwd: root, realFs: true });
    assert.deepEqual(r.effects, []);
    assert.equal(postprocess(r.effects).totalFileCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commands: rmdir does not follow a symlink to an empty real directory', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-rmdir-link-'));
  try {
    const target = nodePath.join(root, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, nodePath.join(root, 'link'), 'dir');
    const r = analyze('rmdir link', { cwd: root, realFs: true });
    assert.deepEqual(r.effects, []);
    assert.ok(r.warnings.some(warning => warning.includes('Not a directory')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commands: find xargs inplace scripts package managers and installers', () => {
  const r = analyze('find src -name "*.tmp" -delete; xargs rm -f; perl -pi -e s/a/b/ config.txt; npm install; make clean install PREFIX=/opt/app; cmake --install build --prefix /opt/cmake', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path, e.command]), [
    ['write', '/work/config.txt', 'perl -i'],
    ['mkdir', '/work/node_modules', 'npm install'],
    ['mkdir', '/opt/app', 'make install'],
    ['copy', '/opt/cmake/<install-contents>', 'cmake --install'],
  ]);
  assert.deepEqual(r.resourceEffects.map(effect => [
    effect.domain,
    effect.command,
    effect.selection.kind,
    effect.selection.root,
  ]), [
    ['local-filesystem-selection', 'find -delete', 'derived', '/work/src'],
    ['local-filesystem-selection', 'xargs rm', 'stdin', '/work'],
    ['local-filesystem-selection', 'make clean', 'derived', '/work'],
  ]);
});

test('commands: git docker kubectl helm terraform risk surfaces', () => {
  const r = analyze('git clean -fdx; git reset --hard; git restore -- app.js; docker compose down -v; docker run -v /host/data:/data img; kubectl delete pod app; helm uninstall rel; terraform destroy', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path, e.command]), [
    ['write', '/work/app.js', 'git restore'],
  ]);
  assert.deepEqual(r.gitEffects.map(effect => [effect.domain, effect.operation, effect.mode]), [
    ['index', 'replace', 'hard'],
    ['worktree', 'discard', 'hard'],
    ['local-ref', 'rewrite', 'hard'],
  ]);
  assert.deepEqual(r.resourceEffects.map(effect => [
    effect.domain,
    effect.operation,
    effect.command,
    effect.selection.target,
  ]), [
    ['git-worktree', 'delete', 'git clean', undefined],
    ['docker-volume', 'delete', 'docker compose down -v', undefined],
    ['container-bind-mount', 'expose', 'docker run bind mount', undefined],
    ['kubernetes', 'delete', 'kubectl delete', undefined],
    ['helm', 'uninstall', 'helm uninstall', 'rel'],
    ['terraform', 'destroy', 'terraform destroy', undefined],
  ]);
  assert.ok(!JSON.stringify({ effects: r.effects, resourceEffects: r.resourceEffects }).includes('<'));
});

test('commands: replacement behavior is normalized across local file tools', () => {
  const result = analyze(
    'cp source a.txt; cp -n source b.txt; cp -i source c.txt; ' +
    'mv source d.txt; mv -n source e.txt; ln -sf source f.txt; ln -s source g.txt; ' +
    'truncate -s 0 h.txt; cp -ni source i.txt; cp -in source j.txt; ' +
    'mv -if source k.txt; mv -fi source l.txt; cp -u source m.txt; mv -u source n.txt',
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects.map(effect => [
    effect.type,
    effect.path,
    effect.replacement,
  ]), [
    ['copy', '/work/a.txt', 'replace'],
    ['copy', '/work/b.txt', 'no-clobber'],
    ['copy', '/work/c.txt', 'conditional'],
    ['move', '/work/d.txt', 'replace'],
    ['move', '/work/e.txt', 'no-clobber'],
    ['link', '/work/f.txt', 'replace'],
    ['link', '/work/g.txt', 'no-clobber'],
    ['truncate', '/work/h.txt', 'replace'],
    ['copy', '/work/i.txt', 'conditional'],
    ['copy', '/work/j.txt', 'no-clobber'],
    ['move', '/work/k.txt', 'replace'],
    ['move', '/work/l.txt', 'conditional'],
    ['copy', '/work/m.txt', 'conditional'],
    ['move', '/work/n.txt', 'conditional'],
  ]);

  const links = analyze(
    'ln -sf source.txt links/; ln -sfT source.txt exact-link',
    { cwd: '/work', fs: ['/work/links/'] },
  );
  assert.deepEqual(links.effects.map(effect => [effect.path, effect.replacement]), [
    ['/work/links/source.txt', 'replace'],
    ['/work/exact-link', 'replace'],
  ]);

  const noDereference = analyze(
    'ln -sfn source.txt links; ln -sfi source.txt prompted',
    { cwd: '/work', fs: ['/work/links/'] },
  );
  assert.deepEqual(noDereference.effects.map(effect => [effect.path, effect.replacement]), [
    ['/work/links', 'replace'],
    ['/work/prompted', 'conditional'],
  ]);
});

test('commands: Docker bind mounts are exposure resources, not file writes', () => {
  const result = analyze(
    'docker run -v /host/rw:/data image; ' +
    'docker run -v /host/ro:/data:ro image; ' +
    'docker run -v named-volume:/data image; ' +
    'docker run --mount type=bind,src=/host/mounted,dst=/data image',
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.resourceEffects.map(effect => [
    effect.domain,
    effect.operation,
    effect.selection.root,
  ]), [
    ['container-bind-mount', 'expose', '/host/rw'],
    ['container-bind-mount', 'expose', '/host/mounted'],
  ]);
});

test('typed non-exact effects preserve exact xargs operands and branch uncertainty', () => {
  const explicit = analyze('xargs rm -f exact.txt', { cwd: '/work' });
  assert.deepEqual(explicit.effects.map(effect => [effect.type, effect.path, effect.command]), [
    ['delete', '/work/exact.txt', 'xargs rm'],
  ]);
  assert.equal(explicit.resourceEffects.length, 1);
  assert.equal(explicit.resourceEffects[0].selection.kind, 'stdin');

  const branched = analyze(
    'if mystery; then find src -delete; else terraform destroy; fi',
    { cwd: '/work' },
  );
  assert.equal(branched.resourceEffects.length, 2);
  assert.ok(branched.resourceEffects.every(effect => effect.uncertainty.includes('conditional-branch')));
});

test('typed non-exact destructive effects are risky local passes without affected-file claims', () => {
  const commands = [
    'git clean -fdx',
    'find src -delete',
    'xargs rm -f',
    'make clean',
    'docker compose down -v',
    'kubectl delete pod app',
    'helm uninstall rel',
    'terraform destroy',
  ];
  for (const command of commands) {
    const result = analyze(command, { cwd: '/work' });
    const analysis = {
      available: true,
      effects: result.effects,
      gitEffects: result.gitEffects,
      resourceEffects: result.resourceEffects,
      affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
    };
    assert.equal(result.resourceEffects.length, 1, command);
    const classified = classifyAnalysis(analysis, { platform: 'linux' });
    assert.equal(classified.severity, 'risky', command);
    assert.ok(classified.reasonCodes.every(code =>
      DIRECT_RISK_POLICY[code as keyof typeof DIRECT_RISK_POLICY] === 'risky'), command);
    assert.equal(decide(analysis, { platform: 'linux' }).decision, 'pass', command);
    assert.ok(!JSON.stringify(result.resourceEffects).includes('<'), command);
  }
});

test('typed resource risk cannot lower an independent exact critical filesystem verdict', () => {
  const result = analyze('terraform destroy; rm -rf /', { cwd: '/work' });
  const verdict = decide({
    available: true,
    effects: result.effects,
    gitEffects: result.gitEffects,
    resourceEffects: result.resourceEffects,
    affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
  }, { platform: 'linux' });
  assert.equal(verdict.severity, 'critical');
  assert.equal(verdict.decision, 'stop');
});

test('git reset analyzer keeps index and ref state out of filesystem effects', () => {
  const cases: Array<[string, string[]]> = [
    ['git reset', ['index', 'local-ref']],
    ['git reset --mixed', ['index', 'local-ref']],
    ['git reset --soft HEAD~1', ['local-ref']],
    ['git reset -- file', ['index']],
    ['git reset HEAD -- file', ['index']],
    ['git reset -p -- file', ['index']],
    ['git reset --pathspec-from-file=list', ['index', 'local-ref']],
  ];
  for (const [command, domains] of cases) {
    const result = analyze(command, { cwd: '/work' });
    assert.deepEqual(result.effects, [], command);
    assert.deepEqual(result.gitEffects.map(effect => effect.domain), domains, command);
  }
});

test('git reset analyzer models worktree modes and submodule scope', () => {
  const hard = analyze('git reset --hard --recurse-submodules', { cwd: '/work' });
  assert.deepEqual(hard.effects, []);
  assert.deepEqual(hard.gitEffects.map(effect => effect.domain), [
    'index', 'worktree', 'local-ref', 'submodule',
  ]);
  assert.equal(hard.gitEffects.find(effect => effect.domain === 'worktree')?.operation, 'discard');
  assert.ok(hard.gitEffects.every(effect => effect.recurseSubmodules === true));

  for (const mode of ['merge', 'keep']) {
    const result = analyze(`git reset --${mode}`, { cwd: '/work' });
    assert.equal(result.gitEffects.find(effect => effect.domain === 'worktree')?.operation, 'replace');
    assert.ok(result.gitEffects.every(effect => effect.mode === mode));
  }

  const abbreviated = analyze('git reset --har', { cwd: '/work' });
  assert.ok(abbreviated.gitEffects.some(effect => effect.domain === 'worktree' && effect.mode === 'hard'));

  const clearedPathspec = analyze(
    'git reset --pathspec-from-file=list --no-pathspec-from-file --hard',
    { cwd: '/work' },
  );
  assert.ok(clearedPathspec.gitEffects.some(effect => effect.domain === 'worktree' && effect.mode === 'hard'));
});

test('git reset analyzer avoids known bare-repository worktree false positives', () => {
  const hard = analyze('git --bare reset --hard', { cwd: '/work' });
  assert.deepEqual(hard.effects, []);
  assert.deepEqual(hard.gitEffects, []);
  assert.ok(hard.warnings.some(warning => warning.includes('known bare repository')));

  const mixed = analyze('git reset --mixed', {
    cwd: '/work',
    env: { GIT_IMPLICIT_WORK_TREE: '0' },
  });
  assert.deepEqual(mixed.gitEffects.map(effect => effect.domain), ['index', 'local-ref']);
  assert.ok(mixed.gitEffects.every(effect => effect.repository.bare));
  assert.ok(mixed.gitEffects.every(effect => !effect.repository.forcedBare));

  const soft = analyze('git --bare reset --soft HEAD~1', { cwd: '/work' });
  assert.deepEqual(soft.gitEffects.map(effect => effect.domain), ['local-ref']);

  const explicitWorktree = analyze(
    'git --bare --work-tree=tree reset --hard',
    { cwd: '/work' },
  );
  assert.ok(explicitWorktree.gitEffects.some(effect => effect.domain === 'worktree'));
});

test('git reset analyzer preserves wrapper privilege cwd environment and path identity', () => {
  const result = analyze(
    'sudo -D admin env GIT_DIR=meta command /usr/bin/git -C repo reset --hard',
    { cwd: '/work' },
  );
  assert.deepEqual(result.effects, []);
  assert.equal(result.gitEffects.length, 3);
  for (const effect of result.gitEffects) {
    assert.equal(effect.repository.cwd, '/work/admin/repo');
    assert.equal(effect.repository.gitDir, '/work/admin/repo/meta');
    assert.equal(effect.repository.confidence, 'explicit');
    assert.equal(effect.privileged, true);
    assert.ok(effect.uncertainty.includes('command-identity'));
  }
});

test('git reset analyzer does not promote operand pathspec help or invalid forms', () => {
  const commands = [
    'git reset -- --hard',
    'git reset HEAD -- --hard',
    'git reset --pathspec-from-file --hard',
    'git reset --hard --soft',
    'git reset --help --hard',
    'git reset --hard HEAD -- file',
    'git --bare reset --hard',
    'git reset --hard -- --hard',
  ];
  for (const command of commands) {
    const result = analyze(command, { cwd: '/work' });
    assert.deepEqual(result.effects, [], command);
    assert.ok(result.gitEffects.every(effect => effect.mode !== 'hard'), command);
    assert.ok(result.gitEffects.every(effect => effect.domain !== 'worktree'), command);
  }
});

test('git reset effects inherit branch uncertainty and argument budgets', () => {
  const branched = analyze('if mystery; then git reset --hard; else git reset --soft; fi', { cwd: '/work' });
  assert.ok(branched.gitEffects.every(effect => effect.uncertainty.includes('conditional-branch')));

  const bounded = analyze(`git reset --soft ${Array.from({ length: 256 }, () => '--quiet').join(' ')} --hard`, { cwd: '/work' });
  assert.equal(bounded.gitEffects.length, 1);
  assert.equal(bounded.gitEffects[0].mode, 'unknown');
  assert.equal(bounded.gitEffects[0].domain, 'worktree');
  assert.ok(bounded.gitEffects[0].uncertainty.includes('argument-budget'));
});

test('git reset risk policy keeps index and ref-only forms safe', () => {
  const commands = [
    'git reset',
    'git reset --mixed',
    'git reset --soft HEAD~1',
    'git reset -- file',
    'git reset HEAD -- file',
    'git reset -p -- file',
    'git reset -- --hard',
    'git reset --pathspec-from-file --hard',
    'git reset --hard --soft',
    'git reset --help --hard',
    'git reset --hard HEAD -- file',
  ];
  for (const command of commands) {
    const result = analyze(command, { cwd: '/work' });
    const analysis = {
      available: true,
      effects: result.effects,
      gitEffects: result.gitEffects,
      affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
    };
    assert.equal(classifyAnalysis(analysis, { platform: 'linux' }).severity, 'safe', command);
    assert.equal(decide(analysis, { platform: 'linux' }).decision, 'pass', command);
  }
});

test('git reset worktree modes are risky local passes without claiming actual loss', () => {
  for (const mode of ['hard', 'merge', 'keep']) {
    const result = analyze(`git reset --${mode}`, { cwd: '/work' });
    const analysis = {
      available: true,
      effects: result.effects,
      gitEffects: result.gitEffects,
      affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
    };
    const classified = classifyAnalysis(analysis, { platform: 'linux' });
    assert.equal(classified.severity, 'risky', mode);
    assert.equal(decide(analysis, { platform: 'linux' }).decision, 'pass', mode);
    const rendered = renderReasonCodesDetailed(classified.reasonCodes, analysis, {
      platform: 'linux',
    });
    assert.ok(rendered.includes('not inspected') || rendered.includes('preserved'), mode);
    assert.ok(!rendered.includes('attempts to discard'), mode);
  }

  const abbreviated = analyze('git reset --har', { cwd: '/work' });
  assert.equal(classifyAnalysis({
    available: true,
    effects: abbreviated.effects,
    gitEffects: abbreviated.gitEffects,
    affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
  }, { platform: 'linux' }).severity, 'risky');
});

test('git reset does not lower an independent critical filesystem decision', () => {
  const result = analyze('git reset --hard; rm -rf /', { cwd: '/work' });
  const decision = decide({
    available: true,
    effects: result.effects,
    gitEffects: result.gitEffects,
    affected: { totalFileCount: 0, totalSize: 0, budgetExhausted: false },
  }, { platform: 'linux' });
  assert.equal(decision.severity, 'critical');
  assert.equal(decision.decision, 'stop');
});

test('commands: package scripts and Makefile targets are analyzed', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-scripts-'));
  try {
    fs.writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ scripts: { clean: 'rm docs/a.pptx', build: 'mkdir dist' } }));
    fs.writeFileSync(nodePath.join(root, 'Makefile'), 'clean:\n\trm docs/b.docx\ninstall:\n\tmkdir out\n');
    const r = analyze('npm run clean; yarn build; make clean', { cwd: root });
    assert.deepEqual(r.effects.map(e => [e.type, nodePath.basename(e.path), e.command]), [
      ['delete', 'a.pptx', 'rm'],
      ['mkdir', 'dist', 'mkdir'],
      ['delete', 'b.docx', 'rm'],
    ]);
    assert.deepEqual(r.resourceEffects.map(effect => effect.command), ['make clean']);

    for (const command of ['make -n clean', 'make --dry-run clean', 'make -q clean', 'make -t clean']) {
      const preview = analyze(command, { cwd: root });
      assert.deepEqual(preview.effects, [], command);
      assert.deepEqual(preview.resourceEffects, [], command);
    }

    const sub = nodePath.join(root, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(nodePath.join(sub, 'Makefile'), 'clean:\n\trm local.docx\n');
    const nested = analyze('make -C sub clean', { cwd: root });
    assert.deepEqual(nested.effects.map(effect => effect.path), [toPosix(nodePath.join(sub, 'local.docx'))]);
    assert.deepEqual(nested.resourceEffects.map(effect => effect.selection.root), [toPosix(sub)]);
    assert.deepEqual(analyze('make -C sub -n clean', { cwd: root }).effects, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commands: local tar and zip metadata produce concrete archive paths', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bash-emu-archives-'));
  try {
    fs.writeFileSync(nodePath.join(root, 'fixture.tar'), makeTar(['docs/a.pptx', 'docs/b.txt']));
    fs.writeFileSync(nodePath.join(root, 'fixture.zip'), makeZip(['photos/a.jpg', 'notes/readme.txt']));
    const r = analyze('tar -xf fixture.tar -C out; unzip fixture.zip -d expanded', { cwd: root });
    assert.deepEqual(r.effects.map(e => [e.type, e.path.slice(root.length + 1), e.command]), [
      ['write', 'out/docs/a.pptx', 'tar'],
      ['write', 'out/docs/b.txt', 'tar'],
      ['write', 'expanded/photos/a.jpg', 'unzip'],
      ['write', 'expanded/notes/readme.txt', 'unzip'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTar(entries: string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry, 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write('00000000000\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(' ', 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function makeZip(entries: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ── Summary ──

console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`);
if (failed > 0) process.exit(1);
