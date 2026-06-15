import {
  buildIssueHandoffState,
  type CompletionReportPullRequestRef,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueCompletionReportRecord,
  type IssueMergeGateState,
  type IssueReviewVerdictRecord,
  latestCurrentApprovalPassVerdict,
} from "../persistence/IssueLifecycleStore.js";

export function shouldSilentlyRetireMergeGate(
  gate: IssueMergeGateState | null | undefined,
  currentHeadSha: string | null | undefined,
  pullRequestNumber: number | null | undefined,
): gate is IssueMergeGateState {
  return (
    isActiveMergeGate(gate) &&
    typeof currentHeadSha === "string" &&
    currentHeadSha.length > 0 &&
    pullRequestNumber !== null &&
    pullRequestNumber !== undefined &&
    gate.pullRequest.number === pullRequestNumber &&
    gate.headSha !== currentHeadSha
  );
}

export function staleMergeGateLifecyclePatch(
  lifecycle: IssueLifecycleRecord,
  currentHeadSha: string | null | undefined,
  pullRequestNumber: number | null | undefined,
): IssueLifecyclePatch | null {
  const gate = lifecycle.mergeGate ?? null;
  if (!shouldSilentlyRetireMergeGate(gate, currentHeadSha, pullRequestNumber)) return null;
  if (typeof currentHeadSha !== "string") return null;
  return supersededMergeGateLifecyclePatch(lifecycle, gate, currentHeadSha);
}

export function silentlyRetireMergeGate(gate: IssueMergeGateState, currentHeadSha: string): IssueMergeGateState {
  return inactiveMergeGate(gate, "superseded", currentHeadSha);
}

export function resolveMergeGate(gate: IssueMergeGateState): IssueMergeGateState {
  return inactiveMergeGate(gate, "resolved", null);
}

export function isActiveMergeGate(gate: IssueMergeGateState | null | undefined): gate is IssueMergeGateState {
  return gate !== null && gate !== undefined && gate.status !== "resolved" && gate.status !== "superseded";
}

export function hasRepairGateClearance(lifecycle: IssueLifecycleRecord, gate: IssueMergeGateState): boolean {
  if (gate.status === "blocked") return false;
  if (gate.status !== "repair_dispatched") return false;
  const repairReport = bindRepairCompletionReport(lifecycle, gate);
  if (!repairReport) return false;
  return resolveRepairGateClearanceApprovalVerdict(lifecycle, gate, repairReport) !== null;
}

export function canAutoResolveMergeGateOnCheckPass(lifecycle: IssueLifecycleRecord, gateId: string): boolean {
  const gate = lifecycle.mergeGate?.id === gateId ? lifecycle.mergeGate : null;
  if (!isActiveMergeGate(gate)) return latestCurrentApprovalPassVerdict(lifecycle) !== null;
  if (gate.status === "observing") return latestCurrentApprovalPassVerdict(lifecycle) !== null;
  if (gate.status === "blocked") return latestCurrentApprovalPassVerdict(lifecycle) !== null;
  return hasRepairGateClearance(lifecycle, gate);
}

export function inactiveMergeGateLifecyclePatch(
  lifecycle: IssueLifecycleRecord,
  gate: IssueMergeGateState,
  status: "resolved" | "superseded",
  supersededByHeadSha: string | null = null,
): IssueLifecyclePatch {
  const mergeGate = inactiveMergeGate(gate, status, supersededByHeadSha);
  const reviewVerdicts = scrubMergeGateVerdicts(lifecycle.reviewVerdicts, gate.id);
  const lastReviewVerdictId =
    lifecycle.lastReviewVerdictId === gate.id ? latestNonMergeGateVerdictId(reviewVerdicts) : lifecycle.lastReviewVerdictId;
  return {
    mergeGate,
    reviewVerdicts,
    lastReviewVerdictId,
  };
}

export function supersededMergeGateLifecyclePatch(
  lifecycle: IssueLifecycleRecord,
  gate: IssueMergeGateState,
  supersededByHeadSha: string,
): IssueLifecyclePatch {
  const mergeGate = inactiveMergeGate(gate, "superseded", supersededByHeadSha);
  const reviewVerdicts = scrubMergeGateVerdicts(lifecycle.reviewVerdicts, gate.id);
  const patchedLifecycle = { ...lifecycle, mergeGate, reviewVerdicts };
  return {
    mergeGate,
    reviewVerdicts,
    lastReviewVerdictId: latestCurrentApprovalPassVerdict(patchedLifecycle)?.id ?? null,
  };
}

export function sanitizeInactiveMergeGateLifecycle(lifecycle: IssueLifecycleRecord | null | undefined): IssueLifecycleRecord | null | undefined {
  const gate = lifecycle?.mergeGate ?? null;
  if (!lifecycle || !gate) return lifecycle;
  if (gate.status !== "resolved" && gate.status !== "superseded") return lifecycle;
  const scrubbedGate = inactiveMergeGate(gate, gate.status, gate.supersededByHeadSha);
  const reviewVerdicts = scrubMergeGateVerdicts(lifecycle.reviewVerdicts, gate.id);
  const lastReviewVerdictId = lifecycle.lastReviewVerdictId === gate.id ? latestNonMergeGateVerdictId(reviewVerdicts) : lifecycle.lastReviewVerdictId;
  const sanitized = {
    ...lifecycle,
    mergeGate: scrubbedGate,
    reviewVerdicts,
    lastReviewVerdictId,
  };
  return {
    ...sanitized,
    handoff: buildIssueHandoffState(sanitized),
  };
}

export function sanitizeStaleMergeGateLifecycle(
  lifecycle: IssueLifecycleRecord | null | undefined,
  currentHeadSha: string | null | undefined,
  pullRequestNumber: number | null | undefined,
): IssueLifecycleRecord | null | undefined {
  if (!lifecycle) return lifecycle;
  const patch = staleMergeGateLifecyclePatch(lifecycle, currentHeadSha, pullRequestNumber);
  if (!patch) return lifecycle;
  const sanitized: IssueLifecycleRecord = {
    ...lifecycle,
    mergeGate: patch.mergeGate ?? lifecycle.mergeGate ?? null,
    reviewVerdicts: patch.reviewVerdicts ?? lifecycle.reviewVerdicts,
    lastReviewVerdictId:
      patch.lastReviewVerdictId === undefined ? lifecycle.lastReviewVerdictId : patch.lastReviewVerdictId,
  };
  return {
    ...sanitized,
    handoff: buildIssueHandoffState(sanitized),
  };
}

function inactiveMergeGate(
  gate: IssueMergeGateState,
  status: "resolved" | "superseded",
  supersededByHeadSha: string | null,
): IssueMergeGateState {
  return {
    ...gate,
    status,
    checks: [],
    repairRunId: null,
    repairReportId: null,
    blockerFingerprint: null,
    writebackOperationKeys: [],
    supersededByHeadSha: status === "superseded" ? supersededByHeadSha : null,
    updatedAt: new Date().toISOString(),
  };
}

function bindRepairCompletionReport(
  lifecycle: IssueLifecycleRecord,
  gate: IssueMergeGateState,
): IssueCompletionReportRecord | null {
  if (!gate.repairReportId || !gate.repairRunId) return null;
  if (lifecycle.lastCompletionReportId !== gate.repairReportId) return null;

  const repairReport = lifecycle.completionReports.find((report) => report.id === gate.repairReportId) ?? null;
  if (!repairReport || repairReport.runId !== gate.repairRunId) return null;
  if (repairReport.acceptedAt.trim().length === 0) return null;
  if (repairReport.pullRequest?.number !== gate.pullRequest.number) return null;
  if (repairReport.pullRequest?.headSha !== gate.headSha) return null;

  const gateVerdict = lifecycle.reviewVerdicts.find((verdict) => verdict.id === gate.id && isMergeGateVerdict(verdict)) ?? null;
  if (!gateVerdict) return null;

  const repairAcceptedAt = Date.parse(repairReport.acceptedAt);
  const gateFailedAt = Date.parse(gateVerdict.submittedAt);
  if (!Number.isFinite(repairAcceptedAt) || !Number.isFinite(gateFailedAt)) return null;
  if (gate.gateReportId && repairReport.id === gate.gateReportId) return null;
  if (repairAcceptedAt <= gateFailedAt) return null;

  return repairReport;
}

function resolveRepairGateClearanceApprovalVerdict(
  lifecycle: IssueLifecycleRecord,
  gate: IssueMergeGateState,
  repairReport: IssueCompletionReportRecord,
): IssueReviewVerdictRecord | null {
  const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
  if (!approvalVerdict) return null;
  if (lifecycle.lastReviewVerdictId !== approvalVerdict.id) return null;
  if (approvalVerdict.verdict !== "pass" || isMergeGateVerdict(approvalVerdict)) return null;
  if (approvalVerdict.evidence.length === 0 || approvalVerdict.acceptanceResults.some((result) => !result.satisfied)) return null;

  const gateVerdict = lifecycle.reviewVerdicts.find((verdict) => verdict.id === gate.id && isMergeGateVerdict(verdict)) ?? null;
  if (!gateVerdict) return null;
  const repairAcceptedAt = Date.parse(repairReport.acceptedAt);
  const approvalSubmittedAt = Date.parse(approvalVerdict.submittedAt);
  const gateFailedAt = Date.parse(gateVerdict.submittedAt);
  if (!Number.isFinite(repairAcceptedAt) || !Number.isFinite(approvalSubmittedAt) || !Number.isFinite(gateFailedAt)) return null;
  if (approvalSubmittedAt <= repairAcceptedAt || approvalSubmittedAt <= gateFailedAt) return null;

  const repairPullRequest = repairReport.pullRequest;
  if (!repairPullRequest) return null;
  if (!hasRepairApprovalFeedback(lifecycle, approvalVerdict, repairPullRequest)) return null;
  return approvalVerdict;
}

function hasRepairApprovalFeedback(
  lifecycle: Pick<IssueLifecycleRecord, "reviewFeedback">,
  verdict: IssueReviewVerdictRecord,
  pullRequest: CompletionReportPullRequestRef,
): boolean {
  return lifecycle.reviewFeedback.some(
    (feedback) =>
      feedback.runId === verdict.runId &&
      feedback.kind === "review" &&
      feedback.event === "APPROVE" &&
      feedback.pullRequest.number === pullRequest.number &&
      feedback.pullRequest.url === pullRequest.url &&
      feedback.pullRequest.headSha === pullRequest.headSha,
  );
}

function scrubMergeGateVerdicts(verdicts: IssueReviewVerdictRecord[], gateId: string): IssueReviewVerdictRecord[] {
  return verdicts.map((verdict) =>
    verdict.id === gateId && isMergeGateVerdict(verdict)
      ? {
          ...verdict,
          acceptanceResults: [],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: [],
        }
      : verdict,
  );
}

function latestNonMergeGateVerdictId(verdicts: IssueReviewVerdictRecord[]): string | null {
  return verdicts
    .slice()
    .reverse()
    .find((verdict) => !isMergeGateVerdict(verdict))?.id ?? null;
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === "symphony-merge-gate" || verdict.id.startsWith("merge-gate:");
}
