import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CompletionReportPullRequestPublication,
  CompletionReportPullRequestPublicationInput,
  CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";
import {
  submitCompletionReportFromMcp,
  writeCompletionReportMcpContext,
} from "../src/core/harness/CompletionReportMcpServer.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue } from "./helpers.js";

describe("completion report MCP handoff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-completion-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("submits a worker completion report through CompletionReportService before review writeback", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-1",
      sessionId: "agent-1:run-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      activeRunId: "run-1",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-1",
      workspacePath: "/tmp/workspace",
      workspace: {
        path: "/tmp/workspace",
        workspaceKey: "TEST-1",
        createdNow: false,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });

    const result = await submitCompletionReportFromMcp(report(), {
      workflowPath,
      contextFile,
      pullRequestPublisher: publisher,
    });

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "completion-report:issue-1:idem-1",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "abc123",
        branch: "symphony/TEST-1",
      },
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    const outbox = await new FileWritebackOutboxStore(stateDir).list();
    const comment = outbox.find((operation) => operation.kind === "comment");
    const transition = outbox.find((operation) => operation.kind === "transition");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(
      "https://github.com/acme/symphony/pull/42",
    );
    expect(transition).toMatchObject({
      kind: "transition",
      payload: { toState: "In Review" },
    });
    await expect(new FileIssueLifecycleStore(stateDir).get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
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
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
github:
  owner: acme
  repo: symphony
  token: github-token
  publish_pull_requests: true
---
Work on {{ issue.identifier }}.
`;
}

function report() {
  return {
    runId: "run-1",
    issueId: "issue-1",
    summary: "Implemented the service contract.",
    validationEvidence: ["npm test"],
    acceptanceChecklist: [
      {
        text: "Completion reports are persisted.",
        satisfied: true,
        evidence: "Lifecycle store records completionReports.",
      },
    ],
    changedFiles: ["src/core/CompletionReportService.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: null,
    risks: [],
    idempotencyKey: "idem-1",
  };
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

class FakePublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(private readonly publication: CompletionReportPullRequestPublication) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    return this.publication;
  }
}
