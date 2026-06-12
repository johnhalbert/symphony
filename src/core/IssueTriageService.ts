import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueTriageDisposition,
  IssueTriageReportRecord,
} from "./persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { Issue } from "./types.js";
import { planIssueTriageReportWritebacks } from "./writeback/TransitionPolicy.js";
import type { FileWritebackOutboxStore } from "./writeback/WritebackOutbox.js";

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

const issueTriageReportSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  triggerFingerprint: z.string().trim().min(1),
  disposition: z.enum(ISSUE_TRIAGE_DISPOSITIONS),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  recommendedAction: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
});

export type IssueTriageReportInput = z.infer<typeof issueTriageReportSchema>;

export interface IssueTriageActiveContext {
  issue: Issue;
  activeRunId: string;
  role: "triage";
  phase: "issue_triage";
}

export interface IssueTriageServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "enqueueOnce">;
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
    const existingScoped = existingLifecycle.issueTriageReports.find(
      (report) => report.runId === context.activeRunId && report.idempotencyKey === parsed.idempotencyKey,
    );
    if (existingScoped) {
      assertIssueTriageReplayAllowed(existingScoped, { idempotencyKey: parsed.idempotencyKey, activeRunId: context.activeRunId, requestHash });
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
    if (!shouldIssueTriageRun(existingLifecycle, this.options.config)) {
      throw new SymphonyError("invalid_request", "Issue triage is not currently eligible for this issue");
    }

    const attemptsForTrigger = existingLifecycle.issueTriageReports.filter(
      (report) => report.triggerFingerprint === parsed.triggerFingerprint,
    ).length;
    if (attemptsForTrigger >= this.options.config.issueTriage.maxAttemptsPerTrigger) {
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
      disposition: parsed.disposition,
      confidence: parsed.confidence,
      summary: parsed.summary,
      evidence: parsed.evidence,
      recommendedAction: parsed.recommendedAction,
      submittedAt,
      writebackOperationKeys: [],
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
    for (const operation of operations) {
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
  return parsed.data;
}

export function shouldIssueTriageRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  config: ServiceConfig,
): lifecycle is IssueLifecycleRecord {
  if (!config.issueTriage.enabled || !lifecycle || lifecycle.phase !== "blocked") return false;
  if (!isIssueTriageBlockedReason(lifecycle.blockedReason)) return false;
  const fingerprint = issueTriageTriggerFingerprint(lifecycle);
  const attemptsForTrigger = lifecycle.issueTriageReports.filter((report) => report.triggerFingerprint === fingerprint).length;
  return attemptsForTrigger < config.issueTriage.maxAttemptsPerTrigger;
}

export function isIssueTriageBlockedReason(reason: string | null | undefined): boolean {
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.includes("max reviewer failures") ||
    normalized.includes("max review rounds") ||
    normalized.includes("max merge gate failures") ||
    normalized.includes("merge gate required checks failed")
  );
}

export function latestIssueTriageReportForFingerprint(
  lifecycle: IssueLifecycleRecord | null | undefined,
  triggerFingerprint: string,
): IssueTriageReportRecord | null {
  if (!lifecycle) return null;
  for (let index = lifecycle.issueTriageReports.length - 1; index >= 0; index -= 1) {
    const report = lifecycle.issueTriageReports[index];
    if (report?.triggerFingerprint === triggerFingerprint) return report;
  }
  return null;
}

export function latestIssueTriageReport(
  lifecycle: IssueLifecycleRecord | null | undefined,
): IssueTriageReportRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastIssueTriageReportId) {
    const exact = lifecycle.issueTriageReports.find((report) => report.id === lifecycle.lastIssueTriageReportId);
    if (exact) return exact;
  }
  return lifecycle.issueTriageReports[lifecycle.issueTriageReports.length - 1] ?? null;
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
    `Disposition: ${report.disposition}`,
    `Confidence: ${report.confidence}`,
    "",
    "Evidence:",
    ...report.evidence.map((item) => `- ${item}`),
    "",
    "Recommended next action:",
    report.recommendedAction,
  ].join("\n");
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
  expected: { idempotencyKey: string; activeRunId: string; requestHash: string },
): void {
  if (existing.requestHash !== expected.requestHash) {
    throw issueTriageIdempotencyConflict("payload_mismatch", existing, expected);
  }
}

function issueTriageIdempotencyConflict(
  reason: "payload_mismatch" | "cross_run_key_reuse",
  existing: IssueTriageReportRecord,
  expected: { idempotencyKey: string; activeRunId: string; requestHash: string },
): SymphonyError {
  return new SymphonyError("conflict", "Issue triage report idempotency key was reused with a different run or payload", {
    reason,
    idempotencyKey: expected.idempotencyKey,
    activeRunId: expected.activeRunId,
    requestHash: expected.requestHash,
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
