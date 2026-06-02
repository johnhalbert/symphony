import { describe, expect, it } from "vitest";

import {
  evaluateAgentCommandPolicy,
  type AgentCommandPolicyInput,
} from "../src/core/harness/AgentCommandPolicy.js";

interface DirectDenyCase {
  readonly command: string;
  readonly commandClass: string;
  readonly executable: string;
  readonly gitSubcommand?: string;
  readonly targetHosts?: readonly string[];
}

describe("AgentCommandPolicy direct upstream GitHub denial", () => {
  it.each<DirectDenyCase>([
    {
      command: "git push origin HEAD",
      commandClass: "git_push",
      executable: "git",
      gitSubcommand: "push",
    },
    {
      command: "git pull --rebase origin main",
      commandClass: "git_pull",
      executable: "git",
      gitSubcommand: "pull",
    },
    {
      command: "git -C ../repo fetch --all --prune",
      commandClass: "git_fetch",
      executable: "git",
      gitSubcommand: "fetch",
    },
    {
      command: "git clone https://github.com/acme/repo.git",
      commandClass: "git_clone",
      executable: "git",
      gitSubcommand: "clone",
      targetHosts: ["github.com"],
    },
    {
      command: "git remote update origin",
      commandClass: "git_remote_update",
      executable: "git",
      gitSubcommand: "remote",
    },
    {
      command: "git remote prune origin",
      commandClass: "git_remote_prune",
      executable: "git",
      gitSubcommand: "remote",
    },
    {
      command: "git checkout --track origin/main",
      commandClass: "git_upstream_checkout",
      executable: "git",
      gitSubcommand: "checkout",
    },
    {
      command: "/usr/bin/git ls-remote git@github.com:acme/repo.git",
      commandClass: "git_ls_remote",
      executable: "git",
      gitSubcommand: "ls-remote",
      targetHosts: ["github.com"],
    },
    {
      command: "C:\\tools\\Git\\cmd\\git.exe fetch origin main",
      commandClass: "git_fetch",
      executable: "git",
      gitSubcommand: "fetch",
    },
    {
      command: "git remote add origin https://github.com/acme/repo.git",
      commandClass: "git_github_transport",
      executable: "git",
      gitSubcommand: "remote",
      targetHosts: ["github.com"],
    },
    {
      command: "gh pr create --fill",
      commandClass: "github_cli",
      executable: "gh",
    },
    {
      command: "gh pr edit 42 --title updated",
      commandClass: "github_cli",
      executable: "gh",
    },
    {
      command: "/opt/homebrew/bin/gh pr review 42 --approve",
      commandClass: "github_cli",
      executable: "gh",
    },
    {
      command: "gh api repos/acme/repo/pulls",
      commandClass: "github_cli",
      executable: "gh",
    },
    {
      command: "hub pull-request --push",
      commandClass: "github_cli",
      executable: "hub",
    },
    {
      command: "ssh -T git@github.com",
      commandClass: "ssh_github_transport",
      executable: "ssh",
      targetHosts: ["github.com"],
    },
    {
      command: "curl https://api.github.com/repos/acme/repo/pulls",
      commandClass: "curl_github_request",
      executable: "curl",
      targetHosts: ["api.github.com"],
    },
    {
      command: "wget https://github.com/acme/repo",
      commandClass: "wget_github_request",
      executable: "wget",
      targetHosts: ["github.com"],
    },
  ])("denies $command before upstream contact", ({ command, commandClass, executable, gitSubcommand, targetHosts }) => {
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

    if (gitSubcommand) {
      expect(decision.audit.gitSubcommand).toBe(gitSubcommand);
    }
    if (targetHosts) {
      expect(decision.audit.targetHosts).toEqual(targetHosts);
    }
  });

  it.each(["worker", "reviewer"])("applies direct upstream denial to the %s role", (role) => {
    const decision = evaluateAgentCommandPolicy(terminalInput("git push origin HEAD", role));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "git_push",
      audit: {
        role,
        upstreamContactAttempted: false,
      },
    });
  });

  it("redacts credential material from policy audit previews", () => {
    const decision = evaluateAgentCommandPolicy(
      terminalInput("git clone https://ghp_1234567890abcdef@github.com/acme/repo.git"),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "git_clone",
    });
    expect(decision.audit.commandPreview).toContain("[redacted]");
    expect(decision.audit.commandPreview).not.toContain("ghp_1234567890abcdef");
    expect(decision.message).not.toContain("ghp_1234567890abcdef");
  });

  it("fails closed when worker command content is missing", () => {
    const decision = evaluateAgentCommandPolicy(terminalInput(""));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unknown_command",
      commandClass: "unknown_command",
      audit: {
        upstreamContactAttempted: false,
      },
    });
  });

  it("does not apply the worker/reviewer boundary to service-owned roles", () => {
    const decision = evaluateAgentCommandPolicy(terminalInput("gh pr create --fill", "service"));

    expect(decision).toMatchObject({
      outcome: "allow",
      reasonKind: "role_not_restricted",
      commandClass: "role_not_restricted",
      audit: {
        role: "service",
        normalizedExecutable: "gh",
        upstreamContactAttempted: false,
      },
    });
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
