"""Hermes plugin shim for repo-root installs."""

from __future__ import annotations

from importlib import util
from pathlib import Path
from types import ModuleType
from typing import Any


PLUGIN_DIR = Path(__file__).resolve().parent


def _load_plugin() -> ModuleType:
    plugin_file = PLUGIN_DIR / "plugin" / "hermes_plugin.py"
    spec = util.spec_from_file_location("atuin_shell_guard_hermes_plugin", plugin_file)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load Hermes plugin from {plugin_file}")
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def register(ctx: Any) -> None:
    _load_plugin().register(ctx)
