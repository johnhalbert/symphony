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


def test_runtime_sitecustomize_blocks_python_subprocess_bypass(policy_env, tmp_path):
    env = os.environ.copy()
    assert policy.install_worker_reviewer_github_runtime(str(tmp_path), env, python_executable=sys.executable)

    script = "import subprocess; subprocess.run(['/usr/bin/git', 'fetch', 'origin'], check=True)"
    blocked = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)

    assert blocked.returncode != 0
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr


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
