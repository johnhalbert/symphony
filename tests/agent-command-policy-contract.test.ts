import { describe, expect, it } from "vitest";
import {
  evaluateAgentCommandPolicy,
  extractAgentCommandPolicyEnvironmentKeys,
  extractAgentCommandPolicyExecutableCandidate,
  extractAgentCommandPolicyInlineEnvironmentKeys,
  normalizeAgentCommandPolicyExecutable,
  redactedAgentCommandPolicyPreview,
} from "../src/core/harness/AgentCommandPolicy.js";
import {
  agentCommandPolicyAuditPayload,
  agentCommandPolicyInput,
  allowPolicyDecision,
  denyPolicyDecision,
  executeCodePolicyInput,
  gatewayToolCallPolicyInput,
  policyInputForRoleAndSurface,
  terminalPolicyInput,
} from "./agent-command-policy-fixtures.js";

describe("AgentCommandPolicy foundation contracts", () => {
  it("builds shared fixtures for command, code, tool-call, allow, deny, and audit contracts", () => {
    expect(terminalPolicyInput("git diff --stat")).toMatchObject({
      role: "worker",
      phase: "implementation",
      surface: "terminal",
      rawInput: { kind: "command", command: "git diff --stat" },
    });
    expect(executeCodePolicyInput("import subprocess").rawInput).toEqual({
      kind: "code",
      code: "import subprocess",
      language: "python",
    });
    expect(gatewayToolCallPolicyInput({ command: "git status" })).toMatchObject({
      surface: "gateway_pre_tool_call",
      rawInput: { kind: "tool_call", toolName: "terminal", params: { command: "git status" } },
    });
    expect(policyInputForRoleAndSurface("reviewer", "acp_permission", "review")).toMatchObject({
      role: "reviewer",
      phase: "review",
      surface: "acp_permission",
    });
    expect(allowPolicyDecision()).toMatchObject({
      outcome: "allow",
      reasonKind: "safe_local_inspection",
      commandClass: "safe_local_inspection",
      requiresUserOrServiceFix: false,
    });
    expect(denyPolicyDecision()).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "direct_upstream_git",
      requiresUserOrServiceFix: true,
    });
    expect(agentCommandPolicyAuditPayload()).toMatchObject({
      redacted: true,
      upstreamContactAttempted: false,
      inheritedEnvironmentKeys: ["HOME", "PATH"],
    });
  });

  it("redacts and bounds raw command previews without persisting credential material", () => {
    const accessKeyValue = "aws-visible-access-value";
    const preview = redactedAgentCommandPolicyPreview(
      `GITHUB_TOKEN=ghp_12...wxyz AWS_ACCESS_KEY_ID=${accessKeyValue} Bearer sk-123...cdef git fetch https://github.com/example/repo.git SECRET_AGENT_VALUE ` +
        "x".repeat(200),
      120,
    );

    expect(preview.preview).toContain("[redacted]");
    expect(preview.preview).not.toContain("ghp_12...wxyz");
    expect(preview.preview).not.toContain("sk-123...cdef");
    expect(preview.preview).not.toContain(accessKeyValue);
    expect(preview.preview).not.toContain("SECRET_AGENT_VALUE");
    expect(preview.truncated).toBe(true);
    expect(preview.redacted).toBe(true);
    expect(preview.preview?.length).toBeLessThanOrEqual(120);
  });

  const githubTokenKey = "GITHUB_TOKEN";
  const ghTokenKey = "GH_TOKEN";
  const sensitiveInlineAssignmentCases = [
    {
      label: "unquoted",
      command: `${githubTokenKey}=plain-visible-value gh auth status`,
      credentialValue: "plain-visible-value",
      keys: [githubTokenKey],
    },
    {
      label: "double-quoted",
      command: `${githubTokenKey}="double visible value" gh api user`,
      credentialValue: "double visible value",
      keys: [githubTokenKey],
    },
    {
      label: "single-quoted",
      command: `${ghTokenKey}='single visible value' git ls-remote origin`,
      credentialValue: "single visible value",
      keys: [ghTokenKey],
    },
  ] as const;

  for (const testCase of sensitiveInlineAssignmentCases) {
    it(`redacts ${testCase.label} sensitive inline shell environment assignments`, () => {
      const preview = redactedAgentCommandPolicyPreview(testCase.command);

      expect(preview.preview).toContain("[redacted]");
      expect(preview.preview).not.toContain(testCase.credentialValue);
      expect(preview.redacted).toBe(true);
      expect(extractAgentCommandPolicyInlineEnvironmentKeys({ kind: "command", command: testCase.command })).toEqual(
        testCase.keys,
      );
    });
  }

  it("redacts nested tool-call command previews before serializing audit evidence", () => {
    const visibleValue = "nested visible value";
    const preview = redactedAgentCommandPolicyPreview({
      toolName: "terminal",
      params: {
        command: `${ghTokenKey}='${visibleValue}' git ls-remote origin`,
      },
    });

    expect(preview.preview).toContain("[redacted]");
    expect(preview.preview).not.toContain(visibleValue);
    expect(preview.redacted).toBe(true);
  });

  it("extracts sorted unique environment key names without exposing values", () => {
    const keys = extractAgentCommandPolicyEnvironmentKeys({
      keysOnly: ["PATH", " HOME ", "path", ""],
      inherited: {
        GIT_PAGER: "less --RAW-CONTROL-CHARS",
        HOME: "/home/agent",
        github_token: "ghp_should_not_appear",
        EMPTY_VALUE: undefined,
      },
    });

    expect(keys).toEqual(["EMPTY_VALUE", "GIT_PAGER", "github_token", "HOME", "PATH"]);
    expect(keys).not.toContain("/home/agent");
    expect(keys).not.toContain("ghp_should_not_appear");
  });

  it("normalizes Windows, POSIX, UNC, and bare executables for classification", () => {
    expect(normalizeAgentCommandPolicyExecutable("C:\\Program Files\\Git\\cmd\\GIT.EXE")).toMatchObject({
      raw: "C:\\Program Files\\Git\\cmd\\GIT.EXE",
      basename: "GIT.EXE",
      normalizedExecutable: "git",
      executableKind: "git",
      hadPathEvidence: true,
      pathStyle: "windows",
    });
    expect(normalizeAgentCommandPolicyExecutable("'/usr/local/bin/gh'")).toMatchObject({
      basename: "gh",
      normalizedExecutable: "gh",
      executableKind: "github_cli",
      hadPathEvidence: true,
      pathStyle: "posix",
    });
    expect(normalizeAgentCommandPolicyExecutable("\\\\server\\share\\OpenSSH\\ssh.EXE")).toMatchObject({
      basename: "ssh.EXE",
      normalizedExecutable: "ssh",
      executableKind: "ssh",
      hadPathEvidence: true,
      pathStyle: "unc",
    });
    expect(normalizeAgentCommandPolicyExecutable("curl.exe")).toMatchObject({
      basename: "curl.exe",
      normalizedExecutable: "curl",
      executableKind: "network_client",
      hadPathEvidence: false,
      pathStyle: "bare",
    });
    expect(normalizeAgentCommandPolicyExecutable("npm.CMD")).toMatchObject({
      normalizedExecutable: "npm",
      executableKind: "package_script",
      pathStyle: "bare",
    });
    expect(normalizeAgentCommandPolicyExecutable("bash")).toMatchObject({
      normalizedExecutable: "bash",
      executableKind: "shell",
      pathStyle: "bare",
    });
    expect(normalizeAgentCommandPolicyExecutable("python3")).toMatchObject({
      normalizedExecutable: "python3",
      executableKind: "interpreter",
      pathStyle: "bare",
    });
    expect(normalizeAgentCommandPolicyExecutable("   ")).toMatchObject({
      normalizedExecutable: null,
      executableKind: "unknown",
      pathStyle: "unknown",
    });
  });

  it("extracts inline environment keys and the first executable candidate from shell commands", () => {
    const input = terminalPolicyInput(
      "GIT_PAGER=cat GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz \"C:\\Program Files\\Git\\cmd\\git.exe\" status --short",
    );

    expect(extractAgentCommandPolicyInlineEnvironmentKeys(input.rawInput)).toEqual(["GIT_PAGER", "GITHUB_TOKEN"]);
    expect(extractAgentCommandPolicyExecutableCandidate(input.rawInput)).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(normalizeAgentCommandPolicyExecutable(extractAgentCommandPolicyExecutableCandidate(input.rawInput))).toMatchObject({
      normalizedExecutable: "git",
      executableKind: "git",
      pathStyle: "windows",
    });
  });

  it("fails closed in the initial evaluator while emitting redacted audit evidence", () => {
    const visibleAuditValue = "audit visible value";
    const inheritedVisibleValue = "inherited visible value";
    const decision = evaluateAgentCommandPolicy(
      agentCommandPolicyInput({
        rawInput: {
          kind: "command",
          command: `${githubTokenKey}="${visibleAuditValue}" /usr/bin/git fetch origin main`,
        },
        environment: {
          inherited: {
            PATH: "/usr/bin",
            [githubTokenKey]: inheritedVisibleValue,
          },
        },
      }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reasonKind).toBe("unknown_command");
    expect(decision.commandClass).toBe("unknown_or_malformed");
    expect(decision.normalizedCommand).toMatchObject({
      executable: "git",
      executableKind: "git",
      hasInlineEnvironment: true,
    });
    expect(decision.audit).toMatchObject({
      redacted: true,
      outcome: "deny",
      reasonKind: "unknown_command",
      normalizedExecutable: "git",
      inheritedEnvironmentKeys: ["GITHUB_TOKEN", "PATH"],
      inlineEnvironmentKeys: ["GITHUB_TOKEN"],
      rawInputPreviewRedacted: true,
      upstreamContactAttempted: false,
    });
    expect(decision.audit.rawInputPreview).toContain("[redacted]");
    expect(decision.audit.rawInputPreview).not.toContain(visibleAuditValue);
    expect(decision.audit.rawInputPreview).not.toContain(inheritedVisibleValue);
    expect(decision.message).toContain("Symphony service-owned GitHub workflow");
  });
});
