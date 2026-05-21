import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  CompletionReportChecklistItem,
  IssueCompletionReportRecord,
  IssueLifecyclePhase,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import { phaseForIssueState } from "./persistence/IssueLifecycleStore.js";
import type { Issue, Workspace } from "./types.js";
import { planCompletionReportAcceptedWritebacks } from "./writeback/TransitionPolicy.js";
import type { FileWritebackOutboxStore, WritebackOperation } from "./writeback/WritebackOutbox.js";

const completionReportSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  validationEvidence: z.array(z.string().trim().min(1)).min(1),
  acceptanceChecklist: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        satisfied: z.boolean(),
        evidence: z.string().trim().min(1).nullable(),
      }),
    )
    .min(1),
  changedFiles: z.array(z.string().trim().min(1)),
  branchName: z.string().trim().min(1).nullable(),
  pullRequest: z
    .object({
      url: z.string().trim().min(1).nullable(),
      number: z.number().int().positive().nullable(),
    })
    .nullable(),
  risks: z.array(z.string().trim().min(1)),
  idempotencyKey: z.string().trim().min(1),
});

export type CompletionReportInput = z.infer<typeof completionReportSchema>;
export type CompletionReportSubmitterRole = "worker" | "orchestrator" | "reviewer" | string;

export interface CompletionReportActiveContext {
  issue: Issue;
  activeRunId: string;
  role: CompletionReportSubmitterRole;
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath?: string | null;
  workspace?: Workspace | null;
  phase?: IssueLifecyclePhase | null;
}

export interface CompletionReportServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "enqueueOnce">;
}

export interface CompletionReportResult {
  accepted: true;
  replayed: boolean;
  report: IssueCompletionReportRecord;
  writebackOperations: WritebackOperation[];
}

export class CompletionReportService {
  constructor(private readonly options: CompletionReportServiceOptions) {}

  async submit_completion_report(input: unknown, context: CompletionReportActiveContext): Promise<CompletionReportResult> {
    return this.submitCompletionReport(input, context);
  }

  async submitCompletionReport(input: unknown, context: CompletionReportActiveContext): Promise<CompletionReportResult> {
    const report = parseCompletionReport(input);
    this.validateCaller(report, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    const existing = existingLifecycle?.completionReports.find((item) => item.idempotencyKey === report.idempotencyKey);
    if (existing) {
      return { accepted: true, replayed: true, report: existing, writebackOperations: [] };
    }

    const lifecyclePhase = context.phase ?? existingLifecycle?.phase ?? phaseForIssueState(context.issue.state, this.options.config);
    this.validateIssueIsAcceptingReports(context, lifecyclePhase);

    const lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
      phase: lifecyclePhase,
      summaryPointers: {
        workspacePath: context.workspacePath ?? context.workspace?.path ?? null,
        branchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? null,
        lastRunId: context.activeRunId,
      },
    });

    const operations = planCompletionReportAcceptedWritebacks(
      {
        issue: context.issue,
        runId: report.runId,
        sessionId: context.sessionId ?? null,
        workspacePath: context.workspacePath ?? context.workspace?.path ?? null,
        workspace: context.workspace ?? null,
      },
      this.options.config,
      {
        reportId: reportIdFor(context.issue.id, report.idempotencyKey),
        idempotencyKey: report.idempotencyKey,
        summary: report.summary,
        validationEvidence: report.validationEvidence,
        acceptanceChecklist: report.acceptanceChecklist,
        changedFiles: report.changedFiles,
        branchName: report.branchName,
        pullRequest: report.pullRequest,
        risks: report.risks,
      },
    );
    if (operations.length === 0) {
      throw new SymphonyError("invalid_request", "Completion report cannot be accepted for the current issue state");
    }

    const storedReport: IssueCompletionReportRecord = {
      id: reportIdFor(context.issue.id, report.idempotencyKey),
      idempotencyKey: report.idempotencyKey,
      runId: report.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      summary: report.summary,
      validationEvidence: report.validationEvidence,
      acceptanceChecklist: normalizeChecklist(report.acceptanceChecklist),
      changedFiles: report.changedFiles,
      branchName: report.branchName,
      pullRequest: report.pullRequest,
      risks: report.risks,
      acceptedAt: new Date().toISOString(),
      writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
    };
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }

    await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: "review",
      incompleteTurnCount: 0,
      lastCompletionReportId: storedReport.id,
      completionReports: [...lifecycle.completionReports, storedReport],
      summaryPointers: {
        workspacePath: context.workspacePath ?? context.workspace?.path ?? null,
        branchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? null,
        lastRunId: context.activeRunId,
      },
    });

    return { accepted: true, replayed: false, report: storedReport, writebackOperations: enqueued };
  }

  private validateCaller(report: CompletionReportInput, context: CompletionReportActiveContext): void {
    if (context.role !== "worker") {
      throw new SymphonyError("invalid_request", "Only active workers may submit completion reports");
    }
    if (context.expectedToken !== undefined && context.expectedToken !== null && context.token !== context.expectedToken) {
      throw new SymphonyError("invalid_request", "Missing or invalid completion report token");
    }
    if (report.runId !== context.activeRunId) {
      throw new SymphonyError("invalid_request", "Completion report run does not match the active worker run");
    }
    if (report.issueId !== context.issue.id && report.issueId !== context.issue.identifier) {
      throw new SymphonyError("invalid_request", "Completion report issue does not match the active worker issue");
    }
  }

  private validateIssueIsAcceptingReports(context: CompletionReportActiveContext, lifecyclePhase: IssueLifecyclePhase): void {
    if (lifecyclePhase !== "implementation") {
      throw new SymphonyError("invalid_request", `Completion report cannot be accepted while lifecycle phase is ${lifecyclePhase}`);
    }
    if (!sameState(context.issue.state, this.options.config.writeback.dispatchState)) {
      throw new SymphonyError("invalid_request", "Completion report requires the issue to be in the active implementation state");
    }
  }
}

function parseCompletionReport(input: unknown): CompletionReportInput {
  const parsed = completionReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Completion report is invalid", parsed.error.flatten());
  }
  return parsed.data;
}

function reportIdFor(issueId: string, idempotencyKey: string): string {
  return `completion-report:${issueId}:${idempotencyKey}`;
}

function normalizeChecklist(items: CompletionReportInput["acceptanceChecklist"]): CompletionReportChecklistItem[] {
  return items.map((item) => ({
    text: item.text,
    satisfied: item.satisfied,
    evidence: item.evidence,
  }));
}

function sameState(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
