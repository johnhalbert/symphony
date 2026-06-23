import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIssueStateStore } from "../src/core/orchestration/FileIssueStateStore.js";
import { SqliteIssueStateStore } from "../src/core/orchestration/SqliteIssueStateStore.js";
import { IssueOrchestrationEngine } from "../src/core/orchestration/IssueOrchestrationEngine.js";
import {
  createIssueSnapshotId,
  transitionAction,
  transitionErrorFromUnknown,
  type IssueCurrentFields,
  type IssueCurrentStateSnapshot,
} from "../src/core/orchestration/IssueOrchestrationState.js";

describe("SqliteIssueStateStore", () => {
  let root: string;
  const stores: SqliteIssueStateStore[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-issue-state-"));
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it("persists current issue state, appends flat history snapshots, and updates actions and errors", async () => {
    const store = new SqliteIssueStateStore(root);
    stores.push(store);
    const current = currentFields();
    await store.ensureIssue(current);
    const snapshot = new IssueOrchestrationEngine([
      {
        id: "dispatch.worker",
        priority: 100,
        evaluate: () => ({
          transitionKind: "dispatch_worker",
          role: "worker",
          runPhase: "implementation",
        }),
      },
    ]).decide(currentSnapshot(current), []);
    expect(snapshot).not.toBeNull();

    await store.appendSnapshot(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!,
    );
    const action = transitionAction({ actionType: "render_prompt" });
    const error = transitionErrorFromUnknown(new Error("boom"), {
      actionId: action.actionId,
    });
    await store.appendSnapshotAction(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!.historySnapshotId,
      action,
    );
    await store.appendSnapshotError(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!.historySnapshotId,
      error,
    );
    await expect(
      access(path.join(root, "issue-state.sqlite")),
    ).resolves.toBeUndefined();

    const reloaded = new SqliteIssueStateStore(root);
    stores.push(reloaded);
    const record = await reloaded.get(current.issueIdentifier);

    expect(record).toMatchObject({
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      history: [
        {
          snapshotKind: "transition",
          transitionKind: "dispatch_worker",
          rulesetId: "dispatch.worker",
          rulesetVersion: "unversioned",
          rulesetFingerprint: "dispatch.worker@unversioned:100",
          actions: [{ actionType: "render_prompt" }],
          errors: [{ message: "boom", actionId: action.actionId }],
        },
      ],
    });
    expect(record?.history[0]).not.toHaveProperty("current");
    expect(record?.history[0]).not.toHaveProperty("transitionRequest");
  });

  it("imports legacy flat-file issue state into sqlite on first open", async () => {
    const legacy = new FileIssueStateStore(root);
    const current = currentFields();
    await legacy.ensureIssue(current);
    const snapshot = new IssueOrchestrationEngine([
      {
        id: "dispatch.worker",
        priority: 100,
        version: "legacy-test-v1",
        evaluate: () => ({
          transitionKind: "dispatch_worker",
          role: "worker",
          runPhase: "implementation",
        }),
      },
    ]).decide(currentSnapshot(current), []);
    expect(snapshot).not.toBeNull();
    await legacy.appendSnapshot(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!,
    );

    const migrated = new SqliteIssueStateStore(root);
    stores.push(migrated);
    const record = await migrated.get(current.issueId);

    await expect(
      access(path.join(root, "issue-state.sqlite")),
    ).resolves.toBeUndefined();
    expect(record).toMatchObject({
      issueId: current.issueId,
      issueIdentifier: current.issueIdentifier,
      history: [
        {
          snapshotKind: "transition",
          transitionKind: "dispatch_worker",
          rulesetId: "dispatch.worker",
          rulesetVersion: "legacy-test-v1",
        },
      ],
    });
  });

  it("persists evidence snapshots in the same ordered issue history", async () => {
    const store = new SqliteIssueStateStore(root);
    stores.push(store);
    const current = currentFields();
    await store.ensureIssue(current);
    const snapshot = new IssueOrchestrationEngine([
      {
        id: "orchestrator.evidence.run",
        priority: 900,
        evaluate: () => ({
          transitionKind: "record_evidence",
          reason: "run_started",
          evidenceKind: "run",
          evidenceEventType: "run_started",
          evidenceSourceId: "run-1",
          evidencePayload: {
            runId: "run-1",
            role: "worker",
            runPhase: "implementation",
            runKind: "implementation",
            status: "running",
            sessionId: "session-1",
            attempt: 1,
            turnNumber: 2,
            harnessId: "codex",
            workspaceKey: "TEST-1",
            workspacePath: "/tmp/workspaces/TEST-1",
            promptTemplateKeys: ["worker.system", "worker.user"],
            tokens: {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
            },
          },
        }),
      },
    ]).decide(currentSnapshot(current), []);
    expect(snapshot).not.toBeNull();

    await store.appendSnapshot(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!,
    );
    const reloaded = new SqliteIssueStateStore(root);
    stores.push(reloaded);

    await expect(reloaded.get(current.issueIdentifier)).resolves.toMatchObject({
      history: [
        {
          snapshotKind: "evidence",
          transitionKind: "record_evidence",
          rulesetId: "orchestrator.evidence.run",
          evidenceKind: "run",
          evidenceEventType: "run_started",
          evidenceSourceId: "run-1",
          evidencePayload: {
            runId: "run-1",
            role: "worker",
          },
          runId: "run-1",
          role: "worker",
          runPhase: "implementation",
          runKind: "implementation",
          runStatus: "running",
          runSessionId: "session-1",
          runAttempt: 1,
          runTurnNumber: 2,
          runHarnessId: "codex",
          runWorkspaceKey: "TEST-1",
          runWorkspacePath: "/tmp/workspaces/TEST-1",
          runPromptTemplateKeys: ["worker.system", "worker.user"],
          runTokens: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
          },
        },
      ],
    });
  });

  it("reads ordered issue history without parsing cached current_json", async () => {
    const store = new SqliteIssueStateStore(root);
    stores.push(store);
    const current = currentFields();
    await store.ensureIssue(current);
    const snapshot = new IssueOrchestrationEngine([
      {
        id: "orchestrator.evidence.run",
        priority: 900,
        evaluate: () => ({
          transitionKind: "record_evidence",
          reason: "run_started",
          evidenceKind: "run",
          evidenceEventType: "run_started",
          evidenceSourceId: "run-1",
          evidencePayload: {
            runId: "run-1",
            role: "worker",
            runPhase: "implementation",
            runKind: "implementation",
            status: "running",
          },
        }),
      },
    ]).decide(currentSnapshot(current), []);
    expect(snapshot).not.toBeNull();
    await store.appendSnapshot(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!,
    );
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    await updateSqliteCurrentJson(
      path.join(root, "issue-state.sqlite"),
      current.issueId,
      "{not valid json",
    );
    const reloaded = new SqliteIssueStateStore(root);
    stores.push(reloaded);

    await expect(reloaded.getHistory(current.issueIdentifier)).resolves.toMatchObject([
      {
        snapshotKind: "evidence",
        transitionKind: "record_evidence",
        evidenceKind: "run",
        evidenceEventType: "run_started",
        runId: "run-1",
      },
    ]);
  });

  it("round-trips runtime requested transition context in snapshot json", async () => {
    const store = new SqliteIssueStateStore(root);
    stores.push(store);
    const current = currentFields();
    await store.ensureIssue(current);
    const snapshot = new IssueOrchestrationEngine([
      {
        id: "orchestrator.merge_policy.observe",
        priority: 150,
        evaluate: () => ({
          transitionKind: "merge_policy_observe",
          reason: "merge_policy_live_observation_required",
        }),
      },
    ]).decide(
      currentSnapshot(current, {
        triggerType: "runtime.requested",
        triggerSource: "transition",
        candidateSource: "merge_policy_candidates",
        transitionRequestContext: {
          kind: "merge_policy_chain",
          requestId: "transition-request-1",
          requestedAt: "2026-01-01T00:00:01.000Z",
          parentHistorySnapshotId: null,
          parentTransitionKind: null,
          payload: {
            chainId: "merge-policy-chain-1",
            iteration: 0,
            maxIterations: 6,
          },
        },
      }),
      [],
    );
    expect(snapshot).not.toBeNull();

    await store.appendSnapshot(
      { id: current.issueId, identifier: current.issueIdentifier },
      snapshot!,
    );
    const reloaded = new SqliteIssueStateStore(root);
    stores.push(reloaded);

    await expect(reloaded.get(current.issueIdentifier)).resolves.toMatchObject({
      history: [
        {
          triggerType: "runtime.requested",
          triggerSource: "transition",
          candidateSource: "merge_policy_candidates",
          transitionRequestContext: {
            kind: "merge_policy_chain",
            payload: {
              chainId: "merge-policy-chain-1",
              iteration: 0,
              maxIterations: 6,
            },
          },
        },
      ],
    });
  });
});

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

function currentFields(): IssueCurrentFields {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    version: 1,
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    title: "Test issue",
    description: "Body",
    priority: 1,
    trackerState: "Todo",
    branchName: null,
    trackerUrl: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: [],
    blockedBy: [],
    hasChildren: false,
    trackerCreatedAt: now,
    trackerUpdatedAt: now,
    phase: "implementation",
    reviewRound: 0,
    incompleteTurnCount: 0,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureAt: null,
    planningRetryDueAt: null,
    blockedReason: null,
    lastIssueBreakdownPlanId: null,
    lastIssueBreakdownPlanApplicationStatus: null,
    lastIssueBreakdownPlanIssueContentFingerprint: null,
    lastIssueBreakdownPlanConfigFingerprint: null,
    lastIssueBreakdownPlanSatisfiesCurrentValidation: false,
    currentIssueContentFingerprint: "issue-fingerprint",
    currentIssueBreakdownConfigFingerprint: "config-fingerprint",
    lastIssueTriageReportId: null,
    lastIssueTriageReportTriggerFingerprint: null,
    lastIssueTriageReportWritebackOperationKeys: null,
    currentIssueTriageTriggerFingerprint: null,
    issueTriageCurrentTriggerReportIds: [],
    latestIssueTriageReportBlockers: [],
    lastPostMortemReportId: null,
    lastPostMortemReportTriggerFingerprint: null,
    lastPostMortemReportWritebackOperationKeys: null,
    currentPostMortemTriggerFingerprint: null,
    postMortemCurrentTriggerReportIds: [],
    lastCompletionReportId: null,
    lastCompletionReportRejectionId: null,
    lastReviewVerdictId: null,
    lastMergeGateResultId: null,
    latestCompletionReport: null,
    latestApprovalPassVerdict: null,
    mergeGate: null,
    mergeConflict: null,
    lifecycleSummaryCiStatus: null,
    lifecyclePersistenceAvailable: false,
    mergePolicyMode: "manual",
    mergePolicySourceStates: [],
    mergePolicyDoneState: null,
    mergePolicyConflictsState: null,
    mergePolicyRequiredChecks: [],
    mergePolicyMaxMergeGateFailures: 0,
    mergePolicyConfigFingerprint: "merge-policy-config",
    currentMergePolicyObservationInputFingerprint: null,
    lastMergePolicyObservationFingerprint: null,
    lastMergePolicyObservationStatus: null,
    lastMergePolicyObservation: null,
    mergePolicyMerge: null,
    mergePolicyMergeGate: null,
    mergePolicyMergeGateResults: [],
    mergePolicyMergeConflict: null,
    mergePolicyLatestCompletionReport: null,
    mergePolicyLatestApprovalVerdict: null,
    mergePolicyReviewFeedback: [],
    mergePolicyLatestCompletionRun: null,
    pendingPublicationApprovalRunId: null,
    pendingPublicationApprovalReportId: null,
    pendingPublicationApprovalReason: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunRole: null,
    latestRunPhase: null,
    latestRunKind: null,
    latestRunCompletedAt: null,
    latestRunError: null,
    latestPrUrl: null,
    latestPrNumber: null,
    latestPrHeadSha: null,
    latestPrBranch: null,
    latestWorkspaceKey: null,
    latestWorkspacePath: null,
    latestGitBranchName: null,
    running: false,
    runningRole: null,
    runningRunPhase: null,
    runningRunKind: null,
    runningManualDispatchStage: null,
    runningManualIgnoreState: false,
    runningHasPendingPublicationApproval: false,
    runningCancellationRequested: false,
    claimed: false,
    paused: false,
    retrying: false,
    runtimeRetryDueAt: null,
    consecutiveSdkErrorFailures: 0,
    consecutiveInfraFailures: 0,
    recordCreatedAt: now,
    recordUpdatedAt: now,
  };
}

function currentSnapshot(
  current: IssueCurrentFields,
  overrides: Partial<IssueCurrentStateSnapshot> = {},
): IssueCurrentStateSnapshot {
  const now = "2026-01-01T00:00:01.000Z";
  return {
    ...current,
    snapshotId: createIssueSnapshotId(),
    snapshotAt: now,
    triggerType: "orchestrator.tick",
    triggerId: "tick-1",
    triggerAt: now,
    triggerSource: "orchestrator",
    candidateSource: "test",
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
    ...overrides,
  };
}
