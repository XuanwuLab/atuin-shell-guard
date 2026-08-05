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

# Codex CLI Guide

Codex installs Atuin Shell Guard from its plugin marketplace; no repository clone is required.

## 1. Check Codex Hooks

Hooks are stable in current Codex releases. Confirm that `hooks` is enabled:

```bash
codex features list
```

If `hooks` is disabled, enable it:

```bash
codex features enable hooks
```

## 2. Add the GitHub Marketplace

```bash
codex plugin marketplace add XuanwuLab/atuin-shell-guard --sparse .agents/plugins
```

## 3. Install the Plugin

```bash
codex plugin add atuin-shell-guard@xuanwulab-atuin-shell-guard
```

## 4. Review and Trust the Hook

Codex skips the Atuin Shell Guard hook until you review and trust it, so the guard cannot inspect commands before this step is complete.

Codex may show this warning:

```text
⚠ 1 hook needs review before it can run. Open /hooks to review it.
```

Open `/hooks`, review the Atuin Shell Guard hook definition, and **press `t`** to trust it. If the hook definition changes after an update, Codex requires review again.

## 5. Create a Disposable Test Fixture

Create two temporary sample documents outside any valuable directory:

```bash
atuin_guard_test_dir="$(mktemp -d)"
printf 'test\n' > "$atuin_guard_test_dir/report.docx"
printf 'test\n' > "$atuin_guard_test_dir/presentation.pptx"
printf '%s\n' "$atuin_guard_test_dir"
```

## 6. Test Safely

Ask Codex to delete the directory printed by the previous command:

```text
delete <printed-test-directory>
```

Atuin Shell Guard should analyze the command before execution. Under the configured cloud-review policy, the command should remain unexecuted and Codex should receive the affected-file consequences. The fixture is disposable if review is unavailable and Codex proceeds.

## Cloud Review and Offline Mode

To disable cloud review, write the following to `~/.atuin-shell-guard/config.json`:

```json
{"cloud-review": "no"}
```

## Update

```bash
codex plugin marketplace upgrade xuanwulab-atuin-shell-guard
```

Open `/hooks` after an update and review the hook again if Codex requests it.

Codex `PreToolUse` hooks and Atuin Shell Guard are barriers, not an operating-system sandbox.
