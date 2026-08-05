import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'dist/bash-emu.cjs');
const fixtures = resolve(root, 'tests/fixtures');
const randomScript = resolve(root, 'tests/random-rm-pptx.sh');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;

function toPosixPath(p) {
  const fwd = p.replace(/\\/g, '/');
  return fwd.replace(/^([A-Za-z]):\/(.*)$/, (_, drive, rest) => `/${drive.toLowerCase()}/${rest}`);
}

function runNode(args, allowFail = false) {
  try {
    return execFileSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (allowFail) return output;
    throw err;
  }
}

function runCli(args, allowFail = false) {
  return runNode([cli, ...args], allowFail);
}

function assertContains(name, output, expected) {
  if (output.includes(expected)) {
    pass++;
    console.log(`  PASS: ${name}`);
    return;
  }
  fail++;
  console.log(`  FAIL: ${name}`);
  console.log(`    expected to contain: ${expected}`);
  console.log(`    got: ${output.split('\n').slice(0, 5).join('\n')}`);
}

function assertNotContains(name, output, unexpected) {
  if (!output.includes(unexpected)) {
    pass++;
    console.log(`  PASS: ${name}`);
    return;
  }
  fail++;
  console.log(`  FAIL: ${name}`);
  console.log(`    expected NOT to contain: ${unexpected}`);
}

console.log('\n--- Basic effects ---');

let out = runCli(['-c', 'echo hello > /tmp/out.txt']);
assertContains('echo redirect produces write', out, 'write');
assertContains('echo redirect shows path', out, '/tmp/out.txt');

out = runCli(['-c', 'rm -rf /tmp/build']);
assertContains('rm produces delete', out, 'delete');
assertContains('rm path', out, '/tmp/build');

out = runCli(['-c', 'cat input | sort > sorted.txt']);
assertContains('pipe redirect produces write', out, 'write');
assertContains('pipe redirect path', out, 'sorted.txt');

console.log('\n--- Script file (-f) ---');

out = runCli(['-f', randomScript, '--cwd', '/tmp']);
assertContains('fuzzy if script removes q4 pptx branch', out, '/tmp/slides/q4-random-7319.pptx');
assertContains('fuzzy if script removes backup pptx branch', out, '/tmp/slides/backup-random-2048.pptx');

out = runCli(['-c', 'sleep 1000; rm test.pptx', '--cwd', '/tmp']);
assertContains('sleep before rm does not block pptx delete', out, '/tmp/test.pptx');

console.log('\n--- Postprocess (affected files on disk) ---');

const rootPosix = toPosixPath(root);
const fixturesPosix = toPosixPath(fixtures);
out = runCli(['-c', `rm -rf ${fixturesPosix}`, '--cwd', rootPosix]);
assertContains('postprocess shows affected', out, 'Affected files on disk');
assertContains('postprocess finds .js', out, '.js');
assertContains('postprocess finds .css', out, '.css');
assertContains('postprocess finds .json', out, '.json');
assertContains('postprocess finds .txt', out, '.txt');
assertContains('postprocess finds .csv', out, '.csv');
assertContains('postprocess finds .svg', out, '.svg');
assertContains('postprocess shows file count', out, 'files');
assertContains('postprocess shows table header', out, 'Path');
assertContains('postprocess shows size column', out, 'Size');
assertContains('postprocess shows created column', out, 'Created');
assertContains('postprocess shows modified column', out, 'Modified');
assertContains('postprocess shows app.js path', out, 'app.js');

out = runCli(['-c', 'rm -rf /nonexistent/path/that/does/not/exist']);
assertContains('delete for missing path', out, 'delete');
assertNotContains('no affected section for missing', out, 'Affected files on disk');

console.log('\n--- Warnings ---');

out = runCli(['-c', 'source /etc/profile']);
assertContains('source produces warning', out, 'Warnings');

out = runCli(['-c', 'echo hello']);
assertContains('echo-only has no file effects', out, 'No file effects');
assertNotContains('echo-only has no affected', out, 'Affected files on disk');

console.log('\n--- Complex scripts ---');

out = runCli(['-c', 'if true; then mkdir -p /deploy; cp app.tar /deploy/; else rm -rf /deploy; fi']);
assertContains('if/else selects the known true branch', out, 'mkdir');
assertNotContains('if/else prunes the impossible false branch', out, 'delete');

out = runCli(['-c', 'cat <<EOF > /etc/app.conf\nkey=value\nEOF']);
assertContains('here-doc write', out, 'write');
assertContains('here-doc path', out, '/etc/app.conf');

out = runCli(['-c', 'echo line >> /var/log/app.log']);
assertContains('append effect', out, 'append');
assertContains('append path', out, '/var/log/app.log');

out = runCli(['-c', `rm ${fixturesPosix}/app.js ${fixturesPosix}/data.csv`, '--cwd', rootPosix]);
assertContains('multi-delete app.js affected', out, 'app.js');
assertContains('multi-delete data.csv affected', out, 'data.csv');
assertContains('multi-delete shows .js group', out, '.js');
assertContains('multi-delete shows .csv group', out, '.csv');

console.log('\n--- Error handling ---');

out = runCli([], true);
assertContains('no args shows usage', out, 'Usage');

out = runCli(['-f', '/nonexistent/script.sh'], true);
assertContains('missing file shows error', out, 'error');

console.log('\n--- Importable library (require) ---');

const { bash_emu } = require(cli);
const result = JSON.stringify(bash_emu('rm -rf /tmp/build && mkdir -p /opt/app', '/home/user'));
assertContains('lib: returns JSON', result, '"effects":');
assertContains('lib: has timestamp', result, '"timestamp":');
assertContains('lib: has warnings array', result, '"warnings":');
assertContains('lib: has affected', result, '"affected":');
assertContains('lib: has effectsByType', result, '"effectsByType":');
assertContains('lib: has bounded provenance graph', result, '"provenance":{"nodes":');
assertContains('lib: effects reference provenance nodes', result, '"provenance":[');
assertContains('lib: captures delete path', result, '/tmp/build');
assertContains('lib: delete type present', result, '"type":"delete"');

const observedResult = JSON.stringify(bash_emu(`rm ${fixturesPosix}/app.js`, rootPosix));
assertContains('lib: affected samples link to effects', observedResult, '"effectIndexes":[0]');
assertContains(
  'lib: affected samples reference observation provenance',
  observedResult,
  '"effectIndexesTruncated":false,"provenance":[',
);
assertContains(
  'lib: graph includes filesystem observations',
  observedResult,
  '"kind":"filesystem-observation"',
);

const gitResult = JSON.stringify(bash_emu('git reset --hard', '/home/user'));
assertContains('lib: exposes typed Git effects', gitResult, '"gitEffects":');
assertContains('lib: Git reset worktree domain', gitResult, '"domain":"worktree"');
assertNotContains('lib: Git reset has no synthetic path', gitResult, '<git-tracked-files>');

const resourceResult = JSON.stringify(bash_emu('git clean -fdx; terraform destroy', '/home/user'));
assertContains('lib: exposes typed resource effects', resourceResult, '"resourceEffects":');
assertContains('lib: Git clean resource domain', resourceResult, '"domain":"git-worktree"');
assertContains('lib: Terraform resource domain', resourceResult, '"domain":"terraform"');
assertNotContains('lib: non-exact effects have no synthetic path', resourceResult, '<');

const total = pass + fail;
console.log(`\nResults: ${pass} passed, ${fail} failed, ${total} total`);
if (fail > 0) process.exit(1);
