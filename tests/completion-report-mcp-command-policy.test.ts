import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { evaluateAgentCommandPolicy } from "../src/core/harness/AgentCommandPolicy.js";
import { buildMcpSubprocessEnvironment } from "../src/core/harness/McpSubprocessEnvironment.js";

describe("completion-report MCP command-policy publication boundary", () => {
  it("slices completion-report MCP to service publication credentials and no adjacent GitHub capabilities", () => {
    const rawConfig = publicationBoundaryConfig();
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", publicationBoundarySourceEnv());

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: {
        PATH: "/bin",
        ...publicationBoundarySourceEnv(),
        GITHUB_TOKEN: "ambient-parent-github-secret",
        GH_TOKEN: "ambient-gh-secret",
        CURSOR_API_KEY: "ambient-cursor-secret",
      },
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
    });
    expect(githubEnvKeys(env)).toEqual([
      "GITHUB_API_BASE_URL",
      "GITHUB_HEAD_OWNER",
      "GITHUB_OWNER",
      "GITHUB_PUBLICATION_TOKEN",
      "GITHUB_REPO",
    ]);
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_FEEDBACK_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_MERGE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_REVIEW_EVIDENCE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_DISCOVERY_TOKEN");
    expect(env).not.toHaveProperty("LINEAR_WRITEBACK_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.github).toMatchObject({ owner: "acme", repo: "symphony", token: null });
    expect(childConfig.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      source: "profile",
      value: "publication-secret",
    });
    expect(() => childConfig.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")).toThrow(
      /GITHUB_FEEDBACK_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("service", "github.merge")).toThrow(
      /GITHUB_MERGE_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("worker", "github.discovery")).toThrow(
      /GITHUB_DISCOVERY_TOKEN/,
    );
  });

  it("keeps publication credentials out of completion-report MCP while operator approval is pending", () => {
    const rawConfig = {
      ...publicationBoundaryConfig(),
      github: {
        ...publicationBoundaryConfig().github,
        operator_approval: { required_for_publication: true },
      },
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", publicationBoundarySourceEnv());

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", ...publicationBoundarySourceEnv(), GITHUB_TOKEN: "ambient-secret" },
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
    });
    expect(githubEnvKeys(env)).toEqual(["GITHUB_API_BASE_URL", "GITHUB_HEAD_OWNER", "GITHUB_OWNER", "GITHUB_REPO"]);
    expect(env).not.toHaveProperty("GITHUB_PUBLICATION_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("allows service-owned publication execution while equivalent worker terminal and code attempts are denied", () => {
    const serviceDecision = evaluateAgentCommandPolicy({
      role: "service",
      phase: "mcp-subprocess",
      surface: "terminal_execute",
      workingDirectory: "/repo",
      rawInput: { kind: "command", command: "gh pr create --fill" },
      environment: { keysOnly: ["GITHUB_PUBLICATION_TOKEN"] },
    });
    expect(serviceDecision).toMatchObject({
      outcome: "allow",
      reasonKind: "role_not_restricted",
      commandClass: "role_not_restricted",
    });

    const workerTerminalDecision = evaluateAgentCommandPolicy({
      role: "worker",
      phase: "implementation",
      surface: "terminal_execute",
      workingDirectory: "/repo",
      rawInput: { kind: "command", command: "gh pr create --fill" },
      environment: { keysOnly: [] },
    });
    expect(workerTerminalDecision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "github_cli",
    });
    expect(workerTerminalDecision.message).toContain("Symphony service-owned workflow actions");

    const workerCodeDecision = evaluateAgentCommandPolicy({
      role: "worker",
      phase: "implementation",
      surface: "execute_code",
      workingDirectory: "/repo",
      rawInput: { kind: "code", code: 'import subprocess\nsubprocess.run(["gh", "pr", "create", "--fill"])' },
      environment: { keysOnly: [] },
    });
    expect(workerCodeDecision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "execute_code_subprocess_github_cli",
    });
    expect(workerCodeDecision.message).toContain("Symphony service-owned workflow actions");
  });
});

function publicationBoundaryConfig() {
  return {
    tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
    github: {
      owner: "$GITHUB_OWNER",
      repo: "$GITHUB_REPO",
      head_owner: "$GITHUB_HEAD_OWNER",
      api_base_url: "$GITHUB_API_BASE_URL",
      publish_pull_requests: true,
      pr_handoff: { enabled: false },
    },
    credential_profiles: {
      profiles: {
        discovery: { value: "$GITHUB_DISCOVERY_TOKEN", capabilities: ["github.discovery"] },
        publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
        feedback: { value: "$GITHUB_FEEDBACK_TOKEN", capabilities: ["github.review_feedback_write"] },
        reviewEvidence: { value: "$GITHUB_REVIEW_EVIDENCE_TOKEN", capabilities: ["github.review_evidence_read"] },
        merge: { value: "$GITHUB_MERGE_TOKEN", capabilities: ["github.merge"] },
        linearWriteback: { value: "$LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
      },
      roles: {
        worker: {
          "github.discovery": "discovery",
          "linear.writeback": "linearWriteback",
        },
        reviewer: {
          "github.review_feedback_write": "feedback",
          "github.review_evidence_read": "reviewEvidence",
        },
        service: {
          "github.publication": "publication",
          "github.merge": "merge",
          "linear.writeback": "linearWriteback",
        },
      },
    },
  } as const;
}

function publicationBoundarySourceEnv(): NodeJS.ProcessEnv {
  return {
    LINEAR_API_KEY: "linear-secret",
    GITHUB_OWNER: "acme",
    GITHUB_REPO: "symphony",
    GITHUB_HEAD_OWNER: "john",
    GITHUB_API_BASE_URL: "https://api.github.test",
    GITHUB_DISCOVERY_TOKEN: "discovery-secret",
    GITHUB_PUBLICATION_TOKEN: "publication-secret",
    GITHUB_FEEDBACK_TOKEN: "feedback-secret",
    GITHUB_REVIEW_EVIDENCE_TOKEN: "review-evidence-secret",
    GITHUB_MERGE_TOKEN: "merge-secret",
    LINEAR_WRITEBACK_TOKEN: "linear-writeback-secret",
    GITHUB_TOKEN: "legacy-github-secret",
  };
}

function githubEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((key) => key.includes("GITHUB"))
    .sort();
}
