import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
  pendingPublicationHandoffForRun,
} from "../src/core/CompletionReportService.js";
import type { IssueBaseRefObservation } from "../src/core/BaseRefVerification.js";
import {
  parseServiceConfig,
  type ServiceConfig,
} from "../src/core/config/Config.js";
import {
  HISTORY_BACKED_FIELD_GROUPS,
  IssueCurrentStateBuilder,
  type IssueCurrentStateHistoryRebuildResult,
  type IssueCurrentStateRuntimeState,
} from "../src/core/orchestration/IssueCurrentStateBuilder.js";
import { SqliteIssueStateStore } from "../src/core/orchestration/SqliteIssueStateStore.js";
import {
  transitionAction,
  type IssueCurrentFields,
  type IssueHistorySnapshot,
  type IssueStateRecord,
  type IssueStateStore,
} from "../src/core/orchestration/IssueOrchestrationState.js";
import {
  FileIssueLifecycleStore,
  latestCurrentApprovalPassVerdict,
  latestCurrentCompletionReport,
  type IssueLifecycleRecord,
  type IssuePreservedWorktreeStash,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { issueTriageTriggerFingerprint } from "../src/core/IssueTriageService.js";
import {
  buildDeclaredIssueSuccessionRecord,
  buildIssueRelationshipState,
} from "../src/core/IssueRelationshipService.js";
import {
  runKindForPhase,
  type AgentRunKind,
  type AgentRunPhase,
  type AgentRunRole,
  type Issue,
  type TokenCounts,
} from "../src/core/types.js";
import { agentEligibleIssueContract } from "./helpers.js";

describe("IssueCurrentStateBuilder", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(os.tmpdir(), "symphony-current-state-builder-"),
    );
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it("builds tracker, config, run, and runtime defaults without optional stores", async () => {
    const builder = new IssueCurrentStateBuilder({
      config: builderConfig(root),
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: new MemoryIssueStateStore(),
      logger: silentLogger(),
    });
    const issue = issueFixture({
      priority: 1,
      state: "Todo",
      labels: ["dogfood-ready"],
      branchName: "feature/defaults",
      assigneeId: null,
      delegateId: "delegate-1",
      assignedToWorker: false,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });

    const current = await builder.build(issue, emptyRuntime());

    expect(current).toMatchObject({
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      priority: 1,
      trackerState: "Todo",
      branchName: "feature/defaults",
      assigneeId: null,
      delegateId: "delegate-1",
      assignedToWorker: false,
      labels: ["dogfood-ready"],
      trackerCreatedAt: "2026-01-01T00:00:01.000Z",
      trackerUpdatedAt: "2026-01-01T00:00:02.000Z",
      lifecyclePersistenceAvailable: false,
      mergePolicyMode: "gated",
      mergePolicySourceStates: ["Ready to Merge"],
      mergePolicyDoneState: "Done",
      mergePolicyConflictsState: "Merge Conflict",
      mergePolicyRequiredChecks: ["ci/test"],
      latestRunId: null,
      latestRunStatus: null,
      running: false,
      runningRole: null,
      claimed: false,
      paused: false,
      retrying: false,
    });
    expect(current.currentIssueContentFingerprint).toMatch(/^[a-f0-9]+$/);
    expect(current.currentIssueBreakdownConfigFingerprint).toMatch(
      /^[a-f0-9]+$/,
    );
    expect(current.mergePolicyConfigFingerprint).toMatch(/^[a-f0-9]+$/);
  });

  it("projects the current generalized relationship graph instead of a stale lifecycle copy", async () => {
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const issueStateStore = new MemoryIssueStateStore();
    const staleIssue = issueFixture({
      description: agentEligibleIssueContract(),
      blocks: [],
      blockedBy: [],
    });
    const currentIssue = issueFixture({
      description: agentEligibleIssueContract({
        issueContractRelationships: {
          blocks: ["TEST-2"],
          blockedBy: ["TEST-0"],
        },
      }),
      blocks: [{ id: "next-1", identifier: "TEST-2", state: "Todo" }],
      blockedBy: [{ id: "dep-1", identifier: "TEST-0", state: "Done" }],
    });
    await lifecycleStore.ensureIssue(currentIssue, {
      relationshipState: buildIssueRelationshipState(staleIssue),
    });
    const builder = new IssueCurrentStateBuilder({
      config: builderConfig(root),
      lifecycleStore,
      runStore: undefined,
      issueStateStore,
      logger: silentLogger(),
    });

    const current = await builder.build(currentIssue, emptyRuntime());

    expect(current.relationshipState).toMatchObject({
      status: "valid",
      contractBlocks: ["TEST-2"],
      contractBlockedBy: ["TEST-0"],
      trackerBlocks: [{ identifier: "TEST-2" }],
      trackerBlockedBy: [{ identifier: "TEST-0" }],
    });
    expect(current.relationshipState?.edges).toHaveLength(2);
  });

  it("projects only the succession declared by the current Issue Contract", async () => {
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const sourceIssue = issueFixture({
      description: agentEligibleIssueContract({
        issueContractContractVersion: "2026-07-23.source",
        issueContractDelivery: {
          mode: "accepted_artifact",
          artifact: "expected_red_tests",
        },
        issueContractRelationships: {
          blocks: ["TEST-2"],
          blockedBy: [],
          succession: {
            id: "tdd-test-1-test-2",
            purpose: "expected_red_implementation",
            successor: { issue: "TEST-2" },
          },
        },
      }),
      blocks: [{ id: "issue-2", identifier: "TEST-2", state: "Todo" }],
    });
    const declared = buildDeclaredIssueSuccessionRecord(sourceIssue);
    if (!declared) throw new Error("Expected a declared succession");
    await lifecycleStore.ensureIssue(sourceIssue, {
      succession: {
        ...declared,
        linearBlockVerified: true,
        status: "integrated",
        mergeCommitSha: "merge-sha",
      },
    });
    const builder = new IssueCurrentStateBuilder({
      config: builderConfig(root),
      lifecycleStore,
      runStore: undefined,
      issueStateStore: new MemoryIssueStateStore(),
      logger: silentLogger(),
    });

    const edgeRemoved = await builder.build(
      {
        ...sourceIssue,
        blocks: [],
      },
      emptyRuntime(),
    );
    expect(edgeRemoved.relationshipState).toMatchObject({
      status: "invalid",
    });
    expect(edgeRemoved.succession).toMatchObject({
      id: "tdd-test-1-test-2",
      role: "succeeded",
      status: "declared",
      linearBlockVerified: false,
      mergeCommitSha: null,
    });

    const unrelatedEdgeDrift = await builder.build(
      {
        ...sourceIssue,
        blocks: [
          ...(sourceIssue.blocks ?? []),
          { id: "issue-99", identifier: "TEST-99", state: "Todo" },
        ],
      },
      emptyRuntime(),
    );
    expect(unrelatedEdgeDrift.relationshipState).toMatchObject({
      status: "invalid",
    });
    expect(unrelatedEdgeDrift.succession).toMatchObject({
      id: "tdd-test-1-test-2",
      role: "succeeded",
      status: "integrated",
      linearBlockVerified: true,
      mergeCommitSha: "merge-sha",
    });

    const removed = await builder.build(
      {
        ...sourceIssue,
        description: agentEligibleIssueContract(),
        blocks: [],
      },
      emptyRuntime(),
    );
    expect(removed.succession).toBeNull();

    const replaced = await builder.build(
      {
        ...sourceIssue,
        description: agentEligibleIssueContract({
          issueContractContractVersion: "2026-07-23.replaced",
          issueContractDelivery: {
            mode: "accepted_artifact",
            artifact: "expected_red_tests",
          },
          issueContractRelationships: {
            blocks: ["TEST-2"],
            blockedBy: [],
            succession: {
              id: "tdd-test-1-test-2-replaced",
              purpose: "expected_red_implementation",
              successor: { issue: "TEST-2" },
            },
          },
        }),
      },
      emptyRuntime(),
    );
    expect(replaced.succession).toMatchObject({
      id: "tdd-test-1-test-2-replaced",
      role: "succeeded",
      status: "declared",
      mergeCommitSha: null,
    });
  });

  it("rebuilds relationship fields from later tracker evidence without resurrecting integrated succession", async () => {
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const sourceIssue = issueFixture({
      description: agentEligibleIssueContract({
        issueContractContractVersion: "2026-07-23.history-source",
        issueContractDelivery: {
          mode: "accepted_artifact",
          artifact: "expected_red_tests",
        },
        issueContractRelationships: {
          blocks: ["TEST-2"],
          blockedBy: [],
          succession: {
            id: "tdd-test-1-test-2-history",
            purpose: "expected_red_implementation",
            successor: { issue: "TEST-2" },
          },
        },
      }),
      blocks: [{ id: "issue-2", identifier: "TEST-2", state: "Todo" }],
    });
    const declared = buildDeclaredIssueSuccessionRecord(sourceIssue);
    if (!declared) throw new Error("Expected a declared succession");
    const lifecycle = await lifecycleStore.ensureIssue(sourceIssue, {
      relationshipState: buildIssueRelationshipState(sourceIssue),
      succession: {
        ...declared,
        linearBlockVerified: true,
        status: "integrated",
        mergeCommitSha: "merge-sha",
      },
    });
    const stateStore = new SqliteIssueStateStore(root);
    try {
      const builder = new IssueCurrentStateBuilder({
        config: builderConfig(root),
        lifecycleStore,
        runStore: undefined,
        issueStateStore: stateStore,
        logger: silentLogger(),
      });
      const integratedCurrent = await builder.build(
        sourceIssue,
        emptyRuntime(),
      );
      await stateStore.ensureCurrent(integratedCurrent);
      await stateStore.appendSnapshotOnly(
        sourceIssue,
        lifecycleEvidenceSnapshot(integratedCurrent, lifecycle),
      );

      const edgeRemovedIssue = {
        ...sourceIssue,
        blocks: [],
        updatedAt: "2026-01-01T00:00:05.000Z",
      };
      const edgeRemovedCurrent = await builder.build(
        edgeRemovedIssue,
        emptyRuntime(),
      );
      const trackerSnapshot = trackerEvidenceSnapshot(
        edgeRemovedCurrent,
        edgeRemovedIssue,
      );
      await stateStore.appendSnapshotOnly(edgeRemovedIssue, {
        ...trackerSnapshot,
        snapshotId: "issue-snapshot:tracker-succession-edge-removed",
        snapshotAt: "2026-01-01T00:00:05.000Z",
        triggerId: "orchestrator.tick:tracker-succession-edge-removed",
        triggerAt: "2026-01-01T00:00:05.000Z",
        historySnapshotId:
          "issue-history:tracker-succession-edge-removed",
        transitionId:
          "transition:record_evidence:tracker-succession-edge-removed",
      });
    } finally {
      await stateStore.close();
    }

    const reopenedStateStore = new SqliteIssueStateStore(root);
    try {
      const historyBuilder = new IssueCurrentStateBuilder({
        config: builderConfig(root),
        lifecycleStore,
        runStore: undefined,
        issueStateStore: reopenedStateStore,
        logger: silentLogger(),
      });
      const rebuilt =
        await historyBuilder.rebuildHistoryBackedFieldsFromStoredHistory(
          sourceIssue.id,
          ["lifecycleReports"],
        );

      expect(rebuilt.fields.relationshipState).toMatchObject({
        status: "invalid",
        trackerBlocks: [],
      });
      expect(rebuilt.fields.succession).toMatchObject({
        id: "tdd-test-1-test-2-history",
        role: "succeeded",
        status: "declared",
        linearBlockVerified: false,
        mergeCommitSha: null,
      });
      expect(rebuilt.sourceSnapshotIdsByGroup.lifecycleReports).toEqual([
        "issue-history:lifecycle-evidence",
        "issue-history:tracker-succession-edge-removed",
      ]);
    } finally {
      await reopenedStateStore.close();
    }
  });

  it("projects only active preserved worktree stashes from lifecycle", async () => {
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const builder = new IssueCurrentStateBuilder({
      config: builderConfig(root),
      lifecycleStore,
      runStore: undefined,
      issueStateStore: new MemoryIssueStateStore(),
      logger: silentLogger(),
    });
    const issue = issueFixture();
    await lifecycleStore.ensureIssue(issue, {
      preservedWorktreeStashes: [
        preservedStashFixture({ id: "stash-active", status: "created" }),
        preservedStashFixture({ id: "stash-dropped", status: "dropped" }),
      ],
    });

    const current = await builder.build(issue, emptyRuntime());

    expect(current.activePreservedWorktreeStashes).toEqual([
      expect.objectContaining({
        id: "stash-active",
        status: "created",
      }),
    ]);
  });

  it("builds tracker, lifecycle, run, and runtime fields from explicit inputs", async () => {
    const config = builderConfig(root);
    const issueStateStore = new MemoryIssueStateStore();
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const issue = issueFixture({
      labels: ["planning"],
      state: "Blocked",
      priority: 2,
      branchName: "feature/test-1",
      blocks: [{ id: "next-1", identifier: "TEST-2", state: "Todo" }],
      blockedBy: [{ id: "dep-1", identifier: "TEST-0", state: "Todo" }],
      hasChildren: true,
    });
    await lifecycleStore.ensureIssue(issue, {
      phase: "blocked",
      reviewRound: 2,
      incompleteTurnCount: 3,
      planningFailureCount: 1,
      planningDispatchRetryCount: 2,
      lastPlanningFailureAt: "2026-01-01T00:00:00.000Z",
      blockedReason: "max incomplete turns reached (3/3)",
      summaryPointers: {
        lastRunId: "run-latest",
        prUrl: "https://github.test/acme/repo/pull/7",
        prNumber: 7,
        prHeadSha: "abc123",
        prBranch: "feature/test-1",
        workspaceKey: "wk-1",
        workspacePath: path.join(root, "wk-1"),
        gitBranchName: "feature/test-1",
      },
    });
    await startFailedWorkerRun(
      runStore,
      issue,
      "run-old",
      "2026-01-01T00:00:00.000Z",
    );
    await startFailedWorkerRun(
      runStore,
      issue,
      "run-latest",
      "2026-01-01T00:01:00.000Z",
    );

    const builder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore,
      issueStateStore,
      logger: silentLogger(),
    });
    const current = await builder.build(issue, {
      runningEntry: {
        role: "worker",
        runPhase: "implementation",
        runId: "run-latest",
        activeRunId: "run-latest",
        manualDispatch: { stage: "worker", ignoreState: true },
        cancellationRequestedAt: new Date("2026-01-01T00:02:00.000Z"),
      },
      running: true,
      claimed: true,
      paused: true,
      retrying: true,
      retryDueAt: "2026-01-01T00:00:06.000Z",
    });

    expect(current).toMatchObject({
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      title: "Implement builder",
      priority: 2,
      trackerState: "Blocked",
      branchName: "feature/test-1",
      assignedToWorker: true,
      labels: ["planning"],
      blocks: [{ id: "next-1", identifier: "TEST-2", state: "Todo" }],
      blockedBy: [{ id: "dep-1", identifier: "TEST-0", state: "Todo" }],
      hasChildren: true,
      phase: "blocked",
      reviewRound: 2,
      incompleteTurnCount: 3,
      planningFailureCount: 1,
      planningDispatchRetryCount: 2,
      blockedReason: "max incomplete turns reached (3/3)",
      latestRunId: "run-latest",
      latestRunStatus: "failed",
      latestRunRole: "worker",
      latestRunPhase: "implementation",
      latestPrNumber: 7,
      latestPrHeadSha: "abc123",
      latestWorkspaceKey: "wk-1",
      latestGitBranchName: "feature/test-1",
      lifecyclePersistenceAvailable: true,
      running: true,
      runningRole: "worker",
      runningRunPhase: "implementation",
      runningRunKind: "implementation",
      runningManualDispatchStage: "worker",
      runningManualIgnoreState: true,
      runningCancellationRequested: true,
      claimed: true,
      paused: true,
      retrying: true,
      runtimeRetryDueAt: "2026-01-01T00:00:06.000Z",
      consecutiveSdkErrorFailures: 2,
    });
    expect(current.planningRetryDueAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("builds full immutable snapshot trigger fields and preserves candidate source metadata", async () => {
    const builder = new IssueCurrentStateBuilder({
      config: builderConfig(root),
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: new MemoryIssueStateStore(),
      logger: silentLogger(),
    });
    const snapshot = await builder.buildSnapshot(
      issueFixture(),
      emptyRuntime(),
      {
        triggerType: "orchestrator.tick",
        triggerSource: "orchestrator",
        candidateSource: "worker_candidates",
        transitionRequestContext: null,
        availableSlots: 3,
        providerDispatchGateActive: false,
        stateSlotAvailable: true,
        allowExistingClaim: true,
        manualStage: null,
        manualForceLabels: false,
        manualIgnoreState: false,
        snapshotPatch: {
          manualStage: "worker",
          manualForceLabels: true,
        },
      },
    );

    expect(snapshot).toMatchObject({
      triggerType: "orchestrator.tick",
      triggerSource: "orchestrator",
      candidateSource: "worker_candidates",
      availableSlots: 3,
      providerDispatchGateActive: false,
      stateSlotAvailable: true,
      allowExistingClaim: true,
      manualStage: "worker",
      manualForceLabels: true,
      manualIgnoreState: false,
    });
    expect(snapshot.snapshotId).toMatch(/^issue-snapshot:/);
    expect(snapshot.triggerId).toMatch(/^orchestrator\.tick:/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.labels)).toBe(true);
    expect("current" in snapshot).toBe(false);
  });

  it("does not read issue history during default snapshot builds", async () => {
    const issueStateStore = new MemoryIssueStateStore();
    issueStateStore.getHistory = async () => {
      throw new Error("history should not be read");
    };
    const builder = new IssueCurrentStateBuilder({
      config: builderConfig(root),
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore,
      logger: silentLogger(),
    });

    const snapshot = await builder.buildSnapshot(
      issueFixture(),
      emptyRuntime(),
      {
        triggerType: "orchestrator.tick",
        triggerSource: "orchestrator",
        candidateSource: "tick_candidates",
        transitionRequestContext: null,
        availableSlots: 1,
        providerDispatchGateActive: false,
        stateSlotAvailable: true,
        allowExistingClaim: false,
        manualStage: null,
        manualForceLabels: false,
        manualIgnoreState: false,
      },
    );

    expect(snapshot.candidateSource).toBe("tick_candidates");
    expect(issueStateStore.getHistoryCalls).toBe(0);
  });

  it("reuses a fresh merge policy observation from current state", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({
      state: "Ready to Merge",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
      lastCompletionReportId: "completion-1",
      lastReviewVerdictId: "verdict-1",
      completionReports: [
        {
          id: "completion-1",
          idempotencyKey: "completion-1",
          runId: "run-1",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          summary: "Done",
          validationEvidence: [],
          acceptanceChecklist: [],
          changedFiles: [],
          branchName: "feature/test-1",
          risks: [],
          pullRequest: {
            url: "https://github.test/acme/repo/pull/7",
            number: 7,
            headSha: "abc123",
            branch: "feature/test-1",
          },
          acceptedAt: "2026-01-01T00:00:01.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewVerdicts: [
        {
          id: "verdict-1",
          idempotencyKey: "verdict-1",
          runId: "review-run-1",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          verdict: "pass",
          acceptanceResults: [],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: [],
          reviewer: null,
          submittedAt: "2026-01-01T00:00:02.000Z",
          writebackOperationKeys: [],
        },
      ],
    });
    const historyStore = new MemoryIssueStateStore();
    const builderWithoutHistory = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const withoutObservation = await builderWithoutHistory.build(
      issue,
      emptyRuntime(),
    );
    const observation = {
      version: 1,
      status: "ready",
      inputFingerprint:
        withoutObservation.currentMergePolicyObservationInputFingerprint,
      observedAt: "2026-01-01T00:00:03.000Z",
      observationKind: "checks_pending",
      nextTransitionKind: "merge_policy_observe_checks_pending",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      configFingerprint: withoutObservation.mergePolicyConfigFingerprint,
      serviceMergeLogin: null,
      gate: lifecycle.mergeGate,
    };
    historyStore.record = {
      ...withoutObservation,
      lastMergePolicyObservationFingerprint: observation.inputFingerprint,
      lastMergePolicyObservationStatus: observation.status,
      lastMergePolicyObservation:
        observation as unknown as IssueCurrentFields["lastMergePolicyObservation"],
      history: [],
    };

    const withObservation = await builderWithoutHistory.build(
      issue,
      emptyRuntime(),
    );

    expect(withObservation.lastMergePolicyObservationFingerprint).toBe(
      withoutObservation.currentMergePolicyObservationInputFingerprint,
    );
    expect(withObservation.lastMergePolicyObservationStatus).toBe("ready");
    expect(withObservation.lastMergePolicyObservation).toMatchObject({
      inputFingerprint:
        withoutObservation.currentMergePolicyObservationInputFingerprint,
      observationKind: "checks_pending",
    });

    await lifecycleStore.updateIssue(issue, {
      baseRefObservation: baseRefObservationFixture({
        checkedAt: "2026-01-01T00:00:04.000Z",
      }),
    });
    const afterBaseRefEvidence = await builderWithoutHistory.build(
      issue,
      emptyRuntime(),
    );
    expect(
      afterBaseRefEvidence.currentMergePolicyObservationInputFingerprint,
    ).toBe(withoutObservation.currentMergePolicyObservationInputFingerprint);
    expect(afterBaseRefEvidence.lastMergePolicyObservation).toMatchObject({
      inputFingerprint:
        withoutObservation.currentMergePolicyObservationInputFingerprint,
      observationKind: "checks_pending",
    });

    await lifecycleStore.updateIssue(issue, {
      summaryPointers: {
        lastPushedAt: "2026-01-01T00:00:05.000Z",
        lastEvidenceCursor: "publication-cursor-2",
      },
    });
    const afterPublicationEvidenceCursor = await builderWithoutHistory.build(
      issue,
      emptyRuntime(),
    );
    expect(
      afterPublicationEvidenceCursor.currentMergePolicyObservationInputFingerprint,
    ).toBe(withoutObservation.currentMergePolicyObservationInputFingerprint);
    expect(
      afterPublicationEvidenceCursor.lastMergePolicyObservation,
    ).toMatchObject({
      inputFingerprint:
        withoutObservation.currentMergePolicyObservationInputFingerprint,
      observationKind: "checks_pending",
    });

    await lifecycleStore.updateIssue(issue, {
      summaryPointers: { prHeadSha: "def456" },
    });
    const afterPrHeadChange = await builderWithoutHistory.build(
      issue,
      emptyRuntime(),
    );
    expect(
      afterPrHeadChange.currentMergePolicyObservationInputFingerprint,
    ).not.toBe(withoutObservation.currentMergePolicyObservationInputFingerprint);
    expect(afterPrHeadChange.lastMergePolicyObservation).toBeNull();
  });

  it("can build tracker fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const liveIssue = issueFixture({
      title: "Live title",
      state: "In Progress",
      labels: ["live"],
      priority: 1,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const observedIssue = issueFixture({
      title: "Observed title",
      description: "Observed body",
      state: "Todo",
      labels: ["observed"],
      priority: 2,
      branchName: "feature/observed",
      assigneeId: "worker-2",
      delegateId: "delegate-1",
      assignedToWorker: false,
      blocks: [{ id: "next-1", identifier: "TEST-2", state: "In Progress" }],
      blockedBy: [{ id: "dep-1", identifier: "TEST-0", state: "Todo" }],
      hasChildren: true,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const liveCurrent = await storeBuilder.build(liveIssue, emptyRuntime());
    historyStore.record = {
      ...liveCurrent,
      history: [trackerEvidenceSnapshot(liveCurrent, observedIssue)],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["tracker"],
      compareHistoryBackedFieldGroups: ["tracker"],
    });

    const current = await historyBackedBuilder.build(liveIssue, emptyRuntime());

    expect(current).toMatchObject({
      title: "Observed title",
      description: "Observed body",
      trackerState: "Todo",
      labels: ["observed"],
      priority: 2,
      branchName: "feature/observed",
      assigneeId: "worker-2",
      delegateId: "delegate-1",
      assignedToWorker: false,
      blocks: [{ id: "next-1", identifier: "TEST-2", state: "In Progress" }],
      blockedBy: [{ id: "dep-1", identifier: "TEST-0", state: "Todo" }],
      hasChildren: true,
      trackerUpdatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(current.currentIssueContentFingerprint).not.toBe(
      liveCurrent.currentIssueContentFingerprint,
    );
  });

  it("logs a fallback when configured history-backed fields have malformed evidence", async () => {
    const config = builderConfig(root);
    const historyStore = new MemoryIssueStateStore();
    const warnings: Array<{
      message: string;
      fields: Record<string, unknown> | undefined;
    }> = [];
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const liveIssue = issueFixture({
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    const malformedObservedIssue = issueFixture({ title: "Malformed title" });
    const liveCurrent = await storeBuilder.build(liveIssue, emptyRuntime());
    const malformedSnapshot = {
      ...trackerEvidenceSnapshot(liveCurrent, malformedObservedIssue),
      observedLabels: null,
    } as IssueHistorySnapshot;
    historyStore.record = {
      ...liveCurrent,
      history: [malformedSnapshot],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: {
        warn: (message, fields) => warnings.push({ message, fields }),
      },
      historyBackedFieldGroups: ["tracker"],
    });

    const current = await historyBackedBuilder.build(liveIssue, emptyRuntime());

    expect(current.title).toBe("Implement builder");
    expect(warnings).toEqual([
      {
        message: "issue current-state history-backed field group fallback",
        fields: {
          issue_id: "issue-1",
          issue_identifier: "TEST-1",
          field_group: "tracker",
          incomplete_groups: expect.arrayContaining(["tracker"]),
          source_snapshot_ids: ["issue-history:tracker-evidence"],
        },
      },
    ]);
  });

  it("can build latest run summary fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture();
    const historyStore = new MemoryIssueStateStore();
    const runStore = new FileRunTranscriptStore(root);
    await startFailedWorkerRun(
      runStore,
      issue,
      "run-old",
      "2026-01-01T00:00:00.000Z",
    );
    await startFailedWorkerRun(
      runStore,
      issue,
      "run-latest",
      "2026-01-01T00:01:00.000Z",
    );
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    historyStore.record = {
      ...storeCurrent,
      history: [
        ...runEvidenceSnapshots(storeCurrent, {
          runId: "run-old",
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
        ...runEvidenceSnapshots(storeCurrent, {
          runId: "run-latest",
          completedAt: "2026-01-01T00:01:00.000Z",
        }),
      ],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["runSummary"],
      compareHistoryBackedFieldGroups: ["runSummary"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current).toMatchObject({
      latestRunId: "run-latest",
      latestRunStatus: "failed",
      latestRunRole: "worker",
      latestRunPhase: "implementation",
      latestRunKind: "implementation",
      latestRunCompletedAt: "2026-01-01T00:01:00.000Z",
      latestRunError: "sdk failed",
      latestWorkspaceKey: "workspace-run-latest",
      latestWorkspacePath: "/tmp/run-latest",
      consecutiveSdkErrorFailures: 2,
      consecutiveInfraFailures: 0,
    });
  });

  it("can build merge-policy completion run from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Ready to Merge" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const completionReport = {
      id: "completion-1",
      idempotencyKey: "completion-1",
      runId: "run-completion",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      summary: "Done",
      validationEvidence: ["validated"],
      acceptanceChecklist: [],
      changedFiles: ["src/app.ts"],
      branchName: "feature/test-1",
      pullRequest: {
        url: "https://github.test/acme/repo/pull/7",
        number: 7,
        headSha: "abc123",
        branch: "feature/test-1",
      },
      risks: [],
      acceptedAt: "2026-01-01T00:00:03.000Z",
      writebackOperationKeys: [],
    };
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
      lastCompletionReportId: completionReport.id,
      completionReports: [completionReport],
    });
    await runStore.startRun({
      runId: "run-completion",
      sessionId: "session-store",
      agentId: "agent-store",
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: 1,
      turnNumber: 2,
      prompt: "History prompt",
      promptTemplateKeys: ["store-template"],
      harnessId: "store-harness",
      workspaceKey: "workspace-run-completion",
      workspacePath: "/tmp/run-completion",
      gitBranchName: "feature/test-1",
    });
    await runStore.updateRun("run-completion", {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:04.000Z",
      tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    historyStore.record = {
      ...storeCurrent,
      history: [
        lifecycleEvidenceSnapshot(storeCurrent, lifecycle),
        runEvidenceSnapshot(storeCurrent, {
          historySnapshotId: "issue-history:run-completion:started",
          snapshotAt: "2026-01-01T00:00:01.000Z",
          eventType: "run_started",
          runId: "run-completion",
          sessionId: "session-history",
          agentId: "agent-history",
          status: "running",
          role: "worker",
          runPhase: "implementation",
          runKind: "implementation",
          prompt: "History prompt",
          promptCharCount: "History prompt".length,
          startedAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          attempt: 1,
          turnNumber: 2,
          harnessId: "history-harness",
          promptTemplateKeys: ["history-template"],
          workspaceKey: "workspace-run-completion",
          workspacePath: "/tmp/run-completion",
          gitBranchName: "feature/test-1",
        }),
        runEvidenceSnapshot(storeCurrent, {
          historySnapshotId: "issue-history:run-completion:terminal",
          snapshotAt: "2026-01-01T00:00:04.000Z",
          eventType: "run_terminal_state_updated",
          runId: "run-completion",
          sessionId: "session-history",
          agentId: "agent-history",
          status: "succeeded",
          role: "worker",
          runPhase: "implementation",
          runKind: "implementation",
          updatedAt: "2026-01-01T00:00:04.000Z",
          completedAt: "2026-01-01T00:00:04.000Z",
          tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          workspaceKey: "workspace-run-completion",
          workspacePath: "/tmp/run-completion",
          gitBranchName: "feature/test-1",
        }),
      ],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["mergePolicyCompletionRun"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current.mergePolicyLatestCompletionRun).toMatchObject({
      runId: "run-completion",
      sessionId: "session-history",
      agentId: "agent-history",
      status: "succeeded",
      completedAt: "2026-01-01T00:00:04.000Z",
      promptTemplateKeys: ["history-template"],
      harnessId: "history-harness",
      tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  it("can build lifecycle core fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "blocked",
      reviewRound: 2,
      incompleteTurnCount: 3,
      planningFailureCount: 1,
      planningDispatchRetryCount: 2,
      lastPlanningFailureAt: "2026-01-01T00:00:00.000Z",
      blockedReason: "max incomplete turns reached (3/3)",
      lastCompletionReportId: "completion-1",
      lastReviewVerdictId: "verdict-1",
      lastMergeGateResultId: "merge-gate-1",
      summaryPointers: {
        ciStatus: "pending",
      },
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    const historyLifecycle: IssueLifecycleRecord = {
      ...lifecycle,
      reviewRound: 4,
      blockedReason: "history-backed blocked reason",
      lastCompletionReportId: "completion-from-history",
      summaryPointers: {
        ...lifecycle.summaryPointers,
        ciStatus: "success",
      },
    };
    historyStore.record = {
      ...storeCurrent,
      history: [
        trackerEvidenceSnapshot(storeCurrent, issue),
        lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle),
      ],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecycleCore"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current).toMatchObject({
      phase: "blocked",
      reviewRound: 4,
      incompleteTurnCount: 3,
      planningFailureCount: 1,
      planningDispatchRetryCount: 2,
      lastPlanningFailureAt: "2026-01-01T00:00:00.000Z",
      planningRetryDueAt: "2026-01-01T00:00:05.000Z",
      blockedReason: "history-backed blocked reason",
      lastCompletionReportId: "completion-from-history",
      lastReviewVerdictId: "verdict-1",
      lastMergeGateResultId: "merge-gate-1",
      lifecycleSummaryCiStatus: "success",
    });
  });

  it("can build lifecycle report fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "In Review" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const completionReport = {
      id: "completion-1",
      idempotencyKey: "completion-1",
      runId: "worker-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      summary: "Store completion summary",
      validationEvidence: ["store validation"],
      acceptanceChecklist: [],
      changedFiles: ["src/store.ts"],
      branchName: "feature/test-1",
      pullRequest: {
        url: "https://github.test/acme/repo/pull/7",
        number: 7,
        headSha: "abc123",
        branch: "feature/test-1",
      },
      risks: [],
      acceptedAt: "2026-01-01T00:00:01.000Z",
      writebackOperationKeys: [],
    };
    const passVerdict = {
      id: "verdict-1",
      idempotencyKey: "verdict-1",
      runId: "review-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      verdict: "pass" as const,
      acceptanceResults: [],
      findings: [],
      gateFindings: [],
      discoveryFindings: [],
      evidence: ["store evidence"],
      reviewer: "store-reviewer",
      submittedAt: "2026-01-01T00:00:02.000Z",
      writebackOperationKeys: [],
    };
    const artifactEvidence = {
      kind: "expected_red_tests" as const,
      command: "npm test -- artifact.test.ts",
      testFiles: ["tests/artifact.test.ts"],
      expectedFailure: "Implementation is pending.",
      observedFailure: "Expected true, received false.",
      exitCode: 1,
    };
    const acceptedArtifact = {
      version: 1 as const,
      id: "artifact-store",
      kind: "expected_red_tests" as const,
      status: "checkpointed" as const,
      sourceIssueId: issue.id,
      sourceIssueIdentifier: issue.identifier,
      contractFingerprint: "contract-fingerprint",
      completionReportId: completionReport.id,
      reviewVerdictId: passVerdict.id,
      reviewFeedbackId: "feedback-1",
      repositoryFingerprint: "repository-fingerprint",
      pullRequest: completionReport.pullRequest,
      sourceBaseHeadSha: "base-head-sha",
      sourceHeadSha: "source-head-sha",
      baseRef: "origin/main",
      changedFiles: ["tests/artifact.test.ts"],
      fileManifest: [
        {
          path: "tests/artifact.test.ts",
          status: "added" as const,
          blobSha: "blob-sha",
        },
      ],
      artifactEvidence,
      commentOperationKey: "comment:artifact-store",
      doneTransitionOperationKey: "transition:artifact-store:done",
      acceptedAt: "2026-01-01T00:00:03.000Z",
      checkpointedAt: "2026-01-01T00:00:04.000Z",
      prClosedAt: null,
      completedAt: null,
    };
    const workspaceSeed = {
      version: 1 as const,
      id: "seed-store",
      kind: "accepted_artifact" as const,
      status: "planned" as const,
      artifactId: acceptedArtifact.id,
      sourceIssueId: issue.id,
      sourceIssueIdentifier: issue.identifier,
      repositoryFingerprint: "repository-fingerprint",
      sourceBranch: "feature/test-1",
      sourceHeadSha: "source-head-sha",
      sourceBaseHeadSha: "base-head-sha",
      configuredBaseRef: "origin/main",
      preparedBaseHeadSha: null,
      preparedHeadSha: null,
      targetBranch: "feature/test-2",
      conflictedFiles: [],
      plannedAt: "2026-01-01T00:00:05.000Z",
      preparedAt: null,
      failureReason: null,
    };
    const acceptedArtifactValidationFailure = {
      version: 1 as const,
      count: 1,
      limit: 3,
      category: "contract_or_head_drift" as const,
      reason: "source_checkpoint_drift" as const,
      signature: "store-failure-signature",
      message: "Store checkpoint drift",
      firstFailedAt: "2026-01-01T00:00:08.000Z",
      lastFailedAt: "2026-01-01T00:00:08.000Z",
      completionReportId: completionReport.id,
      reviewVerdictId: passVerdict.id,
      liveContractFingerprint: "live-contract",
      reviewedContractFingerprint: "reviewed-contract",
      sourceHeadSha: "source-head-sha",
    };
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
      lastCompletionReportId: completionReport.id,
      lastReviewVerdictId: passVerdict.id,
      completionReports: [completionReport],
      reviewVerdicts: [passVerdict],
      acceptedArtifact,
      acceptedArtifactValidationFailure,
      workspaceSeed,
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    expect(storeCurrent.acceptedArtifact).toMatchObject({ id: "artifact-store" });
    expect(storeCurrent.acceptedArtifactValidationFailure).toMatchObject({
      count: 1,
      signature: "store-failure-signature",
    });
    expect(storeCurrent.workspaceSeed).toMatchObject({ id: "seed-store", status: "planned" });
    const historyCompletionReport = {
      ...completionReport,
      summary: "History completion summary",
      validationEvidence: ["history validation"],
      changedFiles: ["src/history.ts"],
    };
    const historyPassVerdict = {
      ...passVerdict,
      evidence: ["history evidence"],
      reviewer: "history-reviewer",
    };
    const historyLifecycle: IssueLifecycleRecord = {
      ...lifecycle,
      completionReports: [historyCompletionReport],
      reviewVerdicts: [historyPassVerdict],
      acceptedArtifact: {
        ...acceptedArtifact,
        id: "artifact-history",
        status: "completed_unmerged",
        completedAt: "2026-01-01T00:00:06.000Z",
      },
      acceptedArtifactValidationFailure: {
        ...acceptedArtifactValidationFailure,
        count: 2,
        message: "History checkpoint drift",
        lastFailedAt: "2026-01-01T00:00:09.000Z",
      },
      workspaceSeed: {
        ...workspaceSeed,
        id: "seed-history",
        status: "prepared",
        preparedBaseHeadSha: "live-base-sha",
        preparedHeadSha: "prepared-head-sha",
        preparedAt: "2026-01-01T00:00:07.000Z",
      },
    };
    historyStore.record = {
      ...storeCurrent,
      history: [
        trackerEvidenceSnapshot(storeCurrent, issue),
        lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle),
      ],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecycleReports"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current.latestCompletionReport).toMatchObject({
      id: "completion-1",
      summary: "History completion summary",
      validationEvidence: ["history validation"],
      changedFiles: ["src/history.ts"],
    });
    expect(current.mergePolicyLatestCompletionReport).toMatchObject({
      id: "completion-1",
      summary: "History completion summary",
    });
    expect(current.latestApprovalPassVerdict).toMatchObject({
      id: "verdict-1",
      evidence: ["history evidence"],
      reviewer: "history-reviewer",
    });
    expect(current.mergePolicyLatestApprovalVerdict).toMatchObject({
      id: "verdict-1",
      reviewer: "history-reviewer",
    });
    expect(current.acceptedArtifact).toMatchObject({
      id: "artifact-history",
      status: "completed_unmerged",
    });
    expect(current.acceptedArtifactValidationFailure).toMatchObject({
      count: 2,
      signature: "store-failure-signature",
      message: "History checkpoint drift",
    });
    expect(current.workspaceSeed).toMatchObject({
      id: "seed-history",
      status: "prepared",
      preparedHeadSha: "prepared-head-sha",
    });
  });

  it("can build lifecycle publication approval fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const completionReport = {
      id: "completion-approval-1",
      idempotencyKey: "completion-approval-1",
      runId: "worker-run-approval-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      summary: "Ready for publication approval",
      validationEvidence: ["validated"],
      acceptanceChecklist: [],
      changedFiles: ["src/app.ts"],
      branchName: "feature/test-1",
      pullRequest: {
        url: "https://github.test/acme/repo/pull/7",
        number: 7,
        headSha: "abc123",
        branch: "feature/test-1",
      },
      risks: [],
      acceptedAt: "2026-01-01T00:00:01.000Z",
      writebackOperationKeys: [],
    };
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: completionReport.id,
      completionReports: [completionReport],
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    historyStore.record = {
      ...storeCurrent,
      history: [lifecycleEvidenceSnapshot(storeCurrent, lifecycle)],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecyclePublication"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current.pendingPublicationApprovalRunId).toBe(
      "worker-run-approval-1",
    );
    expect(current.pendingPublicationApprovalReportId).toBe(
      "completion-approval-1",
    );
    expect(current.pendingPublicationApprovalReason).toBe(
      PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
    );
  });

  it("can build lifecycle merge-policy fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Ready to Merge" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const pullRequest = {
      url: "https://github.test/acme/repo/pull/7",
      number: 7,
      headSha: "abc123",
      branch: "feature/test-1",
    };
    const mergeGate = {
      id: "merge-gate-1",
      status: "observing" as const,
      headSha: "abc123",
      pullRequest,
      requiredChecks: ["ci/test"],
      checks: [],
      mergeability: null,
      reviewRound: 2,
      gateRunId: null,
      gateReportId: null,
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
      writebackOperationKeys: [],
      supersededByHeadSha: null,
      updatedAt: "2026-01-01T00:00:03.000Z",
    };
    const mergeGateResult = {
      id: "merge-gate-result-1",
      idempotencyKey: "merge-gate-result-1",
      runId: "gate-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      status: "blocked" as const,
      headSha: "abc123",
      pullRequest,
      requiredChecks: ["ci/test"],
      checks: [],
      mergeability: null,
      reviewRound: 2,
      blockerFingerprint: "blocker-1",
      findings: ["store finding"],
      evidence: ["store evidence"],
      submittedAt: "2026-01-01T00:00:04.000Z",
      writebackOperationKeys: [],
    };
    const merge = {
      id: "merge-1",
      pullRequest,
      headSha: "abc123",
      mergeCommitSha: "store-merge-sha",
      mergedAt: "2026-01-01T00:00:05.000Z",
      mergedBy: {
        login: null,
        profile: null,
        capability: "github.merge" as const,
      },
      checkStatus: {
        requiredChecks: ["ci/test"],
        passedChecks: ["ci/test"],
        noCiEvidence: null,
      },
      mergeOperationKey: "merge-op-1",
      doneTransitionOperationKey: "done-op-1",
    };
    const reviewFeedback = {
      id: "feedback-1",
      idempotencyKey: "feedback-1",
      requestHash: "feedback-hash",
      runId: "review-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      kind: "review" as const,
      event: "APPROVE" as const,
      body: "Store feedback",
      pullRequest,
      reviewer: "store-reviewer",
      reviewUrl: null,
      commentUrls: [],
      submittedAt: "2026-01-01T00:00:06.000Z",
    };
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
      mergeGate,
      mergeGateResults: [mergeGateResult],
      merge,
      reviewFeedback: [reviewFeedback],
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    const historyLifecycle: IssueLifecycleRecord = {
      ...lifecycle,
      mergeGate: {
        ...mergeGate,
        status: "blocked" as const,
        blockerFingerprint: "history-blocker",
      },
      mergeGateResults: [
        {
          ...mergeGateResult,
          findings: ["history finding"],
          evidence: ["history evidence"],
        },
      ],
      merge: {
        ...merge,
        mergeCommitSha: "history-merge-sha",
      },
      reviewFeedback: [
        {
          ...reviewFeedback,
          body: "History feedback",
          reviewer: "history-reviewer",
        },
      ],
    };
    historyStore.record = {
      ...storeCurrent,
      history: [lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle)],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecycleMergePolicy"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current.mergeGate).toMatchObject({
      id: "merge-gate-1",
      status: "blocked",
      blockerFingerprint: "history-blocker",
    });
    expect(current.mergePolicyMergeGate).toMatchObject({
      id: "merge-gate-1",
      status: "blocked",
    });
    expect(current.mergePolicyMergeGateResults).toMatchObject([
      {
        id: "merge-gate-result-1",
        findings: ["history finding"],
        evidence: ["history evidence"],
      },
    ]);
    expect(current.mergePolicyMerge).toMatchObject({
      id: "merge-1",
      mergeCommitSha: "history-merge-sha",
    });
    expect(current.mergePolicyReviewFeedback).toMatchObject([
      {
        id: "feedback-1",
        body: "History feedback",
        reviewer: "history-reviewer",
      },
    ]);
  });

  it("can build lifecycle breakdown fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ labels: ["planning"] });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const plan = {
      id: "breakdown-plan-1",
      idempotencyKey: "breakdown-plan-1",
      requestHash: "request-hash-1",
      runId: "planner-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      summary: "Split the work",
      proposedIssues: [
        {
          title: "Child issue",
          description: "Child body",
          acceptanceCriteria: ["Works"],
          dependencies: [],
          labels: ["child"],
        },
      ],
      transcriptPointers: [],
      statusApiPointers: [],
      issueUpdatedAt: issue.updatedAt,
      issueContentFingerprint: "store-issue-fingerprint",
      configFingerprint: "store-config-fingerprint",
      cursorMode: "none",
      acceptedAt: "2026-01-01T00:00:01.000Z",
      applicationStatus: "not_requested" as const,
      applicationOperationKeys: [],
      createdIssueRefs: [],
      appliedAt: null,
      applicationBlockedReason: null,
    };
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "implementation",
      lastIssueBreakdownPlanId: plan.id,
      issueBreakdownPlans: [plan],
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    const historyLifecycle: IssueLifecycleRecord = {
      ...lifecycle,
      issueBreakdownPlans: [
        {
          ...plan,
          issueContentFingerprint: "history-issue-fingerprint",
          configFingerprint: "history-config-fingerprint",
          applicationStatus: "applied" as const,
          applicationOperationKeys: ["history-apply-op"],
          appliedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };
    historyStore.record = {
      ...storeCurrent,
      history: [lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle)],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecycleBreakdown"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current).toMatchObject({
      lastIssueBreakdownPlanId: "breakdown-plan-1",
      lastIssueBreakdownPlanApplicationStatus: "applied",
      lastIssueBreakdownPlanIssueContentFingerprint:
        "history-issue-fingerprint",
      lastIssueBreakdownPlanConfigFingerprint: "history-config-fingerprint",
      lastIssueBreakdownPlanSatisfiesCurrentValidation: false,
    });
  });

  it("can build lifecycle triage fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    await lifecycleStore.ensureIssue(issue, {
      phase: "blocked",
      blockedReason: "max review rounds reached",
      reviewRound: 4,
      incompleteTurnCount: 2,
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const baseCurrent = await storeBuilder.build(issue, emptyRuntime());
    const triageFingerprint = baseCurrent.currentIssueTriageTriggerFingerprint;
    if (triageFingerprint === null) {
      throw new Error("missing triage fingerprint");
    }
    const triageBlocker = {
      kind: "implementation_unsatisfied_requirements" as const,
      status: "active" as const,
      nextActor: "worker" as const,
      confidence: "high" as const,
      summary: "Store blocker",
      evidence: ["store blocker evidence"],
      recommendedAction: "Store blocker action",
    };
    const report = {
      id: "triage-report-1",
      idempotencyKey: "triage-report-1",
      requestHash: "triage-hash-1",
      runId: "triage-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      triggerFingerprint: triageFingerprint,
      disposition: "implementation_repair" as const,
      confidence: "high" as const,
      summary: "Store triage summary",
      evidence: ["store evidence"],
      recommendedAction: "Store action",
      blockers: [triageBlocker],
      submittedAt: "2026-01-01T00:00:01.000Z",
      writebackOperationKeys: ["store-triage-writeback"],
    };
    const lifecycle = await lifecycleStore.updateIssue(issue, {
      lastIssueTriageReportId: report.id,
      issueTriageReports: [report],
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    const historyLifecycle: IssueLifecycleRecord = {
      ...lifecycle,
      issueTriageReports: [
        {
          ...report,
          blockers: [
            {
              ...triageBlocker,
              summary: "History blocker",
              evidence: ["history blocker evidence"],
              recommendedAction: "History blocker action",
            },
          ],
          writebackOperationKeys: ["history-triage-writeback"],
        },
      ],
    };
    historyStore.record = {
      ...storeCurrent,
      history: [lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle)],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecycleTriage"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current).toMatchObject({
      lastIssueTriageReportId: "triage-report-1",
      lastIssueTriageReportTriggerFingerprint: triageFingerprint,
      lastIssueTriageReportWritebackOperationKeys: ["history-triage-writeback"],
      lastIssueTriageRecoveryDisposition: null,
      currentIssueTriageTriggerFingerprint: triageFingerprint,
      issueTriageCurrentTriggerReportIds: [],
      latestIssueTriageReportBlockers: [
        {
          summary: "History blocker",
          evidence: ["history blocker evidence"],
          recommendedAction: "History blocker action",
        },
      ],
    });
  });

  it("does not expose triage blockers from a stale trigger", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const initial = await lifecycleStore.ensureIssue(issue, {
      phase: "blocked",
      blockedReason: "old review blocker",
      reviewRound: 1,
    });
    const staleFingerprint = issueTriageTriggerFingerprint(initial);
    const staleReport = {
      id: "triage-report-stale",
      idempotencyKey: "triage-report-stale",
      requestHash: "triage-hash-stale",
      runId: "triage-run-stale",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      triggerFingerprint: staleFingerprint,
      disposition: "decompose_issue" as const,
      confidence: "high" as const,
      summary: "Old decomposition recommendation",
      evidence: ["old blocker evidence"],
      recommendedAction: "Decompose the old blocker",
      blockers: [
        {
          kind: "under_specified_needs_decomposition" as const,
          status: "active" as const,
          nextActor: "planner" as const,
          confidence: "high" as const,
          summary: "Old decomposition recommendation",
          evidence: ["old blocker evidence"],
          recommendedAction: "Decompose the old blocker",
        },
      ],
      submittedAt: "2026-01-01T00:00:01.000Z",
      writebackOperationKeys: [],
    };
    await lifecycleStore.updateIssue(issue, {
      lastIssueTriageReportId: staleReport.id,
      issueTriageReports: [staleReport],
    });
    const currentLifecycle = await lifecycleStore.updateIssue(issue, {
      blockedReason: "new review blocker",
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });

    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());

    expect(storeCurrent.currentIssueTriageTriggerFingerprint).not.toBe(
      staleFingerprint,
    );
    expect(storeCurrent.issueTriageCurrentTriggerReportIds).toEqual([]);
    expect(storeCurrent.latestIssueTriageReportBlockers).toEqual([]);

    historyStore.record = {
      ...storeCurrent,
      history: [lifecycleEvidenceSnapshot(storeCurrent, currentLifecycle)],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecycleTriage"],
    });

    const historyCurrent = await historyBackedBuilder.build(
      issue,
      emptyRuntime(),
    );

    expect(historyCurrent.currentIssueTriageTriggerFingerprint).not.toBe(
      staleFingerprint,
    );
    expect(historyCurrent.issueTriageCurrentTriggerReportIds).toEqual([]);
    expect(historyCurrent.latestIssueTriageReportBlockers).toEqual([]);
  });

  it("can build lifecycle post-mortem fields from typed history evidence", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({ state: "Done" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const completionReport = {
      id: "completion-1",
      idempotencyKey: "completion-1",
      runId: "worker-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      summary: "Done",
      validationEvidence: ["validated"],
      acceptanceChecklist: [],
      changedFiles: ["src/app.ts"],
      branchName: "feature/test-1",
      pullRequest: null,
      risks: [],
      acceptedAt: "2026-01-01T00:00:01.000Z",
      writebackOperationKeys: [],
    };
    const passVerdict = {
      id: "verdict-1",
      idempotencyKey: "verdict-1",
      runId: "review-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      verdict: "pass" as const,
      acceptanceResults: [],
      findings: [],
      gateFindings: [],
      discoveryFindings: [],
      evidence: ["approved"],
      reviewer: null,
      submittedAt: "2026-01-01T00:00:02.000Z",
      writebackOperationKeys: [],
    };
    await lifecycleStore.ensureIssue(issue, {
      phase: "terminal",
      lastCompletionReportId: completionReport.id,
      lastReviewVerdictId: passVerdict.id,
      completionReports: [completionReport],
      reviewVerdicts: [passVerdict],
    });
    const historyStore = new MemoryIssueStateStore();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
    });
    const baseCurrent = await storeBuilder.build(issue, emptyRuntime());
    const postMortemFingerprint =
      baseCurrent.currentPostMortemTriggerFingerprint;
    if (postMortemFingerprint === null) {
      throw new Error("missing post-mortem fingerprint");
    }
    const report = {
      id: "post-mortem-1",
      idempotencyKey: "post-mortem-1",
      requestHash: "post-mortem-hash-1",
      runId: "post-mortem-run-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      triggerFingerprint: postMortemFingerprint,
      summary: "Store post-mortem summary",
      completionJudgment: {
        status: "valid_done" as const,
        rationale: "Done cleanly",
      },
      specificationAssessment: {
        quality: "adequate" as const,
        classifications: ["well_scoped" as const],
        missingContractAreas: [],
        speckitRecommended: false,
        speckitRationale: "No follow-up needed",
      },
      reviewAssessment: {
        gateDecisionLooksValid: true,
        missedGateFindings: [],
        missedDiscoveryFindings: [],
      },
      followUpCandidates: [],
      processLessons: ["store lesson"],
      submittedAt: "2026-01-01T00:00:03.000Z",
      writebackOperationKeys: ["store-post-mortem-writeback"],
    };
    const lifecycle = await lifecycleStore.updateIssue(issue, {
      lastPostMortemReportId: report.id,
      postMortemReports: [report],
    });
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
    const historyLifecycle: IssueLifecycleRecord = {
      ...lifecycle,
      postMortemReports: [
        {
          ...report,
          summary: "History post-mortem summary",
          processLessons: ["history lesson"],
          writebackOperationKeys: ["history-post-mortem-writeback"],
        },
      ],
    };
    historyStore.record = {
      ...storeCurrent,
      history: [
        trackerEvidenceSnapshot(storeCurrent, issue),
        lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle),
      ],
    };
    const historyBackedBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: historyStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["lifecyclePostMortem"],
    });

    const current = await historyBackedBuilder.build(issue, emptyRuntime());

    expect(current).toMatchObject({
      lastPostMortemReportId: "post-mortem-1",
      lastPostMortemReportTriggerFingerprint: postMortemFingerprint,
      lastPostMortemReportWritebackOperationKeys: [
        "history-post-mortem-writeback",
      ],
      currentPostMortemTriggerFingerprint: postMortemFingerprint,
      postMortemCurrentTriggerReportIds: ["post-mortem-1"],
    });
  });

  it("rebuilds history-backed fields from issue history when cached current state is stale", async () => {
    const config = builderConfig(root);
    const issue = issueFixture({
      state: "Ready to Merge",
      updatedAt: "2026-01-01T00:00:10.000Z",
    });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const completionReport = {
      id: "completion-cache-1",
      idempotencyKey: "completion-cache-1",
      runId: "run-cache-1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      summary: "Done",
      validationEvidence: ["validated"],
      acceptanceChecklist: [],
      changedFiles: ["src/cache.ts"],
      branchName: "feature/cache",
      pullRequest: null,
      risks: [],
      acceptedAt: "2026-01-01T00:00:03.000Z",
      writebackOperationKeys: [],
    };
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
      lastCompletionReportId: completionReport.id,
      completionReports: [completionReport],
    });
    await startStoredRun(runStore, issue, {
      runId: "run-cache-1",
      status: "succeeded",
      completedAt: "2026-01-01T00:00:04.000Z",
      gitBranchName: "feature/cache",
    });
    const stateStore = new SqliteIssueStateStore(root);
    try {
      const storeBuilder = new IssueCurrentStateBuilder({
        config,
        lifecycleStore,
        runStore,
        issueStateStore: stateStore,
        logger: silentLogger(),
      });
      const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
      await stateStore.ensureIssue(storeCurrent);
      for (const snapshot of [
        trackerEvidenceSnapshot(storeCurrent, issue),
        lifecycleEvidenceSnapshot(storeCurrent, lifecycle),
        ...runEvidenceSnapshots(storeCurrent, {
          runId: "run-cache-1",
          status: "succeeded",
          completedAt: "2026-01-01T00:00:04.000Z",
          gitBranchName: "feature/cache",
        }),
      ]) {
        await stateStore.appendSnapshot(issue, snapshot);
      }
      await stateStore.updateCurrent(issue, {
        title: "stale cached title",
        phase: "blocked",
        latestRunStatus: "failed",
        latestCompletionReport: null,
        mergePolicyLatestCompletionReport: null,
      });
      const historyBuilder = new IssueCurrentStateBuilder({
        config,
        lifecycleStore,
        runStore,
        issueStateStore: stateStore,
        logger: silentLogger(),
        historyBackedFieldGroups: HISTORY_BACKED_FIELD_GROUPS,
      });

      const current = await historyBuilder.build(issue, emptyRuntime());
      const rebuilt = await historyBuilder.rebuildHistoryBackedFields(
        issue,
        emptyRuntime(),
      );

      expect(current.title).toBe("Implement builder");
      expect(current.phase).toBe("passed");
      expect(current.latestRunStatus).toBe("succeeded");
      expect(current.latestCompletionReport).toMatchObject({
        id: "completion-cache-1",
      });
      expectHistoryRebuildMatchesCurrent(current, rebuilt);
    } finally {
      await stateStore.close();
    }
  });

  it("rebuilds history-backed fields without parsing cached sqlite current_json", async () => {
    const config = builderConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const issue = issueFixture({
      title: "Implement history rebuild",
      state: "In Review",
      branchName: "feature/history-rebuild",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    const completionReport = completionReportFixture(
      issue,
      "run-history-rebuild",
      {
        id: "completion-history-rebuild",
        branchName: "feature/history-rebuild",
        acceptedAt: "2026-01-01T00:00:03.000Z",
      },
    );
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
      lastCompletionReportId: completionReport.id,
      completionReports: [completionReport],
    });
    await startStoredRun(runStore, issue, {
      runId: "run-history-rebuild",
      status: "succeeded",
      completedAt: "2026-01-01T00:00:04.000Z",
      gitBranchName: "feature/history-rebuild",
    });
    const stateStore = new SqliteIssueStateStore(root);
    try {
      const storeBuilder = new IssueCurrentStateBuilder({
        config,
        lifecycleStore,
        runStore,
        issueStateStore: stateStore,
        logger: silentLogger(),
      });
      const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
      await stateStore.ensureIssue(storeCurrent);
      for (const snapshot of [
        trackerEvidenceSnapshot(storeCurrent, issue),
        lifecycleEvidenceSnapshot(storeCurrent, lifecycle),
        ...runEvidenceSnapshots(storeCurrent, {
          runId: "run-history-rebuild",
          status: "succeeded",
          completedAt: "2026-01-01T00:00:04.000Z",
          gitBranchName: "feature/history-rebuild",
        }),
      ]) {
        await stateStore.appendSnapshot(issue, snapshot);
      }
    } finally {
      await stateStore.close();
    }

    await updateSqliteCurrentJson(
      path.join(root, "issue-state.sqlite"),
      issue.id,
      "{not valid json",
    );
    const historyStore = new SqliteIssueStateStore(root);
    try {
      const historyBuilder = new IssueCurrentStateBuilder({
        config,
        lifecycleStore,
        runStore,
        issueStateStore: historyStore,
        logger: silentLogger(),
        historyBackedFieldGroups: HISTORY_BACKED_FIELD_GROUPS,
      });

      const current = await historyBuilder.build(issue, emptyRuntime());
      const rebuilt = await historyBuilder.rebuildHistoryBackedFields(
        issue,
        emptyRuntime(),
      );
      const directRebuilt =
        await historyBuilder.rebuildHistoryBackedFieldsFromStoredHistory(
          issue.id,
          [
            "tracker",
            "lifecycleCore",
            "lifecycleReports",
            "runSummary",
            "mergePolicyCompletionRun",
          ],
        );

      expect(current).toMatchObject({
        title: "Implement history rebuild",
        phase: "passed",
        latestRunStatus: "succeeded",
        latestCompletionReport: { id: "completion-history-rebuild" },
      });
      expectHistoryRebuildMatchesCurrent(current, rebuilt);
      expect(directRebuilt.incompleteGroups).toEqual([]);
      expect(directRebuilt.fields).toMatchObject({
        title: "Implement history rebuild",
        phase: "passed",
        latestRunStatus: "succeeded",
        latestCompletionReport: { id: "completion-history-rebuild" },
        mergePolicyLatestCompletionRun: { runId: "run-history-rebuild" },
      });
    } finally {
      await historyStore.close();
    }
  });

  it("does not restore superseded accepted-artifact completion evidence from lifecycle history", async () => {
    const config = builderConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const issue = issueFixture({
      state: "In Progress",
      branchName: "feature/reopened-artifact",
    });
    const report = completionReportFixture(issue, "worker-accepted-artifact", {
      id: "completion-accepted-artifact",
      branchName: "feature/reopened-artifact",
      pullRequest: pullRequestFixture({
        branch: "feature/reopened-artifact",
        draft: true,
      }),
      contractSnapshot: {
        schemaVersion: 1,
        contractVersion: "accepted-artifact-review",
        fingerprint: "accepted-artifact-fingerprint",
        delivery: {
          mode: "accepted_artifact",
          artifact: "expected_red_tests",
        },
      },
      supersededAt: "2026-07-14T11:00:00.000Z",
      supersededBy: "accepted_artifact_reopened",
      supersededReason: "The accepted artifact source checkpoint changed.",
    });
    const verdict = reviewVerdictFixture(issue, "review-accepted-artifact", {
      id: "verdict-accepted-artifact",
      verdict: "pass",
      passDisposition: "accepted_artifact",
    });
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "implementation",
      lastCompletionReportId: null,
      lastReviewVerdictId: verdict.id,
      completionReports: [report],
      reviewVerdicts: [verdict],
    });
    const stateStore = new MemoryIssueStateStore();
    const liveBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: stateStore,
      logger: silentLogger(),
    });
    const liveCurrent = await liveBuilder.build(issue, emptyRuntime());
    const recordedHistorySnapshot = lifecycleEvidenceSnapshot(
      liveCurrent,
      lifecycle,
    );
    const staleHistorySnapshot = {
      ...recordedHistorySnapshot,
      lifecycleLatestCompletionReport: report,
      lifecycleLatestApprovalPassVerdict: verdict,
    };
    expect(staleHistorySnapshot.lifecycleLatestCompletionReport).toMatchObject({
      id: report.id,
      supersededAt: report.supersededAt,
    });
    stateStore.record = {
      ...liveCurrent,
      history: [staleHistorySnapshot],
    };
    const historyBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore,
      runStore: undefined,
      issueStateStore: stateStore,
      logger: silentLogger(),
      historyBackedFieldGroups: [
        "lifecycleReports",
        "mergePolicyCompletionRun",
      ],
    });

    const current = await historyBuilder.build(issue, emptyRuntime());
    const rebuilt = await historyBuilder.rebuildHistoryBackedFields(
      issue,
      emptyRuntime(),
      ["lifecycleReports", "mergePolicyCompletionRun"],
    );

    expect(liveCurrent.latestCompletionReport).toBeNull();
    expect(liveCurrent.mergePolicyLatestCompletionReport).toBeNull();
    expect(current.latestCompletionReport).toBeNull();
    expect(current.latestApprovalPassVerdict).toBeNull();
    expect(current.mergePolicyLatestCompletionReport).toBeNull();
    expect(current.mergePolicyLatestApprovalVerdict).toBeNull();
    expect(rebuilt.fields.latestCompletionReport).toBeNull();
    expect(rebuilt.fields.latestApprovalPassVerdict).toBeNull();
    expect(rebuilt.fields.mergePolicyLatestCompletionReport).toBeNull();
    expect(rebuilt.fields.mergePolicyLatestApprovalVerdict).toBeNull();
    expect(rebuilt.fields.mergePolicyLatestCompletionRun).toBeNull();
    expect(rebuilt.incompleteGroups).toEqual([]);
  });

  it("rebuilds active runtime control fields from durable runtime evidence", async () => {
    const config = builderConfig(root);
    const stateStore = new MemoryIssueStateStore();
    const issue = issueFixture();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: stateStore,
      logger: silentLogger(),
    });
    const baseCurrent = await storeBuilder.build(issue, emptyRuntime());
    stateStore.record = {
      ...baseCurrent,
      history: [
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-running",
          eventType: "running_entry_created",
          running: true,
          role: "worker",
          runPhase: "implementation",
          runId: "run-runtime",
          manualDispatchStage: "worker",
          manualIgnoreState: true,
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-claim",
          eventType: "claim_acquired",
          claimed: true,
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-pause",
          eventType: "pause_requested",
          paused: true,
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-cancel",
          eventType: "cancellation_requested",
          cancellationRequestedAt: "2026-01-01T00:00:05.000Z",
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-retry",
          eventType: "retry_scheduled",
          retrying: true,
          attempt: 2,
          delayMs: 1000,
          dueAt: "2026-01-01T00:00:06.000Z",
          error: "temporary failure",
        }),
      ],
    };
    const historyBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: stateStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["runtimeControl"],
    });

    const current = await historyBuilder.build(issue, emptyRuntime());
    const rebuilt = await historyBuilder.rebuildHistoryBackedFields(
      issue,
      emptyRuntime(),
      ["runtimeControl"],
    );

    expect(current).toMatchObject({
      running: true,
      runningRole: "worker",
      runningRunPhase: "implementation",
      runningRunKind: "implementation",
      runningManualDispatchStage: "worker",
      runningManualIgnoreState: true,
      runningCancellationRequested: true,
      claimed: true,
      paused: true,
      retrying: true,
    });
    expectHistoryRebuildMatchesCurrent(current, rebuilt);
  });

  it("rebuilds cleared runtime control fields from release evidence", async () => {
    const config = builderConfig(root);
    const stateStore = new MemoryIssueStateStore();
    const issue = issueFixture();
    const storeBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: stateStore,
      logger: silentLogger(),
    });
    const baseCurrent = await storeBuilder.build(issue, emptyRuntime());
    stateStore.record = {
      ...baseCurrent,
      history: [
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-running",
          eventType: "running_entry_created",
          running: true,
          role: "worker",
          runPhase: "implementation",
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-claim",
          eventType: "claim_acquired",
          claimed: true,
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-retry",
          eventType: "retry_scheduled",
          retrying: true,
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-release",
          eventType: "running_entry_released",
          running: false,
          claimed: false,
        }),
        runtimeEvidenceSnapshot(baseCurrent, {
          historySnapshotId: "issue-history:runtime-retry-cleared",
          eventType: "retry_cleared",
          retrying: false,
        }),
      ],
    };
    const historyBuilder = new IssueCurrentStateBuilder({
      config,
      lifecycleStore: undefined,
      runStore: undefined,
      issueStateStore: stateStore,
      logger: silentLogger(),
      historyBackedFieldGroups: ["runtimeControl"],
    });

    const current = await historyBuilder.build(issue, emptyRuntime());
    const rebuilt = await historyBuilder.rebuildHistoryBackedFields(
      issue,
      emptyRuntime(),
      ["runtimeControl"],
    );

    expect(current).toMatchObject({
      running: false,
      runningRole: null,
      runningRunPhase: null,
      runningRunKind: null,
      runningCancellationRequested: false,
      claimed: false,
      retrying: false,
      runtimeRetryDueAt: null,
    });
    expectHistoryRebuildMatchesCurrent(current, rebuilt);
  });

  it("rebuilds history-backed fields for planned timeline scenarios", async () => {
    const scenarios: Array<{
      name: string;
      issue: Issue;
      runs: StoredRunInput[];
      arrangeLifecycle: (input: {
        issue: Issue;
        lifecycleStore: FileIssueLifecycleStore;
      }) => Promise<IssueLifecycleRecord>;
      assertCurrent: (current: IssueCurrentFields) => void;
    }> = [
      {
        name: "normal worker dispatch and completion",
        issue: issueFixture({
          id: "issue-worker-complete",
          identifier: "TEST-WORKER",
          state: "In Review",
        }),
        runs: [
          {
            runId: "worker-complete-run",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          const report = completionReportFixture(issue, "worker-complete-run", {
            id: "completion-worker-complete",
            summary: "Worker completed the issue",
          });
          return lifecycleStore.ensureIssue(issue, {
            phase: "review",
            lastCompletionReportId: report.id,
            completionReports: [report],
          });
        },
        assertCurrent: (current) => {
          expect(current.phase).toBe("review");
          expect(current.latestRunId).toBe("worker-complete-run");
          expect(current.latestCompletionReport).toMatchObject({
            id: "completion-worker-complete",
          });
        },
      },
      {
        name: "reviewer pass",
        issue: issueFixture({
          id: "issue-review-pass",
          identifier: "TEST-REVIEW-PASS",
          state: "Ready to Merge",
        }),
        runs: [
          {
            runId: "worker-reviewed-run",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
          {
            runId: "review-pass-run",
            role: "reviewer",
            runPhase: "review",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:05.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          const report = completionReportFixture(issue, "worker-reviewed-run", {
            id: "completion-review-pass",
          });
          const verdict = reviewVerdictFixture(issue, "review-pass-run", {
            id: "verdict-review-pass",
            verdict: "pass",
          });
          return lifecycleStore.ensureIssue(issue, {
            phase: "passed",
            lastCompletionReportId: report.id,
            lastReviewVerdictId: verdict.id,
            completionReports: [report],
            reviewVerdicts: [verdict],
          });
        },
        assertCurrent: (current) => {
          expect(current.phase).toBe("passed");
          expect(current.latestRunId).toBe("review-pass-run");
          expect(current.latestApprovalPassVerdict).toMatchObject({
            id: "verdict-review-pass",
          });
        },
      },
      {
        name: "reviewer fail",
        issue: issueFixture({
          id: "issue-review-fail",
          identifier: "TEST-REVIEW-FAIL",
          state: "Todo",
        }),
        runs: [
          {
            runId: "worker-failed-review-run",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
          {
            runId: "review-fail-run",
            role: "reviewer",
            runPhase: "review",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:05.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          const report = completionReportFixture(
            issue,
            "worker-failed-review-run",
            { id: "completion-review-fail" },
          );
          const verdict = reviewVerdictFixture(issue, "review-fail-run", {
            id: "verdict-review-fail",
            verdict: "fail",
            findings: ["Missing validation"],
          });
          return lifecycleStore.ensureIssue(issue, {
            phase: "implementation",
            reviewRound: 1,
            lastCompletionReportId: report.id,
            lastReviewVerdictId: verdict.id,
            completionReports: [report],
            reviewVerdicts: [verdict],
          });
        },
        assertCurrent: (current) => {
          expect(current.phase).toBe("implementation");
          expect(current.reviewRound).toBe(1);
          expect(current.latestApprovalPassVerdict).toBeNull();
          expect(current.lastReviewVerdictId).toBe("verdict-review-fail");
        },
      },
      {
        name: "rejected completion report",
        issue: issueFixture({
          id: "issue-rejected-completion",
          identifier: "TEST-REJECTED",
          state: "Todo",
        }),
        runs: [
          {
            runId: "worker-rejected-run",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          const rejection = {
            id: "completion-rejection-1",
            idempotencyKey: "completion-rejection-1",
            reportId: "completion-report-rejected-1",
            runId: "worker-rejected-run",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            reasonCode: "unsatisfied_acceptance_checklist" as const,
            reason: "missing_required_items",
            summary: "Substantially incomplete",
            validationEvidence: [],
            acceptanceChecklist: [],
            changedFiles: [],
            branchName: null,
            pullRequest: null,
            risks: [],
            rejectedAt: "2026-01-01T00:00:05.000Z",
            writebackOperationKeys: [],
          };
          return lifecycleStore.ensureIssue(issue, {
            phase: "implementation",
            incompleteTurnCount: 1,
            lastCompletionReportRejectionId: rejection.id,
            completionReportRejections: [rejection],
          });
        },
        assertCurrent: (current) => {
          expect(current.phase).toBe("implementation");
          expect(current.incompleteTurnCount).toBe(1);
          expect(current.lastCompletionReportRejectionId).toBe(
            "completion-rejection-1",
          );
          expect(current.latestCompletionReport).toBeNull();
        },
      },
      {
        name: "issue triage blocked rebound",
        issue: issueFixture({
          id: "issue-triage-rebound",
          identifier: "TEST-TRIAGE",
          state: "Blocked",
        }),
        runs: [
          {
            runId: "triage-rebound-run",
            role: "triage",
            runPhase: "issue_triage",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          const base = await lifecycleStore.ensureIssue(issue, {
            phase: "blocked",
            blockedReason: "max incomplete turns reached",
            incompleteTurnCount: 3,
          });
          const fingerprint = issueTriageTriggerFingerprint(base);
          const report = {
            id: "triage-rebound-report",
            idempotencyKey: "triage-rebound-report",
            requestHash: "triage-rebound-hash",
            runId: "triage-rebound-run",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            triggerFingerprint: fingerprint,
            disposition: "implementation_repair" as const,
            confidence: "high" as const,
            summary: "Worker should repair",
            evidence: ["Triage evidence"],
            recommendedAction: "Run worker repair",
            blockers: [
              {
                kind: "implementation_unsatisfied_requirements" as const,
                status: "active" as const,
                nextActor: "worker" as const,
                confidence: "high" as const,
                summary: "Missing requirement",
                evidence: ["Requirement missing"],
                recommendedAction: "Implement requirement",
              },
            ],
            submittedAt: "2026-01-01T00:00:05.000Z",
            writebackOperationKeys: [],
          };
          return lifecycleStore.updateIssue(issue, {
            lastIssueTriageReportId: report.id,
            issueTriageReports: [report],
          });
        },
        assertCurrent: (current) => {
          expect(current.lastIssueTriageReportId).toBe("triage-rebound-report");
          expect(current.latestIssueTriageReportBlockers).toMatchObject([
            { summary: "Missing requirement", nextActor: "worker" },
          ]);
        },
      },
      {
        name: "merge policy pass to done",
        issue: issueFixture({
          id: "issue-merge-done",
          identifier: "TEST-MERGE",
          state: "Done",
        }),
        runs: [
          {
            runId: "merge-worker-run",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          const pullRequest = pullRequestFixture();
          const report = completionReportFixture(issue, "merge-worker-run", {
            id: "completion-merge-done",
            pullRequest,
          });
          return lifecycleStore.ensureIssue(issue, {
            phase: "terminal",
            lastCompletionReportId: report.id,
            completionReports: [report],
            merge: {
              id: "merge-done-1",
              pullRequest,
              headSha: "abc123",
              mergeCommitSha: "merge-sha-1",
              mergedAt: "2026-01-01T00:00:06.000Z",
              mergedBy: {
                login: null,
                profile: null,
                capability: "github.merge",
              },
              checkStatus: {
                requiredChecks: ["ci/test"],
                passedChecks: ["ci/test"],
                noCiEvidence: null,
              },
              mergeOperationKey: "merge-op-1",
              doneTransitionOperationKey: "done-op-1",
            },
          });
        },
        assertCurrent: (current) => {
          expect(current.phase).toBe("terminal");
          expect(current.mergePolicyMerge).toMatchObject({
            mergeCommitSha: "merge-sha-1",
          });
        },
      },
      {
        name: "merge conflict repair",
        issue: issueFixture({
          id: "issue-merge-conflict",
          identifier: "TEST-CONFLICT",
          state: "Merge Conflict",
        }),
        runs: [
          {
            runId: "merge-conflict-run",
            runPhase: "merge_conflict_resolution",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          return lifecycleStore.ensureIssue(issue, {
            phase: "merge_conflict_resolution",
            mergeConflict: {
              id: "merge-conflict-1",
              status: "open",
              resolutionStatus: "still_conflicted",
              pullRequest: pullRequestFixture(),
              approvedHeadSha: "abc123",
              currentHeadSha: "def456",
              resolvedHeadSha: null,
              baseBranch: "main",
              baseHeadSha: "base123",
              sourceState: "Ready to Merge",
              conflictsState: "Merge Conflict",
              reason: "merge conflicts",
              mergeableState: "dirty",
              servicePreparation: null,
              detectedAt: "2026-01-01T00:00:03.000Z",
              updatedAt: "2026-01-01T00:00:04.000Z",
              fixTurnCount: 1,
              maxFixTurns: 3,
              lastConflictFixRunId: "merge-conflict-run",
              lastConflictResolutionReportId: "merge-conflict-report-1",
              attemptRunIds: ["merge-conflict-run"],
              writebackOperationKeys: [],
              blockedAt: null,
              blockedReason: null,
            },
          });
        },
        assertCurrent: (current) => {
          expect(current.phase).toBe("merge_conflict_resolution");
          expect(current.mergePolicyMergeConflict).toMatchObject({
            id: "merge-conflict-1",
            lastConflictFixRunId: "merge-conflict-run",
          });
        },
      },
      {
        name: "publication approval rejection recovery",
        issue: issueFixture({
          id: "issue-publication-rejected",
          identifier: "TEST-PUBLICATION",
          state: "Blocked",
        }),
        runs: [
          {
            runId: "publication-run",
            status: "succeeded",
            completedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          return lifecycleStore.ensureIssue(issue, {
            phase: "blocked",
            blockedReason: "publication approval rejected",
            lastCompletionReportRejectionId: "publication-rejection-1",
          });
        },
        assertCurrent: (current) => {
          expect(current.blockedReason).toBe("publication approval rejected");
          expect(current.pendingPublicationApprovalRunId).toBeNull();
          expect(current.lastCompletionReportRejectionId).toBe(
            "publication-rejection-1",
          );
        },
      },
      {
        name: "retry scheduling and firing",
        issue: issueFixture({
          id: "issue-retry",
          identifier: "TEST-RETRY",
          state: "Todo",
        }),
        runs: [
          {
            runId: "retry-planning-run",
            role: "planner",
            runPhase: "issue_breakdown",
            runKind: "planning",
            status: "failed",
            completedAt: "2026-01-01T00:00:04.000Z",
            error: "planning failed",
          },
        ],
        arrangeLifecycle: async ({ issue, lifecycleStore }) => {
          return lifecycleStore.ensureIssue(issue, {
            phase: "implementation",
            planningFailureCount: 1,
            planningDispatchRetryCount: 1,
            lastPlanningFailureAt: "2026-01-01T00:00:04.000Z",
          });
        },
        assertCurrent: (current) => {
          expect(current.planningFailureCount).toBe(1);
          expect(current.planningDispatchRetryCount).toBe(1);
          expect(current.planningRetryDueAt).toBe("2026-01-01T00:00:09.000Z");
        },
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const scenarioRoot = path.join(root, `timeline-${index}`);
      const config = builderConfig(scenarioRoot);
      const lifecycleStore = new FileIssueLifecycleStore(scenarioRoot);
      const runStore = new FileRunTranscriptStore(scenarioRoot);
      const historyStore = new MemoryIssueStateStore();
      await startTimelineRuns(runStore, scenario.issue, scenario.runs);
      const lifecycle = await scenario.arrangeLifecycle({
        issue: scenario.issue,
        lifecycleStore,
      });
      const storeBuilder = new IssueCurrentStateBuilder({
        config,
        lifecycleStore,
        runStore,
        issueStateStore: historyStore,
        logger: silentLogger(),
      });
      const storeCurrent = await storeBuilder.build(
        scenario.issue,
        emptyRuntime(),
      );
      historyStore.record = {
        ...storeCurrent,
        history: [
          trackerEvidenceSnapshot(storeCurrent, scenario.issue),
          lifecycleEvidenceSnapshot(storeCurrent, lifecycle),
          ...scenario.runs.flatMap((run) =>
            runEvidenceSnapshots(storeCurrent, run),
          ),
        ],
      };
      const historyBuilder = new IssueCurrentStateBuilder({
        config,
        lifecycleStore,
        runStore,
        issueStateStore: historyStore,
        logger: silentLogger(),
        historyBackedFieldGroups: HISTORY_BACKED_FIELD_GROUPS,
      });

      const current = await historyBuilder.build(
        scenario.issue,
        emptyRuntime(),
      );
      const rebuilt = await historyBuilder.rebuildHistoryBackedFields(
        scenario.issue,
        emptyRuntime(),
      );

      try {
        scenario.assertCurrent(current);
        expectHistoryRebuildMatchesCurrent(current, rebuilt);
      } catch (error) {
        throw new Error(`Timeline scenario failed: ${scenario.name}`, {
          cause: error,
        });
      }
    }
  });
});

function builderConfig(root: string): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
      },
      workspace: { root },
      review_loop: {
        review_states: ["In Review"],
        blocked_states: ["Blocked"],
        review_pass_state: "Ready to Merge",
        max_incomplete_turns: 3,
      },
      issue_breakdown: {
        enabled: true,
        planning_labels: ["planning"],
      },
      merge_policy: {
        mode: "gated",
        source_states: ["Ready to Merge"],
        conflicts_state: "Merge Conflict",
        required_checks: ["ci/test"],
      },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "secret" },
  );
}

function issueFixture(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Implement builder",
    description: "Body",
    priority: null,
    state: "Todo",
    branchName: null,
    url: "https://linear.test/TEST-1",
    assigneeId: "worker-1",
    delegateId: null,
    assignedToWorker: true,
    labels: [],
    blockedBy: [],
    hasChildren: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pullRequestFixture(
  overrides: Partial<
    NonNullable<
      IssueLifecycleRecord["completionReports"][number]["pullRequest"]
    >
  > = {},
): NonNullable<
  IssueLifecycleRecord["completionReports"][number]["pullRequest"]
> {
  return {
    url: "https://github.test/acme/repo/pull/7",
    number: 7,
    headSha: "abc123",
    branch: "feature/test-1",
    ...overrides,
  };
}

function completionReportFixture(
  issue: Issue,
  runId: string,
  overrides: Partial<IssueLifecycleRecord["completionReports"][number]> = {},
): IssueLifecycleRecord["completionReports"][number] {
  const id = overrides.id ?? `completion-${runId}`;
  return {
    id,
    idempotencyKey: overrides.idempotencyKey ?? id,
    runId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    summary: "Implemented the requested work",
    validationEvidence: ["validated"],
    acceptanceChecklist: [],
    changedFiles: ["src/app.ts"],
    branchName: "feature/test-1",
    pullRequest: null,
    risks: [],
    acceptedAt: "2026-01-01T00:00:03.000Z",
    writebackOperationKeys: [],
    ...overrides,
  };
}

function preservedStashFixture(
  overrides: Partial<IssuePreservedWorktreeStash> = {},
): IssuePreservedWorktreeStash {
  return {
    version: 1,
    id: "stash-1",
    operationId: "base-ref:issue-1:head:base",
    source: "base_ref_repair",
    stashRef: "refs/symphony/preserved-stashes/test/stash-1",
    stashSha: "stash-sha-1",
    message: "Symphony preserved local changes",
    workspacePath: "/tmp/workspace",
    branchName: "feature/test-1",
    baseBranch: "main",
    originalHeadSha: "head-sha-1",
    dirtyFiles: ["src/local.ts"],
    status: "created",
    conflictedFiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    appliedAt: null,
    droppedAt: null,
    dropError: null,
    ...overrides,
  };
}

function reviewVerdictFixture(
  issue: Issue,
  runId: string,
  overrides: Partial<IssueLifecycleRecord["reviewVerdicts"][number]> = {},
): IssueLifecycleRecord["reviewVerdicts"][number] {
  const id = overrides.id ?? `verdict-${runId}`;
  return {
    id,
    idempotencyKey: overrides.idempotencyKey ?? id,
    runId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    verdict: "pass",
    acceptanceResults: [],
    findings: [],
    gateFindings: [],
    discoveryFindings: [],
    evidence: ["reviewed"],
    reviewer: null,
    submittedAt: "2026-01-01T00:00:05.000Z",
    writebackOperationKeys: [],
    ...overrides,
  };
}

function baseRefObservationFixture(
  overrides: Partial<IssueBaseRefObservation> = {},
): IssueBaseRefObservation {
  return {
    version: 1,
    inputFingerprint: "base-ref-fingerprint",
    classification: "ok",
    operation: "merge_policy_dispatch_repair",
    checkedAt: "2026-01-01T00:00:03.000Z",
    workspacePath: "/tmp/workspace",
    branchName: "feature/test-1",
    baseRef: "origin/main",
    normalizedBaseBranch: "main",
    localBaseRef: "refs/remotes/origin/main",
    githubBaseHeadSha: "base-head",
    localBaseHeadShaBeforeFetch: "base-head",
    localBaseHeadShaAfterFetch: "base-head",
    worktreeHeadSha: "feature-head",
    localBaseIsAncestorOfHead: true,
    reason: null,
    error: null,
    ...overrides,
  };
}

function emptyRuntime(): IssueCurrentStateRuntimeState {
  return {
    runningEntry: null,
    running: false,
    claimed: false,
    paused: false,
    retrying: false,
  };
}

function silentLogger() {
  return { warn: () => undefined };
}

type StoredRunInput = {
  runId: string;
  role?: AgentRunRole;
  runPhase?: AgentRunPhase;
  runKind?: AgentRunKind;
  status?: "succeeded" | "failed" | "cancelled";
  completedAt: string;
  error?: string | null;
  prompt?: string;
  attempt?: number | null;
  turnNumber?: number;
  tokens?: TokenCounts;
  workspaceKey?: string;
  workspacePath?: string;
  gitBranchName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prHeadSha?: string | null;
  prBranch?: string | null;
};

async function startStoredRun(
  runStore: FileRunTranscriptStore,
  issue: Issue,
  input: StoredRunInput,
): Promise<void> {
  const role = input.role ?? "worker";
  const runPhase = input.runPhase ?? "implementation";
  const runKind = input.runKind ?? runKindForPhase(runPhase);
  const prompt = input.prompt ?? "Work";
  await runStore.startRun({
    runId: input.runId,
    sessionId: `session-${input.runId}`,
    agentId: `agent-${input.runId}`,
    role,
    runPhase,
    runKind,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: input.attempt ?? null,
    turnNumber: input.turnNumber ?? 1,
    prompt,
    promptTemplateKeys: [`template-${input.runId}`],
    harnessId: "test-harness",
    workspaceKey: input.workspaceKey ?? `workspace-${input.runId}`,
    workspacePath: input.workspacePath ?? `/tmp/${input.runId}`,
    ...(input.gitBranchName == null
      ? {}
      : { gitBranchName: input.gitBranchName }),
  });
  const status = input.status ?? "succeeded";
  await runStore.updateRun(input.runId, {
    status,
    completedAt: input.completedAt,
    error:
      input.error === undefined
        ? status === "failed"
          ? "run failed"
          : null
        : input.error,
    tokens: input.tokens ?? { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    metadata: {
      ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
      ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
      ...(input.prHeadSha === undefined ? {} : { prHeadSha: input.prHeadSha }),
      ...(input.prBranch === undefined ? {} : { prBranch: input.prBranch }),
      sdkRunStatus:
        status === "succeeded"
          ? "finished"
          : status === "cancelled"
            ? "cancelled"
            : "error",
      sdkRunStatusSource: "wait",
      cancellationOutcome: status === "cancelled" ? "cancelled" : "none",
      cancelFailed: false,
    },
  });
}

async function startTimelineRuns(
  runStore: FileRunTranscriptStore,
  issue: Issue,
  runs: readonly StoredRunInput[],
): Promise<void> {
  const firstStartedAt = Date.parse("2026-01-01T00:00:00.000Z");
  vi.useFakeTimers();
  try {
    for (const [index, run] of runs.entries()) {
      vi.setSystemTime(new Date(firstStartedAt + index * 1_000));
      await startStoredRun(runStore, issue, run);
    }
  } finally {
    vi.useRealTimers();
  }
}

async function startFailedWorkerRun(
  runStore: FileRunTranscriptStore,
  issue: Issue,
  runId: string,
  completedAt: string,
): Promise<void> {
  await runStore.startRun({
    runId,
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: null,
    turnNumber: 1,
    prompt: "Work",
    workspaceKey: `workspace-${runId}`,
    workspacePath: `/tmp/${runId}`,
  });
  await runStore.updateRun(runId, {
    status: "failed",
    completedAt,
    error: "sdk failed",
    metadata: {
      sdkRunStatus: "error",
      sdkRunStatusSource: "wait",
    },
  });
}

function trackerEvidenceSnapshot(
  current: IssueCurrentFields,
  observed: Issue,
): IssueHistorySnapshot {
  const at = "2026-01-01T00:00:03.000Z";
  return {
    ...current,
    snapshotId: "issue-snapshot:tracker-evidence",
    snapshotAt: at,
    triggerType: "orchestrator.tick",
    triggerId: "orchestrator.tick:tracker-evidence",
    triggerAt: at,
    triggerSource: "orchestrator",
    candidateSource: "evidence.tracker.tracker_issue_observed",
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
    snapshotKind: "evidence",
    historySnapshotId: "issue-history:tracker-evidence",
    transitionKind: "record_evidence",
    transitionId: "transition:record_evidence:tracker-evidence",
    rulesetId: "orchestrator.evidence.tracker",
    rulesetVersion: "test",
    rulesetFingerprint: "orchestrator.evidence.tracker@test:900",
    rulesetPriority: 900,
    reason: "tracker_issue_observed",
    actions: [],
    errors: [],
    evidenceKind: "tracker",
    evidenceEventType: "tracker_issue_observed",
    evidenceSourceId: observed.id,
    evidencePayload: null,
    observedTitle: observed.title,
    observedDescription: observed.description,
    observedTrackerState: observed.state,
    observedLabels: observed.labels,
    observedBranchName: observed.branchName,
    observedTrackerUrl: observed.url,
    observedPriority: observed.priority,
    observedAssigneeId: observed.assigneeId,
    observedDelegateId: observed.delegateId,
    observedAssignedToWorker: observed.assignedToWorker,
    observedBlocks: observed.blocks ?? [],
    observedBlockedBy: observed.blockedBy,
    observedHasChildren: observed.hasChildren === true,
    observedTrackerCreatedAt: observed.createdAt,
    observedTrackerUpdatedAt: observed.updatedAt,
  };
}

function lifecycleEvidenceSnapshot(
  current: IssueCurrentFields,
  lifecycle: IssueLifecycleRecord,
): IssueHistorySnapshot {
  const at = "2026-01-01T00:00:04.000Z";
  const latestCompletionReport =
    latestCompletionReportForTestLifecycle(lifecycle);
  const latestApprovalPassVerdict =
    latestApprovalPassVerdictForTestLifecycle(lifecycle);
  const pendingPublication = pendingPublicationHandoffForRun(lifecycle);
  return {
    ...current,
    snapshotId: "issue-snapshot:lifecycle-evidence",
    snapshotAt: at,
    triggerType: "orchestrator.tick",
    triggerId: "orchestrator.tick:lifecycle-evidence",
    triggerAt: at,
    triggerSource: "orchestrator",
    candidateSource: "evidence.lifecycle.lifecycle_updated",
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
    snapshotKind: "evidence",
    historySnapshotId: "issue-history:lifecycle-evidence",
    transitionKind: "record_evidence",
    transitionId: "transition:record_evidence:lifecycle-evidence",
    rulesetId: "orchestrator.evidence.lifecycle",
    rulesetVersion: "test",
    rulesetFingerprint: "orchestrator.evidence.lifecycle@test:900",
    rulesetPriority: 900,
    reason: "lifecycle_updated",
    actions: [],
    errors: [],
    evidenceKind: "lifecycle",
    evidenceEventType: "lifecycle_updated",
    evidenceSourceId: lifecycle.issueId,
    evidencePayload: {
      updatedAt: lifecycle.updatedAt,
      phase: lifecycle.phase,
      blockedReason: lifecycle.blockedReason,
      reviewRound: lifecycle.reviewRound,
      incompleteTurnCount: lifecycle.incompleteTurnCount,
      planningFailureCount: lifecycle.planningFailureCount,
      planningDispatchRetryCount: lifecycle.planningDispatchRetryCount,
      lastPlanningFailureAt: lifecycle.lastPlanningFailureAt,
      lastIssueBreakdownPlanId: lifecycle.lastIssueBreakdownPlanId,
      issueBreakdownPlans: lifecycle.issueBreakdownPlans,
      lastIssueTriageReportId: lifecycle.lastIssueTriageReportId,
      issueTriageReports: lifecycle.issueTriageReports,
      lastPostMortemReportId: lifecycle.lastPostMortemReportId,
      postMortemReports: lifecycle.postMortemReports,
      lastCompletionReportId: lifecycle.lastCompletionReportId,
      lastCompletionReportRejectionId:
        lifecycle.lastCompletionReportRejectionId,
      lastReviewVerdictId: lifecycle.lastReviewVerdictId,
      lastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
      pendingPublicationApprovalRunId:
        pendingPublication?.pendingReport.runId ?? null,
      pendingPublicationApprovalReportId:
        pendingPublication?.pendingReport.id ?? null,
      pendingPublicationApprovalReason:
        pendingPublication === null ? null : lifecycle.blockedReason,
      latestCompletionReport,
      latestApprovalPassVerdict,
      acceptedArtifact: lifecycle.acceptedArtifact ?? null,
      acceptedArtifactValidationFailure:
        lifecycle.acceptedArtifactValidationFailure ?? null,
      workspaceSeed: lifecycle.workspaceSeed ?? null,
      relationshipState: lifecycle.relationshipState ?? null,
      succession: lifecycle.succession ?? null,
      merge: lifecycle.merge,
      mergeGate: lifecycle.mergeGate,
      mergeGateResults: lifecycle.mergeGateResults ?? [],
      mergeConflict: lifecycle.mergeConflict,
      reviewFeedback: lifecycle.reviewFeedback,
      summaryPointers: lifecycle.summaryPointers,
    },
    lifecyclePatch: null,
    lifecycleUpdatedAt: lifecycle.updatedAt,
    lifecyclePhase: lifecycle.phase,
    lifecycleBlockedReason: lifecycle.blockedReason,
    lifecycleReviewRound: lifecycle.reviewRound,
    lifecycleIncompleteTurnCount: lifecycle.incompleteTurnCount,
    lifecyclePlanningFailureCount: lifecycle.planningFailureCount,
    lifecyclePlanningDispatchRetryCount: lifecycle.planningDispatchRetryCount,
    lifecycleLastPlanningFailureAt: lifecycle.lastPlanningFailureAt,
    lifecycleLastIssueBreakdownPlanId: lifecycle.lastIssueBreakdownPlanId,
    lifecycleIssueBreakdownPlans: lifecycle.issueBreakdownPlans,
    lifecycleLastIssueTriageReportId: lifecycle.lastIssueTriageReportId,
    lifecycleIssueTriageReports: lifecycle.issueTriageReports,
    lifecycleLastPostMortemReportId: lifecycle.lastPostMortemReportId,
    lifecyclePostMortemReports: lifecycle.postMortemReports,
    lifecycleLastCompletionReportId: lifecycle.lastCompletionReportId,
    lifecycleLastCompletionReportRejectionId:
      lifecycle.lastCompletionReportRejectionId,
    lifecycleLastReviewVerdictId: lifecycle.lastReviewVerdictId,
    lifecycleLastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
    lifecyclePendingPublicationApprovalRunId:
      pendingPublication?.pendingReport.runId ?? null,
    lifecyclePendingPublicationApprovalReportId:
      pendingPublication?.pendingReport.id ?? null,
    lifecyclePendingPublicationApprovalReason:
      pendingPublication === null ? null : lifecycle.blockedReason,
    lifecycleLatestCompletionReport: latestCompletionReport,
    lifecycleLatestApprovalPassVerdict: latestApprovalPassVerdict,
    lifecycleAcceptedArtifact: lifecycle.acceptedArtifact ?? null,
    lifecycleAcceptedArtifactValidationFailure:
      lifecycle.acceptedArtifactValidationFailure ?? null,
    lifecycleWorkspaceSeed: lifecycle.workspaceSeed ?? null,
    lifecycleRelationshipState: lifecycle.relationshipState ?? null,
    lifecycleSuccession: lifecycle.succession ?? null,
    lifecycleMerge: lifecycle.merge,
    lifecycleMergeGate: lifecycle.mergeGate,
    lifecycleMergeGateResults: lifecycle.mergeGateResults ?? [],
    lifecycleMergeConflict: lifecycle.mergeConflict,
    lifecycleReviewFeedback: lifecycle.reviewFeedback,
    lifecycleSummaryCiStatus: lifecycle.summaryPointers.ciStatus,
    lifecycleSummaryPointers: lifecycle.summaryPointers,
  };
}

function runtimeEvidenceSnapshot(
  current: IssueCurrentFields,
  input: {
    historySnapshotId: string;
    eventType: string;
    running?: boolean | null;
    role?: AgentRunRole | null;
    runPhase?: AgentRunPhase | null;
    runId?: string | null;
    activeRunId?: string | null;
    manualDispatchStage?: string | null;
    manualIgnoreState?: boolean | null;
    cancellationRequestedAt?: string | null;
    claimed?: boolean | null;
    paused?: boolean | null;
    retrying?: boolean | null;
    attempt?: number | null;
    delayMs?: number | null;
    dueAt?: string | null;
    error?: string | null;
  },
): IssueHistorySnapshot {
  const at = "2026-01-01T00:00:05.000Z";
  const runKind =
    input.runPhase === undefined || input.runPhase === null
      ? null
      : runKindForPhase(input.runPhase);
  return {
    ...current,
    snapshotId: `issue-snapshot:${input.historySnapshotId}`,
    snapshotAt: at,
    triggerType: "orchestrator.tick",
    triggerId: `orchestrator.tick:${input.historySnapshotId}`,
    triggerAt: at,
    triggerSource: "orchestrator",
    candidateSource: `evidence.runtime.${input.eventType}`,
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
    snapshotKind: "evidence",
    historySnapshotId: input.historySnapshotId,
    transitionKind: "record_evidence",
    transitionId: `transition:record_evidence:${input.historySnapshotId}`,
    rulesetId: "orchestrator.evidence.runtime",
    rulesetVersion: "test",
    rulesetFingerprint: "orchestrator.evidence.runtime@test:900",
    rulesetPriority: 900,
    reason: input.eventType,
    actions: [],
    errors: [],
    evidenceKind: "runtime",
    evidenceEventType: input.eventType,
    evidenceSourceId: input.runId ?? current.issueId,
    evidencePayload: null,
    runtimeRunning: input.running ?? null,
    runtimeRole: input.role ?? null,
    runtimeRunPhase: input.runPhase ?? null,
    runtimeRunKind: runKind,
    runtimeRunId: input.runId ?? null,
    runtimeActiveRunId: input.activeRunId ?? null,
    runtimeManualDispatchStage: input.manualDispatchStage ?? null,
    runtimeManualIgnoreState: input.manualIgnoreState ?? null,
    runtimeCancellationRequestedAt: input.cancellationRequestedAt ?? null,
    runtimeClaimed: input.claimed ?? null,
    runtimePaused: input.paused ?? null,
    runtimeRetrying: input.retrying ?? null,
    retryAttempt: input.attempt ?? null,
    retryDelayMs: input.delayMs ?? null,
    retryError: input.error ?? null,
    retryDueAt: input.dueAt ?? null,
  };
}

function latestCompletionReportForTestLifecycle(
  lifecycle: IssueLifecycleRecord,
): IssueLifecycleRecord["completionReports"][number] | null {
  return latestCurrentCompletionReport(lifecycle);
}

function latestApprovalPassVerdictForTestLifecycle(
  lifecycle: IssueLifecycleRecord,
): IssueLifecycleRecord["reviewVerdicts"][number] | null {
  return latestCurrentApprovalPassVerdict(lifecycle);
}

function runEvidenceSnapshots(
  current: IssueCurrentFields,
  input: StoredRunInput,
): IssueHistorySnapshot[] {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const role = input.role ?? "worker";
  const runPhase = input.runPhase ?? "implementation";
  const runKind = input.runKind ?? runKindForPhase(runPhase);
  const status = input.status ?? "failed";
  const prompt = input.prompt ?? "Work";
  const tokens = input.tokens ?? {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  };
  const error =
    input.error === undefined
      ? status === "failed"
        ? "sdk failed"
        : null
      : input.error;
  const snapshots = [
    runEvidenceSnapshot(current, {
      historySnapshotId: `issue-history:${input.runId}:started`,
      snapshotAt: startedAt,
      eventType: "run_started",
      runId: input.runId,
      sessionId: `session-${input.runId}`,
      agentId: `agent-${input.runId}`,
      status: "running",
      role,
      runPhase,
      runKind,
      prompt,
      promptCharCount: prompt.length,
      startedAt,
      updatedAt: startedAt,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      attempt: input.attempt ?? null,
      turnNumber: input.turnNumber ?? 1,
      harnessId: "test-harness",
      promptTemplateKeys: [`template-${input.runId}`],
      workspaceKey: input.workspaceKey ?? `workspace-${input.runId}`,
      workspacePath: input.workspacePath ?? `/tmp/${input.runId}`,
      gitBranchName: input.gitBranchName ?? null,
    }),
    runEvidenceSnapshot(current, {
      historySnapshotId: `issue-history:${input.runId}:terminal`,
      snapshotAt: input.completedAt,
      eventType: "run_terminal_state_updated",
      runId: input.runId,
      sessionId: `session-${input.runId}`,
      agentId: `agent-${input.runId}`,
      status,
      role,
      runPhase,
      runKind,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
      ...(error === null ? {} : { error }),
      tokens,
      workspaceKey: input.workspaceKey ?? `workspace-${input.runId}`,
      workspacePath: input.workspacePath ?? `/tmp/${input.runId}`,
      gitBranchName: input.gitBranchName ?? null,
      sdkRunStatus:
        status === "succeeded"
          ? "finished"
          : status === "cancelled"
            ? "cancelled"
            : "error",
      sdkRunStatusSource: "wait",
      cancellationOutcome: status === "cancelled" ? "cancelled" : "none",
      cancelFailed: false,
    }),
  ];
  if (
    input.prUrl !== undefined ||
    input.prNumber !== undefined ||
    input.prHeadSha !== undefined ||
    input.prBranch !== undefined
  ) {
    snapshots.push(
      runEvidenceSnapshot(current, {
        historySnapshotId: `issue-history:${input.runId}:pull-request`,
        snapshotAt: input.completedAt,
        eventType: "run_pull_request_updated",
        runId: input.runId,
        sessionId: `session-${input.runId}`,
        agentId: `agent-${input.runId}`,
        status,
        role,
        runPhase,
        runKind,
        workspaceKey: input.workspaceKey ?? `workspace-${input.runId}`,
        workspacePath: input.workspacePath ?? `/tmp/${input.runId}`,
        gitBranchName: input.gitBranchName ?? null,
        prUrl: input.prUrl ?? null,
        prNumber: input.prNumber ?? null,
        prHeadSha: input.prHeadSha ?? null,
        prBranch: input.prBranch ?? null,
      }),
    );
  }
  return snapshots;
}

function runEvidenceSnapshot(
  current: IssueCurrentFields,
  input: {
    historySnapshotId: string;
    snapshotAt: string;
    eventType: string;
    runId: string;
    sessionId?: string | null;
    agentId?: string | null;
    status: string;
    role: AgentRunRole;
    runPhase: AgentRunPhase;
    runKind: AgentRunKind;
    prompt?: string | null;
    promptCharCount?: number | null;
    startedAt?: string | null;
    updatedAt?: string | null;
    completedAt?: string;
    error?: string;
    tokens?: TokenCounts | null;
    attempt?: number | null;
    turnNumber?: number | null;
    harnessId?: string | null;
    workspaceKey: string;
    workspacePath: string;
    gitBranchName?: string | null;
    prUrl?: string | null;
    prNumber?: number | null;
    prHeadSha?: string | null;
    prBranch?: string | null;
    sdkRunStatus?: string;
    sdkRunStatusSource?: string;
    cancellationOutcome?: string;
    cancelFailed?: boolean;
    promptTemplateKeys?: string[] | null;
  },
): IssueHistorySnapshot {
  return {
    ...current,
    snapshotId: `issue-snapshot:${input.historySnapshotId}`,
    snapshotAt: input.snapshotAt,
    triggerType: "orchestrator.tick",
    triggerId: `orchestrator.tick:${input.historySnapshotId}`,
    triggerAt: input.snapshotAt,
    triggerSource: "orchestrator",
    candidateSource: `evidence.run.${input.eventType}`,
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
    snapshotKind: "evidence",
    historySnapshotId: input.historySnapshotId,
    transitionKind: "record_evidence",
    transitionId: `transition:record_evidence:${input.historySnapshotId}`,
    rulesetId: "orchestrator.evidence.run",
    rulesetVersion: "test",
    rulesetFingerprint: "orchestrator.evidence.run@test:900",
    rulesetPriority: 900,
    reason: input.eventType,
    actions: [],
    errors: [],
    evidenceKind: "run",
    evidenceEventType: input.eventType,
    evidenceSourceId: input.runId,
    evidencePayload: null,
    runId: input.runId,
    runSessionId: input.sessionId ?? null,
    runAgentId: input.agentId ?? null,
    role: input.role,
    runPhase: input.runPhase,
    runKind: input.runKind,
    runStatus: input.status,
    runPrompt: input.prompt ?? null,
    runPromptCharCount: input.promptCharCount ?? null,
    runStartedAt: input.startedAt ?? null,
    runUpdatedAt: input.updatedAt ?? null,
    runCompletedAt: input.completedAt ?? null,
    runError: input.error ?? null,
    runTokens: input.tokens ?? null,
    runAttempt: input.attempt ?? null,
    runTurnNumber: input.turnNumber ?? null,
    runHarnessId: input.harnessId ?? null,
    runWorkspaceKey: input.workspaceKey,
    runWorkspacePath: input.workspacePath,
    runGitBranchName: input.gitBranchName ?? null,
    runPrUrl: input.prUrl ?? null,
    runPrNumber: input.prNumber ?? null,
    runPrHeadSha: input.prHeadSha ?? null,
    runPrBranch: input.prBranch ?? null,
    runSdkStatus: input.sdkRunStatus ?? null,
    runSdkStatusSource: input.sdkRunStatusSource ?? null,
    runCancellationRequestedAt: null,
    runCancellationOutcome: input.cancellationOutcome ?? null,
    runCancelFailed: input.cancelFailed ?? null,
    runFailureKind: null,
    runFailureDiagnosticCode: null,
    runPromptTemplateKeys: input.promptTemplateKeys ?? null,
  };
}

function expectHistoryRebuildMatchesCurrent(
  current: IssueCurrentFields,
  rebuilt: IssueCurrentStateHistoryRebuildResult,
): void {
  expect(rebuilt.incompleteGroups).toEqual([]);
  expect(rebuilt.sourceSnapshotIds.length).toBeGreaterThan(0);
  expect(pickCurrentFields(current, Object.keys(rebuilt.fields))).toEqual(
    rebuilt.fields,
  );
}

function pickCurrentFields(
  current: IssueCurrentFields,
  fieldNames: string[],
): Partial<IssueCurrentFields> {
  const picked: Partial<IssueCurrentFields> = {};
  for (const fieldName of fieldNames) {
    const key = fieldName as keyof IssueCurrentFields;
    Object.assign(picked, { [key]: current[key] });
  }
  return picked;
}

async function updateSqliteCurrentJson(
  databasePath: string,
  issueId: string,
  currentJson: string,
): Promise<void> {
  const database = await new Promise<sqlite3.Database>((resolve, reject) => {
    const opened = new sqlite3.Database(databasePath, (error) => {
      if (error) reject(error);
      else resolve(opened);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      database.run(
        "UPDATE issue_state SET current_json = ? WHERE issue_id = ?",
        [currentJson, issueId],
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      database.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

class MemoryIssueStateStore implements IssueStateStore {
  record: IssueStateRecord | null = null;
  getHistoryCalls = 0;

  async get(): Promise<IssueStateRecord | null> {
    return this.record;
  }

  async getCurrent(): Promise<IssueCurrentFields | null> {
    if (!this.record) return null;
    const { history: _history, ...current } = this.record;
    return current as IssueCurrentFields;
  }

  async getHistory(): Promise<IssueHistorySnapshot[] | null> {
    this.getHistoryCalls += 1;
    return this.record?.history ?? null;
  }

  async list(): Promise<IssueStateRecord[]> {
    return this.record ? [this.record] : [];
  }

  async ensureIssue(current: IssueCurrentFields): Promise<IssueStateRecord> {
    await this.ensureCurrent(current);
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async ensureCurrent(current: IssueCurrentFields): Promise<IssueCurrentFields> {
    this.record = { ...current, history: this.record?.history ?? [] };
    return current;
  }

  async updateCurrent(
    _issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueStateRecord> {
    await this.patchCurrent(_issue, patch);
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async patchCurrent(
    _issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueCurrentFields> {
    if (!this.record) throw new Error("missing record");
    const history = this.record.history;
    this.record = { ...this.record, ...patch, history };
    const { history: _history, ...current } = this.record;
    return current as IssueCurrentFields;
  }

  async appendSnapshot(
    _issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<IssueStateRecord> {
    await this.appendSnapshotOnly(_issue, snapshot);
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async appendSnapshotOnly(
    _issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<void> {
    if (!this.record) throw new Error("missing record");
    this.record = {
      ...this.record,
      history: [...this.record.history, snapshot],
    };
  }

  async updateSnapshotActions(): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async updateSnapshotActionsOnly(): Promise<boolean> {
    return this.record !== null;
  }

  async appendSnapshotAction(): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async appendSnapshotActionOnly(): Promise<boolean> {
    return this.record !== null;
  }

  async appendSnapshotError(): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async appendSnapshotErrorOnly(): Promise<boolean> {
    return this.record !== null;
  }
}
