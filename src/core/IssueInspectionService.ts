import type { ServiceConfig } from "./config/Config.js";
import { errorMessage } from "./errors.js";
import type {
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueReviewVerdictRecord,
  IssueTriageReportRecord,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunTranscriptStore,
  type WorkspaceRecord,
} from "./persistence/RunTranscriptStore.js";
import type { TrackerClient } from "./tracker/TrackerClient.js";
import { runKindForPhase, type Issue } from "./types.js";
import type {
  ManualAgentEligibilityResult,
  ManualAgentRunStage,
  Orchestrator,
} from "./orchestrator/Orchestrator.js";
import type { FileOperatorApprovalStore, OperatorApprovalRecord } from "./approval/OperatorApprovalService.js";
import type { FileWritebackOutboxStore, WritebackOperation } from "./writeback/WritebackOutbox.js";

export const DEFAULT_ISSUE_INSPECTION_STAGES: readonly ManualAgentRunStage[] = [
  "worker",
  "reviewer",
  "triage",
  "planner",
  "merge_conflict",
];

export interface IssueInspectionOptions {
  stages?: readonly ManualAgentRunStage[];
  includeRaw?: boolean;
  runsLimit?: number;
}

export interface IssueInspectionResult {
  issue: string;
  generatedAt: string;
  found: boolean;
  config: {
    workflowPath: string;
    activeStates: string[];
    reviewStates: string[];
    blockedStates: string[];
    handoffStates: string[];
    terminalStates: string[];
  };
  tracker: {
    status: "found" | "not_found" | "error";
    issue: Issue | null;
    error: string | null;
  };
  lifecycle: {
    found: boolean;
    summary: IssueLifecycleInspectionSummary | null;
  };
  workspace: WorkspaceRecord | null;
  latest: {
    completionReport: CompletionReportInspectionSummary | null;
    reviewVerdict: ReviewVerdictInspectionSummary | null;
    issueTriageReport: IssueTriageInspectionSummary | null;
    run: RunInspectionSummary | null;
    pendingApproval: OperatorApprovalInspectionSummary | null;
  };
  runs: {
    count: number;
    recent: RunInspectionSummary[];
  };
  writebacks: {
    count: number;
    pendingCount: number;
    pending: WritebackInspectionSummary[];
    recent: WritebackInspectionSummary[];
  };
  eligibility: Partial<Record<ManualAgentRunStage, ManualAgentEligibilityResult>>;
  raw?: {
    lifecycle: IssueLifecycleRecord | null;
    runs: RunRecord[];
    writebacks: WritebackOperation[];
    pendingApproval: OperatorApprovalRecord | null;
  };
}

export interface IssueLifecycleInspectionSummary {
  issueId: string;
  issueIdentifier: string;
  phase: IssueLifecycleRecord["phase"];
  blockedReason: string | null;
  reviewRound: number;
  incompleteTurnCount: number;
  planningFailureCount: number;
  planningDispatchRetryCount: number;
  lastIssueBreakdownPlanId: string | null;
  lastIssueTriageReportId: string | null;
  lastCompletionReportId: string | null;
  lastReviewVerdictId: string | null;
  summaryPointers: IssueLifecycleRecord["summaryPointers"];
  counts: {
    issueBreakdownPlans: number;
    completionReports: number;
    reviewVerdicts: number;
    reviewFeedback: number;
    issueTriageReports: number;
    reviewEvidence: number;
    mergeConflictResolutionReports: number;
  };
  mergeGate: {
    status: string | null;
    blockerFingerprint: string | null;
    repairRound: number | null;
    updatedAt: string | null;
  } | null;
  mergeConflict: {
    status: string;
    resolutionStatus: string;
    fixTurnCount: number;
    maxFixTurns: number;
    blockedReason: string | null;
  } | null;
  updatedAt: string;
}

export interface CompletionReportInspectionSummary {
  id: string;
  runId: string;
  summary: string;
  acceptedAt: string;
  changedFiles: string[];
  validationEvidence: string[];
  pullRequest: IssueCompletionReportRecord["pullRequest"];
}

export interface ReviewVerdictInspectionSummary {
  id: string;
  runId: string;
  verdict: IssueReviewVerdictRecord["verdict"];
  submittedAt: string;
  findings: string[];
  gateFindings: IssueReviewVerdictRecord["gateFindings"];
  discoveryFindings: IssueReviewVerdictRecord["discoveryFindings"];
  unsatisfiedAcceptanceCount: number;
  evidence: string[];
}

export interface IssueTriageInspectionSummary {
  id: string;
  runId: string;
  disposition: IssueTriageReportRecord["disposition"];
  confidence: IssueTriageReportRecord["confidence"];
  submittedAt: string;
  triggerFingerprint: string;
  summary: string;
  recommendedAction: string;
  blockers: IssueTriageReportRecord["blockers"];
}

export interface RunInspectionSummary {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  role: RunRecord["role"];
  runPhase: RunRecord["runPhase"];
  runKind: RunRecord["runKind"];
  issueId: string;
  issueIdentifier: string;
  status: RunRecord["status"];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  workspaceKey: string;
  workspacePath: string;
  attempt: number | null;
  turnNumber: number;
  promptCharCount: number | null;
  ephemeralSystemPromptCharCount: number | null;
  prUrl: string | null;
  prNumber: number | null;
  ciStatus: string | null;
  manualDispatch: boolean;
  manualDispatchStage: string | null;
  hermesSessionKey: string | null;
  hermesSessionResumed: boolean | null;
  handoffRepairKind: string | null;
}

export interface WritebackInspectionSummary {
  idempotencyKey: string;
  kind: WritebackOperation["kind"];
  issueId: string;
  runId: string | null;
  status: WritebackOperation["status"];
  attempt: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  lastError: string | null;
  resultStatus: string | null;
  resultMessage: string | null;
  payloadPreview: string;
}

export interface OperatorApprovalInspectionSummary {
  requestId: string;
  status: OperatorApprovalRecord["status"];
  issueId: string;
  issueIdentifier: string;
  runId: string;
  evidenceCursor: string;
  requestedAt: string;
  expiresAt: string | null;
  actionKind: OperatorApprovalRecord["action"]["kind"];
  branchName: string;
  baseBranch: string;
  changedFiles: string[];
}

export class IssueInspectionService {
  constructor(
    private readonly options: {
      config: ServiceConfig;
      tracker: TrackerClient;
      lifecycleStore: Pick<IssueLifecycleStore, "get">;
      runStore: Pick<RunTranscriptStore, "findWorkspace" | "listRunsForIssue" | "latestRunForIssue">;
      writebackOutbox?: Pick<FileWritebackOutboxStore, "list">;
      approvalStore?: Pick<FileOperatorApprovalStore, "findPendingForIssue">;
      orchestrator: Pick<Orchestrator, "inspectManualAgentEligibilityForIssue">;
    },
  ) {}

  async inspect(issueIdOrIdentifier: string, options: IssueInspectionOptions = {}): Promise<IssueInspectionResult> {
    const generatedAt = new Date().toISOString();
    const runsLimit = Math.max(1, Math.min(options.runsLimit ?? 10, 100));
    const tracker = await this.fetchTrackerIssue(issueIdOrIdentifier);
    const lifecycle = await this.loadLifecycle(issueIdOrIdentifier, tracker.issue);
    const keys = issueKeys(issueIdOrIdentifier, tracker.issue, lifecycle);
    const [runs, workspace, pendingApproval, writebacks] = await Promise.all([
      this.loadRuns(keys),
      this.loadWorkspace(keys),
      this.options.approvalStore?.findPendingForIssue(keys) ?? Promise.resolve(null),
      this.loadWritebacks(keys),
    ]);
    const latestRun = latestRunFrom(runs);
    const stages = [...new Set(options.stages ?? DEFAULT_ISSUE_INSPECTION_STAGES)];
    const eligibility = await this.inspectEligibility(stages, tracker);
    const recentRuns = runs.slice().reverse().slice(0, runsLimit);
    const recentWritebacks = writebacks
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 25);
    const pendingWritebacks = writebacks.filter((operation) =>
      operation.status === "pending" || operation.status === "in_flight" || operation.status === "retrying",
    );

    return {
      issue: issueIdOrIdentifier,
      generatedAt,
      found:
        tracker.status === "found" ||
        lifecycle !== null ||
        runs.length > 0 ||
        workspace !== null ||
        writebacks.length > 0 ||
        pendingApproval !== null,
      config: {
        workflowPath: this.options.config.workflowPath,
        activeStates: [...this.options.config.tracker.activeStates],
        reviewStates: [...this.options.config.reviewLoop.reviewStates],
        blockedStates: [...this.options.config.reviewLoop.blockedStates],
        handoffStates: [...this.options.config.tracker.handoffStates],
        terminalStates: [...this.options.config.tracker.terminalStates],
      },
      tracker,
      lifecycle: {
        found: lifecycle !== null,
        summary: lifecycle === null ? null : lifecycleSummary(lifecycle),
      },
      workspace,
      latest: {
        completionReport: completionReportSummary(latestCompletionReport(lifecycle)),
        reviewVerdict: reviewVerdictSummary(latestReviewVerdict(lifecycle)),
        issueTriageReport: issueTriageSummary(latestIssueTriageReport(lifecycle)),
        run: latestRun === null ? null : runSummary(latestRun),
        pendingApproval: pendingApproval === null ? null : approvalSummary(pendingApproval),
      },
      runs: {
        count: runs.length,
        recent: recentRuns.map(runSummary),
      },
      writebacks: {
        count: writebacks.length,
        pendingCount: pendingWritebacks.length,
        pending: pendingWritebacks.map(writebackSummary),
        recent: recentWritebacks.map(writebackSummary),
      },
      eligibility,
      ...(options.includeRaw === true
        ? {
            raw: {
              lifecycle,
              runs: recentRuns,
              writebacks: recentWritebacks,
              pendingApproval,
            },
          }
        : {}),
    };
  }

  private async fetchTrackerIssue(
    issueIdOrIdentifier: string,
  ): Promise<IssueInspectionResult["tracker"]> {
    try {
      const issue = (await this.options.tracker.fetchIssueStatesByIds([issueIdOrIdentifier]))[0] ?? null;
      return {
        status: issue === null ? "not_found" : "found",
        issue,
        error: null,
      };
    } catch (error) {
      return {
        status: "error",
        issue: null,
        error: errorMessage(error),
      };
    }
  }

  private async loadLifecycle(issueIdOrIdentifier: string, issue: Issue | null): Promise<IssueLifecycleRecord | null> {
    return (
      (issue === null ? null : await this.options.lifecycleStore.get(issue.id)) ??
      (issue === null ? null : await this.options.lifecycleStore.get(issue.identifier)) ??
      (await this.options.lifecycleStore.get(issueIdOrIdentifier))
    );
  }

  private async loadRuns(keys: string[]): Promise<RunRecord[]> {
    const byId = new Map<string, RunRecord>();
    for (const key of keys) {
      for (const run of await this.options.runStore.listRunsForIssue(key)) {
        byId.set(run.runId, run);
      }
    }
    return [...byId.values()].sort(compareRunChronology);
  }

  private async loadWorkspace(keys: string[]): Promise<WorkspaceRecord | null> {
    for (const key of keys) {
      const workspace = await this.options.runStore.findWorkspace(key);
      if (workspace) return workspace;
    }
    return null;
  }

  private async loadWritebacks(keys: string[]): Promise<WritebackOperation[]> {
    if (!this.options.writebackOutbox) return [];
    const normalized = normalizeKeySet(keys);
    return (await this.options.writebackOutbox.list()).filter((operation) => writebackTouchesIssue(operation, normalized));
  }

  private async inspectEligibility(
    stages: ManualAgentRunStage[],
    tracker: IssueInspectionResult["tracker"],
  ): Promise<Partial<Record<ManualAgentRunStage, ManualAgentEligibilityResult>>> {
    const result: Partial<Record<ManualAgentRunStage, ManualAgentEligibilityResult>> = {};
    for (const stage of stages) {
      const target = manualStageTarget(stage);
      if (!tracker.issue) {
        result[stage] = {
          issue: null,
          role: target.role,
          runPhase: target.runPhase,
          runKind: target.runKind,
          eligible: false,
          reason: tracker.status === "error" ? "tracker_fetch_failed" : "issue_not_found",
          explanation: tracker.error,
        };
        continue;
      }
      result[stage] = await this.options.orchestrator.inspectManualAgentEligibilityForIssue(tracker.issue, { stage });
    }
    return result;
  }
}

function issueKeys(
  issueIdOrIdentifier: string,
  issue: Issue | null,
  lifecycle: IssueLifecycleRecord | null,
): string[] {
  return uniqueStrings([
    issueIdOrIdentifier,
    issue?.id,
    issue?.identifier,
    lifecycle?.issueId,
    lifecycle?.issueIdentifier,
    lifecycle?.summaryPointers.workspaceKey,
  ]);
}

function normalizeKeySet(keys: readonly string[]): Set<string> {
  return new Set(keys.map((key) => key.toLowerCase()));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function latestRunFrom(runs: readonly RunRecord[]): RunRecord | null {
  return runs[runs.length - 1] ?? null;
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord | null): IssueCompletionReportRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function latestReviewVerdict(lifecycle: IssueLifecycleRecord | null): IssueReviewVerdictRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastReviewVerdictId) {
    const exact = lifecycle.reviewVerdicts.find((verdict) => verdict.id === lifecycle.lastReviewVerdictId);
    if (exact) return exact;
  }
  return lifecycle.reviewVerdicts[lifecycle.reviewVerdicts.length - 1] ?? null;
}

function latestIssueTriageReport(lifecycle: IssueLifecycleRecord | null): IssueTriageReportRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastIssueTriageReportId) {
    const exact = lifecycle.issueTriageReports.find((report) => report.id === lifecycle.lastIssueTriageReportId);
    if (exact) return exact;
  }
  return lifecycle.issueTriageReports[lifecycle.issueTriageReports.length - 1] ?? null;
}

function lifecycleSummary(lifecycle: IssueLifecycleRecord): IssueLifecycleInspectionSummary {
  return {
    issueId: lifecycle.issueId,
    issueIdentifier: lifecycle.issueIdentifier,
    phase: lifecycle.phase,
    blockedReason: lifecycle.blockedReason,
    reviewRound: lifecycle.reviewRound,
    incompleteTurnCount: lifecycle.incompleteTurnCount,
    planningFailureCount: lifecycle.planningFailureCount,
    planningDispatchRetryCount: lifecycle.planningDispatchRetryCount,
    lastIssueBreakdownPlanId: lifecycle.lastIssueBreakdownPlanId,
    lastIssueTriageReportId: lifecycle.lastIssueTriageReportId,
    lastCompletionReportId: lifecycle.lastCompletionReportId,
    lastReviewVerdictId: lifecycle.lastReviewVerdictId,
    summaryPointers: lifecycle.summaryPointers,
    counts: {
      issueBreakdownPlans: lifecycle.issueBreakdownPlans.length,
      completionReports: lifecycle.completionReports.length,
      reviewVerdicts: lifecycle.reviewVerdicts.length,
      reviewFeedback: lifecycle.reviewFeedback.length,
      issueTriageReports: lifecycle.issueTriageReports.length,
      reviewEvidence: lifecycle.reviewEvidence.items.length,
      mergeConflictResolutionReports: lifecycle.mergeConflictResolutionReports.length,
    },
    mergeGate: lifecycle.mergeGate
      ? {
          status: lifecycle.mergeGate.status,
          blockerFingerprint: lifecycle.mergeGate.blockerFingerprint,
          repairRound: lifecycle.mergeGate.reviewRound,
          updatedAt: lifecycle.mergeGate.updatedAt,
        }
      : null,
    mergeConflict: lifecycle.mergeConflict
      ? {
          status: lifecycle.mergeConflict.status,
          resolutionStatus: lifecycle.mergeConflict.resolutionStatus,
          fixTurnCount: lifecycle.mergeConflict.fixTurnCount,
          maxFixTurns: lifecycle.mergeConflict.maxFixTurns,
          blockedReason: lifecycle.mergeConflict.blockedReason,
        }
      : null,
    updatedAt: lifecycle.updatedAt,
  };
}

function completionReportSummary(
  report: IssueCompletionReportRecord | null,
): CompletionReportInspectionSummary | null {
  if (!report) return null;
  return {
    id: report.id,
    runId: report.runId,
    summary: report.summary,
    acceptedAt: report.acceptedAt,
    changedFiles: report.changedFiles,
    validationEvidence: report.validationEvidence,
    pullRequest: report.pullRequest,
  };
}

function reviewVerdictSummary(report: IssueReviewVerdictRecord | null): ReviewVerdictInspectionSummary | null {
  if (!report) return null;
  return {
    id: report.id,
    runId: report.runId,
    verdict: report.verdict,
    submittedAt: report.submittedAt,
    findings: report.findings,
    gateFindings: report.gateFindings,
    discoveryFindings: report.discoveryFindings,
    unsatisfiedAcceptanceCount: report.acceptanceResults.filter((item) => !item.satisfied).length,
    evidence: report.evidence,
  };
}

function issueTriageSummary(report: IssueTriageReportRecord | null): IssueTriageInspectionSummary | null {
  if (!report) return null;
  return {
    id: report.id,
    runId: report.runId,
    disposition: report.disposition,
    confidence: report.confidence,
    submittedAt: report.submittedAt,
    triggerFingerprint: report.triggerFingerprint,
    summary: report.summary,
    recommendedAction: report.recommendedAction,
    blockers: report.blockers,
  };
}

function runSummary(run: RunRecord): RunInspectionSummary {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    agentId: run.agentId,
    role: run.role,
    runPhase: run.runPhase,
    runKind: run.runKind,
    issueId: run.issueId,
    issueIdentifier: run.issueIdentifier,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    error: run.error,
    workspaceKey: run.workspaceKey,
    workspacePath: run.workspacePath,
    attempt: run.attempt,
    turnNumber: run.turnNumber,
    promptCharCount: run.promptCharCount ?? null,
    ephemeralSystemPromptCharCount: run.ephemeralSystemPromptCharCount ?? null,
    prUrl: run.prUrl ?? null,
    prNumber: run.prNumber ?? null,
    ciStatus: run.ciStatus ?? null,
    manualDispatch: run.manualDispatch === true,
    manualDispatchStage: run.manualDispatchStage ?? null,
    hermesSessionKey: run.hermesSessionKey ?? null,
    hermesSessionResumed: run.hermesSessionResumed ?? null,
    handoffRepairKind: run.handoffRepairKind ?? null,
  };
}

function approvalSummary(record: OperatorApprovalRecord): OperatorApprovalInspectionSummary {
  return {
    requestId: record.requestId,
    status: record.status,
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    runId: record.runId,
    evidenceCursor: record.evidenceCursor,
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt,
    actionKind: record.action.kind,
    branchName: record.action.branchName,
    baseBranch: record.action.baseBranch,
    changedFiles: record.action.changedFiles,
  };
}

function writebackSummary(operation: WritebackOperation): WritebackInspectionSummary {
  return {
    idempotencyKey: operation.idempotencyKey,
    kind: operation.kind,
    issueId: operation.issueId,
    runId: operation.runId ?? null,
    status: operation.status,
    attempt: operation.attempt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    nextAttemptAt: operation.nextAttemptAt,
    lastError: operation.lastError,
    resultStatus: operation.resultStatus,
    resultMessage: operation.resultMessage,
    payloadPreview: previewJson(operation.payload),
  };
}

function previewJson(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered.length <= 240) return rendered;
  return `${rendered.slice(0, 237)}...`;
}

function writebackTouchesIssue(operation: WritebackOperation, keys: Set<string>): boolean {
  if (keys.has(operation.issueId.toLowerCase())) return true;
  if (operation.kind === "issue_create") return keys.has(operation.payload.parentIssueId.toLowerCase());
  if (operation.kind === "issue_relation") {
    return (
      keys.has(operation.payload.sourceIssueId.toLowerCase()) ||
      keys.has(operation.payload.targetIssueId.toLowerCase()) ||
      (operation.payload.sourceIssueIdentifier !== null &&
        keys.has(operation.payload.sourceIssueIdentifier.toLowerCase())) ||
      (operation.payload.targetIssueIdentifier !== null &&
        keys.has(operation.payload.targetIssueIdentifier.toLowerCase()))
    );
  }
  return false;
}

function manualStageTarget(stage: ManualAgentRunStage): Pick<ManualAgentEligibilityResult, "role" | "runPhase" | "runKind"> {
  switch (stage) {
    case "worker":
      return { role: "worker", runPhase: "implementation", runKind: runKindForPhase("implementation") };
    case "reviewer":
      return { role: "reviewer", runPhase: "review", runKind: runKindForPhase("review") };
    case "triage":
      return { role: "triage", runPhase: "issue_triage", runKind: runKindForPhase("issue_triage") };
    case "planner":
      return { role: "planner", runPhase: "issue_breakdown", runKind: runKindForPhase("issue_breakdown") };
    case "merge_conflict":
      return { role: "worker", runPhase: "merge_conflict_resolution", runKind: runKindForPhase("merge_conflict_resolution") };
  }
}
