"""Tests for Symphony worker/reviewer GitHub command policy."""

import os
import shutil
import subprocess
import sys

import pytest

from tools import worker_github_policy as policy
from tools.approval import check_all_command_guards


@pytest.fixture
def policy_env(monkeypatch):
    monkeypatch.setenv(policy.COMMAND_POLICY_ENV, policy.COMMAND_POLICY_VALUE)
    monkeypatch.setenv(policy.ROLE_ENV, "worker")
    monkeypatch.setenv("HERMES_YOLO_MODE", "1")
    return monkeypatch


def test_policy_blocks_upstream_github_commands_even_with_yolo_and_container_skip(policy_env):
    result = check_all_command_guards("git fetch origin main", "docker")

    assert result["approved"] is False
    assert result["worker_reviewer_github_policy"] is True
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in result["message"]


@pytest.mark.parametrize(
    "command",
    [
        "git status --short",
        "git diff -- src/core/foo.ts",
        "git log --oneline -5",
        "git branch --show-current",
        "gh --version",
    ],
)
def test_policy_allows_local_inspection_commands(policy_env, command):
    result = check_all_command_guards(command, "local")

    assert result["approved"] is True


@pytest.mark.parametrize(
    "command",
    [
        "git pull --rebase origin main",
        "git -C ../repo fetch origin main",
        "env FOO=bar git push origin HEAD",
        "git push origin HEAD",
        "git ls-remote origin",
        "git remote update --prune",
        "git credential fill",
        "git config credential.helper store",
        "git -c http.https://github.com/.extraheader=token=placeholder-value fetch origin",
        "gh auth status",
        "gh pr create --title test --body test",
        "gh pr edit 1 --title test",
        "gh pr comment 1 --body test",
        "gh pr review 1 --approve",
        "gh pr merge 1 --squash",
        "gh pr checks 1",
        "gh api repos/acme/repo/pulls",
        "curl https://api.github.com/repos/acme/repo",
        "ssh -T git@github.com",
        "ssh-keyscan github.com >> ~/.ssh/known_hosts",
    ],
)
def test_policy_blocks_auth_or_upstream_shell_commands(policy_env, command):
    decision = policy.check_worker_reviewer_github_command(command)

    assert decision is not None
    assert decision["blocked"] is True
    assert "placeholder-value" not in decision["message"]


@pytest.mark.parametrize(
    "tool,args",
    [
        ("git", ["fetch", "origin", "main"]),
        ("/usr/bin/git", ["push", "origin", "HEAD"]),
        ("git.exe", ["credential", "fill"]),
        ("gh", ["api", "repos/acme/repo"]),
        ("ssh", ["-T", "git@github.com"]),
        ("curl", ["https://api.github.com/repos/acme/repo"]),
    ],
)
def test_policy_blocks_direct_argv_invocations(policy_env, tool, args):
    decision = policy.check_worker_reviewer_github_argv(tool, args)

    assert decision is not None
    assert decision["blocked"] is True


@pytest.mark.parametrize(
    "tool,args",
    [
        ("bash", ["-c", "/usr/bin/git fetch origin"]),
        ("/bin/sh", ["-c", "PATH=/usr/bin git fetch origin"]),
        ("bash", ["-lc", "/usr/bin/git fetch origin"]),
        ("env", ["-i", "PATH=/usr/bin", "git", "fetch", "origin"]),
        ("/usr/bin/env", ["--ignore-environment", "PATH=/usr/bin", "/usr/bin/git", "fetch", "origin"]),
        ("env", ["-i", "PATH=/usr/bin", "bash", "-c", "/usr/bin/git fetch origin"]),
        ("cmd.exe", ["/c", "git", "fetch", "origin"]),
        ("pwsh", ["-Command", "git fetch origin"]),
    ],
)
def test_policy_blocks_shell_and_env_wrapper_argv(policy_env, tool, args):
    decision = policy.check_worker_reviewer_github_argv(tool, args)

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == "upstream Git network operation"


@pytest.mark.parametrize(
    "tool,args",
    [
        ("bash", ["-c", "git status --short"]),
        ("sh", ["-lc", "git -C . status --short"]),
        ("env", ["-i", "PATH=/usr/bin", "git", "status", "--short"]),
        ("env", ["-i", "PATH=/usr/bin", "bash", "-c", "git status --short"]),
        ("cmd.exe", ["/c", "git", "status", "--short"]),
        ("pwsh", ["-Command", "git status --short"]),
    ],
)
def test_policy_allows_shell_and_env_wrapped_local_git_inspection(policy_env, tool, args):
    assert policy.check_worker_reviewer_github_argv(tool, args) is None


def test_policy_disabled_env_cannot_disable_worker_reviewer_classification(policy_env):
    env = {
        policy.COMMAND_POLICY_ENV: policy.COMMAND_POLICY_VALUE,
        policy.ROLE_ENV: "worker",
        policy.POLICY_DISABLED_ENV: "1",
    }

    decision = policy.check_worker_reviewer_github_argv("git", ["fetch", "origin"], env=env)

    assert decision is not None
    assert decision["blocked"] is True


@pytest.mark.parametrize(
    "config_arg",
    [
        "--config-env=credential.helper=GIT_CREDENTIAL_HELPER",
        "--config-env=core.askpass=GIT_ASKPASS",
        "--config-env=core.sshCommand=GIT_SSH_COMMAND",
        "--config-env=http.https://github.com/.extraheader=GIT_HEADER",
        "--config-env=url.https://github.com/.insteadOf=GIT_URL",
    ],
)
def test_policy_blocks_git_config_env_equals_sensitive_values(policy_env, config_arg):
    decision = policy.check_worker_reviewer_github_argv("git", [config_arg, "status"])

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == "unsafe Git credential or transport configuration"


def test_path_shim_blocks_fetch_and_allows_safe_version(policy_env, tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git executable is not available")
    env = os.environ.copy()
    upstream_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    env["PYTHONPATH"] = os.pathsep.join([upstream_root, env.get("PYTHONPATH", "")])
    policy.install_worker_reviewer_github_shims(str(tmp_path), env, python_executable=sys.executable)

    git_shim = tmp_path / ("git.cmd" if os.name == "nt" else "git")
    blocked = subprocess.run([str(git_shim), "fetch", "origin"], env=env, text=True, capture_output=True)
    assert blocked.returncode == 126
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr

    allowed = subprocess.run([str(git_shim), "--version"], env=env, text=True, capture_output=True)
    assert allowed.returncode == 0
    assert "git version" in allowed.stdout.lower()


def test_path_shim_cannot_be_disabled_by_agent_env(policy_env, tmp_path):
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    _write_fake_tool(fake_bin, "git")
    shim_dir = tmp_path / "shims"
    env = os.environ.copy()
    upstream_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    env["PYTHONPATH"] = os.pathsep.join([upstream_root, env.get("PYTHONPATH", "")])
    policy.install_worker_reviewer_github_shims(str(shim_dir), env, python_executable=sys.executable)
    env[policy.POLICY_DISABLED_ENV] = "1"

    git_shim = shim_dir / ("git.cmd" if os.name == "nt" else "git")
    blocked = subprocess.run([str(git_shim), "fetch", "origin"], env=env, text=True, capture_output=True)

    assert blocked.returncode == 126
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr
    assert "FAKE_GIT_RAN" not in blocked.stderr


def test_runtime_sitecustomize_blocks_python_subprocess_bypass(policy_env, tmp_path):
    env = os.environ.copy()
    assert policy.install_worker_reviewer_github_runtime(str(tmp_path), env, python_executable=sys.executable)

    script = "import subprocess; subprocess.run(['/usr/bin/git', 'fetch', 'origin'], check=True)"
    blocked = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)

    assert blocked.returncode != 0
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr


def test_runtime_sitecustomize_blocks_shell_and_env_wrapper_subprocess_bypasses(policy_env, tmp_path):
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    fake_git = _write_fake_tool(fake_bin, "git")
    runtime_dir = tmp_path / "runtime"
    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    assert policy.install_worker_reviewer_github_runtime(str(runtime_dir), env, python_executable=sys.executable)

    fake_git_text = fake_git.as_posix()
    fake_bin_text = fake_bin.as_posix()
    argv_cases = [
        ["bash", "-c", f"{fake_git_text} fetch origin"],
        ["sh", "-c", f"PATH={fake_bin_text} git fetch origin"],
        ["bash", "-lc", f"{fake_git_text} fetch origin"],
        ["env", "-i", f"PATH={fake_bin_text}", "git", "fetch", "origin"],
        ["env", "-i", f"PATH={fake_bin_text}", "bash", "-c", f"{fake_git_text} fetch origin"],
    ]

    for argv in argv_cases:
        script = f"import subprocess\nsubprocess.run({argv!r}, check=True)\n"
        blocked = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)
        combined = blocked.stdout + blocked.stderr

        assert blocked.returncode != 0, argv
        assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr, argv
        assert "FAKE_GIT_RAN" not in combined


def test_runtime_sitecustomize_allows_shell_wrapped_local_git_inspection(policy_env, tmp_path):
    if shutil.which("git") is None or shutil.which("bash") is None:
        pytest.skip("git and bash executables are required")
    env = os.environ.copy()
    assert policy.install_worker_reviewer_github_runtime(str(tmp_path), env, python_executable=sys.executable)

    script = "import subprocess; subprocess.run(['bash', '-c', 'git --version'], check=True)"
    allowed = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)

    assert allowed.returncode == 0
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" not in allowed.stderr


def test_runtime_sitecustomize_cannot_be_disabled_by_subprocess_env(policy_env, tmp_path):
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    _write_fake_tool(fake_bin, "git")
    runtime_dir = tmp_path / "runtime"
    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    assert policy.install_worker_reviewer_github_runtime(str(runtime_dir), env, python_executable=sys.executable)

    script = """
import os
import subprocess

child_env = {
    "PATH": os.environ.get("PATH", ""),
    "SYMPHONY_AGENT_COMMAND_POLICY_DISABLED": "1",
}
subprocess.run(["git", "fetch", "origin"], env=child_env, check=True)
"""
    blocked = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)

    assert blocked.returncode != 0
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr
    assert "FAKE_GIT_RAN" not in blocked.stderr


def test_sanitize_subprocess_env_installs_terminal_runtime(policy_env, tmp_path, monkeypatch):
    from tools.environments import local as local_env

    monkeypatch.setattr(local_env, "_command_policy_runtime_dir", lambda: str(tmp_path))
    env = local_env._sanitize_subprocess_env(os.environ, {})

    assert env["SYMPHONY_AGENT_COMMAND_POLICY"] == policy.COMMAND_POLICY_VALUE
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["PATH"].split(os.pathsep)[0] == str(tmp_path / "bin")
    assert env["PYTHONPATH"].split(os.pathsep)[0] == str(tmp_path)


def test_sitecustomize_blocks_execute_code_subprocess_bypass(policy_env, tmp_path):
    upstream_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    (tmp_path / "sitecustomize.py").write_text(policy.python_sitecustomize_source(), encoding="utf-8")
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([str(tmp_path), upstream_root, env.get("PYTHONPATH", "")])

    child = subprocess.run(
        [
            sys.executable,
            "-c",
            "import subprocess; subprocess.run(['/usr/bin/git', 'fetch', 'origin'], check=True)",
        ],
        env=env,
        text=True,
        capture_output=True,
    )

    assert child.returncode != 0
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in child.stderr


def _write_fake_tool(bin_dir, name, marker="FAKE_GIT_RAN"):
    path = bin_dir / (f"{name}.cmd" if os.name == "nt" else name)
    if os.name == "nt":
        path.write_text(f"@echo off\r\necho {marker} 1>&2\r\nexit /b 99\r\n", encoding="utf-8")
    else:
        path.write_text(f"#!/bin/sh\necho {marker} >&2\nexit 99\n", encoding="utf-8")
        path.chmod(0o755)
    return path
