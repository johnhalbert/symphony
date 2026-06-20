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
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue } from "./helpers.js";

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

const symphonyProjectContext = {
  projectContextId: "symphony",
  projectContextLabel: "Symphony",
  linearProjectSlug: "ENG",
  routingSource: "candidate_poll",
} as const;

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
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "review-run-1" },
    });
    await writeReviewVerdictMcpContext(contextFile, {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "review-run-1",
      role: "reviewer",
      token: null,
      expectedToken: null,
      reviewer: "reviewer-agent:review-run-1",
      phase: "review",
    });

    const result = await submitReviewVerdictFromMcp(
      {
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
      verdictId: "review-verdict:issue-1:review-verdict-1",
      verdict: "fail",
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-1",
      reviewVerdicts: [
        {
          runId: "review-run-1",
          verdict: "fail",
          reviewer: "reviewer-agent:review-run-1",
          projectContext: docsProjectContext,
        },
      ],
    });
    const outbox = await new FileWritebackOutboxStore(stateDir).list();
    expect(outbox.find((operation) => operation.kind === "comment")).toMatchObject({
      kind: "comment",
      runId: "review-run-1",
      projectContext: docsProjectContext,
    });
    expect(outbox.find((operation) => operation.kind === "transition")).toMatchObject({
      kind: "transition",
      runId: "review-run-1",
      projectContext: docsProjectContext,
      payload: { toState: "In Progress" },
    });
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
      verdictId: "review-verdict:issue-1:review-verdict-pass-1",
      verdict: "pass",
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "passed",
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-pass-1",
      reviewVerdicts: [
        {
          runId: "review-run-2",
          verdict: "pass",
          reviewer: "reviewer-agent:review-run-2",
        },
      ],
    });
    expect((await new FileWritebackOutboxStore(stateDir).list()).find((operation) => operation.kind === "transition")).toMatchObject({
      kind: "transition",
      payload: { toState: "Ready to Merge" },
    });
  });

  it("rejects reviewer verdict submissions when the handoff project context mismatches the persisted lifecycle context", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const serviceOwnedIssue = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await lifecycleStore.ensureIssue(serviceOwnedIssue, {
      phase: "review",
      reviewRound: 0,
      projectContext: symphonyProjectContext,
      summaryPointers: { lastRunId: "review-run-3" },
    });
    await writeReviewVerdictMcpContext(contextFile, {
      issue: serviceOwnedIssue,
      projectContext: docsProjectContext,
      activeRunId: "review-run-3",
      role: "reviewer",
      token: null,
      expectedToken: null,
      reviewer: "reviewer-agent:review-run-3",
      phase: "review",
    });

    await expect(
      submitReviewVerdictFromMcp(
        {
          verdict: "fail",
          acceptanceResults: [
            {
              text: "Reviewer verdict submissions are wired through MCP.",
              satisfied: false,
              evidence: "Tampered project context should be rejected.",
            },
          ],
          findings: ["Reject mismatched project context claims before accepting verdicts."],
          evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-3"],
          idempotencyKey: "review-verdict-context-mismatch-1",
        },
        { workflowPath, contextFile },
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Review verdict MCP context does not match the service-owned issue project context",
    });

    const lifecycle = await lifecycleStore.get("TEST-1");
    expect(lifecycle).toMatchObject({
      phase: "review",
      reviewRound: 0,
      projectContext: symphonyProjectContext,
    });
    expect(lifecycle?.reviewVerdicts ?? []).toHaveLength(0);
    expect(await new FileWritebackOutboxStore(stateDir).list()).toHaveLength(0);
  });

  it("accepts reviewer verdict submissions when only same-context metadata drifts and preserves the service-owned context", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const spoofedIssue = {
      ...issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      projectContextId: symphonyProjectContext.projectContextId,
      projectContextLabel: "Spoofed Symphony",
      routingSource: "replay",
    };
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      phase: "review",
      reviewRound: 0,
      projectContext: symphonyProjectContext,
      summaryPointers: { lastRunId: "review-run-4" },
    });
    await writeReviewVerdictMcpContext(contextFile, {
      issue: spoofedIssue,
      projectContext: {
        projectContextId: symphonyProjectContext.projectContextId,
        projectContextLabel: "Spoofed Symphony",
        linearProjectSlug: null,
        routingSource: "replay",
      },
      activeRunId: "review-run-4",
      role: "reviewer",
      token: null,
      expectedToken: null,
      reviewer: "reviewer-agent:review-run-4",
      phase: "review",
    });

    const result = await submitReviewVerdictFromMcp(
      {
        verdict: "fail",
        acceptanceResults: [
          {
            text: "Review verdicts tolerate same-context provenance drift while preserving service-owned context.",
            satisfied: false,
            evidence: "Same projectContextId with drifted metadata should still submit.",
          },
        ],
        findings: ["Preserve the service-owned project context when provenance metadata drifts."],
        evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-4"],
        idempotencyKey: "review-verdict-context-drift-accepted-1",
      },
      { workflowPath, contextFile },
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      verdictId: "review-verdict:issue-1:review-verdict-context-drift-accepted-1",
      verdict: "fail",
    });

    const lifecycle = await lifecycleStore.get("TEST-1");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      reviewRound: 1,
      projectContext: symphonyProjectContext,
      reviewVerdicts: [expect.objectContaining({ projectContext: symphonyProjectContext })],
    });
    expect((await new FileWritebackOutboxStore(stateDir).list()).find((operation) => operation.kind === "transition")).toMatchObject({
      projectContext: symphonyProjectContext,
      payload: { toState: "In Progress" },
    });
  });
});

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
