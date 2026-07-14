import type { ServiceConfig } from "../config/Config.js";
import { pendingPublicationHandoffForRun } from "../CompletionReportService.js";
import type { Logger } from "../logging/StructuredLogger.js";
import {
  latestCurrentApprovalPassVerdict,
  latestCurrentCompletionReport,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueLifecycleStore,
} from "../persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { Issue } from "../types.js";
import { IssueCurrentStateBuilder } from "./IssueCurrentStateBuilder.js";
import { issueHistorySnapshotFromRequest } from "./IssueOrchestrationEngine.js";
import type {
  IssueEvidenceKind,
  IssueStateStore,
  IssueTriggerSource,
  IssueTriggerType,
  TransitionRuleset,
} from "./IssueOrchestrationState.js";

const ISSUE_HISTORY_RULESET_VERSION = "2026-06-21.issue-history-v1";
const RECORD_EVIDENCE_RULESET_PRIORITY = 900;

export interface IssueLifecycleEvidenceRecorderOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  runStore?: RunTranscriptStore;
  issueStateStore: IssueStateStore;
  logger: Pick<Logger, "warn">;
}

export interface RecordLifecycleEvidenceInput {
  issue: Issue;
  lifecycle: IssueLifecycleRecord;
  patch: IssueLifecyclePatch;
  eventType?: string;
  sourceId?: string | null;
  reason?: string | null;
  triggerType?: IssueTriggerType;
  triggerSource?: IssueTriggerSource;
  audit?: Record<string, unknown>;
}

export class IssueLifecycleEvidenceRecorder {
  private readonly builder: IssueCurrentStateBuilder;

  constructor(private readonly options: IssueLifecycleEvidenceRecorderOptions) {
    this.builder = new IssueCurrentStateBuilder({
      config: options.config,
      lifecycleStore: options.lifecycleStore,
      runStore: options.runStore,
      issueStateStore: options.issueStateStore,
      logger: options.logger,
    });
  }

  async record(input: RecordLifecycleEvidenceInput): Promise<string> {
    return this.recordEvidenceSnapshot({
      issue: input.issue,
      evidenceKind: "lifecycle",
      eventType: input.eventType ?? "lifecycle_updated",
      sourceId: input.sourceId ?? null,
      reason: input.reason ?? input.eventType ?? "lifecycle_updated",
      triggerType: input.triggerType ?? "orchestrator.tick",
      triggerSource: input.triggerSource ?? "orchestrator",
      payload: lifecycleEvidencePayload(input.lifecycle, input.patch, input.audit),
    });
  }

  private async recordEvidenceSnapshot(input: {
    issue: Issue;
    evidenceKind: IssueEvidenceKind;
    eventType: string;
    sourceId: string | null;
    reason: string | null;
    triggerType: IssueTriggerType;
    triggerSource: IssueTriggerSource;
    payload: unknown;
  }): Promise<string> {
    const snapshot = await this.builder.buildSnapshot(input.issue, emptyRuntimeState(), {
      triggerType: input.triggerType,
      triggerSource: input.triggerSource,
      candidateSource: `evidence.${input.evidenceKind}.${safeEvidenceSegment(input.eventType)}`,
      transitionRequestContext: null,
      availableSlots: 0,
      providerDispatchGateActive: false,
      stateSlotAvailable: false,
      allowExistingClaim: false,
      manualStage: null,
      manualForceLabels: false,
      manualIgnoreState: false,
    });
    await this.options.issueStateStore.ensureCurrent(snapshot);

    const ruleset = evidenceRuleset(input.evidenceKind);
    const historySnapshot = issueHistorySnapshotFromRequest(
      snapshot,
      {
        transitionKind: "record_evidence",
        reason: input.reason,
        evidenceKind: input.evidenceKind,
        evidenceEventType: input.eventType,
        evidenceSourceId: input.sourceId,
        evidencePayload: input.payload,
      },
      ruleset,
    );
    await this.options.issueStateStore.appendSnapshotOnly(input.issue, historySnapshot);
    return historySnapshot.historySnapshotId;
  }
}

function lifecycleEvidencePayload(
  lifecycle: IssueLifecycleRecord,
  patch: IssueLifecyclePatch,
  audit: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const pendingPublication = pendingPublicationHandoffForRun(lifecycle);
  return {
    patch,
    updatedAt: lifecycle.updatedAt,
    phase: lifecycle.phase,
    blockedReason: lifecycle.blockedReason,
    reviewRound: lifecycle.reviewRound,
    incompleteTurnCount: lifecycle.incompleteTurnCount,
    planningFailureCount: lifecycle.planningFailureCount,
    planningDispatchRetryCount: lifecycle.planningDispatchRetryCount,
    lastPlanningFailureAt: lifecycle.lastPlanningFailureAt ?? null,
    lastIssueBreakdownPlanId: lifecycle.lastIssueBreakdownPlanId ?? null,
    issueBreakdownPlans: lifecycle.issueBreakdownPlans,
    lastIssueTriageReportId: lifecycle.lastIssueTriageReportId ?? null,
    issueTriageReports: lifecycle.issueTriageReports,
    lastPostMortemReportId: lifecycle.lastPostMortemReportId ?? null,
    postMortemReports: lifecycle.postMortemReports,
    lastCompletionReportId: lifecycle.lastCompletionReportId ?? null,
    lastCompletionReportRejectionId: lifecycle.lastCompletionReportRejectionId ?? null,
    lastReviewVerdictId: lifecycle.lastReviewVerdictId ?? null,
    lastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
    pendingPublicationApprovalRunId: pendingPublication?.pendingReport.runId ?? null,
    pendingPublicationApprovalReportId: pendingPublication?.pendingReport.id ?? null,
    pendingPublicationApprovalReason: pendingPublication === null ? null : lifecycle.blockedReason ?? null,
    latestCompletionReport: latestCurrentCompletionReport(lifecycle),
    latestApprovalPassVerdict: latestCurrentApprovalPassVerdict(lifecycle),
    acceptedArtifact: lifecycle.acceptedArtifact ?? null,
    workspaceSeed: lifecycle.workspaceSeed ?? null,
    merge: lifecycle.merge ?? null,
    mergeGate: lifecycle.mergeGate ?? null,
    mergeGateResults: lifecycle.mergeGateResults ?? [],
    mergeConflict: lifecycle.mergeConflict ?? null,
    reviewFeedback: lifecycle.reviewFeedback,
    baseRefObservation: lifecycle.baseRefObservation,
    preservedWorktreeStashes: lifecycle.preservedWorktreeStashes ?? [],
    summaryPointers: lifecycle.summaryPointers,
    ...(audit === undefined ? {} : { audit }),
  };
}

function emptyRuntimeState() {
  return {
    runningEntry: null,
    running: false,
    claimed: false,
    paused: false,
    retrying: false,
    retryDueAt: null,
  };
}

function evidenceRuleset(evidenceKind: IssueEvidenceKind): TransitionRuleset {
  const id = `orchestrator.evidence.${evidenceKind}`;
  return {
    id,
    priority: RECORD_EVIDENCE_RULESET_PRIORITY,
    version: ISSUE_HISTORY_RULESET_VERSION,
    fingerprint: `${id}@${ISSUE_HISTORY_RULESET_VERSION}:${RECORD_EVIDENCE_RULESET_PRIORITY}`,
    evaluate: () => null,
  };
}

function safeEvidenceSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}
