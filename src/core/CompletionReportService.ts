import { spawn } from "node:child_process";
import { z } from "zod";
import {
  BaseRefVerifier,
  baseRefBlockedReason,
  localRemoteBaseRefExists,
  type BaseRefGitHubClient,
  type IssueBaseRefObservation,
} from "./BaseRefVerification.js";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError, errorMessage } from "./errors.js";
import { parseIssueContract } from "./IssueContractLint.js";
import type {
  CompletionReportAcceptanceContext,
  CompletionReportChecklistItem,
  CompletionReportPullRequestRef,
  DependencyArtifactResult,
  ExpectedRedArtifactEvidence,
  IssueCompletionReportRejectionRecord,
  IssueCompletionReportRecord,
  IssueContractSnapshot,
  IssueLifecycleRecord,
  IssueLifecyclePhase,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import {
  isSupersededLifecycleRecord,
  latestCurrentCompletionReport,
  phaseForIssueState,
} from "./persistence/IssueLifecycleStore.js";
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
  planCompletionReportRejectedWritebacks,
  planCompletionReportPublicationApprovalPendingWritebacks,
  planCompletionReportPublicationApprovalTerminalWritebacks,
  planAcceptedArtifactHandoffWritebacks,
  planPullRequestHandoffWritebacks,
} from "./writeback/TransitionPolicy.js";
import { shouldSilentlyRetireMergeGate, supersededMergeGateLifecyclePatch } from "./merge/MergeGateLifecycle.js";
import type {
  NewWritebackOperation,
  WritebackOutboxStore,
  WritebackOperation,
  WritebackProcessor,
  WritebackStatus,
} from "./writeback/WritebackOutbox.js";

export const PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON = "publication approval setup incomplete";
export const PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON = "awaiting operator approval for PR publication";
export const PUBLICATION_APPROVAL_BLOCKED_REASON = PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON;
const SETTLED_WRITEBACK_STATUSES = new Set<WritebackStatus>(["succeeded", "skipped"]);

class PullRequestPublicationFailure extends Error {
  constructor(readonly publicationError: unknown) {
    super(errorMessage(publicationError));
    this.name = "PullRequestPublicationFailure";
  }
}

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
  artifactEvidence: z
    .object({
      kind: z.literal("expected_red_tests"),
      command: z.string().trim().min(1),
      testFiles: z.array(z.string().trim().min(1)).min(1),
      expectedFailure: z.string().trim().min(1),
      observedFailure: z.string().trim().min(1),
      exitCode: z.number().int().positive(),
    })
    .optional(),
  dependencyArtifactResult: z
    .object({
      artifactId: z.string().trim().min(1),
      command: z.string().trim().min(1),
      exitCode: z.literal(0),
      evidence: z.string().trim().min(1),
    })
    .optional(),
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
  activeRunId: string;
  role: CompletionReportSubmitterRole;
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath?: string | null;
  workspace?: Workspace | null;
  phase?: IssueLifecyclePhase | null;
  ignoreStateGate?: boolean;
}

export interface CompletionReportServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<WritebackOutboxStore, "enqueueOnce" | "get">;
  writebackProcessor?: Pick<WritebackProcessor, "processDue"> & Partial<Pick<WritebackProcessor, "enqueueAndProcess">>;
  runStore?: Pick<RunTranscriptStore, "appendEvent" | "getRun" | "recordPullRequestEvent" | "updateRun">;
  pullRequestPublisher?: CompletionReportPullRequestPublisher;
  baseRefVerifier?: Pick<BaseRefVerifier, "verify">;
  operatorApproval?: Pick<OperatorApprovalService, "requestPublicationApproval" | "waitForPublicationApprovalRequest"> &
    Partial<Pick<OperatorApprovalService, "get" | "getByDedupe">>;
  resolveIssuesByIds?: (issueIds: string[]) => Promise<Issue[]>;
  dependencyArtifactManifestVerifier?: (
    input: DependencyArtifactManifestVerificationInput,
  ) => Promise<void>;
}

export interface DependencyArtifactManifestVerificationInput {
  workspacePath: string;
  artifact: NonNullable<IssueLifecycleRecord["acceptedArtifact"]>;
}

export class DependencyArtifactDeferredError extends SymphonyError {
  constructor(
    readonly reason:
      | "live_lookup_unavailable"
      | "live_issue_missing"
      | "source_not_done",
    message: string,
    details?: unknown,
  ) {
    super("conflict", message, details);
    this.name = "DependencyArtifactDeferredError";
  }
}

export interface CompletionReportPullRequestPublisher {
  publishPullRequest(input: CompletionReportPullRequestPublicationInput): Promise<CompletionReportPullRequestPublication>;
  getBranchHeadSha?(input: { branchName: string }): Promise<string>;
  gitAuthHeader?(): Promise<string>;
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
  forceEmptyCommit?: boolean;
  draft?: boolean;
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

interface CompletionReportLocalGitSnapshot {
  branchName: string | null;
  baseRef: string | null;
  baseHeadSha: string | null;
  worktreeHeadSha: string | null;
  treeSha: string | null;
  worktreeDirty: boolean | null;
  worktreeStatus: "clean" | "dirty" | "unknown";
  unmergedFiles: string[] | null;
}

interface CompletionReportReadinessRejection {
  reasonCode: "unsatisfied_acceptance_checklist" | "pull_request_publication_failed";
  reason: string;
  unsatisfiedAcceptanceChecklist: Array<{ text: string; evidence: string | null }>;
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
    const contractSnapshot = contractSnapshotForIssue(context.issue);
    await validateCompletionDeliveryEvidence({
      report,
      contractSnapshot,
      lifecycle: existingLifecycle,
      lifecycleStore: this.options.lifecycleStore,
      config: this.options.config,
      targetIssueId: context.issue.id,
      workspacePath:
        context.workspacePath ??
        context.workspace?.path ??
        existingLifecycle?.summaryPointers.workspacePath ??
        null,
      ...(this.options.resolveIssuesByIds === undefined
        ? {}
        : { resolveIssuesByIds: this.options.resolveIssuesByIds }),
      ...(this.options.dependencyArtifactManifestVerifier === undefined
        ? {}
        : {
            dependencyArtifactManifestVerifier:
              this.options.dependencyArtifactManifestVerifier,
          }),
    });
    let existing = findCompletionReportForRun(existingLifecycle, report.runId, report.idempotencyKey);
    assertCompletionContractHasNotDrifted(existing, contractSnapshot);
    const inputPullRequest = normalizeInputPullRequest(report.pullRequest, report.branchName);
    const localSnapshot = await captureCompletionReportLocalGitSnapshot(report, context, existingLifecycle, this.options.config);
    if (existing && isFinalizedCompletionReport(existing)) {
      const currentAcceptanceContext = buildCompletionReportAcceptanceContext({
        report,
        context,
        pullRequest: inputPullRequest,
        publication: null,
        baseRefObservation: null,
        localSnapshot,
      });
      if (
        completionReplayMatchesAuthoritativeState(existing, currentAcceptanceContext) &&
        completionReplayMatchesDeliveryEvidence(existing, report, contractSnapshot)
      ) {
        return { accepted: true, replayed: true, report: existing, writebackOperations: [] };
      }
      existing = undefined;
    }
    const readinessRejection = completionReportReadinessRejection(report);
    if (readinessRejection) {
      await this.rejectCompletionReport({
        report,
        context,
        existingLifecycle,
        rejection: readinessRejection,
      });
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

    const lifecyclePhase = context.phase ?? existingLifecycle?.phase ?? phaseForIssueState(context.issue.state, this.options.config);
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
        pullRequest: inputPullRequest,
        acceptanceContext: buildCompletionReportAcceptanceContext({
          report,
          context,
          pullRequest: inputPullRequest,
          publication: null,
          baseRefObservation: null,
          localSnapshot,
        }),
        contractSnapshot,
        acceptedAt: existing?.acceptedAt ?? null,
        writebackOperationKeys: [],
      });
      for (const operation of pendingOperations) {
        enqueuedPendingOperations.push(await this.options.writebackOutbox.enqueueOnce(operation));
      }
      lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
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

    let publication: CompletionReportPullRequestPublication | null = null;
    let baseRefObservation: IssueBaseRefObservation | null = null;
    try {
      const publicationResult = await this.publishPullRequestIfNeeded(report, context, lifecycle);
      publication = publicationResult.publication;
      baseRefObservation = publicationResult.baseRefObservation;
    } catch (error) {
      const publicationError = error instanceof PullRequestPublicationFailure ? error.publicationError : null;
      if (publicationError === null) throw error;
      const terminalApprovalRecorded = await this.recordPublicationApprovalTerminalIfNeeded(
        publicationError,
        report,
        context,
        inputPullRequest,
      );
      if (terminalApprovalRecorded) throw publicationError;
      await this.rejectCompletionReport({
        report,
        context,
        existingLifecycle: lifecycle,
        rejection: completionReportPublicationRejection(publicationError),
      });
    }
    return this.finalizeCompletionReport({
      report,
      context,
      inputPullRequest,
      publication,
      baseRefObservation,
      localSnapshot,
      lifecycle,
      existing,
      contractSnapshot,
    });
  }

  async resumeApprovedPublication(input: PublicationApprovalResumeInput): Promise<CompletionReportResult | null> {
    if (input.approval.status !== "approved") return null;
    if (!this.options.config.github.publishPullRequests) return null;
    if (!this.options.pullRequestPublisher) {
      throw new SymphonyError("invalid_request", "PR publication is enabled but no GitHub publisher is configured");
    }

    const lifecycle = await this.options.lifecycleStore.get(input.approval.issueId);
    const existing = lifecycle === null
      ? null
      : latestCurrentCompletionReport(lifecycle);
    if (!lifecycle || !existing) return null;
    if (
      existing.runId !== input.approval.runId ||
      existing.idempotencyKey !== input.approval.evidenceCursor
    ) return null;
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
    const contractSnapshot = contractSnapshotForIssue(input.issue);
    assertCompletionContractHasNotDrifted(existing, contractSnapshot);
    await validateCompletionDeliveryEvidence({
      report,
      contractSnapshot,
      lifecycle,
      lifecycleStore: this.options.lifecycleStore,
      config: this.options.config,
      targetIssueId: input.issue.id,
      workspacePath: input.approval.action.workspacePath,
      ...(this.options.resolveIssuesByIds === undefined
        ? {}
        : { resolveIssuesByIds: this.options.resolveIssuesByIds }),
      ...(this.options.dependencyArtifactManifestVerifier === undefined
        ? {}
        : {
            dependencyArtifactManifestVerifier:
              this.options.dependencyArtifactManifestVerifier,
          }),
    });
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
    const baseRefObservation = await this.verifyBaseRefBeforePublication(input.issue, publicationInput, "recover_publication_approval");
    const localSnapshot = await captureCompletionReportLocalGitSnapshot(report, context, lifecycle, this.options.config);
    const publication = await this.options.pullRequestPublisher.publishPullRequest(publicationInput);
    const result = await this.finalizeCompletionReport({
      report,
      context,
      inputPullRequest: normalizeInputPullRequest(report.pullRequest, report.branchName),
      publication,
      baseRefObservation,
      localSnapshot,
      lifecycle,
      existing,
      contractSnapshot,
    });
    await this.processDueForOperations(result.writebackOperations);
    return result;
  }

  async recordPublicationApprovalTerminal(input: PublicationApprovalResumeInput): Promise<WritebackOperation[]> {
    if (!isTerminalApprovalStatus(input.approval.status)) return [];
    const lifecycle = await this.options.lifecycleStore.get(input.approval.issueId);
    const existing = lifecycle === null
      ? null
      : latestCurrentCompletionReport(lifecycle);
    if (!lifecycle || !existing || isFinalizedCompletionReport(existing)) return [];
    if (
      existing.runId !== input.approval.runId ||
      existing.idempotencyKey !== input.approval.evidenceCursor
    ) return [];
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
    const context: CompletionReportActiveContext = {
      issue: input.issue,
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
    baseRefObservation: IssueBaseRefObservation | null;
    localSnapshot: CompletionReportLocalGitSnapshot;
    lifecycle: ExistingIssueLifecycle;
    existing: IssueCompletionReportRecord | undefined;
    contractSnapshot: IssueContractSnapshot | null;
  }): Promise<CompletionReportResult> {
    const acceptedLocalSnapshot = input.publication
      ? await captureCompletionReportLocalGitSnapshot(
          input.report,
          input.context,
          input.lifecycle,
          this.options.config,
        )
      : input.localSnapshot;
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
    const acceptedArtifact = isAcceptedArtifactContract(input.contractSnapshot);
    const handoffChecks = acceptedArtifact
      ? null
      : await this.evaluatePullRequestHandoffChecks(verifiedPullRequest);
    if (acceptedArtifact && (!verifiedPullRequest || verifiedPullRequest.draft !== true)) {
      throw new SymphonyError(
        "invalid_request",
        "Accepted expected-red artifacts require a verified draft pull request handoff",
      );
    }
    if (!acceptedArtifact && this.options.config.github.prHandoff.enabled && (!verifiedPullRequest || !handoffChecks)) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report handoff requires a verified pull request that satisfies the handoff policy",
      );
    }
    const lifecycle = await this.options.lifecycleStore.ensureIssue(input.context.issue, {
      summaryPointers: summaryPointersFor(input.context, pullRequest, input.publication, input.lifecycle),
    });
    const writebackContext = runWritebackContext(input.context, input.report.runId);
    const writebackReport = completionReportWritebackDetails(input.report, input.context.issue, pullRequest);
    const operations = acceptedArtifact
      ? verifiedPullRequest && input.report.artifactEvidence
        ? planAcceptedArtifactHandoffWritebacks(writebackContext, this.options.config, {
            pullRequest: verifiedPullRequest,
            report: writebackReport,
            artifactEvidence: input.report.artifactEvidence,
          })
        : []
      : this.options.config.github.prHandoff.enabled
        ? verifiedPullRequest && handoffChecks
        ? planPullRequestHandoffWritebacks(writebackContext, this.options.config, {
            pullRequest: verifiedPullRequest,
            report: writebackReport,
            ci: handoffChecks,
          })
        : []
        : planCompletionReportAcceptedWritebacks(writebackContext, this.options.config, writebackReport);
    if (operations.length === 0) {
      if (input.context.ignoreStateGate !== true || this.options.config.github.prHandoff.enabled) {
        throw new SymphonyError(
          "invalid_request",
          acceptedArtifact
            ? "Accepted expected-red artifact handoff requires a verified draft pull request"
            : this.options.config.github.prHandoff.enabled
            ? "Completion report handoff requires a verified pull request that satisfies the handoff policy"
            : "Completion report cannot be accepted for the current issue state",
        );
      }
    }

    const storedReport = buildCompletionReportRecord({
      report: input.report,
      issue: input.context.issue,
      pullRequest,
      acceptanceContext: buildCompletionReportAcceptanceContext({
        report: input.report,
        context: input.context,
        pullRequest,
        publication: input.publication,
        baseRefObservation: input.baseRefObservation,
        localSnapshot: acceptedLocalSnapshot,
      }),
      contractSnapshot: input.contractSnapshot,
      writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      acceptedAt: input.existing?.acceptedAt ?? null,
    });
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }
    await this.recordPullRequestMetadata(input.context, input.publication);

    let currentLifecycle = await this.options.lifecycleStore.updateIssue(input.context.issue, {
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

  private async rejectCompletionReport(input: {
    report: CompletionReportInput;
    context: CompletionReportActiveContext;
    existingLifecycle: ExistingIssueLifecycle;
    rejection: CompletionReportReadinessRejection;
  }): Promise<never> {
    const inputPullRequest = normalizeInputPullRequest(input.report.pullRequest, input.report.branchName);
    const writebackDetails = completionReportWritebackDetails(input.report, input.context.issue, inputPullRequest);
    const operations = planCompletionReportRejectedWritebacks(runWritebackContext(input.context, input.report.runId), this.options.config, {
      reason: input.rejection.reason,
      report: writebackDetails,
    });
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }
    const rejectedReport = buildCompletionReportRejectionRecord({
      report: input.report,
      issue: input.context.issue,
      pullRequest: inputPullRequest,
      contractSnapshot: contractSnapshotForIssue(input.context.issue),
      rejection: input.rejection,
      writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
    });
    const lifecycle = await this.options.lifecycleStore.ensureIssue(input.context.issue, {
      lastCompletionReportRejectionId: rejectedReport.id,
      completionReportRejections: upsertCompletionReportRejection(
        input.existingLifecycle?.completionReportRejections ?? [],
        rejectedReport,
      ),
      summaryPointers: rejectionSummaryPointersFor(input.context, inputPullRequest, input.existingLifecycle),
    });
    await appendLaneMemoTelemetry(this.options.runStore, input.context.activeRunId, lifecycle, "completion_report_rejection");
    throw new SymphonyError("invalid_request", input.rejection.reason, {
      reasonCode: input.rejection.reasonCode,
      rejectionId: rejectedReport.id,
      reportId: rejectedReport.reportId,
      unsatisfiedAcceptanceChecklist: input.rejection.unsatisfiedAcceptanceChecklist,
      writebackOperationKeys: enqueued.map((operation) => operation.idempotencyKey),
    });
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
    if (context.ignoreStateGate !== true && !sameStateIn(context.issue.state, allowedStates)) {
      throw new SymphonyError("invalid_request", "Completion report requires the issue to be in the active implementation state");
    }
  }

  private async publishPullRequestIfNeeded(
    report: CompletionReportInput,
    context: CompletionReportActiveContext,
    existingLifecycle: ExistingIssueLifecycle,
  ): Promise<{ publication: CompletionReportPullRequestPublication | null; baseRefObservation: IssueBaseRefObservation | null }> {
    if (!this.options.config.github.publishPullRequests) return { publication: null, baseRefObservation: null };
    if (this.shouldPersistBeforePublicationApproval()) return { publication: null, baseRefObservation: null };
    if (!this.options.pullRequestPublisher) {
      throw new SymphonyError("invalid_request", "PR publication is enabled but no GitHub publisher is configured");
    }
    const publicationInput = this.buildPublicationInput(report, context, existingLifecycle);
    const baseRefObservation = await this.verifyBaseRefBeforePublication(context.issue, publicationInput, "reconcile_completion_report_handoff");
    try {
      return {
        publication: await this.options.pullRequestPublisher.publishPullRequest(publicationInput),
        baseRefObservation,
      };
    } catch (error) {
      throw new PullRequestPublicationFailure(error);
    }
  }

  private async verifyBaseRefBeforePublication(
    issue: Issue,
    publicationInput: CompletionReportPullRequestPublicationInput,
    operation: string,
  ): Promise<IssueBaseRefObservation | null> {
    const client = baseRefClientFromPublisher(this.options.pullRequestPublisher);
    if (client === null) return null;
    if (
      this.options.baseRefVerifier === undefined &&
      !(await localRemoteBaseRefExists({
        workspacePath: publicationInput.workspacePath,
        baseRef: publicationInput.baseBranch,
      }))
    ) {
      return null;
    }
    const observation = await (this.options.baseRefVerifier ?? new BaseRefVerifier()).verify({
      workspacePath: publicationInput.workspacePath,
      branchName: publicationInput.branchName,
      baseRef: publicationInput.baseBranch,
      operation,
      client,
    });
    if (observation.classification === "ok") {
      await this.options.lifecycleStore.updateIssue(issue, {
        baseRefObservation: observation,
      });
      return observation;
    }
    const blockedReason = baseRefBlockedReason(observation);
    await this.options.lifecycleStore.updateIssue(issue, {
      phase: "blocked",
      blockedReason,
      baseRefObservation: observation,
    });
    throw new SymphonyError("invalid_request", blockedReason, {
      baseRefObservation: observation,
    });
  }

  private async evaluatePullRequestHandoffChecks(
    pullRequest: CompletionReportPullRequestRef | null,
  ): Promise<{ requiredChecks: string[]; passedChecks: string[]; noCiEvidence: string | null } | null> {
    if (!this.options.config.github.prHandoff.enabled) return null;
    if (pullRequest?.draft === true && !this.options.config.github.prHandoff.allowDrafts) return null;
    const requiredChecks = this.options.config.github.prHandoff.requiredChecks;
    if (requiredChecks.length === 0) {
      const noCiEvidence = this.options.config.github.prHandoff.noCiAllowed
        ? this.options.config.github.prHandoff.noCiEvidence
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
        const finalized = lifecycle === null
          ? null
          : latestCurrentCompletionReport(lifecycle);
        if (
          finalized === null ||
          finalized.runId !== input.report.runId ||
          finalized.idempotencyKey !== input.report.idempotencyKey
        ) {
          throw new SymphonyError(
            "conflict",
            "Approved completion report is no longer the current lifecycle evidence",
          );
        }
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
      forceEmptyCommit: shouldForceFreshHeadForNoChangeMergeGateRepair(report, existingLifecycle),
      draft: report.artifactEvidence?.kind === "expected_red_tests",
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
    if (processor.enqueueAndProcess) {
      const unsettled: Array<{ operation: NewWritebackOperation; record: WritebackOperation }> = [];
      for (const operation of operations) {
        const record = await processor.enqueueAndProcess(operation);
        if (!SETTLED_WRITEBACK_STATUSES.has(record.status)) {
          unsettled.push({ operation, record });
        }
      }
      const firstUnsettled = unsettled[0];
      if (firstUnsettled) {
        throw new SymphonyError("tracker_error", "Pending publication approval writeback did not complete", {
          idempotencyKey: firstUnsettled.operation.idempotencyKey,
          status: firstUnsettled.record.status,
          lastError: firstUnsettled.record.lastError,
        });
      }
      return;
    }
    for (const operation of operations) {
      await this.options.writebackOutbox.enqueueOnce(operation);
    }
    await processor.processDue({ idempotencyKeys: operations.map((operation) => operation.idempotencyKey) });
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
  ): Promise<boolean> {
    const approval = error instanceof SymphonyError ? approvalRecordFromDetails(error.details) : null;
    if (!approval || !["rejected", "stale", "expired", "cancelled"].includes(approval.status)) return false;
    await this.enqueuePublicationApprovalTerminal(approval, report, context, pullRequest);
    return true;
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
    await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: "blocked",
      blockedReason: terminalReason,
    });
    const issue = {
      ...context.issue,
      state: this.options.config.reviewLoop.blockedStates[0] ?? context.issue.state,
    };
    const enqueued: WritebackOperation[] = [];
    const processedOnEnqueue = this.options.writebackProcessor?.enqueueAndProcess !== undefined;

    for (const operation of planCompletionReportPublicationApprovalTerminalWritebacks(
      runWritebackContext({ ...context, issue }, report.runId),
      this.options.config,
      completionReportWritebackDetails(report, issue, pullRequest),
      approval.status,
      approval.staleReason,
    )) {
      enqueued.push(await this.enqueueWritebackForImmediateProcessing(operation));
    }
    if (!processedOnEnqueue) await this.processDueForOperations(enqueued);
    return enqueued;
  }

  private async enqueueWritebackForImmediateProcessing(operation: NewWritebackOperation): Promise<WritebackOperation> {
    const processor = this.options.writebackProcessor;
    if (processor?.enqueueAndProcess) {
      return processor.enqueueAndProcess(operation);
    }
    return this.options.writebackOutbox.enqueueOnce(operation);
  }

  private async processDueForOperations(operations: ReadonlyArray<WritebackOperation>): Promise<void> {
    if (operations.length === 0) return;
    const processor = this.options.writebackProcessor;
    if (!processor) return;
    if (processor.enqueueAndProcess) {
      for (const operation of operations) {
        await processor.enqueueAndProcess(operation);
      }
      return;
    }
    await processor.processDue({
      idempotencyKeys: operations.map((operation) => operation.idempotencyKey),
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

function contractSnapshotForIssue(issue: Issue): IssueContractSnapshot | null {
  const parsed = parseIssueContract(issue.description);
  if (!parsed.valid) return null;
  const delivery = parsed.contract.delivery;
  return {
    schemaVersion: parsed.contract.schemaVersion,
    contractVersion: parsed.contract.contractVersion,
    fingerprint: parsed.fingerprint,
    delivery: {
      mode: delivery.mode,
      artifact: delivery.mode === "accepted_artifact" ? delivery.artifact : null,
    },
  };
}

function isAcceptedArtifactContract(
  snapshot: IssueContractSnapshot | null | undefined,
): snapshot is IssueContractSnapshot & {
  delivery: { mode: "accepted_artifact"; artifact: "expected_red_tests" };
} {
  return snapshot?.delivery.mode === "accepted_artifact" && snapshot.delivery.artifact === "expected_red_tests";
}

async function validateCompletionDeliveryEvidence(input: {
  report: CompletionReportInput;
  contractSnapshot: IssueContractSnapshot | null;
  lifecycle: ExistingIssueLifecycle;
  lifecycleStore: Pick<IssueLifecycleStore, "get">;
  config: ServiceConfig;
  targetIssueId: string;
  workspacePath: string | null;
  resolveIssuesByIds?: (issueIds: string[]) => Promise<Issue[]>;
  dependencyArtifactManifestVerifier?: (
    input: DependencyArtifactManifestVerificationInput,
  ) => Promise<void>;
}): Promise<void> {
  const acceptedArtifact = isAcceptedArtifactContract(input.contractSnapshot);
  const artifactEvidence = input.report.artifactEvidence;
  if (acceptedArtifact) {
    if (!artifactEvidence) {
      throw new SymphonyError(
        "invalid_request",
        "Accepted expected-red artifact delivery requires structured artifactEvidence",
      );
    }
    if (new Set(artifactEvidence.testFiles).size !== artifactEvidence.testFiles.length) {
      throw new SymphonyError("invalid_request", "artifactEvidence.testFiles must not contain duplicates");
    }
    const changedFiles = new Set(input.report.changedFiles);
    const missingTestFiles = artifactEvidence.testFiles.filter((file) => !changedFiles.has(file));
    if (missingTestFiles.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        "Every expected-red test file must be included in completion report changedFiles",
        { missingTestFiles },
      );
    }
  } else if (artifactEvidence !== undefined) {
    throw new SymphonyError(
      "invalid_request",
      "artifactEvidence is only valid for an explicit accepted expected-red artifact delivery contract",
    );
  }

  const seed = input.lifecycle?.workspaceSeed ?? null;
  const dependencyResult = input.report.dependencyArtifactResult;
  if (acceptedArtifact && (seed !== null || dependencyResult !== undefined)) {
    throw new SymphonyError(
      "invalid_request",
      "Accepted-artifact source issues cannot themselves consume another accepted artifact; use a merge-delivery integration issue",
    );
  }
  if (seed === null) {
    if (dependencyResult !== undefined) {
      throw new SymphonyError(
        "invalid_request",
        "dependencyArtifactResult is only valid for a workspace with a durable accepted-artifact seed",
      );
    }
    return;
  }
  if (seed.status !== "prepared") {
    throw new SymphonyError(
      "invalid_request",
      `Completion report cannot be accepted while accepted-artifact workspace seed is ${seed.status}`,
    );
  }
  if (!dependencyResult) {
    throw new SymphonyError(
      "invalid_request",
      "Seeded implementation completion requires dependencyArtifactResult proving the inherited expected-red tests pass",
    );
  }
  const sourceLifecycle = await input.lifecycleStore.get(seed.sourceIssueId);
  const artifact = sourceLifecycle?.acceptedArtifact ?? null;
  if (
    !artifact ||
    isSupersededLifecycleRecord(artifact) ||
    artifact.status !== "completed_unmerged" ||
    artifact.id !== seed.artifactId
  ) {
    throw new SymphonyError(
      "invalid_request",
      "Seeded implementation completion requires the matching completed accepted artifact checkpoint",
    );
  }
  if (!input.resolveIssuesByIds) {
    throw new DependencyArtifactDeferredError(
      "live_lookup_unavailable",
      "Seeded implementation completion requires live dependency-state verification",
    );
  }
  let liveIssues: Issue[];
  try {
    liveIssues = await input.resolveIssuesByIds([
      input.targetIssueId,
      seed.sourceIssueId,
    ]);
  } catch (error) {
    throw new DependencyArtifactDeferredError(
      "live_lookup_unavailable",
      `Seeded implementation completion could not refresh live dependency state: ${errorMessage(error)}`,
    );
  }
  const liveTarget = liveIssues.find(
    (candidate) => candidate.id === input.targetIssueId,
  );
  const liveSource = liveIssues.find(
    (candidate) => candidate.id === seed.sourceIssueId,
  );
  if (!liveTarget || !liveSource) {
    throw new DependencyArtifactDeferredError(
      "live_issue_missing",
      "Seeded implementation completion could not verify the live target and accepted-artifact source issues",
    );
  }
  if (
    !liveTarget.blockedBy.some(
      (blocker) => blocker.id === seed.sourceIssueId,
    )
  ) {
    throw new SymphonyError(
      "conflict",
      "Seeded implementation completion requires the accepted-artifact source to remain a direct dependency",
    );
  }
  if (
    liveSource.state.toLowerCase() !==
    input.config.mergePolicy.doneState.toLowerCase()
  ) {
    const retryableState = [
      ...input.config.tracker.activeStates,
      ...input.config.tracker.handoffStates,
      ...input.config.reviewLoop.reviewStates,
      ...(input.config.reviewLoop.reviewPassState === null
        ? []
        : [input.config.reviewLoop.reviewPassState]),
    ].some((state) => state.toLowerCase() === liveSource.state.toLowerCase());
    if (!retryableState) {
      throw new SymphonyError(
        "conflict",
        `Seeded implementation completion requires accepted-artifact source ${seed.sourceIssueIdentifier} to remain in ${input.config.mergePolicy.doneState}; current state is ${liveSource.state}`,
      );
    }
    throw new DependencyArtifactDeferredError(
      "source_not_done",
      `Seeded implementation completion is waiting for accepted-artifact source ${seed.sourceIssueIdentifier} to become terminal again`,
    );
  }
  const sourceContract = parseIssueContract(liveSource.description);
  if (
    !sourceContract.valid ||
    sourceContract.fingerprint !== artifact.contractFingerprint
  ) {
    throw new SymphonyError(
      "conflict",
      "Seeded implementation completion requires the live source Issue Contract to match the reviewed accepted artifact",
    );
  }
  if (dependencyResult.artifactId !== artifact.id || dependencyResult.command !== artifact.artifactEvidence.command) {
    throw new SymphonyError(
      "invalid_request",
      "dependencyArtifactResult must match the seeded artifact id and declared expected-red command",
    );
  }
  if (!input.workspacePath) {
    throw new SymphonyError(
      "invalid_request",
      "Seeded implementation completion requires a worktree to verify the inherited artifact manifest",
    );
  }
  await (
    input.dependencyArtifactManifestVerifier ??
    verifyDependencyArtifactManifest
  )({
    workspacePath: input.workspacePath,
    artifact,
  });
}

function assertCompletionContractHasNotDrifted(
  existing: IssueCompletionReportRecord | undefined,
  current: IssueContractSnapshot | null,
): void {
  if (!existing) return;
  const previous = existing.contractSnapshot ?? null;
  if (previous === null && current === null) return;
  if (previous?.fingerprint === current?.fingerprint) return;
  throw new SymphonyError(
    "conflict",
    "Issue Contract changed after this completion report was persisted; submit a fresh completion report against the current contract",
    {
      previousFingerprint: previous?.fingerprint ?? null,
      currentFingerprint: current?.fingerprint ?? null,
    },
  );
}

function completionReplayMatchesDeliveryEvidence(
  existing: IssueCompletionReportRecord,
  report: CompletionReportInput,
  contractSnapshot: IssueContractSnapshot | null,
): boolean {
  return (
    sameJson(existing.contractSnapshot ?? null, contractSnapshot) &&
    sameJson(existing.artifactEvidence ?? null, normalizeArtifactEvidence(report.artifactEvidence)) &&
    sameJson(existing.dependencyArtifactResult ?? null, normalizeDependencyArtifactResult(report.dependencyArtifactResult))
  );
}

function normalizeArtifactEvidence(
  evidence: CompletionReportInput["artifactEvidence"],
): ExpectedRedArtifactEvidence | null {
  return evidence
    ? {
        kind: evidence.kind,
        command: evidence.command,
        testFiles: [...evidence.testFiles],
        expectedFailure: evidence.expectedFailure,
        observedFailure: evidence.observedFailure,
        exitCode: evidence.exitCode,
      }
    : null;
}

function normalizeDependencyArtifactResult(
  result: CompletionReportInput["dependencyArtifactResult"],
): DependencyArtifactResult | null {
  return result
    ? {
        artifactId: result.artifactId,
        command: result.command,
        exitCode: result.exitCode,
        evidence: result.evidence,
      }
    : null;
}

function completionReportReadinessRejection(report: CompletionReportInput): CompletionReportReadinessRejection | null {
  const unsatisfied = report.acceptanceChecklist.filter((item) => !item.satisfied);
  if (unsatisfied.length === 0) return null;
  return {
    reasonCode: "unsatisfied_acceptance_checklist",
    reason: "Completion report cannot be accepted with unsatisfied acceptance checklist items",
    unsatisfiedAcceptanceChecklist: unsatisfied.map((item) => ({
      text: item.text,
      evidence: item.evidence,
    })),
  };
}

function completionReportPublicationRejection(error: unknown): CompletionReportReadinessRejection {
  return {
    reasonCode: "pull_request_publication_failed",
    reason: `Completion report could not publish the pull request: ${errorMessage(error)}`,
    unsatisfiedAcceptanceChecklist: [],
  };
}

function reportIdFor(issueId: string, idempotencyKey: string, runId?: string | null): string {
  return runId ? `completion-report:${issueId}:${runId}:${idempotencyKey}` : `completion-report:${issueId}:${idempotencyKey}`;
}

function reportRejectionIdFor(issueId: string, idempotencyKey: string): string {
  return `completion-report-rejection:${issueId}:${idempotencyKey}`;
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
  const current = latestCurrentCompletionReport(lifecycle);
  return current !== null && !isFinalizedCompletionReport(current) ? current : null;
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

function findCompletionReportForRun(
  lifecycle: IssueLifecycleRecord | null | undefined,
  runId: string,
  idempotencyKey: string,
): IssueCompletionReportRecord | undefined {
  if (!lifecycle) return undefined;
  const current = latestCurrentCompletionReport(lifecycle);
  return current?.runId === runId && current.idempotencyKey === idempotencyKey
    ? current
    : undefined;
}

function buildCompletionReportRecord(input: {
  report: CompletionReportInput;
  issue: Issue;
  pullRequest: CompletionReportPullRequestRef | null;
  acceptanceContext: CompletionReportAcceptanceContext | null;
  contractSnapshot: IssueContractSnapshot | null;
  acceptedAt: string | null;
  writebackOperationKeys: string[];
}): IssueCompletionReportRecord {
  return {
    id: reportIdFor(input.issue.id, input.report.idempotencyKey, input.report.runId),
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
    acceptanceContext: input.acceptanceContext,
    contractSnapshot: input.contractSnapshot,
    artifactEvidence: normalizeArtifactEvidence(input.report.artifactEvidence),
    dependencyArtifactResult: normalizeDependencyArtifactResult(input.report.dependencyArtifactResult),
    risks: input.report.risks,
    acceptedAt: input.acceptedAt ?? new Date().toISOString(),
    writebackOperationKeys: input.writebackOperationKeys,
  };
}

function buildCompletionReportAcceptanceContext(input: {
  report: CompletionReportInput;
  context: CompletionReportActiveContext;
  pullRequest: CompletionReportPullRequestRef | null;
  publication: CompletionReportPullRequestPublication | null;
  baseRefObservation: IssueBaseRefObservation | null;
  localSnapshot: CompletionReportLocalGitSnapshot;
}): CompletionReportAcceptanceContext {
  const branchName =
    input.localSnapshot.branchName ??
    input.publication?.headBranch ??
    input.pullRequest?.branch ??
    input.context.workspace?.gitBranchName ??
    input.report.branchName ??
    input.context.issue.branchName ??
    null;
  const baseRef =
    input.baseRefObservation?.baseRef ??
    input.localSnapshot.baseRef ??
    input.context.workspace?.baseRef ??
    null;
  const baseHeadSha =
    input.baseRefObservation?.localBaseHeadShaAfterFetch ??
    input.baseRefObservation?.githubBaseHeadSha ??
    input.localSnapshot.baseHeadSha ??
    null;
  const worktreeHeadSha =
    input.baseRefObservation?.worktreeHeadSha ??
    input.localSnapshot.worktreeHeadSha ??
    null;
  const pullRequestHeadSha = input.publication?.headSha ?? input.pullRequest?.headSha ?? null;
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    runId: input.report.runId,
    branchName,
    baseRef,
    baseHeadSha,
    worktreeHeadSha,
    treeSha: input.localSnapshot.treeSha,
    pullRequestHeadSha,
    worktreeDirty: input.localSnapshot.worktreeDirty,
    worktreeStatus: input.localSnapshot.worktreeStatus,
    unmergedFiles: input.localSnapshot.unmergedFiles,
  };
}

function completionReplayMatchesAuthoritativeState(
  existing: IssueCompletionReportRecord,
  current: CompletionReportAcceptanceContext,
): boolean {
  const previous = existing.acceptanceContext ?? null;
  if (!previous) return false;
  if (previous.worktreeStatus === "unknown" || current.worktreeStatus === "unknown") return false;
  if (previous.worktreeStatus !== current.worktreeStatus) return false;
  if (previous.worktreeDirty !== current.worktreeDirty) return false;
  if (!sameRequiredStateValue(previous.branchName, current.branchName)) return false;
  if (!sameRequiredStateValue(previous.baseRef, current.baseRef)) return false;
  if (!sameRequiredStateValue(previous.baseHeadSha, current.baseHeadSha)) return false;
  if (!sameRequiredStateValue(previous.worktreeHeadSha, current.worktreeHeadSha)) return false;
  if (!sameRequiredStateValue(previous.treeSha, current.treeSha)) return false;
  if (!sameNullableStringArray(previous.unmergedFiles, current.unmergedFiles)) return false;

  const previousPrHead = previous.pullRequestHeadSha ?? existing.pullRequest?.headSha ?? null;
  const currentPrHead = current.pullRequestHeadSha ?? current.worktreeHeadSha;
  if (previousPrHead !== null && currentPrHead !== null && previousPrHead !== currentPrHead) return false;
  return true;
}

function sameRequiredStateValue(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left === right;
}

function sameNullableStringArray(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return false;
  return sameJson([...left].sort(), [...right].sort());
}

function buildCompletionReportRejectionRecord(input: {
  report: CompletionReportInput;
  issue: Issue;
  pullRequest: CompletionReportPullRequestRef | null;
  contractSnapshot: IssueContractSnapshot | null;
  rejection: CompletionReportReadinessRejection;
  writebackOperationKeys: string[];
}): IssueCompletionReportRejectionRecord {
  return {
    id: reportRejectionIdFor(input.issue.id, input.report.idempotencyKey),
    reportId: reportIdFor(input.issue.id, input.report.idempotencyKey),
    idempotencyKey: input.report.idempotencyKey,
    runId: input.report.runId,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    reasonCode: input.rejection.reasonCode,
    reason: input.rejection.reason,
    summary: input.report.summary,
    validationEvidence: input.report.validationEvidence,
    acceptanceChecklist: normalizeChecklist(input.report.acceptanceChecklist),
    changedFiles: input.report.changedFiles,
    branchName: input.report.branchName,
    pullRequest: input.pullRequest,
    contractSnapshot: input.contractSnapshot,
    artifactEvidence: normalizeArtifactEvidence(input.report.artifactEvidence),
    dependencyArtifactResult: normalizeDependencyArtifactResult(input.report.dependencyArtifactResult),
    risks: input.report.risks,
    rejectedAt: new Date().toISOString(),
    writebackOperationKeys: input.writebackOperationKeys,
  };
}

function upsertCompletionReport(
  reports: IssueCompletionReportRecord[],
  report: IssueCompletionReportRecord,
): IssueCompletionReportRecord[] {
  return [
    ...reports.filter((item) => item.runId !== report.runId || item.idempotencyKey !== report.idempotencyKey),
    report,
  ];
}

function upsertCompletionReportRejection(
  rejections: IssueCompletionReportRejectionRecord[],
  rejection: IssueCompletionReportRejectionRecord,
): IssueCompletionReportRejectionRecord[] {
  return [...rejections.filter((item) => item.idempotencyKey !== rejection.idempotencyKey), rejection];
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

function rejectionSummaryPointersFor(
  context: CompletionReportActiveContext,
  pullRequest: CompletionReportPullRequestRef | null,
  existingLifecycle: ExistingIssueLifecycle,
) {
  const pointers = summaryPointersFor(context, pullRequest, null, existingLifecycle);
  if (pullRequest !== null) return pointers;
  return {
    ...pointers,
    prUrl: existingLifecycle?.summaryPointers.prUrl ?? null,
    prNumber: existingLifecycle?.summaryPointers.prNumber ?? null,
    prHeadSha: existingLifecycle?.summaryPointers.prHeadSha ?? null,
    prBranch: existingLifecycle?.summaryPointers.prBranch ?? null,
  };
}

async function captureCompletionReportLocalGitSnapshot(
  report: CompletionReportInput,
  context: CompletionReportActiveContext,
  existingLifecycle: ExistingIssueLifecycle,
  config: ServiceConfig,
): Promise<CompletionReportLocalGitSnapshot> {
  const workspacePath = context.workspacePath ?? context.workspace?.path ?? existingLifecycle?.summaryPointers.workspacePath ?? null;
  const fallbackBranchName =
    context.workspace?.gitBranchName ??
    report.branchName ??
    existingLifecycle?.summaryPointers.gitBranchName ??
    existingLifecycle?.summaryPointers.branchName ??
    context.issue.branchName ??
    null;
  const baseRef =
    context.workspace?.baseRef ??
    existingLifecycle?.summaryPointers.baseRef ??
    config.workspace.source.baseRef ??
    null;
  const empty = {
    branchName: fallbackBranchName,
    baseRef,
    baseHeadSha: null,
    worktreeHeadSha: null,
    treeSha: null,
    worktreeDirty: null,
    worktreeStatus: "unknown" as const,
    unmergedFiles: null,
  };
  if (!workspacePath) return empty;

  const [observedBranchName, worktreeHeadSha, treeSha, statusOutput, unmergedOutput, baseHeadSha] = await Promise.all([
    runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(workspacePath, ["rev-parse", "HEAD"]),
    runGit(workspacePath, ["rev-parse", "HEAD^{tree}"]),
    runGit(workspacePath, ["status", "--porcelain", "--untracked-files=all"]),
    runGit(workspacePath, ["diff", "--name-only", "--diff-filter=U"]),
    resolveLocalBaseHeadSha(workspacePath, baseRef),
  ]);
  const worktreeDirty = statusOutput === null ? null : statusOutput.length > 0;
  const unmergedFiles =
    unmergedOutput === null
      ? null
      : unmergedOutput
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
  return {
    branchName: observedBranchName ?? fallbackBranchName,
    baseRef,
    baseHeadSha,
    worktreeHeadSha,
    treeSha,
    worktreeDirty,
    worktreeStatus: worktreeDirty === null ? "unknown" : worktreeDirty ? "dirty" : "clean",
    unmergedFiles,
  };
}

async function resolveLocalBaseHeadSha(workspacePath: string, baseRef: string | null): Promise<string | null> {
  if (!baseRef) return null;
  for (const candidate of baseRefCandidates(baseRef)) {
    const headSha = await runGit(workspacePath, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (headSha) return headSha;
  }
  return null;
}

function baseRefCandidates(baseRef: string): string[] {
  const trimmed = baseRef.trim();
  if (trimmed.length === 0) return [];
  const branch =
    trimmed.startsWith("refs/heads/")
      ? trimmed.slice("refs/heads/".length)
      : trimmed.startsWith("refs/remotes/origin/")
        ? trimmed.slice("refs/remotes/origin/".length)
        : trimmed.startsWith("origin/")
          ? trimmed.slice("origin/".length)
          : trimmed;
  return [...new Set([trimmed, `origin/${branch}`, `refs/remotes/origin/${branch}`])];
}

function runGit(workspacePath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };
    const child = spawn("git", args, {
      cwd: workspacePath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
  });
}

export async function verifyDependencyArtifactManifest(
  input: DependencyArtifactManifestVerificationInput,
): Promise<void> {
  const manifest = input.artifact.fileManifest;
  if (manifest.length === 0) {
    throw new SymphonyError(
      "conflict",
      "Accepted-artifact manifest is empty and cannot be verified",
    );
  }
  const literalPaths = manifest.map((entry) => `:(literal)${entry.path}`);
  const status = await runGit(input.workspacePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...literalPaths,
  ]);
  if (status === null) {
    throw new SymphonyError(
      "conflict",
      "Unable to inspect inherited accepted-artifact files in the implementation worktree",
    );
  }
  if (status.length > 0) {
    throw new SymphonyError(
      "conflict",
      "Inherited accepted-artifact files have uncommitted changes",
    );
  }

  for (const entry of manifest) {
    const treeEntry = await runGit(input.workspacePath, [
      "ls-tree",
      "-z",
      "HEAD",
      "--",
      `:(literal)${entry.path}`,
    ]);
    if (treeEntry === null) {
      throw new SymphonyError(
        "conflict",
        `Unable to inspect inherited accepted-artifact file ${entry.path}`,
      );
    }
    const tab = treeEntry.indexOf("\t");
    const actualBlob =
      tab < 0
        ? null
        : (treeEntry.slice(0, tab).trim().split(/\s+/)[2] ?? null);
    if (entry.status === "deleted") {
      if (actualBlob !== null) {
        throw new SymphonyError(
          "conflict",
          `Inherited accepted-artifact deleted path ${entry.path} was restored`,
        );
      }
      continue;
    }
    if (actualBlob?.toLowerCase() !== entry.blobSha?.toLowerCase()) {
      throw new SymphonyError(
        "conflict",
        `Inherited accepted-artifact file ${entry.path} no longer matches the reviewed checkpoint`,
      );
    }
  }
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

function recoveryContextFor(input: {
  issue: Issue;
  lifecycle: IssueLifecycleRecord;
  pendingReport: IssueCompletionReportRecord;
  run: ExistingRunRecord;
  config: ServiceConfig;
}): CompletionReportActiveContext {
  const branchName =
    input.pendingReport.branchName ??
    input.lifecycle.summaryPointers.gitBranchName ??
    input.lifecycle.summaryPointers.branchName ??
    input.run?.gitBranchName ??
    input.issue.branchName;
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
      state: input.config.writeback.dispatchState,
      branchName,
    },
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
    reportId: reportIdFor(issue.id, report.idempotencyKey, report.runId),
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
  if (!sameJson(input.incomingReport.artifactEvidence ?? null, input.storedReport.artifactEvidence ?? null)) {
    mismatchedFields.push("artifactEvidence");
  }
  if (
    !sameJson(
      input.incomingReport.dependencyArtifactResult ?? null,
      input.storedReport.dependencyArtifactResult ?? null,
    )
  ) {
    mismatchedFields.push("dependencyArtifactResult");
  }
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
  if ((input.incomingPublicationInput.forceEmptyCommit ?? false) !== (input.storedPublicationInput.forceEmptyCommit ?? false)) {
    mismatchedFields.push("forceEmptyCommit");
  }
  if ((input.incomingPublicationInput.draft ?? false) !== (input.storedPublicationInput.draft ?? false)) {
    mismatchedFields.push("draft");
  }
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
    ...(record.artifactEvidence == null ? {} : { artifactEvidence: record.artifactEvidence }),
    ...(record.dependencyArtifactResult == null
      ? {}
      : {
          dependencyArtifactResult: {
            ...record.dependencyArtifactResult,
            exitCode: 0 as const,
          },
        }),
    branchName: record.branchName,
    pullRequest: record.pullRequest,
    risks: record.risks,
    idempotencyKey: record.idempotencyKey,
  };
}

function baseRefClientFromPublisher(
  publisher: CompletionReportPullRequestPublisher | undefined,
): BaseRefGitHubClient | null {
  if (
    publisher &&
    typeof publisher.getBranchHeadSha === "function" &&
    typeof publisher.gitAuthHeader === "function"
  ) {
    return {
      getBranchHeadSha: (input) => publisher.getBranchHeadSha!(input),
      gitAuthHeader: () => publisher.gitAuthHeader!(),
    };
  }
  return null;
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
  const artifactEvidence = report.artifactEvidence;
  return [
    artifactEvidence
      ? "Symphony published this draft pull request for review of an accepted expected-red test artifact."
      : "Symphony published this pull request from an accepted worker completion report.",
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
    ...(artifactEvidence
      ? [
          "",
          "Expected-red artifact evidence:",
          `- Command: ${artifactEvidence.command}`,
          `- Exit code: ${artifactEvidence.exitCode}`,
          `- Expected failure: ${artifactEvidence.expectedFailure}`,
          `- Observed failure: ${artifactEvidence.observedFailure}`,
          ...artifactEvidence.testFiles.map((file) => `- Test file: ${file}`),
        ]
      : []),
    "",
    "Changed files:",
    ...(report.changedFiles.length === 0 ? ["- n/a"] : report.changedFiles.map((item) => `- ${item}`)),
  ].join("\n");
}

function shouldForceFreshHeadForNoChangeMergeGateRepair(
  report: CompletionReportInput,
  lifecycle: ExistingIssueLifecycle,
): boolean {
  if (report.changedFiles.length > 0) return false;
  const gate = lifecycle?.mergeGate ?? null;
  if (gate?.status !== "repair_dispatched" && gate?.status !== "blocked") return false;
  const reportPullRequest = report.pullRequest;
  const reportNumber = reportPullRequest?.number ?? lifecycle?.summaryPointers.prNumber ?? null;
  const reportHeadSha = reportPullRequest?.headSha ?? lifecycle?.summaryPointers.prHeadSha ?? null;
  return reportNumber !== null && reportHeadSha !== null && gate.pullRequest.number === reportNumber && gate.headSha === reportHeadSha;
}

function sameState(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => sameState(state, candidate));
}
