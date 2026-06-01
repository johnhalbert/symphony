"""Symphony worker/reviewer GitHub command policy.

This module enforces the dogfood worker/reviewer boundary that upstream
GitHub operations belong to Symphony service-owned publication, refresh,
review, and merge paths -- not to agent shell commands.  It is intentionally
independent of the normal dangerous-command approval flow so yolo/approval
settings cannot bypass it.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import stat
import sys
from typing import Mapping, Optional, Sequence

try:  # Python 3.8 compatibility for older embedded Hermes installs.
    from shlex import quote as _shell_quote
except ImportError:  # pragma: no cover
    def _shell_quote(value: str) -> str:
        return "'" + value.replace("'", "'\\''") + "'"


COMMAND_POLICY_ENV = "SYMPHONY_AGENT_COMMAND_POLICY"
COMMAND_POLICY_VALUE = "worker_reviewer_github_upstream_block"
ROLE_ENV = "SYMPHONY_AGENT_ROLE"
POLICY_DISABLED_ENV = "SYMPHONY_AGENT_COMMAND_POLICY_DISABLED"
SHIM_DIR_ENV = "SYMPHONY_COMMAND_POLICY_SHIM_DIR"

_POLICY_ROLES = {"worker", "reviewer"}
_POLICY_VALUES = {COMMAND_POLICY_VALUE, "block_upstream_github", "worker_reviewer_github"}
_SHIM_TOOLS = ("git", "gh", "ssh", "ssh-keyscan", "ssh-keygen", "ssh-add", "curl", "wget")

_TOKEN_REPLACEMENTS = [
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{8,}\b"), "[REDACTED]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{8,}\b", re.IGNORECASE), "[REDACTED]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE), "Bearer [REDACTED]"),
    (re.compile(r"(?i)(authorization\s*[:=]\s*)([^\s'\"]+)"), r"\1[REDACTED]"),
    (re.compile(r"(?i)((?:token|access_token|auth|password|secret)\s*=\s*)([^\s'\"]+)"), r"\1[REDACTED]"),
]


class PolicyDecision(dict):
    """Small dict subclass for ergonomic truthiness and JSON-ability."""


def is_worker_reviewer_github_policy_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """Return True when the worker/reviewer GitHub command policy applies."""

    source = env or os.environ
    policy = str(source.get(COMMAND_POLICY_ENV, "")).strip().lower()
    role = str(
        source.get(ROLE_ENV)
        or source.get("SYMPHONY_RUN_ROLE")
        or source.get("HERMES_SYMPHONY_ROLE")
        or ""
    ).strip().lower()
    return policy in _POLICY_VALUES or role in _POLICY_ROLES


def worker_reviewer_github_child_env(source_env: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    """Return env vars that propagate policy + noninteractive hardening."""

    source = source_env or os.environ
    if not is_worker_reviewer_github_policy_enabled(source):
        return {}
    role = str(source.get(ROLE_ENV) or source.get("SYMPHONY_RUN_ROLE") or source.get("HERMES_SYMPHONY_ROLE") or "worker")
    return {
        COMMAND_POLICY_ENV: COMMAND_POLICY_VALUE,
        ROLE_ENV: role,
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "never",
        "GH_PROMPT_DISABLED": "1",
        "GIT_SSH_COMMAND": "ssh -o BatchMode=yes",
        "SSH_ASKPASS_REQUIRE": "never",
    }


def apply_worker_reviewer_github_child_env(
    target_env: dict[str, str],
    source_env: Optional[Mapping[str, str]] = None,
) -> bool:
    """Apply policy env/hardening to *target_env*; return whether active."""

    updates = worker_reviewer_github_child_env(source_env)
    if not updates:
        return False
    target_env.pop(POLICY_DISABLED_ENV, None)
    target_env.update(updates)
    return True


def sanitize_command_preview(command: object, limit: int = 240) -> str:
    """Redact common token forms and truncate command text for denial messages."""

    text = str(command or "").replace("\x00", "")
    for pattern, replacement in _TOKEN_REPLACEMENTS:
        text = pattern.sub(replacement, text)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def _message(description: str, command: str) -> str:
    preview = sanitize_command_preview(command)
    return (
        f"BLOCKED by Symphony worker/reviewer GitHub command policy: {description}. "
        f"Command preview: {preview!r}. "
        "Worker/reviewer agents must not contact GitHub, mutate remotes, use desktop GitHub credentials, "
        "or open OAuth/SSH prompts from terminal, shell, or execute_code subprocesses. "
        "Use Symphony service-owned repository refresh, publication, review-feedback, and merge paths instead; "
        "inspect only the prepared local worktree and already-refreshed local refs."
    )


def _decision(description: str, command: str) -> PolicyDecision:
    return PolicyDecision({
        "blocked": True,
        "description": description,
        "message": _message(description, command),
        "command_preview": sanitize_command_preview(command),
    })


def _shell_segments(command: str) -> list[list[str]]:
    """Best-effort tokenization of shell command segments for argv policy."""

    spaced = re.sub(r"(&&|\|\||[;|])", r" \1 ", command)
    try:
        tokens = shlex.split(spaced, posix=True)
    except ValueError:
        return []
    segments: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token in {"&&", "||", ";", "|"}:
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)

    normalized_segments: list[list[str]] = []
    for segment in segments:
        index = 0
        while index < len(segment) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", segment[index]):
            index += 1
        if index < len(segment) and segment[index] == "command":
            index += 1
        if index < len(segment) and segment[index] == "env":
            index += 1
            while index < len(segment) and (segment[index].startswith("-") or "=" in segment[index]):
                index += 1
        if index < len(segment):
            normalized_segments.append(segment[index:])
    return normalized_segments


def _normalized_command(command: str) -> str:
    try:
        from tools.approval import _normalize_command_for_detection  # reuse ANSI/Unicode normalization
        return _normalize_command_for_detection(command)
    except Exception:
        return str(command or "").replace("\x00", "")


_COMMAND_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*(?:fetch|pull|push|ls-remote)\b", re.IGNORECASE | re.DOTALL), "upstream Git network operation"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*remote\s+update\b", re.IGNORECASE | re.DOTALL), "upstream Git remote update"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*remote\s+(?:add|set-url|remove|rename|prune)\b", re.IGNORECASE | re.DOTALL), "Git remote mutation"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*clone\b[^\n;&|]*(?:github\.com|gh:)", re.IGNORECASE | re.DOTALL), "GitHub clone from worker/reviewer shell"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*(?:credential|credential-cache|credential-store)\b", re.IGNORECASE | re.DOTALL), "Git credential helper access"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*config\b[^\n;&|]*(?:credential|askpass|core\.sshcommand|http\.[^\s]*extraheader|url\.[^\s]*insteadof)", re.IGNORECASE | re.DOTALL), "unsafe Git credential or transport configuration"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*-[cC]\s+[^\n;&|]*(?:credential|askpass|core\.sshcommand|http\.[^\s]*extraheader|url\.[^\s]*insteadof)", re.IGNORECASE | re.DOTALL), "unsafe Git credential or transport configuration"),
    (re.compile(r"\bgit\s+(?:-[^\s]+\s+)*submodule\s+(?:update|sync|foreach)\b", re.IGNORECASE | re.DOTALL), "Git submodule upstream operation"),
    (re.compile(r"\bgh(?:\s|$)(?!(?:--version|-h|--help|version|help)(?:\s|$))", re.IGNORECASE | re.DOTALL), "GitHub CLI command"),
    (re.compile(r"\b(?:curl|wget|http|https|httpie)\b[^\n;&|]*(?:https?://)?api\.github\.com\b", re.IGNORECASE | re.DOTALL), "raw GitHub API call from shell"),
    (re.compile(r"\b(?:curl|wget|http|https|httpie)\b[^\n;&|]*github\.com/(?:graphql|repos|login/oauth|settings/tokens)\b", re.IGNORECASE | re.DOTALL), "raw GitHub API/auth call from shell"),
    (re.compile(r"\bssh\b[^\n;&|]*(?:git@github\.com|ssh://git@github\.com|github\.com)\b", re.IGNORECASE | re.DOTALL), "SSH GitHub probe"),
    (re.compile(r"\bssh-keyscan\b[^\n;&|]*github\.com\b", re.IGNORECASE | re.DOTALL), "GitHub SSH known-host probe"),
    (re.compile(r"\bssh-keygen\b[^\n;&|]*(?:github\.com|known_hosts)\b", re.IGNORECASE | re.DOTALL), "GitHub SSH known-host mutation"),
    (re.compile(r"\bssh-add\b", re.IGNORECASE | re.DOTALL), "SSH credential agent access"),
    (re.compile(r"(?:>>?|\btee\b[^\n;&|]*)[^\n;&|]*\.ssh/known_hosts\b[^\n;&|]*github\.com", re.IGNORECASE | re.DOTALL), "GitHub SSH known-host mutation"),
]


def check_worker_reviewer_github_command(
    command: str,
    env: Optional[Mapping[str, str]] = None,
) -> Optional[PolicyDecision]:
    """Classify a shell command string; return a decision when blocked."""

    if not is_worker_reviewer_github_policy_enabled(env):
        return None
    normalized = _normalized_command(command)
    for segment in _shell_segments(normalized):
        decision = check_worker_reviewer_github_argv(segment[0], segment[1:], env=env)
        if decision is not None:
            return decision
    for pattern, description in _COMMAND_PATTERNS:
        if pattern.search(normalized):
            return _decision(description, normalized)
    return None


def _strip_windows_suffix(tool: str) -> str:
    base = os.path.basename(tool or "").lower()
    for suffix in (".exe", ".cmd", ".bat", ".com"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def _argv_command(tool: str, argv: Sequence[str]) -> str:
    parts = [tool] + [str(arg) for arg in argv]
    return " ".join(_shell_quote(part) for part in parts)


def _skip_git_global_options(args: Sequence[str]) -> tuple[Optional[str], list[str]]:
    sensitive_from_global: list[str] = []
    index = 0
    while index < len(args):
        arg = str(args[index])
        lower = arg.lower()
        if arg == "--":
            index += 1
            break
        if lower in {"-c", "--config-env", "-c"}:
            if index + 1 < len(args):
                sensitive_from_global.append(str(args[index + 1]))
            index += 2
            continue
        if lower.startswith("--config-env="):
            sensitive_from_global.append(arg.split("=", 1)[1])
            index += 1
            continue
        if lower.startswith("-c") and len(arg) > 2:
            sensitive_from_global.append(arg[2:])
            index += 1
            continue
        if lower in {"-C".lower(), "--git-dir", "--work-tree", "--namespace", "--exec-path", "--html-path", "--man-path", "--info-path"}:
            index += 2
            continue
        if lower.startswith(("--git-dir=", "--work-tree=", "--namespace=", "--exec-path=")):
            index += 1
            continue
        if arg.startswith("-"):
            index += 1
            continue
        return lower, sensitive_from_global
    if index < len(args):
        return str(args[index]).lower(), sensitive_from_global
    return None, sensitive_from_global


def _contains_sensitive_git_config(values: Sequence[str]) -> bool:
    joined = " ".join(str(value).lower() for value in values)
    return any(token in joined for token in ("credential", "askpass", "core.sshcommand", "extraheader", "insteadof"))


def _next_non_option(args: Sequence[str], start: int = 0) -> Optional[str]:
    for arg in args[start:]:
        text = str(arg)
        if text == "--":
            continue
        if text.startswith("-"):
            continue
        return text.lower()
    return None


def _contains_github_endpoint(args: Sequence[str]) -> bool:
    joined = " ".join(str(arg).lower() for arg in args)
    return (
        "api.github.com" in joined
        or "github.com/graphql" in joined
        or "github.com/repos" in joined
        or "github.com/login/oauth" in joined
        or "github.com/settings/tokens" in joined
        or "git@github.com" in joined
        or "ssh://git@github.com" in joined
        or "github.com:" in joined
        or "github.com/" in joined
    )


def check_worker_reviewer_github_argv(
    tool: str,
    argv: Sequence[str],
    env: Optional[Mapping[str, str]] = None,
) -> Optional[PolicyDecision]:
    """Classify a direct executable invocation; return a decision when blocked."""

    if not is_worker_reviewer_github_policy_enabled(env):
        return None
    canonical = _strip_windows_suffix(tool)
    args = [str(arg) for arg in argv]
    command = _argv_command(canonical, args)

    if canonical == "git":
        subcommand, global_configs = _skip_git_global_options(args)
        if _contains_sensitive_git_config(global_configs):
            return _decision("unsafe Git credential or transport configuration", command)
        if subcommand in {"fetch", "pull", "push", "ls-remote"}:
            return _decision("upstream Git network operation", command)
        if subcommand and subcommand.startswith("credential"):
            return _decision("Git credential helper access", command)
        if subcommand == "remote":
            try:
                start = args.index("remote") + 1
            except ValueError:
                start = 0
            remote_subcommand = _next_non_option(args, start)
            if remote_subcommand in {"update", "add", "set-url", "remove", "rename", "prune"}:
                description = "upstream Git remote update" if remote_subcommand == "update" else "Git remote mutation"
                return _decision(description, command)
        if subcommand == "config" and _contains_sensitive_git_config(args):
            return _decision("unsafe Git credential or transport configuration", command)
        if subcommand == "clone" and _contains_github_endpoint(args):
            return _decision("GitHub clone from worker/reviewer shell", command)
        if subcommand == "submodule":
            try:
                start = args.index("submodule") + 1
            except ValueError:
                start = 0
            submodule_action = _next_non_option(args, start)
            if submodule_action in {"update", "sync", "foreach"}:
                return _decision("Git submodule upstream operation", command)
        return None

    if canonical == "gh":
        first = _next_non_option(args)
        if first in {None, "--version", "version", "help", "--help", "-h"}:
            return None
        return _decision("GitHub CLI command", command)

    if canonical == "ssh":
        if _contains_github_endpoint(args) or any("github.com" in arg.lower() for arg in args):
            return _decision("SSH GitHub probe", command)
        return None

    if canonical == "ssh-keyscan":
        if any("github.com" in arg.lower() for arg in args):
            return _decision("GitHub SSH known-host probe", command)
        return None

    if canonical == "ssh-keygen":
        if any("github.com" in arg.lower() or "known_hosts" in arg.lower() for arg in args):
            return _decision("GitHub SSH known-host mutation", command)
        return None

    if canonical == "ssh-add":
        return _decision("SSH credential agent access", command)

    if canonical in {"curl", "wget", "http", "https", "httpie"}:
        if _contains_github_endpoint(args):
            return _decision("raw GitHub API/auth call from shell", command)
        return None

    return None


def check_worker_reviewer_github_policy_result(command: str, env: Optional[Mapping[str, str]] = None) -> Optional[dict]:
    """Return an approval.py-compatible block result for *command*."""

    decision = check_worker_reviewer_github_command(command, env=env)
    if decision is None:
        return None
    return {
        "approved": False,
        "message": decision["message"],
        "worker_reviewer_github_policy": True,
        "description": decision["description"],
    }


def _real_env_name(tool: str) -> str:
    return "SYMPHONY_REAL_" + _strip_windows_suffix(tool).upper().replace("-", "_")


def _path_without_shim_dir(env: Mapping[str, str]) -> str:
    path_value = str(env.get("PATH") or "")
    shim_dir = str(env.get(SHIM_DIR_ENV) or "")
    if not shim_dir:
        return path_value
    shim_abs = os.path.abspath(shim_dir)
    parts = []
    for part in path_value.split(os.pathsep):
        if not part:
            continue
        try:
            if os.path.abspath(part) == shim_abs:
                continue
        except Exception:
            pass
        parts.append(part)
    return os.pathsep.join(parts)


def _find_real_tool(tool: str, env: Mapping[str, str]) -> Optional[str]:
    explicit = env.get(_real_env_name(tool))
    if explicit:
        return str(explicit)
    path_value = _path_without_shim_dir(env)
    return shutil.which(_strip_windows_suffix(tool), path=path_value)


def _write_text_executable(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    try:
        current = os.stat(path).st_mode
        os.chmod(path, current | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass


def posix_tool_shim_source(tool: str, python_command: str = "python3") -> str:
    return (
        "#!/bin/sh\n"
        f"export {SHIM_DIR_ENV}=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"\n"
        f"exec {_shell_quote(python_command)} -m tools.worker_github_policy {_shell_quote(_strip_windows_suffix(tool))} \"$@\"\n"
    )


def posix_askpass_source() -> str:
    return (
        "#!/bin/sh\n"
        "echo 'Symphony worker/reviewer command policy: interactive GitHub credentials are disabled.' >&2\n"
        "exit 1\n"
    )


def python_sitecustomize_source() -> str:
    """Return a sitecustomize module that blocks Python subprocess bypasses."""

    return r'''
# Auto-generated by Symphony worker/reviewer GitHub command policy.
import os as _os
import subprocess as _subprocess

try:
    from tools.worker_github_policy import (
        COMMAND_POLICY_ENV as _COMMAND_POLICY_ENV,
        COMMAND_POLICY_VALUE as _COMMAND_POLICY_VALUE,
        ROLE_ENV as _ROLE_ENV,
        POLICY_DISABLED_ENV as _POLICY_DISABLED_ENV,
        SHIM_DIR_ENV as _SHIM_DIR_ENV,
        check_worker_reviewer_github_argv as _check_argv,
        check_worker_reviewer_github_command as _check_command,
        is_worker_reviewer_github_policy_enabled as _is_policy_enabled,
        worker_reviewer_github_child_env as _child_policy_env,
    )
except Exception:  # pragma: no cover - fail closed only when import worked at generation time
    _COMMAND_POLICY_ENV = None
    _COMMAND_POLICY_VALUE = None
    _ROLE_ENV = None
    _POLICY_DISABLED_ENV = None
    _SHIM_DIR_ENV = None
    _check_argv = None
    _check_command = None
    _is_policy_enabled = None
    _child_policy_env = None


def _policy_is_active(env):
    if _is_policy_enabled is None:
        return False
    try:
        return bool(_is_policy_enabled(env))
    except Exception:
        return False


def _prepend_path_value(value, required_prefix):
    if not required_prefix:
        return value
    sep = _os.pathsep
    parts = [part for part in str(value or "").split(sep) if part]
    try:
        required_abs = _os.path.abspath(required_prefix)
        if any(_os.path.abspath(part) == required_abs for part in parts):
            return value
    except Exception:
        if required_prefix in parts:
            return value
    return required_prefix + (sep + str(value) if value else "")


def _merge_pythonpath(parent_value, child_value):
    if not parent_value:
        return child_value
    sep = _os.pathsep
    merged = [part for part in str(child_value or "").split(sep) if part]
    for part in reversed([part for part in str(parent_value or "").split(sep) if part]):
        if part not in merged:
            merged.insert(0, part)
    return sep.join(merged)


def _effective_policy_env(kwargs_env=None):
    env = dict(kwargs_env) if kwargs_env is not None else dict(_os.environ)
    parent_active = _policy_is_active(_os.environ)
    child_active = _policy_is_active(env)
    if not parent_active and not child_active:
        return env

    if _child_policy_env is not None:
        try:
            env.update(_child_policy_env(_os.environ if parent_active else env))
        except Exception:
            pass

    for key in (
        _COMMAND_POLICY_ENV,
        _ROLE_ENV,
        "SYMPHONY_RUN_ROLE",
        "HERMES_SYMPHONY_ROLE",
        _SHIM_DIR_ENV,
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "GIT_TERMINAL_PROMPT",
        "GCM_INTERACTIVE",
        "GH_PROMPT_DISABLED",
        "GIT_SSH_COMMAND",
        "SSH_ASKPASS_REQUIRE",
    ):
        if key and _os.environ.get(key):
            env[key] = _os.environ[key]
    for key, value in _os.environ.items():
        if key.startswith("SYMPHONY_REAL_"):
            env[key] = value
    if _POLICY_DISABLED_ENV:
        env.pop(_POLICY_DISABLED_ENV, None)
    if _COMMAND_POLICY_ENV and _COMMAND_POLICY_VALUE and parent_active:
        env[_COMMAND_POLICY_ENV] = _COMMAND_POLICY_VALUE

    shim_dir = _os.environ.get(_SHIM_DIR_ENV or "")
    if shim_dir:
        env["PATH"] = _prepend_path_value(env.get("PATH") or _os.environ.get("PATH"), shim_dir)
    if _os.environ.get("PYTHONPATH"):
        env["PYTHONPATH"] = _merge_pythonpath(_os.environ.get("PYTHONPATH"), env.get("PYTHONPATH"))
    return env


def _policy_decision_for_args(args, kwargs_env=None):
    if _check_command is None or _check_argv is None:
        return None
    env = _effective_policy_env(kwargs_env)
    try:
        if isinstance(args, (str, bytes, _os.PathLike)):
            return _check_command(_os.fsdecode(args), env=env)
        seq = list(args)
        if not seq:
            return None
        return _check_argv(_os.fsdecode(seq[0]), [_os.fsdecode(item) for item in seq[1:]], env=env)
    except Exception:
        return None


def _raise_if_blocked(args, kwargs_env=None):
    decision = _policy_decision_for_args(args, kwargs_env=kwargs_env)
    if decision is not None:
        raise PermissionError(decision.get("message") or "Blocked by Symphony worker/reviewer GitHub command policy")


_real_popen = _subprocess.Popen


def _policy_popen(args, *popen_args, **popen_kwargs):
    caller_env = popen_kwargs.get("env")
    effective_env = _effective_policy_env(caller_env)
    _raise_if_blocked(args, kwargs_env=effective_env)
    if caller_env is not None and _policy_is_active(effective_env):
        popen_kwargs["env"] = effective_env
    return _real_popen(args, *popen_args, **popen_kwargs)


_subprocess.Popen = _policy_popen

_real_os_system = _os.system


def _policy_os_system(command):
    _raise_if_blocked(command)
    return _real_os_system(command)


_os.system = _policy_os_system

if hasattr(_os, "popen"):
    _real_os_popen = _os.popen

    def _policy_os_popen(command, *args, **kwargs):
        _raise_if_blocked(command)
        return _real_os_popen(command, *args, **kwargs)

    _os.popen = _policy_os_popen


def _wrap_exec_like(name, argv_index):
    real = getattr(_os, name, None)
    if real is None:
        return

    def wrapped(*args, **kwargs):
        try:
            command_args = args[argv_index]
        except Exception:
            command_args = args[0] if args else []
        env = None
        if name.endswith("e"):
            env = args[-1] if args else None
        effective_env = _effective_policy_env(env)
        _raise_if_blocked(command_args, kwargs_env=effective_env)
        if env is not None and _policy_is_active(effective_env):
            args = list(args)
            args[-1] = effective_env
            args = tuple(args)
        return real(*args, **kwargs)

    setattr(_os, name, wrapped)


for _name, _argv_index in (
    ("execv", 1), ("execve", 1), ("execvp", 1), ("execvpe", 1),
    ("spawnv", 2), ("spawnve", 2), ("spawnvp", 2), ("spawnvpe", 2),
):
    _wrap_exec_like(_name, _argv_index)
'''.lstrip()


def install_worker_reviewer_github_shims(
    shim_dir: str,
    env: dict[str, str],
    python_executable: Optional[str] = None,
    tools: Sequence[str] = _SHIM_TOOLS,
) -> bool:
    """Install PATH shims into *shim_dir* and prepend them to *env[PATH]*."""

    if not is_worker_reviewer_github_policy_enabled(env):
        return False
    os.makedirs(shim_dir, exist_ok=True)
    original_path = env.get("PATH") or os.environ.get("PATH", "")
    env[SHIM_DIR_ENV] = shim_dir
    for tool in tools:
        real = shutil.which(_strip_windows_suffix(tool), path=original_path)
        if real:
            env[_real_env_name(tool)] = real
        _write_text_executable(os.path.join(shim_dir, _strip_windows_suffix(tool)), posix_tool_shim_source(tool, python_executable or sys.executable))
        if os.name == "nt":
            cmd_path = os.path.join(shim_dir, f"{_strip_windows_suffix(tool)}.cmd")
            _write_text_executable(
                cmd_path,
                f"@echo off\r\n\"{python_executable or sys.executable}\" -m tools.worker_github_policy {_strip_windows_suffix(tool)} %*\r\n",
            )
    askpass_name = "symphony-deny-askpass.cmd" if os.name == "nt" else "symphony-deny-askpass"
    askpass_path = os.path.join(shim_dir, askpass_name)
    if os.name == "nt":
        _write_text_executable(
            askpass_path,
            "@echo off\r\necho Symphony worker/reviewer command policy: interactive GitHub credentials are disabled. 1>&2\r\nexit /b 1\r\n",
        )
    else:
        _write_text_executable(askpass_path, posix_askpass_source())
    env["GIT_ASKPASS"] = askpass_path
    env["SSH_ASKPASS"] = askpass_path
    env["PATH"] = shim_dir + (os.pathsep + original_path if original_path else "")
    if os.name == "nt":
        pathext = env.get("PATHEXT") or os.environ.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD"
        if ".CMD" not in pathext.upper().split(";"):
            pathext = pathext + ";.CMD"
        env["PATHEXT"] = pathext
    return True


def install_worker_reviewer_github_runtime(
    runtime_dir: str,
    env: dict[str, str],
    python_executable: Optional[str] = None,
) -> bool:
    """Install shims + sitecustomize into *runtime_dir* and wire env for child shells.

    This protects shell children that try to bypass the terminal command-string
    guard by launching Python subprocesses directly.  ``sitecustomize`` blocks
    Python ``subprocess``/``os.system``/``os.exec*`` calls, while PATH shims
    catch ordinary shell scripts and aliases that invoke ``git``/``gh``/``ssh``.
    """

    if not apply_worker_reviewer_github_child_env(env, env):
        return False

    os.makedirs(runtime_dir, exist_ok=True)
    tools_dir = os.path.join(runtime_dir, "tools")
    os.makedirs(tools_dir, exist_ok=True)
    with open(os.path.join(tools_dir, "__init__.py"), "w", encoding="utf-8") as handle:
        handle.write("")
    with open(__file__, "r", encoding="utf-8") as source:
        with open(os.path.join(tools_dir, "worker_github_policy.py"), "w", encoding="utf-8") as target:
            target.write(source.read())
    with open(os.path.join(runtime_dir, "sitecustomize.py"), "w", encoding="utf-8") as handle:
        handle.write(python_sitecustomize_source())

    existing_pythonpath = env.get("PYTHONPATH", "")
    pythonpath_parts = [runtime_dir]
    if existing_pythonpath:
        pythonpath_parts.extend(part for part in existing_pythonpath.split(os.pathsep) if part and part != runtime_dir)
    env["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)

    return install_worker_reviewer_github_shims(
        os.path.join(runtime_dir, "bin"),
        env,
        python_executable=python_executable or sys.executable,
    )


def remote_policy_env_prefix(source_env: Optional[Mapping[str, str]], sandbox_dir: str) -> str:
    """Return a POSIX env-prefix fragment for remote execute_code sandboxes."""

    updates = worker_reviewer_github_child_env(source_env)
    if not updates:
        return ""
    bin_dir = f"{sandbox_dir}/bin"
    updates.update({
        SHIM_DIR_ENV: bin_dir,
        "GIT_ASKPASS": f"{bin_dir}/symphony-deny-askpass",
        "SSH_ASKPASS": f"{bin_dir}/symphony-deny-askpass",
    })
    parts = [f"{key}={_shell_quote(value)}" for key, value in updates.items()]
    parts.append(f"PATH={_shell_quote(bin_dir)}:$PATH")
    parts.append(f"PYTHONPATH={_shell_quote(sandbox_dir)}:${{PYTHONPATH:-}}")
    return " ".join(parts)


def _shim_invocation_policy_env(source_env: Mapping[str, str]) -> dict[str, str]:
    """Return fail-closed policy env for PATH shim execution."""

    env = dict(source_env)
    env.pop(POLICY_DISABLED_ENV, None)
    if env.get(SHIM_DIR_ENV):
        env.setdefault(COMMAND_POLICY_ENV, COMMAND_POLICY_VALUE)
        env.setdefault(ROLE_ENV, env.get("SYMPHONY_RUN_ROLE") or env.get("HERMES_SYMPHONY_ROLE") or "worker")
    return env


def _main(argv: Sequence[str]) -> int:
    if len(argv) < 2:
        print("Symphony command policy shim invoked without a tool name", file=sys.stderr)
        return 127
    tool = argv[1]
    tool_args = list(argv[2:])
    policy_env = _shim_invocation_policy_env(os.environ)
    decision = check_worker_reviewer_github_argv(tool, tool_args, env=policy_env)
    if decision is not None:
        print(decision["message"], file=sys.stderr)
        return 126
    real = _find_real_tool(tool, policy_env)
    if not real:
        print(f"Symphony command policy shim could not locate the real executable for {tool!r} outside the shim PATH.", file=sys.stderr)
        return 127
    if os.name == "nt":
        import subprocess
        return subprocess.call([real] + tool_args)
    os.execv(real, [real] + tool_args)
    return 127  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover - covered via subprocess tests
    raise SystemExit(_main(sys.argv))
