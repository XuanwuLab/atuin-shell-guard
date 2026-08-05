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

# Hermes Agent Guide

## Requirements

- `node` and `git` available on `PATH`.

## 1. Clone Atuin Shell Guard

```bash
git clone https://github.com/XuanwuLab/atuin-shell-guard "$HOME/atuin-shell-guard"
```

The repository contains the ready-to-run hook bundle; no npm install or build step is required.

## 2. Register and Enable the Plugin

Hermes discovers user plugins under `~/.hermes/plugins`. Link the cloned repository there so updates continue to use the same checkout:

```bash
mkdir -p "$HOME/.hermes/plugins"
ln -s "$HOME/atuin-shell-guard" "$HOME/.hermes/plugins/atuin-shell-guard"
hermes plugins enable atuin-shell-guard
```

If `HERMES_HOME` points elsewhere, place the link under `$HERMES_HOME/plugins` instead. Restart Hermes after enabling the plugin. It registers a `pre_tool_call` hook and checks `terminal` commands before execution.

## 3. Verify

```bash
hermes plugins list
```

Confirm that `atuin-shell-guard` is enabled.

## 4. Test Safely

Ask Hermes to delete the repository's sample documents directory:

```text
delete ~/atuin-shell-guard/plugin_test_harness/rootfs/docs
```

Atuin Shell Guard should analyze the command before execution. Under the configured cloud-review policy, the command should remain unexecuted and Hermes should receive the affected-file consequences. Do not test the hook on valuable data.

## Cloud Review and Offline Mode

To disable cloud review, write the following to `~/.atuin-shell-guard/config.json`:

```json
{"cloud-review": "no"}
```

## Update

```bash
git -C "$HOME/atuin-shell-guard" pull --ff-only
```

Restart Hermes to load the updated plugin code.

Hermes hooks and Atuin Shell Guard are barriers, not an operating-system sandbox.
