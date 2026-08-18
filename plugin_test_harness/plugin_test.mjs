
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, openSync, closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const rootfs = resolve(here, 'rootfs');
const shellProject = resolve(here, 'fixtures', 'shell-project');
const guard = resolve(root, 'plugin', 'atuin-shell-guard.cjs');
const defaultHook = guard;
const forcePlatform = resolve(here, 'force_platform.cjs');
const forceHookTimeout = resolve(here, 'force_hook_timeout.cjs');
const hookHome = resolve(rootfs, 'tmp', 'hook-home');
const require = createRequire(import.meta.url);

const bigFile = resolve(rootfs, 'tmp', 'bigfile.bin');
const bigFileSize = 110 * 1024 * 1024;
const defaultChildTimeoutMs = 30_000;
const blockAiInstruction = "To AI: Reconsider whether this shell call is justified. First inspect Atuin's concrete command-impact information; if it is insufficient, investigate the relevant files and state yourself, and consider safer alternatives.";
const stopAiInstruction = 'To AI: Stop immediately; the system detected dangerous behavior in this conversation, so terminate any active goal or loop, end this turn after explaining the risk to the user, and take no further action until the user decides. If the targeted file truly can be deleted, ask the user to delete it manually for you instead of attempting to bypass shell-guard.';
const updateNoticeHeading = '## Atuin Shell Guard needs update!';
const updateAiInstruction = 'To AI: Atuin Shell Guard needs to be updated so it can better protect data in the current environment. You and the user can learn how to update the plugin on GitHub: https://github.com/XuanwuLab/atuin-shell-guard';
const riskReasonCodes = Object.freeze({
  CATASTROPHIC_ROOT_DESTRUCTION: 1001,
  PROTECTED_SYSTEM_TREE_DESTRUCTION: 1002,
  BROAD_UNRESOLVED_CATASTROPHIC_DELETE: 1003,
  RAW_BLOCK_DEVICE_WRITE: 1011,
  OPAQUE_LOCAL_DESTRUCTIVE_SELECTION: 1012,
  SPECIAL_DEVICE_SIDE_EFFECT: 1013,
  AFFECTED_FILE_COUNT_CRITICAL: 2001,
  AFFECTED_FILE_COUNT_RISKY: 2002,
  CONDITIONAL_AFFECTED_FILE_COUNT: 2003,
  SENSITIVE_EXTENSION: 2011,
  CONDITIONAL_SENSITIVE_EXTENSION: 2012,
  AFFECTED_TOTAL_SIZE: 2021,
  CONDITIONAL_AFFECTED_TOTAL_SIZE: 2022,
  OLD_AFFECTED_FILE: 2031,
  CONDITIONAL_OLD_AFFECTED_FILE: 2032,
  GIT_WORKTREE_DISCARD: 3001,
  EXTERNAL_RESOURCE_DESTRUCTION: 4001,
  CONTAINER_HOST_WRITE_EXPOSURE: 4002,
});
const directReasonCodeSet = new Set([
  riskReasonCodes.CATASTROPHIC_ROOT_DESTRUCTION,
  riskReasonCodes.PROTECTED_SYSTEM_TREE_DESTRUCTION,
  riskReasonCodes.BROAD_UNRESOLVED_CATASTROPHIC_DELETE,
  riskReasonCodes.RAW_BLOCK_DEVICE_WRITE,
  riskReasonCodes.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION,
  riskReasonCodes.SPECIAL_DEVICE_SIDE_EFFECT,
  riskReasonCodes.GIT_WORKTREE_DISCARD,
  riskReasonCodes.EXTERNAL_RESOURCE_DESTRUCTION,
  riskReasonCodes.CONTAINER_HOST_WRITE_EXPOSURE,
]);

const tests = [];
let passed = 0;
let failed = 0;
const powershellGuardEnabled = process.platform === 'win32';

function test(name, fn) {
  tests.push({ name, fn });
}

function windowsTest(name, fn) {
  if (powershellGuardEnabled) test(name, fn);
}

class AssertionFailure extends Error {}

function assertEqual(actual, expected, message = 'values differ') {
  if (actual !== expected) {
    throw new AssertionFailure(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTruthy(value, message = 'expected truthy value') {
  if (!value) throw new AssertionFailure(message);
}

function assertIncludes(haystack, needle, message = 'missing expected text') {
  if (!String(haystack).includes(needle)) {
    throw new AssertionFailure(`${message}\n  expected to contain: ${JSON.stringify(needle)}\n  got: ${JSON.stringify(haystack)}`);
  }
}

function assertAffectedFileMetadata(output, filename, size) {
  const line = String(output).split('\n').find(candidate =>
    candidate.includes(filename) && candidate.includes(`size ${size}`));
  assertTruthy(line, `${filename} entry should include size ${size}`);
  assertTruthy(
    /created \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(line),
    `${filename} entry should include its full ISO creation time`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: defaultChildTimeoutMs,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

async function runPython(args, options = {}) {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'py', prefix: ['-3'] },
        { command: 'python', prefix: [] },
        { command: 'python3', prefix: [] },
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ];

  for (const candidate of candidates) {
    try {
      return await runAsync(candidate.command, [...candidate.prefix, ...args], options);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  throw new Error('Python 3 is required to test the Hermes adapter');
}

function protectOnPlatform(command, shell, platform, env = {}) {
  const source = [
    "Object.defineProperty(process, 'platform', { value: process.argv[1] });",
    'const { protect } = require(process.argv[2]);',
    'const result = protect(process.argv[3], process.argv[4], process.argv[5]);',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const result = run(
    process.execPath,
    ['-e', source, platform, guard, command, rootfs, shell],
    { env: { ...process.env, ...env } },
  );
  if (result.status !== 0) {
    throw new Error(`platform guard probe failed\n${result.stderr}`);
  }
  return parseStdout(result.stdout);
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input = '', timeoutMs = defaultChildTimeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      ...spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let settled = false;
    let timeout;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`child process timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.once('error', err => finish(reject, err));
    child.once('close', status => finish(resolve, { status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function protectWithReview(command, {
  cwd = rootfs,
  shell = 'bash',
  cloudReview = 'yes',
  env = {},
} = {}) {
  writeHookCloudReview(cloudReview);
  const source = [
    'const { protectWithReview } = require(process.argv[1]);',
    'protectWithReview(process.argv[2], process.argv[3], process.argv[4])',
    '  .then(result => process.stdout.write(JSON.stringify(result)))',
    '  .catch(error => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
  const result = await runAsync(process.execPath, ['-e', source, guard, command, cwd, shell], {
    env: {
      ...process.env,
      HOME: hookHome,
      USERPROFILE: hookHome,
      XW_ENABLE_LOG: 'false',
      ...env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`protectWithReview probe failed\n${result.stderr}`);
  }
  return parseStdout(result.stdout);
}

function buildPlugin() {
  console.log(`[build] bundle direct hook in ${root}`);
  const result = run(process.execPath, [resolve(root, 'scripts/bundle.mjs'), 'plugin'], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`direct hook build failed with exit code ${result.status}`);
  }
  if (!existsSync(guard)) {
    throw new Error(`direct hook bundle missing after build: ${guard}`);
  }
}

function ensureBigFile() {
  mkdirSync(dirname(bigFile), { recursive: true });
  const fd = openSync(bigFile, 'w');
  try {
    // Sparse file keeps the test fast while exercising the size threshold.
    writeSync(fd, Buffer.from([0]), 0, 1, bigFileSize - 1);
  } finally {
    closeSync(fd);
  }
}

function cleanupBigFile() {
  rmSync(bigFile, { force: true });
}

function touch(path) {
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, 'a'));
}

function cleanup(paths) {
  for (const path of paths) {
    rmSync(path, { force: true });
  }
}

function writeHookCloudReview(value) {
  const configPath = resolve(hookHome, '.atuin-shell-guard', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  let config = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  }
  if (typeof config['installation-id'] !== 'string') {
    config['installation-id'] = '00000000-0000-4000-8000-000000000001';
  }
  config['cloud-review'] = value;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function parseStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function readShellProjectFixture(shell, name) {
  const extension = shell === 'powershell' ? 'ps1' : 'sh';
  return readFileSync(resolve(shellProject, shell, `${name}.${extension}`), 'utf8').replace(/\r\n/g, '\n');
}

function runHook(command, {
  cwd = rootfs,
  toolName = 'Bash',
  toolInput = { command },
  hookEvent = 'PreToolUse',
  hookFields = {},
  hookPath = defaultHook,
  platform,
  cloudReview = 'no',
  env = {},
} = {}) {
  if (cloudReview !== null) writeHookCloudReview(cloudReview);
  const payload = {
    hook_event_name: hookEvent,
    session_id: 'plugin-test',
    turn_id: 'plugin-test-turn',
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
    ...hookFields,
  };

  const start = performance.now();
  const nodeArgs = platform ? ['--require', forcePlatform, hookPath] : [hookPath];
  const result = run(process.execPath, nodeArgs, {
    input: JSON.stringify(payload),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: hookHome,
      USERPROFILE: hookHome,
      XW_ENABLE_LOG: 'false',
      ...(platform ? { ASG_TEST_PLATFORM: platform } : {}),
      ...env,
    },
  });
  const elapsed = Math.round(performance.now() - start);
  const parsed = parseStdout(result.stdout);
  const decision = parsed?.hookSpecificOutput?.permissionDecision ?? parsed?.decision ?? parsed?.action ?? null;
  console.log(`        [${String(elapsed).padStart(4)}ms] ${toolName}(${JSON.stringify(command)}) -> rc=${result.status} decision=${decision}`);
  return { ...result, parsed };
}

async function runHookAsync(command, {
  cwd = rootfs,
  toolName = 'Bash',
  toolInput = { command },
  hookEvent = 'PreToolUse',
  hookFields = {},
  hookPath = defaultHook,
  nodeArgs,
  platform,
  cloudReview = 'no',
  env = {},
} = {}) {
  if (cloudReview !== null) writeHookCloudReview(cloudReview);
  const payload = {
    hook_event_name: hookEvent,
    session_id: 'plugin-test',
    turn_id: 'plugin-test-turn',
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
    ...hookFields,
  };

  const start = performance.now();
  const resolvedNodeArgs = nodeArgs ?? (platform ? ['--require', forcePlatform, hookPath] : [hookPath]);
  const result = await runAsync(process.execPath, resolvedNodeArgs, {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HOME: hookHome,
      USERPROFILE: hookHome,
      XW_ENABLE_LOG: 'false',
      ...(platform ? { ASG_TEST_PLATFORM: platform } : {}),
      ...env,
    },
  });
  const elapsed = Math.round(performance.now() - start);
  const parsed = parseStdout(result.stdout);
  const decision = parsed?.hookSpecificOutput?.permissionDecision ?? parsed?.decision ?? parsed?.action ?? null;
  console.log(`        [${String(elapsed).padStart(4)}ms] ${toolName}(${JSON.stringify(command)}) -> rc=${result.status} decision=${decision}`);
  return { ...result, parsed };
}

function reason(result) {
  return result.parsed?.hookSpecificOutput?.permissionDecisionReason
    ?? result.parsed?.reason
    ?? result.parsed?.message
    ?? '';
}

function assertNestedDenialOnly(result, message = 'hook denial') {
  const output = result.parsed;
  const nested = output?.hookSpecificOutput;
  assertEqual(nested?.hookEventName, 'PreToolUse', `${message} hook event`);
  assertEqual(nested?.permissionDecision, 'deny', `${message} permission decision`);
  assertTruthy(nested?.permissionDecisionReason, `${message} nested reason`);
  assertEqual(output?.decision, undefined, `${message} omits top-level decision`);
  assertEqual(output?.reason, undefined, `${message} omits top-level reason`);
  assertEqual(
    JSON.stringify(Object.keys(output ?? {}).sort()),
    JSON.stringify(['hookSpecificOutput']),
    `${message} emits only hookSpecificOutput`,
  );
  assertEqual(
    JSON.stringify(Object.keys(nested ?? {}).sort()),
    JSON.stringify(['hookEventName', 'permissionDecision', 'permissionDecisionReason']),
    `${message} nested output fields`,
  );
}

function directReasons(result) {
  return (result?.reasonCodes ?? []).filter(code => directReasonCodeSet.has(code));
}

function assertPasses(command, options = {}) {
  const result = runHook(command, options);
  assertEqual(result.status, 0, 'exit code');
  assertEqual(result.parsed, null, 'safe command should emit no hook output');
}

function assertBlocked(command, options = {}) {
  const result = runHook(command, options);
  assertEqual(result.status, 0, 'exit code');
  assertNestedDenialOnly(result, 'critical denial');
  assertTruthy(reason(result), 'denial reason should be present');
  assertIncludes(reason(result), stopAiInstruction, 'stop instruction');
  return result;
}

function assertSoftBlocked(command, options = {}) {
  const result = runHook(command, options);
  assertEqual(result.status, 0, 'exit code');
  assertNestedDenialOnly(result, 'offline risky denial');
  assertIncludes(reason(result), blockAiInstruction, 'block instruction');
  assertTruthy(!reason(result).includes(stopAiInstruction), 'block output must not contain the stop instruction');
  return result;
}

async function assertBlockedAsync(command, options = {}) {
  const result = await runHookAsync(command, options);
  assertEqual(result.status, 0, 'exit code');
  assertNestedDenialOnly(result, 'critical denial');
  assertTruthy(reason(result), 'denial reason should be present');
  assertIncludes(reason(result), stopAiInstruction, 'stop instruction');
  return result;
}

async function assertSoftBlockedAsync(command, options = {}) {
  const result = await runHookAsync(command, options);
  assertEqual(result.status, 0, 'exit code');
  assertNestedDenialOnly(result, 'review block denial');
  assertIncludes(reason(result), blockAiInstruction, 'block instruction');
  assertTruthy(!reason(result).includes(stopAiInstruction), 'block output must not contain the stop instruction');
  return result;
}

async function assertPassesAsync(command, options = {}) {
  const result = await runHookAsync(command, options);
  assertEqual(result.status, 0, 'exit code');
  assertEqual(result.parsed, null, 'passing command should emit no hook output');
  return result;
}

async function withReviewHandler(handler, fn) {
  const requests = [];
  const handlerErrors = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('error', error => {
      handlerErrors.push(error);
      if (!res.destroyed) res.destroy();
    });
    req.once('end', async () => {
      const request = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      };
      requests.push(request);
      try {
        await handler(req, res, request);
      } catch (error) {
        handlerErrors.push(error);
        if (!res.destroyed && !res.writableEnded) {
          res.statusCode = 500;
          res.end('review fixture failed');
        }
      }
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const result = await fn(`http://127.0.0.1:${port}`, requests);
    if (handlerErrors.length > 0) throw handlerErrors[0];
    return result;
  } finally {
    await new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections?.();
    });
  }
}

async function withReviewServer(response, fn) {
  return withReviewHandler((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  }, fn);
}

function decodeReviewRequest(request) {
  assertEqual(request.method, 'POST', 'cloud review method');
  assertEqual(request.url, '/v1/xw_review_bash', 'cloud review path');
  assertEqual(request.headers['content-type'], 'application/json', 'cloud review content type');
  assertEqual(request.headers['content-encoding'], 'gzip', 'cloud review content encoding');
  assertEqual(request.headers['accept-encoding'], 'br, gzip', 'cloud review accepted response encodings');
  assertEqual(request.headers['x-service-id'], 'atuin', 'cloud review service id');
  assertEqual(request.headers['user-agent'], 'Atuin Shell Guard/1.0.0', 'cloud review user agent');
  const config = JSON.parse(readFileSync(resolve(hookHome, '.atuin-shell-guard', 'config.json'), 'utf8'));
  assertTruthy(typeof request.headers['x-atuin-iid'] === 'string', 'cloud review installation ID header');
  assertEqual(request.headers['x-atuin-iid'], config['installation-id'], 'cloud review installation ID');
  assertTruthy(request.body.length > 0, 'cloud review body should not be empty');
  try {
    return JSON.parse(gunzipSync(request.body).toString('utf8'));
  } catch (error) {
    throw new AssertionFailure(`cloud review body is not gzip JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function hookProtocolVariants(command) {
  return [
    ['Claude Code', {
      hookEvent: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command },
      hookFields: { session_id: 'claude-conversation' },
    }],
    ['Codex', {
      hookEvent: 'PreToolUse',
      toolName: 'exec_command',
      toolInput: { cmd: command },
      hookFields: { session_id: 'codex-conversation' },
    }],
    ['Kimi Code', {
      hookEvent: 'PreToolUse',
      toolName: 'Shell',
      toolInput: { command },
      hookFields: { session_id: 'kimi-conversation' },
    }],
  ];
}

function codexTranscriptItem(callId, command, {
  workdir = 'docs',
  environmentId,
} = {}) {
  const args = { cmd: command, workdir };
  if (environmentId !== undefined) args.environment_id = environmentId;
  return JSON.stringify({
    timestamp: '2026-07-27T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  });
}

function codexHookFields(transcriptPath, toolUseId, extra = {}) {
  return {
    model: 'gpt-5.4',
    tool_use_id: toolUseId,
    transcript_path: transcriptPath,
    ...extra,
  };
}

test('release metadata uses version 1.0.0 consistently', () => {
  const expected = '1.0.0';
  const jsonFiles = [
    'package.json',
    'plugin/package.json',
    'plugin/.claude-plugin/plugin.json',
    'plugin/.codex-plugin/plugin.json',
    'plugin/openclaw.plugin.json',
  ];
  for (const relative of jsonFiles) {
    const metadata = JSON.parse(readFileSync(resolve(root, relative), 'utf8'));
    assertEqual(metadata.version, expected, `${relative} version`);
  }

  const marketplace = JSON.parse(
    readFileSync(resolve(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  assertEqual(marketplace.version, expected, 'Claude marketplace version');
  for (const plugin of marketplace.plugins ?? []) {
    assertEqual(plugin.version, expected, `Claude marketplace ${plugin.name} version`);
  }

  for (const relative of ['plugin.yaml', 'plugin/plugin.yaml']) {
    const metadata = readFileSync(resolve(root, relative), 'utf8');
    assertIncludes(metadata, `version: "${expected}"`, `${relative} version`);
  }
});

test('direct hook startup creates a stable installation ID', () => {
  rmSync(hookHome, { recursive: true, force: true });
  assertPasses('ls -la', { cloudReview: null });
  const configPath = resolve(hookHome, '.atuin-shell-guard', 'config.json');
  const first = JSON.parse(readFileSync(configPath, 'utf8'));
  assertTruthy(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(first['installation-id']),
    'installation-id should be a UUID',
  );
  assertEqual(first['cloud-review'], 'yes', 'cloud review should default to yes');

  assertPasses('ls -la', { cloudReview: null });
  const second = JSON.parse(readFileSync(configPath, 'utf8'));
  assertEqual(second['installation-id'], first['installation-id'], 'installation-id should remain stable');
  assertEqual(second['cloud-review'], 'yes', 'cloud review default should remain stable');
});

test('installation config preserves existing fields when adding its ID', () => {
  const home = mkdtempSync(resolve(rootfs, 'tmp', 'config-home-'));
  try {
    const configDir = resolve(home, '.atuin-shell-guard');
    const configPath = resolve(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ channel: 'stable' }));

    const { ensureInstallationConfig } = require(guard);
    assertEqual(ensureInstallationConfig(home), true, 'config initialization result');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assertEqual(config.channel, 'stable', 'existing config field');
    assertTruthy(typeof config['installation-id'] === 'string', 'generated installation-id');
    assertEqual(config['cloud-review'], 'yes', 'cloud review default');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installation config migrates the cloud review default without replacing its ID', () => {
  const home = mkdtempSync(resolve(rootfs, 'tmp', 'config-migration-home-'));
  try {
    const configDir = resolve(home, '.atuin-shell-guard');
    const configPath = resolve(configDir, 'config.json');
    const installationId = '00000000-0000-4000-8000-000000000002';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      'installation-id': installationId,
      channel: 'stable',
    }));

    const { ensureInstallationConfig } = require(guard);
    assertEqual(ensureInstallationConfig(home), true, 'config migration result');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assertEqual(config['installation-id'], installationId, 'existing installation-id');
    assertEqual(config['cloud-review'], 'yes', 'migrated cloud review default');
    assertEqual(config.channel, 'stable', 'unrelated config field');

    config['cloud-review'] = 'no';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    assertEqual(ensureInstallationConfig(home), true, 'explicit offline config result');
    const offlineConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    assertEqual(offlineConfig['cloud-review'], 'no', 'explicit offline setting is preserved');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cloud review calls its API only when the config value is exactly yes', async () => {
  const command = 'git reset --hard';
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    for (const cloudReview of ['no', 'true']) {
      const local = await runHookAsync(command, {
        cloudReview,
        env: {
          XW_SHELL_GUARD_CLOUD_REVIEW: 'true',
          XW_SHELL_GUARD_URL: url,
        },
      });
      assertEqual(local.status, 0, `${cloudReview} hook exit code`);
      assertNestedDenialOnly(local, `${cloudReview} offline risky denial`);
      assertIncludes(reason(local), blockAiInstruction, `${cloudReview} block instruction`);
      assertTruthy(!reason(local).includes(stopAiInstruction), `${cloudReview} omits stop instruction`);
      assertEqual(requests.length, 0, `${cloudReview} must not call cloud review`);
    }

    const reviewed = await assertSoftBlockedAsync(command, {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_CLOUD_REVIEW: 'false',
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertTruthy(reviewed.parsed, 'yes uses the cloud-review decision');
    assertEqual(requests.length, 1, 'yes calls cloud review exactly once');
    decodeReviewRequest(requests[0]);
  });
});

test('offline mode blocks risky commands while safe commands still pass', async () => {
  const risky = await protectWithReview('git reset --hard', { cloudReview: 'no' });
  assertEqual(risky.severity, 'risky', 'offline severity');
  assertEqual(risky.decision, 'block', 'offline risky decision');
  assertTruthy(risky.detail, 'offline block has risk detail');

  assertSoftBlocked('git reset --hard', { cloudReview: 'no' });
  assertPasses('ls -la', { cloudReview: 'no' });
});

test('an exact first-line risk-ID declaration suppresses only the matching final block', () => {
  const command = 'git reset --hard';
  const directive = '# atuin-suppress-warning: 3001';
  const blocked = assertSoftBlocked(command, { cloudReview: 'no' });
  assertIncludes(reason(blocked), 'Risk IDs: 3001', 'block reports its stable risk IDs');
  assertIncludes(reason(blocked), directive, 'block gives the exact suppression directive');
  assertIncludes(reason(blocked), 'investigate the relevant files and state yourself', 'block asks AI to investigate missing context');
  assertIncludes(reason(blocked), 'consider safer alternatives', 'block asks AI to consider alternatives');

  assertPasses(`${directive}\n${command}`, { cloudReview: 'no' });
  assertPasses(`${directive}\r\n${command}`, { cloudReview: 'no' });

  for (const invalidFirstLine of [
    '# atuin-suppress-warning: 2011',
    '# atuin-suppress-warning: 3001,2011',
    '# atuin-suppress-warning: 3001,3001',
    '# atuin-suppress-warning: 3001 ',
  ]) {
    assertSoftBlocked(`${invalidFirstLine}\n${command}`, { cloudReview: 'no' });
  }
  assertSoftBlocked(`# explanatory comment\n${directive}\n${command}`, { cloudReview: 'no' });

  const multiRiskCommand = 'git reset --hard && rm -f docs/report.docx';
  const multiRiskBlocked = assertSoftBlocked(multiRiskCommand, { cloudReview: 'no' });
  assertIncludes(reason(multiRiskBlocked), 'Risk IDs: 2012,2032,3001', 'multiple current risk IDs are sorted');
  assertPasses(
    `# atuin-suppress-warning: 3001,2012,2032\n${multiRiskCommand}`,
    { cloudReview: 'no' },
  );
  assertSoftBlocked(
    `# atuin-suppress-warning: 2012,3001\n${multiRiskCommand}`,
    { cloudReview: 'no' },
  );

  assertBlocked(
    '# atuin-suppress-warning: 2011,2031\nrm -f docs/report.docx',
    { cloudReview: 'no' },
  );
});

test('the exact first-line risk-ID declaration applies after a cloud block', async () => {
  const command = '# atuin-suppress-warning: 3001\ngit reset --hard';
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    const result = await runHookAsync(command, {
      cloudReview: 'yes',
      env: { XW_SHELL_GUARD_URL: url },
    });
    assertEqual(result.status, 0, 'cloud-suppressed hook exit code');
    assertEqual(result.parsed, null, 'matching declaration suppresses the final cloud block');
    assertEqual(requests.length, 1, 'suppression does not skip cloud review');
  });
});

test('Codex recovers exec_command workdir from the bounded transcript tail', () => {
  const transcriptDir = mkdtempSync(resolve(rootfs, 'tmp', 'codex-transcript-'));
  const transcriptPath = resolve(transcriptDir, 'rollout.jsonl');
  const command = 'rm -f ./report.docx';
  const callId = 'call_codex_cwd_success';
  try {
    const discardedPrefix = 'x'.repeat(1024 * 1024 + 128);
    writeFileSync(
      transcriptPath,
      `${discardedPrefix}\n${codexTranscriptItem(callId, command)}\n`,
    );
    const result = assertBlocked(command, {
      cwd: rootfs,
      toolName: 'Bash',
      toolInput: { command },
      hookFields: codexHookFields(transcriptPath, callId),
    });
    assertIncludes(reason(result), 'report.docx', 'Codex recovered cwd denial identifies the target');
  } finally {
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test('Codex transcript cwd recovery fails open to the original cwd for invalid evidence', () => {
  const transcriptDir = mkdtempSync(resolve(rootfs, 'tmp', 'codex-transcript-fallback-'));
  const command = 'rm -f ./report.docx';
  const callId = 'call_codex_cwd_fallback';
  const validItem = codexTranscriptItem(callId, command);
  const unrelatedItem = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } });
  const writeTranscript = (name, content) => {
    const transcriptPath = resolve(transcriptDir, name);
    writeFileSync(transcriptPath, content);
    return transcriptPath;
  };

  try {
    const validPath = writeTranscript('valid.jsonl', `${validItem}\n`);
    const malformedPath = writeTranscript('malformed.jsonl', '{\n');
    const unrecognizedPath = writeTranscript('unrecognized.jsonl', `${unrelatedItem}\n`);
    const wrongCallPath = writeTranscript(
      'wrong-call.jsonl',
      `${codexTranscriptItem('call_other', command)}\n`,
    );
    const wrongCommandPath = writeTranscript(
      'wrong-command.jsonl',
      `${codexTranscriptItem(callId, 'rm -f ./other.docx')}\n`,
    );
    const invalidWorkdirPath = writeTranscript(
      'invalid-workdir.jsonl',
      `${codexTranscriptItem(callId, command, { workdir: null })}\n`,
    );
    const remoteEnvironmentPath = writeTranscript(
      'remote-environment.jsonl',
      `${codexTranscriptItem(callId, command, { environmentId: 'remote' })}\n`,
    );
    const byteBoundPath = writeTranscript(
      'outside-byte-bound.jsonl',
      `${validItem}\n${'x'.repeat(1024 * 1024 + 128)}\n`,
    );
    const lineBoundPath = writeTranscript(
      'outside-line-bound.jsonl',
      `${validItem}\n${Array.from({ length: 4100 }, () => unrelatedItem).join('\n')}\n`,
    );

    const cases = [
      ['missing transcript path', codexHookFields(undefined, callId)],
      ['relative transcript path', codexHookFields('rollout.jsonl', callId)],
      ['unreadable transcript path', codexHookFields(resolve(transcriptDir, 'missing.jsonl'), callId)],
      ['non-file transcript path', codexHookFields(transcriptDir, callId)],
      ['malformed transcript JSONL', codexHookFields(malformedPath, callId)],
      ['unrecognized transcript record', codexHookFields(unrecognizedPath, callId)],
      ['different call id', codexHookFields(wrongCallPath, callId)],
      ['different command', codexHookFields(wrongCommandPath, callId)],
      ['invalid workdir', codexHookFields(invalidWorkdirPath, callId)],
      ['non-local environment', codexHookFields(remoteEnvironmentPath, callId)],
      ['matching record outside byte bound', codexHookFields(byteBoundPath, callId)],
      ['matching record outside line bound', codexHookFields(lineBoundPath, callId)],
      ['inconclusive Codex detection', codexHookFields(validPath, callId, { model: undefined })],
    ];

    for (const [name, hookFields] of cases) {
      const result = runHook(command, {
        cwd: rootfs,
        toolName: 'Bash',
        toolInput: { command },
        hookFields,
      });
      assertEqual(result.status, 0, `${name} exit code`);
      assertEqual(result.parsed, null, `${name} preserves original cwd fallback`);
    }
  } finally {
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test('ls passes with no output', () => assertPasses('ls -la'));
test('cat passes with no output', () => assertPasses('cat safe/notes.txt'));
test('echo passes with no output', () => assertPasses('echo hello world'));
test('mkdir passes with no output', () => assertPasses('mkdir -p newdir/subdir'));
test('find read-only passes with no output', () => assertPasses("find . -name '*.txt'"));

test('harness terminates a hung child probe', async () => {
  let error;
  try {
    await runAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
  } catch (caught) {
    error = caught;
  }
  assertTruthy(error instanceof Error, 'hung child should reject');
  assertIncludes(error.message, 'timed out after 100ms', 'hung child timeout message');
});

[
  ['echo mentions rm sensitive file', 'echo "rm docs/presentation.pptx"'],
  ['printf mentions rm glob', 'printf "%s\\n" "rm photos/*.jpg"'],
  ['grep searches for rm text', 'grep -R "rm -rf" safe/notes.txt'],
  ['find prints sensitive document', 'find docs -name "*.pptx" -print'],
  ['for loop only echoes jpg matches', 'for f in photos/*.jpg; do echo "$f"; done'],
  ['pipeline only reads', 'find photos -name "*.jpg" | sort | head -n 1'],
  ['heredoc contains rm text', "cat <<'EOF'\nrm -rf docs\nEOF"],
  ['echo mentions pwsh destructive command', 'echo "pwsh -Command Remove-Item docs/presentation.pptx"'],
].forEach(([name, command]) => {
  test(`innocent bash passes: ${name}`, () => assertPasses(command));
});

test('Bash quoted heredoc does not run PowerShell command text', () => {
  assertPasses("cat <<'EOF'\nRemove-Item docs/presentation.pptx\nEOF");
});

test('Bash unquoted heredoc does not run command-like body text', () => {
  assertPasses('cat <<EOF\nrm docs/presentation.pptx\nEOF');
});

windowsTest('Bash heredoc does not hide executable PowerShell code after its delimiter on Windows', () => {
  const result = assertBlocked("cat <<'EOF'\nRemove-Item data-only.pptx\nEOF\nRemove-Item docs/presentation.pptx");
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell reading a Bash heredoc from stdin is still analyzed on Windows', () => {
  const result = assertBlocked("pwsh -Command - <<'EOF'\nRemove-Item docs/presentation.pptx\nEOF");
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

test('command substitution in an expandable Bash heredoc is still analyzed', () => {
  const result = assertBlocked('cat <<EOF\n$(rm docs/presentation.pptx)\nEOF');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

test('quoted and escaped Bash heredoc substitutions remain data', () => {
  assertPasses("cat <<'EOF'\n$(rm docs/presentation.pptx)\nEOF");
  assertPasses('cat <<EOF\n\\$(rm docs/presentation.pptx)\nEOF');
});

test('Bash command substitution honors executable and literal quoting contexts', () => {
  const result = assertBlocked('printf "%s\\n" "$(rm docs/presentation.pptx)"');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
  const backtick = assertBlocked('printf "%s\\n" "`rm docs/presentation.pptx`"');
  assertIncludes(reason(backtick), '.pptx', 'reason mentions .pptx');
  assertPasses("printf '%s\\n' '$(rm docs/presentation.pptx)'");
});

[
  ['function call removes sensitive file', 'cleanup() { rm "docs/presentation.pptx"; }; cleanup'],
  ['for loop removes expanded sensitive file', 'for f in presentation.pptx; do rm "docs/$f"; done'],
  ['brace group redirects over sensitive file', '{ echo replacement; } > docs/report.docx'],
  ['exact case clause removes sensitive file', 'case "x" in x) rm "docs/report.docx";; *) echo noop;; esac'],
  ['double-bracket predicate selects a sensitive delete', 'if [[ docs/report.docx == docs/*.docx ]]; then rm docs/report.docx; fi'],
  ['arithmetic predicate selects a sensitive delete', 'if (( 2 > 1 )); then rm docs/report.docx; fi'],
  ['indexed array element selects a sensitive delete', 'files[2]=docs/report.docx; rm "${files[2]}"'],
  ['associative array value selects a sensitive delete', 'declare -A files; files[target]=docs/report.docx; rm "${files[target]}"'],
  ['quoted array expansion selects every sensitive delete', 'files[0]=docs/report.docx; files[2]=docs/presentation.pptx; rm "${files[@]}"'],
  ['process substitution removes a sensitive file', 'cat <(rm docs/report.docx)'],
  ['command arguments expand before a prefix assignment', 'target=docs/report.docx; target=tmp/safe rm "$target"'],
  ['literal eval removes sensitive file', "eval 'rm docs/report.docx'"],
].forEach(([name, command]) => {
  test(`complicated destructive command is blocked: ${name}`, () => assertBlocked(command));
});

test('literal sourced script is blocked', () => {
  const scriptPath = resolve(rootfs, 'tmp', 'hook-source.sh');
  writeFileSync(scriptPath, 'rm docs/report.docx\n');
  try {
    assertBlocked('source tmp/hook-source.sh');
  } finally {
    cleanup([scriptPath]);
  }
});

test('false double-bracket predicate prunes a sensitive delete', () => {
  assertPasses(
    'if [[ docs/report.docx == "docs/*.docx" ]]; then rm docs/report.docx; fi',
  );
});

test('double-bracket short circuit does not rescan a skipped command substitution', () => {
  assertPasses('[[ -n yes || "$(rm docs/report.docx)" == x ]]');
});

test('evaluated double-bracket command substitution is blocked', () => {
  assertBlocked(`[[ -n "$(bash -c 'rm docs/report.docx')" ]]`);
});

test('false arithmetic predicate prunes a sensitive delete', () => {
  assertPasses('if (( 0 )); then rm docs/report.docx; fi');
});

test('evaluated arithmetic command substitution is blocked', () => {
  assertBlocked(`(( $(bash -c 'rm docs/report.docx') ))`);
});

test('deterministically generated sourced script is blocked', () => {
  assertBlocked(
    "printf '%s\\n' 'rm docs/report.docx' > tmp/generated-hook-source.sh; "
      + 'source tmp/generated-hook-source.sh',
  );
});

[
  ['if branch contains a conditional rm', 'if mystery; then echo skip; else rm "docs/presentation.pptx"; fi'],
  ['unknown case subject conservatively contains a conditional rm', 'case "$(detect_value)" in x) rm "docs/report.docx";; *) echo noop;; esac'],
  ['AND-list contains a conditional rm', '(cd docs && rm report.docx)'],
].forEach(([name, command]) => {
  test(`conditional destructive command is locally risky: ${name}`, () => {
    const local = protectOnPlatform(command, 'bash', process.platform);
    assertEqual(local.decision, 'pass', `${name} local decision`);
    assertEqual(local.severity, 'risky', `${name} local severity`);
    assertEqual(local.analysis.affected?.definitePolicyFileCount ?? 0, 0, `${name} definite files`);
    assertTruthy((local.analysis.affected?.conditionalPolicyFileCount ?? 0) > 0, `${name} conditional files`);
    assertSoftBlocked(command);
  });
});

windowsTest('complicated destructive command is blocked: called function runs pwsh destructive command on Windows', () => {
  assertBlocked('cleanup() { pwsh -Command "Remove-Item docs/presentation.pptx"; }; cleanup');
});

test('existing .pptx is blocked', () => {
  const result = assertBlocked('rm "docs/presentation.pptx"');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

test('existing .docx is blocked', () => {
  const result = assertBlocked('rm "docs/report.docx"');
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

if (!powershellGuardEnabled) {
  test('non-Windows hook does not analyze a direct PowerShell payload', () => {
    assertPasses('Remove-Item docs/presentation.pptx', { toolName: 'PowerShell' });
  });

  test('non-Windows hook does not run the secondary PowerShell analyzer for Bash', () => {
    assertPasses('Remove-Item docs/presentation.pptx');
  });

  test('non-Windows hook skips a nested pwsh invocation', () => {
    assertPasses('pwsh -Command "Remove-Item docs/presentation.pptx"');
  });
}

test('all guard PowerShell entry points are Windows-only', () => {
  const cases = [
    ['direct PowerShell payload', 'Remove-Item docs/presentation.pptx', 'powershell'],
    ['secondary PowerShell fallback', 'Remove-Item docs/presentation.pptx', 'bash'],
    ['nested pwsh invocation', 'pwsh -Command "Remove-Item docs/presentation.pptx"', 'bash'],
  ];

  for (const [name, command, shell] of cases) {
    const nonWindows = protectOnPlatform(command, shell, 'linux');
    assertEqual(nonWindows.analysis.effects?.length ?? 0, 0, `${name} is skipped outside Windows`);
    if (shell === 'powershell') {
      assertEqual(nonWindows.analysis.available, false, `${name} is unavailable outside Windows`);
    }

    const windows = protectOnPlatform(command, shell, 'win32');
    assertEqual(windows.analysis.available, true, `${name} is available on Windows`);
    assertTruthy(
      windows.analysis.effects.some(effect => effect.type === 'delete' && effect.path.endsWith('/docs/presentation.pptx')),
      `${name} enters the PowerShell analyzer on Windows`,
    );
  }
});

test('Bash-only conditional forms do not enter the secondary PowerShell analyzer', () => {
  for (const command of [
    '[[ -n "$(Remove-Item docs/report.docx)" ]]',
    '(( $(Remove-Item docs/report.docx) ))',
  ]) {
    const result = protectOnPlatform(command, 'bash', 'win32');
    assertEqual(result.analysis.effects.length, 0, `${command} remains Bash`);
  }
});

windowsTest('PowerShell -Command destructive item command is blocked on Windows', () => {
  const result = assertBlocked('pwsh -Command "Remove-Item docs/presentation.pptx"');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell -Command through Bash variable is blocked on Windows', () => {
  const result = assertBlocked('PS_CMD="Remove-Item docs/report.docx"; pwsh -Command "$PS_CMD"');
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

windowsTest('PowerShell launched after Bash cd resolves cwd on Windows', () => {
  const result = assertBlocked('cd docs && pwsh -Command "Remove-Item presentation.pptx"');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell launched inside Bash for loop expands loop variable on Windows', () => {
  const result = assertBlocked('for f in presentation.pptx report.docx; do pwsh -Command "Remove-Item docs/$f"; done');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

windowsTest('PowerShell -File inside cwd is analyzed on Windows', () => {
  const scriptPath = resolve(rootfs, 'scripts', 'remove-report.ps1');
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, 'Remove-Item ../docs/report.docx\n');
  try {
    const result = assertBlocked('pwsh -File scripts/remove-report.ps1');
    assertIncludes(reason(result), '.docx', 'reason mentions .docx');
  } finally {
    cleanup([scriptPath]);
  }
});

windowsTest('shell field marks generic shell tool as PowerShell on Windows', () => {
  const result = assertBlocked('Remove-Item docs/presentation.pptx', {
    toolName: 'shell',
    toolInput: { command: 'Remove-Item docs/presentation.pptx', shell: 'pwsh' },
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('inline Bash assignment applies only to the pwsh invocation on Windows', () => {
  const result = assertBlocked('PS_CMD="Remove-Item docs/report.docx" pwsh -Command "$PS_CMD"');
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

windowsTest('inline Bash assignment does not leak into later pwsh invocation on Windows', () => {
  assertPasses('PS_CMD="Remove-Item docs/report.docx" echo safe; pwsh -Command "$PS_CMD"');
});

windowsTest('PowerShell -EncodedCommand destructive item command is blocked on Windows', () => {
  const encoded = 'UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAZABvAGMAcwAvAHIAZQBwAG8AcgB0AC4AZABvAGMAeAA=';
  const result = assertBlocked(`pwsh -EncodedCommand ${encoded}`);
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

windowsTest('direct PowerShell tool payload is blocked on Windows', () => {
  const result = assertBlocked('Remove-Item docs/presentation.pptx', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('direct PowerShell here-string command text remains data on Windows', () => {
  assertPasses('$text = @"\nRemove-Item docs/presentation.pptx\n"@\nWrite-Output $text', {
    toolName: 'PowerShell',
  });
});

windowsTest('Invoke-Expression executes a command stored in a PowerShell here-string on Windows', () => {
  const result = assertBlocked("$script = @'\nRemove-Item docs/presentation.pptx\n'@\nInvoke-Expression $script", {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell block-comment command text remains data on Windows', () => {
  assertPasses('<#\nRemove-Item docs/presentation.pptx\n#>\nWrite-Output ok', {
    toolName: 'PowerShell',
  });
});

windowsTest('PowerShell -WhatIf does not block an operation that will not execute on Windows', () => {
  assertPasses('Remove-Item docs/presentation.pptx -WhatIf', {
    toolName: 'PowerShell',
  });
  const result = assertBlocked('Remove-Item docs/presentation.pptx -WhatIf:$false', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell here-string path excludes the closing newline on Windows', () => {
  const result = assertBlocked('$path = @"\ndocs/presentation.pptx\n"@\nRemove-Item $path', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell expandable here-string subexpressions are analyzed on Windows', () => {
  const result = assertBlocked('$text = @"\n$(Remove-Item docs/presentation.pptx)\n"@\nWrite-Output $text', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('Bash tool payload is conservatively checked as PowerShell on Windows', () => {
  const result = assertBlocked('Remove-Item docs/presentation.pptx', {
    hookPath: guard,
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

test('Bash shell-project safe fixture keeps destructive-looking heredoc text as data', () => {
  const command = readShellProjectFixture('bash', 'safe');
  const local = protectOnPlatform(command, 'bash', 'linux');
  assertEqual(local.decision, 'pass', 'safe Bash project decision');
  assertEqual(local.severity, 'safe', 'safe Bash project severity');
  assertEqual(local.analysis.resourceEffects?.length ?? 0, 0, 'preview commands emit no resource effects');
  assertTruthy(
    local.analysis.effects.some(effect => effect.type === 'write' && effect.path.endsWith('/tmp/bash-project-plan.txt')),
    'safe Bash project retains its new-file redirect',
  );
  assertPasses(command);
});

test('Bash shell-project destructive fixture retains function loop and branch deletes', () => {
  const command = readShellProjectFixture('bash', 'destructive');
  const local = protectOnPlatform(command, 'bash', 'linux', { RUN_CLEANUP: '1' });
  assertEqual(local.decision, 'stop', 'destructive Bash project decision');
  assertEqual(local.severity, 'critical', 'destructive Bash project severity');
  assertTruthy(
    local.analysis.effects.some(effect => effect.type === 'delete' && effect.path.endsWith('/docs/presentation.pptx')),
    'Bash project retains the pptx delete',
  );
  assertTruthy(
    local.analysis.effects.some(effect => effect.type === 'delete' && effect.path.endsWith('/docs/report.docx')),
    'Bash project retains the docx delete',
  );
  assertEqual(local.analysis.affected?.definitePolicyFileCount ?? 0, 2, 'known environment selects the cleanup branch');
  assertEqual(local.analysis.affected?.conditionalPolicyFileCount ?? 0, 0, 'known environment avoids branch uncertainty');
  assertBlocked(command, { env: { RUN_CLEANUP: '1' } });
});

test('PowerShell shell-project safe fixture keeps here-string text and WhatIf non-executing', () => {
  const command = readShellProjectFixture('powershell', 'safe');
  const local = protectOnPlatform(command, 'powershell', 'win32');
  assertEqual(local.decision, 'pass', 'safe PowerShell project decision');
  assertEqual(local.severity, 'safe', 'safe PowerShell project severity');
  assertTruthy(
    local.analysis.effects.some(effect => effect.type === 'write' && effect.path.endsWith('/tmp/powershell-project-status.txt')),
    'safe PowerShell project retains the no-clobber new-file write',
  );
  assertTruthy(
    !local.analysis.effects.some(effect => effect.type === 'delete'),
    'PowerShell WhatIf and here-string data emit no delete',
  );
  assertPasses(command, { toolName: 'PowerShell', platform: 'win32' });
});

test('PowerShell shell-project destructive fixture resolves pipeline objects to concrete files', () => {
  const command = readShellProjectFixture('powershell', 'destructive');
  const local = protectOnPlatform(command, 'powershell', 'win32');
  assertEqual(local.decision, 'pass', 'destructive PowerShell project decision');
  assertEqual(local.severity, 'risky', 'destructive PowerShell project severity');
  assertTruthy(
    local.analysis.effects.some(effect => effect.type === 'delete' && effect.path.endsWith('/docs/presentation.pptx')),
    'PowerShell project retains the concrete pipeline delete',
  );
  assertEqual(local.analysis.affected?.definitePolicyFileCount ?? 0, 0, 'pipeline loop remains conditional');
  assertEqual(local.analysis.affected?.conditionalPolicyFileCount ?? 0, 1, 'pipeline file retains metadata');
  assertSoftBlocked(command, { toolName: 'PowerShell', platform: 'win32' });
});

test('Bash -c nested shell command is blocked', () => {
  const result = assertBlocked('bash -c "rm docs/presentation.pptx"');
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

test('sudo env command wrappers around Bash are blocked', () => {
  const result = assertBlocked('sudo env FOO=1 bash -c "rm docs/report.docx"');
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

const pathQualifiedWrapperExecutionForms = [
  '/bin/rm docs/report.docx',
  '/usr/bin/env rm docs/report.docx',
];

const definiteWrapperExecutionForms = [
  'env FOO=1 rm docs/report.docx',
  'command rm docs/report.docx',
  'exec rm docs/report.docx',
  'nohup rm docs/report.docx',
  'sudo rm docs/report.docx',
  'sudo -u root rm docs/report.docx',
  'sudo -- env FOO=1 bash -c "rm docs/report.docx"',
  'env -C docs bash -c "rm report.docx"',
  "env TARGET=docs/report.docx bash -c 'rm \"$TARGET\"'",
  'sudo env command rm docs/report.docx',
];

const wrapperOperandTraps = [
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
  'bash -c rm docs/report.docx',
];

test('protect keeps definite wrapper severity equivalent to bare rm', () => {
  const baseline = protectOnPlatform('rm docs/report.docx', 'bash', process.platform);
  assertEqual(baseline.decision, 'stop', 'bare rm local decision');
  for (const command of definiteWrapperExecutionForms) {
    const result = protectOnPlatform(command, 'bash', process.platform);
    assertEqual(result.decision, baseline.decision, `${command} local decision`);
    assertEqual(result.severity, baseline.severity, `${command} local severity`);
  }
});

test('path-qualified command identities retain conditional file statistics', () => {
  for (const command of pathQualifiedWrapperExecutionForms) {
    const result = protectOnPlatform(command, 'bash', process.platform);
    assertEqual(result.decision, 'pass', `${command} local decision`);
    assertEqual(result.severity, 'risky', `${command} local severity`);
    assertEqual(
      result.analysis.affected?.conditionalPolicyFileCount ?? 0,
      1,
      `${command} conditional affected-file count`,
    );
    assertEqual(directReasons(result).length, 0, `${command} direct-risk count`);
    assertSoftBlocked(command);
  }
});

test('built hook blocks every definite supported wrapper execution form', () => {
  for (const command of definiteWrapperExecutionForms) assertBlocked(command);
});

test('protect and built hook pass every wrapper option-operand trap', () => {
  for (const command of wrapperOperandTraps) {
    const result = protectOnPlatform(command, 'bash', process.platform);
    assertEqual(result.decision, 'pass', `${command} local decision`);
    assertPasses(command);
  }
});

test('wrapper execution and operand binding remain stable on the Windows guard route', () => {
  for (const command of [
    'sudo -u root rm docs/report.docx',
    'env -C docs bash -lc "rm report.docx"',
  ]) {
    assertEqual(protectOnPlatform(command, 'bash', 'win32').decision, 'stop', `${command} Windows decision`);
    assertBlocked(command, { platform: 'win32' });
  }
  for (const command of ['sudo -u rm echo safe', 'command -v rm', 'bash -c rm docs/report.docx']) {
    assertEqual(protectOnPlatform(command, 'bash', 'win32').decision, 'pass', `${command} Windows decision`);
    assertPasses(command, { platform: 'win32' });
  }
});

test('env -i child shells do not inherit hook-process variables', () => {
  assertPasses("env -i bash -c 'rm -rf \"$TARGET\"'", {
    env: { TARGET: 'docs/report.docx' },
  });
});

test('protect and built hook preserve function precedence and explicit bypass', () => {
  const safe = 'rm() { echo safe; }; rm docs/report.docx';
  assertEqual(protectOnPlatform(safe, 'bash', process.platform).decision, 'pass', 'shadowing function decision');
  assertPasses(safe);

  for (const command of [
    'cat() { rm docs/report.docx; }; cat',
    'rm() { echo safe; }; command rm docs/report.docx',
    'rm() { echo safe; }; env rm docs/report.docx',
  ]) {
    assertEqual(protectOnPlatform(command, 'bash', process.platform).decision, 'stop', `${command} local decision`);
    assertBlocked(command);
  }
});

windowsTest('PowerShell launching Bash is blocked on Windows', () => {
  const result = assertBlocked('bash -c "rm docs/report.docx"', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

windowsTest('PowerShell pipeline object FullName is blocked on Windows', () => {
  const result = assertBlocked('Get-ChildItem docs/*.pptx | ForEach-Object { Remove-Item $_.FullName }', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.pptx', 'reason mentions .pptx');
});

windowsTest('PowerShell Start-Process launching Bash is blocked on Windows', () => {
  const result = assertBlocked('Start-Process bash -ArgumentList "-c","rm docs/report.docx"', {
    toolName: 'PowerShell',
  });
  assertIncludes(reason(result), '.docx', 'reason mentions .docx');
});

test('npm run script body retains conditional file statistics', () => {
  const packagePath = resolve(rootfs, 'package.json');
  writeFileSync(packagePath, JSON.stringify({ scripts: { clean: 'rm docs/presentation.pptx' } }));
  try {
    const local = protectOnPlatform('npm run clean', 'bash', process.platform);
    assertEqual(local.severity, 'risky', 'package script local severity');
    assertEqual(local.decision, 'pass', 'package script local decision');
    assertEqual(local.analysis.affected?.conditionalPolicyFileCount ?? 0, 1, 'package script affected count');
    assertSoftBlocked('npm run clean');
  } finally {
    cleanup([packagePath]);
  }
});

test('glob over sensitive .jpg files is blocked', () => {
  const result = assertBlocked('rm photos/*.jpg');
  assertIncludes(reason(result), '.jpg', 'reason mentions .jpg');
});

test('rm -rf on dir with .jpg is blocked', () => {
  const result = assertBlocked('rm -rf photos');
  const detail = reason(result);
  assertIncludes(detail, '.jpg', 'reason mentions .jpg');
  assertIncludes(detail, 'Affected files found on disk: 3, total size 33 B', 'reason reports affected count and size');
  assertIncludes(detail, 'Extension .jpg: 3 files, total size 33 B', 'reason reports extension count');
  assertAffectedFileMetadata(detail, 'photo1.jpg', '11 B');
  assertAffectedFileMetadata(detail, 'photo2.jpg', '11 B');
  assertAffectedFileMetadata(detail, 'photo3.jpg', '11 B');
});

test('missing .pptx passes because nothing is on disk', () => assertPasses('rm does-not-exist.pptx'));
test('missing .jpg passes because nothing is on disk', () => assertPasses('rm ghost.jpg'));

test('fresh .txt is not a local critical stop', () => {
  const path = resolve(rootfs, 'tmp', 'fresh-note.txt');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'temporary note');
  try {
    assertPasses('rm "tmp/fresh-note.txt"');
  } finally {
    cleanup([path]);
  }
});
test('risky rsync delete is blocked when cloud review is disabled', () => assertSoftBlocked('rsync -a --delete src/ mirror/'));

test('non-executing command modes are locally safe and pass the hook', () => {
  const commands = [
    'git clean -nfdx',
    'git clean --dry-run -d -x',
    'git clean --help -fdx',
    'git clean -x -X',
    'git clean -e',
    'git reset',
    'git reset --mixed',
    'git reset --soft HEAD~1',
    'git reset -- file',
    'git reset HEAD -- file',
    'git reset -p -- file',
    'git reset -- --hard',
    'git reset HEAD -- --hard',
    'git reset --pathspec-from-file --hard',
    'git reset --hard --soft',
    'git reset --help --hard',
    'git reset --hard HEAD -- file',
    'git reset --hard -- --hard',
    'git --bare reset --hard',
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
    'find . -exec echo -delete \\;',
    'xargs --help rm',
    'xargs -I rm echo safe',
    'xargs --replace=rm echo safe',
    'xargs rm --help',
    'make -n clean',
    'make --dry-run clean',
    'make -q clean',
    'make -t clean',
    'make -C sub -n clean',
    'make -C clean build',
    'make -f custom:clean build',
    'make --eval clean build',
    'docker compose down',
    'docker compose down -v --help',
    'kubectl delete pod x --help',
    'kubectl delete',
    'kubectl delete --namespace ns',
    'kubectl delete pod',
    'kubectl apply',
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
    'tar --group -x -f archive.tar',
    'tar -xf',
    'tar --extract --file',
    'tar --help -xf archive.tar',
    'unzip -l archive.zip',
    'unzip -t archive.zip',
    'unzip -p archive.zip file',
    'unzip -Z archive.zip',
    'unzip -h archive.zip',
    'unzip -P -l archive.zip',
    'unzip -- -l',
    'bash -c "rmdir docs"',
  ];
  for (const command of commands) {
    const local = protectOnPlatform(command, 'bash', 'linux');
    assertEqual(local.decision, 'pass', `${command} local decision`);
    assertEqual(local.severity, 'safe', `${command} local severity`);
    assertEqual(local.analysis.effects?.length ?? 0, 0, `${command} destructive effects`);
    assertEqual(local.analysis.resourceEffects?.length ?? 0, 0, `${command} resource effects`);
    assertEqual(local.analysis.affected?.totalFileCount ?? 0, 0, `${command} affected file count`);
    assertPasses(command);
  }
});

test('git reset uses typed state effects and offline mode blocks the risky local result', () => {
  const result = protectOnPlatform('git reset --hard --recurse-submodules', 'bash', 'linux');
  assertEqual(result.decision, 'pass', 'hard reset local decision');
  assertEqual(result.severity, 'risky', 'hard reset local severity');
  assertEqual(result.analysis.effects?.length ?? 0, 0, 'hard reset has no filesystem effect');
  assertEqual(result.analysis.gitEffects?.length ?? 0, 4, 'hard reset has typed Git effects');
  assertTruthy(result.analysis.gitEffects.some(effect => effect.domain === 'worktree' && effect.operation === 'discard'));
  assertTruthy(result.analysis.gitEffects.some(effect => effect.domain === 'submodule'));
  assertEqual(
    JSON.stringify(result.reasonCodes),
    JSON.stringify([riskReasonCodes.GIT_WORKTREE_DISCARD]),
    'hard reset has one stable reason code',
  );
  assertEqual(result.reasons, undefined, 'local result omits complex reasons');
  assertTruthy(!JSON.stringify(result.analysis).includes('<git-tracked-files>'));
  assertSoftBlocked('git reset --hard --recurse-submodules');
});

test('typed Git effects are bounded in the actual cloud review request', async () => {
  const { protect, trimAnalysisForWire } = require(guard);
  const command = Array.from({ length: 60 }, (_, index) => `git -C repo-${index} reset --hard`).join('; ');
  const result = protect(command, rootfs, 'bash');
  assertTruthy(result.analysis.gitEffects.length > 50, 'fixture produces more than the wire cap');
  const trimmed = trimAnalysisForWire(result.analysis);
  assertEqual(trimmed.gitEffects.length, 50, 'wire Git effect cap');
  assertEqual(trimmed.gitEffectsTruncated, true, 'wire Git truncation marker');
  assertEqual(trimmed.gitEffectsTotal, result.analysis.gitEffectsTotal, 'total count remains visible');

  await withReviewServer({ decision: 'pass' }, async (url, requests) => {
    await protectWithReview(command, {
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertEqual(requests.length, 1, 'cloud review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.command, command, 'wire command');
    assertEqual(payload.severity, 'risky', 'wire severity');
    assertEqual(payload.analysis.gitEffects.length, 50, 'HTTP payload Git effect cap');
    assertEqual(payload.analysis.gitEffectsTruncated, true, 'HTTP payload Git truncation marker');
    assertEqual(payload.analysis.gitEffectsTotal, result.analysis.gitEffectsTotal, 'HTTP payload Git total');
    assertEqual(
      JSON.stringify(payload.reasonCodes),
      JSON.stringify([riskReasonCodes.GIT_WORKTREE_DISCARD]),
      'HTTP payload Git reason code',
    );
    assertEqual(payload.reasons, undefined, 'HTTP payload omits complex reasons');
  });
});

test('typed resource effects are bounded in the actual cloud review request', async () => {
  const { protect, trimAnalysisForWire } = require(guard);
  const command = Array.from({ length: 60 }, (_, index) => `find src-${index} -delete`).join('; ');
  const result = protect(command, rootfs, 'bash');
  assertTruthy(result.analysis.resourceEffects.length > 50, 'fixture produces more than the wire cap');
  assertEqual(
    JSON.stringify(result.reasonCodes),
    JSON.stringify([riskReasonCodes.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION]),
    'repeated facts collapse to one reason code',
  );
  assertEqual(result.analysis.effects.length, 0, 'derived selections stay out of file effects');
  const trimmed = trimAnalysisForWire(result.analysis);
  assertEqual(trimmed.resourceEffects.length, 50, 'wire resource effect cap');
  assertEqual(trimmed.resourceEffectsTruncated, true, 'wire resource truncation marker');
  assertEqual(trimmed.resourceEffectsTotal, result.analysis.resourceEffectsTotal, 'total count remains visible');

  await withReviewServer({ decision: 'pass' }, async (url, requests) => {
    await protectWithReview(command, {
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertEqual(requests.length, 1, 'cloud review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.command, command, 'wire command');
    assertEqual(payload.severity, 'risky', 'wire severity');
    assertEqual(payload.analysis.effects.length, 0, 'HTTP payload has no invented file effects');
    assertEqual(payload.analysis.resourceEffects.length, 50, 'HTTP payload resource effect cap');
    assertEqual(payload.analysis.resourceEffectsTruncated, true, 'HTTP payload resource truncation marker');
    assertEqual(payload.analysis.resourceEffectsTotal, result.analysis.resourceEffectsTotal, 'HTTP payload resource total');
    assertEqual(
      JSON.stringify(payload.reasonCodes),
      JSON.stringify(result.reasonCodes),
      'HTTP payload carries the deduplicated numeric reason-code set',
    );
    assertEqual(payload.reasons, undefined, 'HTTP payload omits complex reasons');
  });
});

test('executing counterparts retain local risk and hook behavior', () => {
  const cases = [
    ['git clean -fdx', 'risky', 'pass'],
    ['git clean -n --no-dry-run -fdx', 'risky', 'pass'],
    ['git clean -- --dry-run', 'risky', 'pass'],
    ['git clean -e -n -fdx', 'risky', 'pass'],
    ['git clean --exclude --dry-run -fdx', 'risky', 'pass'],
    ['git reset --hard', 'risky', 'pass'],
    ['git reset --har', 'risky', 'pass'],
    ['git reset --merge', 'risky', 'pass'],
    ['git reset --keep', 'risky', 'pass'],
    ['git reset --hard --recurse-submodules', 'risky', 'pass'],
    ['git reset --pathspec-from-file=list --no-pathspec-from-file --hard', 'risky', 'pass'],
    ['command /usr/bin/git -C repo -C nested reset --hard', 'risky', 'pass'],
    ['rsync -a --delete src/ dst/', 'risky', 'pass'],
    ['rsync -T -n -a --delete src/ dst/', 'risky', 'pass'],
    ['rsync --temp-dir --dry-run -a --delete src/ dst/', 'risky', 'pass'],
    ['find src -delete', 'risky', 'pass'],
    ['xargs rm -f', 'risky', 'pass'],
    ['make clean', 'risky', 'pass'],
    ['make -C -n clean', 'risky', 'pass'],
    ['make -Onone clean', 'risky', 'pass'],
    ['docker compose down -v', 'risky', 'pass'],
    ['kubectl --context dev delete pod x', 'risky', 'pass'],
    ['kubectl delete pod x --dry-run=none', 'risky', 'pass'],
    ['kubectl delete pod x --dry-run=false', 'risky', 'pass'],
    ['kubectl delete pod x --dry-run=0', 'risky', 'pass'],
    ['kubectl delete pod x --dry-run=client --dry-run=none', 'risky', 'pass'],
    ['kubectl delete pod x -- --dry-run=client', 'risky', 'pass'],
    ['kubectl delete -f --dry-run=client', 'risky', 'pass'],
    ['kubectl delete --context --dry-run=server pod x', 'risky', 'pass'],
    ['kubectl -s --dry-run=server delete pod x', 'risky', 'pass'],
    ['helm uninstall rel', 'risky', 'pass'],
    ['terraform destroy', 'risky', 'pass'],
    ['kubectl apply -f --dry-run=client', 'risky', 'pass'],
    ['kubectl apply --field-manager --dry-run=server -f manifest.yaml', 'risky', 'pass'],
    ['tar -xf archive.tar', 'risky', 'pass'],
    ['tar --group -t -xf archive.tar', 'risky', 'pass'],
    ['unzip archive.zip', 'risky', 'pass'],
    ['unzip archive.zip -l', 'risky', 'pass'],
    ['unzip -P-l archive.zip', 'risky', 'pass'],
    ['unzip -l-l archive.zip', 'risky', 'pass'],
    ['unzip -- -l archive.zip', 'risky', 'pass'],
    ['rm -rf docs', 'critical', 'stop'],
  ];
  for (const [command, severity, decision] of cases) {
    const local = protectOnPlatform(command, 'bash', 'linux');
    assertEqual(local.severity, severity, `${command} local severity`);
    assertEqual(local.decision, decision, `${command} local decision`);
    assertTruthy(
      (local.analysis.effects?.length ?? 0)
        + (local.analysis.gitEffects?.length ?? 0)
        + (local.analysis.resourceEffects?.length ?? 0) > 0,
      `${command} retains effects`,
    );
  }

  for (const command of [
    'git clean -fdx',
    'git clean -e -n -fdx',
    'git clean --exclude --dry-run -fdx',
    'git reset --hard',
    'git reset --har',
    'git reset --merge',
    'git reset --keep',
    'command /usr/bin/git -C repo -C nested reset --hard',
    'find src -delete',
    'xargs rm -f',
    'make clean',
    'docker compose down -v',
    'kubectl --context dev delete pod x',
    'kubectl delete pod x --dry-run=none',
    'kubectl delete pod x --dry-run=false',
    'kubectl delete pod x --dry-run=0',
    'kubectl delete -f --dry-run=client',
    'kubectl delete --context --dry-run=server pod x',
    'kubectl -s --dry-run=server delete pod x',
    'helm uninstall rel',
    'terraform destroy',
    'kubectl apply -f --dry-run=client',
    'kubectl apply --field-manager --dry-run=server -f manifest.yaml',
    'rsync -a --delete src/ dst/',
    'rsync -T -n -a --delete src/ dst/',
    'rsync --temp-dir --dry-run -a --delete src/ dst/',
    'tar -xf archive.tar',
    'tar --group -t -xf archive.tar',
    'unzip archive.zip',
    'unzip archive.zip -l',
    'unzip -P-l archive.zip',
    'unzip -l-l archive.zip',
    'unzip -- -l archive.zip',
  ]) {
    assertSoftBlocked(command);
  }
});

test('PowerShell no-clobber and append modes are safe through the Windows hook route', () => {
  const cases = [
    ['"x" | Out-File -FilePath docs/presentation.pptx -NoClobber', []],
    ['"x" | Out-File -FilePath docs/presentation.pptx -NoClobber:$true', []],
    ['"x" | Out-File -FilePath docs/presentation.pptx -NoOverwrite', []],
    ['"x" | Out-File -FilePath docs/presentation.pptx -NoClobber -Force', []],
    ['Export-Csv -Path docs/presentation.pptx -NoClobber', []],
    ['"x" | Out-File -FilePath docs/presentation.pptx -Append', ['append']],
    ['Export-Csv -Path docs/presentation.pptx -Append', ['append']],
    ['"x" | Out-File -FilePath docs/presentation.pptx -Append -NoClobber', ['append']],
    ['"x" | Out-File -FilePath tmp/new-no-clobber.pptx -NoClobber', ['write']],
  ];
  for (const [command, effectTypes] of cases) {
    const local = protectOnPlatform(command, 'powershell', 'win32');
    assertEqual(local.decision, 'pass', `${command} local decision`);
    assertEqual(local.severity, 'safe', `${command} local severity`);
    assertEqual(JSON.stringify(local.analysis.effects.map(effect => effect.type)), JSON.stringify(effectTypes), `${command} effects`);
    assertEqual(local.analysis.affected?.totalFileCount ?? 0, 0, `${command} overwrite enumeration`);
    assertPasses(command, { toolName: 'PowerShell', platform: 'win32' });
  }
});

test('PowerShell overwrite counterparts remain blocked through the Windows hook route', () => {
  const commands = [
    '"x" | Out-File -FilePath docs/presentation.pptx',
    'Export-Csv -Path docs/presentation.pptx',
    '"x" | Out-File -FilePath docs/presentation.pptx -NoClobber:$false',
    'Export-Csv -Path docs/presentation.pptx -Append:$false',
  ];
  for (const command of commands) {
    const local = protectOnPlatform(command, 'powershell', 'win32');
    assertEqual(local.decision, 'stop', `${command} local decision`);
    assertEqual(local.severity, 'critical', `${command} local severity`);
    assertTruthy(local.analysis.effects.some(effect => effect.type === 'write'), `${command} retains overwrite effect`);
    assertBlocked(command, { toolName: 'PowerShell', platform: 'win32' });
  }
});

test('cloud review can block a locally risky command', async () => {
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    const result = await assertSoftBlockedAsync('rsync -a --delete src/ mirror/', {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertIncludes(reason(result), 'Could not enumerate a destructive local target', 'reason names opaque selection');
    assertEqual(requests.length, 1, 'cloud review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.command, 'rsync -a --delete src/ mirror/', 'cloud review command');
    assertEqual(payload.cwd, rootfs, 'cloud review cwd');
    assertEqual(payload.shell, 'bash', 'cloud review shell');
    assertEqual(payload.severity, 'risky', 'cloud review severity');
  });
});

test('cloud review blocks path-qualified commands from their conditional statistics', async () => {
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    for (const command of pathQualifiedWrapperExecutionForms) {
      await assertSoftBlockedAsync(command, {
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
    }
    assertEqual(requests.length, pathQualifiedWrapperExecutionForms.length, 'path-qualified review request count');
    for (const request of requests) {
      const payload = decodeReviewRequest(request);
      assertEqual(payload.severity, 'risky', 'path-qualified wire severity');
      assertEqual(
        payload.reasonCodes.some(code => directReasonCodeSet.has(code)),
        false,
        'path-qualified command identity does not become a direct risk',
      );
      assertEqual(
        payload.analysis.affected.conditionalPolicyFileCount,
        1,
        'path-qualified wire conditional file count',
      );
    }
  });
});

test('cloud block for conditional local data loss reports bounded file statistics', async () => {
  const command = 'if test -n "$MAYBE"; then rm docs/presentation.pptx; fi';
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    const result = await assertSoftBlockedAsync(command, {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    const detail = reason(result);
    assertIncludes(detail, 'Affected files found on disk: 1, total size 23 B', 'block reports affected count and size');
    assertIncludes(detail, 'Extension .pptx: 1 file, total size 23 B', 'block reports extension');
    assertAffectedFileMetadata(detail, 'presentation.pptx', '23 B');
    assertIncludes(detail, 'operations delete-entry, conditional', 'block reports operation certainty');

    assertEqual(requests.length, 1, 'conditional review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.severity, 'risky', 'conditional wire severity');
    assertEqual(
      payload.reasonCodes.some(code => directReasonCodeSet.has(code)),
      false,
      'conditional statistics do not become direct risks',
    );
    assertEqual(payload.analysis.affected.policyFileCount, 1, 'wire policy file count');
    assertEqual(payload.analysis.affected.policyTotalSize, 23, 'wire policy total size');
    assertEqual(payload.analysis.affected.conditionalPolicyFileCount, 1, 'conditional wire file count');
    assertEqual(payload.analysis.affected.conditionalPolicyTotalSize, 23, 'conditional wire total size');
    assertEqual(payload.analysis.affected.definitePolicyFileCount, 0, 'conditional wire definite count');
    assertEqual(payload.analysis.affected.definitePolicyTotalSize, 0, 'conditional wire definite size');
    assertEqual(payload.analysis.affected.visitedEntries, undefined, 'wire omits local visit diagnostics');
    assertEqual(payload.analysis.affected.maxDepthReached, undefined, 'wire omits local depth diagnostics');
    assertEqual(payload.analysis.affected.policyOldest, undefined, 'wire does not add policy sample arrays');
    assertEqual(payload.analysis.affected.definitePolicyOldest, undefined, 'wire does not add certainty sample arrays');
    assertEqual(
      JSON.stringify(payload.analysis.affected.specialTargets),
      JSON.stringify([]),
      'wire keeps the special-target fact channel',
    );
    assertEqual(
      JSON.stringify(payload.analysis.affected.metadataUnavailable),
      JSON.stringify([]),
      'wire keeps the metadata-unavailable fact channel',
    );
    const wireGroup = payload.analysis.affected.groups[0];
    assertEqual(wireGroup.policyCount, undefined, 'wire groups retain their legacy shape');
    assertEqual(wireGroup.policyFiles, undefined, 'wire does not add group sample arrays');
    const wireFile = wireGroup.files[0];
    assertEqual(wireFile.modifiedAt, undefined, 'wire samples omit modification time');
    assertEqual(wireFile.operations, undefined, 'wire samples omit local operation labels');
    assertEqual(wireFile.executionCertainty, undefined, 'wire samples omit local certainty labels');
    assertEqual(wireFile.disposable, undefined, 'wire samples omit local policy labels');
    assertEqual(payload.reasons, undefined, 'wire omits complex reason objects');
    assertTruthy(payload.reasonCodes.every(Number.isInteger), 'wire reason codes are numeric');
  });
});

test('cloud payload strips normalized replacement semantics from file effects', async () => {
  const command = 'cp -f source.bin docs/presentation.pptx';
  await withReviewServer({ decision: 'stop' }, async (url, requests) => {
    await assertBlockedAsync(command, {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertEqual(requests.length, 1, 'replacement review request count');
    const payload = decodeReviewRequest(requests[0]);
    const effect = payload.analysis.effects.find(item => item.type === 'copy');
    assertTruthy(effect, 'wire retains the copy effect');
    assertEqual(effect.replacement, undefined, 'wire omits analyzer-only replacement semantics');
    assertEqual(effect.provenance, undefined, 'wire omits local effect provenance');
    assertEqual(payload.analysis.provenance, undefined, 'wire omits the local provenance graph');
  });
});

test('cloud payload never includes sourced-file warning details', async () => {
  const secret = 'do-not-upload-source-warning-token';
  const scriptPath = resolve(rootfs, 'tmp', 'cloud-source-warning.sh');
  const command = 'source tmp/cloud-source-warning.sh';
  writeFileSync(
    scriptPath,
    `bash --${secret}\nrm docs/report.docx\n`,
  );
  try {
    await withReviewServer({ decision: 'stop' }, async (url, requests) => {
      await assertBlockedAsync(command, {
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
      assertEqual(requests.length, 1, 'source review request count');
      const payload = decodeReviewRequest(requests[0]);
      assertTruthy(
        payload.analysis.warnings.some(warning =>
          warning.includes('source') && warning.includes('details omitted')),
        'wire warning uses a source summary',
      );
      assertTruthy(
        !JSON.stringify(payload).includes(secret),
        'wire payload omits sourced-file warning tokens',
      );
    });
  } finally {
    cleanup([scriptPath]);
  }
});

test('direct catastrophic review uploads only a numeric code and analysis facts', async () => {
  const command = 'rm -rf /';
  await withReviewServer({ decision: 'stop' }, async (url, requests) => {
    await assertBlockedAsync(command, {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertEqual(requests.length, 1, 'catastrophic review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(
      JSON.stringify(payload.reasonCodes),
      JSON.stringify([riskReasonCodes.CATASTROPHIC_ROOT_DESTRUCTION]),
      'catastrophic reason code',
    );
    assertEqual(payload.analysis.effects[0].path, '/', 'catastrophic path remains an analysis fact');
    assertEqual(payload.reasons, undefined, 'request omits complex reason objects');
    assertEqual(payload.directRisks, undefined, 'request envelope remains unchanged');
    assertEqual(
      JSON.stringify(Object.keys(payload).sort()),
      JSON.stringify([
        'analysis',
        'command',
        'conversation_id',
        'cwd',
        'platform',
        'reasonCodes',
        'severity',
        'shell',
        'version',
      ]),
      'cloud request uses the numeric reason-code field',
    );
  });
});

test('cloud review authority is unchanged for a locally risky hard reset', async () => {
  await withReviewServer({ decision: 'stop' }, async (url, requests) => {
    const result = await assertBlockedAsync('git reset --hard', {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertIncludes(reason(result), 'hard reset', 'reason describes potential Git reset risk');
    assertEqual(requests.length, 1, 'cloud review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertTruthy(payload.analysis.gitEffects.length > 0, 'cloud review includes typed Git effects');
    assertTruthy(
      payload.analysis.gitEffects.every(effect => effect.provenance === undefined),
      'cloud review omits local Git provenance',
    );
    assertEqual(payload.analysis.effects.length, 0, 'Git state stays out of file effects on the wire');
  });
});

test('Bash and PowerShell shell-project fixtures preserve the selected shell in cloud review', async () => {
  const cases = [
    {
      name: 'Bash',
      command: readShellProjectFixture('bash', 'destructive'),
      options: {},
      env: { RUN_CLEANUP: '1' },
      shell: 'bash',
      platform: process.platform,
    },
    {
      name: 'PowerShell',
      command: readShellProjectFixture('powershell', 'destructive'),
      options: { toolName: 'PowerShell', platform: 'win32' },
      env: {},
      shell: 'powershell',
      platform: 'win32',
    },
  ];

  await withReviewServer({ decision: 'pass' }, async (url, requests) => {
    for (const fixture of cases) {
      await assertPassesAsync(fixture.command, {
        ...fixture.options,
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
          ...fixture.env,
        },
      });
    }
    assertEqual(requests.length, cases.length, 'cross-shell cloud review request count');
    for (let i = 0; i < cases.length; i++) {
      const fixture = cases[i];
      const payload = decodeReviewRequest(requests[i]);
      assertEqual(payload.command, fixture.command, `${fixture.name} wire command`);
      assertEqual(payload.shell, fixture.shell, `${fixture.name} wire shell`);
      assertEqual(payload.platform, fixture.platform, `${fixture.name} wire platform`);
      assertEqual(payload.severity, fixture.name === 'Bash' ? 'critical' : 'risky', `${fixture.name} wire severity`);
      assertEqual(
        payload.reasonCodes.some(code => directReasonCodeSet.has(code)),
        false,
        `${fixture.name} uses statistical rather than direct risk`,
      );
      assertTruthy(payload.analysis.effects.some(effect => effect.type === 'delete'), `${fixture.name} wire delete effect`);
      if (fixture.name === 'Bash') {
        assertTruthy(
          (payload.analysis.affected?.definitePolicyFileCount ?? 0) > 0,
          `${fixture.name} wire definite affected-file count`,
        );
      } else {
        assertTruthy(
          (payload.analysis.affected?.conditionalPolicyFileCount ?? 0) > 0,
          `${fixture.name} wire conditional affected-file count`,
        );
      }
    }
  });
});

test('each migrated non-exact destructive operation reaches cloud review exactly once', async () => {
  const cases = [
    ['git clean -fdx', 'git-worktree', 'delete'],
    ['find src -delete', 'local-filesystem-selection', 'delete'],
    ['xargs rm -f', 'local-filesystem-selection', 'delete'],
    ['make clean', 'local-filesystem-selection', 'delete'],
    ['docker compose down -v', 'docker-volume', 'delete'],
    ['kubectl delete pod app', 'kubernetes', 'delete'],
    ['helm uninstall rel', 'helm', 'uninstall'],
    ['terraform destroy', 'terraform', 'destroy'],
  ];
  await withReviewServer({ decision: 'stop' }, async (url, requests) => {
    for (let i = 0; i < cases.length; i++) {
      const [command, domain, operation] = cases[i];
      await assertBlockedAsync(command, {
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
      assertEqual(requests.length, i + 1, `${command} cloud review request count`);
      const payload = decodeReviewRequest(requests[i]);
      assertEqual(payload.version, '1.0.0', `${command} wire version`);
      assertEqual(payload.platform, process.platform, `${command} wire platform`);
      assertEqual(payload.cwd, rootfs, `${command} wire cwd`);
      assertEqual(payload.command, command, `${command} wire command`);
      assertEqual(payload.shell, 'bash', `${command} wire shell`);
      assertEqual(payload.severity, 'risky', `${command} wire severity`);
      assertTruthy(payload.reasonCodes.length > 0, `${command} wire reason codes`);
      assertTruthy(payload.reasonCodes.every(Number.isInteger), `${command} numeric reason codes`);
      assertEqual(payload.reasons, undefined, `${command} omits complex reasons`);
      assertEqual(payload.analysis.effects.length, 0, `${command} has no synthetic file effects`);
      assertTruthy(
        payload.analysis.resourceEffects.some(effect => effect.domain === domain && effect.operation === operation),
        `${command} wire resource effect`,
      );
      assertTruthy(
        payload.analysis.resourceEffects.every(effect => effect.provenance === undefined),
        `${command} omits local resource provenance`,
      );
      assertTruthy(!JSON.stringify(payload.analysis).includes('<'), `${command} wire analysis has no invented path`);
    }
  });
});

test('proven non-executing migrated forms never request cloud review', async () => {
  const commands = [
    'git clean -nfdx',
    'git clean -x -X',
    'find --help -delete',
    'find . -name -delete',
    'xargs --help rm',
    'xargs -I rm echo safe',
    'xargs rm --help',
    'make -n clean',
    'make -C clean build',
    'docker compose down',
    'docker compose down -v --help',
    'kubectl delete pod app --dry-run=client',
    'kubectl delete pod app --help',
    'kubectl delete',
    'helm uninstall rel --dry-run',
    'helm uninstall',
    'terraform destroy -help',
  ];
  await withReviewServer({ decision: 'stop' }, async (url, requests) => {
    for (const command of commands) {
      await assertPassesAsync(command, {
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
    }
    assertEqual(requests.length, 0, 'safe forms bypass cloud review');
  });
});

test('Guardrail cloud authority and critical fallback cover every response class', async () => {
  const command = 'terraform destroy; rm -rf docs';
  const local = protectOnPlatform(command, 'bash', process.platform);
  assertEqual(local.severity, 'critical', 'fixture local severity');
  assertEqual(local.decision, 'stop', 'fixture local decision');

  const optionsFor = (url, extra = {}) => ({
    cloudReview: 'yes',
    env: {
      XW_SHELL_GUARD_URL: url,
      ...extra,
    },
  });
  const assertFallback = async (handler, label, extraEnv = {}) => {
    await withReviewHandler(handler, async (url, requests) => {
      const result = await assertBlockedAsync(command, optionsFor(url, extraEnv));
      assertIncludes(reason(result), '.pptx', `${label} retains concrete critical file evidence`);
      assertEqual(requests.length, 1, `${label} critical command request count`);
      const payload = decodeReviewRequest(requests[0]);
      assertEqual(payload.severity, 'critical', `${label} wire severity`);
    });
  };

  await withReviewServer({ decision: 'pass' }, async (url, requests) => {
    await assertPassesAsync(command, optionsFor(url));
    assertEqual(requests.length, 1, 'cloud-pass critical command review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.severity, 'critical', 'cloud-pass wire severity');
  });

  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    await assertSoftBlockedAsync(command, optionsFor(url));
    assertEqual(requests.length, 1, 'cloud-block critical command review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.severity, 'critical', 'cloud-block wire severity');
  });

  await assertFallback((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ decision: 'stop' }));
  }, 'cloud-stop');
  await assertFallback((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ decision: 'allow' }));
  }, 'unknown-verdict');
  await assertFallback((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{');
  }, 'malformed-json');
  await assertFallback((_req, res) => {
    res.statusCode = 503;
    res.end('review unavailable');
  }, 'http-failure');
  await assertFallback((_req, res) => {
    res.destroy();
  }, 'connection-reset');
  await assertFallback((_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ decision: 'pass' }));
    }, 1000);
  }, 'timeout', { XW_SHELL_GUARD_TIMEOUT_MS: '500' });

  await withReviewHandler(() => {
    // Keep the response open so the direct hook's own deadline chooses the local verdict.
  }, async (url, requests) => {
    const result = await assertBlockedAsync(command, {
      nodeArgs: ['--require', forceHookTimeout, defaultHook],
      ...optionsFor(url, { XW_SHELL_GUARD_TIMEOUT_MS: '120000' }),
    });
    assertIncludes(reason(result), '.pptx', 'outer-timeout retains concrete critical file evidence');
    assertEqual(requests.length, 1, 'outer-timeout critical command request count');
    decodeReviewRequest(requests[0]);
  });
});

test('cloud verdicts preserve the local critical classification and evidence in the library result', async () => {
  const command = 'terraform destroy; rm -rf docs';
  const local = protectOnPlatform(command, 'bash', process.platform);
  const normalizedCodes = [...new Set(local.reasonCodes)].sort((left, right) => left - right);
  assertEqual(
    JSON.stringify(local.reasonCodes),
    JSON.stringify(normalizedCodes),
    'mixed local risks are deduplicated and sorted',
  );
  assertTruthy(
    local.reasonCodes.includes(riskReasonCodes.SENSITIVE_EXTENSION),
    'mixed local risks include sensitive-file policy',
  );
  assertTruthy(
    local.reasonCodes.includes(riskReasonCodes.EXTERNAL_RESOURCE_DESTRUCTION),
    'mixed local risks include external-resource policy',
  );
  assertEqual(local.reasons, undefined, 'local result has no complex reasons field');
  await withReviewServer({ decision: 'pass' }, async (url, requests) => {
    const reviewed = await protectWithReview(command, {
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertEqual(reviewed.decision, 'pass', 'cloud pass is the final decision');
    assertEqual(reviewed.severity, 'critical', 'local severity is retained');
    assertEqual(reviewed.detail, '', 'passing result has no denial detail');
    assertEqual(
      JSON.stringify(reviewed.reasonCodes),
      JSON.stringify(local.reasonCodes),
      'local reason codes are retained',
    );
    assertEqual(reviewed.reasons, undefined, 'reviewed result omits complex reasons');
    assertEqual(
      JSON.stringify(reviewed.analysis.effects),
      JSON.stringify(local.analysis.effects),
      'local filesystem evidence is retained',
    );
    assertEqual(requests.length, 1, 'critical library call review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(payload.severity, 'critical', 'library call wire severity');
  });

  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    const reviewed = await protectWithReview(command, {
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertEqual(reviewed.decision, 'block', 'cloud block is the final decision');
    assertEqual(reviewed.severity, 'critical', 'cloud block retains local severity');
    assertTruthy(reviewed.detail.length > 0, 'cloud block retains denial detail');
    assertEqual(
      JSON.stringify(reviewed.reasonCodes),
      JSON.stringify(local.reasonCodes),
      'cloud block retains local reason codes',
    );
    assertEqual(requests.length, 1, 'critical library cloud-block request count');
    decodeReviewRequest(requests[0]);
  });
});

test('cloud pass renders provider-specific allow output for every hook protocol', async () => {
  const command = 'rm -rf docs';
  const variants = hookProtocolVariants(command);
  await withReviewServer({ decision: 'pass', need_update: true }, async (url, requests) => {
    for (const [name, options] of variants) {
      const result = await runHookAsync(command, {
        ...options,
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
      assertEqual(result.status, 0, `${name} exit code`);
      assertEqual(result.parsed, null, `${name} pass output`);
    }
    assertEqual(requests.length, variants.length, 'provider cloud-pass request count');
    for (const request of requests) decodeReviewRequest(request);
  });
});

test('bundle exports the tri-state hook reason contract for adapter shims', () => {
  const { buildHookReason } = require(guard);
  assertEqual(buildHookReason({ decision: 'pass', detail: '' }), '', 'pass has no denial reason');

  const detail = '- fixture destructive operation';
  const blockReason = buildHookReason({ decision: 'block', detail });
  assertIncludes(blockReason, detail, 'block retains risk detail');
  assertIncludes(blockReason, blockAiInstruction, 'block adapter instruction');
  assertTruthy(!blockReason.includes(stopAiInstruction), 'block adapter reason omits stop instruction');
  assertTruthy(!blockReason.includes(updateNoticeHeading), 'block omits update notice by default');

  const stopReason = buildHookReason({ decision: 'stop', detail });
  assertIncludes(stopReason, detail, 'stop retains risk detail');
  assertIncludes(stopReason, stopAiInstruction, 'stop adapter instruction');
  assertTruthy(!stopReason.includes(blockAiInstruction), 'stop adapter reason omits block instruction');
  assertTruthy(!stopReason.includes(updateNoticeHeading), 'stop omits update notice by default');

  for (const [decision, aiInstruction] of [
    ['block', blockAiInstruction],
    ['stop', stopAiInstruction],
  ]) {
    const updateReason = buildHookReason({ decision, detail, needUpdate: true });
    assertIncludes(updateReason, updateNoticeHeading, `${decision} update heading`);
    assertIncludes(updateReason, updateAiInstruction, `${decision} update instruction`);
    assertTruthy(
      updateReason.indexOf(updateNoticeHeading) > updateReason.indexOf(aiInstruction),
      `${decision} update notice follows the existing AI instruction`,
    );
  }
});

test('bundle exports the complete stable numeric reason-code registry', () => {
  const { RISK_REASON_CODES } = require(guard);
  assertEqual(
    JSON.stringify(RISK_REASON_CODES),
    JSON.stringify(riskReasonCodes),
    'exported reason-code registry',
  );
  assertEqual(
    new Set(Object.values(RISK_REASON_CODES)).size,
    Object.keys(RISK_REASON_CODES).length,
    'reason codes are unique',
  );
  assertTruthy(
    Object.values(RISK_REASON_CODES).every(Number.isInteger),
    'every reason code is an integer',
  );
});

test('cloud block renders command-level guidance for every hook protocol', async () => {
  const command = 'rm -rf docs';
  const variants = hookProtocolVariants(command);
  await withReviewServer({ decision: 'block', need_update: true }, async (url, requests) => {
    for (const [name, options] of variants) {
      const result = await runHookAsync(command, {
        ...options,
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
      assertEqual(result.status, 0, `${name} exit code`);
      assertNestedDenialOnly(result, `${name} cloud block`);
      const detail = reason(result);
      assertIncludes(detail, 'Affected files found on disk: 2, total size 46 B', `${name} reports affected count`);
      assertIncludes(detail, 'Extension .pptx: 1 file, total size 23 B', `${name} reports .pptx count`);
      assertIncludes(detail, 'Extension .docx: 1 file, total size 23 B', `${name} reports .docx count`);
      assertAffectedFileMetadata(detail, 'presentation.pptx', '23 B');
      assertAffectedFileMetadata(detail, 'report.docx', '23 B');
      assertIncludes(reason(result), blockAiInstruction, `${name} block instruction`);
      assertTruthy(!reason(result).includes(stopAiInstruction), `${name} omits stop instruction`);
      assertIncludes(detail, updateNoticeHeading, `${name} update heading`);
      assertIncludes(detail, updateAiInstruction, `${name} update instruction`);
      assertTruthy(
        detail.indexOf(updateNoticeHeading) > detail.indexOf(blockAiInstruction),
        `${name} update notice follows block instruction`,
      );
    }
    assertEqual(requests.length, variants.length, 'provider cloud-block request count');
    for (let index = 0; index < requests.length; index++) {
      const payload = decodeReviewRequest(requests[index]);
      const [name, options] = variants[index];
      assertEqual(
        payload.conversation_id,
        options.hookFields.session_id,
        `${name} forwards session_id as conversation_id`,
      );
      assertEqual(payload.session_id, undefined, `${name} does not expose the provider field name`);
      assertEqual(payload.turn_id, undefined, `${name} does not upload the turn identifier`);
    }
  });
});

test('cloud review omits unavailable or oversized hook conversation identifiers', async () => {
  const command = 'rsync -a --delete src/ mirror/';
  const cases = [
    ['missing', undefined],
    ['empty', ''],
    ['oversized', 'x'.repeat(257)],
  ];
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    for (const [name, sessionId] of cases) {
      await assertSoftBlockedAsync(command, {
        hookFields: { session_id: sessionId },
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
      const payload = decodeReviewRequest(requests.at(-1));
      assertEqual(payload.conversation_id, undefined, `${name} session ID is omitted`);
    }
    assertEqual(requests.length, cases.length, 'bounded conversation ID request count');
  });
});

test('cloud stop renders provider-specific deny output for every hook protocol', async () => {
  const command = 'rm -rf docs';
  const variants = hookProtocolVariants(command);
  await withReviewServer({ decision: 'stop', need_update: true }, async (url, requests) => {
    for (const [name, options] of variants) {
      const result = await runHookAsync(command, {
        ...options,
        cloudReview: 'yes',
        env: {
          XW_SHELL_GUARD_URL: url,
        },
      });
      assertEqual(result.status, 0, `${name} exit code`);
      assertNestedDenialOnly(result, `${name} cloud stop`);
      assertIncludes(reason(result), stopAiInstruction, `${name} stop instruction`);
      assertTruthy(!reason(result).includes(blockAiInstruction), `${name} omits block instruction`);
      assertIncludes(reason(result), updateNoticeHeading, `${name} update heading`);
      assertIncludes(reason(result), updateAiInstruction, `${name} update instruction`);
      assertTruthy(
        reason(result).indexOf(updateNoticeHeading) > reason(result).indexOf(stopAiInstruction),
        `${name} update notice follows stop instruction`,
      );
    }
    assertEqual(requests.length, variants.length, 'provider cloud-stop request count');
    for (const request of requests) decodeReviewRequest(request);
  });
});

test('direct-hook timeout preserves Codex nested critical denial output', async () => {
  const command = 'rm -rf docs';
  await withReviewHandler(() => {
    // Keep the response open so the accelerated direct-hook deadline uses the cached local output.
  }, async (url, requests) => {
    const result = await runHookAsync(command, {
      hookEvent: 'PreToolUse',
      toolName: 'exec_command',
      toolInput: { cmd: command },
      nodeArgs: ['--require', forceHookTimeout, defaultHook],
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
        XW_SHELL_GUARD_TIMEOUT_MS: '120000',
      },
    });
    assertEqual(result.status, 0, 'Codex timeout exit code');
    assertNestedDenialOnly(result, 'Codex timeout fallback');
    assertIncludes(reason(result), stopAiInstruction, 'Codex timeout stop instruction');
    assertEqual(requests.length, 1, 'Codex timeout cloud request count');
    decodeReviewRequest(requests[0]);
  });
});

test('overwriting a recent ordinary txt uses statistics and remains locally safe', () => {
  const path = resolve(rootfs, 'tmp', 'recent-overwrite.txt');
  writeFileSync(path, 'recent');
  try {
    const local = protectOnPlatform('echo changed > tmp/recent-overwrite.txt', 'bash', process.platform);
    assertEqual(local.severity, 'safe', 'recent ordinary overwrite severity');
    assertEqual(local.analysis.affected?.totalFileCount ?? 0, 1, 'recent ordinary overwrite factual count');
    assertEqual(directReasons(local).length, 0, 'recent ordinary overwrite direct-risk count');
    assertPasses('echo changed > tmp/recent-overwrite.txt');
  } finally {
    cleanup([path]);
  }
});

test('POSIX null sink remains safe across every content-replacement emitter', () => {
  if (process.platform === 'win32') return;
  const commands = [
    'printf x > /dev/null',
    'printf x | tee /dev/null',
    'curl -o /dev/null https://example.invalid/file',
    'wget -O /dev/null https://example.invalid/file',
    'dd if=safe/notes.txt of=/dev/null',
    'truncate -s 0 /dev/null',
  ];
  for (const command of commands) {
    const local = protectOnPlatform(command, 'bash', process.platform);
    assertEqual(local.severity, 'safe', `${command} local severity`);
    assertEqual(local.analysis.affected?.totalFileCount ?? 0, 0, `${command} affected count`);
    assertEqual(directReasons(local).length, 0, `${command} direct-risk count`);
    assertTruthy(
      local.analysis.affected?.specialTargets?.some(target =>
        target.path === '/dev/null' && target.kind === 'character-device' && target.safeSink),
      `${command} null-sink observation`,
    );
    assertPasses(command);
  }
});

test('special-device review keeps the numeric code and target facts separate', async () => {
  if (process.platform === 'win32' || !existsSync('/dev/zero')) return;
  await withReviewServer({ decision: 'block' }, async (url, requests) => {
    const result = await assertSoftBlockedAsync('printf x > /dev/zero', {
      cloudReview: 'yes',
      env: {
        XW_SHELL_GUARD_URL: url,
      },
    });
    assertIncludes(reason(result), 'character-device', 'local renderer uses special-target facts');
    assertEqual(requests.length, 1, 'special-device cloud review request count');
    const payload = decodeReviewRequest(requests[0]);
    assertEqual(
      JSON.stringify(payload.reasonCodes),
      JSON.stringify([riskReasonCodes.SPECIAL_DEVICE_SIDE_EFFECT]),
      'wire special-device reason code',
    );
    assertEqual(payload.reasons, undefined, 'wire omits complex reasons');
    assertEqual(payload.analysis.affected.specialTargets.length, 1, 'wire special-target fact count');
    assertEqual(payload.analysis.affected.specialTargets[0].path, '/dev/zero', 'wire target path');
    assertEqual(
      payload.analysis.affected.specialTargets[0].kind,
      'character-device',
      'wire target kind',
    );
  });
});

test('copy move forced-link truncate and install replacements share sensitive-file policy', () => {
  const commands = [
    'cp safe/notes.txt docs/presentation.pptx',
    'mv safe/notes.txt docs/presentation.pptx',
    'ln -sf safe/notes.txt docs/report.docx',
    'truncate -s 0 docs/presentation.pptx',
    'install safe/notes.txt docs/report.docx',
    'install -D safe/notes.txt docs/report.docx',
  ];
  for (const command of commands) {
    const result = assertBlocked(command);
    assertIncludes(reason(result), 'Affected files found on disk: 1', `${command} affected count`);
    assertTruthy(
      reason(result).includes('Extension .pptx: 1 file')
        || reason(result).includes('Extension .docx: 1 file'),
      `${command} extension group`,
    );
  }
  assertPasses('cp -n safe/notes.txt docs/presentation.pptx');
  assertPasses('mv -n safe/notes.txt docs/presentation.pptx');
  assertPasses('ln -s safe/notes.txt docs/report.docx');
});

test('Docker bind mounts are host-write exposure facts, never immediate file overwrites', () => {
  const { protect } = require(guard);
  const writable = protect('docker run -v ./docs:/data image', rootfs, 'bash');
  assertEqual(writable.severity, 'risky', 'writable bind local severity');
  assertEqual(writable.analysis.effects.length, 0, 'writable bind has no file overwrite effect');
  assertEqual(writable.analysis.affected.totalFileCount, 0, 'writable bind has no affected-file inventory');
  assertEqual(
    JSON.stringify(directReasons(writable)),
    JSON.stringify([riskReasonCodes.CONTAINER_HOST_WRITE_EXPOSURE]),
    'writable bind reason code',
  );
  assertSoftBlocked('docker run -v ./docs:/data image');

  const readOnly = protect('docker run -v ./docs:/data:ro image', rootfs, 'bash');
  assertEqual(readOnly.severity, 'safe', 'read-only bind local severity');
  assertEqual(readOnly.analysis.resourceEffects.length, 0, 'read-only bind resource effects');
  assertPasses('docker run -v ./docs:/data:ro image');
});

test('generated .log deletion passes silently', () => {
  const path = resolve(rootfs, 'tmp', 'e2e-build.log');
  touch(path);
  try {
    assertPasses('rm "tmp/e2e-build.log"');
  } finally {
    cleanup([path]);
  }
});

test('mv sensitive file is not blocked', () => {
  assertPasses('mv "docs/presentation.pptx" "docs/presentation-copy.pptx"');
});

test('large file is blocked on total-size rule', () => {
  ensureBigFile();
  try {
    const result = assertBlocked('rm "tmp/bigfile.bin"');
    assertIncludes(reason(result), 'MB', 'reason mentions MB size');
  } finally {
    cleanupBigFile();
  }
});

test('Hermes pre_tool_call terminal payload blocks in the direct hook', () => {
  const result = assertBlocked('rm -rf docs', {
    hookEvent: 'pre_tool_call',
    toolName: 'terminal',
  });
  assertIncludes(reason(result), 'atuin-shell-guard blocked', 'reason mentions guard');
});

test('Hermes Python adapter maps the nested hook denial to a block', async () => {
  writeHookCloudReview('no');
  const source = [
    'import importlib.util',
    'import json',
    'import sys',
    'spec = importlib.util.spec_from_file_location("atuin_shell_guard_hermes_test", sys.argv[1])',
    'if spec is None or spec.loader is None:',
    '    raise ImportError(f"Cannot load Hermes adapter from {sys.argv[1]}")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'result = module._run_guard(',
    '    "terminal",',
    '    {"command": sys.argv[3], "workdir": sys.argv[2]},',
    '    "hermes-adapter-test",',
    '    session_id="hermes-session",',
    '    tool_call_id="hermes-tool-call",',
    ')',
    'print(json.dumps(result))',
  ].join('\n');
  const result = await runPython([
    '-c',
    source,
    resolve(root, 'plugin', 'hermes_plugin.py'),
    rootfs,
    'rm -rf docs',
  ], {
    env: {
      ...process.env,
      HOME: hookHome,
      USERPROFILE: hookHome,
      XW_ENABLE_LOG: 'false',
    },
  });

  assertEqual(result.status, 0, `Hermes adapter probe failed\n${result.stderr}`);
  const parsed = parseStdout(result.stdout);
  assertEqual(parsed?.action, 'block', 'Hermes adapter action');
  assertIncludes(parsed?.message, 'atuin-shell-guard blocked', 'Hermes adapter message');
});

test('non-PreToolUse event emits no output', () => {
  assertPasses('ignored', { hookEvent: 'PostToolUse' });
});

test('unknown tool name emits no output', () => {
  assertPasses('ignored', {
    toolName: 'UnknownTool',
    toolInput: { whatever: 'value' },
  });
});

test('rm with -f flag on sensitive file is blocked', () => assertBlocked('rm -f "docs/presentation.pptx"'));
test('rm with -rf flags on sensitive dir is blocked', () => assertBlocked('rm -rf docs'));
test('piped command with rm is blocked', () => assertBlocked('echo yes | rm "docs/presentation.pptx"'));
test('background destructive command remains blocked', () => assertBlocked('rm "docs/report.docx" &'));
test('pipefail prunes an impossible destructive AND branch', () => {
  assertPasses('set -o pipefail; false | true && rm "docs/presentation.pptx"');
});
test('exit prevents a later destructive command from reaching the hook decision', () => {
  assertPasses('exit 0; rm "docs/presentation.pptx"');
});
test('function return prevents an unreachable destructive command', () => {
  assertPasses('cleanup() { return 0; rm "docs/presentation.pptx"; }; cleanup');
});
test('modeled command-substitution stdout resolves a destructive target', () => {
  assertBlocked('target=$(printf "%s" docs/presentation.pptx); rm "$target"');
});
test('modeled pipeline stdout resolves a destructive target inside a group', () => {
  assertBlocked('printf "%s\\n" docs/presentation.pptx | { read target; rm "$target"; }');
});
test('semicolon-chained rm is blocked', () => assertBlocked('echo hello; rm "docs/presentation.pptx"'));
test('&& chained rm retains conditional sensitive-file statistics', () => {
  const command = 'ls && rm "docs/presentation.pptx"';
  const local = protectOnPlatform(command, 'bash', process.platform);
  assertEqual(local.severity, 'risky', 'AND-list local severity');
  assertEqual(local.decision, 'pass', 'AND-list local decision');
  assertEqual(local.analysis.affected?.conditionalPolicyFileCount ?? 0, 1, 'AND-list conditional count');
  assertSoftBlocked(command);
});


async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--no-build');
  const filterArg = args.find((arg) => arg.startsWith('--filter='));
  const filter = filterArg?.split('=', 2)[1]?.toLowerCase();

  if (skipBuild) {
    console.log('[build] skipped (--no-build)');
    if (!existsSync(guard)) throw new Error(`--no-build but bundle missing: ${guard}`);
  } else {
    buildPlugin();
  }

  const selected = filter
    ? tests.filter(({ name }) => name.toLowerCase().includes(filter))
    : tests;
  if (filter) console.log(`[filter] ${JSON.stringify(filter)} matched ${selected.length}/${tests.length} test(s)`);
  if (filter && selected.length === 0) {
    throw new Error(`no tests matched --filter=${JSON.stringify(filterArg?.split('=', 2)[1] ?? '')}`);
  }

  console.log(`[run  ] ${selected.length} test case(s)`);
  for (const { name, fn } of selected) {
    console.log(`  - ${name}`);
    try {
      await fn();
      passed++;
      console.log('    OK');
    } catch (err) {
      failed++;
      console.log(`    FAIL: ${err?.stack ?? err}`);
    }
  }

  rmSync(hookHome, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
