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

  it("allows clean absolute terminal workdir when hook and context cwd are omitted", async () => {
    const cleanToolRepo = temporaryDirectory();
    writeSafeRepoConfig(cleanToolRepo);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git status --short", workdir: cleanToolRepo }, { cwd: null })),
      hookContext(),
    );

    expect(evaluation.policyInput).toMatchObject({
      workingDirectory: path.normalize(cleanToolRepo),
      rawInput: { command: "git status --short", workdir: cleanToolRepo },
      environment: { keysOnly: ["PATH"] },
    });
    expect(evaluation.decision).toMatchObject({
      outcome: "allow",
      reasonKind: "local_only_inspection",
      commandClass: "local_git_inspection",
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

  it("resolves relative terminal cwd alias against context workingDirectory when payload cwd is omitted", async () => {
    const baseDirectory = temporaryDirectory();
    const unsafeToolRepo = path.join(baseDirectory, "unsafe-repo");
    const helperPath = path.join(baseDirectory, "context-relative-cwd-helper.sh");
    writeSafeRepoConfig(baseDirectory);
    writeUnsafeDiffHelperConfig(unsafeToolRepo, helperPath);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git diff -- README.md", cwd: "unsafe-repo" }, { cwd: null })),
      hookContext({ workingDirectory: baseDirectory }),
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

  it("fails closed when hook payload and context omit cwd for local Git inspection", async () => {
    const apiSecret = "ambient-missing-cwd-secret";

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git status --short" }, { cwd: null })),
      hookContext({ environment: { OPENAI_API_KEY: apiSecret, PATH: path.dirname(process.execPath) } }),
    );

    expect(evaluation.policyInput).toBeNull();
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "missing_hook_context",
      commandClass: "missing_hermes_tool_working_directory_context",
    });
    expect(evaluation.hookResponse).toEqual({
      action: "block",
      message: expect.stringContaining("trustworthy effective terminal working directory") as string,
    });
    expect(evaluation.stdout).toContain("trustworthy effective terminal working directory");
    expect(evaluation.stdout).not.toContain(apiSecret);
  });

  it("fails closed when relative terminal workdir has no trustworthy hook or context base", async () => {
    const apiSecret = "ambient-relative-cwd-secret";

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git status --short", workdir: "relative-repo" }, { cwd: null })),
      hookContext({ environment: { OPENAI_API_KEY: apiSecret, PATH: path.dirname(process.execPath) } }),
    );

    expect(evaluation.policyInput).toBeNull();
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "missing_hook_context",
      commandClass: "unresolved_relative_hermes_tool_working_directory",
    });
    expect(evaluation.stdout).toContain("trustworthy effective terminal working directory");
    expect(evaluation.stdout).not.toContain(apiSecret);
  });

  it.each([
    { name: "blank workdir", toolInput: { command: "git status --short", workdir: "   " }, commandClass: "malformed_hermes_tool_working_directory" },
    {
      name: "ambiguous workdir aliases",
      toolInput: { command: "git status --short", workdir: "repo-a", cwd: "repo-b" },
      commandClass: "ambiguous_hermes_tool_working_directory",
    },
  ])("fails closed for $name before selecting a local-inspection cwd", async ({ toolInput, commandClass }) => {
    const baseDirectory = temporaryDirectory();
    const apiSecret = "ambient-ambiguous-cwd-secret";

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload(toolInput, { cwd: baseDirectory })),
      hookContext({ environment: { OPENAI_API_KEY: apiSecret, PATH: path.dirname(process.execPath) } }),
    );

    expect(evaluation.policyInput).toBeNull();
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "missing_hook_context",
      commandClass,
    });
    expect(evaluation.stdout).toContain("trustworthy effective terminal working directory");
    expect(evaluation.stdout).not.toContain(apiSecret);
  });

  it("blocks local inspection when the selected terminal workdir is not an inspectable directory", async () => {
    const baseDirectory = temporaryDirectory();
    const missingWorkdir = path.join(baseDirectory, "missing-repo");
    const apiSecret = "ambient-missing-workdir-secret";

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git status --short", workdir: missingWorkdir }, { cwd: null })),
      hookContext({ environment: { OPENAI_API_KEY: apiSecret, PATH: path.dirname(process.execPath) } }),
    );

    expect(evaluation.policyInput?.workingDirectory).toBe(path.normalize(missingWorkdir));
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "missing_hook_context",
      commandClass: "uninspectable_hermes_tool_working_directory",
    });
    expect(evaluation.stdout).toContain("not an inspectable directory");
    expect(evaluation.stdout).not.toContain(apiSecret);
  });

  it.each([
    {
      key: "HOME",
      configPath: (directory: string) => path.join(directory, ".gitconfig"),
    },
    {
      key: "USERPROFILE",
      configPath: (directory: string) => path.join(directory, ".gitconfig"),
    },
    {
      key: "XDG_CONFIG_HOME",
      configPath: (directory: string) => path.join(directory, "git", "config"),
    },
  ])("passes environment keys and selected $key context without exposing unrelated credential values", async ({ key, configPath }) => {
    const workspace = temporaryDirectory();
    const configDirectory = temporaryDirectory();
    const helperPath = path.join(configDirectory, "user-config-helper.sh");
    const apiSecret = "ambient-openai-secret-value";
    writeSafeRepoConfig(workspace);
    writeGitConfig(configPath(configDirectory), ["[diff]", `  external = ${helperPath}`]);

    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ command: "git diff -- README.md" }, { cwd: workspace })),
      hookContext({
        environment: { [key]: configDirectory, OPENAI_API_KEY: apiSecret, PATH: path.dirname(process.execPath) },
      }),
    );

    expect(evaluation.policyInput).toMatchObject({
      workingDirectory: path.normalize(workspace),
      environment: {
        keysOnly: [key, "OPENAI_API_KEY", "PATH"].sort((left, right) => left.localeCompare(right)),
        inherited: { [key]: configDirectory },
      },
    });
    expect(JSON.stringify(evaluation.policyInput?.environment)).not.toContain(apiSecret);
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      audit: {
        inheritedEnvironmentKeys: [key, "OPENAI_API_KEY", "PATH"].sort((left, right) => left.localeCompare(right)),
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
    workingDirectory?: string;
  } = {},
) {
  return {
    role: "worker",
    phase: "implementation",
    environment: overrides.environment ?? { PATH: path.dirname(process.execPath) },
    ...(overrides.workingDirectory === undefined ? {} : { workingDirectory: overrides.workingDirectory }),
  };
}

function hermesPayload(toolInput: Record<string, unknown>, options: { cwd?: string | null } = {}) {
  const payload: Record<string, unknown> = {
    hook_event_name: "pre_tool_call",
    tool_name: "terminal",
    tool_input: toolInput,
    session_id: "test-session",
    extra: { task_id: "task-1", tool_call_id: "tool-call-1" },
  };
  if (options.cwd !== null) payload.cwd = options.cwd ?? "/hook/process/cwd";
  return payload;
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
