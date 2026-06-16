import type {
  CompletionReportPullRequestRef,
  IssueLifecyclePatch,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueMergeGateCheckState,
  IssueMergeGateResultRecord,
  IssueMergeGateState,
  IssueReviewVerdictRecord,
  IssueTriageBlockerKind,
  IssueTriageReportRecord,
} from "./persistence/IssueLifecycleStore.js";
import { isSupersededLifecycleRecord } from "./persistence/IssueLifecycleStore.js";

export type LifecycleReconciliationActionKind =
  | "legacy_merge_gate_verdict_migrated"
  | "legacy_merge_gate_verdict_superseded"
  | "merge_gate_result_superseded"
  | "review_failure_superseded"
  | "triage_report_superseded"
  | "last_review_verdict_pointer_updated"
  | "last_merge_gate_result_pointer_updated"
  | "last_issue_triage_report_pointer_updated";

export interface LifecycleReconciliationAction {
  kind: LifecycleReconciliationActionKind;
  recordId: string;
  supersededBy?: string | null;
  reason?: string | null;
  detail: string;
}

export interface LifecycleReconciliationResult {
  issueId: string;
  issueIdentifier: string;
  changed: boolean;
  actions: LifecycleReconciliationAction[];
  patch: IssueLifecyclePatch | null;
}

export interface LifecycleReconciliationApplyResult extends LifecycleReconciliationResult {
  applied: boolean;
}

export interface LifecycleReconciliationServiceOptions {
  lifecycleStore: Pick<IssueLifecycleStore, "get" | "list" | "updateIssue">;
}

type MutableReconciliationState = {
  reviewVerdicts: IssueReviewVerdictRecord[];
  mergeGateResults: IssueMergeGateResultRecord[];
  issueTriageReports: IssueTriageReportRecord[];
  lastReviewVerdictId: string | null;
  lastMergeGateResultId: string | null;
  lastIssueTriageReportId: string | null;
};

export class LifecycleReconciliationService {
  constructor(private readonly options: LifecycleReconciliationServiceOptions) {}

  async previewIssue(issueIdOrIdentifier: string, now = new Date().toISOString()): Promise<LifecycleReconciliationResult | null> {
    const lifecycle = await this.options.lifecycleStore.get(issueIdOrIdentifier);
    if (!lifecycle) return null;
    return reconcileLifecycleRecord(lifecycle, now);
  }

  async applyIssue(issueIdOrIdentifier: string, now = new Date().toISOString()): Promise<LifecycleReconciliationApplyResult | null> {
    const preview = await this.previewIssue(issueIdOrIdentifier, now);
    if (!preview) return null;
    if (!preview.patch) return { ...preview, applied: false };
    await this.options.lifecycleStore.updateIssue(
      { id: preview.issueId, identifier: preview.issueIdentifier },
      preview.patch,
    );
    return { ...preview, applied: true };
  }

  async previewAll(now = new Date().toISOString()): Promise<LifecycleReconciliationResult[]> {
    const records = await this.options.lifecycleStore.list();
    return records.map((record) => reconcileLifecycleRecord(record, now));
  }

  async applyAll(now = new Date().toISOString()): Promise<LifecycleReconciliationApplyResult[]> {
    const previews = await this.previewAll(now);
    const results: LifecycleReconciliationApplyResult[] = [];
    for (const preview of previews) {
      if (!preview.patch) {
        results.push({ ...preview, applied: false });
        continue;
      }
      await this.options.lifecycleStore.updateIssue(
        { id: preview.issueId, identifier: preview.issueIdentifier },
        preview.patch,
      );
      results.push({ ...preview, applied: true });
    }
    return results;
  }
}

export function reconcileLifecycleRecord(
  lifecycle: IssueLifecycleRecord,
  now = new Date().toISOString(),
): LifecycleReconciliationResult {
  const actions: LifecycleReconciliationAction[] = [];
  const state: MutableReconciliationState = {
    reviewVerdicts: lifecycle.reviewVerdicts.map((verdict) => ({ ...verdict })),
    mergeGateResults: (lifecycle.mergeGateResults ?? []).map((result) => ({ ...result })),
    issueTriageReports: lifecycle.issueTriageReports.map((report) => ({ ...report })),
    lastReviewVerdictId: lifecycle.lastReviewVerdictId,
    lastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
    lastIssueTriageReportId: lifecycle.lastIssueTriageReportId,
  };

  migrateLegacyMergeGateVerdicts(lifecycle, state, actions, now);
  supersedeInactiveMergeGateResults(lifecycle, state, actions, now);
  supersedeOlderReviewFailures(lifecycle, state, actions, now);
  supersedeStaleTriageReports(lifecycle, state, actions, now);
  reconcilePointers(lifecycle, state, actions);

  const patch: IssueLifecyclePatch = {};
  if (!jsonEqual(state.reviewVerdicts, lifecycle.reviewVerdicts)) patch.reviewVerdicts = state.reviewVerdicts;
  if (!jsonEqual(state.mergeGateResults, lifecycle.mergeGateResults ?? [])) patch.mergeGateResults = state.mergeGateResults;
  if (!jsonEqual(state.issueTriageReports, lifecycle.issueTriageReports)) {
    patch.issueTriageReports = state.issueTriageReports;
  }
  if (state.lastReviewVerdictId !== lifecycle.lastReviewVerdictId) patch.lastReviewVerdictId = state.lastReviewVerdictId;
  if (state.lastMergeGateResultId !== (lifecycle.lastMergeGateResultId ?? null)) {
    patch.lastMergeGateResultId = state.lastMergeGateResultId;
  }
  if (state.lastIssueTriageReportId !== lifecycle.lastIssueTriageReportId) {
    patch.lastIssueTriageReportId = state.lastIssueTriageReportId;
  }

  return {
    issueId: lifecycle.issueId,
    issueIdentifier: lifecycle.issueIdentifier,
    changed: Object.keys(patch).length > 0,
    actions,
    patch: Object.keys(patch).length === 0 ? null : patch,
  };
}

function migrateLegacyMergeGateVerdicts(
  lifecycle: IssueLifecycleRecord,
  state: MutableReconciliationState,
  actions: LifecycleReconciliationAction[],
  now: string,
): void {
  for (const verdict of state.reviewVerdicts) {
    if (!isMergeGateVerdict(verdict)) continue;
    const existingResult = state.mergeGateResults.find((result) => result.id === verdict.id) ?? null;
    if (!existingResult) {
      const migrated = mergeGateResultFromLegacyVerdict(lifecycle, verdict);
      state.mergeGateResults.push(migrated);
      actions.push({
        kind: "legacy_merge_gate_verdict_migrated",
        recordId: verdict.id,
        supersededBy: migrated.id,
        reason: "migrated_to_merge_gate_result",
        detail: `Migrated legacy service-owned merge-gate verdict ${verdict.id} into mergeGateResults.`,
      });
    }
    if (!isSupersededLifecycleRecord(verdict)) {
      verdict.supersededAt = now;
      verdict.supersededBy = verdict.id;
      verdict.supersededReason = "migrated_to_merge_gate_result";
      actions.push({
        kind: "legacy_merge_gate_verdict_superseded",
        recordId: verdict.id,
        supersededBy: verdict.id,
        reason: "migrated_to_merge_gate_result",
        detail: `Superseded legacy service-owned merge-gate verdict ${verdict.id}.`,
      });
    }
  }
}

function supersedeInactiveMergeGateResults(
  lifecycle: IssueLifecycleRecord,
  state: MutableReconciliationState,
  actions: LifecycleReconciliationAction[],
  now: string,
): void {
  const gate = lifecycle.mergeGate ?? null;
  if (!gate || (gate.status !== "resolved" && gate.status !== "superseded")) return;
  for (const result of state.mergeGateResults) {
    if (result.id !== gate.id || isSupersededLifecycleRecord(result)) continue;
    result.supersededAt = now;
    result.supersededBy = gate.supersededByHeadSha ?? gate.id;
    result.supersededReason = gate.status === "resolved" ? "merge_gate_resolved" : "merge_gate_superseded";
    actions.push({
      kind: "merge_gate_result_superseded",
      recordId: result.id,
      supersededBy: result.supersededBy,
      reason: result.supersededReason,
      detail: `Superseded merge-gate result ${result.id} because mergeGate is ${gate.status}.`,
    });
  }
}

function supersedeOlderReviewFailures(
  lifecycle: IssueLifecycleRecord,
  state: MutableReconciliationState,
  actions: LifecycleReconciliationAction[],
  now: string,
): void {
  const humanPasses = state.reviewVerdicts.filter((verdict) => isHumanPassVerdict(lifecycle, verdict));
  for (const verdict of state.reviewVerdicts) {
    if (!isHumanFailure(lifecycle, verdict)) continue;
    const laterPass = humanPasses.find((pass) => occursAfter(pass.submittedAt, verdict.submittedAt)) ?? null;
    if (!laterPass) continue;
    verdict.supersededAt = now;
    verdict.supersededBy = laterPass.id;
    verdict.supersededReason = "later_human_pass";
    actions.push({
      kind: "review_failure_superseded",
      recordId: verdict.id,
      supersededBy: laterPass.id,
      reason: "later_human_pass",
      detail: `Superseded failed review verdict ${verdict.id} because later human pass ${laterPass.id} exists.`,
    });
  }
}

function supersedeStaleTriageReports(
  lifecycle: IssueLifecycleRecord,
  state: MutableReconciliationState,
  actions: LifecycleReconciliationAction[],
  now: string,
): void {
  const activeHumanFailures = state.reviewVerdicts.filter((verdict) => isHumanFailure(lifecycle, verdict));
  const activeMergeGate = activeMergeGateSignal(lifecycle, state);
  const latestHumanPass = state.reviewVerdicts
    .filter((verdict) => isHumanPassVerdict(lifecycle, verdict))
    .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))[0] ?? null;

  for (const report of state.issueTriageReports) {
    if (isSupersededLifecycleRecord(report)) continue;
    const activeKinds = new Set(report.blockers.filter((blocker) => blocker.status === "active").map((blocker) => blocker.kind));
    if (activeKinds.has("merge_gate_check_failure")) continue;
    const staleScopeOrRequirement =
      activeKinds.has("implementation_unsatisfied_requirements") || activeKinds.has("pr_target_or_scope_mismatch");
    if (!staleScopeOrRequirement) continue;

    const laterHumanPass = latestHumanPass && occursAfter(latestHumanPass.submittedAt, report.submittedAt) ? latestHumanPass : null;
    const supersededBy = activeMergeGate?.id ?? laterHumanPass?.id ?? null;
    if (activeHumanFailures.length > 0 || supersededBy === null) continue;

    report.supersededAt = now;
    report.supersededBy = supersededBy;
    report.supersededReason = activeMergeGate ? "merge_gate_signal_reclassified_blocker" : "later_human_pass";
    actions.push({
      kind: "triage_report_superseded",
      recordId: report.id,
      supersededBy,
      reason: report.supersededReason,
      detail: `Superseded stale triage report ${report.id}; active blocker should not remain scope/requirements after review pass and merge-gate signal.`,
    });
  }
}

function reconcilePointers(
  lifecycle: IssueLifecycleRecord,
  state: MutableReconciliationState,
  actions: LifecycleReconciliationAction[],
): void {
  const nextReviewVerdictId = latestActiveHumanReviewVerdict(state.reviewVerdicts)?.id ?? null;
  const pointedReview = state.reviewVerdicts.find((verdict) => verdict.id === state.lastReviewVerdictId) ?? null;
  if (
    state.lastReviewVerdictId !== nextReviewVerdictId &&
    (pointedReview === null || isMergeGateVerdict(pointedReview) || isSupersededLifecycleRecord(pointedReview))
  ) {
    actions.push({
      kind: "last_review_verdict_pointer_updated",
      recordId: state.lastReviewVerdictId ?? "null",
      supersededBy: nextReviewVerdictId,
      reason: "active_human_review_pointer",
      detail: `Updated lastReviewVerdictId from ${state.lastReviewVerdictId ?? "null"} to ${nextReviewVerdictId ?? "null"}.`,
    });
    state.lastReviewVerdictId = nextReviewVerdictId;
  }

  const nextMergeGateResultId = latestActiveMergeGateResult(state.mergeGateResults)?.id ?? null;
  if (state.lastMergeGateResultId !== nextMergeGateResultId) {
    actions.push({
      kind: "last_merge_gate_result_pointer_updated",
      recordId: state.lastMergeGateResultId ?? "null",
      supersededBy: nextMergeGateResultId,
      reason: "active_merge_gate_result_pointer",
      detail: `Updated lastMergeGateResultId from ${state.lastMergeGateResultId ?? "null"} to ${nextMergeGateResultId ?? "null"}.`,
    });
    state.lastMergeGateResultId = nextMergeGateResultId;
  }

  const nextTriageReportId = latestActiveTriageReport(state.issueTriageReports)?.id ?? null;
  const pointedTriage = state.issueTriageReports.find((report) => report.id === state.lastIssueTriageReportId) ?? null;
  if (
    state.lastIssueTriageReportId !== null &&
    state.lastIssueTriageReportId !== nextTriageReportId &&
    (pointedTriage === null || isSupersededLifecycleRecord(pointedTriage))
  ) {
    actions.push({
      kind: "last_issue_triage_report_pointer_updated",
      recordId: state.lastIssueTriageReportId ?? "null",
      supersededBy: nextTriageReportId,
      reason: "active_triage_report_pointer",
      detail: `Updated lastIssueTriageReportId from ${state.lastIssueTriageReportId ?? "null"} to ${nextTriageReportId ?? "null"}.`,
    });
    state.lastIssueTriageReportId = nextTriageReportId;
  }
}

function mergeGateResultFromLegacyVerdict(
  lifecycle: IssueLifecycleRecord,
  verdict: IssueReviewVerdictRecord,
): IssueMergeGateResultRecord {
  const gate = lifecycle.mergeGate?.id === verdict.id ? lifecycle.mergeGate : null;
  const headSha = gate?.headSha ?? lifecycle.summaryPointers.prHeadSha ?? mergeGateHeadShaFromId(verdict.id) ?? "unknown";
  return {
    id: verdict.id,
    idempotencyKey: verdict.idempotencyKey,
    runId: verdict.runId,
    issueId: verdict.issueId,
    issueIdentifier: verdict.issueIdentifier,
    status: gate?.status === "blocked" ? "blocked" : "repair_dispatched",
    headSha,
    pullRequest: gate?.pullRequest ?? pullRequestFromLifecyclePointers(lifecycle, headSha),
    requiredChecks: gate?.requiredChecks ?? [],
    checks: gate?.checks.map(cloneMergeGateCheck) ?? [],
    mergeability: gate?.mergeability ?? null,
    reviewRound: gate?.reviewRound ?? lifecycle.reviewRound,
    blockerFingerprint: gate?.blockerFingerprint ?? null,
    findings: [...verdict.findings],
    evidence: [...verdict.evidence],
    submittedAt: verdict.submittedAt,
    writebackOperationKeys: [...verdict.writebackOperationKeys],
    supersededAt: null,
    supersededBy: null,
    supersededReason: null,
  };
}

function pullRequestFromLifecyclePointers(
  lifecycle: IssueLifecycleRecord,
  headSha: string,
): CompletionReportPullRequestRef {
  return {
    url: lifecycle.summaryPointers.prUrl,
    number: lifecycle.summaryPointers.prNumber,
    headSha,
    branch: lifecycle.summaryPointers.prBranch ?? lifecycle.summaryPointers.gitBranchName,
  };
}

function cloneMergeGateCheck(check: IssueMergeGateCheckState): IssueMergeGateCheckState {
  return {
    name: check.name,
    outcome: check.outcome,
    rawStatus: check.rawStatus,
    conclusion: check.conclusion,
    url: check.url,
    firstObservedAt: check.firstObservedAt,
    actionableSince: check.actionableSince,
  };
}

function activeMergeGateSignal(
  lifecycle: IssueLifecycleRecord,
  state: MutableReconciliationState,
): IssueMergeGateState | IssueMergeGateResultRecord | null {
  const gate = lifecycle.mergeGate ?? null;
  if (gate && gate.status !== "resolved" && gate.status !== "superseded") return gate;
  return latestActiveMergeGateResult(state.mergeGateResults);
}

function latestActiveHumanReviewVerdict(verdicts: readonly IssueReviewVerdictRecord[]): IssueReviewVerdictRecord | null {
  for (const verdict of verdicts.slice().reverse()) {
    if (!isMergeGateVerdict(verdict) && !isSupersededLifecycleRecord(verdict)) return verdict;
  }
  return null;
}

function latestActiveMergeGateResult(results: readonly IssueMergeGateResultRecord[]): IssueMergeGateResultRecord | null {
  for (const result of results.slice().reverse()) {
    if (!isSupersededLifecycleRecord(result)) return result;
  }
  return null;
}

function latestActiveTriageReport(reports: readonly IssueTriageReportRecord[]): IssueTriageReportRecord | null {
  for (const report of reports.slice().reverse()) {
    if (!isSupersededLifecycleRecord(report)) return report;
  }
  return null;
}

function isHumanFailure(lifecycle: IssueLifecycleRecord, verdict: IssueReviewVerdictRecord): boolean {
  return (
    verdict.issueId === lifecycle.issueId &&
    verdict.issueIdentifier === lifecycle.issueIdentifier &&
    verdict.verdict === "fail" &&
    !isMergeGateVerdict(verdict) &&
    !isSupersededLifecycleRecord(verdict)
  );
}

function isHumanPassVerdict(lifecycle: IssueLifecycleRecord, verdict: IssueReviewVerdictRecord): boolean {
  return (
    verdict.issueId === lifecycle.issueId &&
    verdict.issueIdentifier === lifecycle.issueIdentifier &&
    verdict.verdict === "pass" &&
    !isMergeGateVerdict(verdict) &&
    !isSupersededLifecycleRecord(verdict) &&
    verdict.acceptanceResults.every((result) => result.satisfied)
  );
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === "symphony-merge-gate" || verdict.id.startsWith("merge-gate:");
}

function mergeGateHeadShaFromId(id: string): string | null {
  const segments = id.split(":");
  return segments[0] === "merge-gate" && segments.length >= 4 ? segments[segments.length - 1] ?? null : null;
}

function occursAfter(candidate: string, reference: string): boolean {
  const candidateTime = Date.parse(candidate);
  const referenceTime = Date.parse(reference);
  return Number.isFinite(candidateTime) && Number.isFinite(referenceTime) && candidateTime > referenceTime;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
