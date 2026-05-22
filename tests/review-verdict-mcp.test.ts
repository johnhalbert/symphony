import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  submitReviewVerdictFromMcp,
  writeReviewVerdictMcpContext,
} from "../src/core/harness/ReviewVerdictMcpServer.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
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
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-1",
      reviewVerdicts: [
        {
          runId: "review-run-1",
          verdict: "fail",
          reviewer: "reviewer-agent:review-run-1",
        },
      ],
    });
    const outbox = await new FileWritebackOutboxStore(stateDir).list();
    expect(outbox.find((operation) => operation.kind === "comment")).toMatchObject({
      kind: "comment",
      runId: "review-run-1",
    });
    expect(outbox.find((operation) => operation.kind === "transition")).toMatchObject({
      kind: "transition",
      runId: "review-run-1",
      payload: { toState: "In Progress" },
    });
  });

  it("submits a reviewer pass verdict through ReviewVerdictService", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "review-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      phase: "review",
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
