import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateAgentCommandPolicy,
  type AgentCommandPolicyInput,
} from "../src/core/harness/AgentCommandPolicy.js";

const temporaryDirectories: string[] = [];
const GIT_HELPER_DENY_MESSAGE =
  "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.";

describe("AgentCommandPolicy persisted Git config fake-helper fail-closed behavior", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("denies persisted repository diff.external config before a fake helper can run", () => {
    const workspace = temporaryDirectory();
    const helper = writeFakeHelper(workspace, "repo-diff-helper-ran");
    writeGitConfig(path.join(workspace, ".git", "config"), [
      "[core]",
      "  repositoryformatversion = 0",
      "[diff]",
      `  external = ${helper.commandPath}`,
    ]);

    const decision = evaluateAgentCommandPolicy(
      terminalInput("git diff -- README.md", { workingDirectory: workspace }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      message: GIT_HELPER_DENY_MESSAGE,
      audit: {
        normalizedExecutable: "git",
        executableKind: "git",
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
    expect(fs.existsSync(helper.markerPath)).toBe(false);
    expect(JSON.stringify(decision.audit)).not.toContain(helper.commandPath);
    expect(JSON.stringify(decision.audit)).not.toContain(helper.markerPath);
  });

  it("denies persisted user diff.external config before a fake helper can run", () => {
    const workspace = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    const helper = writeFakeHelper(homeDirectory, "user-diff-helper-ran");
    writeGitConfig(path.join(workspace, ".git", "config"), [
      "[core]",
      "  repositoryformatversion = 0",
    ]);
    writeGitConfig(path.join(homeDirectory, ".gitconfig"), [
      "[diff]",
      `  external = ${helper.commandPath}`,
    ]);

    const decision = evaluateAgentCommandPolicy(
      terminalInput("git diff -- README.md", {
        workingDirectory: workspace,
        environment: { inherited: { HOME: homeDirectory, PATH: path.dirname(process.execPath) } },
      }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      message: GIT_HELPER_DENY_MESSAGE,
      audit: {
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand: "diff",
        inheritedEnvironmentKeys: ["HOME", "PATH"],
        unsafeConfigCategories: ["external_diff"],
        unsafeConfigFindings: [
          {
            source: "persisted_user_config",
            key: "diff.external",
            category: "external_diff",
            effect: "executes_helper",
          },
        ],
        upstreamContactAttempted: false,
      },
    });
    expect(fs.existsSync(helper.markerPath)).toBe(false);
    expect(JSON.stringify(decision.audit)).not.toContain(helper.commandPath);
    expect(JSON.stringify(decision.audit)).not.toContain(helper.markerPath);
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-agent-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeGitConfig(filePath: string, lines: readonly string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeFakeHelper(directory: string, markerName: string): { readonly commandPath: string; readonly markerPath: string } {
  const markerPath = path.join(directory, `${markerName}.marker`);
  const commandPath = path.join(directory, `${markerName}.sh`);
  fs.writeFileSync(commandPath, `#!/bin/sh\nprintf helper-ran > ${JSON.stringify(markerPath)}\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  return { commandPath, markerPath };
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
