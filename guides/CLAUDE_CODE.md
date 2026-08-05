# Privacy & Data Usage Notice

Cloud review is enabled by default.

When cloud review is enabled and the local risk model determines that a command may pose risk, the tool-call command that the agent is about to execute, metadata of potentially affected user-side resources (e.g. file names, file sizes, creation times), the randomly generated installation ID, conversation ID (when available), error logs, and telemetry data will be uploaded to Tencent's cloud services for processing. We may use this data to improve our product experience.

- Privacy Policy: [PRIVACY.md](https://github.com/XuanwuLab/atuin-shell-guard/blob/main/PRIVACY.md)

- User Service Agreement: [USER_SERVICE_AGREEMENT.md](https://github.com/XuanwuLab/atuin-shell-guard/blob/main/USER_SERVICE_AGREEMENT.md)

Please review both documents carefully before using any software provided by this repository. By installing or enabling the plugin or hook scripts from this repository on any agent platform, or by otherwise using any content from this repository, you acknowledge that you have read and agree to the Privacy Policy and User Service Agreement.

# Offline Mode

To disable cloud review, write the following to `~/.atuin-shell-guard/config.json` (on Windows, `%USERPROFILE%\.atuin-shell-guard\config.json`):

```json
{"cloud-review": "no"}
```

# Claude Code Guide

## Requirements

- `node` and `git` available on `PATH`.

## 1. Clone Atuin Shell Guard

```bash
git clone https://github.com/XuanwuLab/atuin-shell-guard "$HOME/atuin-shell-guard"
```

The repository contains the ready-to-run hook bundle; no npm install or build step is required.

## 2. Start Claude Code with the Plugin

```bash
claude --plugin-dir "$HOME/atuin-shell-guard/plugin"
```

`--plugin-dir` loads the cloned plugin for that Claude Code session. Start future guarded sessions with the same option.

## 3. Test Safely

Ask Claude Code to delete the repository's sample documents directory:

```text
delete ~/atuin-shell-guard/plugin_test_harness/rootfs/docs
```

Atuin Shell Guard should analyze the command before execution. Under the configured cloud-review policy, the command should remain unexecuted and Claude Code should receive the affected-file consequences. Do not test the hook on valuable data.

## Cloud Review and Offline Mode

To disable cloud review, write the following to `~/.atuin-shell-guard/config.json`:

```json
{"cloud-review": "no"}
```

## Update

```bash
git -C "$HOME/atuin-shell-guard" pull --ff-only
```

Run `/reload-plugins` in an active Claude Code session, or start a new session with the same `--plugin-dir` option.

Claude Code hooks and Atuin Shell Guard are barriers, not an operating-system sandbox.
