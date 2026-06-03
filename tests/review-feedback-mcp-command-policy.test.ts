import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { evaluateAgentCommandPolicy } from "../src/core/harness/AgentCommandPolicy.js";
import { buildMcpSubprocessEnvironment } from "../src/core/harness/McpSubprocessEnvironment.js";
import {
  submitReviewFeedbackFromMcp,
  writeReviewFeedbackMcpContext,
} from "../src/core/harness/ReviewFeedbackMcpServer.js";
import { FileIssueLifecycleStore, type IssueCompletionReportRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import { issue } from "./helpers.js";

let root: string;

describe("review-feedback MCP command-policy boundary", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-review-feedback-command-policy-"));
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it("slices review-feedback MCP to reviewer feedback credentials and no adjacent GitHub capabilities", () => {
    const rawConfig = reviewFeedbackBoundaryConfig();
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", reviewFeedbackBoundarySourceEnv());

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-feedback-mcp",
      parentEnv: {
        PATH: "/bin",
        ...reviewFeedbackBoundarySourceEnv(),
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
      GITHUB_FEEDBACK_TOKEN: "feedback-secret",
    });
    expect(githubEnvKeys(env)).toEqual([
      "GITHUB_API_BASE_URL",
      "GITHUB_FEEDBACK_TOKEN",
      "GITHUB_HEAD_OWNER",
      "GITHUB_OWNER",
      "GITHUB_REPO",
    ]);
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_PUBLICATION_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_MERGE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_REVIEW_EVIDENCE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_DISCOVERY_TOKEN");
    expect(env).not.toHaveProperty("LINEAR_WRITEBACK_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.github).toMatchObject({ owner: "acme", repo: "symphony", token: null });
    expect(childConfig.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")).toMatchObject({
      source: "profile",
      value: "feedback-secret",
    });
    expect(() => childConfig.credentialProfiles.resolveForRole("service", "github.publication")).toThrow(
      /GITHUB_PUBLICATION_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("service", "github.merge")).toThrow(
      /GITHUB_MERGE_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("reviewer", "github.review_evidence_read")).toThrow(
      /GITHUB_REVIEW_EVIDENCE_TOKEN/,
    );
    expect(() => childConfig.credentialProfiles.resolveForRole("worker", "github.discovery")).toThrow(
      /GITHUB_DISCOVERY_TOKEN/,
    );
  });

  it("allows MCP review feedback writes with scoped reviewer credentials while direct reviewer GitHub commands are denied", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-feedback-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await seedLifecycle(lifecycleStore);
    await writeReviewFeedbackMcpContext(contextFile, {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      activeRunId: "review-run-1",
      role: "reviewer",
      token: null,
      expectedToken: null,
      reviewer: "reviewer-agent:review-run-1",
      phase: "review",
    });
    vi.stubEnv("LINEAR_API_KEY", "linear-secret");
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "feedback-secret");
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      return new Response(
        JSON.stringify({
          id: 9001,
          html_url: "https://github.com/acme/symphony/pull/42#pullrequestreview-9001",
          comments: [{ html_url: "https://github.com/acme/symphony/pull/42#discussion_r9002" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await submitReviewFeedbackFromMcp(
      {
        kind: "review",
        event: "REQUEST_CHANGES",
        body: "Please address the lifecycle-bound PR feedback.",
        comments: [{ path: "src/index.ts", body: "Inline note.", line: 5, side: "RIGHT" }],
        idempotencyKey: "feedback-boundary-1",
      },
      { workflowPath, contextFile },
    );

    expect(authorizations).toEqual(["Bearer feedback-secret"]);
    expect(JSON.stringify(result)).not.toContain("feedback-secret");
    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      feedbackId: "review-feedback:issue-1:review-run-1:feedback-boundary-1",
      pullRequest: { number: 42, url: "https://github.com/acme/symphony/pull/42", headSha: "abc123" },
      reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-9001",
      commentUrls: ["https://github.com/acme/symphony/pull/42#discussion_r9002"],
    });

    const reviewerDecision = evaluateAgentCommandPolicy({
      role: "reviewer",
      phase: "review",
      surface: "terminal_execute",
      workingDirectory: "/repo",
      rawInput: { kind: "command", command: "gh pr review 42 --request-changes --body 'Please fix this'" },
      environment: { keysOnly: ["GITHUB_FEEDBACK_TOKEN"] },
    });
    expect(reviewerDecision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "github_cli",
    });
    expect(reviewerDecision.message).toContain("Symphony service-owned workflow actions");
  });
});

function reviewFeedbackBoundaryConfig() {
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

function reviewFeedbackBoundarySourceEnv(): NodeJS.ProcessEnv {
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

async function seedLifecycle(lifecycleStore: FileIssueLifecycleStore): Promise<void> {
  const report = completionReportRecord();
  await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
    phase: "review",
    lastCompletionReportId: report.id,
    completionReports: [report],
    summaryPointers: { lastRunId: "review-run-1" },
  });
}

function completionReportRecord(): IssueCompletionReportRecord {
  return {
    id: "completion-report-1",
    idempotencyKey: "report-1",
    runId: "worker-run-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    summary: "Implemented the requested change.",
    validationEvidence: ["npm test"],
    acceptanceChecklist: [{ text: "Review feedback is possible.", satisfied: true, evidence: "Tests passed." }],
    changedFiles: ["src/index.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: "symphony/TEST-1",
    },
    risks: [],
    acceptedAt: "2026-01-01T00:00:00Z",
    writebackOperationKeys: [],
  };
}

function workflow(stateDir: string): string {
  return `---
tracker:
  kind: linear
  api_key: "$LINEAR_API_KEY"
  project_slug: TEST
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - In Review
github:
  owner: acme
  repo: symphony
  api_base_url: https://api.github.test
  publish_pull_requests: true
  pr_handoff:
    enabled: false
credential_profiles:
  profiles:
    feedback:
      value: "$GITHUB_FEEDBACK_TOKEN"
      capabilities:
        - github.review_feedback_write
  roles:
    reviewer:
      github.review_feedback_write: feedback
review_loop:
  review_states:
    - In Review
  review_pass_state: Ready to Merge
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
---
Work on {{ issue.identifier }}.
`;
}

function githubEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((key) => key.includes("GITHUB"))
    .sort();
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}
