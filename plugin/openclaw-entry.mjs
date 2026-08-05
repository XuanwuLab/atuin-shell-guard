import { createRequire } from "node:module";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const require = createRequire(import.meta.url);
const { buildHookReason, ensureInstallationConfig, protectWithReview } = require("./atuin-shell-guard.cjs");

ensureInstallationConfig();

const EXEC_TOOL_NAMES = new Set([
  "exec",
  "exec_command",
  "shell",
  "terminal",
  "bash",
  "Bash",
  "run_command",
  "execute",
]);

export default definePluginEntry({
  id: "atuin-shell-guard",
  name: "Atuin Shell Guard",
  description: "Local dry-run bash interpreter that blocks destructive commands before execution.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!EXEC_TOOL_NAMES.has(event.toolName)) return undefined;

        const command = event.params?.command || event.params?.cmd || event.params?.script;
        if (!command || typeof command !== "string") return undefined;

        const cwd = event.params?.cwd || event.params?.workdir || ctx?.workspaceDir || process.cwd();
        const result = await protectWithReview(command, cwd);
        if (result.decision === "pass") return undefined;

        return {
          block: true,
          blockReason: buildHookReason(result),
        };
      },
      { priority: 100, timeoutMs: 120_000 },
    );
  },
});
