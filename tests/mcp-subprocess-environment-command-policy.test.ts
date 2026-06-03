import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { evaluateAgentCommandPolicy } from "../src/core/harness/AgentCommandPolicy.js";
import { buildMcpSubprocessEnvironment } from "../src/core/harness/McpSubprocessEnvironment.js";

describe("MCP subprocess environment command-policy boundary", () => {
  it("slices completion-report MCP to service publication credentials without exposing adjacent role or service credentials", () => {
    const rawConfig = githubCredentialSliceConfig();
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", githubCredentialSliceSourceEnv());

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: {
        PATH: "/bin",
        ...githubCredentialSliceSourceEnv(),
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
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_DISCOVERY_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_FEEDBACK_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_MERGE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_REVIEW_EVIDENCE_TOKEN");
    expect(env).not.toHaveProperty("LINEAR_WRITEBACK_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_RUNTIME_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");
    expect(githubEnvKeys(env)).toEqual([
      "GITHUB_API_BASE_URL",
      "GITHUB_HEAD_OWNER",
      "GITHUB_OWNER",
      "GITHUB_PUBLICATION_TOKEN",
      "GITHUB_REPO",
    ]);

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.github).toMatchObject({
      owner: "acme",
      repo: "symphony",
      token: null,
      publishPullRequests: true,
    });
    expect(childConfig.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      source: "profile",
      value: "publication-secret",
    });
    expect(() => childConfig.credentialProfiles.resolveForRole("service", "github.merge")).toThrow(
      /GITHUB_MERGE_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")).toThrow(
      /GITHUB_FEEDBACK_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("reviewer", "github.review_evidence_read")).toThrow(
      /GITHUB_REVIEW_EVIDENCE_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("worker", "github.discovery")).toThrow(
      /GITHUB_DISCOVERY_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("service", "linear.writeback")).toThrow(
      /LINEAR_WRITEBACK_TOKEN/,
    );
  });

  it("keeps service-owned command execution outside the worker/reviewer command policy while direct worker attempts are denied", () => {
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

    const workerDecision = evaluateAgentCommandPolicy({
      role: "worker",
      phase: "implementation",
      surface: "terminal_execute",
      workingDirectory: "/repo",
      rawInput: { kind: "command", command: "gh pr create --fill" },
      environment: { keysOnly: [] },
    });
    expect(workerDecision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "github_cli",
    });
    expect(workerDecision.message).toContain("Symphony service-owned workflow actions");
  });

  it.each([
    "merge-conflict-resolution-mcp",
    "issue-breakdown-plan-mcp",
    "review-verdict-mcp",
    "transcript-recall-mcp",
  ] as const)("keeps %s free of GitHub capability credentials and metadata refs", (command) => {
    const config = parseServiceConfig(githubCredentialSliceConfig(), "/repo/WORKFLOW.md", githubCredentialSliceSourceEnv());

    const env = buildMcpSubprocessEnvironment({
      config,
      command,
      parentEnv: {
        PATH: "/bin",
        ...githubCredentialSliceSourceEnv(),
        GITHUB_TOKEN: "ambient-parent-github-secret",
        CURSOR_API_KEY: "ambient-cursor-secret",
      },
    });

    expect(env).toMatchObject({ PATH: "/bin", LINEAR_API_KEY: "linear-secret" });
    expect(githubEnvKeys(env)).toEqual([]);
    expect(env).not.toHaveProperty("LINEAR_WRITEBACK_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_RUNTIME_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");
  });

  it("reports missing assigned review-feedback profile secrets without falling back to legacy GITHUB_TOKEN", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
        credential_profiles: {
          profiles: {
            feedback: { value: "$MISSING_GITHUB_FEEDBACK_TOKEN", capabilities: ["github.review_feedback_write"] },
          },
          roles: {
            reviewer: {
              "github.review_feedback_write": "feedback",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
      },
    );

    expect(() =>
      buildMcpSubprocessEnvironment({
        config,
        command: "review-feedback-mcp",
        parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
      }),
    ).toThrow(/MISSING_GITHUB_FEEDBACK_TOKEN/);
  });

  it("omits empty GitHub credential variables when no publication credential is configured", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret", GH_TOKEN: "decoy-gh-secret" },
    });

    expect(env).toMatchObject({ PATH: "/bin", LINEAR_API_KEY: "linear-secret" });
    expect(githubEnvKeys(env)).toEqual([]);
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
  });
});

function githubCredentialSliceConfig() {
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
        reviewEvidence: { value: "$GITHUB_REVIEW_EVIDENCE_TOKEN", capabilities: ["github.review_evidence_read"] },
        feedback: { value: "$GITHUB_FEEDBACK_TOKEN", capabilities: ["github.review_feedback_write"] },
        merge: { value: "$GITHUB_MERGE_TOKEN", capabilities: ["github.merge"] },
        linearWriteback: { value: "$LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
        cursorRuntime: { value: "$CURSOR_RUNTIME_TOKEN", capabilities: ["runtime.cursor"] },
      },
      roles: {
        worker: {
          "github.discovery": "discovery",
          "linear.writeback": "linearWriteback",
          "runtime.cursor": "cursorRuntime",
        },
        reviewer: {
          "github.review_evidence_read": "reviewEvidence",
          "github.review_feedback_write": "feedback",
          "linear.writeback": "linearWriteback",
          "runtime.cursor": "cursorRuntime",
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

function githubCredentialSliceSourceEnv(): NodeJS.ProcessEnv {
  return {
    LINEAR_API_KEY: "linear-secret",
    GITHUB_OWNER: "acme",
    GITHUB_REPO: "symphony",
    GITHUB_HEAD_OWNER: "john",
    GITHUB_API_BASE_URL: "https://api.github.test",
    GITHUB_DISCOVERY_TOKEN: "discovery-secret",
    GITHUB_PUBLICATION_TOKEN: "publication-secret",
    GITHUB_REVIEW_EVIDENCE_TOKEN: "review-evidence-secret",
    GITHUB_FEEDBACK_TOKEN: "feedback-secret",
    GITHUB_MERGE_TOKEN: "merge-secret",
    LINEAR_WRITEBACK_TOKEN: "linear-writeback-secret",
    CURSOR_RUNTIME_TOKEN: "cursor-runtime-secret",
    GITHUB_TOKEN: "legacy-github-secret",
  };
}

function githubEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((key) => key.includes("GITHUB"))
    .sort();
}
