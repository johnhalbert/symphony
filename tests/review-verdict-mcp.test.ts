import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  submitReviewVerdictFromMcp,
  writeReviewVerdictMcpContext,
} from "../src/core/harness/ReviewVerdictMcpServer.js";
import {
  FileIssueLifecycleStore,
  type IssueCompletionReportRecord,
  type IssueReviewFeedbackRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { SqliteWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue } from "./helpers.js";

describe("review verdict MCP handoff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-review-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("submits a reviewer fail verdict through ReviewVerdictService", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      phase: "review",
      reviewRound: 0,
      summaryPointers: { lastRunId: "review-run-1" },
    });
    await writeReviewVerdictMcpContext(contextFile, {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      activeRunId: "review-run-1",
      role: "reviewer",
      token: null,
      expectedToken: null,
      reviewer: "reviewer-agent:review-run-1",
      phase: "review",
    });

    const result = await submitReviewVerdictFromMcp(
      {
        finalDisposition:
          "Review failed because the contract-required reviewer MCP path was missing.\n\nThe worker should add that bounded path and rerun the focused validation.",
        verdict: "fail",
        acceptanceResults: [
          {
            text: "Reviewer verdict submissions are wired through MCP.",
            satisfied: false,
            evidence: "No live reviewer MCP path was present.",
          },
        ],
        findings: ["Add the reviewer MCP submission path."],
        evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
        idempotencyKey: "review-verdict-1",
      },
      { workflowPath, contextFile },
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      verdictId: "review-verdict:issue-1:review-run-1:review-verdict-1",
      verdict: "fail",
      finalDisposition: expect.stringContaining("Review failed because"),
      handoffStatus: "pending",
      writebackOperationKeys: [],
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      reviewRound: 0,
      lastReviewVerdictId: null,
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "review-run-1:review-verdict-1",
          runId: "review-run-1",
          verdict: "fail",
          reviewer: "reviewer-agent:review-run-1",
          status: "pending",
        },
      ],
    });
    expect(await listWritebacks(stateDir)).toHaveLength(0);
  });

  it("submits a reviewer pass verdict through ReviewVerdictService", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const report = completionReportRecord();
    await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      reviewFeedback: [approvalFeedback({ runId: "review-run-2" })],
      summaryPointers: { lastRunId: "review-run-2" },
    });
    await writeReviewVerdictMcpContext(contextFile, {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      activeRunId: "review-run-2",
      role: "reviewer",
      reviewer: "reviewer-agent:review-run-2",
      phase: "review",
    });

    const result = await submitReviewVerdictFromMcp(
      {
        finalDisposition:
          "Review passed for the exact lifecycle-bound pull request head.\n\nAll acceptance criteria are satisfied and the approval evidence is attached.",
        verdict: "pass",
        acceptanceResults: [
          {
            text: "All acceptance criteria are satisfied.",
            satisfied: true,
            evidence: "Reviewed the PR.",
          },
        ],
        findings: [],
        evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-2"],
        idempotencyKey: "review-verdict-pass-1",
      },
      { workflowPath, contextFile },
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      verdictId: "review-verdict:issue-1:review-run-2:review-verdict-pass-1",
      verdict: "pass",
      finalDisposition: expect.stringContaining("Review passed for the exact"),
      handoffStatus: "pending",
      writebackOperationKeys: [],
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      lastReviewVerdictId: null,
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "review-run-2:review-verdict-pass-1",
          runId: "review-run-2",
          verdict: "pass",
          reviewer: "reviewer-agent:review-run-2",
          status: "pending",
        },
      ],
    });
    expect(await listWritebacks(stateDir)).toHaveLength(0);
  });

  it("submits a reviewer blocked verdict through ReviewVerdictService", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      phase: "review",
      reviewRound: 1,
      summaryPointers: { lastRunId: "review-run-3" },
    });
    await writeReviewVerdictMcpContext(contextFile, {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      activeRunId: "review-run-3",
      role: "reviewer",
      reviewer: "reviewer-agent:review-run-3",
      phase: "review",
    });

    const result = await submitReviewVerdictFromMcp(
      {
        finalDisposition:
          "Review is blocked because required validation is unavailable on both bounded command surfaces.\n\nThis is a non-worker-owned tooling blocker requiring triage.",
        verdict: "blocked",
        acceptanceResults: [
          {
            text: "Required validation evidence is available.",
            satisfied: false,
            evidence: "Worker/reviewer command policy blocks the required focused validation commands.",
          },
        ],
        findings: ["Required validation is unavailable to worker and reviewer command surfaces."],
        gateFindings: [],
        discoveryFindings: [],
        evidence: ["reviewer observed command-policy denial"],
        idempotencyKey: "review-blocked-1",
      },
      { workflowPath, contextFile },
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      verdictId: "review-verdict:issue-1:review-run-3:review-blocked-1",
      verdict: "blocked",
      finalDisposition: expect.stringContaining("Review is blocked because"),
      handoffStatus: "pending",
      writebackOperationKeys: [],
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      reviewRound: 1,
      lastReviewVerdictId: null,
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "review-run-3:review-blocked-1",
          runId: "review-run-3",
          verdict: "blocked",
          reviewer: "reviewer-agent:review-run-3",
          status: "pending",
        },
      ],
    });
    expect(await listWritebacks(stateDir)).toHaveLength(0);
  });
});

async function listWritebacks(stateDir: string) {
  const store = new SqliteWritebackOutboxStore(stateDir);
  try {
    return await store.list();
  } finally {
    await store.close();
  }
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
writeback:
  enabled: true
  mode: dry_run
  dispatch_state: In Progress
review_loop:
  review_states:
    - In Review
  blocked_states:
    - Blocked
  review_pass_state: Ready to Merge
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
---
Work on {{ issue.identifier }}.
`;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
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
    acceptanceChecklist: [{ text: "Reviewer verdict submissions are wired through MCP.", satisfied: true, evidence: "Tests passed." }],
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

function approvalFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return {
    id: "review-feedback:issue-1:review-run-2:approve-1",
    idempotencyKey: "approve-1",
    requestHash: "request-hash",
    runId: "review-run-2",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    kind: "review",
    event: "APPROVE",
    body: "Looks good.",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: "symphony/TEST-1",
    },
    reviewer: "reviewer-agent:review-run-2",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-2",
    commentUrls: [],
    submittedAt: "2026-01-01T00:00:02.000Z",
    ...overrides,
  };
}
