import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateAgentCommandPolicy,
  type AgentCommandPolicyInput,
  type AgentCommandPolicyUnsafeGitConfigCategory,
  type AgentCommandPolicyUnsafeGitConfigEffect,
  type AgentCommandPolicyUnsafeGitConfigFinding,
  type AgentCommandPolicyUnsafeGitConfigSource,
} from "../src/core/harness/AgentCommandPolicy.js";

const temporaryDirectories: string[] = [];
const GIT_HELPER_DENY_MESSAGE =
  "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.";

type PersistedConfigSource = Extract<
  AgentCommandPolicyUnsafeGitConfigSource,
  "persisted_repo_config" | "persisted_user_config"
>;

interface PersistedConfigMatrixCase {
  readonly name: string;
  readonly lines: (helper: FakeHelper) => readonly string[];
  readonly expectedKey: string;
  readonly category: AgentCommandPolicyUnsafeGitConfigCategory;
  readonly effect: AgentCommandPolicyUnsafeGitConfigEffect;
}

interface FakeHelper {
  readonly commandPath: string;
  readonly markerPath: string;
}

const PERSISTED_CONFIG_SOURCES: readonly PersistedConfigSource[] = ["persisted_repo_config", "persisted_user_config"];
const PERSISTED_CONFIG_MATRIX: readonly PersistedConfigMatrixCase[] = [
  {
    name: "alias helper",
    lines: (helper) => ["[alias]", `  publish = !${helper.commandPath}`],
    expectedKey: "alias.publish",
    category: "alias",
    effect: "executes_helper",
  },
  {
    name: "pager helper",
    lines: (helper) => ["[core]", `  pager = ${helper.commandPath}`],
    expectedKey: "core.pager",
    category: "pager",
    effect: "executes_helper",
  },
  {
    name: "external diff helper",
    lines: (helper) => ["[diff]", `  external = ${helper.commandPath}`],
    expectedKey: "diff.external",
    category: "external_diff",
    effect: "executes_helper",
  },
  {
    name: "credential helper",
    lines: (helper) => ["[credential]", `  helper = !${helper.commandPath}`],
    expectedKey: "credential.helper",
    category: "credential_helper",
    effect: "uses_credentials",
  },
  {
    name: "core askPass helper",
    lines: (helper) => ["[core]", `  askPass = ${helper.commandPath}`],
    expectedKey: "core.askpass",
    category: "credential_helper",
    effect: "uses_credentials",
  },
  {
    name: "hook path helper",
    lines: (helper) => ["[core]", `  hooksPath = ${path.dirname(helper.commandPath)}`],
    expectedKey: "core.hookspath",
    category: "hook",
    effect: "executes_helper",
  },
  {
    name: "filter process helper",
    lines: (helper) => ["[filter \"evil\"]", `  process = ${helper.commandPath}`],
    expectedKey: "filter.evil.process",
    category: "filter",
    effect: "executes_helper",
  },
  {
    name: "signing program helper",
    lines: (helper) => ["[gpg]", `  program = ${helper.commandPath}`],
    expectedKey: "gpg.program",
    category: "signing_program",
    effect: "executes_helper",
  },
  {
    name: "filesystem monitor helper",
    lines: (helper) => ["[core]", `  fsmonitor = ${helper.commandPath}`],
    expectedKey: "core.fsmonitor",
    category: "filesystem_monitor",
    effect: "executes_helper",
  },
  {
    name: "transport helper",
    lines: (helper) => ["[core]", `  gitProxy = ${helper.commandPath}`],
    expectedKey: "core.gitproxy",
    category: "transport_helper",
    effect: "contacts_remote",
  },
  {
    name: "SSH command helper",
    lines: (helper) => ["[core]", `  sshCommand = ${helper.commandPath}`],
    expectedKey: "core.sshcommand",
    category: "ssh_command",
    effect: "contacts_remote",
  },
];

describe("AgentCommandPolicy persisted Git config fake-helper fail-closed behavior", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(
    PERSISTED_CONFIG_SOURCES.flatMap((source) =>
      PERSISTED_CONFIG_MATRIX.map((scenario) => ({
        testName: `${source} ${scenario.name}`,
        source,
        scenario,
      })),
    ),
  )("denies persisted $testName before a fake helper can run", ({ source, scenario }) => {
    const workspace = temporaryDirectory();
    const homeDirectory = source === "persisted_user_config" ? temporaryDirectory() : undefined;
    const helper = writeFakeHelper(homeDirectory ?? workspace, `${source}-${scenario.category}-helper-ran`);
    writeSafeRepoConfig(workspace);

    if (source === "persisted_repo_config") {
      writeGitConfig(path.join(workspace, ".git", "config"), [
        "[core]",
        "  repositoryformatversion = 0",
        ...scenario.lines(helper),
      ]);
    } else {
      writeGitConfig(path.join(homeDirectory ?? workspace, ".gitconfig"), scenario.lines(helper));
    }

    const decision = evaluateAgentCommandPolicy(
      terminalInput("git diff -- README.md", {
        workingDirectory: workspace,
        environment:
          homeDirectory === undefined
            ? undefined
            : { inherited: { HOME: homeDirectory, PATH: path.dirname(process.execPath) } },
      }),
    );

    expectUnsafePersistedConfigDeny(decision, {
      source,
      key: scenario.expectedKey,
      category: scenario.category,
      effect: scenario.effect,
    });
    expectNoHelperLeakOrExecution(decision, helper);
  });

  it("denies persisted repository config selected by git -C while the caller cwd is clean", () => {
    const callerWorkspace = temporaryDirectory();
    const targetWorkspace = temporaryDirectory();
    const helper = writeFakeHelper(targetWorkspace, "git-c-target-diff-helper-ran");
    writeSafeRepoConfig(callerWorkspace);
    writeGitConfig(path.join(targetWorkspace, ".git", "config"), [
      "[core]",
      "  repositoryformatversion = 0",
      "[diff]",
      `  external = ${helper.commandPath}`,
    ]);

    const decision = evaluateAgentCommandPolicy(
      terminalInput(`git -C ${quoteCommandToken(targetWorkspace)} diff -- README.md`, {
        workingDirectory: callerWorkspace,
      }),
    );

    expectUnsafePersistedConfigDeny(decision, {
      source: "persisted_repo_config",
      key: "diff.external",
      category: "external_diff",
      effect: "executes_helper",
    });
    expect(decision.audit.upstreamContactAttempted).toBe(false);
    expectNoHelperLeakOrExecution(decision, helper);
  });

  it("denies persisted repository config selected by a relative git -C path", () => {
    const baseDirectory = temporaryDirectory();
    const targetWorkspace = path.join(baseDirectory, "unsafe-repo");
    const helper = writeFakeHelper(baseDirectory, "relative-git-c-diff-helper-ran");
    writeGitConfig(path.join(targetWorkspace, ".git", "config"), [
      "[core]",
      "  repositoryformatversion = 0",
      "[diff]",
      `  external = ${helper.commandPath}`,
    ]);

    const decision = evaluateAgentCommandPolicy(
      terminalInput("git -C unsafe-repo status --short", { workingDirectory: baseDirectory }),
    );

    expectUnsafePersistedConfigDeny(decision, {
      source: "persisted_repo_config",
      key: "diff.external",
      category: "external_diff",
      effect: "executes_helper",
    });
    expectNoHelperLeakOrExecution(decision, helper);
  });

  it.each([
    {
      name: "equals-form --git-dir/--work-tree",
      command: (targetWorkspace: string) =>
        `git --git-dir=${quoteCommandToken(path.join(targetWorkspace, ".git"))} --work-tree=${quoteCommandToken(
          targetWorkspace,
        )} diff -- README.md`,
    },
    {
      name: "separate --git-dir/--work-tree values",
      command: (targetWorkspace: string) =>
        `git --git-dir ${quoteCommandToken(path.join(targetWorkspace, ".git"))} --work-tree ${quoteCommandToken(
          targetWorkspace,
        )} diff -- README.md`,
    },
    {
      name: "-C-relative --git-dir/--work-tree values",
      command: (targetWorkspace: string) =>
        `git --git-dir=.git --work-tree=. -C ${quoteCommandToken(targetWorkspace)} diff -- README.md`,
    },
    {
      name: "work-tree-selected repository",
      command: (targetWorkspace: string) => `git --work-tree ${quoteCommandToken(targetWorkspace)} status --short`,
    },
  ])("denies persisted repository config selected by $name", ({ command }) => {
    const callerWorkspace = temporaryDirectory();
    const targetWorkspace = temporaryDirectory();
    const helper = writeFakeHelper(targetWorkspace, "explicit-repo-selection-helper-ran");
    writeSafeRepoConfig(callerWorkspace);
    writeGitConfig(path.join(targetWorkspace, ".git", "config"), [
      "[core]",
      "  repositoryformatversion = 0",
      "[diff]",
      `  external = ${helper.commandPath}`,
    ]);

    const decision = evaluateAgentCommandPolicy(
      terminalInput(command(targetWorkspace), { workingDirectory: callerWorkspace }),
    );

    expectUnsafePersistedConfigDeny(decision, {
      source: "persisted_repo_config",
      key: "diff.external",
      category: "external_diff",
      effect: "executes_helper",
    });
    expectNoHelperLeakOrExecution(decision, helper);
  });

  it("fails closed when an explicitly selected git -C repository cannot be resolved", () => {
    const workspace = temporaryDirectory();
    writeSafeRepoConfig(workspace);

    const decision = evaluateAgentCommandPolicy(
      terminalInput("git -C missing-repo status --short", { workingDirectory: workspace }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      message: GIT_HELPER_DENY_MESSAGE,
      audit: {
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand: "status",
        unsafeConfigCategories: ["other"],
        unsafeConfigFindings: [
          {
            source: "persisted_repo_config",
            key: "<unresolved_effective_working_directory>",
            category: "other",
            effect: "ambiguous",
          },
        ],
        upstreamContactAttempted: false,
      },
    });
  });

  it("redacts token-like persisted config key material from structured findings", () => {
    const workspace = temporaryDirectory();
    const secretSentinel = "ghp_secretSentinel12345678";
    writeGitConfig(path.join(workspace, ".git", "config"), [
      "[core]",
      "  repositoryformatversion = 0",
      `[url \"https://${secretSentinel}@github.com/acme/\"]`,
      "  insteadOf = https://github.com/acme/",
    ]);

    const decision = evaluateAgentCommandPolicy(
      terminalInput("git status --short", { workingDirectory: workspace }),
    );

    expectUnsafePersistedConfigDeny(decision, {
      source: "persisted_repo_config",
      key: "url.https://[redacted]@github.com/acme/.insteadof",
      category: "transport_helper",
      effect: "contacts_remote",
    });
    expect(JSON.stringify(decision.audit)).not.toContain(secretSentinel);
    expect(decision.message).not.toContain(secretSentinel);
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-agent-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSafeRepoConfig(workspace: string): void {
  writeGitConfig(path.join(workspace, ".git", "config"), ["[core]", "  repositoryformatversion = 0"]);
}

function writeGitConfig(filePath: string, lines: readonly string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeFakeHelper(directory: string, markerName: string): FakeHelper {
  const markerPath = path.join(directory, `${markerName}.marker`);
  const commandPath = path.join(directory, `${markerName}.sh`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(commandPath, `#!/bin/sh\nprintf helper-ran > ${JSON.stringify(markerPath)}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  return { commandPath, markerPath };
}

function expectUnsafePersistedConfigDeny(
  decision: ReturnType<typeof evaluateAgentCommandPolicy>,
  expectedFinding: AgentCommandPolicyUnsafeGitConfigFinding,
): void {
  expect(decision).toMatchObject({
    outcome: "deny",
    reasonKind: "unsafe_git_config",
    commandClass: "git_local_inspection_with_helper",
    message: GIT_HELPER_DENY_MESSAGE,
    audit: {
      redacted: true,
      normalizedExecutable: "git",
      executableKind: "git",
      unsafeConfigCategories: [expectedFinding.category],
      unsafeConfigFindings: [expectedFinding],
      upstreamContactAttempted: false,
    },
  });
}

function expectNoHelperLeakOrExecution(decision: ReturnType<typeof evaluateAgentCommandPolicy>, helper: FakeHelper): void {
  expect(fs.existsSync(helper.markerPath)).toBe(false);
  expect(JSON.stringify(decision.audit)).not.toContain(helper.commandPath);
  expect(JSON.stringify(decision.audit)).not.toContain(helper.markerPath);
  expect(decision.message).not.toContain(helper.commandPath);
  expect(decision.message).not.toContain(helper.markerPath);
}

function quoteCommandToken(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function terminalInput(
  command: string,
  options: {
    readonly workingDirectory: string;
    readonly environment?: AgentCommandPolicyInput["environment"];
  },
): AgentCommandPolicyInput {
  return {
    role: "worker",
    phase: "implementation",
    surface: "terminal",
    workingDirectory: options.workingDirectory,
    rawInput: { command },
    environment: options.environment ?? { keysOnly: ["HOME", "PATH"] },
  };
}
