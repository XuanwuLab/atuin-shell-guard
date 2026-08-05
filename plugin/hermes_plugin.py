"""Hermes plugin entrypoint for Atuin Shell Guard."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


PLUGIN_DIR = Path(__file__).resolve().parent
GUARD = PLUGIN_DIR / "atuin-shell-guard.cjs"


def _effective_cwd(args: dict[str, Any], kwargs: dict[str, Any]) -> str:
    workdir = args.get("workdir")
    if isinstance(workdir, str) and workdir:
        return workdir

    cwd = kwargs.get("cwd")
    if isinstance(cwd, str) and cwd:
        return cwd

    return os.environ.get("TERMINAL_CWD") or os.getcwd()


def _run_guard(tool_name: str, args: dict[str, Any], task_id: str, **kwargs: Any) -> dict[str, str] | None:
    if tool_name != "terminal":
        return None

    command = args.get("command")
    if not isinstance(command, str) or not command:
        return None

    payload = {
        "hook_event_name": "pre_tool_call",
        "tool_name": tool_name,
        "tool_input": args,
        "session_id": kwargs.get("session_id") or task_id or "",
        "cwd": _effective_cwd(args, kwargs),
        "extra": {
            "task_id": task_id,
            "tool_call_id": kwargs.get("tool_call_id", ""),
        },
    }

    try:
        proc = subprocess.run(
            ["node", str(GUARD)],
            input=json.dumps(payload),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=120,
            check=False,
        )
    except Exception:
        return None

    if not proc.stdout or not proc.stdout.strip():
        return None

    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None

    # The shared hook emits the provider-neutral nested denial shape. Convert
    # it to Hermes' action/message contract at this adapter boundary.
    hook_output = result.get("hookSpecificOutput")
    if (
        isinstance(hook_output, dict)
        and hook_output.get("permissionDecision") == "deny"
    ):
        message = hook_output.get("permissionDecisionReason")
    elif result.get("action") in {"block", "stop"}:
        message = result.get("message")
    elif result.get("decision") in {"block", "stop"}:
        message = result.get("reason")
    else:
        message = None

    if isinstance(message, str) and message:
        return {"action": "block", "message": message}
    return None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_tool_call", _run_guard)
