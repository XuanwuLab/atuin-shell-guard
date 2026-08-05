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

# Kimi Code CLI Guide

Atuin Shell Guard integrates with Kimi Code CLI as a `PreToolUse` Hook. It is not a Kimi tool plugin, so `kimi plugin install` does not register the guard.

## Requirements

- Kimi Code CLI 1.28.0 or later (`kimi --version`). Hooks are currently a Beta feature in Kimi.
- `node` and `git` available on `PATH`.

## 1. Install Atuin Shell Guard

The repository contains the ready-to-run hook bundle; no npm install or build step is required.

Linux and macOS:

```bash
git clone https://github.com/XuanwuLab/atuin-shell-guard "$HOME/atuin-shell-guard"
```

Windows PowerShell:

```powershell
git clone https://github.com/XuanwuLab/atuin-shell-guard "$HOME\atuin-shell-guard"
```

## 2. Configure the Hook

Add one hook entry to `~/.kimi/config.toml`. If you use `KIMI_SHARE_DIR` or start Kimi with `--config-file`, edit that configuration file instead.

Linux and macOS:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "^Shell$"
command = "node \"$HOME/atuin-shell-guard/plugin/atuin-shell-guard.cjs\""
timeout = 120
```

Windows:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "^Shell$"
command = 'node "%USERPROFILE%\atuin-shell-guard\plugin\atuin-shell-guard.cjs"'
timeout = 120
```

The anchored matcher limits the hook to Kimi's `Shell` tool. The 120-second Kimi timeout leaves room for Atuin Shell Guard's bounded local analysis and optional cloud review; Kimi fails open if a hook crashes or times out.

## 3. Restart and Verify

Start a new Kimi session after editing the configuration, then run:

```text
/hooks
```

The output should list one `PreToolUse` hook with matcher `^Shell$`. If it does not, check the configuration path and `~/.kimi/logs/kimi.log`.

## 4. Test Safely

Ask Kimi to delete the repository's sample documents directory:

```text
delete ~/atuin-shell-guard/plugin_test_harness/rootfs/docs
```

Atuin Shell Guard should analyze the command before execution. Under the configured cloud-review policy, the command should remain unexecuted and Kimi should receive the affected-file consequences. Do not test the hook on valuable data.

## Cloud Review and Offline Mode

To disable cloud review, write the following to `~/.atuin-shell-guard/config.json`:

```json
{"cloud-review": "no"}
```

## Update

Linux and macOS:

```bash
git -C "$HOME/atuin-shell-guard" pull --ff-only
```

Windows PowerShell:

```powershell
git -C "$HOME\atuin-shell-guard" pull --ff-only
```

The next hook invocation uses the updated bundle. Restart Kimi only when you also change the `[[hooks]]` configuration.

Kimi Hooks and Atuin Shell Guard are barriers, not an operating-system sandbox. A missing, invalid, failed, or timed-out hook is allowed by Kimi's fail-open policy.
