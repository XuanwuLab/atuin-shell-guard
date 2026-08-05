import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { powerShellAnalysisEnabled } from '../../plugin/platform.js';
import { analyzePowerShell } from '../index.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
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

console.log('ts-bash-emu PowerShell tests\n');

test('guard PowerShell routing is enabled only on Windows', () => {
  assert.equal(powerShellAnalysisEnabled('win32'), true);
  assert.equal(powerShellAnalysisEnabled('linux'), false);
  assert.equal(powerShellAnalysisEnabled('darwin'), false);
});

test('Remove-Item predicts delete using Path position 0', () => {
  const r = analyzePowerShell('Remove-Item -Recurse ./dist', { cwd: '/work' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/work/dist');
});

test('New-Item -ItemType Directory predicts mkdir', () => {
  const r = analyzePowerShell('New-Item -Path out -ItemType Directory', { cwd: '/work' });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'mkdir');
  assert.equal(r.effects[0].path, '/work/out');
});

test('Copy-Item and Move-Item preserve destination directory semantics', () => {
  const r = analyzePowerShell('Copy-Item a.txt out/; Move-Item b.txt out/', { cwd: '/work', fs: ['/work/out/'] });
  assert.deepEqual(r.effects.map(e => [e.type, e.path, e.source]), [
    ['copy', '/work/out/a.txt', 'a.txt'],
    ['move', '/work/out/b.txt', 'b.txt'],
  ]);
});

test('item cmdlets expose their documented destination replacement behavior', () => {
  const r = analyzePowerShell(
    'New-Item a.txt -ItemType File; New-Item b.txt -ItemType File -Force; '
    + 'Copy-Item c.txt copy.txt; Copy-Item c.txt forced-copy.txt -Force; '
    + 'Move-Item d.txt move.txt; Move-Item d.txt forced-move.txt -Force; '
    + 'Rename-Item e.txt renamed.txt; Rename-Item e.txt forced-rename.txt -Force',
    { cwd: '/work' },
  );
  assert.deepEqual(r.effects.map(effect => [effect.type, effect.path, effect.replacement]), [
    ['write', '/work/a.txt', 'no-clobber'],
    ['write', '/work/b.txt', 'replace'],
    ['copy', '/work/copy.txt', 'conditional'],
    ['copy', '/work/forced-copy.txt', 'replace'],
    ['move', '/work/move.txt', 'no-clobber'],
    ['move', '/work/forced-move.txt', 'replace'],
    ['move', '/work/renamed.txt', 'no-clobber'],
    ['move', '/work/forced-rename.txt', 'no-clobber'],
  ]);
});

test('content cmdlets map to write append and truncate', () => {
  const r = analyzePowerShell('Set-Content a.txt hi; Add-Content b.txt hi; Clear-Content c.txt', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [
    ['write', '/work/a.txt'],
    ['append', '/work/b.txt'],
    ['truncate', '/work/c.txt'],
  ]);
});

test('Out-File Tee-Object and Invoke-WebRequest use reference file parameters', () => {
  const r = analyzePowerShell('"x" | Out-File -FilePath out.txt; "y" | Tee-Object -Append tee.txt; Invoke-WebRequest u -OutFile dl.bin', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [
    ['write', '/work/out.txt'],
    ['append', '/work/tee.txt'],
    ['write', '/work/dl.bin'],
  ]);
});

test('Out-File NoClobber and Export-Csv Append avoid overwrite effects', () => {
  const existing = analyzePowerShell(
    '"x" | Out-File -FilePath report.pptx -NoClobber; "y" | Out-File -FilePath alias.pptx -NoOverwrite; Export-Csv -Path data.csv -NoClobber; "z" | Out-File -FilePath forced.pptx -NoClobber -Force',
    {
      cwd: '/work',
      fs: ['/work/report.pptx', '/work/alias.pptx', '/work/data.csv', '/work/forced.pptx'],
    },
  );
  assert.deepEqual(existing.effects, []);
  assert.equal(existing.warnings.filter(warning => warning.includes('prevents writing')).length, 4);

  const modes = analyzePowerShell(
    '"x" | Out-File -FilePath report.pptx -Append; Export-Csv -Path data.csv -Append; "z" | Out-File -FilePath both.pptx -Append -NoClobber',
    {
      cwd: '/work',
      fs: ['/work/report.pptx', '/work/data.csv', '/work/both.pptx'],
    },
  );
  assert.deepEqual(modes.effects.map(effect => [effect.type, effect.path]), [
    ['append', '/work/report.pptx'],
    ['append', '/work/data.csv'],
    ['append', '/work/both.pptx'],
  ]);
});

test('PowerShell switch values preserve executing overwrite counterparts', () => {
  const r = analyzePowerShell(
    '"x" | Out-File -FilePath a.pptx -NoClobber:$false; Export-Csv -Path b.csv -Append:$false; "z" | Out-File -FilePath c.pptx -Append:$true',
    {
      cwd: '/work',
      fs: ['/work/a.pptx', '/work/b.csv', '/work/c.pptx'],
    },
  );
  assert.deepEqual(r.effects.map(effect => [effect.type, effect.path]), [
    ['write', '/work/a.pptx'],
    ['write', '/work/b.csv'],
    ['append', '/work/c.pptx'],
  ]);
});

test('PowerShell splatting binds NoClobber and Append as switches', () => {
  const r = analyzePowerShell(
    '$safe = @{ FilePath = "report.pptx"; NoClobber = $true }; "x" | Out-File @safe; ' +
    '$overwrite = @{ Path = "data.csv"; NoClobber = $false }; Export-Csv @overwrite; ' +
    '$append = @{ Path = "append.csv"; Append = $true }; Export-Csv @append',
    {
      cwd: '/work',
      fs: ['/work/report.pptx', '/work/data.csv', '/work/append.csv'],
    },
  );
  assert.deepEqual(r.effects.map(effect => [effect.type, effect.path]), [
    ['write', '/work/data.csv'],
    ['append', '/work/append.csv'],
  ]);
});

test('Out-File NoClobber may create a target that does not exist', () => {
  const r = analyzePowerShell('"x" | Out-File -FilePath new.txt -NoClobber', {
    cwd: '/work',
    fs: [],
  });
  assert.deepEqual(r.effects.map(effect => [effect.type, effect.path]), [['write', '/work/new.txt']]);
});

test('variables expand in expandable strings and env scope', () => {
  const r = analyzePowerShell('$d = "out"; Set-Content "$d/$env:NAME.txt" hi', { cwd: '/work', env: { NAME: 'report' } });
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/work/out/report.txt');
});

test('if and else bodies are both walked conservatively', () => {
  const r = analyzePowerShell('if ($true) { Remove-Item a } else { Remove-Item b }', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/a', '/work/b']);
  assert.equal(r.effects.every(e => e.uncertainty.includes('conditional-branch')), true);
});

test('multi-value Path arrays and splatting are bound', () => {
  const r = analyzePowerShell('$p = @{ Path = @("a.pptx","b.docx"); Force = $true }; Remove-Item @p', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [
    ['delete', '/work/a.pptx'],
    ['delete', '/work/b.docx'],
  ]);
});

test('Start-Process redirect files are writes', () => {
  const r = analyzePowerShell('Start-Process tool -RedirectStandardOutput out.log -RedirectStandardError err.log', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [
    ['write', '/work/out.log'],
    ['write', '/work/err.log'],
  ]);
});

test('$null redirection discards output without a file effect', () => {
  for (const script of ['1 2>$null', 'Write-Output ok >${NULL}']) {
    const r = analyzePowerShell(script, { cwd: '/work' });
    assert.deepEqual(r.effects, [], script);
    assert.deepEqual(r.warnings, [], script);
  }
});

test('directory redirection emits no write or command effect', () => {
  const r = analyzePowerShell('Remove-Item victim > output', {
    cwd: '/work',
    fs: ['/work/victim', '/work/output/'],
  });
  assert.deepEqual(r.effects, []);
  assert.ok(r.warnings.some(warning => warning.includes('Is a directory')));
});

test('archive and export cmdlets predict target writes', () => {
  const r = analyzePowerShell('Compress-Archive -Path src -DestinationPath out.zip; Expand-Archive out.zip expanded; Export-Csv out.csv', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [
    ['write', '/work/out.zip'],
    ['mkdir', '/work/expanded'],
    ['write', '/work/expanded/<archive-contents>'],
    ['write', '/work/out.csv'],
  ]);
});

test('fixture scripts match expected effects', () => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const fixtureDir = nodePath.join(here, 'fixtures');
  const cases = JSON.parse(fs.readFileSync(nodePath.join(fixtureDir, 'expected.json'), 'utf8')) as Array<{
    script: string;
    cwd: string;
    effects: Array<[string, string]>;
  }>;
  for (const fixture of cases) {
    const script = fs.readFileSync(nodePath.join(fixtureDir, fixture.script), 'utf8');
    const r = analyzePowerShell(script, { cwd: fixture.cwd });
    assert.deepEqual(r.effects.map(e => [e.type, e.path]), fixture.effects, fixture.script);
  }
});

test('foreach statement binds loop variable', () => {
  const r = analyzePowerShell('foreach ($f in "a.pptx","b.docx") { Remove-Item "docs/$f" }', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/docs/a.pptx', '/work/docs/b.docx']);
});

test('ForEach-Object executes scriptblock but Where-Object does not', () => {
  const r = analyzePowerShell('"a.pptx" | ForEach-Object { Remove-Item docs/a.pptx }; "b.docx" | Where-Object { Remove-Item docs/b.docx }', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/docs/a.pptx']);
});

test('PowerShell Windows cwd and paths normalize', () => {
  const r = analyzePowerShell('Remove-Item C:\\Users\\me\\docs\\a.pptx; Set-Content out.txt x', { cwd: 'C:\\Users\\me' });
  assert.deepEqual(r.effects.map(e => e.path), ['/c/Users/me/docs/a.pptx', '/c/Users/me/out.txt']);
});

test('Get-ChildItem and Resolve-Path pipe filesystem paths', () => {
  const r = analyzePowerShell('Get-ChildItem *.pptx | Remove-Item; Resolve-Path *.docx | % { Remove-Item $_ }', {
    cwd: '/work',
    fs: ['/work/a.pptx', '/work/b.txt', '/work/c.docx'],
  });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/a.pptx', '/work/c.docx']);
});

test('Include Exclude and Filter use shared wildcard matching', () => {
  const r = analyzePowerShell('Remove-Item @("a.pptx","b.docx","c.txt") -Include *.pptx,*.docx -Exclude b.*; Set-Content -Path @("x.log","y.txt") -Value done -Filter *.txt', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [
    ['delete', '/work/a.pptx'],
    ['write', '/work/y.txt'],
  ]);
});

test('script param block binds -File arguments', () => {
  const r = analyzePowerShell('param($Target) Remove-Item $Target', { cwd: '/work', args: ['docs/a.pptx'] });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/docs/a.pptx']);
});

test('pipeline objects expose FullName Name and Path', () => {
  const r = analyzePowerShell('Get-ChildItem docs/*.pptx | ForEach-Object { Remove-Item $_.FullName; Remove-Item $_.Path }', {
    cwd: '/work',
    fs: ['/work/docs/a.pptx'],
  });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/docs/a.pptx', '/work/docs/a.pptx']);
});

test('try catch finally switch and do bodies are walked', () => {
  const r = analyzePowerShell('try { Remove-Item a } catch { Remove-Item b } finally { Remove-Item c }; switch ($x) { "v" { Remove-Item d } default { Remove-Item e } }; do { Remove-Item f } while ($false)', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/a', '/work/b', '/work/c', '/work/d', '/work/e', '/work/f']);
});

test('subexpressions indexing and scriptblock launchers are modeled', () => {
  const r = analyzePowerShell('$files = @("a.pptx","b.docx"); Remove-Item "$($files[0])"; Invoke-Command -ScriptBlock { Remove-Item c.pdf }; Start-Job { Remove-Item d.jpg }', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/a.pptx', '/work/c.pdf', '/work/d.jpg']);
});

test('Start-Process shell ArgumentList is analyzed', () => {
  const r = analyzePowerShell('Start-Process bash -ArgumentList "-c","rm docs/a.pptx"', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/docs/a.pptx']);
});

test('Start-Process Bash propagates typed Git reset effects', () => {
  const r = analyzePowerShell('Start-Process bash -ArgumentList "-c","git reset --hard"', { cwd: '/work' });
  assert.deepEqual(r.effects, []);
  assert.ok(r.gitEffects.some(effect => effect.domain === 'worktree' && effect.mode === 'hard'));
});

test('Start-Process Bash propagates typed non-exact resource effects', () => {
  const r = analyzePowerShell('Start-Process bash -ArgumentList "-c","git clean -fdx"', { cwd: '/work' });
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.resourceEffects.map(effect => [effect.domain, effect.command]), [
    ['git-worktree', 'git clean'],
  ]);
});

test('Python here-string code is not parsed as PowerShell commands', () => {
  const r = analyzePowerShell('$code = @"\nimport os\nos.system("Remove-Item docs/a.pptx")\n"@\npython -c $code', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), []);
});

test('single- and double-quoted here-string bodies remain data', () => {
  const scripts = [
    `$text = @"
Remove-Item docs/a.pptx
"@
Write-Output $text`,
    `$text = @'
Remove-Item docs/a.pptx
'@
Write-Output $text`,
  ];

  for (const script of scripts) {
    const r = analyzePowerShell(script, { cwd: '/work' });
    assert.deepEqual(r.effects, []);
  }
});

test('Invoke-Expression analyzes commands stored in a literal here-string', () => {
  const r = analyzePowerShell(
    `$script = @'
Remove-Item docs/a.pptx
'@
Invoke-Expression $script`,
    { cwd: '/work' },
  );
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/work/docs/a.pptx');
});

test('the closing here-string newline is not part of the value', () => {
  const r = analyzePowerShell(
    `$path = @"
docs/a.pptx
"@
Remove-Item $path`,
    { cwd: '/work' },
  );
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].path, '/work/docs/a.pptx');

  const crlf = analyzePowerShell('$path = @"\r\ndocs/b.pptx\r\n"@\r\nRemove-Item $path', { cwd: '/work' });
  assert.equal(crlf.effects.length, 1);
  assert.equal(crlf.effects[0].path, '/work/docs/b.pptx');
});

test('subexpressions in expandable strings are analyzed', () => {
  const r = analyzePowerShell(
    `$text = @"
$(Remove-Item docs/a.pptx)
"@
Write-Output $text`,
    { cwd: '/work' },
  );
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, 'delete');
  assert.equal(r.effects[0].path, '/work/docs/a.pptx');

  const ordinary = analyzePowerShell('Write-Output "$(Remove-Item docs/b.pptx)"', { cwd: '/work' });
  assert.equal(ordinary.effects.length, 1);
  assert.equal(ordinary.effects[0].path, '/work/docs/b.pptx');
});

test('escaped subexpressions in expandable here-strings remain data', () => {
  const r = analyzePowerShell('$text = @"\n`$(Remove-Item docs/a.pptx)\n"@\nWrite-Output $text', { cwd: '/work' });
  assert.deepEqual(r.effects, []);
});

test('literal subexpression text inside arrays and hashtables remains data', () => {
  const literals = analyzePowerShell(
    'Write-Output @("`$(Remove-Item docs/a.pptx)", \'$(Remove-Item docs/b.pptx)\'); ' +
    '$p = @{ Value = "`$(Remove-Item docs/c.pptx)" }; Write-Output @p',
    { cwd: '/work' },
  );
  assert.deepEqual(literals.effects, []);

  const executable = analyzePowerShell('Write-Output @("$(Remove-Item docs/a.pptx)")', { cwd: '/work' });
  assert.equal(executable.effects.length, 1);
  assert.equal(executable.effects[0].path, '/work/docs/a.pptx');
});

test('a here-string opening marker must be followed by a newline', () => {
  const r = analyzePowerShell(
    `$text = @"not-a-valid-opening
"@
Remove-Item docs/a.pptx`,
    { cwd: '/work' },
  );
  assert.deepEqual(r.effects, []);
  assert.ok(r.warnings.some(warning => /parse|here-string/i.test(warning)));
});

test('commands inside a block comment are ignored', () => {
  const r = analyzePowerShell(
    `<#
Remove-Item docs/a.pptx
#>
Write-Output ok`,
    { cwd: '/work' },
  );
  assert.deepEqual(r.effects, []);
});

test('-WhatIf suppresses only the modeled command effect', () => {
  const remove = analyzePowerShell('Remove-Item docs/a.pptx -WhatIf', { cwd: '/work' });
  const write = analyzePowerShell('Set-Content output.txt value -WhatIf', { cwd: '/work' });
  assert.deepEqual(remove.effects, []);
  assert.deepEqual(write.effects, []);

  const explicitTrue = analyzePowerShell('Remove-Item docs/a.pptx -WhatIf:$true', { cwd: '/work' });
  const explicitFalse = analyzePowerShell('Remove-Item docs/a.pptx -WhatIf:$false', { cwd: '/work' });
  assert.deepEqual(explicitTrue.effects, []);
  assert.equal(explicitFalse.effects.length, 1);
  assert.equal(explicitFalse.effects[0].path, '/work/docs/a.pptx');

  const splattedTrue = analyzePowerShell('$p = @{ Path = "docs/a.pptx"; WhatIf = $true }; Remove-Item @p', { cwd: '/work' });
  const splattedFalse = analyzePowerShell('$p = @{ Path = "docs/a.pptx"; WhatIf = $false }; Remove-Item @p', { cwd: '/work' });
  assert.deepEqual(splattedTrue.effects, []);
  assert.equal(splattedFalse.effects.length, 1);
  assert.equal(splattedFalse.effects[0].path, '/work/docs/a.pptx');

  const redirected = analyzePowerShell('Remove-Item docs/a.pptx -WhatIf > audit.log', { cwd: '/work' });
  assert.deepEqual(redirected.effects.map(effect => [effect.type, effect.path]), [['write', '/work/audit.log']]);
});

test('descriptor duplication does not create a file named &1', () => {
  for (const script of ['Write-Error boom 2>&1', 'Write-Output ok *>&1']) {
    const r = analyzePowerShell(script, { cwd: '/work' });
    assert.deepEqual(r.effects, []);
  }
});

test('commands used as control-flow conditions are analyzed', () => {
  const scripts = [
    'if (Remove-Item docs/a.pptx) { Write-Output ok }',
    'while (Remove-Item docs/a.pptx) { Write-Output ok }',
    'do { Write-Output ok } while (Remove-Item docs/a.pptx)',
    'switch (Remove-Item docs/a.pptx) { default { Write-Output ok } }',
  ];
  for (const script of scripts) {
    const r = analyzePowerShell(script, { cwd: '/work' });
    assert.equal(r.effects.length, 1);
    assert.equal(r.effects[0].type, 'delete');
    assert.equal(r.effects[0].path, '/work/docs/a.pptx');
  }
});

test('ForEach-Object parameter blocks and Invoke-Expression are modeled', () => {
  const r = analyzePowerShell('Get-ChildItem a.txt | ForEach-Object -Begin { Remove-Item begin.txt } -Process { Remove-Item $_ } -End { Remove-Item end.txt }; $cmd = "Remove-Item expr.docx"; Invoke-Expression $cmd', { cwd: '/work', fs: ['/work/a.txt'] });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/begin.txt', '/work/a.txt', '/work/end.txt', '/work/expr.docx']);
});

test('hashtable object member access is modeled', () => {
  const r = analyzePowerShell('$obj = @{ FullName = "docs/a.pptx"; Name = "a.pptx" }; Remove-Item $obj.FullName', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => e.path), ['/work/docs/a.pptx']);
});

test('parenthesized statement bodies are parsed without hanging', () => {
  const r = analyzePowerShell('(Remove-Item docs/a.pptx)', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [['delete', '/work/docs/a.pptx']]);
  assert.equal(r.effects[0].uncertainty.includes('unknown-loop-count'), false);
});

test('unexpected closing tokens recover without hanging', () => {
  for (const script of [') Remove-Item docs/a.pptx', '} Remove-Item docs/a.pptx']) {
    const r = analyzePowerShell(script, { cwd: '/work' });
    assert.equal(r.effects.length, 1, script);
    assert.equal(r.warnings.some(w => w.includes('unexpected token')), true, script);
  }
});

test('unclosed parenthesized statement recovers at eof', () => {
  const r = analyzePowerShell('(Remove-Item docs/a.pptx', { cwd: '/work' });
  assert.deepEqual(r.effects.map(e => [e.type, e.path]), [['delete', '/work/docs/a.pptx']]);
  assert.equal(r.warnings.some(w => w.includes("expected ')'")), true);
});

test('leading grouping edge cases are covered by project tests', () => {
  const cases: Array<{ script: string; paths: string[] }> = [
    { script: '(Get-ChildItem)', paths: [] },
    { script: '(cd docs && rm report.docx)', paths: ['/work/docs/report.docx'] },
    { script: '('.repeat(32) + 'Remove-Item docs/a.pptx', paths: ['/work/docs/a.pptx'] },
  ];

  for (const { script, paths } of cases) {
    const r = analyzePowerShell(script, { cwd: '/work' });
    assert.deepEqual(r.effects.map(e => e.path), paths, script);
  }
});

if (failed > 0) {
  console.log(`\n${passed} passed, ${failed} failed`);
  throw new Error(`${failed} PowerShell tests failed`);
}

console.log(`\n${passed} passed, ${failed} failed`);
