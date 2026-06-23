import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseServiceConfig,
  type ServiceConfig,
} from "../src/core/config/Config.js";
import {
  IssueCurrentStateBuilder,
  type IssueCurrentStateRuntimeState,
} from "../src/core/orchestration/IssueCurrentStateBuilder.js";
import {
  transitionAction,
  type IssueCurrentFields,
  type IssueHistorySnapshot,
  type IssueStateRecord,
  type IssueStateStore,
} from "../src/core/orchestration/IssueOrchestrationState.js";
import {
  FileIssueLifecycleStore,
  type IssueLifecycleRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { Issue } from "../src/core/types.js";

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

  it("reuses a fresh merge policy observation from issue history", async () => {
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
      history: [
        {
          transitionKind: "merge_policy_observe",
          actions: [
            transitionAction({
              actionType: "record_merge_policy_observation",
              status: "succeeded",
              details: observation,
            }),
          ],
        } as IssueHistorySnapshot,
      ],
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
      blockedBy: [{ id: "dep-1", identifier: "TEST-0", state: "Todo" }],
      hasChildren: true,
      trackerUpdatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(current.currentIssueContentFingerprint).not.toBe(
      liveCurrent.currentIssueContentFingerprint,
    );
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
      history: [lifecycleEvidenceSnapshot(storeCurrent, historyLifecycle)],
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
    const lifecycle = await lifecycleStore.ensureIssue(issue, {
      phase: "passed",
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
    const storeCurrent = await storeBuilder.build(issue, emptyRuntime());
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
      lastCompletionReportId: lifecycle.lastCompletionReportId,
      lastCompletionReportRejectionId:
        lifecycle.lastCompletionReportRejectionId,
      lastReviewVerdictId: lifecycle.lastReviewVerdictId,
      lastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
      latestCompletionReport,
      latestApprovalPassVerdict,
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
    lifecycleLastCompletionReportId: lifecycle.lastCompletionReportId,
    lifecycleLastCompletionReportRejectionId:
      lifecycle.lastCompletionReportRejectionId,
    lifecycleLastReviewVerdictId: lifecycle.lastReviewVerdictId,
    lifecycleLastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
    lifecycleLatestCompletionReport: latestCompletionReport,
    lifecycleLatestApprovalPassVerdict: latestApprovalPassVerdict,
    lifecycleSummaryCiStatus: lifecycle.summaryPointers.ciStatus,
    lifecycleSummaryPointers: lifecycle.summaryPointers,
  };
}

function latestCompletionReportForTestLifecycle(
  lifecycle: IssueLifecycleRecord,
): IssueLifecycleRecord["completionReports"][number] | null {
  if (lifecycle.lastCompletionReportId) {
    return (
      lifecycle.completionReports.find(
        (report) => report.id === lifecycle.lastCompletionReportId,
      ) ?? null
    );
  }
  return lifecycle.completionReports.at(-1) ?? null;
}

function latestApprovalPassVerdictForTestLifecycle(
  lifecycle: IssueLifecycleRecord,
): IssueLifecycleRecord["reviewVerdicts"][number] | null {
  for (const verdict of lifecycle.reviewVerdicts.slice().reverse()) {
    if (
      verdict.verdict === "pass" &&
      verdict.issueId === lifecycle.issueId &&
      verdict.issueIdentifier === lifecycle.issueIdentifier &&
      !verdict.supersededAt
    ) {
      return verdict;
    }
  }
  return null;
}

function runEvidenceSnapshots(
  current: IssueCurrentFields,
  input: { runId: string; completedAt: string },
): IssueHistorySnapshot[] {
  const startedAt = "2026-01-01T00:00:00.000Z";
  return [
    runEvidenceSnapshot(current, {
      historySnapshotId: `issue-history:${input.runId}:started`,
      snapshotAt: startedAt,
      eventType: "run_started",
      runId: input.runId,
      status: "running",
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      workspaceKey: `workspace-${input.runId}`,
      workspacePath: `/tmp/${input.runId}`,
    }),
    runEvidenceSnapshot(current, {
      historySnapshotId: `issue-history:${input.runId}:terminal`,
      snapshotAt: input.completedAt,
      eventType: "run_terminal_state_updated",
      runId: input.runId,
      status: "failed",
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      completedAt: input.completedAt,
      error: "sdk failed",
      workspaceKey: `workspace-${input.runId}`,
      workspacePath: `/tmp/${input.runId}`,
      sdkRunStatus: "error",
      sdkRunStatusSource: "wait",
      cancellationOutcome: "none",
      cancelFailed: false,
    }),
  ];
}

function runEvidenceSnapshot(
  current: IssueCurrentFields,
  input: {
    historySnapshotId: string;
    snapshotAt: string;
    eventType: string;
    runId: string;
    status: string;
    role: "worker";
    runPhase: "implementation";
    runKind: "implementation";
    completedAt?: string;
    error?: string;
    workspaceKey: string;
    workspacePath: string;
    sdkRunStatus?: string;
    sdkRunStatusSource?: string;
    cancellationOutcome?: string;
    cancelFailed?: boolean;
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
    role: input.role,
    runPhase: input.runPhase,
    runKind: input.runKind,
    runStatus: input.status,
    runCompletedAt: input.completedAt ?? null,
    runError: input.error ?? null,
    runWorkspaceKey: input.workspaceKey,
    runWorkspacePath: input.workspacePath,
    runSdkStatus: input.sdkRunStatus ?? null,
    runSdkStatusSource: input.sdkRunStatusSource ?? null,
    runCancellationRequestedAt: null,
    runCancellationOutcome: input.cancellationOutcome ?? null,
    runCancelFailed: input.cancelFailed ?? null,
    runFailureKind: null,
    runFailureDiagnosticCode: null,
  };
}

class MemoryIssueStateStore implements IssueStateStore {
  record: IssueStateRecord | null = null;

  async get(): Promise<IssueStateRecord | null> {
    return this.record;
  }

  async list(): Promise<IssueStateRecord[]> {
    return this.record ? [this.record] : [];
  }

  async ensureIssue(current: IssueCurrentFields): Promise<IssueStateRecord> {
    this.record = { ...current, history: this.record?.history ?? [] };
    return this.record;
  }

  async updateCurrent(
    _issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    this.record = { ...this.record, ...patch };
    return this.record;
  }

  async appendSnapshot(
    _issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    this.record = {
      ...this.record,
      history: [...this.record.history, snapshot],
    };
    return this.record;
  }

  async updateSnapshotActions(): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async appendSnapshotAction(): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    return this.record;
  }

  async appendSnapshotError(): Promise<IssueStateRecord> {
    if (!this.record) throw new Error("missing record");
    return this.record;
  }
}
