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
import type { OperatorApprovalService } from "./approval/OperatorApprovalService.js";
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
      headSha: z.string().trim().min(1).nullable().optional(),
      branch: z.string().trim().min(1).nullable().optional(),
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
    const publication = await this.publishPullRequestIfNeeded(report, context, existingLifecycle);
    const pullRequest = publication
      ? pullRequestRefFromPublication(publication)
      : normalizeInputPullRequest(report.pullRequest, report.branchName);

    const lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
      phase: lifecyclePhase,
      summaryPointers: {
        workspacePath: context.workspacePath ?? context.workspace?.path ?? null,
        branchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? null,
        gitBranchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? null,
        repoPath: context.workspace?.repoPath ?? null,
        baseRef: context.workspace?.baseRef ?? null,
        lastRunId: context.activeRunId,
        prUrl: pullRequest?.url ?? null,
        prNumber: pullRequest?.number ?? null,
        prHeadSha: pullRequest?.headSha ?? null,
        prBranch: pullRequest?.branch ?? null,
        lastPushedAt: publication?.lastPushedAt ?? existingLifecycle?.summaryPointers.lastPushedAt ?? null,
        lastEvidenceCursor: publication?.evidenceCursor ?? existingLifecycle?.summaryPointers.lastEvidenceCursor ?? null,
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
        pullRequest,
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
      pullRequest,
      risks: report.risks,
      acceptedAt: new Date().toISOString(),
      writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
    };
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }
    await this.recordPullRequestMetadata(context, publication);

    const updatedLifecycle = await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: "review",
      incompleteTurnCount: 0,
      lastCompletionReportId: storedReport.id,
      completionReports: [...lifecycle.completionReports, storedReport],
      summaryPointers: {
        workspacePath: context.workspacePath ?? context.workspace?.path ?? null,
        branchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? null,
        gitBranchName: context.workspace?.gitBranchName ?? context.issue.branchName ?? null,
        repoPath: context.workspace?.repoPath ?? null,
        baseRef: context.workspace?.baseRef ?? null,
        lastRunId: context.activeRunId,
        prUrl: pullRequest?.url ?? null,
        prNumber: pullRequest?.number ?? null,
        prHeadSha: pullRequest?.headSha ?? null,
        prBranch: pullRequest?.branch ?? null,
        lastPushedAt: publication?.lastPushedAt ?? existingLifecycle?.summaryPointers.lastPushedAt ?? null,
        lastEvidenceCursor: publication?.evidenceCursor ?? existingLifecycle?.summaryPointers.lastEvidenceCursor ?? null,
      },
    });
    await appendLaneMemoTelemetry(this.options.runStore, context.activeRunId, updatedLifecycle, "completion_report");

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
    existingLifecycle: Awaited<ReturnType<IssueLifecycleStore["get"]>>,
  ): Promise<CompletionReportPullRequestPublication | null> {
    if (!this.options.config.github.publishPullRequests) return null;
    if (!this.options.pullRequestPublisher) {
      throw new SymphonyError("invalid_request", "PR publication is enabled but no GitHub publisher is configured");
    }
    const workspacePath = context.workspacePath ?? context.workspace?.path ?? null;
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
    const publicationInput = {
      workspacePath,
      branchName,
      baseBranch,
      title: `${context.issue.identifier}: ${context.issue.title}`,
      body: formatPullRequestBody(report, context),
      evidenceCursor: report.idempotencyKey,
    };
    await this.options.operatorApproval?.waitForPublicationApproval({
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      runId: context.activeRunId,
      evidenceCursor: report.idempotencyKey,
      action: {
        kind: "push_and_pr",
        branchName,
        baseBranch,
        workspacePath,
        title: publicationInput.title,
        evidenceCursor: report.idempotencyKey,
        summaryPreview: report.summary.length <= 240 ? report.summary : `${report.summary.slice(0, 237)}...`,
        changedFiles: report.changedFiles,
        plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
      },
    });
    return this.options.pullRequestPublisher.publishPullRequest(publicationInput);
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
