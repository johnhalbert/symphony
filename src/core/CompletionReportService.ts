import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import {
  isRuntimeSourcePath,
  matchesRuntimeSourcePathPattern,
  normalizeRuntimeSourcePath,
  parseIssueRuntimeSourceScope,
  type ServiceConfig,
} from "./config/Config.js";
import { normalizeProjectContextResolution, projectContextResolutionFromIssue, type ProjectContextResolution } from "./config/ProjectContexts.js";
import { resolveServiceConfigForProjectContext } from "./config/ProjectContextServiceConfig.js";
import { SymphonyError } from "./errors.js";
import type {
  CompletionReportChecklistItem,
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecyclePhase,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import { phaseForIssueState } from "./persistence/IssueLifecycleStore.js";
import { appendLaneMemoTelemetry } from "./persistence/LaneMemoTelemetry.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type {
  OperatorApprovalRecord,
  OperatorApprovalRequestInput,
  OperatorApprovalService,
} from "./approval/OperatorApprovalService.js";
import { OPERATOR_REJECTED_PUBLICATION_ERROR } from "./approval/OperatorApprovalService.js";
import type { Issue, Workspace } from "./types.js";
import {
  planCompletionReportAcceptedWritebacks,
  planCompletionReportPublicationApprovalPendingWritebacks,
  planCompletionReportPublicationApprovalTerminalWritebacks,
  planPullRequestHandoffWritebacks,
} from "./writeback/TransitionPolicy.js";
import { shouldSilentlyRetireMergeGate, supersededMergeGateLifecyclePatch } from "./merge/MergeGateLifecycle.js";
import type {
  FileWritebackOutboxStore,
  NewWritebackOperation,
  WritebackOperation,
  WritebackProcessor,
  WritebackStatus,
} from "./writeback/WritebackOutbox.js";
import { writebackIdentityKey } from "./writeback/WritebackOutbox.js";

export const PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON = "publication approval setup incomplete";
export const PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON = "awaiting operator approval for PR publication";
export const PUBLICATION_APPROVAL_BLOCKED_REASON = PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON;
const SETTLED_WRITEBACK_STATUSES = new Set<WritebackStatus>(["succeeded", "skipped"]);
const TRUSTED_WORKSPACE_DIFF_TIMEOUT_MS = 30_000;

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
type ExistingRunRecord = Awaited<ReturnType<RunTranscriptStore["getRun"]>>;

export interface CompletionReportActiveContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
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
  runStore?: Pick<RunTranscriptStore, "appendEvent" | "getRun" | "recordPullRequestEvent" | "updateRun">;
  pullRequestPublisher?: CompletionReportPullRequestPublisher;
  operatorApproval?: Pick<OperatorApprovalService, "requestPublicationApproval" | "waitForPublicationApprovalRequest"> &
    Partial<Pick<OperatorApprovalService, "get" | "getByDedupe">>;
}

export interface CompletionReportPullRequestPublisher {
  publishPullRequest(input: CompletionReportPullRequestPublicationInput): Promise<CompletionReportPullRequestPublication>;
  getRequiredCheckResults?(input: {
    headSha: string;
    requiredChecks: string[];
  }): Promise<CompletionReportPullRequestCheckResult[]>;
}

export interface CompletionReportPullRequestCheckResult {
  name: string;
  status: "success" | "failure" | "pending" | "missing" | "unknown";
  conclusion: string | null;
  url: string | null;
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
  draft?: boolean | null;
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

export interface PendingPublicationApprovalRecoveryInput {
  issue: Issue;
  lifecycle?: IssueLifecycleRecord | null;
}

export type PendingPublicationApprovalRecoveryResult =
  | {
      recovered: true;
      approvalRequest: OperatorApprovalRecord;
      report: IssueCompletionReportRecord;
      outcome: "pending";
    }
  | {
      recovered: true;
      report: IssueCompletionReportRecord;
      outcome: "approved" | "terminal";
    }
  | {
      recovered: false;
      reason:
        | "not_applicable"
        | "no_pending_report"
        | "missing_run"
        | "approval_already_pending"
        | "audit_not_settled"
        | "approval_not_pending";
      report?: IssueCompletionReportRecord;
    };

export class CompletionReportService {
  constructor(private readonly options: CompletionReportServiceOptions) {}

  async submit_completion_report(input: unknown, context: CompletionReportActiveContext): Promise<CompletionReportResult> {
    return this.submitCompletionReport(input, context);
  }

  async submitCompletionReport(input: unknown, context: CompletionReportActiveContext): Promise<CompletionReportResult> {
    const report = parseCompletionReport(input);
    this.validateCaller(report, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    validateCompletionReportProjectContext(context, existingLifecycle);
    const existing = existingLifecycle?.completionReports.find((item) => item.idempotencyKey === report.idempotencyKey);
    if (existing && isFinalizedCompletionReport(existing)) {
      return { accepted: true, replayed: true, report: existing, writebackOperations: [] };
    }
    const pendingPublicationHandoff =
      existing !== undefined && this.shouldPersistBeforePublicationApproval()
        ? pendingPublicationHandoffForRun(existingLifecycle, {
            runId: existing.runId,
            idempotencyKey: existing.idempotencyKey,
          })
        : null;
    const resumingPendingPublication =
      existing !== undefined && pendingPublicationHandoff?.pendingReport.id === existing.id;
    if (!resumingPendingPublication) {
      await this.validateAuthorizedRuntimeSourceScope(report, context, existingLifecycle);
    }

    const lifecyclePhase = context.phase ?? existingLifecycle?.phase ?? phaseForIssueState(context.issue.state, this.options.config);
    const inputPullRequest = normalizeInputPullRequest(report.pullRequest, report.branchName);
    let lifecycle = existingLifecycle;
    if (!resumingPendingPublication) {
      this.validateIssueIsAcceptingReports(context, lifecyclePhase);
    }

    if (this.shouldPersistBeforePublicationApproval()) {
      const enqueuedPendingOperations: WritebackOperation[] = [];
      if (resumingPendingPublication) {
        const pendingReport = pendingPublicationHandoff.pendingReport;
        const run = await this.options.runStore?.getRun(pendingReport.runId);
        if (!run) {
          throw new SymphonyError("invalid_request", "Pending publication approval resume requires an existing run record");
        }
        const storedReport = completionReportInputFromRecord(pendingReport);
        const storedContext = recoveryContextFor({
          issue: context.issue,
          lifecycle: pendingPublicationHandoff.lifecycle,
          pendingReport,
          run,
          config: this.options.config,
        });
        const storedInputPullRequest = normalizeInputPullRequest(storedReport.pullRequest, storedReport.branchName);
        const publicationInput = this.buildPublicationInput(storedReport, storedContext, pendingPublicationHandoff.lifecycle);
        const incomingPublicationInput = this.buildPublicationInput(report, context, existingLifecycle);
        assertPendingPublicationReplayMatches({
          incomingReport: report,
          incomingPublicationInput,
          storedReport,
          storedPublicationInput: publicationInput,
        });
        const pendingOperations = planCompletionReportPublicationApprovalPendingWritebacks(
          runWritebackContext(storedContext, storedReport.runId),
          this.options.config,
          completionReportWritebackDetails(storedReport, storedContext.issue, storedInputPullRequest),
          {
            branchName: publicationInput.branchName,
            baseBranch: publicationInput.baseBranch,
            workspacePath: publicationInput.workspacePath,
            title: publicationInput.title,
          },
        );
        for (const operation of pendingOperations) {
          enqueuedPendingOperations.push(await this.options.writebackOutbox.enqueueOnce(operation));
        }
        await this.processAndVerifyPendingPublicationApprovalWritebacks(pendingOperations);
        const existingApproval = await this.currentPublicationApproval(pendingReport, run.pendingApprovalRequestId ?? null);
        const approvalRequest =
          existingApproval ?? (await this.requestPublicationApproval(storedReport, storedContext, publicationInput));
        if (approvalRequest.status === "pending") {
          await this.linkPendingPublicationApproval(approvalRequest);
          await this.options.lifecycleStore.updateIssue(storedContext.issue, {
            projectContext: resolveCompletionReportProjectContext(storedContext),
            phase: "blocked",
            blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
          });
        }
        return this.waitForServiceOwnedPublicationApproval({
          approvalRequest,
          pendingReport,
          pendingOperations: enqueuedPendingOperations,
          report: storedReport,
          context: storedContext,
          inputPullRequest: storedInputPullRequest,
        });
      }

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
      const pendingReport = buildCompletionReportRecord({
        report,
        issue: context.issue,
        projectContext: resolveCompletionReportProjectContext(context, existingLifecycle),
        pullRequest: inputPullRequest,
        acceptedAt: existing?.acceptedAt ?? null,
        writebackOperationKeys: [],
      });
      for (const operation of pendingOperations) {
        enqueuedPendingOperations.push(await this.options.writebackOutbox.enqueueOnce(operation));
      }
      lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
        projectContext: resolveCompletionReportProjectContext(context, existingLifecycle),
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        lastCompletionReportId: pendingReport.id,
        completionReports: upsertCompletionReport(existingLifecycle?.completionReports ?? [], pendingReport),
        summaryPointers: summaryPointersFor(context, inputPullRequest, null, existingLifecycle),
      });
      await this.processAndVerifyPendingPublicationApprovalWritebacks(pendingOperations);
      const approvalRequest = await this.requestPublicationApproval(report, context, publicationInput);
      if (approvalRequest.status === "pending") {
        await this.linkPendingPublicationApproval(approvalRequest);
        await this.options.lifecycleStore.updateIssue(context.issue, {
          projectContext: resolveCompletionReportProjectContext(context, lifecycle),
          phase: "blocked",
          blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
        });
      }
      return this.waitForServiceOwnedPublicationApproval({
        approvalRequest,
        pendingReport,
        pendingOperations: enqueuedPendingOperations,
        report,
        context,
        inputPullRequest,
      });
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
    const pendingReport = pendingPublicationHandoffForRun(lifecycle, {
      runId: input.approval.runId,
      idempotencyKey: input.approval.evidenceCursor,
    })?.pendingReport;
    if (
      !pendingReport ||
      pendingReport.runId !== input.approval.runId ||
      pendingReport.idempotencyKey !== input.approval.evidenceCursor
    ) {
      return null;
    }

    const report = completionReportInputFromRecord(existing);
    const issueTitle = lifecycle.summaryPointers.issueTitle ?? input.issue.title;
    const context: CompletionReportActiveContext = {
      issue: { ...input.issue, title: issueTitle },
      activeRunId: input.approval.runId,
      role: "worker",
      sessionId: null,
      workspacePath: input.approval.action.workspacePath,
      workspace: workspaceFromApproval(input.approval, lifecycle),
      phase: "blocked",
    };
    const publicationInput = this.buildPublicationInput(report, context, lifecycle);
    const publication = await this.options.pullRequestPublisher.publishPullRequest(publicationInput);
    const result = await this.finalizeCompletionReport({
      report,
      context,
      inputPullRequest: normalizeInputPullRequest(report.pullRequest, report.branchName),
      publication,
      lifecycle,
      existing,
    });
    await this.processDueForOperations(result.writebackOperations);
    return result;
  }

  async recordPublicationApprovalTerminal(input: PublicationApprovalResumeInput): Promise<WritebackOperation[]> {
    if (!isTerminalApprovalStatus(input.approval.status)) return [];
    const lifecycle = await this.options.lifecycleStore.get(input.approval.issueId);
    const existing = lifecycle?.completionReports.find(
      (item) => item.runId === input.approval.runId && item.idempotencyKey === input.approval.evidenceCursor,
    );
    if (!lifecycle || !existing || isFinalizedCompletionReport(existing)) return [];
    const alreadyRecorded = lifecycle.blockedReason === `publication approval ${input.approval.status}`;
    const pendingReport =
      pendingPublicationHandoffForRun(lifecycle, {
        runId: input.approval.runId,
        idempotencyKey: input.approval.evidenceCursor,
      })?.pendingReport ?? (alreadyRecorded ? pendingPublicationReport(lifecycle) : null);
    if (
      !pendingReport ||
      pendingReport.runId !== input.approval.runId ||
      pendingReport.idempotencyKey !== input.approval.evidenceCursor
    ) {
      return [];
    }

    const report = completionReportInputFromRecord(existing);
    const issueTitle = lifecycle.summaryPointers.issueTitle ?? input.issue.title;
    const context: CompletionReportActiveContext = {
      issue: { ...input.issue, title: issueTitle },
      activeRunId: input.approval.runId,
      role: "worker",
      sessionId: null,
      workspacePath: input.approval.action.workspacePath,
      workspace: workspaceFromApproval(input.approval, lifecycle),
      phase: "blocked",
    };
    return this.enqueuePublicationApprovalTerminal(input.approval, report, context, existing.pullRequest);
  }

  async recoverPendingPublicationApproval(
    input: PendingPublicationApprovalRecoveryInput,
  ): Promise<PendingPublicationApprovalRecoveryResult> {
    if (!this.shouldPersistBeforePublicationApproval()) {
      return { recovered: false, reason: "not_applicable" };
    }
    const lifecycle =
      input.lifecycle ?? (await this.options.lifecycleStore.get(input.issue.id)) ?? (await this.options.lifecycleStore.get(input.issue.identifier));
    const handoff = pendingPublicationHandoffForRun(lifecycle);
    if (!handoff) {
      return { recovered: false, reason: "not_applicable" };
    }
    const handoffLifecycle = handoff.lifecycle;
    const pendingReport = handoff.pendingReport;

    const report = completionReportInputFromRecord(pendingReport);
    const run = await this.options.runStore?.getRun(pendingReport.runId);
    if (!run) {
      return { recovered: false, reason: "missing_run", report: pendingReport };
    }
    const linkedPendingApproval =
      handoffLifecycle.blockedReason === PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON &&
      run.pendingApprovalRequestId &&
      this.options.operatorApproval?.get
        ? await this.options.operatorApproval.get(run.pendingApprovalRequestId)
        : null;
    if (
      linkedPendingApproval &&
      linkedPendingApproval.requestId === run.pendingApprovalRequestId &&
      linkedPendingApproval.status === "pending" &&
      approvalMatchesReport(linkedPendingApproval, pendingReport)
    ) {
      return { recovered: false, reason: "approval_already_pending", report: pendingReport };
    }
    const context = recoveryContextFor({
      issue: input.issue,
      lifecycle: handoffLifecycle,
      pendingReport,
      run: run ?? null,
      config: this.options.config,
    });
    const inputPullRequest = normalizeInputPullRequest(report.pullRequest, report.branchName);
    const publicationInput = this.buildPublicationInput(report, context, handoffLifecycle);
    const existingApproval = await this.currentPublicationApproval(pendingReport, run.pendingApprovalRequestId ?? null);
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

    for (const operation of pendingOperations) {
      await this.options.writebackOutbox.enqueueOnce(operation);
    }
    try {
      await this.processAndVerifyPendingPublicationApprovalWritebacks(pendingOperations);
    } catch (error) {
      if (error instanceof SymphonyError && error.code === "tracker_error") {
        return { recovered: false, reason: "audit_not_settled", report: pendingReport };
      }
      throw error;
    }

    const approvalRequest = existingApproval ?? (await this.requestPublicationApproval(report, context, publicationInput));
    if (approvalRequest.status === "pending") {
      await this.linkPendingPublicationApproval(approvalRequest);
      await this.options.lifecycleStore.updateIssue(context.issue, {
        projectContext: resolveCompletionReportProjectContext(context),
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      });
      return { recovered: true, approvalRequest, report: pendingReport, outcome: "pending" };
    }
    if (approvalRequest.status === "approved") {
      const result = await this.resumeApprovedPublication({ approval: approvalRequest, issue: input.issue });
      if (!result) {
        return { recovered: false, reason: "approval_not_pending", report: pendingReport };
      }
      return { recovered: true, report: pendingReport, outcome: "approved" };
    }
    if (isTerminalApprovalStatus(approvalRequest.status)) {
      await this.recordPublicationApprovalTerminal({ approval: approvalRequest, issue: input.issue });
      return { recovered: true, report: pendingReport, outcome: "terminal" };
    }
    return { recovered: false, reason: "approval_not_pending", report: pendingReport };
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
    const verifiedPullRequest =
      input.publication && pullRequest
        ? {
            ...pullRequest,
            draft: input.publication.draft ?? null,
          }
        : null;
    const projectContext = resolveCompletionReportProjectContext(input.context, input.lifecycle);
    const resolvedConfig = resolveServiceConfigForProjectContext(this.options.config, projectContext);
    const handoffChecks = await this.evaluatePullRequestHandoffChecks(verifiedPullRequest, resolvedConfig);
    if (resolvedConfig.github.prHandoff.enabled && (!verifiedPullRequest || !handoffChecks)) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report handoff requires a verified pull request that satisfies the handoff policy",
      );
    }
    const lifecycle = await this.options.lifecycleStore.ensureIssue(input.context.issue, {
      projectContext,
      summaryPointers: summaryPointersFor(input.context, pullRequest, input.publication, input.lifecycle),
    });
    const writebackContext = runWritebackContext({ ...input.context, projectContext }, input.report.runId);
    const writebackReport = completionReportWritebackDetails(input.report, input.context.issue, pullRequest);
    const operations = resolvedConfig.github.prHandoff.enabled
      ? verifiedPullRequest && handoffChecks
        ? planPullRequestHandoffWritebacks(writebackContext, this.options.config, {
            pullRequest: verifiedPullRequest,
            report: writebackReport,
            ci: handoffChecks,
          })
        : []
      : planCompletionReportAcceptedWritebacks(writebackContext, this.options.config, writebackReport);
    if (operations.length === 0) {
      throw new SymphonyError(
        "invalid_request",
        resolvedConfig.github.prHandoff.enabled
          ? "Completion report handoff requires a verified pull request that satisfies the handoff policy"
          : "Completion report cannot be accepted for the current issue state",
      );
    }

    const storedReport = buildCompletionReportRecord({
      report: input.report,
      issue: input.context.issue,
      projectContext: resolveCompletionReportProjectContext(input.context, lifecycle),
      pullRequest,
      writebackOperationKeys: operations.map((operation) => writebackIdentityKey(operation.idempotencyKey, operation.projectContext)),
      acceptedAt: input.existing?.acceptedAt ?? null,
    });
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }
    await this.recordPullRequestMetadata(input.context, input.publication);

    let currentLifecycle = await this.options.lifecycleStore.updateIssue(input.context.issue, {
      projectContext: resolveCompletionReportProjectContext(input.context, lifecycle),
      phase: "review",
      blockedReason: null,
      incompleteTurnCount: 0,
      lastCompletionReportId: storedReport.id,
      completionReports: upsertCompletionReport(lifecycle.completionReports, storedReport),
      summaryPointers: summaryPointersFor(input.context, pullRequest, input.publication, lifecycle),
    });
    const reportHeadSha = storedReport.pullRequest?.headSha ?? null;
    const reportNumber = storedReport.pullRequest?.number ?? null;
    if (reportHeadSha !== null && reportNumber !== null && shouldSilentlyRetireMergeGate(currentLifecycle.mergeGate, reportHeadSha, reportNumber)) {
      currentLifecycle = await this.options.lifecycleStore.updateIssue(input.context.issue, {
        projectContext: resolveCompletionReportProjectContext(input.context, currentLifecycle),
        ...supersededMergeGateLifecyclePatch(currentLifecycle, currentLifecycle.mergeGate, reportHeadSha),
      });
    }
    if (
      currentLifecycle.mergeGate?.status === "repair_dispatched" &&
      (currentLifecycle.mergeGate.repairReportId === null || currentLifecycle.mergeGate.repairReportId !== storedReport.id) &&
      reportHeadSha === currentLifecycle.mergeGate.headSha &&
      reportNumber === currentLifecycle.mergeGate.pullRequest.number
    ) {
      currentLifecycle = await this.options.lifecycleStore.updateIssue(input.context.issue, {
        projectContext: resolveCompletionReportProjectContext(input.context, currentLifecycle),
        mergeGate: {
          ...currentLifecycle.mergeGate,
          repairRunId: storedReport.runId,
          repairReportId: storedReport.id,
          updatedAt: new Date().toISOString(),
        },
      });
    }
    await appendLaneMemoTelemetry(this.options.runStore, input.context.activeRunId, currentLifecycle, "completion_report");

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
    const allowedStates = [this.options.config.writeback.dispatchState];
    if (!sameStateIn(context.issue.state, allowedStates)) {
      throw new SymphonyError("invalid_request", "Completion report requires the issue to be in the active implementation state");
    }
  }

  private async validateAuthorizedRuntimeSourceScope(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    existingLifecycle: ExistingIssueLifecycle,
  ): Promise<void> {
    const scope = parseIssueRuntimeSourceScope(context.issue.description);
    if (!scope.hasTouchedSurfacesSection) return;

    const changedFileRoots = changedFileNormalizationRoots(context, existingLifecycle);
    const reportedRuntimeChangedFiles = normalizeRuntimeChangedFiles(report.changedFiles, changedFileRoots);
    const trustedChangedFiles = await trustedChangedFilesFromWorkspace(resolveRuntimeScopeWorkspacePath(context, existingLifecycle));
    const trustedRuntimeChangedFiles = normalizeRuntimeChangedFiles(trustedChangedFiles, changedFileRoots);
    const trustedRuntimeChangedFileKeys = new Set(trustedRuntimeChangedFiles.map(runtimeSourcePathComparisonKey));
    const reportedRuntimeChangedFileKeys = new Set(reportedRuntimeChangedFiles.map(runtimeSourcePathComparisonKey));
    const omittedRuntimeChangedFiles = trustedRuntimeChangedFiles.filter(
      (changedFile) => !reportedRuntimeChangedFileKeys.has(runtimeSourcePathComparisonKey(changedFile)),
    );
    const unexpectedReportedRuntimeChangedFiles = reportedRuntimeChangedFiles.filter(
      (changedFile) => !trustedRuntimeChangedFileKeys.has(runtimeSourcePathComparisonKey(changedFile)),
    );
    if (omittedRuntimeChangedFiles.length > 0 || unexpectedReportedRuntimeChangedFiles.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report runtime source changedFiles do not match the trusted workspace diff",
        {
          changedFiles: report.changedFiles,
          trustedChangedFiles,
          trustedRuntimeChangedFiles,
          omittedRuntimeChangedFiles,
          unexpectedReportedRuntimeChangedFiles,
        },
      );
    }
    if (trustedRuntimeChangedFiles.length === 0) return;

    const unauthorizedRuntimeChangedFiles = trustedRuntimeChangedFiles.filter(
      (changedFile) => !scope.authorizedPaths.some((authorizedPath) => matchesRuntimeSourcePathPattern(authorizedPath, changedFile)),
    );
    if (unauthorizedRuntimeChangedFiles.length === 0) return;

    const details = {
      authorizedRuntimeSourcePaths: scope.authorizedPaths,
      unauthorizedRuntimeChangedFiles,
      changedFiles: report.changedFiles,
      trustedChangedFiles,
      trustedRuntimeChangedFiles,
    };
    if (scope.authorizedPaths.length === 0) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report includes runtime source changes but the issue does not authorize runtime implementation in Touched Surfaces",
        details,
      );
    }
    throw new SymphonyError(
      "invalid_request",
      "Completion report includes runtime source changes outside the issue's authorized Touched Surfaces scope",
      details,
    );
  }

  private async publishPullRequestIfNeeded(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    existingLifecycle: ExistingIssueLifecycle,
  ): Promise<CompletionReportPullRequestPublication | null> {
    if (!this.options.config.github.publishPullRequests) return null;
    if (this.shouldPersistBeforePublicationApproval()) return null;
    if (!this.options.pullRequestPublisher) {
      throw new SymphonyError("invalid_request", "PR publication is enabled but no GitHub publisher is configured");
    }
    const publicationInput = this.buildPublicationInput(report, context, existingLifecycle);
    return this.options.pullRequestPublisher.publishPullRequest(publicationInput);
  }

  private async evaluatePullRequestHandoffChecks(
    pullRequest: CompletionReportPullRequestRef | null,
    config: ServiceConfig,
  ): Promise<{ requiredChecks: string[]; passedChecks: string[]; noCiEvidence: string | null } | null> {
    if (!config.github.prHandoff.enabled) return null;
    if (pullRequest?.draft === true && !config.github.prHandoff.allowDrafts) return null;
    const requiredChecks = config.github.prHandoff.requiredChecks;
    if (requiredChecks.length === 0) {
      const noCiEvidence = config.github.prHandoff.noCiAllowed
        ? config.github.prHandoff.noCiEvidence
        : null;
      return noCiEvidence === null
        ? null
        : {
            requiredChecks: [],
            passedChecks: [],
            noCiEvidence,
          };
    }
    if (pullRequest?.headSha === null || pullRequest?.headSha === undefined) return null;
    if (!this.options.pullRequestPublisher?.getRequiredCheckResults) return null;

    const results = await this.options.pullRequestPublisher.getRequiredCheckResults({
      headSha: pullRequest.headSha,
      requiredChecks,
    });
    const passedChecks = results.filter((check) => check.status === "success").map((check) => check.name);
    const passed = new Set(passedChecks.map((check) => check.toLowerCase()));
    const missing = requiredChecks.filter((check) => !passed.has(check.toLowerCase()));
    return missing.length === 0 ? { requiredChecks, passedChecks, noCiEvidence: null } : null;
  }

  private async requestPublicationApproval(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    publicationInput: CompletionReportPullRequestPublicationInput,
  ): Promise<OperatorApprovalRecord> {
    if (!this.options.operatorApproval) {
      throw new SymphonyError("invalid_request", "Publication approval is required but no operator approval service is configured");
    }
    return this.options.operatorApproval.requestPublicationApproval({
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
  }

  private async currentPublicationApproval(
    report: IssueCompletionReportRecord,
    pendingApprovalRequestId: string | null,
  ): Promise<OperatorApprovalRecord | null> {
    const byPointer =
      pendingApprovalRequestId && this.options.operatorApproval?.get
        ? await this.options.operatorApproval.get(pendingApprovalRequestId)
        : null;
    if (approvalMatchesReport(byPointer, report)) return byPointer;
    const byDedupe = await this.options.operatorApproval?.getByDedupe?.(report.runId, report.idempotencyKey);
    return approvalMatchesReport(byDedupe ?? null, report) ? (byDedupe ?? null) : null;
  }

  private async linkPendingPublicationApproval(approval: OperatorApprovalRecord): Promise<void> {
    if (approval.status !== "pending") return;
    if (!this.options.runStore?.updateRun) {
      throw new SymphonyError("invalid_request", "Publication approval requires a run store to link pending approval metadata");
    }
    const run = await this.options.runStore.getRun(approval.runId);
    if (!run) {
      throw new SymphonyError("invalid_request", "Publication approval requires an existing run record");
    }
    if (run.pendingApprovalRequestId === approval.requestId && run.pendingApprovalRequestedAt === approval.requestedAt) return;
    await this.options.runStore.updateRun(approval.runId, {
      metadata: {
        pendingApprovalRequestId: approval.requestId,
        pendingApprovalRequestedAt: approval.requestedAt,
      },
    });
  }

  private async waitForServiceOwnedPublicationApproval(input: {
    approvalRequest: OperatorApprovalRecord;
    pendingReport: IssueCompletionReportRecord;
    pendingOperations: WritebackOperation[];
    report: CompletionReportInput;
    context: CompletionReportActiveContext;
    inputPullRequest: CompletionReportPullRequestRef | null;
  }): Promise<CompletionReportResult> {
    try {
      const approval = await this.options.operatorApproval!.waitForPublicationApprovalRequest(input.approvalRequest);
      if (approval.status === "approved") {
        const lifecycle = await this.options.lifecycleStore.get(input.context.issue.id);
        const finalized = lifecycle?.completionReports.find(
          (item) => item.runId === input.report.runId && item.idempotencyKey === input.report.idempotencyKey,
        );
        if (finalized && isFinalizedCompletionReport(finalized)) {
          return { accepted: true, replayed: true, report: finalized, writebackOperations: [] };
        }
      }
      return {
        accepted: true,
        replayed: false,
        report: input.pendingReport,
        writebackOperations: input.pendingOperations,
      };
    } catch (error) {
      await this.recordPublicationApprovalTerminalIfNeeded(error, input.report, input.context, input.inputPullRequest);
      throw error;
    }
  }

  private buildPublicationInput(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    existingLifecycle: ExistingIssueLifecycle,
  ): CompletionReportPullRequestPublicationInput {
    const workspacePath = context.workspacePath ?? context.workspace?.path ?? existingLifecycle?.summaryPointers.workspacePath ?? null;
    if (!workspacePath) {
      throw new SymphonyError("invalid_request", "PR publication requires a worktree workspace path");
    }
    const branchName =
      resolveServiceOwnedCompletionReportBranchName({
        workspaceGitBranchName: context.workspace?.gitBranchName ?? null,
        lifecycleGitBranchName: existingLifecycle?.summaryPointers.gitBranchName ?? null,
        lifecycleBranchName: existingLifecycle?.summaryPointers.branchName ?? null,
        issueBranchName: context.issue.branchName,
      }) || report.branchName || null;
    if (!branchName) {
      throw new SymphonyError("invalid_request", "PR publication requires a worktree branch");
    }
    const baseBranch = context.workspace?.baseRef ?? existingLifecycle?.summaryPointers.baseRef ?? this.options.config.workspace.source.baseRef;
    if (!baseBranch) {
      throw new SymphonyError("invalid_request", "PR publication requires a base branch");
    }
    const issueTitle = existingLifecycle?.summaryPointers.issueTitle ?? context.issue.title;
    return {
      workspacePath,
      branchName,
      baseBranch,
      title: `${context.issue.identifier}: ${issueTitle}`,
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
    const projectContext = sharedWritebackProjectContext(operations);
    await processor.processDue({
      idempotencyKeys: operations.map((operation) => operation.idempotencyKey),
      ...(projectContext === undefined ? {} : { projectContext }),
    });
    for (const operation of operations) {
      const record = await this.options.writebackOutbox.get(operation.idempotencyKey, operation.projectContext);
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
  ): Promise<WritebackOperation[]> {
    if (!isTerminalApprovalStatus(approval.status)) return [];
    await this.recordPublicationApprovalTerminalRun(approval);
    const terminalReason = `publication approval ${approval.status}`;
    const latestLifecycle =
      (await this.options.lifecycleStore.get(context.issue.id)) ??
      (context.issue.identifier ? await this.options.lifecycleStore.get(context.issue.identifier) : null);
    if (latestLifecycle?.phase === "blocked" && latestLifecycle.blockedReason === terminalReason) {
      return [];
    }
    const projectContext = resolveCompletionReportProjectContext(context, latestLifecycle);
    const resolvedConfig = resolveServiceConfigForProjectContext(this.options.config, projectContext);
    const issue = {
      ...context.issue,
      state: resolvedConfig.reviewLoop.blockedStates[0] ?? context.issue.state,
    };
    const enqueued: WritebackOperation[] = [];

    for (const operation of planCompletionReportPublicationApprovalTerminalWritebacks(
      runWritebackContext({ ...context, issue, projectContext }, report.runId),
      this.options.config,
      completionReportWritebackDetails(report, issue, pullRequest),
      approval.status,
      approval.staleReason,
    )) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }
    await this.options.lifecycleStore.updateIssue(context.issue, {
      projectContext,
      phase: "blocked",
      blockedReason: `publication approval ${approval.status}`,
    });
    await this.processDueForOperations(enqueued);
    return enqueued;
  }

  private async processDueForOperations(
    operations: ReadonlyArray<Pick<WritebackOperation, "idempotencyKey" | "projectContext">>,
  ): Promise<void> {
    if (operations.length === 0) return;
    const projectContext = sharedWritebackProjectContext(operations);
    await this.options.writebackProcessor?.processDue({
      idempotencyKeys: operations.map((operation) => operation.idempotencyKey),
      ...(projectContext === undefined ? {} : { projectContext }),
    });
  }

  private async recordPublicationApprovalTerminalRun(approval: OperatorApprovalRecord): Promise<void> {
    const runStore = this.options.runStore;
    if (!runStore) return;
    const existing = await runStore.getRun(approval.runId);
    const completedAt = existing?.completedAt ?? new Date().toISOString();
    const rejectPolicy = this.options.config.github.operatorApproval?.rejectPolicy ?? "cancel";
    const cancelledByPolicy = approval.status === "rejected" && rejectPolicy === "cancel";
    const failedByPolicy = approval.status === "rejected" && rejectPolicy === "fail";
    await runStore.updateRun(approval.runId, {
      status: cancelledByPolicy ? "cancelled" : "failed",
      completedAt,
      error: cancelledByPolicy
        ? "Operator cancelled issue"
        : failedByPolicy
          ? OPERATOR_REJECTED_PUBLICATION_ERROR
          : `Publication approval ${approval.status}`,
      metadata: {
        pendingApprovalRequestId: null,
        pendingApprovalRequestedAt: null,
      },
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

export function isPendingPublicationApprovalReason(reason: string | null | undefined): boolean {
  return reason === PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON || reason === PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON;
}

export function isPendingPublicationApprovalLifecycle(
  lifecycle: IssueLifecycleRecord | null | undefined,
): lifecycle is IssueLifecycleRecord {
  return lifecycle?.phase === "blocked" && isPendingPublicationApprovalReason(lifecycle.blockedReason);
}

export function isAwaitingPublicationApprovalLifecycle(
  lifecycle: IssueLifecycleRecord | null | undefined,
): lifecycle is IssueLifecycleRecord {
  return lifecycle?.phase === "blocked" && lifecycle.blockedReason === PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON;
}

export function pendingPublicationReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  const lastPending =
    lifecycle.lastCompletionReportId === null
      ? undefined
      : lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId && !isFinalizedCompletionReport(report));
  return lastPending ?? [...lifecycle.completionReports].reverse().find((report) => !isFinalizedCompletionReport(report)) ?? null;
}

export function pendingPublicationHandoffForRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  match: { runId?: string; idempotencyKey?: string } = {},
): { lifecycle: IssueLifecycleRecord; pendingReport: IssueCompletionReportRecord } | null {
  if (!lifecycle || !isPendingPublicationApprovalReason(lifecycle.blockedReason)) return null;
  const pendingReport = pendingPublicationReport(lifecycle);
  if (!pendingReport) return null;
  if (match.runId !== undefined && pendingReport.runId !== match.runId) return null;
  if (match.idempotencyKey !== undefined && pendingReport.idempotencyKey !== match.idempotencyKey) return null;
  return { lifecycle, pendingReport };
}

export function approvalMatchesReport(
  approval: OperatorApprovalRecord | null,
  report: IssueCompletionReportRecord | null | undefined,
): approval is OperatorApprovalRecord {
  return Boolean(
    approval &&
      report &&
      approval.runId === report.runId &&
      approval.evidenceCursor === report.idempotencyKey &&
      approval.issueId === report.issueId,
  );
}

function isTerminalApprovalStatus(
  status: OperatorApprovalRecord["status"],
): status is "rejected" | "stale" | "expired" | "cancelled" {
  return status === "rejected" || status === "stale" || status === "expired" || status === "cancelled";
}

function buildCompletionReportRecord(input: {
  report: CompletionReportInput;
  issue: Issue;
  projectContext: ProjectContextResolution;
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
    projectContext: input.projectContext,
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

function resolveCompletionReportProjectContext(
  context: CompletionReportActiveContext,
  existingLifecycle: ExistingIssueLifecycle = null,
): ProjectContextResolution {
  return normalizeProjectContextResolution(
    existingLifecycle?.projectContext ?? context.projectContext ?? projectContextResolutionFromIssue(context.issue),
  );
}

function projectContextEquals(
  left: ProjectContextResolution | undefined,
  right: ProjectContextResolution | undefined,
): boolean {
  const normalizedLeft = normalizeProjectContextResolution(left);
  const normalizedRight = normalizeProjectContextResolution(right);
  return (
    normalizedLeft.projectContextId === normalizedRight.projectContextId &&
    normalizedLeft.projectContextLabel === normalizedRight.projectContextLabel &&
    normalizedLeft.linearProjectSlug === normalizedRight.linearProjectSlug &&
    normalizedLeft.routingSource === normalizedRight.routingSource
  );
}

function sharedWritebackProjectContext(
  operations: ReadonlyArray<Pick<NewWritebackOperation, "projectContext"> | Pick<WritebackOperation, "projectContext">>,
): ProjectContextResolution | undefined {
  if (operations.length === 0) return undefined;
  const first = normalizeProjectContextResolution(operations[0]?.projectContext);
  return operations.every(
    (operation) => normalizeProjectContextResolution(operation.projectContext).projectContextId === first.projectContextId,
  )
    ? first
    : undefined;
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
  const branchName = resolveServiceOwnedCompletionReportBranchName({
    workspaceGitBranchName: context.workspace?.gitBranchName ?? null,
    lifecycleGitBranchName: existingLifecycle?.summaryPointers.gitBranchName ?? null,
    lifecycleBranchName: existingLifecycle?.summaryPointers.branchName ?? null,
    issueBranchName: context.issue.branchName,
  });
  return {
    workspacePath: context.workspacePath ?? context.workspace?.path ?? existingLifecycle?.summaryPointers.workspacePath ?? null,
    branchName,
    issueTitle: context.issue.title,
    gitBranchName: branchName,
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

function resolveServiceOwnedCompletionReportBranchName(input: {
  workspaceGitBranchName?: string | null;
  lifecycleGitBranchName?: string | null;
  lifecycleBranchName?: string | null;
  runGitBranchName?: string | null;
  issueBranchName?: string | null;
}): string | null {
  return (
    input.workspaceGitBranchName ??
    input.lifecycleGitBranchName ??
    input.lifecycleBranchName ??
    input.runGitBranchName ??
    input.issueBranchName ??
    null
  );
}

function normalizeChecklist(items: CompletionReportInput["acceptanceChecklist"]): CompletionReportChecklistItem[] {
  return items.map((item) => ({
    text: item.text,
    satisfied: item.satisfied,
    evidence: item.evidence,
  }));
}


function validateCompletionReportProjectContext(
  context: CompletionReportActiveContext,
  existingLifecycle: ExistingIssueLifecycle,
): void {
  if (!context.projectContext || !existingLifecycle?.projectContext) return;
  if (projectContextEquals(context.projectContext, existingLifecycle.projectContext)) return;
  throw new SymphonyError(
    "invalid_request",
    "Completion report issue project context does not match the lifecycle record",
  );
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

function recoveryContextFor(input: {
  issue: Issue;
  lifecycle: IssueLifecycleRecord;
  pendingReport: IssueCompletionReportRecord;
  run: ExistingRunRecord;
  config: ServiceConfig;
}): CompletionReportActiveContext {
  const branchName = resolveServiceOwnedCompletionReportBranchName({
    lifecycleGitBranchName: input.lifecycle.summaryPointers.gitBranchName,
    lifecycleBranchName: input.lifecycle.summaryPointers.branchName,
    runGitBranchName: input.run?.gitBranchName ?? null,
    issueBranchName: input.issue.branchName,
  });
  const workspacePath = input.lifecycle.summaryPointers.workspacePath ?? input.run?.workspacePath ?? null;
  const baseRef = input.lifecycle.summaryPointers.baseRef ?? input.run?.baseRef ?? input.config.workspace.source.baseRef;
  const repoPath = input.lifecycle.summaryPointers.repoPath ?? input.run?.repoPath ?? null;
  const workspace =
    workspacePath === null
      ? null
      : {
          path: workspacePath,
          workspaceKey: input.lifecycle.summaryPointers.workspaceKey ?? input.run?.workspaceKey ?? input.pendingReport.issueIdentifier,
          createdNow: false,
          issueId: input.pendingReport.issueId,
          issueIdentifier: input.pendingReport.issueIdentifier,
          ...(branchName === null ? {} : { gitBranchName: branchName }),
          ...(baseRef === null ? {} : { baseRef }),
          ...(repoPath === null ? {} : { repoPath }),
        };
  return {
    issue: {
      ...input.issue,
      id: input.pendingReport.issueId,
      identifier: input.pendingReport.issueIdentifier,
      title: input.lifecycle.summaryPointers.issueTitle ?? input.issue.title,
      state: input.config.writeback.dispatchState,
      branchName,
    },
    projectContext: input.pendingReport.projectContext ?? input.lifecycle.projectContext ?? input.run?.projectContext ?? undefined,
    activeRunId: input.pendingReport.runId,
    role: "worker",
    workspacePath,
    workspace,
    phase: "implementation",
  };
}

function runWritebackContext(context: CompletionReportActiveContext, runId: string) {
  return {
    issue: context.issue,
    projectContext: context.projectContext ?? projectContextResolutionFromIssue(context.issue) ?? undefined,
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

function assertPendingPublicationReplayMatches(input: {
  incomingReport: CompletionReportInput;
  incomingPublicationInput: CompletionReportPullRequestPublicationInput;
  storedReport: CompletionReportInput;
  storedPublicationInput: CompletionReportPullRequestPublicationInput;
}): void {
  const mismatchedFields: string[] = [];
  if (input.incomingReport.summary !== input.storedReport.summary) mismatchedFields.push("summary");
  if (!sameStringSet(input.incomingReport.changedFiles, input.storedReport.changedFiles)) mismatchedFields.push("changedFiles");
  if (input.incomingReport.branchName !== input.storedReport.branchName) mismatchedFields.push("branchName");
  if (!sameJson(input.incomingReport.acceptanceChecklist, input.storedReport.acceptanceChecklist)) {
    mismatchedFields.push("acceptanceChecklist");
  }
  if (!sameStringSet(input.incomingReport.risks, input.storedReport.risks)) mismatchedFields.push("risks");
  if (!sameJson(input.incomingReport.pullRequest, input.storedReport.pullRequest)) mismatchedFields.push("pullRequest");
  if (input.incomingPublicationInput.workspacePath !== input.storedPublicationInput.workspacePath) {
    mismatchedFields.push("workspacePath");
  }
  if (input.incomingPublicationInput.branchName !== input.storedPublicationInput.branchName) {
    mismatchedFields.push("publicationBranchName");
  }
  if (input.incomingPublicationInput.baseBranch !== input.storedPublicationInput.baseBranch) {
    mismatchedFields.push("baseBranch");
  }
  if (input.incomingPublicationInput.title !== input.storedPublicationInput.title) mismatchedFields.push("title");
  if (input.incomingPublicationInput.body !== input.storedPublicationInput.body) mismatchedFields.push("body");
  if (mismatchedFields.length > 0) {
    throw new SymphonyError("conflict", "Completion report replay differs from persisted pending publication handoff", {
      fields: mismatchedFields,
      idempotencyKey: input.storedReport.idempotencyKey,
    });
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) => [...new Set(values)].sort();
  return sameJson(normalize(left), normalize(right));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function changedFileNormalizationRoots(
  context: CompletionReportActiveContext,
  existingLifecycle: ExistingIssueLifecycle,
): Array<string | null | undefined> {
  return [
    context.workspacePath,
    context.workspace?.path ?? null,
    existingLifecycle?.summaryPointers.workspacePath ?? null,
    context.workspace?.repoPath ?? null,
    existingLifecycle?.summaryPointers.repoPath ?? null,
  ];
}

function normalizeRuntimeChangedFiles(
  changedFiles: readonly string[],
  roots: readonly (string | null | undefined)[],
): string[] {
  const runtimeChangedFiles = new Map<string, string>();
  for (const changedFile of changedFiles) {
    const normalizedChangedFile = normalizeReportedChangedFilePath(changedFile, roots);
    if (!isRuntimeSourcePath(normalizedChangedFile)) continue;
    const comparisonKey = runtimeSourcePathComparisonKey(normalizedChangedFile);
    if (!runtimeChangedFiles.has(comparisonKey)) {
      runtimeChangedFiles.set(comparisonKey, normalizedChangedFile);
    }
  }
  return [...runtimeChangedFiles.values()];
}

function runtimeSourcePathComparisonKey(value: string): string {
  return normalizeRuntimeSourcePath(value).toLowerCase();
}

function resolveRuntimeScopeWorkspacePath(
  context: CompletionReportActiveContext,
  existingLifecycle: ExistingIssueLifecycle,
): string {
  const workspacePath = context.workspacePath ?? context.workspace?.path ?? existingLifecycle?.summaryPointers.workspacePath ?? null;
  if (workspacePath) return workspacePath;
  throw new SymphonyError(
    "invalid_request",
    "Completion report runtime source scope validation requires a workspace path to inspect the trusted workspace diff",
  );
}

async function trustedChangedFilesFromWorkspace(workspacePath: string): Promise<string[]> {
  const result = await runGitCommand(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    workspacePath,
    TRUSTED_WORKSPACE_DIFF_TIMEOUT_MS,
  );
  return parseGitStatusPorcelainChangedFiles(result.stdout);
}

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGitCommand(args: string[], cwd: string, timeoutMs: number): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new SymphonyError("invalid_request", "Unable to inspect workspace diff for completion report runtime scope validation", {
          workspacePath: cwd,
          gitArgs: args,
          timeoutMs,
          reason: "timed_out",
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new SymphonyError("invalid_request", "Unable to inspect workspace diff for completion report runtime scope validation", {
          workspacePath: cwd,
          gitArgs: args,
          reason: "spawn_error",
          error: error.message,
        }),
      );
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code === 0) {
        resolve(result);
        return;
      }
      reject(
        new SymphonyError("invalid_request", "Unable to inspect workspace diff for completion report runtime scope validation", {
          workspacePath: cwd,
          gitArgs: args,
          exitCode: result.code,
          stderr: result.stderr.trim() || null,
        }),
      );
    });
  });
}

function parseGitStatusPorcelainChangedFiles(output: string): string[] {
  const changedFiles: string[] = [];
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 3) continue;
    const status = entry.slice(0, 2);
    if (status === "!!") continue;

    const primaryPath = entry.slice(3);
    if (primaryPath.length > 0) changedFiles.push(primaryPath);
    if (!status.includes("R") && !status.includes("C")) continue;

    const secondaryPath = entries[index + 1] ?? "";
    if (secondaryPath.length > 0) changedFiles.push(secondaryPath);
    index += 1;
  }
  return [...new Set(changedFiles)];
}

function normalizeReportedChangedFilePath(changedFile: string, roots: readonly (string | null | undefined)[]): string {
  const trimmed = changedFile.trim();
  if (!isAbsolutePathLike(trimmed)) return normalizeRuntimeSourcePath(trimmed);
  for (const root of roots) {
    const relative = relativizePathIfWithinRoot(trimmed, root);
    if (relative !== null) return normalizeRuntimeSourcePath(relative);
  }
  return normalizeRuntimeSourcePath(trimmed);
}

function relativizePathIfWithinRoot(candidate: string, root: string | null | undefined): string | null {
  if (!root || !isAbsolutePathLike(candidate) || !isAbsolutePathLike(root)) return null;
  const pathApi = pathApiForPathValues(candidate, root);
  if (samePath(root, candidate, pathApi)) return "";
  if (!isPathInsideRoot(root, candidate, pathApi)) return null;
  const relative = pathApi.relative(pathApi.normalize(root), pathApi.normalize(candidate));
  if (relative.length === 0) return "";
  const normalizedRelative = relative.replace(/\\/g, "/");
  if (normalizedRelative === ".." || normalizedRelative.startsWith("../")) return null;
  return normalizedRelative;
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

type PathApi = typeof path.posix;

function pathApiForPathValues(...values: string[]): PathApi {
  return values.some((value) => usesWindowsPathSemantics(value)) ? path.win32 : path.posix;
}

function usesWindowsPathSemantics(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.includes("\\");
}

function samePath(left: string, right: string, pathApi: PathApi): boolean {
  return pathForComparison(left, pathApi) === pathForComparison(right, pathApi);
}

function isPathInsideRoot(root: string, candidate: string, pathApi: PathApi): boolean {
  const normalizedRoot = pathForComparison(root, pathApi);
  const normalizedCandidate = pathForComparison(candidate, pathApi);
  const rootWithSeparator = normalizedRoot.endsWith(pathApi.sep) ? normalizedRoot : `${normalizedRoot}${pathApi.sep}`;
  return normalizedCandidate.startsWith(rootWithSeparator);
}

function pathForComparison(value: string, pathApi: PathApi): string {
  const normalized = pathApi.normalize(value);
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}

function sameState(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => sameState(state, candidate));
}
