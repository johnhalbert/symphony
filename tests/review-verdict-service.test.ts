import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import {
  FileIssueLifecycleStore,
  type IssueLifecycleRecord,
  type IssueMergeGateState,
  type IssueReviewFeedbackRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import {
  formatWorkerMergeGatePromptResult,
  ReviewVerdictService,
  type ReviewVerdictActiveContext,
  type ReviewVerdictInput,
} from "../src/core/ReviewVerdictService.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";

describe("ReviewVerdictService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-review-verdict-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a fail verdict, records requested revisions, and routes the issue back to implementation", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 0,
    });

    const result = await service.submit_review_verdict(failVerdict(), context());

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(2);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "implementation",
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
      reviewVerdicts: [
        {
          id: "review-verdict:issue-1:verdict-1",
          idempotencyKey: "verdict-1",
          runId: "review-run-1",
          verdict: "fail",
          findings: ["Add a regression test for duplicate verdict handling."],
          evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
        },
      ],
    });

    const operations = await outbox.list();
    const comment = operations.find((operation) => operation.kind === "comment");
    const transition = operations.find((operation) => operation.kind === "transition");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("## Symphony Review Verdict: Fail");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(
      "Add a regression test for duplicate verdict handling.",
    );
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("[ ] Duplicate verdicts are idempotent");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(
      "https://github.com/acme/symphony/pull/42#discussion_r1",
    );
    expect(transition).toMatchObject({
      idempotencyKey: "transition:issue-1:review-run-1:review-verdict-fail:In Progress",
      kind: "transition",
      payload: {
        fromStates: ["In Review"],
        toState: "In Progress",
      },
    });
  });

  it("stores structured gate and discovery findings while deriving legacy findings from gate summaries", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 0,
    });

    await service.submitReviewVerdict(
      failVerdict({
        idempotencyKey: "verdict-structured-1",
        findings: ["Legacy summary that should not drive storage."],
        gateFindings: [
          gateFinding({
            summary: "Preserve explicit project context when resolving workspace fallbacks.",
            requirementIds: ["REQ-1"],
            contractAnchor: "Issue Contract > Requirements > REQ-1",
          }),
        ],
        discoveryFindings: [
          discoveryFinding({
            summary: "The sibling docs workspace fallback matrix may need its own follow-up.",
            relationship: "adjacent_sibling",
            suggestedDisposition: "followup_issue",
          }),
        ],
      }),
      context(),
    );

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewVerdicts: [
        {
          idempotencyKey: "verdict-structured-1",
          findings: ["Preserve explicit project context when resolving workspace fallbacks."],
          gateFindings: [
            {
              summary: "Preserve explicit project context when resolving workspace fallbacks.",
              requirementIds: ["REQ-1"],
              contractAnchor: "Issue Contract > Requirements > REQ-1",
            },
          ],
          discoveryFindings: [
            {
              summary: "The sibling docs workspace fallback matrix may need its own follow-up.",
              relationship: "adjacent_sibling",
              suggestedDisposition: "followup_issue",
            },
          ],
        },
      ],
    });
  });

  it("increments review rounds on each accepted fail verdict", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      summaryPointers: { lastRunId: "review-run-1" },
    });

    await service.submitReviewVerdict(failVerdict(), context());

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewRound: 2,
    });
  });

  it("accepts a manual fail verdict with the issue state gate explicitly ignored", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "Todo" }), {
      phase: "review",
      reviewRound: 0,
    });

    const result = await service.submitReviewVerdict(
      failVerdict(),
      context({
        issue: issue({ state: "Todo", branchName: "symphony/TEST-1" }),
        ignoreStateGate: true,
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(0);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "implementation",
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
    });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("rejects a pass verdict when the active reviewer run has not approved the lifecycle-bound PR", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
    });

    await expect(service.submitReviewVerdict(passVerdict(), context())).rejects.toMatchObject({
      code: "invalid_request",
      message:
        'Pass review verdict requires prior submit_pull_request_review_feedback with kind="review" and event="APPROVE" for the active reviewer run and lifecycle-bound PR.',
    });
  });

  it("rejects a pass verdict when feedback is non-approval or from a different run", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      reviewFeedback: [
        requestChangesFeedback(),
        issueCommentFeedback(),
        reviewCommentFeedback(),
        approvalFeedback({ runId: "other-review-run" }),
      ],
    });

    await expect(service.submitReviewVerdict(passVerdict(), context())).rejects.toMatchObject({
      code: "invalid_request",
      message:
        'Pass review verdict requires prior submit_pull_request_review_feedback with kind="review" and event="APPROVE" for the active reviewer run and lifecycle-bound PR.',
    });
  });

  it("accepts a pass verdict, records verified completion, and applies configured pass behavior", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      summaryPointers: { prUrl: "https://github.com/acme/symphony/pull/42", prNumber: 42, prHeadSha: "head-sha-1" },
      reviewFeedback: [approvalFeedback()],
    });

    const result = await service.submitReviewVerdict(passVerdict(), context());

    expect(result.replayed).toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      reviewVerdicts: [
        {
          id: "review-verdict:issue-1:verdict-pass-1",
          verdict: "pass",
          acceptanceResults: [{ text: "All acceptance criteria satisfied", satisfied: true }],
        },
      ],
    });
    expect((await outbox.list()).find((operation) => operation.kind === "transition")).toMatchObject({
      idempotencyKey: "transition:issue-1:review-run-1:review-verdict-pass:Ready to Merge",
      payload: { toState: "Ready to Merge" },
    });
  });

  it("accepts a pass verdict with non-gating discovery findings", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      summaryPointers: { prUrl: "https://github.com/acme/symphony/pull/42", prNumber: 42, prHeadSha: "head-sha-1" },
      reviewFeedback: [approvalFeedback()],
    });

    await service.submitReviewVerdict(
      passVerdict({
        idempotencyKey: "verdict-pass-with-discovery",
        discoveryFindings: [
          discoveryFinding({
            summary: "A broader stale-cache matrix would be useful hardening outside this contract.",
            relationship: "future_hardening",
            suggestedDisposition: "followup_issue",
          }),
        ],
      }),
      context(),
    );

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      reviewVerdicts: [
        {
          idempotencyKey: "verdict-pass-with-discovery",
          verdict: "pass",
          findings: [],
          gateFindings: [],
          discoveryFindings: [
            {
              summary: "A broader stale-cache matrix would be useful hardening outside this contract.",
              relationship: "future_hardening",
              suggestedDisposition: "followup_issue",
            },
          ],
        },
      ],
    });
  });

  it("accepts a fail verdict with same-run request-changes or comment-only feedback", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewFeedback: [requestChangesFeedback(), issueCommentFeedback(), reviewCommentFeedback()],
    });

    const result = await service.submitReviewVerdict(failVerdict(), context());

    expect(result.replayed).toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "implementation",
      reviewRound: 1,
    });
  });

  it("rejects a fail verdict after same-run approval feedback", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewFeedback: [approvalFeedback()],
    });

    await expect(service.submitReviewVerdict(failVerdict(), context())).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Fail review verdict cannot follow APPROVE review feedback in the same reviewer run; submit a pass verdict or start a fresh review run.",
    });
  });

  it("replays duplicate verdicts without new lifecycle or writeback side effects", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    const first = await service.submitReviewVerdict(failVerdict(), context());
    const second = await service.submitReviewVerdict(
      failVerdict({ findings: ["Changed finding on replay."] }),
      context({ issue: issue({ state: "In Progress" }), phase: "implementation" }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.verdict.findings).toEqual(["Add a regression test for duplicate verdict handling."]);
    expect((await lifecycleStore.get("issue-1"))?.reviewVerdicts).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
  });

  it("rejects verdict calls from the wrong role, run, or state", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await expect(service.submitReviewVerdict(failVerdict(), context({ role: "worker" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.submitReviewVerdict(failVerdict({ runId: "other-run" }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.submitReviewVerdict(failVerdict(), context({ issue: issue({ state: "In Progress" }), phase: "implementation" })),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects invalid verdict payloads", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await expect(service.submitReviewVerdict(failVerdict({ findings: [] }), context())).rejects.toBeInstanceOf(
      SymphonyError,
    );
    await expect(service.submitReviewVerdict(failVerdict({ findings: [] }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.submitReviewVerdict(failVerdict({ findings: [], gateFindings: [], discoveryFindings: [discoveryFinding()] }), context()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Fail review verdicts require at least one gate finding or legacy finding",
    });
    await expect(
      service.submitReviewVerdict(passVerdict({ gateFindings: [gateFinding()] }), context()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Pass review verdicts cannot include gate findings",
    });
  });

  it("formats merge-gate repair prompts with missing-check stabilization history", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        mergeGate: mergeGate({
          checks: [
            {
              name: "typecheck",
              outcome: "missing_actionable",
              rawStatus: "missing",
              conclusion: null,
              url: null,
              firstObservedAt: "2026-01-01T00:00:00.000Z",
              actionableSince: "2026-01-01T00:05:00.000Z",
            },
            {
              name: "lint",
              outcome: "missing_observed",
              rawStatus: "missing",
              conclusion: null,
              url: null,
              firstObservedAt: "2026-01-01T00:00:01.000Z",
              actionableSince: null,
            },
            {
              name: "test",
              outcome: "failing",
              rawStatus: "failure",
              conclusion: "failure",
              url: "https://ci.test/test",
              firstObservedAt: null,
              actionableSince: null,
            },
          ],
        }),
      }),
    );

    expect(result?.kind).toBe("repair");
    expect(result?.text).toContain(
      "- typecheck: missing_actionable; firstObservedAt: 2026-01-01T00:00:00.000Z; actionableSince: 2026-01-01T00:05:00.000Z",
    );
    expect(result?.text).toContain("- lint: missing_observed; firstObservedAt: 2026-01-01T00:00:01.000Z; actionableSince: n/a");
    expect(result?.text).toContain("- test: failing / failure (https://ci.test/test)");
    expect(result?.text).not.toContain("- test: failing / failure (https://ci.test/test); firstObservedAt");
    expect(result?.text).toContain("leave the final implementation changes uncommitted and unpushed");
    expect(result?.text).toContain("Do not run git commit, git push");
    expect(result?.text).not.toContain("commit and push the repaired branch");
  });

  it("formats conflicted merge-gate repair prompts without worker publication commands", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        mergeGate: mergeGate({
          mergeability: {
            status: "conflicted",
            pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
            mergeable: false,
            mergeableState: "dirty",
            reason: "Pull request branch is out of date",
            baseBranch: "main",
            baseHeadSha: "base-sha-1",
            checkedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      }),
    );

    expect(result?.kind).toBe("repair");
    expect(result?.text).toContain("reconcile the lifecycle-bound PR changes with origin/main");
    expect(result?.text).toContain("leave the final implementation changes uncommitted and unpushed");
    expect(result?.text).toContain("Symphony performs service-owned commit, push, and PR publication/reuse");
    expect(result?.text).not.toContain("commit and push the repaired branch");
  });

  it("warns without stale repair details when a merge gate belongs to an older PR head", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        summaryPointers: { prHeadSha: "head-sha-2" },
        mergeGate: mergeGate({
          headSha: "head-sha-1",
          repairRunId: "repair-run-1",
          repairReportId: "completion-report:issue-1:repair-1",
          blockerFingerprint: "head-sha-1:test:failure",
        }),
      }),
    );

    expect(result?.kind).toBe("stale_warning");
    expect(result?.text).toContain("## Symphony Merge Gate Head Advanced");
    expect(result?.text).toContain("Current PR head SHA: head-sha-2");
    expect(result?.text).not.toContain("## Symphony Merge Gate Repair");
    expect(result?.text).not.toContain("test: failing / failure");
    expect(result?.text).not.toContain("Repair round");
    expect(result?.text).not.toContain("Blocker fingerprint");
    expect(result?.text).not.toContain("completion-report:issue-1:repair-1");
  });

  it("warns for a persisted superseded same-PR gate bound to the current head", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        summaryPointers: { prHeadSha: "head-sha-2" },
        mergeGate: mergeGate({
          status: "superseded",
          headSha: "head-sha-1",
          checks: [],
          repairRunId: null,
          repairReportId: null,
          blockerFingerprint: null,
          supersededByHeadSha: "head-sha-2",
        }),
      }),
    );

    expect(result?.kind).toBe("stale_warning");
    expect(result?.text).toContain("## Symphony Merge Gate Head Advanced");
    expect(result?.text).not.toContain("## Symphony Merge Gate Repair");
  });

  function fixture() {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const service = new ReviewVerdictService({ config, lifecycleStore, writebackOutbox: outbox });
    return { service, lifecycleStore, outbox };
  }
});

function lifecycle(
  overrides: Omit<Partial<IssueLifecycleRecord>, "summaryPointers"> & {
    summaryPointers?: Partial<IssueLifecycleRecord["summaryPointers"]>;
  } = {},
): IssueLifecycleRecord {
  const { summaryPointers: summaryPointerOverrides, ...recordOverrides } = overrides;
  return {
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    phase: "implementation",
    reviewRound: 1,
    incompleteTurnCount: 0,
    lastIssueBreakdownPlanId: null,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureRunId: null,
    lastPlanningFailureAt: null,
    lastIssueTriageReportId: null,
    lastCompletionReportId: null,
    lastReviewVerdictId: null,
    blockedReason: null,
    summaryPointers: {
      workspaceKey: null,
      workspacePath: null,
      branchName: "symphony/TEST-1",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
      lastRunId: null,
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-1",
      prBranch: "symphony/TEST-1",
      ciStatus: null,
      lastPushedAt: null,
      lastEvidenceCursor: null,
      ...summaryPointerOverrides,
    },
    summaryReferences: [],
    issueBreakdownPlans: [],
    completionReports: [],
    reviewVerdicts: [],
    reviewFeedback: [],
    issueTriageReports: [],
    reviewEvidence: { pullRequest: null, lastIngestedCursor: null, lastWorkerEvidenceCursor: null, items: [], updatedAt: null },
    mergeGate: mergeGate(),
    mergeConflict: null,
    mergeConflictResolutionReports: [],
    merge: null,
    handoff: {
      version: 1,
      memo: {
        version: 1,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        reviewRound: 1,
        incompleteTurnCount: 0,
        sizeChars: 0,
        entries: [],
        openFindings: [],
        pointers: {
          workspaceKey: null,
          workspacePath: null,
          branchName: "symphony/TEST-1",
          gitBranchName: "symphony/TEST-1",
          repoPath: "/repo",
          baseRef: "main",
          lastRunId: null,
          prUrl: "https://github.com/acme/symphony/pull/42",
          prNumber: 42,
          prHeadSha: "head-sha-1",
          prBranch: "symphony/TEST-1",
          ciStatus: null,
          lastPushedAt: null,
          lastEvidenceCursor: null,
        },
        lastWorkerRunId: null,
        lastReviewerRunId: null,
      },
      lastWorkerOutput: null,
      lastReviewerOutput: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...recordOverrides,
  };
}

function mergeGate(overrides: Partial<IssueMergeGateState> = {}): IssueMergeGateState {
  return {
    id: "merge-gate:issue-1:pr-42:head-sha-1",
    status: "repair_dispatched",
    headSha: "head-sha-1",
    pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
    requiredChecks: ["test"],
    checks: [
      {
        name: "test",
        outcome: "failing",
        rawStatus: "failure",
        conclusion: "failure",
        url: "https://ci.test/test",
        firstObservedAt: null,
        actionableSince: null,
      },
    ],
    mergeability: null,
    reviewRound: 1,
    gateRunId: "worker-run-1",
    gateReportId: "completion-report:issue-1:report-1",
    repairRunId: null,
    repairReportId: null,
    blockerFingerprint: "head-sha-1:test:failure",
    writebackOperationKeys: [],
    supersededByHeadSha: null,
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function approvalFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    kind: "review",
    event: "APPROVE",
    body: "Looks good.",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
    commentUrls: [],
    ...overrides,
  });
}

function requestChangesFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    id: "review-feedback:issue-1:review-run-1:request-changes-1",
    idempotencyKey: "request-changes-1",
    kind: "review",
    event: "REQUEST_CHANGES",
    body: "Please update the tests.",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-2",
    commentUrls: [],
    ...overrides,
  });
}

function issueCommentFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    id: "review-feedback:issue-1:review-run-1:issue-comment-1",
    idempotencyKey: "issue-comment-1",
    kind: "issue_comment",
    event: null,
    body: "High-level note.",
    reviewUrl: null,
    commentUrls: ["https://github.com/acme/symphony/pull/42#issuecomment-1"],
    ...overrides,
  });
}

function reviewCommentFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    id: "review-feedback:issue-1:review-run-1:review-comment-1",
    idempotencyKey: "review-comment-1",
    kind: "review_comment",
    event: null,
    body: "Inline note.",
    reviewUrl: null,
    commentUrls: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    ...overrides,
  });
}

function reviewFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return {
    id: "review-feedback:issue-1:review-run-1:approve-1",
    idempotencyKey: "approve-1",
    requestHash: "request-hash",
    runId: "review-run-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    kind: "review",
    event: "APPROVE",
    body: "Looks good.",
    pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
    reviewer: "reviewer-1",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
    commentUrls: [],
    submittedAt: "2026-01-01T00:00:02.000Z",
    ...overrides,
  };
}

function failVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    verdict: "fail",
    acceptanceResults: [
      {
        text: "Duplicate verdicts are idempotent",
        satisfied: false,
        evidence: "No duplicate test was present.",
      },
    ],
    findings: ["Add a regression test for duplicate verdict handling."],
    discoveryFindings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    idempotencyKey: "verdict-1",
    ...overrides,
  };
}

function passVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    verdict: "pass",
    acceptanceResults: [
      {
        text: "All acceptance criteria satisfied",
        satisfied: true,
        evidence: "Reviewer verified the PR.",
      },
    ],
    findings: [],
    discoveryFindings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
    idempotencyKey: "verdict-pass-1",
    ...overrides,
  };
}

function gateFinding(
  overrides: Partial<NonNullable<ReviewVerdictInput["gateFindings"]>[number]> = {},
): NonNullable<ReviewVerdictInput["gateFindings"]>[number] {
  return {
    summary: "Add a regression test for duplicate verdict handling.",
    requirementIds: ["REQ-1"],
    contractAnchor: "Issue Contract > Requirements > REQ-1",
    scenario: "Duplicate review verdict submission",
    scenarioEntitlement: "explicit_requirement",
    observedFailure: "The PR has no duplicate verdict regression coverage.",
    currentIssueOwnership: "The issue contract names idempotent duplicate handling as required behavior.",
    boundedRepair: "Add focused duplicate verdict regression coverage.",
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    ...overrides,
  };
}

function discoveryFinding(
  overrides: Partial<NonNullable<ReviewVerdictInput["discoveryFindings"]>[number]> = {},
): NonNullable<ReviewVerdictInput["discoveryFindings"]>[number] {
  return {
    summary: "Sibling workflow coverage may need separate hardening.",
    importance: "medium",
    relationship: "adjacent_sibling",
    discoveryReason: "Review found a nearby scenario that is related but not explicitly owned by this issue contract.",
    suggestedDisposition: "operator_decision",
    scenarioAxes: ["sibling workflow", "fallback state"],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r2"],
    ownerIssueIdentifier: null,
    ...overrides,
  };
}

function context(overrides: Partial<ReviewVerdictActiveContext> = {}): ReviewVerdictActiveContext {
  return {
    issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
    activeRunId: "review-run-1",
    role: "reviewer",
    token: "review-token",
    expectedToken: "review-token",
    reviewer: "reviewer-1",
    phase: "review",
    ...overrides,
  };
}
