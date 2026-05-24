import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  CompletionReportChecklistItem,
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecyclePhase,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import { phaseForIssueState } from "./persistence/IssueLifecycleStore.js";
import { appendLaneMemoTelemetry } from "./persistence/LaneMemoTelemetry.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { OperatorApprovalRecord, OperatorApprovalService } from "./approval/OperatorApprovalService.js";
import type { Issue, Workspace } from "./types.js";
import {
  planCompletionReportAcceptedWritebacks,
  planCompletionReportPublicationApprovalPendingWritebacks,
  planCompletionReportPublicationApprovalTerminalWritebacks,
} from "./writeback/TransitionPolicy.js";
import type {
  FileWritebackOutboxStore,
  NewWritebackOperation,
  WritebackOperation,
  WritebackProcessor,
  WritebackStatus,
} from "./writeback/WritebackOutbox.js";

export const PUBLICATION_APPROVAL_BLOCKED_REASON = "awaiting operator approval for PR publication";
const SETTLED_WRITEBACK_STATUSES = new Set<WritebackStatus>(["succeeded", "skipped"]);

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
      headSha: z.string().trim().min(1).nullable().optional(),
      branch: z.string().trim().min(1).nullable().optional(),
    })
    .nullable(),
  risks: z.array(z.string().trim().min(1)),
  idempotencyKey: z.string().trim().min(1),
});

export type CompletionReportInput = z.infer<typeof completionReportSchema>;
export type CompletionReportSubmitterRole = "worker" | "orchestrator" | "reviewer" | string;
type ExistingIssueLifecycle = Awaited<ReturnType<IssueLifecycleStore["get"]>>;

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
  writebackOutbox: Pick<FileWritebackOutboxStore, "enqueueOnce" | "get">;
  writebackProcessor?: Pick<WritebackProcessor, "processDue">;
  runStore?: Pick<RunTranscriptStore, "appendEvent" | "getRun" | "recordPullRequestEvent">;
  pullRequestPublisher?: CompletionReportPullRequestPublisher;
  operatorApproval?: Pick<OperatorApprovalService, "waitForPublicationApproval">;
}

export interface CompletionReportPullRequestPublisher {
  publishPullRequest(input: CompletionReportPullRequestPublicationInput): Promise<CompletionReportPullRequestPublication>;
}

export interface CompletionReportPullRequestPublicationInput {
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  evidenceCursor: string;
}

export interface CompletionReportPullRequestPublication {
  url: string;
  number: number;
  headBranch: string;
  headSha: string;
  lastPushedAt: string | null;
  action: "reused" | "created";
  evidenceCursor: string;
}

export interface CompletionReportResult {
  accepted: true;
  replayed: boolean;
  report: IssueCompletionReportRecord;
  writebackOperations: WritebackOperation[];
}

export interface PublicationApprovalResumeInput {
  approval: OperatorApprovalRecord;
  issue: Issue;
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
    if (existing && isFinalizedCompletionReport(existing)) {
      return { accepted: true, replayed: true, report: existing, writebackOperations: [] };
    }
    const resumingPendingPublication =
      existing !== undefined &&
      this.shouldPersistBeforePublicationApproval() &&
      isPendingPublicationApprovalLifecycle(existingLifecycle);

    const lifecyclePhase = context.phase ?? existingLifecycle?.phase ?? phaseForIssueState(context.issue.state, this.options.config);
    const inputPullRequest = normalizeInputPullRequest(report.pullRequest, report.branchName);
    let lifecycle = existingLifecycle;
    if (!resumingPendingPublication) {
      this.validateIssueIsAcceptingReports(context, lifecyclePhase);
    }

    if (this.shouldPersistBeforePublicationApproval()) {
      const publicationInput = this.buildPublicationInput(report, context, existingLifecycle);
      const pendingOperations = planCompletionReportPublicationApprovalPendingWritebacks(
        runWritebackContext(context, report.runId),
        this.options.config,
        completionReportWritebackDetails(report, context.issue, inputPullRequest),
        {
          branchName: publicationInput.branchName,
          baseBranch: publicationInput.baseBranch,
          workspacePath: publicationInput.workspacePath,
          title: publicationInput.title,
        },
      );
      if (resumingPendingPublication) {
        for (const operation of pendingOperations) {
          await this.options.writebackOutbox.enqueueOnce(operation);
        }
        await this.processAndVerifyPendingPublicationApprovalWritebacks(pendingOperations);
      } else {
        const pendingReport = buildCompletionReportRecord({
          report,
          issue: context.issue,
          pullRequest: inputPullRequest,
          acceptedAt: existing?.acceptedAt ?? null,
          writebackOperationKeys: [],
        });
        for (const operation of pendingOperations) {
          await this.options.writebackOutbox.enqueueOnce(operation);
        }
        lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
          phase: "blocked",
          blockedReason: PUBLICATION_APPROVAL_BLOCKED_REASON,
          lastCompletionReportId: pendingReport.id,
          completionReports: upsertCompletionReport(existingLifecycle?.completionReports ?? [], pendingReport),
          summaryPointers: summaryPointersFor(context, inputPullRequest, null, existingLifecycle),
        });
        await this.processAndVerifyPendingPublicationApprovalWritebacks(pendingOperations);
      }
    }

    let publication: CompletionReportPullRequestPublication | null;
    try {
      publication = await this.publishPullRequestIfNeeded(report, context, lifecycle);
    } catch (error) {
      await this.recordPublicationApprovalTerminalIfNeeded(error, report, context, inputPullRequest);
      throw error;
    }
    return this.finalizeCompletionReport({ report, context, inputPullRequest, publication, lifecycle, existing });
  }

  async resumeApprovedPublication(input: PublicationApprovalResumeInput): Promise<CompletionReportResult | null> {
    if (input.approval.status !== "approved") return null;
    if (!this.options.config.github.publishPullRequests) return null;
    if (!this.options.pullRequestPublisher) {
      throw new SymphonyError("invalid_request", "PR publication is enabled but no GitHub publisher is configured");
    }

    const lifecycle = await this.options.lifecycleStore.get(input.approval.issueId);
    const existing = lifecycle?.completionReports.find(
      (item) => item.runId === input.approval.runId && item.idempotencyKey === input.approval.evidenceCursor,
    );
    if (!lifecycle || !existing) return null;
    if (isFinalizedCompletionReport(existing)) {
      return { accepted: true, replayed: true, report: existing, writebackOperations: [] };
    }

    const report = completionReportInputFromRecord(existing);
    const context: CompletionReportActiveContext = {
      issue: input.issue,
      activeRunId: input.approval.runId,
      role: "worker",
      sessionId: null,
      workspacePath: input.approval.action.workspacePath,
      workspace: workspaceFromApproval(input.approval, lifecycle),
      phase: "blocked",
    };
    const publicationInput = this.buildPublicationInput(report, context, lifecycle);
    const publication = await this.options.pullRequestPublisher.publishPullRequest(publicationInput);
    return this.finalizeCompletionReport({
      report,
      context,
      inputPullRequest: normalizeInputPullRequest(report.pullRequest, report.branchName),
      publication,
      lifecycle,
      existing,
    });
  }

  async recordPublicationApprovalTerminal(input: PublicationApprovalResumeInput): Promise<boolean> {
    if (!isTerminalApprovalStatus(input.approval.status)) return false;
    const lifecycle = await this.options.lifecycleStore.get(input.approval.issueId);
    const existing = lifecycle?.completionReports.find(
      (item) => item.runId === input.approval.runId && item.idempotencyKey === input.approval.evidenceCursor,
    );
    if (!lifecycle || !existing || isFinalizedCompletionReport(existing)) return false;

    const report = completionReportInputFromRecord(existing);
    const context: CompletionReportActiveContext = {
      issue: input.issue,
      activeRunId: input.approval.runId,
      role: "worker",
      sessionId: null,
      workspacePath: input.approval.action.workspacePath,
      workspace: workspaceFromApproval(input.approval, lifecycle),
      phase: "blocked",
    };
    await this.enqueuePublicationApprovalTerminal(input.approval, report, context, existing.pullRequest);
    return true;
  }

  private async finalizeCompletionReport(input: {
    report: CompletionReportInput;
    context: CompletionReportActiveContext;
    inputPullRequest: CompletionReportPullRequestRef | null;
    publication: CompletionReportPullRequestPublication | null;
    lifecycle: ExistingIssueLifecycle;
    existing: IssueCompletionReportRecord | undefined;
  }): Promise<CompletionReportResult> {
    const pullRequest = input.publication
      ? pullRequestRefFromPublication(input.publication)
      : input.inputPullRequest;
    const lifecycle = await this.options.lifecycleStore.ensureIssue(input.context.issue, {
      summaryPointers: summaryPointersFor(input.context, pullRequest, input.publication, input.lifecycle),
    });
    const operations = planCompletionReportAcceptedWritebacks(
      runWritebackContext(input.context, input.report.runId),
      this.options.config,
      completionReportWritebackDetails(input.report, input.context.issue, pullRequest),
    );
    if (operations.length === 0) {
      throw new SymphonyError("invalid_request", "Completion report cannot be accepted for the current issue state");
    }

    const storedReport = buildCompletionReportRecord({
      report: input.report,
      issue: input.context.issue,
      pullRequest,
      writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      acceptedAt: input.existing?.acceptedAt ?? null,
    });
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }
    await this.recordPullRequestMetadata(input.context, input.publication);

    const updatedLifecycle = await this.options.lifecycleStore.updateIssue(input.context.issue, {
      phase: "review",
      blockedReason: null,
      incompleteTurnCount: 0,
      lastCompletionReportId: storedReport.id,
      completionReports: upsertCompletionReport(lifecycle.completionReports, storedReport),
      summaryPointers: summaryPointersFor(input.context, pullRequest, input.publication, lifecycle),
    });
    await appendLaneMemoTelemetry(this.options.runStore, input.context.activeRunId, updatedLifecycle, "completion_report");

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

  private async publishPullRequestIfNeeded(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    existingLifecycle: ExistingIssueLifecycle,
  ): Promise<CompletionReportPullRequestPublication | null> {
    if (!this.options.config.github.publishPullRequests) return null;
    const publicationInput = this.buildPublicationInput(report, context, existingLifecycle);
    await this.options.operatorApproval?.waitForPublicationApproval({
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      runId: context.activeRunId,
      evidenceCursor: report.idempotencyKey,
      action: {
        kind: "push_and_pr",
        branchName: publicationInput.branchName,
        baseBranch: publicationInput.baseBranch,
        workspacePath: publicationInput.workspacePath,
        title: publicationInput.title,
        evidenceCursor: report.idempotencyKey,
        summaryPreview: report.summary.length <= 240 ? report.summary : `${report.summary.slice(0, 237)}...`,
        changedFiles: report.changedFiles,
        plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
      },
    });
    return this.options.pullRequestPublisher!.publishPullRequest(publicationInput);
  }

  private buildPublicationInput(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    existingLifecycle: ExistingIssueLifecycle,
  ): CompletionReportPullRequestPublicationInput {
    if (!this.options.pullRequestPublisher) {
      throw new SymphonyError("invalid_request", "PR publication is enabled but no GitHub publisher is configured");
    }
    const workspacePath = context.workspacePath ?? context.workspace?.path ?? existingLifecycle?.summaryPointers.workspacePath ?? null;
    if (!workspacePath) {
      throw new SymphonyError("invalid_request", "PR publication requires a worktree workspace path");
    }
    const branchName =
      context.workspace?.gitBranchName ??
      report.branchName ??
      existingLifecycle?.summaryPointers.gitBranchName ??
      existingLifecycle?.summaryPointers.branchName ??
      context.issue.branchName;
    if (!branchName) {
      throw new SymphonyError("invalid_request", "PR publication requires a worktree branch");
    }
    const baseBranch = context.workspace?.baseRef ?? existingLifecycle?.summaryPointers.baseRef ?? this.options.config.workspace.source.baseRef;
    if (!baseBranch) {
      throw new SymphonyError("invalid_request", "PR publication requires a base branch");
    }
    return {
      workspacePath,
      branchName,
      baseBranch,
      title: `${context.issue.identifier}: ${context.issue.title}`,
      body: formatPullRequestBody(report, context),
      evidenceCursor: report.idempotencyKey,
    };
  }

  private shouldPersistBeforePublicationApproval(): boolean {
    return (
      this.options.config.github.publishPullRequests &&
      (this.options.config.github.operatorApproval?.requiredForPublication ?? false)
    );
  }

  private async processAndVerifyPendingPublicationApprovalWritebacks(
    operations: NewWritebackOperation[],
  ): Promise<void> {
    if (operations.length === 0) return;
    const processor = this.options.writebackProcessor;
    if (!processor) {
      throw new SymphonyError(
        "invalid_request",
        "Publication approval requires a writeback processor to apply pending Linear audit before waiting",
      );
    }
    await processor.processDue();
    for (const operation of operations) {
      const record = await this.options.writebackOutbox.get(operation.idempotencyKey);
      if (!record || !SETTLED_WRITEBACK_STATUSES.has(record.status)) {
        throw new SymphonyError("tracker_error", "Pending publication approval writeback did not complete", {
          idempotencyKey: operation.idempotencyKey,
          status: record?.status ?? "missing",
          lastError: record?.lastError ?? null,
        });
      }
    }
  }

  private async recordPullRequestMetadata(
    context: CompletionReportActiveContext,
    publication: CompletionReportPullRequestPublication | null,
  ): Promise<void> {
    if (!publication || !this.options.runStore) return;
    const existing = await this.options.runStore.getRun(context.activeRunId);
    if (
      existing?.prUrl === publication.url &&
      existing.prNumber === publication.number &&
      existing.prHeadSha === publication.headSha &&
      existing.prBranch === publication.headBranch &&
      existing.lastEvidenceCursor === publication.evidenceCursor
    ) {
      return;
    }
    await this.options.runStore.recordPullRequestEvent({
      runId: context.activeRunId,
      action: existing?.prUrl ? "updated" : "opened",
      prUrl: publication.url,
      prNumber: publication.number,
      prHeadSha: publication.headSha,
      prBranch: publication.headBranch,
      lastPushedAt: publication.lastPushedAt,
      lastEvidenceCursor: publication.evidenceCursor,
      gitBranchName: publication.headBranch,
      repoPath: context.workspace?.repoPath ?? null,
      baseRef: context.workspace?.baseRef ?? null,
    });
  }

  private async recordPublicationApprovalTerminalIfNeeded(
    error: unknown,
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    pullRequest: CompletionReportPullRequestRef | null,
  ): Promise<void> {
    const approval = error instanceof SymphonyError ? approvalRecordFromDetails(error.details) : null;
    if (!approval || !["rejected", "stale", "expired", "cancelled"].includes(approval.status)) return;
    await this.enqueuePublicationApprovalTerminal(approval, report, context, pullRequest);
  }

  private async enqueuePublicationApprovalTerminal(
    approval: OperatorApprovalRecord,
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    pullRequest: CompletionReportPullRequestRef | null,
  ): Promise<void> {
    if (!isTerminalApprovalStatus(approval.status)) return;
    const issue = {
      ...context.issue,
      state: this.options.config.reviewLoop.blockedStates[0] ?? context.issue.state,
    };
    for (const operation of planCompletionReportPublicationApprovalTerminalWritebacks(
      runWritebackContext({ ...context, issue }, report.runId),
      this.options.config,
      completionReportWritebackDetails(report, issue, pullRequest),
      approval.status,
      approval.staleReason,
    )) {
      await this.options.writebackOutbox.enqueueOnce(operation);
    }
    await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: "blocked",
      blockedReason: `publication approval ${approval.status}`,
    });
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

export function isFinalizedCompletionReport(report: IssueCompletionReportRecord): boolean {
  return report.writebackOperationKeys.length > 0;
}

function isPendingPublicationApprovalLifecycle(lifecycle: ExistingIssueLifecycle): boolean {
  return lifecycle?.phase === "blocked" && lifecycle.blockedReason === PUBLICATION_APPROVAL_BLOCKED_REASON;
}

function isTerminalApprovalStatus(
  status: OperatorApprovalRecord["status"],
): status is "rejected" | "stale" | "expired" | "cancelled" {
  return status === "rejected" || status === "stale" || status === "expired" || status === "cancelled";
}

function buildCompletionReportRecord(input: {
  report: CompletionReportInput;
  issue: Issue;
  pullRequest: CompletionReportPullRequestRef | null;
  acceptedAt: string | null;
  writebackOperationKeys: string[];
}): IssueCompletionReportRecord {
  return {
    id: reportIdFor(input.issue.id, input.report.idempotencyKey),
    idempotencyKey: input.report.idempotencyKey,
    runId: input.report.runId,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    summary: input.report.summary,
    validationEvidence: input.report.validationEvidence,
    acceptanceChecklist: normalizeChecklist(input.report.acceptanceChecklist),
    changedFiles: input.report.changedFiles,
    branchName: input.report.branchName,
    pullRequest: input.pullRequest,
    risks: input.report.risks,
    acceptedAt: input.acceptedAt ?? new Date().toISOString(),
    writebackOperationKeys: input.writebackOperationKeys,
  };
}

function upsertCompletionReport(
  reports: IssueCompletionReportRecord[],
  report: IssueCompletionReportRecord,
): IssueCompletionReportRecord[] {
  return [...reports.filter((item) => item.idempotencyKey !== report.idempotencyKey), report];
}

function summaryPointersFor(
  context: CompletionReportActiveContext,
  pullRequest: CompletionReportPullRequestRef | null,
  publication: CompletionReportPullRequestPublication | null,
  existingLifecycle: ExistingIssueLifecycle,
) {
  return {
    workspacePath: context.workspacePath ?? context.workspace?.path ?? existingLifecycle?.summaryPointers.workspacePath ?? null,
    branchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? existingLifecycle?.summaryPointers.branchName ?? null,
    gitBranchName:
      context.workspace?.gitBranchName ?? context.issue.branchName ?? existingLifecycle?.summaryPointers.gitBranchName ?? null,
    repoPath: context.workspace?.repoPath ?? existingLifecycle?.summaryPointers.repoPath ?? null,
    baseRef: context.workspace?.baseRef ?? existingLifecycle?.summaryPointers.baseRef ?? null,
    lastRunId: context.activeRunId,
    prUrl: pullRequest?.url ?? null,
    prNumber: pullRequest?.number ?? null,
    prHeadSha: pullRequest?.headSha ?? null,
    prBranch: pullRequest?.branch ?? null,
    lastPushedAt: publication?.lastPushedAt ?? existingLifecycle?.summaryPointers.lastPushedAt ?? null,
    lastEvidenceCursor: publication?.evidenceCursor ?? existingLifecycle?.summaryPointers.lastEvidenceCursor ?? null,
  };
}

function normalizeChecklist(items: CompletionReportInput["acceptanceChecklist"]): CompletionReportChecklistItem[] {
  return items.map((item) => ({
    text: item.text,
    satisfied: item.satisfied,
    evidence: item.evidence,
  }));
}

function normalizeInputPullRequest(
  pullRequest: CompletionReportInput["pullRequest"],
  branchName: string | null,
): CompletionReportPullRequestRef | null {
  if (pullRequest === null) return null;
  return {
    url: pullRequest.url,
    number: pullRequest.number,
    headSha: pullRequest.headSha ?? null,
    branch: pullRequest.branch ?? branchName,
  };
}

function pullRequestRefFromPublication(publication: CompletionReportPullRequestPublication): CompletionReportPullRequestRef {
  return {
    url: publication.url,
    number: publication.number,
    headSha: publication.headSha,
    branch: publication.headBranch,
  };
}

function runWritebackContext(context: CompletionReportActiveContext, runId: string) {
  return {
    issue: context.issue,
    runId,
    sessionId: context.sessionId ?? null,
    workspacePath: context.workspacePath ?? context.workspace?.path ?? null,
    workspace: context.workspace ?? null,
  };
}

function completionReportWritebackDetails(
  report: CompletionReportInput,
  issue: Issue,
  pullRequest: CompletionReportPullRequestRef | null,
) {
  return {
    reportId: reportIdFor(issue.id, report.idempotencyKey),
    idempotencyKey: report.idempotencyKey,
    summary: report.summary,
    validationEvidence: report.validationEvidence,
    acceptanceChecklist: report.acceptanceChecklist,
    changedFiles: report.changedFiles,
    branchName: report.branchName,
    pullRequest,
    risks: report.risks,
  };
}

function completionReportInputFromRecord(record: IssueCompletionReportRecord): CompletionReportInput {
  return {
    runId: record.runId,
    issueId: record.issueId,
    summary: record.summary,
    validationEvidence: record.validationEvidence,
    acceptanceChecklist: record.acceptanceChecklist,
    changedFiles: record.changedFiles,
    branchName: record.branchName,
    pullRequest: record.pullRequest,
    risks: record.risks,
    idempotencyKey: record.idempotencyKey,
  };
}

function workspaceFromApproval(approval: OperatorApprovalRecord, lifecycle: NonNullable<ExistingIssueLifecycle>): Workspace {
  return {
    path: approval.action.workspacePath,
    workspaceKey: lifecycle.summaryPointers.workspaceKey ?? approval.issueIdentifier,
    createdNow: false,
    issueId: approval.issueId,
    issueIdentifier: approval.issueIdentifier,
    gitBranchName: approval.action.branchName,
    baseRef: approval.action.baseBranch,
    ...(lifecycle.summaryPointers.repoPath === null ? {} : { repoPath: lifecycle.summaryPointers.repoPath }),
  };
}

function approvalRecordFromDetails(details: unknown): OperatorApprovalRecord | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as Partial<OperatorApprovalRecord>;
  return typeof record.requestId === "string" && typeof record.status === "string" ? (record as OperatorApprovalRecord) : null;
}

function formatPullRequestBody(report: CompletionReportInput, context: CompletionReportActiveContext): string {
  return [
    "Symphony published this pull request from an accepted worker completion report.",
    "",
    `Issue: ${context.issue.identifier}`,
    `Run: ${report.runId}`,
    `Evidence cursor: ${report.idempotencyKey}`,
    "",
    "Summary:",
    report.summary,
    "",
    "Validation evidence:",
    ...report.validationEvidence.map((item) => `- ${item}`),
    "",
    "Changed files:",
    ...(report.changedFiles.length === 0 ? ["- n/a"] : report.changedFiles.map((item) => `- ${item}`)),
  ].join("\n");
}

function sameState(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
