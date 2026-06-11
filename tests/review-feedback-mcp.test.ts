import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REVIEW_FEEDBACK_TOOL_NAME,
  runReviewFeedbackMcpServer,
  submitReviewFeedbackFromMcp,
  writeReviewFeedbackMcpContext,
} from "../src/core/harness/ReviewFeedbackMcpServer.js";
import { FileIssueLifecycleStore, type IssueCompletionReportRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import { issue } from "./helpers.js";

let root: string;

describe("review feedback MCP handoff", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-review-feedback-mcp-"));
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
    await rm(root, { recursive: true, force: true });
  });

  it("lists the reviewer PR feedback tool schema", async () => {
    const output = await listToolsViaServer();

    expect(output).toContain(REVIEW_FEEDBACK_TOOL_NAME);
    expect(output).toContain("APPROVE");
    expect(output).toContain("REQUEST_CHANGES");
    expect(output).not.toContain('"COMMENT"');
    expect(output).toContain("idempotencyKey");
  });

  it("submits PR review feedback and returns durable structured URLs without exposing tokens", async () => {
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
        event: "APPROVE",
        body: "Reviewer feedback from MCP.",
        comments: [{ path: "src/index.ts", body: "Inline note.", line: 5, side: "RIGHT" }],
        idempotencyKey: "feedback-1",
      },
      { workflowPath, contextFile },
    );

    expect(authorizations).toEqual(["Bearer github-secret"]);
    expect(JSON.stringify(result)).not.toContain("github-secret");
    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      feedbackId: "review-feedback:issue-1:review-run-1:feedback-1",
      pullRequest: { number: 42, url: "https://github.com/acme/symphony/pull/42", headSha: "abc123" },
      reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-9001",
      commentUrls: ["https://github.com/acme/symphony/pull/42#discussion_r9002"],
      urls: [
        "https://github.com/acme/symphony/pull/42#pullrequestreview-9001",
        "https://github.com/acme/symphony/pull/42#discussion_r9002",
      ],
    });
  });

  it("rejects review feedback when the MCP context issue identifier does not match the lifecycle record", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-feedback-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await seedLifecycle(lifecycleStore);
    await writeReviewFeedbackMcpContext(contextFile, {
      issue: issue({ identifier: "TEST-2", state: "In Review", branchName: "symphony/TEST-1" }),
      activeRunId: "review-run-1",
      role: "reviewer",
      phase: "review",
    });
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ message: "expected test failure if called" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      submitReviewFeedbackFromMcp(
        { kind: "review", event: "APPROVE", body: "Looks good.", idempotencyKey: "approve-mismatch-1" },
        { workflowPath, contextFile },
      ),
    ).rejects.toMatchObject({
      code: "tracker_error",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sanitizes GitHub token material from write errors", async () => {
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
      phase: "review",
    });
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ message: "Cannot approve with github-secret" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      await submitReviewFeedbackFromMcp(
        { kind: "review", event: "APPROVE", body: "Looks good.", idempotencyKey: "approve-1" },
        { workflowPath, contextFile },
      );
      throw new Error("expected failure");
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain("[redacted]");
      expect(message).not.toContain("github-secret");
    }
  });
});

async function listToolsViaServer(): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const server = runReviewFeedbackMcpServer({
    workflowPath: path.join(root, "WORKFLOW.md"),
    contextFile: path.join(root, "missing-context.json"),
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  input.end(
    [
      jsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "symphony-test-client", version: "0.1.0" },
        },
      }),
      jsonRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      jsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join(""),
  );
  await server;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const outputText = Buffer.concat(chunks).toString("utf8");
    if (outputText.includes(REVIEW_FEEDBACK_TOOL_NAME)) return outputText;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Buffer.concat(chunks).toString("utf8");
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
    acceptanceChecklist: [{ text: "Feedback is possible.", satisfied: true, evidence: "Tests passed." }],
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
  api_key: linear-test-key
  project_slug: TEST
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - In Review
github:
  owner: acme
  repo: symphony
  token: github-secret
  api_base_url: https://api.github.test
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

function jsonRpcMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}
