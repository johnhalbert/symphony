import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIssueLifecycleStore, type IssueCompletionReportRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import {
  formatWorkerReviewEvidencePrompt,
  PullRequestReviewEvidenceService,
  type RemotePullRequestReviewEvidence,
} from "../src/core/review/PullRequestReviewEvidenceService.js";
import { issue } from "./helpers.js";

describe("PullRequestReviewEvidenceService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-review-evidence-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ingests and dedupes PR review evidence while retaining fail verdict across repeat prompts", async () => {
    const candidate = issue({ branchName: "symphony/TEST-1" });
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReport(candidate.id, candidate.identifier, 42)],
    });
    const client = new FakeReviewEvidenceClient({
      42: [
        remoteEvidence({
          source: "review",
          githubId: "review-1",
          state: "CHANGES_REQUESTED",
          body: "Requested changes summary.",
          updatedAt: "2026-01-01T00:00:01Z",
        }),
        remoteEvidence({
          githubId: "comment-1",
          body: "Add a regression test here.",
          path: "src/core/orchestrator/Orchestrator.ts",
          line: 588,
          originalLine: 580,
          threadId: "thread-1",
          isResolved: false,
          updatedAt: "2026-01-01T00:00:02Z",
        }),
        remoteEvidence({
          githubId: "comment-resolved",
          body: "Already fixed.",
          isResolved: true,
          updatedAt: "2026-01-01T00:00:03Z",
        }),
        remoteEvidence({
          githubId: "comment-outdated",
          body: "Old diff hunk.",
          isOutdated: true,
          updatedAt: "2026-01-01T00:00:04Z",
        }),
      ],
    });
    const service = new PullRequestReviewEvidenceService({
      lifecycleStore: store,
      client,
      fullHistoryThreshold: 1,
    });

    const firstContext = await service.prepareWorkerPromptContext(candidate);
    const firstPrompt = firstContext ? formatWorkerReviewEvidencePrompt(firstContext) : "";
    const secondContext = await service.prepareWorkerPromptContext(candidate);

    expect(client.calls).toEqual([42, 42]);
    expect(firstContext?.verdict).toBe("fail");
    expect(firstPrompt).toContain("Pull request: #42 https://github.com/acme/symphony/pull/42");
    expect(firstPrompt).toContain("src/core/orchestrator/Orchestrator.ts:588");
    expect(firstPrompt).toContain("thread: thread-1");
    expect(firstPrompt).toContain("Add a regression test here.");
    expect(firstPrompt).toContain("Reviewer verdict: fail / requested changes");
    expect(firstPrompt).toContain("Criterion still missing");
    expect(firstPrompt).not.toContain("Already fixed.");
    expect(firstPrompt).not.toContain("Old diff hunk.");
    expect(secondContext?.verdict).toBe("fail");
    expect(secondContext?.evidence.map((item) => item.githubId)).toEqual(["comment-1"]);
    expect(secondContext ? formatWorkerReviewEvidencePrompt(secondContext) : "").toContain(
      "Reviewer verdict: fail / requested changes",
    );
    await expect(store.get(candidate.identifier)).resolves.toMatchObject({
      reviewEvidence: {
        lastIngestedCursor: "2026-01-01T00:00:04Z",
        lastWorkerEvidenceCursor: "2026-01-01T00:00:02Z",
        items: [
          { githubId: "review-1" },
          { githubId: "comment-1" },
          { githubId: "comment-resolved" },
          { githubId: "comment-outdated" },
        ],
      },
    });
  });

  it("keeps PR review evidence isolated by issue lifecycle record", async () => {
    const first = issue({ id: "issue-1", identifier: "TEST-1" });
    const second = issue({ id: "issue-2", identifier: "TEST-2" });
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(first, {
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReport(first.id, first.identifier, 42)],
    });
    await store.ensureIssue(second, {
      lastCompletionReportId: "completion-report:issue-2:idem-1",
      completionReports: [completionReport(second.id, second.identifier, 99)],
    });
    const service = new PullRequestReviewEvidenceService({
      lifecycleStore: store,
      client: new FakeReviewEvidenceClient({
        42: [remoteEvidence({ githubId: "first-comment", body: "First issue feedback.", pullRequestNumber: 42 })],
        99: [remoteEvidence({ githubId: "second-comment", body: "Second issue feedback.", pullRequestNumber: 99 })],
      }),
      fullHistoryThreshold: 5,
    });

    const firstContext = await service.prepareWorkerPromptContext(first);
    const secondContext = await service.prepareWorkerPromptContext(second);

    expect(firstContext?.evidence.map((item) => item.body)).toEqual(["First issue feedback."]);
    expect(secondContext?.evidence.map((item) => item.body)).toEqual(["Second issue feedback."]);
    await expect(store.get(first.identifier)).resolves.toMatchObject({
      reviewEvidence: { items: [{ pullRequestNumber: 42, githubId: "first-comment" }] },
    });
    await expect(store.get(second.identifier)).resolves.toMatchObject({
      reviewEvidence: { items: [{ pullRequestNumber: 99, githubId: "second-comment" }] },
    });
  });
});

function completionReport(issueId: string, issueIdentifier: string, pullRequestNumber: number): IssueCompletionReportRecord {
  return {
    id: `completion-report:${issueId}:idem-1`,
    idempotencyKey: "idem-1",
    runId: `worker-run-${issueIdentifier}`,
    issueId,
    issueIdentifier,
    summary: "Implemented the issue.",
    validationEvidence: ["npm test"],
    acceptanceChecklist: [
      { text: "Criterion satisfied", satisfied: true, evidence: "test" },
      { text: "Criterion still missing", satisfied: false, evidence: "reviewer requested more coverage" },
    ],
    changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
    branchName: `symphony/${issueIdentifier}`,
    pullRequest: {
      url: `https://github.com/acme/symphony/pull/${pullRequestNumber}`,
      number: pullRequestNumber,
      headSha: "abc123",
      branch: `symphony/${issueIdentifier}`,
    },
    risks: [],
    acceptedAt: "2026-01-01T00:00:00Z",
    writebackOperationKeys: [],
  };
}

function remoteEvidence(
  overrides: Partial<RemotePullRequestReviewEvidence> = {},
): RemotePullRequestReviewEvidence {
  const pullRequestNumber = overrides.pullRequestNumber ?? 42;
  return {
    source: "review_comment",
    githubId: "comment-1",
    pullRequestNumber,
    pullRequestUrl: `https://api.github.test/repos/acme/symphony/pulls/${pullRequestNumber}`,
    url: `https://github.com/acme/symphony/pull/${pullRequestNumber}#discussion_r1`,
    reviewer: "reviewer-a",
    body: "Review feedback.",
    state: null,
    path: null,
    line: null,
    originalLine: null,
    side: null,
    threadId: null,
    inReplyToId: null,
    isResolved: null,
    isOutdated: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    submittedAt: null,
    ...overrides,
  };
}

class FakeReviewEvidenceClient {
  readonly calls: number[] = [];

  constructor(private readonly evidenceByPr: Record<number, RemotePullRequestReviewEvidence[]>) {}

  async listPullRequestReviewEvidence(input: { pullRequestNumber: number }): Promise<RemotePullRequestReviewEvidence[]> {
    this.calls.push(input.pullRequestNumber);
    return this.evidenceByPr[input.pullRequestNumber] ?? [];
  }
}
