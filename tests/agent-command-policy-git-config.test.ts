import { describe, expect, it } from "vitest";

import {
  evaluateAgentCommandPolicy,
  type AgentCommandPolicyDecision,
  type AgentCommandPolicyInput,
  type AgentCommandPolicyUnsafeGitConfigCategory,
} from "../src/core/harness/AgentCommandPolicy.js";

interface UnsafeGitConfigCase {
  readonly name: string;
  readonly command: string;
  readonly gitSubcommand: string;
  readonly unsafeConfigCategories: readonly AgentCommandPolicyUnsafeGitConfigCategory[];
  readonly inlineEnvironmentKeys?: readonly string[];
  readonly role?: "worker" | "reviewer";
  readonly redactedValue?: string;
}

interface InheritedGitConfigCase {
  readonly name: string;
  readonly environment: AgentCommandPolicyInput["environment"];
  readonly unsafeConfigCategories: readonly AgentCommandPolicyUnsafeGitConfigCategory[];
  readonly inheritedEnvironmentKeys: readonly string[];
}

const GIT_HELPER_DENY_MESSAGE =
  "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.";

describe("AgentCommandPolicy unsafe inline environment and per-command Git config denial", () => {
  it("allows helper-free local inspection with benign inline environment assignments", () => {
    const decision = evaluateAgentCommandPolicy(terminalInput("NO_COLOR=1 LC_ALL=C git status --short"));

    expect(decision).toMatchObject({
      outcome: "allow",
      reasonKind: "local_only_inspection",
      commandClass: "local_git_inspection",
      message: "Allowed helper-free local Git inspection command.",
      audit: {
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand: "status",
        inlineEnvironmentKeys: ["LC_ALL", "NO_COLOR"],
        unsafeConfigCategories: [],
        upstreamContactAttempted: false,
      },
    });
  });

  it.each<UnsafeGitConfigCase>([
    {
      name: "external diff helper from inline GIT_EXTERNAL_DIFF",
      command: "GIT_EXTERNAL_DIFF=./helper git diff -- src/core/harness/AgentCommandPolicy.ts",
      gitSubcommand: "diff",
      unsafeConfigCategories: ["external_diff"],
      inlineEnvironmentKeys: ["GIT_EXTERNAL_DIFF"],
    },
    {
      name: "pager helper from generic PAGER",
      command: "PAGER='sh -c echo blocked' git log -1",
      gitSubcommand: "log",
      unsafeConfigCategories: ["pager"],
      inlineEnvironmentKeys: ["PAGER"],
    },
    {
      name: "credential prompt helper from SSH_ASKPASS",
      command: "SSH_ASKPASS=./askpass git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["credential_helper"],
      inlineEnvironmentKeys: ["SSH_ASKPASS"],
    },
    {
      name: "transport helper from GIT_PROXY_COMMAND",
      command: "GIT_PROXY_COMMAND=./proxy git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["transport_helper"],
      inlineEnvironmentKeys: ["GIT_PROXY_COMMAND"],
    },
    {
      name: "Git exec path helper lookup override",
      command: "GIT_EXEC_PATH=./fake-git-core git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["other"],
      inlineEnvironmentKeys: ["GIT_EXEC_PATH"],
    },
    {
      name: "command lookup override from inline PATH",
      command: "PATH=./fake-bin git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["command_lookup"],
      inlineEnvironmentKeys: ["PATH"],
    },
    {
      name: "Git behavior override from inline HOME",
      command: "HOME=./fake-home git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["git_environment"],
      inlineEnvironmentKeys: ["HOME"],
    },
    {
      name: "Git config lookup override from inline XDG_CONFIG_HOME",
      command: "XDG_CONFIG_HOME=./fake-config git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["git_environment"],
      inlineEnvironmentKeys: ["XDG_CONFIG_HOME"],
    },
    {
      name: "repository redirection from inline GIT_DIR",
      command: "GIT_DIR=../other/.git git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["git_environment"],
      inlineEnvironmentKeys: ["GIT_DIR"],
    },
    {
      name: "work tree redirection from inline GIT_WORK_TREE",
      command: "GIT_WORK_TREE=../other git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["git_environment"],
      inlineEnvironmentKeys: ["GIT_WORK_TREE"],
    },
    {
      name: "loader helper execution from inline LD_PRELOAD",
      command: "LD_PRELOAD=./helper.so git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["loader"],
      inlineEnvironmentKeys: ["LD_PRELOAD"],
    },
    {
      name: "macOS loader helper execution from inline DYLD_INSERT_LIBRARIES",
      command: "DYLD_INSERT_LIBRARIES=./helper.dylib git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["loader"],
      inlineEnvironmentKeys: ["DYLD_INSERT_LIBRARIES"],
    },
    {
      name: "reviewer credential from inline GitHub PAT",
      command: "GITHUB_PAT=pat-secret-value git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["credential_helper"],
      inlineEnvironmentKeys: ["GITHUB_PAT"],
      role: "reviewer",
      redactedValue: "pat-secret-value",
    },
  ])(
    "denies unsafe inline environment before local inspection: $name",
    ({ command, gitSubcommand, unsafeConfigCategories, inlineEnvironmentKeys, role, redactedValue }) => {
      const decision = evaluateAgentCommandPolicy(terminalInput(command, role ?? "worker"));

      expectUnsafeGitConfigDecision(decision, {
        gitSubcommand,
        unsafeConfigCategories,
        inlineEnvironmentKeys,
        role: role ?? "worker",
      });
      if (redactedValue !== undefined) {
        expect(JSON.stringify(decision.audit)).not.toContain(redactedValue);
      }
    },
  );

  it.each<UnsafeGitConfigCase>([
    {
      name: "alias helper config",
      command: "git -c alias.publish='!helper' status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["alias"],
    },
    {
      name: "credential helper config",
      command: "git -c credential.helper='!helper' status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["credential_helper"],
    },
    {
      name: "hooks path config",
      command: "git -c core.hooksPath=.githooks status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["hook"],
    },
    {
      name: "filter process config",
      command: "git -c filter.lfs.process='git-lfs filter-process' status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["filter"],
    },
    {
      name: "signing program config",
      command: "git -c gpg.program=./fake-gpg log -1",
      gitSubcommand: "log",
      unsafeConfigCategories: ["signing_program"],
    },
    {
      name: "filesystem monitor config",
      command: "git -c core.fsmonitor=./watchman status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["filesystem_monitor"],
    },
    {
      name: "transport helper protocol config",
      command: "git -c protocol.ext.allow=always status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["transport_helper"],
    },
    {
      name: "ambiguous include config fails closed",
      command: "git -c include.path=./helper-config status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["other"],
    },
  ])(
    "denies unsafe per-command Git -c config before local inspection: $name",
    ({ command, gitSubcommand, unsafeConfigCategories }) => {
      const decision = evaluateAgentCommandPolicy(terminalInput(command));

      expectUnsafeGitConfigDecision(decision, {
        gitSubcommand,
        unsafeConfigCategories,
        inlineEnvironmentKeys: [],
        role: "worker",
      });
    },
  );

  it.each<UnsafeGitConfigCase>([
    {
      name: "separate --config-env option with pager config",
      command: "git --config-env core.pager=AGENT_PAGER log -1",
      gitSubcommand: "log",
      unsafeConfigCategories: ["pager"],
    },
    {
      name: "inline --config-env option with SSH command config",
      command: "git --config-env=core.sshCommand=AGENT_SSH status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["transport_helper"],
    },
  ])("denies unsafe --config-env Git config: $name", ({ command, gitSubcommand, unsafeConfigCategories }) => {
    const decision = evaluateAgentCommandPolicy(terminalInput(command));

    expectUnsafeGitConfigDecision(decision, {
      gitSubcommand,
      unsafeConfigCategories,
      inlineEnvironmentKeys: [],
      role: "worker",
    });
  });

  it.each<UnsafeGitConfigCase>([
    {
      name: "multiple indexed GIT_CONFIG_COUNT pairs from inline environment",
      command:
        "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=less GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!helper' git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["credential_helper", "pager"],
      inlineEnvironmentKeys: [
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_KEY_1",
        "GIT_CONFIG_VALUE_0",
        "GIT_CONFIG_VALUE_1",
      ],
    },
    {
      name: "missing indexed config key fails closed",
      command: "GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0='!helper' git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["other"],
      inlineEnvironmentKeys: ["GIT_CONFIG_COUNT", "GIT_CONFIG_VALUE_0"],
    },
    {
      name: "oversized indexed config count fails closed before unbounded expansion",
      command: "GIT_CONFIG_COUNT=9007199254740991 git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["other"],
      inlineEnvironmentKeys: ["GIT_CONFIG_COUNT"],
    },
    {
      name: "oversized indexed config slot fails closed as ambiguous",
      command:
        "GIT_CONFIG_COUNT=65 GIT_CONFIG_KEY_64=core.pager GIT_CONFIG_VALUE_64=less git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["other"],
      inlineEnvironmentKeys: [
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_64",
        "GIT_CONFIG_VALUE_64",
      ],
    },
    {
      name: "GIT_CONFIG_PARAMETERS alias from inline environment",
      command: "GIT_CONFIG_PARAMETERS='alias.publish=!gh pr create' git status --short",
      gitSubcommand: "status",
      unsafeConfigCategories: ["alias"],
      inlineEnvironmentKeys: ["GIT_CONFIG_PARAMETERS"],
    },
  ])(
    "denies unsafe Git config injected through inline GIT_CONFIG_* environment: $name",
    ({ command, gitSubcommand, unsafeConfigCategories, inlineEnvironmentKeys }) => {
      const decision = evaluateAgentCommandPolicy(terminalInput(command));

      expectUnsafeGitConfigDecision(decision, {
        gitSubcommand,
        unsafeConfigCategories,
        inlineEnvironmentKeys,
        role: "worker",
      });
    },
  );

  it.each<InheritedGitConfigCase>([
    {
      name: "transport helper from inherited indexed GIT_CONFIG_COUNT pair",
      environment: {
        inherited: {
          HOME: "/home/agent",
          PATH: "/usr/bin",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "protocol.ext.allow",
          GIT_CONFIG_VALUE_0: "always",
        },
      },
      unsafeConfigCategories: ["transport_helper"],
      inheritedEnvironmentKeys: ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "HOME", "PATH"],
    },
    {
      name: "GIT_CONFIG_GLOBAL path fails closed without exposing a helper value",
      environment: {
        inherited: {
          HOME: "/home/agent",
          PATH: "/usr/bin",
          GIT_CONFIG_GLOBAL: "/tmp/helper.gitconfig",
        },
      },
      unsafeConfigCategories: ["other"],
      inheritedEnvironmentKeys: ["GIT_CONFIG_GLOBAL", "HOME", "PATH"],
    },
  ])("denies unsafe Git config injected through inherited environment: $name", ({ environment, unsafeConfigCategories, inheritedEnvironmentKeys }) => {
    const decision = evaluateAgentCommandPolicy(terminalInput("git status --short", "worker", environment));

    expectUnsafeGitConfigDecision(decision, {
      gitSubcommand: "status",
      unsafeConfigCategories,
      inlineEnvironmentKeys: [],
      inheritedEnvironmentKeys,
      role: "worker",
    });
  });
});

function expectUnsafeGitConfigDecision(
  decision: AgentCommandPolicyDecision,
  expected: {
    readonly gitSubcommand: string;
    readonly unsafeConfigCategories: readonly AgentCommandPolicyUnsafeGitConfigCategory[];
    readonly inlineEnvironmentKeys: readonly string[] | undefined;
    readonly inheritedEnvironmentKeys?: readonly string[];
    readonly role: "worker" | "reviewer";
  },
): void {
  expect(decision).toMatchObject({
    outcome: "deny",
    reasonKind: "unsafe_git_config",
    commandClass: "git_local_inspection_with_helper",
    message: GIT_HELPER_DENY_MESSAGE,
    audit: {
      redacted: true,
      role: expected.role,
      normalizedExecutable: "git",
      executableKind: "git",
      gitSubcommand: expected.gitSubcommand,
      commandClass: "git_local_inspection_with_helper",
      inlineEnvironmentKeys: expected.inlineEnvironmentKeys ?? [],
      upstreamContactAttempted: false,
    },
  });
  expect(decision.audit.unsafeConfigCategories).toEqual(expected.unsafeConfigCategories);
  if (expected.inheritedEnvironmentKeys !== undefined) {
    expect(decision.audit.inheritedEnvironmentKeys).toEqual(expected.inheritedEnvironmentKeys);
  }
  expect(decision.message).not.toContain("policy scaffold");
}

function terminalInput(
  command: string,
  role: "worker" | "reviewer" = "worker",
  environment: AgentCommandPolicyInput["environment"] = { keysOnly: ["HOME", "PATH"] },
): AgentCommandPolicyInput {
  return {
    role,
    phase: role === "reviewer" ? "review" : "implementation",
    surface: "terminal",
    workingDirectory: "/workspace/project",
    rawInput: { command },
    environment,
  };
}
