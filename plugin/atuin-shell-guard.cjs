"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/plugin/direct-hook.ts
var direct_hook_exports = {};
__export(direct_hook_exports, {
  RISK_REASON_CODES: () => RISK_REASON_CODES,
  applyBlockSuppression: () => applyBlockSuppression,
  applyOfflineRiskPolicy: () => applyOfflineRiskPolicy,
  buildHookReason: () => buildHookReason,
  decide: () => decide,
  ensureInstallationConfig: () => ensureInstallationConfig,
  protect: () => protect,
  protectWithReview: () => protectWithReview,
  renderReasonCodes: () => renderReasonCodes,
  renderReasonCodesDetailed: () => renderReasonCodesDetailed,
  trimAnalysisForWire: () => trimAnalysisForWire
});
module.exports = __toCommonJS(direct_hook_exports);
var fs8 = __toESM(require("node:fs"), 1);

// src/plugin/hook-protocol.ts
var fs = __toESM(require("node:fs"), 1);
var path = __toESM(require("node:path"), 1);
var SHELL_TOOL_NAMES = /* @__PURE__ */ new Set([
  "Bash",
  "Shell",
  "terminal",
  "shell",
  "bash",
  "exec_command"
]);
var POWERSHELL_TOOL_NAMES = /* @__PURE__ */ new Set([
  "PowerShell",
  "powershell",
  "pwsh",
  "Powershell",
  "run_powershell_command",
  "powershell_command"
]);
var CODEX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
var CODEX_TRANSCRIPT_MAX_LINES = 4096;
function parseHookRequest(input) {
  if (!isRecord(input)) return null;
  const event = stringField(input, "hook_event_name");
  const toolName = stringField(input, "tool_name");
  if (event !== "PreToolUse" && event !== "pre_tool_call") return null;
  if (!toolName || !SHELL_TOOL_NAMES.has(toolName) && !POWERSHELL_TOOL_NAMES.has(toolName)) return null;
  const toolInput = hookToolInput(input);
  const shell = detectShell(toolName, toolInput);
  const command = hookCommand(toolInput);
  if (!command) return null;
  const fallbackCwd = stringField(input, "cwd") ?? stringField(input, "workspacePath") ?? stringField(input, "workspace_path") ?? stringField(toolInput, "cwd") ?? stringField(toolInput, "workdir") ?? stringField(toolInput, "directory") ?? ".";
  const cwd = tryGetCwdForCodex(input) ?? fallbackCwd;
  const conversationId = stringField(input, "session_id");
  return { command, cwd, shell, conversationId };
}
function tryGetCwdForCodex(input) {
  if (!isRecord(input)) return void 0;
  if (stringField(input, "hook_event_name") !== "PreToolUse") return void 0;
  const turnId = stringField(input, "turn_id");
  const model = stringField(input, "model");
  const toolUseId = stringField(input, "tool_use_id");
  if (!turnId || !model || !toolUseId) return void 0;
  const transcriptPath = stringField(input, "transcript_path");
  const originalCwd = stringField(input, "cwd");
  const command = hookCommand(hookToolInput(input));
  if (!transcriptPath || !path.isAbsolute(transcriptPath) || !originalCwd || !path.isAbsolute(originalCwd) || !command) {
    return void 0;
  }
  const transcriptTail = readTranscriptTail(transcriptPath);
  if (transcriptTail === void 0) return void 0;
  const lines = transcriptTail.split(/\r?\n/);
  let examinedLines = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    examinedLines += 1;
    if (examinedLines > CODEX_TRANSCRIPT_MAX_LINES) return void 0;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return void 0;
    }
    if (!isRecord(item) || item.type !== "response_item" || !isRecord(item.payload)) continue;
    const payload = item.payload;
    if (payload.type !== "function_call" || payload.name !== "exec_command" || payload.call_id !== toolUseId) {
      continue;
    }
    const serializedArguments = stringField(payload, "arguments");
    if (!serializedArguments) return void 0;
    let args;
    try {
      args = JSON.parse(serializedArguments);
    } catch {
      return void 0;
    }
    if (!isRecord(args) || args.cmd !== command) return void 0;
    const environmentId = args.environment_id;
    if (environmentId !== void 0 && (typeof environmentId !== "string" || environmentId.length > 0)) {
      return void 0;
    }
    const workdir = args.workdir;
    if (typeof workdir !== "string" || workdir.length === 0 || workdir.includes("\0")) {
      return void 0;
    }
    return path.resolve(originalCwd, workdir);
  }
  return void 0;
}
function readTranscriptTail(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return void 0;
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
        start + bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    let tail = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = tail.indexOf("\n");
      if (firstNewline < 0) return void 0;
      tail = tail.slice(firstNewline + 1);
    }
    return tail;
  } catch {
    return void 0;
  } finally {
    if (fd !== void 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function hookToolInput(input) {
  return isRecord(input.tool_input) ? input.tool_input : isRecord(input.toolInput) ? input.toolInput : isRecord(input.params) ? input.params : {};
}
function hookCommand(toolInput) {
  return stringField(toolInput, "command") ?? stringField(toolInput, "cmd") ?? stringField(toolInput, "script");
}
function detectShell(toolName, toolInput) {
  if (POWERSHELL_TOOL_NAMES.has(toolName)) return "powershell";
  const shell = stringField(toolInput, "shell") ?? stringField(toolInput, "shellName") ?? stringField(toolInput, "shell_name");
  if (!shell) return "bash";
  const lower = shell.toLowerCase();
  return lower === "powershell" || lower === "pwsh" || lower === "powershell.exe" || lower === "pwsh.exe" ? "powershell" : "bash";
}
function buildHookOutput(result) {
  if (result.decision === "pass") return null;
  const reason = buildHookReason(result);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}
function buildHookReason(result) {
  if (result.decision === "pass") return "";
  const aiInstruction = result.decision === "stop" ? "To AI: Stop immediately; the system detected dangerous behavior in this conversation, so terminate any active goal or loop, end this turn after explaining the risk to the user, and take no further action until the user decides. If the targeted file truly can be deleted, ask the user to delete it manually for you instead of attempting to bypass shell-guard." : buildBlockAiInstruction(result.reasonCodes);
  const lines = [
    "atuin-shell-guard blocked this command due to destructive risk:",
    result.detail,
    "",
    aiInstruction
  ];
  if (result.needUpdate === true) {
    lines.push(
      "",
      "## Atuin Shell Guard needs update!",
      "To AI: Atuin Shell Guard needs to be updated so it can better protect data in the current environment. You and the user can learn how to update the plugin on GitHub: https://github.com/XuanwuLab/atuin-shell-guard"
    );
  }
  return lines.join("\n");
}
function buildBlockAiInstruction(reasonCodes) {
  const riskIds = normalizedRiskIds(reasonCodes);
  const reflection = "To AI: Reconsider whether this shell call is justified. First inspect Atuin's concrete command-impact information; if it is insufficient, investigate the relevant files and state yourself, and consider safer alternatives.";
  if (riskIds.length === 0) {
    return `${reflection} This block has no suppressible risk-ID set, so do not attempt to bypass it.`;
  }
  const joinedIds = riskIds.join(",");
  return [
    `Risk IDs: ${joinedIds}`,
    reflection,
    "If, after that review, you deliberately decide to ignore this warning and execute the same command, put exactly this directive on the first line of the shell call:",
    `# atuin-suppress-warning: ${joinedIds}`,
    "The directive is accepted only when its comma-separated IDs exactly match this command's current risk IDs; missing, extra, duplicate, or malformed IDs do not suppress the block."
  ].join("\n");
}
function normalizedRiskIds(reasonCodes) {
  if (!reasonCodes) return [];
  return [...new Set(reasonCodes.filter((code) => Number.isSafeInteger(code) && code > 0))].sort((left, right) => left - right);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function stringField(obj, key) {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

// src/plugin/user-config.ts
var import_node_crypto = require("node:crypto");
var fs2 = __toESM(require("node:fs"), 1);
var os = __toESM(require("node:os"), 1);
var path2 = __toESM(require("node:path"), 1);
var CONFIG_DIR = ".atuin-shell-guard";
var CONFIG_FILE = "config.json";
var INSTALLATION_ID = "installation-id";
var CLOUD_REVIEW = "cloud-review";
function ensureInstallationConfig(homeDir = os.homedir()) {
  return getInstallationId(homeDir) !== null;
}
function getInstallationId(homeDir = os.homedir()) {
  const config = ensureUserConfig(homeDir);
  if (!config) return null;
  const installationId = config[INSTALLATION_ID];
  return typeof installationId === "string" && installationId.length > 0 ? installationId : null;
}
function getCloudReviewSetting(homeDir = os.homedir()) {
  const config = ensureUserConfig(homeDir);
  if (!config) return null;
  const value = config[CLOUD_REVIEW];
  return value === "yes" || value === "no" ? value : null;
}
function ensureUserConfig(homeDir) {
  try {
    const configDir = path2.join(homeDir, CONFIG_DIR);
    const configPath = path2.join(configDir, CONFIG_FILE);
    fs2.mkdirSync(configDir, { recursive: true, mode: 448 });
    let config = {};
    try {
      const parsed = JSON.parse(fs2.readFileSync(configPath, "utf8"));
      if (!isRecord2(parsed)) return null;
      config = parsed;
    } catch (err) {
      if (!isErrorCode(err, "ENOENT")) return null;
    }
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(config, INSTALLATION_ID)) {
      const installationId = config[INSTALLATION_ID];
      if (typeof installationId !== "string" || installationId.length === 0) return null;
    } else {
      config[INSTALLATION_ID] = (0, import_node_crypto.randomUUID)();
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(config, CLOUD_REVIEW)) {
      config[CLOUD_REVIEW] = "yes";
      changed = true;
    }
    if (changed) {
      fs2.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}
`, {
        encoding: "utf8",
        mode: 384
      });
    }
    return config;
  } catch {
    return null;
  }
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isErrorCode(value, code) {
  return value instanceof Error && "code" in value && value.code === code;
}

// src/plugin/guard.ts
var fs7 = __toESM(require("node:fs"), 1);
var path11 = __toESM(require("node:path"), 1);
var zlib = __toESM(require("node:zlib"), 1);

// src/bash/command.ts
var W_QUOTED = 2;
var W_ASSIGNMENT = 4;
var W_NOGLOB = 32;
var CMD_WANT_SUBSHELL = 1;
var CMD_INVERT_RETURN = 4;
var CMD_AMPERSAND = 512;
var CASEPAT_FALLTHROUGH = 1;
var CASEPAT_TESTNEXT = 2;
var COND_AND = 1;
var COND_OR = 2;
var COND_UNARY = 3;
var COND_BINARY = 4;
var COND_TERM = 5;
var COND_EXPR = 6;
var COND_UNKNOWN = 7;
var AND_AND = 256;
var OR_OR = 257;
var SEMI = 59;
var NEWLINE = 10;
var AMP = 38;
var PIPE = 124;
var BAR_AND = 258;

// src/bash/general.ts
function legal_variable_starter(c) {
  return c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "_";
}
function legal_variable_char(c) {
  return legal_variable_starter(c) || c >= "0" && c <= "9";
}
function assignment_word(word) {
  return parseAssignment(word) !== null;
}
function assignment_name(word) {
  return parseAssignment(word)?.target ?? word;
}
function assignment_value(word) {
  return parseAssignment(word)?.value ?? "";
}
function assignment_operator(word) {
  return parseAssignment(word)?.operator ?? "=";
}
function parseAssignment(word) {
  if (word.length === 0 || !legal_variable_starter(word[0])) return null;
  let position = 1;
  while (position < word.length && legal_variable_char(word[position])) position++;
  if (word[position] === "[") {
    const end = readArrayReferenceEnd(word, position);
    if (end === null) return null;
    position = end;
  }
  let operator;
  if (word.startsWith("+=", position)) {
    operator = "+=";
  } else if (word[position] === "=") {
    operator = "=";
  } else {
    return null;
  }
  return {
    target: word.substring(0, position),
    operator,
    value: word.substring(position + operator.length)
  };
}
function parse_array_reference(value) {
  if (value.length === 0 || !legal_variable_starter(value[0])) return null;
  let position = 1;
  while (position < value.length && legal_variable_char(value[position])) position++;
  if (value[position] !== "[") return null;
  const start = position;
  const end = readArrayReferenceEnd(value, start);
  if (end !== value.length) return null;
  return {
    name: value.substring(0, start),
    subscript: value.substring(start + 1, end - 1)
  };
}
function readArrayReferenceEnd(value, start) {
  let position = start;
  let depth = 0;
  let quote = null;
  for (; position < value.length; position++) {
    const character = value[position];
    if (character === "\\" && quote !== "'") {
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
    if (character === "[") depth++;
    else if (character === "]") {
      depth--;
      if (depth === 0) return position + 1;
    }
  }
  return null;
}
function assignment_base_name(word) {
  const reference = parse_array_reference(assignment_name(word));
  return reference?.name ?? assignment_name(word);
}

// src/analysis/provenance.ts
var MAX_PROVENANCE_NODES = 512;
var MAX_PROVENANCE_PARENTS = 8;
var MAX_PROVENANCE_LABEL_CHARS = 240;
var ProvenanceStore = class {
  nodes = [];
  nodeIdsByKey = /* @__PURE__ */ new Map();
  context = [];
  budgetNodeId = null;
  truncated = false;
  add(input) {
    if (this.budgetNodeId !== null) {
      this.truncated = true;
      return this.budgetNodeId;
    }
    const parents = this.normalizeParents(
      input.parents ?? this.currentParents()
    );
    const line = positiveLine(input.line) ?? [...parents].reverse().map((parent) => this.nodes[parent]?.line).find((parentLine) => parentLine !== void 0);
    const normalized = {
      kind: input.kind,
      label: normalizeLabel(input.label),
      ...line === void 0 ? {} : { line },
      parents,
      ...input.reason ? { reason: normalizeLabel(input.reason) } : {}
    };
    const key = JSON.stringify(normalized);
    const existing = this.nodeIdsByKey.get(key);
    if (existing !== void 0) return existing;
    if (this.nodes.length >= MAX_PROVENANCE_NODES - 1) {
      return this.getBudgetNode(parents);
    }
    const id = this.nodes.length;
    this.nodes.push({ id, ...normalized });
    this.nodeIdsByKey.set(key, id);
    return id;
  }
  withNode(input, run) {
    const id = this.add(input);
    this.context.push(id);
    try {
      return run();
    } finally {
      this.context.pop();
    }
  }
  currentParents() {
    const current = this.context[this.context.length - 1];
    return current === void 0 ? [] : [current];
  }
  graph() {
    return {
      nodes: this.nodes.map((node) => ({
        ...node,
        parents: [...node.parents]
      })),
      truncated: this.truncated
    };
  }
  /** Import another analysis-local graph and return its id remapping. */
  importGraph(graph) {
    const remapped = /* @__PURE__ */ new Map();
    for (const node of [...graph.nodes].sort((left, right) => left.id - right.id)) {
      const id = this.add({
        kind: node.kind,
        label: node.label,
        line: node.line,
        parents: node.parents.map((parent) => remapped.get(parent)).filter((parent) => parent !== void 0),
        reason: node.reason
      });
      remapped.set(node.id, id);
    }
    this.truncated ||= graph.truncated;
    return remapped;
  }
  /**
   * Bypass explanation nodes whose uncertainty was later proven to be common
   * to every abstract path and removed from an effect.
   */
  withoutReasons(roots, reasons) {
    const result = [];
    const pending = [...roots];
    const visited = /* @__PURE__ */ new Set();
    while (pending.length > 0) {
      const id = pending.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.nodes[id];
      if (!node) continue;
      if (node.reason && reasons.has(node.reason)) {
        pending.unshift(...node.parents);
      } else {
        result.push(id);
      }
    }
    return normalizeIds(result, MAX_PROVENANCE_PARENTS);
  }
  normalizeParents(parents) {
    return normalizeIds(
      parents.filter((id) => Number.isInteger(id) && id >= 0 && id < this.nodes.length),
      MAX_PROVENANCE_PARENTS
    );
  }
  getBudgetNode(parents) {
    this.truncated = true;
    if (this.budgetNodeId !== null) return this.budgetNodeId;
    const id = this.nodes.length;
    const node = {
      id,
      kind: "budget",
      label: `provenance truncated after ${MAX_PROVENANCE_NODES} nodes`,
      parents: normalizeIds(parents, MAX_PROVENANCE_PARENTS),
      reason: "provenance-budget"
    };
    this.nodes.push(node);
    this.nodeIdsByKey.set(JSON.stringify({
      kind: node.kind,
      label: node.label,
      parents: node.parents,
      reason: node.reason
    }), id);
    this.budgetNodeId = id;
    return id;
  }
};
function normalizeLabel(value) {
  const normalized = value.replace(/\s+/g, " ").trim() || "(unspecified)";
  if (normalized.length <= MAX_PROVENANCE_LABEL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PROVENANCE_LABEL_CHARS - 1)}\u2026`;
}
function normalizeIds(ids, limit) {
  return [...new Set(ids)].sort((left, right) => left - right).slice(0, limit);
}
function positiveLine(line) {
  return line !== void 0 && Number.isInteger(line) && line > 0 ? line : void 0;
}

// src/bash/print_cmd.ts
function print_command(cmd) {
  return print_cmd(cmd, 0);
}
function indent(level) {
  return "  ".repeat(level);
}
function print_cmd(cmd, level) {
  switch (cmd.type) {
    case "simple":
      return print_simple(cmd, level);
    case "for":
      return print_for(cmd, level);
    case "case":
      return print_case(cmd, level);
    case "while":
      return print_while(cmd, level);
    case "until":
      return print_until(cmd, level);
    case "if":
      return print_if(cmd, level);
    case "connection":
      return print_connection(cmd, level);
    case "function_def":
      return print_function(cmd, level);
    case "group":
      return print_group(cmd, level);
    case "subshell":
      return print_subshell(cmd, level);
    case "arith":
      return print_arith(cmd, level);
    case "cond":
      return print_cond(cmd, level);
    default:
      return "<unknown>";
  }
}
function print_words(words) {
  return words.map((w) => w.word).join(" ");
}
function print_redirects(r) {
  const parts = [];
  while (r) {
    let s = "";
    const src = r.redirector.dest;
    switch (r.instruction) {
      case "r_output_direction":
        if (src !== 1) s += src;
        s += "> ";
        break;
      case "r_appending_to":
        if (src !== 1) s += src;
        s += ">> ";
        break;
      case "r_input_direction":
        if (src !== 0) s += src;
        s += "< ";
        break;
      case "r_output_force":
        if (src !== 1) s += src;
        s += ">| ";
        break;
      case "r_input_output":
        if (src !== 0) s += src;
        s += "<> ";
        break;
      case "r_err_and_out":
        s += "&> ";
        break;
      case "r_append_err_and_out":
        s += "&>> ";
        break;
      case "r_reading_until":
        s += "<< ";
        break;
      case "r_deblank_reading_until":
        s += "<<- ";
        break;
      case "r_reading_string":
        if (src !== 0) s += src;
        s += "<<< ";
        break;
      case "r_duplicating_input":
        if (src !== 0) s += src;
        s += "<& ";
        break;
      case "r_duplicating_output":
        if (src !== 1) s += src;
        s += ">& ";
        break;
      case "r_close_this":
        s += src + ">&- ";
        break;
      default:
        s += "? ";
        break;
    }
    if (r.redirectee.filename) {
      s += r.redirectee.filename.word;
    } else if (r.redirectee.dest >= 0) {
      s += String(r.redirectee.dest);
    }
    parts.push(s);
    r = r.next;
  }
  return parts.length ? " " + parts.join(" ") : "";
}
function print_simple(cmd, level) {
  const parts = [];
  for (const a of cmd.assignments) parts.push(a.word);
  for (const w of cmd.words) parts.push(w.word);
  return indent(level) + parts.join(" ") + print_redirects(cmd.redirects);
}
function print_for(cmd, level) {
  let s = indent(level) + "for " + cmd.name.word;
  if (cmd.map_list.length > 0) {
    s += " in " + print_words(cmd.map_list);
  }
  s += "; do\n";
  s += print_cmd(cmd.action, level + 1) + "\n";
  s += indent(level) + "done";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_case(cmd, level) {
  let s = indent(level) + "case " + cmd.word.word + " in\n";
  let clause = cmd.clauses;
  while (clause) {
    s += indent(level + 1) + print_words(clause.patterns) + ")\n";
    if (clause.action) {
      s += print_cmd(clause.action, level + 2) + "\n";
    }
    const terminator = (clause.flags & CASEPAT_FALLTHROUGH) !== 0 ? ";&" : (clause.flags & CASEPAT_TESTNEXT) !== 0 ? ";;&" : ";;";
    s += indent(level + 2) + terminator + "\n";
    clause = clause.next;
  }
  s += indent(level) + "esac";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_while(cmd, level) {
  let s = indent(level) + "while ";
  s += print_cmd(cmd.test, 0) + "; do\n";
  s += print_cmd(cmd.action, level + 1) + "\n";
  s += indent(level) + "done";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_until(cmd, level) {
  let s = indent(level) + "until ";
  s += print_cmd(cmd.test, 0) + "; do\n";
  s += print_cmd(cmd.action, level + 1) + "\n";
  s += indent(level) + "done";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_if(cmd, level) {
  let s = indent(level) + "if " + print_cmd(cmd.test, 0) + "; then\n";
  s += print_cmd(cmd.true_case, level + 1) + "\n";
  if (cmd.false_case) {
    if (cmd.false_case.type === "if") {
      s += indent(level) + "el" + print_cmd(cmd.false_case, 0).trimStart() + "\n";
    } else {
      s += indent(level) + "else\n";
      s += print_cmd(cmd.false_case, level + 1) + "\n";
    }
  }
  s += indent(level) + "fi";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_connection(cmd, level) {
  const first = print_cmd(cmd.first, level);
  if (!cmd.second) {
    if (cmd.connector === AMP) return first + " &";
    return first;
  }
  const second = print_cmd(cmd.second, level);
  switch (cmd.connector) {
    case AND_AND:
      return first + " && " + second.trimStart();
    case OR_OR:
      return first + " || " + second.trimStart();
    case PIPE:
      return first + " | " + second.trimStart();
    case BAR_AND:
      return first + " |& " + second.trimStart();
    case AMP:
      return first + " & " + second.trimStart();
    case SEMI:
    case NEWLINE:
    default:
      return first + "; " + second.trimStart();
  }
}
function print_function(cmd, level) {
  let s = indent(level) + cmd.name.word + " () {\n";
  s += print_cmd(cmd.command, level + 1) + "\n";
  s += indent(level) + "}";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_group(cmd, level) {
  let s = indent(level) + "{\n";
  s += print_cmd(cmd.command, level + 1) + "\n";
  s += indent(level) + "}";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_subshell(cmd, level) {
  let s = indent(level) + "(\n";
  s += print_cmd(cmd.command, level + 1) + "\n";
  s += indent(level) + ")";
  s += print_redirects(cmd.redirects);
  return s;
}
function print_arith(cmd, level) {
  return indent(level) + "(( " + cmd.expression.word + " ))" + print_redirects(cmd.redirects);
}
function print_cond(cmd, level) {
  return indent(level) + "[[ " + print_cond_node(cmd.expression) + " ]]" + print_redirects(cmd.redirects);
}
function print_cond_node(node) {
  let body;
  if (node.type === COND_AND || node.type === COND_OR) {
    const operator = node.type === COND_AND ? "&&" : "||";
    body = `${print_cond_node(node.left)} ${operator} ${print_cond_node(node.right)}`;
  } else if (node.type === COND_EXPR) {
    body = `( ${print_cond_node(node.left)} )`;
  } else if (node.type === COND_UNARY) {
    body = `${node.op?.word ?? "-n"} ${print_cond_node(node.left)}`;
  } else if (node.type === COND_BINARY) {
    body = `${print_cond_node(node.left)} ${node.op?.word ?? "?"} ${print_cond_node(node.right)}`;
  } else if (node.type === COND_TERM) {
    body = node.op?.word ?? "";
  } else if (node.type === COND_UNKNOWN) {
    body = node.words?.map((word) => word.word).join(" ") || "?";
  } else {
    body = "?";
  }
  return (node.flags & CMD_INVERT_RETURN) !== 0 ? `! ${body}` : body;
}

// src/analysis/vfs.ts
var fs3 = __toESM(require("node:fs"), 1);
var import_node_crypto2 = require("node:crypto");
var import_node_path = require("node:path");
var IS_WIN32 = process.platform === "win32";
var MAX_BOUNDED_TEXT_READ_BYTES = 16 * 1024 * 1024;
var MAX_PREDICTED_TEXT_FILE_BYTES = 16 * 1024;
var MAX_GLOB_DIRECTORY_SCANS = 4096;
var MAX_GLOB_VISITED_ENTRIES = 2e4;
var MAX_GLOB_PATH_CANDIDATES = 2e4;
function toPosix(p) {
  const fwd = p.replace(/\\/g, "/");
  const m = fwd.match(/^([a-zA-Z]):\/(.*)/);
  if (m) return "/" + m[1].toLowerCase() + "/" + m[2];
  const b = fwd.match(/^([a-zA-Z]):$/);
  if (b) return "/" + b[1].toLowerCase();
  return fwd;
}
function isAbsolutePath(p) {
  if (p.length === 0) return false;
  if (p[0] === "/") return true;
  if (/^[a-zA-Z]$/.test(p[0]) && p[1] === ":") {
    if (p.length === 2) return true;
    if (p[2] === "/" || p[2] === "\\") return true;
  }
  return false;
}
function toNative(p) {
  if (!IS_WIN32) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (m) return m[1].toUpperCase() + ":\\" + m[2].replace(/\//g, "\\");
  return p;
}
var VirtualFS = class _VirtualFS {
  entries = /* @__PURE__ */ new Map();
  constructor(paths) {
    if (paths) {
      for (const p of paths) {
        if (p.endsWith("/")) {
          this.addDirectory(p.slice(0, -1));
        } else {
          this.addFile(p);
        }
      }
    }
  }
  norm(p) {
    return import_node_path.posix.normalize(p);
  }
  exists(absPath) {
    return this.entries.has(this.norm(absPath));
  }
  isDirectory(absPath) {
    return this.entries.get(this.norm(absPath))?.kind === "directory";
  }
  isFile(absPath) {
    return this.entries.get(this.norm(absPath))?.kind === "file";
  }
  isSymbolicLink() {
    return false;
  }
  readdir(dirPath) {
    const dir = this.norm(dirPath);
    const results = [];
    for (const [p] of this.entries) {
      const parent = import_node_path.posix.dirname(p);
      if (parent === dir && p !== dir) {
        results.push(import_node_path.posix.basename(p));
      }
    }
    return results.sort();
  }
  readTextFile(absPath, maxBytes) {
    const entry = this.entries.get(this.norm(absPath));
    if (entry === void 0) return { kind: "unavailable", reason: "missing" };
    if (entry.kind === "directory") return { kind: "unavailable", reason: "directory" };
    return readOverlayText(entry.text, maxBytes);
  }
  updateTextFile(absPath, text, mode) {
    const n = this.norm(absPath);
    const current = this.entries.get(n);
    if (current?.kind === "directory") return false;
    const base = mode === "append" ? current?.kind === "file" ? current.text : "" : "";
    this.entries.set(n, {
      kind: "file",
      text: combinePredictedText(base, text)
    });
    this._ensureParents(n);
    return true;
  }
  addFile(absPath) {
    const n = this.norm(absPath);
    this.entries.set(n, { kind: "file", text: null });
    this._ensureParents(n);
  }
  addDirectory(absPath) {
    const n = this.norm(absPath);
    this.entries.set(n, { kind: "directory" });
    this._ensureParents(n);
  }
  remove(absPath) {
    const n = this.norm(absPath);
    this.entries.delete(n);
    const prefix = n + "/";
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
  clone() {
    const copy = new _VirtualFS();
    copy.entries = new Map(this.entries);
    return copy;
  }
  stateKey() {
    return JSON.stringify([
      "virtual",
      [...this.entries].sort(([left], [right]) => left.localeCompare(right)).map(([entryPath, entry]) => [entryPath, entryStateKey(entry)])
    ]);
  }
  _ensureParents(p) {
    let dir = import_node_path.posix.dirname(p);
    while (dir !== p && dir !== "/" && dir !== ".") {
      if (!this.entries.has(dir)) {
        this.entries.set(dir, { kind: "directory" });
      }
      p = dir;
      dir = import_node_path.posix.dirname(dir);
    }
    if (!this.entries.has("/")) {
      this.entries.set("/", { kind: "directory" });
    }
  }
};
var RealFS = class _RealFS {
  added = /* @__PURE__ */ new Map();
  removed = /* @__PURE__ */ new Set();
  norm(p) {
    return import_node_path.posix.normalize(p);
  }
  exists(absPath) {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return false;
    if (this.added.has(n)) return true;
    try {
      fs3.statSync(toNative(n));
      return true;
    } catch {
      return false;
    }
  }
  isDirectory(absPath) {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return false;
    const ov = this.added.get(n);
    if (ov !== void 0) return ov.kind === "directory";
    try {
      return fs3.statSync(toNative(n)).isDirectory();
    } catch {
      return false;
    }
  }
  isFile(absPath) {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return false;
    const ov = this.added.get(n);
    if (ov !== void 0) return ov.kind === "file";
    try {
      return fs3.statSync(toNative(n)).isFile();
    } catch {
      return false;
    }
  }
  isSymbolicLink(absPath) {
    const n = this.norm(absPath);
    if (this.removed.has(n) || this.added.has(n)) return false;
    try {
      return fs3.lstatSync(toNative(n)).isSymbolicLink();
    } catch {
      return false;
    }
  }
  readdir(dirPath) {
    const dir = this.norm(dirPath);
    const names = /* @__PURE__ */ new Set();
    try {
      for (const name of fs3.readdirSync(toNative(dir))) {
        const full = import_node_path.posix.join(dir, name);
        if (!this.removed.has(full)) {
          names.add(name);
        }
      }
    } catch {
    }
    for (const [p] of this.added) {
      if (import_node_path.posix.dirname(p) === dir) {
        const name = import_node_path.posix.basename(p);
        if (!this.removed.has(p)) {
          names.add(name);
        }
      }
    }
    return [...names].sort();
  }
  readTextFile(absPath, maxBytes) {
    const n = this.norm(absPath);
    if (this.removed.has(n)) return { kind: "unavailable", reason: "missing" };
    const overlay = this.added.get(n);
    if (overlay?.kind === "directory") {
      return { kind: "unavailable", reason: "directory" };
    }
    if (overlay?.kind === "file") {
      return readOverlayText(overlay.text, maxBytes);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BOUNDED_TEXT_READ_BYTES) {
      return { kind: "unavailable", reason: "too-large" };
    }
    let fd;
    try {
      fd = fs3.openSync(
        toNative(n),
        fs3.constants.O_RDONLY | fs3.constants.O_NONBLOCK
      );
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") return { kind: "unavailable", reason: "missing" };
      if (code === "EISDIR") return { kind: "unavailable", reason: "directory" };
      return { kind: "unavailable", reason: "unreadable" };
    }
    try {
      const before = fs3.fstatSync(fd);
      if (before.isDirectory()) return { kind: "unavailable", reason: "directory" };
      if (!before.isFile()) return { kind: "unavailable", reason: "special-file" };
      if (before.size > maxBytes) return { kind: "unavailable", reason: "too-large" };
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs3.readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) return { kind: "unavailable", reason: "too-large" };
      const after = fs3.fstatSync(fd);
      if (before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        return { kind: "unavailable", reason: "changed-during-read" };
      }
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) return { kind: "unavailable", reason: "nul-byte" };
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        return { kind: "unavailable", reason: "not-utf8" };
      }
      return { kind: "text", text, byteLength: length };
    } catch {
      return { kind: "unavailable", reason: "unreadable" };
    } finally {
      try {
        fs3.closeSync(fd);
      } catch {
      }
    }
  }
  updateTextFile(absPath, text, mode) {
    const n = this.norm(absPath);
    const overlay = this.added.get(n);
    if (overlay?.kind === "directory") return false;
    let base = "";
    if (mode === "append") {
      if (overlay?.kind === "file") {
        base = overlay.text;
      } else if (!this.removed.has(n)) {
        const diskKind = this.diskEntryKind(n);
        if (diskKind === "directory" || diskKind === "special") return false;
        if (diskKind === "unknown") base = null;
        if (diskKind === "file") {
          const existing = this.readTextFile(
            n,
            MAX_PREDICTED_TEXT_FILE_BYTES
          );
          base = existing.kind === "text" ? existing.text : null;
        }
      }
    } else if (overlay === void 0 && !this.removed.has(n)) {
      const diskKind = this.diskEntryKind(n);
      if (diskKind === "directory" || diskKind === "special") return false;
      if (diskKind === "unknown") text = null;
    }
    this.removed.delete(n);
    this.added.set(n, {
      kind: "file",
      text: combinePredictedText(base, text)
    });
    return true;
  }
  addFile(absPath) {
    const n = this.norm(absPath);
    this.removed.delete(n);
    this.added.set(n, { kind: "file", text: null });
  }
  addDirectory(absPath) {
    const n = this.norm(absPath);
    this.removed.delete(n);
    this.added.set(n, { kind: "directory" });
  }
  remove(absPath) {
    const n = this.norm(absPath);
    this.added.delete(n);
    this.removed.add(n);
  }
  clone() {
    const copy = new _RealFS();
    copy.added = new Map(this.added);
    copy.removed = new Set(this.removed);
    return copy;
  }
  stateKey() {
    return JSON.stringify([
      "real-overlay",
      [...this.added].sort(([left], [right]) => left.localeCompare(right)).map(([entryPath, entry]) => [entryPath, entryStateKey(entry)]),
      [...this.removed].sort()
    ]);
  }
  diskEntryKind(absPath) {
    try {
      const stat = fs3.statSync(toNative(absPath));
      if (stat.isFile()) return "file";
      if (stat.isDirectory()) return "directory";
      return "special";
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "unknown";
    }
  }
};
function readOverlayText(text, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BOUNDED_TEXT_READ_BYTES) {
    return { kind: "unavailable", reason: "too-large" };
  }
  if (text === null) {
    return { kind: "unavailable", reason: "overlay-content-unknown" };
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    return { kind: "unavailable", reason: "too-large" };
  }
  if (text.includes("\0")) {
    return { kind: "unavailable", reason: "nul-byte" };
  }
  return { kind: "text", text, byteLength };
}
function combinePredictedText(base, addition) {
  if (base === null || addition === null) return null;
  const combined = base + addition;
  return Buffer.byteLength(combined, "utf8") <= MAX_PREDICTED_TEXT_FILE_BYTES ? combined : null;
}
function entryStateKey(entry) {
  if (entry.kind === "directory") return ["directory"];
  if (entry.text === null) return ["file", "unknown"];
  return [
    "file",
    Buffer.byteLength(entry.text, "utf8"),
    (0, import_node_crypto2.createHash)("sha256").update(entry.text, "utf8").digest("hex")
  ];
}
function glob_segment_to_regex(segment) {
  let re = "^";
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i++;
        continue;
      }
      let j = i + 1;
      let cls = "[";
      if (j < segment.length && (segment[j] === "!" || segment[j] === "^")) {
        cls += "^";
        j++;
      }
      while (j < segment.length && segment[j] !== "]") {
        cls += segment[j];
        j++;
      }
      if (j < segment.length) {
        cls += "]";
        j++;
      }
      re += cls;
      i = j;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}
function glob_match_segment(pattern, value) {
  if (value.startsWith(".") && !pattern.startsWith(".")) return false;
  return glob_segment_to_regex(pattern).test(value);
}
function has_glob_chars(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "*" || s[i] === "?") return true;
    if (s[i] === "[" && s.indexOf("]", i + 1) !== -1) return true;
  }
  return false;
}
function createGlobExpansionBudget(limits = {}) {
  return {
    maxDirectoryScans: boundedGlobLimit(
      limits.maxDirectoryScans,
      MAX_GLOB_DIRECTORY_SCANS
    ),
    maxVisitedEntries: boundedGlobLimit(
      limits.maxVisitedEntries,
      MAX_GLOB_VISITED_ENTRIES
    ),
    maxPathCandidates: boundedGlobLimit(
      limits.maxPathCandidates,
      MAX_GLOB_PATH_CANDIDATES
    ),
    directoryScans: 0,
    visitedEntries: 0,
    pathCandidates: 0,
    exhaustedReasons: /* @__PURE__ */ new Set()
  };
}
function glob_expand_bounded(pattern, cwd, vfs, options = {}) {
  const posixPattern = toPosix(pattern);
  const absPattern = isAbsolutePath(pattern) ? posixPattern : import_node_path.posix.join(cwd, posixPattern);
  const segments = collapseAdjacentGlobstars(
    absPattern.split("/").filter((s) => s !== "")
  );
  const budget = options.budget ?? createGlobExpansionBudget();
  const maxMatches = boundedGlobLimit(
    options.maxMatches,
    Number.MAX_SAFE_INTEGER,
    true
  );
  const localReasons = /* @__PURE__ */ new Set();
  const directoryCache = /* @__PURE__ */ new Map();
  let candidates;
  let startIdx;
  if (IS_WIN32 && segments.length > 0 && /^[a-zA-Z]$/.test(segments[0])) {
    candidates = /* @__PURE__ */ new Set(["/" + segments[0]]);
    startIdx = 1;
  } else {
    candidates = /* @__PURE__ */ new Set(["/"]);
    startIdx = 0;
  }
  for (let si = startIdx; si < segments.length; si++) {
    const seg = segments[si];
    const isLast = si === segments.length - 1;
    const nextCandidates = /* @__PURE__ */ new Set();
    if (seg === "**") {
      expandGlobstarCandidates(
        candidates,
        nextCandidates,
        isLast,
        vfs,
        budget,
        maxMatches,
        localReasons,
        directoryCache
      );
    } else if (has_glob_chars(seg)) {
      const re = glob_segment_to_regex(seg);
      for (const cand of candidates) {
        if (!vfs.isDirectory(cand)) continue;
        const read = readGlobDirectory(cand, vfs, budget, directoryCache);
        if (!read.complete) {
          for (const reason of budget.exhaustedReasons) localReasons.add(reason);
        }
        for (const name of read.names) {
          if (name.startsWith(".") && !seg.startsWith(".")) continue;
          if (re.test(name)) {
            const added = addGlobPath(
              nextCandidates,
              import_node_path.posix.join(cand, name),
              isLast,
              budget,
              maxMatches,
              localReasons
            );
            if (!added) break;
          }
        }
        if (globExpansionStopped(budget, localReasons)) break;
      }
    } else {
      for (const cand of candidates) {
        const full = import_node_path.posix.join(cand, seg);
        if (vfs.exists(full)) {
          const added = addGlobPath(
            nextCandidates,
            full,
            isLast,
            budget,
            maxMatches,
            localReasons
          );
          if (!added) break;
        }
      }
    }
    candidates = nextCandidates;
    if (candidates.size === 0) break;
  }
  const limitReasons = [
    .../* @__PURE__ */ new Set([
      ...budget.exhaustedReasons,
      ...localReasons
    ])
  ].sort();
  return {
    matches: [...candidates].sort(),
    complete: limitReasons.length === 0,
    limitReasons,
    directoryScans: budget.directoryScans,
    visitedEntries: budget.visitedEntries,
    pathCandidates: budget.pathCandidates
  };
}
function glob_expand(pattern, cwd, vfs) {
  const result = glob_expand_bounded(pattern, cwd, vfs);
  return result.complete ? result.matches : [.../* @__PURE__ */ new Set([...result.matches, pattern])];
}
function collapseAdjacentGlobstars(segments) {
  const collapsed = [];
  for (const segment of segments) {
    if (segment === "**" && collapsed[collapsed.length - 1] === "**") continue;
    collapsed.push(segment);
  }
  return collapsed;
}
function expandGlobstarCandidates(roots, output, terminal, vfs, budget, maxMatches, localReasons, directoryCache) {
  const queue = [...roots];
  const reachable = new Set(roots);
  let cursor = 0;
  while (cursor < queue.length) {
    const directory = queue[cursor++];
    if (!addGlobPath(
      output,
      directory,
      terminal,
      budget,
      maxMatches,
      localReasons,
      false
    )) {
      return;
    }
    const read = readGlobDirectory(directory, vfs, budget, directoryCache);
    if (!read.complete) {
      for (const reason of budget.exhaustedReasons) localReasons.add(reason);
    }
    for (const name of read.names) {
      if (name.startsWith(".")) continue;
      const full = import_node_path.posix.join(directory, name);
      if (terminal && !addGlobPath(
        output,
        full,
        true,
        budget,
        maxMatches,
        localReasons,
        false
      )) {
        return;
      }
      if (!vfs.isDirectory(full) || vfs.isSymbolicLink(full) || reachable.has(full)) {
        continue;
      }
      if (!consumeGlobCandidate(budget)) {
        localReasons.add("path-candidate-limit");
        return;
      }
      reachable.add(full);
      queue.push(full);
      if (!terminal) output.add(full);
    }
    if (budget.exhaustedReasons.size > 0) return;
  }
}
function readGlobDirectory(directory, vfs, budget, cache) {
  const cached = cache.get(directory);
  if (cached) return cached;
  if (budget.directoryScans >= budget.maxDirectoryScans) {
    budget.exhaustedReasons.add("directory-scan-limit");
    return { names: [], complete: false };
  }
  budget.directoryScans++;
  const names = vfs.readdir(directory);
  const remaining = budget.maxVisitedEntries - budget.visitedEntries;
  if (names.length > remaining) {
    const bounded = {
      names: names.slice(0, Math.max(0, remaining)),
      complete: false
    };
    budget.visitedEntries += bounded.names.length;
    budget.exhaustedReasons.add("visited-entry-limit");
    cache.set(directory, bounded);
    return bounded;
  }
  budget.visitedEntries += names.length;
  const complete = { names, complete: true };
  cache.set(directory, complete);
  return complete;
}
function addGlobPath(output, value, terminal, budget, maxMatches, reasons, consumeCandidate = true) {
  if (output.has(value)) return true;
  if (terminal) {
    if (output.size >= maxMatches) {
      reasons.add("match-limit");
      return false;
    }
  } else if (consumeCandidate && !consumeGlobCandidate(budget)) {
    reasons.add("path-candidate-limit");
    return false;
  }
  output.add(value);
  return true;
}
function consumeGlobCandidate(budget) {
  if (budget.pathCandidates >= budget.maxPathCandidates) {
    budget.exhaustedReasons.add("path-candidate-limit");
    return false;
  }
  budget.pathCandidates++;
  return true;
}
function globExpansionStopped(budget, localReasons) {
  return budget.exhaustedReasons.size > 0 || localReasons.has("match-limit");
}
function boundedGlobLimit(value, fallback, allowZero = false) {
  if (value === void 0) return fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) return fallback;
  return value;
}

// src/analysis/postprocess.ts
var fs4 = __toESM(require("node:fs"), 1);
var nodePath = __toESM(require("node:path"), 1);

// src/analysis/effects.ts
var import_node_path2 = require("node:path");
var PATH_UNCERTAINTY_REASONS = /* @__PURE__ */ new Set([
  "unresolved-expansion",
  "glob-without-fs",
  "command-substitution",
  "derived-path",
  "state-widening"
]);
var EffectTracker = class _EffectTracker {
  effects = [];
  gitEffects = [];
  resourceEffects = [];
  warnings = [];
  cwd;
  _vfs;
  ephemeralPaths = /* @__PURE__ */ new Set();
  intrinsicUncertainty = /* @__PURE__ */ new WeakMap();
  provenanceStore = new ProvenanceStore();
  constructor(cwd, vfs) {
    this.cwd = toPosix(cwd);
    this._vfs = vfs ?? null;
  }
  get vfs() {
    return this._vfs;
  }
  /** Replace the active branch overlay without changing accumulated effects. */
  setVfs(vfs) {
    this._vfs = vfs;
  }
  /** Update the current working directory (when `cd` is simulated) */
  setCwd(newCwd) {
    this.cwd = toPosix(newCwd);
  }
  getCwd() {
    return this.cwd;
  }
  /** Resolve a path against the current working directory (handles Windows drive paths) */
  resolvePath(p) {
    const posix2 = toPosix(p);
    if (isAbsolutePath(p)) return import_node_path2.posix.normalize(posix2);
    return import_node_path2.posix.normalize(import_node_path2.posix.join(this.cwd, posix2));
  }
  isKnownDirectory(p) {
    const resolved = this.resolvePath(p);
    if (this.vfs?.isDirectory(resolved)) return true;
    const prefix = resolved === "/" ? "/" : `${resolved}/`;
    return resolved === this.cwd || this.cwd.startsWith(prefix);
  }
  /**
   * Register a shell-created handle such as a process-substitution `/dev/fd`
   * path. Commands may read or write the handle, but it is not a user file
   * whose replacement belongs in the data-loss inventory.
   */
  registerEphemeralPath(p) {
    const resolved = this.resolvePath(p);
    this.ephemeralPaths.add(resolved);
    return resolved;
  }
  isEphemeralPath(p) {
    return this.ephemeralPaths.has(this.resolvePath(p));
  }
  addProvenance(input) {
    return this.provenanceStore.add(this.withActiveProvenance(input));
  }
  withProvenance(input, run) {
    return this.provenanceStore.withNode(
      this.withActiveProvenance(input),
      run
    );
  }
  getProvenanceGraph() {
    return this.provenanceStore.graph();
  }
  currentProvenance() {
    return this.provenanceStore.currentParents();
  }
  /** Check if a string contains unresolved expansions */
  static hasUncertainty(s) {
    return _EffectTracker.uncertaintyReasons(s).length > 0;
  }
  static uncertaintyReasons(s) {
    const reasons = /* @__PURE__ */ new Set();
    if (/\$\(/.test(s) || /<\$\(/.test(s)) reasons.add("command-substitution");
    if (/\$[\w{(]/.test(s)) reasons.add("unresolved-expansion");
    if (has_glob_chars(s)) reasons.add("glob-without-fs");
    return [...reasons];
  }
  static hasPathUncertainty(effect) {
    if (!effect.uncertain) return false;
    if (!effect.uncertainty) return true;
    return effect.uncertainty.some((reason) => PATH_UNCERTAINTY_REASONS.has(reason));
  }
  add(effect, options = {}) {
    const resolved = this.resolvePath(effect.path);
    if (this.ephemeralPaths.has(resolved)) return;
    const pathReasons = _EffectTracker.uncertaintyReasons(effect.path);
    const uncertainty = [.../* @__PURE__ */ new Set([...effect.uncertainty ?? [], ...pathReasons])];
    const uncertain = effect.uncertain === true || uncertainty.length > 0;
    const certainty = effect.certainty ?? (uncertain ? "unknown" : "exact");
    const sourcePath = effect.sourcePath ?? (effect.source ? this.resolvePath(effect.source) : void 0);
    const modelNode = this.provenanceStore.add({
      kind: "command-model",
      label: `${effect.command} predicts ${effect.type}`,
      line: effect.line,
      parents: effect.provenance && effect.provenance.length > 0 ? effect.provenance : this.provenanceStore.currentParents()
    });
    let provenance = [modelNode];
    const updatesVfs = this.vfs && !uncertain && options.updateVfs !== false && effectUpdatesVfs(effect.type);
    if (updatesVfs) {
      provenance = [this.provenanceStore.add({
        kind: "vfs-transition",
        label: `${effect.type} ${resolved}`,
        line: effect.line,
        parents: provenance
      })];
    }
    const tracked = {
      ...effect,
      path: resolved,
      sourcePath,
      uncertain,
      certainty,
      uncertainty,
      provenance
    };
    this.attachUncertaintyProvenance(tracked, uncertainty);
    this.effects.push(tracked);
    this.rememberIntrinsicUncertainty(tracked, uncertainty);
    if (this.vfs && !uncertain && options.updateVfs !== false) {
      const t = effect.type;
      if (t === "write" || t === "append" || t === "copy" || t === "link" || t === "truncate") {
        this.vfs.addFile(resolved);
      } else if (t === "mkdir") {
        this.vfs.addDirectory(resolved);
      } else if (t === "delete") {
        this.vfs.remove(resolved);
      } else if (t === "move") {
        if (sourcePath) this.vfs.remove(sourcePath);
        this.vfs.addFile(resolved);
      }
    }
  }
  addGit(effect) {
    const uncertainty = [...new Set(effect.uncertainty ?? [])];
    const uncertain = effect.uncertain === true || uncertainty.length > 0 || effect.completeness === "partial";
    const certainty = effect.certainty ?? (uncertain ? "unknown" : "exact");
    const tracked = {
      ...effect,
      kind: "git",
      repository: { ...effect.repository },
      selection: {
        ...effect.selection,
        pathspecs: effect.selection.pathspecs ? [...effect.selection.pathspecs] : void 0
      },
      uncertain,
      certainty,
      uncertainty,
      provenance: [this.provenanceStore.add({
        kind: "command-model",
        label: `${effect.command} predicts ${effect.domain}/${effect.operation}`,
        line: effect.line,
        parents: effect.provenance && effect.provenance.length > 0 ? effect.provenance : this.provenanceStore.currentParents()
      })]
    };
    this.attachUncertaintyProvenance(tracked, uncertainty);
    this.gitEffects.push(tracked);
    this.rememberIntrinsicUncertainty(tracked, uncertainty);
  }
  addResource(effect) {
    const uncertainty = [...new Set(effect.uncertainty ?? [])];
    const uncertain = effect.uncertain === true || uncertainty.length > 0 || effect.completeness === "partial";
    const certainty = effect.certainty ?? (uncertain ? "unknown" : "exact");
    const tracked = {
      ...effect,
      kind: "resource",
      selection: { ...effect.selection },
      uncertain,
      certainty,
      uncertainty,
      provenance: [this.provenanceStore.add({
        kind: "command-model",
        label: `${effect.command} predicts ${effect.domain}/${effect.operation}`,
        line: effect.line,
        parents: effect.provenance && effect.provenance.length > 0 ? effect.provenance : this.provenanceStore.currentParents()
      })]
    };
    this.attachUncertaintyProvenance(tracked, uncertainty);
    this.resourceEffects.push(tracked);
    this.rememberIntrinsicUncertainty(tracked, uncertainty);
  }
  addWarning(msg) {
    this.warnings.push(msg);
  }
  merge(other) {
    const provenanceIds = this.provenanceStore.importGraph(
      other.getProvenanceGraph()
    );
    const remap = (roots) => normalizeEffectProvenance((roots ?? []).map((root) => provenanceIds.get(root)).filter((root) => root !== void 0));
    const files = other.effects.map((effect) => ({
      ...effect,
      uncertainty: [...effect.uncertainty],
      provenance: remap(effect.provenance)
    }));
    const git = other.gitEffects.map((effect) => ({
      ...effect,
      repository: { ...effect.repository },
      selection: {
        ...effect.selection,
        pathspecs: effect.selection.pathspecs ? [...effect.selection.pathspecs] : void 0
      },
      uncertainty: [...effect.uncertainty],
      provenance: remap(effect.provenance)
    }));
    const resources = other.resourceEffects.map((effect) => ({
      ...effect,
      selection: { ...effect.selection },
      uncertainty: [...effect.uncertainty],
      provenance: remap(effect.provenance)
    }));
    this.effects.push(...files);
    this.gitEffects.push(...git);
    this.resourceEffects.push(...resources);
    this.warnings.push(...other.warnings);
    for (const ephemeralPath of other.ephemeralPaths) {
      this.ephemeralPaths.add(ephemeralPath);
    }
    for (const [original, merged] of [
      ...other.effects.map((effect, index) => [effect, files[index]]),
      ...other.gitEffects.map((effect, index) => [effect, git[index]]),
      ...other.resourceEffects.map((effect, index) => [effect, resources[index]])
    ]) {
      const intrinsic = other.intrinsicUncertainty.get(original);
      if (intrinsic) this.intrinsicUncertainty.set(merged, new Set(intrinsic));
    }
  }
  checkpoint() {
    return { files: this.effects.length, git: this.gitEffects.length, resources: this.resourceEffects.length };
  }
  markAllEffectsFrom(checkpoint, uncertainty, certainty = "overapprox") {
    this.markEffectsFrom(checkpoint.files, uncertainty, certainty, true);
    this.markGitEffectsFrom(checkpoint.git, uncertainty, certainty, true);
    this.markResourceEffectsFrom(checkpoint.resources, uncertainty, certainty, true);
  }
  markInheritedExecutionUncertaintyFrom(checkpoint, uncertainty, certainty = "overapprox") {
    this.markEffectsFrom(checkpoint.files, uncertainty, certainty, false);
    this.markGitEffectsFrom(checkpoint.git, uncertainty, certainty, false);
    this.markResourceEffectsFrom(checkpoint.resources, uncertainty, certainty, false);
  }
  markEffectsFrom(startIndex, uncertainty, certainty = "overapprox", intrinsic = true) {
    for (let i = startIndex; i < this.effects.length; i++) {
      const e = this.effects[i];
      const added = uncertainty.filter((reason) => !e.uncertainty.includes(reason));
      e.uncertain = true;
      e.certainty = e.certainty === "unknown" ? "unknown" : certainty;
      e.uncertainty = [.../* @__PURE__ */ new Set([...e.uncertainty, ...uncertainty])];
      this.attachUncertaintyProvenance(e, added);
      if (intrinsic) this.rememberIntrinsicUncertainty(e, uncertainty);
    }
  }
  markGitEffectsFrom(startIndex, uncertainty, certainty = "overapprox", intrinsic = true) {
    for (let i = startIndex; i < this.gitEffects.length; i++) {
      const effect = this.gitEffects[i];
      const added = uncertainty.filter((reason) => !effect.uncertainty.includes(reason));
      effect.uncertain = true;
      effect.certainty = effect.certainty === "unknown" ? "unknown" : certainty;
      effect.uncertainty = [.../* @__PURE__ */ new Set([...effect.uncertainty, ...uncertainty])];
      this.attachUncertaintyProvenance(effect, added);
      if (intrinsic) this.rememberIntrinsicUncertainty(effect, uncertainty);
    }
  }
  markResourceEffectsFrom(startIndex, uncertainty, certainty = "overapprox", intrinsic = true) {
    for (let i = startIndex; i < this.resourceEffects.length; i++) {
      const effect = this.resourceEffects[i];
      const added = uncertainty.filter((reason) => !effect.uncertainty.includes(reason));
      effect.uncertain = true;
      effect.certainty = effect.certainty === "unknown" ? "unknown" : certainty;
      effect.uncertainty = [.../* @__PURE__ */ new Set([...effect.uncertainty, ...uncertainty])];
      this.attachUncertaintyProvenance(effect, added);
      if (intrinsic) this.rememberIntrinsicUncertainty(effect, uncertainty);
    }
  }
  /**
   * A single AST operation can be reached through several abstract paths.
   * Effects are a may-happen set, so merge identical path witnesses produced
   * by that operation instead of presenting them as repeated executions.
   */
  deduplicateAllFrom(checkpoint) {
    this.effects = deduplicateEffects(
      this.effects,
      checkpoint.files,
      this.intrinsicUncertainty,
      this.provenanceStore
    );
    this.gitEffects = deduplicateEffects(
      this.gitEffects,
      checkpoint.git,
      this.intrinsicUncertainty,
      this.provenanceStore
    );
    this.resourceEffects = deduplicateEffects(
      this.resourceEffects,
      checkpoint.resources,
      this.intrinsicUncertainty,
      this.provenanceStore
    );
  }
  identitiesFrom(checkpoint) {
    return {
      files: new Set(this.effects.slice(checkpoint.files).map(effectIdentityKey)),
      git: new Set(this.gitEffects.slice(checkpoint.git).map(effectIdentityKey)),
      resources: new Set(this.resourceEffects.slice(checkpoint.resources).map(effectIdentityKey))
    };
  }
  removeExecutionUncertaintyFrom(checkpoint, identities, reasons) {
    const removable = new Set(reasons);
    removeExecutionUncertainty(
      this.effects.slice(checkpoint.files),
      identities.files,
      removable,
      this.intrinsicUncertainty,
      this.provenanceStore
    );
    removeExecutionUncertainty(
      this.gitEffects.slice(checkpoint.git),
      identities.git,
      removable,
      this.intrinsicUncertainty,
      this.provenanceStore
    );
    removeExecutionUncertainty(
      this.resourceEffects.slice(checkpoint.resources),
      identities.resources,
      removable,
      this.intrinsicUncertainty,
      this.provenanceStore
    );
  }
  rememberIntrinsicUncertainty(effect, uncertainty) {
    const existing = this.intrinsicUncertainty.get(effect) ?? /* @__PURE__ */ new Set();
    for (const reason of uncertainty) existing.add(reason);
    this.intrinsicUncertainty.set(effect, existing);
  }
  attachUncertaintyProvenance(effect, uncertainty) {
    let roots = effect.provenance ?? [];
    for (const reason of uncertainty) {
      roots = [this.provenanceStore.add({
        kind: provenanceKindForReason(reason),
        label: provenanceLabelForReason(reason),
        line: effect.line,
        parents: roots,
        reason
      })];
    }
    effect.provenance = roots;
  }
  withActiveProvenance(input) {
    if (!input.parents) return input;
    return {
      ...input,
      parents: [
        ...this.provenanceStore.currentParents(),
        ...input.parents
      ]
    };
  }
};
function deduplicateEffects(effects, startIndex, intrinsicUncertainty, provenanceStore) {
  const prefix = effects.slice(0, startIndex);
  const unique = /* @__PURE__ */ new Map();
  for (const effect of effects.slice(startIndex)) {
    const key = effectIdentityKey(effect);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, effect);
      continue;
    }
    existing.uncertain ||= effect.uncertain;
    existing.certainty = joinEffectCertainty(existing.certainty, effect.certainty);
    existing.uncertainty = [.../* @__PURE__ */ new Set([...existing.uncertainty, ...effect.uncertainty])];
    const existingRoots = normalizeEffectProvenance(existing.provenance ?? []);
    const incomingRoots = normalizeEffectProvenance(effect.provenance ?? []);
    const mergedRoots = normalizeEffectProvenance([
      ...existing.provenance ?? [],
      ...effect.provenance ?? []
    ]);
    existing.provenance = sameProvenanceRoots(existingRoots, incomingRoots) ? mergedRoots : [provenanceStore.add({
      kind: "state-join",
      label: "merge equivalent predicted effect paths",
      line: existing.line,
      parents: mergedRoots
    })];
    const mergedIntrinsic = /* @__PURE__ */ new Set([
      ...intrinsicUncertainty.get(existing) ?? [],
      ...intrinsicUncertainty.get(effect) ?? effect.uncertainty
    ]);
    intrinsicUncertainty.set(existing, mergedIntrinsic);
  }
  return [...prefix, ...unique.values()];
}
function effectIdentityKey(effect) {
  return JSON.stringify({
    ...effect,
    uncertain: void 0,
    certainty: void 0,
    uncertainty: void 0,
    provenance: void 0
  });
}
function removeExecutionUncertainty(effects, identities, removable, intrinsicUncertainty, provenanceStore) {
  for (const effect of effects) {
    if (!identities.has(effectIdentityKey(effect))) continue;
    const intrinsic = intrinsicUncertainty.get(effect) ?? new Set(effect.uncertainty);
    const previousUncertainty = effect.uncertainty;
    effect.uncertainty = effect.uncertainty.filter((reason) => !removable.has(reason) || intrinsic.has(reason));
    const removed = new Set(
      previousUncertainty.filter((reason) => !effect.uncertainty.includes(reason))
    );
    if (removed.size > 0 && effect.provenance) {
      effect.provenance = provenanceStore.withoutReasons(
        effect.provenance,
        removed
      );
    }
    if (effect.uncertainty.length === 0 && effect.certainty === "overapprox") {
      effect.uncertain = false;
      effect.certainty = "exact";
    }
  }
}
function effectUpdatesVfs(type) {
  return type === "write" || type === "append" || type === "copy" || type === "link" || type === "truncate" || type === "mkdir" || type === "delete" || type === "move";
}
function provenanceKindForReason(reason) {
  if (reason === "state-widening") return "state-join";
  if (reason === "unresolved-expansion" || reason === "command-substitution" || reason === "derived-path" || reason === "glob-without-fs") {
    return "expansion";
  }
  if (reason === "command-identity" || reason === "unknown-command") {
    return "command-model";
  }
  if (reason === "pipeline-race" || reason === "background-race") {
    return "state-join";
  }
  return "control-guard";
}
function provenanceLabelForReason(reason) {
  return `precision widened: ${reason}`;
}
function normalizeEffectProvenance(ids) {
  return [...new Set(ids)].sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}
function sameProvenanceRoots(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
function joinEffectCertainty(left, right) {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "overapprox" || right === "overapprox") return "overapprox";
  return "exact";
}

// src/analysis/path-policy.ts
function toPosixForPolicy(path12) {
  if (!path12 || typeof path12 !== "string") return "";
  const match = /^([A-Za-z]):([\\/].*)?$/.exec(path12);
  if (match) {
    const rest = (match[2] || "").replace(/\\/g, "/");
    return `/${match[1]}${rest}`.toLowerCase();
  }
  return path12.replace(/\\/g, "/").toLowerCase();
}
function isCatastrophicPath(path12, platform = process.platform) {
  const normalized = toPosixForPolicy(path12);
  if (normalized === "/" || normalized === "/*") return true;
  if (platform !== "win32") return false;
  return /^\/[a-z]$/.test(normalized) || /^\/[a-z]\/$/.test(normalized) || /^\/[a-z]\/\*$/.test(normalized);
}
function isSystemPath(path12, platform = process.platform) {
  const normalized = toPosixForPolicy(path12);
  if (platform === "darwin") {
    return hasPathPrefix(normalized, "/system") || hasPathPrefix(normalized, "/library");
  }
  if (platform === "win32") {
    const drive = windowsSystemDrive();
    return hasPathPrefix(normalized, `${drive}/windows`) || hasPathPrefix(normalized, `${drive}/program files`) || hasPathPrefix(normalized, `${drive}/program files (x86)`) || hasPathPrefix(normalized, `${drive}/programdata`);
  }
  return false;
}
function isUnresolvedCatastrophicDelete(path12, platform = process.platform) {
  return isCatastrophicPath(path12, platform);
}
function hasPathPrefix(path12, prefix) {
  return path12 === prefix || path12.startsWith(`${prefix}/`);
}
function windowsSystemDrive() {
  const configured = process.env["SystemDrive"] || process.env["SYSTEMDRIVE"] || process.env["SystemRoot"] || process.env["SYSTEMROOT"] || process.env["windir"] || process.env["WINDIR"] || "C:";
  const normalized = toPosixForPolicy(configured);
  const match = /^\/([a-z])(?:\/|$)/.exec(normalized);
  return match ? `/${match[1]}` : "/c";
}

// src/analysis/postprocess.ts
var MAX_FILES = 1e4;
var MAX_VISITED_ENTRIES = 2e4;
var MAX_DEPTH = 128;
var MAX_WALK_ELAPSED_MS = 2e3;
var MAX_PER_GROUP = 10;
var MAX_OBSERVATIONS = 50;
var MAX_EFFECT_INDEXES_PER_OBSERVATION = 8;
var DISPOSABLE_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git"]);
var FILE_EXTENSION_IGNORE_LIST = /* @__PURE__ */ new Set([
  // Churny generated files remain factual observations but are excluded from
  // the initial policy counters to preserve the existing threshold policy.
  "tmp",
  "temp",
  "log",
  "lock",
  "pid",
  "sock",
  "swp",
  "swo",
  "swn",
  "part",
  "cache",
  "bak",
  "old",
  "orig",
  "rej",
  "pyc",
  "pyo",
  "class",
  "o",
  "obj",
  "lo",
  "d",
  "map",
  "exe",
  "dll",
  "lib",
  "so",
  "dylib",
  "a",
  "la",
  "pdb",
  "ilk",
  "exp",
  "idb",
  "ipdb"
]);
function postprocess(effects, options = {}) {
  const files = /* @__PURE__ */ new Map();
  const specialTargets = [];
  const metadataUnavailable = [];
  const budget = {
    startedAt: (options.clock ?? Date.now)(),
    maxFiles: boundedOption(options.maxFiles, MAX_FILES),
    maxVisitedEntries: boundedOption(options.maxVisitedEntries, MAX_VISITED_ENTRIES),
    maxDepth: boundedOption(options.maxDepth, MAX_DEPTH),
    maxElapsedMs: boundedOption(options.maxElapsedMs, MAX_WALK_ELAPSED_MS),
    clock: options.clock ?? Date.now,
    visitedEntries: 0,
    maxDepthReached: 0,
    exhausted: false,
    provenance: makeObservationProvenance(effects, options.provenance)
  };
  const targets = selectDestructiveTargets(effects);
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const target = targets[targetIndex];
    if (target.mode === "delete-entry" && isCatastrophicPath(target.path)) continue;
    if (!consumeVisitBudget(budget, files.size, target.executionCertainty)) {
      if (targets.slice(targetIndex + 1).some((item) => item.executionCertainty === "definite")) {
        markBudgetExhausted(budget, "definite");
      }
      break;
    }
    observeTarget(target, files, specialTargets, metadataUnavailable, budget);
    if (budget.exhausted) {
      if (targets.slice(targetIndex + 1).some((item) => item.executionCertainty === "definite")) {
        markBudgetExhausted(budget, "definite");
      }
      break;
    }
  }
  const found = [...files.values()].map(finalizeAffectedFile);
  const policyFiles = found.filter((file) => !file.disposable);
  const definitePolicyFiles = policyFiles.filter((file) => file.executionCertainty === "definite");
  const conditionalPolicyFiles = policyFiles.filter((file) => file.executionCertainty === "conditional");
  const groups = groupByExtension(found);
  const totalSize = sumSizes(found);
  const policyTotalSize = sumSizes(policyFiles);
  return {
    groups,
    oldest: oldest(found),
    largest: largest(found),
    policyOldest: oldest(policyFiles),
    policyLargest: largest(policyFiles),
    definitePolicyOldest: oldest(definitePolicyFiles),
    conditionalPolicyOldest: oldest(conditionalPolicyFiles),
    totalFileCount: found.length,
    totalSize,
    policyFileCount: policyFiles.length,
    policyTotalSize,
    definitePolicyFileCount: definitePolicyFiles.length,
    definitePolicyTotalSize: sumSizes(definitePolicyFiles),
    conditionalPolicyFileCount: conditionalPolicyFiles.length,
    conditionalPolicyTotalSize: sumSizes(conditionalPolicyFiles),
    specialTargets,
    metadataUnavailable,
    visitedEntries: budget.visitedEntries,
    maxDepthReached: budget.maxDepthReached,
    budgetExhausted: budget.exhausted,
    budgetExhaustedCertainty: budget.exhaustedCertainty,
    ...budget.provenance ? { provenance: budget.provenance.store.graph() } : {}
  };
}
function makeObservationProvenance(effects, graph) {
  if (!graph || !isBoundedProvenanceGraph(graph)) return void 0;
  const store = new ProvenanceStore();
  const remapped = store.importGraph(graph);
  return {
    store,
    effectRoots: effects.map((effect) => normalizeProvenance((effect.provenance ?? []).map((root) => remapped.get(root)).filter((root) => root !== void 0)))
  };
}
function isBoundedProvenanceGraph(graph) {
  return graph.nodes.length <= MAX_PROVENANCE_NODES && graph.nodes.every((node) => Number.isInteger(node.id) && node.id >= 0 && node.label.length <= MAX_PROVENANCE_LABEL_CHARS && (node.reason === void 0 || node.reason.length <= MAX_PROVENANCE_LABEL_CHARS) && node.parents.length <= MAX_PROVENANCE_PARENTS && node.parents.every((parent) => Number.isInteger(parent) && parent >= 0));
}
function selectDestructiveTargets(effects) {
  const targets = [];
  const targetIndexes = /* @__PURE__ */ new Map();
  for (let effectIndex = 0; effectIndex < effects.length; effectIndex++) {
    const effect = effects[effectIndex];
    if (EffectTracker.hasPathUncertainty(effect)) continue;
    const target = destructiveTarget(effect, effectIndex);
    if (!target) continue;
    const targetKey = `${target.mode}\0${target.effectType}\0${target.path}`;
    const existingIndex = targetIndexes.get(targetKey);
    if (existingIndex !== void 0) {
      if (target.executionCertainty === "definite") {
        targets[existingIndex].executionCertainty = "definite";
      }
      continue;
    }
    targetIndexes.set(targetKey, targets.length);
    targets.push(target);
  }
  return targets;
}
function destructiveTarget(effect, effectIndex) {
  const replacement = replacementBehavior(effect);
  const executionCertainty = effectExecutionCertainty(effect, replacement);
  switch (effect.type) {
    case "delete":
      return { effectIndex, effectType: effect.type, path: effect.path, mode: "delete-entry", executionCertainty };
    case "write":
      if (replacement === "no-clobber") return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: "replace-content", executionCertainty };
    case "truncate":
      if (replacement === "no-clobber") return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: "truncate-content", executionCertainty };
    case "copy":
    case "move":
      if (replacement === "no-clobber") return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: "replace-destination", executionCertainty };
    case "link":
      if (replacement !== "replace" && replacement !== "conditional") return null;
      return { effectIndex, effectType: effect.type, path: effect.path, mode: "replace-destination", executionCertainty };
    default:
      return null;
  }
}
function replacementBehavior(effect) {
  if (effect.replacement) return effect.replacement;
  return effect.type === "link" ? "no-clobber" : "replace";
}
function effectExecutionCertainty(effect, replacement) {
  if (replacement === "conditional") return "conditional";
  if (effect.uncertain) return "conditional";
  return "definite";
}
function observeTarget(target, files, specialTargets, metadataUnavailable, budget) {
  const nativePath = toNative(target.path);
  let lstat;
  try {
    lstat = fs4.lstatSync(nativePath);
  } catch (error) {
    recordMetadataError(
      nativePath,
      target,
      error,
      metadataUnavailable,
      budget.provenance
    );
    return;
  }
  if (lstat.isSymbolicLink()) {
    if (followsDestination(target.effectType, target.mode)) {
      let followed;
      try {
        followed = fs4.statSync(nativePath);
      } catch (error) {
        if (!isMissingError(error)) {
          recordMetadataError(
            nativePath,
            target,
            error,
            metadataUnavailable,
            budget.provenance
          );
        }
        return;
      }
      observeStat(nativePath, followed, target, files, specialTargets, metadataUnavailable, budget);
      return;
    }
    recordSpecial(
      nativePath,
      "symlink",
      target,
      specialTargets,
      false,
      budget.provenance
    );
    return;
  }
  observeStat(nativePath, lstat, target, files, specialTargets, metadataUnavailable, budget);
}
function followsDestination(effectType, mode) {
  return mode === "replace-content" || mode === "truncate-content" || mode === "replace-destination" && effectType === "copy";
}
function observeStat(path12, stat, target, files, specialTargets, metadataUnavailable, budget) {
  const kind = targetKind(stat);
  if (kind === "regular-file") {
    addAffectedFile(
      path12,
      stat,
      target.mode,
      target.executionCertainty,
      target.effectIndex,
      files,
      budget
    );
    return;
  }
  if (kind === "directory") {
    if (target.mode === "delete-entry") {
      recordSpecial(
        path12,
        kind,
        target,
        specialTargets,
        false,
        budget.provenance
      );
      walkDeletedDirectory(path12, target, files, specialTargets, metadataUnavailable, budget, 0);
    } else {
      recordSpecial(
        path12,
        kind,
        target,
        specialTargets,
        false,
        budget.provenance
      );
    }
    return;
  }
  recordSpecial(
    path12,
    kind,
    target,
    specialTargets,
    target.mode !== "delete-entry" && isKnownNullSink(path12, kind),
    budget.provenance
  );
}
function walkDeletedDirectory(dir, target, files, specialTargets, metadataUnavailable, budget, depth) {
  if (budget.exhausted) return;
  budget.maxDepthReached = Math.max(budget.maxDepthReached, depth);
  if (depth >= budget.maxDepth) {
    markBudgetExhausted(budget, target.executionCertainty);
    return;
  }
  let entries;
  try {
    entries = fs4.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    recordMetadataError(
      dir,
      target,
      error,
      metadataUnavailable,
      budget.provenance
    );
    return;
  }
  for (const entry of entries) {
    if (!consumeVisitBudget(budget, files.size, target.executionCertainty)) return;
    const full = nodePath.join(dir, entry.name);
    let stat;
    try {
      stat = fs4.lstatSync(full);
    } catch (error) {
      recordMetadataError(
        full,
        target,
        error,
        metadataUnavailable,
        budget.provenance
      );
      continue;
    }
    const kind = targetKind(stat);
    if (kind === "regular-file") {
      addAffectedFile(
        full,
        stat,
        target.mode,
        target.executionCertainty,
        target.effectIndex,
        files,
        budget
      );
    } else if (kind === "directory") {
      walkDeletedDirectory(full, target, files, specialTargets, metadataUnavailable, budget, depth + 1);
    } else {
      recordSpecial(
        full,
        kind,
        target,
        specialTargets,
        false,
        budget.provenance
      );
    }
    if (budget.exhausted) return;
  }
}
function consumeVisitBudget(budget, fileCount, executionCertainty) {
  if (budget.visitedEntries >= budget.maxVisitedEntries || fileCount >= budget.maxFiles || budget.clock() - budget.startedAt >= budget.maxElapsedMs) {
    markBudgetExhausted(budget, executionCertainty);
    return false;
  }
  budget.visitedEntries++;
  return true;
}
function addAffectedFile(path12, stat, operation, executionCertainty, effectIndex, files, budget) {
  if (files.size >= budget.maxFiles) {
    markBudgetExhausted(budget, executionCertainty);
    return;
  }
  const provenance = recordFilesystemObservation(
    budget.provenance,
    effectIndex,
    `observed regular file for ${operation}: ${path12} (${stat.size} bytes)`
  );
  const existing = files.get(path12);
  if (existing) {
    existing.operations.add(operation);
    if (executionCertainty === "definite") existing.executionCertainty = "definite";
    if (!existing.effectIndexes.includes(effectIndex)) {
      if (existing.effectIndexes.length < MAX_EFFECT_INDEXES_PER_OBSERVATION) {
        existing.effectIndexes.push(effectIndex);
        existing.effectIndexes.sort((left, right) => left - right);
      } else {
        existing.effectIndexesTruncated = true;
      }
    }
    existing.provenance = normalizeProvenance([
      ...existing.provenance ?? [],
      ...optionalProvenance(provenance)
    ]);
    return;
  }
  const createdAt = stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
  files.set(path12, {
    path: path12,
    createdAt,
    modifiedAt: stat.mtime,
    size: stat.size,
    operations: /* @__PURE__ */ new Set([operation]),
    executionCertainty,
    disposable: isDisposableAffectedFile(path12),
    effectIndexes: [effectIndex],
    effectIndexesTruncated: false,
    ...provenance === void 0 ? {} : { provenance: [provenance] }
  });
}
function markBudgetExhausted(budget, executionCertainty) {
  budget.exhausted = true;
  if (budget.exhaustedCertainty !== "definite") {
    budget.exhaustedCertainty = executionCertainty;
  }
}
function finalizeAffectedFile(file) {
  return {
    ...file,
    operations: [...file.operations].sort()
  };
}
function recordSpecial(path12, kind, target, observations, safeSink, provenanceContext) {
  const existing = observations.find((item) => item.path === path12 && item.kind === kind && item.operation === target.mode && item.executionCertainty === target.executionCertainty);
  if (existing) {
    const provenance2 = recordFilesystemObservation(
      provenanceContext,
      target.effectIndex,
      `observed ${kind} for ${target.mode}: ${path12}`
    );
    existing.provenance = normalizeProvenance([
      ...existing.provenance ?? [],
      ...optionalProvenance(provenance2)
    ]);
    return;
  }
  let replaceIndex = -1;
  if (observations.length >= MAX_OBSERVATIONS) {
    if (kind !== "block-device" || target.executionCertainty !== "definite") {
      return;
    }
    replaceIndex = observations.findIndex((item) => item.kind !== "block-device" || item.executionCertainty !== "definite");
    if (replaceIndex < 0) return;
  }
  const provenance = recordFilesystemObservation(
    provenanceContext,
    target.effectIndex,
    `observed ${kind} for ${target.mode}: ${path12}`
  );
  const observation = {
    effectIndex: target.effectIndex,
    path: path12,
    kind,
    operation: target.mode,
    executionCertainty: target.executionCertainty,
    safeSink,
    ...provenance === void 0 ? {} : { provenance: [provenance] }
  };
  if (observations.length < MAX_OBSERVATIONS) {
    observations.push(observation);
    return;
  }
  observations[replaceIndex] = observation;
}
function recordMetadataError(path12, target, error, observations, provenanceContext) {
  if (isMissingError(error) || observations.length >= MAX_OBSERVATIONS) return;
  const message = errorMessage(error);
  const provenance = recordFilesystemObservation(
    provenanceContext,
    target.effectIndex,
    `metadata unavailable for ${target.mode}: ${path12} (${message})`
  );
  observations.push({
    effectIndex: target.effectIndex,
    path: path12,
    operation: target.mode,
    executionCertainty: target.executionCertainty,
    error: message,
    ...provenance === void 0 ? {} : { provenance: [provenance] }
  });
}
function recordFilesystemObservation(context, effectIndex, label) {
  if (!context) return void 0;
  return context.store.add({
    kind: "filesystem-observation",
    label,
    parents: context.effectRoots[effectIndex] ?? []
  });
}
function optionalProvenance(id) {
  return id === void 0 ? [] : [id];
}
function normalizeProvenance(ids) {
  return [...new Set(ids)].filter((id) => Number.isInteger(id) && id >= 0).sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}
function targetKind(stat) {
  if (stat.isFile()) return "regular-file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "other";
}
function isKnownNullSink(path12, kind) {
  if (kind !== "character-device" || process.platform === "win32") return false;
  if (nodePath.normalize(path12) === "/dev/null") return true;
  try {
    return nodePath.normalize(fs4.realpathSync(path12)) === "/dev/null";
  } catch {
    return false;
  }
}
function isMissingError(error) {
  return isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
function isDisposableAffectedFile(path12) {
  const ext = nodePath.extname(path12).slice(1).toLowerCase();
  if (FILE_EXTENSION_IGNORE_LIST.has(ext)) return true;
  return path12.split(/[\\/]+/).some((segment) => DISPOSABLE_DIRS.has(segment));
}
function groupByExtension(found) {
  const groups = /* @__PURE__ */ new Map();
  for (const file of found) {
    const extension = nodePath.extname(file.path) || "(no ext)";
    let group = groups.get(extension);
    if (!group) {
      group = {
        files: [],
        policyFiles: [],
        totalCount: 0,
        totalSize: 0,
        policyCount: 0,
        policySize: 0,
        definitePolicyCount: 0,
        definitePolicySize: 0,
        conditionalPolicyCount: 0,
        conditionalPolicySize: 0
      };
      groups.set(extension, group);
    }
    group.totalCount++;
    group.totalSize += file.size;
    if (group.files.length < MAX_PER_GROUP) group.files.push(file);
    if (!file.disposable) {
      group.policyCount++;
      group.policySize += file.size;
      if (file.executionCertainty === "definite") {
        group.definitePolicyCount++;
        group.definitePolicySize += file.size;
      } else {
        group.conditionalPolicyCount++;
        group.conditionalPolicySize += file.size;
      }
      if (group.policyFiles.length < MAX_PER_GROUP) group.policyFiles.push(file);
    }
  }
  return [...groups].map(([extension, group]) => ({
    extension,
    ...group,
    disposable: group.policyCount === 0
  })).sort((a, b) => b.totalSize - a.totalSize);
}
function sumSizes(files) {
  let total = 0;
  for (const file of files) total += file.size;
  return total;
}
function oldest(files) {
  return [...files].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, MAX_PER_GROUP);
}
function largest(files) {
  return [...files].sort((a, b) => b.size - a.size).slice(0, MAX_PER_GROUP);
}
function boundedOption(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

// src/bash/variables.ts
var att_readonly = 2;
var att_array = 4;
var att_local = 32;
var att_assoc = 64;
var MAX_ARRAY_ELEMENTS = 128;
var MAX_ARRAY_KEY_CHARS = 4096;
var MAX_ARRAY_VALUE_CHARS = 16 * 1024;
var VC_HASLOCAL = 1;
var VC_FUNCENV = 4;
var VariableEnvironment = class {
  global_context;
  current_context;
  scope_counter = 0;
  provenanceRecorder;
  functions = /* @__PURE__ */ new Map();
  constructor(env, inheritProcessEnv = true) {
    this.global_context = {
      name: "",
      scope: 0,
      flags: 0,
      up: null,
      table: /* @__PURE__ */ new Map()
    };
    this.current_context = this.global_context;
    const shellDefaults = {
      IFS: " 	\n"
    };
    for (const [k, v] of Object.entries(shellDefaults)) {
      this.global_context.table.set(k, { name: k, value: v, uncertain: false, attributes: 0, context: 0 });
    }
    const pathVars = /* @__PURE__ */ new Set([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "PWD",
      "OLDPWD",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SHELL"
    ]);
    if (inheritProcessEnv) {
      for (const [k, v] of Object.entries(process.env)) {
        if (v === void 0) continue;
        const val = pathVars.has(k) ? toPosix(v) : v;
        this.global_context.table.set(k, { name: k, value: val, uncertain: false, attributes: 0, context: 0 });
      }
    }
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        this.global_context.table.set(k, { name: k, value: v, uncertain: false, attributes: 0, context: 0 });
      }
    }
    if (!this.global_context.table.has("HOME")) {
      const up = this.global_context.table.get("USERPROFILE")?.value;
      const hd = this.global_context.table.get("HOMEDRIVE")?.value;
      const hp = this.global_context.table.get("HOMEPATH")?.value;
      let home;
      if (up) home = toPosix(up);
      else if (hd && hp) home = toPosix(hd + hp);
      if (home) {
        this.global_context.table.set("HOME", {
          name: "HOME",
          value: home,
          uncertain: false,
          attributes: 0,
          context: 0
        });
      }
    }
  }
  get context() {
    return this.current_context;
  }
  set_provenance_recorder(recorder) {
    this.provenanceRecorder = recorder;
  }
  snapshot() {
    return {
      current: cloneContext(this.current_context),
      scopeCounter: this.scope_counter,
      functions: new Map(this.functions)
    };
  }
  restore(snapshot) {
    const contexts = /* @__PURE__ */ new Map();
    this.current_context = restoreContextChain(snapshot.current, contexts);
    this.global_context = rootContext(this.current_context);
    this.scope_counter = snapshot.scopeCounter;
    this.functions = new Map(snapshot.functions);
  }
  /**
   * Restore a sound summary when the path budget cannot retain every branch.
   * Equal bindings remain exact; differing or absent bindings become explicit
   * uncertain placeholders rather than an arbitrary branch representative.
   */
  restore_widened(snapshots) {
    if (snapshots.length === 0) return;
    this.restore(snapshots[0]);
    const views = snapshots.map(visibleSnapshotVariables);
    const names = new Set(views.flatMap((view) => [...view.keys()]));
    for (const name of [...names].sort()) {
      const values = views.map((view) => view.get(name));
      if (values.every((value) => sameShellVariable(value, values[0]))) {
        const current = this.find_variable(name);
        if (current) {
          const provenance = variableProvenance(values);
          current.provenance = provenance.length === 0 ? [] : this.recordProvenance(
            "state-join",
            name,
            provenance
          );
        }
        continue;
      }
      this.remove_all_bindings(name);
      const joined = joinShellVariables(name, values, this.current_context.scope);
      joined.provenance = this.recordProvenance(
        "state-join",
        name,
        variableProvenance(values)
      );
      this.current_context.table.set(name, joined);
    }
    const functionNames = new Set(snapshots.flatMap((snapshot) => [...snapshot.functions.keys()]));
    for (const name of functionNames) {
      const definitions = snapshots.map((snapshot) => snapshot.functions.get(name));
      const first = definitions[0];
      if (!first || definitions.some((definition) => definition?.body !== first.body)) {
        this.functions.delete(name);
      }
    }
  }
  /** Reset variables before modeling a child launched with an empty environment. */
  reset_for_child_environment() {
    let ctx = this.current_context;
    while (ctx) {
      ctx.table.clear();
      ctx = ctx.up;
    }
    this.global_context.table.set("IFS", {
      name: "IFS",
      value: " 	\n",
      uncertain: false,
      attributes: 0,
      context: 0
    });
  }
  /** Return the currently visible scalar values, with inner scopes winning. */
  to_record() {
    const chain = [];
    let ctx = this.current_context;
    while (ctx) {
      chain.unshift(ctx);
      ctx = ctx.up;
    }
    const values = /* @__PURE__ */ Object.create(null);
    for (const item of chain) {
      for (const [name, variable] of item.table) values[name] = variable.value;
    }
    return values;
  }
  /** Replace inherited positional parameters before analyzing a child shell. */
  reset_positional_params(args) {
    let ctx = this.current_context;
    while (ctx) {
      for (const name of [...ctx.table.keys()]) {
        if (name === "#" || name === "@" || name === "*" || /^[0-9]+$/u.test(name)) ctx.table.delete(name);
      }
      ctx = ctx.up;
    }
    this.set_positional_params(args);
  }
  /** Save caller parameters before a source builtin installs temporary args. */
  snapshot_source_positional_params(replacementCount) {
    const names = /* @__PURE__ */ new Set(["#", "@", "*"]);
    let ctx = this.current_context;
    while (ctx) {
      for (const name of ctx.table.keys()) {
        if (/^[1-9][0-9]*$/u.test(name)) names.add(name);
      }
      ctx = ctx.up;
    }
    for (let index = 1; index <= replacementCount; index++) {
      names.add(String(index));
    }
    return this.snapshot_variables([...names]);
  }
  /** Source arguments replace $1... while preserving the caller's $0. */
  set_source_positional_params(args) {
    let ctx = this.current_context;
    while (ctx) {
      for (const name of [...ctx.table.keys()]) {
        if (name === "#" || name === "@" || name === "*" || /^[1-9][0-9]*$/u.test(name)) {
          ctx.table.delete(name);
        }
      }
      ctx = ctx.up;
    }
    this.set_positional_params(args);
  }
  snapshot_variables(names) {
    const entries = /* @__PURE__ */ new Map();
    for (const name of names) {
      const v = this.find_variable(name);
      entries.set(name, v ? cloneShellVariable(v) : null);
    }
    return { entries };
  }
  restore_variables(snapshot) {
    for (const [name, saved] of snapshot.entries) {
      if (saved) {
        const current = this.find_variable(name);
        if (current) {
          current.value = saved.value;
          current.uncertain = saved.uncertain;
          current.attributes = saved.attributes;
          current.context = saved.context;
          current.array = saved.array ? cloneShellArray(saved.array) : void 0;
          current.provenance = cloneProvenance(saved.provenance);
        } else {
          this.global_context.table.set(name, cloneShellVariable(saved));
        }
      } else {
        this.unbind_variable(name);
      }
    }
  }
  /** Find a variable by name, walking the context chain upward */
  find_variable(name) {
    let ctx = this.current_context;
    while (ctx) {
      const v = ctx.table.get(name);
      if (v) return v;
      ctx = ctx.up;
    }
    return void 0;
  }
  get_array_kind(name) {
    return this.find_variable(name)?.array?.kind;
  }
  declare_array(name, kind, local = false, provenance = []) {
    let variable = local ? this.current_context.table.get(name) : this.find_variable(name);
    if (!variable) {
      variable = {
        name,
        value: "",
        uncertain: false,
        attributes: arrayKindAttribute(kind) | (local ? att_local : 0),
        context: this.current_context.scope,
        array: emptyShellArray(kind),
        provenance: this.recordProvenance(
          "declare-array",
          name,
          provenance
        )
      };
      this.current_context.table.set(name, variable);
      if (local) this.current_context.flags |= VC_HASLOCAL;
      return variable;
    }
    if (variable.attributes & att_readonly) return variable;
    if (variable.array) {
      if (variable.array.kind !== kind) {
        variable.uncertain = true;
        variable.array.unknownKeys = true;
      }
      return variable;
    }
    const existing = boundedArrayElement(
      name,
      "0",
      variable.value,
      variable.uncertain,
      variable.provenance
    );
    variable.array = emptyShellArray(kind);
    variable.array.entries.set("0", existing);
    variable.attributes &= ~(att_array | att_assoc);
    variable.attributes |= arrayKindAttribute(kind);
    if (local) variable.attributes |= att_local;
    variable.provenance = this.recordProvenance(
      "declare-array",
      name,
      [
        ...variable.provenance ?? [],
        ...provenance
      ]
    );
    return variable;
  }
  bind_array_element(name, key, value, uncertain = false, kind = "indexed", provenance = []) {
    let variable = this.find_variable(name) ?? this.declare_array(name, kind, false, provenance);
    if (variable.attributes & att_readonly) return variable;
    if (!variable.array) {
      variable = this.declare_array(name, kind, false, provenance);
    }
    if (!variable.array) return variable;
    const array = variable.array;
    if (array.kind !== kind || key.length > MAX_ARRAY_KEY_CHARS) {
      variable.uncertain = true;
      array.unknownKeys = true;
      variable.provenance = this.recordProvenance(
        "array-widen",
        name,
        [...variable.provenance ?? [], ...provenance],
        key
      );
      return variable;
    }
    if (!array.entries.has(key) && array.entries.size >= MAX_ARRAY_ELEMENTS) {
      variable.uncertain = true;
      array.unknownKeys = true;
      variable.provenance = this.recordProvenance(
        "array-widen",
        name,
        [...variable.provenance ?? [], ...provenance],
        key
      );
      return variable;
    }
    const binding = this.recordProvenance(
      "array-bind",
      name,
      provenance,
      key
    );
    array.entries.set(
      key,
      boundedArrayElement(name, key, value, uncertain, binding)
    );
    refreshArrayScalarValue(variable);
    return variable;
  }
  widen_array(name, kind = "indexed", provenance = []) {
    let variable = this.find_variable(name) ?? this.declare_array(name, kind, false, provenance);
    if (variable.attributes & att_readonly) return variable;
    if (!variable.array) {
      variable = this.declare_array(name, kind, false, provenance);
    }
    if (!variable.array) return variable;
    variable.uncertain = true;
    variable.array.unknownKeys = true;
    variable.provenance = this.recordProvenance(
      "array-widen",
      name,
      [...variable.provenance ?? [], ...provenance]
    );
    return variable;
  }
  get_array_element(name, key) {
    const variable = this.find_variable(name);
    if (!variable) {
      return { value: void 0, uncertain: false, provenance: [] };
    }
    if (!variable.array) {
      return key === "0" ? {
        value: variable.value,
        uncertain: variable.uncertain,
        provenance: cloneProvenance(variable.provenance)
      } : {
        value: void 0,
        uncertain: variable.uncertain,
        provenance: cloneProvenance(variable.provenance)
      };
    }
    if (variable.array.unknownKeys) {
      return {
        value: `<unknown:${name}[${key}]>`,
        uncertain: true,
        provenance: cloneProvenance(variable.provenance)
      };
    }
    const element = variable.array.entries.get(key);
    return {
      value: element?.value,
      uncertain: variable.uncertain || variable.array.unknownKeys || element?.uncertain === true,
      provenance: normalizeProvenance2([
        ...variable.provenance ?? [],
        ...element?.provenance ?? []
      ])
    };
  }
  get_array_values(name) {
    const variable = this.find_variable(name);
    if (!variable) {
      return { values: [], uncertain: false, provenance: [] };
    }
    if (!variable.array) {
      return {
        values: [{
          value: variable.value,
          uncertain: variable.uncertain,
          provenance: cloneProvenance(variable.provenance)
        }],
        uncertain: variable.uncertain,
        provenance: cloneProvenance(variable.provenance)
      };
    }
    const array = variable.array;
    const values = sortedArrayEntries(array).map(([, element]) => ({
      value: element.value,
      uncertain: variable.uncertain || array.unknownKeys || element.uncertain,
      provenance: normalizeProvenance2([
        ...variable.provenance ?? [],
        ...element.provenance ?? []
      ])
    }));
    return {
      values,
      uncertain: variable.uncertain || array.unknownKeys,
      provenance: normalizeProvenance2([
        ...variable.provenance ?? [],
        ...values.flatMap((element) => element.provenance ?? [])
      ])
    };
  }
  get_array_max_index(name) {
    const array = this.find_variable(name)?.array;
    if (!array || array.kind !== "indexed" || array.entries.size === 0) return null;
    let maximum = null;
    for (const key of array.entries.keys()) {
      if (!/^[0-9]+$/u.test(key)) continue;
      const index = BigInt(key);
      if (maximum === null || index > maximum) maximum = index;
    }
    return maximum;
  }
  /** Get variable value or undefined */
  get_string_value(name) {
    const variable = this.find_variable(name);
    if (!variable) return void 0;
    return variable.array ? variable.array.entries.get("0")?.value : variable.value;
  }
  get_value_provenance(name) {
    const variable = this.find_variable(name);
    if (!variable) return [];
    if (!variable.array) return cloneProvenance(variable.provenance);
    return normalizeProvenance2([
      ...variable.provenance ?? [],
      ...variable.array.entries.get("0")?.provenance ?? []
    ]);
  }
  get_array_provenance(name) {
    const variable = this.find_variable(name);
    if (!variable) return [];
    return normalizeProvenance2([
      ...variable.provenance ?? [],
      ...[...variable.array?.entries.values() ?? []].flatMap((element) => element.provenance ?? [])
    ]);
  }
  is_value_uncertain(name) {
    const variable = this.find_variable(name);
    if (!variable) return false;
    return variable.uncertain || variable.array?.unknownKeys === true || variable.array?.entries.get("0")?.uncertain === true;
  }
  /** Bind a variable in the current scope */
  bind_variable(name, value, attributes = 0, uncertain = false, provenance = []) {
    const existing = this.find_variable(name);
    if (existing?.array && !(existing.attributes & att_readonly)) {
      return this.bind_array_element(
        name,
        "0",
        value,
        uncertain,
        existing.array.kind,
        provenance
      );
    }
    if (existing && !(existing.attributes & att_readonly)) {
      if (existing.attributes & att_local) {
        existing.value = value;
        existing.uncertain = uncertain;
        existing.provenance = this.recordProvenance(
          "bind",
          name,
          provenance
        );
        return existing;
      }
      const inCurrent = this.current_context.table.get(name);
      if (inCurrent) {
        if (inCurrent.attributes & att_readonly) {
          return inCurrent;
        }
        inCurrent.value = value;
        inCurrent.uncertain = uncertain;
        inCurrent.provenance = this.recordProvenance(
          "bind",
          name,
          provenance
        );
        return inCurrent;
      }
    }
    const v = {
      name,
      value,
      uncertain,
      attributes,
      context: this.current_context.scope,
      provenance: this.recordProvenance("bind", name, provenance)
    };
    this.current_context.table.set(name, v);
    return v;
  }
  unbind_variable(name) {
    let ctx = this.current_context;
    while (ctx) {
      if (ctx.table.delete(name)) return;
      ctx = ctx.up;
    }
  }
  remove_all_bindings(name) {
    let ctx = this.current_context;
    while (ctx) {
      ctx.table.delete(name);
      ctx = ctx.up;
    }
  }
  /** Make a variable local to the current function scope */
  make_local_variable(name, value = "", uncertain = false, provenance = []) {
    const v = {
      name,
      value,
      uncertain,
      attributes: att_local,
      context: this.current_context.scope,
      provenance: this.recordProvenance(
        "local-bind",
        name,
        provenance
      )
    };
    this.current_context.table.set(name, v);
    this.current_context.flags |= VC_HASLOCAL;
    return v;
  }
  /** Push a new variable context for function call */
  push_var_context(funcName) {
    this.scope_counter++;
    const ctx = {
      name: funcName,
      scope: this.scope_counter,
      flags: VC_FUNCENV,
      up: this.current_context,
      table: /* @__PURE__ */ new Map()
    };
    this.current_context = ctx;
    return ctx;
  }
  /** Pop the current context, restoring the parent */
  pop_var_context() {
    if (this.current_context.up) {
      this.current_context = this.current_context.up;
    }
  }
  /** Register a function definition */
  register_function(name, body) {
    this.functions.set(name, { name, body });
  }
  /** Look up a function */
  find_function(name) {
    return this.functions.get(name);
  }
  /** Set positional parameters ($1, $2, ..., $@, $#) */
  set_positional_params(args) {
    for (let i = 0; i < args.length; i++) {
      this.bind_variable(String(i + 1), args[i]);
    }
    this.bind_variable("#", String(args.length));
    this.bind_variable("@", args.join(" "));
    this.bind_variable("*", args.join(" "));
  }
  recordProvenance(kind, name, parents, key) {
    const normalized = normalizeProvenance2(parents);
    const id = this.provenanceRecorder?.({
      kind,
      name,
      ...key === void 0 ? {} : { key },
      parents: normalized
    });
    return id === void 0 ? normalized : [id];
  }
};
function mergeEquivalentVariableSnapshotProvenance(snapshots, recordJoin) {
  const first = snapshots[0];
  if (!first) {
    throw new Error("cannot merge an empty variable snapshot set");
  }
  const merged = {
    current: cloneContextSnapshot(first.current),
    scopeCounter: first.scopeCounter,
    functions: new Map(first.functions)
  };
  mergeContextProvenance(
    merged.current,
    snapshots.map((snapshot) => snapshot.current),
    recordJoin
  );
  return merged;
}
function variableEnvironmentSnapshotKey(snapshot) {
  return JSON.stringify({
    contexts: snapshotContextKey(snapshot.current),
    scopeCounter: snapshot.scopeCounter,
    functions: [...snapshot.functions].sort(([left], [right]) => left.localeCompare(right)).map(([name, definition]) => [name, definition.body])
  });
}
function cloneContextSnapshot(snapshot) {
  return {
    name: snapshot.name,
    scope: snapshot.scope,
    flags: snapshot.flags,
    up: snapshot.up ? cloneContextSnapshot(snapshot.up) : null,
    table: snapshot.table.map(([name, variable]) => [
      name,
      cloneShellVariable(variable)
    ])
  };
}
function mergeContextProvenance(target, sources, recordJoin) {
  const sourceTables = sources.map((source) => new Map(source.table));
  for (const [name, variable] of target.table) {
    const candidates = sourceTables.map((table) => table.get(name));
    const signatures = candidates.map(variableProvenanceSignature);
    const originsDiffer = signatures.some((signature) => signature !== signatures[0]);
    const roots = variableProvenance(candidates);
    const joined = roots.length > 0 && (originsDiffer || sources.length > 1) ? recordJoin?.(name, roots) : void 0;
    variable.provenance = joined === void 0 ? roots : [joined];
  }
  if (target.up) {
    mergeContextProvenance(
      target.up,
      sources.map((source) => source.up).filter((source) => source !== null),
      recordJoin
    );
  }
}
function cloneContext(ctx) {
  return {
    name: ctx.name,
    scope: ctx.scope,
    flags: ctx.flags,
    up: ctx.up ? cloneContext(ctx.up) : null,
    table: [...ctx.table.entries()].map(([name, value]) => [
      name,
      cloneShellVariable(value)
    ])
  };
}
function visibleSnapshotVariables(snapshot) {
  const chain = [];
  let context = snapshot.current;
  while (context) {
    chain.unshift(context);
    context = context.up;
  }
  const result = /* @__PURE__ */ new Map();
  for (const item of chain) {
    for (const [name, variable] of item.table) result.set(name, variable);
  }
  return result;
}
function sameShellVariable(left, right) {
  return left === void 0 ? right === void 0 : right !== void 0 && left.value === right.value && left.uncertain === right.uncertain && left.attributes === right.attributes && sameShellArray(left.array, right.array);
}
function intersectAttributes(values) {
  let attributes = values[0]?.attributes ?? 0;
  for (const value of values.slice(1)) attributes &= value?.attributes ?? 0;
  return attributes;
}
function snapshotContextKey(snapshot) {
  if (!snapshot) return null;
  return {
    name: snapshot.name,
    scope: snapshot.scope,
    flags: snapshot.flags,
    up: snapshotContextKey(snapshot.up),
    table: [...snapshot.table].sort(([left], [right]) => left.localeCompare(right)).map(([name, variable]) => [
      name,
      variable.value,
      variable.uncertain,
      variable.attributes,
      variable.context,
      shellArrayKey(variable.array)
    ])
  };
}
function restoreContextChain(snapshot, contexts) {
  const up = snapshot.up ? restoreContextChain(snapshot.up, contexts) : null;
  const ctx = {
    name: snapshot.name,
    scope: snapshot.scope,
    flags: snapshot.flags,
    up,
    table: new Map(snapshot.table.map(([name, value]) => [
      name,
      cloneShellVariable(value)
    ]))
  };
  contexts.set(ctx.scope, ctx);
  return ctx;
}
function emptyShellArray(kind) {
  return {
    kind,
    entries: /* @__PURE__ */ new Map(),
    unknownKeys: false
  };
}
function arrayKindAttribute(kind) {
  return kind === "indexed" ? att_array : att_assoc;
}
function cloneShellArray(array) {
  return {
    kind: array.kind,
    entries: new Map([...array.entries].map(([key, element]) => [
      key,
      {
        ...element,
        provenance: cloneProvenance(element.provenance)
      }
    ])),
    unknownKeys: array.unknownKeys
  };
}
function cloneShellVariable(variable) {
  return {
    ...variable,
    array: variable.array ? cloneShellArray(variable.array) : void 0,
    provenance: cloneProvenance(variable.provenance)
  };
}
function sortedArrayEntries(array) {
  return [...array.entries].sort(([left], [right]) => {
    if (array.kind === "associative") {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    const leftIndex = BigInt(left);
    const rightIndex = BigInt(right);
    return leftIndex < rightIndex ? -1 : leftIndex > rightIndex ? 1 : 0;
  });
}
function refreshArrayScalarValue(variable) {
  variable.value = variable.array?.entries.get("0")?.value ?? "";
}
function boundedArrayElement(name, key, value, uncertain, provenance = []) {
  if (value.length <= MAX_ARRAY_VALUE_CHARS) {
    return {
      value,
      uncertain,
      provenance: normalizeProvenance2(provenance)
    };
  }
  return {
    value: `<unknown:${name}[${key}]>`,
    uncertain: true,
    provenance: normalizeProvenance2(provenance)
  };
}
function sameShellArray(left, right) {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.unknownKeys !== right.unknownKeys || left.entries.size !== right.entries.size) {
    return false;
  }
  for (const [key, element] of left.entries) {
    const candidate = right.entries.get(key);
    if (!candidate || candidate.value !== element.value || candidate.uncertain !== element.uncertain) {
      return false;
    }
  }
  return true;
}
function shellArrayKey(array) {
  if (!array) return null;
  return {
    kind: array.kind,
    unknownKeys: array.unknownKeys,
    entries: sortedArrayEntries(array).map(([key, element]) => [
      key,
      element.value,
      element.uncertain
    ])
  };
}
function joinShellVariables(name, values, context) {
  const defined = values.filter((value) => value !== void 0);
  const arrayKind = defined[0]?.array?.kind;
  if (arrayKind && defined.every((value) => value.array?.kind === arrayKind)) {
    const keys = /* @__PURE__ */ new Set();
    let unknownKeys = values.some((value) => value === void 0 || value.uncertain || value.array?.unknownKeys === true);
    for (const value of defined) {
      const valueArray = value.array;
      if (!valueArray || valueArray.kind !== arrayKind) {
        unknownKeys = true;
        continue;
      }
      for (const key of valueArray.entries.keys()) {
        if (keys.size >= MAX_ARRAY_ELEMENTS && !keys.has(key)) {
          unknownKeys = true;
          continue;
        }
        keys.add(key);
      }
    }
    const array = emptyShellArray(arrayKind);
    array.unknownKeys = unknownKeys;
    for (const key of [...keys].sort()) {
      const elements = values.map((value) => value?.array?.entries.get(key));
      const first = elements[0];
      if (first && elements.every((element) => element?.value === first.value && element.uncertain === first.uncertain)) {
        array.entries.set(key, { ...first });
      } else {
        array.entries.set(key, {
          value: `<unknown:${name}[${key}]>`,
          uncertain: true,
          provenance: normalizeProvenance2(
            elements.flatMap((element) => element?.provenance ?? [])
          )
        });
      }
    }
    const result = {
      name,
      value: "",
      uncertain: values.some((value) => value === void 0 || value.uncertain),
      attributes: intersectAttributes(values) | arrayKindAttribute(arrayKind),
      context,
      array,
      provenance: variableProvenance(values)
    };
    refreshArrayScalarValue(result);
    return result;
  }
  return {
    name,
    value: `<unknown:${name}>`,
    uncertain: true,
    attributes: intersectAttributes(values) & ~(att_array | att_assoc),
    context,
    provenance: variableProvenance(values)
  };
}
function variableProvenance(values) {
  return normalizeProvenance2(values.flatMap((variable) => [
    ...variable?.provenance ?? [],
    ...[...variable?.array?.entries.values() ?? []].flatMap((element) => element.provenance ?? [])
  ]));
}
function variableProvenanceSignature(variable) {
  if (!variable) return "unset";
  return JSON.stringify({
    scalar: normalizeProvenance2(variable.provenance ?? []),
    array: variable.array ? sortedArrayEntries(variable.array).map(([key, element]) => [
      key,
      normalizeProvenance2(element.provenance ?? [])
    ]) : null
  });
}
function cloneProvenance(provenance) {
  return normalizeProvenance2(provenance ?? []);
}
function normalizeProvenance2(provenance) {
  return [...new Set(provenance)].filter((id) => Number.isInteger(id) && id >= 0).sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}
function rootContext(ctx) {
  let current = ctx;
  while (current.up) current = current.up;
  return current;
}

// src/bash/make_cmd.ts
var current_line = 1;
function set_line_number(n) {
  current_line = n;
}
function make_word(word, flags = 0) {
  return { word, flags };
}
function make_simple_command() {
  return {
    type: "simple",
    flags: 0,
    line: current_line,
    redirects: null,
    words: [],
    assignments: []
  };
}
function add_element_to_simple_command(cmd, word) {
  cmd.words.push(word);
}
function clean_simple_command(cmd) {
  const words = [];
  const assignments = [];
  let pastCommand = false;
  for (const w of cmd.words) {
    if (!pastCommand && assignment_word(w.word)) {
      w.flags |= W_ASSIGNMENT;
      assignments.push(w);
    } else {
      pastCommand = true;
      words.push(w);
    }
  }
  cmd.words = words;
  cmd.assignments = assignments;
  return cmd;
}
function make_for_command(name, map_list, action, lineno) {
  return {
    type: "for",
    flags: 0,
    line: lineno,
    redirects: null,
    name,
    map_list,
    action
  };
}
function make_if_command(test, true_case, false_case) {
  return {
    type: "if",
    flags: 0,
    line: current_line,
    redirects: null,
    test,
    true_case,
    false_case
  };
}
function make_while_command(test, action) {
  return {
    type: "while",
    flags: 0,
    line: current_line,
    redirects: null,
    test,
    action
  };
}
function make_until_command(test, action) {
  return {
    type: "until",
    flags: 0,
    line: current_line,
    redirects: null,
    test,
    action
  };
}
function make_case_command(word, clauses, lineno) {
  return {
    type: "case",
    flags: 0,
    line: lineno,
    redirects: null,
    word,
    clauses
  };
}
function make_pattern_list(patterns, action) {
  return {
    next: null,
    patterns,
    action,
    flags: 0
  };
}
function make_group_command(command) {
  return {
    type: "group",
    flags: 0,
    line: current_line,
    redirects: null,
    command
  };
}
function make_subshell_command(command) {
  return {
    type: "subshell",
    flags: 0,
    line: current_line,
    redirects: null,
    command
  };
}
function make_arith_command(expression, line = current_line) {
  return {
    type: "arith",
    flags: 0,
    line,
    redirects: null,
    expression
  };
}
function make_cond_node(type, op, left, right, line = current_line) {
  return {
    flags: 0,
    line,
    type,
    op,
    left,
    right
  };
}
function make_cond_command(expression, line = current_line) {
  return {
    type: "cond",
    flags: 0,
    line,
    redirects: null,
    expression
  };
}
function make_function_def(name, command) {
  return {
    type: "function_def",
    flags: 0,
    line: current_line,
    redirects: null,
    name,
    command
  };
}
function command_connect(first, second, connector) {
  return {
    type: "connection",
    flags: 0,
    line: first.line,
    redirects: null,
    first,
    second,
    connector
  };
}
function connect_async_list(command, command2, connector) {
  if (command.type !== "connection" || !command.second || (command.flags & CMD_WANT_SUBSHELL) !== 0 || command.connector !== SEMI) {
    return command_connect(command, command2, connector);
  }
  let parent = command;
  let tail = command.second;
  while (tail.type === "connection" && tail.second && (tail.flags & CMD_WANT_SUBSHELL) === 0 && tail.connector === SEMI) {
    parent = tail;
    tail = tail.second;
  }
  parent.second = command_connect(tail, command2, connector);
  return command;
}
function make_redirectee(arg) {
  if (typeof arg === "number") {
    return { dest: arg, filename: null };
  }
  return { dest: -1, filename: arg };
}
function make_redirection(source, instruction, redirectee, rflags = 0) {
  return {
    next: null,
    redirector: source,
    rflags,
    instruction,
    redirectee,
    here_doc_eof: void 0
  };
}
function append_redirect(existing, newRedir) {
  if (!existing) return newRedir;
  let tail = existing;
  while (tail.next) tail = tail.next;
  tail.next = newRedir;
  return existing;
}

// src/bash/parse.ts
function token_word_flags(token) {
  return token.quoted ? W_QUOTED : 0;
}
function is_all_digits(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] < "0" || s[i] > "9") return false;
  }
  return true;
}
function starts_with_windows_drive_prefix(s) {
  if (s.length < 2) return false;
  const c = s[0];
  return (c >= "A" && c <= "Z" || c >= "a" && c <= "z") && s[1] === ":";
}
function strip_leading_tabs(s) {
  let pos = 0;
  while (pos < s.length && s[pos] === "	") pos++;
  return s.substring(pos);
}
function strip_quoting_chars(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "'" && c !== '"' && c !== "\\") out += c;
  }
  return out;
}
var RESERVED_WORDS = {
  "if": 3 /* IF */,
  "then": 4 /* THEN */,
  "else": 5 /* ELSE */,
  "elif": 6 /* ELIF */,
  "fi": 7 /* FI */,
  "case": 8 /* CASE */,
  "esac": 9 /* ESAC */,
  "for": 11 /* FOR */,
  "while": 12 /* WHILE */,
  "until": 13 /* UNTIL */,
  "do": 14 /* DO */,
  "done": 15 /* DONE */,
  "in": 10 /* IN */,
  "function": 16 /* FUNCTION */,
  "select": 17 /* SELECT */,
  "coproc": 18 /* COPROC */,
  "!": 19 /* BANG */,
  "time": 20 /* TIME */,
  "{": 43 /* LBRACE */,
  "}": 44 /* RBRACE */
};
var CONDITIONAL_UNARY_OPERATORS = /* @__PURE__ */ new Set([
  "-a",
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-g",
  "-h",
  "-k",
  "-n",
  "-o",
  "-p",
  "-r",
  "-s",
  "-t",
  "-u",
  "-v",
  "-w",
  "-x",
  "-z",
  "-G",
  "-L",
  "-O",
  "-S",
  "-N",
  "-R"
]);
var CONDITIONAL_BINARY_OPERATORS = /* @__PURE__ */ new Set([
  "=",
  "==",
  "!=",
  "=~",
  "<",
  ">",
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef"
]);
var MAX_SHELL_GROUP_CLOSE_CANDIDATES = 128;
var MAX_SHELL_GROUP_PARSE_CHARS = 64 * 1024;
var Lexer = class {
  input;
  pos = 0;
  line = 1;
  pushback = [];
  _allowReserved = true;
  _conditionalExpression = false;
  conditionalEndSeen = false;
  conditionalWordTokens = [];
  pendingHereDocs = [];
  warnings = [];
  constructor(input) {
    this.input = input;
  }
  get currentLine() {
    return this.line;
  }
  set allowReserved(v) {
    this._allowReserved = v;
  }
  set conditionalExpression(value) {
    this._conditionalExpression = value;
    if (value) {
      this.conditionalEndSeen = false;
      this.conditionalWordTokens = [];
    }
  }
  get hasSeenConditionalEnd() {
    return this.conditionalEndSeen;
  }
  takeConditionalWords() {
    const words = this.conditionalWordTokens.map((token) => make_word(token.value, token_word_flags(token)));
    this.conditionalWordTokens = [];
    return words;
  }
  shell_getc() {
    if (this.pos >= this.input.length) return "";
    const c = this.input[this.pos++];
    if (c === "\n") this.line++;
    return c;
  }
  shell_ungetc() {
    if (this.pos > 0) {
      this.pos--;
      if (this.input[this.pos] === "\n") this.line--;
    }
  }
  peek_char() {
    if (this.pos >= this.input.length) return "";
    return this.input[this.pos];
  }
  /** Read a dollar expansion after the leading '$' has been consumed. */
  read_dollar_expansion() {
    const after = this.peek_char();
    if (after === "(") {
      this.shell_getc();
      if (this.peek_char() === "(") {
        this.shell_getc();
        let expansion = "$((";
        let depth = 1;
        while (depth > 0) {
          const character = this.shell_getc();
          if (character === "") break;
          expansion += character;
          if (character === "(" && this.peek_char() === "(") depth++;
          if (character === ")" && this.peek_char() === ")") {
            depth--;
            if (depth === 0) {
              expansion += this.shell_getc();
              break;
            }
          }
        }
        return expansion;
      }
      return this.read_shell_command_group("$(");
    }
    if (after === "{") {
      this.shell_getc();
      let expansion = "${";
      let depth = 1;
      while (depth > 0) {
        const character = this.shell_getc();
        if (character === "") break;
        expansion += character;
        if (character === "{") depth++;
        if (character === "}") depth--;
      }
      return expansion;
    }
    return null;
  }
  /** Read a legacy command substitution after its opening backtick. */
  read_backtick_word() {
    let word = "`";
    while (true) {
      const character = this.shell_getc();
      if (character === "" || character === "`") {
        word += character;
        return word;
      }
      if (character === "\\") {
        word += "\\" + this.shell_getc();
        continue;
      }
      word += character;
    }
  }
  /**
   * Read a process substitution after `<(` or `>(` has been consumed.
   * Bash lexes the complete construct as part of one word, including spaces
   * and shell operators in the nested command.
   */
  read_process_substitution(marker) {
    return this.read_shell_command_group(`${marker}(`);
  }
  read_shell_command_group(prefix) {
    let word = prefix;
    let closeCandidates = 0;
    let validationBudgetExhausted = false;
    let fallback = null;
    while (true) {
      const character = this.shell_getc();
      if (character === "") {
        if (fallback) {
          this.pos = fallback.position;
          this.line = fallback.line;
          this.warnings.push(validationBudgetExhausted ? `${prefix} close matching widened after ${MAX_SHELL_GROUP_CLOSE_CANDIDATES} candidates or ${MAX_SHELL_GROUP_PARSE_CHARS} characters` : `unexpected EOF while proving the matching ')' in ${prefix}`);
          return fallback.word;
        }
        this.warnings.push(`unexpected EOF while looking for matching ')' in ${prefix}`);
        return word;
      }
      word += character;
      if (character === "\\") {
        const escaped = this.shell_getc();
        word += escaped;
        if (escaped === "") {
          this.warnings.push(`unexpected EOF while looking for matching ')' in ${prefix}`);
          return word;
        }
        continue;
      }
      if (character === ")") {
        closeCandidates++;
        const body = word.slice(prefix.length, -1);
        const withinBudget = closeCandidates <= MAX_SHELL_GROUP_CLOSE_CANDIDATES && body.length <= MAX_SHELL_GROUP_PARSE_CHARS;
        if (withinBudget && this.isCompleteShellGroupBody(body)) {
          return word;
        }
        validationBudgetExhausted ||= !withinBudget;
        fallback = {
          position: this.pos,
          line: this.line,
          word
        };
      }
    }
  }
  isCompleteShellGroupBody(body) {
    if (body.trim().length === 0) return true;
    const parser = new Parser(`(${body})`);
    const ast = parser.parse();
    if (!ast || !parser.consumedAllInput) return false;
    return !parser.warnings.some((warning) => warning.includes("Parse error") || warning.includes("unexpected EOF") || warning.includes("delimited by end-of-file"));
  }
  /**
   * Try to read the rest of `(( expression ))` after the first opening
   * parenthesis token. On failure, restore the lexer so ordinary nested
   * subshell parsing sees the second parenthesis.
   */
  tryReadArithmeticCommand() {
    if (this.pushback.length > 0 || this.peek_char() !== "(") return null;
    const savedPosition = this.pos;
    const savedLine = this.line;
    this.shell_getc();
    let expression = "";
    let nestedParentheses = 0;
    let quote = null;
    while (true) {
      const character = this.shell_getc();
      if (character === "") {
        this.pos = savedPosition;
        this.line = savedLine;
        return null;
      }
      if (character === "\\" && quote !== "'") {
        expression += character;
        const escaped = this.shell_getc();
        if (escaped === "") {
          this.pos = savedPosition;
          this.line = savedLine;
          return null;
        }
        expression += escaped;
        continue;
      }
      if (character === "$" && quote !== "'") {
        const expansion = this.read_dollar_expansion();
        if (expansion !== null) {
          expression += expansion;
          continue;
        }
      }
      if (quote !== null) {
        expression += character;
        if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        expression += character;
        continue;
      }
      if (character === "(") {
        nestedParentheses++;
        expression += character;
        continue;
      }
      if (character === ")") {
        if (nestedParentheses > 0) {
          nestedParentheses--;
          expression += character;
          continue;
        }
        if (this.peek_char() === ")") {
          this.shell_getc();
          return expression;
        }
        this.pos = savedPosition;
        this.line = savedLine;
        return null;
      }
      expression += character;
    }
  }
  unget_token(tok) {
    this.pushback.push(tok);
  }
  next_token() {
    if (this.pushback.length > 0) {
      return this.pushback.pop();
    }
    return this.read_token();
  }
  /** Gather any pending here-documents after a newline */
  gather_here_documents() {
    for (const hd of this.pendingHereDocs) {
      const body = this.read_here_doc(hd.eof, hd.strip);
      if (hd.redirect.redirectee.filename) {
        hd.redirect.redirectee.filename.word = body;
      }
    }
    this.pendingHereDocs = [];
  }
  read_here_doc(eof, strip) {
    let body = "";
    while (true) {
      let line = "";
      while (true) {
        const c = this.shell_getc();
        if (c === "") {
          this.warnings.push(`here-document delimited by end-of-file (wanted '${eof}')`);
          return body;
        }
        if (c === "\n") break;
        line += c;
      }
      let checkLine = line;
      if (strip) {
        checkLine = strip_leading_tabs(line);
      }
      if (checkLine === eof) break;
      body += line + "\n";
    }
    return body;
  }
  skip_whitespace_and_comments() {
    while (true) {
      const c = this.peek_char();
      if (c === " " || c === "	") {
        this.shell_getc();
      } else if (c === "#") {
        while (true) {
          const ch = this.shell_getc();
          if (ch === "\n" || ch === "") {
            if (ch === "\n") this.shell_ungetc();
            break;
          }
        }
      } else {
        break;
      }
    }
  }
  read_token() {
    this.skip_whitespace_and_comments();
    const startLine = this.line;
    const c = this.shell_getc();
    if (c === "") return { type: 46 /* EOF */, value: "", line: startLine };
    if (c === "\n") {
      this.gather_here_documents();
      return { type: 37 /* NEWLINE */, value: "\n", line: startLine };
    }
    const c2 = this.peek_char();
    if (c === "&" && c2 === "&") {
      this.shell_getc();
      return { type: 21 /* AND_AND */, value: "&&", line: startLine };
    }
    if (c === "|" && c2 === "|") {
      this.shell_getc();
      return { type: 22 /* OR_OR */, value: "||", line: startLine };
    }
    if (c === "|" && c2 === "&") {
      this.shell_getc();
      return { type: 36 /* BAR_AND */, value: "|&", line: startLine };
    }
    if (c === ";" && c2 === ";") {
      this.shell_getc();
      if (this.peek_char() === "&") {
        this.shell_getc();
        return { type: 29 /* SEMI_SEMI_AND */, value: ";;&", line: startLine };
      }
      return { type: 27 /* SEMI_SEMI */, value: ";;", line: startLine };
    }
    if (c === ";" && c2 === "&") {
      this.shell_getc();
      return { type: 28 /* SEMI_AND */, value: ";&", line: startLine };
    }
    if (c === ">" && c2 === ">") {
      this.shell_getc();
      return { type: 23 /* GREATER_GREATER */, value: ">>", line: startLine };
    }
    if (c === ">" && c2 === "|") {
      this.shell_getc();
      return { type: 35 /* GREATER_BAR */, value: ">|", line: startLine };
    }
    if (c === ">" && c2 === "&") {
      this.shell_getc();
      return { type: 26 /* GREATER_AND */, value: ">&", line: startLine };
    }
    if (c === "<" && c2 === "<") {
      this.shell_getc();
      const c3 = this.peek_char();
      if (c3 === "-") {
        this.shell_getc();
        return { type: 30 /* LESS_LESS_MINUS */, value: "<<-", line: startLine };
      }
      if (c3 === "<") {
        this.shell_getc();
        return { type: 31 /* LESS_LESS_LESS */, value: "<<<", line: startLine };
      }
      return { type: 24 /* LESS_LESS */, value: "<<", line: startLine };
    }
    if (c === "<" && c2 === "&") {
      this.shell_getc();
      return { type: 25 /* LESS_AND */, value: "<&", line: startLine };
    }
    if (c === "<" && c2 === ">") {
      this.shell_getc();
      return { type: 34 /* LESS_GREATER */, value: "<>", line: startLine };
    }
    if (c === "&" && c2 === ">") {
      this.shell_getc();
      if (this.peek_char() === ">") {
        this.shell_getc();
        return { type: 33 /* AND_GREATER_GREATER */, value: "&>>", line: startLine };
      }
      return { type: 32 /* AND_GREATER */, value: "&>", line: startLine };
    }
    if (c === "|") return { type: 40 /* PIPE */, value: "|", line: startLine };
    if (c === "&") return { type: 39 /* AMP */, value: "&", line: startLine };
    if (c === ";") return { type: 38 /* SEMI */, value: ";", line: startLine };
    if (c === ">" && c2 !== "(") return { type: 0 /* WORD */, value: ">", line: startLine };
    if (c === "<" && c2 !== "(") return { type: 0 /* WORD */, value: "<", line: startLine };
    if (c === "(") return { type: 41 /* LPAREN */, value: "(", line: startLine };
    if (c === ")") return { type: 42 /* RPAREN */, value: ")", line: startLine };
    this.shell_ungetc();
    const ch = this.shell_getc();
    let word = "";
    let isNum = true;
    let quoted = false;
    word += ch;
    if (ch < "0" || ch > "9") isNum = false;
    if (ch === "'" || ch === '"') {
      quoted = true;
      this.shell_ungetc();
      word = "";
    } else if (ch === "\\") {
      quoted = true;
      const next = this.shell_getc();
      if (next === "\n") {
        return this.read_token();
      }
      word = "\\" + next;
    } else if (ch === "$") {
      word = this.read_dollar_expansion() ?? "$";
    } else if (ch === "`") {
      quoted = true;
      word = this.read_backtick_word();
    } else if ((ch === "<" || ch === ">") && this.peek_char() === "(") {
      this.shell_getc();
      word = this.read_process_substitution(ch);
    }
    if (ch === "'" || ch === '"') {
    }
    while (true) {
      const nc = this.peek_char();
      const startsProcessSubstitution = (nc === "<" || nc === ">") && this.input[this.pos + 1] === "(";
      if (startsProcessSubstitution) {
        this.shell_getc();
        this.shell_getc();
        word += this.read_process_substitution(nc);
        isNum = false;
        continue;
      }
      if (nc === "" || nc === " " || nc === "	" || nc === "\n" || nc === "|" || nc === "&" || nc === ";" || nc === ")" || nc === "(" || nc === "#") {
        break;
      }
      if ((nc === ">" || nc === "<") && word.length > 0) {
        if (is_all_digits(word)) {
          break;
        }
        break;
      }
      if (nc === "}" && this._allowReserved && word === "") {
        this.shell_getc();
        word = "}";
        break;
      }
      this.shell_getc();
      if (nc === "\\") {
        if (starts_with_windows_drive_prefix(word)) {
          word += "\\\\";
          continue;
        }
        quoted = true;
        const escaped = this.shell_getc();
        if (escaped === "\n") continue;
        word += "\\" + escaped;
        continue;
      }
      if (nc === "'") {
        quoted = true;
        word += "'";
        while (true) {
          const qc = this.shell_getc();
          if (qc === "") {
            this.warnings.push("unexpected EOF while looking for matching `''`");
            break;
          }
          if (qc === "'") {
            word += qc;
            break;
          }
          word += qc;
        }
        continue;
      }
      if (nc === '"') {
        quoted = true;
        word += '"';
        while (true) {
          const qc = this.shell_getc();
          if (qc === "") {
            this.warnings.push('unexpected EOF while looking for matching `"`');
            break;
          }
          if (qc === '"') {
            word += qc;
            break;
          }
          if (qc === "\\") {
            const esc = this.shell_getc();
            word += "\\" + esc;
            continue;
          }
          word += qc;
        }
        continue;
      }
      if (nc === "$") {
        const expansion = this.read_dollar_expansion();
        if (expansion !== null) {
          word += expansion;
          continue;
        }
      }
      if (nc === "`") {
        quoted = true;
        word += this.read_backtick_word();
        continue;
      }
      word += nc;
      if (nc < "0" || nc > "9") isNum = false;
    }
    if (word === "") return this.read_token();
    if (this._conditionalExpression) {
      if (word === "]]") {
        this.conditionalEndSeen = true;
        return { type: 45 /* COND_END */, value: word, line: startLine };
      }
      if (word === "!") {
        return { type: 19 /* BANG */, value: word, line: startLine };
      }
      const type = isNum && word.length > 0 ? 2 /* NUMBER */ : 0 /* WORD */;
      const token = { type, value: word, line: startLine, quoted };
      this.conditionalWordTokens.push(token);
      return token;
    }
    if (this._allowReserved) {
      const rw = RESERVED_WORDS[word];
      if (rw !== void 0) {
        return { type: rw, value: word, line: startLine };
      }
    }
    if (assignment_word(word)) {
      return { type: 1 /* ASSIGNMENT_WORD */, value: word, line: startLine, quoted };
    }
    const tt = isNum && word.length > 0 ? 2 /* NUMBER */ : 0 /* WORD */;
    return { type: tt, value: word, line: startLine, quoted };
  }
  /** Register a here-document to be collected at the next newline */
  registerHereDoc(redirect, eof, strip, quoted) {
    this.pendingHereDocs.push({ redirect, eof, strip, quoted });
  }
};
var Parser = class {
  lexer;
  _consumedAllInput = false;
  warnings = [];
  constructor(input) {
    this.lexer = new Lexer(input);
  }
  get consumedAllInput() {
    return this._consumedAllInput;
  }
  parse() {
    this._consumedAllInput = false;
    try {
      const cmd = this.parse_compound_list();
      this.skip_newlines();
      const tok = this.lexer.next_token();
      if (tok.type !== 46 /* EOF */) {
        this.lexer.unget_token(tok);
      } else {
        this._consumedAllInput = true;
      }
      this.warnings.push(...this.lexer.warnings);
      return cmd;
    } catch (e) {
      this.warnings.push(...this.lexer.warnings);
      this.warnings.push("Parse error: " + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }
  peek() {
    const tok = this.lexer.next_token();
    this.lexer.unget_token(tok);
    return tok;
  }
  expect(type, what) {
    const tok = this.lexer.next_token();
    if (tok.type !== type) {
      throw new Error(`Expected ${what} but got '${tok.value}' (line ${tok.line})`);
    }
    return tok;
  }
  skip_newlines() {
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type !== 37 /* NEWLINE */) {
        this.lexer.unget_token(tok);
        return;
      }
    }
  }
  /** compound_list → newline_list list1 (terminator newline_list list1)* */
  parse_compound_list() {
    this.skip_newlines();
    let cmd = this.parse_list1();
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type === 37 /* NEWLINE */ || tok.type === 38 /* SEMI */) {
        this.skip_newlines();
        const next = this.peek();
        if (this.is_command_start(next)) {
          const right = this.parse_list1();
          cmd = command_connect(cmd, right, SEMI);
        }
      } else if (tok.type === 39 /* AMP */) {
        this.skip_newlines();
        const next = this.peek();
        const right = this.is_command_start(next) ? this.parse_list1() : null;
        cmd = connect_async_list(cmd, right, AMP);
      } else {
        this.lexer.unget_token(tok);
        break;
      }
    }
    return cmd;
  }
  /** list1 → pipeline_command ((AND_AND|OR_OR) newline_list pipeline_command)* */
  parse_list1() {
    let cmd = this.parse_pipeline_command();
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type === 21 /* AND_AND */) {
        this.skip_newlines();
        const right = this.parse_pipeline_command();
        cmd = command_connect(cmd, right, AND_AND);
      } else if (tok.type === 22 /* OR_OR */) {
        this.skip_newlines();
        const right = this.parse_pipeline_command();
        cmd = command_connect(cmd, right, OR_OR);
      } else {
        this.lexer.unget_token(tok);
        break;
      }
    }
    return cmd;
  }
  /** pipeline_command → BANG? pipeline */
  parse_pipeline_command() {
    const tok = this.lexer.next_token();
    if (tok.type === 19 /* BANG */) {
      const cmd = this.parse_pipeline();
      cmd.flags |= CMD_INVERT_RETURN;
      return cmd;
    }
    if (tok.type === 20 /* TIME */) {
      return this.parse_pipeline_command();
    }
    this.lexer.unget_token(tok);
    return this.parse_pipeline();
  }
  /** pipeline → command (('|'|'|&') newline_list command)* */
  parse_pipeline() {
    let cmd = this.parse_command();
    while (true) {
      const tok = this.lexer.next_token();
      if (tok.type === 40 /* PIPE */) {
        this.skip_newlines();
        const right = this.parse_command();
        cmd = command_connect(cmd, right, PIPE);
      } else if (tok.type === 36 /* BAR_AND */) {
        this.skip_newlines();
        const right = this.parse_command();
        cmd = command_connect(cmd, right, BAR_AND);
      } else {
        this.lexer.unget_token(tok);
        break;
      }
    }
    return cmd;
  }
  /** command → shell_command redirect_list? | function_def | simple_command */
  parse_command() {
    const tok = this.peek();
    if (tok.type === 3 /* IF */) return this.parse_if_command_with_redirects();
    if (tok.type === 11 /* FOR */) return this.parse_for_command_with_redirects();
    if (tok.type === 12 /* WHILE */) return this.parse_while_command_with_redirects();
    if (tok.type === 13 /* UNTIL */) return this.parse_until_command_with_redirects();
    if (tok.type === 8 /* CASE */) return this.parse_case_command_with_redirects();
    if (tok.type === 43 /* LBRACE */) return this.parse_group_command_with_redirects();
    if (tok.type === 41 /* LPAREN */) {
      const start = this.lexer.next_token();
      const expression = this.lexer.tryReadArithmeticCommand();
      if (expression !== null) {
        set_line_number(start.line);
        return this.parse_shell_command_with_redirects(() => make_arith_command(make_word(expression, W_QUOTED), start.line));
      }
      this.lexer.unget_token(start);
      return this.parse_subshell_with_redirects();
    }
    if (tok.type === 16 /* FUNCTION */) return this.parse_function_def();
    if (tok.type === 0 /* WORD */ && tok.value === "[[") {
      return this.parse_cond_command_with_redirects();
    }
    if (tok.type === 0 /* WORD */ || tok.type === 1 /* ASSIGNMENT_WORD */) {
      return this.parse_simple_command_or_function();
    }
    if (tok.type === 2 /* NUMBER */) {
      return this.parse_simple_command_or_function();
    }
    throw new Error(`Unexpected token '${tok.value}' at line ${tok.line}`);
  }
  parse_shell_command_with_redirects(parseFn) {
    const cmd = parseFn();
    cmd.redirects = this.parse_redirect_list(cmd.redirects);
    return cmd;
  }
  parse_if_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_if_command());
  }
  parse_for_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_for_command());
  }
  parse_while_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_while_command());
  }
  parse_until_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_until_command());
  }
  parse_case_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_case_command());
  }
  parse_group_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_group_command());
  }
  parse_subshell_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_subshell());
  }
  parse_cond_command_with_redirects() {
    return this.parse_shell_command_with_redirects(() => this.parse_cond_command());
  }
  // ── [[ conditional expression ]] ──
  parse_cond_command() {
    const start = this.lexer.next_token();
    if (start.type !== 0 /* WORD */ || start.value !== "[[") {
      throw new Error(`Expected '[[' but got '${start.value}' (line ${start.line})`);
    }
    set_line_number(start.line);
    this.lexer.conditionalExpression = true;
    let expression;
    try {
      expression = this.parse_cond_or();
      this.expect(45 /* COND_END */, "]]");
      this.lexer.takeConditionalWords();
    } catch (error) {
      if (!this.lexer.hasSeenConditionalEnd) {
        let token;
        do {
          token = this.lexer.next_token();
        } while (token.type !== 45 /* COND_END */ && token.type !== 46 /* EOF */);
      }
      expression = make_cond_node(
        COND_UNKNOWN,
        null,
        null,
        null,
        start.line
      );
      expression.words = this.lexer.takeConditionalWords();
      this.warnings.push(
        `conditional expression at line ${start.line} widened to unknown: ` + (error instanceof Error ? error.message : String(error))
      );
    } finally {
      this.lexer.conditionalExpression = false;
    }
    return make_cond_command(expression, start.line);
  }
  parse_cond_or() {
    let node = this.parse_cond_and();
    while (true) {
      const token = this.lexer.next_token();
      if (token.type !== 22 /* OR_OR */) {
        this.lexer.unget_token(token);
        return node;
      }
      node = make_cond_node(
        COND_OR,
        null,
        node,
        this.parse_cond_and(),
        token.line
      );
    }
  }
  parse_cond_and() {
    let node = this.parse_cond_term();
    while (true) {
      const token = this.lexer.next_token();
      if (token.type !== 21 /* AND_AND */) {
        this.lexer.unget_token(token);
        return node;
      }
      node = make_cond_node(
        COND_AND,
        null,
        node,
        this.parse_cond_term(),
        token.line
      );
    }
  }
  parse_cond_term() {
    this.skip_newlines();
    const token = this.lexer.next_token();
    if (token.type === 41 /* LPAREN */) {
      const nested = this.parse_cond_or();
      this.expect(42 /* RPAREN */, ")");
      this.skip_newlines();
      return make_cond_node(COND_EXPR, null, nested, null, token.line);
    }
    if (token.type === 19 /* BANG */) {
      const nested = this.parse_cond_term();
      nested.flags ^= CMD_INVERT_RETURN;
      return nested;
    }
    const first = this.conditionalTokenWord(token);
    if (!first) {
      throw new Error(
        `Unexpected token '${token.value}' in conditional expression (line ${token.line})`
      );
    }
    if (CONDITIONAL_UNARY_OPERATORS.has(first.word)) {
      const operandToken = this.lexer.next_token();
      const operand = this.conditionalTokenWord(operandToken);
      if (!operand) {
        throw new Error(
          `Expected operand for '${first.word}' but got '${operandToken.value}' (line ${operandToken.line})`
        );
      }
      this.skip_newlines();
      const term = make_cond_node(
        COND_TERM,
        operand,
        null,
        null,
        operandToken.line
      );
      return make_cond_node(
        COND_UNARY,
        first,
        term,
        null,
        token.line
      );
    }
    const left = make_cond_node(COND_TERM, first, null, null, token.line);
    const operatorToken = this.lexer.next_token();
    if (operatorToken.type === 45 /* COND_END */ || operatorToken.type === 21 /* AND_AND */ || operatorToken.type === 22 /* OR_OR */ || operatorToken.type === 42 /* RPAREN */) {
      this.lexer.unget_token(operatorToken);
      return make_cond_node(
        COND_UNARY,
        make_word("-n"),
        left,
        null,
        token.line
      );
    }
    const operator = this.conditionalTokenWord(operatorToken);
    if (!operator || !CONDITIONAL_BINARY_OPERATORS.has(operator.word)) {
      throw new Error(
        `Expected conditional binary operator but got '${operatorToken.value}' (line ${operatorToken.line})`
      );
    }
    const rightToken = this.lexer.next_token();
    const rightWord = this.conditionalTokenWord(rightToken);
    if (!rightWord) {
      throw new Error(
        `Expected right operand for '${operator.word}' but got '${rightToken.value}' (line ${rightToken.line})`
      );
    }
    this.skip_newlines();
    return make_cond_node(
      COND_BINARY,
      operator,
      left,
      make_cond_node(COND_TERM, rightWord, null, null, rightToken.line),
      token.line
    );
  }
  conditionalTokenWord(token) {
    if (token.type === 0 /* WORD */ || token.type === 2 /* NUMBER */) {
      return make_word(token.value, token_word_flags(token));
    }
    if (token.type === 19 /* BANG */) return make_word("!");
    return null;
  }
  // ── if_command ──
  parse_if_command() {
    const startLine = this.lexer.currentLine;
    this.expect(3 /* IF */, "if");
    set_line_number(startLine);
    const test = this.parse_compound_list();
    this.expect(4 /* THEN */, "then");
    const true_case = this.parse_compound_list();
    let false_case = null;
    const tok = this.lexer.next_token();
    if (tok.type === 6 /* ELIF */) {
      this.lexer.unget_token({ type: 3 /* IF */, value: "if", line: tok.line });
      false_case = this.parse_if_command();
    } else if (tok.type === 5 /* ELSE */) {
      false_case = this.parse_compound_list();
      this.expect(7 /* FI */, "fi");
    } else if (tok.type === 7 /* FI */) {
    } else {
      throw new Error(`Expected 'elif', 'else', or 'fi' but got '${tok.value}' (line ${tok.line})`);
    }
    return make_if_command(test, true_case, false_case);
  }
  // ── for_command ──
  parse_for_command() {
    const startLine = this.lexer.currentLine;
    this.expect(11 /* FOR */, "for");
    set_line_number(startLine);
    this.lexer.allowReserved = false;
    const nameTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    const name = make_word(nameTok.value, token_word_flags(nameTok));
    const map_list = [];
    const sep = this.lexer.next_token();
    if (sep.type === 10 /* IN */) {
      this.lexer.allowReserved = false;
      while (true) {
        const wt = this.lexer.next_token();
        if (wt.type === 38 /* SEMI */ || wt.type === 37 /* NEWLINE */) break;
        if (wt.type === 46 /* EOF */) break;
        map_list.push(make_word(wt.value, token_word_flags(wt)));
      }
      this.lexer.allowReserved = true;
      this.skip_newlines();
    } else if (sep.type === 38 /* SEMI */ || sep.type === 37 /* NEWLINE */) {
      this.skip_newlines();
    } else {
      this.lexer.unget_token(sep);
      this.skip_newlines();
    }
    this.expect(14 /* DO */, "do");
    const action = this.parse_compound_list();
    this.expect(15 /* DONE */, "done");
    return make_for_command(name, map_list, action, startLine);
  }
  // ── while_command ──
  parse_while_command() {
    this.expect(12 /* WHILE */, "while");
    const test = this.parse_compound_list();
    this.expect(14 /* DO */, "do");
    const action = this.parse_compound_list();
    this.expect(15 /* DONE */, "done");
    return make_while_command(test, action);
  }
  // ── until_command ──
  parse_until_command() {
    this.expect(13 /* UNTIL */, "until");
    const test = this.parse_compound_list();
    this.expect(14 /* DO */, "do");
    const action = this.parse_compound_list();
    this.expect(15 /* DONE */, "done");
    return make_until_command(test, action);
  }
  // ── case_command ──
  parse_case_command() {
    const startLine = this.lexer.currentLine;
    this.expect(8 /* CASE */, "case");
    set_line_number(startLine);
    this.lexer.allowReserved = false;
    const wordTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    const word = make_word(wordTok.value, token_word_flags(wordTok));
    this.skip_newlines();
    this.expect(10 /* IN */, "in");
    this.skip_newlines();
    let clauses = null;
    let lastClause = null;
    while (true) {
      const tok = this.peek();
      if (tok.type === 9 /* ESAC */) {
        this.lexer.next_token();
        break;
      }
      const patterns = [];
      const maybeParen = this.lexer.next_token();
      if (maybeParen.type !== 41 /* LPAREN */) {
        this.lexer.unget_token(maybeParen);
      }
      this.lexer.allowReserved = false;
      while (true) {
        const pt = this.lexer.next_token();
        patterns.push(make_word(pt.value, token_word_flags(pt)));
        const sep = this.lexer.next_token();
        if (sep.type === 40 /* PIPE */) continue;
        if (sep.value === ")") break;
        this.lexer.unget_token(sep);
        break;
      }
      this.lexer.allowReserved = true;
      this.skip_newlines();
      let action = null;
      const next = this.peek();
      if (next.type !== 27 /* SEMI_SEMI */ && next.type !== 28 /* SEMI_AND */ && next.type !== 29 /* SEMI_SEMI_AND */ && next.type !== 9 /* ESAC */) {
        action = this.parse_compound_list();
      }
      const clause = make_pattern_list(patterns, action);
      if (lastClause) lastClause.next = clause;
      else clauses = clause;
      lastClause = clause;
      const termTok = this.lexer.next_token();
      if (termTok.type === 27 /* SEMI_SEMI */ || termTok.type === 28 /* SEMI_AND */ || termTok.type === 29 /* SEMI_SEMI_AND */) {
        if (termTok.type === 28 /* SEMI_AND */) {
          clause.flags |= CASEPAT_FALLTHROUGH;
        } else if (termTok.type === 29 /* SEMI_SEMI_AND */) {
          clause.flags |= CASEPAT_TESTNEXT;
        }
        this.skip_newlines();
      } else if (termTok.type === 9 /* ESAC */) {
        break;
      } else {
        this.lexer.unget_token(termTok);
        this.skip_newlines();
        const check = this.peek();
        if (check.type === 9 /* ESAC */) {
          this.lexer.next_token();
          break;
        }
      }
    }
    return make_case_command(word, clauses, startLine);
  }
  // ── group_command ──
  parse_group_command() {
    this.expect(43 /* LBRACE */, "{");
    const cmd = this.parse_compound_list();
    this.expect(44 /* RBRACE */, "}");
    return make_group_command(cmd);
  }
  // ── subshell ──
  parse_subshell() {
    this.expect(41 /* LPAREN */, "(");
    const cmd = this.parse_compound_list();
    this.expect(42 /* RPAREN */, ")");
    return make_subshell_command(cmd);
  }
  // ── function_def ──
  parse_function_def() {
    this.expect(16 /* FUNCTION */, "function");
    this.lexer.allowReserved = false;
    const nameTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    const name = make_word(nameTok.value, token_word_flags(nameTok));
    const tok = this.lexer.next_token();
    if (tok.type === 41 /* LPAREN */) {
      this.expect(42 /* RPAREN */, ")");
      this.skip_newlines();
    } else {
      this.lexer.unget_token(tok);
      this.skip_newlines();
    }
    const body = this.parse_command();
    return make_function_def(name, body);
  }
  // ── simple_command or word() function ──
  parse_simple_command_or_function() {
    const first = this.lexer.next_token();
    if (first.type === 0 /* WORD */) {
      const tok2 = this.lexer.next_token();
      if (tok2.type === 41 /* LPAREN */) {
        const tok3 = this.lexer.next_token();
        if (tok3.type === 42 /* RPAREN */) {
          this.skip_newlines();
          const name = make_word(first.value, token_word_flags(first));
          const body = this.parse_command();
          return make_function_def(name, body);
        }
        this.lexer.unget_token(tok3);
      }
      this.lexer.unget_token(tok2);
    }
    this.lexer.unget_token(first);
    return this.parse_simple_command();
  }
  // ── simple_command ──
  parse_simple_command() {
    const cmd = make_simple_command();
    cmd.line = this.lexer.currentLine;
    set_line_number(cmd.line);
    while (true) {
      const tok = this.lexer.next_token();
      if (this.is_redirect_token(tok)) {
        this.lexer.unget_token(tok);
        cmd.redirects = this.parse_single_redirect(cmd.redirects, -1);
        continue;
      }
      if (tok.type === 0 /* WORD */ || tok.type === 1 /* ASSIGNMENT_WORD */ || tok.type === 2 /* NUMBER */) {
        if (tok.type === 2 /* NUMBER */ || tok.type === 0 /* WORD */ && is_all_digits(tok.value)) {
          const next = this.peek();
          if (this.is_redirect_start(next)) {
            const fd = parseInt(tok.value, 10);
            cmd.redirects = this.parse_single_redirect(cmd.redirects, fd);
            continue;
          }
        }
        const flags = token_word_flags(tok) | (tok.type === 1 /* ASSIGNMENT_WORD */ ? W_ASSIGNMENT : 0);
        add_element_to_simple_command(cmd, make_word(tok.value, flags));
        continue;
      }
      this.lexer.unget_token(tok);
      break;
    }
    return clean_simple_command(cmd);
  }
  // ── Redirections ──
  is_redirect_start(tok) {
    return this.is_redirect_token(tok);
  }
  is_redirect_token(tok) {
    switch (tok.type) {
      case 23 /* GREATER_GREATER */:
      case 24 /* LESS_LESS */:
      case 30 /* LESS_LESS_MINUS */:
      case 31 /* LESS_LESS_LESS */:
      case 25 /* LESS_AND */:
      case 26 /* GREATER_AND */:
      case 32 /* AND_GREATER */:
      case 33 /* AND_GREATER_GREATER */:
      case 34 /* LESS_GREATER */:
      case 35 /* GREATER_BAR */:
        return true;
      default:
        if (tok.type === 0 /* WORD */ && (tok.value === ">" || tok.value === "<")) return true;
        return false;
    }
  }
  parse_redirect_list(existing) {
    while (true) {
      const tok = this.peek();
      if (tok.type === 2 /* NUMBER */ || tok.type === 0 /* WORD */ && is_all_digits(tok.value)) {
        const next_next = this.lexer.next_token();
        const after = this.peek();
        this.lexer.unget_token(next_next);
        if (this.is_redirect_token(after)) {
          this.lexer.next_token();
          const fd = parseInt(next_next.value, 10);
          existing = this.parse_single_redirect(existing, fd);
          continue;
        }
        break;
      }
      if (!this.is_redirect_token(tok)) break;
      existing = this.parse_single_redirect(existing, -1);
    }
    return existing;
  }
  parse_single_redirect(existing, fd) {
    const opTok = this.lexer.next_token();
    let instruction;
    const defaultInFd = fd >= 0 ? fd : 0;
    const defaultOutFd = fd >= 0 ? fd : 1;
    switch (opTok.type) {
      case 23 /* GREATER_GREATER */:
        instruction = "r_appending_to";
        break;
      case 24 /* LESS_LESS */:
        instruction = "r_reading_until";
        break;
      case 30 /* LESS_LESS_MINUS */:
        instruction = "r_deblank_reading_until";
        break;
      case 31 /* LESS_LESS_LESS */:
        instruction = "r_reading_string";
        break;
      case 25 /* LESS_AND */:
        instruction = "r_duplicating_input";
        break;
      case 26 /* GREATER_AND */:
        instruction = "r_duplicating_output";
        break;
      case 32 /* AND_GREATER */:
        instruction = "r_err_and_out";
        break;
      case 33 /* AND_GREATER_GREATER */:
        instruction = "r_append_err_and_out";
        break;
      case 34 /* LESS_GREATER */:
        instruction = "r_input_output";
        break;
      case 35 /* GREATER_BAR */:
        instruction = "r_output_force";
        break;
      default:
        if (opTok.value === ">") {
          instruction = "r_output_direction";
        } else {
          instruction = "r_input_direction";
        }
        break;
    }
    this.lexer.allowReserved = false;
    const targetTok = this.lexer.next_token();
    this.lexer.allowReserved = true;
    if (instruction === "r_reading_until" || instruction === "r_deblank_reading_until") {
      const strip = instruction === "r_deblank_reading_until";
      let eof = targetTok.value;
      const quoted = eof.includes("'") || eof.includes('"') || eof.includes("\\");
      eof = strip_quoting_chars(eof);
      const source2 = make_redirectee(defaultInFd);
      const redir_target = make_redirectee(make_word(targetTok.value, token_word_flags(targetTok)));
      const redir2 = make_redirection(source2, instruction, redir_target);
      redir2.here_doc_eof = eof;
      redir2.here_doc_quoted = quoted;
      this.lexer.registerHereDoc(redir2, eof, strip, quoted);
      return append_redirect(existing, redir2);
    }
    if (instruction === "r_duplicating_input" || instruction === "r_duplicating_output") {
      if (targetTok.value === "-") {
        const src_fd2 = instruction === "r_duplicating_input" ? defaultInFd : defaultOutFd;
        const source3 = make_redirectee(src_fd2);
        const redir3 = make_redirection(source3, "r_close_this", make_redirectee(-1));
        return append_redirect(existing, redir3);
      }
      if (is_all_digits(targetTok.value)) {
        const src_fd2 = instruction === "r_duplicating_input" ? defaultInFd : defaultOutFd;
        const source3 = make_redirectee(src_fd2);
        const redir3 = make_redirection(source3, instruction, make_redirectee(parseInt(targetTok.value, 10)));
        return append_redirect(existing, redir3);
      }
      const newInstr = instruction === "r_duplicating_input" ? "r_duplicating_input_word" : "r_duplicating_output_word";
      const src_fd = instruction === "r_duplicating_input" ? defaultInFd : defaultOutFd;
      const source2 = make_redirectee(src_fd);
      const redir2 = make_redirection(source2, newInstr, make_redirectee(make_word(targetTok.value, token_word_flags(targetTok))));
      return append_redirect(existing, redir2);
    }
    const isOutput = instruction === "r_output_direction" || instruction === "r_appending_to" || instruction === "r_output_force" || instruction === "r_err_and_out" || instruction === "r_append_err_and_out";
    const srcFd = isOutput ? defaultOutFd : defaultInFd;
    const source = make_redirectee(srcFd);
    const redirectee = make_redirectee(make_word(targetTok.value, token_word_flags(targetTok)));
    const redir = make_redirection(source, instruction, redirectee);
    return append_redirect(existing, redir);
  }
  // ── Helpers ──
  is_command_start(tok) {
    switch (tok.type) {
      case 0 /* WORD */:
      case 1 /* ASSIGNMENT_WORD */:
      case 2 /* NUMBER */:
      case 3 /* IF */:
      case 11 /* FOR */:
      case 12 /* WHILE */:
      case 13 /* UNTIL */:
      case 8 /* CASE */:
      case 43 /* LBRACE */:
      case 41 /* LPAREN */:
      case 16 /* FUNCTION */:
      case 19 /* BANG */:
      case 20 /* TIME */:
        return true;
      default:
        return false;
    }
  }
};
function parse(input) {
  const parser = new Parser(input);
  const ast = parser.parse();
  return { ast, warnings: parser.warnings };
}
function parseComplete(input) {
  const parser = new Parser(input);
  const ast = parser.parse();
  return {
    ast,
    warnings: parser.warnings,
    complete: parser.consumedAllInput
  };
}

// src/analysis/abstract.ts
var DEFAULT_ABSTRACT_VALUE_LIMIT = 8;
var DEFAULT_ABSTRACT_STREAM_LIMIT = 8;
var DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT = 16 * 1024;
function normalControl() {
  return { kind: "none" };
}
function finiteStringValue(values, mayBeUnset = false) {
  return {
    kind: "finite",
    values: normalizeStrings(values),
    mayBeUnset,
    reasons: []
  };
}
function exactStringValue(value) {
  return finiteStringValue([value]);
}
function unsetStringValue() {
  return finiteStringValue([], true);
}
function unknownStringValue(reason, witnesses = [], mayBeUnset = false) {
  return {
    kind: "unknown",
    values: normalizeStrings(witnesses),
    mayBeUnset,
    reasons: [reason]
  };
}
function joinStringValues(values, reason, limit = DEFAULT_ABSTRACT_VALUE_LIMIT) {
  if (values.length === 0) return unsetStringValue();
  const witnesses = normalizeStrings(values.flatMap((value) => value.values));
  const widened = witnesses.length > limit;
  const unknown = widened || values.some((value) => value.kind === "unknown");
  const reasons = normalizeStrings([
    ...values.flatMap((value) => value.reasons),
    ...unknown && values.length > 1 ? [reason] : []
  ]);
  return {
    kind: unknown ? "unknown" : "finite",
    values: witnesses.slice(0, limit),
    mayBeUnset: values.some((value) => value.mayBeUnset),
    reasons
  };
}
function exactStatus(code) {
  const normalized = normalizeStatusCode(code);
  return {
    maySucceed: normalized === 0,
    mayFail: normalized !== 0,
    exactCodes: [normalized],
    mayHaveOtherFailureCode: false
  };
}
function successStatus() {
  return exactStatus(0);
}
function failureStatus() {
  return {
    maySucceed: false,
    mayFail: true,
    exactCodes: [],
    mayHaveOtherFailureCode: true
  };
}
function unknownStatus() {
  return {
    maySucceed: true,
    mayFail: true,
    exactCodes: [0],
    mayHaveOtherFailureCode: true
  };
}
function joinStatuses(statuses) {
  if (statuses.length === 0) return unknownStatus();
  return {
    maySucceed: statuses.some((status) => status.maySucceed),
    mayFail: statuses.some((status) => status.mayFail),
    exactCodes: normalizeNumbers(statuses.flatMap((status) => status.exactCodes)),
    mayHaveOtherFailureCode: statuses.some((status) => status.mayHaveOtherFailureCode)
  };
}
function successfulStatusPart(status) {
  return status.maySucceed ? successStatus() : failureStatus();
}
function failureStatusPart(status) {
  if (!status.mayFail) return successStatus();
  return {
    maySucceed: false,
    mayFail: true,
    exactCodes: status.exactCodes.filter((code) => code !== 0),
    mayHaveOtherFailureCode: status.mayHaveOtherFailureCode
  };
}
function pipelineStatus(statuses, pipefail) {
  if (statuses.length === 0) return unknownStatus();
  if (!pipefail) return statuses[statuses.length - 1];
  let laterMaySucceed = true;
  let mayFail = false;
  let mayHaveOtherFailureCode = false;
  const failureCodes = [];
  for (let index = statuses.length - 1; index >= 0; index--) {
    const status = statuses[index];
    if (laterMaySucceed && status.mayFail) {
      mayFail = true;
      failureCodes.push(...status.exactCodes.filter((code) => code !== 0));
      mayHaveOtherFailureCode ||= status.mayHaveOtherFailureCode;
    }
    laterMaySucceed &&= status.maySucceed;
  }
  const maySucceed = laterMaySucceed;
  const exactCodes = normalizeNumbers([
    ...maySucceed ? [0] : [],
    ...failureCodes
  ]);
  return {
    maySucceed,
    mayFail,
    exactCodes,
    mayHaveOtherFailureCode
  };
}
function invertStatus(status) {
  const exactCodes = [];
  if (status.mayFail) exactCodes.push(0);
  if (status.maySucceed) exactCodes.push(1);
  return {
    maySucceed: status.mayFail,
    mayFail: status.maySucceed,
    exactCodes,
    mayHaveOtherFailureCode: false
  };
}
function emptyStream(provenance = []) {
  return {
    value: exactStringValue(""),
    mayHaveTrailingNewline: false,
    provenance: normalizeProvenance3(provenance)
  };
}
function exactStream(value, charLimit = DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT, provenance = []) {
  if (value.length > charLimit) {
    return {
      value: unknownStringValue(
        "stream-character-budget",
        [value.slice(0, charLimit)]
      ),
      mayHaveTrailingNewline: true,
      provenance: normalizeProvenance3(provenance)
    };
  }
  return {
    value: exactStringValue(value),
    mayHaveTrailingNewline: value.endsWith("\n"),
    provenance: normalizeProvenance3(provenance)
  };
}
function unknownStream(reason, provenance = []) {
  return {
    value: unknownStringValue(reason),
    mayHaveTrailingNewline: true,
    provenance: normalizeProvenance3(provenance)
  };
}
function appendStreams(left, right, reason = "stream-concatenation", limit = DEFAULT_ABSTRACT_STREAM_LIMIT) {
  const candidates = [];
  let widened = false;
  for (const leftValue of left.value.values) {
    for (const rightValue of right.value.values) {
      if (candidates.length >= limit) {
        widened = true;
        break;
      }
      const candidate = leftValue + rightValue;
      if (candidate.length > DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT) {
        candidates.push(candidate.slice(0, DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT));
        widened = true;
        break;
      }
      candidates.push(candidate);
    }
    if (widened) break;
  }
  const unknown = widened || left.value.kind === "unknown" || right.value.kind === "unknown";
  return {
    value: {
      kind: unknown ? "unknown" : "finite",
      values: normalizeStrings(candidates).slice(0, limit),
      mayBeUnset: left.value.mayBeUnset || right.value.mayBeUnset,
      reasons: normalizeStrings([
        ...left.value.reasons,
        ...right.value.reasons,
        ...unknown ? [reason] : []
      ])
    },
    mayHaveTrailingNewline: widened ? true : right.value.values.length === 0 ? left.mayHaveTrailingNewline || right.mayHaveTrailingNewline : right.mayHaveTrailingNewline,
    provenance: normalizeProvenance3([
      ...left.provenance,
      ...right.provenance
    ])
  };
}
function joinStreams(streams, reason = "stream-join", limit = DEFAULT_ABSTRACT_STREAM_LIMIT) {
  if (streams.length === 0) return emptyStream();
  const value = joinStringValues(
    streams.map((stream) => stream.value),
    reason,
    limit
  );
  return {
    value,
    mayHaveTrailingNewline: streams.some((stream) => stream.mayHaveTrailingNewline),
    provenance: normalizeProvenance3(
      streams.flatMap((stream) => stream.provenance)
    )
  };
}
function stripTrailingNewlines(stream) {
  return {
    value: {
      ...stream.value,
      values: normalizeStrings(
        stream.value.values.map((value) => value.replace(/\n+$/u, ""))
      )
    },
    mayHaveTrailingNewline: false,
    provenance: [...stream.provenance]
  };
}
function normalizeStrings(values) {
  return [...new Set(values)].sort();
}
function normalizeNumbers(values) {
  return [...new Set([...values].map(normalizeStatusCode))].sort((a, b) => a - b);
}
function normalizeProvenance3(provenance) {
  return [...new Set(provenance)].filter((id) => Number.isInteger(id) && id >= 0).sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}
function normalizeStatusCode(code) {
  if (!Number.isFinite(code)) return 1;
  return Math.trunc(code) & 255;
}

// src/analysis/state.ts
var MAX_SHELL_PATHS = 64;
function makeAnalysisState(env, flags, tracker, nestedDepth = 0) {
  env.set_provenance_recorder((event) => recordVariableProvenance(tracker, event));
  return {
    env,
    flags,
    tracker,
    lastStatus: successStatus(),
    control: normalControl(),
    io: makeDefaultIoState(),
    nestedDepth,
    privileged: false,
    runtime: {
      statementCount: 0,
      functionDepth: 0,
      sourceDepth: 0,
      processSubstitutionCount: 0,
      loopDepth: 0,
      halted: false,
      warnings: /* @__PURE__ */ new Set(),
      alternatives: [],
      pathUncertainty: [],
      vfsSelectionUncertainty: [],
      lastCommandSubstitutionStatus: null
    }
  };
}
function recordVariableProvenance(tracker, event) {
  if (event.kind === "bind" && event.name === "?" && event.parents.length === 0) {
    return tracker.currentProvenance()[0];
  }
  const subject = event.key === void 0 ? event.name : `${event.name}[${event.key}]`;
  const kind = event.kind === "state-join" ? "state-join" : "variable-binding";
  const action = event.kind === "state-join" ? "join" : event.kind === "array-widen" ? "widen" : event.kind === "declare-array" ? "declare" : "bind";
  return tracker.addProvenance({
    kind,
    label: `${action} ${subject}`,
    ...event.parents.length === 0 ? {} : { parents: event.parents }
  });
}
function captureShellState(state) {
  return {
    env: state.env.snapshot(),
    flags: { ...state.flags },
    cwd: state.tracker.getCwd(),
    vfs: state.tracker.vfs?.clone() ?? null,
    lastStatus: state.lastStatus,
    control: cloneControl(state.control),
    io: cloneIoState(state.io),
    pathUncertainty: [...state.runtime.pathUncertainty]
  };
}
function restoreShellState(state, snapshot) {
  state.env.restore(snapshot.env);
  state.flags = { ...snapshot.flags };
  state.tracker.setCwd(snapshot.cwd);
  state.tracker.setVfs(snapshot.vfs?.clone() ?? null);
  state.lastStatus = snapshot.lastStatus;
  state.control = cloneControl(snapshot.control);
  state.io = cloneIoState(snapshot.io);
  state.runtime.pathUncertainty = [...snapshot.pathUncertainty];
}
function takeShellStates(state) {
  if (state.runtime.alternatives.length === 0) return [captureShellState(state)];
  const alternatives = state.runtime.alternatives;
  state.runtime.alternatives = [];
  return alternatives;
}
function installShellStates(state, snapshots) {
  const deduplicated = deduplicateShellStates(snapshots, state.tracker);
  const bounded = deduplicated.length <= MAX_SHELL_PATHS ? deduplicated : widenShellStateGroups(
    state,
    deduplicated
  );
  if (bounded.length === 0) {
    const fallback = captureShellState(state);
    restoreShellState(state, fallback);
    state.runtime.alternatives = [];
    return fallback.lastStatus;
  }
  restoreShellState(state, bounded[0]);
  state.runtime.alternatives = bounded.length > 1 ? bounded : [];
  return joinStatuses(bounded.map((snapshot) => snapshot.lastStatus));
}
function appendPathUncertainty(snapshot, reason) {
  return {
    ...snapshot,
    pathUncertainty: [.../* @__PURE__ */ new Set([...snapshot.pathUncertainty, reason])]
  };
}
function collapseEquivalentShellStates(snapshots, retainedUncertainty, tracker) {
  if (snapshots.length < 2) return [...snapshots];
  const normalized = snapshots.map((snapshot) => ({
    ...snapshot,
    pathUncertainty: [...retainedUncertainty]
  }));
  const deduplicated = deduplicateShellStates(normalized, tracker);
  return deduplicated.length === 1 ? deduplicated : [...snapshots];
}
function deduplicateShellStates(snapshots, tracker) {
  const grouped = /* @__PURE__ */ new Map();
  for (const snapshot of snapshots) {
    const key = shellStateKey(snapshot);
    const group = grouped.get(key);
    if (group) group.push(snapshot);
    else grouped.set(key, [snapshot]);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => {
    if (group.length === 1) return group[0];
    return {
      ...group[0],
      env: mergeEquivalentVariableSnapshotProvenance(
        group.map((snapshot) => snapshot.env),
        tracker ? (name, parents) => tracker.addProvenance({
          kind: "state-join",
          label: `join equivalent ${name} bindings`,
          ...parents.length === 0 ? {} : { parents }
        }) : void 0
      ),
      io: joinIoStates(group.map((snapshot) => snapshot.io))
    };
  });
}
function widenShellStateGroups(state, snapshots) {
  const groups = /* @__PURE__ */ new Map();
  for (const snapshot of snapshots) {
    const key = controlWideningKey(snapshot.control);
    const group = groups.get(key);
    if (group) group.push(snapshot);
    else groups.set(key, [snapshot]);
  }
  const widened = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => widenShellStates(state, group));
  if (!state.runtime.warnings.has("shell-path-budget")) {
    state.runtime.warnings.add("shell-path-budget");
    state.tracker.addWarning(
      `Bash branch state widened after ${MAX_SHELL_PATHS} alternatives`
    );
  }
  return widened;
}
function widenShellStates(state, snapshots) {
  state.env.restore_widened(snapshots.map((snapshot) => snapshot.env));
  const cwd = snapshots.every((snapshot) => snapshot.cwd === snapshots[0].cwd) ? snapshots[0].cwd : "/<unknown-cwd>";
  state.tracker.setCwd(cwd);
  if (cwd !== snapshots[0].cwd) {
    state.env.bind_variable("PWD", cwd, 0, true);
  }
  const flags = { ...snapshots[0].flags };
  for (const key of Object.keys(flags)) {
    if (snapshots.some((snapshot) => snapshot.flags[key] !== flags[key])) {
      flags[key] = key === "noglob" ? false : flags[key];
    }
  }
  state.flags = flags;
  const vfsKey = snapshots[0].vfs?.stateKey() ?? "none";
  const vfs = snapshots.every((snapshot) => (snapshot.vfs?.stateKey() ?? "none") === vfsKey) ? snapshots[0].vfs?.clone() ?? null : null;
  state.tracker.setVfs(vfs);
  const status = joinStatuses(snapshots.map((snapshot) => snapshot.lastStatus));
  state.lastStatus = status;
  state.control = joinControls(snapshots.map((snapshot) => snapshot.control));
  state.io = joinIoStates(snapshots.map((snapshot) => snapshot.io));
  state.runtime.pathUncertainty = [
    .../* @__PURE__ */ new Set([
      ...snapshots.flatMap((snapshot) => snapshot.pathUncertainty),
      "state-widening"
    ])
  ];
  return captureShellState(state);
}
function shellStateKey(snapshot) {
  return JSON.stringify({
    env: variableEnvironmentSnapshotKey(snapshot.env),
    flags: snapshot.flags,
    cwd: snapshot.cwd,
    vfs: snapshot.vfs?.stateKey() ?? null,
    status: snapshot.lastStatus,
    control: snapshot.control,
    io: ioStateKey(snapshot.io),
    uncertainty: [...snapshot.pathUncertainty].sort()
  });
}
function controlWideningKey(control) {
  if (control.kind === "break" || control.kind === "continue") {
    return `${control.kind}:${control.levels}`;
  }
  return control.kind;
}
function joinControls(controls) {
  const first = controls[0] ?? normalControl();
  if (first.kind === "return" || first.kind === "exit") {
    return {
      kind: first.kind,
      status: joinStatuses(controls.filter((control) => control.kind === first.kind).map((control) => control.status))
    };
  }
  return cloneControl(first);
}
function cloneControl(control) {
  if (control.kind === "return" || control.kind === "exit") {
    return { kind: control.kind, status: control.status };
  }
  if (control.kind === "break" || control.kind === "continue") {
    return { kind: control.kind, levels: control.levels };
  }
  return { kind: control.kind };
}
function makeDefaultIoState() {
  return {
    fds: {
      0: { kind: "external", channel: "stdin" },
      1: { kind: "external", channel: "stdout" },
      2: { kind: "external", channel: "stderr" }
    },
    capture: emptyStream()
  };
}
function cloneIoState(io) {
  return {
    fds: Object.fromEntries(
      Object.entries(io.fds).map(([fd, target]) => [fd, cloneFdTarget(target)])
    ),
    capture: cloneStream(io.capture)
  };
}
function joinIoStates(states) {
  if (states.length === 0) return makeDefaultIoState();
  const fds = {};
  const fdKeys = new Set(states.flatMap((state) => Object.keys(state.fds)));
  for (const fd of [...fdKeys].sort((left, right) => Number(left) - Number(right))) {
    fds[fd] = joinFdTargets(states.map((state) => state.fds[fd] ?? { kind: "closed" }));
  }
  return {
    fds,
    capture: joinStreams(states.map((state) => state.capture), "stream-state-widening")
  };
}
function joinFdTargets(targets) {
  const first = targets[0] ?? { kind: "closed" };
  if (targets.every((target) => fdTargetKey(target) === fdTargetKey(first))) {
    if (first.kind === "input") {
      return {
        kind: "input",
        stream: joinStreams(
          targets.filter((target) => target.kind === "input").map((target) => target.stream),
          "fd-input-provenance-join"
        )
      };
    }
    return cloneFdTarget(first);
  }
  if (targets.every((target) => target.kind === "input")) {
    return {
      kind: "input",
      stream: joinStreams(targets.map((target) => target.stream), "fd-input-join")
    };
  }
  return { kind: "unknown", reason: "fd-state-join" };
}
function cloneFdTarget(target) {
  if (target.kind === "input") {
    return { kind: target.kind, stream: cloneStream(target.stream) };
  }
  return { ...target };
}
function cloneStream(stream) {
  return {
    value: {
      ...stream.value,
      values: [...stream.value.values],
      reasons: [...stream.value.reasons]
    },
    mayHaveTrailingNewline: stream.mayHaveTrailingNewline,
    provenance: [...stream.provenance]
  };
}
function fdTargetKey(target) {
  if (target.kind !== "input") return JSON.stringify(target);
  return JSON.stringify({
    kind: target.kind,
    stream: streamStateKey(target.stream)
  });
}
function ioStateKey(io) {
  return {
    fds: Object.fromEntries(
      Object.entries(io.fds).map(([fd, target]) => [
        fd,
        target.kind === "input" ? { kind: target.kind, stream: streamStateKey(target.stream) } : target
      ])
    ),
    capture: streamStateKey(io.capture)
  };
}
function streamStateKey(stream) {
  return {
    value: stream.value,
    mayHaveTrailingNewline: stream.mayHaveTrailingNewline
  };
}

// src/bash/commands.ts
var import_node_path4 = require("node:path");
var fs5 = __toESM(require("node:fs"), 1);

// src/git/invocation.ts
var import_node_path3 = require("node:path");
var DEFAULT_MAX_GIT_ARGS = 256;
var GIT_FLAG_OPTIONS = /* @__PURE__ */ new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-lazy-fetch",
  "--no-replace-objects",
  "--no-optional-locks",
  "--no-advice",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs"
]);
var GIT_QUERY_OPTIONS = /* @__PURE__ */ new Set([
  "--html-path",
  "--man-path",
  "--info-path"
]);
var GIT_OPTIONS_WITH_SEPARATE_VALUES = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--namespace",
  "--work-tree",
  "--shallow-file",
  "--attr-source"
]);
var GIT_OPTIONS_WITH_ATTACHED_VALUES = /* @__PURE__ */ new Set([
  "--config-env",
  "--git-dir",
  "--namespace",
  "--work-tree",
  "--attr-source"
]);
var GIT_PATHSPEC_FLAGS = /* @__PURE__ */ new Set([
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs"
]);
var RESET_LONG_OPTIONS = [
  "quiet",
  "no-quiet",
  "refresh",
  "no-refresh",
  "mixed",
  "soft",
  "hard",
  "merge",
  "keep",
  "recurse-submodules",
  "no-recurse-submodules",
  "patch",
  "no-patch",
  "auto-advance",
  "no-auto-advance",
  "unified",
  "inter-hunk-context",
  "intent-to-add",
  "no-intent-to-add",
  "pathspec-from-file",
  "no-pathspec-from-file",
  "pathspec-file-nul",
  "no-pathspec-file-nul"
];
var CLEAN_LONG_OPTIONS = [
  "quiet",
  "no-quiet",
  "dry-run",
  "no-dry-run",
  "force",
  "no-force",
  "interactive",
  "no-interactive",
  "exclude"
];
function resolveGitInvocation(args, options) {
  const maxArgs = positiveBudget(options.maxArgs);
  const budgetExhausted = args.length > maxArgs;
  const input = budgetExhausted ? args.slice(0, maxArgs) : args;
  let cwd = normalizeCwd(options.cwd);
  let gitDir = options.env?.["GIT_DIR"];
  let workTree = options.env?.["GIT_WORK_TREE"];
  let namespace = options.env?.["GIT_NAMESPACE"];
  let bare = options.env?.["GIT_IMPLICIT_WORK_TREE"] === "0";
  let forcedBare = false;
  let confidence = gitDir !== void 0 || workTree !== void 0 ? "environment" : "implicit";
  const pathspecFlags = [];
  const warnings = [];
  const completeness = budgetExhausted ? "partial" : "complete";
  const invalid2 = (warning) => finishGitInvocation({
    args: [],
    cwd,
    gitDir,
    workTree,
    namespace,
    bare,
    forcedBare,
    confidence,
    pathspecFlags,
    completeness: "invalid",
    exitsEarly: false,
    queryOnly: false,
    budgetExhausted,
    warnings: [...warnings, warning]
  });
  if (budgetExhausted) warnings.push(`Git invocation resolution stopped after ${maxArgs} arguments`);
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (!arg.startsWith("-")) {
      return finishGitInvocation({
        subcommand: arg,
        args: input.slice(i + 1),
        cwd,
        gitDir,
        workTree,
        namespace,
        bare,
        forcedBare,
        confidence,
        pathspecFlags,
        completeness,
        exitsEarly: false,
        queryOnly: false,
        budgetExhausted,
        warnings
      });
    }
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") {
      return finishGitInvocation({
        args: [],
        cwd,
        gitDir,
        workTree,
        namespace,
        bare,
        forcedBare,
        confidence,
        pathspecFlags,
        completeness,
        exitsEarly: true,
        queryOnly: true,
        budgetExhausted,
        warnings
      });
    }
    if (arg === "--exec-path" || GIT_QUERY_OPTIONS.has(arg) || arg.startsWith("--list-cmds=")) {
      return finishGitInvocation({
        args: [],
        cwd,
        gitDir,
        workTree,
        namespace,
        bare,
        forcedBare,
        confidence,
        pathspecFlags,
        completeness,
        exitsEarly: true,
        queryOnly: true,
        budgetExhausted,
        warnings
      });
    }
    if (arg.startsWith("--exec-path=")) continue;
    if (arg === "--bare") {
      if (gitDir === void 0) gitDir = cwd;
      bare = true;
      forcedBare = true;
      confidence = "explicit";
      continue;
    }
    if (GIT_FLAG_OPTIONS.has(arg)) {
      if (GIT_PATHSPEC_FLAGS.has(arg)) pathspecFlags.push(arg);
      continue;
    }
    const attached = attachedLongOption(arg);
    if (attached && GIT_OPTIONS_WITH_ATTACHED_VALUES.has(attached.name)) {
      if (attached.name === "--config-env" && !validConfigEnv(attached.value)) {
        return invalid2(`${attached.name} requires <name>=<envvar>`);
      }
      ({ gitDir, workTree, namespace, confidence } = applyGitContextOption(
        attached.name,
        attached.value,
        gitDir,
        workTree,
        namespace,
        "explicit"
      ));
      continue;
    }
    if (GIT_OPTIONS_WITH_SEPARATE_VALUES.has(arg)) {
      const value = input[i + 1];
      if (value === void 0) {
        if (budgetExhausted) {
          warnings.push(`Git invocation budget ended before the operand for ${arg}`);
          return finishGitInvocation({
            args: [],
            cwd,
            gitDir,
            workTree,
            namespace,
            bare,
            forcedBare,
            confidence,
            pathspecFlags,
            completeness: "partial",
            exitsEarly: false,
            queryOnly: false,
            budgetExhausted,
            warnings
          });
        }
        return invalid2(`${arg} requires an operand`);
      }
      i++;
      if (arg === "-C") {
        if (value.length > 0) cwd = resolveFrom(cwd, value);
        confidence = "explicit";
        continue;
      }
      if (arg === "--config-env" && !validConfigEnv(value)) {
        return invalid2(`${arg} requires <name>=<envvar>`);
      }
      ({ gitDir, workTree, namespace, confidence } = applyGitContextOption(
        arg,
        value,
        gitDir,
        workTree,
        namespace,
        confidence
      ));
      continue;
    }
    return invalid2(`unsupported Git global option ${arg}`);
  }
  if (budgetExhausted) {
    return finishGitInvocation({
      args: [],
      cwd,
      gitDir,
      workTree,
      namespace,
      bare,
      forcedBare,
      confidence,
      pathspecFlags,
      completeness: "partial",
      exitsEarly: false,
      queryOnly: false,
      budgetExhausted,
      warnings
    });
  }
  return invalid2("Git invocation has no subcommand");
}
function resolveGitReset(args, options = {}) {
  const maxArgs = positiveBudget(options.maxArgs);
  const budgetExhausted = args.length > maxArgs;
  const input = budgetExhausted ? args.slice(0, maxArgs) : args;
  const warnings = [];
  let completeness = budgetExhausted ? "partial" : "complete";
  if (budgetExhausted) warnings.push(`git reset resolution stopped after ${maxArgs} arguments`);
  let selectedMode;
  let patchMode = false;
  let pathspecFile;
  let pathspecFileNul = false;
  let intentToAdd = false;
  let recurseSubmodules = "configured";
  let unified = false;
  let interHunkContext = false;
  let autoAdvance = true;
  const beforeDash = [];
  let afterDash = null;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (afterDash !== null) {
      afterDash.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDash = [];
      continue;
    }
    if (arg === "-h" || arg === "--help" || arg === "--help-all") {
      return nonExecutingReset("mixed", warnings, budgetExhausted);
    }
    const longOption = arg.startsWith("--") ? resolveResetLongOption(arg) : null;
    if (longOption?.kind === "ambiguous") {
      return invalidReset(warnings, budgetExhausted, `ambiguous git reset option ${longOption.option}`);
    }
    if (longOption?.kind === "resolved") {
      const { name, attached, value } = longOption;
      const rejectValue = () => attached ? invalidReset(warnings, budgetExhausted, `--${name} takes no value`) : null;
      if (name === "mixed" || name === "soft" || name === "hard" || name === "merge" || name === "keep") {
        const rejected = rejectValue();
        if (rejected) return rejected;
        selectedMode = name;
        continue;
      }
      if (name === "patch" || name === "no-patch") {
        const rejected = rejectValue();
        if (rejected) return rejected;
        patchMode = name === "patch";
        continue;
      }
      if (name === "quiet" || name === "no-quiet" || name === "refresh" || name === "no-refresh") {
        const rejected = rejectValue();
        if (rejected) return rejected;
        continue;
      }
      if (name === "intent-to-add" || name === "no-intent-to-add") {
        const rejected = rejectValue();
        if (rejected) return rejected;
        intentToAdd = name === "intent-to-add";
        continue;
      }
      if (name === "pathspec-file-nul" || name === "no-pathspec-file-nul") {
        const rejected = rejectValue();
        if (rejected) return rejected;
        pathspecFileNul = name === "pathspec-file-nul";
        continue;
      }
      if (name === "recurse-submodules" || name === "no-recurse-submodules") {
        if (name === "no-recurse-submodules") {
          const rejected = rejectValue();
          if (rejected) return rejected;
          recurseSubmodules = false;
          continue;
        }
        if (!attached) {
          recurseSubmodules = true;
          continue;
        }
        const parsed = parseGitBoolean(value ?? "");
        if (parsed === null) {
          return invalidReset(warnings, budgetExhausted, `bad --recurse-submodules argument ${value ?? ""}`);
        }
        recurseSubmodules = parsed;
        continue;
      }
      if (name === "auto-advance" || name === "no-auto-advance") {
        const rejected = rejectValue();
        if (rejected) return rejected;
        autoAdvance = name === "auto-advance";
        continue;
      }
      if (name === "pathspec-from-file" || name === "no-pathspec-from-file") {
        if (name === "no-pathspec-from-file") {
          const rejected = rejectValue();
          if (rejected) return rejected;
          pathspecFile = void 0;
          continue;
        }
        let operand = value;
        if (!attached) {
          operand = input[i + 1];
          if (operand === void 0) {
            return missingResetOperand(warnings, budgetExhausted, "--pathspec-from-file");
          }
          i++;
        }
        pathspecFile = operand === "" ? void 0 : operand;
        continue;
      }
      if (name === "unified" || name === "inter-hunk-context") {
        let operand = value;
        if (!attached) {
          operand = input[i + 1];
          if (operand === void 0) return missingResetOperand(warnings, budgetExhausted, `--${name}`);
          i++;
        }
        if (!validResetContextInteger(operand ?? "")) {
          return invalidReset(warnings, budgetExhausted, `--${name} requires an integer greater than or equal to -1`);
        }
        if (name === "unified") unified = true;
        else interHunkContext = true;
        continue;
      }
    }
    if (arg === "-p") {
      patchMode = true;
      continue;
    }
    if (arg === "-q") continue;
    if (arg === "-N") {
      intentToAdd = true;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
      let consumedCluster = true;
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "q") continue;
        if (flag === "p") {
          patchMode = true;
          continue;
        }
        if (flag === "N") {
          intentToAdd = true;
          continue;
        }
        if (flag === "U") {
          let value = arg.slice(j + 1);
          if (value.length === 0) {
            const operand = input[i + 1];
            if (operand === void 0) return missingResetOperand(warnings, budgetExhausted, "-U");
            value = operand;
            i++;
          }
          if (!validResetContextInteger(value)) {
            return invalidReset(warnings, budgetExhausted, "-U requires an integer greater than or equal to -1");
          }
          unified = true;
          j = arg.length;
          continue;
        }
        consumedCluster = false;
        break;
      }
      if (consumedCluster) continue;
      return invalidReset(warnings, budgetExhausted, `unsupported git reset option ${arg}`);
    }
    if (arg === "-U") {
      const operand = input[i + 1];
      if (operand === void 0) return missingResetOperand(warnings, budgetExhausted, "-U");
      if (!validResetContextInteger(operand)) {
        return invalidReset(warnings, budgetExhausted, "-U requires an integer greater than or equal to -1");
      }
      unified = true;
      i++;
      continue;
    }
    if (arg.startsWith("-")) return invalidReset(warnings, budgetExhausted, `unsupported git reset option ${arg}`);
    beforeDash.push(arg);
  }
  if (budgetExhausted) completeness = "partial";
  if (pathspecFileNul && pathspecFile === void 0) {
    return invalidReset(warnings, budgetExhausted, "--pathspec-file-nul requires --pathspec-from-file");
  }
  if (patchMode && selectedMode !== void 0) {
    return invalidReset(warnings, budgetExhausted, "--patch cannot be combined with a reset mode");
  }
  if (patchMode && pathspecFile !== void 0) {
    return invalidReset(warnings, budgetExhausted, "--patch cannot be combined with --pathspec-from-file");
  }
  if (!patchMode && (unified || interHunkContext || !autoAdvance)) {
    return invalidReset(warnings, budgetExhausted, "interactive diff options require --patch");
  }
  const positional = resolveResetPositionals(beforeDash, afterDash);
  if (positional.invalid) return invalidReset(warnings, budgetExhausted, positional.warning);
  if (positional.ambiguous) {
    completeness = "partial";
    warnings.push("git reset target is ambiguous between a revision and a path without repository state");
  }
  if (pathspecFile !== void 0 && positional.pathspecs.length > 0) {
    return invalidReset(warnings, budgetExhausted, "--pathspec-from-file cannot be combined with command-line pathspecs");
  }
  const mode = patchMode ? "patch" : selectedMode ?? "mixed";
  if (!patchMode && intentToAdd && mode !== "mixed") return invalidReset(warnings, budgetExhausted, "-N requires --mixed");
  const hasKnownPathspec = positional.pathspecs.length > 0;
  if (hasKnownPathspec && mode !== "mixed" && mode !== "patch") {
    return invalidReset(warnings, budgetExhausted, `--${mode} cannot be combined with pathspecs`);
  }
  let form;
  let selection;
  let updatesHead;
  if (patchMode) {
    form = "patch";
    selection = positional.ambiguous ? { kind: "unknown" } : hasKnownPathspec ? { kind: "pathspecs", pathspecs: positional.pathspecs } : { kind: "all" };
    updatesHead = false;
  } else if (pathspecFile !== void 0) {
    form = "pathspec-file";
    selection = { kind: "pathspec-file", pathspecFile };
    updatesHead = "conditional";
    completeness = "partial";
  } else if (positional.ambiguous) {
    form = "ambiguous";
    selection = { kind: "unknown" };
    updatesHead = "conditional";
  } else if (hasKnownPathspec) {
    form = "pathspec";
    selection = { kind: "pathspecs", pathspecs: positional.pathspecs };
    updatesHead = false;
  } else {
    form = "mode";
    selection = { kind: "all" };
    updatesHead = true;
  }
  return {
    mode,
    form,
    target: positional.target,
    selection,
    updatesHead,
    recurseSubmodules,
    completeness,
    exitsEarly: false,
    budgetExhausted,
    warnings
  };
}
function resolveGitClean(args, options = {}) {
  const maxArgs = positiveBudget(options.maxArgs);
  const budgetExhausted = args.length > maxArgs;
  const input = budgetExhausted ? args.slice(0, maxArgs) : args;
  const warnings = [];
  if (budgetExhausted) warnings.push(`git clean resolution stopped after ${maxArgs} arguments`);
  let dryRun = false;
  let force = 0;
  let interactive = false;
  let removeDirectories = false;
  let includeIgnored = false;
  let ignoredOnly = false;
  const pathspecs = [];
  let positional = false;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (positional) {
      pathspecs.push(arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    if (arg === "-h" || arg === "--help" || arg === "--help-all") {
      return nonExecutingClean(warnings, budgetExhausted);
    }
    if (arg.startsWith("--")) {
      const resolved = resolveCleanLongOption(arg);
      if (resolved?.kind === "ambiguous") {
        return invalidClean(warnings, budgetExhausted, `ambiguous git clean option ${resolved.option}`);
      }
      if (!resolved) return invalidClean(warnings, budgetExhausted, `unsupported git clean option ${arg}`);
      const { name, attached } = resolved;
      if (name === "exclude") {
        if (!attached) {
          if (input[i + 1] === void 0) return missingCleanOperand(warnings, budgetExhausted, "--exclude");
          i++;
        }
        continue;
      }
      if (attached) return invalidClean(warnings, budgetExhausted, `--${name} takes no value`);
      if (name === "dry-run" || name === "no-dry-run") dryRun = name === "dry-run";
      else if (name === "force") force++;
      else if (name === "no-force") force = 0;
      else if (name === "interactive" || name === "no-interactive") interactive = name === "interactive";
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const flag = cluster[j];
        if (flag === "q") continue;
        if (flag === "n") {
          dryRun = true;
          continue;
        }
        if (flag === "f") {
          force++;
          continue;
        }
        if (flag === "i") {
          interactive = true;
          continue;
        }
        if (flag === "d") {
          removeDirectories = true;
          continue;
        }
        if (flag === "x") {
          includeIgnored = true;
          continue;
        }
        if (flag === "X") {
          ignoredOnly = true;
          continue;
        }
        if (flag === "e") {
          const attached = cluster.slice(j + 1);
          if (!attached) {
            if (input[i + 1] === void 0) return missingCleanOperand(warnings, budgetExhausted, "-e");
            i++;
          }
          j = cluster.length;
          continue;
        }
        return invalidClean(warnings, budgetExhausted, `unsupported git clean option -${flag}`);
      }
      continue;
    }
    pathspecs.push(arg);
  }
  if (includeIgnored && ignoredOnly) {
    return invalidClean(warnings, budgetExhausted, "-x and -X cannot be used together");
  }
  const completeness = budgetExhausted ? "partial" : "complete";
  const selection = budgetExhausted ? { kind: "unknown" } : pathspecs.length > 0 ? { kind: "pathspecs", pathspecs } : { kind: "all" };
  return {
    dryRun,
    force,
    interactive,
    removeDirectories: removeDirectories || pathspecs.length > 0,
    ignoredMode: ignoredOnly ? "ignored-only" : includeIgnored ? "include-ignored" : "standard",
    selection,
    completeness,
    exitsEarly: false,
    budgetExhausted,
    warnings
  };
}
function finishGitInvocation(input) {
  return {
    subcommand: input.subcommand,
    args: input.args,
    context: {
      cwd: input.cwd,
      gitDir: input.gitDir === void 0 ? void 0 : resolveFrom(input.cwd, input.gitDir),
      workTree: input.workTree === void 0 ? void 0 : resolveFrom(input.cwd, input.workTree),
      namespace: input.namespace,
      bare: input.bare,
      forcedBare: input.forcedBare,
      confidence: input.confidence
    },
    pathspecFlags: [...input.pathspecFlags],
    completeness: input.completeness,
    exitsEarly: input.exitsEarly,
    queryOnly: input.queryOnly,
    budgetExhausted: input.budgetExhausted,
    warnings: [...input.warnings]
  };
}
function applyGitContextOption(name, value, gitDir, workTree, namespace, confidence) {
  if (name === "--git-dir") return { gitDir: value, workTree, namespace, confidence: "explicit" };
  if (name === "--work-tree") return { gitDir, workTree: value, namespace, confidence: "explicit" };
  if (name === "--namespace") return { gitDir, workTree, namespace: value, confidence: "explicit" };
  return { gitDir, workTree, namespace, confidence };
}
function resolveResetPositionals(beforeDash, afterDash) {
  if (afterDash !== null) {
    if (beforeDash.length > 1) {
      return { pathspecs: [], ambiguous: false, invalid: true, warning: "too many reset targets before --" };
    }
    return {
      target: beforeDash[0],
      pathspecs: [...afterDash],
      ambiguous: false,
      invalid: false
    };
  }
  if (beforeDash.length === 0) return { pathspecs: [], ambiguous: false, invalid: false };
  if (beforeDash.length === 1) {
    return { target: beforeDash[0], pathspecs: [], ambiguous: true, invalid: false };
  }
  return {
    target: beforeDash[0],
    pathspecs: beforeDash.slice(1),
    ambiguous: true,
    invalid: false
  };
}
function nonExecutingReset(mode, warnings, budgetExhausted) {
  return {
    mode,
    form: "mode",
    selection: { kind: "all" },
    updatesHead: false,
    recurseSubmodules: "configured",
    completeness: "complete",
    exitsEarly: true,
    budgetExhausted,
    warnings
  };
}
function invalidReset(warnings, budgetExhausted, warning) {
  return {
    mode: "mixed",
    form: "mode",
    selection: { kind: "unknown" },
    updatesHead: false,
    recurseSubmodules: "configured",
    completeness: "invalid",
    exitsEarly: false,
    budgetExhausted,
    warnings: [...warnings, warning]
  };
}
function partialReset(warnings, warning) {
  return {
    mode: "mixed",
    form: "ambiguous",
    selection: { kind: "unknown" },
    updatesHead: "conditional",
    recurseSubmodules: "configured",
    completeness: "partial",
    exitsEarly: false,
    budgetExhausted: true,
    warnings: [...warnings, warning]
  };
}
function missingResetOperand(warnings, budgetExhausted, option) {
  return budgetExhausted ? partialReset(warnings, `git reset argument budget ended before the operand for ${option}`) : invalidReset(warnings, false, `${option} requires an operand`);
}
function resolveResetLongOption(arg) {
  if (!arg.startsWith("--")) return null;
  const equals = arg.indexOf("=");
  const option = arg.slice(2, equals < 0 ? void 0 : equals);
  const attached = equals >= 0;
  const value = attached ? arg.slice(equals + 1) : void 0;
  const exact = RESET_LONG_OPTIONS.find((candidate) => candidate === option);
  if (exact) return { kind: "resolved", name: exact, attached, value };
  const matches = RESET_LONG_OPTIONS.filter((candidate) => candidate.startsWith(option));
  if (matches.length === 1) return { kind: "resolved", name: matches[0], attached, value };
  if (matches.length > 1) return { kind: "ambiguous", option: `--${option}` };
  return null;
}
function resolveCleanLongOption(arg) {
  if (!arg.startsWith("--")) return null;
  const equals = arg.indexOf("=");
  const option = arg.slice(2, equals < 0 ? void 0 : equals);
  const attached = equals >= 0;
  const value = attached ? arg.slice(equals + 1) : void 0;
  const exact = CLEAN_LONG_OPTIONS.find((candidate) => candidate === option);
  if (exact) return { kind: "resolved", name: exact, attached, value };
  const matches = CLEAN_LONG_OPTIONS.filter((candidate) => candidate.startsWith(option));
  if (matches.length === 1) return { kind: "resolved", name: matches[0], attached, value };
  if (matches.length > 1) return { kind: "ambiguous", option: `--${option}` };
  return null;
}
function nonExecutingClean(warnings, budgetExhausted) {
  return {
    dryRun: true,
    force: 0,
    interactive: false,
    removeDirectories: false,
    ignoredMode: "standard",
    selection: { kind: "all" },
    completeness: "complete",
    exitsEarly: true,
    budgetExhausted,
    warnings
  };
}
function invalidClean(warnings, budgetExhausted, warning) {
  return {
    dryRun: false,
    force: 0,
    interactive: false,
    removeDirectories: false,
    ignoredMode: "standard",
    selection: { kind: "unknown" },
    completeness: "invalid",
    exitsEarly: false,
    budgetExhausted,
    warnings: [...warnings, warning]
  };
}
function partialClean(warnings, warning) {
  return {
    dryRun: false,
    force: 0,
    interactive: false,
    removeDirectories: false,
    ignoredMode: "standard",
    selection: { kind: "unknown" },
    completeness: "partial",
    exitsEarly: false,
    budgetExhausted: true,
    warnings: [...warnings, warning]
  };
}
function missingCleanOperand(warnings, budgetExhausted, option) {
  return budgetExhausted ? partialClean(warnings, `git clean argument budget ended before the operand for ${option}`) : invalidClean(warnings, false, `${option} requires an operand`);
}
function attachedLongOption(arg) {
  if (!arg.startsWith("--")) return null;
  const equals = arg.indexOf("=");
  if (equals < 0) return null;
  return { name: arg.slice(0, equals), value: arg.slice(equals + 1) };
}
function validConfigEnv(value) {
  const equals = value.indexOf("=");
  return equals > 0 && equals < value.length - 1;
}
function parseGitBoolean(value) {
  const normalized = value.toLowerCase();
  if (normalized === "" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  if (normalized === "true" || normalized === "yes" || normalized === "on") return true;
  const numeric = parseGitInt(value);
  return numeric === null ? null : numeric !== 0;
}
function validResetContextInteger(value) {
  const parsed = parseGitInt(value);
  return parsed !== null && parsed >= -1;
}
function parseGitInt(value) {
  const match = /^([+-]?[0-9]+)([kmg])?$/iu.exec(value);
  if (!match) return null;
  const factor = match[2] === void 0 ? 1 : match[2].toLowerCase() === "k" ? 1024 : match[2].toLowerCase() === "m" ? 1024 * 1024 : 1024 * 1024 * 1024;
  const parsed = Number(match[1]) * factor;
  return Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : null;
}
function positiveBudget(value) {
  return value !== void 0 && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_GIT_ARGS;
}
function normalizeCwd(cwd) {
  return import_node_path3.posix.normalize(toPosix(cwd));
}
function resolveFrom(cwd, value) {
  const normalized = toPosix(value);
  return import_node_path3.posix.normalize(isAbsolutePath(value) ? normalized : import_node_path3.posix.join(cwd, normalized));
}

// src/git/effects.ts
function analyzeGitArgs(args, options) {
  const invocation = resolveGitInvocation(args, {
    cwd: options.cwd,
    env: options.env,
    maxArgs: options.maxArgs
  });
  const warnings = [...invocation.warnings];
  if (invocation.completeness === "invalid" || invocation.exitsEarly || invocation.queryOnly) {
    return { effects: [], resourceEffects: [], warnings, invocation };
  }
  if (invocation.subcommand === "clean") {
    const clean = resolveGitClean(invocation.args, { maxArgs: options.maxArgs });
    warnings.push(...clean.warnings);
    if (clean.completeness === "invalid" || clean.exitsEarly) {
      return { effects: [], resourceEffects: [], warnings, invocation, clean };
    }
    if (invocation.context.forcedBare && invocation.context.workTree === void 0) {
      warnings.push("git clean cannot update a known bare repository without a worktree");
      return { effects: [], resourceEffects: [], warnings, invocation, clean };
    }
    if (clean.dryRun && invocation.completeness === "complete" && clean.completeness === "complete") {
      return { effects: [], resourceEffects: [], warnings, invocation, clean };
    }
    return {
      effects: [],
      resourceEffects: [cleanResourceEffect(invocation, clean, options)],
      warnings,
      invocation,
      clean
    };
  }
  if (invocation.subcommand !== "reset") {
    return { effects: [], resourceEffects: [], warnings, invocation };
  }
  const reset = resolveGitReset(invocation.args, { maxArgs: options.maxArgs });
  warnings.push(...reset.warnings);
  if (reset.completeness === "invalid" || reset.exitsEarly) {
    return { effects: [], resourceEffects: [], warnings, invocation, reset };
  }
  if (invocation.context.forcedBare && invocation.context.workTree === void 0 && reset.mode !== "soft" && reset.mode !== "patch") {
    warnings.push(`git reset --${reset.mode} cannot update a known bare repository without a worktree`);
    return { effects: [], resourceEffects: [], warnings, invocation, reset };
  }
  if (invocation.budgetExhausted || reset.budgetExhausted) {
    return {
      effects: [makeEffect(invocation, reset, options, {
        domain: "worktree",
        operation: "discard",
        mode: "unknown",
        recoverability: "unknown",
        executionMode: "conditional",
        uncertainty: ["argument-budget", "unknown-repository-state"],
        completeness: "partial"
      })],
      resourceEffects: [],
      warnings,
      invocation,
      reset
    };
  }
  return {
    effects: resetEffects(invocation, reset, options),
    resourceEffects: [],
    warnings,
    invocation,
    reset
  };
}
function cleanResourceEffect(invocation, clean, options) {
  const completeness = invocation.completeness === "partial" || clean.completeness === "partial" ? "partial" : "complete";
  const executionMode = clean.interactive ? "interactive" : clean.force > 0 ? "definite" : "config-dependent";
  const uncertainty = ["derived-selection"];
  if (executionMode === "config-dependent") uncertainty.push("configuration-dependent");
  if (completeness === "partial" || clean.selection.kind === "unknown") uncertainty.push("unknown-selection");
  const pathspecs = clean.selection.kind === "pathspecs" ? clean.selection.pathspecs ?? [] : [];
  return {
    domain: "git-worktree",
    operation: "delete",
    command: "git clean",
    selection: {
      kind: clean.selection.kind === "unknown" ? "unknown" : "derived",
      root: invocation.context.workTree ?? invocation.context.cwd,
      target: pathspecs.length === 1 ? pathspecs[0] : void 0
    },
    executionMode,
    recoverability: "none",
    completeness,
    privileged: options.privileged,
    line: options.line,
    uncertain: true,
    certainty: "unknown",
    uncertainty
  };
}
function resetEffects(invocation, reset, options) {
  const effects = [];
  const uncertainty = resetUncertainty(reset);
  const completeness = invocation.completeness === "partial" || reset.completeness === "partial" ? "partial" : "complete";
  const conditional = completeness === "partial" || reset.form === "ambiguous" || reset.form === "pathspec-file";
  const add = (domain, operation, recoverability, executionMode = conditional ? "conditional" : "definite") => {
    effects.push(makeEffect(invocation, reset, options, {
      domain,
      operation,
      mode: reset.mode,
      recoverability,
      executionMode,
      uncertainty,
      completeness
    }));
  };
  if (reset.mode === "patch") {
    add("index", "replace", "worktree-preserved", "interactive");
    return effects;
  }
  if (reset.mode === "soft") {
    if (reset.updatesHead !== false) add("local-ref", "rewrite", "reflog-or-orig-head");
    return effects;
  }
  if (reset.mode === "mixed") {
    add("index", "replace", "worktree-preserved");
    if (reset.updatesHead !== false) add("local-ref", "rewrite", "reflog-or-orig-head");
    return effects;
  }
  add("index", "replace", reset.mode === "keep" ? "worktree-preserved" : "unknown");
  add(
    "worktree",
    reset.mode === "hard" ? "discard" : "replace",
    reset.mode === "keep" ? "worktree-preserved" : "unknown",
    "conditional"
  );
  if (reset.updatesHead !== false) add("local-ref", "rewrite", "reflog-or-orig-head");
  if (reset.recurseSubmodules === true) add("submodule", "reset", "unknown", "conditional");
  return effects;
}
function makeEffect(invocation, reset, options, fields) {
  const uncertain = fields.executionMode !== "definite" || fields.completeness === "partial" || fields.uncertainty.length > 0;
  return {
    command: "git reset",
    domain: fields.domain,
    operation: fields.operation,
    mode: fields.mode,
    selection: {
      ...reset.selection,
      pathspecs: reset.selection.pathspecs ? [...reset.selection.pathspecs] : void 0
    },
    target: reset.target,
    repository: { ...invocation.context },
    recoverability: fields.recoverability,
    executionMode: fields.executionMode,
    completeness: fields.completeness,
    recurseSubmodules: reset.recurseSubmodules,
    privileged: options.privileged,
    line: options.line,
    uncertain,
    certainty: uncertain ? "unknown" : "exact",
    uncertainty: [...fields.uncertainty]
  };
}
function resetUncertainty(reset) {
  const reasons = [];
  if (reset.form === "ambiguous") reasons.push("ambiguous-revision-or-path");
  if (reset.form === "pathspec-file") reasons.push("pathspec-file-contents");
  if (isWorktreeMode(reset.mode)) reasons.push("unknown-repository-state");
  return reasons;
}
function isWorktreeMode(mode) {
  return mode === "hard" || mode === "merge" || mode === "keep";
}

// src/bash/commands.ts
function parseFlags(args, knownFlags) {
  const flags = /* @__PURE__ */ new Set();
  const rest = [];
  let positional = false;
  for (const arg of args) {
    if (positional) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      for (let i = 1; i < arg.length; i++) {
        if (knownFlags.includes(arg[i])) flags.add(arg[i]);
      }
      continue;
    }
    if (arg.startsWith("--")) continue;
    rest.push(arg);
  }
  return { flags, rest };
}
function addCommandSpec(spec) {
  return [
    spec.name,
    (args, tracker, line, context) => spec.apply(parseFlags(args, spec.knownFlags), args, tracker, line, context)
  ];
}
function destinationForSource(dest, source, tracker) {
  const resolvedDest = tracker.resolvePath(dest);
  if (dest.endsWith("/") || tracker.vfs?.isDirectory(resolvedDest)) {
    return import_node_path4.posix.join(dest, import_node_path4.posix.basename(source));
  }
  return dest;
}
var COMMAND_SPECS = [
  {
    name: "rm",
    knownFlags: "rRfid",
    apply({ flags, rest }, rawArgs, tracker, line) {
      const recursive = flags.has("r") || flags.has("R") || rawArgs.includes("--recursive");
      const dirFlag = flags.has("d") || rawArgs.includes("--dir");
      for (const p of rest) {
        if (p.length === 0) {
          tracker.addWarning(`rm: cannot remove an empty path (line ${line})`);
          continue;
        }
        if (!recursive && !dirFlag && tracker.vfs) {
          const resolved = tracker.resolvePath(p);
          if (tracker.vfs.isDirectory(resolved)) {
            tracker.addWarning(`rm: cannot remove '${p}': Is a directory (line ${line})`);
            continue;
          }
        }
        tracker.add({ type: "delete", path: p, line, command: "rm", uncertain: false });
      }
    }
  },
  {
    name: "rmdir",
    knownFlags: "p",
    apply({ rest }, _rawArgs, tracker, line) {
      for (const p of rest) {
        if (tracker.vfs) {
          const resolved = tracker.resolvePath(p);
          if (!tracker.vfs.exists(resolved)) {
            tracker.addWarning(`rmdir: failed to remove '${p}': No such directory (line ${line})`);
            continue;
          }
          if (!p.endsWith("/") && tracker.vfs.isSymbolicLink(resolved)) {
            tracker.addWarning(`rmdir: failed to remove '${p}': Not a directory (line ${line})`);
            continue;
          }
          if (!tracker.vfs.isDirectory(resolved)) {
            tracker.addWarning(`rmdir: failed to remove '${p}': Not a directory (line ${line})`);
            continue;
          }
          if (tracker.vfs.readdir(resolved).length > 0) {
            tracker.addWarning(`rmdir: failed to remove '${p}': Directory not empty (line ${line})`);
            continue;
          }
        }
        tracker.add({ type: "delete", path: p, line, command: "rmdir", uncertain: false });
      }
    }
  },
  {
    name: "mkdir",
    knownFlags: "pm",
    apply({ rest }, _rawArgs, tracker, line) {
      for (const p of rest) tracker.add({ type: "mkdir", path: p, line, command: "mkdir", uncertain: false });
    }
  },
  {
    name: "cp",
    knownFlags: "rRfailpTun",
    apply({ rest }, rawArgs, tracker, line) {
      if (rest.length < 2) return;
      const dest = rest[rest.length - 1];
      const replacement = replacementBehavior2(rawArgs, "cp");
      for (let i = 0; i < rest.length - 1; i++) {
        tracker.add({
          type: "copy",
          path: destinationForSource(dest, rest[i], tracker),
          source: rest[i],
          line,
          command: "cp",
          replacement,
          uncertain: false
        });
      }
    }
  },
  {
    name: "mv",
    knownFlags: "fiTnu",
    apply({ rest }, rawArgs, tracker, line) {
      if (rest.length < 2) return;
      const dest = rest[rest.length - 1];
      const replacement = replacementBehavior2(rawArgs, "mv");
      for (let i = 0; i < rest.length - 1; i++) {
        tracker.add({
          type: "move",
          path: destinationForSource(dest, rest[i], tracker),
          source: rest[i],
          line,
          command: "mv",
          replacement,
          uncertain: false
        });
      }
    }
  },
  {
    name: "tee",
    knownFlags: "ai",
    apply({ flags, rest }, _rawArgs, tracker, line) {
      const effectType = flags.has("a") ? "append" : "write";
      for (const p of rest) tracker.add({ type: effectType, path: p, line, command: "tee", uncertain: false });
    }
  },
  {
    name: "chmod",
    knownFlags: "Rf",
    apply({ rest }, _rawArgs, tracker, line) {
      for (let i = 1; i < rest.length; i++) {
        tracker.add({ type: "chmod", path: rest[i], line, command: "chmod", uncertain: false });
      }
    }
  },
  {
    name: "chown",
    knownFlags: "Rf",
    apply({ rest }, _rawArgs, tracker, line) {
      for (let i = 1; i < rest.length; i++) {
        tracker.add({ type: "chown", path: rest[i], line, command: "chown", uncertain: false });
      }
    }
  },
  {
    name: "ln",
    knownFlags: "sfiTn",
    apply({ flags, rest }, rawArgs, tracker, line) {
      if (rest.length < 2) return;
      const replacement = linkReplacementBehavior(rawArgs);
      const dest = rest[rest.length - 1];
      const noTargetDirectory = flags.has("T") || flags.has("n") || rawArgs.includes("--no-target-directory") || rawArgs.includes("--no-dereference");
      for (let i = 0; i < rest.length - 1; i++) {
        tracker.add({
          type: "link",
          path: noTargetDirectory ? dest : destinationForSource(dest, rest[i], tracker),
          source: rest[i],
          line,
          command: "ln",
          replacement,
          uncertain: false
        });
      }
    }
  },
  {
    name: "install",
    knownFlags: "dDm",
    apply({ flags, rest }, _rawArgs, tracker, line) {
      if (flags.has("d")) {
        for (const p of rest) tracker.add({ type: "mkdir", path: p, line, command: "install", uncertain: false });
      } else if (rest.length >= 2) {
        const dest = rest[rest.length - 1];
        if (flags.has("D")) {
          tracker.add({
            type: "mkdir",
            path: import_node_path4.posix.dirname(dest),
            line,
            command: "install -D",
            uncertain: false
          });
        }
        for (let i = 0; i < rest.length - 1; i++) {
          tracker.add({
            type: "copy",
            path: destinationForSource(dest, rest[i], tracker),
            source: rest[i],
            line,
            command: "install",
            replacement: "replace",
            uncertain: false
          });
        }
      }
    }
  },
  {
    name: "sed",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      let inPlace = false;
      const files = [];
      let skipNext = false;
      for (const arg of rawArgs) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (arg === "-i" || arg.startsWith("-i")) {
          inPlace = true;
        } else if (arg === "-e" || arg === "-f") {
          skipNext = true;
        } else if (!arg.startsWith("-")) {
          files.push(arg);
        }
      }
      if (!inPlace || files.length === 0) return;
      const startIdx = files.length > 1 ? 1 : 0;
      for (let i = startIdx; i < files.length; i++) {
        tracker.add({ type: "write", path: files[i], line, command: "sed -i", uncertain: false });
      }
    }
  },
  {
    name: "dd",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      for (const arg of rawArgs) {
        if (arg.startsWith("of=")) {
          tracker.add({ type: "write", path: arg.substring(3), line, command: "dd", uncertain: false });
        }
      }
    }
  },
  {
    name: "truncate",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      for (const target of truncateTargets(rawArgs)) {
        tracker.add({
          type: "truncate",
          path: target,
          line,
          command: "truncate",
          replacement: "replace",
          uncertain: false
        });
      }
    }
  },
  {
    name: "curl",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      for (let i = 0; i < rawArgs.length; i++) {
        if ((rawArgs[i] === "-o" || rawArgs[i] === "--output") && i + 1 < rawArgs.length) {
          tracker.add({ type: "write", path: rawArgs[i + 1], line, command: "curl", uncertain: false });
          i++;
        }
      }
    }
  },
  {
    name: "wget",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      for (let i = 0; i < rawArgs.length; i++) {
        if ((rawArgs[i] === "-O" || rawArgs[i] === "--output-document") && i + 1 < rawArgs.length) {
          tracker.add({ type: "write", path: rawArgs[i + 1], line, command: "wget", uncertain: false });
          i++;
        }
      }
    }
  },
  {
    name: "rsync",
    knownFlags: "avzrhHPS",
    apply({ rest }, rawArgs, tracker, line) {
      if (commandOptionEnabled(rawArgs, "n", "--dry-run", RSYNC_SHORT_OPTIONS_WITH_VALUES, RSYNC_LONG_OPTIONS_WITH_VALUES)) return;
      if (commandOptionEnabled(rawArgs, "", "--list-only", RSYNC_SHORT_OPTIONS_WITH_VALUES, RSYNC_LONG_OPTIONS_WITH_VALUES)) return;
      const operands = rest.filter((arg) => !arg.includes("="));
      if (operands.length < 2) return;
      const dest = operands[operands.length - 1];
      for (let i = 0; i < operands.length - 1; i++) {
        tracker.add({
          type: "copy",
          path: destinationForSource(dest, operands[i], tracker),
          source: operands[i],
          line,
          command: rawArgs.includes("--delete") ? "rsync --delete" : "rsync",
          replacement: "conditional",
          uncertain: false
        });
      }
      if (rawArgs.includes("--delete")) {
        tracker.add({ type: "delete", path: dest, line, command: "rsync --delete", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
      }
      if (rawArgs.includes("--remove-source-files")) {
        for (let i = 0; i < operands.length - 1; i++) {
          tracker.add({ type: "delete", path: operands[i], line, command: "rsync --remove-source-files", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
        }
      }
      const backupDir = optionValue(rawArgs, "--backup-dir");
      if (backupDir) {
        tracker.add({ type: "mkdir", path: backupDir, line, command: "rsync --backup-dir", uncertain: false });
      }
    }
  },
  {
    name: "tar",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      const invocation = parseTarInvocation(rawArgs);
      if (invocation.operation === "extract" && !invocation.invalid && !invocation.exitsEarly && !invocation.toStdout) {
        const entries = invocation.archive ? listTarEntries(tracker.resolvePath(invocation.archive)) : [];
        if (entries.length > 0) {
          for (const entry of entries) tracker.add({ type: "write", path: import_node_path4.posix.join(invocation.dest, entry), line, command: "tar", uncertain: false });
        } else {
          tracker.add({ type: "write", path: import_node_path4.posix.join(invocation.dest, "<archive-contents>"), line, command: "tar", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
        }
      }
    }
  },
  {
    name: "unzip",
    knownFlags: "oqn",
    apply(_parsed, rawArgs, tracker, line) {
      const invocation = parseUnzipInvocation(rawArgs);
      if (invocation.invalid || invocation.nonWriting || !invocation.archive) return;
      const entries = listZipEntries(tracker.resolvePath(invocation.archive));
      if (entries.length > 0) {
        for (const entry of entries) tracker.add({ type: "write", path: import_node_path4.posix.join(invocation.dest, entry), line, command: "unzip", uncertain: false });
      } else {
        tracker.add({ type: "write", path: import_node_path4.posix.join(invocation.dest, "<archive-contents>"), line, command: "unzip", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
      }
    }
  },
  {
    name: "python",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePythonLike(rawArgs, tracker, line, "python");
    }
  },
  {
    name: "python3",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePythonLike(rawArgs, tracker, line, "python3");
    }
  },
  {
    name: "pip",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePipLike(rawArgs, tracker, line, "pip");
    }
  },
  {
    name: "pip3",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePipLike(rawArgs, tracker, line, "pip3");
    }
  },
  {
    name: "find",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseFindDeleteInvocation(rawArgs);
      if (!invocation.deletes || invocation.exitsEarly || invocation.invalid) return;
      for (const root of invocation.roots) {
        tracker.addResource({
          domain: "local-filesystem-selection",
          operation: "delete",
          command: "find -delete",
          selection: { kind: "derived", root: tracker.resolvePath(root) },
          executionMode: "definite",
          recoverability: "unknown",
          completeness: "complete",
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: "unknown",
          uncertainty: ["derived-selection"]
        });
      }
    }
  },
  {
    name: "xargs",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseXargsInvocation(rawArgs);
      if (invocation.exitsEarly || invocation.invalid || invocation.commandIndex === void 0) return;
      const childCommand = rawArgs[invocation.commandIndex];
      if (!isRmExecutable(childCommand)) return;
      const rmArgs = rawArgs.slice(invocation.commandIndex + 1);
      if (hasEarlyExitOption(rmArgs, /* @__PURE__ */ new Set(["--help", "--version"]))) return;
      const explicit = positionalOperands(rmArgs);
      if (explicit.length > 0) {
        for (const target of explicit) tracker.add({ type: "delete", path: target, line, command: "xargs rm", uncertain: false });
      }
      tracker.addResource({
        domain: "local-filesystem-selection",
        operation: "delete",
        command: "xargs rm",
        selection: { kind: "stdin", root: tracker.getCwd() },
        executionMode: rawArgs.includes("-p") || rawArgs.includes("--interactive") ? "interactive" : "conditional",
        recoverability: "unknown",
        completeness: "partial",
        privileged: context.privileged,
        line,
        uncertain: true,
        certainty: "unknown",
        uncertainty: ["stdin-selection"]
      });
    }
  },
  {
    name: "perl",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handleInPlaceScript(rawArgs, tracker, line, "perl");
    }
  },
  {
    name: "awk",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handleInPlaceScript(rawArgs, tracker, line, "awk");
    }
  },
  {
    name: "make",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseMakeInvocation(rawArgs);
      if (invocation.invalid) return;
      if (invocation.goals.some((arg) => arg === "clean" || arg.endsWith(":clean"))) {
        if (!invocation.nonExecuting) {
          tracker.addResource({
            domain: "local-filesystem-selection",
            operation: "delete",
            command: "make clean",
            selection: { kind: "derived", root: resolveMakeCwd(tracker.getCwd(), invocation.directories), target: "clean" },
            executionMode: "conditional",
            recoverability: "unknown",
            completeness: "partial",
            privileged: context.privileged,
            line,
            uncertain: true,
            certainty: "unknown",
            uncertainty: ["derived-selection"]
          });
        }
      }
      if (invocation.goals.includes("install") && !invocation.nonExecuting) {
        const destdir = assignmentArg(rawArgs, "DESTDIR") || assignmentArg(rawArgs, "PREFIX") || "/usr/local";
        tracker.add({ type: "mkdir", path: destdir, line, command: "make install", uncertain: destdir === "/usr/local" && !rawArgs.some((arg) => arg.startsWith("PREFIX=") || arg.startsWith("DESTDIR=")) });
      }
    }
  },
  {
    name: "cmake",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      const installIndex = rawArgs.indexOf("--install");
      if (installIndex < 0) return;
      const source = rawArgs[installIndex + 1] ?? ".";
      const prefix = optionValue(rawArgs, "--prefix");
      tracker.add({
        type: "copy",
        path: import_node_path4.posix.join(prefix ?? "<cmake-install-prefix>", "<install-contents>"),
        source,
        line,
        command: "cmake --install",
        replacement: "conditional",
        uncertain: true,
        certainty: "unknown",
        uncertainty: ["derived-path"]
      });
    }
  },
  {
    name: "npm",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePackageManager(rawArgs, tracker, line, "npm");
    }
  },
  {
    name: "yarn",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePackageManager(rawArgs, tracker, line, "yarn");
    }
  },
  {
    name: "pnpm",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line) {
      handlePackageManager(rawArgs, tracker, line, "pnpm");
    }
  },
  {
    name: "git",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      const analyzed = analyzeGitArgs(rawArgs, {
        cwd: tracker.getCwd(),
        env: context.env,
        privileged: context.privileged,
        line
      });
      for (const warning of analyzed.warnings) tracker.addWarning(`${warning} (line ${line})`);
      for (const effect of analyzed.effects) tracker.addGit(effect);
      for (const effect of analyzed.resourceEffects) tracker.addResource(effect);
      const invocation = analyzed.invocation;
      if (invocation.completeness === "invalid" || invocation.exitsEarly || invocation.queryOnly || !invocation.subcommand) return;
      const commandArgs = invocation.args;
      if (invocation.subcommand === "reset") return;
      if (invocation.subcommand === "clean") return;
      if ((invocation.subcommand === "checkout" || invocation.subcommand === "restore") && commandArgs.includes("--")) {
        const sep = commandArgs.indexOf("--");
        for (const target of commandArgs.slice(sep + 1)) {
          tracker.add({ type: "write", path: target, line, command: `git ${invocation.subcommand}`, uncertain: false });
        }
        return;
      }
      if (invocation.subcommand !== "clone") return;
      const rest = commandArgs.filter((arg) => !arg.startsWith("-"));
      if (rest.length >= 2) {
        tracker.add({ type: "mkdir", path: rest[rest.length - 1], line, command: "git clone", uncertain: false });
      } else if (rest.length === 1) {
        const url = rest[0];
        const base = url.split("/").pop()?.replace(/\.git$/, "") || url;
        tracker.add({ type: "mkdir", path: base, line, command: "git clone", uncertain: true, uncertainty: ["derived-path"] });
      }
    }
  },
  {
    name: "docker",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      if (isDockerComposeVolumeRemoval(rawArgs)) {
        tracker.addResource({
          domain: "docker-volume",
          operation: "delete",
          command: "docker compose down -v",
          selection: { kind: "unknown" },
          executionMode: "definite",
          recoverability: "unknown",
          completeness: "partial",
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: "unknown",
          uncertainty: ["unknown-selection", "external-resource-state"]
        });
      }
      if (rawArgs[0] === "run") {
        for (const mount of dockerBindMounts(rawArgs.slice(1), tracker)) {
          if (mount.readOnly) continue;
          tracker.addResource({
            domain: "container-bind-mount",
            operation: "expose",
            command: "docker run bind mount",
            selection: { kind: "named", root: mount.hostPath },
            executionMode: "config-dependent",
            recoverability: "domain-dependent",
            completeness: "complete",
            privileged: context.privileged,
            line,
            uncertain: true,
            certainty: "unknown",
            uncertainty: ["configuration-dependent", "external-resource-state"]
          });
        }
      }
    }
  },
  {
    name: "kubectl",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      const located = findSubcommand(rawArgs, KUBECTL_GLOBAL_OPTIONS_WITH_VALUES);
      if (!located) return;
      if (located.name !== "delete" && located.name !== "apply") return;
      const commandArgs = rawArgs.slice(located.index + 1);
      const mode = parseKubectlInvocationMode(commandArgs, located.name);
      if (mode.invalid || mode.exitsEarly || isNonWritingKubectlDryRun(mode.dryRun)) return;
      if (located.name === "delete") {
        tracker.addResource({
          domain: "kubernetes",
          operation: "delete",
          command: "kubectl delete",
          selection: { kind: "unknown" },
          executionMode: "definite",
          recoverability: "domain-dependent",
          completeness: "partial",
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: "unknown",
          uncertainty: ["unknown-selection", "external-resource-state"]
        });
      } else if (located.name === "apply") {
        tracker.add({ type: "write", path: "<kubernetes-resources>", line, command: "kubectl apply", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
      }
    }
  },
  {
    name: "helm",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      const invocation = parseHelmUninstallInvocation(rawArgs);
      if (invocation && !invocation.exitsEarly && !invocation.invalid) {
        const release = invocation.releases.length === 1 ? invocation.releases[0] : void 0;
        tracker.addResource({
          domain: "helm",
          operation: "uninstall",
          command: "helm uninstall",
          selection: { kind: "named", target: release },
          executionMode: "definite",
          recoverability: "domain-dependent",
          completeness: "complete",
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: "unknown",
          uncertainty: ["external-resource-state"]
        });
      } else if (!invocation && rawArgs[0] === "upgrade" && rawArgs.includes("--install")) {
        tracker.add({ type: "write", path: "<helm-release>", line, command: "helm upgrade --install", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
      }
    }
  },
  {
    name: "terraform",
    knownFlags: "",
    apply(_parsed, rawArgs, tracker, line, context) {
      if (rawArgs[0] === "destroy") {
        if (rawArgs.includes("-help") || rawArgs.includes("--help")) return;
        tracker.addResource({
          domain: "terraform",
          operation: "destroy",
          command: "terraform destroy",
          selection: { kind: "unknown" },
          executionMode: "definite",
          recoverability: "domain-dependent",
          completeness: "partial",
          privileged: context.privileged,
          line,
          uncertain: true,
          certainty: "unknown",
          uncertainty: ["unknown-selection", "external-resource-state"]
        });
      } else if (rawArgs[0] === "apply") {
        tracker.add({ type: "write", path: "<terraform-managed-resources>", line, command: "terraform apply", uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
      }
    }
  }
];
function handlePythonLike(rawArgs, tracker, line, command) {
  if (rawArgs[0] !== "-m" || rawArgs[1] !== "pip" || rawArgs[2] !== "install") return;
  handlePipLike(rawArgs.slice(2), tracker, line, `${command} -m pip`);
}
function handlePipLike(rawArgs, tracker, line, command) {
  if (rawArgs[0] !== "install") return;
  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if ((arg === "--target" || arg === "-t" || arg === "--prefix") && i + 1 < rawArgs.length) {
      tracker.add({ type: "mkdir", path: rawArgs[i + 1], line, command: `${command} install`, uncertain: false });
      i++;
    }
  }
}
function handleInPlaceScript(rawArgs, tracker, line, command) {
  const inPlace = rawArgs.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "-pi" || arg.startsWith("-pi"));
  if (!inPlace) return;
  const files = rawArgs.filter((arg) => !arg.startsWith("-") && !arg.includes("{") && !arg.includes("$"));
  const start = files.length > 1 ? 1 : 0;
  for (let i = start; i < files.length; i++) {
    tracker.add({ type: "write", path: files[i], line, command: `${command} -i`, uncertain: false });
  }
}
function handlePackageManager(rawArgs, tracker, line, command) {
  const installLike = rawArgs.length === 0 || rawArgs[0] === "install" || rawArgs[0] === "i" || rawArgs[0] === "add";
  if (!installLike) return;
  tracker.add({ type: "mkdir", path: "node_modules", line, command: `${command} install`, uncertain: false });
}
function replacementBehavior2(rawArgs, command) {
  let behavior = "replace";
  let update = false;
  for (const arg of rawArgs) {
    if (arg === "--") break;
    if (arg === "--no-clobber") {
      behavior = "no-clobber";
      continue;
    }
    if (arg === "--interactive") {
      behavior = "conditional";
      continue;
    }
    if (arg === "--force") {
      if (command === "mv") behavior = "replace";
      continue;
    }
    if (arg === "--update" || arg.startsWith("--update=")) {
      const mode = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "older";
      if (mode === "none" || mode === "none-fail") behavior = "no-clobber";
      else if (mode !== "all") update = true;
      continue;
    }
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    for (const flag of arg.slice(1)) {
      if (flag === "n") behavior = "no-clobber";
      else if (flag === "i") behavior = "conditional";
      else if (flag === "f" && command === "mv") behavior = "replace";
      else if (flag === "u") update = true;
    }
  }
  return update && behavior === "replace" ? "conditional" : behavior;
}
function linkReplacementBehavior(rawArgs) {
  let behavior = "no-clobber";
  for (const arg of rawArgs) {
    if (arg === "--") break;
    if (arg === "--force" || arg === "--backup" || arg.startsWith("--backup=")) {
      behavior = "replace";
      continue;
    }
    if (arg === "--interactive") {
      behavior = "conditional";
      continue;
    }
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    for (const flag of arg.slice(1)) {
      if (flag === "f" || flag === "b") behavior = "replace";
      else if (flag === "i") behavior = "conditional";
    }
  }
  return behavior;
}
function truncateTargets(args) {
  if (args.includes("--help") || args.includes("--version")) return [];
  const targets = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) {
      targets.push(arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    if (arg === "--size" || arg === "--reference" || arg === "-s" || arg === "-r") {
      i++;
      continue;
    }
    if (arg.startsWith("--size=") || arg.startsWith("--reference=")) continue;
    if (/^-[sr].+/.test(arg)) continue;
    if (arg.startsWith("-")) continue;
    targets.push(arg);
  }
  return targets;
}
function dockerBindMounts(args, tracker) {
  const mounts = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-v" || arg === "--volume") && args[i + 1]) {
      const mount = parseDockerVolumeSpec(args[++i], tracker);
      if (mount) mounts.push(mount);
      continue;
    }
    if (arg.startsWith("--volume=")) {
      const mount = parseDockerVolumeSpec(arg.slice("--volume=".length), tracker);
      if (mount) mounts.push(mount);
      continue;
    }
    if (arg === "--mount" && args[i + 1]) {
      const mount = parseDockerMountSpec(args[++i], tracker);
      if (mount) mounts.push(mount);
      continue;
    }
    if (arg.startsWith("--mount=")) {
      const mount = parseDockerMountSpec(arg.slice("--mount=".length), tracker);
      if (mount) mounts.push(mount);
    }
  }
  return mounts;
}
function parseDockerVolumeSpec(spec, tracker) {
  const separator = /^[A-Za-z]:[\\/]/.test(spec) ? spec.indexOf(":", 2) : spec.indexOf(":");
  if (separator <= 0) return null;
  const source = spec.slice(0, separator);
  if (!isDockerHostPath(source)) return null;
  const destinationAndOptions = spec.slice(separator + 1);
  const finalSeparator = destinationAndOptions.lastIndexOf(":");
  const options = finalSeparator < 0 ? "" : destinationAndOptions.slice(finalSeparator + 1);
  return {
    hostPath: tracker.resolvePath(source),
    readOnly: dockerMountOptionsReadOnly(options)
  };
}
function parseDockerMountSpec(spec, tracker) {
  const fields = spec.split(",");
  const values = /* @__PURE__ */ new Map();
  const switches = /* @__PURE__ */ new Set();
  for (const field of fields) {
    const equals = field.indexOf("=");
    if (equals < 0) switches.add(field.toLowerCase());
    else values.set(field.slice(0, equals).toLowerCase(), field.slice(equals + 1));
  }
  if ((values.get("type") ?? "").toLowerCase() !== "bind") return null;
  const source = values.get("source") ?? values.get("src");
  if (!source || !isDockerHostPath(source)) return null;
  return {
    hostPath: tracker.resolvePath(source),
    readOnly: switches.has("readonly") || switches.has("ro")
  };
}
function isDockerHostPath(source) {
  return isAbsolutePath(source) || source === "." || source === ".." || source.startsWith("./") || source.startsWith("../") || source.includes("/") || source.includes("\\");
}
function dockerMountOptionsReadOnly(options) {
  return options.split(",").some((option) => option.toLowerCase() === "ro" || option.toLowerCase() === "readonly");
}
function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1];
    if (arg.startsWith(name + "=")) return arg.slice(name.length + 1);
  }
  return void 0;
}
function commandOptionEnabled(args, shortName, longName, shortOptionsWithValues, longOptionsWithValues) {
  let enabled = false;
  for (let argIndex = 0; argIndex < args.length; argIndex++) {
    const arg = args[argIndex];
    if (arg === "--") break;
    if (arg === longName) {
      enabled = true;
      continue;
    }
    if (arg === `--no-${longName.slice(2)}`) {
      enabled = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const option = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && longOptionsWithValues.has(option)) argIndex++;
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) continue;
    const cluster = arg.slice(1);
    for (let i = 0; i < cluster.length; i++) {
      const flag = cluster[i];
      if (flag === shortName) enabled = true;
      if (!shortOptionsWithValues.has(flag)) continue;
      if (i === cluster.length - 1) argIndex++;
      break;
    }
  }
  return enabled;
}
var RSYNC_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["@", "B", "e", "f", "M", "T"]);
var RSYNC_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--address",
  "--backup-dir",
  "--block-size",
  "--bwlimit",
  "--cc",
  "--checksum-choice",
  "--checksum-seed",
  "--chmod",
  "--chown",
  "--compare-dest",
  "--compress-choice",
  "--compress-level",
  "--compress-threads",
  "--contimeout",
  "--copy-as",
  "--copy-dest",
  "--debug",
  "--early-input",
  "--exclude",
  "--exclude-from",
  "--files-from",
  "--filter",
  "--groupmap",
  "--iconv",
  "--include",
  "--include-from",
  "--info",
  "--link-dest",
  "--log-file",
  "--log-file-format",
  "--max-alloc",
  "--max-delete",
  "--max-size",
  "--min-size",
  "--modify-window",
  "--only-write-batch",
  "--out-format",
  "--outbuf",
  "--partial-dir",
  "--password-file",
  "--port",
  "--protocol",
  "--read-batch",
  "--remote-option",
  "--rsh",
  "--rsync-path",
  "--skip-compress",
  "--sockopts",
  "--stderr",
  "--stop-after",
  "--stop-at",
  "--suffix",
  "--temp-dir",
  "--timeout",
  "--usermap",
  "--write-batch",
  "--zc",
  "--zl",
  "--zt"
]);
function isDockerComposeVolumeRemoval(args) {
  if (args[0] !== "compose" || args[1] !== "down") return false;
  let removesVolumes = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return false;
    if (arg === "-v" || arg === "--volumes") removesVolumes = true;
  }
  return removesVolumes;
}
var HELM_UNINSTALL_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--burst-limit",
  "--cascade",
  "--description",
  "--kube-apiserver",
  "--kube-as-group",
  "--kube-as-user",
  "--kube-ca-file",
  "--kube-context",
  "--kube-tls-server-name",
  "--kube-token",
  "--kubeconfig",
  "--namespace",
  "--qps",
  "--timeout"
]);
var HELM_UNINSTALL_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["n"]);
function parseHelmUninstallInvocation(args) {
  if (args[0] !== "uninstall" && args[0] !== "delete") return null;
  const result = { releases: [], exitsEarly: false, invalid: false };
  let positional = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (positional) {
      result.releases.push(arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.exitsEarly = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.exitsEarly = true;
      continue;
    }
    if (arg.startsWith("--dry-run=")) {
      const value = arg.slice("--dry-run=".length).toLowerCase();
      if (value === "true" || value === "1") result.exitsEarly = true;
      else if (value !== "false" && value !== "0") result.invalid = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && HELM_UNINSTALL_LONG_OPTIONS_WITH_VALUES.has(name)) {
        if (args[i + 1] === void 0) result.invalid = true;
        else i++;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const flag = cluster[j];
        if (flag === "h") result.exitsEarly = true;
        if (!HELM_UNINSTALL_SHORT_OPTIONS_WITH_VALUES.has(flag)) continue;
        if (j === cluster.length - 1) {
          if (args[i + 1] === void 0) result.invalid = true;
          else i++;
        }
        break;
      }
      continue;
    }
    result.releases.push(arg);
  }
  if (result.releases.length === 0) result.invalid = true;
  return result;
}
function findSubcommand(args, optionsWithValues) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      const name = args[i + 1];
      return name ? { name, index: i + 1 } : null;
    }
    if (!arg.startsWith("-") || arg === "-") return { name: arg, index: i };
    const optionName = arg.split("=", 1)[0];
    if (optionsWithValues.has(optionName) && !arg.includes("=")) i++;
    if (arg.length > 2) {
      const shortOption = arg.slice(0, 2);
      if (optionsWithValues.has(shortOption)) continue;
    }
  }
  return null;
}
var KUBECTL_GLOBAL_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["n", "s", "v"]);
var KUBECTL_GLOBAL_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--as",
  "--as-group",
  "--as-uid",
  "--as-user-extra",
  "--cache-dir",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--context",
  "--kubeconfig",
  "--kuberc",
  "--namespace",
  "--password",
  "--profile",
  "--profile-output",
  "--request-timeout",
  "--server",
  "--storage-driver-buffer-duration",
  "--storage-driver-db",
  "--storage-driver-host",
  "--storage-driver-password",
  "--storage-driver-table",
  "--storage-driver-user",
  "--tls-server-name",
  "--token",
  "--user",
  "--username",
  "--vmodule"
]);
var KUBECTL_GLOBAL_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  ...[...KUBECTL_GLOBAL_SHORT_OPTIONS_WITH_VALUES].map((option) => `-${option}`),
  ...KUBECTL_GLOBAL_LONG_OPTIONS_WITH_VALUES
]);
var KUBECTL_DELETE_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["f", "k", "l", "o"]);
var KUBECTL_DELETE_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--field-selector",
  "--filename",
  "--grace-period",
  "--kustomize",
  "--output",
  "--raw",
  "--selector",
  "--timeout"
]);
var KUBECTL_APPLY_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["f", "k", "l", "o"]);
var KUBECTL_APPLY_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--field-manager",
  "--filename",
  "--grace-period",
  "--kustomize",
  "--output",
  "--prune-allowlist",
  "--selector",
  "--subresource",
  "--template",
  "--timeout"
]);
function parseKubectlInvocationMode(args, command) {
  const commandShortOptions = command === "delete" ? KUBECTL_DELETE_SHORT_OPTIONS_WITH_VALUES : KUBECTL_APPLY_SHORT_OPTIONS_WITH_VALUES;
  const commandLongOptions = command === "delete" ? KUBECTL_DELETE_LONG_OPTIONS_WITH_VALUES : KUBECTL_APPLY_LONG_OPTIONS_WITH_VALUES;
  const result = { invalid: false, exitsEarly: false, hasTarget: false };
  let positionalCount = 0;
  let selector = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionalCount += args.length - i - 1;
      break;
    }
    if (arg === "--help" || arg === "-h") {
      result.exitsEarly = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = "unchanged";
      continue;
    }
    if (arg.startsWith("--dry-run=")) {
      result.dryRun = arg.slice("--dry-run=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (name === "--all") selector = true;
      if (equals < 0 && (KUBECTL_GLOBAL_LONG_OPTIONS_WITH_VALUES.has(name) || commandLongOptions.has(name))) {
        if (i + 1 >= args.length) result.invalid = true;
        else {
          if (name === "--filename" || name === "--kustomize" || name === "--raw") result.hasTarget = true;
          if (name === "--selector" || name === "--field-selector") selector = true;
          i++;
        }
      } else if (equals >= 0) {
        if (name === "--filename" || name === "--kustomize" || name === "--raw") result.hasTarget = true;
        if (name === "--selector" || name === "--field-selector") selector = true;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg.length < 2) {
      positionalCount++;
      continue;
    }
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (!KUBECTL_GLOBAL_SHORT_OPTIONS_WITH_VALUES.has(flag) && !commandShortOptions.has(flag)) continue;
      if (flag === "f" || flag === "k") result.hasTarget = true;
      if (flag === "l") selector = true;
      if (j === cluster.length - 1) {
        if (i + 1 >= args.length) result.invalid = true;
        else i++;
      }
      break;
    }
  }
  if (result.dryRun !== void 0 && !isValidKubectlDryRun(result.dryRun)) result.invalid = true;
  result.hasTarget ||= command === "delete" ? positionalCount >= 2 || positionalCount >= 1 && selector : false;
  if (!result.exitsEarly && !result.hasTarget) result.invalid = true;
  return result;
}
function isValidKubectlDryRun(value) {
  return value === "unchanged" || value === "client" || value === "server" || value === "none" || value === "1" || value === "t" || value === "T" || value === "true" || value === "TRUE" || value === "True" || value === "0" || value === "f" || value === "F" || value === "false" || value === "FALSE" || value === "False";
}
function isNonWritingKubectlDryRun(value) {
  return value === "unchanged" || value === "client" || value === "server" || value === "1" || value === "t" || value === "T" || value === "true" || value === "TRUE" || value === "True";
}
var MAKE_SHORT_OPTIONS_WITH_REQUIRED_VALUES = /* @__PURE__ */ new Set(["C", "E", "f", "I", "o", "W"]);
var MAKE_SHORT_OPTIONS_WITH_OPTIONAL_VALUES = /* @__PURE__ */ new Set(["j", "l", "O"]);
var MAKE_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--assume-new",
  "--assume-old",
  "--directory",
  "--eval",
  "--file",
  "--include-dir",
  "--makefile",
  "--new-file",
  "--old-file",
  "--what-if"
]);
function parseMakeInvocation(args) {
  const result = { goals: [], directories: [], nonExecuting: false, invalid: false };
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) {
      if (!isMakeAssignment(arg)) result.goals.push(arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    if (arg === "--dry-run" || arg === "--just-print" || arg === "--recon" || arg === "--question" || arg === "--touch" || arg === "--help" || arg === "--version") {
      result.nonExecuting = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && MAKE_LONG_OPTIONS_WITH_VALUES.has(name)) {
        const operand = args[i + 1];
        if (operand === void 0) result.invalid = true;
        else {
          if (name === "--directory") result.directories.push(operand);
          i++;
        }
      } else if (equals >= 0 && name === "--directory") {
        result.directories.push(arg.slice(equals + 1));
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      if (!isMakeAssignment(arg)) result.goals.push(arg);
      continue;
    }
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === "n" || flag === "q" || flag === "t") result.nonExecuting = true;
      if (MAKE_SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(flag)) {
        const attached = cluster.slice(j + 1);
        let operand = attached;
        if (!attached) {
          operand = args[i + 1] ?? "";
          if (operand === "") result.invalid = true;
          else i++;
        }
        if (flag === "C" && operand) result.directories.push(operand);
        break;
      }
      if (MAKE_SHORT_OPTIONS_WITH_OPTIONAL_VALUES.has(flag) && j < cluster.length - 1) break;
    }
  }
  return result;
}
function isMakeAssignment(arg) {
  return /^[A-Za-z_][A-Za-z0-9_]*(?::|\+|\?|!)?=/.test(arg);
}
function resolveMakeCwd(cwd, directories) {
  let resolved = cwd;
  for (const directory of directories) {
    const normalized = toPosix(directory);
    resolved = isAbsolutePath(directory) ? import_node_path4.posix.normalize(normalized) : import_node_path4.posix.normalize(import_node_path4.posix.join(resolved, normalized));
  }
  return resolved;
}
var TAR_SHORT_OPERATIONS = /* @__PURE__ */ new Map([
  ["x", "extract"],
  ["t", "list"],
  ["c", "create"],
  ["r", "append"],
  ["u", "update"],
  ["A", "concatenate"],
  ["d", "compare"]
]);
var TAR_LONG_OPERATIONS = /* @__PURE__ */ new Map([
  ["--extract", "extract"],
  ["--get", "extract"],
  ["--list", "list"],
  ["--create", "create"],
  ["--append", "append"],
  ["--update", "update"],
  ["--concatenate", "concatenate"],
  ["--catenate", "concatenate"],
  ["--compare", "compare"],
  ["--diff", "compare"],
  ["--delete", "delete"],
  ["--test-label", "test-label"]
]);
var TAR_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["b", "C", "f", "F", "g", "H", "I", "K", "L", "N", "T", "V", "X"]);
var TAR_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--add-file",
  "--after-date",
  "--blocking-factor",
  "--checkpoint-action",
  "--directory",
  "--exclude",
  "--exclude-from",
  "--exclude-ignore",
  "--exclude-ignore-recursive",
  "--exclude-tag",
  "--exclude-tag-all",
  "--exclude-tag-under",
  "--file",
  "--files-from",
  "--format",
  "--group",
  "--group-map",
  "--hole-detection",
  "--index-file",
  "--info-script",
  "--label",
  "--level",
  "--listed-incremental",
  "--mode",
  "--mtime",
  "--new-volume-script",
  "--newer",
  "--newer-mtime",
  "--no-quote-chars",
  "--owner",
  "--owner-map",
  "--pax-option",
  "--quote-chars",
  "--quoting-style",
  "--record-size",
  "--rmt-command",
  "--rsh-command",
  "--sort",
  "--sparse-version",
  "--starting-file",
  "--strip-components",
  "--suffix",
  "--tape-length",
  "--to-command",
  "--transform",
  "--use-compress-program",
  "--volno-file",
  "--warning",
  "--xattrs-exclude",
  "--xattrs-include",
  "--xform"
]);
var TAR_EARLY_EXIT_LONG_OPTIONS = /* @__PURE__ */ new Set(["--help", "--show-defaults", "--usage", "--version"]);
function parseTarInvocation(args) {
  const result = { operation: null, invalid: false, exitsEarly: false, toStdout: false, dest: "." };
  let options = true;
  const setOperation = (operation) => {
    if (result.operation) result.invalid = true;
    else result.operation = operation;
  };
  const applyShortFlag = (flag) => {
    const operation = TAR_SHORT_OPERATIONS.get(flag);
    if (operation) setOperation(operation);
    if (flag === "O") result.toStdout = true;
    if (flag === "?") result.exitsEarly = true;
  };
  const applyOptionValue = (flag, value) => {
    if (value === void 0) {
      result.invalid = true;
      return;
    }
    if (flag === "f" || flag === "--file") result.archive = value;
    else if (flag === "C" || flag === "--directory") result.dest = value;
  };
  let start = 0;
  const traditional = args[0] !== void 0 && !args[0].startsWith("-") && /^[A-Za-z?]+$/.test(args[0]);
  if (traditional) {
    const valueFlags = [];
    for (const flag of args[0]) {
      applyShortFlag(flag);
      if (TAR_SHORT_OPTIONS_WITH_VALUES.has(flag)) valueFlags.push(flag);
    }
    start = 1;
    for (const flag of valueFlags) applyOptionValue(flag, args[start++]);
  }
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options) continue;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const inlineValue = equals < 0 ? void 0 : arg.slice(equals + 1);
      const operation = TAR_LONG_OPERATIONS.get(name);
      if (operation) {
        setOperation(operation);
        if (inlineValue !== void 0) result.invalid = true;
      }
      if (name === "--to-stdout") {
        result.toStdout = true;
        if (inlineValue !== void 0) result.invalid = true;
      }
      if (TAR_EARLY_EXIT_LONG_OPTIONS.has(name)) result.exitsEarly = true;
      if (TAR_LONG_OPTIONS_WITH_VALUES.has(name)) {
        const value = inlineValue ?? args[++i];
        applyOptionValue(name, value);
      }
      continue;
    }
    if (!arg.startsWith("-")) continue;
    if (arg === "-") continue;
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      applyShortFlag(flag);
      if (!TAR_SHORT_OPTIONS_WITH_VALUES.has(flag)) continue;
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      applyOptionValue(flag, value);
      break;
    }
  }
  return result;
}
var UNZIP_NEGATABLE_MODIFIER_FLAGS = /* @__PURE__ */ new Set([
  "a",
  "b",
  "B",
  "C",
  "D",
  "E",
  "F",
  "i",
  "j",
  "J",
  "K",
  "L",
  "M",
  "N",
  "o",
  "q",
  "r",
  "s",
  "S",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "2",
  "$",
  ":",
  "^"
]);
function parseUnzipInvocation(args) {
  const result = { dest: ".", invalid: false, nonWriting: false };
  if (args[0]?.startsWith("-Z")) {
    result.nonWriting = true;
    return result;
  }
  let cflag = false;
  let fflag = false;
  let tflag = false;
  let timestampFlag = false;
  let uflag = false;
  let overwriteNone = false;
  let vflag = 0;
  let zflag = 0;
  let negative = 0;
  let help = false;
  let destinationSeen = false;
  let passwordSeen = false;
  let i = 0;
  const enableUnlessNegated = () => {
    if (negative) {
      negative = 0;
      return false;
    }
    return true;
  };
  const updateCount = (value, verbose = false) => {
    if (negative) {
      const updated = Math.max(value - negative, 0);
      negative = 0;
      return updated;
    }
    return verbose ? value ? value + 1 : 2 : value + 1;
  };
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const cluster = args[i].slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === "-") {
        negative++;
        continue;
      }
      if (flag === "c" || flag === "p") {
        cflag = enableUnlessNegated();
        continue;
      }
      if (flag === "f") {
        if (negative) {
          negative = 0;
          fflag = false;
          uflag = false;
        } else {
          fflag = true;
          uflag = true;
        }
        continue;
      }
      if (flag === "l") {
        vflag = updateCount(vflag);
        continue;
      }
      if (flag === "n") {
        overwriteNone = enableUnlessNegated();
        continue;
      }
      if (flag === "t") {
        tflag = enableUnlessNegated();
        continue;
      }
      if (flag === "T") {
        timestampFlag = enableUnlessNegated();
        continue;
      }
      if (flag === "u") {
        uflag = enableUnlessNegated();
        continue;
      }
      if (flag === "v") {
        vflag = updateCount(vflag, true);
        continue;
      }
      if (flag === "z") {
        zflag = updateCount(zflag);
        continue;
      }
      if (flag === "h") {
        help = true;
        continue;
      }
      if (flag === "Z") {
        result.invalid = true;
        continue;
      }
      if (flag === "d") {
        if (negative || destinationSeen) {
          result.invalid = true;
          continue;
        }
        const attached = cluster.slice(j + 1);
        if (attached) {
          result.dest = attached;
        } else {
          const value = args[i + 1];
          if (value === void 0 || value.startsWith("-")) result.invalid = true;
          else {
            result.dest = value;
            i++;
          }
        }
        destinationSeen = true;
        break;
      }
      if (flag === "P") {
        if (negative) {
          result.invalid = true;
          continue;
        }
        if (!passwordSeen) {
          const attached = cluster.slice(j + 1);
          if (!attached) {
            const value = args[i + 1];
            if (value === void 0 || value.startsWith("-")) result.invalid = true;
            else i++;
          }
          passwordSeen = true;
          break;
        }
        continue;
      }
      if (UNZIP_NEGATABLE_MODIFIER_FLAGS.has(flag)) negative = 0;
    }
  }
  if (i < args.length) result.archive = args[i++];
  for (; i < args.length; i++) {
    const arg = args[i];
    if (destinationSeen || !arg.startsWith("-d")) continue;
    const attached = arg.slice(2);
    if (attached) result.dest = attached;
    else if (i + 1 < args.length) result.dest = args[++i];
    else result.invalid = true;
    destinationSeen = true;
  }
  if (cflag && (tflag || uflag) || tflag && uflag || fflag && overwriteNone) {
    result.invalid = true;
  }
  result.nonWriting = help || cflag || tflag || timestampFlag || vflag > 0 || zflag > 0;
  return result;
}
function assignmentArg(args, name) {
  const prefix = name + "=";
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
var FIND_EXPRESSIONS_WITH_ONE_OPERAND = /* @__PURE__ */ new Set([
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-ctime",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-iwholename",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mnewer",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-samefile",
  "-size",
  "-type",
  "-uid",
  "-user",
  "-wholename",
  "-xtype",
  "-fprint",
  "-fprint0",
  "-fls",
  "-regextype",
  "-files0-from"
]);
var FIND_EXPRESSIONS_WITH_TWO_OPERANDS = /* @__PURE__ */ new Set(["-fprintf"]);
var FIND_VARIABLE_OPERAND_EXPRESSIONS = /* @__PURE__ */ new Set(["-exec", "-execdir", "-ok", "-okdir"]);
function parseFindDeleteInvocation(args) {
  const result = { roots: [], deletes: false, exitsEarly: false, invalid: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--help" || arg === "--version") {
      result.exitsEarly = true;
      return result;
    }
    if (arg === "-H" || arg === "-L" || arg === "-P" || /^-O\d+$/.test(arg)) {
      i++;
      continue;
    }
    if (arg === "-D") {
      if (args[i + 1] === void 0) result.invalid = true;
      else i += 2;
      continue;
    }
    break;
  }
  while (i < args.length && !isFindExpressionStart(args[i])) result.roots.push(args[i++]);
  if (result.roots.length === 0) result.roots.push(".");
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "--version") {
      result.exitsEarly = true;
      continue;
    }
    if (arg === "-delete") {
      result.deletes = true;
      continue;
    }
    if (FIND_VARIABLE_OPERAND_EXPRESSIONS.has(arg)) {
      let terminated = false;
      while (++i < args.length) {
        if (args[i] === ";" || args[i] === "+") {
          terminated = true;
          break;
        }
      }
      if (!terminated) result.invalid = true;
      continue;
    }
    const dynamicNewer = /^-newer[A-Za-z]{2}$/.test(arg);
    const operands = dynamicNewer || FIND_EXPRESSIONS_WITH_ONE_OPERAND.has(arg) ? 1 : FIND_EXPRESSIONS_WITH_TWO_OPERANDS.has(arg) ? 2 : 0;
    if (operands > 0) {
      if (i + operands >= args.length) result.invalid = true;
      i += operands;
    }
  }
  return result;
}
function isFindExpressionStart(arg) {
  return arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")" || arg === ",";
}
var XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES = /* @__PURE__ */ new Set([
  "--arg-file",
  "--delimiter",
  "--eof-str",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--process-slot-var",
  "--replace-str"
]);
var XARGS_LONG_OPTIONS_WITH_OPTIONAL_VALUES = /* @__PURE__ */ new Set(["--eof", "--replace"]);
var XARGS_SHORT_OPTIONS_WITH_REQUIRED_VALUES = /* @__PURE__ */ new Set(["a", "d", "E", "I", "L", "n", "P", "s", "S"]);
var XARGS_SHORT_OPTIONS_WITH_OPTIONAL_VALUES = /* @__PURE__ */ new Set(["e", "i", "l"]);
function parseXargsInvocation(args) {
  const result = { exitsEarly: false, invalid: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      if (args[i + 1] === void 0) result.invalid = true;
      else result.commandIndex = i + 1;
      return result;
    }
    if (arg === "--help" || arg === "--version") {
      result.exitsEarly = true;
      return result;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals < 0 && XARGS_LONG_OPTIONS_WITH_REQUIRED_VALUES.has(name)) {
        if (args[i + 1] === void 0) result.invalid = true;
        else i++;
      } else if (equals < 0 && XARGS_LONG_OPTIONS_WITH_OPTIONAL_VALUES.has(name)) {
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const cluster = arg.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        const flag = cluster[j];
        if (XARGS_SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(flag)) {
          if (j === cluster.length - 1) {
            if (args[i + 1] === void 0) result.invalid = true;
            else i++;
          }
          break;
        }
        if (XARGS_SHORT_OPTIONS_WITH_OPTIONAL_VALUES.has(flag)) break;
      }
      if (result.invalid) return result;
      continue;
    }
    result.commandIndex = i;
    return result;
  }
  return result;
}
function isRmExecutable(command) {
  let basename = import_node_path4.posix.basename(toPosix(command));
  if (basename.toLowerCase().endsWith(".exe")) basename = basename.slice(0, -4).toLowerCase();
  return basename === "rm";
}
function hasEarlyExitOption(args, earlyExitOptions) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (earlyExitOptions.has(arg)) return true;
  }
  return false;
}
function positionalOperands(args) {
  const operands = [];
  let positional = false;
  for (const arg of args) {
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (positional || !arg.startsWith("-") || arg === "-") operands.push(arg);
  }
  return operands;
}
function listTarEntries(archivePath) {
  try {
    const fd = fs5.openSync(toNative(archivePath), "r");
    try {
      const entries = [];
      const header = Buffer.alloc(512);
      let offset = 0;
      while (fs5.readSync(fd, header, 0, 512, offset) === 512) {
        if (header.every((byte) => byte === 0)) break;
        const name = readNullTerminated(header, 0, 100);
        const prefix = readNullTerminated(header, 345, 155);
        const fullName = sanitizeArchiveEntry(prefix ? `${prefix}/${name}` : name);
        const sizeText = readNullTerminated(header, 124, 12).trim();
        const size = Number.parseInt(sizeText, 8);
        if (fullName && !fullName.endsWith("/")) entries.push(fullName);
        const dataSize = Number.isFinite(size) ? size : 0;
        offset += 512 + Math.ceil(dataSize / 512) * 512;
      }
      return entries;
    } finally {
      fs5.closeSync(fd);
    }
  } catch {
    return [];
  }
}
function listZipEntries(archivePath) {
  try {
    const data = fs5.readFileSync(toNative(archivePath));
    const entries = [];
    let i = 0;
    while (i + 46 <= data.length) {
      if (data.readUInt32LE(i) !== 33639248) {
        i++;
        continue;
      }
      const method = data.readUInt16LE(i + 10);
      const nameLen = data.readUInt16LE(i + 28);
      const extraLen = data.readUInt16LE(i + 30);
      const commentLen = data.readUInt16LE(i + 32);
      const name = sanitizeArchiveEntry(data.slice(i + 46, i + 46 + nameLen).toString("utf8"));
      if (method !== 0 && method !== 8) return [];
      if (name && !name.endsWith("/")) entries.push(name);
      i += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } catch {
    return [];
  }
}
function readNullTerminated(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const limit = end >= start && end < start + length ? end : start + length;
  return buffer.slice(start, limit).toString("utf8");
}
function sanitizeArchiveEntry(entry) {
  const normalized = import_node_path4.posix.normalize(entry.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) return "";
  return normalized;
}
var COMMAND_HANDLERS = new Map(COMMAND_SPECS.map(addCommandSpec));

// src/bash/arithmetic.ts
var MAX_ARITHMETIC_EXPRESSION_CHARS = 16 * 1024;
var MAX_ARITHMETIC_TOKENS = 2048;
var MAX_ARITHMETIC_RECURSION = 128;
var MAX_ARITHMETIC_EXPONENT = 128n;
function evaluateArithmeticExpression(expression, env) {
  if (expression.trim().length === 0) {
    return { value: 0n, uncertain: false, provenance: [] };
  }
  const runtime = {
    remainingChars: MAX_ARITHMETIC_EXPRESSION_CHARS,
    remainingTokens: MAX_ARITHMETIC_TOKENS,
    variableStack: /* @__PURE__ */ new Set(),
    readProvenance: []
  };
  let ast;
  try {
    ast = parseArithmeticSource(expression, runtime);
  } catch (error) {
    widenPotentialArithmeticWrites(expression, env, runtime.readProvenance);
    return {
      value: null,
      uncertain: true,
      error: error instanceof ArithmeticBudgetError ? "budget" : "syntax",
      provenance: runtime.readProvenance
    };
  }
  try {
    const result = evaluateArithmeticNode(ast, env, runtime, 0);
    const provenance = normalizeArithmeticProvenance([
      ...result.provenance,
      ...runtime.readProvenance
    ]);
    return result.exact ? {
      value: result.value,
      uncertain: false,
      provenance
    } : {
      value: null,
      uncertain: true,
      error: "evaluation",
      provenance
    };
  } catch (error) {
    widenPotentialArithmeticWrites(expression, env, runtime.readProvenance);
    return {
      value: null,
      uncertain: true,
      error: error instanceof ArithmeticBudgetError ? "budget" : "evaluation",
      provenance: runtime.readProvenance
    };
  }
}
var ArithmeticBudgetError = class extends Error {
};
var ArithmeticParser = class {
  constructor(tokens) {
    this.tokens = tokens;
  }
  tokens;
  position = 0;
  recursion = 0;
  parse() {
    const result = this.withDepth(() => this.parseComma());
    if (this.peek().kind !== "eof") {
      throw new Error(`unexpected arithmetic token ${this.peek().text}`);
    }
    return result;
  }
  parseComma() {
    let node = this.parseAssignment();
    while (this.consume(",")) {
      node = { kind: "comma", left: node, right: this.parseAssignment() };
    }
    return node;
  }
  parseAssignment() {
    const left = this.parseConditional();
    const operator = this.peek().text;
    if (!ASSIGNMENT_OPERATORS.has(operator)) return left;
    this.next();
    if (left.kind !== "variable") {
      throw new Error("arithmetic assignment requires a scalar variable");
    }
    return {
      kind: "assignment",
      operator,
      name: left.name,
      value: this.withDepth(() => this.parseAssignment())
    };
  }
  parseConditional() {
    const test = this.parseLogicalOr();
    if (!this.consume("?")) return test;
    const consequent = this.withDepth(() => this.parseComma());
    this.expect(":");
    const alternate = this.withDepth(() => this.parseAssignment());
    return { kind: "conditional", test, consequent, alternate };
  }
  parseLogicalOr() {
    return this.parseLeftAssociative(
      () => this.parseLogicalAnd(),
      /* @__PURE__ */ new Set(["||"])
    );
  }
  parseLogicalAnd() {
    return this.parseLeftAssociative(
      () => this.parseBitwiseOr(),
      /* @__PURE__ */ new Set(["&&"])
    );
  }
  parseBitwiseOr() {
    return this.parseLeftAssociative(
      () => this.parseBitwiseXor(),
      /* @__PURE__ */ new Set(["|"])
    );
  }
  parseBitwiseXor() {
    return this.parseLeftAssociative(
      () => this.parseBitwiseAnd(),
      /* @__PURE__ */ new Set(["^"])
    );
  }
  parseBitwiseAnd() {
    return this.parseLeftAssociative(
      () => this.parseEquality(),
      /* @__PURE__ */ new Set(["&"])
    );
  }
  parseEquality() {
    return this.parseLeftAssociative(
      () => this.parseRelational(),
      /* @__PURE__ */ new Set(["==", "!="])
    );
  }
  parseRelational() {
    return this.parseLeftAssociative(
      () => this.parseShift(),
      /* @__PURE__ */ new Set(["<", "<=", ">", ">="])
    );
  }
  parseShift() {
    return this.parseLeftAssociative(
      () => this.parseAdditive(),
      /* @__PURE__ */ new Set(["<<", ">>"])
    );
  }
  parseAdditive() {
    return this.parseLeftAssociative(
      () => this.parseMultiplicative(),
      /* @__PURE__ */ new Set(["+", "-"])
    );
  }
  parseMultiplicative() {
    return this.parseLeftAssociative(
      () => this.parsePower(),
      /* @__PURE__ */ new Set(["*", "/", "%"])
    );
  }
  parsePower() {
    const left = this.parseUnary();
    if (!this.consume("**")) return left;
    return {
      kind: "binary",
      operator: "**",
      left,
      right: this.withDepth(() => this.parsePower())
    };
  }
  parseUnary() {
    const operator = this.peek().text;
    if (operator === "++" || operator === "--") {
      this.next();
      const operand = this.withDepth(() => this.parseUnary());
      if (operand.kind !== "variable") {
        throw new Error("arithmetic update requires a scalar variable");
      }
      return { kind: "update", operator, name: operand.name, prefix: true };
    }
    if (operator === "+" || operator === "-" || operator === "!" || operator === "~") {
      this.next();
      return {
        kind: "unary",
        operator,
        operand: this.withDepth(() => this.parseUnary())
      };
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    const operand = this.parsePrimary();
    const operator = this.peek().text;
    if (operator !== "++" && operator !== "--") return operand;
    this.next();
    if (operand.kind !== "variable") {
      throw new Error("arithmetic update requires a scalar variable");
    }
    return { kind: "update", operator, name: operand.name, prefix: false };
  }
  parsePrimary() {
    const token = this.next();
    if (token.kind === "number") {
      const value = parseArithmeticInteger(token.text);
      if (value === null) throw new Error("unsupported arithmetic integer");
      return { kind: "literal", value };
    }
    if (token.kind === "name") return { kind: "variable", name: token.text };
    if (token.text === "(") {
      const node = this.withDepth(() => this.parseComma());
      this.expect(")");
      return node;
    }
    throw new Error(`expected arithmetic operand, got ${token.text}`);
  }
  parseLeftAssociative(parseOperand, operators) {
    let node = parseOperand();
    while (operators.has(this.peek().text)) {
      const operator = this.next().text;
      node = {
        kind: "binary",
        operator,
        left: node,
        right: this.withDepth(parseOperand)
      };
    }
    return node;
  }
  withDepth(fn) {
    this.recursion++;
    if (this.recursion > MAX_ARITHMETIC_RECURSION) {
      this.recursion--;
      throw new ArithmeticBudgetError("arithmetic recursion budget exhausted");
    }
    try {
      return fn();
    } finally {
      this.recursion--;
    }
  }
  peek() {
    return this.tokens[this.position] ?? { kind: "eof", text: "" };
  }
  next() {
    const token = this.peek();
    if (token.kind !== "eof") this.position++;
    return token;
  }
  consume(operator) {
    if (this.peek().text !== operator) return false;
    this.next();
    return true;
  }
  expect(operator) {
    if (!this.consume(operator)) {
      throw new Error(`expected arithmetic operator ${operator}`);
    }
  }
};
var ASSIGNMENT_OPERATORS = /* @__PURE__ */ new Set([
  "=",
  "*=",
  "/=",
  "%=",
  "+=",
  "-=",
  "<<=",
  ">>=",
  "&=",
  "^=",
  "|="
]);
function parseArithmeticSource(expression, runtime) {
  if (expression.length > runtime.remainingChars) {
    throw new ArithmeticBudgetError("arithmetic source budget exhausted");
  }
  runtime.remainingChars -= expression.length;
  return new ArithmeticParser(tokenizeArithmetic(expression, runtime)).parse();
}
function tokenizeArithmetic(expression, runtime) {
  const tokens = [];
  let position = 0;
  while (position < expression.length) {
    const character = expression[position];
    if (/\s/u.test(character)) {
      position++;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      let end = position + 1;
      while (end < expression.length && /[A-Za-z0-9_]/u.test(expression[end])) end++;
      tokens.push({ kind: "name", text: expression.slice(position, end) });
      position = end;
    } else if (/[0-9]/u.test(character)) {
      let end = position + 1;
      while (end < expression.length && /[A-Za-z0-9_#@]/u.test(expression[end])) end++;
      tokens.push({ kind: "number", text: expression.slice(position, end) });
      position = end;
    } else {
      const operator = readArithmeticOperator(expression, position);
      if (operator === null) {
        throw new Error(`unsupported arithmetic character ${character}`);
      }
      tokens.push({ kind: "operator", text: operator });
      position += operator.length;
    }
    runtime.remainingTokens--;
    if (runtime.remainingTokens < 0) {
      throw new ArithmeticBudgetError("arithmetic token budget exhausted");
    }
  }
  tokens.push({ kind: "eof", text: "" });
  return tokens;
}
function readArithmeticOperator(expression, position) {
  for (const operator of ARITHMETIC_OPERATORS) {
    if (expression.startsWith(operator, position)) return operator;
  }
  return null;
}
var ARITHMETIC_OPERATORS = [
  "<<=",
  ">>=",
  "++",
  "--",
  "**",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "<<",
  ">>",
  "*=",
  "/=",
  "%=",
  "+=",
  "-=",
  "&=",
  "^=",
  "|=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "<",
  ">",
  "&",
  "^",
  "|",
  "!",
  "~",
  "?",
  ":",
  "=",
  ","
];
function evaluateArithmeticNode(node, env, runtime, depth) {
  if (depth > MAX_ARITHMETIC_RECURSION) {
    throw new ArithmeticBudgetError("arithmetic evaluation budget exhausted");
  }
  if (node.kind === "literal") return exactArithmeticValue(node.value);
  if (node.kind === "variable") {
    return readArithmeticVariable(node.name, env, runtime, depth + 1);
  }
  if (node.kind === "unary") {
    return evaluateArithmeticUnary(
      node.operator,
      evaluateArithmeticNode(node.operand, env, runtime, depth + 1)
    );
  }
  if (node.kind === "update") {
    return evaluateArithmeticUpdate(node, env, runtime, depth + 1);
  }
  if (node.kind === "assignment") {
    return evaluateArithmeticAssignment(node, env, runtime, depth + 1);
  }
  if (node.kind === "conditional") {
    const test = evaluateArithmeticNode(node.test, env, runtime, depth + 1);
    if (test.exact) {
      return withArithmeticProvenance(evaluateArithmeticNode(
        test.value !== 0n ? node.consequent : node.alternate,
        env,
        runtime,
        depth + 1
      ), test.provenance);
    }
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => evaluateArithmeticNode(node.consequent, env, runtime, depth + 1),
        () => evaluateArithmeticNode(node.alternate, env, runtime, depth + 1)
      ]
    ), test.provenance);
  }
  if (node.kind === "comma") {
    const left = evaluateArithmeticNode(node.left, env, runtime, depth + 1);
    if (!left.exact) {
      return withArithmeticProvenance(evaluateArithmeticBranches(
        env,
        [
          () => unknownArithmeticValue(),
          () => {
            const right = evaluateArithmeticNode(
              node.right,
              env,
              runtime,
              depth + 1
            );
            return unknownArithmeticValue(right.provenance);
          }
        ]
      ), left.provenance);
    }
    return evaluateArithmeticNode(node.right, env, runtime, depth + 1);
  }
  return evaluateArithmeticBinary(node, env, runtime, depth + 1);
}
function evaluateArithmeticBinary(node, env, runtime, depth) {
  const left = evaluateArithmeticNode(node.left, env, runtime, depth);
  if (node.operator === "&&") {
    if (left.exact && left.value === 0n) {
      return exactArithmeticValue(0n, left.provenance);
    }
    if (left.exact) {
      const right2 = evaluateArithmeticNode(node.right, env, runtime, depth);
      return withArithmeticProvenance(
        booleanArithmeticValue(right2),
        left.provenance
      );
    }
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => exactArithmeticValue(0n),
        () => booleanArithmeticValue(
          evaluateArithmeticNode(node.right, env, runtime, depth)
        )
      ]
    ), left.provenance);
  }
  if (node.operator === "||") {
    if (left.exact && left.value !== 0n) {
      return exactArithmeticValue(1n, left.provenance);
    }
    if (left.exact) {
      const right2 = evaluateArithmeticNode(node.right, env, runtime, depth);
      return withArithmeticProvenance(
        booleanArithmeticValue(right2),
        left.provenance
      );
    }
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => exactArithmeticValue(1n),
        () => booleanArithmeticValue(
          evaluateArithmeticNode(node.right, env, runtime, depth)
        )
      ]
    ), left.provenance);
  }
  if (!left.exact) {
    return withArithmeticProvenance(evaluateArithmeticBranches(
      env,
      [
        () => unknownArithmeticValue(),
        () => {
          const right2 = evaluateArithmeticNode(
            node.right,
            env,
            runtime,
            depth
          );
          return unknownArithmeticValue(right2.provenance);
        }
      ]
    ), left.provenance);
  }
  const right = evaluateArithmeticNode(node.right, env, runtime, depth);
  const provenance = combineArithmeticProvenance(left, right);
  if (!right.exact) return unknownArithmeticValue(provenance);
  return applyArithmeticBinary(
    node.operator,
    left.value,
    right.value,
    provenance
  );
}
function evaluateArithmeticUnary(operator, operand) {
  if (!operand.exact) return unknownArithmeticValue(operand.provenance);
  if (operator === "+") {
    return exactArithmeticValue(operand.value, operand.provenance);
  }
  if (operator === "-") {
    return exactArithmeticValue(-operand.value, operand.provenance);
  }
  if (operator === "!") {
    return exactArithmeticValue(
      operand.value === 0n ? 1n : 0n,
      operand.provenance
    );
  }
  return exactArithmeticValue(~operand.value, operand.provenance);
}
function evaluateArithmeticUpdate(node, env, runtime, depth) {
  const old = readArithmeticVariable(node.name, env, runtime, depth);
  if (!old.exact) {
    bindUnknownArithmeticVariable(node.name, env, old.provenance);
    return unknownArithmeticValue(old.provenance);
  }
  const next = exactArithmeticValue(
    node.operator === "++" ? old.value + 1n : old.value - 1n,
    old.provenance
  );
  env.bind_variable(node.name, String(next.value), 0, false, next.provenance);
  return node.prefix ? next : old;
}
function evaluateArithmeticAssignment(node, env, runtime, depth) {
  const left = node.operator === "=" ? null : readArithmeticVariable(node.name, env, runtime, depth);
  const right = evaluateArithmeticNode(node.value, env, runtime, depth);
  let assigned = right;
  if (left !== null) {
    const binary = node.operator.slice(0, -1);
    assigned = left.exact && right.exact ? applyArithmeticBinary(
      binary,
      left.value,
      right.value,
      combineArithmeticProvenance(left, right)
    ) : unknownArithmeticValue(combineArithmeticProvenance(left, right));
  }
  if (assigned.exact) {
    env.bind_variable(
      node.name,
      String(assigned.value),
      0,
      false,
      assigned.provenance
    );
  } else {
    bindUnknownArithmeticVariable(node.name, env, assigned.provenance);
  }
  return assigned;
}
function evaluateArithmeticBranches(env, branches) {
  const input = env.snapshot();
  const outputs = [];
  const values = [];
  for (const branch of branches) {
    env.restore(input);
    values.push(branch());
    outputs.push(env.snapshot());
  }
  env.restore_widened(outputs);
  const first = values[0];
  const provenance = normalizeArithmeticProvenance(
    values.flatMap((value) => value.provenance)
  );
  return first.exact && values.every((value) => value.exact && value.value === first.value) ? exactArithmeticValue(first.value, provenance) : unknownArithmeticValue(provenance);
}
function applyArithmeticBinary(operator, left, right, provenance = []) {
  if (operator === "**") {
    if (right < 0n || right > MAX_ARITHMETIC_EXPONENT) {
      return unknownArithmeticValue(provenance);
    }
    return exactArithmeticValue(left ** right, provenance);
  }
  if (operator === "*") return exactArithmeticValue(left * right, provenance);
  if (operator === "/") {
    if (right === 0n || left === -(1n << 63n) && right === -1n) {
      return unknownArithmeticValue(provenance);
    }
    return exactArithmeticValue(left / right, provenance);
  }
  if (operator === "%") {
    if (right === 0n) return unknownArithmeticValue(provenance);
    return exactArithmeticValue(left % right, provenance);
  }
  if (operator === "+") return exactArithmeticValue(left + right, provenance);
  if (operator === "-") return exactArithmeticValue(left - right, provenance);
  if (operator === "<<" || operator === ">>") {
    if (right < 0n || right >= 64n) {
      return unknownArithmeticValue(provenance);
    }
    return exactArithmeticValue(
      operator === "<<" ? left << right : left >> right,
      provenance
    );
  }
  if (operator === "<") return exactArithmeticValue(left < right ? 1n : 0n, provenance);
  if (operator === "<=") return exactArithmeticValue(left <= right ? 1n : 0n, provenance);
  if (operator === ">") return exactArithmeticValue(left > right ? 1n : 0n, provenance);
  if (operator === ">=") return exactArithmeticValue(left >= right ? 1n : 0n, provenance);
  if (operator === "==") return exactArithmeticValue(left === right ? 1n : 0n, provenance);
  if (operator === "!=") return exactArithmeticValue(left !== right ? 1n : 0n, provenance);
  if (operator === "&") return exactArithmeticValue(left & right, provenance);
  if (operator === "^") return exactArithmeticValue(left ^ right, provenance);
  if (operator === "|") return exactArithmeticValue(left | right, provenance);
  return unknownArithmeticValue(provenance);
}
function booleanArithmeticValue(value) {
  return value.exact ? exactArithmeticValue(
    value.value === 0n ? 0n : 1n,
    value.provenance
  ) : unknownArithmeticValue(value.provenance);
}
function exactArithmeticValue(value, provenance = []) {
  return {
    exact: true,
    value: BigInt.asIntN(64, value),
    provenance: normalizeArithmeticProvenance(provenance)
  };
}
function unknownArithmeticValue(provenance = []) {
  return {
    exact: false,
    value: 0n,
    provenance: normalizeArithmeticProvenance(provenance)
  };
}
function withArithmeticProvenance(value, provenance) {
  const combined = normalizeArithmeticProvenance([
    ...provenance,
    ...value.provenance
  ]);
  return value.exact ? exactArithmeticValue(value.value, combined) : unknownArithmeticValue(combined);
}
function combineArithmeticProvenance(...values) {
  return normalizeArithmeticProvenance(
    values.flatMap((value) => value.provenance)
  );
}
function readArithmeticVariable(name, env, runtime, depth) {
  const variable = env.find_variable(name);
  if (!variable) return exactArithmeticValue(0n);
  const provenance = env.get_value_provenance(name);
  runtime.readProvenance = normalizeArithmeticProvenance([
    ...runtime.readProvenance,
    ...provenance
  ]);
  if (variable.uncertain) return unknownArithmeticValue(provenance);
  if (variable.value.length === 0) {
    return exactArithmeticValue(0n, provenance);
  }
  const parsed = parseArithmeticInteger(variable.value);
  if (parsed !== null) return exactArithmeticValue(parsed, provenance);
  if (depth > MAX_ARITHMETIC_RECURSION || runtime.variableStack.has(name)) {
    widenPotentialArithmeticWrites(variable.value, env, provenance);
    return unknownArithmeticValue(provenance);
  }
  runtime.variableStack.add(name);
  try {
    const nested = parseArithmeticSource(variable.value, runtime);
    return withArithmeticProvenance(
      evaluateArithmeticNode(nested, env, runtime, depth + 1),
      provenance
    );
  } catch {
    widenPotentialArithmeticWrites(
      variable.value,
      env,
      normalizeArithmeticProvenance([
        ...provenance,
        ...runtime.readProvenance
      ])
    );
    return unknownArithmeticValue([
      ...provenance,
      ...runtime.readProvenance
    ]);
  } finally {
    runtime.variableStack.delete(name);
  }
}
function parseArithmeticInteger(value) {
  const match = /^([+-]?)(.*)$/u.exec(value);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const digits = match[2];
  try {
    if (/^0[xX][0-9A-Fa-f]+$/u.test(digits)) {
      return sign * BigInt(digits);
    }
    if (/^0[0-7]+$/u.test(digits) && digits.length > 1) {
      return sign * BigInt(`0o${digits.slice(1)}`);
    }
    if (/^(?:0|[1-9][0-9]*)$/u.test(digits)) {
      return sign * BigInt(digits);
    }
  } catch {
    return null;
  }
  return null;
}
function bindUnknownArithmeticVariable(name, env, provenance = []) {
  const arrayKind = env.get_array_kind(name);
  if (arrayKind) {
    env.widen_array(name, arrayKind, provenance);
    return;
  }
  env.bind_variable(name, `<unknown:${name}>`, 0, true, provenance);
}
function widenPotentialArithmeticWrites(expression, env, provenance = []) {
  const names = /* @__PURE__ */ new Set();
  for (const match of expression.matchAll(
    /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)?(?:<<=|>>=|\+\+|--|[+\-*/%&^|]?=)/gu
  )) {
    names.add(match[1]);
  }
  for (const match of expression.matchAll(
    /(?:^|[^A-Za-z0-9_])(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)/gu
  )) {
    names.add(match[1]);
  }
  for (const name of names) {
    bindUnknownArithmeticVariable(name, env, provenance);
  }
}
function normalizeArithmeticProvenance(provenance) {
  return [...new Set(provenance)].filter((id) => Number.isInteger(id) && id >= 0).sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}

// src/bash/arrays.ts
function resolve_array_element(reference, env, expandSubscript) {
  const kind = env.get_array_kind(reference.name) ?? "indexed";
  const expanded = expandSubscript(reference.subscript);
  const provenance = [...expanded.provenance ?? []];
  if (expanded.uncertain) {
    return { key: null, kind, uncertain: true, provenance };
  }
  if (kind === "associative") {
    if (expanded.word.length === 0) {
      return { key: null, kind, uncertain: true, provenance };
    }
    return {
      key: expanded.word,
      kind,
      uncertain: false,
      provenance
    };
  }
  const evaluated = evaluateArithmeticExpression(expanded.word, env);
  let arithmeticProvenance = normalizeProvenance4([
    ...provenance,
    ...evaluated.provenance
  ]);
  if (evaluated.uncertain || evaluated.value === null) {
    return {
      key: null,
      kind,
      uncertain: true,
      provenance: arithmeticProvenance
    };
  }
  let index = evaluated.value;
  if (index < 0n) {
    if (env.get_array_values(reference.name).uncertain) {
      return {
        key: null,
        kind,
        uncertain: true,
        provenance: arithmeticProvenance
      };
    }
    arithmeticProvenance = normalizeProvenance4([
      ...arithmeticProvenance,
      ...env.get_array_provenance(reference.name)
    ]);
    const maximum = env.get_array_max_index(reference.name) ?? -1n;
    index = maximum + 1n + index;
  }
  if (index < 0n) {
    return {
      key: null,
      kind,
      uncertain: true,
      provenance: arithmeticProvenance
    };
  }
  return {
    key: String(index),
    kind,
    uncertain: false,
    provenance: arithmeticProvenance
  };
}
function normalizeProvenance4(provenance) {
  return [...new Set(provenance)].filter((id) => Number.isInteger(id) && id >= 0).sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}

// src/bash/subst.ts
var MAX_BRACE_EXPANSION_RESULTS = 2e3;
var MAX_EXPANDED_WORDS = 4e3;
function emit_brace_result(word, budget) {
  if (budget.produced >= budget.limit) {
    budget.truncated = true;
    return [];
  }
  budget.produced++;
  return [word];
}
function brace_expand(word, budget) {
  const start = find_brace_open(word);
  if (start === -1) return emit_brace_result(word, budget);
  const end = find_brace_close(word, start);
  if (end === -1) return emit_brace_result(word, budget);
  const preamble = word.substring(0, start);
  const postamble = word.substring(end + 1);
  const body = word.substring(start + 1, end);
  const seq = parse_numeric_brace_sequence(body);
  if (seq) {
    const { from, to, step } = seq;
    if (step === 0) return emit_brace_result(word, budget);
    const results2 = [];
    if (from <= to) {
      for (let i = from; i <= to && !budget.truncated; i += step) {
        results2.push(...brace_expand(preamble + i + postamble, budget));
      }
    } else {
      for (let i = from; i >= to && !budget.truncated; i -= step) {
        results2.push(...brace_expand(preamble + i + postamble, budget));
      }
    }
    return results2;
  }
  const parts = split_brace_body(body);
  if (parts.length <= 1) return emit_brace_result(word, budget);
  const results = [];
  for (const part of parts) {
    if (budget.truncated) break;
    results.push(...brace_expand(preamble + part + postamble, budget));
  }
  return results;
}
function parse_numeric_brace_sequence(body) {
  const first = readSignedInteger(body, 0);
  if (!first) return null;
  let pos = first.end;
  if (body[pos] !== "." || body[pos + 1] !== ".") return null;
  pos += 2;
  const second = readSignedInteger(body, pos);
  if (!second) return null;
  pos = second.end;
  let step = 1;
  if (pos < body.length) {
    if (body[pos] !== "." || body[pos + 1] !== ".") return null;
    pos += 2;
    const third = readSignedInteger(body, pos);
    if (!third) return null;
    step = Math.abs(third.value);
    pos = third.end;
  }
  if (pos !== body.length) return null;
  return { from: first.value, to: second.value, step };
}
function readSignedInteger(s, start) {
  let pos = start;
  let sign = 1;
  if (s[pos] === "-") {
    sign = -1;
    pos++;
  }
  const digitsStart = pos;
  let value = 0;
  while (pos < s.length && s[pos] >= "0" && s[pos] <= "9") {
    value = value * 10 + (s.charCodeAt(pos) - 48);
    pos++;
  }
  if (pos === digitsStart) return null;
  return { value: sign * value, end: pos };
}
function find_brace_open(word) {
  let depth = 0;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "\\") {
      i++;
      continue;
    }
    if (word[i] === "'" || word[i] === '"') {
      const q = word[i];
      i++;
      while (i < word.length && word[i] !== q) {
        if (word[i] === "\\" && q === '"') i++;
        i++;
      }
      continue;
    }
    if (word[i] === "{") {
      if (depth === 0) return i;
      depth++;
    }
    if (word[i] === "}") depth--;
  }
  return -1;
}
function find_brace_close(word, openPos) {
  let depth = 1;
  for (let i = openPos + 1; i < word.length; i++) {
    if (word[i] === "\\") {
      i++;
      continue;
    }
    if (word[i] === "'" || word[i] === '"') {
      const q = word[i];
      i++;
      while (i < word.length && word[i] !== q) {
        if (word[i] === "\\" && q === '"') i++;
        i++;
      }
      continue;
    }
    if (word[i] === "{") depth++;
    if (word[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function split_brace_body(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      current += body[i] + (body[i + 1] || "");
      i++;
      continue;
    }
    if (body[i] === "{") depth++;
    if (body[i] === "}") depth--;
    if (body[i] === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += body[i];
    }
  }
  parts.push(current);
  return parts;
}
function tilde_expand_word(word, env) {
  if (!word.startsWith("~")) return word;
  const slash = word.indexOf("/");
  const user = slash === -1 ? word.substring(1) : word.substring(1, slash);
  const rest = slash === -1 ? "" : word.substring(slash);
  if (user === "" || user === (env.get_string_value("USER") ?? "")) {
    const home = env.get_string_value("HOME") ?? "/home/user";
    return quote_expanded_value(home) + rest;
  }
  return word;
}
function param_expand(expr, env, context) {
  const parsed = parseParameterExpansion(expr);
  if (!parsed) return { value: "", uncertain: true, provenance: [] };
  if (parsed.kind === "length") {
    const reference = parse_array_reference(parsed.name);
    if (reference && (reference.subscript === "@" || reference.subscript === "*")) {
      const values = env.get_array_values(reference.name);
      return {
        value: String(values.values.length),
        uncertain: values.uncertain,
        provenance: values.provenance
      };
    }
    const expanded2 = parameterValue(parsed.name, env, context);
    return {
      value: String(expanded2.value.length),
      uncertain: expanded2.uncertain,
      provenance: expanded2.provenance
    };
  }
  const expanded = parameterValue(parsed.name, env, context);
  const val = expanded.isSet ? expanded.value : void 0;
  const valueUncertain = expanded.uncertain;
  const isSet = val !== void 0;
  const isNonNull = isSet && val !== "";
  switch (parsed.kind) {
    case "value":
      return {
        value: val ?? "",
        uncertain: valueUncertain,
        provenance: expanded.provenance
      };
    case "default":
      if (parsed.checkNull ? isNonNull : isSet) {
        return {
          value: val ?? "",
          uncertain: valueUncertain,
          provenance: expanded.provenance
        };
      }
      return expandParameterOperatorWord(parsed.word, env, context);
    case "assignDefault":
      if (parsed.checkNull ? isNonNull : isSet) {
        return {
          value: val ?? "",
          uncertain: valueUncertain,
          provenance: expanded.provenance
        };
      }
      {
        const assigned = expandParameterOperatorWord(parsed.word, env, context);
        const reference = parse_array_reference(parsed.name);
        if (reference) {
          env.widen_array(
            reference.name,
            env.get_array_kind(reference.name) ?? "indexed",
            assigned.provenance
          );
          return {
            value: assigned.value,
            uncertain: true,
            provenance: env.get_array_provenance(reference.name)
          };
        }
        env.bind_variable(
          parsed.name,
          assigned.value,
          0,
          assigned.uncertain,
          assigned.provenance
        );
        return {
          ...assigned,
          provenance: env.get_value_provenance(parsed.name)
        };
      }
    case "alternate":
      if (parsed.checkNull ? isNonNull : isSet) {
        const alternate = expandParameterOperatorWord(parsed.word, env, context);
        return {
          value: alternate.value,
          uncertain: valueUncertain || alternate.uncertain,
          provenance: normalizeProvenance5([
            ...expanded.provenance ?? [],
            ...alternate.provenance ?? []
          ])
        };
      }
      return {
        value: "",
        uncertain: false,
        provenance: expanded.provenance
      };
    case "error":
      if (parsed.checkNull ? isNonNull : isSet) {
        return {
          value: val ?? "",
          uncertain: valueUncertain,
          provenance: expanded.provenance
        };
      }
      {
        const errorWord = expandParameterOperatorWord(
          parsed.word,
          env,
          context
        );
        return {
          value: "",
          uncertain: true,
          provenance: normalizeProvenance5([
            ...expanded.provenance ?? [],
            ...errorWord.provenance ?? []
          ])
        };
      }
    case "removePrefix":
      return {
        value: strip_prefix(val ?? "", parsed.pattern, parsed.longest),
        uncertain: valueUncertain,
        provenance: expanded.provenance
      };
    case "removeSuffix":
      return {
        value: strip_suffix(val ?? "", parsed.pattern, parsed.longest),
        uncertain: valueUncertain,
        provenance: expanded.provenance
      };
    case "replace":
      return {
        value: replace_pattern(val ?? "", parsed.pattern, parsed.replacement),
        uncertain: valueUncertain,
        provenance: expanded.provenance
      };
  }
}
function expandParameterOperatorWord(word, env, context) {
  let uncertain = false;
  const provenance = [];
  const tracedContext = collectExpansionProvenance(context, provenance);
  const expanded = expand_dollar(
    word,
    env,
    (value) => {
      uncertain ||= value;
    },
    tracedContext
  );
  return {
    value: string_quote_removal(expanded),
    uncertain,
    provenance: normalizeProvenance5(provenance)
  };
}
function parameterValue(name, env, context) {
  const reference = parse_array_reference(name);
  if (!reference) {
    const value = env.get_string_value(name);
    return {
      value: value ?? "",
      uncertain: env.is_value_uncertain(name),
      isSet: value !== void 0,
      provenance: env.get_value_provenance(name)
    };
  }
  if (reference.subscript === "@" || reference.subscript === "*") {
    const expanded = env.get_array_values(reference.name);
    const separator = (env.get_string_value("IFS") ?? " 	\n")[0] ?? "";
    return {
      value: expanded.values.map((element2) => element2.value).join(separator),
      uncertain: expanded.uncertain || expanded.values.some((element2) => element2.uncertain) || expanded.values.length > 1,
      isSet: expanded.values.length > 0,
      provenance: expanded.provenance
    };
  }
  const resolved = resolve_array_element(
    reference,
    env,
    (subscript) => expandArraySubscript(subscript, env, context)
  );
  if (resolved.key === null) {
    return {
      value: `<unknown:${reference.name}[${reference.subscript}]>`,
      uncertain: true,
      isSet: true,
      provenance: env.get_array_provenance(reference.name)
    };
  }
  const element = env.get_array_element(reference.name, resolved.key);
  if (element.value === void 0 && element.uncertain) {
    return {
      value: `<unknown:${reference.name}[${resolved.key}]>`,
      uncertain: true,
      isSet: true,
      provenance: normalizeProvenance5([
        ...resolved.provenance,
        ...element.provenance
      ])
    };
  }
  return {
    value: element.value ?? "",
    uncertain: resolved.uncertain || element.uncertain,
    isSet: element.value !== void 0,
    provenance: normalizeProvenance5([
      ...resolved.provenance,
      ...element.provenance
    ])
  };
}
function expandArraySubscript(subscript, env, context) {
  let uncertain = false;
  const provenance = [];
  const tracedContext = collectExpansionProvenance(context, provenance);
  const expanded = expand_dollar(
    subscript,
    env,
    (value) => {
      uncertain ||= value;
    },
    tracedContext
  );
  return {
    word: string_quote_removal(expanded),
    uncertain,
    provenance: normalizeProvenance5(provenance)
  };
}
function parseParameterExpansion(expr) {
  if (expr.length === 0) return null;
  if (expr[0] === "#") {
    const name2 = expr.substring(1);
    return isParameterName(name2) ? { kind: "length", name: name2 } : null;
  }
  const nameEnd = readParameterName(expr, 0);
  if (nameEnd === 0) return null;
  const name = expr.substring(0, nameEnd);
  if (nameEnd === expr.length) return { kind: "value", name };
  let pos = nameEnd;
  let checkNull = false;
  if (expr[pos] === ":" && pos + 1 < expr.length && isColonParameterOperator(expr[pos + 1])) {
    checkNull = true;
    pos++;
  }
  const op = expr[pos];
  const rest = expr.substring(pos + 1);
  if (op === "-") return { kind: "default", name, word: rest, checkNull };
  if (op === "=") return { kind: "assignDefault", name, word: rest, checkNull };
  if (op === "+") return { kind: "alternate", name, word: rest, checkNull };
  if (op === "?") return { kind: "error", name, word: rest, checkNull };
  if (op === "#") {
    const longest = rest[0] === "#";
    const pattern = longest ? rest.substring(1) : rest;
    return { kind: "removePrefix", name, pattern, longest };
  }
  if (op === "%") {
    const longest = rest[0] === "%";
    const pattern = longest ? rest.substring(1) : rest;
    return { kind: "removeSuffix", name, pattern, longest };
  }
  if (op === "/") {
    const split = splitPatternReplacement(rest);
    return { kind: "replace", name, pattern: split.pattern, replacement: split.replacement };
  }
  return null;
}
function readShellName(s, start) {
  if (start >= s.length || !legal_variable_starter(s[start])) return start;
  let pos = start + 1;
  while (pos < s.length && legal_variable_char(s[pos])) pos++;
  return pos;
}
function readParameterName(s, start) {
  if (start >= s.length) return start;
  const c = s[start];
  if (c >= "0" && c <= "9" || c === "?" || c === "!" || c === "$" || c === "#" || c === "@" || c === "*" || c === "-") {
    return start + 1;
  }
  const nameEnd = readShellName(s, start);
  if (nameEnd === start || s[nameEnd] !== "[") return nameEnd;
  let depth = 0;
  let quote = null;
  for (let position = nameEnd; position < s.length; position++) {
    const character = s[position];
    if (character === "\\" && quote !== "'") {
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
    if (character === "[") depth++;
    else if (character === "]") {
      depth--;
      if (depth === 0) return position + 1;
    }
  }
  return nameEnd;
}
function isParameterName(s) {
  return readParameterName(s, 0) === s.length;
}
function isColonParameterOperator(c) {
  return c === "-" || c === "=" || c === "+" || c === "?";
}
function splitPatternReplacement(s) {
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (s[i] === "\\") {
      escaped = true;
      continue;
    }
    if (s[i] === "/") {
      return { pattern: s.substring(0, i), replacement: s.substring(i + 1) };
    }
  }
  return { pattern: s, replacement: "" };
}
function strip_suffix(str, pattern, longest) {
  if (longest) {
    for (let i = 0; i <= str.length; i++) {
      if (glob_match(pattern, str.substring(i))) return str.substring(0, i);
    }
  } else {
    for (let i = str.length; i >= 0; i--) {
      if (glob_match(pattern, str.substring(i))) return str.substring(0, i);
    }
  }
  return str;
}
function strip_prefix(str, pattern, longest) {
  if (longest) {
    for (let i = str.length; i >= 0; i--) {
      if (glob_match(pattern, str.substring(0, i))) return str.substring(i);
    }
  } else {
    for (let i = 0; i <= str.length; i++) {
      if (glob_match(pattern, str.substring(0, i))) return str.substring(i);
    }
  }
  return str;
}
function replace_pattern(str, pattern, replacement) {
  for (let start = 0; start <= str.length; start++) {
    for (let end = start; end <= str.length; end++) {
      if (glob_match(pattern, str.substring(start, end))) {
        return str.substring(0, start) + replacement + str.substring(end);
      }
    }
  }
  return str;
}
function glob_match(pattern, value) {
  const memo = /* @__PURE__ */ new Map();
  const matchAt = (pi, vi) => {
    const key = pi + ":" + vi;
    const cached = memo.get(key);
    if (cached !== void 0) return cached;
    let result;
    if (pi === pattern.length) {
      result = vi === value.length;
    } else if (pattern[pi] === "*") {
      result = false;
      for (let next = vi; next <= value.length; next++) {
        if (matchAt(pi + 1, next)) {
          result = true;
          break;
        }
      }
    } else if (pattern[pi] === "?") {
      result = vi < value.length && matchAt(pi + 1, vi + 1);
    } else if (pattern[pi] === "\\" && pi + 1 < pattern.length) {
      result = vi < value.length && pattern[pi + 1] === value[vi] && matchAt(pi + 2, vi + 1);
    } else {
      result = vi < value.length && pattern[pi] === value[vi] && matchAt(pi + 1, vi + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matchAt(0, 0);
}
function word_split(value, ifs) {
  if (ifs === "") return [value];
  const parts = [];
  let current = "";
  let inWhitespace = false;
  for (const c of value) {
    if (ifs.includes(c)) {
      if (current || !inWhitespace) {
        if (current) parts.push(current);
        current = "";
      }
      inWhitespace = " 	\n".includes(c);
    } else {
      current += c;
      inWhitespace = false;
    }
  }
  if (current) parts.push(current);
  return parts;
}
function quote_expanded_value(val) {
  let out = "";
  for (let i = 0; i < val.length; i++) {
    const c = val.charCodeAt(i);
    if (c === 34 || c === 39 || c === 92) out += "\\";
    out += val[i];
  }
  return out;
}
function string_quote_removal(word) {
  let result = "";
  let i = 0;
  while (i < word.length) {
    if (word[i] === "\\" && i + 1 < word.length) {
      result += word[i + 1];
      i += 2;
    } else if (word[i] === "'") {
      i++;
      while (i < word.length && word[i] !== "'") {
        result += word[i];
        i++;
      }
      i++;
    } else if (word[i] === '"') {
      i++;
      while (i < word.length && word[i] !== '"') {
        if (word[i] === "\\" && i + 1 < word.length) {
          const escaped = word[i + 1];
          if (escaped === "\n") {
            i += 2;
            continue;
          }
          if ('$`"\\'.includes(escaped)) result += escaped;
          else result += `\\${escaped}`;
          i += 2;
        } else {
          result += word[i];
          i++;
        }
      }
      i++;
    } else {
      result += word[i];
      i++;
    }
  }
  return result;
}
function expand_word_internal(word, env, quoted = false, onWarning, context, maxResults = MAX_BRACE_EXPANSION_RESULTS, limitScope = "word") {
  const resultLimit = boundedExpansionLimit(
    maxResults,
    MAX_BRACE_EXPANSION_RESULTS
  );
  let uncertain = false;
  const provenance = [];
  const tracedContext = context ? {
    ...context,
    recordExpansion: (trace) => {
      const id = context.recordExpansion?.(trace);
      if (id !== void 0) provenance.push(id);
      return id;
    }
  } : void 0;
  const braceBudget = {
    limit: Math.min(MAX_BRACE_EXPANSION_RESULTS, resultLimit),
    produced: 0,
    truncated: false
  };
  const braceExpanded = quoted ? [word] : brace_expand(word, braceBudget);
  if (braceExpanded.length !== 1 || braceExpanded[0] !== word) {
    tracedContext?.recordExpansion?.({
      operation: "brace",
      expression: word
    });
  }
  const results = [];
  let resultLimitReached = false;
  for (const w of braceExpanded) {
    if (results.length >= resultLimit) {
      resultLimitReached = true;
      break;
    }
    let expanded = tilde_expand_word(w, env);
    if (expanded !== w) {
      tracedContext?.recordExpansion?.({
        operation: "tilde",
        expression: w,
        parents: env.get_value_provenance("HOME")
      });
    }
    const arrayWords = expandStandaloneArrayWord(
      expanded,
      env,
      quoted,
      uncertain
    );
    if (arrayWords !== null) {
      tracedContext?.recordExpansion?.({
        operation: "array",
        expression: expanded,
        parents: (() => {
          const reference = standaloneArrayReference(expanded, quoted);
          return reference ? env.get_array_provenance(reference.name) : [];
        })()
      });
      const roots = normalizeProvenance5(provenance);
      for (const result of arrayWords) {
        if (results.length >= resultLimit) {
          resultLimitReached = true;
          break;
        }
        results.push({
          ...result,
          provenance: normalizeProvenance5([
            ...result.provenance ?? [],
            ...roots
          ])
        });
      }
      if (resultLimitReached) break;
      continue;
    }
    expanded = expand_dollar(
      expanded,
      env,
      (u) => {
        if (u) uncertain = true;
      },
      tracedContext
    );
    expanded = string_quote_removal(expanded);
    if (!quoted) {
      const ifs = env.get_string_value("IFS") ?? " 	\n";
      const split = word_split(expanded, ifs);
      if (split.length !== 1 || split[0] !== expanded) {
        tracedContext?.recordExpansion?.({
          operation: "word-splitting",
          expression: expanded,
          parents: normalizeProvenance5([
            ...provenance,
            ...env.get_value_provenance("IFS")
          ])
        });
      }
      for (const s of split) {
        if (results.length >= resultLimit) {
          resultLimitReached = true;
          break;
        }
        results.push({
          word: s,
          uncertain,
          provenance: normalizeProvenance5(provenance)
        });
      }
    } else {
      results.push({
        word: expanded,
        uncertain,
        provenance: normalizeProvenance5(provenance)
      });
    }
  }
  if (braceBudget.truncated || resultLimitReached) {
    const scope = braceBudget.truncated && braceBudget.limit === MAX_BRACE_EXPANSION_RESULTS ? "word" : limitScope;
    retainBoundedExpansionRemainder(
      results,
      word,
      braceBudget.truncated ? "brace" : "word",
      scope,
      provenance
    );
    if (scope === "word") {
      const label = braceBudget.truncated ? "brace expansion" : "word expansion";
      const limit = braceBudget.truncated ? braceBudget.limit : resultLimit;
      onWarning?.(`${label} truncated after ${limit} results: ${word}`);
    }
  }
  return results;
}
function expandStandaloneArrayWord(word, env, quoted, inheritedUncertainty) {
  const reference = standaloneArrayReference(word, quoted);
  if (!reference) return null;
  let doubleQuoted = false;
  if (word.startsWith('"') && word.endsWith('"') && word.length >= 2) {
    doubleQuoted = true;
  }
  const expansion = env.get_array_values(reference.name);
  const elements = [...expansion.values];
  if (expansion.uncertain) {
    elements.push({
      value: `<unknown:${reference.name}[@]>`,
      uncertain: true,
      provenance: expansion.provenance
    });
  }
  const baseUncertainty = inheritedUncertainty || expansion.uncertain;
  const ifs = env.get_string_value("IFS") ?? " 	\n";
  if (reference.subscript === "@") {
    if (quoted || doubleQuoted) {
      return elements.map((element) => ({
        word: element.value,
        uncertain: baseUncertainty || element.uncertain,
        noglob: true,
        provenance: element.provenance
      }));
    }
    const words = [];
    for (const element of elements) {
      for (const field of word_split(element.value, ifs)) {
        words.push({
          word: field,
          uncertain: baseUncertainty || element.uncertain,
          provenance: normalizeProvenance5([
            ...element.provenance ?? [],
            ...env.get_value_provenance("IFS")
          ])
        });
      }
    }
    return words;
  }
  const separator = ifs[0] ?? "";
  const joined = elements.map((element) => element.value).join(separator);
  const joinedUncertain = baseUncertainty || elements.some((element) => element.uncertain);
  const provenance = normalizeProvenance5([
    ...expansion.provenance,
    ...env.get_value_provenance("IFS")
  ]);
  if (quoted || doubleQuoted) {
    return [{
      word: joined,
      uncertain: joinedUncertain,
      noglob: true,
      provenance
    }];
  }
  return word_split(joined, ifs).map((field) => ({
    word: field,
    uncertain: joinedUncertain,
    provenance
  }));
}
function standaloneArrayReference(word, quoted) {
  let parameter = word;
  let doubleQuoted = false;
  if (word.startsWith('"') && word.endsWith('"') && word.length >= 2) {
    parameter = word.slice(1, -1);
    doubleQuoted = true;
  } else if (word.startsWith("'") && word.endsWith("'")) {
    return null;
  }
  if (quoted && !doubleQuoted) return null;
  if (!parameter.startsWith("${") || !parameter.endsWith("}")) return null;
  const reference = parse_array_reference(parameter.slice(2, -1));
  if (!reference || reference.subscript !== "@" && reference.subscript !== "*") {
    return null;
  }
  return reference;
}
function expand_dollar(word, env, onUncertain, context, mode = "word") {
  let result = "";
  let i = 0;
  let inDoubleQuote = false;
  while (i < word.length) {
    if (word[i] === "\\" && i + 1 < word.length) {
      result += word[i] + word[i + 1];
      i += 2;
      continue;
    }
    if (mode === "word" && word[i] === "'" && !inDoubleQuote) {
      const end = word.indexOf("'", i + 1);
      if (end === -1) {
        result += word.substring(i);
        break;
      }
      result += word.substring(i, end + 1);
      i = end + 1;
      continue;
    }
    if (mode === "word" && word[i] === '"') {
      inDoubleQuote = !inDoubleQuote;
      result += word[i];
      i++;
      continue;
    }
    if (mode === "word" && !inDoubleQuote && (word[i] === "<" || word[i] === ">") && word[i + 1] === "(") {
      const end = find_matching_paren(word, i + 1);
      if (end !== -1) {
        const script = word.substring(i + 2, end);
        const direction = word[i] === "<" ? "read" : "write";
        context?.recordExpansion?.({
          operation: "process-substitution",
          expression: word.substring(i, end + 1)
        });
        const substitution = context?.processSubstitute?.(script, direction);
        result += protectExpandedValue(
          substitution?.word ?? `<${direction}-process-substitution>`,
          mode
        );
        onUncertain(substitution?.uncertain ?? true);
        i = end + 1;
        continue;
      }
    }
    if (word[i] === "$") {
      if (i + 1 >= word.length) {
        result += "$";
        i++;
        continue;
      }
      if (word[i + 1] === "(" && word[i + 2] === "(") {
        const end = word.indexOf("))", i + 3);
        if (end !== -1) {
          const expr = word.substring(i + 3, end);
          const expanded = expand_dollar(
            expr,
            env,
            onUncertain,
            context,
            mode
          );
          const arith = evaluateArithmeticExpression(expanded, env);
          context?.recordExpansion?.({
            operation: "arithmetic",
            expression: word.substring(i, end + 2),
            parents: arith.provenance
          });
          onUncertain(arith.uncertain);
          result += arith.value === null ? "0" : String(arith.value);
          i = end + 2;
          continue;
        }
      }
      if (word[i + 1] === "(") {
        const end = find_matching_paren(word, i + 1);
        if (end !== -1) {
          const cmd = word.substring(i + 2, end);
          const substitution = context?.commandSubstitute?.(cmd);
          context?.recordExpansion?.({
            operation: "command-substitution",
            expression: word.substring(i, end + 1),
            parents: substitution?.provenance
          });
          result += protectExpandedValue(
            substitution?.word ?? `<$(${cmd})>`,
            mode
          );
          onUncertain(substitution?.uncertain ?? true);
          i = end + 1;
          continue;
        }
      }
      if (word[i + 1] === "{") {
        const end = find_matching_brace(word, i + 1);
        if (end !== -1) {
          const expr = word.substring(i + 2, end);
          const expanded = param_expand(expr, env, context);
          context?.recordExpansion?.({
            operation: "parameter",
            expression: word.substring(i, end + 1),
            parents: expanded.provenance
          });
          onUncertain(expanded.uncertain);
          result += protectExpandedValue(expanded.value, mode);
          i = end + 1;
          continue;
        }
      }
      if (legal_variable_starter(word[i + 1])) {
        let j = i + 1;
        while (j < word.length && legal_variable_char(word[j])) j++;
        const name = word.substring(i + 1, j);
        context?.recordExpansion?.({
          operation: "parameter",
          expression: word.substring(i, j),
          parents: env.get_value_provenance(name)
        });
        const val = env.get_string_value(name);
        if (val !== void 0) {
          result += protectExpandedValue(val, mode);
          onUncertain(env.is_value_uncertain(name));
        } else {
          onUncertain(true);
        }
        i = j;
        continue;
      }
      if ("?!$#@*-".includes(word[i + 1])) {
        const name = word[i + 1];
        context?.recordExpansion?.({
          operation: "parameter",
          expression: word.substring(i, i + 2),
          parents: env.get_value_provenance(name)
        });
        const val = env.get_string_value(name);
        if (val === void 0 && name === "?") {
          result += "<unknown-status>";
          onUncertain(true);
        } else {
          result += protectExpandedValue(val ?? "", mode);
          onUncertain(env.is_value_uncertain(name));
        }
        i += 2;
        continue;
      }
      if (word[i + 1] >= "0" && word[i + 1] <= "9") {
        const name = word[i + 1];
        context?.recordExpansion?.({
          operation: "parameter",
          expression: word.substring(i, i + 2),
          parents: env.get_value_provenance(name)
        });
        const val = env.get_string_value(name);
        result += protectExpandedValue(val ?? "", mode);
        i += 2;
        continue;
      }
      result += "$";
      i++;
      continue;
    }
    if (word[i] === "`") {
      const end = word.indexOf("`", i + 1);
      if (end !== -1) {
        const cmd = word.substring(i + 1, end);
        const substitution = context?.commandSubstitute?.(cmd);
        context?.recordExpansion?.({
          operation: "command-substitution",
          expression: word.substring(i, end + 1),
          parents: substitution?.provenance
        });
        result += protectExpandedValue(
          substitution?.word ?? `<$(${cmd})>`,
          mode
        );
        onUncertain(substitution?.uncertain ?? true);
        i = end + 1;
        continue;
      }
    }
    result += word[i];
    i++;
  }
  return result;
}
function protectExpandedValue(value, mode) {
  return mode === "word" ? quote_expanded_value(value) : value;
}
function find_matching_paren(s, openPos) {
  let closeCandidates = 0;
  let validationBudgetExhausted = false;
  let fallback = -1;
  for (let i = openPos + 1; i < s.length; i++) {
    const character = s[i];
    if (character === "\\") {
      i++;
      continue;
    }
    if (character === ")") {
      closeCandidates++;
      fallback = i;
      const body = s.substring(openPos + 1, i);
      const withinBudget = closeCandidates <= MAX_SHELL_GROUP_CLOSE_CANDIDATES && body.length <= MAX_SHELL_GROUP_PARSE_CHARS;
      if (withinBudget && isCompleteNestedShellBody(body)) {
        return i;
      }
      validationBudgetExhausted ||= !withinBudget;
    }
  }
  return validationBudgetExhausted ? fallback : -1;
}
function isCompleteNestedShellBody(body) {
  if (body.trim().length === 0) return true;
  const parsed = parseComplete(`(${body})`);
  return parsed.ast !== null && parsed.complete && !parsed.warnings.some((warning) => warning.includes("Parse error") || warning.includes("unexpected EOF") || warning.includes("delimited by end-of-file"));
}
function find_matching_brace(s, openPos) {
  let depth = 1;
  for (let i = openPos + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "{") depth++;
    if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function has_unquoted_glob(word) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((c === "*" || c === "?" || c === "[") && !inSingle && !inDouble) {
      return true;
    }
  }
  return false;
}
function expand_words(words, env, options = {}) {
  const maxWords = boundedExpansionLimit(
    options.maxWords,
    MAX_EXPANDED_WORDS
  );
  const results = [];
  let listLimitReached = false;
  for (let index = 0; index < words.length; index++) {
    const wd = words[index];
    if (results.length >= maxWords) {
      listLimitReached = true;
      retainBoundedExpansionRemainder(
        results,
        wd.word,
        "word-list",
        "list",
        []
      );
      break;
    }
    const quoted = !!(wd.flags & W_QUOTED);
    const noglob = !!(wd.flags & (W_QUOTED | W_NOGLOB)) || !has_unquoted_glob(wd.word);
    const remainingWords = words.length - index - 1;
    const reservedWords = Math.min(
      remainingWords,
      Math.max(0, maxWords - results.length - 1)
    );
    const available = Math.max(
      1,
      maxWords - results.length - reservedWords
    );
    const expanded = expand_word_internal(
      wd.word,
      env,
      quoted,
      options.onWarning,
      options.context,
      available,
      "list"
    );
    for (const ew of expanded) {
      if (noglob) ew.noglob = true;
      results.push(ew);
      if (ew.boundedRemainder?.scope === "list") {
        listLimitReached = true;
      }
    }
  }
  if (listLimitReached) {
    options.onWarning?.(
      `word expansion truncated after ${maxWords} words`
    );
  }
  return results;
}
function expand_word_to_string(word, env, onWarning, context) {
  const results = expand_word_internal(word, env, false, onWarning, context);
  if (results.length === 0) return { word: "", uncertain: false };
  if (results.length === 1) return results[0];
  return {
    word: results.map((result) => result.word).join(" "),
    uncertain: true,
    provenance: normalizeProvenance5(
      results.flatMap((result) => result.provenance ?? [])
    )
  };
}
function expand_word_unsplit_to_string(word, env, onWarning, context) {
  const results = expand_word_internal(word, env, true, onWarning, context);
  if (results.length === 0) return { word: "", uncertain: false };
  if (results.length === 1) return results[0];
  return {
    word: results.map((result) => result.word).join(" "),
    uncertain: results.some((result) => result.uncertain),
    noglob: true,
    provenance: normalizeProvenance5(
      results.flatMap((result) => result.provenance ?? [])
    )
  };
}
function expand_here_document(body, env, onWarning, context) {
  let uncertain = body.includes("\\");
  const provenance = [];
  const tracedContext = context ? {
    ...context,
    recordExpansion: (trace) => {
      const id = context.recordExpansion?.(trace);
      if (id !== void 0) provenance.push(id);
      return id;
    }
  } : void 0;
  const expanded = expand_dollar(
    body,
    env,
    (value) => {
      uncertain ||= value;
    },
    tracedContext,
    "here-document"
  );
  if (uncertain) onWarning?.("here-document expansion is not fully resolved");
  return {
    word: expanded,
    uncertain,
    noglob: true,
    provenance: normalizeProvenance5(provenance)
  };
}
function glob_expand_words(words, vfs, cwd, options = {}) {
  if (!vfs) return words;
  const maxWords = Number.isSafeInteger(options.maxWords) && options.maxWords > 0 ? options.maxWords : Number.MAX_SAFE_INTEGER;
  const budget = createGlobExpansionBudget();
  const results = [];
  for (let index = 0; index < words.length; index++) {
    const ew = words[index];
    if (ew.noglob || !has_glob_chars(ew.word)) {
      results.push(ew);
      continue;
    }
    const remainingWords = words.length - index - 1;
    const available = Math.max(
      1,
      maxWords - results.length - remainingWords
    );
    const expansion = glob_expand_bounded(ew.word, cwd, vfs, {
      budget,
      maxMatches: available
    });
    if (expansion.matches.length > 0 || !expansion.complete) {
      const provenance = normalizeProvenance5([
        ...ew.provenance ?? [],
        ...optionalId(options.recordExpansion?.({
          operation: "glob",
          expression: ew.word
        }))
      ]);
      const exactLimit = expansion.complete ? available : Math.max(0, available - 1);
      for (const match of expansion.matches.slice(0, exactLimit)) {
        results.push({
          word: match,
          uncertain: false,
          noglob: true,
          globbed: true,
          provenance
        });
      }
      if (!expansion.complete) {
        results.push({
          ...ew,
          noglob: true,
          globbed: true,
          provenance
        });
        options.onWarning?.(
          `glob expansion widened (${expansion.limitReasons.join(", ")}) for: ${ew.word}`
        );
      }
    } else {
      results.push(ew);
    }
  }
  return results;
}
function retainBoundedExpansionRemainder(results, expression, kind, scope, provenance) {
  const representative = results.pop();
  results.push({
    word: representative?.word ?? expression,
    uncertain: true,
    noglob: true,
    globbed: representative?.globbed,
    boundedRemainder: { kind, expression, scope },
    provenance: normalizeProvenance5([
      ...representative?.provenance ?? [],
      ...provenance
    ])
  });
}
function boundedExpansionLimit(value, fallback) {
  if (value === void 0) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}
function normalizeProvenance5(ids) {
  return [...new Set(ids)].sort((left, right) => left - right).slice(0, MAX_PROVENANCE_PARENTS);
}
function collectExpansionProvenance(context, provenance) {
  if (!context) return void 0;
  return {
    ...context,
    recordExpansion: (trace) => {
      const id = context.recordExpansion?.(trace);
      if (id !== void 0) provenance.push(id);
      return id;
    }
  };
}
function optionalId(id) {
  return id === void 0 ? [] : [id];
}

// src/bash/redir.ts
function WRITE_REDIRECT(ri) {
  return ri === "r_output_direction" || ri === "r_appending_to" || ri === "r_output_force" || ri === "r_err_and_out" || ri === "r_append_err_and_out";
}
function is_write_redirect(r) {
  return WRITE_REDIRECT(r.instruction);
}
function is_append_redirect(r) {
  return r.instruction === "r_appending_to" || r.instruction === "r_append_err_and_out";
}
function redirect_target_filename(r) {
  if (r.redirectee.filename) {
    return r.redirectee.filename.word;
  }
  return null;
}

// src/bash/flags.ts
function default_flags() {
  return {
    errexit: false,
    nounset: false,
    xtrace: false,
    noglob: false,
    noexec: false,
    verbose: false,
    allexport: false,
    notify: false,
    hashall: true,
    privileged: false,
    pipefail: false
  };
}
var FLAG_MAP = {
  "e": "errexit",
  "u": "nounset",
  "x": "xtrace",
  "f": "noglob",
  "n": "noexec",
  "v": "verbose",
  "a": "allexport",
  "b": "notify",
  "h": "hashall",
  "p": "privileged"
};
function apply_set_flag(flags, char, enable) {
  const key = FLAG_MAP[char];
  if (!key) return false;
  flags[key] = enable;
  return true;
}
function apply_set_option(flags, name, enable) {
  if (name === "pipefail") {
    flags.pipefail = enable;
    return true;
  }
  if (name in flags) {
    flags[name] = enable;
    return true;
  }
  return false;
}

// src/bash/invocation.ts
var import_node_path5 = require("node:path");
var DEFAULT_MAX_WRAPPERS = 12;
var SUDO_SHORT_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set(["C", "D", "g", "h", "p", "R", "T", "U", "u", "c", "r", "t"]);
var SUDO_LONG_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "--close-from",
  "--chdir",
  "--group",
  "--host",
  "--prompt",
  "--chroot",
  "--command-timeout",
  "--other-user",
  "--user",
  "--login-class",
  "--role",
  "--type"
]);
var SUDO_SHORT_OPTIONS = /* @__PURE__ */ new Set(["A", "B", "b", "E", "H", "K", "k", "N", "n", "P", "S"]);
var SUDO_LONG_OPTIONS = /* @__PURE__ */ new Set([
  "--askpass",
  "--bell",
  "--background",
  "--preserve-env",
  "--set-home",
  "--remove-timestamp",
  "--reset-timestamp",
  "--no-update",
  "--non-interactive",
  "--preserve-groups",
  "--stdin"
]);
function resolveInvocation(words, options) {
  const cwd = normalizeCwd2(options.cwd);
  const result = {
    originalCommand: words[0],
    args: [],
    cwd,
    envOverlay: /* @__PURE__ */ Object.create(null),
    clearEnvironment: false,
    wrapperChain: [],
    bypassFunctions: false,
    privileged: false,
    completeness: "complete",
    queryOnly: false,
    exitsEarly: false,
    warnings: []
  };
  let current = [...words];
  const maxWrappers = options.maxWrappers ?? DEFAULT_MAX_WRAPPERS;
  while (current.length > 0) {
    const rawCommand = current[0];
    const normalized = normalizeCommandName(rawCommand);
    const wrapperName = asWrapperName(normalized.name);
    if (!wrapperName) {
      result.rawCommand = rawCommand;
      result.commandName = normalized.name;
      result.args = current.slice(1);
      result.identityConfidence = normalized.pathQualified ? "path-basename" : "bare-name";
      if (normalized.pathQualified) result.bypassFunctions = true;
      return result;
    }
    if (result.wrapperChain.length >= maxWrappers) {
      result.completeness = "partial";
      result.warnings.push(`wrapper resolution stopped after ${maxWrappers} layers`);
      return result;
    }
    const parsed = parseWrapper(wrapperName, current.slice(1), result.cwd);
    result.wrapperChain.push({
      name: wrapperName,
      rawCommand,
      privileged: parsed.privileged === true,
      identityConfidence: normalized.pathQualified ? "path-basename" : "bare-name"
    });
    result.bypassFunctions = true;
    result.privileged ||= parsed.privileged === true;
    if (parsed.clearEnvironment) {
      result.clearEnvironment = true;
      for (const key of Object.keys(result.envOverlay)) delete result.envOverlay[key];
    }
    if (parsed.cwd !== void 0) result.cwd = parsed.cwd;
    if (parsed.envOverlay) Object.assign(result.envOverlay, parsed.envOverlay);
    if (parsed.warning) result.warnings.push(parsed.warning);
    if (parsed.completeness) result.completeness = parsed.completeness;
    result.queryOnly ||= parsed.queryOnly === true;
    result.exitsEarly ||= parsed.exitsEarly === true;
    if (!parsed.target || parsed.completeness === "invalid" || parsed.completeness === "partial" || parsed.queryOnly || parsed.exitsEarly) {
      return result;
    }
    current = parsed.target;
  }
  return result;
}
function normalizeCommandName(rawCommand) {
  const slash = Math.max(rawCommand.lastIndexOf("/"), rawCommand.lastIndexOf("\\"));
  let name = slash >= 0 ? rawCommand.slice(slash + 1) : rawCommand;
  if (name.toLowerCase().endsWith(".exe")) name = name.slice(0, -4).toLowerCase();
  return { name, pathQualified: slash >= 0 };
}
function resolveBashCommandString(args) {
  const result = {
    args: [],
    completeness: "complete",
    exitsEarly: false,
    warnings: []
  };
  let wantsCommand = false;
  let i = 0;
  while (i < args.length && args[i].startsWith("--") && args[i] !== "--") {
    const option = args[i];
    if (option === "--help" || option === "--version") {
      result.exitsEarly = true;
      return result;
    }
    if (option === "--init-file" || option === "--rcfile") {
      if (args[i + 1] === void 0) return invalidBashInvocation(result, `${option} requires an operand`);
      i += 2;
      continue;
    }
    if (BASH_LONG_OPTIONS.has(option)) {
      i++;
      continue;
    }
    return partialBashInvocation(result, `unsupported Bash option ${option}`);
  }
  while (i < args.length && (args[i].startsWith("-") || args[i].startsWith("+"))) {
    const option = args[i];
    if (option === "-" || option === "--") {
      i++;
      break;
    }
    let next = i + 1;
    for (const flag of option.slice(1)) {
      if (flag === "c") {
        wantsCommand = true;
        continue;
      }
      if (flag === "o" || flag === "O") {
        if (args[next] !== void 0) next++;
        continue;
      }
      if (!BASH_INVOCATION_FLAGS.has(flag)) {
        return partialBashInvocation(result, `unsupported Bash option ${option[0]}${flag}`);
      }
    }
    i = next;
  }
  if (!wantsCommand) return result;
  if (args[i] === void 0) return invalidBashInvocation(result, "-c requires a command string");
  result.script = args[i];
  result.args = args.length > i + 1 ? args.slice(i + 2) : [];
  return result;
}
var BASH_LONG_OPTIONS = /* @__PURE__ */ new Set([
  "--debug",
  "--debugger",
  "--dump-po-strings",
  "--dump-strings",
  "--login",
  "--noediting",
  "--noprofile",
  "--norc",
  "--posix",
  "--pretty-print",
  "--protected",
  "--restricted",
  "--verbose",
  "--wordexp"
]);
var BASH_INVOCATION_FLAGS = new Set("abefhikmnprstuvxBCEHPTDls");
function invalidBashInvocation(result, warning) {
  result.completeness = "invalid";
  result.warnings.push(`bash: ${warning}`);
  return result;
}
function partialBashInvocation(result, warning) {
  result.completeness = "partial";
  result.warnings.push(`bash: ${warning}`);
  return result;
}
function asWrapperName(name) {
  if (name === "command" || name === "env" || name === "sudo" || name === "exec" || name === "nohup") return name;
  return null;
}
function parseWrapper(name, args, cwd) {
  switch (name) {
    case "command":
      return parseCommand(args);
    case "env":
      return parseEnv(args, cwd);
    case "sudo":
      return parseSudo(args, cwd);
    case "exec":
      return parseExec(args);
    case "nohup":
      return parseNohup(args);
  }
}
function parseCommand(args) {
  let queryOnly = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--help") return { exitsEarly: true };
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg.startsWith("--")) return invalid(`command: unsupported option ${arg}`);
    for (const flag of arg.slice(1)) {
      if (flag === "v" || flag === "V") queryOnly = true;
      else if (flag !== "p") return invalid(`command: unsupported option -${flag}`);
    }
  }
  if (queryOnly) return { queryOnly: true };
  return { target: args.slice(i) };
}
function parseEnv(args, cwd) {
  const envOverlay = /* @__PURE__ */ Object.create(null);
  let clearEnvironment = false;
  let nextCwd = cwd;
  let i = 0;
  for (; i < args.length; ) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-") {
      clearEnvironment = true;
      i++;
      continue;
    }
    if (!arg.startsWith("-")) break;
    if (arg === "--help" || arg === "--version") return { exitsEarly: true };
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const inline = equals < 0 ? void 0 : arg.slice(equals + 1);
      if (name === "--ignore-environment") clearEnvironment = true;
      else if (name === "--null" || name === "--debug" || name === "--list-signal-handling" || name === "--default-signal" || name === "--block-signal" || name === "--ignore-signal") {
      } else if (name === "--split-string") {
        const value = inline ?? args[i + 1];
        if (value === void 0) return invalid("env: missing operand for --split-string");
        return partial("env: --split-string requires its own quoting and expansion grammar");
      } else if (name === "--unset" || name === "--chdir" || name === "--argv0") {
        const value = inline ?? args[++i];
        if (value === void 0) return invalid(`env: missing operand for ${name}`);
        if (name === "--unset") envOverlay[value] = void 0;
        else if (name === "--chdir") nextCwd = resolveCwd(nextCwd, value);
      } else {
        return invalid(`env: unsupported option ${name}`);
      }
      i++;
      continue;
    }
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === "i") {
        clearEnvironment = true;
        continue;
      }
      if (flag === "0" || flag === "v") continue;
      if (flag !== "a" && flag !== "u" && flag !== "C" && flag !== "S") {
        return invalid(`env: unsupported option -${flag}`);
      }
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      if (value === void 0) return invalid(`env: missing operand for -${flag}`);
      if (flag === "S") return partial("env: -S requires its own quoting and expansion grammar");
      if (flag === "u") envOverlay[value] = void 0;
      else if (flag === "C") nextCwd = resolveCwd(nextCwd, value);
      break;
    }
    i++;
  }
  while (i < args.length && isEnvironmentAssignment(args[i])) {
    const equals = args[i].indexOf("=");
    envOverlay[args[i].slice(0, equals)] = args[i].slice(equals + 1);
    i++;
  }
  return { target: args.slice(i), cwd: nextCwd, envOverlay, clearEnvironment };
}
function parseExec(args) {
  let clearEnvironment = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--help") return { exitsEarly: true };
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg.startsWith("--")) return invalid(`exec: unsupported option ${arg}`);
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === "c") {
        clearEnvironment = true;
        continue;
      }
      if (flag === "l") continue;
      if (flag !== "a") return invalid(`exec: unsupported option -${flag}`);
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      if (value === void 0) return invalid("exec: missing operand for -a");
      break;
    }
  }
  return { target: args.slice(i), clearEnvironment };
}
function parseNohup(args) {
  let i = 0;
  if (args[i] === "--") i++;
  else if (args[i] === "--help" || args[i] === "--version") return { exitsEarly: true };
  else if (args[i]?.startsWith("-")) return invalid(`nohup: unsupported option ${args[i]}`);
  if (i >= args.length) return invalid("nohup: missing command operand");
  return { target: args.slice(i) };
}
function parseSudo(args, cwd) {
  const envOverlay = /* @__PURE__ */ Object.create(null);
  let nextCwd = cwd;
  let queryOnly = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg === "--help" || arg === "-h" && i + 1 >= args.length) return { exitsEarly: true, privileged: true };
    if (arg === "--version" || arg === "-V") return { queryOnly: true, privileged: true };
    if (arg === "--remove-timestamp" || arg === "-K") return { queryOnly: true, privileged: true };
    if (arg === "--list" || arg === "--validate" || arg === "-l" || arg === "-v") {
      queryOnly = true;
      continue;
    }
    if (arg === "--edit" || arg === "-e") return { ...partial("sudo: edit mode is not a command wrapper"), privileged: true };
    if (arg === "--login" || arg === "--shell" || arg === "-i" || arg === "-s") {
      return { ...partial(`sudo: ${arg} changes shell invocation semantics`), privileged: true };
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const inline = equals < 0 ? void 0 : arg.slice(equals + 1);
      if (name === "--chroot") return { ...partial("sudo: chroot execution is outside the local-path model"), privileged: true };
      if (SUDO_LONG_OPTIONS_WITH_VALUES.has(name)) {
        const value = inline ?? args[++i];
        if (value === void 0) return { ...invalid(`sudo: missing operand for ${name}`), privileged: true };
        if (name === "--chdir") nextCwd = resolveCwd(nextCwd, value);
        continue;
      }
      if (SUDO_LONG_OPTIONS.has(name)) continue;
      return { ...invalid(`sudo: unsupported option ${name}`), privileged: true };
    }
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const flag = cluster[j];
      if (flag === "l" || flag === "v" || flag === "V") {
        queryOnly = true;
        continue;
      }
      if (flag === "e" || flag === "i" || flag === "s") {
        return { ...partial(`sudo: -${flag} is not a direct command wrapper`), privileged: true };
      }
      if (SUDO_SHORT_OPTIONS.has(flag)) continue;
      if (!SUDO_SHORT_OPTIONS_WITH_VALUES.has(flag)) {
        return { ...invalid(`sudo: unsupported option -${flag}`), privileged: true };
      }
      const attached = cluster.slice(j + 1);
      const value = attached || args[++i];
      if (value === void 0) return { ...invalid(`sudo: missing operand for -${flag}`), privileged: true };
      if (flag === "R") return { ...partial("sudo: chroot execution is outside the local-path model"), privileged: true };
      if (flag === "D") nextCwd = resolveCwd(nextCwd, value);
      break;
    }
  }
  while (i < args.length && isEnvironmentAssignment(args[i])) {
    const equals = args[i].indexOf("=");
    envOverlay[args[i].slice(0, equals)] = args[i].slice(equals + 1);
    i++;
  }
  if (queryOnly) return { queryOnly: true, privileged: true, cwd: nextCwd, envOverlay };
  if (i >= args.length) return { ...invalid("sudo: missing command operand"), privileged: true };
  return { target: args.slice(i), privileged: true, cwd: nextCwd, envOverlay };
}
function invalid(warning) {
  return { completeness: "invalid", warning };
}
function partial(warning) {
  return { completeness: "partial", warning };
}
function isEnvironmentAssignment(value) {
  return value.indexOf("=") > 0;
}
function normalizeCwd2(cwd) {
  const normalized = toPosix(cwd);
  return import_node_path5.posix.normalize(normalized);
}
function resolveCwd(cwd, target) {
  const normalized = toPosix(target);
  return isAbsolutePath(target) ? import_node_path5.posix.normalize(normalized) : import_node_path5.posix.normalize(import_node_path5.posix.join(cwd, normalized));
}

// src/bash/execute_cmd.ts
var fs6 = __toESM(require("node:fs"), 1);
var import_node_path7 = require("node:path");

// src/bash/test_builtin.ts
var import_node_path6 = require("node:path");
function evaluateTestBuiltin(command, rawArgs, vfs, cwd) {
  let args = [...rawArgs];
  if (command === "[") {
    if (args[args.length - 1] !== "]") return exactStatus(2);
    args = args.slice(0, -1);
  }
  return evaluateTestArgs(args, vfs, cwd);
}
function evaluateTestArgs(args, vfs, cwd) {
  if (args.length === 0) return failureStatus();
  if (args[0] === "!") {
    if (args.length === 1) return successStatus();
    return invertStatus(evaluateTestArgs(args.slice(1), vfs, cwd));
  }
  if (args.length === 1) return args[0].length > 0 ? successStatus() : failureStatus();
  if (args.length === 2) {
    const [operator, operand] = args;
    if (operator === "-n") return operand.length > 0 ? successStatus() : failureStatus();
    if (operator === "-z") return operand.length === 0 ? successStatus() : failureStatus();
    return evaluateFileUnary(operator, operand, vfs, cwd);
  }
  if (args.length === 3) {
    const [left, operator, right] = args;
    if (operator === "-a") {
      return left.length > 0 && right.length > 0 ? successStatus() : failureStatus();
    }
    if (operator === "-o") {
      return left.length > 0 || right.length > 0 ? successStatus() : failureStatus();
    }
    return evaluateBinary(left, operator, right);
  }
  return unknownStatus();
}
function evaluateFileUnary(operator, operand, vfs, cwd) {
  if (!["-a", "-e", "-f", "-d", "-h", "-L"].includes(operator)) return unknownStatus();
  if (!vfs) return unknownStatus();
  const posix2 = toPosix(operand);
  const target = isAbsolutePath(operand) ? import_node_path6.posix.normalize(posix2) : import_node_path6.posix.normalize(import_node_path6.posix.join(cwd, posix2));
  if (operator === "-a" || operator === "-e") return boolStatus(vfs.exists(target));
  if (operator === "-f") return boolStatus(vfs.isFile(target));
  if (operator === "-d") return boolStatus(vfs.isDirectory(target));
  return boolStatus(vfs.isSymbolicLink(target));
}
function evaluateBinary(left, operator, right) {
  if (operator === "=" || operator === "==") return boolStatus(left === right);
  if (operator === "!=") return boolStatus(left !== right);
  if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) {
    const lhs = parseInteger(left);
    const rhs = parseInteger(right);
    if (lhs === null || rhs === null) return exactStatus(2);
    if (operator === "-eq") return boolStatus(lhs === rhs);
    if (operator === "-ne") return boolStatus(lhs !== rhs);
    if (operator === "-lt") return boolStatus(lhs < rhs);
    if (operator === "-le") return boolStatus(lhs <= rhs);
    if (operator === "-gt") return boolStatus(lhs > rhs);
    return boolStatus(lhs >= rhs);
  }
  return unknownStatus();
}
function parseInteger(value) {
  if (!/^[+-]?[0-9]+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
function boolStatus(value) {
  return value ? successStatus() : exactStatus(1);
}

// src/bash/execute_cmd.ts
var MAX_NESTED_SCRIPT_DEPTH = 4;
var MAX_EVAL_SCRIPT_CHARS = 64 * 1024;
var MAX_SOURCE_SCRIPT_BYTES = 128 * 1024;
var MAX_SOURCE_PATH_CHARS = 16 * 1024;
var MAX_SOURCE_PATH_ENTRIES = 64;
var MAX_PROCESS_SUBSTITUTIONS = 64;
var MAX_PROCESS_SUBSTITUTION_SCRIPT_CHARS = 64 * 1024;
var MAX_COMMAND_SUBSTITUTION_SCRIPT_CHARS = 64 * 1024;
var MAX_EXEC_STATEMENTS = 1e4;
var MAX_FUNCTION_CALL_DEPTH = 64;
var EXECUTION_GUARD_REASONS = /* @__PURE__ */ new Set([
  "conditional-branch",
  "case-branch",
  "and-or-branch",
  "unknown-loop-count",
  "uncertain-loop-values",
  "pipeline-race",
  "background-race",
  "unknown-command"
]);
function execute_command_state(cmd, state) {
  if (state.runtime.alternatives.length > 0) {
    return executeAcrossShellStates(cmd, state);
  }
  return executeCommandConcrete(cmd, state);
}
function executeCommandConcrete(cmd, state, ignoreAsync = false, countStep = true) {
  return state.tracker.withProvenance({
    kind: "ast-command",
    label: describeAstCommand(cmd),
    line: cmd.line
  }, () => executeCommandConcreteTraced(
    cmd,
    state,
    ignoreAsync,
    countStep
  ));
}
function executeCommandConcreteTraced(cmd, state, ignoreAsync, countStep) {
  if (state.control.kind !== "none") return state.lastStatus;
  const before = state.tracker.checkpoint();
  const inheritedUncertainty = [...state.runtime.pathUncertainty];
  const asynchronous = !ignoreAsync && (cmd.flags & CMD_AMPERSAND) !== 0;
  const savedFds = asynchronous ? null : cloneIoState(state.io).fds;
  let status;
  if (countStep && !enterExecutionStep(state)) {
    status = unknownStatus();
  } else if (asynchronous) {
    status = executeBackgroundCommand(cmd, state);
  } else if (!collect_redirect_effects(cmd.redirects, state)) {
    status = failureStatus();
  } else {
    status = dispatchCommand(cmd, state);
  }
  if (!asynchronous && cmd.flags & CMD_INVERT_RETURN && (state.control.kind === "none" || state.runtime.alternatives.length > 0)) {
    status = invertAlternativeStatuses(state, status);
  }
  const result = setLastStatus(state, status);
  if (inheritedUncertainty.length > 0) {
    state.tracker.markInheritedExecutionUncertaintyFrom(
      before,
      inheritedUncertainty
    );
  }
  if (savedFds) restoreFileDescriptors(state, savedFds);
  return result;
}
function describeAstCommand(cmd) {
  switch (cmd.type) {
    case "simple": {
      const words = [...cmd.assignments, ...cmd.words].map((word) => word.word).join(" ");
      return words || "redirect-only simple command";
    }
    case "arith":
      return `(( ${cmd.expression.word} ))`;
    case "cond":
      return "[[ conditional expression ]]";
    case "function_def":
      return `function ${cmd.name.word}`;
    default:
      return `${cmd.type} command`;
  }
}
function dispatchCommand(cmd, state) {
  const { env } = state;
  let status;
  switch (cmd.type) {
    case "simple":
      status = execute_simple_command(cmd, state);
      break;
    case "for":
      status = execute_for_command(cmd, state);
      break;
    case "case":
      status = execute_case_command(cmd, state);
      break;
    case "while":
      status = execute_while_command(cmd, state);
      break;
    case "until":
      status = execute_until_command(cmd, state);
      break;
    case "if":
      status = execute_if_command(cmd, state);
      break;
    case "connection":
      status = execute_connection(cmd, state);
      break;
    case "function_def":
      register_function(cmd, env);
      status = successStatus();
      break;
    case "group":
      status = execute_group_command(cmd, state);
      break;
    case "subshell":
      status = execute_subshell(cmd, state);
      break;
    case "arith":
      status = execute_arith_command(cmd, state);
      break;
    case "cond":
      status = execute_cond_command(cmd, state);
      break;
  }
  return status;
}
function executeAcrossShellStates(cmd, state) {
  const before = state.tracker.checkpoint();
  const inputs = takeShellStates(state);
  const outputs = [];
  const pathIdentities = [];
  for (const input of inputs) {
    restoreShellState(state, input);
    state.runtime.alternatives = [];
    if (input.control.kind !== "none") {
      pathIdentities.push(emptyEffectIdentities());
      outputs.push(input);
      continue;
    }
    const pathBefore = state.tracker.checkpoint();
    executeCommandConcrete(cmd, state);
    pathIdentities.push(state.tracker.identitiesFrom(pathBefore));
    outputs.push(...takeShellStates(state));
  }
  state.tracker.deduplicateAllFrom(before);
  const commonIdentities = intersectEffectIdentities(pathIdentities);
  const executionGuardReasons = isDirectLeafEffectCommand(cmd, inputs) ? new Set(
    inputs.flatMap((input) => input.pathUncertainty).filter((reason) => EXECUTION_GUARD_REASONS.has(reason))
  ) : /* @__PURE__ */ new Set();
  state.tracker.removeExecutionUncertaintyFrom(
    before,
    commonIdentities,
    [...executionGuardReasons]
  );
  const retainedUncertainty = commonPathUncertainty(
    inputs.map((input) => input.pathUncertainty)
  ).filter((reason) => reason !== "pipeline-race" && reason !== "background-race");
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      retainedUncertainty,
      state.tracker
    )
  );
}
function isDirectLeafEffectCommand(cmd, inputs) {
  if (cmd.type !== "simple") return false;
  const commandName = cmd.words[0]?.word;
  if (commandName && inputs.some((input) => input.env.functions.has(commandName))) {
    return false;
  }
  return cmd.redirects !== null || commandName !== void 0 && COMMAND_HANDLERS.has(commandName);
}
function invertAlternativeStatuses(state, fallback) {
  if (state.runtime.alternatives.length === 0) {
    return setLastStatus(state, invertStatus(fallback));
  }
  const outputs = [];
  for (const snapshot of takeShellStates(state)) {
    restoreShellState(state, snapshot);
    if (snapshot.control.kind === "none") {
      setLastStatus(state, invertStatus(snapshot.lastStatus));
    }
    outputs.push(captureShellState(state));
  }
  return installShellStates(state, outputs);
}
function execute_simple_command(cmd, state) {
  const { env } = state;
  state.runtime.lastCommandSubstitutionStatus = null;
  const expanded = expandSimpleCommandWords(cmd, state);
  const hasCommand = expanded.length > 0;
  const temporaryAssignments = cmd.assignments.length > 0 && hasCommand ? env.snapshot_variables(cmd.assignments.map((a) => assignment_base_name(a.word))) : null;
  for (const a of cmd.assignments) {
    const target = assignment_name(a.word);
    const rawValue = assignment_value(a.word);
    const value = expand_word_unsplit_to_string(
      rawValue,
      env,
      expansionWarning(state),
      expansionContext(state)
    );
    applyShellAssignment(
      target,
      assignment_operator(a.word),
      value,
      state
    );
  }
  if (!hasCommand) {
    return state.runtime.lastCommandSubstitutionStatus ?? successStatus();
  }
  try {
    return execute_simple_command_body(cmd, state, expanded);
  } finally {
    if (temporaryAssignments) {
      mapShellStates(state, () => {
        env.restore_variables(temporaryAssignments);
        return captureShellState(state);
      });
    }
  }
}
function applyShellAssignment(target, operator, value, state) {
  const reference = parse_array_reference(target);
  if (!reference) {
    const previousProvenance = operator === "+=" ? state.env.get_value_provenance(target) : [];
    const assigned2 = operator === "+=" ? (state.env.get_string_value(target) ?? "") + value.word : value.word;
    state.env.bind_variable(
      target,
      assigned2,
      0,
      value.uncertain,
      [...previousProvenance, ...value.provenance ?? []]
    );
    return;
  }
  const resolved = resolve_array_element(
    reference,
    state.env,
    (subscript) => expand_word_unsplit_to_string(
      subscript,
      state.env,
      expansionWarning(state),
      expansionContext(state)
    )
  );
  if (resolved.key === null) {
    state.env.widen_array(
      reference.name,
      resolved.kind,
      [...resolved.provenance, ...value.provenance ?? []]
    );
    return;
  }
  const previous = state.env.get_array_element(reference.name, resolved.key);
  const assigned = operator === "+=" ? (previous.value ?? "") + value.word : value.word;
  state.env.bind_array_element(
    reference.name,
    resolved.key,
    assigned,
    value.uncertain || resolved.uncertain || previous.uncertain,
    resolved.kind,
    [
      ...resolved.provenance,
      ...operator === "+=" ? previous.provenance : [],
      ...value.provenance ?? []
    ]
  );
}
function execute_cond_command(cmd, state) {
  return execute_cond_node(cmd.expression, state);
}
function execute_arith_command(cmd, state) {
  const expanded = expand_word_unsplit_to_string(
    cmd.expression.word,
    state.env,
    expansionWarning(state),
    expansionContext(state)
  );
  const evaluated = evaluateArithmeticExpression(expanded.word, state.env);
  if (expanded.uncertain || evaluated.uncertain || evaluated.value === null) {
    warnOnce(
      state,
      `arithmetic-command-${cmd.line}`,
      `arithmetic command at line ${cmd.line} widened to unknown`
    );
    return unknownStatus();
  }
  return conditional_boolean_status(evaluated.value !== 0n);
}
function execute_cond_node(node, state) {
  let status;
  if (node.type === COND_AND || node.type === COND_OR) {
    status = execute_cond_logical(node, state);
  } else if (node.type === COND_EXPR && node.left) {
    status = execute_cond_node(node.left, state);
  } else if (node.type === COND_UNARY) {
    status = evaluate_cond_unary(node, state);
  } else if (node.type === COND_BINARY) {
    status = evaluate_cond_binary(node, state);
  } else if (node.type === COND_TERM) {
    const value = expand_cond_word(node.op, state);
    status = value.uncertain ? unknownStatus() : conditional_boolean_status(value.word.length > 0);
    setLastStatus(state, status);
  } else if (node.type === COND_UNKNOWN) {
    status = execute_unknown_cond(node, state);
  } else {
    status = unknownStatus();
    setLastStatus(state, status);
  }
  if ((node.flags & CMD_INVERT_RETURN) !== 0) {
    return invertAlternativeStatuses(state, status);
  }
  return status;
}
function execute_cond_logical(node, state) {
  const before = state.tracker.checkpoint();
  execute_cond_node(node.left, state);
  const candidates = [];
  for (const input of takeShellStates(state)) {
    if (node.type === COND_AND) {
      if (input.lastStatus.mayFail) {
        candidates.push({
          input,
          entryStatus: failureStatusPart(input.lastStatus),
          executeRight: false,
          route: "skip"
        });
      }
      if (input.lastStatus.maySucceed) {
        candidates.push({
          input,
          entryStatus: successfulStatusPart(input.lastStatus),
          executeRight: true,
          route: "execute"
        });
      }
    } else {
      if (input.lastStatus.maySucceed) {
        candidates.push({
          input,
          entryStatus: successfulStatusPart(input.lastStatus),
          executeRight: false,
          route: "skip"
        });
      }
      if (input.lastStatus.mayFail) {
        candidates.push({
          input,
          entryStatus: failureStatusPart(input.lastStatus),
          executeRight: true,
          route: "execute"
        });
      }
    }
  }
  const retainedUncertainty = commonPathUncertainty(
    candidates.map((candidate) => candidate.input.pathUncertainty)
  );
  const conditional = new Set(candidates.map((candidate) => candidate.route)).size > 1;
  const outputs = [];
  for (const candidate of candidates) {
    const input = conditional ? appendPathUncertainty(candidate.input, "and-or-branch") : candidate.input;
    restoreShellState(state, input);
    state.runtime.alternatives = [];
    setLastStatus(state, candidate.entryStatus);
    if (candidate.executeRight && node.right) {
      execute_cond_node(node.right, state);
    }
    outputs.push(...takeShellStates(state));
  }
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      retainedUncertainty,
      state.tracker
    )
  );
}
function evaluate_cond_unary(node, state) {
  const operator = node.op?.word ?? "";
  const operand = expand_cond_word(node.left?.op ?? null, state);
  let status;
  if (operand.uncertain) {
    status = unknownStatus();
  } else if (operator === "-n") {
    status = conditional_boolean_status(operand.word.length > 0);
  } else if (operator === "-z") {
    status = conditional_boolean_status(operand.word.length === 0);
  } else if (operator === "-v") {
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u.test(operand.word)) {
      status = unknownStatus();
    } else {
      const variable = state.env.find_variable(operand.word);
      status = variable?.uncertain ? unknownStatus() : conditional_boolean_status(variable !== void 0);
    }
  } else if (operator === "-o") {
    const flags = state.flags;
    status = Object.prototype.hasOwnProperty.call(flags, operand.word) ? conditional_boolean_status(flags[operand.word]) : unknownStatus();
  } else {
    status = evaluateTestBuiltin(
      "test",
      [operator, operand.word],
      state.tracker.vfs,
      state.tracker.getCwd()
    );
  }
  setLastStatus(state, status);
  return status;
}
function evaluate_cond_binary(node, state) {
  const operator = node.op?.word ?? "";
  const left = expand_cond_word(node.left?.op ?? null, state);
  const right = expand_cond_word(node.right?.op ?? null, state);
  let status;
  if (left.uncertain || right.uncertain) {
    status = unknownStatus();
  } else if (operator === "=" || operator === "==" || operator === "!=") {
    const matched = match_cond_pattern(
      left.word,
      right.word,
      node.right?.op ?? null
    );
    status = matched === null ? unknownStatus() : conditional_boolean_status(operator === "!=" ? !matched : matched);
  } else if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) {
    status = evaluate_cond_integer_binary(left.word, operator, right.word);
  } else {
    status = unknownStatus();
  }
  setLastStatus(state, status);
  return status;
}
function expand_cond_word(word, state) {
  if (!word) return { word: "", uncertain: true };
  return expand_word_unsplit_to_string(
    word.word,
    state.env,
    expansionWarning(state),
    expansionContext(state)
  );
}
function match_cond_pattern(value, pattern, patternWord) {
  if (!patternWord) return null;
  const quoteMode = conditional_word_quote_mode(patternWord);
  if (quoteMode === "mixed") return null;
  if (quoteMode === "quoted") return value === pattern;
  if (/(^|[^\\])[?*+@!]\(/u.test(patternWord.word) || !hasSupportedCaseBrackets(pattern)) {
    return null;
  }
  return matchCasePattern(pattern, value);
}
function conditional_word_quote_mode(word) {
  if ((word.flags & W_QUOTED) === 0) return "unquoted";
  let quote = null;
  let quoted = false;
  let unquoted = false;
  for (let index = 0; index < word.word.length; index++) {
    const char = word.word[index];
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      quoted = true;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (quote === null && char === "\\") {
      quoted = true;
      index++;
      continue;
    }
    if (quote === null) unquoted = true;
    else quoted = true;
  }
  return quoted && unquoted ? "mixed" : quoted ? "quoted" : "unquoted";
}
function evaluate_cond_integer_binary(left, operator, right) {
  const lhs = parse_cond_integer(left);
  const rhs = parse_cond_integer(right);
  if (lhs === null || rhs === null) return unknownStatus();
  if (operator === "-eq") return conditional_boolean_status(lhs === rhs);
  if (operator === "-ne") return conditional_boolean_status(lhs !== rhs);
  if (operator === "-lt") return conditional_boolean_status(lhs < rhs);
  if (operator === "-le") return conditional_boolean_status(lhs <= rhs);
  if (operator === "-gt") return conditional_boolean_status(lhs > rhs);
  return conditional_boolean_status(lhs >= rhs);
}
function conditional_boolean_status(value) {
  return value ? successStatus() : exactStatus(1);
}
function parse_cond_integer(value) {
  if (!/^[+-]?[0-9]+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
function execute_unknown_cond(node, state) {
  const before = state.tracker.checkpoint();
  const parent = captureShellState(state);
  const guarded = appendPathUncertainty(parent, "and-or-branch");
  restoreShellState(state, guarded);
  state.runtime.alternatives = [];
  for (const word of node.words ?? []) expand_cond_word(word, state);
  setLastStatus(state, unknownStatus());
  const expanded = takeShellStates(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  setLastStatus(state, unknownStatus());
  const skipped = captureShellState(state);
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      [skipped, ...expanded],
      parent.pathUncertainty,
      state.tracker
    )
  );
}
function expandSimpleCommandWords(cmd, state) {
  const { tracker, env, flags } = state;
  const expanded0 = limitExpandedWords(
    expand_words(
      cmd.words,
      env,
      {
        maxWords: MAX_EXPANDED_WORDS,
        onWarning: expansionWarning(state),
        context: expansionContext(state)
      }
    ),
    state,
    cmd.line,
    "word expansion"
  );
  const expanded = limitExpandedWords(
    flags.noglob ? expanded0 : glob_expand_words(
      expanded0,
      tracker.vfs,
      tracker.getCwd(),
      {
        maxWords: MAX_EXPANDED_WORDS,
        recordExpansion: (trace) => tracker.addProvenance(expansionProvenance(trace)),
        onWarning: expansionWarning(state)
      }
    ),
    state,
    cmd.line,
    flags.noglob ? "word expansion" : "glob expansion"
  );
  return expanded;
}
function execute_simple_command_body(cmd, state, expanded) {
  const { tracker } = state;
  if (expanded.length === 0) return successStatus();
  const invocation = resolveInvocation(expanded.map((word) => word.word), { cwd: tracker.getCwd() });
  for (const warning of invocation.warnings) {
    tracker.addWarning(`${warning} (line ${cmd.line})`);
  }
  if (invocation.exitsEarly) return successStatus();
  if (invocation.completeness === "invalid") return failureStatus();
  if (invocation.completeness !== "complete" || invocation.queryOnly || !invocation.commandName) {
    return unknownStatus();
  }
  const anyUncertain = expanded.some((w) => w.uncertain);
  const vfsSelectionUncertain = expanded.some((word) => word.globbed) && state.runtime.vfsSelectionUncertainty.length > 0;
  const before = tracker.checkpoint();
  const expansionRoots = [
    ...new Set(expanded.flatMap((word) => word.provenance ?? []))
  ];
  const run = () => executeResolvedInvocation(invocation, state, cmd.line, anyUncertain);
  const status = expansionRoots.length === 0 ? run() : tracker.withProvenance({
    kind: "expansion",
    label: "resolved command arguments",
    line: cmd.line,
    parents: expansionRoots
  }, run);
  if (anyUncertain) {
    tracker.markAllEffectsFrom(before, ["unresolved-expansion"], "unknown");
  }
  if (invocation.identityConfidence === "path-basename" || invocation.wrapperChain.some((frame) => frame.identityConfidence === "path-basename")) {
    tracker.markAllEffectsFrom(before, ["command-identity"], "overapprox");
  }
  if (vfsSelectionUncertain) {
    tracker.markAllEffectsFrom(
      before,
      state.runtime.vfsSelectionUncertainty,
      "overapprox"
    );
  }
  return anyUncertain || vfsSelectionUncertain ? unknownStatus() : status;
}
function executeResolvedInvocation(invocation, state, line, uncertainArguments) {
  const isolatesChild = invocation.wrapperChain.some((frame) => frame.name !== "command");
  if (!isolatesChild) {
    return dispatchResolvedInvocation(invocation, state, line, uncertainArguments);
  }
  return executeWithShellLocalIsolation(state, () => {
    if (invocation.clearEnvironment) state.env.reset_for_child_environment();
    for (const [name, value] of Object.entries(invocation.envOverlay)) {
      if (value === void 0) state.env.unbind_variable(name);
      else state.env.bind_variable(name, value);
    }
    state.tracker.setCwd(invocation.cwd);
    state.env.bind_variable("PWD", invocation.cwd);
    const childState = invocation.privileged && !state.privileged ? { ...state, privileged: true } : state;
    return dispatchResolvedInvocation(invocation, childState, line, uncertainArguments);
  });
}
function dispatchResolvedInvocation(invocation, state, line, uncertainArguments) {
  const { tracker } = state;
  const cmdName = invocation.commandName;
  const args = invocation.args;
  if (!invocation.bypassFunctions) {
    const functionStatus = executeFunction(cmdName, args, state, line);
    if (functionStatus) return functionStatus;
  }
  const allowsShellBuiltins = invocation.identityConfidence === "bare-name" && invocation.wrapperChain.every((frame) => frame.name === "command");
  if (allowsShellBuiltins) {
    const outputBuiltinStatus = executeOutputBuiltin(
      cmdName,
      args,
      state,
      uncertainArguments
    );
    if (outputBuiltinStatus) return outputBuiltinStatus;
  }
  if (allowsShellBuiltins) {
    const builtinStatus = executeStatefulBuiltin(
      cmdName,
      args,
      state,
      line,
      uncertainArguments
    );
    if (builtinStatus) return builtinStatus;
    if ((cmdName === "test" || cmdName === "[") && !uncertainArguments) {
      return evaluateTestBuiltin(cmdName, args, tracker.vfs, tracker.getCwd());
    }
  }
  if (cmdName === "true" || cmdName === ":") return successStatus();
  if (cmdName === "false") return exactStatus(1);
  if (cmdName === "true" || cmdName === "false" || cmdName === ":" || cmdName === "test" || cmdName === "[" || cmdName === "read" || cmdName === "return" || cmdName === "exit" || cmdName === "break" || cmdName === "continue" || cmdName === "shift" || cmdName === "wait" || cmdName === "trap" || cmdName === "touch" || cmdName === "pushd" || cmdName === "popd" || cmdName === "alias" || cmdName === "type" || cmdName === "which" || cmdName === "hash" || cmdName === "builtin" || cmdName === "let" || cmdName === "getopts") {
    return unknownStatus();
  }
  const nestedScript = packageOrMakeScript(cmdName, args, tracker.getCwd());
  if (nestedScript) {
    const nestedStatus = executeNestedScript(nestedScript.script, state, line, nestedScript.label, [], nestedScript.cwd);
    if (cmdName !== "make") return nestedStatus;
  }
  const shellStatus = executeShellCommand(cmdName, args, state, line);
  if (shellStatus) return shellStatus;
  const handler = COMMAND_HANDLERS.get(cmdName);
  if (handler) {
    handler(args, tracker, line, {
      env: state.env.to_record(),
      privileged: state.privileged
    });
    if (cmdName === "tee") emitToFd(state, 1, readFromFd(state, 0));
    else emitUnknownOutputIfRouted(state, cmdName);
    return unknownStatus();
  }
  emitUnknownOutputIfRouted(state, cmdName);
  return unknownStatus();
}
function executeOutputBuiltin(cmdName, args, state, uncertainArguments) {
  if (cmdName === "echo") {
    const output = modelEchoOutput(args, uncertainArguments);
    emitToFd(state, 1, output);
    return successStatus();
  }
  if (cmdName === "printf") {
    if (args[0] === "-v") {
      const name = args[1];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        return failureStatus();
      }
      const output2 = traceStreamFlow(
        state,
        modelPrintfOutput(args.slice(2), uncertainArguments),
        `bind printf output to ${name}`
      );
      if (output2.value.kind === "finite" && output2.value.values.length === 1 && !output2.value.mayBeUnset) {
        state.env.bind_variable(
          name,
          output2.value.values[0],
          0,
          false,
          output2.provenance
        );
        return successStatus();
      }
      state.env.bind_variable(name, "<printf>", 0, true, output2.provenance);
      return unknownStatus();
    }
    const printfArgs = args[0] === "--" ? args.slice(1) : args;
    if (printfArgs.length === 0) return failureStatus();
    const output = modelPrintfOutput(printfArgs, uncertainArguments);
    emitToFd(state, 1, output);
    return output.value.kind === "unknown" ? unknownStatus() : successStatus();
  }
  if (cmdName === "cat") {
    const operands = args.filter((arg) => arg === "-" || !arg.startsWith("-"));
    const output = operands.length === 0 || operands.every((arg) => arg === "-") ? readFromFd(state, 0) : unknownStream("cat-file-content");
    emitToFd(state, 1, output);
    return unknownStatus();
  }
  return null;
}
function modelEchoOutput(args, uncertainArguments) {
  if (uncertainArguments) return unknownStream("echo-arguments");
  let newline = true;
  let index = 0;
  while (index < args.length && /^-[nEe]+$/u.test(args[index])) {
    if (args[index].includes("n")) newline = false;
    if (args[index].includes("e") || args[index].includes("E")) {
      return unknownStream("echo-escape-mode");
    }
    index++;
  }
  const values = args.slice(index);
  if (values.some((value) => value.includes("\\"))) {
    return unknownStream("echo-escape-portability");
  }
  return exactStream(values.join(" ") + (newline ? "\n" : ""));
}
function modelPrintfOutput(args, uncertainArguments) {
  if (uncertainArguments || args.length === 0) {
    return unknownStream("printf-arguments");
  }
  const rendered = renderPrintf(args[0], args.slice(1));
  return rendered === null ? unknownStream("printf-format") : exactStream(rendered);
}
function renderPrintf(format, args) {
  let output = "";
  let argumentIndex = 0;
  while (true) {
    const before = argumentIndex;
    for (let index = 0; index < format.length; index++) {
      const char = format[index];
      if (char === "\\") {
        const escape = decodePrintfEscape(format, index);
        if (!escape) return null;
        output += escape.value;
        index = escape.end;
        continue;
      }
      if (char !== "%") {
        output += char;
        continue;
      }
      if (format[index + 1] === "%") {
        output += "%";
        index++;
        continue;
      }
      const conversion = format[index + 1];
      if (conversion !== "s" && conversion !== "b" && conversion !== "c") {
        return null;
      }
      const value = args[argumentIndex++] ?? "";
      if (conversion === "s") output += value;
      else if (conversion === "c") output += value.slice(0, 1);
      else {
        const decoded = decodePrintfString(value);
        if (decoded === null) return null;
        output += decoded;
      }
      index++;
    }
    if (output.length > DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT) return null;
    if (argumentIndex >= args.length || argumentIndex === before) break;
  }
  return output;
}
function decodePrintfString(value) {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\") {
      output += value[index];
      continue;
    }
    const escape = decodePrintfEscape(value, index);
    if (!escape) return null;
    output += escape.value;
    index = escape.end;
  }
  return output;
}
function decodePrintfEscape(value, slashIndex) {
  const code = value[slashIndex + 1];
  if (code === void 0) return null;
  const simple = {
    "\\": "\\",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    E: "\x1B",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "	",
    v: "\v"
  };
  if (code in simple) return { value: simple[code], end: slashIndex + 1 };
  if (code === "0") {
    const digits = value.slice(slashIndex + 2).match(/^[0-7]{1,3}/u)?.[0] ?? "";
    return {
      value: String.fromCodePoint(Number.parseInt(digits || "0", 8)),
      end: slashIndex + 1 + digits.length
    };
  }
  if (code === "x") {
    const digits = value.slice(slashIndex + 2).match(/^[0-9a-fA-F]{1,2}/u)?.[0];
    if (!digits) return null;
    return {
      value: String.fromCodePoint(Number.parseInt(digits, 16)),
      end: slashIndex + 1 + digits.length
    };
  }
  return { value: code, end: slashIndex + 1 };
}
function executeFunction(cmdName, args, state, line) {
  const func = state.env.find_function(cmdName);
  if (!func) return null;
  if (state.runtime.functionDepth >= MAX_FUNCTION_CALL_DEPTH) {
    warnOnce(state, `function-depth:${cmdName}`, `${cmdName} at line ${line} skipped after function call depth ${MAX_FUNCTION_CALL_DEPTH}`);
    return unknownStatus();
  }
  const inheritedUncertainty = [...state.runtime.pathUncertainty];
  state.runtime.functionDepth++;
  state.env.push_var_context(cmdName);
  state.env.set_positional_params(args);
  try {
    const fallbackStatus = execute_command_state(func.body, state);
    if (state.runtime.alternatives.length === 0) {
      setLastStatus(state, fallbackStatus);
    }
    const outputs = [];
    for (const outcome of takeShellStates(state)) {
      restoreShellState(state, outcome);
      if (outcome.control.kind === "return") {
        state.control = normalControl();
        setLastStatus(state, outcome.control.status);
      }
      state.env.pop_var_context();
      outputs.push(captureShellState(state));
    }
    return installShellStates(
      state,
      collapseEquivalentShellStates(
        outputs,
        inheritedUncertainty,
        state.tracker
      )
    );
  } finally {
    state.runtime.functionDepth--;
  }
}
function executeStatefulBuiltin(cmdName, args, state, line, uncertainArguments) {
  const { tracker, env, flags } = state;
  if (cmdName === "break" || cmdName === "continue") {
    return executeLoopControlBuiltin(cmdName, args, state, uncertainArguments);
  }
  if (cmdName === "return") {
    if (state.runtime.functionDepth === 0 && state.runtime.sourceDepth === 0) {
      return exactStatus(2);
    }
    const status = controlTransferStatus(args, state.lastStatus, uncertainArguments);
    state.control = { kind: "return", status };
    return status;
  }
  if (cmdName === "exit") {
    const status = controlTransferStatus(args, state.lastStatus, uncertainArguments);
    state.control = { kind: "exit", status };
    return status;
  }
  if (cmdName === "read") {
    return executeReadBuiltin(args, state, uncertainArguments);
  }
  if (cmdName === "cd") {
    if (args.length > 0) {
      const dir = args[0];
      if (dir === "-") {
        const oldpwd = env.get_string_value("OLDPWD") ?? tracker.getCwd();
        const current = env.get_string_value("PWD") ?? tracker.getCwd();
        env.bind_variable("OLDPWD", current);
        env.bind_variable("PWD", oldpwd);
        tracker.setCwd(oldpwd);
      } else {
        const current = env.get_string_value("PWD") ?? tracker.getCwd();
        env.bind_variable("OLDPWD", current);
        const resolved = isAbsolutePath(dir) ? toPosix(dir) : tracker.resolvePath(dir);
        env.bind_variable("PWD", resolved);
        tracker.setCwd(resolved);
      }
    }
    return unknownStatus();
  }
  if (cmdName === "export") {
    for (const arg of args) {
      if (arg.includes("=")) env.bind_variable(assignment_name(arg), assignment_value(arg));
    }
    return successStatus();
  }
  if (cmdName === "local" || cmdName === "declare" || cmdName === "typeset") {
    const arrayKind = declarationArrayKind(args);
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const target = arg.includes("=") ? assignment_name(arg) : arg;
      const reference = parse_array_reference(target);
      if (arrayKind || reference) {
        env.declare_array(
          reference?.name ?? target,
          arrayKind ?? "indexed",
          true
        );
        if (arg.includes("=")) {
          applyShellAssignment(
            target,
            assignment_operator(arg),
            {
              word: assignment_value(arg),
              uncertain: uncertainArguments
            },
            state
          );
        }
      } else if (arg.includes("=")) {
        env.make_local_variable(target, assignment_value(arg), uncertainArguments);
      } else {
        env.make_local_variable(arg, "");
      }
    }
    return successStatus();
  }
  if (cmdName === "readonly") {
    for (const arg of args) {
      if (arg.includes("=")) env.bind_variable(assignment_name(arg), assignment_value(arg));
    }
    return successStatus();
  }
  if (cmdName === "unset") return successStatus();
  if (cmdName === "set") {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--") break;
      if (arg === "-o" || arg === "+o") {
        const enable = arg[0] === "-";
        if (i + 1 < args.length) {
          apply_set_option(flags, args[i + 1], enable);
          i += 2;
          continue;
        }
      }
      if (arg.startsWith("-") || arg.startsWith("+")) {
        const enable = arg[0] === "-";
        for (let j = 1; j < arg.length; j++) apply_set_flag(flags, arg[j], enable);
      }
      i++;
    }
    return successStatus();
  }
  if (cmdName === "source" || cmdName === ".") {
    return executeSourceBuiltin(args, state, line, uncertainArguments);
  }
  if (cmdName === "eval") {
    return executeEvalBuiltin(args, state, line, uncertainArguments);
  }
  return null;
}
function declarationArrayKind(args) {
  let kind = null;
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    for (const flag of arg.slice(1)) {
      if (flag === "a") kind = "indexed";
      if (flag === "A") kind = "associative";
    }
  }
  return kind;
}
function executeSourceBuiltin(args, state, line, uncertainArguments) {
  if (uncertainArguments) {
    warnOnce(
      state,
      `source-unresolved:${line}`,
      `source at line ${line} has unresolved arguments; sourced effects were not analyzed`
    );
    return unknownStatus();
  }
  const invocation = parseSourceInvocation(args);
  if (!invocation) return exactStatus(2);
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      `source-depth:${line}`,
      `source at line ${line} skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`
    );
    return unknownStatus();
  }
  const resolved = resolveSourceScript(invocation, state);
  if (resolved.kind === "missing") {
    warnOnce(
      state,
      `source-missing:${line}:${invocation.filename}`,
      `source at line ${line} could not read ${resolved.path ?? invocation.filename}`
    );
    return exactStatus(1);
  }
  if (resolved.kind === "unknown") {
    warnOnce(
      state,
      `source-unavailable:${line}:${invocation.filename}:${resolved.reason}`,
      `source at line ${line} was not analyzed${resolved.path ? ` from ${resolved.path}` : ""}: ${resolved.reason}`
    );
    return unknownStatus();
  }
  if (resolved.script.length === 0) return successStatus();
  const parsed = parse(resolved.script);
  if (parsed.warnings.length > 0) {
    warnOnce(
      state,
      `source-parse:${line}:${resolved.path}`,
      `source ${resolved.path} at line ${line} produced ${parsed.warnings.length} parser warning(s); details omitted`
    );
  }
  if (!parsed.ast) return unknownStatus();
  const caller = captureShellState(state);
  const savedPositional = invocation.args.length > 0 ? state.env.snapshot_source_positional_params(invocation.args.length) : null;
  if (savedPositional) {
    state.env.set_source_positional_params(invocation.args);
  }
  const before = state.tracker.checkpoint();
  const warningStart = state.tracker.warnings.length;
  const warningKeysBefore = new Set(state.runtime.warnings);
  state.nestedDepth++;
  state.runtime.sourceDepth++;
  try {
    execute_command_state(parsed.ast, state);
  } finally {
    state.runtime.sourceDepth--;
    state.nestedDepth--;
  }
  const nestedWarningCount = state.tracker.warnings.length - warningStart;
  state.runtime.warnings = warningKeysBefore;
  if (nestedWarningCount > 0) {
    state.tracker.warnings.splice(warningStart, nestedWarningCount);
    warnOnce(
      state,
      `source-inner-warning:${line}:${resolved.path}`,
      `source ${resolved.path} produced ${nestedWarningCount} analyzer warning(s); details omitted`
    );
  }
  const outcomes = [];
  for (const outcome of takeShellStates(state)) {
    restoreShellState(state, outcome);
    state.runtime.alternatives = [];
    if (state.control.kind === "return") {
      const returnStatus = state.control.status;
      state.control = normalControl();
      setLastStatus(state, returnStatus);
    }
    if (savedPositional) {
      state.env.restore_variables(savedPositional);
    }
    outcomes.push(captureShellState(state));
  }
  if (parsed.warnings.length === 0) {
    return installShellStates(
      state,
      collapseEquivalentShellStates(
        outcomes,
        caller.pathUncertainty,
        state.tracker
      )
    );
  }
  state.tracker.markAllEffectsFrom(before, ["unknown-command"], "overapprox");
  const uncertainOutcomes = outcomes.map((outcome) => appendPathUncertainty(outcome, "unknown-command"));
  restoreShellState(state, caller);
  state.runtime.alternatives = [];
  setLastStatus(state, unknownStatus());
  uncertainOutcomes.push(
    appendPathUncertainty(captureShellState(state), "unknown-command")
  );
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      uncertainOutcomes,
      caller.pathUncertainty,
      state.tracker
    )
  );
}
function parseSourceInvocation(args) {
  let searchPath;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (arg === "-p") {
      if (args[index + 1] === void 0) return null;
      searchPath = args[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("-p") && arg.length > 2) {
      searchPath = arg.slice(2);
      index++;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return null;
    break;
  }
  const filename = args[index];
  if (filename === void 0) return null;
  return {
    filename,
    args: args.slice(index + 1),
    ...searchPath === void 0 ? {} : { searchPath }
  };
}
function resolveSourceScript(invocation, state) {
  const { filename } = invocation;
  if (filename.length > MAX_SOURCE_PATH_CHARS) {
    return { kind: "unknown", reason: `source filename exceeds ${MAX_SOURCE_PATH_CHARS} characters` };
  }
  const vfs = state.tracker.vfs;
  if (!vfs) {
    return { kind: "unknown", reason: "filesystem contents are unavailable" };
  }
  if (isAbsolutePath(filename) || filename.includes("/") || filename.includes("\\")) {
    return readSourceCandidate(state.tracker.resolvePath(filename), state);
  }
  let pathValue = invocation.searchPath;
  const explicitPath = pathValue !== void 0;
  if (!explicitPath) {
    if (state.env.is_value_uncertain("PATH")) {
      return { kind: "unknown", reason: "PATH is unresolved" };
    }
    pathValue = state.env.get_string_value("PATH");
  }
  if (pathValue !== void 0 && pathValue.length > MAX_SOURCE_PATH_CHARS) {
    return { kind: "unknown", reason: `source search path exceeds ${MAX_SOURCE_PATH_CHARS} characters` };
  }
  const entries = pathValue === void 0 ? [] : pathValue.length === 0 ? ["."] : pathValue.split(":");
  const truncated = entries.length > MAX_SOURCE_PATH_ENTRIES;
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries.slice(0, MAX_SOURCE_PATH_ENTRIES)) {
    const directory = resolveSourcePathEntry(entry, state);
    if (directory === null) {
      return { kind: "unknown", reason: `source search entry ${entry} is unresolved` };
    }
    const candidate = state.tracker.resolvePath(import_node_path7.posix.join(directory, filename));
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const result = readSourceCandidate(candidate, state);
    if (result.kind === "ready" || result.kind === "unknown") return result;
  }
  if (truncated) {
    return {
      kind: "unknown",
      reason: `source search stopped after ${MAX_SOURCE_PATH_ENTRIES} PATH entries`
    };
  }
  if (explicitPath) return { kind: "missing" };
  const cwdCandidate = state.tracker.resolvePath(filename);
  if (seen.has(cwdCandidate)) return { kind: "missing", path: cwdCandidate };
  return readSourceCandidate(cwdCandidate, state);
}
function resolveSourcePathEntry(entry, state) {
  const value = entry.length === 0 ? "." : entry;
  if (!value.startsWith("~")) return value;
  if (value !== "~" && !value.startsWith("~/")) return null;
  if (state.env.is_value_uncertain("HOME")) return null;
  const home = state.env.get_string_value("HOME");
  if (!home) return null;
  return value === "~" ? home : import_node_path7.posix.join(home, value.slice(2));
}
function readSourceCandidate(candidate, state) {
  const result = state.tracker.vfs.readTextFile(
    candidate,
    MAX_SOURCE_SCRIPT_BYTES
  );
  if (result.kind === "text") {
    return { kind: "ready", path: candidate, script: result.text };
  }
  if (result.reason === "missing" || result.reason === "directory" || result.reason === "unreadable") {
    return { kind: "missing", path: candidate };
  }
  const reasons = {
    "special-file": "path is a non-regular file and was not read",
    "overlay-content-unknown": "predicted file contents are unknown",
    "too-large": `file exceeds the ${MAX_SOURCE_SCRIPT_BYTES}-byte source budget`,
    "not-utf8": "file is not valid UTF-8 text",
    "nul-byte": "file contains NUL bytes",
    "changed-during-read": "file changed while it was being read"
  };
  return { kind: "unknown", path: candidate, reason: reasons[result.reason] };
}
function executeEvalBuiltin(args, state, line, uncertainArguments) {
  if (uncertainArguments) {
    warnOnce(
      state,
      `eval-unresolved:${line}`,
      `eval at line ${line} has unresolved arguments; nested effects were not analyzed`
    );
    return unknownStatus();
  }
  let words = args;
  if (words[0] === "--") {
    words = words.slice(1);
  } else if (words[0]?.startsWith("-") && words[0] !== "-") {
    return exactStatus(2);
  }
  if (words.length === 0) return successStatus();
  const script = words.join(" ");
  if (script.length === 0) return successStatus();
  if (script.length > MAX_EVAL_SCRIPT_CHARS) {
    warnOnce(
      state,
      `eval-size:${line}`,
      `eval at line ${line} skipped because its expanded input exceeds ${MAX_EVAL_SCRIPT_CHARS} characters`
    );
    return unknownStatus();
  }
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      `eval-depth:${line}`,
      `eval at line ${line} skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`
    );
    return unknownStatus();
  }
  const parsed = parse(script);
  for (const warning of parsed.warnings) {
    warnOnce(
      state,
      `eval-parse:${line}:${warning}`,
      `eval at line ${line}: ${warning}`
    );
  }
  if (!parsed.ast) return unknownStatus();
  const fallback = parsed.warnings.length > 0 ? captureShellState(state) : null;
  const before = state.tracker.checkpoint();
  state.nestedDepth++;
  let status;
  try {
    status = execute_command_state(parsed.ast, state);
  } finally {
    state.nestedDepth--;
  }
  if (!fallback) return status;
  state.tracker.markAllEffectsFrom(before, ["unknown-command"], "overapprox");
  const outcomes = takeShellStates(state).map((outcome) => appendPathUncertainty(outcome, "unknown-command"));
  restoreShellState(state, fallback);
  state.runtime.alternatives = [];
  setLastStatus(state, unknownStatus());
  outcomes.push(appendPathUncertainty(captureShellState(state), "unknown-command"));
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outcomes,
      fallback.pathUncertainty,
      state.tracker
    )
  );
}
function executeReadBuiltin(args, state, uncertainArguments) {
  const names = [];
  let raw = false;
  let supported = !uncertainArguments;
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (options && arg === "-r") raw = true;
    else if (options && arg.startsWith("-")) supported = false;
    else names.push(arg);
  }
  const targets = names.length > 0 ? names : ["REPLY"];
  const input = readFromFd(state, 0);
  if (!supported || input.value.kind === "unknown" || input.value.values.length !== 1) {
    for (const name of targets) {
      state.env.bind_variable(
        name,
        "<stdin>",
        0,
        true,
        input.provenance
      );
    }
    return unknownStatus();
  }
  const source = input.value.values[0];
  const newline = source.indexOf("\n");
  const line = newline >= 0 ? source.slice(0, newline) : source;
  if (!raw && line.includes("\\")) {
    for (const name of targets) {
      state.env.bind_variable(
        name,
        "<stdin>",
        0,
        true,
        input.provenance
      );
    }
    return unknownStatus();
  }
  bindReadLine(state, targets, line, input.provenance);
  return newline >= 0 ? successStatus() : exactStatus(1);
}
function bindReadLine(state, targets, line, provenance) {
  if (targets.length === 1 && targets[0] === "REPLY") {
    state.env.bind_variable(targets[0], line, 0, false, provenance);
    return;
  }
  const ifs = state.env.get_string_value("IFS") ?? " 	\n";
  const fieldProvenance = [
    ...provenance,
    ...state.env.get_value_provenance("IFS")
  ];
  const fields = ifs.length === 0 ? [line] : line.trim().length === 0 ? [] : line.trim().split(new RegExp(`[${escapeRegExpClass(ifs)}]+`, "u"));
  for (let index = 0; index < targets.length; index++) {
    const value = index === targets.length - 1 ? fields.slice(index).join(" ") : fields[index] ?? "";
    state.env.bind_variable(
      targets[index],
      value,
      0,
      false,
      fieldProvenance
    );
  }
}
function escapeRegExpClass(value) {
  return value.replace(/[\\\]^-]/gu, "\\$&");
}
function executeLoopControlBuiltin(kind, args, state, uncertainArguments) {
  if (state.runtime.loopDepth === 0) return successStatus();
  if (uncertainArguments) {
    const base = captureShellState(state);
    const outputs = [];
    const retainedDepth = Math.min(state.runtime.loopDepth, MAX_SHELL_PATHS - 1);
    for (let levels2 = 1; levels2 <= retainedDepth; levels2++) {
      restoreShellState(state, base);
      const status2 = successStatus();
      state.control = { kind, levels: levels2 };
      setLastStatus(state, status2);
      outputs.push(captureShellState(state));
    }
    if (state.runtime.loopDepth > retainedDepth) {
      restoreShellState(state, base);
      const status2 = successStatus();
      state.control = { kind, levels: state.runtime.loopDepth };
      setLastStatus(state, status2);
      outputs.push(captureShellState(state));
    }
    restoreShellState(state, base);
    state.control = normalControl();
    setLastStatus(state, failureStatus());
    outputs.push(captureShellState(state));
    installShellStates(state, outputs);
    return unknownStatus();
  }
  const parsed = parseLoopControlLevels(args[0]);
  if (parsed === null) {
    const status2 = failureStatus();
    state.control = { kind: "exit", status: status2 };
    return status2;
  }
  const levels = parsed <= 0 ? state.runtime.loopDepth : Math.min(parsed, state.runtime.loopDepth);
  const status = parsed <= 0 ? failureStatus() : successStatus();
  state.control = {
    kind: parsed <= 0 ? "break" : kind,
    levels
  };
  return status;
}
function parseLoopControlLevels(value) {
  if (value === void 0) return 1;
  if (!/^[+-]?\d+$/u.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(parsed);
  } catch {
    return null;
  }
}
function controlTransferStatus(args, fallback, uncertainArguments) {
  if (args.length === 0) return fallback;
  if (uncertainArguments || !/^[+-]?\d+$/u.test(args[0])) return unknownStatus();
  try {
    return exactStatus(Number(BigInt(args[0]) & 0xffn));
  } catch {
    return unknownStatus();
  }
}
function executeNestedScript(script, state, line, label, args = [], cwd) {
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    state.tracker.addWarning(`${label} at line ${line} skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`);
    return unknownStatus();
  }
  const parsed = parse(script);
  if (!parsed.ast) {
    for (const warning of parsed.warnings) state.tracker.addWarning(`${label}: ${warning}`);
    return unknownStatus();
  }
  const ast = parsed.ast;
  const before = state.tracker.checkpoint();
  return executeWithShellLocalIsolation(state, () => {
    if (cwd !== void 0) {
      state.tracker.setCwd(cwd);
      state.env.bind_variable("PWD", cwd);
    }
    state.env.functions.clear();
    state.env.reset_positional_params(args);
    state.flags = { ...state.flags };
    state.nestedDepth++;
    try {
      const status = execute_command_state(ast, state);
      state.tracker.markAllEffectsFrom(before, ["unknown-command"], "overapprox");
      for (const warning of parsed.warnings) state.tracker.addWarning(`${label}: ${warning}`);
      return status;
    } finally {
      state.nestedDepth--;
    }
  });
}
function expansionContext(state) {
  const recordExpansion = (trace) => state.tracker.addProvenance(expansionProvenance(trace));
  return {
    recordExpansion,
    commandSubstitute: (script) => state.tracker.withProvenance(
      expansionProvenance({
        operation: "command-substitution",
        expression: `$(${script})`
      }),
      () => executeCommandSubstitution(script, state)
    ),
    processSubstitute: (script, direction) => state.tracker.withProvenance(
      expansionProvenance({
        operation: "process-substitution",
        expression: `${direction === "read" ? "<" : ">"}(${script})`
      }),
      () => executeProcessSubstitution(script, direction, state)
    )
  };
}
function expansionProvenance(trace) {
  return {
    kind: "expansion",
    label: `${trace.operation}: ${trace.expression}`,
    ...trace.parents && trace.parents.length > 0 ? { parents: trace.parents } : {}
  };
}
function executeProcessSubstitution(script, direction, state) {
  if (script.trim().length === 0) return { word: "", uncertain: false };
  state.runtime.processSubstitutionCount++;
  const sequence = state.runtime.processSubstitutionCount;
  const handle = state.tracker.registerEphemeralPath(
    `/dev/fd/${63 + sequence}`
  );
  if (sequence > MAX_PROCESS_SUBSTITUTIONS) {
    warnOnce(
      state,
      "process-substitution-budget",
      `process substitution skipped after ${MAX_PROCESS_SUBSTITUTIONS} expansions`
    );
    return { word: handle, uncertain: true };
  }
  if (script.length > MAX_PROCESS_SUBSTITUTION_SCRIPT_CHARS) {
    warnOnce(
      state,
      "process-substitution-size",
      `process substitution skipped above ${MAX_PROCESS_SUBSTITUTION_SCRIPT_CHARS} characters`
    );
    return { word: handle, uncertain: true };
  }
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      "process-substitution-depth",
      `process substitution skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`
    );
    return { word: handle, uncertain: true };
  }
  const parsed = parse(script);
  if (!parsed.ast) {
    for (const warning of parsed.warnings) {
      state.tracker.addWarning(`process substitution: ${warning}`);
    }
    return { word: handle, uncertain: true };
  }
  const parent = captureShellState(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  if (direction === "read") {
    setFdTarget(state, 1, {
      kind: "unknown",
      reason: "process-substitution-output"
    });
  } else {
    setFdTarget(state, 0, {
      kind: "unknown",
      reason: "process-substitution-input"
    });
  }
  state.control = normalControl();
  state.nestedDepth++;
  try {
    execute_command_state(parsed.ast, state);
  } finally {
    state.nestedDepth--;
  }
  const childOutcomes = takeShellStates(state);
  const vfsOutcomes = [parent, ...childOutcomes];
  const firstVfsKey = vfsOutcomes[0].vfs?.stateKey() ?? "none";
  const commonVfs = vfsOutcomes.every((outcome) => (outcome.vfs?.stateKey() ?? "none") === firstVfsKey);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  if (!commonVfs) {
    state.tracker.setVfs(null);
    state.runtime.vfsSelectionUncertainty = [
      .../* @__PURE__ */ new Set([
        ...state.runtime.vfsSelectionUncertainty,
        "background-race"
      ])
    ];
    warnOnce(
      state,
      "process-substitution-vfs-race",
      "process substitution VFS effects race with the surrounding command"
    );
  }
  for (const warning of parsed.warnings) {
    state.tracker.addWarning(`process substitution: ${warning}`);
  }
  return { word: handle, uncertain: false };
}
function executeCommandSubstitution(script, state) {
  if (script.trim().length === 0) {
    state.runtime.lastCommandSubstitutionStatus = successStatus();
    return { word: "", uncertain: false };
  }
  if (script.length > MAX_COMMAND_SUBSTITUTION_SCRIPT_CHARS) {
    warnOnce(
      state,
      "command-substitution-size",
      `command substitution skipped above ${MAX_COMMAND_SUBSTITUTION_SCRIPT_CHARS} characters`
    );
    state.runtime.lastCommandSubstitutionStatus = unknownStatus();
    return { word: "<$(oversized-command-substitution)>", uncertain: true };
  }
  if (state.nestedDepth >= MAX_NESTED_SCRIPT_DEPTH) {
    warnOnce(
      state,
      "command-substitution-depth",
      `command substitution skipped after nested script depth ${MAX_NESTED_SCRIPT_DEPTH}`
    );
    state.runtime.lastCommandSubstitutionStatus = unknownStatus();
    return { word: `<$(${script})>`, uncertain: true };
  }
  const parsed = parse(script);
  if (!parsed.ast) {
    for (const warning of parsed.warnings) {
      state.tracker.addWarning(`command substitution: ${warning}`);
    }
    state.runtime.lastCommandSubstitutionStatus = unknownStatus();
    return { word: `<$(${script})>`, uncertain: true };
  }
  const parent = captureShellState(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  setFdTarget(state, 1, { kind: "capture" });
  state.io.capture = emptyStream();
  state.control = normalControl();
  state.nestedDepth++;
  try {
    execute_command_state(parsed.ast, state);
  } finally {
    state.nestedDepth--;
  }
  const childOutcomes = takeShellStates(state);
  const status = joinStatuses(
    childOutcomes.map((outcome) => outcome.lastStatus)
  );
  const stdout = joinStreams(
    childOutcomes.map((outcome) => stripTrailingNewlines(outcome.io.capture)),
    "command-substitution-output-join"
  );
  const vfsKey = childOutcomes[0]?.vfs?.stateKey() ?? "none";
  const commonVfs = childOutcomes.every((outcome) => (outcome.vfs?.stateKey() ?? "none") === vfsKey);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  if (commonVfs) {
    state.tracker.setVfs(childOutcomes[0]?.vfs?.clone() ?? null);
  } else {
    state.tracker.setVfs(null);
    state.runtime.vfsSelectionUncertainty = [
      .../* @__PURE__ */ new Set([
        ...state.runtime.vfsSelectionUncertainty,
        "command-substitution"
      ])
    ];
    warnOnce(
      state,
      "command-substitution-vfs-join",
      "command substitution VFS alternatives widened to an unknown selection"
    );
  }
  state.runtime.lastCommandSubstitutionStatus = status;
  for (const warning of parsed.warnings) {
    state.tracker.addWarning(`command substitution: ${warning}`);
  }
  if (stdout.value.kind === "finite" && stdout.value.values.length === 1 && !stdout.value.mayBeUnset) {
    return {
      word: stdout.value.values[0],
      uncertain: false,
      provenance: [...stdout.provenance]
    };
  }
  return {
    word: stdout.value.values.length === 1 ? stdout.value.values[0] : `<$(${script})>`,
    uncertain: true,
    provenance: [...stdout.provenance]
  };
}
function executeShellCommand(cmdName, args, state, line) {
  const base = baseName(cmdName).toLowerCase();
  if (base === "bash" || base === "sh" || base === "zsh") {
    const resolved = resolveBashCommandString(args);
    for (const warning of resolved.warnings) state.tracker.addWarning(`${warning} (line ${line})`);
    if (resolved.script !== void 0) {
      return executeNestedScript(resolved.script, state, line, `${base} -c`, resolved.args);
    }
    return unknownStatus();
  }
  if (base === "cmd" || base === "cmd.exe") {
    const cIndex = args.findIndex((arg) => arg.toLowerCase() === "/c");
    if (cIndex >= 0) {
      return executeNestedScript(args.slice(cIndex + 1).join(" "), state, line, "cmd /c");
    }
  }
  return null;
}
function packageOrMakeScript(cmdName, args, cwd) {
  const base = baseName(cmdName).toLowerCase();
  const packageScript = packageScriptName(base, args);
  if (packageScript) {
    const script = readPackageScript(cwd, packageScript);
    if (script) return { script, label: `${base} run ${packageScript}` };
  }
  if (base === "make") {
    const invocation = parseMakeInvocation(args);
    if (invocation.invalid || invocation.nonExecuting) return null;
    const makeCwd = resolveMakeCwd(cwd, invocation.directories);
    for (const target of invocation.goals) {
      const script = readMakeTarget(makeCwd, target);
      if (script) return { script, label: `make ${target}`, cwd: makeCwd };
    }
  }
  return null;
}
function packageScriptName(command, args) {
  if (command === "npm") {
    if ((args[0] === "run" || args[0] === "run-script") && args[1]) return args[1];
    return null;
  }
  if (command === "pnpm") {
    if (args[0] === "run" && args[1]) return args[1];
    return null;
  }
  if (command === "yarn") {
    if (args[0] === "run" && args[1]) return args[1];
    if (args[0] && !["install", "add", "remove"].includes(args[0]) && !args[0].startsWith("-")) return args[0];
  }
  return null;
}
function readPackageScript(cwd, name) {
  try {
    const pkg = JSON.parse(fs6.readFileSync(toNative(import_node_path7.posix.join(cwd, "package.json")), "utf8"));
    const script = pkg.scripts?.[name];
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}
function readMakeTarget(cwd, target) {
  try {
    const content = fs6.readFileSync(toNative(import_node_path7.posix.join(cwd, "Makefile")), "utf8");
    const lines = content.split(/\r?\n/u);
    const commands = [];
    let inTarget = false;
    for (const line of lines) {
      if (!inTarget) {
        const colon = line.indexOf(":");
        if (colon > 0 && line.slice(0, colon).trim().split(/\s+/u).includes(target)) inTarget = true;
        continue;
      }
      if (line.startsWith("	")) {
        commands.push(line.slice(1));
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) break;
    }
    return commands.length > 0 ? commands.join("\n") : null;
  } catch {
    return null;
  }
}
function baseName(command) {
  const slash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  return slash >= 0 ? command.slice(slash + 1) : command;
}
function execute_for_command(cmd, state) {
  const { tracker, env, flags } = state;
  const expanded0 = limitExpandedWords(
    expand_words(
      cmd.map_list,
      env,
      {
        maxWords: MAX_EXPANDED_WORDS,
        onWarning: expansionWarning(state),
        context: expansionContext(state)
      }
    ),
    state,
    cmd.line,
    "for loop expansion"
  );
  const expanded = limitExpandedWords(
    flags.noglob ? expanded0 : glob_expand_words(
      expanded0,
      tracker.vfs,
      tracker.getCwd(),
      {
        maxWords: MAX_EXPANDED_WORDS,
        recordExpansion: (trace) => tracker.addProvenance(expansionProvenance(trace)),
        onWarning: expansionWarning(state)
      }
    ),
    state,
    cmd.line,
    flags.noglob ? "for loop expansion" : "for loop glob expansion"
  );
  const uncertain = expanded.some((w) => w.uncertain);
  const vfsSelectionUncertain = expanded.some((word) => word.globbed) && state.runtime.vfsSelectionUncertainty.length > 0;
  if (expanded.length === 0 && cmd.map_list.length === 0) {
    const before2 = tracker.checkpoint();
    state.runtime.loopDepth++;
    let status2;
    try {
      status2 = execute_command_state(cmd.action, state);
      finishForLoopControls(state);
    } finally {
      state.runtime.loopDepth--;
    }
    tracker.markAllEffectsFrom(before2, ["uncertain-loop-values"]);
    return status2;
  }
  const before = tracker.checkpoint();
  let status = successStatus();
  state.runtime.loopDepth++;
  try {
    for (const item of expanded) {
      mutateShellStates(state, () => {
        env.bind_variable(
          cmd.name.word,
          item.word,
          0,
          item.uncertain,
          item.provenance
        );
      });
      status = execute_command_state(cmd.action, state);
      consumeCurrentLoopContinues(state);
    }
    finishForLoopControls(state);
  } finally {
    state.runtime.loopDepth--;
  }
  if (uncertain) {
    tracker.markAllEffectsFrom(before, ["uncertain-loop-values"]);
    tracker.addWarning(`for loop at line ${cmd.line} has uncertain iteration values`);
  }
  if (vfsSelectionUncertain) {
    tracker.markAllEffectsFrom(
      before,
      state.runtime.vfsSelectionUncertainty,
      "overapprox"
    );
  }
  return uncertain || vfsSelectionUncertain ? unknownStatus() : status;
}
function consumeCurrentLoopContinues(state) {
  mapShellStates(state, (snapshot) => {
    if (snapshot.control.kind !== "continue" || snapshot.control.levels > 1) {
      return snapshot;
    }
    return withLoopControl(state, snapshot, normalControl());
  });
}
function finishForLoopControls(state) {
  mapShellStates(state, (snapshot) => {
    const control = snapshot.control;
    if (control.kind !== "break" && control.kind !== "continue") return snapshot;
    return withLoopControl(
      state,
      snapshot,
      control.levels <= 1 ? normalControl() : { kind: control.kind, levels: control.levels - 1 }
    );
  });
}
function execute_case_command(cmd, state) {
  const subject = expand_word_unsplit_to_string(
    cmd.word.word,
    state.env,
    expansionWarning(state),
    expansionContext(state)
  );
  const clauses = caseClauses(cmd.clauses);
  const staticPatterns = clauses.map((clause) => clause.patterns.map((pattern) => resolveStaticCasePattern(pattern, state)));
  if (subject.uncertain || staticPatterns.some((patterns) => patterns.some((pattern) => !pattern))) {
    return executeCaseConservatively(cmd, state);
  }
  let clauseIndex = findMatchingCaseClause(
    staticPatterns,
    subject.word,
    0
  );
  let status = successStatus();
  while (clauseIndex >= 0) {
    const clause = clauses[clauseIndex];
    if (clause.action) {
      status = execute_command_state(clause.action, state);
    } else {
      status = successStatus();
      mutateShellStates(state, () => {
        setLastStatus(state, status);
      });
    }
    if ((clause.flags & CASEPAT_FALLTHROUGH) !== 0) {
      clauseIndex = clauseIndex + 1 < clauses.length ? clauseIndex + 1 : -1;
      continue;
    }
    if ((clause.flags & CASEPAT_TESTNEXT) !== 0) {
      clauseIndex = findMatchingCaseClause(
        staticPatterns,
        subject.word,
        clauseIndex + 1
      );
      continue;
    }
    break;
  }
  return status;
}
function caseClauses(head) {
  const clauses = [];
  for (let clause = head; clause; clause = clause.next) clauses.push(clause);
  return clauses;
}
function resolveStaticCasePattern(word, state) {
  const raw = word.word;
  if (/[$`{}]/u.test(raw) || /(^|[^\\])[?*+@!]\(/u.test(raw)) return null;
  if (raw.startsWith("'") && raw.endsWith("'") || raw.startsWith('"') && raw.endsWith('"')) {
    const expanded = expand_word_unsplit_to_string(
      raw,
      state.env,
      expansionWarning(state)
    );
    return expanded.uncertain ? null : { pattern: expanded.word, literal: true };
  }
  if (raw.includes("'") || raw.includes('"') || raw.startsWith("~")) {
    return null;
  }
  if (!hasSupportedCaseBrackets(raw)) return null;
  return { pattern: raw, literal: false };
}
function hasSupportedCaseBrackets(pattern) {
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "\\") {
      index++;
      continue;
    }
    if (pattern[index] !== "[") continue;
    const end = pattern.indexOf("]", index + 1);
    if (end < 0) continue;
    const body = pattern.slice(index + 1, end).replace(/^[!^]/u, "");
    if (body.length === 0 || body.startsWith("]") || body.includes("\\") || body.includes("-") || body.includes("[:") || body.includes("[.") || body.includes("[=")) {
      return false;
    }
    index = end;
  }
  return true;
}
function findMatchingCaseClause(patternsByClause, subject, start) {
  for (let index = start; index < patternsByClause.length; index++) {
    if (patternsByClause[index].some((pattern) => pattern.literal ? pattern.pattern === subject : matchCasePattern(pattern.pattern, subject))) {
      return index;
    }
  }
  return -1;
}
function matchCasePattern(pattern, value) {
  const memo = /* @__PURE__ */ new Map();
  const matchAt = (patternIndex, valueIndex) => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== void 0) return cached;
    let matched;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === "*") {
      matched = matchAt(patternIndex + 1, valueIndex) || valueIndex < value.length && matchAt(patternIndex, valueIndex + 1);
    } else if (pattern[patternIndex] === "?") {
      matched = valueIndex < value.length && matchAt(patternIndex + 1, valueIndex + 1);
    } else if (pattern[patternIndex] === "\\" && patternIndex + 1 < pattern.length) {
      matched = valueIndex < value.length && pattern[patternIndex + 1] === value[valueIndex] && matchAt(patternIndex + 2, valueIndex + 1);
    } else if (pattern[patternIndex] === "[") {
      const bracket = matchCaseBracket(pattern, patternIndex, value[valueIndex]);
      matched = bracket !== null ? valueIndex < value.length && bracket.matches && matchAt(bracket.end + 1, valueIndex + 1) : valueIndex < value.length && pattern[patternIndex] === value[valueIndex] && matchAt(patternIndex + 1, valueIndex + 1);
    } else {
      matched = valueIndex < value.length && pattern[patternIndex] === value[valueIndex] && matchAt(patternIndex + 1, valueIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return matchAt(0, 0);
}
function matchCaseBracket(pattern, start, value) {
  const end = pattern.indexOf("]", start + 1);
  if (end < 0) return null;
  let index = start + 1;
  const negate = pattern[index] === "!" || pattern[index] === "^";
  if (negate) index++;
  let matches = false;
  while (index < end) {
    const first = pattern[index] === "\\" && index + 1 < end ? pattern[++index] : pattern[index];
    matches ||= value === first;
    index++;
  }
  return { matches: negate ? !matches : matches, end };
}
function executeCaseConservatively(cmd, state) {
  const patternEffects = state.tracker.checkpoint();
  let executablePattern = false;
  for (const clause of caseClauses(cmd.clauses)) {
    for (const pattern of clause.patterns) {
      executablePattern ||= pattern.word.includes("$(") || pattern.word.includes("`");
      expand_word_unsplit_to_string(
        pattern.word,
        state.env,
        expansionWarning(state),
        expansionContext(state)
      );
    }
  }
  state.tracker.markAllEffectsFrom(patternEffects, ["case-branch"]);
  if (executablePattern) {
    state.tracker.setVfs(null);
    state.runtime.vfsSelectionUncertainty = [
      .../* @__PURE__ */ new Set([
        ...state.runtime.vfsSelectionUncertainty,
        "case-branch"
      ])
    ];
  }
  const clauses = caseClauses(cmd.clauses);
  if (clauses.length === 0) return successStatus();
  const base = appendPathUncertainty(captureShellState(state), "case-branch");
  const finalOutputs = [
    caseNoMatchSnapshot(state, base)
  ];
  let testNextInputs = [];
  let fallthroughInputs = [];
  const actionEffects = state.tracker.checkpoint();
  for (const clause of clauses) {
    const inputs = boundShellSnapshots(state, [
      base,
      ...testNextInputs,
      ...fallthroughInputs
    ]);
    const clauseOutputs = [];
    for (const input of inputs) {
      restoreShellState(state, input);
      state.runtime.alternatives = [];
      if (input.control.kind !== "none") {
        clauseOutputs.push(input);
      } else if (clause.action) {
        execute_command_state(clause.action, state);
        clauseOutputs.push(...takeShellStates(state));
      } else {
        setLastStatus(state, successStatus());
        clauseOutputs.push(captureShellState(state));
      }
    }
    const normalOutputs = clauseOutputs.filter(
      (output) => output.control.kind === "none"
    );
    finalOutputs.push(...clauseOutputs.filter(
      (output) => output.control.kind !== "none"
    ));
    fallthroughInputs = [];
    if ((clause.flags & CASEPAT_FALLTHROUGH) !== 0) {
      fallthroughInputs = normalOutputs;
    } else if ((clause.flags & CASEPAT_TESTNEXT) !== 0) {
      finalOutputs.push(...normalOutputs);
      testNextInputs = boundShellSnapshots(state, [
        ...testNextInputs,
        ...normalOutputs
      ]);
    } else {
      finalOutputs.push(...normalOutputs);
    }
  }
  finalOutputs.push(...fallthroughInputs);
  state.tracker.deduplicateAllFrom(actionEffects);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      boundShellSnapshots(state, finalOutputs),
      base.pathUncertainty.filter((reason) => reason !== "case-branch"),
      state.tracker
    )
  );
}
function caseNoMatchSnapshot(state, base) {
  restoreShellState(state, base);
  state.runtime.alternatives = [];
  setLastStatus(state, successStatus());
  return captureShellState(state);
}
function boundShellSnapshots(state, snapshots) {
  if (snapshots.length === 0) return [];
  installShellStates(state, snapshots);
  return takeShellStates(state);
}
function execute_while_command(cmd, state) {
  return execute_while_or_until(cmd, state, false);
}
function execute_until_command(cmd, state) {
  return execute_while_or_until(cmd, state, true);
}
function execute_while_or_until(cmd, state, until) {
  const before = state.tracker.checkpoint();
  const outputs = [];
  state.runtime.loopDepth++;
  try {
    execute_command_state(cmd.test, state);
    for (const tested of takeShellStates(state)) {
      if (tested.control.kind !== "none") {
        outputs.push(finishSingleLoopPath(
          state,
          tested,
          successStatus(),
          true
        ));
        continue;
      }
      const status = tested.lastStatus;
      const mayEnter = until ? status.mayFail : status.maySucceed;
      const mayExit = until ? status.maySucceed : status.mayFail;
      if (mayExit) {
        const exitInput = mayEnter ? appendPathUncertainty(tested, "unknown-loop-count") : tested;
        outputs.push(asLoopExit(state, exitInput, successStatus()));
      }
      if (!mayEnter) continue;
      const entryStatus = until ? failureStatusPart(status) : successfulStatusPart(status);
      const bodyInput = appendPathUncertainty(tested, "unknown-loop-count");
      restoreShellState(state, bodyInput);
      state.runtime.alternatives = [];
      state.control = normalControl();
      setLastStatus(state, entryStatus);
      execute_command_state(cmd.action, state);
      for (const bodyOutput of takeShellStates(state)) {
        outputs.push(finishSingleLoopPath(
          state,
          bodyOutput,
          bodyOutput.lastStatus,
          false
        ));
      }
    }
  } finally {
    state.runtime.loopDepth--;
  }
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      commonPathUncertainty(outputs.map((output) => output.pathUncertainty)),
      state.tracker
    )
  );
}
function finishSingleLoopPath(state, snapshot, status, fromTest) {
  const control = snapshot.control;
  if (control.kind === "none") return asLoopExit(state, snapshot, status);
  if (control.kind === "break") {
    if (control.levels <= 1) {
      return asLoopExit(
        state,
        withoutPathUncertainty(snapshot, "unknown-loop-count"),
        status
      );
    }
    return withLoopControl(state, snapshot, {
      kind: control.kind,
      levels: control.levels - 1
    });
  }
  if (control.kind === "continue") {
    if (control.levels <= 1) {
      const resumed = fromTest ? appendPathUncertainty(snapshot, "unknown-loop-count") : snapshot;
      return asLoopExit(state, resumed, status);
    }
    return withLoopControl(state, snapshot, {
      kind: control.kind,
      levels: control.levels - 1
    });
  }
  return snapshot;
}
function withoutPathUncertainty(snapshot, reason) {
  return {
    ...snapshot,
    pathUncertainty: snapshot.pathUncertainty.filter((item) => item !== reason)
  };
}
function asLoopExit(state, snapshot, status) {
  restoreShellState(state, snapshot);
  state.runtime.alternatives = [];
  state.control = normalControl();
  setLastStatus(state, status);
  return captureShellState(state);
}
function withLoopControl(state, snapshot, control) {
  restoreShellState(state, snapshot);
  state.runtime.alternatives = [];
  state.control = control;
  return captureShellState(state);
}
function execute_if_command(cmd, state) {
  execute_command_state(cmd.test, state);
  const thenCandidates = [];
  const elseCandidates = [];
  for (const snapshot of takeShellStates(state)) {
    if (snapshot.lastStatus.maySucceed) {
      thenCandidates.push({
        input: snapshot,
        entryStatus: successfulStatusPart(snapshot.lastStatus),
        action: cmd.true_case,
        route: "then"
      });
    }
    if (snapshot.lastStatus.mayFail) {
      elseCandidates.push({
        input: snapshot,
        entryStatus: failureStatusPart(snapshot.lastStatus),
        action: cmd.false_case,
        resultStatus: successStatus(),
        route: "else"
      });
    }
  }
  return executeGuardedCandidates(
    state,
    [...thenCandidates, ...elseCandidates],
    "conditional-branch"
  );
}
function execute_connection(cmd, state) {
  if (cmd.connector === PIPE || cmd.connector === BAR_AND) {
    return executePipeline(cmd, state);
  }
  if (cmd.connector === AMP) {
    const asyncFirst = (cmd.first.flags & CMD_AMPERSAND) !== 0 ? cmd.first : { ...cmd.first, flags: cmd.first.flags | CMD_AMPERSAND };
    execute_command_state(asyncFirst, state);
    return cmd.second ? execute_command_state(cmd.second, state) : successStatus();
  }
  const firstStatus = execute_command_state(cmd.first, state);
  if (!cmd.second) return firstStatus;
  if (cmd.connector === AND_AND) {
    const candidates = [];
    for (const snapshot of takeShellStates(state)) {
      if (snapshot.lastStatus.mayFail) {
        candidates.push({
          input: snapshot,
          entryStatus: failureStatusPart(snapshot.lastStatus),
          action: null,
          resultStatus: failureStatusPart(snapshot.lastStatus),
          route: "skip"
        });
      }
      if (snapshot.lastStatus.maySucceed) {
        candidates.push({
          input: snapshot,
          entryStatus: successfulStatusPart(snapshot.lastStatus),
          action: cmd.second,
          route: "execute"
        });
      }
    }
    return executeGuardedCandidates(state, candidates, "and-or-branch");
  }
  if (cmd.connector === OR_OR) {
    const candidates = [];
    for (const snapshot of takeShellStates(state)) {
      if (snapshot.lastStatus.maySucceed) {
        candidates.push({
          input: snapshot,
          entryStatus: successfulStatusPart(snapshot.lastStatus),
          action: null,
          resultStatus: successfulStatusPart(snapshot.lastStatus),
          route: "skip"
        });
      }
      if (snapshot.lastStatus.mayFail) {
        candidates.push({
          input: snapshot,
          entryStatus: failureStatusPart(snapshot.lastStatus),
          action: cmd.second,
          route: "execute"
        });
      }
    }
    return executeGuardedCandidates(state, candidates, "and-or-branch");
  }
  return execute_command_state(cmd.second, state);
}
function executePipeline(cmd, state) {
  const parent = captureShellState(state);
  const segments = flattenPipeline(cmd);
  const segmentStatuses = [];
  const filesystemOutcomes = [parent];
  let pipelineInput = null;
  for (const segment of segments) {
    restoreShellState(state, parent);
    state.runtime.alternatives = [];
    if (pipelineInput) {
      setFdTarget(state, 0, { kind: "input", stream: pipelineInput });
    }
    setFdTarget(state, 1, { kind: "capture" });
    state.io.capture = emptyStream();
    const savedSelectionUncertainty = state.runtime.vfsSelectionUncertainty;
    state.runtime.vfsSelectionUncertainty = [
      .../* @__PURE__ */ new Set([...savedSelectionUncertainty, "pipeline-race"])
    ];
    let status2;
    try {
      status2 = executeWithShellLocalIsolation(
        state,
        () => execute_command_state(
          segment.pipeStderr ? withStderrPipeRedirect(segment.command) : segment.command,
          state
        )
      );
    } finally {
      state.runtime.vfsSelectionUncertainty = savedSelectionUncertainty;
    }
    segmentStatuses.push(status2);
    const segmentOutcomes = takeShellStates(state);
    pipelineInput = joinStreams(
      segmentOutcomes.map((outcome) => outcome.io.capture),
      "pipeline-output-join"
    );
    filesystemOutcomes.push(...segmentOutcomes);
    if (filesystemOutcomes.length > MAX_SHELL_PATHS) {
      installShellStates(state, filesystemOutcomes);
      filesystemOutcomes.splice(0, filesystemOutcomes.length, ...takeShellStates(state));
    }
  }
  const status = pipelineStatus(segmentStatuses, parent.flags.pipefail);
  const outputs = restoreParentShellWithFilesystemOutcomes(
    state,
    parent,
    filesystemOutcomes,
    status,
    "pipeline-race",
    pipelineInput ?? emptyStream()
  );
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      parent.pathUncertainty,
      state.tracker
    )
  );
}
function flattenPipeline(command) {
  if (command.type !== "connection" || command.connector !== PIPE && command.connector !== BAR_AND || !command.second) {
    return [{ command, pipeStderr: false }];
  }
  const left = flattenPipeline(command.first);
  const right = flattenPipeline(command.second);
  left[left.length - 1] = {
    ...left[left.length - 1],
    pipeStderr: command.connector === BAR_AND
  };
  return [...left, ...right];
}
function withStderrPipeRedirect(command) {
  const redirect = {
    next: null,
    redirector: { dest: 2, filename: null },
    rflags: 0,
    instruction: "r_duplicating_output",
    redirectee: { dest: 1, filename: null }
  };
  return {
    ...command,
    redirects: appendClonedRedirect(command.redirects, redirect)
  };
}
function appendClonedRedirect(redirects, appended) {
  if (!redirects) return appended;
  const head = {
    ...redirects,
    redirector: { ...redirects.redirector },
    redirectee: {
      ...redirects.redirectee,
      filename: redirects.redirectee.filename ? { ...redirects.redirectee.filename } : null
    },
    next: null
  };
  let source = redirects.next;
  let target = head;
  while (source) {
    target.next = {
      ...source,
      redirector: { ...source.redirector },
      redirectee: {
        ...source.redirectee,
        filename: source.redirectee.filename ? { ...source.redirectee.filename } : null
      },
      next: null
    };
    target = target.next;
    source = source.next;
  }
  target.next = appended;
  return head;
}
function executeBackgroundCommand(cmd, state) {
  const parent = captureShellState(state);
  restoreShellState(state, parent);
  state.runtime.alternatives = [];
  executeCommandConcrete(cmd, state, true, false);
  const childOutcomes = takeShellStates(state);
  const status = successStatus();
  const outputs = restoreParentShellWithFilesystemOutcomes(
    state,
    parent,
    [parent, ...childOutcomes],
    status,
    "background-race"
  );
  installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      parent.pathUncertainty,
      state.tracker
    )
  );
  return status;
}
function restoreParentShellWithFilesystemOutcomes(state, parent, filesystemOutcomes, status, uncertainty, routedOutput) {
  const outputs = [];
  for (const filesystemOutcome of filesystemOutcomes) {
    restoreShellState(state, filesystemOutcome);
    const vfs = state.tracker.vfs?.clone() ?? null;
    state.env.restore(parent.env);
    state.flags = { ...parent.flags };
    state.tracker.setCwd(parent.cwd);
    state.tracker.setVfs(vfs);
    state.control = parent.control;
    state.io = cloneIoState(parent.io);
    if (routedOutput) emitToFd(state, 1, routedOutput);
    else state.io.capture = filesystemOutcome.io.capture;
    state.runtime.pathUncertainty = [
      .../* @__PURE__ */ new Set([
        ...parent.pathUncertainty,
        ...filesystemOutcome.pathUncertainty,
        uncertainty
      ])
    ];
    setLastStatus(state, status);
    outputs.push(captureShellState(state));
  }
  return outputs;
}
function intersectEffectIdentities(identities) {
  if (identities.length === 0) return emptyEffectIdentities();
  return {
    files: intersectSets(identities.map((identity) => identity.files)),
    git: intersectSets(identities.map((identity) => identity.git)),
    resources: intersectSets(identities.map((identity) => identity.resources))
  };
}
function emptyEffectIdentities() {
  return { files: /* @__PURE__ */ new Set(), git: /* @__PURE__ */ new Set(), resources: /* @__PURE__ */ new Set() };
}
function intersectSets(sets) {
  if (sets.length === 0) return /* @__PURE__ */ new Set();
  return new Set([...sets[0]].filter((value) => sets.slice(1).every((set) => set.has(value))));
}
function register_function(cmd, env) {
  env.register_function(cmd.name.word, cmd.command);
}
function execute_group_command(cmd, state) {
  return execute_command_state(cmd.command, state);
}
function execute_subshell(cmd, state) {
  return executeWithShellLocalIsolation(
    state,
    () => execute_command_state(cmd.command, state)
  );
}
function executeGuardedCandidates(state, candidates, uncertainty) {
  const before = state.tracker.checkpoint();
  const retainedUncertainty = commonPathUncertainty(
    candidates.map((candidate) => candidate.input.pathUncertainty)
  );
  const routes = new Set(candidates.map((candidate) => candidate.route));
  const conditional = routes.size > 1;
  const outputs = [];
  for (const candidate of candidates) {
    if (candidate.input.control.kind !== "none") {
      outputs.push(candidate.input);
      continue;
    }
    const input = conditional ? appendPathUncertainty(candidate.input, uncertainty) : candidate.input;
    restoreShellState(state, input);
    state.runtime.alternatives = [];
    setLastStatus(state, candidate.entryStatus);
    if (candidate.action) {
      execute_command_state(candidate.action, state);
    } else {
      setLastStatus(state, candidate.resultStatus ?? candidate.entryStatus);
    }
    outputs.push(...takeShellStates(state));
  }
  state.tracker.deduplicateAllFrom(before);
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      retainedUncertainty,
      state.tracker
    )
  );
}
function mutateShellStates(state, mutate) {
  mapShellStates(state, (snapshot) => {
    if (snapshot.control.kind === "none") mutate();
    return captureShellState(state);
  });
}
function mapShellStates(state, map) {
  const outputs = [];
  for (const snapshot of takeShellStates(state)) {
    restoreShellState(state, snapshot);
    state.runtime.alternatives = [];
    outputs.push(map(snapshot));
  }
  installShellStates(state, outputs);
}
function executeWithShellLocalIsolation(state, execute) {
  const parent = captureShellState(state);
  const fallbackStatus = execute();
  if (state.runtime.alternatives.length === 0) {
    setLastStatus(state, fallbackStatus);
  }
  const childOutcomes = takeShellStates(state);
  const outputs = [];
  for (const child of childOutcomes) {
    restoreShellState(state, child);
    const childVfs = state.tracker.vfs?.clone() ?? null;
    const childStatus = child.lastStatus;
    const childUncertainty = [...child.pathUncertainty];
    const childCapture = child.io.capture;
    state.env.restore(parent.env);
    state.flags = { ...parent.flags };
    state.tracker.setCwd(parent.cwd);
    state.tracker.setVfs(childVfs);
    state.control = normalControl();
    state.io = cloneIoState(parent.io);
    state.io.capture = childCapture;
    state.runtime.pathUncertainty = childUncertainty;
    setLastStatus(state, childStatus);
    outputs.push(captureShellState(state));
  }
  return installShellStates(
    state,
    collapseEquivalentShellStates(
      outputs,
      parent.pathUncertainty,
      state.tracker
    )
  );
}
function commonPathUncertainty(reasons) {
  if (reasons.length === 0) return [];
  return reasons[0].filter((reason) => reasons.slice(1).every((candidate) => candidate.includes(reason)));
}
function setLastStatus(state, status) {
  state.lastStatus = status;
  if (!status.mayHaveOtherFailureCode && status.exactCodes.length === 1) {
    state.env.bind_variable("?", String(status.exactCodes[0]));
  } else {
    state.env.unbind_variable("?");
  }
  return status;
}
function collect_redirect_effects(redir, state) {
  const { tracker, env } = state;
  let r = redir;
  while (r) {
    let expandedTarget = null;
    if (redirectExpandsTarget(r)) {
      const filename = redirect_target_filename(r);
      if (filename !== null) {
        expandedTarget = expand_word_to_string(
          filename,
          env,
          expansionWarning(state),
          expansionContext(state)
        );
        if (expandedTarget.word.length === 0) {
          tracker.addWarning("redirect: empty target");
          return false;
        }
      }
    }
    if (is_write_redirect(r)) {
      if (expandedTarget) {
        if (tracker.isKnownDirectory(expandedTarget.word)) {
          tracker.addWarning(`redirect: ${expandedTarget.word}: Is a directory`);
          return false;
        }
        const effectType = is_append_redirect(r) ? "append" : "write";
        const opSymbol = effectType === "append" ? ">>" : ">";
        tracker.add({
          type: effectType,
          path: expandedTarget.word,
          line: 0,
          // redirect doesn't have its own line
          command: opSymbol,
          uncertain: expandedTarget.uncertain,
          provenance: expandedTarget.provenance
          // Redirect opening below owns truncation/append content semantics.
        }, { updateVfs: false });
      }
    }
    if (!applyFdRedirect(r, expandedTarget, state)) return false;
    r = r.next;
  }
  return true;
}
function redirectExpandsTarget(redir) {
  return redir.instruction === "r_output_direction" || redir.instruction === "r_appending_to" || redir.instruction === "r_input_direction" || redir.instruction === "r_input_output" || redir.instruction === "r_output_force" || redir.instruction === "r_err_and_out" || redir.instruction === "r_append_err_and_out" || redir.instruction === "r_reading_string" || redir.instruction === "r_duplicating_input_word" || redir.instruction === "r_duplicating_output_word" || redir.instruction === "r_move_input_word" || redir.instruction === "r_move_output_word";
}
function applyFdRedirect(redir, expandedTarget, state) {
  const destination = redir.redirector.dest;
  switch (redir.instruction) {
    case "r_output_direction":
    case "r_output_force":
      return setFileFd(state, destination, expandedTarget, "write");
    case "r_appending_to":
      return setFileFd(state, destination, expandedTarget, "append");
    case "r_err_and_out":
    case "r_append_err_and_out": {
      const mode = redir.instruction === "r_append_err_and_out" ? "append" : "write";
      if (!expandedTarget) return false;
      const target = expandedTarget.uncertain ? { kind: "unknown", reason: "redirect-target-expansion" } : makeFileFdTarget(state, expandedTarget.word, mode);
      setFdTarget(state, 1, target);
      setFdTarget(state, 2, target);
      return true;
    }
    case "r_input_direction":
      return setFileFd(state, destination, expandedTarget, "read");
    case "r_input_output":
      return setFileFd(state, destination, expandedTarget, "read-write");
    case "r_reading_until":
    case "r_deblank_reading_until": {
      const body = redir.redirectee.filename?.word ?? "";
      const expanded = redir.here_doc_quoted ? { word: body, uncertain: false } : expand_here_document(
        body,
        state.env,
        expansionWarning(state),
        expansionContext(state)
      );
      const stream = expanded.uncertain ? unknownStream(
        "here-document-expansion",
        expanded.provenance ?? []
      ) : exactStream(
        expanded.word,
        DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
        expanded.provenance ?? []
      );
      setFdTarget(state, destination, { kind: "input", stream });
      return true;
    }
    case "r_reading_string": {
      const stream = expandedTarget && !expandedTarget.uncertain ? exactStream(
        `${expandedTarget.word}
`,
        DEFAULT_ABSTRACT_STREAM_CHAR_LIMIT,
        expandedTarget.provenance ?? []
      ) : unknownStream(
        "here-string-expansion",
        expandedTarget?.provenance ?? []
      );
      setFdTarget(state, destination, { kind: "input", stream });
      return true;
    }
    case "r_close_this":
      setFdTarget(state, destination, { kind: "closed" });
      return true;
    case "r_duplicating_input":
    case "r_duplicating_output":
      duplicateFd(state, destination, redir.redirectee.dest, false);
      return true;
    case "r_move_input":
    case "r_move_output":
      duplicateFd(state, destination, redir.redirectee.dest, true);
      return true;
    case "r_duplicating_input_word":
    case "r_duplicating_output_word":
      return duplicateExpandedFd(state, destination, expandedTarget, false);
    case "r_move_input_word":
    case "r_move_output_word":
      return duplicateExpandedFd(state, destination, expandedTarget, true);
  }
}
function setFileFd(state, destination, target, mode) {
  if (!target) return false;
  const fdTarget = target.uncertain ? { kind: "unknown", reason: "redirect-target-expansion" } : makeFileFdTarget(state, target.word, mode);
  setFdTarget(state, destination, fdTarget);
  return true;
}
function makeFileFdTarget(state, target, mode) {
  const resolved = state.tracker.resolvePath(target);
  if (state.tracker.isEphemeralPath(resolved)) {
    return {
      kind: "unknown",
      reason: "process-substitution-handle"
    };
  }
  if (mode === "write") {
    state.tracker.vfs?.updateTextFile(resolved, "", "truncate");
  } else if (mode === "append" || mode === "read-write") {
    state.tracker.vfs?.updateTextFile(resolved, "", "append");
  }
  return { kind: "file", path: resolved, mode };
}
function duplicateExpandedFd(state, destination, target, move) {
  if (!target) return false;
  if (target.uncertain) {
    setFdTarget(state, destination, {
      kind: "unknown",
      reason: "redirect-fd-expansion"
    });
    return true;
  }
  if (target.word === "-") {
    setFdTarget(state, destination, { kind: "closed" });
    return true;
  }
  if (!/^\d+$/u.test(target.word)) {
    setFdTarget(state, destination, {
      kind: "unknown",
      reason: "redirect-fd-target"
    });
    return false;
  }
  duplicateFd(state, destination, Number.parseInt(target.word, 10), move);
  return true;
}
function duplicateFd(state, destination, source, move) {
  setFdTarget(
    state,
    destination,
    cloneFdTarget(state.io.fds[String(source)] ?? {
      kind: "unknown",
      reason: "unbound-fd"
    }),
    `${move ? "move" : "duplicate"} fd ${source} to fd ${destination}`
  );
  if (move) setFdTarget(state, source, { kind: "closed" });
}
function setFdTarget(state, fd, target, flowLabel) {
  const cloned = cloneFdTarget(target);
  if (cloned.kind === "input") {
    cloned.stream = traceStreamFlow(
      state,
      cloned.stream,
      flowLabel ?? `bind input stream to fd ${fd}`
    );
  }
  state.io.fds[String(fd)] = cloned;
}
function restoreFileDescriptors(state, fds) {
  mapShellStates(state, () => {
    state.io.fds = Object.fromEntries(
      Object.entries(fds).map(([fd, target]) => [fd, cloneFdTarget(target)])
    );
    return captureShellState(state);
  });
}
function readFromFd(state, fd) {
  const target = state.io.fds[String(fd)];
  if (target?.kind === "input") {
    return traceStreamFlow(state, target.stream, `read from fd ${fd}`);
  }
  if (target?.kind === "closed") {
    return traceStreamFlow(state, emptyStream(), `read closed fd ${fd}`);
  }
  const reason = target?.kind === "file" ? "file-input" : target?.kind === "unknown" ? target.reason : "inherited-input";
  return traceStreamFlow(
    state,
    unknownStream(reason),
    `read unknown stream from fd ${fd}`
  );
}
function emitToFd(state, fd, stream) {
  const target = state.io.fds[String(fd)];
  if (target?.kind === "capture") {
    const routed = traceStreamFlow(
      state,
      stream,
      `write fd ${fd} to captured stream`
    );
    state.io.capture = appendStreams(state.io.capture, routed);
  } else if (target?.kind === "file") {
    if (target.mode === "write" || target.mode === "append") {
      state.tracker.vfs?.updateTextFile(
        target.path,
        exactStreamValue(stream),
        "append"
      );
    } else if (target.mode === "read-write") {
      state.tracker.vfs?.updateTextFile(target.path, null, "truncate");
    }
  } else if (target?.kind === "unknown") {
    const routed = traceStreamFlow(
      state,
      stream,
      `write fd ${fd} through unknown route`
    );
    state.io.capture = appendStreams(
      state.io.capture,
      unknownStream(target.reason, routed.provenance),
      "unknown-fd-route"
    );
  }
}
function traceStreamFlow(state, stream, label) {
  const root = state.tracker.addProvenance({
    kind: "stream-flow",
    label,
    ...stream.provenance.length === 0 ? {} : { parents: stream.provenance }
  });
  return {
    ...stream,
    provenance: [root]
  };
}
function exactStreamValue(stream) {
  return stream.value.kind === "finite" && stream.value.values.length === 1 && !stream.value.mayBeUnset ? stream.value.values[0] : null;
}
function emitUnknownOutputIfRouted(state, command) {
  const target = state.io.fds["1"];
  if (target?.kind === "capture" || target?.kind === "unknown" || target?.kind === "file") {
    emitToFd(state, 1, unknownStream(`stdout:${command}`));
  }
}
function enterExecutionStep(state) {
  if (state.runtime.halted) return false;
  state.runtime.statementCount++;
  if (state.runtime.statementCount <= MAX_EXEC_STATEMENTS) return true;
  state.runtime.halted = true;
  warnOnce(state, "statement-budget", `Bash analysis stopped after ${MAX_EXEC_STATEMENTS} commands`);
  return false;
}
function expansionWarning(state) {
  return (warning) => warnOnce(state, `expansion:${warning}`, warning);
}
function limitExpandedWords(words, state, line, context) {
  if (words.length <= MAX_EXPANDED_WORDS) return words;
  warnOnce(state, `expanded-words:${context}:${line}`, `${context} at line ${line} truncated after ${MAX_EXPANDED_WORDS} words`);
  return words.slice(0, MAX_EXPANDED_WORDS).map((word) => ({ ...word, uncertain: true }));
}
function warnOnce(state, key, message) {
  if (state.runtime.warnings.has(key)) return;
  state.runtime.warnings.add(key);
  state.tracker.addWarning(message);
}

// src/bash/index.ts
function analyze(script, opts) {
  const envVars = { ...opts.env, PWD: opts.cwd };
  const env = new VariableEnvironment(envVars, opts.inheritEnv !== false);
  if (opts.args) {
    env.set_positional_params(opts.args);
  }
  const { ast, warnings } = parse(script);
  let vfs;
  if (opts.fs) vfs = new VirtualFS(opts.fs);
  else if (opts.realFs) vfs = new RealFS();
  const tracker = new EffectTracker(opts.cwd, vfs);
  if (ast) {
    const flags = default_flags();
    execute_command_state(ast, makeAnalysisState(env, flags, tracker));
  }
  return {
    effects: tracker.effects,
    gitEffects: tracker.gitEffects,
    resourceEffects: tracker.resourceEffects,
    warnings: [...warnings, ...tracker.warnings],
    ast,
    provenance: tracker.getProvenanceGraph()
  };
}

// src/powershell/index.ts
var import_node_path8 = require("node:path");

// src/powershell/tokenizer.ts
function isWhitespace(c) {
  return c === " " || c === "	" || c === "\r";
}
function isAsciiAlpha(c) {
  if (c.length === 0) return false;
  const code = c.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}
function isAsciiDigit(c) {
  if (c.length === 0) return false;
  const code = c.charCodeAt(0);
  return code >= 48 && code <= 57;
}
function isNameChar(c) {
  return isAsciiAlpha(c) || isAsciiDigit(c) || c === "_" || c === "?" || c === ":";
}
function isBoundary(c) {
  return isWhitespace(c) || c === "\n" || c === ";" || c === "|" || c === ">" || c === "<" || c === "{" || c === "}" || c === "(" || c === ")" || c === ",";
}
function isParameterStart(input, pos) {
  const next = input[pos + 1] ?? "";
  return input[pos] === "-" && (isAsciiAlpha(next) || next === "?");
}
function isVariableStart(input, pos) {
  const next = input[pos + 1] ?? "";
  return input[pos] === "$" && (isAsciiAlpha(next) || next === "_" || next === "{");
}
function isStreamDigit(c) {
  return c >= "1" && c <= "6";
}
function tokenize(script) {
  const tokens = [];
  const warnings = [];
  let i = 0;
  let line = 1;
  const push = (kind, text, tokenLine, quoted = false, expandable = true, literalDollarOffsets) => {
    tokens.push({ kind, text, line: tokenLine, quoted, expandable, literalDollarOffsets });
  };
  while (i < script.length) {
    const c = script[i];
    if (isWhitespace(c)) {
      i++;
      continue;
    }
    if (c === "\n") {
      push("newline", "\n", line);
      line++;
      i++;
      continue;
    }
    if (c === "#") {
      while (i < script.length && script[i] !== "\n") i++;
      continue;
    }
    const tokenLine = line;
    const n1 = script[i + 1] ?? "";
    const n2 = script[i + 2] ?? "";
    if (c === "<" && n1 === "#") {
      i += 2;
      let terminated = false;
      while (i < script.length) {
        if (script[i] === "#" && script[i + 1] === ">") {
          i += 2;
          terminated = true;
          break;
        }
        if (script[i] === "\n") line++;
        i++;
      }
      if (!terminated) warnings.push(`unterminated block comment at line ${tokenLine}`);
      continue;
    }
    if ((c === "*" || isStreamDigit(c)) && n1 === ">" && n2 === "&" && isStreamDigit(script[i + 3] ?? "")) {
      push("operator", script.slice(i, i + 4), tokenLine);
      i += 4;
      continue;
    }
    if (c === "*" && n1 === ">" && n2 === ">") {
      push("operator", "*>>", tokenLine);
      i += 3;
      continue;
    }
    if (isStreamDigit(c) && n1 === ">" && n2 === ">") {
      push("operator", c + n1 + n2, tokenLine);
      i += 3;
      continue;
    }
    if (c === "&" && n1 === "&") {
      push("operator", "&&", tokenLine);
      i += 2;
      continue;
    }
    if (c === "|" && n1 === "|") {
      push("operator", "||", tokenLine);
      i += 2;
      continue;
    }
    if (c === ">" && n1 === ">") {
      push("operator", ">>", tokenLine);
      i += 2;
      continue;
    }
    if (c === "*" && n1 === ">") {
      push("operator", "*>", tokenLine);
      i += 2;
      continue;
    }
    if (isStreamDigit(c) && n1 === ">") {
      push("operator", c + n1, tokenLine);
      i += 2;
      continue;
    }
    if (c === ";" || c === "|" || c === ">" || c === "<" || c === "{" || c === "}" || c === "(" || c === ")" || c === "," || c === "=") {
      push("operator", c, tokenLine);
      i++;
      continue;
    }
    if (c === "@" && (n1 === "'" || n1 === '"')) {
      const quote = n1;
      i += 2;
      while (script[i] === " " || script[i] === "	" || script[i] === "\f" || script[i] === "\v") i++;
      if (script[i] === "\r" && script[i + 1] === "\n") {
        line++;
        i += 2;
      } else if (script[i] === "\n" || script[i] === "\r") {
        line++;
        i++;
      } else {
        warnings.push(`unexpected characters after here-string header at line ${tokenLine}`);
        while (i < script.length && script[i] !== "\r" && script[i] !== "\n") {
          if (script[i] === quote && script[i + 1] === "@") {
            i += 2;
            break;
          }
          i++;
        }
        push("string", "", tokenLine, true, quote === '"');
        continue;
      }
      let text2 = "";
      const literalDollarOffsets2 = [];
      let terminated = false;
      let atLineStart = true;
      while (i < script.length) {
        if (atLineStart && script[i] === quote && script[i + 1] === "@") {
          i += 2;
          terminated = true;
          break;
        }
        const ch = script[i];
        if (quote === '"' && ch === "`" && i + 1 < script.length) {
          const escaped = decodeBacktick(script[i + 1]);
          if (escaped === "$") literalDollarOffsets2.push(text2.length);
          text2 += escaped;
          if (script[i + 1] === "\n") line++;
          atLineStart = script[i + 1] === "\n" || script[i + 1] === "\r";
          i += 2;
          continue;
        }
        if (ch === "\r" && script[i + 1] === "\n") {
          text2 += "\r\n";
          line++;
          i += 2;
          atLineStart = true;
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          line++;
          atLineStart = true;
        } else {
          atLineStart = false;
        }
        text2 += ch;
        i++;
      }
      if (terminated) {
        if (text2.endsWith("\r\n")) text2 = text2.slice(0, -2);
        else if (text2.endsWith("\n") || text2.endsWith("\r")) text2 = text2.slice(0, -1);
      } else {
        warnings.push(`unterminated here-string at line ${tokenLine}`);
      }
      push("string", text2, tokenLine, true, quote === '"', literalDollarOffsets2);
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let text2 = "";
      const literalDollarOffsets2 = [];
      while (i < script.length) {
        const ch = script[i];
        if (ch === "\n") line++;
        if (ch === quote) {
          if (quote === "'" && script[i + 1] === "'") {
            text2 += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (quote === '"' && ch === "`" && i + 1 < script.length) {
          const escaped = decodeBacktick(script[i + 1]);
          if (escaped === "$") literalDollarOffsets2.push(text2.length);
          text2 += escaped;
          i += 2;
          continue;
        }
        text2 += ch;
        i++;
      }
      if (i >= script.length && script[script.length - 1] !== quote) {
        warnings.push(`unterminated ${quote === '"' ? "double" : "single"}-quoted string at line ${tokenLine}`);
      }
      push("string", text2, tokenLine, true, quote === '"', literalDollarOffsets2);
      continue;
    }
    if (isParameterStart(script, i)) {
      let text2 = "";
      while (i < script.length && !isBoundary(script[i])) {
        text2 += script[i++];
      }
      push("parameter", text2, tokenLine, false, true);
      continue;
    }
    if (c === "@" && (script[i + 1] === "{" || script[i + 1] === "(")) {
      const open = script[i + 1];
      const close = open === "{" ? "}" : ")";
      let depth = 0;
      let text2 = "";
      let quote = null;
      while (i < script.length) {
        const ch = script[i];
        text2 += ch;
        if (ch === "\n") line++;
        if (quote) {
          if (quote === "'" && ch === "'" && script[i + 1] === "'") {
            text2 += script[i + 1];
            i += 2;
            continue;
          }
          if (ch === quote) quote = null;
          i++;
          continue;
        }
        if (ch === "'" || ch === '"') {
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
      push("word", text2, tokenLine, false, true);
      continue;
    }
    if (isVariableStart(script, i)) {
      let text2 = script[i++];
      if (script[i] === "{") {
        text2 += script[i++];
        while (i < script.length && script[i] !== "}") {
          text2 += script[i++];
        }
        if (i < script.length) text2 += script[i++];
      } else {
        while (i < script.length && isNameChar(script[i])) {
          text2 += script[i++];
        }
      }
      push("variable", text2, tokenLine, false, true);
      continue;
    }
    let text = "";
    const literalDollarOffsets = [];
    while (i < script.length && !isBoundary(script[i])) {
      if (script[i] === "`" && i + 1 < script.length) {
        const escaped = decodeBacktick(script[i + 1]);
        if (escaped === "$") literalDollarOffsets.push(text.length);
        text += escaped;
        i += 2;
        continue;
      }
      text += script[i++];
    }
    if (text.length > 0) {
      push("word", text, tokenLine, false, true, literalDollarOffsets);
      continue;
    }
    push("operator", c, tokenLine);
    i++;
  }
  push("eof", "", line);
  return { tokens, warnings };
}
function decodeBacktick(value) {
  switch (value) {
    case "0":
      return "\0";
    case "a":
      return "\x07";
    case "b":
      return "\b";
    case "e":
      return "\x1B";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "	";
    case "v":
      return "\v";
    default:
      return value;
  }
}

// src/powershell/parser.ts
function parsePowerShell(script) {
  const { tokens, warnings } = tokenize(script);
  const parser = new Parser2(tokens, warnings);
  return parser.parseScript();
}
var Parser2 = class _Parser {
  constructor(tokens, warnings) {
    this.tokens = tokens;
    this.warnings = warnings;
  }
  tokens;
  warnings;
  pos = 0;
  parseScript() {
    const statements = this.parseStatementList(false);
    return { ast: { type: "script", statements }, warnings: this.warnings };
  }
  parseStatementList(stopOnRightBrace) {
    const statements = [];
    while (!this.at("eof")) {
      this.skipSeparators();
      if (stopOnRightBrace && this.peek().text === "}") break;
      if (this.at("eof")) break;
      const startPos = this.pos;
      const stmt = this.parseStatement();
      if (stmt) statements.push(stmt);
      if (this.pos === startPos) {
        this.warnUnexpectedAndAdvance();
      }
      this.skipSeparators();
    }
    return statements;
  }
  parseStatement() {
    if (this.peek().text === "}") return null;
    if (this.peek().text === ")") return null;
    const keyword = this.peekWordLower();
    if (keyword === "if" || keyword === "elseif" || keyword === "else" || keyword === "foreach" || keyword === "for" || keyword === "while" || keyword === "do" || keyword === "switch" || keyword === "try" || keyword === "catch" || keyword === "finally") {
      return this.parseBlock(keyword);
    }
    if (this.peek().text === "(") return this.parseParenthesizedStatement();
    if (this.peek().text === "{") return this.parseBareScriptBlock();
    return this.parsePipeline("statement");
  }
  parseParenthesizedStatement() {
    const line = this.peek().line;
    const tokens = this.captureBalanced("(", ")");
    const eofLine = tokens[tokens.length - 1]?.line ?? line;
    const inner = new _Parser([
      ...tokens,
      { kind: "eof", text: "", line: eofLine, quoted: false, expandable: false }
    ], this.warnings).parseScript();
    return { type: "block", keyword: "subexpression", body: inner.ast.statements, line, fuzzy: true };
  }
  parseBlock(keyword) {
    const start = this.advance();
    if (keyword === "if") return this.parseIfBlock(start.line);
    if (keyword === "try") return this.parseTryBlock(start.line);
    if (keyword === "do") return this.parseDoBlock(start.line);
    if (keyword === "switch") return this.parseSwitchBlock(start.line);
    let variable;
    let values;
    let conditions;
    if (keyword !== "else" && this.peek().text === "(") {
      const condition = this.captureBalanced("(", ")");
      if (keyword === "foreach") {
        const parsed = this.parseForeachCondition(condition);
        variable = parsed.variable;
        values = parsed.values;
      } else {
        conditions = [this.parseCapturedStatements(condition, start.line)];
      }
    }
    const body = this.peek().text === "{" ? this.parseBraceBody() : [];
    return { type: "block", keyword, body, conditions, variable, values, line: start.line, fuzzy: true };
  }
  parseTryBlock(line) {
    const body = this.peek().text === "{" ? this.parseBraceBody() : [];
    while (true) {
      this.skipSeparators();
      const keyword = this.peekWordLower();
      if (keyword !== "catch" && keyword !== "finally") break;
      this.advance();
      if (this.peek().text === "(") this.skipBalanced("(", ")");
      if (this.peek().text === "{") body.push(...this.parseBraceBody());
    }
    return { type: "block", keyword: "try", body, line, fuzzy: true };
  }
  parseDoBlock(line) {
    const body = this.peek().text === "{" ? this.parseBraceBody() : [];
    let conditions;
    this.skipSeparators();
    const keyword = this.peekWordLower();
    if (keyword === "while" || keyword === "until") {
      this.advance();
      if (this.peek().text === "(") {
        conditions = [this.parseCapturedStatements(this.captureBalanced("(", ")"), line)];
      }
    }
    return { type: "block", keyword: "do", body, conditions, line, fuzzy: true };
  }
  parseSwitchBlock(line) {
    let conditions;
    if (this.peek().text === "(") {
      conditions = [this.parseCapturedStatements(this.captureBalanced("(", ")"), line)];
    }
    const body = [];
    if (this.peek().text !== "{") return { type: "block", keyword: "switch", body, conditions, line, fuzzy: true };
    this.expectOperator("{");
    while (!this.at("eof") && this.peek().text !== "}") {
      this.skipSeparators();
      if (this.peek().text === "{") {
        body.push(...this.parseBraceBody());
      } else {
        this.advance();
      }
    }
    this.expectOperator("}");
    return { type: "block", keyword: "switch", body, conditions, line, fuzzy: true };
  }
  parseIfBlock(line) {
    const conditions = [];
    if (this.peek().text === "(") {
      conditions.push(this.parseCapturedStatements(this.captureBalanced("(", ")"), line));
    }
    const body = this.peek().text === "{" ? this.parseBraceBody() : [];
    while (true) {
      this.skipSeparators();
      const keyword = this.peekWordLower();
      if (keyword === "elseif") {
        const elseif = this.advance();
        if (this.peek().text === "(") {
          conditions.push(this.parseCapturedStatements(this.captureBalanced("(", ")"), elseif.line));
        }
        if (this.peek().text === "{") body.push(...this.parseBraceBody());
        continue;
      }
      if (keyword === "else") {
        this.advance();
        if (this.peek().text === "{") body.push(...this.parseBraceBody());
      }
      break;
    }
    return { type: "block", keyword: "if", body, conditions, line, fuzzy: true };
  }
  parseCapturedStatements(tokens, line) {
    const eofLine = tokens[tokens.length - 1]?.line ?? line;
    return new _Parser([
      ...tokens,
      { kind: "eof", text: "", line: eofLine, quoted: false, expandable: false }
    ], this.warnings).parseScript().ast.statements;
  }
  parseForeachCondition(tokens) {
    let variable;
    const values = [];
    let inValues = false;
    for (const token of tokens) {
      if (!inValues && token.kind === "variable") {
        variable = token.text;
        continue;
      }
      if (!inValues && token.kind === "word" && token.text.toLowerCase() === "in") {
        inValues = true;
        continue;
      }
      if (inValues && this.isCommandElement(token)) {
        values.push(this.wordFrom(token));
      }
    }
    return { variable, values };
  }
  parseBareScriptBlock() {
    const line = this.peek().line;
    return { type: "block", keyword: "scriptblock", body: this.parseBraceBody(), line, fuzzy: true };
  }
  parseBraceBody() {
    this.expectOperator("{");
    const body = this.parseStatementList(true);
    this.expectOperator("}");
    return body;
  }
  parsePipeline(connector) {
    const commands = [];
    const first = this.parseCommand();
    if (!first) return null;
    commands.push(first);
    while (this.peek().text === "|") {
      this.advance();
      const command = this.parseCommand();
      if (command) commands.push(command);
    }
    const line = commands[0]?.line ?? this.peek().line;
    const pipeline = { type: "pipeline", commands, connector, line };
    if (this.peek().text === "&&" || this.peek().text === "||") {
      const op = this.advance().text;
      const next = this.parsePipeline(op === "&&" ? "and" : "or");
      if (next) {
        return {
          type: "pipeline",
          commands: [...pipeline.commands, ...next.commands],
          connector: next.connector,
          line
        };
      }
    }
    return pipeline;
  }
  parseCommand() {
    while (this.peek().text === ",") this.advance();
    const nameToken = this.peek();
    if (!this.isCommandElement(nameToken)) return null;
    const name = this.wordFrom(this.advance());
    const args = [];
    const redirections = [];
    while (!this.at("eof") && !this.isStatementBoundary(this.peek())) {
      const token = this.peek();
      if (this.isMergingRedirectionOperator(token.text)) {
        const op = this.advance();
        redirections.push({ kind: "merge", op: op.text, line: op.line });
        continue;
      }
      if (this.isRedirectionOperator(token.text)) {
        const op = this.advance();
        const target = this.isCommandElement(this.peek()) ? this.wordFrom(this.advance()) : this.emptyWord(op.line);
        redirections.push({ kind: "file", op: op.text, target, line: op.line });
        continue;
      }
      if (token.text === ",") {
        args.push({ text: ",", line: token.line, quoted: false, expandable: false, parameter: false });
        this.advance();
        continue;
      }
      if (this.isCommandElement(token) || token.text === "=") {
        args.push(this.wordFrom(this.advance()));
        continue;
      }
      if (token.text === "(") {
        this.skipBalanced("(", ")");
        args.push({ text: "<expression>", line: token.line, quoted: false, expandable: true, parameter: false });
        continue;
      }
      if (token.text === "{") {
        const scriptBlockBody = this.parseBraceBody();
        args.push({ text: "<scriptblock>", line: token.line, quoted: false, expandable: false, parameter: false, scriptBlockBody });
        continue;
      }
      this.advance();
    }
    return { type: "command", name, args, redirections, line: name.line, fuzzy: false };
  }
  skipBalanced(open, close) {
    this.captureBalanced(open, close);
  }
  captureBalanced(open, close) {
    const tokens = [];
    let depth = 0;
    const start = this.peek();
    while (!this.at("eof")) {
      const t = this.advance();
      if (t.text === open) depth++;
      if (t.text === close) {
        depth--;
        if (depth <= 0) return tokens;
      }
      if (depth > 0 && t.text !== open) {
        tokens.push(t);
      }
    }
    if (depth > 0) this.warnings.push(`expected '${close}' for '${open}' at line ${start.line}`);
    return tokens;
  }
  skipSeparators() {
    while (this.peek().kind === "newline" || this.peek().text === ";") this.advance();
  }
  isStatementBoundary(token) {
    if (token.kind === "newline" || token.kind === "eof") return true;
    return token.text === ";" || token.text === "|" || token.text === "}" || token.text === "&&" || token.text === "||";
  }
  isCommandElement(token) {
    return token.kind === "word" || token.kind === "string" || token.kind === "parameter" || token.kind === "variable";
  }
  isRedirectionOperator(op) {
    if (op === ">" || op === ">>" || op === "*>" || op === "*>>") return true;
    if (op.length === 2 && op[1] === ">" && op[0] >= "1" && op[0] <= "6") return true;
    if (op.length === 3 && op[1] === ">" && op[2] === ">" && op[0] >= "1" && op[0] <= "6") return true;
    return false;
  }
  isMergingRedirectionOperator(op) {
    return op.length === 4 && (op[0] === "*" || op[0] >= "1" && op[0] <= "6") && op[1] === ">" && op[2] === "&" && op[3] >= "1" && op[3] <= "6";
  }
  wordFrom(token) {
    return {
      text: token.text,
      line: token.line,
      quoted: token.quoted,
      expandable: token.expandable,
      parameter: token.kind === "parameter",
      literalDollarOffsets: token.literalDollarOffsets
    };
  }
  emptyWord(line) {
    return { text: "", line, quoted: false, expandable: false, parameter: false };
  }
  expectOperator(text) {
    if (this.peek().text === text) {
      this.advance();
      return;
    }
    this.warnings.push(`expected '${text}' at line ${this.peek().line}`);
  }
  warnUnexpectedAndAdvance() {
    const token = this.peek();
    if (token.kind === "eof") return;
    this.warnings.push(`unexpected token '${token.text}' at line ${token.line}`);
    this.advance();
  }
  peekWordLower() {
    const token = this.peek();
    if (token.kind !== "word") return "";
    return token.text.toLowerCase();
  }
  at(kind) {
    return this.peek().kind === kind;
  }
  peek() {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }
  advance() {
    const token = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }
};

// src/powershell/index.ts
var MAX_STATEMENTS = 1e4;
var MAX_PIPELINE_VALUES = 2e3;
var MAX_ARRAY_LITERAL_VALUES = 2e3;
var MAX_FOREACH_VALUES = 2e3;
var COMMAND_ALIASES = /* @__PURE__ */ new Map([
  ["remove-item", "remove-item"],
  ["rm", "remove-item"],
  ["ri", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["rd", "remove-item"],
  ["rmdir", "remove-item"],
  ["new-item", "new-item"],
  ["ni", "new-item"],
  ["copy-item", "copy-item"],
  ["copy", "copy-item"],
  ["cp", "copy-item"],
  ["cpi", "copy-item"],
  ["ci", "copy-item"],
  ["move-item", "move-item"],
  ["move", "move-item"],
  ["mv", "move-item"],
  ["mi", "move-item"],
  ["rename-item", "rename-item"],
  ["ren", "rename-item"],
  ["rni", "rename-item"],
  ["set-content", "set-content"],
  ["sc", "set-content"],
  ["add-content", "add-content"],
  ["ac", "add-content"],
  ["clear-content", "clear-content"],
  ["clc", "clear-content"],
  ["out-file", "out-file"],
  ["tee-object", "tee-object"],
  ["tee", "tee-object"],
  ["invoke-webrequest", "invoke-webrequest"],
  ["iwr", "invoke-webrequest"],
  ["wget", "invoke-webrequest"],
  ["curl", "invoke-webrequest"],
  ["invoke-restmethod", "invoke-webrequest"],
  ["irm", "invoke-webrequest"],
  ["foreach-object", "foreach-object"],
  ["%", "foreach-object"],
  ["get-childitem", "get-childitem"],
  ["gci", "get-childitem"],
  ["dir", "get-childitem"],
  ["ls", "get-childitem"],
  ["resolve-path", "resolve-path"],
  ["rvpa", "resolve-path"],
  ["test-path", "test-path"],
  ["start-process", "start-process"],
  ["saps", "start-process"],
  ["start", "start-process"],
  ["invoke-command", "invoke-command"],
  ["icm", "invoke-command"],
  ["start-job", "start-job"],
  ["sajb", "start-job"],
  ["invoke-expression", "invoke-expression"],
  ["iex", "invoke-expression"],
  ["&", "invoke-expression"],
  ["compress-archive", "compress-archive"],
  ["expand-archive", "expand-archive"],
  ["export-csv", "export-file"],
  ["epcsv", "export-file"],
  ["export-clixml", "export-file"],
  ["export-alias", "export-file"],
  ["export-counter", "export-file"],
  ["new-itemproperty", "new-itemproperty"],
  ["set-itemproperty", "set-itemproperty"],
  ["remove-itemproperty", "remove-itemproperty"],
  ["save-module", "save-module"],
  ["save-script", "save-module"],
  ["install-module", "install-module"],
  ["cd", "set-location"],
  ["chdir", "set-location"],
  ["sl", "set-location"],
  ["set-location", "set-location"]
]);
var PARAM_ALIASES = /* @__PURE__ */ new Map([
  ["pspath", "literalpath"],
  ["lp", "literalpath"],
  ["path", "path"],
  ["filepath", "filepath"],
  ["name", "name"],
  ["itemtype", "itemtype"],
  ["type", "itemtype"],
  ["destination", "destination"],
  ["literalpath", "literalpath"],
  ["outfile", "outfile"],
  ["destinationpath", "destinationpath"],
  ["argumentlist", "argumentlist"],
  ["args", "argumentlist"],
  ["redirectstandardoutput", "redirectstandardoutput"],
  ["rso", "redirectstandardoutput"],
  ["redirectstandarderror", "redirectstandarderror"],
  ["rse", "redirectstandarderror"],
  ["redirectstandardinput", "redirectstandardinput"],
  ["rsi", "redirectstandardinput"],
  ["append", "append"],
  ["recurse", "recurse"],
  ["force", "force"],
  ["filter", "filter"],
  ["include", "include"],
  ["exclude", "exclude"],
  ["value", "value"],
  ["target", "value"],
  ["newname", "newname"],
  ["file", "path"],
  ["scope", "scope"],
  ["nooverwrite", "noclobber"]
]);
var SWITCH_PARAMS = /* @__PURE__ */ new Set(["append", "recurse", "force", "whatif", "noclobber"]);
var COMMAND_HANDLERS2 = /* @__PURE__ */ new Map([
  ["remove-item", handleRemoveItem],
  ["new-item", handleNewItem],
  ["copy-item", handleCopyItem],
  ["move-item", handleMoveItem],
  ["rename-item", handleRenameItem],
  ["set-content", handleSetContent],
  ["add-content", handleAddContent],
  ["clear-content", handleClearContent],
  ["out-file", handleOutFile],
  ["tee-object", handleTeeObject],
  ["invoke-webrequest", handleInvokeWebRequest],
  ["foreach-object", handleForEachObject],
  ["get-childitem", handleGetChildItem],
  ["resolve-path", handleResolvePath],
  ["test-path", handleTestPath],
  ["start-process", handleStartProcess],
  ["invoke-command", handleScriptBlockLauncher],
  ["start-job", handleScriptBlockLauncher],
  ["invoke-expression", handleInvokeExpression],
  ["compress-archive", handleCompressArchive],
  ["expand-archive", handleExpandArchive],
  ["export-file", handleExportFile],
  ["new-itemproperty", handleItemProperty],
  ["set-itemproperty", handleItemProperty],
  ["remove-itemproperty", handleItemProperty],
  ["save-module", handleSaveModule],
  ["install-module", handleInstallModule],
  ["set-location", handleSetLocation]
]);
function analyzePowerShell(script, opts) {
  const paramBlock = readParamBlock(script);
  const parsed = parsePowerShell(script.slice(paramBlock.end));
  let vfs;
  if (opts.fs) vfs = new VirtualFS(opts.fs);
  else if (opts.realFs) vfs = new RealFS();
  const tracker = new EffectTracker(toPosix(opts.cwd), vfs);
  const env = makeEnv(opts.env, opts.inheritEnv !== false);
  env.set("pwd", tracker.getCwd());
  bindScriptArgs(paramBlock.params, opts.args ?? [], env);
  const state = {
    env,
    splats: /* @__PURE__ */ new Map(),
    tracker,
    pipelineInput: [],
    pipelineOutput: [],
    statementCount: 0,
    budgetWarnings: /* @__PURE__ */ new Set()
  };
  executeScript(parsed.ast, state);
  return {
    effects: tracker.effects,
    gitEffects: tracker.gitEffects,
    resourceEffects: tracker.resourceEffects,
    warnings: [...parsed.warnings, ...tracker.warnings],
    ast: parsed.ast,
    provenance: tracker.getProvenanceGraph()
  };
}
function makeEnv(overrides, inheritProcessEnv = true) {
  const env = /* @__PURE__ */ new Map();
  if (inheritProcessEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== void 0) env.set(key.toLowerCase(), toPosix(value));
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    env.set(key.toLowerCase(), toPosix(value));
  }
  return env;
}
function executeScript(script, state) {
  executeStatements(script.statements, state);
}
function executeStatements(statements, state) {
  for (const statement of statements) executeStatement(statement, state);
}
function executeStatement(statement, state) {
  state.statementCount++;
  if (state.statementCount > MAX_STATEMENTS) {
    warnOnce2(state, "statement-budget", `PowerShell analysis stopped after ${MAX_STATEMENTS} statements`);
    return;
  }
  if (statement.type === "block") {
    const start = state.tracker.checkpoint();
    for (const condition of statement.conditions ?? []) executeStatements(condition, state);
    if (statement.keyword === "foreach") {
      executeForEachBlock(statement, state);
    } else if (statement.keyword === "subexpression") {
      executeStatements(statement.body, state);
      return;
    } else {
      executeStatements(statement.body, state);
    }
    const reason = statement.keyword === "if" ? "conditional-branch" : "unknown-loop-count";
    state.tracker.markAllEffectsFrom(start, [reason], "overapprox");
    return;
  }
  executePipeline2(statement, state);
}
function executeForEachBlock(statement, state) {
  const variable = statement.variable ? variableName(statement.variable) : "";
  const values = limitValues(statement.values?.flatMap((word) => expandValueWord(word, state)) ?? [], MAX_FOREACH_VALUES, state, "foreach-value-budget");
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
    if (previous === void 0) state.env.delete(variable);
    else state.env.set(variable, previous);
  }
}
function executePipeline2(pipeline, state) {
  const start = state.tracker.checkpoint();
  let input = [];
  for (const command of pipeline.commands) {
    state.pipelineInput = input;
    state.pipelineOutput = [];
    executeCommand(command, state);
    input = state.pipelineOutput;
  }
  state.pipelineInput = [];
  state.pipelineOutput = [];
  if (pipeline.connector === "and" || pipeline.connector === "or") {
    state.tracker.markAllEffectsFrom(start, ["and-or-branch"], "overapprox");
  }
}
function executeCommand(command, state) {
  if (tryAssignment(command, state)) return;
  for (const redir of command.redirections) {
    if (redir.kind === "merge" || !redir.target) continue;
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
    const type = redir.op.endsWith(">>") ? "append" : "write";
    state.tracker.add({ type, path: target, line: redir.line, command: redir.op, uncertain: EffectTracker.hasUncertainty(target) });
  }
  const evaluated = evaluateCommandWords(command, state);
  const rawName = evaluated.name.text.toLowerCase();
  const canonical = COMMAND_ALIASES.get(rawName);
  if (!canonical) return;
  const handler = COMMAND_HANDLERS2.get(canonical);
  if (!handler) return;
  if (hasActiveWhatIf(evaluated, state)) return;
  handler({ ...evaluated, name: { ...evaluated.name, text: canonical } }, state);
}
function isNullRedirectTarget(word) {
  if (word.quoted || !word.expandable || word.literalDollarOffsets?.includes(0)) return false;
  return /^\$(?:null|\{null\})$/i.test(word.text);
}
function evaluateCommandWords(command, state) {
  const evaluate = (word) => word.scriptBlockBody ? word : {
    ...word,
    text: expandWord(word, state),
    expandable: false,
    literalDollarOffsets: void 0
  };
  const args = [];
  for (let i = 0; i < command.args.length; ) {
    const word = command.args[i];
    if (word.text.startsWith("@(") && word.text.endsWith(")")) {
      const values = parseArrayLiteral(word.text, state);
      for (let j = 0; j < values.length; j++) {
        if (j > 0) args.push({ text: ",", line: word.line, quoted: false, expandable: false, parameter: false });
        args.push({ ...word, text: values[j], expandable: false, literalDollarOffsets: void 0 });
      }
      i++;
      continue;
    }
    if (word.text.startsWith("@{") && word.text.endsWith("}")) {
      parseHashtableLiteral(word.text, state);
      args.push({ ...word, text: "<hashtable>", expandable: false, literalDollarOffsets: void 0 });
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
    args
  };
}
function hasActiveWhatIf(command, state) {
  for (const arg of command.args) {
    const splatName = splatVariableName(arg.text);
    if (splatName && state.splats.get(splatName)?.switches.has("whatif")) return true;
    if (!arg.parameter) continue;
    let raw = arg.text;
    while (raw.startsWith("-")) raw = raw.slice(1);
    const lower = raw.toLowerCase();
    if (lower === "whatif") return true;
    if (!lower.startsWith("whatif:")) continue;
    const value = lower.slice("whatif:".length);
    if (value === "$true" || value === "true" || value === "1") return true;
  }
  return false;
}
function tryAssignment(command, state) {
  if (!command.name.text.startsWith("$")) return false;
  if (command.args[0]?.text !== "=") return false;
  const key = variableName(command.name.text);
  if (key.length === 0) return false;
  const valueWord = command.args[1];
  if (valueWord?.text.startsWith("@{") === true) {
    const table = parseHashtableLiteral(valueWord.text, state);
    state.splats.set(key, table);
    for (const [name, values] of table.params) {
      if (values[0] !== void 0) state.env.set(`${key}.${name}`, values[0]);
    }
    return true;
  }
  if (valueWord?.text.startsWith("@(") === true) {
    const values = parseArrayLiteral(valueWord.text, state);
    state.env.set(key, values.join(" "));
    for (let i = 0; i < values.length; i++) state.env.set(`${key}.${i}`, values[i]);
    return true;
  }
  const value = command.args.slice(1).map((word) => expandWord(word, state)).join(" ");
  state.env.set(key, value);
  return true;
}
function handleRemoveItem(command, state) {
  const bound = bind(command, state);
  const paths = bindPaths(bound, "path");
  const inputs = paths.length > 0 ? paths : state.pipelineInput.map(pipelineValueText);
  for (const p of applyPathFilters(inputs, bound)) {
    for (const target of expandPathSet(p, state, !bound.params.has("literalpath"))) {
      if (warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({ type: "delete", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    }
  }
}
function handleNewItem(command, state) {
  const bound = bind(command, state);
  const rawPaths = bindPaths(bound, "path");
  const paths = rawPaths.length > 0 ? rawPaths : [""];
  const itemType = firstParam(bound, "itemtype").toLowerCase();
  const name = firstParam(bound, "name");
  const effectType = itemType === "directory" || itemType === "container" ? "mkdir" : "write";
  for (const p of paths) {
    const bases = name.length > 0 ? expandPathSet(p.length > 0 ? p : ".", state, !bound.params.has("literalpath")) : [p];
    for (const base of bases) {
      const target = name.length > 0 ? import_node_path8.posix.join(base, name) : base;
      if (warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({
        type: effectType,
        path: target,
        line: command.line,
        command: bound.name,
        replacement: effectType === "write" ? bound.switches.has("force") ? "replace" : "no-clobber" : void 0,
        uncertain: EffectTracker.hasUncertainty(target)
      });
    }
  }
}
function handleCopyItem(command, state) {
  const bound = bind(command, state);
  const destination = firstParam(bound, "destination") || bound.positionals[1] || ".";
  const sources = applyPathFilters(bindPaths(bound, "path").filter((p) => p !== destination), bound);
  for (const source of sources) {
    for (const expanded of expandPathSet(source, state, !bound.params.has("literalpath"))) {
      const target = destinationForSource2(destination, expanded, state.tracker);
      if (warnProviderPath(expanded, command.line, state) || warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({
        type: "copy",
        path: target,
        source: expanded,
        line: command.line,
        command: bound.name,
        replacement: bound.switches.has("force") ? "replace" : "conditional",
        uncertain: EffectTracker.hasUncertainty(expanded) || EffectTracker.hasUncertainty(destination)
      });
    }
  }
}
function handleMoveItem(command, state) {
  const bound = bind(command, state);
  const destination = firstParam(bound, "destination") || bound.positionals[1] || ".";
  const sources = applyPathFilters(bindPaths(bound, "path").filter((p) => p !== destination), bound);
  for (const source of sources) {
    for (const expanded of expandPathSet(source, state, !bound.params.has("literalpath"))) {
      const target = destinationForSource2(destination, expanded, state.tracker);
      if (warnProviderPath(expanded, command.line, state) || warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({
        type: "move",
        path: target,
        source: expanded,
        line: command.line,
        command: bound.name,
        replacement: bound.switches.has("force") ? "replace" : "no-clobber",
        uncertain: EffectTracker.hasUncertainty(expanded) || EffectTracker.hasUncertainty(destination)
      });
    }
  }
}
function handleRenameItem(command, state) {
  const bound = bind(command, state);
  const source = firstPath(bound);
  const newName = firstParam(bound, "newname") || bound.positionals[1];
  if (!source || !newName) return;
  const destination = import_node_path8.posix.join(import_node_path8.posix.dirname(source), newName);
  if (warnProviderPath(source, command.line, state) || warnProviderPath(destination, command.line, state)) return;
  state.tracker.add({
    type: "move",
    path: destination,
    source,
    line: command.line,
    command: bound.name,
    replacement: "no-clobber",
    uncertain: EffectTracker.hasUncertainty(source) || EffectTracker.hasUncertainty(newName)
  });
}
function handleSetContent(command, state) {
  addPathEffects(bind(command, state), state, command.line, "write");
}
function handleAddContent(command, state) {
  addPathEffects(bind(command, state), state, command.line, "append");
}
function handleClearContent(command, state) {
  addPathEffects(bind(command, state), state, command.line, "truncate");
}
function handleOutFile(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "filepath") || firstParam(bound, "path") || firstParam(bound, "literalpath") || bound.positionals[0];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  addOutputFileEffect(bound, target, state, command.line);
}
function handleTeeObject(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "filepath") || firstParam(bound, "path") || firstParam(bound, "literalpath") || bound.positionals[0];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: bound.switches.has("append") ? "append" : "write", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}
function handleInvokeWebRequest(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "outfile");
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: "write", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}
function handleForEachObject(command, state) {
  const start = state.tracker.checkpoint();
  const blocks = forEachObjectBlocks(command);
  const inputs = state.pipelineInput.length > 0 ? state.pipelineInput : [scalarPipelineValue("")];
  const previousUnderscore = state.env.get("_");
  const previousPsItem = state.env.get("psitem");
  const previousUnderscoreFields = saveObjectFields(state.env, "_");
  const previousPsItemFields = saveObjectFields(state.env, "psitem");
  try {
    for (const block of blocks.begin) executeStatements(block, state);
    for (const item of inputs) {
      bindPipelineObject(state.env, "_", item);
      bindPipelineObject(state.env, "psitem", item);
      for (const block of blocks.process) executeStatements(block, state);
    }
    for (const block of blocks.end) executeStatements(block, state);
  } finally {
    restoreEnvValue(state.env, "_", previousUnderscore);
    restoreEnvValue(state.env, "psitem", previousPsItem);
    restoreObjectFields(state.env, "_", previousUnderscoreFields);
    restoreObjectFields(state.env, "psitem", previousPsItemFields);
  }
  state.tracker.markAllEffectsFrom(start, ["unknown-loop-count"], "overapprox");
}
function forEachObjectBlocks(command) {
  const begin = [];
  const process2 = [];
  const end = [];
  let mode = null;
  for (const arg of command.args) {
    if (arg.parameter) {
      const name = canonicalParamName(arg.text);
      if (name === "begin" || name === "process" || name === "end") mode = name;
      continue;
    }
    if (!arg.scriptBlockBody) continue;
    if (mode === "begin") begin.push(arg.scriptBlockBody);
    else if (mode === "end") end.push(arg.scriptBlockBody);
    else process2.push(arg.scriptBlockBody);
    mode = null;
  }
  return { begin, process: process2.length > 0 ? process2 : begin.length === 0 && end.length === 0 ? [] : process2, end };
}
function handleGetChildItem(command, state) {
  const bound = bind(command, state);
  const paths = bindPaths(bound, "path");
  const candidates = paths.length > 0 ? paths : ["."];
  for (const candidate of applyPathFilters(candidates, bound)) {
    for (const expanded of expandPathSet(candidate, state, !bound.params.has("literalpath"))) {
      pushPipelineOutput(state, pathObject(expanded));
    }
  }
}
function handleResolvePath(command, state) {
  handleGetChildItem(command, state);
}
function handleTestPath(_command, state) {
  state.pipelineOutput = [];
}
function handleStartProcess(command, state) {
  const bound = bind(command, state);
  for (const name of ["redirectstandardoutput", "redirectstandarderror"]) {
    const target = firstParam(bound, name);
    if (target) {
      if (warnProviderPath(target, command.line, state)) continue;
      state.tracker.add({ type: "write", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    }
  }
  const executable = firstParam(bound, "filepath") || firstParam(bound, "path") || bound.positionals[0];
  const argumentList = bound.params.get("argumentlist") ?? bound.positionals.slice(1);
  analyzeLaunchedShell(executable, argumentList, state, command.line);
}
function handleScriptBlockLauncher(command, state) {
  const start = state.tracker.checkpoint();
  for (const arg of command.args) {
    if (arg.scriptBlockBody) executeStatements(arg.scriptBlockBody, state);
  }
  state.tracker.markAllEffectsFrom(start, ["unknown-command"], "overapprox");
}
function handleInvokeExpression(command, state) {
  const bound = bind(command, state);
  const script = bound.positionals.join(" ");
  if (!script) return;
  const result = analyzePowerShell(script, { cwd: state.tracker.getCwd(), realFs: true });
  for (const effect of result.effects) {
    state.tracker.add({
      ...effect,
      line: command.line,
      command: "invoke-expression",
      provenance: void 0
    });
  }
  for (const effect of result.gitEffects) {
    state.tracker.addGit({ ...effect, line: command.line, provenance: void 0 });
  }
  for (const effect of result.resourceEffects) {
    state.tracker.addResource({ ...effect, line: command.line, provenance: void 0 });
  }
  for (const warning of result.warnings) state.tracker.addWarning(`invoke-expression: ${warning}`);
}
function handleCompressArchive(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "destinationpath") || bound.positionals[1];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: "write", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}
function handleExpandArchive(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "destinationpath") || bound.positionals[1] || ".";
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: "mkdir", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
  state.tracker.add({ type: "write", path: import_node_path8.posix.join(target, "<archive-contents>"), line: command.line, command: bound.name, uncertain: true, certainty: "unknown", uncertainty: ["derived-path"] });
}
function handleExportFile(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "path") || firstParam(bound, "literalpath") || bound.positionals[0];
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  addOutputFileEffect(bound, target, state, command.line);
}
function addOutputFileEffect(bound, target, state, line) {
  if (bound.switches.has("append")) {
    state.tracker.add({ type: "append", path: target, line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    return;
  }
  const resolved = state.tracker.resolvePath(target);
  if (bound.switches.has("noclobber") && state.tracker.vfs?.exists(resolved)) {
    state.tracker.addWarning(`${bound.name}: '${target}' already exists; -NoClobber prevents writing (line ${line})`);
    return;
  }
  state.tracker.add({
    type: "write",
    path: target,
    line,
    command: bound.name,
    replacement: bound.switches.has("noclobber") ? "no-clobber" : "replace",
    uncertain: EffectTracker.hasUncertainty(target)
  });
}
function handleItemProperty(command, state) {
  const bound = bind(command, state);
  const target = firstPath(bound);
  if (!target) return;
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: command.name.text.startsWith("remove") ? "delete" : "write", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}
function handleSaveModule(command, state) {
  const bound = bind(command, state);
  const target = firstParam(bound, "path") || bound.positionals[1] || ".";
  if (warnProviderPath(target, command.line, state)) return;
  state.tracker.add({ type: "mkdir", path: target, line: command.line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
}
function handleInstallModule(command, state) {
  const bound = bind(command, state);
  const name = firstParam(bound, "name") || bound.positionals[0] || "<module>";
  const scope = firstParam(bound, "scope").toLowerCase();
  const home = state.env.get("home") || "~";
  const base = scope === "allusers" ? "/usr/local/share/powershell/Modules" : import_node_path8.posix.join(home, "Documents/PowerShell/Modules");
  const target = import_node_path8.posix.join(base, name);
  state.tracker.add({ type: "mkdir", path: target, line: command.line, command: bound.name, uncertain: name === "<module>", certainty: name === "<module>" ? "unknown" : "exact", uncertainty: name === "<module>" ? ["derived-path"] : [] });
}
function handleSetLocation(command, state) {
  const bound = bind(command, state);
  const target = firstPath(bound);
  if (!target || EffectTracker.hasUncertainty(target)) return;
  state.tracker.setCwd(state.tracker.resolvePath(target));
  state.env.set("pwd", state.tracker.getCwd());
}
function addPathEffects(bound, state, line, type) {
  for (const p of applyPathFilters(bindPaths(bound, "path"), bound)) {
    for (const target of expandPathSet(p, state, !bound.params.has("literalpath"))) {
      if (warnProviderPath(target, line, state)) continue;
      state.tracker.add({ type, path: target, line, command: bound.name, uncertain: EffectTracker.hasUncertainty(target) });
    }
  }
}
function bind(command, state) {
  const params = /* @__PURE__ */ new Map();
  const switches = /* @__PURE__ */ new Set();
  const positionals = [];
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
      addParam(params, name, "");
      i++;
      continue;
    }
    if (word.text !== "=" && word.text !== ",") {
      const combined = combineMemberAccess(command.args, i);
      for (const value of expandValueWord(combined.word, state)) positionals.push(value);
      i = combined.nextIndex;
      continue;
    }
    i++;
  }
  return { name: command.name.text, params, switches, positionals };
}
function collectParamValues(words, start, state) {
  const values = [];
  let i = start;
  let expectValue = true;
  while (i < words.length) {
    const word = words[i];
    if (word.parameter || word.text === "=") break;
    if (word.text === ",") {
      expectValue = true;
      i++;
      continue;
    }
    if (!expectValue && values.length > 0) break;
    const combined = combineMemberAccess(words, i);
    values.push(...expandValueWord(combined.word, state));
    expectValue = false;
    i = combined.nextIndex;
    if (i < words.length && words[i]?.text === ",") continue;
    break;
  }
  return { values, nextIndex: i };
}
function bindPaths(bound, paramName) {
  const explicit = bound.params.get("literalpath") ?? bound.params.get(paramName);
  if (explicit && explicit.length > 0) return explicit;
  if (bound.positionals.length === 0) return [];
  if ((bound.name === "copy-item" || bound.name === "move-item") && bound.positionals.length > 1) {
    return bound.positionals.slice(0, bound.positionals.length - 1);
  }
  return [bound.positionals[0]];
}
function firstPath(bound) {
  return bindPaths(bound, "path")[0];
}
function firstParam(bound, name) {
  return bound.params.get(name)?.[0] ?? "";
}
function combineMemberAccess(words, index) {
  const word = words[index];
  const next = words[index + 1];
  if (word?.text.startsWith("$") && next && !next.parameter && next.text.startsWith(".")) {
    return { word: { ...word, text: word.text + next.text }, nextIndex: index + 2 };
  }
  if (word?.text.startsWith("$") && next && !next.parameter && next.text.startsWith("[")) {
    return { word: { ...word, text: word.text + next.text }, nextIndex: index + 2 };
  }
  return { word, nextIndex: index + 1 };
}
function applyPathFilters(paths, bound) {
  const filters = [
    ...bound.params.get("filter") ?? [],
    ...bound.params.get("include") ?? []
  ];
  const excludes = bound.params.get("exclude") ?? [];
  if (filters.length === 0 && excludes.length === 0) return paths;
  return paths.filter((candidate) => {
    const name = import_node_path8.posix.basename(candidate);
    if (filters.length > 0 && !filters.some((pattern) => glob_match_segment(pattern, name))) return false;
    if (excludes.some((pattern) => glob_match_segment(pattern, name))) return false;
    return true;
  });
}
function addParam(params, name, value) {
  let values = params.get(name);
  if (!values) {
    values = [];
    params.set(name, values);
  }
  values.push(value);
}
function mergeSplat(params, switches, positionals, splat) {
  for (const [name, values] of splat.params) {
    for (const value of values) addParam(params, name, value);
  }
  for (const name of splat.switches) switches.add(name);
  positionals.push(...splat.positionals);
}
function canonicalParamName(raw) {
  let i = 0;
  while (raw[i] === "-") i++;
  const name = raw.slice(i).toLowerCase();
  return PARAM_ALIASES.get(name) ?? name;
}
function parseInlineSwitchParameter(raw) {
  const colon = raw.indexOf(":");
  if (colon < 0) return { name: raw, enabled: true };
  const value = raw.slice(colon + 1).toLowerCase();
  return {
    name: raw.slice(0, colon),
    enabled: value === "$true" || value === "true" || value === "1"
  };
}
function expandWord(word, state) {
  if (!word.expandable) return word.text;
  const literalDollarOffsets = new Set(word.literalDollarOffsets ?? []);
  let out = "";
  let i = 0;
  while (i < word.text.length) {
    const c = word.text[i];
    if (c !== "$" || literalDollarOffsets.has(i)) {
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
function expandValueWord(word, state) {
  if (word.text.startsWith("@(") && word.text.endsWith(")")) {
    return parseArrayLiteral(word.text, state);
  }
  return [expandWord(word, state)];
}
function parseArrayLiteral(text, state) {
  const inner = text.slice(2, text.length - 1);
  const { tokens } = tokenize(inner);
  const values = [];
  for (const token of tokens) {
    if (values.length >= MAX_ARRAY_LITERAL_VALUES) {
      warnOnce2(state, "array-literal-budget", `PowerShell array literal expansion stopped after ${MAX_ARRAY_LITERAL_VALUES} values`);
      break;
    }
    if (token.kind === "eof" || token.kind === "newline" || token.text === ",") continue;
    if (token.kind === "word" || token.kind === "string" || token.kind === "variable") {
      values.push(expandWord({
        text: token.text,
        line: token.line,
        quoted: token.quoted,
        expandable: token.expandable,
        parameter: false,
        literalDollarOffsets: token.literalDollarOffsets
      }, state));
    }
  }
  return values;
}
function parseHashtableLiteral(text, state) {
  const inner = text.slice(2, text.length - 1);
  const { tokens } = tokenize(inner);
  const params = /* @__PURE__ */ new Map();
  const switches = /* @__PURE__ */ new Set();
  const positionals = [];
  let i = 0;
  while (i < tokens.length) {
    const keyToken = tokens[i];
    if (keyToken.kind === "eof") break;
    if (keyToken.kind === "newline" || keyToken.text === ";" || keyToken.text === ",") {
      i++;
      continue;
    }
    const key = canonicalParamName(keyToken.text);
    i++;
    if (tokens[i]?.text === "=") i++;
    const values = [];
    while (i < tokens.length && tokens[i]?.kind !== "eof" && tokens[i]?.text !== ";") {
      const token = tokens[i];
      if (token.text !== ",") {
        values.push(...expandValueWord({
          text: token.text,
          line: token.line,
          quoted: token.quoted,
          expandable: token.expandable,
          parameter: false,
          literalDollarOffsets: token.literalDollarOffsets
        }, state));
      }
      i++;
    }
    if (SWITCH_PARAMS.has(key) && (values.length === 0 || values[0]?.toLowerCase() !== "$false")) {
      switches.add(key);
    } else {
      for (const value of values) addParam(params, key, value);
    }
  }
  return { params, switches, positionals };
}
function readVariable(text, start) {
  let i = start + 1;
  if (text[i] === "{") {
    i++;
    const nameStart2 = i;
    while (i < text.length && text[i] !== "}") i++;
    if (i >= text.length) return null;
    return { name: normalizeVariableName(text.slice(nameStart2, i)), end: i + 1 };
  }
  const nameStart = i;
  while (i < text.length) {
    const c = text[i];
    if (!isVariableChar(c)) break;
    i++;
  }
  if (i === nameStart) return null;
  const baseName2 = text.slice(nameStart, i);
  if (baseName2.toLowerCase().startsWith("env:")) {
    return { name: normalizeVariableName(baseName2), end: i };
  }
  while (text[i] === ".") {
    i++;
    while (i < text.length && isVariableChar(text[i])) i++;
  }
  if (text[i] === "[") {
    const indexStart = i + 1;
    while (i < text.length && text[i] !== "]") i++;
    if (i < text.length) {
      const index = text.slice(indexStart, i);
      return { name: normalizeVariableName(`${baseName2}.${index}`), end: i + 1 };
    }
  }
  return { name: normalizeVariableName(text.slice(nameStart, i)), end: i };
}
function normalizeVariableName(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("env:")) return lower.slice(4);
  return lower;
}
function variableName(raw) {
  return normalizeVariableName(raw.startsWith("${") && raw.endsWith("}") ? raw.slice(2, raw.length - 1) : raw.slice(1));
}
function splatVariableName(raw) {
  if (!raw.startsWith("@") || raw.startsWith("@(") || raw.startsWith("@{")) return null;
  const name = raw.slice(1);
  return name.length > 0 ? normalizeVariableName(name) : null;
}
function isVariableChar(c) {
  const code = c.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || c === "_" || c === ":";
}
function expandPathSet(pattern, state, allowWildcard) {
  if (!allowWildcard || !state.tracker.vfs || !has_glob_chars(pattern)) return [pattern];
  const matches = glob_expand(pattern, state.tracker.getCwd(), state.tracker.vfs);
  return matches.length > 0 ? matches : [pattern];
}
function pathObject(fullPath) {
  const fields = /* @__PURE__ */ new Map();
  fields.set("fullname", fullPath);
  fields.set("path", fullPath);
  fields.set("name", import_node_path8.posix.basename(fullPath));
  return { text: fullPath, fields };
}
function scalarPipelineValue(text) {
  return { text, fields: /* @__PURE__ */ new Map() };
}
function readSubexpression(text, start) {
  if (text[start] !== "$" || text[start + 1] !== "(") return null;
  let depth = 1;
  let i = start + 2;
  const exprStart = i;
  while (i < text.length) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") {
      depth--;
      if (depth === 0) return { expr: text.slice(exprStart, i), end: i + 1 };
    }
    i++;
  }
  return null;
}
function expandSubexpression(expr, state) {
  const trimmed = expr.trim();
  if (trimmed.startsWith("$")) {
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
function analyzeLaunchedShell(executable, args, state, line) {
  const shell = shellKindForExecutable(import_node_path8.posix.basename(executable).toLowerCase());
  if (!shell) return;
  const script = shellCommandArgument(args, shell);
  if (!script) return;
  const result = shell === "powershell" ? analyzePowerShell(script, { cwd: state.tracker.getCwd(), realFs: true }) : analyze(script, { cwd: state.tracker.getCwd(), realFs: true });
  for (const effect of result.effects) {
    state.tracker.add({
      ...effect,
      line,
      command: `start-process ${shell}`,
      provenance: void 0
    });
  }
  for (const effect of result.gitEffects) {
    state.tracker.addGit({ ...effect, line, provenance: void 0 });
  }
  for (const effect of result.resourceEffects) {
    state.tracker.addResource({ ...effect, line, provenance: void 0 });
  }
  for (const warning of result.warnings) state.tracker.addWarning(`${shell}: ${warning}`);
}
function shellKindForExecutable(executable) {
  if (executable === "bash" || executable === "bash.exe" || executable === "sh" || executable === "sh.exe" || executable === "wsl" || executable === "wsl.exe") return "bash";
  if (executable === "pwsh" || executable === "pwsh.exe" || executable === "powershell" || executable === "powershell.exe") return "powershell";
  return null;
}
function shellCommandArgument(args, shell) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    if (arg === "-c" || arg === "-command" || shell === "powershell" && arg === "-encodedcommand") {
      if (arg === "-encodedcommand") return decodeUtf16LeBase64(args[i + 1] ?? "");
      return args.slice(i + 1).join(" ");
    }
  }
  return null;
}
function decodeUtf16LeBase64(value) {
  try {
    return Buffer.from(value, "base64").toString("utf16le").replace(/\0+$/u, "");
  } catch {
    return "";
  }
}
function pipelineValueText(value) {
  return value.text;
}
function pushPipelineOutput(state, value) {
  if (state.pipelineOutput.length >= MAX_PIPELINE_VALUES) {
    warnOnce2(state, "pipeline-budget", `PowerShell pipeline output stopped after ${MAX_PIPELINE_VALUES} values`);
    return;
  }
  state.pipelineOutput.push(value);
}
function bindPipelineObject(env, name, value) {
  env.set(name, value.text);
  for (const [field, fieldValue] of value.fields) {
    env.set(`${name}.${field}`, fieldValue);
  }
}
function saveObjectFields(env, name) {
  const saved = /* @__PURE__ */ new Map();
  saved.set(`${name}.fullname`, env.get(`${name}.fullname`));
  saved.set(`${name}.path`, env.get(`${name}.path`));
  saved.set(`${name}.name`, env.get(`${name}.name`));
  return saved;
}
function restoreObjectFields(env, name, saved) {
  for (const field of ["fullname", "path", "name"]) {
    restoreEnvValue(env, `${name}.${field}`, saved.get(`${name}.${field}`));
  }
}
function limitValues(values, limit, state, key) {
  if (values.length <= limit) return values;
  warnOnce2(state, key, `PowerShell expansion stopped after ${limit} values`);
  return values.slice(0, limit);
}
function warnOnce2(state, key, message) {
  if (state.budgetWarnings.has(key)) return;
  state.budgetWarnings.add(key);
  state.tracker.addWarning(message);
}
function warnProviderPath(value, line, state) {
  if (!isNonFilesystemProviderPath(value)) return false;
  state.tracker.addWarning(`PowerShell provider path '${value}' is not modeled as a filesystem path (line ${line})`);
  return true;
}
function isNonFilesystemProviderPath(value) {
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  if (colon === 1 && isAsciiAlpha2(value[0])) return false;
  return true;
}
function isAsciiAlpha2(value) {
  if (value.length === 0) return false;
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}
function restoreEnvValue(env, name, previous) {
  if (previous === void 0) env.delete(name);
  else env.set(name, previous);
}
function bindScriptArgs(params, args, env) {
  for (let i = 0; i < params.length; i++) {
    env.set(params[i].toLowerCase(), toPosix(args[i] ?? ""));
  }
  for (let i = 0; i < args.length; i++) {
    env.set(String(i + 1), toPosix(args[i]));
  }
}
function readParamBlock(script) {
  let i = 0;
  while (i < script.length && isWhitespace2(script[i])) i++;
  if (!startsWithWord(script, i, "param")) return { params: [], end: 0 };
  i += "param".length;
  while (i < script.length && isWhitespace2(script[i])) i++;
  if (script[i] !== "(") return { params: [], end: 0 };
  const end = findBalanced(script, i, "(", ")");
  if (end <= i) return { params: [], end: 0 };
  const { tokens } = tokenize(script.slice(i + 1, end));
  const params = [];
  for (const token of tokens) {
    if (token.kind === "variable") params.push(variableName(token.text));
  }
  return { params, end: end + 1 };
}
function startsWithWord(script, pos, word) {
  if (script.slice(pos, pos + word.length).toLowerCase() !== word) return false;
  const next = script[pos + word.length] ?? "";
  return next.length === 0 || !isVariableChar(next);
}
function findBalanced(script, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
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
function isWhitespace2(value) {
  return value === " " || value === "	" || value === "\r" || value === "\n";
}
function destinationForSource2(dest, source, tracker) {
  const resolvedDest = tracker.resolvePath(dest);
  if (dest.endsWith("/") || tracker.vfs?.isDirectory(resolvedDest)) {
    return import_node_path8.posix.join(dest, import_node_path8.posix.basename(source));
  }
  return dest;
}

// src/plugin/platform.ts
function powerShellAnalysisEnabled(platform = process.platform) {
  return platform === "win32";
}

// src/analysis/risk-codes.ts
var RISK_REASON_CODES = {
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
  CONTAINER_HOST_WRITE_EXPOSURE: 4002
};
var DIRECT_REASON_CODES = [
  RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION,
  RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION,
  RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE,
  RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE,
  RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION,
  RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT,
  RISK_REASON_CODES.GIT_WORKTREE_DISCARD,
  RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION,
  RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE
];
var DIRECT_RISK_POLICY = {
  [RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION]: "critical",
  [RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION]: "critical",
  [RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE]: "critical",
  [RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE]: "critical",
  [RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION]: "risky",
  [RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT]: "risky",
  [RISK_REASON_CODES.GIT_WORKTREE_DISCARD]: "risky",
  [RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION]: "risky",
  [RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE]: "risky"
};
var REASON_CODE_SEVERITY = {
  ...DIRECT_RISK_POLICY,
  [RISK_REASON_CODES.AFFECTED_FILE_COUNT_CRITICAL]: "critical",
  [RISK_REASON_CODES.AFFECTED_FILE_COUNT_RISKY]: "risky",
  [RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT]: "risky",
  [RISK_REASON_CODES.SENSITIVE_EXTENSION]: "critical",
  [RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION]: "risky",
  [RISK_REASON_CODES.AFFECTED_TOTAL_SIZE]: "critical",
  [RISK_REASON_CODES.CONDITIONAL_AFFECTED_TOTAL_SIZE]: "risky",
  [RISK_REASON_CODES.OLD_AFFECTED_FILE]: "critical",
  [RISK_REASON_CODES.CONDITIONAL_OLD_AFFECTED_FILE]: "risky"
};
function normalizeReasonCodes(codes) {
  return [...new Set(codes)].sort((left, right) => left - right);
}

// src/analysis/predicates.ts
function evaluateEffectPredicates(effects, opts) {
  const platform = opts?.platform ?? process.platform;
  const reasonCodes = [];
  for (const effect of effects ?? []) {
    if (EffectTracker.hasPathUncertainty(effect)) {
      if (effect.type === "delete" && isUnresolvedCatastrophicDelete(effect.path, platform)) {
        reasonCodes.push(RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE);
      } else if (hasUnresolvedLocalPath(effect)) {
        reasonCodes.push(RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION);
      }
      continue;
    }
    if (effect.type === "delete") {
      if (isCatastrophicPath(effect.path, platform)) {
        reasonCodes.push(RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION);
      } else if (!effect.uncertain && isSystemPath(effect.path, platform)) {
        reasonCodes.push(RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION);
      }
    }
  }
  return normalizeReasonCodes(reasonCodes);
}
function evaluateGitEffectPredicates(effects) {
  const reasonCodes = [];
  for (const effect of effects ?? []) {
    if (effect.command !== "git reset" || effect.domain !== "worktree") continue;
    if (effect.mode === "hard" || effect.mode === "merge" || effect.mode === "keep" || effect.mode === "unknown") {
      reasonCodes.push(RISK_REASON_CODES.GIT_WORKTREE_DISCARD);
    }
  }
  return normalizeReasonCodes(reasonCodes);
}
function evaluateResourceEffectPredicates(effects) {
  const reasonCodes = [];
  for (const effect of effects ?? []) {
    switch (effect.domain) {
      case "git-worktree":
        reasonCodes.push(RISK_REASON_CODES.GIT_WORKTREE_DISCARD);
        break;
      case "local-filesystem-selection":
        reasonCodes.push(RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION);
        break;
      case "docker-volume":
      case "kubernetes":
      case "helm":
      case "terraform":
        reasonCodes.push(RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION);
        break;
      case "container-bind-mount":
        reasonCodes.push(RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE);
        break;
    }
  }
  return normalizeReasonCodes(reasonCodes);
}
function hasUnresolvedLocalPath(effect) {
  if (!["delete", "write", "truncate", "copy", "move", "link"].includes(effect.type)) return false;
  return effect.uncertainty.some((item) => item === "unresolved-expansion" || item === "glob-without-fs" || item === "command-substitution" || item === "derived-path");
}

// src/analysis/risk_model.ts
var OLD_FILE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1e3;
var LARGE_TOTAL_SIZE_THRESHOLD_BYTES = 100 * 1024 * 1024;
var MANY_FILES_CRITICAL = 1e3;
var MANY_FILES_RISKY = 100;
var SENSITIVE_EXTENSIONS = /* @__PURE__ */ new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "raw",
  "cr2",
  "nef",
  "arw",
  "psd",
  "ai",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "wmv",
  "flv",
  "webm",
  "mpeg",
  "mpg",
  "m4v",
  "3gp",
  "zip",
  "rar",
  "7z",
  "vmdk",
  "vhd",
  "vhdx",
  "vdi",
  "iso",
  "img"
]);
function posixToNative(p, platform) {
  const plat = platform === void 0 ? process.platform : platform;
  if (plat !== "win32") return p;
  if (!p || typeof p !== "string") return p;
  if (/^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:$/.test(p)) return p;
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (!m) return p;
  const drive = m[1].toUpperCase();
  const rest = m[2] ? m[2].replace(/\//g, "\\") : "";
  return rest ? drive + ":\\" + rest : drive + ":\\";
}
function isSystemPath2(p, platform = process.platform) {
  return isSystemPath(p, platform);
}
function isCatastrophicPath2(p, platform = process.platform) {
  return isCatastrophicPath(p, platform);
}
var SEVERITY_RANK = { safe: 0, risky: 1, critical: 2 };
function higher(a, b) {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
function classifyAnalysis(analysis, opts) {
  const options = opts || {};
  const platform = options.platform === void 0 ? process.platform : options.platform;
  const now = options.now === void 0 ? Date.now() : options.now;
  const reasonCodes = /* @__PURE__ */ new Set();
  let severity = "safe";
  const bump = (code) => {
    const level = REASON_CODE_SEVERITY[code];
    severity = higher(severity, level);
    reasonCodes.add(code);
  };
  if (!analysis || !analysis.available) return { severity: "safe", reasonCodes: [] };
  for (const code of evaluateEffectPredicates(analysis.effects, { platform })) {
    bump(code);
  }
  const aff = analysis.affected || {};
  const policyCount = numberOr(aff.policyFileCount, aff.totalFileCount);
  const definiteCount = numberOr(aff.definitePolicyFileCount, policyCount);
  if (definiteCount >= MANY_FILES_CRITICAL || aff.budgetExhausted && aff.budgetExhaustedCertainty !== "conditional") {
    bump(RISK_REASON_CODES.AFFECTED_FILE_COUNT_CRITICAL);
  } else if (policyCount >= MANY_FILES_CRITICAL || aff.budgetExhausted) {
    bump(RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT);
  } else if (definiteCount >= MANY_FILES_RISKY) {
    bump(RISK_REASON_CODES.AFFECTED_FILE_COUNT_RISKY);
  } else if (policyCount >= MANY_FILES_RISKY) {
    bump(RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT);
  }
  for (const g of aff.groups || []) {
    const ext = (g.extension || "").replace(/^\./, "").toLowerCase();
    if (!ext || !SENSITIVE_EXTENSIONS.has(ext)) continue;
    const cnt = numberOr(g.policyCount, g.totalCount);
    if (cnt <= 0) continue;
    const definite = numberOr(g.definitePolicyCount, cnt);
    bump(definite > 0 ? RISK_REASON_CODES.SENSITIVE_EXTENSION : RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION);
  }
  const policyTotalSize = numberOr(aff.policyTotalSize, aff.totalSize);
  const definiteTotalSize = numberOr(aff.definitePolicyTotalSize, policyTotalSize);
  if (definiteTotalSize >= LARGE_TOTAL_SIZE_THRESHOLD_BYTES) {
    bump(RISK_REASON_CODES.AFFECTED_TOTAL_SIZE);
  } else if (policyTotalSize >= LARGE_TOTAL_SIZE_THRESHOLD_BYTES) {
    bump(RISK_REASON_CODES.CONDITIONAL_AFFECTED_TOTAL_SIZE);
  }
  const definiteOldMatches = oldFiles(
    aff.definitePolicyOldest ?? aff.policyOldest ?? aff.oldest,
    now
  );
  if (definiteOldMatches.length > 0) {
    bump(RISK_REASON_CODES.OLD_AFFECTED_FILE);
  }
  const conditionalOldMatches = oldFiles(aff.conditionalPolicyOldest, now);
  if (definiteOldMatches.length === 0 && conditionalOldMatches.length > 0) {
    bump(RISK_REASON_CODES.CONDITIONAL_OLD_AFFECTED_FILE);
  }
  for (const target of aff.specialTargets || []) {
    if (target.safeSink || target.kind === "directory" || target.kind === "symlink" || target.kind === "other") continue;
    if (target.kind === "block-device" && target.operation !== "delete-entry" && target.executionCertainty === "definite") {
      bump(RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE);
    } else {
      bump(RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT);
    }
  }
  if ((aff.metadataUnavailable?.length ?? 0) > 0) {
    bump(RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION);
  }
  for (const code of evaluateGitEffectPredicates(analysis.gitEffects)) {
    bump(code);
  }
  for (const code of evaluateResourceEffectPredicates(analysis.resourceEffects)) {
    bump(code);
  }
  return { severity, reasonCodes: normalizeReasonCodes(reasonCodes) };
}
function oldFiles(files, now) {
  const matches = [];
  for (const f of files || []) {
    const ts = Date.parse(f.createdAt || "");
    if (!Number.isFinite(ts)) continue;
    if (now - ts >= OLD_FILE_THRESHOLD_MS) matches.push(f);
  }
  return matches;
}
function numberOr(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0) return fallback;
  return 0;
}
function renderReasonCodes(reasonCodes, analysis, max) {
  const limit = max === void 0 ? 5 : max;
  return materializeReasonCodes(reasonCodes, analysis).slice(0, limit).map((reason) => {
    const first = reason.paths?.[0];
    return first?.path ? `${reason.text} (${first.path})` : reason.text;
  });
}
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
function renderReasonCodesDetailed(reasonCodes, analysis, opts) {
  const o = opts || {};
  const maxReasons = o.maxReasons === void 0 ? 10 : o.maxReasons;
  const maxPaths = o.maxPathsPerReason === void 0 ? 10 : o.maxPathsPerReason;
  const affectedMetadata = indexAffectedMetadata(analysis.affected, o.platform);
  const out = [];
  for (const reason of materializeReasonCodes(reasonCodes, analysis, o.platform).slice(0, maxReasons)) {
    out.push("- " + reason.text);
    if (reason.paths && reason.paths.length) {
      for (const p of reason.paths.slice(0, maxPaths)) {
        out.push("    * " + renderFileMetadata(withAffectedMetadata(p, affectedMetadata, o.platform), o.platform));
      }
      if (reason.paths.length > maxPaths) {
        out.push(`    * ... and ${reason.paths.length - maxPaths} more`);
      }
    }
  }
  const affected = renderAffectedFiles(analysis.affected, o);
  if (affected.length > 0) {
    if (out.length > 0) out.push("");
    out.push(...affected);
  }
  return out.join("\n");
}
function materializeReasonCodes(reasonCodes, analysis, platform = process.platform) {
  const rendered = [];
  for (const code of normalizeReasonCodes(reasonCodes ?? [])) {
    rendered.push(...materializeReasonCode(code, analysis, platform));
  }
  return dedupeRenderedReasons(rendered);
}
function materializeReasonCode(code, analysis, platform) {
  const affected = analysis.affected ?? {};
  switch (code) {
    case RISK_REASON_CODES.CATASTROPHIC_ROOT_DESTRUCTION:
      return renderMatchingEffects(
        analysis.effects,
        (effect) => effect.type === "delete" && !EffectTracker.hasPathUncertainty(effect) && isCatastrophicPath2(effect.path, platform),
        "**Danger:** attempts to delete filesystem root",
        platform
      );
    case RISK_REASON_CODES.PROTECTED_SYSTEM_TREE_DESTRUCTION:
      return renderMatchingEffects(
        analysis.effects,
        (effect) => effect.type === "delete" && !effect.uncertain && !EffectTracker.hasPathUncertainty(effect) && isSystemPath2(effect.path, platform),
        "**Danger:** attempts to delete a protected system path",
        platform
      );
    case RISK_REASON_CODES.BROAD_UNRESOLVED_CATASTROPHIC_DELETE:
      return renderMatchingEffects(
        analysis.effects,
        (effect) => effect.type === "delete" && EffectTracker.hasPathUncertainty(effect) && isUnresolvedCatastrophicDelete(effect.path, platform),
        "**Danger:** may delete a broad unresolved path",
        platform
      );
    case RISK_REASON_CODES.RAW_BLOCK_DEVICE_WRITE:
      return (affected.specialTargets ?? []).filter((target) => target.kind === "block-device" && target.operation !== "delete-entry" && target.executionCertainty === "definite").map((target) => ({
        text: "**Danger:** may write raw data to a block device",
        paths: [pathSample(target.path, platform)]
      }));
    case RISK_REASON_CODES.OPAQUE_LOCAL_DESTRUCTIVE_SELECTION:
      return renderOpaqueLocalSelections(analysis, platform);
    case RISK_REASON_CODES.SPECIAL_DEVICE_SIDE_EFFECT:
      return (affected.specialTargets ?? []).filter((target) => !target.safeSink && target.kind !== "directory" && target.kind !== "symlink" && target.kind !== "other" && !(target.kind === "block-device" && target.operation !== "delete-entry" && target.executionCertainty === "definite")).map((target) => ({
        text: target.operation === "delete-entry" ? `May remove a ${target.kind} filesystem entry` : `May produce an external side effect through a ${target.kind}`,
        paths: [pathSample(target.path, platform)]
      }));
    case RISK_REASON_CODES.AFFECTED_FILE_COUNT_CRITICAL: {
      const policyCount = numberOr(affected.policyFileCount, affected.totalFileCount);
      const definiteCount = numberOr(affected.definitePolicyFileCount, policyCount);
      return [{
        text: affected.budgetExhausted ? `**Danger:** may destroy or replace more than ${policyCount} files` : `**Danger:** may destroy or replace ${definiteCount} files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform)
      }];
    }
    case RISK_REASON_CODES.AFFECTED_FILE_COUNT_RISKY: {
      const policyCount = numberOr(affected.policyFileCount, affected.totalFileCount);
      const definiteCount = numberOr(affected.definitePolicyFileCount, policyCount);
      return [{
        text: `May destroy or replace ${definiteCount} files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform)
      }];
    }
    case RISK_REASON_CODES.CONDITIONAL_AFFECTED_FILE_COUNT: {
      const policyCount = numberOr(affected.policyFileCount, affected.totalFileCount);
      return [{
        text: `May conditionally destroy or replace at least ${policyCount} files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform)
      }];
    }
    case RISK_REASON_CODES.SENSITIVE_EXTENSION:
      return renderSensitiveExtensions(affected, platform, true);
    case RISK_REASON_CODES.CONDITIONAL_SENSITIVE_EXTENSION:
      return renderSensitiveExtensions(affected, platform, false);
    case RISK_REASON_CODES.AFFECTED_TOTAL_SIZE: {
      const policyTotalSize = numberOr(affected.policyTotalSize, affected.totalSize);
      const definiteTotalSize = numberOr(affected.definitePolicyTotalSize, policyTotalSize);
      const mb = Math.round(definiteTotalSize / (1024 * 1024));
      return [{
        text: `**Danger:** may destroy or replace up to ${mb} MB of files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform)
      }];
    }
    case RISK_REASON_CODES.CONDITIONAL_AFFECTED_TOTAL_SIZE: {
      const policyTotalSize = numberOr(affected.policyTotalSize, affected.totalSize);
      const mb = Math.round(policyTotalSize / (1024 * 1024));
      return [{
        text: `May conditionally destroy or replace up to ${mb} MB of files`,
        paths: sampleFiles(affected.policyLargest ?? affected.largest, platform)
      }];
    }
    case RISK_REASON_CODES.OLD_AFFECTED_FILE: {
      const files = affected.definitePolicyOldest ?? affected.policyOldest ?? affected.oldest;
      const ageDays = fileAgeDays(files?.[0]);
      return [{
        text: ageDays === void 0 ? "**Danger:** may destroy or replace old files" : `**Danger:** may destroy or replace old files created ${ageDays} days ago`,
        paths: sampleFiles(files, platform)
      }];
    }
    case RISK_REASON_CODES.CONDITIONAL_OLD_AFFECTED_FILE: {
      const files = affected.conditionalPolicyOldest;
      const ageDays = fileAgeDays(files?.[0]);
      return [{
        text: ageDays === void 0 ? "May conditionally destroy or replace old files" : `May conditionally destroy or replace old files created ${ageDays} days ago`,
        paths: sampleFiles(files, platform)
      }];
    }
    case RISK_REASON_CODES.GIT_WORKTREE_DISCARD:
      return renderGitWorktreeRisks(analysis, platform);
    case RISK_REASON_CODES.EXTERNAL_RESOURCE_DESTRUCTION:
      return renderExternalResourceRisks(analysis, platform);
    case RISK_REASON_CODES.CONTAINER_HOST_WRITE_EXPOSURE:
      return (analysis.resourceEffects ?? []).filter((effect) => effect.domain === "container-bind-mount").map((effect) => ({
        text: "A container may modify files through a writable host bind mount",
        paths: effect.selection.root ? [pathSample(effect.selection.root, platform)] : void 0
      }));
  }
  return [];
}
function renderMatchingEffects(effects, matches, text, platform) {
  return (effects ?? []).filter(matches).map((effect) => ({ text, paths: [pathSample(effect.path, platform)] }));
}
function renderOpaqueLocalSelections(analysis, platform) {
  const rendered = [];
  for (const effect of analysis.effects ?? []) {
    if (!EffectTracker.hasPathUncertainty(effect) || !hasUnresolvedLocalPath(effect) || effect.type === "delete" && isUnresolvedCatastrophicDelete(effect.path, platform)) {
      continue;
    }
    rendered.push({
      text: "Could not enumerate a destructive local target",
      paths: [pathSample(effect.path, platform)]
    });
  }
  for (const observation of analysis.affected?.metadataUnavailable ?? []) {
    rendered.push({
      text: "Could not inspect a destructive local target",
      paths: [pathSample(observation.path, platform)]
    });
  }
  for (const effect of analysis.resourceEffects ?? []) {
    if (effect.domain !== "local-filesystem-selection") continue;
    rendered.push({
      text: `${effect.command} may delete files selected from derived or runtime input; exact targets are unavailable`,
      paths: effect.selection.root ? [pathSample(effect.selection.root, platform)] : void 0
    });
  }
  return rendered;
}
function renderSensitiveExtensions(affected, platform, definiteOnly) {
  const rendered = [];
  for (const group of affected.groups ?? []) {
    const extension = (group.extension || "").replace(/^\./, "").toLowerCase();
    if (!extension || !SENSITIVE_EXTENSIONS.has(extension)) continue;
    const count = numberOr(group.policyCount, group.totalCount);
    const definiteCount = numberOr(group.definitePolicyCount, count);
    if (count <= 0 || (definiteOnly ? definiteCount <= 0 : definiteCount > 0)) continue;
    rendered.push({
      text: count > 1 ? `${definiteOnly ? "**Danger:** May" : "May conditionally"} destroy or replace ${count} potentially important user files (.${extension})` : `${definiteOnly ? "**Danger:** May" : "May conditionally"} destroy or replace potentially important user data (.${extension})`,
      paths: sampleFiles(group.policyFiles ?? group.files, platform)
    });
  }
  return rendered;
}
function renderGitWorktreeRisks(analysis, platform) {
  const rendered = [];
  for (const effect of analysis.gitEffects ?? []) {
    if (effect.command !== "git reset" || effect.domain !== "worktree") continue;
    const submodules = effect.recurseSubmodules === true ? ", including active submodules" : "";
    let text;
    if (effect.mode === "hard") {
      text = `Git hard reset may discard uncommitted worktree changes${submodules}; repository dirty state was not inspected`;
    } else if (effect.mode === "merge") {
      text = `Git merge reset may replace staged worktree state${submodules}; repository state was not inspected`;
    } else if (effect.mode === "keep") {
      text = `Git keep reset may update worktree and index state${submodules}; local worktree changes should be preserved or make Git abort`;
    } else if (effect.mode === "unknown") {
      text = "Partially resolved Git reset arguments may select a worktree-discarding mode";
    }
    if (text) {
      rendered.push({
        text,
        paths: [pathSample(effect.repository.workTree ?? effect.repository.cwd, platform)]
      });
    }
  }
  for (const effect of analysis.resourceEffects ?? []) {
    if (effect.domain !== "git-worktree") continue;
    rendered.push({
      text: "Git clean may delete untracked or ignored worktree files; exact targets were not inspected",
      paths: effect.selection.root ? [pathSample(effect.selection.root, platform)] : void 0
    });
  }
  return rendered;
}
function renderExternalResourceRisks(analysis, platform) {
  const rendered = [];
  for (const effect of analysis.resourceEffects ?? []) {
    const target = effect.selection.target ? ` (${effect.selection.target})` : "";
    let text;
    if (effect.domain === "docker-volume") {
      text = "Docker Compose may delete persistent volumes; the Docker resource state was not inspected";
    } else if (effect.domain === "kubernetes") {
      text = `kubectl may delete Kubernetes resources${target}; cluster state was not inspected`;
    } else if (effect.domain === "helm") {
      text = `Helm may uninstall a release${target}; cluster release state was not inspected`;
    } else if (effect.domain === "terraform") {
      text = "Terraform may destroy managed resources; backend and plan state were not inspected";
    }
    if (text) {
      rendered.push({
        text,
        paths: effect.selection.root ? [pathSample(effect.selection.root, platform)] : void 0
      });
    }
  }
  return rendered;
}
function pathSample(path12, platform) {
  return { path: posixToNative(path12, platform) };
}
function sampleFiles(files, platform) {
  return (files ?? []).slice(0, 10).map((file) => ({
    ...file,
    path: posixToNative(file.path, platform)
  }));
}
function fileAgeDays(file) {
  const createdAt = Date.parse(file?.createdAt || "");
  if (!Number.isFinite(createdAt)) return void 0;
  const elapsed = Date.now() - createdAt;
  if (elapsed < 0) return void 0;
  return Math.floor(elapsed / (24 * 60 * 60 * 1e3));
}
function dedupeRenderedReasons(reasons) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const reason of reasons) {
    const key = `${reason.text}\0${reason.paths?.map((path12) => path12.path).join("\0") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reason);
  }
  return deduped;
}
function indexAffectedMetadata(affected, platform) {
  const indexed = /* @__PURE__ */ new Map();
  const samples = [
    ...affected?.oldest || [],
    ...affected?.largest || [],
    ...affected?.policyOldest || [],
    ...affected?.policyLargest || [],
    ...affected?.definitePolicyOldest || [],
    ...affected?.conditionalPolicyOldest || [],
    ...(affected?.groups || []).flatMap((group) => group.files),
    ...(affected?.groups || []).flatMap((group) => group.policyFiles || [])
  ];
  for (const sample of samples) {
    indexed.set(sample.path, sample);
    indexed.set(posixToNative(sample.path, platform), sample);
  }
  return indexed;
}
function withAffectedMetadata(file, indexed, platform) {
  const metadata = indexed.get(file.path) ?? indexed.get(posixToNative(file.path, platform));
  if (!metadata) return file;
  return {
    path: file.path,
    size: file.size ?? metadata.size,
    createdAt: file.createdAt ?? metadata.createdAt,
    modifiedAt: file.modifiedAt ?? metadata.modifiedAt,
    operations: file.operations ?? metadata.operations,
    executionCertainty: file.executionCertainty ?? metadata.executionCertainty,
    disposable: file.disposable ?? metadata.disposable
  };
}
function renderAffectedFiles(affected, opts) {
  if (!affected) return [];
  const count = Number.isFinite(affected.totalFileCount) && affected.totalFileCount >= 0 ? affected.totalFileCount : 0;
  const size = Number.isFinite(affected.totalSize) && affected.totalSize >= 0 ? formatBytes(affected.totalSize) : "size unavailable";
  const countLabel = affected.budgetExhausted ? `at least ${count}` : String(count);
  const out = [`Affected files found on disk: ${countLabel}, total size ${size}`];
  const policyCount = numberOr(affected.policyFileCount, count);
  const policySize = numberOr(affected.policyTotalSize, affected.totalSize);
  if (policyCount !== count || policySize !== affected.totalSize) {
    out.push(`- Policy-relevant files: ${policyCount}, total size ${formatBytes(policySize)}`);
  }
  if (count === 0) {
    out.push("- No regular-file extension or creation-time metadata was found.");
    return out;
  }
  const groups = affected.groups || [];
  const maxGroups = opts.maxAffectedGroups === void 0 ? 10 : opts.maxAffectedGroups;
  const maxFiles = opts.maxFilesPerGroup === void 0 ? 10 : opts.maxFilesPerGroup;
  for (const group of groups.slice(0, maxGroups)) {
    const extension = group.extension === "(no ext)" || !group.extension ? "(no extension)" : group.extension.startsWith(".") ? group.extension : `.${group.extension}`;
    const groupCount = Number.isFinite(group.totalCount) && group.totalCount >= 0 ? group.totalCount : group.files.length;
    const groupSize = Number.isFinite(group.totalSize) && group.totalSize >= 0 ? formatBytes(group.totalSize) : "size unavailable";
    out.push(`- Extension ${extension}: ${groupCount} ${groupCount === 1 ? "file" : "files"}, total size ${groupSize}`);
    for (const file of group.files.slice(0, maxFiles)) {
      out.push("    * " + renderFileMetadata(file, opts.platform));
    }
    if (groupCount > Math.min(group.files.length, maxFiles)) {
      out.push(`    * ... and ${groupCount - Math.min(group.files.length, maxFiles)} more`);
    }
  }
  if (groups.length > maxGroups) {
    out.push(`- ... and ${groups.length - maxGroups} more extensions`);
  }
  return out;
}
function renderFileMetadata(file, platform) {
  const size = typeof file.size === "number" && Number.isFinite(file.size) && file.size >= 0 ? formatBytes(file.size) : "unavailable";
  const createdAt = formatCreatedAt(file.createdAt);
  const operations = file.operations && file.operations.length > 0 ? `, operations ${file.operations.join("/")}` : "";
  const certainty = file.executionCertainty === "conditional" ? ", conditional" : "";
  return `${posixToNative(file.path, platform)}, size ${size}, created ${createdAt}${operations}${certainty}`;
}
function formatCreatedAt(value) {
  if (!value) return "unavailable";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(value);
}
function decide(analysis, opts) {
  if (!analysis || !analysis.available) {
    return { decision: "pass", severity: "safe", reasonCodes: [] };
  }
  const classified = classifyAnalysis(analysis, opts);
  const decision = classified.severity === "critical" ? "stop" : "pass";
  return {
    decision,
    severity: classified.severity,
    reasonCodes: classified.reasonCodes
  };
}

// src/plugin/guard.ts
var VER = "1.0.0";
var PLUGIN_ROOT = process.env["CODEBUDDY_PLUGIN_ROOT"] || __dirname;
var LOG_FILE = path11.join(PLUGIN_ROOT, "protector_log.txt");
var ENABLE_LOG = process.env["XW_ENABLE_LOG"] === "true";
var MAX_AFFECTED_SAMPLES = 10;
var MAX_FORWARD_EFFECTS = 50;
var MAX_FORWARD_GIT_EFFECTS = 50;
var MAX_FORWARD_RESOURCE_EFFECTS = 50;
var MAX_FORWARD_CONVERSATION_ID_BYTES = 256;
var SHELL_GUARD_DEFAULT_URL = "https://shell-guard.atuin.tencent.com";
var SHELL_GUARD_REVIEW_PATH = "/v1/xw_review_bash";
var SHELL_GUARD_TIMEOUT_MS = readPositiveInt(process.env["XW_SHELL_GUARD_TIMEOUT_MS"], 6e4);
var POWERSHELL_FILE_CACHE = /* @__PURE__ */ new Map();
var MAX_NESTED_SHELL_DEPTH = 4;
function log(msg) {
  if (ENABLE_LOG) {
    try {
      fs7.appendFileSync(LOG_FILE, msg + "\n");
    } catch {
    }
  }
}
function analyzeCommand(command, cwd, shell = "bash") {
  if (shell === "powershell" && !powerShellAnalysisEnabled()) {
    return { available: false, error: "PowerShell guard analysis is available only on Windows" };
  }
  try {
    const resolvedCwd = toPosix(cwd ?? process.cwd());
    const result = analyzeShellEffects(command, resolvedCwd, shell, 0);
    return buildAnalysis(result);
  } catch (err) {
    log(`shell analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function analyzeProtectedCommand(command, cwd, shell = "bash") {
  if (shell !== "bash") return analyzeCommand(command, cwd, shell);
  const resolvedCwd = toPosix(cwd ?? process.cwd());
  const effects = [];
  const gitEffects = [];
  const resourceEffects = [];
  const warnings = [];
  let successfulAnalyzers = 0;
  const failures = [];
  const secondaryPowerShellCommand = powerShellAnalysisEnabled() ? commandForSecondaryPowerShell(command) : null;
  const candidates = [
    { shell: "bash", script: command },
    ...secondaryPowerShellCommand === null ? [] : [{ shell: "powershell", script: secondaryPowerShellCommand }]
  ];
  for (const candidate of candidates) {
    try {
      const result = analyzeShellEffects(candidate.script, resolvedCwd, candidate.shell, 0);
      successfulAnalyzers++;
      effects.push(...result.effects);
      gitEffects.push(...result.gitEffects);
      resourceEffects.push(...result.resourceEffects);
      warnings.push(...candidate.shell === "powershell" ? result.warnings.map((w) => `powershell: ${w}`) : result.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${candidate.shell}: ${message}`);
      log(`protected ${candidate.shell} analysis failed: ${message}`);
    }
  }
  if (successfulAnalyzers === 0) {
    return { available: false, error: failures.join("; ") || "shell analysis failed" };
  }
  warnings.push(...failures.map((failure) => `analysis failed: ${failure}`));
  return buildAnalysis({
    effects: dedupeEffects(effects),
    gitEffects: dedupeGitEffects(gitEffects),
    resourceEffects: dedupeResourceEffects(resourceEffects),
    warnings
  });
}
function commandForSecondaryPowerShell(command) {
  const parsed = parse(command);
  let candidate = command;
  if (parsed.ast && stripBashHereDocuments(parsed.ast)) {
    candidate = print_command(parsed.ast);
  }
  return candidate.trim().length > 0 && shouldRunSecondaryPowerShell(candidate) ? candidate : null;
}
function shouldRunSecondaryPowerShell(command) {
  if (/\b(?:then|fi|esac|done)\b/.test(command)) return false;
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(command)) return false;
  if (/(^|[;&|]\s*)!?\s*(?:\(\(|\[\[)/.test(command)) return false;
  if (/(^|[;&|]\s*)\([^)]*(?:&&|\|\||;)[^)]*\)/.test(command)) return false;
  if (/(^|[;&|]\s*)\{[^}]*(?:&&|\|\||;)[^}]*\}/.test(command)) return false;
  return true;
}
function stripBashHereDocuments(command) {
  const filtered = withoutHereDocumentRedirects(command.redirects);
  command.redirects = filtered.redirects;
  let found = filtered.found;
  switch (command.type) {
    case "simple":
    case "arith":
    case "cond":
      break;
    case "connection":
      found = stripBashHereDocuments(command.first) || found;
      if (command.second) found = stripBashHereDocuments(command.second) || found;
      break;
    case "if":
      found = stripBashHereDocuments(command.test) || found;
      found = stripBashHereDocuments(command.true_case) || found;
      if (command.false_case) found = stripBashHereDocuments(command.false_case) || found;
      break;
    case "for":
    case "while":
    case "until":
      found = stripBashHereDocuments(command.action) || found;
      if (command.type === "while" || command.type === "until") {
        found = stripBashHereDocuments(command.test) || found;
      }
      break;
    case "case": {
      let clause = command.clauses;
      while (clause) {
        if (clause.action) found = stripBashHereDocuments(clause.action) || found;
        clause = clause.next;
      }
      break;
    }
    case "function_def":
      found = stripBashHereDocuments(command.command) || found;
      break;
    case "group":
    case "subshell":
      found = stripBashHereDocuments(command.command) || found;
      break;
  }
  return found;
}
function withoutHereDocumentRedirects(redirect) {
  let head = null;
  let tail = null;
  let found = false;
  let current = redirect;
  while (current) {
    const next = current.next;
    current.next = null;
    if (current.instruction === "r_reading_until" || current.instruction === "r_deblank_reading_until") {
      found = true;
    } else if (!head) {
      head = tail = current;
    } else {
      tail.next = current;
      tail = current;
    }
    current = next;
  }
  return { redirects: head, found };
}
function buildAnalysis(result) {
  const affected = postprocess(result.effects);
  const rawEffects = result.effects.map((e) => ({
    type: e.type,
    path: e.path,
    source: e.source,
    sourcePath: e.sourcePath,
    line: e.line,
    command: e.command,
    replacement: e.replacement,
    uncertain: !!e.uncertain,
    certainty: e.certainty,
    uncertainty: e.uncertainty
  }));
  const rawGitEffects = result.gitEffects.map((effect) => ({
    ...stripLocalProvenance(effect),
    repository: { ...effect.repository },
    selection: {
      ...effect.selection,
      pathspecs: effect.selection.pathspecs ? [...effect.selection.pathspecs] : void 0
    },
    uncertainty: [...effect.uncertainty]
  }));
  const rawResourceEffects = result.resourceEffects.map((effect) => ({
    ...stripLocalProvenance(effect),
    selection: { ...effect.selection },
    uncertainty: [...effect.uncertainty]
  }));
  return {
    available: true,
    effects: rawEffects,
    effectsTotal: rawEffects.length,
    gitEffects: rawGitEffects,
    gitEffectsTotal: rawGitEffects.length,
    resourceEffects: rawResourceEffects,
    resourceEffectsTotal: rawResourceEffects.length,
    warnings: result.warnings.slice(0, 20),
    affected: {
      totalFileCount: affected.totalFileCount,
      totalSize: affected.totalSize,
      policyFileCount: affected.policyFileCount,
      policyTotalSize: affected.policyTotalSize,
      definitePolicyFileCount: affected.definitePolicyFileCount,
      definitePolicyTotalSize: affected.definitePolicyTotalSize,
      conditionalPolicyFileCount: affected.conditionalPolicyFileCount,
      conditionalPolicyTotalSize: affected.conditionalPolicyTotalSize,
      budgetExhausted: affected.budgetExhausted,
      budgetExhaustedCertainty: affected.budgetExhaustedCertainty,
      visitedEntries: affected.visitedEntries,
      maxDepthReached: affected.maxDepthReached,
      oldest: sampleAffected(affected.oldest),
      largest: sampleAffected(affected.largest),
      policyOldest: sampleAffected(affected.policyOldest),
      policyLargest: sampleAffected(affected.policyLargest),
      definitePolicyOldest: sampleAffected(affected.definitePolicyOldest),
      conditionalPolicyOldest: sampleAffected(affected.conditionalPolicyOldest),
      groups: sampleGroups(affected.groups),
      // Observation-to-effect links are local provenance and are not part of
      // the cloud-review payload or policy input.
      specialTargets: affected.specialTargets.map((target) => ({
        path: target.path,
        kind: target.kind,
        operation: target.operation,
        executionCertainty: target.executionCertainty,
        safeSink: target.safeSink
      })),
      metadataUnavailable: affected.metadataUnavailable.map((observation) => ({
        path: observation.path,
        operation: observation.operation,
        executionCertainty: observation.executionCertainty,
        error: observation.error
      }))
    }
  };
}
function dedupeEffects(effects) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const effect of effects) {
    const key = [
      effect.type,
      effect.path,
      effect.sourcePath ?? effect.source ?? "",
      effect.replacement ?? "",
      effect.line,
      effect.uncertain ? "1" : "0",
      (effect.uncertainty ?? []).join(",")
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(effect);
  }
  return deduped;
}
function dedupeGitEffects(effects) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const effect of effects) {
    const key = [
      effect.command,
      effect.domain,
      effect.operation,
      effect.mode,
      effect.repository.cwd,
      effect.repository.gitDir ?? "",
      effect.repository.workTree ?? "",
      effect.repository.bare ? "1" : "0",
      effect.repository.forcedBare ? "1" : "0",
      effect.repository.confidence,
      effect.selection.kind,
      effect.selection.pathspecFile ?? "",
      (effect.selection.pathspecs ?? []).join("\0"),
      effect.target ?? "",
      effect.line,
      effect.recoverability,
      effect.executionMode,
      String(effect.recurseSubmodules),
      effect.privileged ? "1" : "0",
      effect.completeness,
      effect.certainty,
      effect.uncertain ? "1" : "0",
      effect.uncertainty.join(",")
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(effect);
  }
  return deduped;
}
function dedupeResourceEffects(effects) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const effect of effects) {
    const key = [
      effect.domain,
      effect.operation,
      effect.command,
      effect.selection.kind,
      effect.selection.root ?? "",
      effect.selection.target ?? "",
      effect.executionMode,
      effect.recoverability,
      effect.completeness,
      effect.privileged ? "1" : "0",
      effect.line,
      effect.certainty,
      effect.uncertain ? "1" : "0",
      effect.uncertainty.join(",")
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(effect);
  }
  return deduped;
}
function analyzeShellEffects(command, cwd, shell, depth, env, inheritEnv = true, args) {
  if (shell === "powershell" && !powerShellAnalysisEnabled()) {
    return {
      effects: [],
      gitEffects: [],
      resourceEffects: [],
      warnings: ["PowerShell guard analysis skipped because the host is not Windows"]
    };
  }
  const primaryResult = shell === "powershell" ? analyzePowerShell(command, { cwd, env, inheritEnv, args, realFs: true }) : analyze(command, { cwd, env, inheritEnv, args, realFs: true });
  const result = {
    effects: [...primaryResult.effects],
    gitEffects: [...primaryResult.gitEffects],
    resourceEffects: [...primaryResult.resourceEffects],
    warnings: [...primaryResult.warnings]
  };
  if (depth >= MAX_NESTED_SHELL_DEPTH) {
    result.warnings.push(`nested shell analysis stopped after depth ${MAX_NESTED_SHELL_DEPTH}`);
    return result;
  }
  for (const invocation of extractNestedShellInvocations(command, cwd, shell, env, inheritEnv, args)) {
    const nested = analyzeShellEffects(
      invocation.script,
      invocation.cwd,
      invocation.shell,
      depth + 1,
      invocation.env,
      invocation.inheritEnv,
      invocation.args
    );
    result.effects.push(...nested.effects);
    result.gitEffects.push(...nested.gitEffects);
    result.resourceEffects.push(...nested.resourceEffects);
    result.warnings.push(...nested.warnings.map((w) => `${invocation.shell}: ${w}`));
  }
  return result;
}
function extractNestedShellInvocations(command, cwd, shell, env, inheritEnv = true, args) {
  return shell === "powershell" ? extractPowerShellNestedShells(command, cwd, env, inheritEnv, args) : extractBashNestedShells(command, cwd, env, inheritEnv, args);
}
function extractBashNestedShells(command, cwd, initialEnv, inheritEnv = true, args) {
  const parsed = parse(command);
  if (!parsed.ast) return [];
  const env = new VariableEnvironment({ ...initialEnv, PWD: cwd }, inheritEnv);
  if (args) env.set_positional_params(args);
  return collectShellScripts(parsed.ast, /* @__PURE__ */ new Map(), env);
}
function collectShellScripts(command, functions, env) {
  switch (command.type) {
    case "simple": {
      const restore = applyAssignments(command, env);
      try {
        const substitutions = [
          ...commandSubstitutionsInWords(command.assignments, currentCwd(env)),
          ...commandSubstitutionsInWords(command.words, currentCwd(env)),
          ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env))
        ];
        const words = expandSimpleWords(command, env);
        const invocation = resolveInvocation(words, { cwd: currentCwd(env) });
        if (invocation.completeness !== "complete" || invocation.queryOnly || invocation.exitsEarly || !invocation.commandName) {
          return substitutions;
        }
        const allowsShellBuiltins = invocation.identityConfidence === "bare-name" && invocation.wrapperChain.every((frame) => frame.name === "command");
        if (allowsShellBuiltins && invocation.commandName === "cd") {
          applyCd([invocation.commandName, ...invocation.args], env);
          return substitutions;
        }
        const functionBody = invocation.bypassFunctions ? void 0 : functions.get(invocation.commandName);
        if (functionBody) return [...substitutions, ...collectShellScripts(functionBody, functions, env)];
        return [
          ...substitutions,
          ...extractShellFromInvocation(invocation, env, hereDocBody(command.redirects))
        ];
      } finally {
        restore();
      }
    }
    case "connection":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.first, functions, env),
        ...command.second ? collectShellScripts(command.second, functions, env) : []
      ];
    case "if":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.test, functions, env),
        ...collectShellScripts(command.true_case, functions, env),
        ...command.false_case ? collectShellScripts(command.false_case, functions, env) : []
      ];
    case "for":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...commandSubstitutionsInWords(command.map_list, currentCwd(env)),
        ...collectForShellScripts(command.name.word, command.map_list, command.action, functions, env)
      ];
    case "while":
    case "until":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.test, functions, env),
        ...collectShellScripts(command.action, functions, env)
      ];
    case "case": {
      const found = [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...commandSubstitutionsInWords([command.word], currentCwd(env))
      ];
      let clause = command.clauses;
      while (clause) {
        found.push(...commandSubstitutionsInWords(clause.patterns, currentCwd(env)));
        if (clause.action) found.push(...collectShellScripts(clause.action, functions, env));
        clause = clause.next;
      }
      return found;
    }
    case "function_def": {
      functions.set(command.name.word, command.command);
      return [];
    }
    case "group":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectShellScripts(command.command, functions, env)
      ];
    case "subshell": {
      const snapshot = env.snapshot();
      try {
        return [
          ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
          ...collectShellScripts(command.command, functions, env)
        ];
      } finally {
        env.restore(snapshot);
      }
    }
    case "arith":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...commandSubstitutionsInWords([command.expression], currentCwd(env))
      ];
    case "cond":
      return [
        ...commandSubstitutionsInRedirects(command.redirects, currentCwd(env)),
        ...collectConditionalShellScripts(command.expression, env).invocations
      ];
  }
}
function collectConditionalShellScripts(node, env) {
  let result;
  if (node.type === COND_AND || node.type === COND_OR) {
    result = collectConditionalLogicalShellScripts(node, env);
  } else if (node.type === COND_EXPR && node.left) {
    result = collectConditionalShellScripts(node.left, env);
  } else if (node.type === COND_TERM) {
    const operand = inspectConditionalWord(node.op, env);
    result = {
      invocations: operand.invocations,
      truth: operand.exact ? conditionalTruth(operand.value.length > 0) : "unknown"
    };
  } else if (node.type === COND_UNARY) {
    result = collectConditionalUnaryShellScripts(node, env);
  } else if (node.type === COND_BINARY) {
    result = collectConditionalBinaryShellScripts(node, env);
  } else if (node.type === COND_UNKNOWN) {
    result = {
      invocations: commandSubstitutionsInWords(
        node.words ?? [],
        currentCwd(env)
      ),
      truth: "unknown"
    };
  } else {
    result = { invocations: [], truth: "unknown" };
  }
  return (node.flags & CMD_INVERT_RETURN) !== 0 ? { ...result, truth: invertConditionalTruth(result.truth) } : result;
}
function collectConditionalLogicalShellScripts(node, env) {
  if (!node.left || !node.right) {
    return { invocations: [], truth: "unknown" };
  }
  const left = collectConditionalShellScripts(node.left, env);
  if (node.type === COND_AND && left.truth === "false") return left;
  if (node.type === COND_OR && left.truth === "true") return left;
  const right = collectConditionalShellScripts(node.right, env);
  let truth;
  if (node.type === COND_AND) {
    truth = left.truth === "true" ? right.truth : right.truth === "false" ? "false" : "unknown";
  } else {
    truth = left.truth === "false" ? right.truth : right.truth === "true" ? "true" : "unknown";
  }
  return {
    invocations: [...left.invocations, ...right.invocations],
    truth
  };
}
function collectConditionalUnaryShellScripts(node, env) {
  const operand = inspectConditionalWord(node.left?.op ?? null, env);
  let truth = "unknown";
  if (operand.exact) {
    const operator = node.op?.word ?? "";
    if (operator === "-n") truth = conditionalTruth(operand.value.length > 0);
    else if (operator === "-z") truth = conditionalTruth(operand.value.length === 0);
    else if (operator === "-v" && /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u.test(operand.value)) {
      const variable = env.find_variable(operand.value);
      truth = variable?.uncertain ? "unknown" : conditionalTruth(variable !== void 0);
    }
  }
  return { invocations: operand.invocations, truth };
}
function collectConditionalBinaryShellScripts(node, env) {
  const left = inspectConditionalWord(node.left?.op ?? null, env);
  const right = inspectConditionalWord(node.right?.op ?? null, env);
  let truth = "unknown";
  if (left.exact && right.exact) {
    const operator = node.op?.word ?? "";
    if ((operator === "=" || operator === "==" || operator === "!=") && !hasUnquotedConditionalPattern(node.right?.op?.word ?? "") && !hasConditionalPatternValue(right.value)) {
      const equal = left.value === right.value;
      truth = conditionalTruth(operator === "!=" ? !equal : equal);
    } else if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) {
      truth = compareConditionalIntegers(left.value, operator, right.value);
    }
  }
  return {
    invocations: [...left.invocations, ...right.invocations],
    truth
  };
}
function inspectConditionalWord(word, env) {
  if (!word) return { invocations: [], value: "", exact: false };
  const expanded = expand_word_to_string(word.word, env);
  return {
    invocations: commandSubstitutionInvocations(
      word.word,
      currentCwd(env),
      false
    ),
    value: expanded.word,
    exact: !expanded.uncertain
  };
}
function hasUnquotedConditionalPattern(word) {
  let quote = null;
  for (let index = 0; index < word.length; index++) {
    const char = word[index];
    if (char === "\\" && quote !== "'") {
      index++;
      continue;
    }
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (quote !== null) continue;
    if (char === "*" || char === "?" || char === "[") return true;
    if ("@+!".includes(char) && word[index + 1] === "(") return true;
  }
  return false;
}
function hasConditionalPatternValue(value) {
  return value.includes("*") || value.includes("?") || value.includes("[") || /(?:^|[^\\])[@+!]\(/u.test(value);
}
function compareConditionalIntegers(left, operator, right) {
  if (!/^[+-]?[0-9]+$/u.test(left) || !/^[+-]?[0-9]+$/u.test(right)) {
    return "unknown";
  }
  try {
    const lhs = BigInt(left);
    const rhs = BigInt(right);
    if (operator === "-eq") return conditionalTruth(lhs === rhs);
    if (operator === "-ne") return conditionalTruth(lhs !== rhs);
    if (operator === "-lt") return conditionalTruth(lhs < rhs);
    if (operator === "-le") return conditionalTruth(lhs <= rhs);
    if (operator === "-gt") return conditionalTruth(lhs > rhs);
    return conditionalTruth(lhs >= rhs);
  } catch {
    return "unknown";
  }
}
function conditionalTruth(value) {
  return value ? "true" : "false";
}
function invertConditionalTruth(value) {
  if (value === "true") return "false";
  if (value === "false") return "true";
  return "unknown";
}
function commandSubstitutionsInWords(words, cwd) {
  return words.flatMap((word) => commandSubstitutionInvocations(word.word, cwd, false));
}
function commandSubstitutionsInRedirects(redirect, cwd) {
  const invocations = [];
  let current = redirect;
  while (current) {
    const body = current.redirectee.filename?.word;
    if (body !== void 0) {
      const hereDocument = current.instruction === "r_reading_until" || current.instruction === "r_deblank_reading_until";
      if (!hereDocument || !current.here_doc_quoted) {
        invocations.push(...commandSubstitutionInvocations(body, cwd, hereDocument));
      }
    }
    current = current.next;
  }
  return invocations;
}
function commandSubstitutionInvocations(text, cwd, hereDocument) {
  return extractCommandSubstitutionScripts(text, hereDocument).map((script) => ({ script, cwd, shell: "bash" }));
}
function extractCommandSubstitutionScripts(text, hereDocument) {
  const scripts = [];
  let quote = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (!hereDocument && quote === "single") {
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1] ?? "";
      if (!hereDocument || next === "$" || next === "`" || next === "\\" || next === "\n") {
        i += Math.min(2, text.length - i);
      } else {
        i++;
      }
      continue;
    }
    if (!hereDocument && c === "'" && quote !== "double") {
      quote = "single";
      i++;
      continue;
    }
    if (!hereDocument && c === '"') {
      quote = quote === "double" ? null : quote === null ? "double" : quote;
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      if (text[i + 2] === "(") {
        i += 3;
        continue;
      }
      const end = findCommandSubstitutionEnd(text, i);
      if (end === null) break;
      scripts.push(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = findBacktickEnd(text, i);
      if (end === null) break;
      scripts.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return scripts;
}
function findCommandSubstitutionEnd(text, start) {
  let quote = null;
  let depth = 1;
  let i = start + 2;
  while (i < text.length) {
    const c = text[i];
    if (quote === "single") {
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === "\\") {
      i += Math.min(2, text.length - i);
      continue;
    }
    if (c === "'" && quote !== "double") {
      quote = "single";
      i++;
      continue;
    }
    if (c === '"') {
      quote = quote === "double" ? null : quote === null ? "double" : quote;
      i++;
      continue;
    }
    if (c === "`") {
      const end = findBacktickEnd(text, i);
      if (end === null) return null;
      i = end + 1;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const nested = findCommandSubstitutionEnd(text, i);
      if (nested === null) return null;
      i = nested + 1;
      continue;
    }
    if (quote === null && c === "(") {
      depth++;
    } else if (quote === null && c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}
function findBacktickEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += Math.min(2, text.length - i);
      continue;
    }
    if (text[i] === "`") return i;
    i++;
  }
  return null;
}
function applyAssignments(command, env) {
  const snapshot = command.assignments.length > 0 && command.words.length > 0 ? env.snapshot_variables(command.assignments.map((assignment) => assignment_name(assignment.word))) : null;
  for (const assignment of command.assignments) {
    const name = assignment_name(assignment.word);
    const rawValue = assignment_value(assignment.word);
    const expanded = expand_word_to_string(rawValue, env);
    env.bind_variable(name, expanded.word);
  }
  return () => {
    if (snapshot) env.restore_variables(snapshot);
  };
}
function expandSimpleWords(command, env) {
  return expand_words(command.words, env, {
    maxWords: MAX_EXPANDED_WORDS
  }).map((word) => word.word);
}
function collectForShellScripts(name, mapList, action, functions, env) {
  const items = expand_words(mapList, env, {
    maxWords: MAX_EXPANDED_WORDS
  }).map((word) => word.word);
  const snapshot = env.snapshot_variables([name]);
  const invocations = [];
  try {
    for (const item of items) {
      env.bind_variable(name, item);
      invocations.push(...collectShellScripts(action, functions, env));
    }
  } finally {
    env.restore_variables(snapshot);
  }
  return invocations;
}
function applyCd(words, env) {
  const target = words[1];
  if (!target || EffectTrackerLike.hasUncertainty(target)) return;
  const oldPwd = currentCwd(env);
  const next = target === "-" ? env.get_string_value("OLDPWD") ?? oldPwd : resolveAgainst(oldPwd, target);
  env.bind_variable("OLDPWD", oldPwd);
  env.bind_variable("PWD", next);
}
function currentCwd(env) {
  return env.get_string_value("PWD") ?? process.cwd();
}
function resolveAgainst(cwd, target) {
  const posixTarget = toPosix(target);
  if (posixTarget.startsWith("/") || isWindowsDriveAbsolute(posixTarget)) return path11.posix.normalize(posixTarget);
  return path11.posix.normalize(path11.posix.join(cwd, posixTarget));
}
function isWindowsDriveAbsolute(value) {
  return value.length >= 2 && value[0] === "/" && isAsciiAlpha3(value[1]) && (value.length === 2 || value[2] === "/");
}
function isAsciiAlpha3(value) {
  if (value.length === 0) return false;
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}
var EffectTrackerLike = {
  hasUncertainty(value) {
    return value.includes("$") || value.includes("*") || value.includes("?");
  }
};
function extractShellFromInvocation(invocation, parentEnv, stdinScript) {
  if (invocation.completeness !== "complete" || invocation.queryOnly || invocation.exitsEarly || !invocation.commandName) return [];
  const scripts = [];
  const executable = powerShellAnalysisEnabled() ? invocation.commandName.toLowerCase() : invocation.commandName;
  const shell = shellKindForExecutable2(executable);
  if (!shell) return scripts;
  const context = childInvocationContext(invocation, parentEnv);
  const makeInvocation = (script, targetShell, args2) => ({
    script,
    cwd: invocation.cwd,
    shell: targetShell,
    args: args2,
    ...context,
    privileged: invocation.privileged
  });
  const args = invocation.args;
  if (executable === "cmd") {
    const cmdIndex = args.findIndex((word) => word.toLowerCase() === "/c");
    if (cmdIndex >= 0) scripts.push(makeInvocation(args.slice(cmdIndex + 1).join(" "), "bash"));
    return scripts;
  }
  if (executable === "bash" || executable === "sh" || executable === "zsh") {
    const resolved = resolveBashCommandString(args);
    if (resolved.script !== void 0) {
      scripts.push(makeInvocation(resolved.script, "bash", resolved.args));
    }
    return scripts;
  }
  for (let j = 0; j < args.length; j++) {
    const arg = args[j].toLowerCase();
    if (arg === "-command" || arg === "-c") {
      const script = args.slice(j + 1).join(" ");
      if (script === "-" && stdinScript && stdinScript.length > 0) {
        scripts.push(makeInvocation(stdinScript, shell));
      } else if (script.length > 0) {
        scripts.push(makeInvocation(script, shell));
      }
      break;
    }
    if (arg === "-encodedcommand" || arg === "-enc" || arg === "-e") {
      const encoded = args[j + 1];
      if (encoded !== void 0) {
        const decoded = decodePowerShellCommand(encoded);
        if (decoded.length > 0) scripts.push(makeInvocation(decoded, "powershell"));
      }
      break;
    }
    if (shell === "powershell" && (arg === "-file" || arg === "-f")) {
      const filePath = args[j + 1];
      if (filePath !== void 0 && filePath !== "-") {
        const loaded = readPowerShellFile(invocation.cwd, filePath, args.slice(j + 2));
        if (loaded) scripts.push({ ...loaded, ...context, privileged: invocation.privileged });
      }
      break;
    }
  }
  return scripts;
}
function shellKindForExecutable2(executable) {
  if (executable === "pwsh" || executable === "pwsh.exe" || executable === "powershell" || executable === "powershell.exe") return "powershell";
  if (executable === "bash" || executable === "bash.exe" || executable === "sh" || executable === "sh.exe" || executable === "zsh" || executable === "zsh.exe") return "bash";
  if (executable === "wsl" || executable === "wsl.exe") return "bash";
  if (executable === "cmd" || executable === "cmd.exe") return "bash";
  return null;
}
function childInvocationContext(invocation, parentEnv) {
  const hasUnset = Object.values(invocation.envOverlay).some((value) => value === void 0);
  let inheritEnv = parentEnv === void 0 && !invocation.clearEnvironment && !hasUnset;
  let env;
  if (parentEnv) env = invocation.clearEnvironment ? emptyEnvironmentRecord() : parentEnv.to_record();
  else if (inheritEnv) env = emptyEnvironmentRecord();
  else env = invocation.clearEnvironment ? emptyEnvironmentRecord() : new VariableEnvironment().to_record();
  for (const [name, value] of Object.entries(invocation.envOverlay)) {
    if (value === void 0) delete env[name];
    else env[name] = value;
  }
  env["PWD"] = invocation.cwd;
  if (parentEnv) inheritEnv = false;
  return { env, inheritEnv };
}
function emptyEnvironmentRecord() {
  return /* @__PURE__ */ Object.create(null);
}
function extractPowerShellNestedShells(command, cwd, env, inheritEnv = true, args) {
  const parsed = analyzePowerShell(command, { cwd, env, inheritEnv, args });
  const invocations = [];
  const shellEnv = new VariableEnvironment(env, inheritEnv);
  collectPowerShellAstInvocations(parsed.ast.statements, cwd, shellEnv, invocations);
  return invocations;
}
function collectPowerShellAstInvocations(statements, cwd, env, invocations) {
  for (const statement of statements) {
    if (statement.type === "block") {
      collectPowerShellAstInvocations(statement.body, cwd, env, invocations);
      continue;
    }
    for (const command of statement.commands) {
      const words = [command.name.text, ...command.args.map((arg) => arg.text)];
      const resolved = resolveInvocation(words, { cwd });
      invocations.push(...extractShellFromInvocation(resolved, env));
    }
  }
}
function hereDocBody(redirect) {
  let current = redirect;
  while (current) {
    if ((current.instruction === "r_reading_until" || current.instruction === "r_deblank_reading_until") && current.redirectee.filename?.word !== void 0) {
      return current.redirectee.filename.word;
    }
    current = current.next;
  }
  return void 0;
}
function readPowerShellFile(cwd, filePath, args) {
  const resolved = resolveAgainst(cwd, filePath);
  const normalizedCwd = path11.posix.normalize(cwd);
  if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd.endsWith("/") ? normalizedCwd : normalizedCwd + "/")) {
    return null;
  }
  try {
    const nativePath = toNative(resolved);
    const stat = fs7.statSync(nativePath);
    if (!stat.isFile()) return null;
    const cached = POWERSHELL_FILE_CACHE.get(resolved);
    const script = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size ? cached.script : fs7.readFileSync(nativePath, "utf8");
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      POWERSHELL_FILE_CACHE.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, script });
    }
    return {
      script,
      cwd: path11.posix.dirname(resolved),
      shell: "powershell",
      args
    };
  } catch {
    return null;
  }
}
function decodePowerShellCommand(encoded) {
  try {
    return trimTrailingNuls(Buffer.from(encoded, "base64").toString("utf16le"));
  } catch {
    return "";
  }
}
function trimTrailingNuls(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "\0") end--;
  return value.slice(0, end);
}
function protect(command, cwd, shell = "bash") {
  const analysis = analyzeProtectedCommand(command, cwd, shell);
  const verdict = decide(analysis);
  return buildProtectResult(verdict, analysis);
}
async function protectWithReview(command, cwd, shell = "bash") {
  const result = protect(command, cwd, shell);
  return reviewProtectResult(result, command, cwd, shell);
}
async function reviewProtectResult(result, command, cwd, shell = "bash", conversationId) {
  const reviewEnabled = cloudReviewEnabled();
  const localResult = applyOfflineRiskPolicy(result, reviewEnabled);
  if (localResult.severity === "safe" || !reviewEnabled) {
    return applyBlockSuppression(localResult, command);
  }
  const wireConversationId = conversationIdForWire(conversationId);
  const review = await callBashReview({
    version: VER,
    ...wireConversationId === void 0 ? {} : { conversation_id: wireConversationId },
    platform: process.platform,
    cwd: cwd ?? process.cwd(),
    command,
    shell,
    severity: result.severity,
    reasonCodes: result.reasonCodes,
    analysis: trimAnalysisForWire(result.analysis)
  });
  if (review?.decision === "pass") {
    if (result.decision !== "pass") log(`cloud review pass overruled local ${result.decision}`);
    return {
      ...result,
      decision: "pass",
      detail: ""
    };
  }
  if (review?.decision === "block" || review?.decision === "stop") {
    return applyBlockSuppression({
      ...result,
      decision: review.decision,
      detail: renderReasonCodesDetailed(result.reasonCodes, result.analysis, {
        platform: process.platform
      }),
      needUpdate: review.need_update === true
    }, command);
  }
  return applyBlockSuppression(result, command);
}
function applyBlockSuppression(result, command) {
  if (result.decision !== "block") return result;
  const declaredIds = parseSuppressionRiskIds(command);
  const currentIds = normalizedRiskIds2(result.reasonCodes);
  if (declaredIds === null || currentIds.length === 0 || declaredIds.length !== currentIds.length || declaredIds.some((id, index) => id !== currentIds[index])) {
    return result;
  }
  return {
    ...result,
    decision: "pass",
    detail: ""
  };
}
function parseSuppressionRiskIds(command) {
  const newline = command.indexOf("\n");
  const firstLineWithPossibleCr = newline < 0 ? command : command.slice(0, newline);
  const firstLine = firstLineWithPossibleCr.endsWith("\r") ? firstLineWithPossibleCr.slice(0, -1) : firstLineWithPossibleCr;
  const match = /^# atuin-suppress-warning: ([1-9]\d*(?:,[1-9]\d*)*)$/.exec(firstLine);
  if (!match) return null;
  const ids = match[1].split(",").map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids.sort((left, right) => left - right);
}
function normalizedRiskIds2(reasonCodes) {
  return [...new Set(reasonCodes.filter((code) => Number.isSafeInteger(code)))].sort((left, right) => left - right);
}
function applyOfflineRiskPolicy(result, reviewEnabled = cloudReviewEnabled()) {
  if (reviewEnabled || result.severity !== "risky" || result.decision !== "pass") return result;
  return {
    ...result,
    decision: "block",
    detail: renderReasonCodesDetailed(result.reasonCodes, result.analysis, {
      platform: process.platform
    })
  };
}
function buildProtectResult(verdict, analysis) {
  const detail = verdict.decision !== "pass" ? renderReasonCodesDetailed(verdict.reasonCodes, analysis, {
    platform: process.platform
  }) : "";
  return {
    decision: verdict.decision,
    severity: verdict.severity,
    reasonCodes: verdict.reasonCodes,
    detail,
    analysis
  };
}
async function callBashReview(payload) {
  try {
    const body = await postToShellGuard(SHELL_GUARD_REVIEW_PATH, payload);
    if (body?.decision === "pass" || body?.decision === "block" || body?.decision === "stop") {
      return {
        decision: body.decision,
        need_update: body.need_update === true
      };
    }
    log(`cloud review returned unexpected response: ${JSON.stringify(body)}`);
  } catch (err) {
    log(`cloud review failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}
async function postToShellGuard(endpoint, payload) {
  const fetchFn = globalThis.fetch;
  if (!fetchFn) throw new Error("fetch is unavailable");
  const installationId = getInstallationId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHELL_GUARD_TIMEOUT_MS);
  try {
    const response = await fetchFn(shellGuardUrl(endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Accept-Encoding": "br, gzip",
        "X-Service-Id": "atuin",
        "User-Agent": `Atuin Shell Guard/${VER}`,
        ...installationId ? { "x-atuin-iid": installationId } : {}
      },
      body: zlib.gzipSync(JSON.stringify(payload)),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text || "{}");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const timeoutError = new Error(`POST ${endpoint} timed out`);
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
function trimAnalysisForWire(analysis) {
  const effects = analysis.effects ?? [];
  let kept = effects;
  if (effects.length > MAX_FORWARD_EFFECTS) {
    const important = effects.filter((effect) => isSystemPath2(effect.path) || isCatastrophicPath2(effect.path) || !!effect.uncertain);
    const regular = effects.filter((effect) => !important.includes(effect));
    kept = important.slice(0, MAX_FORWARD_EFFECTS);
    for (const effect of regular) {
      if (kept.length >= MAX_FORWARD_EFFECTS) break;
      kept.push(effect);
    }
  }
  const gitEffects = analysis.gitEffects ?? [];
  const keptGitEffects = gitEffects.slice(0, MAX_FORWARD_GIT_EFFECTS);
  const resourceEffects = analysis.resourceEffects ?? [];
  const keptResourceEffects = resourceEffects.slice(0, MAX_FORWARD_RESOURCE_EFFECTS);
  return {
    available: analysis.available,
    effects: kept.map((effect) => ({
      type: effect.type,
      path: effect.path,
      source: effect.source,
      sourcePath: effect.sourcePath,
      line: effect.line,
      command: effect.command,
      uncertain: effect.uncertain,
      certainty: effect.certainty,
      uncertainty: [...effect.uncertainty]
    })),
    effectsTotal: analysis.effectsTotal,
    gitEffects: keptGitEffects.map(stripLocalProvenance),
    gitEffectsTotal: analysis.gitEffectsTotal,
    resourceEffects: keptResourceEffects.map(stripLocalProvenance),
    resourceEffectsTotal: analysis.resourceEffectsTotal,
    warnings: analysis.warnings,
    affected: trimAffectedForWire(analysis.affected),
    error: analysis.error,
    effectsTruncated: effects.length > kept.length,
    gitEffectsTruncated: gitEffects.length > keptGitEffects.length,
    resourceEffectsTruncated: resourceEffects.length > keptResourceEffects.length
  };
}
function stripLocalProvenance(effect) {
  const copy = { ...effect };
  delete copy.provenance;
  return copy;
}
function trimAffectedForWire(affected) {
  if (!affected) return void 0;
  return {
    totalFileCount: affected.totalFileCount,
    totalSize: affected.totalSize,
    policyFileCount: affected.policyFileCount,
    policyTotalSize: affected.policyTotalSize,
    definitePolicyFileCount: affected.definitePolicyFileCount,
    definitePolicyTotalSize: affected.definitePolicyTotalSize,
    conditionalPolicyFileCount: affected.conditionalPolicyFileCount,
    conditionalPolicyTotalSize: affected.conditionalPolicyTotalSize,
    budgetExhausted: affected.budgetExhausted,
    budgetExhaustedCertainty: affected.budgetExhaustedCertainty,
    oldest: (affected.oldest ?? []).map(trimSampleForWire),
    largest: (affected.largest ?? []).map(trimSampleForWire),
    groups: (affected.groups ?? []).map((group) => ({
      extension: group.extension,
      totalCount: group.totalCount,
      totalSize: group.totalSize,
      files: group.files.map(trimSampleForWire)
    })),
    specialTargets: (affected.specialTargets ?? []).slice(0, MAX_AFFECTED_SAMPLES).map((target) => ({
      path: target.path,
      kind: target.kind,
      operation: target.operation,
      executionCertainty: target.executionCertainty,
      safeSink: target.safeSink
    })),
    metadataUnavailable: (affected.metadataUnavailable ?? []).slice(0, MAX_AFFECTED_SAMPLES).map((observation) => ({
      path: observation.path,
      operation: observation.operation,
      executionCertainty: observation.executionCertainty,
      error: observation.error
    }))
  };
}
function trimSampleForWire(file) {
  return {
    path: file.path,
    size: file.size,
    createdAt: file.createdAt
  };
}
function cloudReviewEnabled() {
  return getCloudReviewSetting() === "yes";
}
function conversationIdForWire(value) {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_FORWARD_CONVERSATION_ID_BYTES) {
    return void 0;
  }
  return value;
}
function shellGuardUrl(endpoint) {
  const base = process.env["XW_SHELL_GUARD_URL"] || SHELL_GUARD_DEFAULT_URL;
  return `${base.replace(/\/+$/, "")}${endpoint}`;
}
function readPositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function sampleAffected(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_AFFECTED_SAMPLES).map((f) => ({
    path: f.path,
    createdAt: f.createdAt.toISOString(),
    modifiedAt: f.modifiedAt.toISOString(),
    size: f.size,
    operations: [...f.operations],
    executionCertainty: f.executionCertainty,
    disposable: f.disposable
  }));
}
function sampleGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map((g) => ({
    extension: g.extension,
    totalCount: g.totalCount,
    totalSize: g.totalSize,
    policyCount: g.policyCount,
    policySize: g.policySize,
    definitePolicyCount: g.definitePolicyCount,
    definitePolicySize: g.definitePolicySize,
    conditionalPolicyCount: g.conditionalPolicyCount,
    conditionalPolicySize: g.conditionalPolicySize,
    disposable: g.disposable,
    files: sampleAffected(g.files),
    policyFiles: sampleAffected(g.policyFiles)
  }));
}

// src/plugin/direct-hook.ts
var hasEmitted = false;
var globalTimeoutId = null;
var timeoutFallback = null;
var DIRECT_HOOK_TIMEOUT_MS = 6e4;
function emitResult(result) {
  if (hasEmitted) return;
  hasEmitted = true;
  if (globalTimeoutId) clearTimeout(globalTimeoutId);
  if (result === null) {
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}
async function main() {
  ensureInstallationConfig();
  const stdin = fs8.readFileSync(0, "utf8");
  log("====PROTECTOR INPUT====");
  log(stdin);
  let input;
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
  timeoutFallback = buildHookOutput(applyBlockSuppression(
    applyOfflineRiskPolicy(localResult),
    request.command
  ));
  const result = await reviewProtectResult(
    localResult,
    request.command,
    request.cwd,
    request.shell,
    request.conversationId
  );
  const rendered = renderReasonCodes(result.reasonCodes, result.analysis, 10);
  if (rendered.length > 0) {
    log(`decision=${result.decision} severity=${result.severity}: ${rendered.join("; ")}`);
  }
  emitResult(buildHookOutput(result));
}
if (require.main === module) {
  globalTimeoutId = setTimeout(() => {
    emitResult(timeoutFallback);
  }, DIRECT_HOOK_TIMEOUT_MS);
  main().catch((err) => {
    log(`protector error: ${err instanceof Error ? err.message : String(err)}`);
    emitResult(timeoutFallback);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RISK_REASON_CODES,
  applyBlockSuppression,
  applyOfflineRiskPolicy,
  buildHookReason,
  decide,
  ensureInstallationConfig,
  protect,
  protectWithReview,
  renderReasonCodes,
  renderReasonCodesDetailed,
  trimAnalysisForWire
});
