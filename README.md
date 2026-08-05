# Atuin Shell Guard

Atuin Shell Guard helps AI coding agents avoid accidental local file damage.

Before an agent runs a shell command, Atuin Shell Guard predicts what that command would do to the filesystem. It can show the agent which files may be deleted, overwritten, truncated, moved, or created, and it can ask the agent to rethink when the consequences look unsafe. For known dangerous file-operation patterns, it can refuse the command before it reaches the shell.

## Why this exists

AI coding agents are useful because they can act: edit files, run commands, clean generated output, download artifacts, unpack archives, and reorganize project directories.

That same ability creates a common failure mode: the agent intends to do a harmless cleanup, but the command affects the wrong files.

Typical mistakes are simple:

- Cleaning the wrong directory.
- Deleting a path that expanded differently than expected.
- Treating user documents as generated output.
- Overwriting an existing file while downloading or redirecting command output.
- Removing a large directory without noticing what is inside.

These are usually not malicious actions. They are ordinary mistakes made quickly.

Atuin Shell Guard adds a consequence-aware review step before execution. It turns a command such as `rm -rf some_dir/` into a concrete question: what would this command affect, and is that expected?

## Why command approval alone is not enough

A normal approval prompt usually shows the command text:

```bash
rm -rf some_dir/
```

That is not enough information. The same command can mean very different things:

- If `some_dir/` contains only temporary `.o` files, deleting it is routine cleanup.
- If `some_dir/` contains two-year-old local files, deleting it is suspicious.
- If `some_dir/` contains hundreds of files including `.docx` and `.pptx`, deleting it is probably not routine cleanup.

The risk is not only the command name. The risk is the command's expected impact: which files would be affected, how important they look, and whether the operation still looks like routine cleanup.

Atuin Shell Guard estimates that impact before the command runs.

## What it checks

Atuin Shell Guard focuses on local filesystem consequences:

- Which paths the command may touch.
- Whether paths came from variables, globs, braces, redirects, or command substitutions.
- Whether the command may delete, replace, truncate, move, copy, append, or create files.
- Whether the target already exists.
- How many real files are affected.
- How large the affected files are.
- How old the affected files are.
- Whether affected files look disposable, such as `.o`, `.obj`, `.tmp`, `.log`, or `.lock`.
- Whether affected files look user-important, such as `.docx`, `.pptx`, `.pdf`, images, videos, archives, or disk images.
- Whether the command targets protected locations or special device paths.

The result is returned to the agent as concrete consequences. The agent can then choose a safer command, ask the user for help, or stop.

## Example cases

### 1. Safe cleanup: build artifacts

Command:

```bash
rm -rf build/
```

Filesystem:

```text
build/
  main.o
  parser.o
  cache.tmp
  build.log
```

Atuin Shell Guard treats this as ordinary cleanup. The files are disposable build artifacts, so the command can run.

### 2. Suspicious cleanup: old local files

Command:

```bash
rm -rf archive/
```

Filesystem:

```text
archive/
  notes.txt        created 2 years ago
  experiment.json  created 2 years ago
```

Atuin Shell Guard surfaces the file age before execution. Old local files are more likely to be user data, historical work, or hard-to-recreate artifacts, so the agent is asked to rethink instead of deleting them silently.

### 3. Dangerous cleanup: home directory

Command:

```bash
rm -rf home_dir/
```

Filesystem:

```text
home_dir/
  Documents/
  Desktop/
  Downloads/
  Pictures/
  projects/
```

Atuin Shell Guard recognizes that the command targets the user's home directory. This is treated as a dangerous filesystem pattern, not cleanup. Atuin reports the consequences to the agent and instructs it to stop the current work immediately.

## How it works

<img src="assets/flowchart.png" alt="Atuin Shell Guard command review flow" width="100%">

At a high level:

1. The agent proposes a shell command.
2. Atuin Shell Guard analyzes the command without executing it.
3. It predicts local filesystem effects.
4. It checks exact affected paths against the real filesystem in read-only mode.
5. It classifies the operation using file count, size, age, extension, path, and device rules.
6. It returns the result to the agent runtime before the command runs.

Cloud review is enabled by default for risky local results. Offline mode is available; see [Privacy and offline mode](#privacy-and-offline-mode).

## Supported integrations

- [Claude Code](guides/CLAUDE_CODE.md)
- [Codex CLI](guides/CODEX.md)
- [Hermes Agent](guides/HERMES_AGENT.md)
- [Kimi Code CLI](guides/KIMI.md)

Codex users must review and trust the Atuin Shell Guard hook in `/hooks`. Until the hook is trusted, Codex skips it and the guard cannot inspect commands. Codex may require review again after the hook definition changes.

## Privacy and offline mode

Cloud review is enabled by default.

When cloud review is enabled and the local risk model determines that a command may pose risk, the tool-call command that the agent is about to execute, metadata of potentially affected user-side resources, the randomly generated installation ID, conversation ID when available, error logs, and telemetry data will be uploaded to Tencent's cloud services for processing. We may use this data to improve our product experience.

Review these documents before using the software:

- [Privacy Policy](PRIVACY.md)
- [User Service Agreement](USER_SERVICE_AGREEMENT.md)

By installing or enabling the plugin or hook scripts from this repository, or by otherwise using any content from this repository, you acknowledge that you have read and agree to the Privacy Policy and User Service Agreement.

To disable cloud review, write the following to `~/.atuin-shell-guard/config.json` on Linux or macOS, or `%USERPROFILE%\.atuin-shell-guard\config.json` on Windows:

```json
{"cloud-review": "no"}
```

In offline mode, Atuin Shell Guard still performs local analysis and local risk classification, but cloud review is not used.

## Known limits

Atuin Shell Guard is designed to reduce accidental local file loss caused by well-intentioned agents. It is not a security boundary for running untrusted code.

Important limits:

- It is not an operating-system sandbox. Allowed commands execute normally.
- Highly dynamic, obfuscated, malformed, or excessively complex commands may produce incomplete predictions.
- PowerShell support is not a full PowerShell runtime.

Use Atuin Shell Guard together with normal engineering controls: least-privilege accounts, disposable workspaces, backups, runtime permission prompts, and human review for high-impact operations.

## Development

The project is implemented in TypeScript and ships a ready-to-run bundled hook under `plugin/`.

Common commands:

```bash
npm run build
npm test
npm run plugin:test
```

The programmatic analyzer entry point returns predicted file effects, affected-file metadata, warnings, and provenance for embedders that want to build additional review surfaces.
