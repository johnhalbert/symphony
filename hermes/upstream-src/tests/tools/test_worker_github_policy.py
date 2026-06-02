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
    "tool,args,description",
    [
        ("bash", ["script.sh"], "uninspectable POSIX shell script execution"),
        ("bash", ["-e", "script.sh"], "uninspectable POSIX shell script execution"),
        ("sh", ["./script.sh"], "uninspectable POSIX shell script execution"),
        ("env", ["-i", "PATH=/real-bin", "bash", "script.sh"], "uninspectable POSIX shell script execution"),
        ("./script.sh", [], "uninspectable shell script execution"),
    ],
)
def test_policy_blocks_uninspectable_shell_script_argv(policy_env, tool, args, description):
    decision = policy.check_worker_reviewer_github_argv(tool, args)

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == description


@pytest.mark.parametrize(
    "command",
    [
        "bash script.sh",
        "sh ./script.sh",
        "env -i PATH=/real-bin bash script.sh",
        "./script.sh",
    ],
)
def test_policy_blocks_uninspectable_shell_script_command_strings(policy_env, command):
    decision = policy.check_worker_reviewer_github_command(command)

    assert decision is not None
    assert decision["blocked"] is True
    assert "script execution" in decision["description"]


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


@pytest.mark.parametrize(
    "tool,args,description",
    [
        (sys.executable, ["-S", "-c", "import subprocess; subprocess.run(['/usr/bin/git', 'fetch', 'origin'])"], "Python interpreter policy runtime suppression"),
        ("python", ["-I", "-c", "print('isolated')"], "Python interpreter policy runtime suppression"),
        ("python3", ["-E", "-m", "pytest"], "Python interpreter policy runtime suppression"),
        ("python", ["-c", "import subprocess; subprocess.run(['/usr/bin/git', 'fetch', 'origin'])"], "Python interpreter code execution"),
        ("python3", ["-m", "pytest", "--version"], "Python interpreter module execution"),
        ("python", ["child.py"], "uninspectable Python script execution"),
        ("python", ["-"], "uninspectable Python stdin execution"),
        ("env", ["-i", "PYTHONPATH=", "python", "-m", "pytest"], "Python interpreter execution with policy-suppressing env wrapper"),
        ("env", ["PATH=/real-bin", "python", "-c", "print('hidden')"], "Python interpreter execution with policy-suppressing env wrapper"),
        ("env", ["-i", "PATH=/real-bin", "bash", "-c", "python -m pytest"], "Python interpreter execution with policy-suppressing env wrapper"),
    ],
)
def test_policy_blocks_python_interpreter_policy_suppression_argv(policy_env, tool, args, description):
    decision = policy.check_worker_reviewer_github_argv(tool, args)

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == description


@pytest.mark.parametrize(
    "tool,args",
    [
        ("python", ["--version"]),
        ("python", ["-V"]),
    ],
)
def test_policy_allows_python_help_and_version(policy_env, tool, args):
    assert policy.check_worker_reviewer_github_argv(tool, args) is None


@pytest.mark.parametrize(
    "command,description",
    [
        ("python -S -c 'import subprocess; subprocess.run([\"/usr/bin/git\",\"fetch\",\"origin\"])'", "Python interpreter policy runtime suppression"),
        ("python -c 'import subprocess; subprocess.run([\"/usr/bin/git\",\"fetch\",\"origin\"])'", "Python interpreter code execution"),
        ("python -m pytest --version", "Python interpreter module execution"),
        ("python ./child.py", "uninspectable Python script execution"),
        ("PYTHONPATH= python -c 'print(1)'", "Python interpreter code execution"),
        ("PATH=/real-bin PYTHONPATH= python -m pytest", "Python interpreter module execution"),
        ("bash -c 'PYTHONPATH= python -c \"print(1)\"'", "Python interpreter code execution"),
        ("PYTHONPATH= env python -c 'print(1)'", "Python interpreter code execution"),
        ("env -i PYTHONPATH= python -m pytest", "Python interpreter execution with policy-suppressing env wrapper"),
        ("env -i PATH=/real-bin bash -c 'python -m pytest'", "Python interpreter execution with policy-suppressing env wrapper"),
    ],
)
def test_policy_blocks_python_interpreter_policy_suppression_command_strings(policy_env, command, description):
    decision = policy.check_worker_reviewer_github_command(command)

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == description


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


@pytest.mark.parametrize(
    "tool,args,description",
    [
        ("git", ["-c", "alias.pwn=!fake-helper", "pwn"], "command-executing Git configuration"),
        ("git", ["-calias.pwn=!fake-helper", "pwn"], "command-executing Git configuration"),
        ("git", ["-C", ".", "-c", "alias.pwn=!fake-helper", "pwn"], "command-executing Git configuration"),
        ("git", ["--config-env=alias.pwn=GIT_ALIAS", "pwn"], "command-executing Git configuration"),
        ("git", ["--config-env=diff.external=GIT_EXTERNAL_DIFF_CONFIG", "diff", "--cached"], "command-executing Git configuration"),
        ("git", ["-c", "diff.external=fake-helper", "diff", "--cached"], "command-executing Git configuration"),
        ("git", ["-c", "core.pager=fake-helper", "--paginate", "log", "-1"], "command-executing Git configuration"),
        ("git", ["-c", "pager.log=fake-helper", "--paginate", "log", "-1"], "command-executing Git configuration"),
        ("git", ["-c", "difftool.pwn.cmd=fake-helper", "difftool", "--tool=pwn"], "command-executing Git configuration"),
        ("git", ["-c", "diff.pwn.command=fake-helper", "diff", "--cached"], "command-executing Git configuration"),
        ("git", ["-c", "include.path=/tmp/policy-bypass.gitconfig", "status"], "command-executing Git configuration"),
        ("git", ["config", "alias.pwn", "!fake-helper"], "command-executing Git configuration"),
        ("git", ["config", "--add", "alias.pwn", "!fake-helper"], "command-executing Git configuration"),
        ("git", ["config", "diff.external", "fake-helper"], "command-executing Git configuration"),
        ("git", ["config", "core.pager", "fake-helper"], "command-executing Git configuration"),
        ("git", ["config", "pager.log", "fake-helper"], "command-executing Git configuration"),
        ("git", ["config", "difftool.pwn.cmd", "fake-helper"], "command-executing Git configuration"),
        ("git", ["config", "diff.pwn.command", "fake-helper"], "command-executing Git configuration"),
    ],
)
def test_policy_blocks_command_executing_git_config_argv(policy_env, tool, args, description):
    decision = policy.check_worker_reviewer_github_argv(tool, args)

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == description


@pytest.mark.parametrize(
    "args",
    [
        ["status", "--short"],
        ["-C", ".", "status", "--short"],
        ["diff", "--", "src/core/foo.ts"],
        ["log", "--oneline", "-5"],
        ["--no-pager", "log", "--oneline", "-5"],
        ["-c", "color.ui=never", "status", "--short"],
        ["-ccore.quotepath=false", "diff", "--", "src/core/foo.ts"],
        ["config", "user.email", "test@example.com"],
        ["config", "--get", "alias.pwn"],
        ["config", "--unset", "alias.pwn"],
    ],
)
def test_policy_allows_safe_git_inspection_and_benign_config(policy_env, args):
    assert policy.check_worker_reviewer_github_argv("git", args) is None


def test_policy_blocks_command_executing_git_config_from_environment(policy_env):
    env = {
        policy.COMMAND_POLICY_ENV: policy.COMMAND_POLICY_VALUE,
        policy.ROLE_ENV: "worker",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "alias.pwn",
        "GIT_CONFIG_VALUE_0": "!fake-helper",
    }

    decision = policy.check_worker_reviewer_github_argv("git", ["status", "--short"], env=env)

    assert decision is not None
    assert decision["blocked"] is True
    assert decision["description"] == "command-executing Git configuration"

    external_diff_env = {
        policy.COMMAND_POLICY_ENV: policy.COMMAND_POLICY_VALUE,
        policy.ROLE_ENV: "worker",
        "GIT_EXTERNAL_DIFF": "fake-helper",
    }
    decision = policy.check_worker_reviewer_github_argv("git", ["diff", "--cached"], env=external_diff_env)

    assert decision is not None
    assert decision["description"] == "command-executing Git diff environment"


def _install_policy_git_shim(tmp_path, fake_bin=None):
    env = os.environ.copy()
    upstream_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    if fake_bin is not None:
        env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    env["PYTHONPATH"] = os.pathsep.join([upstream_root, env.get("PYTHONPATH", "")])
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env["HOME"] = str(home)
    env["XDG_CONFIG_HOME"] = str(tmp_path / "xdg")
    env["GIT_CONFIG_GLOBAL"] = str(tmp_path / "global.gitconfig")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    shim_dir = tmp_path / "shims"
    policy.install_worker_reviewer_github_shims(str(shim_dir), env, python_executable=sys.executable)
    return env, shim_dir / ("git.cmd" if os.name == "nt" else "git")


def test_path_shim_blocks_inline_command_executing_git_config_before_fake_tool(policy_env, tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git executable is not available")
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    fake_tool = _write_fake_tool(fake_bin, "fake-helper", marker="FAKE_GIT_CONFIG_RAN")
    file_a = tmp_path / "a.txt"
    file_b = tmp_path / "b.txt"
    file_a.write_text("a\n", encoding="utf-8")
    file_b.write_text("b\n", encoding="utf-8")
    env, git_shim = _install_policy_git_shim(tmp_path, fake_bin=fake_bin)

    cases = [
        ["-c", f"alias.pwn=!{fake_tool}", "pwn"],
        [f"-calias.pwn=!{fake_tool}", "pwn"],
        ["--config-env=alias.pwn=GIT_ALIAS", "pwn"],
        ["-c", f"diff.external={fake_tool}", "diff", "--no-index", str(file_a), str(file_b)],
        ["-c", f"core.pager={fake_tool}", "--paginate", "log", "-1"],
        ["-c", f"pager.log={fake_tool}", "--paginate", "log", "-1"],
        ["-c", f"difftool.pwn.cmd={fake_tool}", "difftool", "--tool=pwn", "--no-prompt"],
    ]
    for args in cases:
        blocked = subprocess.run([str(git_shim), *args], env=env, text=True, capture_output=True)
        combined = blocked.stdout + blocked.stderr

        assert blocked.returncode == 126, args
        assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr, args
        assert "FAKE_GIT_CONFIG_RAN" not in combined, args


def test_path_shim_blocks_persisted_git_alias_and_diff_external_before_fake_tool(policy_env, tmp_path):
    real_git = shutil.which("git")
    if real_git is None:
        pytest.skip("git executable is not available")
    repo = tmp_path / "repo"
    repo.mkdir()
    setup_env = os.environ.copy()
    setup_env["GIT_CONFIG_NOSYSTEM"] = "1"
    subprocess.run([real_git, "init", "-q"], cwd=repo, env=setup_env, check=True)
    tracked = repo / "tracked.txt"
    tracked.write_text("hello\n", encoding="utf-8")
    subprocess.run([real_git, "-C", str(repo), "add", "tracked.txt"], env=setup_env, check=True)

    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    fake_tool = _write_fake_tool(fake_bin, "fake-helper", marker="FAKE_PERSISTED_GIT_CONFIG_RAN")
    subprocess.run([real_git, "-C", str(repo), "config", "alias.pwn", f"!{fake_tool}"], env=setup_env, check=True)
    subprocess.run([real_git, "-C", str(repo), "config", "diff.external", str(fake_tool)], env=setup_env, check=True)
    subprocess.run([real_git, "-C", str(repo), "config", "core.pager", str(fake_tool)], env=setup_env, check=True)

    env, git_shim = _install_policy_git_shim(tmp_path, fake_bin=fake_bin)
    preflight_decision = policy.check_worker_reviewer_git_persisted_config(
        "git",
        ["-C", str(repo), "pwn"],
        env=env,
        real_git=real_git,
    )
    assert preflight_decision is not None
    assert preflight_decision["description"] == "persisted Git alias command execution"

    blocked_alias = subprocess.run([str(git_shim), "-C", str(repo), "pwn"], env=env, text=True, capture_output=True)
    alias_combined = blocked_alias.stdout + blocked_alias.stderr
    assert blocked_alias.returncode == 126
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked_alias.stderr
    assert "FAKE_PERSISTED_GIT_CONFIG_RAN" not in alias_combined

    blocked_diff = subprocess.run([str(git_shim), "-C", str(repo), "diff", "--cached"], env=env, text=True, capture_output=True)
    diff_combined = blocked_diff.stdout + blocked_diff.stderr
    assert blocked_diff.returncode == 126
    assert "persisted command-executing Git diff configuration" in blocked_diff.stderr
    assert "FAKE_PERSISTED_GIT_CONFIG_RAN" not in diff_combined

    blocked_pager = subprocess.run([str(git_shim), "-C", str(repo), "--paginate", "log", "-1"], env=env, text=True, capture_output=True)
    pager_combined = blocked_pager.stdout + blocked_pager.stderr
    assert blocked_pager.returncode == 126
    assert "persisted command-executing Git pager configuration" in blocked_pager.stderr
    assert "FAKE_PERSISTED_GIT_CONFIG_RAN" not in pager_combined


def test_path_shim_allows_safe_status_diff_log_with_fake_tools_on_path(policy_env, tmp_path):
    real_git = shutil.which("git")
    if real_git is None:
        pytest.skip("git executable is not available")
    repo = tmp_path / "repo"
    repo.mkdir()
    setup_env = os.environ.copy()
    setup_env["GIT_CONFIG_NOSYSTEM"] = "1"
    subprocess.run([real_git, "init", "-q"], cwd=repo, env=setup_env, check=True)
    subprocess.run([real_git, "-C", str(repo), "config", "user.email", "test@example.com"], env=setup_env, check=True)
    subprocess.run([real_git, "-C", str(repo), "config", "user.name", "Test User"], env=setup_env, check=True)
    tracked = repo / "tracked.txt"
    tracked.write_text("hello\n", encoding="utf-8")
    subprocess.run([real_git, "-C", str(repo), "add", "tracked.txt"], env=setup_env, check=True)
    subprocess.run([real_git, "-C", str(repo), "commit", "-q", "-m", "initial"], env=setup_env, check=True)
    tracked.write_text("hello\nworld\n", encoding="utf-8")

    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    _write_fake_tool(fake_bin, "fake-helper", marker="FAKE_SAFE_LOCAL_GIT_RAN")
    env, git_shim = _install_policy_git_shim(tmp_path, fake_bin=fake_bin)

    commands = [
        ["-C", str(repo), "status", "--short"],
        ["-C", str(repo), "diff", "--", "tracked.txt"],
        ["-C", str(repo), "--no-pager", "log", "--oneline", "-1"],
    ]
    for args in commands:
        allowed = subprocess.run([str(git_shim), *args], env=env, text=True, capture_output=True)
        combined = allowed.stdout + allowed.stderr

        assert allowed.returncode == 0, (args, combined)
        assert "BLOCKED by Symphony worker/reviewer GitHub command policy" not in allowed.stderr
        assert "FAKE_SAFE_LOCAL_GIT_RAN" not in combined


def test_runtime_sitecustomize_blocks_persisted_git_config_bypass(policy_env, tmp_path):
    real_git = shutil.which("git")
    if real_git is None:
        pytest.skip("git executable is not available")
    repo = tmp_path / "repo"
    repo.mkdir()
    setup_env = os.environ.copy()
    setup_env["GIT_CONFIG_NOSYSTEM"] = "1"
    subprocess.run([real_git, "init", "-q"], cwd=repo, env=setup_env, check=True)
    tracked = repo / "tracked.txt"
    tracked.write_text("hello\n", encoding="utf-8")
    subprocess.run([real_git, "-C", str(repo), "add", "tracked.txt"], env=setup_env, check=True)
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    fake_tool = _write_fake_tool(fake_bin, "fake-helper", marker="FAKE_SITE_GIT_CONFIG_RAN")
    subprocess.run([real_git, "-C", str(repo), "config", "diff.external", str(fake_tool)], env=setup_env, check=True)

    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    assert policy.install_worker_reviewer_github_runtime(str(tmp_path / "runtime"), env, python_executable=sys.executable)
    script = (
        "import subprocess\n"
        f"subprocess.run([{real_git!r}, '-C', {str(repo)!r}, 'diff', '--cached'], check=True)\n"
    )
    blocked = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)
    combined = blocked.stdout + blocked.stderr

    assert blocked.returncode != 0
    assert "BLOCKED by Symphony worker/reviewer GitHub command policy" in blocked.stderr
    assert "FAKE_SITE_GIT_CONFIG_RAN" not in combined


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

    cleared_pythonpath_env = dict(env)
    cleared_pythonpath_env["PYTHONPATH"] = ""
    allowed_with_cleared_pythonpath = subprocess.run(
        [str(git_shim), "--version"], env=cleared_pythonpath_env, text=True, capture_output=True,
    )
    assert allowed_with_cleared_pythonpath.returncode == 0
    assert "git version" in allowed_with_cleared_pythonpath.stdout.lower()


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


def test_runtime_sitecustomize_blocks_python_interpreter_suppression_bypasses(policy_env, tmp_path):
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    fake_git = _write_fake_tool(fake_bin, "git")
    runtime_dir = tmp_path / "runtime"
    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    assert policy.install_worker_reviewer_github_runtime(str(runtime_dir), env, python_executable=sys.executable)

    child_script = tmp_path / "child_fetch.py"
    child_script.write_text(
        f"import subprocess\nsubprocess.run([{str(fake_git)!r}, 'fetch', 'origin'], check=True)\n",
        encoding="utf-8",
    )
    fake_git_text = str(fake_git)
    fake_bin_assignment = "PATH=" + str(fake_bin)
    child_script_text = str(child_script)
    script = f"""
import shlex
import subprocess
import sys
cases = [
    [sys.executable, "-c", "import subprocess; subprocess.run([{fake_git_text!r}, 'fetch', 'origin'], check=True)"],
    [sys.executable, "-S", "-c", "import subprocess; subprocess.run([{fake_git_text!r}, 'fetch', 'origin'], check=True)"],
    [sys.executable, {child_script_text!r}],
    ["env", "-i", {fake_bin_assignment!r}, "PYTHONPATH=", sys.executable, "-S", "-c", "import subprocess; subprocess.run([{fake_git_text!r}, 'fetch', 'origin'], check=True)"],
    ["bash", "-c", "PYTHONPATH= " + shlex.quote(sys.executable) + " -c " + shlex.quote("import subprocess; subprocess.run([{fake_git_text!r}, 'fetch', 'origin'], check=True)")],
    ["bash", "-c", "PATH=" + shlex.quote({str(fake_bin)!r}) + " PYTHONPATH= " + shlex.quote(sys.executable) + " -c " + shlex.quote("import subprocess; subprocess.run([{fake_git_text!r}, 'fetch', 'origin'], check=True)")],
]
for argv in cases:
    try:
        subprocess.run(argv, check=True)
    except PermissionError as exc:
        print("BLOCKED_PYTHON", argv[0], "GitHub command policy" in str(exc))
    else:
        raise AssertionError(f"python interpreter bypass was not blocked before fake git ran: {{argv!r}}")
"""
    blocked = subprocess.run([sys.executable, "-c", script], env=env, text=True, capture_output=True)
    combined = blocked.stdout + blocked.stderr

    assert blocked.returncode == 0
    assert combined.count("BLOCKED_PYTHON") == 6
    assert "FAKE_GIT_RAN" not in combined


def test_runtime_sitecustomize_blocks_shell_and_env_wrapper_subprocess_bypasses(policy_env, tmp_path):
    fake_bin = tmp_path / "real-bin"
    fake_bin.mkdir()
    fake_git = _write_fake_tool(fake_bin, "git")
    runtime_dir = tmp_path / "runtime"
    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    assert policy.install_worker_reviewer_github_runtime(str(runtime_dir), env, python_executable=sys.executable)

    script_absolute = tmp_path / "absolute-fetch.sh"
    script_absolute.write_text(f"#!/bin/sh\n{fake_git.as_posix()} fetch origin\n", encoding="utf-8")
    script_absolute.chmod(0o755)
    script_path_reset = tmp_path / "path-reset-fetch.sh"
    script_path_reset.write_text(f"#!/bin/sh\nPATH={fake_bin.as_posix()} git fetch origin\n", encoding="utf-8")
    script_path_reset.chmod(0o755)

    fake_git_text = fake_git.as_posix()
    fake_bin_text = fake_bin.as_posix()
    argv_cases = [
        ["bash", "-c", f"{fake_git_text} fetch origin"],
        ["sh", "-c", f"PATH={fake_bin_text} git fetch origin"],
        ["bash", "-lc", f"{fake_git_text} fetch origin"],
        ["env", "-i", f"PATH={fake_bin_text}", "git", "fetch", "origin"],
        ["env", "-i", f"PATH={fake_bin_text}", "bash", "-c", f"{fake_git_text} fetch origin"],
        ["bash", script_absolute.as_posix()],
        ["bash", script_path_reset.as_posix()],
        ["env", "-i", f"PATH={fake_bin_text}", "bash", script_path_reset.as_posix()],
        [script_absolute.as_posix()],
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
