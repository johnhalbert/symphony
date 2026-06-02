import { describe, expect, it } from "vitest";

import { evaluateAgentCommandPolicy } from "../src/core/harness/AgentCommandPolicy.js";
import { executeCodePolicyInput } from "./agent-command-policy-fixtures.js";

interface ExecuteCodeDenyCase {
  readonly name: string;
  readonly code: string;
  readonly reasonKind: "upstream_github" | "unsafe_environment" | "ambiguous_command";
  readonly commandClass: string;
  readonly normalizedExecutable?: string;
  readonly executableKind?: string;
  readonly gitSubcommand?: string;
  readonly targetHosts?: readonly string[];
  readonly unsafeConfigCategories?: readonly string[];
  readonly hasNestedCommand?: boolean;
  readonly messageFragment: string;
}

describe("AgentCommandPolicy execute_code denial", () => {
  it.each<ExecuteCodeDenyCase>([
    {
      name: "local Git subprocess spawning",
      code: `import subprocess
subprocess.run(["git", "status", "--short"], check=True)`,
      reasonKind: "ambiguous_command",
      commandClass: "execute_code_subprocess_spawn",
      normalizedExecutable: "git",
      executableKind: "git",
      gitSubcommand: "status",
      hasNestedCommand: true,
      messageFragment: "subprocess spawning",
    },
    {
      name: "local Git shell spawning",
      code: `import os
os.system("git status --short")`,
      reasonKind: "ambiguous_command",
      commandClass: "execute_code_shell_spawn",
      normalizedExecutable: "git",
      executableKind: "git",
      gitSubcommand: "status",
      hasNestedCommand: true,
      messageFragment: "shell process spawning",
    },
    {
      name: "upstream Git fetch through subprocess argv",
      code: `import subprocess
subprocess.run(["git", "fetch", "origin", "main"], check=True)`,
      reasonKind: "upstream_github",
      commandClass: "execute_code_subprocess_git_fetch",
      normalizedExecutable: "git",
      executableKind: "git",
      gitSubcommand: "fetch",
      hasNestedCommand: true,
      messageFragment: "service-owned workflow",
    },
    {
      name: "GitHub CLI through subprocess argv",
      code: `import subprocess
subprocess.run(["gh", "pr", "create", "--fill"], check=True)`,
      reasonKind: "upstream_github",
      commandClass: "execute_code_subprocess_github_cli",
      normalizedExecutable: "gh",
      executableKind: "github_cli",
      hasNestedCommand: true,
      messageFragment: "service-owned workflow",
    },
    {
      name: "Python network client targeting GitHub API",
      code: `import requests
requests.get("https://api.github.com/repos/acme/repo/pulls")`,
      reasonKind: "upstream_github",
      commandClass: "execute_code_python_network_github_request",
      targetHosts: ["api.github.com"],
      messageFragment: "service-owned workflow",
    },
    {
      name: "generic network client with dynamic target",
      code: `import requests
requests.get(url)`,
      reasonKind: "ambiguous_command",
      commandClass: "execute_code_network_client",
      messageFragment: "network-capable code",
    },
    {
      name: "credential-backed GitHub path and token access",
      code: `import os
from pathlib import Path
token = "ghp_1234567890abcdef"
os.environ["GITHUB_TOKEN"]
Path.home().joinpath(".config", "gh", "hosts.yml").read_text()`,
      reasonKind: "unsafe_environment",
      commandClass: "execute_code_credential_backed_path",
      unsafeConfigCategories: ["credential_helper"],
      messageFragment: "credential-backed",
    },
    {
      name: "dynamically constructed subprocess command",
      code: `import subprocess
cmd = ["g" + "it", "fe" + "tch", "origin"]
subprocess.run(cmd, check=True)`,
      reasonKind: "ambiguous_command",
      commandClass: "execute_code_dynamic_command",
      hasNestedCommand: true,
      messageFragment: "dynamically constructed",
    },
    {
      name: "dynamic code evaluation",
      code: `exec(open("script.py").read())`,
      reasonKind: "ambiguous_command",
      commandClass: "execute_code_ambiguous_code",
      messageFragment: "cannot be proven local-only",
    },
  ])("denies execute_code before code execution: $name", (testCase) => {
    const decision = evaluateAgentCommandPolicy(executeCodePolicyInput(testCase.code));

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: testCase.reasonKind,
      commandClass: testCase.commandClass,
      audit: {
        redacted: true,
        role: "worker",
        phase: "implementation",
        surface: "execute_code",
        commandClass: testCase.commandClass,
        upstreamContactAttempted: false,
      },
    });
    expect(decision.message).toContain(testCase.messageFragment);

    if (testCase.normalizedExecutable) {
      expect(decision.audit.normalizedExecutable).toBe(testCase.normalizedExecutable);
    }
    if (testCase.executableKind) {
      expect(decision.audit.executableKind).toBe(testCase.executableKind);
    }
    if (testCase.gitSubcommand) {
      expect(decision.audit.gitSubcommand).toBe(testCase.gitSubcommand);
    }
    if (testCase.targetHosts) {
      expect(decision.audit.targetHosts).toEqual(testCase.targetHosts);
    }
    if (testCase.unsafeConfigCategories) {
      expect(decision.audit.unsafeConfigCategories).toEqual(testCase.unsafeConfigCategories);
    }
    if (testCase.hasNestedCommand !== undefined) {
      expect(decision.audit.hasNestedCommand).toBe(testCase.hasNestedCommand);
    }
  });

  it("redacts credential values from execute_code audit previews and denial messages", () => {
    const secret = "ghp_1234567890abcdef";
    const decision = evaluateAgentCommandPolicy(
      executeCodePolicyInput(`import os
token = "${secret}"
os.environ["GITHUB_TOKEN"]`),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_environment",
      commandClass: "execute_code_credential_backed_path",
    });
    expect(decision.audit.commandPreview).toContain("[redacted-github-token]");
    expect(JSON.stringify(decision.audit)).not.toContain(secret);
    expect(decision.message).not.toContain(secret);
  });

  it.each(["worker", "reviewer"])("applies execute_code denial to the %s role", (role) => {
    const decision = evaluateAgentCommandPolicy(
      executeCodePolicyInput(`import subprocess
subprocess.run(["gh", "pr", "create", "--fill"])`, {
        role,
        phase: role === "reviewer" ? "review" : "implementation",
      }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "execute_code_subprocess_github_cli",
      audit: {
        role,
        surface: "execute_code",
        upstreamContactAttempted: false,
      },
    });
  });

  it("does not apply the worker/reviewer execute_code boundary to service-owned roles", () => {
    const decision = evaluateAgentCommandPolicy(
      executeCodePolicyInput(`import subprocess
subprocess.run(["gh", "pr", "create", "--fill"])`, { role: "service" }),
    );

    expect(decision).toMatchObject({
      outcome: "allow",
      reasonKind: "role_not_restricted",
      commandClass: "role_not_restricted",
      audit: {
        role: "service",
        surface: "execute_code",
        upstreamContactAttempted: false,
      },
    });
  });
});
