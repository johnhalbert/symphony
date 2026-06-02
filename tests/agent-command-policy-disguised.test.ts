import { describe, expect, it } from "vitest";

import {
  evaluateAgentCommandPolicy,
  type AgentCommandPolicyInput,
} from "../src/core/harness/AgentCommandPolicy.js";

interface DisguisedUpstreamDenyCase {
  readonly name: string;
  readonly command: string;
  readonly commandClass: string;
  readonly executable: string;
  readonly executableKind?: string;
  readonly gitSubcommand?: string;
  readonly targetHosts?: readonly string[];
  readonly hasNestedCommand?: boolean;
}

interface AmbiguousWrapperDenyCase {
  readonly name: string;
  readonly command: string;
  readonly commandClass: string;
  readonly executable: string;
  readonly executableKind: string;
}

interface AmbiguousCompoundDenyCase {
  readonly name: string;
  readonly command: string;
}

describe("AgentCommandPolicy disguised upstream GitHub command denial", () => {
  it.each<DisguisedUpstreamDenyCase>([
    {
      name: "absolute POSIX Git path",
      command: "/usr/local/bin/git push origin HEAD",
      commandClass: "git_push",
      executable: "git",
      executableKind: "git",
      gitSubcommand: "push",
    },
    {
      name: "absolute Windows GitHub CLI path",
      command: "\"C:\\Program Files\\GitHub CLI\\gh.exe\" pr create --fill",
      commandClass: "github_cli",
      executable: "gh",
      executableKind: "github_cli",
    },
    {
      name: "POSIX shell -c nested Git push",
      command: "/bin/bash -lc \"git push origin HEAD\"",
      commandClass: "shell_wrapped_git_push",
      executable: "bash",
      executableKind: "shell",
      gitSubcommand: "push",
    },
    {
      name: "Windows cmd nested GitHub CLI",
      command: "cmd.exe /c \"gh pr create --fill\"",
      commandClass: "shell_wrapped_github_cli",
      executable: "cmd",
      executableKind: "shell",
    },
    {
      name: "PowerShell nested GitHub API request",
      command: "powershell.exe -Command \"curl https://api.github.com/repos/acme/repo/pulls\"",
      commandClass: "shell_wrapped_curl_github_request",
      executable: "powershell",
      executableKind: "shell",
      targetHosts: ["api.github.com"],
    },
    {
      name: "Python interpreter subprocess wrapper",
      command: "python -c \"import subprocess; subprocess.run(['git','fetch','origin'])\"",
      commandClass: "interpreter_wrapped_git_fetch",
      executable: "python",
      executableKind: "interpreter",
      gitSubcommand: "fetch",
    },
    {
      name: "Node interpreter child_process wrapper",
      command: "node -e \"require('child_process').execSync('gh pr create --fill')\"",
      commandClass: "interpreter_wrapped_github_cli",
      executable: "node",
      executableKind: "interpreter",
    },
    {
      name: "package executable wrapper",
      command: "npx --yes gh pr create --fill",
      commandClass: "package_script_wrapped_github_cli",
      executable: "npx",
      executableKind: "package_script",
    },
    {
      name: "compound shell command after local inspection",
      command: "git status --short && git fetch origin main",
      commandClass: "compound_git_fetch",
      executable: "git",
      executableKind: "git",
      gitSubcommand: "fetch",
    },
    {
      name: "$() command substitution hiding GitHub CLI",
      command: "git status --short $(gh pr create --fill)",
      commandClass: "shell_substitution_github_cli",
      executable: "git",
      executableKind: "git",
      hasNestedCommand: true,
    },
    {
      name: "$() command substitution hiding Git fetch",
      command: "git diff -- $(git fetch origin main)",
      commandClass: "shell_substitution_git_fetch",
      executable: "git",
      executableKind: "git",
      gitSubcommand: "fetch",
      hasNestedCommand: true,
    },
    {
      name: "backtick substitution hiding GitHub CLI",
      command: "git status --short `gh pr create --fill`",
      commandClass: "shell_substitution_github_cli",
      executable: "git",
      executableKind: "git",
      hasNestedCommand: true,
    },
    {
      name: "backtick substitution hiding GitHub API request",
      command: "git status --short `curl https://api.github.com/repos/acme/repo/pulls`",
      commandClass: "shell_substitution_curl_github_request",
      executable: "git",
      executableKind: "git",
      targetHosts: ["api.github.com"],
      hasNestedCommand: true,
    },
    {
      name: "input process substitution hiding Git fetch",
      command: "git diff -- <(git fetch origin main)",
      commandClass: "process_substitution_git_fetch",
      executable: "git",
      executableKind: "git",
      gitSubcommand: "fetch",
      hasNestedCommand: true,
    },
    {
      name: "output process substitution hiding GitHub SSH",
      command: "git diff -- >(ssh -T git@github.com)",
      commandClass: "process_substitution_ssh_github_transport",
      executable: "git",
      executableKind: "git",
      targetHosts: ["github.com"],
      hasNestedCommand: true,
    },
  ])(
    "denies disguised upstream GitHub activity before execution: $name",
    ({ command, commandClass, executable, executableKind, gitSubcommand, targetHosts, hasNestedCommand }) => {
      const decision = evaluateAgentCommandPolicy(terminalInput(command));

      expect(decision).toMatchObject({
        outcome: "deny",
        reasonKind: "upstream_github",
        commandClass,
        audit: {
          redacted: true,
          role: "worker",
          surface: "terminal",
          normalizedExecutable: executable,
          upstreamContactAttempted: false,
        },
      });
      expect(decision.message).toContain("service-owned workflow");

      if (executableKind) {
        expect(decision.audit.executableKind).toBe(executableKind);
      }
      if (gitSubcommand) {
        expect(decision.audit.gitSubcommand).toBe(gitSubcommand);
      }
      if (targetHosts) {
        expect(decision.audit.targetHosts).toEqual(targetHosts);
      }
      if (hasNestedCommand !== undefined) {
        expect(decision.audit.hasNestedCommand).toBe(hasNestedCommand);
      }
    },
  );

  it.each<AmbiguousWrapperDenyCase>([
    {
      name: "opaque package script",
      command: "npm run publish-pr",
      commandClass: "ambiguous_package_script",
      executable: "npm",
      executableKind: "package_script",
    },
    {
      name: "opaque script wrapper path",
      command: "./scripts/publish-pr.sh",
      commandClass: "ambiguous_script_wrapper",
      executable: "publish-pr.sh",
      executableKind: "other",
    },
  ])("fails closed for opaque wrapper content: $name", ({ command, commandClass, executable, executableKind }) => {
    const decision = evaluateAgentCommandPolicy(terminalInput(command));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "ambiguous_command",
      commandClass,
      audit: {
        redacted: true,
        normalizedExecutable: executable,
        executableKind,
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toContain("service-owned GitHub workflow");
  });

  it.each<AmbiguousCompoundDenyCase>([
    {
      name: "LF before opaque npm package script",
      command: "git status --short\nnpm run publish-pr",
    },
    {
      name: "CRLF before opaque npm package script",
      command: "git status --short\r\nnpm run publish-pr",
    },
    {
      name: "LF before opaque yarn package script",
      command: "git status --short\nyarn publish-pr",
    },
    {
      name: "LF before script-wrapper path",
      command: "git status --short\n./scripts/publish-pr.sh",
    },
    {
      name: "CRLF before script-wrapper path",
      command: "git status --short\r\n./scripts/publish-pr.sh",
    },
    {
      name: "LF before shell-wrapper command",
      command: "git status --short\nbash -lc ./scripts/publish-pr.sh",
    },
    {
      name: "CRLF before shell-wrapper command",
      command: "git status --short\r\nbash -lc ./scripts/publish-pr.sh",
    },
    {
      name: "LF before interpreter-wrapper command",
      command: "git status --short\npython ./scripts/publish-pr.py",
    },
    {
      name: "CRLF before interpreter-wrapper command",
      command: "git status --short\r\npython ./scripts/publish-pr.py",
    },
  ])("fails closed for newline-separated wrapper content: $name", ({ command }) => {
    const decision = evaluateAgentCommandPolicy(terminalInput(command));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "ambiguous_command",
      commandClass: "ambiguous_compound_command",
      audit: {
        redacted: true,
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand: "status",
        hasNestedCommand: true,
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toContain("service-owned GitHub workflow");
  });

  it("fails closed for shell substitution even when no upstream executable is visible", () => {
    const decision = evaluateAgentCommandPolicy(terminalInput("git status --short $(pwd)"));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "ambiguous_command",
      commandClass: "ambiguous_shell_substitution_command",
      audit: {
        redacted: true,
        normalizedExecutable: "git",
        executableKind: "git",
        hasNestedCommand: true,
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toContain("service-owned GitHub workflow");
  });

  it("applies disguised denial to reviewer roles", () => {
    const decision = evaluateAgentCommandPolicy(terminalInput("bash -lc \"git push origin HEAD\"", "reviewer"));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "shell_wrapped_git_push",
      audit: {
        role: "reviewer",
        normalizedExecutable: "bash",
        executableKind: "shell",
        gitSubcommand: "push",
        upstreamContactAttempted: false,
      },
    });
  });

  it("redacts inline environment values around disguised commands", () => {
    const decision = evaluateAgentCommandPolicy(
      terminalInput("GITHUB_TOKEN=plain-secret-value bash -lc \"gh api user\""),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "shell_wrapped_github_cli",
      audit: {
        inlineEnvironmentKeys: ["GITHUB_TOKEN"],
        normalizedExecutable: "bash",
        upstreamContactAttempted: false,
      },
    });
    expect(decision.audit.commandPreview).toContain("GITHUB_TOKEN=[redacted]");
    expect(JSON.stringify(decision.audit)).not.toContain("plain-secret-value");
    expect(decision.message).not.toContain("plain-secret-value");
  });
});

function terminalInput(command: string, role = "worker"): AgentCommandPolicyInput {
  return {
    role,
    phase: role === "reviewer" ? "review" : "implementation",
    surface: "terminal",
    workingDirectory: "/workspace/project",
    rawInput: { command },
    environment: { keysOnly: ["HOME", "PATH"] },
  };
}
