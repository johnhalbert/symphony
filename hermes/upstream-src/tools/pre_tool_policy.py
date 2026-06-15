"""Runtime bridge for configured pre_tool_call policy hooks.

Hermes' normal agent tool executor invokes pre_tool_call hooks before dispatch,
but gateway/native handlers may call tool functions directly. This module gives
command-capable tools a small, idempotent runtime check so direct entrypoints
cannot bypass configured policy hooks.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_registration_attempted = False


def pre_tool_call_block_message(
    tool_name: str,
    args: Optional[Dict[str, Any]],
    *,
    task_id: Optional[str] = None,
    session_id: str = "",
    tool_call_id: str = "",
) -> Optional[str]:
    """Return a configured pre_tool_call block message for a direct tool call."""

    policy_hook_present = _ensure_configured_shell_hooks_registered(tool_name)
    try:
        from hermes_cli.plugins import get_pre_tool_call_block_message

        return get_pre_tool_call_block_message(
            tool_name,
            args if isinstance(args, dict) else {},
            task_id=task_id or "",
            session_id=session_id,
            tool_call_id=tool_call_id,
        )
    except Exception as exc:  # pragma: no cover - defensive runtime guard
        logger.warning(
            "pre_tool_call policy hook lookup failed for %s: %s",
            tool_name,
            exc,
        )
        if policy_hook_present:
            return (
                "Command denied: Symphony command policy hook failed before "
                "this tool call could be verified. Use Symphony service-owned "
                "GitHub workflow actions for upstream GitHub activity."
            )
        return None


def _ensure_configured_shell_hooks_registered(tool_name: str) -> bool:
    """Lazily register auto-accepted shell hooks for direct tool entrypoints.

    Returns True when the active config appears to contain a matching Symphony
    command-policy hook. That lets callers fail closed if lookup itself errors.
    """

    global _registration_attempted

    cfg: Dict[str, Any] = {}
    try:
        from hermes_cli.config import load_config

        loaded = load_config()
        if isinstance(loaded, dict):
            cfg = loaded
    except Exception as exc:  # pragma: no cover - config loading is external
        logger.debug("could not load Hermes config for policy hook registration: %s", exc)
        return False

    policy_hook_present = _has_matching_symphony_policy_hook(cfg, tool_name)
    if _registration_attempted:
        return policy_hook_present
    _registration_attempted = True

    if not cfg.get("hooks"):
        return policy_hook_present
    if not _hooks_auto_accepted(cfg):
        return policy_hook_present

    try:
        from agent.shell_hooks import register_from_config

        register_from_config(cfg, accept_hooks=True)
    except Exception as exc:  # pragma: no cover - defensive runtime guard
        logger.warning("failed to register configured shell hooks before %s: %s", tool_name, exc)
        if policy_hook_present:
            raise

    return policy_hook_present


def _hooks_auto_accepted(cfg: Dict[str, Any]) -> bool:
    if cfg.get("hooks_auto_accept") is True:
        return True
    return str(os.environ.get("HERMES_ACCEPT_HOOKS", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _has_matching_symphony_policy_hook(cfg: Dict[str, Any], tool_name: str) -> bool:
    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        return False
    entries = hooks.get("pre_tool_call")
    if not isinstance(entries, list):
        return False

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        command = entry.get("command")
        if not isinstance(command, str) or "agent-command-policy-hook" not in command:
            continue
        matcher = entry.get("matcher")
        if _matcher_covers_tool(matcher, tool_name):
            return True
    return False


def _matcher_covers_tool(matcher: Any, tool_name: str) -> bool:
    if matcher is None:
        return True
    if not isinstance(matcher, str) or not matcher:
        return False
    try:
        import re

        return re.fullmatch(matcher, tool_name) is not None
    except Exception:
        return matcher == tool_name
