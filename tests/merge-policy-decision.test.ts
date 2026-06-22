import { describe, expect, it } from "vitest";
import {
  mergePolicyObservationFromUnknown,
  mergePolicyTransitionRequestFromObservation,
} from "../src/core/merge/MergePolicyDecision.js";
import type { MergeGateStatus, MergePolicyObservation } from "../src/core/merge/MergePolicyService.js";
import type { IssueCurrentStateSnapshot } from "../src/core/orchestration/IssueOrchestrationState.js";
import type { IssueMergeGateState } from "../src/core/persistence/IssueLifecycleStore.js";

describe("MergePolicyDecision", () => {
  it("selects merge transition from observation kind instead of embedded transition kind", () => {
    const observation = observationWith({ observationKind: "merge_ready", nextTransitionKind: "merge_policy_block_failure" });

    expect(mergePolicyTransitionRequestFromObservation(snapshot(), observation)).toEqual({
      transitionKind: "merge_policy_merge_pull_request",
    });
  });

  it("decides merge-gate repair versus block from current snapshot evidence", () => {
    const gate = gateStatus();
    const observation = observationWith({ observationKind: "merge_gate_failure", gate, existingGateFailure: null });

    expect(
      mergePolicyTransitionRequestFromObservation(
        snapshot({ mergePolicyMaxMergeGateFailures: 2, mergePolicyMergeGate: mergeGateState({ reviewRound: 0 }) }),
        observation,
      ),
    ).toEqual({ transitionKind: "merge_policy_dispatch_repair" });

    expect(
      mergePolicyTransitionRequestFromObservation(
        snapshot({ mergePolicyMaxMergeGateFailures: 1, mergePolicyMergeGate: mergeGateState({ reviewRound: 0 }) }),
        observation,
      ),
    ).toEqual({ transitionKind: "merge_policy_block_failure" });
  });

  it("blocks conflicted merge-gate failures when no conflicts state is configured", () => {
    const observation = observationWith({
      observationKind: "merge_gate_failure",
      gate: gateStatus({
        mergeability: {
          status: "conflicted",
          pullRequest: { number: 12, url: "https://example.test/pr/12", branch: "feature", headSha: "head" },
          mergeable: false,
          mergeableState: "dirty",
          reason: "conflicted",
          baseBranch: "main",
          baseHeadSha: "base",
          observedBaseHeadSha: "base",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });

    expect(
      mergePolicyTransitionRequestFromObservation(snapshot({ mergePolicyConflictsState: null }), observation),
    ).toEqual({ transitionKind: "merge_policy_block_failure" });
  });

  it("normalizes legacy observations that only stored nextTransitionKind", () => {
    const parsed = mergePolicyObservationFromUnknown({
      version: 1,
      inputFingerprint: "fp",
      observedAt: "2026-01-01T00:00:00.000Z",
      status: "ready",
      reason: "legacy",
      nextTransitionKind: "merge_policy_prepare_conflict",
    });

    expect(parsed).toMatchObject({
      observationKind: "service_preparable_conflict",
      serviceMergeLogin: null,
    });
  });
});

function snapshot(overrides: Partial<IssueCurrentStateSnapshot> = {}): IssueCurrentStateSnapshot {
  return {
    phase: "passed",
    mergePolicyConflictsState: "Merge Conflicts",
    mergePolicyMaxMergeGateFailures: 2,
    mergePolicyMergeGate: null,
    ...overrides,
  } as IssueCurrentStateSnapshot;
}

function observationWith(overrides: Partial<MergePolicyObservation>): MergePolicyObservation {
  return {
    version: 1,
    inputFingerprint: "fp",
    observedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    observationKind: "checks_pending",
    reason: null,
    gate: null,
    existingGateFailure: null,
    serviceMergeLogin: null,
    ...overrides,
  } as MergePolicyObservation;
}

function gateStatus(overrides: Partial<MergeGateStatus> = {}): MergeGateStatus {
  return {
    id: "merge-gate:issue-1:pr-12:head",
    pullRequest: { number: 12, url: "https://example.test/pr/12", branch: "feature", headSha: "head" },
    headSha: "head",
    requiredChecks: ["test"],
    passedChecks: [],
    failedChecks: [{ name: "test", status: "failure", conclusion: "failed", url: null }],
    actionableMissingChecks: [],
    pendingChecks: [],
    missingChecks: [],
    unknownChecks: [],
    checks: [
      {
        name: "test",
        status: "failure",
        conclusion: "failed",
        url: null,
        outcome: "failing",
        rawStatus: "failure",
        firstObservedAt: null,
        actionableSince: null,
      },
    ],
    mergeability: null,
    blockerFingerprint: "head:test:failure",
    writebackOperationKeys: [],
    ...overrides,
  };
}

function mergeGateState(overrides: Partial<IssueMergeGateState>): IssueMergeGateState {
  return {
    id: "merge-gate:issue-1:pr-12:head",
    status: "repair_dispatched",
    headSha: "head",
    pullRequest: { number: 12, url: "https://example.test/pr/12", branch: "feature", headSha: "head" },
    requiredChecks: ["test"],
    checks: [],
    mergeability: null,
    reviewRound: 0,
    gateRunId: null,
    gateReportId: null,
    repairRunId: null,
    repairReportId: null,
    blockerFingerprint: "head:test:failure",
    writebackOperationKeys: [],
    supersededByHeadSha: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
