import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  IssueTriageBlockerKind,
  IssueTriageBlockerNextActor,
  IssueTriageBlockerRecord,
  IssueTriageBlockerStatus,
  IssueTriageConfidence,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueTriageDisposition,
  IssueTriageReportRecord,
} from "./persistence/IssueLifecycleStore.js";
import { isSupersededLifecycleRecord } from "./persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { Issue } from "./types.js";
import { planIssueTriageReportWritebacks } from "./writeback/TransitionPolicy.js";
import type { WritebackOutboxStore } from "./writeback/WritebackOutbox.js";
import { bindWritebackOperationToLifecycle } from "./writeback/WritebackOutbox.js";

export const ISSUE_TRIAGE_DISPOSITIONS = [
  "decompose_issue",
  "implementation_repair",
  "validation_repair",
  "compatibility_matrix_repair",
  "retarget_or_split_pr",
  "close_or_retarget_issue",
  "merge_gate_repair",
  "process_gate_repair",
  "infra_repair",
  "orchestrator_context_repair",
  "manual_decision",
] as const satisfies readonly IssueTriageDisposition[];

export const ISSUE_TRIAGE_BLOCKER_KINDS = [
  "under_specified_needs_decomposition",
  "implementation_unsatisfied_requirements",
  "validation_or_test_failure",
  "compatibility_matrix_gap",
  "orchestrator_context_or_prompt_gap",
  "infra_or_tooling_failure",
  "pr_target_or_scope_mismatch",
  "merge_conflict",
  "merge_gate_check_failure",
  "pr_review_gate",
  "manual_decision",
] as const satisfies readonly IssueTriageBlockerKind[];

export const ISSUE_TRIAGE_BLOCKER_STATUSES = ["active", "downstream"] as const satisfies readonly IssueTriageBlockerStatus[];
export const ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS = [
  "planner",
  "worker",
  "reviewer",
  "merge_conflict_worker",
  "operator",
  "orchestrator",
  "infra",
] as const satisfies readonly IssueTriageBlockerNextActor[];

const ISSUE_TRIAGE_BLOCKER_PRECEDENCE: Record<IssueTriageBlockerKind, number> = {
  under_specified_needs_decomposition: 10,
  implementation_unsatisfied_requirements: 20,
  validation_or_test_failure: 30,
  compatibility_matrix_gap: 40,
  orchestrator_context_or_prompt_gap: 50,
  infra_or_tooling_failure: 60,
  pr_target_or_scope_mismatch: 70,
  merge_conflict: 80,
  merge_gate_check_failure: 90,
  pr_review_gate: 100,
  manual_decision: 110,
};

const issueTriageBlockerSchema = z.object({
  kind: z.enum(ISSUE_TRIAGE_BLOCKER_KINDS),
  status: z.enum(ISSUE_TRIAGE_BLOCKER_STATUSES),
  nextActor: z.enum(ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  recommendedAction: z.string().trim().min(1),
});

const issueTriageReportSchema = z
  .object({
    runId: z.string().trim().min(1),
    issueId: z.string().trim().min(1),
    triggerFingerprint: z.string().trim().min(1),
    finalDisposition: z.string().min(1).refine((value) => value.trim().length > 0, "Final disposition cannot be blank"),
    summary: z.string().trim().min(1),
    blockers: z.array(issueTriageBlockerSchema).min(1).optional(),
    disposition: z.enum(ISSUE_TRIAGE_DISPOSITIONS).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
    evidence: z.array(z.string().trim().min(1)).min(1).optional(),
    recommendedAction: z.string().trim().min(1).optional(),
    idempotencyKey: z.string().trim().min(1),
  })
  .superRefine((value, context) => {
    if (value.blockers !== undefined) return;
    if (value.disposition === undefined) {
      context.addIssue({ code: "custom", path: ["disposition"], message: "Legacy triage reports require disposition" });
    }
    if (value.confidence === undefined) {
      context.addIssue({ code: "custom", path: ["confidence"], message: "Legacy triage reports require confidence" });
    }
    if (value.evidence === undefined) {
      context.addIssue({ code: "custom", path: ["evidence"], message: "Legacy triage reports require evidence" });
    }
    if (value.recommendedAction === undefined) {
      context.addIssue({ code: "custom", path: ["recommendedAction"], message: "Legacy triage reports require recommendedAction" });
    }
  });

type RawIssueTriageReportInput = z.infer<typeof issueTriageReportSchema>;

export interface IssueTriageReportInput {
  runId: string;
  issueId: string;
  triggerFingerprint: string;
  finalDisposition: string;
  summary: string;
  blockers: IssueTriageBlockerRecord[];
  disposition: IssueTriageDisposition;
  confidence: IssueTriageConfidence;
  evidence: string[];
  recommendedAction: string;
  idempotencyKey: string;
}

export interface IssueTriageActiveContext {
  issue: Issue;
  activeRunId: string;
  role: "triage";
  phase: "issue_triage";
  manualDispatch?: boolean;
}

export interface IssueTriageServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<WritebackOutboxStore, "enqueueOnce">;
  runStore?: Pick<RunTranscriptStore, "appendEvent">;
}

export interface IssueTriageReportResult {
  accepted: true;
  replayed: boolean;
  report: IssueTriageReportRecord;
}

export class IssueTriageService {
  constructor(private readonly options: IssueTriageServiceOptions) {}

  async submit_issue_triage_report(input: unknown, context: IssueTriageActiveContext): Promise<IssueTriageReportResult> {
    return this.submitIssueTriageReport(input, context);
  }

  async submitIssueTriageReport(input: unknown, context: IssueTriageActiveContext): Promise<IssueTriageReportResult> {
    const parsed = parseIssueTriageReport(input);
    validateCaller(parsed, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    if (!existingLifecycle) {
      throw new SymphonyError("invalid_request", "Issue triage report requires an existing blocked lifecycle record");
    }
    const expectedFingerprint = issueTriageTriggerFingerprint(existingLifecycle);
    if (parsed.triggerFingerprint !== expectedFingerprint) {
      throw new SymphonyError("conflict", "Issue triage trigger fingerprint is stale", {
        expectedTriggerFingerprint: expectedFingerprint,
        submittedTriggerFingerprint: parsed.triggerFingerprint,
      });
    }

    const requestHash = issueTriageReportRequestHash(parsed);
    const preFinalDispositionRequestHash = preFinalDispositionIssueTriageReportRequestHash(parsed);
    const legacyRequestHash = legacyIssueTriageReportRequestHash(parsed);
    const existingScoped = existingLifecycle.issueTriageReports.find(
      (report) => report.runId === context.activeRunId && report.idempotencyKey === parsed.idempotencyKey,
    );
    if (existingScoped) {
      assertIssueTriageReplayAllowed(existingScoped, {
        idempotencyKey: parsed.idempotencyKey,
        activeRunId: context.activeRunId,
        requestHash,
        preFinalDispositionRequestHash,
        legacyRequestHash,
      });
      return { accepted: true, replayed: true, report: existingScoped };
    }
    const existingCrossRun = existingLifecycle.issueTriageReports.find(
      (report) => report.idempotencyKey === parsed.idempotencyKey && report.runId !== context.activeRunId,
    );
    if (existingCrossRun) {
      throw issueTriageIdempotencyConflict("cross_run_key_reuse", existingCrossRun, {
        idempotencyKey: parsed.idempotencyKey,
        activeRunId: context.activeRunId,
        requestHash,
      });
    }
    const triageEligible = context.manualDispatch === true
      ? shouldIssueTriageManualRun(existingLifecycle, this.options.config)
      : shouldIssueTriageRun(existingLifecycle, this.options.config);
    if (!triageEligible) {
      throw new SymphonyError("invalid_request", "Issue triage is not currently eligible for this issue");
    }

    const attemptsForTrigger = existingLifecycle.issueTriageReports.filter(
      (report) => report.triggerFingerprint === parsed.triggerFingerprint && !isSupersededLifecycleRecord(report),
    ).length;
    if (context.manualDispatch !== true && attemptsForTrigger >= this.options.config.issueTriage.maxAttemptsPerTrigger) {
      throw new SymphonyError("conflict", "Issue triage report already exists for this blocked trigger", {
        triggerFingerprint: parsed.triggerFingerprint,
        attemptsForTrigger,
        maxAttemptsPerTrigger: this.options.config.issueTriage.maxAttemptsPerTrigger,
      });
    }

    const submittedAt = new Date().toISOString();
    const reportBase: IssueTriageReportRecord = {
      id: issueTriageReportIdFor(context.issue.id, parsed.idempotencyKey),
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      runId: parsed.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      triggerFingerprint: parsed.triggerFingerprint,
      finalDisposition: parsed.finalDisposition,
      disposition: parsed.disposition,
      confidence: parsed.confidence,
      summary: parsed.summary,
      evidence: parsed.evidence,
      recommendedAction: parsed.recommendedAction,
      blockers: parsed.blockers,
      submittedAt,
      writebackOperationKeys: [],
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    };
    const operations = planIssueTriageReportWritebacks(
      {
        issue: context.issue,
        report: reportBase,
        blockedReason: existingLifecycle.blockedReason,
      },
      this.options.config,
    );
    const writebackOperationKeys: string[] = [];
    for (const rawOperation of operations) {
      const operation = bindWritebackOperationToLifecycle(rawOperation, {
        kind: "issue_triage_report",
        recordId: reportBase.id,
      });
      const enqueued = await this.options.writebackOutbox.enqueueOnce(operation);
      writebackOperationKeys.push(enqueued.idempotencyKey);
    }
    const report: IssueTriageReportRecord = {
      ...reportBase,
      writebackOperationKeys,
    };

    const lifecycle = await this.options.lifecycleStore.updateIssue(context.issue, {
      lastIssueTriageReportId: report.id,
      issueTriageReports: [...existingLifecycle.issueTriageReports, report],
    });
    await this.options.runStore?.appendEvent({
      runId: parsed.runId,
      at: submittedAt,
      source: "orchestrator",
      eventType: "issue_triage_report_accepted",
      message: `Accepted issue triage report ${report.id}`,
      payload: {
        reportId: report.id,
        disposition: report.disposition,
        confidence: report.confidence,
        blockers: report.blockers.map((blocker) => ({ kind: blocker.kind, status: blocker.status, nextActor: blocker.nextActor })),
        triggerFingerprint: report.triggerFingerprint,
        lifecycleUpdatedAt: lifecycle.updatedAt,
      },
    });
    return { accepted: true, replayed: false, report };
  }
}

export function parseIssueTriageReport(input: unknown): IssueTriageReportInput {
  const parsed = issueTriageReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Issue triage report is invalid", parsed.error.flatten());
  }
  return canonicalIssueTriageReportInput(parsed.data);
}

export function shouldIssueTriageRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  config: ServiceConfig,
): lifecycle is IssueLifecycleRecord {
  if (!config.issueTriage.enabled || !lifecycle || !isIssueTriageLifecyclePhase(lifecycle)) return false;
  if (!isIssueTriageBlockedReason(lifecycle.blockedReason)) return false;
  const fingerprint = issueTriageTriggerFingerprint(lifecycle);
  const attemptsForTrigger = lifecycle.issueTriageReports.filter(
    (report) => report.triggerFingerprint === fingerprint && !isSupersededLifecycleRecord(report),
  ).length;
  return attemptsForTrigger < config.issueTriage.maxAttemptsPerTrigger;
}

export function shouldIssueTriageManualRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  config: ServiceConfig,
): lifecycle is IssueLifecycleRecord {
  if (!config.issueTriage.enabled || !lifecycle || !isIssueTriageLifecyclePhase(lifecycle)) return false;
  return isIssueTriageBlockedReason(lifecycle.blockedReason);
}

export function isIssueTriageBlockedReason(reason: string | null | undefined): boolean {
  const normalized = (reason ?? "").toLowerCase();
  return (
    isReviewerBlockedTriageReason(reason) ||
    normalized.includes("max reviewer failures") ||
    normalized.includes("max review rounds") ||
    normalized.includes("max merge gate failures") ||
    normalized.includes("merge gate required checks failed")
  );
}

export function isReviewerBlockedTriageReason(reason: string | null | undefined): boolean {
  return (reason ?? "").toLowerCase().startsWith("review blocked:");
}

function isIssueTriageLifecyclePhase(lifecycle: IssueLifecycleRecord): boolean {
  if (lifecycle.phase === "blocked") return true;
  return lifecycle.phase === "review" && isReviewerBlockedTriageReason(lifecycle.blockedReason);
}

export function latestIssueTriageReportForFingerprint(
  lifecycle: IssueLifecycleRecord | null | undefined,
  triggerFingerprint: string,
): IssueTriageReportRecord | null {
  if (!lifecycle) return null;
  for (let index = lifecycle.issueTriageReports.length - 1; index >= 0; index -= 1) {
    const report = lifecycle.issueTriageReports[index];
    if (report?.triggerFingerprint === triggerFingerprint && !isSupersededLifecycleRecord(report)) return report;
  }
  return null;
}

export function latestIssueTriageReport(
  lifecycle: IssueLifecycleRecord | null | undefined,
): IssueTriageReportRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastIssueTriageReportId) {
    const exact = lifecycle.issueTriageReports.find((report) => report.id === lifecycle.lastIssueTriageReportId);
    if (exact && !isSupersededLifecycleRecord(exact)) return exact;
  }
  for (const report of lifecycle.issueTriageReports.slice().reverse()) {
    if (!isSupersededLifecycleRecord(report)) return report;
  }
  return null;
}

export function issueTriageTriggerFingerprint(lifecycle: IssueLifecycleRecord): string {
  return createHash("sha256")
    .update(
      stableJson({
        version: 1,
        phase: lifecycle.phase,
        blockedReason: normalizeString(lifecycle.blockedReason ?? ""),
        reviewRound: lifecycle.reviewRound,
        incompleteTurnCount: lifecycle.incompleteTurnCount,
        lastCompletionReportId: lifecycle.lastCompletionReportId,
        lastReviewVerdictId: lifecycle.lastReviewVerdictId,
        lastMergeGateResultId: lifecycle.lastMergeGateResultId ?? null,
        mergeGate: lifecycle.mergeGate
          ? {
              id: lifecycle.mergeGate.id,
              status: lifecycle.mergeGate.status,
              headSha: lifecycle.mergeGate.headSha,
              reviewRound: lifecycle.mergeGate.reviewRound,
              blockerFingerprint: lifecycle.mergeGate.blockerFingerprint,
              gateReportId: lifecycle.mergeGate.gateReportId,
              repairReportId: lifecycle.mergeGate.repairReportId,
              updatedAt: lifecycle.mergeGate.updatedAt,
            }
          : null,
      }),
    )
    .digest("hex");
}

export function issueTriageReportRequestHash(input: IssueTriageReportInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        issueId: input.issueId,
        triggerFingerprint: input.triggerFingerprint,
        finalDisposition: input.finalDisposition,
        summary: normalizeString(input.summary),
        blockers: input.blockers,
      }),
    )
    .digest("hex");
}

export function preFinalDispositionIssueTriageReportRequestHash(input: IssueTriageReportInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        issueId: input.issueId,
        triggerFingerprint: input.triggerFingerprint,
        summary: normalizeString(input.summary),
        blockers: input.blockers,
      }),
    )
    .digest("hex");
}

export function legacyIssueTriageReportRequestHash(input: IssueTriageReportInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        issueId: input.issueId,
        triggerFingerprint: input.triggerFingerprint,
        disposition: input.disposition,
        confidence: input.confidence,
        summary: normalizeString(input.summary),
        evidence: normalizeStringList(input.evidence),
        recommendedAction: normalizeString(input.recommendedAction),
      }),
    )
    .digest("hex");
}

export function renderIssueTriageReportSummary(report: IssueTriageReportRecord): string {
  return [
    report.summary,
    "",
    "Blockers:",
    ...report.blockers.flatMap((blocker, index) => [
      `${index + 1}. ${blocker.kind} (${blocker.status}, ${blocker.nextActor}, ${blocker.confidence})`,
      `   Summary: ${blocker.summary}`,
      `   Recommended next action: ${blocker.recommendedAction}`,
      "   Evidence:",
      ...blocker.evidence.map((item) => `   - ${item}`),
    ]),
  ].join("\n");
}

export function sortIssueTriageBlockers(blockers: readonly IssueTriageBlockerRecord[]): IssueTriageBlockerRecord[] {
  return [...blockers].sort(compareIssueTriageBlockers);
}

export function highestPrecedenceIssueTriageBlocker(
  report: { blockers?: readonly IssueTriageBlockerRecord[] } | null | undefined,
): IssueTriageBlockerRecord | null {
  return sortIssueTriageBlockers(report?.blockers ?? [])[0] ?? null;
}

export function activeIssueTriageBlockers(
  report: ({ blockers?: readonly IssueTriageBlockerRecord[] } & { supersededAt?: string | null }) | null | undefined,
): IssueTriageBlockerRecord[] {
  if (isSupersededLifecycleRecord(report)) return [];
  return sortIssueTriageBlockers((report?.blockers ?? []).filter((blocker) => blocker.status === "active"));
}

export function activeWorkerOwnedIssueTriageBlockers(
  report: ({ blockers?: readonly IssueTriageBlockerRecord[] } & { supersededAt?: string | null }) | null | undefined,
): IssueTriageBlockerRecord[] {
  return activeIssueTriageBlockers(report).filter((blocker) => blocker.nextActor === "worker");
}

export function issueTriageBlockerPrecedence(kind: IssueTriageBlockerKind): number {
  return ISSUE_TRIAGE_BLOCKER_PRECEDENCE[kind];
}

function canonicalIssueTriageReportInput(input: RawIssueTriageReportInput): IssueTriageReportInput {
  const blockers = sortIssueTriageBlockers(
    (input.blockers ?? [
      {
        kind: legacyIssueTriageBlockerKind(input.disposition as IssueTriageDisposition),
        status: "active" as const,
        nextActor: legacyIssueTriageNextActor(input.disposition as IssueTriageDisposition),
        confidence: input.confidence as IssueTriageConfidence,
        summary: input.summary,
        evidence: input.evidence as string[],
        recommendedAction: input.recommendedAction as string,
      },
    ]).map(canonicalIssueTriageBlocker),
  );
  const primary = primaryIssueTriageBlockerForLegacyFields(blockers);
  if (!primary) {
    throw new SymphonyError("invalid_request", "Issue triage report requires at least one blocker");
  }
  return {
    runId: normalizeString(input.runId),
    issueId: normalizeString(input.issueId),
    triggerFingerprint: normalizeString(input.triggerFingerprint),
    finalDisposition: input.finalDisposition,
    summary: normalizeString(input.summary),
    blockers,
    disposition: legacyDispositionForIssueTriageBlocker(primary.kind),
    confidence: primary.confidence,
    evidence: primary.evidence,
    recommendedAction: primary.recommendedAction,
    idempotencyKey: normalizeString(input.idempotencyKey),
  };
}

function canonicalIssueTriageBlocker(blocker: IssueTriageBlockerRecord): IssueTriageBlockerRecord {
  return {
    kind: blocker.kind,
    status: blocker.status,
    nextActor: blocker.nextActor,
    confidence: blocker.confidence,
    summary: normalizeString(blocker.summary),
    evidence: normalizeStringList(blocker.evidence),
    recommendedAction: normalizeString(blocker.recommendedAction),
  };
}

function primaryIssueTriageBlockerForLegacyFields(blockers: readonly IssueTriageBlockerRecord[]): IssueTriageBlockerRecord | null {
  const active = highestPrecedenceIssueTriageBlocker({ blockers: blockers.filter((blocker) => blocker.status === "active") });
  return active ?? highestPrecedenceIssueTriageBlocker({ blockers });
}

function compareIssueTriageBlockers(left: IssueTriageBlockerRecord, right: IssueTriageBlockerRecord): number {
  const precedence = ISSUE_TRIAGE_BLOCKER_PRECEDENCE[left.kind] - ISSUE_TRIAGE_BLOCKER_PRECEDENCE[right.kind];
  if (precedence !== 0) return precedence;
  const status = issueTriageBlockerStatusRank(left.status) - issueTriageBlockerStatusRank(right.status);
  if (status !== 0) return status;
  const actor = left.nextActor.localeCompare(right.nextActor);
  if (actor !== 0) return actor;
  return left.summary.localeCompare(right.summary);
}

function issueTriageBlockerStatusRank(status: IssueTriageBlockerStatus): number {
  return status === "active" ? 0 : 1;
}

function legacyIssueTriageBlockerKind(disposition: IssueTriageDisposition): IssueTriageBlockerKind {
  switch (disposition) {
    case "decompose_issue":
      return "under_specified_needs_decomposition";
    case "implementation_repair":
      return "implementation_unsatisfied_requirements";
    case "validation_repair":
      return "validation_or_test_failure";
    case "compatibility_matrix_repair":
      return "compatibility_matrix_gap";
    case "retarget_or_split_pr":
    case "close_or_retarget_issue":
      return "pr_target_or_scope_mismatch";
    case "merge_gate_repair":
      return "merge_gate_check_failure";
    case "process_gate_repair":
    case "orchestrator_context_repair":
      return "orchestrator_context_or_prompt_gap";
    case "infra_repair":
      return "infra_or_tooling_failure";
    case "manual_decision":
      return "manual_decision";
  }
}

function legacyIssueTriageNextActor(disposition: IssueTriageDisposition): IssueTriageBlockerNextActor {
  switch (disposition) {
    case "decompose_issue":
      return "planner";
    case "implementation_repair":
    case "validation_repair":
    case "compatibility_matrix_repair":
    case "merge_gate_repair":
      return "worker";
    case "process_gate_repair":
    case "orchestrator_context_repair":
      return "orchestrator";
    case "infra_repair":
      return "infra";
    case "retarget_or_split_pr":
    case "close_or_retarget_issue":
    case "manual_decision":
      return "operator";
  }
}

function legacyDispositionForIssueTriageBlocker(kind: IssueTriageBlockerKind): IssueTriageDisposition {
  switch (kind) {
    case "under_specified_needs_decomposition":
      return "decompose_issue";
    case "implementation_unsatisfied_requirements":
      return "implementation_repair";
    case "validation_or_test_failure":
      return "validation_repair";
    case "compatibility_matrix_gap":
      return "compatibility_matrix_repair";
    case "pr_target_or_scope_mismatch":
      return "retarget_or_split_pr";
    case "merge_conflict":
    case "merge_gate_check_failure":
    case "pr_review_gate":
      return "merge_gate_repair";
    case "orchestrator_context_or_prompt_gap":
      return "orchestrator_context_repair";
    case "infra_or_tooling_failure":
      return "infra_repair";
    case "manual_decision":
      return "manual_decision";
  }
}

function validateCaller(report: IssueTriageReportInput, context: IssueTriageActiveContext): void {
  if (context.role !== "triage" || context.phase !== "issue_triage") {
    throw new SymphonyError("invalid_request", "Issue triage reports can only be submitted by issue triage runs");
  }
  if (report.runId !== context.activeRunId) {
    throw new SymphonyError("invalid_request", "Issue triage report runId does not match the active run");
  }
  if (report.issueId !== context.issue.id && report.issueId !== context.issue.identifier) {
    throw new SymphonyError("invalid_request", "Issue triage report issueId does not match the active issue");
  }
}

function assertIssueTriageReplayAllowed(
  existing: IssueTriageReportRecord,
  expected: {
    idempotencyKey: string;
    activeRunId: string;
    requestHash: string;
    preFinalDispositionRequestHash: string;
    legacyRequestHash: string;
  },
): void {
  if (
    existing.requestHash !== expected.requestHash &&
    !(
      existing.finalDisposition === undefined &&
      (existing.requestHash === expected.preFinalDispositionRequestHash ||
        existing.requestHash === expected.legacyRequestHash)
    )
  ) {
    throw issueTriageIdempotencyConflict("payload_mismatch", existing, expected);
  }
}

function issueTriageIdempotencyConflict(
  reason: "payload_mismatch" | "cross_run_key_reuse",
  existing: IssueTriageReportRecord,
  expected: {
    idempotencyKey: string;
    activeRunId: string;
    requestHash: string;
    preFinalDispositionRequestHash?: string;
    legacyRequestHash?: string;
  },
): SymphonyError {
  return new SymphonyError("conflict", "Issue triage report idempotency key was reused with a different run or payload", {
    reason,
    idempotencyKey: expected.idempotencyKey,
    activeRunId: expected.activeRunId,
    requestHash: expected.requestHash,
    legacyRequestHash: expected.legacyRequestHash,
    existingRunId: existing.runId,
    existingRequestHash: existing.requestHash,
    existingReportId: existing.id,
  });
}

function issueTriageReportIdFor(issueId: string, idempotencyKey: string): string {
  return `issue-triage-report:${issueId}:${idempotencyKey}`;
}

function normalizeString(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeStringList(values: readonly string[]): string[] {
  return values.map((value) => normalizeString(value)).sort();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
