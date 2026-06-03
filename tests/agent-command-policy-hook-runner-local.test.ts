import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { evaluateAgentCommandPolicyHookPayload } from "../src/core/harness/AgentCommandPolicyHookRunner.js";

const temporaryDirectories: string[] = [];

describe("AgentCommandPolicyHookRunner local inspection context", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses terminal workdir as the effective cwd so clean local inspection is not contaminated by the hook process cwd", async () => {
    const hookProcessRepo = temporaryDirectory();
    const cleanToolRepo = temporaryDirectory();
    writeUnsafeDiffHelperConfig(hookProcessRepo, path.join(hookProcessRepo, "hook-cwd-helper.sh"));
    writeSafeRepoConfig(cleanToolRepo);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(
        hermesPayload({ command: "git diff -- README.md", workdir: cleanToolRepo }, { cwd: hookProcessRepo }),
      ),
      hookContext(),
    );

    expect(evaluation.policyInput).toMatchObject({
      workingDirectory: path.normalize(cleanToolRepo),
      rawInput: { command: "git diff -- README.md", workdir: cleanToolRepo },
      environment: { keysOnly: ["PATH"] },
    });
    expect(evaluation.decision).toMatchObject({
      outcome: "allow",
      reasonKind: "local_only_inspection",
      commandClass: "local_git_inspection",
      audit: {
        upstreamContactAttempted: false,
        unsafeConfigCategories: [],
      },
    });
    expect(evaluation.stdout).toBe("");
  });

  it("blocks local inspection when terminal workdir selects a repository with persisted helper config", async () => {
    const hookProcessRepo = temporaryDirectory();
    const unsafeToolRepo = temporaryDirectory();
    const helperPath = path.join(unsafeToolRepo, "tool-workdir-helper.sh");
    writeSafeRepoConfig(hookProcessRepo);
    writeUnsafeDiffHelperConfig(unsafeToolRepo, helperPath);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(
        hermesPayload({ command: "git diff -- README.md", workdir: unsafeToolRepo }, { cwd: hookProcessRepo }),
      ),
      hookContext(),
    );

    expect(evaluation.policyInput?.workingDirectory).toBe(path.normalize(unsafeToolRepo));
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      audit: {
        gitSubcommand: "diff",
        unsafeConfigCategories: ["external_diff"],
        unsafeConfigFindings: [
          {
            source: "persisted_repo_config",
            key: "diff.external",
            category: "external_diff",
            effect: "executes_helper",
          },
        ],
        upstreamContactAttempted: false,
      },
    });
    expect(evaluation.hookResponse).toEqual({
      action: "block",
      message:
        "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.",
    });
    expect(evaluation.stdout).toContain("local Git inspection would execute a configured helper");
    expect(JSON.stringify(evaluation.decision.audit)).not.toContain(helperPath);
    expect(evaluation.stdout).not.toContain(helperPath);
  });

  it("resolves relative terminal workdir against the hook payload cwd before local repository inspection", async () => {
    const baseDirectory = temporaryDirectory();
    const unsafeToolRepo = path.join(baseDirectory, "unsafe-repo");
    const helperPath = path.join(baseDirectory, "relative-workdir-helper.sh");
    writeSafeRepoConfig(baseDirectory);
    writeUnsafeDiffHelperConfig(unsafeToolRepo, helperPath);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git diff -- README.md", workdir: "unsafe-repo" }, { cwd: baseDirectory })),
      hookContext(),
    );

    expect(evaluation.policyInput?.workingDirectory).toBe(path.resolve(baseDirectory, "unsafe-repo"));
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      audit: {
        unsafeConfigFindings: [
          expect.objectContaining({
            source: "persisted_repo_config",
            key: "diff.external",
            category: "external_diff",
          }) as unknown,
        ],
        upstreamContactAttempted: false,
      },
    });
    expect(JSON.stringify(evaluation.decision.audit)).not.toContain(helperPath);
  });

  it("passes environment keys and selected home context without exposing unrelated credential values", async () => {
    const workspace = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    const helperPath = path.join(homeDirectory, "user-config-helper.sh");
    const apiSecret = "ambient-openai-secret-value";
    writeSafeRepoConfig(workspace);
    writeGitConfig(path.join(homeDirectory, ".gitconfig"), ["[diff]", `  external = ${helperPath}`]);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git diff -- README.md" }, { cwd: workspace })),
      hookContext({ environment: { HOME: homeDirectory, OPENAI_API_KEY: apiSecret, PATH: path.dirname(process.execPath) } }),
    );

    expect(evaluation.policyInput).toMatchObject({
      workingDirectory: path.normalize(workspace),
      environment: {
        keysOnly: ["HOME", "OPENAI_API_KEY", "PATH"],
        inherited: { HOME: homeDirectory },
      },
    });
    expect(JSON.stringify(evaluation.policyInput?.environment)).not.toContain(apiSecret);
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      audit: {
        inheritedEnvironmentKeys: ["HOME", "OPENAI_API_KEY", "PATH"],
        unsafeConfigFindings: [
          expect.objectContaining({
            source: "persisted_user_config",
            key: "diff.external",
            category: "external_diff",
            effect: "executes_helper",
          }) as unknown,
        ],
        upstreamContactAttempted: false,
      },
    });
    expect(JSON.stringify(evaluation.decision.audit)).not.toContain(apiSecret);
    expect(JSON.stringify(evaluation.decision.audit)).not.toContain(helperPath);
    expect(evaluation.stdout).not.toContain(apiSecret);
    expect(evaluation.stdout).not.toContain(helperPath);
  });
});

function hookContext(
  overrides: {
    environment?: Record<string, string | undefined>;
  } = {},
) {
  return {
    role: "worker",
    phase: "implementation",
    environment: overrides.environment ?? { PATH: path.dirname(process.execPath) },
  };
}

function hermesPayload(toolInput: Record<string, unknown>, options: { cwd?: string } = {}) {
  return {
    hook_event_name: "pre_tool_call",
    tool_name: "terminal",
    tool_input: toolInput,
    session_id: "test-session",
    cwd: options.cwd ?? "/hook/process/cwd",
    extra: { task_id: "task-1", tool_call_id: "tool-call-1" },
  };
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-hook-runner-local-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSafeRepoConfig(repositoryDirectory: string): void {
  writeGitConfig(path.join(repositoryDirectory, ".git", "config"), [
    "[core]",
    "  repositoryformatversion = 0",
  ]);
}

function writeUnsafeDiffHelperConfig(repositoryDirectory: string, helperPath: string): void {
  writeGitConfig(path.join(repositoryDirectory, ".git", "config"), [
    "[core]",
    "  repositoryformatversion = 0",
    "[diff]",
    `  external = ${helperPath}`,
  ]);
}

function writeGitConfig(configPath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${lines.join("\n")}\n`, "utf8");
}
