import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import { createGitHubPullRequestClientForCapability } from "../integrations/github/GitHubCredentialResolver.js";
import {
  ServiceOwnedMergeConflictGit,
  type ServiceOwnedMergeConflictFinalizationInput,
  type ServiceOwnedMergeConflictFinalizationResult,
  type ServiceOwnedMergeConflictPreparationInput,
  type ServiceOwnedMergeConflictPreparationResult,
  type ServiceOwnedPreservedStashApplyResult,
  type ServiceOwnedStashApplyFinalizationInput,
  type ServiceOwnedStashApplyFinalizationResult,
  isPreparedBaseRefDriftError,
} from "./merge/ServiceOwnedMergeConflictGit.js";
import type {
  CompletionReportPullRequestRef,
  IssueLifecycleStore,
  IssueMergeConflictMetadata,
  IssueMergeConflictResolutionReportRecord,
  IssuePreservedWorktreeStash,
} from "./persistence/IssueLifecycleStore.js";
import type { Issue, Workspace } from "./types.js";
import { planBlockedEscalationWritebacks } from "./writeback/TransitionPolicy.js";
import type {
  WritebackOperation,
  WritebackOutboxStore,
  WritebackProcessor,
} from "./writeback/WritebackOutbox.js";

const mergeConflictResolutionSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  resolutionStatus: z.enum(["resolved", "still_conflicted", "blocked"]),
  summary: z.string().trim().min(1),
  validationEvidence: z.array(z.string().trim().min(1)).min(1),
  changedFiles: z.array(z.string().trim().min(1)),
  pullRequest: z.object({
    url: z.string().trim().min(1).nullable(),
    number: z.number().int().positive().nullable(),
    headSha: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable(),
  }),
  previousHeadSha: z.string().trim().min(1),
  newHeadSha: z.string().trim().min(1).nullable().optional(),
  baseBranch: z.string().trim().min(1),
  baseHeadSha: z.string().trim().min(1),
  blockedReason: z.string().trim().min(1).nullable().optional(),
  risks: z.array(z.string().trim().min(1)),
  idempotencyKey: z.string().trim().min(1),
});

export type MergeConflictResolutionInput = z.infer<typeof mergeConflictResolutionSchema>;
export type MergeConflictResolutionSubmitterRole = "worker" | string;

export interface MergeConflictResolutionFinalizer {
  finalize(input: ServiceOwnedMergeConflictFinalizationInput): Promise<ServiceOwnedMergeConflictFinalizationResult>;
  reprepareAfterBaseDrift?(
    input: ServiceOwnedMergeConflictPreparationInput,
  ): Promise<ServiceOwnedMergeConflictPreparationResult>;
  publishPreparedHead?(input: {
    workspacePath: string;
    branchName: string;
    previousRemoteHeadSha: string;
    authHeader: string;
  }): Promise<void>;
  applyPreservedStash?(input: {
    workspacePath: string;
    branchName: string;
    preservedStash: IssuePreservedWorktreeStash;
  }): Promise<ServiceOwnedPreservedStashApplyResult>;
  dropPreservedStash?(input: {
    workspacePath: string;
    preservedStash: IssuePreservedWorktreeStash;
  }): Promise<IssuePreservedWorktreeStash>;
  finalizeStashApply?(
    input: ServiceOwnedStashApplyFinalizationInput,
  ): Promise<ServiceOwnedStashApplyFinalizationResult>;
}

export interface MergeConflictResolutionActiveContext {
  issue: Issue;
  activeRunId: string;
  role: MergeConflictResolutionSubmitterRole;
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath?: string | null;
  workspace?: Workspace | null;
  phase?: "merge_conflict_resolution" | null;
  ignoreStateGate?: boolean;
}

export interface MergeConflictResolutionServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<WritebackOutboxStore, "enqueueOnce">;
  writebackProcessor?: Pick<WritebackProcessor, "processDue">;
  finalizer?: MergeConflictResolutionFinalizer;
  gitAuthHeaderProvider?: () => Promise<string>;
}

export interface MergeConflictResolutionResult {
  accepted: true;
  replayed: boolean;
  report: IssueMergeConflictResolutionReportRecord;
  mergeConflict: IssueMergeConflictMetadata;
  writebackOperations: WritebackOperation[];
}

export class MergeConflictResolutionService {
  constructor(private readonly options: MergeConflictResolutionServiceOptions) {}

  async submit_merge_conflict_resolution(
    input: unknown,
    context: MergeConflictResolutionActiveContext,
  ): Promise<MergeConflictResolutionResult> {
    return this.submitMergeConflictResolution(input, context);
  }

  async submitMergeConflictResolution(
    input: unknown,
    context: MergeConflictResolutionActiveContext,
  ): Promise<MergeConflictResolutionResult> {
    const report = parseMergeConflictResolution(input);
    this.validateCaller(report, context);
    this.validateConflictState(context);

    const lifecycle = await this.options.lifecycleStore.get(context.issue.id);
    const mergeConflict = lifecycle?.mergeConflict ?? null;
    const existing = lifecycle?.mergeConflictResolutionReports.find((item) => item.idempotencyKey === report.idempotencyKey);
    if (existing && mergeConflict) {
      assertPullRequestMatchesConflict(report.pullRequest, mergeConflict);
      assertReplayMatchesReport(normalizeReplayReport(report, existing, mergeConflict), existing);
      return { accepted: true, replayed: true, report: existing, mergeConflict, writebackOperations: [] };
    }
    if (!lifecycle || !mergeConflict || mergeConflict.status === "blocked") {
      throw new SymphonyError("invalid_request", "Merge conflict resolution requires an open merge conflict lifecycle record");
    }

    assertPullRequestMatchesConflict(report.pullRequest, mergeConflict);
    const finalReport = await this.normalizeReportForServicePreparation(report, mergeConflict, context);
    if (!finalReport.serviceRemediation) assertReportMatchesConflict(finalReport, mergeConflict);
    const storedReport = buildMergeConflictResolutionReport({ report: finalReport, issue: context.issue });
    const now = new Date().toISOString();
    const countedRunIds = new Set(mergeConflict.attemptRunIds);
    const shouldCountAttempt =
      finalReport.resolutionStatus !== "resolved" &&
      finalReport.serviceRemediation === undefined &&
      !countedRunIds.has(finalReport.runId);
    if (shouldCountAttempt) countedRunIds.add(report.runId);
    const fixTurnCount = mergeConflict.fixTurnCount + (shouldCountAttempt ? 1 : 0);
    const blocked =
      finalReport.resolutionStatus === "blocked" ||
      (finalReport.resolutionStatus === "still_conflicted" && fixTurnCount >= mergeConflict.maxFixTurns);
    const blockedReason = blocked
      ? finalReport.blockedReason ?? conflictBlockedReason(fixTurnCount, mergeConflict.maxFixTurns)
      : null;
    const nextConflict: IssueMergeConflictMetadata =
      finalReport.serviceRemediation?.kind === "prepared_base_ref_drift"
        ? mergeConflictAfterPreparedBaseDrift({
            issueId: context.issue.id,
            mergeConflict,
            report: finalReport,
            now,
            reportId: storedReport.id,
          })
        : finalReport.serviceRemediation?.kind === "preserved_stash_apply_conflicted"
          ? mergeConflictAfterPreservedStashApplyConflict({
              issueId: context.issue.id,
              mergeConflict,
              report: finalReport,
              now,
            })
          : {
              ...mergeConflict,
              status: blocked ? "blocked" : finalReport.resolutionStatus === "resolved" ? "resolved" : "open",
              resolutionStatus: blocked ? "blocked" : finalReport.resolutionStatus,
              pullRequest: { ...finalReport.pullRequest },
              currentHeadSha: finalReport.newHeadSha,
              resolvedHeadSha: finalReport.resolutionStatus === "resolved" ? finalReport.newHeadSha : mergeConflict.resolvedHeadSha,
              baseBranch: finalReport.baseBranch,
              baseHeadSha: finalReport.baseHeadSha,
              servicePreparation: servicePreparationAfterReport(mergeConflict, finalReport, now),
              updatedAt: now,
              fixTurnCount,
              lastConflictFixRunId: finalReport.runId,
              lastConflictResolutionReportId: storedReport.id,
              attemptRunIds: [...countedRunIds],
              blockedAt: blocked ? now : mergeConflict.blockedAt,
              blockedReason,
            };

    const writebackOperations = blocked ? await this.enqueueBlockedWritebacks(context, nextConflict) : [];
    const implementationPhase =
      !blocked &&
      finalReport.resolutionStatus === "resolved" &&
      (finalReport.serviceRemediation?.kind === "preserved_stash_applied_clean" ||
        finalReport.serviceRemediation?.kind === "stash_apply_finalized");
    const activeStash = preservedStashFromReport(finalReport);
    const preservedWorktreeStashes =
      activeStash === null
        ? preservedWorktreeStashesOf(lifecycle)
        : upsertPreservedWorktreeStash(preservedWorktreeStashesOf(lifecycle), activeStash);
    const updated = await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: blocked
        ? "blocked"
        : implementationPhase
          ? "implementation"
          : nextConflict.resolutionStatus === "resolved"
            ? "passed"
            : "merge_conflict_resolution",
      blockedReason: blocked ? nextConflict.blockedReason : null,
      mergeConflict: {
        ...nextConflict,
        writebackOperationKeys:
          writebackOperations.length > 0
            ? writebackOperations.map((operation) => operation.idempotencyKey)
            : nextConflict.writebackOperationKeys,
      },
      mergeConflictResolutionReports: upsertMergeConflictResolutionReport(
        lifecycle.mergeConflictResolutionReports,
        storedReport,
      ),
      preservedWorktreeStashes,
      summaryPointers: {
        lastRunId: finalReport.runId,
        prUrl: finalReport.pullRequest.url,
        prNumber: finalReport.pullRequest.number,
        prHeadSha: finalReport.pullRequest.headSha,
        prBranch: finalReport.pullRequest.branch,
        lastEvidenceCursor: finalReport.idempotencyKey,
        ...(implementationPhase ? { ciStatus: null } : {}),
      },
    });

    await this.options.writebackProcessor?.processDue();
    return {
      accepted: true,
      replayed: false,
      report: storedReport,
      mergeConflict: updated.mergeConflict ?? nextConflict,
      writebackOperations,
    };
  }

  private validateCaller(report: MergeConflictResolutionInput, context: MergeConflictResolutionActiveContext): void {
    if (context.role !== "worker") {
      throw new SymphonyError("invalid_request", "Only active conflict-fix workers may submit merge conflict resolutions");
    }
    if (context.expectedToken !== undefined && context.expectedToken !== null && context.token !== context.expectedToken) {
      throw new SymphonyError("invalid_request", "Missing or invalid merge conflict resolution token");
    }
    if (report.runId !== context.activeRunId) {
      throw new SymphonyError("invalid_request", "Merge conflict resolution run does not match the active worker run");
    }
    if (report.issueId !== context.issue.id && report.issueId !== context.issue.identifier) {
      throw new SymphonyError("invalid_request", "Merge conflict resolution issue does not match the active worker issue");
    }
  }

  private validateConflictState(context: MergeConflictResolutionActiveContext): void {
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (
      this.options.config.mergePolicy.mode !== "gated" ||
      conflictsState === null ||
      (context.ignoreStateGate !== true && !sameState(context.issue.state, conflictsState))
    ) {
      throw new SymphonyError("invalid_request", "Merge conflict resolution requires the configured conflict-fix state");
    }
    if (context.phase !== undefined && context.phase !== null && context.phase !== "merge_conflict_resolution") {
      throw new SymphonyError("invalid_request", `Merge conflict resolution cannot be accepted while lifecycle phase is ${context.phase}`);
    }
  }

  private async enqueueBlockedWritebacks(
    context: MergeConflictResolutionActiveContext,
    mergeConflict: IssueMergeConflictMetadata,
  ): Promise<WritebackOperation[]> {
    const operations = planBlockedEscalationWritebacks(
      {
        issue: context.issue,
        runId: context.activeRunId,
        reason: mergeConflict.blockedReason ?? conflictBlockedReason(mergeConflict.fixTurnCount, mergeConflict.maxFixTurns),
        requiredAction: [
          "Merge conflicts remain unresolved after the configured conflict-fix attempts.",
          `Pull request: ${formatPullRequest(mergeConflict.pullRequest)}`,
          `Approved head SHA: ${mergeConflict.approvedHeadSha}`,
          `Latest reported head SHA: ${mergeConflict.currentHeadSha}`,
          "Inspect the branch, resolve conflicts manually or reset approval, then move the issue when Symphony should continue.",
        ].join("\n"),
      },
      this.options.config,
    );
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    return enqueued;
  }

  private async normalizeReportForServicePreparation(
    report: MergeConflictResolutionInput,
    mergeConflict: IssueMergeConflictMetadata,
    context: MergeConflictResolutionActiveContext,
  ): Promise<NormalizedMergeConflictResolutionInput> {
    if (report.newHeadSha !== undefined && report.newHeadSha !== null) return normalizeProvidedNewHeadSha(report);
    if (!canOmitNewHeadShaForServicePreparation(report, mergeConflict)) {
      throw new SymphonyError(
        "invalid_request",
        "Merge conflict resolution newHeadSha is required unless Symphony service-prepared the conflict worktree",
      );
    }
    if (report.resolutionStatus !== "resolved") {
      return {
        ...report,
        pullRequest: { ...report.pullRequest, headSha: mergeConflict.currentHeadSha },
        newHeadSha: mergeConflict.currentHeadSha,
      };
    }
    const servicePreparation = mergeConflict.servicePreparation;
    if (servicePreparation === null || servicePreparation.status !== "conflicted") {
      throw new SymphonyError("invalid_request", "Service-prepared merge conflict is not ready for finalization");
    }
    const workspacePath = context.workspacePath ?? context.workspace?.path ?? null;
    if (!workspacePath) {
      throw new SymphonyError("invalid_request", "Merge conflict finalization requires the worker workspace path");
    }
    const branchName = requireValue(mergeConflict.pullRequest.branch, "Merge conflict finalization requires the PR branch");
    const baseBranch = requireValue(mergeConflict.baseBranch, "Merge conflict finalization requires the PR base branch");
    const finalizer = this.options.finalizer ?? new ServiceOwnedMergeConflictGit();
    const authHeader = await this.gitAuthHeader();
    if (servicePreparation.strategy === "stash_apply") {
      const finalizeStashApply = finalizer.finalizeStashApply?.bind(finalizer);
      if (!finalizeStashApply) {
        throw new SymphonyError("invalid_request", "Stash-apply conflict finalization requires service-owned stash finalization");
      }
      const finalized = await finalizeStashApply({
        workspacePath,
        branchName,
        previousRemoteHeadSha: mergeConflict.currentHeadSha,
        allowedFiles: servicePreparation.allowedFiles,
        conflictedFiles: servicePreparation.conflictedFiles,
        changedFiles: report.changedFiles,
        preservedStash: servicePreparation.preservedStash,
        authHeader,
      });
      return {
        ...report,
        pullRequest: { ...report.pullRequest, headSha: finalized.newHeadSha },
        newHeadSha: finalized.newHeadSha,
        serviceRemediation: {
          kind: "stash_apply_finalized",
          preservedStash: finalized.preservedStash,
        },
      };
    }
    let finalized: ServiceOwnedMergeConflictFinalizationResult;
    try {
      finalized = await finalizer.finalize({
        workspacePath,
        branchName,
        previousRemoteHeadSha: mergeConflict.currentHeadSha,
        preparedBaseHeadSha: servicePreparation.preparedBaseHeadSha,
        baseBranch,
        conflictedFiles: servicePreparation.conflictedFiles,
        changedFiles: report.changedFiles,
        authHeader,
      });
    } catch (error) {
      if (!isPreparedBaseRefDriftError(error)) throw error;
      return this.reprepareAfterPreparedBaseDrift({
        report,
        mergeConflict,
        workspacePath,
        branchName,
        baseBranch,
        authHeader,
        liveBaseHeadSha: error.details.actualSha,
        finalizer,
      });
    }
    const preservedStash = servicePreparation.preservedStash ?? null;
    if (preservedStash !== null) {
      const applyPreservedStash = finalizer.applyPreservedStash?.bind(finalizer);
      if (!applyPreservedStash) {
        throw new SymphonyError("invalid_request", "Preserved stash restoration requires service-owned stash apply support");
      }
      const stashApply = await applyPreservedStash({
        workspacePath,
        branchName,
        preservedStash,
      });
      if (stashApply.status === "conflicted") {
        return {
          ...report,
          resolutionStatus: "still_conflicted",
          pullRequest: { ...report.pullRequest, headSha: finalized.newHeadSha },
          newHeadSha: finalized.newHeadSha,
          blockedReason: null,
          serviceRemediation: {
            kind: "preserved_stash_apply_conflicted",
            applyResult: stashApply,
          },
        };
      }
      const dropPreservedStash = finalizer.dropPreservedStash?.bind(finalizer);
      if (!dropPreservedStash) {
        throw new SymphonyError("invalid_request", "Preserved stash cleanup requires service-owned stash drop support");
      }
      const dropped = await dropPreservedStash({
        workspacePath,
        preservedStash: stashApply.stash,
      });
      return {
        ...report,
        pullRequest: { ...report.pullRequest, headSha: finalized.newHeadSha },
        newHeadSha: finalized.newHeadSha,
        serviceRemediation: {
          kind: "preserved_stash_applied_clean",
          preservedStash: dropped,
        },
      };
    }
    return {
      ...report,
      pullRequest: { ...report.pullRequest, headSha: finalized.newHeadSha },
      newHeadSha: finalized.newHeadSha,
    };
  }

  private async reprepareAfterPreparedBaseDrift(input: {
    report: MergeConflictResolutionInput;
    mergeConflict: IssueMergeConflictMetadata;
    workspacePath: string;
    branchName: string;
    baseBranch: string;
    authHeader: string;
    liveBaseHeadSha: string;
    finalizer: MergeConflictResolutionFinalizer;
  }): Promise<NormalizedMergeConflictResolutionInput> {
    const reprepare = input.finalizer.reprepareAfterBaseDrift?.bind(input.finalizer);
    if (!reprepare) {
      throw new SymphonyError("invalid_request", "Prepared base drift requires service-owned conflict repreparation");
    }
    const preparation = await reprepare({
      workspacePath: input.workspacePath,
      branchName: input.branchName,
      expectedHeadSha: input.mergeConflict.currentHeadSha,
      baseBranch: input.baseBranch,
      observedPrBaseHeadSha: input.liveBaseHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      authHeader: input.authHeader,
    });
    if (preparation.status === "clean") {
      const publish = input.finalizer.publishPreparedHead?.bind(input.finalizer);
      if (!publish) {
        throw new SymphonyError("invalid_request", "Clean prepared-base drift remediation requires service-owned PR publication");
      }
      await publish({
        workspacePath: input.workspacePath,
        branchName: input.branchName,
        previousRemoteHeadSha: input.mergeConflict.currentHeadSha,
        authHeader: input.authHeader,
      });
      return {
        ...input.report,
        resolutionStatus: "resolved",
        pullRequest: { ...input.report.pullRequest, headSha: preparation.rebasedHeadSha },
        newHeadSha: preparation.rebasedHeadSha,
        baseHeadSha: preparation.liveBaseHeadSha,
        serviceRemediation: { kind: "prepared_base_ref_drift", preparation },
      };
    }

    return {
      ...input.report,
      resolutionStatus: "still_conflicted",
      pullRequest: { ...input.report.pullRequest, headSha: input.mergeConflict.currentHeadSha },
      newHeadSha: input.mergeConflict.currentHeadSha,
      baseHeadSha: preparation.liveBaseHeadSha,
      blockedReason: null,
      serviceRemediation: { kind: "prepared_base_ref_drift", preparation },
    };
  }

  private gitAuthHeader(): Promise<string> {
    if (this.options.gitAuthHeaderProvider) return this.options.gitAuthHeaderProvider();
    return createGitHubPullRequestClientForCapability(this.options.config, "github.merge").gitAuthHeader();
  }
}

function parseMergeConflictResolution(input: unknown): MergeConflictResolutionInput {
  const parsed = mergeConflictResolutionSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Merge conflict resolution report is invalid", parsed.error.flatten());
  }
  return parsed.data;
}

type NormalizedMergeConflictResolutionInput = MergeConflictResolutionInput & {
  newHeadSha: string;
  pullRequest: MergeConflictResolutionInput["pullRequest"] & { headSha: string };
  serviceRemediation?: {
    kind: "prepared_base_ref_drift";
    preparation: ServiceOwnedMergeConflictPreparationResult;
  } | {
    kind: "preserved_stash_applied_clean";
    preservedStash: IssuePreservedWorktreeStash;
  } | {
    kind: "preserved_stash_apply_conflicted";
    applyResult: ServiceOwnedPreservedStashApplyResult & { status: "conflicted" };
  } | {
    kind: "stash_apply_finalized";
    preservedStash: IssuePreservedWorktreeStash;
  };
};

function buildMergeConflictResolutionReport(input: {
  report: NormalizedMergeConflictResolutionInput;
  issue: Issue;
}): IssueMergeConflictResolutionReportRecord {
  return {
    id: `merge-conflict-resolution:${input.issue.id}:${input.report.idempotencyKey}`,
    idempotencyKey: input.report.idempotencyKey,
    runId: input.report.runId,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    resolutionStatus: input.report.resolutionStatus,
    summary: input.report.summary,
    validationEvidence: input.report.validationEvidence,
    changedFiles: input.report.changedFiles,
    pullRequest: input.report.pullRequest,
    previousHeadSha: input.report.previousHeadSha,
    newHeadSha: input.report.newHeadSha,
    baseBranch: input.report.baseBranch,
    baseHeadSha: input.report.baseHeadSha,
    blockedReason: input.report.resolutionStatus === "blocked" ? input.report.blockedReason ?? null : null,
    risks: input.report.risks,
    submittedAt: new Date().toISOString(),
  };
}

function upsertMergeConflictResolutionReport(
  reports: IssueMergeConflictResolutionReportRecord[],
  report: IssueMergeConflictResolutionReportRecord,
): IssueMergeConflictResolutionReportRecord[] {
  return [...reports.filter((item) => item.idempotencyKey !== report.idempotencyKey), report];
}

function assertPullRequestMatchesConflict(
  pullRequest: CompletionReportPullRequestRef,
  mergeConflict: IssueMergeConflictMetadata,
): void {
  requireMatches("conflict resolution PR number", pullRequest.number, mergeConflict.pullRequest.number);
  requireMatches("conflict resolution PR URL", pullRequest.url, mergeConflict.pullRequest.url);
  requireMatches("conflict resolution PR branch", pullRequest.branch, mergeConflict.pullRequest.branch);
}

function assertReportMatchesConflict(
  report: NormalizedMergeConflictResolutionInput,
  mergeConflict: IssueMergeConflictMetadata,
): void {
  requireMatches("conflict resolution previous head SHA", report.previousHeadSha, mergeConflict.currentHeadSha);
  requireMatches("conflict resolution new head SHA", report.newHeadSha, report.pullRequest.headSha);
  if (mergeConflict.baseBranch !== null) requireMatches("conflict resolution base branch", report.baseBranch, mergeConflict.baseBranch);
  if (mergeConflict.baseHeadSha !== null) {
    requireMatches("conflict resolution base head SHA", report.baseHeadSha, mergeConflict.baseHeadSha);
  }
}

function assertReplayMatchesReport(
  report: NormalizedMergeConflictResolutionInput,
  existing: IssueMergeConflictResolutionReportRecord,
): void {
  const expected = {
    runId: existing.runId,
    resolutionStatus: existing.resolutionStatus,
    summary: existing.summary,
    validationEvidence: existing.validationEvidence,
    changedFiles: existing.changedFiles,
    pullRequest: existing.pullRequest,
    previousHeadSha: existing.previousHeadSha,
    newHeadSha: existing.newHeadSha,
    baseBranch: existing.baseBranch,
    baseHeadSha: existing.baseHeadSha,
    blockedReason: existing.blockedReason,
    risks: existing.risks,
  };
  const actual = {
    runId: report.runId,
    resolutionStatus: report.resolutionStatus,
    summary: report.summary,
    validationEvidence: report.validationEvidence,
    changedFiles: report.changedFiles,
    pullRequest: report.pullRequest,
    previousHeadSha: report.previousHeadSha,
    newHeadSha: report.newHeadSha,
    baseBranch: report.baseBranch,
    baseHeadSha: report.baseHeadSha,
    blockedReason: report.resolutionStatus === "blocked" ? report.blockedReason ?? null : null,
    risks: report.risks,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SymphonyError("invalid_request", "Merge conflict resolution idempotency key was reused with different report metadata");
  }
}

function normalizeProvidedNewHeadSha(report: MergeConflictResolutionInput): NormalizedMergeConflictResolutionInput {
  const newHeadSha = requireValue(report.newHeadSha, "Merge conflict resolution newHeadSha is required");
  return { ...report, newHeadSha };
}

function normalizeReplayReport(
  report: MergeConflictResolutionInput,
  existing: IssueMergeConflictResolutionReportRecord,
  mergeConflict: IssueMergeConflictMetadata,
): NormalizedMergeConflictResolutionInput {
  if (report.newHeadSha !== undefined && report.newHeadSha !== null) return normalizeProvidedNewHeadSha(report);
  if (!canOmitNewHeadShaForServicePreparation(report, mergeConflict)) {
    throw new SymphonyError(
      "invalid_request",
      "Merge conflict resolution newHeadSha is required unless Symphony service-prepared the conflict worktree",
    );
  }
  const existingPullRequestHeadSha = requireValue(
    existing.pullRequest.headSha,
    "Existing merge conflict resolution report is missing pull request head SHA",
  );
  const existingNewHeadSha = requireValue(existing.newHeadSha, "Existing merge conflict resolution report is missing new head SHA");
  return {
    ...report,
    pullRequest: { ...report.pullRequest, headSha: existingPullRequestHeadSha },
    newHeadSha: existingNewHeadSha,
  };
}

function canOmitNewHeadShaForServicePreparation(
  report: MergeConflictResolutionInput,
  mergeConflict: IssueMergeConflictMetadata,
): boolean {
  return (
    (mergeConflict.servicePreparation?.strategy === "squash_rebase" ||
      mergeConflict.servicePreparation?.strategy === "stash_apply") &&
    (mergeConflict.servicePreparation.status === "conflicted" || mergeConflict.servicePreparation.status === "finalized") &&
    report.previousHeadSha === mergeConflict.servicePreparation.originalHeadSha
  );
}

function servicePreparationAfterReport(
  mergeConflict: IssueMergeConflictMetadata,
  report: NormalizedMergeConflictResolutionInput,
  now: string,
): IssueMergeConflictMetadata["servicePreparation"] {
  const servicePreparation = mergeConflict.servicePreparation;
  if (servicePreparation === null || report.resolutionStatus !== "resolved") return servicePreparation;
  if (servicePreparation.strategy === "stash_apply") {
    const remediation = report.serviceRemediation;
    const preservedStash =
      remediation?.kind === "stash_apply_finalized"
        ? remediation.preservedStash
        : servicePreparation.preservedStash;
    return {
      ...servicePreparation,
      status: "finalized",
      preservedStash,
      finalizedAt: now,
      finalizedHeadSha: report.newHeadSha,
    };
  }
  const remediation = report.serviceRemediation;
  const preservedStash =
    remediation?.kind === "preserved_stash_applied_clean"
      ? remediation.preservedStash
      : servicePreparation.preservedStash ?? null;
  return {
    ...servicePreparation,
    status: "finalized",
    preservedStash,
    finalizedAt: now,
    finalizedHeadSha: report.newHeadSha,
  };
}

function mergeConflictAfterPreparedBaseDrift(input: {
  issueId: string;
  mergeConflict: IssueMergeConflictMetadata;
  report: NormalizedMergeConflictResolutionInput;
  now: string;
  reportId: string;
}): IssueMergeConflictMetadata {
  const remediation = input.report.serviceRemediation;
  if (remediation?.kind !== "prepared_base_ref_drift") {
    throw new SymphonyError("invalid_request", "Prepared-base remediation metadata is missing");
  }
  const preparation = remediation.preparation;
  const resolved = preparation.status === "clean";
  return {
    ...input.mergeConflict,
    id: `merge-conflict:${input.issueId}:${input.mergeConflict.approvedHeadSha}:${preparation.liveBaseHeadSha}`,
    status: resolved ? "resolved" : "open",
    resolutionStatus: resolved ? "resolved" : "pending",
    pullRequest: { ...input.report.pullRequest },
    currentHeadSha: input.report.newHeadSha,
    resolvedHeadSha: resolved ? input.report.newHeadSha : null,
    baseHeadSha: preparation.liveBaseHeadSha,
    servicePreparation: {
      strategy: "squash_rebase",
      status: resolved ? "finalized" : "conflicted",
      originalHeadSha: preparation.originalHeadSha,
      observedPrBaseHeadSha: preparation.observedPrBaseHeadSha,
      liveBaseHeadSha: preparation.liveBaseHeadSha,
      preparedBaseHeadSha: preparation.preparedBaseHeadSha,
      mergeBaseSha: preparation.mergeBaseSha,
      squashCommitSha: preparation.squashCommitSha,
      conflictedFiles: preparation.conflictedFiles,
      preparedAt: input.now,
      finalizedAt: resolved ? input.now : null,
      finalizedHeadSha: resolved ? input.report.newHeadSha : null,
      preservedStash:
        input.mergeConflict.servicePreparation?.strategy === "squash_rebase"
          ? input.mergeConflict.servicePreparation.preservedStash ?? null
          : null,
    },
    updatedAt: input.now,
    fixTurnCount: 0,
    lastConflictFixRunId: resolved ? input.report.runId : null,
    lastConflictResolutionReportId: input.reportId,
    attemptRunIds: [],
    blockedAt: null,
    blockedReason: null,
  };
}

function mergeConflictAfterPreservedStashApplyConflict(input: {
  issueId: string;
  mergeConflict: IssueMergeConflictMetadata;
  report: NormalizedMergeConflictResolutionInput;
  now: string;
}): IssueMergeConflictMetadata {
  const remediation = input.report.serviceRemediation;
  if (remediation?.kind !== "preserved_stash_apply_conflicted") {
    throw new SymphonyError("invalid_request", "Preserved stash apply conflict metadata is missing");
  }
  const applyResult = remediation.applyResult;
  const allowedFiles = sortedUnique([
    ...applyResult.stash.dirtyFiles,
    ...applyResult.changedFiles,
    ...applyResult.conflictedFiles,
  ]);
  return {
    ...input.mergeConflict,
    id: `merge-conflict:${input.issueId}:stash-apply:${input.report.newHeadSha}:${applyResult.stash.stashSha}`,
    status: "open",
    resolutionStatus: "pending",
    pullRequest: { ...input.report.pullRequest },
    approvedHeadSha: input.report.newHeadSha,
    currentHeadSha: input.report.newHeadSha,
    resolvedHeadSha: null,
    baseBranch: input.report.baseBranch,
    baseHeadSha: input.report.baseHeadSha,
    reason: "Preserved local changes conflicted while restoring after service-owned repair",
    mergeableState: "dirty",
    servicePreparation: {
      strategy: "stash_apply",
      status: "conflicted",
      originalHeadSha: input.report.newHeadSha,
      currentHeadSha: input.report.newHeadSha,
      conflictedFiles: applyResult.conflictedFiles,
      allowedFiles,
      preservedStash: applyResult.stash,
      preparedAt: input.now,
      finalizedAt: null,
      finalizedHeadSha: null,
    },
    updatedAt: input.now,
    fixTurnCount: 0,
    lastConflictFixRunId: null,
    lastConflictResolutionReportId: null,
    attemptRunIds: [],
    blockedAt: null,
    blockedReason: null,
  };
}

function preservedStashFromReport(
  report: NormalizedMergeConflictResolutionInput,
): IssuePreservedWorktreeStash | null {
  const remediation = report.serviceRemediation;
  if (
    remediation?.kind === "preserved_stash_applied_clean" ||
    remediation?.kind === "stash_apply_finalized"
  ) {
    return remediation.preservedStash;
  }
  if (remediation?.kind === "preserved_stash_apply_conflicted") {
    return remediation.applyResult.stash;
  }
  return null;
}

function upsertPreservedWorktreeStash(
  stashes: IssuePreservedWorktreeStash[],
  stash: IssuePreservedWorktreeStash,
): IssuePreservedWorktreeStash[] {
  const index = stashes.findIndex((item) => item.id === stash.id);
  if (index === -1) return [...stashes, stash];
  return stashes.map((item, itemIndex) => (itemIndex === index ? stash : item));
}

function preservedWorktreeStashesOf(lifecycle: {
  preservedWorktreeStashes?: IssuePreservedWorktreeStash[];
}): IssuePreservedWorktreeStash[] {
  return lifecycle.preservedWorktreeStashes ?? [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new SymphonyError("invalid_request", message);
  return value;
}

function requireMatches(label: string, actual: string | number | null | undefined, expected: string | number | null | undefined): void {
  if (actual === expected) return;
  throw new SymphonyError("invalid_request", `${label} does not match merge conflict metadata`);
}

function conflictBlockedReason(fixTurnCount: number, maxFixTurns: number): string {
  return `merge conflicts remain unresolved (${fixTurnCount}/${maxFixTurns} conflict-fix attempts)`;
}

function formatPullRequest(pullRequest: CompletionReportPullRequestRef): string {
  if (pullRequest.number !== null && pullRequest.url !== null) return `#${pullRequest.number} (${pullRequest.url})`;
  if (pullRequest.number !== null) return `#${pullRequest.number}`;
  return pullRequest.url ?? "unknown";
}

function sameState(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
