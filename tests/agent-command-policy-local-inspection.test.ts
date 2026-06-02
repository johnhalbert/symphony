import { describe, expect, it } from "vitest";

import {
  evaluateAgentCommandPolicy,
  type AgentCommandPolicyInput,
  type AgentCommandPolicyUnsafeGitConfigCategory,
} from "../src/core/harness/AgentCommandPolicy.js";

interface LocalGitAllowCase {
  readonly name: string;
  readonly command: string;
  readonly gitSubcommand: string;
  readonly role?: "worker" | "reviewer";
}

interface LocalGitUnsafeHelperCase {
  readonly name: string;
  readonly command: string;
  readonly gitSubcommand: string;
  readonly unsafeConfigCategories: readonly AgentCommandPolicyUnsafeGitConfigCategory[];
}

interface LocalGitNonInspectionCase {
  readonly name: string;
  readonly command: string;
  readonly gitSubcommand: string;
}

describe("AgentCommandPolicy helper-free local Git inspection allowlist", () => {
  it.each<LocalGitAllowCase>([
    {
      name: "status porcelain with branch metadata",
      command: "git status --short --branch",
      gitSubcommand: "status",
    },
    {
      name: "status from an explicit local worktree path",
      command: "git -C ../repo status --porcelain=v2",
      gitSubcommand: "status",
    },
    {
      name: "diff stat scoped to a pathspec",
      command: "git diff --stat -- src/core/harness/AgentCommandPolicy.ts",
      gitSubcommand: "diff",
    },
    {
      name: "diff against a local remote-tracking ref with helpers disabled",
      command: "git diff --no-ext-diff --no-textconv origin/main...HEAD",
      gitSubcommand: "diff",
    },
    {
      name: "file history log query",
      command: "git log --oneline --decorate -5 -- src/core/harness/AgentCommandPolicy.ts",
      gitSubcommand: "log",
    },
    {
      name: "show object content with helper-enabling options disabled",
      command: "git show --no-ext-diff --no-textconv HEAD:package.json",
      gitSubcommand: "show",
    },
    {
      name: "branch listing across local and remote-tracking refs",
      command: "git branch --list --all --no-color",
      gitSubcommand: "branch",
    },
    {
      name: "branch listing filtered by containing commit",
      command: "git branch --contains HEAD --no-color",
      gitSubcommand: "branch",
    },
    {
      name: "blame file history inspection",
      command: "git blame --line-porcelain -- src/core/harness/AgentCommandPolicy.ts",
      gitSubcommand: "blame",
    },
    {
      name: "reviewer local show inspection",
      command: "git show --stat HEAD",
      gitSubcommand: "show",
      role: "reviewer",
    },
  ])("allows helper-free local inspection: $name", ({ command, gitSubcommand, role }) => {
    const decision = evaluateAgentCommandPolicy(terminalInput(command, role));

    expect(decision).toMatchObject({
      outcome: "allow",
      reasonKind: "local_only_inspection",
      commandClass: "local_git_inspection",
      message: "Allowed helper-free local Git inspection command.",
      audit: {
        redacted: true,
        role: role ?? "worker",
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand,
        commandClass: "local_git_inspection",
        unsafeConfigCategories: [],
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toContain("helper-free local Git inspection");
    expect(decision.message).not.toContain("policy scaffold");
  });

  it.each<LocalGitUnsafeHelperCase>([
    {
      name: "external diff helper flag",
      command: "git diff --ext-diff -- src/core/harness/AgentCommandPolicy.ts",
      gitSubcommand: "diff",
      unsafeConfigCategories: ["external_diff"],
    },
    {
      name: "textconv helper flag",
      command: "git show --textconv HEAD:src/core/harness/AgentCommandPolicy.ts",
      gitSubcommand: "show",
      unsafeConfigCategories: ["external_diff"],
    },
    {
      name: "global pager helper flag",
      command: "git --paginate log -1",
      gitSubcommand: "log",
      unsafeConfigCategories: ["pager"],
    },
    {
      name: "global short pager helper flag",
      command: "git -p show HEAD",
      gitSubcommand: "show",
      unsafeConfigCategories: ["pager"],
    },
    {
      name: "per-command Git config before local status",
      command: "git -c core.pager='sh -c echo blocked' status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["pager"],
    },
  ])(
    "denies local inspection that could execute Git helpers before execution: $name",
    ({ command, gitSubcommand, unsafeConfigCategories }) => {
      const decision = evaluateAgentCommandPolicy(terminalInput(command));

      expect(decision).toMatchObject({
        outcome: "deny",
        reasonKind: "unsafe_git_config",
        commandClass: "git_local_inspection_with_helper",
        message:
          "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.",
        audit: {
          redacted: true,
          normalizedExecutable: "git",
          executableKind: "git",
          gitSubcommand,
          commandClass: "git_local_inspection_with_helper",
          unsafeConfigCategories,
          upstreamContactAttempted: false,
        },
      });
      expect(decision.message).not.toContain("policy scaffold");
    },
  );

  it.each<LocalGitNonInspectionCase>([
    {
      name: "delete a branch",
      command: "git branch -d stale-branch",
      gitSubcommand: "branch",
    },
    {
      name: "create a branch from a bare branch argument",
      command: "git branch feature-from-agent HEAD",
      gitSubcommand: "branch",
    },
    {
      name: "rename a branch",
      command: "git branch -m old-name new-name",
      gitSubcommand: "branch",
    },
    {
      name: "set upstream tracking metadata",
      command: "git branch --set-upstream-to origin/main main",
      gitSubcommand: "branch",
    },
  ])("denies local Git commands outside the inspection allowlist: $name", ({ command, gitSubcommand }) => {
    const decision = evaluateAgentCommandPolicy(terminalInput(command));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "ambiguous_command",
      commandClass: "git_non_inspection_command",
      audit: {
        redacted: true,
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand,
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toContain("only helper-free local inspection commands are allowed");
    expect(decision.message).toContain("service-owned GitHub workflow");
    expect(decision.message).not.toContain("policy scaffold");
  });

  it("uses the stable local-only denial message for unsupported Git subcommands", () => {
    const decision = evaluateAgentCommandPolicy(terminalInput("git commit --amend --no-edit"));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "ambiguous_command",
      commandClass: "ambiguous_git_command",
      audit: {
        normalizedExecutable: "git",
        gitSubcommand: "commit",
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toBe(
      "Blocked worker/reviewer Git command: command is not classified as helper-free local inspection. Use direct local inspection commands or Symphony service-owned GitHub workflow actions.",
    );
  });
});

function terminalInput(command: string, role: "worker" | "reviewer" = "worker"): AgentCommandPolicyInput {
  return {
    role,
    phase: role === "reviewer" ? "review" : "implementation",
    surface: "terminal",
    workingDirectory: "/workspace/project",
    rawInput: { command },
    environment: { keysOnly: ["HOME", "PATH"] },
  };
}
