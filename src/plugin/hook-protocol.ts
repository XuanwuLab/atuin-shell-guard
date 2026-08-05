import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProtectResult } from './guard.js';

export type ShellKind = 'bash' | 'powershell';

export interface HookRequest {
  command: string;
  cwd: string;
  shell: ShellKind;
  conversationId?: string;
}

const SHELL_TOOL_NAMES = new Set([
  'Bash',
  'Shell',
  'terminal',
  'shell',
  'bash',
  'exec_command',
]);

const POWERSHELL_TOOL_NAMES = new Set([
  'PowerShell',
  'powershell',
  'pwsh',
  'Powershell',
  'run_powershell_command',
  'powershell_command',
]);

const CODEX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const CODEX_TRANSCRIPT_MAX_LINES = 4096;

export function parseHookRequest(input: unknown): HookRequest | null {
  if (!isRecord(input)) return null;

  const event = stringField(input, 'hook_event_name');
  const toolName = stringField(input, 'tool_name');
  if (event !== 'PreToolUse' && event !== 'pre_tool_call') return null;
  if (!toolName || (!SHELL_TOOL_NAMES.has(toolName) && !POWERSHELL_TOOL_NAMES.has(toolName))) return null;

  const toolInput = hookToolInput(input);
  const shell = detectShell(toolName, toolInput);
  const command = hookCommand(toolInput);
  if (!command) return null;

  const fallbackCwd = stringField(input, 'cwd')
    ?? stringField(input, 'workspacePath')
    ?? stringField(input, 'workspace_path')
    ?? stringField(toolInput, 'cwd')
    ?? stringField(toolInput, 'workdir')
    ?? stringField(toolInput, 'directory')
    ?? '.';
  const cwd = tryGetCwdForCodex(input) ?? fallbackCwd;
  const conversationId = stringField(input, 'session_id');

  return { command, cwd, shell, conversationId };
}

export function tryGetCwdForCodex(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (stringField(input, 'hook_event_name') !== 'PreToolUse') return undefined;

  const turnId = stringField(input, 'turn_id');
  const model = stringField(input, 'model');
  const toolUseId = stringField(input, 'tool_use_id');
  if (!turnId || !model || !toolUseId) return undefined;

  const transcriptPath = stringField(input, 'transcript_path');
  const originalCwd = stringField(input, 'cwd');
  const command = hookCommand(hookToolInput(input));
  if (
    !transcriptPath
    || !path.isAbsolute(transcriptPath)
    || !originalCwd
    || !path.isAbsolute(originalCwd)
    || !command
  ) {
    return undefined;
  }

  const transcriptTail = readTranscriptTail(transcriptPath);
  if (transcriptTail === undefined) return undefined;

  const lines = transcriptTail.split(/\r?\n/);
  let examinedLines = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    examinedLines += 1;
    if (examinedLines > CODEX_TRANSCRIPT_MAX_LINES) return undefined;

    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(item) || item.type !== 'response_item' || !isRecord(item.payload)) continue;

    const payload = item.payload;
    if (
      payload.type !== 'function_call'
      || payload.name !== 'exec_command'
      || payload.call_id !== toolUseId
    ) {
      continue;
    }

    const serializedArguments = stringField(payload, 'arguments');
    if (!serializedArguments) return undefined;

    let args: unknown;
    try {
      args = JSON.parse(serializedArguments);
    } catch {
      return undefined;
    }
    if (!isRecord(args) || args.cmd !== command) return undefined;

    const environmentId = args.environment_id;
    if (
      environmentId !== undefined
      && (typeof environmentId !== 'string' || environmentId.length > 0)
    ) {
      return undefined;
    }

    const workdir = args.workdir;
    if (typeof workdir !== 'string' || workdir.length === 0 || workdir.includes('\0')) {
      return undefined;
    }
    return path.resolve(originalCwd, workdir);
  }

  return undefined;
}

function readTranscriptTail(transcriptPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;

    const byteLength = Math.min(stat.size, CODEX_TRANSCRIPT_TAIL_BYTES);
    const start = stat.size - byteLength;
    const buffer = Buffer.allocUnsafe(byteLength);
    let bytesRead = 0;
    while (bytesRead < byteLength) {
      const count = fs.readSync(
        fd,
        buffer,
        bytesRead,
        byteLength - bytesRead,
        start + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }

    let tail = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = tail.indexOf('\n');
      if (firstNewline < 0) return undefined;
      tail = tail.slice(firstNewline + 1);
    }
    return tail;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The bounded read is already complete; closing is best effort.
      }
    }
  }
}

function hookToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return isRecord(input.tool_input) ? input.tool_input
    : isRecord(input.toolInput) ? input.toolInput
      : isRecord(input.params) ? input.params
        : {};
}

function hookCommand(toolInput: Record<string, unknown>): string | undefined {
  return stringField(toolInput, 'command')
    ?? stringField(toolInput, 'cmd')
    ?? stringField(toolInput, 'script');
}

function detectShell(toolName: string, toolInput: Record<string, unknown>): ShellKind {
  if (POWERSHELL_TOOL_NAMES.has(toolName)) return 'powershell';
  const shell = stringField(toolInput, 'shell')
    ?? stringField(toolInput, 'shellName')
    ?? stringField(toolInput, 'shell_name');
  if (!shell) return 'bash';
  const lower = shell.toLowerCase();
  return lower === 'powershell' || lower === 'pwsh' || lower === 'powershell.exe' || lower === 'pwsh.exe'
    ? 'powershell'
    : 'bash';
}

export function buildHookOutput(result: ProtectResult | {
  decision: ProtectResult['decision'];
  detail: string;
  needUpdate?: boolean;
}): object | null {
  if (result.decision === 'pass') return null;

  const reason = buildHookReason(result);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function buildHookReason(result: {
  decision: ProtectResult['decision'];
  detail: string;
  needUpdate?: boolean;
}): string {
  if (result.decision === 'pass') return '';
  const aiInstruction = result.decision === 'stop'
    ? 'To AI: Stop immediately; the system detected dangerous behavior in this conversation, so terminate any active goal or loop, end this turn after explaining the risk to the user, and take no further action until the user decides. If the targeted file truly can be deleted, ask the user to delete it manually for you instead of attempting to bypass shell-guard.'
    : 'To AI: Reconsider whether this command is intended; if it is truly necessary, do not bypass this guard—pause your current work, including any goal or loop, explain the operation and risks, and ask the user to run it manually; if a safer alternative exists, use it instead. Reconsider this deletion operation from the beginning: determine whether it is truly necessary and verify that every affected file is expected before taking any further action.';
  const lines = [
    'atuin-shell-guard blocked this command due to destructive risk:',
    result.detail,
    '',
    aiInstruction,
  ];
  if (result.needUpdate === true) {
    lines.push(
      '',
      '## Atuin Shell Guard needs update!',
      'To AI: Atuin Shell Guard needs to be updated so it can better protect data in the current environment. You and the user can learn how to update the plugin on GitHub: https://github.com/XuanwuLab/atuin-shell-guard',
    );
  }
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
