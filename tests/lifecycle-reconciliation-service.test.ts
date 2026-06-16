import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleReconciliationService } from "../src/core/LifecycleReconciliationService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { issue } from "./helpers.js";

describe("LifecycleReconciliationService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-lifecycle-reconcile-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("migrates legacy merge-gate verdicts and supersedes stale review and triage records", async () => {
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const currentIssue = issue({ state: "Blocked" });
    const humanFailId = "review-verdict:issue-1:fail-1";
    const humanPassId = "review-verdict:issue-1:pass-1";
    const gateId = "merge-gate:issue-1:pr-42:head-sha-1";
    const triageId = "issue-triage-report:issue-1:triage-1";

    await lifecycleStore.ensureIssue(currentIssue, {
      phase: "blocked",
      reviewRound: 2,
      blockedReason: "max merge gate failures reached (2/2)",
      lastReviewVerdictId: gateId,
      lastIssueTriageReportId: triageId,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-1",
        prBranch: "symphony/TEST-1",
        ciStatus: "failure",
      },
      reviewVerdicts: [
        {
          id: humanFailId,
          idempotencyKey: "fail-1",
          runId: "review-run-1",
          issueId: currentIssue.id,
          issueIdentifier: currentIssue.identifier,
          verdict: "fail",
          acceptanceResults: [{ text: "Implementation satisfies the contract", satisfied: false, evidence: "old finding" }],
          findings: ["Old implementation requirement finding"],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["old review evidence"],
          reviewer: "reviewer-1",
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
        {
          id: humanPassId,
          idempotencyKey: "pass-1",
          runId: "review-run-2",
          issueId: currentIssue.id,
          issueIdentifier: currentIssue.identifier,
          verdict: "pass",
          acceptanceResults: [{ text: "Implementation satisfies the contract", satisfied: true, evidence: "approved" }],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["approved review evidence"],
          reviewer: "reviewer-1",
          submittedAt: "2026-01-01T00:10:00.000Z",
          writebackOperationKeys: [],
        },
        {
          id: gateId,
          idempotencyKey: `${gateId}:repair:head-sha-1:typecheck:failure`,
          runId: "worker-run-1",
          issueId: currentIssue.id,
          issueIdentifier: currentIssue.identifier,
          verdict: "fail",
          acceptanceResults: [
            {
              text: "Required checks are passing and the pull request is mergeable before gated merge",
              satisfied: false,
              evidence: "typecheck failed",
            },
          ],
          findings: ["Required check failed: typecheck"],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["typecheck failed"],
          reviewer: "symphony-merge-gate",
          submittedAt: "2026-01-01T00:20:00.000Z",
          writebackOperationKeys: ["transition:issue-1:merge-gate-repair"],
        },
      ],
      issueTriageReports: [
        {
          id: triageId,
          idempotencyKey: "triage-1",
          requestHash: "triage-hash-1",
          runId: "triage-run-1",
          issueId: currentIssue.id,
          issueIdentifier: currentIssue.identifier,
          triggerFingerprint: "blocked-trigger-1",
          disposition: "implementation_repair",
          confidence: "high",
          summary: "Old triage report says implementation requirements are still unsatisfied.",
          evidence: ["old failed review was newer in the prompt"],
          recommendedAction: "Worker should repair implementation requirements.",
          blockers: [
            {
              kind: "implementation_unsatisfied_requirements",
              status: "active",
              nextActor: "worker",
              confidence: "high",
              summary: "Old failed review was treated as active.",
              evidence: ["old failed review was newer in the prompt"],
              recommendedAction: "Worker should repair implementation requirements.",
            },
          ],
          submittedAt: "2026-01-01T00:30:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      mergeGate: {
        id: gateId,
        status: "repair_dispatched",
        headSha: "head-sha-1",
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        requiredChecks: ["typecheck"],
        checks: [
          {
            name: "typecheck",
            outcome: "failing",
            rawStatus: "failure",
            conclusion: "failure",
            url: "https://ci.test/typecheck",
            firstObservedAt: "2026-01-01T00:20:00.000Z",
            actionableSince: "2026-01-01T00:20:00.000Z",
          },
        ],
        mergeability: null,
        reviewRound: 2,
        gateRunId: "worker-run-1",
        gateReportId: "completion-report:issue-1:report-1",
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: "head-sha-1:typecheck:failure",
        writebackOperationKeys: ["transition:issue-1:merge-gate-repair"],
        supersededByHeadSha: null,
        updatedAt: "2026-01-01T00:20:00.000Z",
      },
    });

    const result = await new LifecycleReconciliationService({ lifecycleStore }).applyIssue(
      currentIssue.id,
      "2026-01-01T01:00:00.000Z",
    );
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result?.applied).toBe(true);
    expect(result?.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining([
        "legacy_merge_gate_verdict_migrated",
        "legacy_merge_gate_verdict_superseded",
        "review_failure_superseded",
        "triage_report_superseded",
        "last_review_verdict_pointer_updated",
        "last_merge_gate_result_pointer_updated",
        "last_issue_triage_report_pointer_updated",
      ]),
    );
    expect(lifecycle?.lastReviewVerdictId).toBe(humanPassId);
    expect(lifecycle?.lastMergeGateResultId).toBe(gateId);
    expect(lifecycle?.lastIssueTriageReportId).toBeNull();
    expect(lifecycle?.mergeGateResults).toHaveLength(1);
    expect(lifecycle?.mergeGateResults?.[0]).toMatchObject({
      id: gateId,
      status: "repair_dispatched",
      findings: ["Required check failed: typecheck"],
      evidence: ["typecheck failed"],
      supersededAt: null,
    });
    expect(lifecycle?.reviewVerdicts.find((verdict) => verdict.id === gateId)).toMatchObject({
      supersededAt: "2026-01-01T01:00:00.000Z",
      supersededBy: gateId,
      supersededReason: "migrated_to_merge_gate_result",
    });
    expect(lifecycle?.reviewVerdicts.find((verdict) => verdict.id === humanFailId)).toMatchObject({
      supersededAt: "2026-01-01T01:00:00.000Z",
      supersededBy: humanPassId,
      supersededReason: "later_human_pass",
    });
    expect(lifecycle?.issueTriageReports[0]).toMatchObject({
      supersededAt: "2026-01-01T01:00:00.000Z",
      supersededBy: gateId,
      supersededReason: "merge_gate_signal_reclassified_blocker",
    });
  });
});
