import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssuePostMortemCompletionStatus,
  IssuePostMortemFollowUpCandidateRecord,
  IssuePostMortemFollowUpKind,
  IssuePostMortemFollowUpPriority,
  IssuePostMortemReportRecord,
  IssuePostMortemSpecificationClassification,
  IssuePostMortemSpecificationQuality,
} from "./persistence/IssueLifecycleStore.js";
import { latestCurrentApprovalPassVerdict } from "./persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { Issue } from "./types.js";
import { planIssuePostMortemReportWritebacks } from "./writeback/TransitionPolicy.js";
import type { FileWritebackOutboxStore } from "./writeback/WritebackOutbox.js";

export const ISSUE_POST_MORTEM_COMPLETION_STATUSES = [
  "valid_done",
  "valid_with_followups",
  "questionable_done",
] as const satisfies readonly IssuePostMortemCompletionStatus[];

export const ISSUE_POST_MORTEM_SPECIFICATION_QUALITIES = [
  "strong",
  "adequate",
  "weak",
] as const satisfies readonly IssuePostMortemSpecificationQuality[];

export const ISSUE_POST_MORTEM_SPECIFICATION_CLASSIFICATIONS = [
  "well_scoped",
  "underspecified",
  "overbroad",
  "speckit_candidate",
  "needs_clarification",
] as const satisfies readonly IssuePostMortemSpecificationClassification[];

export const ISSUE_POST_MORTEM_FOLLOW_UP_PRIORITIES = [
  "high",
  "medium",
  "low",
] as const satisfies readonly IssuePostMortemFollowUpPriority[];

export const ISSUE_POST_MORTEM_FOLLOW_UP_KINDS = [
  "hardening",
  "test_gap",
  "scope_gap",
  "refactor",
  "process_gap",
] as const satisfies readonly IssuePostMortemFollowUpKind[];

const postMortemFollowUpCandidateSchema = z.object({
  title: z.string().trim().min(1),
  priority: z.enum(ISSUE_POST_MORTEM_FOLLOW_UP_PRIORITIES),
  kind: z.enum(ISSUE_POST_MORTEM_FOLLOW_UP_KINDS),
  rationale: z.string().trim().min(1),
  readyForSpecKit: z.boolean(),
  suggestedIssueContract: z.string().trim().min(1).nullable(),
});

const issuePostMortemReportSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  triggerFingerprint: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  completionJudgment: z.object({
    status: z.enum(ISSUE_POST_MORTEM_COMPLETION_STATUSES),
    rationale: z.string().trim().min(1),
  }),
  specificationAssessment: z.object({
    quality: z.enum(ISSUE_POST_MORTEM_SPECIFICATION_QUALITIES),
    classifications: z.array(z.enum(ISSUE_POST_MORTEM_SPECIFICATION_CLASSIFICATIONS)).min(1),
    missingContractAreas: z.array(z.string().trim().min(1)),
    speckitRecommended: z.boolean(),
    speckitRationale: z.string().trim().min(1),
  }),
  reviewAssessment: z.object({
    gateDecisionLooksValid: z.boolean(),
    missedGateFindings: z.array(z.string().trim().min(1)),
    missedDiscoveryFindings: z.array(z.string().trim().min(1)),
  }),
  followUpCandidates: z.array(postMortemFollowUpCandidateSchema),
  processLessons: z.array(z.string().trim().min(1)),
  idempotencyKey: z.string().trim().min(1),
});

type RawIssuePostMortemReportInput = z.infer<typeof issuePostMortemReportSchema>;

export interface IssuePostMortemReportInput {
  runId: string;
  issueId: string;
  triggerFingerprint: string;
  summary: string;
  completionJudgment: {
    status: IssuePostMortemCompletionStatus;
    rationale: string;
  };
  specificationAssessment: {
    quality: IssuePostMortemSpecificationQuality;
    classifications: IssuePostMortemSpecificationClassification[];
    missingContractAreas: string[];
    speckitRecommended: boolean;
    speckitRationale: string;
  };
  reviewAssessment: {
    gateDecisionLooksValid: boolean;
    missedGateFindings: string[];
    missedDiscoveryFindings: string[];
  };
  followUpCandidates: IssuePostMortemFollowUpCandidateRecord[];
  processLessons: string[];
  idempotencyKey: string;
}

export interface IssuePostMortemActiveContext {
  issue: Issue;
  activeRunId: string;
  role: "post_mortem";
  phase: "post_mortem";
  manualDispatch?: boolean;
}

export interface IssuePostMortemServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "enqueueOnce">;
  runStore?: Pick<RunTranscriptStore, "appendEvent">;
}

export interface IssuePostMortemReportResult {
  accepted: true;
  replayed: boolean;
  report: IssuePostMortemReportRecord;
}

export class IssuePostMortemService {
  constructor(private readonly options: IssuePostMortemServiceOptions) {}

  async submit_issue_post_mortem_report(
    input: unknown,
    context: IssuePostMortemActiveContext,
  ): Promise<IssuePostMortemReportResult> {
    return this.submitIssuePostMortemReport(input, context);
  }

  async submitIssuePostMortemReport(
    input: unknown,
    context: IssuePostMortemActiveContext,
  ): Promise<IssuePostMortemReportResult> {
    const parsed = parseIssuePostMortemReport(input);
    validateCaller(parsed, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    if (!existingLifecycle) {
      throw new SymphonyError("invalid_request", "Issue post-mortem report requires an existing lifecycle record");
    }
    const expectedFingerprint = issuePostMortemTriggerFingerprint(existingLifecycle, context.issue);
    if (parsed.triggerFingerprint !== expectedFingerprint) {
      throw new SymphonyError("conflict", "Issue post-mortem trigger fingerprint is stale", {
        expectedTriggerFingerprint: expectedFingerprint,
        submittedTriggerFingerprint: parsed.triggerFingerprint,
      });
    }

    const requestHash = issuePostMortemReportRequestHash(parsed);
    const existingScoped = existingLifecycle.postMortemReports.find(
      (report) => report.runId === context.activeRunId && report.idempotencyKey === parsed.idempotencyKey,
    );
    if (existingScoped) {
      assertIssuePostMortemReplayAllowed(existingScoped, {
        idempotencyKey: parsed.idempotencyKey,
        activeRunId: context.activeRunId,
        requestHash,
      });
      return { accepted: true, replayed: true, report: existingScoped };
    }
    const existingCrossRun = existingLifecycle.postMortemReports.find(
      (report) => report.idempotencyKey === parsed.idempotencyKey && report.runId !== context.activeRunId,
    );
    if (existingCrossRun) {
      throw issuePostMortemIdempotencyConflict("cross_run_key_reuse", existingCrossRun, {
        idempotencyKey: parsed.idempotencyKey,
        activeRunId: context.activeRunId,
        requestHash,
      });
    }

    const eligible =
      context.manualDispatch === true
        ? shouldIssuePostMortemManualRun(existingLifecycle, this.options.config)
        : shouldIssuePostMortemRun(existingLifecycle, context.issue, this.options.config);
    if (!eligible) {
      throw new SymphonyError("invalid_request", "Issue post-mortem is not currently eligible for this issue");
    }

    const attemptsForTrigger = existingLifecycle.postMortemReports.filter(
      (report) => report.triggerFingerprint === parsed.triggerFingerprint,
    ).length;
    if (context.manualDispatch !== true && attemptsForTrigger >= this.options.config.postMortem.maxAttemptsPerTrigger) {
      throw new SymphonyError("conflict", "Issue post-mortem report already exists for this trigger", {
        triggerFingerprint: parsed.triggerFingerprint,
        attemptsForTrigger,
        maxAttemptsPerTrigger: this.options.config.postMortem.maxAttemptsPerTrigger,
      });
    }

    const submittedAt = new Date().toISOString();
    const reportBase: IssuePostMortemReportRecord = {
      id: issuePostMortemReportIdFor(context.issue.id, parsed.idempotencyKey),
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      runId: parsed.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      triggerFingerprint: parsed.triggerFingerprint,
      summary: parsed.summary,
      completionJudgment: parsed.completionJudgment,
      specificationAssessment: parsed.specificationAssessment,
      reviewAssessment: parsed.reviewAssessment,
      followUpCandidates: parsed.followUpCandidates,
      processLessons: parsed.processLessons,
      submittedAt,
      writebackOperationKeys: [],
    };
    const operations = planIssuePostMortemReportWritebacks({ issue: context.issue, report: reportBase }, this.options.config);
    const writebackOperationKeys: string[] = [];
    for (const operation of operations) {
      const enqueued = await this.options.writebackOutbox.enqueueOnce(operation);
      writebackOperationKeys.push(enqueued.idempotencyKey);
    }
    const report: IssuePostMortemReportRecord = {
      ...reportBase,
      writebackOperationKeys,
    };

    const lifecycle = await this.options.lifecycleStore.updateIssue(context.issue, {
      lastPostMortemReportId: report.id,
      postMortemReports: [...existingLifecycle.postMortemReports, report],
    });
    await this.options.runStore?.appendEvent({
      runId: parsed.runId,
      at: submittedAt,
      source: "orchestrator",
      eventType: "issue_post_mortem_report_accepted",
      message: `Accepted issue post-mortem report ${report.id}`,
      payload: {
        reportId: report.id,
        completionStatus: report.completionJudgment.status,
        specificationQuality: report.specificationAssessment.quality,
        triggerFingerprint: report.triggerFingerprint,
        lifecycleUpdatedAt: lifecycle.updatedAt,
      },
    });
    return { accepted: true, replayed: false, report };
  }
}

export function parseIssuePostMortemReport(input: unknown): IssuePostMortemReportInput {
  const parsed = issuePostMortemReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Issue post-mortem report is invalid", parsed.error.flatten());
  }
  return canonicalIssuePostMortemReportInput(parsed.data);
}

export function shouldIssuePostMortemRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  issue: Issue,
  config: ServiceConfig,
): lifecycle is IssueLifecycleRecord {
  if (!config.postMortem.enabled || !lifecycle) return false;
  if (!isStateIn(issue.state, config.postMortem.doneStates)) return false;
  if (!hasPostMortemEvidence(lifecycle)) return false;
  const fingerprint = issuePostMortemTriggerFingerprint(lifecycle, issue);
  const attemptsForTrigger = lifecycle.postMortemReports.filter((report) => report.triggerFingerprint === fingerprint).length;
  return attemptsForTrigger < config.postMortem.maxAttemptsPerTrigger;
}

export function shouldIssuePostMortemManualRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  config: ServiceConfig,
): lifecycle is IssueLifecycleRecord {
  if (!config.postMortem.enabled || !lifecycle) return false;
  return hasPostMortemEvidence(lifecycle);
}

export function latestIssuePostMortemReportForFingerprint(
  lifecycle: IssueLifecycleRecord | null | undefined,
  triggerFingerprint: string,
): IssuePostMortemReportRecord | null {
  if (!lifecycle) return null;
  for (let index = lifecycle.postMortemReports.length - 1; index >= 0; index -= 1) {
    const report = lifecycle.postMortemReports[index];
    if (report?.triggerFingerprint === triggerFingerprint) return report;
  }
  return null;
}

export function latestIssuePostMortemReport(
  lifecycle: IssueLifecycleRecord | null | undefined,
): IssuePostMortemReportRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastPostMortemReportId) {
    const exact = lifecycle.postMortemReports.find((report) => report.id === lifecycle.lastPostMortemReportId);
    if (exact) return exact;
  }
  return lifecycle.postMortemReports[lifecycle.postMortemReports.length - 1] ?? null;
}

export function issuePostMortemTriggerFingerprint(lifecycle: IssueLifecycleRecord, issue: Issue): string {
  const completion = latestCompletionReport(lifecycle);
  const passVerdict = latestCurrentApprovalPassVerdict(lifecycle);
  return createHash("sha256")
    .update(
      stableJson({
        version: 1,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          state: normalizeString(issue.state),
          updatedAt: issue.updatedAt,
        },
        lifecycle: {
          phase: lifecycle.phase,
          reviewRound: lifecycle.reviewRound,
          incompleteTurnCount: lifecycle.incompleteTurnCount,
          lastCompletionReportId: lifecycle.lastCompletionReportId,
          lastReviewVerdictId: lifecycle.lastReviewVerdictId,
          merge: lifecycle.merge
            ? {
                pullRequest: lifecycle.merge.pullRequest,
                headSha: lifecycle.merge.headSha,
                mergeCommitSha: lifecycle.merge.mergeCommitSha,
                mergedAt: lifecycle.merge.mergedAt,
              }
            : null,
        },
        completion: completion
          ? {
              id: completion.id,
              runId: completion.runId,
              acceptedAt: completion.acceptedAt,
              pullRequest: completion.pullRequest,
            }
          : null,
        passVerdict: passVerdict
          ? {
              id: passVerdict.id,
              runId: passVerdict.runId,
              submittedAt: passVerdict.submittedAt,
            }
          : null,
      }),
    )
    .digest("hex");
}

export function issuePostMortemReportRequestHash(input: IssuePostMortemReportInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        issueId: input.issueId,
        triggerFingerprint: input.triggerFingerprint,
        summary: normalizeString(input.summary),
        completionJudgment: input.completionJudgment,
        specificationAssessment: input.specificationAssessment,
        reviewAssessment: input.reviewAssessment,
        followUpCandidates: input.followUpCandidates,
        processLessons: normalizeStringList(input.processLessons),
      }),
    )
    .digest("hex");
}

export function renderIssuePostMortemReportSummary(report: IssuePostMortemReportRecord): string {
  return [
    report.summary,
    "",
    `Completion judgment: ${report.completionJudgment.status}`,
    report.completionJudgment.rationale,
    "",
    `Specification: ${report.specificationAssessment.quality} (${report.specificationAssessment.classifications.join(", ")})`,
    `Spec Kit recommended: ${report.specificationAssessment.speckitRecommended ? "yes" : "no"} - ${
      report.specificationAssessment.speckitRationale
    }`,
    "",
    `Reviewer gate decision looks valid: ${report.reviewAssessment.gateDecisionLooksValid ? "yes" : "no"}`,
    "",
    "Follow-up candidates:",
    ...(report.followUpCandidates.length === 0
      ? ["- None"]
      : report.followUpCandidates.map((candidate) => `- [${candidate.priority}] ${candidate.kind}: ${candidate.title}`)),
  ].join("\n");
}

function canonicalIssuePostMortemReportInput(input: RawIssuePostMortemReportInput): IssuePostMortemReportInput {
  return {
    runId: normalizeString(input.runId),
    issueId: normalizeString(input.issueId),
    triggerFingerprint: normalizeString(input.triggerFingerprint),
    summary: normalizeString(input.summary),
    completionJudgment: {
      status: input.completionJudgment.status,
      rationale: normalizeString(input.completionJudgment.rationale),
    },
    specificationAssessment: {
      quality: input.specificationAssessment.quality,
      classifications: [...new Set(input.specificationAssessment.classifications)],
      missingContractAreas: normalizeStringList(input.specificationAssessment.missingContractAreas),
      speckitRecommended: input.specificationAssessment.speckitRecommended,
      speckitRationale: normalizeString(input.specificationAssessment.speckitRationale),
    },
    reviewAssessment: {
      gateDecisionLooksValid: input.reviewAssessment.gateDecisionLooksValid,
      missedGateFindings: normalizeStringList(input.reviewAssessment.missedGateFindings),
      missedDiscoveryFindings: normalizeStringList(input.reviewAssessment.missedDiscoveryFindings),
    },
    followUpCandidates: input.followUpCandidates.map((candidate) => ({
      title: normalizeString(candidate.title),
      priority: candidate.priority,
      kind: candidate.kind,
      rationale: normalizeString(candidate.rationale),
      readyForSpecKit: candidate.readyForSpecKit,
      suggestedIssueContract: candidate.suggestedIssueContract === null ? null : candidate.suggestedIssueContract.trim(),
    })),
    processLessons: normalizeStringList(input.processLessons),
    idempotencyKey: normalizeString(input.idempotencyKey),
  };
}

function validateCaller(report: IssuePostMortemReportInput, context: IssuePostMortemActiveContext): void {
  if (context.role !== "post_mortem" || context.phase !== "post_mortem") {
    throw new SymphonyError("invalid_request", "Issue post-mortem reports can only be submitted by post-mortem runs");
  }
  if (report.runId !== context.activeRunId) {
    throw new SymphonyError("invalid_request", "Issue post-mortem report runId does not match the active run");
  }
  if (report.issueId !== context.issue.id && report.issueId !== context.issue.identifier) {
    throw new SymphonyError("invalid_request", "Issue post-mortem report issueId does not match the active issue");
  }
}

function assertIssuePostMortemReplayAllowed(
  existing: IssuePostMortemReportRecord,
  expected: { idempotencyKey: string; activeRunId: string; requestHash: string },
): void {
  if (existing.requestHash !== expected.requestHash) {
    throw issuePostMortemIdempotencyConflict("payload_mismatch", existing, expected);
  }
}

function issuePostMortemIdempotencyConflict(
  reason: "payload_mismatch" | "cross_run_key_reuse",
  existing: IssuePostMortemReportRecord,
  expected: { idempotencyKey: string; activeRunId: string; requestHash: string },
): SymphonyError {
  return new SymphonyError("conflict", "Issue post-mortem report idempotency key was reused with a different run or payload", {
    reason,
    idempotencyKey: expected.idempotencyKey,
    activeRunId: expected.activeRunId,
    requestHash: expected.requestHash,
    existingRunId: existing.runId,
    existingRequestHash: existing.requestHash,
    existingReportId: existing.id,
  });
}

function hasPostMortemEvidence(lifecycle: IssueLifecycleRecord): boolean {
  return latestCompletionReport(lifecycle) !== null && latestCurrentApprovalPassVerdict(lifecycle) !== null;
}

function latestCompletionReport(
  record: Pick<IssueLifecycleRecord, "completionReports" | "lastCompletionReportId">,
): IssueCompletionReportRecord | null {
  if (record.lastCompletionReportId) {
    return record.completionReports.find((report) => report.id === record.lastCompletionReportId) ?? null;
  }
  return record.completionReports[record.completionReports.length - 1] ?? null;
}

function issuePostMortemReportIdFor(issueId: string, idempotencyKey: string): string {
  return `issue-post-mortem-report:${issueId}:${idempotencyKey}`;
}

function isStateIn(state: string, states: readonly string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
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
