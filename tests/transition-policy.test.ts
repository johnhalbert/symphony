import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/core/config/Config.js";
import type {
  IssuePostMortemReportRecord,
  IssueTriageReportRecord,
  PullRequestReviewEvidenceItem,
} from "../src/core/persistence/IssueLifecycleStore.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import {
  planBlockedEscalationWritebacks,
  planCompletionReportAcceptedWritebacks,
  planIssuePostMortemReportWritebacks,
  planIssueTriageReportWritebacks,
  planMergeGateBlockedWritebacks,
  planMergeGateRepairWritebacks,
  planPullRequestHandoffWritebacks,
  planReviewFailWritebacks,
  planReviewPassWritebacks,
} from "../src/core/writeback/TransitionPolicy.js";
import { issue, testConfig } from "./helpers.js";

type NewCommentOperation = NewWritebackOperation & {
  kind: "comment";
  payload: { body: string; dedupeKey: string };
};

describe("TransitionPolicy review-loop planners", () => {
  it("plans completion report accepted comment and In Progress to review transition", () => {
    const config = reviewLoopConfig();
    const operations = planCompletionReportAcceptedWritebacks(
      {
        issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
        runId: "run-1",
        sessionId: "session-1",
        workspacePath: "/tmp/workspace",
      },
      config,
      "Implemented the requested policy planners.",
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:run-1:completion-report-accepted",
      kind: "comment",
      payload: {
        dedupeKey: "run-1:completion-report-accepted",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Completion Report");
    expect(commentBody(operations, 0)).toContain("Status: accepted");
    expect(commentBody(operations, 0)).toContain("Next state: In Review (agent review queue)");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:run-1:completion-report-accepted:In Review",
      kind: "transition",
      payload: {
        fromStates: ["In Progress", "Blocked"],
        toState: "In Review",
      },
    });
  });

  it("does not plan completion report accepted writebacks outside the active implementation state", () => {
    const config = reviewLoopConfig();

    expect(
      planCompletionReportAcceptedWritebacks(
        {
          issue: issue({ state: "In Review" }),
          runId: "run-1",
          sessionId: "session-1",
          workspacePath: "/tmp/workspace",
        },
        config,
      ),
    ).toEqual([]);
  });

  it("plans verified PR handoff comment and transition to the configured handoff state", () => {
    const config = reviewLoopConfig();
    config.tracker.handoffStates = ["Human Review"];
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    const operations = planPullRequestHandoffWritebacks(
      {
        issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
        runId: "run-1",
        sessionId: "session-1",
        workspacePath: "/tmp/workspace",
      },
      config,
      {
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "abc123",
          branch: "symphony/TEST-1",
          draft: false,
        },
        ci: {
          requiredChecks: ["Typecheck and test"],
          passedChecks: ["Typecheck and test"],
          noCiEvidence: null,
        },
      },
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:pull-request-handoff:pr-42:abc123",
      kind: "comment",
      payload: {
        dedupeKey: "pull-request-handoff:pr-42:abc123",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony PR Handoff");
    expect(commentBody(operations, 0)).toContain("Status: verified PR ready for human review");
    expect(commentBody(operations, 0)).toContain("Next state: Human Review (PR review handoff)");
    expect(commentBody(operations, 0)).toContain("PR: #42 https://github.com/acme/symphony/pull/42");
    expect(commentBody(operations, 0)).toContain("Required checks: Typecheck and test");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:pull-request-handoff:pr-42:abc123:Human Review",
      kind: "transition",
      payload: {
        fromStates: ["In Progress"],
        toState: "Human Review",
      },
    });
  });

  it("plans review fail comment with requested revisions and review to active transition", () => {
    const config = reviewLoopConfig();
    const operations = planReviewFailWritebacks(
      { issue: issue({ state: "In Review" }), runId: "review-run-1", reviewer: "reviewer-1" },
      config,
      ["Add tests for the blocked fallback.", "Clarify idempotency keys."],
      [reviewEvidence()],
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:review-run-1:review-verdict-fail",
      kind: "comment",
      payload: {
        dedupeKey: "review-run-1:review-verdict-fail",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Review Verdict: Fail");
    expect(commentBody(operations, 0)).toContain("Gate findings requiring worker repair:");
    expect(commentBody(operations, 0)).toContain("Discovery findings (not worker-gating):");
    expect(commentBody(operations, 0)).toContain("- Add tests for the blocked fallback.");
    expect(commentBody(operations, 0)).toContain("- Clarify idempotency keys.");
    expect(commentBody(operations, 0)).toContain("PR review evidence:");
    expect(commentBody(operations, 0)).toContain("Pull request: https://github.com/acme/symphony/pull/42");
    expect(commentBody(operations, 0)).toContain("src/core/review/PullRequestReviewEvidenceService.ts:72");
    expect(commentBody(operations, 0)).toContain("GitHub PR reviews and comments are the primary detailed review surface.");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:review-run-1:review-verdict-fail:In Progress",
      kind: "transition",
      payload: {
        fromStates: ["In Review"],
        toState: "In Progress",
      },
    });
  });

  it("does not plan review fail writebacks outside review states", () => {
    const config = reviewLoopConfig();

    expect(
      planReviewFailWritebacks(
        { issue: issue({ state: "In Progress" }), runId: "review-run-1", reviewer: null },
        config,
        ["Make a change."],
      ),
    ).toEqual([]);
  });

  it("plans review pass comment and configured pass transition", () => {
    const config = reviewLoopConfig();
    const operations = planReviewPassWritebacks(
      { issue: issue({ state: "In Review" }), runId: "review-run-2", reviewer: "reviewer-1" },
      config,
      "Looks good.",
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:review-run-2:review-verdict-pass",
      kind: "comment",
      payload: {
        dedupeKey: "review-run-2:review-verdict-pass",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Review Verdict: Pass");
    expect(commentBody(operations, 0)).toContain("Review pass state: Ready to Merge");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:review-run-2:review-verdict-pass:Ready to Merge",
      kind: "transition",
      payload: {
        fromStates: ["In Review"],
        toState: "Ready to Merge",
      },
    });
  });

  it("plans review pass marker comment without transition when no pass state is configured", () => {
    const config = reviewLoopConfig();
    config.reviewLoop.reviewPassState = null;

    const operations = planReviewPassWritebacks(
      { issue: issue({ state: "In Review" }), runId: "review-run-2", reviewer: null },
      config,
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:review-run-2:review-verdict-pass",
      kind: "comment",
    });
    expect(commentBody(operations, 0)).toContain("Review passed marker: review-passed");
  });

  it("does not plan review pass writebacks outside review states", () => {
    const config = reviewLoopConfig();

    expect(
      planReviewPassWritebacks(
        { issue: issue({ state: "In Progress" }), runId: "review-run-2", reviewer: null },
        config,
      ),
    ).toEqual([]);
  });

  it("plans blocked escalation comment and transition from active or review states", () => {
    const config = reviewLoopConfig();
    const operations = planBlockedEscalationWritebacks(
      {
        issue: issue({ state: "In Review" }),
        runId: "run-blocked-1",
        reason: "review loop ceiling reached",
      },
      config,
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:run-blocked-1:blocked-escalation",
      kind: "comment",
      payload: {
        dedupeKey: "run-blocked-1:blocked-escalation",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Blocked Escalation");
    expect(commentBody(operations, 0)).toContain("Ceiling reason: review loop ceiling reached");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:run-blocked-1:blocked-escalation:Blocked",
      kind: "transition",
      payload: {
        fromStates: ["Todo", "In Progress", "In Review"],
        toState: "Blocked",
      },
    });
  });

  it("uses triage-pending blocked escalation action for triage-eligible ceilings", () => {
    const config = reviewLoopConfig();
    config.issueTriage.enabled = true;

    const operations = planBlockedEscalationWritebacks(
      {
        issue: issue({ state: "In Review" }),
        runId: "run-blocked-1",
        reason: "max reviewer failures reached (3/3)",
      },
      config,
    );

    expect(commentBody(operations, 0)).toContain("Symphony will run issue triage");
    expect(commentBody(operations, 0)).toContain("publish a follow-up recommendation");
    expect(commentBody(operations, 0)).not.toContain("Inspect the latest worker output and reviewer feedback");
  });

  it("plans blocked escalation transitions from PR handoff states", () => {
    const config = reviewLoopConfig();
    config.tracker.handoffStates = ["Human Review"];

    const operations = planBlockedEscalationWritebacks(
      {
        issue: issue({ state: "Human Review" }),
        runId: "run-blocked-1",
        reason: "human review ceiling reached",
      },
      config,
    );

    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({
      kind: "transition",
      payload: {
        fromStates: ["Todo", "In Progress", "Human Review", "In Review"],
        toState: "Blocked",
      },
    });
  });

  it("plans blocked fallback comment only when no blocked state is configured", () => {
    const config = reviewLoopConfig();
    config.reviewLoop.blockedStates = [];

    const operations = planBlockedEscalationWritebacks(
      {
        issue: issue({ state: "In Progress" }),
        runId: "run-blocked-1",
        reason: "max incomplete turns reached",
      },
      config,
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:run-blocked-1:blocked-escalation",
      kind: "comment",
    });
    expect(commentBody(operations, 0)).toContain("left the issue state unchanged");
  });

  it("plans issue triage report comments", () => {
    const config = reviewLoopConfig();
    const report: IssueTriageReportRecord = {
      id: "issue-triage-report:issue-1:triage-1",
      idempotencyKey: "triage-1",
      requestHash: "request-hash-1",
      runId: "triage-run-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      triggerFingerprint: "trigger-fingerprint-1",
      disposition: "decompose_issue",
      confidence: "high",
      summary: "Review failures exposed hidden sibling scope.",
      evidence: ["review-verdict:issue-1:verdict-3 found sibling path"],
      recommendedAction: "Use SpecKit to create blocking child issues for the hidden sibling scope.",
      blockers: [
        {
          kind: "under_specified_needs_decomposition",
          status: "active",
          nextActor: "planner",
          confidence: "high",
          summary: "Review failures exposed hidden sibling scope.",
          evidence: ["review-verdict:issue-1:verdict-3 found sibling path"],
          recommendedAction: "Use SpecKit to create blocking child issues for the hidden sibling scope.",
        },
      ],
      submittedAt: "2026-01-01T00:00:00.000Z",
      writebackOperationKeys: [],
    };

    const operations = planIssueTriageReportWritebacks(
      {
        issue: issue({ state: "Blocked" }),
        report,
        blockedReason: "max reviewer failures reached (3/3)",
      },
      config,
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:issue-triage:triage-1",
      kind: "comment",
      issueId: "issue-1",
      runId: "triage-run-1",
      payload: {
        dedupeKey: "issue-triage:triage-1",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Issue Triage");
    expect(commentBody(operations, 0)).toContain("Status: triage complete, human action required");
    expect(commentBody(operations, 0)).toContain("Blocked reason: max reviewer failures reached (3/3)");
    expect(commentBody(operations, 0)).toContain("### 1. under_specified_needs_decomposition");
    expect(commentBody(operations, 0)).toContain("Confidence: high");
    expect(commentBody(operations, 0)).toContain("Review failures exposed hidden sibling scope.");
    expect(commentBody(operations, 0)).toContain("- review-verdict:issue-1:verdict-3 found sibling path");
    expect(commentBody(operations, 0)).toContain("Recommended human action:");
    expect(commentBody(operations, 0)).toContain(report.recommendedAction);
  });

  it("plans issue post-mortem report comments", () => {
    const config = reviewLoopConfig();
    const report: IssuePostMortemReportRecord = {
      id: "issue-post-mortem-report:issue-1:postmortem-1",
      idempotencyKey: "postmortem-1",
      requestHash: "request-hash-1",
      runId: "post-mortem-run-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      triggerFingerprint: "trigger-fingerprint-1",
      summary: "Done state is valid with one follow-up test gap.",
      completionJudgment: {
        status: "valid_with_followups",
        rationale: "The implementation satisfies the written contract.",
      },
      specificationAssessment: {
        quality: "adequate",
        classifications: ["well_scoped"],
        missingContractAreas: [],
        speckitRecommended: false,
        speckitRationale: "No decomposition need was found.",
      },
      reviewAssessment: {
        gateDecisionLooksValid: true,
        missedGateFindings: [],
        missedDiscoveryFindings: ["Add a stale-state regression later."],
      },
      followUpCandidates: [
        {
          title: "Add stale-state regression",
          priority: "medium",
          kind: "test_gap",
          rationale: "Adjacent stale behavior is worth capturing after Done.",
          readyForSpecKit: true,
          suggestedIssueContract: "Add a stale-state regression without changing shipped behavior.",
        },
      ],
      processLessons: ["The issue was specified well enough to complete, but had one follow-up gap."],
      submittedAt: "2026-01-01T00:00:00.000Z",
      writebackOperationKeys: [],
    };

    const operations = planIssuePostMortemReportWritebacks(
      {
        issue: issue({ state: "Done" }),
        report,
      },
      config,
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:issue-post-mortem:postmortem-1",
      kind: "comment",
      issueId: "issue-1",
      runId: "post-mortem-run-1",
      payload: {
        dedupeKey: "issue-post-mortem:postmortem-1",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Post-Mortem");
    expect(commentBody(operations, 0)).toContain("Status: post-mortem complete, follow-up candidates reported");
    expect(commentBody(operations, 0)).toContain("Completion judgment:");
    expect(commentBody(operations, 0)).toContain("- Status: valid_with_followups");
    expect(commentBody(operations, 0)).toContain("Specification assessment:");
    expect(commentBody(operations, 0)).toContain("Review assessment:");
    expect(commentBody(operations, 0)).toContain("Follow-up candidates:");
    expect(commentBody(operations, 0)).toContain("Add stale-state regression");
  });

  it("does not plan blocked escalation writebacks outside active or review states", () => {
    const config = reviewLoopConfig();

    expect(
      planBlockedEscalationWritebacks(
        {
          issue: issue({ state: "Done" }),
          runId: "run-blocked-1",
          reason: "max incomplete turns reached",
        },
        config,
      ),
    ).toEqual([]);
  });

  it("plans merge gate repair writebacks from the merge source state with check evidence", () => {
    const config = reviewLoopConfig();
    const operations = planMergeGateRepairWritebacks(
      {
        issue: issue({ state: "Ready to Merge" }),
        gateId: "merge-gate:issue-1:pr-42:head-sha-1",
        blockerFingerprint: "head-sha-1:lint:missing|test:failure",
        fromState: "Ready to Merge",
        pullRequest: {
          number: 42,
          url: "https://github.com/acme/symphony/pull/42",
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        requiredChecks: ["test", "typecheck"],
        failedChecks: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
        actionableMissingChecks: [{ name: "lint", status: "missing", conclusion: null, url: null }],
        pendingChecks: [{ name: "typecheck", status: "pending", conclusion: null, url: "https://ci.test/typecheck" }],
        missingChecks: [],
        reviewRound: 1,
        maxReviewRounds: 3,
      },
      config,
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_lint_missing_test_failure:r1",
      kind: "comment",
      payload: {
        dedupeKey: "merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_lint_missing_test_failure:r1",
      },
    });
    expect(commentBody(operations, 0)).toContain("## Symphony Merge Gate");
    expect(commentBody(operations, 0)).toContain("Status: repair required");
    expect(commentBody(operations, 0)).toContain("PR: #42 https://github.com/acme/symphony/pull/42");
    expect(commentBody(operations, 0)).toContain("PR head SHA: head-sha-1");
    expect(commentBody(operations, 0)).toContain("test: failure / failure (https://ci.test/test)");
    expect(commentBody(operations, 0)).toContain("Actionable missing checks:");
    expect(commentBody(operations, 0)).toContain("lint: missing");
    expect(commentBody(operations, 0)).toContain("typecheck: pending (https://ci.test/typecheck)");
    expect(commentBody(operations, 0)).toContain("leave the final implementation changes uncommitted and unpushed");
    expect(commentBody(operations, 0)).toContain("Do not run git commit, git push");
    expect(commentBody(operations, 0)).not.toContain("push the repair to the lifecycle-bound PR branch");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_lint_missing_test_failure:r1:In Progress",
      kind: "transition",
      payload: {
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
      },
    });
  });

  it("plans conflicted merge gate repair writebacks without worker publication commands", () => {
    const config = reviewLoopConfig();
    const operations = planMergeGateRepairWritebacks(
      {
        issue: issue({ state: "Ready to Merge" }),
        gateId: "merge-gate:issue-1:pr-42:head-sha-1",
        blockerFingerprint: "head-sha-1:mergeability:dirty",
        fromState: "Ready to Merge",
        pullRequest: {
          number: 42,
          url: "https://github.com/acme/symphony/pull/42",
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        requiredChecks: ["test"],
        failedChecks: [],
        actionableMissingChecks: [],
        pendingChecks: [],
        missingChecks: [],
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
        reviewRound: 1,
        maxReviewRounds: 3,
      },
      config,
    );

    expect(commentBody(operations, 0)).toContain("reconcile the lifecycle-bound PR changes with origin/main");
    expect(commentBody(operations, 0)).toContain("leave the final implementation changes uncommitted and unpushed");
    expect(commentBody(operations, 0)).toContain("Symphony performs service-owned commit, push, and PR publication/reuse");
    expect(commentBody(operations, 0)).not.toContain("commit and push the repaired branch");
  });

  it("plans merge gate blocked writebacks from the merge source state", () => {
    const config = reviewLoopConfig();
    const operations = planMergeGateBlockedWritebacks(
      {
        issue: issue({ state: "Ready to Merge" }),
        gateId: "merge-gate:issue-1:pr-42:head-sha-1",
        blockerFingerprint: "head-sha-1:test:failure",
        fromState: "Ready to Merge",
        pullRequest: {
          number: 42,
          url: "https://github.com/acme/symphony/pull/42",
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        requiredChecks: ["test"],
        failedChecks: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
        pendingChecks: [],
        missingChecks: [],
        reviewRound: 3,
        maxReviewRounds: 3,
      },
      config,
    );

    expect(operations).toHaveLength(2);
    expect(commentBody(operations, 0)).toContain("Status: blocked, human action required");
    expect(commentBody(operations, 0)).toContain("Transitioning to blocked state: Blocked");
    expect(operations[1]).toMatchObject({
      idempotencyKey: "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:blocked:head-sha-1_test_failure:r3:Blocked",
      kind: "transition",
      payload: {
        fromStates: ["Ready to Merge"],
        toState: "Blocked",
      },
    });
  });

  it("uses triage-pending merge gate blocked action when issue triage is enabled", () => {
    const config = reviewLoopConfig();
    config.issueTriage.enabled = true;

    const operations = planMergeGateBlockedWritebacks(
      {
        issue: issue({ state: "Ready to Merge" }),
        gateId: "merge-gate:issue-1:pr-42:head-sha-1",
        blockerFingerprint: "head-sha-1:test:failure",
        fromState: "Ready to Merge",
        pullRequest: {
          number: 42,
          url: "https://github.com/acme/symphony/pull/42",
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        requiredChecks: ["test"],
        failedChecks: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
        pendingChecks: [],
        missingChecks: [],
        reviewRound: 3,
        maxReviewRounds: 3,
      },
      config,
    );

    expect(commentBody(operations, 0)).toContain("Symphony will run issue triage for this merge-gate ceiling");
    expect(commentBody(operations, 0)).toContain("publish a follow-up recommendation");
    expect(commentBody(operations, 0)).not.toContain("Inspect the failing required checks and decide whether to repair");
  });
});

function reviewLoopConfig(): ServiceConfig {
  const config = testConfig("/tmp/symphony-transition-policy");
  config.writeback.enabled = true;
  config.writeback.dispatchState = "In Progress";
  config.reviewLoop.reviewStates = ["In Review"];
  config.reviewLoop.blockedStates = ["Blocked"];
  config.reviewLoop.reviewPassState = "Ready to Merge";
  return config;
}

function commentBody(operations: NewWritebackOperation[], index: number): string {
  const operation = operations[index] as NewCommentOperation | undefined;
  expect(operation?.kind).toBe("comment");
  if (operation?.kind !== "comment") throw new Error(`Expected operation ${index} to be a comment`);
  return operation.payload.body;
}

function reviewEvidence(): PullRequestReviewEvidenceItem {
  return {
    id: "review_comment:42:comment-1",
    source: "review_comment",
    githubId: "comment-1",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/acme/symphony/pull/42",
    url: "https://github.com/acme/symphony/pull/42#discussion_r1",
    reviewer: "reviewer-a",
    body: "Add coverage for the dedupe path.",
    state: null,
    path: "src/core/review/PullRequestReviewEvidenceService.ts",
    line: 72,
    originalLine: 70,
    side: "RIGHT",
    threadId: "thread-1",
    inReplyToId: null,
    isResolved: false,
    isOutdated: false,
    createdAt: "2026-01-01T00:00:01Z",
    updatedAt: "2026-01-01T00:00:02Z",
    submittedAt: null,
    cursor: "2026-01-01T00:00:02Z",
  };
}
