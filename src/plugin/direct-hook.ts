// main.ts — Direct hook entry for AI coding agents.

import * as fs from 'node:fs';
import { buildHookOutput, buildHookReason, parseHookRequest } from './hook-protocol.js';
import { ensureInstallationConfig } from './user-config.js';
import {
  log,
  protect,
  protectWithReview,
  reviewProtectResult,
  decide,
  RISK_REASON_CODES,
  renderReasonCodes,
  renderReasonCodesDetailed,
  trimAnalysisForWire,
  type Analysis,
  type ProtectResult,
  type ReasonCode,
} from './guard.js';

let hasEmitted = false;
let globalTimeoutId: ReturnType<typeof setTimeout> | null = null;
let timeoutFallback: object | null = null;
const DIRECT_HOOK_TIMEOUT_MS = 60_000;

function emitResult(result: object | null): void {
  if (hasEmitted) return;
  hasEmitted = true;
  if (globalTimeoutId) clearTimeout(globalTimeoutId);

  if (result === null) {
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

async function main(): Promise<void> {
  ensureInstallationConfig();
  const stdin = fs.readFileSync(0, 'utf8');
  log('====PROTECTOR INPUT====');
  log(stdin);

  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    emitResult(null);
    return;
  }

  const request = parseHookRequest(input);
  if (!request) {
    emitResult(null);
    return;
  }

  const localResult = protect(request.command, request.cwd, request.shell);
  timeoutFallback = buildHookOutput(localResult);
  const result = await reviewProtectResult(
    localResult,
    request.command,
    request.cwd,
    request.shell,
    request.conversationId,
  );
  const rendered = renderReasonCodes(result.reasonCodes, result.analysis, 10);
  if (rendered.length > 0) {
    log(`decision=${result.decision} severity=${result.severity}: ${rendered.join('; ')}`);
  }

  emitResult(buildHookOutput(result));
}

export {
  buildHookReason,
  decide,
  ensureInstallationConfig,
  protect,
  protectWithReview,
  RISK_REASON_CODES,
  renderReasonCodes,
  renderReasonCodesDetailed,
  trimAnalysisForWire,
  type Analysis,
  type ProtectResult,
  type ReasonCode,
};

declare const require: NodeRequire;
declare const module: NodeModule;

if (require.main === module) {
  globalTimeoutId = setTimeout(() => { emitResult(timeoutFallback); }, DIRECT_HOOK_TIMEOUT_MS);
  main().catch((err: unknown) => {
    log(`protector error: ${err instanceof Error ? err.message : String(err)}`);
    emitResult(timeoutFallback);
  });
}
