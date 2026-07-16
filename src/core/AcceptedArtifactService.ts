import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import { parseIssueContract } from "./IssueContractLint.js";
import type {
  CompletionReportPullRequestRef,
  IssueAcceptedArtifactRecord,
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueReviewFeedbackRecord,
  IssueReviewVerdictRecord,
} from "./persistence/IssueLifecycleStore.js";
import {
  isSupersededLifecycleRecord,
  latestCurrentCompletionReport,
} from "./persistence/IssueLifecycleStore.js";
import type { ArtifactFileManifestEntry, Issue } from "./types.js";
import { workspaceRepositoryFingerprint } from "./workspace/GitWorktreeManager.js";
import { planAcceptedArtifactCompletionWritebacks } from "./writeback/TransitionPolicy.js";
import type {
  WritebackOperation,
  WritebackOutboxStore,
  WritebackProcessor,
} from "./writeback/WritebackOutbox.js";
import type {
  PullRequestCloseInput,
  PullRequestCloseResult,
  PullRequestDetails,
} from "../integrations/github/GitHubPullRequestClient.js";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export interface AcceptedArtifactGitHubClient {
  getPullRequest(input: { pullRequestNumber: number }): Promise<PullRequestDetails>;
  getBranchHeadSha(input: { branchName: string }): Promise<string>;
  closePullRequest(input: PullRequestCloseInput): Promise<PullRequestCloseResult>;
}

export interface AcceptedArtifactCheckpointInput {
  workspacePath: string;
  sourceBaseHeadSha: string;
  sourceHeadSha: string;
  changedFiles: string[];
}

export interface AcceptedArtifactCheckpointBuilder {
  build(input: AcceptedArtifactCheckpointInput): Promise<ArtifactFileManifestEntry[]>;
}

export interface AcceptedArtifactServiceOptions {
  config: ServiceConfig;
  lifecycleStore: Pick<IssueLifecycleStore, "get" | "updateIssue">;
  writebackOutbox: Pick<WritebackOutboxStore, "enqueueOnce" | "get">;
  writebackProcessor?: Pick<WritebackProcessor, "processDue"> &
    Partial<Pick<WritebackProcessor, "enqueueAndProcess">>;
  client: AcceptedArtifactGitHubClient;
  checkpointBuilder?: AcceptedArtifactCheckpointBuilder;
}

export interface CompleteAcceptedArtifactInput {
  issue: Issue;
  workspacePath: string | null;
}

export interface CompleteAcceptedArtifactResult {
  status: "completed_unmerged";
  replayed: boolean;
  artifact: IssueAcceptedArtifactRecord;
  writebackOperations: WritebackOperation[];
  writebacksSettled: boolean;
}

export type AcceptedArtifactFailureCategory =
  | "contract_or_head_drift"
  | "permanent_github_access_or_configuration"
  | "unexpected_merged_or_irrecoverable_checkpoint"
  | "transient";

export type AcceptedArtifactFailureReason =
  | "contract_or_review_drift"
  | "pull_request_or_branch_drift"
  | "source_checkpoint_drift"
  | "unexpected_merged_pull_request"
  | "irrecoverable_checkpoint"
  | "github_access_or_configuration"
  | "github_or_tracker_failure"
  | "unexpected_failure";

export class AcceptedArtifactCompletionError extends SymphonyError {
  constructor(
    readonly category: AcceptedArtifactFailureCategory,
    readonly reason: AcceptedArtifactFailureReason,
    message: string,
    details?: unknown,
  ) {
    super(
      category === "transient"
        ? "tracker_error"
        : category === "permanent_github_access_or_configuration"
          ? "invalid_request"
          : "conflict",
      message,
      details,
    );
    this.name = "AcceptedArtifactCompletionError";
  }
}

export function classifyAcceptedArtifactCompletionError(error: unknown): AcceptedArtifactFailureCategory {
  if (error instanceof AcceptedArtifactCompletionError) return error.category;
  if (error instanceof SymphonyError) {
    if (error.code === "tracker_error" || error.code === "tracker_unavailable") return "transient";
    if (error.code === "invalid_request" || error.code === "config_validation_error") {
      return "permanent_github_access_or_configuration";
    }
    if (error.code === "not_found" || error.code === "conflict" || error.code === "workspace_error") {
      return "contract_or_head_drift";
    }
  }
  return "transient";
}

interface ValidatedAcceptedArtifactReview {
  lifecycle: IssueLifecycleRecord;
  report: IssueCompletionReportRecord;
  verdict: IssueReviewVerdictRecord;
  feedback: IssueReviewFeedbackRecord;
  pullRequest: Omit<CompletionReportPullRequestRef, "number" | "headSha" | "branch"> & {
    number: number;
    headSha: string;
    branch: string;
  };
  sourceBaseHeadSha: string;
  baseRef: string;
  contractFingerprint: string;
}

export class AcceptedArtifactService {
  private readonly checkpointBuilder: AcceptedArtifactCheckpointBuilder;

  constructor(private readonly options: AcceptedArtifactServiceOptions) {
    this.checkpointBuilder = options.checkpointBuilder ?? new LocalAcceptedArtifactCheckpointBuilder();
  }

  async complete_accepted_artifact(input: CompleteAcceptedArtifactInput): Promise<CompleteAcceptedArtifactResult> {
    return this.completeAcceptedArtifact(input);
  }

  async completeAcceptedArtifact(input: CompleteAcceptedArtifactInput): Promise<CompleteAcceptedArtifactResult> {
    try {
      return await this.performCompletion(input);
    } catch (error) {
      if (error instanceof AcceptedArtifactCompletionError) throw error;
      if (error instanceof SymphonyError) {
        if (error.code === "tracker_error" || error.code === "tracker_unavailable") {
          throw new AcceptedArtifactCompletionError(
            "transient",
            "github_or_tracker_failure",
            error.message,
            error.details,
          );
        }
        if (error.code === "invalid_request" || error.code === "config_validation_error") {
          throw new AcceptedArtifactCompletionError(
            "permanent_github_access_or_configuration",
            "github_access_or_configuration",
            error.message,
            error.details,
          );
        }
        if (error.code === "not_found") {
          throw new AcceptedArtifactCompletionError(
            "contract_or_head_drift",
            "pull_request_or_branch_drift",
            error.message,
            error.details,
          );
        }
        if (error.code === "conflict" || error.code === "workspace_error") {
          throw new AcceptedArtifactCompletionError(
            "contract_or_head_drift",
            "source_checkpoint_drift",
            error.message,
            error.details,
          );
        }
      }
      throw new AcceptedArtifactCompletionError(
        "transient",
        "unexpected_failure",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async performCompletion(input: CompleteAcceptedArtifactInput): Promise<CompleteAcceptedArtifactResult> {
    const review = await this.validateReview(input.issue);
    const artifactId = acceptedArtifactId(review);
    let replayed = false;
    let artifact = review.lifecycle.acceptedArtifact ?? null;
    if (artifact !== null && isSupersededLifecycleRecord(artifact)) {
      artifact = null;
    }

    if (artifact !== null) {
      this.validateExistingCheckpoint(artifact, review, artifactId);
      replayed = true;
    } else {
      if (input.workspacePath === null || input.workspacePath.trim().length === 0) {
        throw new AcceptedArtifactCompletionError(
          "contract_or_head_drift",
          "source_checkpoint_drift",
          "Accepted-artifact checkpoint requires the source worktree before the draft PR can be closed",
        );
      }
      await this.validateLivePullRequest(review, "open");
      const fileManifest = await this.checkpointBuilder.build({
        workspacePath: input.workspacePath,
        sourceBaseHeadSha: review.sourceBaseHeadSha,
        sourceHeadSha: review.pullRequest.headSha,
        changedFiles: review.report.changedFiles,
      });
      validateArtifactTestFiles(review.report, fileManifest);
      const now = new Date().toISOString();
      artifact = {
        id: artifactId,
        version: 1,
        kind: "expected_red_tests",
        status: "checkpointed",
        sourceIssueId: input.issue.id,
        sourceIssueIdentifier: input.issue.identifier,
        contractFingerprint: review.contractFingerprint,
        completionReportId: review.report.id,
        reviewVerdictId: review.verdict.id,
        reviewFeedbackId: review.feedback.id,
        repositoryFingerprint: repositoryFingerprint(this.options.config),
        pullRequest: {
          ...review.report.pullRequest!,
          draft: true,
        },
        sourceBaseHeadSha: review.sourceBaseHeadSha,
        sourceHeadSha: review.pullRequest.headSha,
        baseRef: review.baseRef,
        changedFiles: [...review.report.changedFiles],
        fileManifest,
        artifactEvidence: review.report.artifactEvidence!,
        commentOperationKey: acceptedArtifactCommentOperationKey(input.issue.id, artifactId),
        doneTransitionOperationKey: acceptedArtifactDoneOperationKey(
          input.issue.id,
          artifactId,
          this.options.config.mergePolicy.doneState,
        ),
        acceptedAt: review.verdict.submittedAt,
        checkpointedAt: now,
        prClosedAt: null,
        completedAt: null,
      };
      const checkpointed = await this.options.lifecycleStore.updateIssue(input.issue, { acceptedArtifact: artifact });
      artifact = checkpointed.acceptedArtifact ?? null;
      if (artifact === null) {
        throw new AcceptedArtifactCompletionError(
          "unexpected_merged_or_irrecoverable_checkpoint",
          "irrecoverable_checkpoint",
          "Accepted-artifact checkpoint was not persisted",
        );
      }
    }

    const planned = planAcceptedArtifactCompletionWritebacks(
      {
        issue: input.issue,
        artifact,
        fromStates: acceptedArtifactCompletionSourceStates(this.options.config),
        doneState: this.options.config.mergePolicy.doneState,
      },
      this.options.config,
    );
    if (planned.length !== 2) {
      throw new AcceptedArtifactCompletionError(
        "unexpected_merged_or_irrecoverable_checkpoint",
        "irrecoverable_checkpoint",
        "Accepted-artifact completion writebacks could not be planned before draft PR closure",
      );
    }

    await this.validateRemoteBranch(artifact);
    const livePullRequest = await this.validateLivePullRequest(review, "open_or_closed");
    if (livePullRequest.state?.toLowerCase() !== "closed") {
      try {
        await this.options.client.closePullRequest({
          pullRequestNumber: review.pullRequest.number,
          expectedHeadSha: artifact.sourceHeadSha,
        });
      } catch (error) {
        if (error instanceof SymphonyError && error.code === "conflict") {
          const raced = await this.options.client.getPullRequest({ pullRequestNumber: review.pullRequest.number });
          if (pullRequestWasMerged(raced)) {
            throw unexpectedMergedError();
          }
          throw new AcceptedArtifactCompletionError(
            "contract_or_head_drift",
            "pull_request_or_branch_drift",
            error.message,
            error.details,
          );
        }
        throw error;
      }
    }
    const closedPullRequest = await this.validateLivePullRequest(review, "closed");
    if (closedPullRequest.merged === true || closedPullRequest.state?.toLowerCase() !== "closed") {
      throw new AcceptedArtifactCompletionError(
        "unexpected_merged_or_irrecoverable_checkpoint",
        "irrecoverable_checkpoint",
        "Accepted-artifact draft PR closure could not be verified",
      );
    }

    if (artifact.status !== "completed_unmerged") {
      const completedAt = new Date().toISOString();
      const completed = await this.options.lifecycleStore.updateIssue(input.issue, {
        acceptedArtifact: {
          ...artifact,
          status: "completed_unmerged",
          prClosedAt: completedAt,
          completedAt,
        },
      });
      artifact = completed.acceptedArtifact ?? null;
      if (artifact === null) {
        throw new AcceptedArtifactCompletionError(
          "unexpected_merged_or_irrecoverable_checkpoint",
          "irrecoverable_checkpoint",
          "Completed accepted-artifact record was not persisted",
        );
      }
    }

    const enqueued: WritebackOperation[] = [];
    for (const operation of planned) {
      enqueued.push(
        this.options.writebackProcessor?.enqueueAndProcess
          ? await this.options.writebackProcessor.enqueueAndProcess(operation, {
              retrySkipped: true,
            })
          : await this.options.writebackOutbox.enqueueOnce(operation),
      );
    }
    if (enqueued.length > 0 && this.options.writebackProcessor && !this.options.writebackProcessor.enqueueAndProcess) {
      await this.options.writebackProcessor.processDue({
        idempotencyKeys: enqueued.map((operation) => operation.idempotencyKey),
      });
    }
    const writebackOperations = await Promise.all(
      enqueued.map(async (operation) => (await this.options.writebackOutbox.get(operation.idempotencyKey)) ?? operation),
    );
    return {
      status: "completed_unmerged",
      replayed,
      artifact,
      writebackOperations,
      writebacksSettled: writebackOperations.every((operation) => operation.status === "succeeded"),
    };
  }

  private async validateReview(issue: Issue): Promise<ValidatedAcceptedArtifactReview> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (lifecycle === null) {
      throw new AcceptedArtifactCompletionError(
        "unexpected_merged_or_irrecoverable_checkpoint",
        "irrecoverable_checkpoint",
        "Accepted-artifact completion requires durable lifecycle state",
      );
    }
    if (!sameStateIn(issue.state, acceptedArtifactCompletionSourceStates(this.options.config))) {
      throw new SymphonyError(
        "conflict",
        "Accepted-artifact completion requires the issue to remain in review or an unmerged review-pass state",
      );
    }
    if (lifecycle.phase !== "passed") {
      throw new SymphonyError("conflict", "Accepted-artifact completion requires a persisted pass verdict");
    }
    if (lifecycle.merge !== null) {
      throw unexpectedMergedError();
    }

    const parsedContract = parseIssueContract(issue.description);
    if (!parsedContract.valid) {
      throw new SymphonyError("conflict", "Accepted-artifact Issue Contract is missing or invalid", {
        errors: parsedContract.errors,
      });
    }
    if (
      parsedContract.contract.delivery.mode !== "accepted_artifact" ||
      parsedContract.contract.delivery.artifact !== "expected_red_tests"
    ) {
      throw new SymphonyError("conflict", "Current Issue Contract no longer declares expected-red accepted-artifact delivery");
    }

    const report = latestCurrentCompletionReport(lifecycle);
    if (!report) throw new SymphonyError("conflict", "Accepted-artifact completion report is not current");
    const snapshot = report.contractSnapshot;
    if (
      !snapshot ||
      snapshot.delivery.mode !== "accepted_artifact" ||
      snapshot.delivery.artifact !== "expected_red_tests" ||
      snapshot.fingerprint !== parsedContract.fingerprint ||
      snapshot.schemaVersion !== parsedContract.contract.schemaVersion ||
      snapshot.contractVersion !== parsedContract.contract.contractVersion
    ) {
      throw new SymphonyError("conflict", "Issue Contract changed after the accepted-artifact completion report");
    }
    if (!report.artifactEvidence || report.artifactEvidence.kind !== "expected_red_tests") {
      throw new SymphonyError("conflict", "Accepted-artifact completion report lacks expected-red evidence");
    }
    if (!Number.isInteger(report.artifactEvidence.exitCode) || report.artifactEvidence.exitCode <= 0) {
      throw new SymphonyError("conflict", "Accepted-artifact evidence must record an intentional nonzero exit code");
    }
    if (report.dependencyArtifactResult) {
      throw new SymphonyError("conflict", "Accepted-artifact source report cannot contain dependency artifact results");
    }

    const pullRequest = requiredPullRequest(report.pullRequest);
    if (report.pullRequest?.draft !== true) {
      throw new SymphonyError("conflict", "Accepted-artifact completion requires a draft pull request");
    }
    const acceptanceContext = report.acceptanceContext;
    const sourceBaseHeadSha = fullObjectId(acceptanceContext?.baseHeadSha, "source base head");
    const sourceHeadSha = fullObjectId(pullRequest.headSha, "source head");
    if (
      acceptanceContext?.worktreeHeadSha !== sourceHeadSha ||
      acceptanceContext.pullRequestHeadSha !== sourceHeadSha ||
      acceptanceContext.worktreeDirty !== false ||
      acceptanceContext.worktreeStatus !== "clean"
    ) {
      throw new SymphonyError("conflict", "Accepted-artifact completion report does not bind a clean source checkpoint");
    }
    const configuredBaseRef = this.options.config.workspace.source.baseRef?.trim() ?? "";
    if (configuredBaseRef.length === 0 || acceptanceContext.baseRef?.trim() !== configuredBaseRef) {
      throw new SymphonyError("conflict", "Accepted-artifact completion report base ref does not match configuration");
    }

    const verdict = lifecycle.reviewVerdicts.find((candidate) => candidate.id === lifecycle.lastReviewVerdictId);
    if (
      !verdict ||
      verdict.verdict !== "pass" ||
      verdict.passDisposition !== "accepted_artifact" ||
      isSupersededLifecycleRecord(verdict)
    ) {
      throw new SymphonyError("conflict", "Accepted-artifact completion requires the current accepted-artifact pass verdict");
    }
    if (Date.parse(verdict.submittedAt) < Date.parse(report.acceptedAt)) {
      throw new SymphonyError("conflict", "Accepted-artifact pass verdict predates the current completion report");
    }
    const feedback = lifecycle.reviewFeedback.find(
      (candidate) =>
        candidate.runId === verdict.runId &&
        candidate.kind === "review" &&
        candidate.event === "COMMENT" &&
        candidate.pullRequest.number === pullRequest.number &&
        candidate.pullRequest.headSha === sourceHeadSha,
    );
    if (!feedback) {
      throw new SymphonyError(
        "conflict",
        "Accepted-artifact completion requires lifecycle-bound COMMENT review feedback on the reviewed head",
      );
    }

    return {
      lifecycle,
      report,
      verdict,
      feedback,
      pullRequest: { ...pullRequest, headSha: sourceHeadSha },
      sourceBaseHeadSha,
      baseRef: configuredBaseRef,
      contractFingerprint: parsedContract.fingerprint,
    };
  }

  private validateExistingCheckpoint(
    artifact: IssueAcceptedArtifactRecord,
    review: ValidatedAcceptedArtifactReview,
    artifactId: string,
  ): void {
    if (
      artifact.id !== artifactId ||
      artifact.sourceIssueId !== review.lifecycle.issueId ||
      artifact.sourceIssueIdentifier !== review.lifecycle.issueIdentifier ||
      artifact.contractFingerprint !== review.contractFingerprint ||
      artifact.completionReportId !== review.report.id ||
      artifact.reviewVerdictId !== review.verdict.id ||
      artifact.reviewFeedbackId !== review.feedback.id ||
      artifact.sourceBaseHeadSha !== review.sourceBaseHeadSha ||
      artifact.sourceHeadSha !== review.pullRequest.headSha ||
      artifact.baseRef !== review.baseRef ||
      artifact.repositoryFingerprint !== repositoryFingerprint(this.options.config) ||
      artifact.pullRequest.number !== review.pullRequest.number ||
      artifact.pullRequest.branch !== review.pullRequest.branch ||
      artifact.pullRequest.draft !== true ||
      !sameStringSet(artifact.changedFiles, review.report.changedFiles) ||
      artifact.fileManifest.length === 0 ||
      JSON.stringify(artifact.artifactEvidence) !== JSON.stringify(review.report.artifactEvidence) ||
      artifact.commentOperationKey !== acceptedArtifactCommentOperationKey(review.lifecycle.issueId, artifactId) ||
      artifact.doneTransitionOperationKey !==
        acceptedArtifactDoneOperationKey(
          review.lifecycle.issueId,
          artifactId,
          this.options.config.mergePolicy.doneState,
        ) ||
      (artifact.status === "completed_unmerged" &&
        (artifact.prClosedAt === null || artifact.completedAt === null))
    ) {
      throw new AcceptedArtifactCompletionError(
        "unexpected_merged_or_irrecoverable_checkpoint",
        "irrecoverable_checkpoint",
        "Durable accepted-artifact checkpoint does not match the current review",
      );
    }
  }

  private async validateRemoteBranch(artifact: IssueAcceptedArtifactRecord): Promise<void> {
    const branch = artifact.pullRequest.branch?.trim() ?? "";
    if (branch.length === 0) throw new SymphonyError("conflict", "Accepted-artifact source branch is missing");
    const remoteHead = await this.options.client.getBranchHeadSha({ branchName: branch });
    if (remoteHead.toLowerCase() !== artifact.sourceHeadSha.toLowerCase()) {
      throw new SymphonyError(
        "conflict",
        `Accepted-artifact source branch moved from ${artifact.sourceHeadSha} to ${remoteHead}`,
      );
    }
  }

  private async validateLivePullRequest(
    review: ValidatedAcceptedArtifactReview,
    expectedState: "open" | "closed" | "open_or_closed",
  ): Promise<PullRequestDetails> {
    const live = await this.options.client.getPullRequest({ pullRequestNumber: review.pullRequest.number });
    if (
      live.number !== review.pullRequest.number ||
      live.headSha?.toLowerCase() !== review.pullRequest.headSha.toLowerCase() ||
      live.headBranch !== review.pullRequest.branch ||
      live.draft !== true
    ) {
      throw new SymphonyError("conflict", "Accepted-artifact draft PR no longer matches the reviewed head and branch");
    }
    if (pullRequestWasMerged(live)) {
      throw unexpectedMergedError();
    }
    const state = live.state?.toLowerCase() ?? "";
    const validState =
      expectedState === "open_or_closed" ? state === "open" || state === "closed" : state === expectedState;
    if (!validState) {
      throw new SymphonyError("conflict", `Accepted-artifact draft PR has unexpected state ${live.state ?? "unknown"}`);
    }
    return live;
  }
}

export class LocalAcceptedArtifactCheckpointBuilder implements AcceptedArtifactCheckpointBuilder {
  constructor(private readonly timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {}

  async build(input: AcceptedArtifactCheckpointInput): Promise<ArtifactFileManifestEntry[]> {
    const workspacePath = path.resolve(input.workspacePath);
    const [repoRoot, localHead, sourceBaseHeadSha, sourceHeadSha] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], workspacePath, this.timeoutMs),
      runGit(["rev-parse", "HEAD"], workspacePath, this.timeoutMs),
      resolveExactCommit(workspacePath, input.sourceBaseHeadSha, "source base head", this.timeoutMs),
      resolveExactCommit(workspacePath, input.sourceHeadSha, "source head", this.timeoutMs),
    ]);
    if (path.resolve(repoRoot.stdout.trim()) !== workspacePath) {
      throw new SymphonyError("conflict", "Accepted-artifact checkpoint path is not the source worktree root");
    }
    if (localHead.stdout.trim().toLowerCase() !== sourceHeadSha.toLowerCase()) {
      throw new SymphonyError("conflict", "Accepted-artifact source worktree moved after review");
    }
    await assertAncestor(workspacePath, sourceBaseHeadSha, sourceHeadSha, this.timeoutMs);
    const manifest = await buildFileManifest(workspacePath, sourceBaseHeadSha, sourceHeadSha, this.timeoutMs);
    if (manifest.length === 0) {
      throw new SymphonyError("conflict", "Accepted-artifact source checkpoint has no changed files");
    }
    if (!sameStringSet(manifest.map((entry) => entry.path), input.changedFiles)) {
      throw new SymphonyError("conflict", "Accepted-artifact changedFiles do not match the exact git checkpoint diff");
    }
    return manifest;
  }
}

function acceptedArtifactId(review: ValidatedAcceptedArtifactReview): string {
  const digest = createHash("sha256")
    .update(
      [
        review.lifecycle.issueId,
        review.report.id,
        review.verdict.id,
        review.feedback.id,
        review.contractFingerprint,
        review.pullRequest.headSha,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return `accepted-artifact-${digest}`;
}

function unexpectedMergedError(): AcceptedArtifactCompletionError {
  return new AcceptedArtifactCompletionError(
    "unexpected_merged_or_irrecoverable_checkpoint",
    "unexpected_merged_pull_request",
    "Accepted-artifact draft PR was merged unexpectedly",
  );
}

function pullRequestWasMerged(
  pullRequest: Pick<PullRequestDetails, "merged" | "mergedAt">,
): boolean {
  return pullRequest.merged === true || pullRequest.mergedAt !== null;
}

function acceptedArtifactCompletionSourceStates(config: ServiceConfig): string[] {
  return [
    ...new Set([
      ...config.reviewLoop.reviewStates,
      ...(config.reviewLoop.reviewPassState === null
        ? []
        : [config.reviewLoop.reviewPassState]),
      ...config.mergePolicy.sourceStates,
    ]),
  ];
}

function acceptedArtifactCommentOperationKey(issueId: string, artifactId: string): string {
  return `comment:${issueId}:accepted-artifact:${artifactId}:completed-unmerged`;
}

function acceptedArtifactDoneOperationKey(issueId: string, artifactId: string, doneState: string): string {
  return `transition:${issueId}:accepted-artifact:${artifactId}:${safeKeySegment(doneState)}`;
}

function repositoryFingerprint(config: ServiceConfig): string {
  const repository = config.workspace.source.repository?.trim() ?? "";
  if (repository.length === 0) {
    throw new SymphonyError("conflict", "Accepted-artifact completion requires a configured git repository");
  }
  return workspaceRepositoryFingerprint(repository);
}

function requiredPullRequest(
  pullRequest: CompletionReportPullRequestRef | null,
): Omit<CompletionReportPullRequestRef, "number" | "headSha" | "branch"> & {
  number: number;
  headSha: string;
  branch: string;
} {
  if (
    pullRequest === null ||
    !Number.isInteger(pullRequest.number) ||
    (pullRequest.number ?? 0) <= 0 ||
    !pullRequest.headSha ||
    !pullRequest.branch
  ) {
    throw new SymphonyError("conflict", "Accepted-artifact completion requires a lifecycle-bound pull request");
  }
  return pullRequest as Omit<CompletionReportPullRequestRef, "number" | "headSha" | "branch"> & {
    number: number;
    headSha: string;
    branch: string;
  };
}

function validateArtifactTestFiles(
  report: IssueCompletionReportRecord,
  manifest: ArtifactFileManifestEntry[],
): void {
  const evidence = report.artifactEvidence;
  if (!evidence) throw new SymphonyError("conflict", "Accepted-artifact evidence is missing");
  const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));
  for (const testFile of evidence.testFiles) {
    const entry = manifestByPath.get(testFile);
    if (!entry || entry.status === "deleted") {
      throw new SymphonyError(
        "conflict",
        `Expected-red test file ${testFile} is not present in the accepted-artifact checkpoint`,
      );
    }
  }
}

async function buildFileManifest(
  workspacePath: string,
  sourceBaseHeadSha: string,
  sourceHeadSha: string,
  timeoutMs: number,
): Promise<ArtifactFileManifestEntry[]> {
  const diff = await runGit(
    ["diff", "--name-status", "-z", "--find-renames", sourceBaseHeadSha, sourceHeadSha, "--"],
    workspacePath,
    timeoutMs,
  );
  const fields = diff.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: Array<Omit<ArtifactFileManifestEntry, "blobSha" | "mode">> = [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++];
    const code = rawStatus?.[0];
    if (!code) throw new SymphonyError("conflict", "Unable to parse accepted-artifact git diff status");
    if (code === "R") {
      index += 1;
      const destination = fields[index++];
      if (!destination) throw new SymphonyError("conflict", "Unable to parse accepted-artifact rename");
      entries.push({ path: normalizedRepositoryPath(destination), status: "renamed" });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new SymphonyError("conflict", "Unable to parse accepted-artifact git diff path");
    const status =
      code === "A"
        ? "added"
        : code === "M" || code === "T"
          ? "modified"
          : code === "D"
            ? "deleted"
            : null;
    if (status === null) {
      throw new SymphonyError("conflict", `Unsupported accepted-artifact git change status ${rawStatus}`);
    }
    entries.push({ path: normalizedRepositoryPath(filePath), status });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  const manifest: ArtifactFileManifestEntry[] = [];
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new SymphonyError("conflict", `Accepted-artifact path repeated: ${entry.path}`);
    paths.add(entry.path);
    if (entry.status === "deleted") {
      manifest.push({ ...entry, blobSha: null, mode: null });
      continue;
    }
    const treeEntry = await treeBlobEntry(
      workspacePath,
      sourceHeadSha,
      entry.path,
      timeoutMs,
    );
    manifest.push({
      ...entry,
      blobSha: treeEntry.blobSha,
      mode: treeEntry.mode,
    });
  }
  return manifest;
}

async function treeBlobEntry(
  workspacePath: string,
  commitSha: string,
  filePath: string,
  timeoutMs: number,
): Promise<{
  blobSha: string;
  mode: Exclude<ArtifactFileManifestEntry["mode"], null | undefined>;
}> {
  const result = await runGit(
    ["ls-tree", "-z", commitSha, "--", `:(literal)${filePath}`],
    workspacePath,
    timeoutMs,
  );
  const tab = result.stdout.indexOf("\t");
  const match =
    tab < 0
      ? null
      : /^(100644|100755|120000) blob ([0-9a-f]{40,64})$/i.exec(
          result.stdout.slice(0, tab),
        );
  if (match === null) {
    throw new SymphonyError("conflict", `Unable to resolve accepted-artifact blob for ${filePath}`);
  }
  return {
    mode: match[1]!.toLowerCase() as Exclude<
      ArtifactFileManifestEntry["mode"],
      null | undefined
    >,
    blobSha: match[2]!,
  };
}

async function resolveExactCommit(
  workspacePath: string,
  expectedSha: string,
  label: string,
  timeoutMs: number,
): Promise<string> {
  const expected = fullObjectId(expectedSha, label);
  const result = await runGit(["rev-parse", "--verify", `${expected}^{commit}`], workspacePath, timeoutMs);
  const resolved = result.stdout.trim();
  if (resolved.toLowerCase() !== expected.toLowerCase()) {
    throw new SymphonyError("conflict", `${label} does not resolve to the exact reviewed object`);
  }
  return resolved;
}

async function assertAncestor(
  workspacePath: string,
  ancestor: string,
  descendant: string,
  timeoutMs: number,
): Promise<void> {
  const result = await runGit(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    workspacePath,
    timeoutMs,
    true,
  );
  if (result.code !== 0) {
    throw new SymphonyError("conflict", "Accepted-artifact source base is not an ancestor of the reviewed head");
  }
}

function fullObjectId(value: string | null | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9a-f]{40,64}$/i.test(normalized)) {
    throw new SymphonyError("conflict", `Accepted-artifact ${label} must be a full git object ID`);
  }
  return normalized;
}

function normalizedRepositoryPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.startsWith("../")
  ) {
    throw new SymphonyError("conflict", `Invalid accepted-artifact repository path ${JSON.stringify(value)}`);
  }
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...new Set(left.map((value) => value.trim()))].sort();
  const normalizedRight = [...new Set(right.map((value) => value.trim()))].sort();
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function sameStateIn(state: string, candidates: readonly string[]): boolean {
  const normalized = state.trim().toLowerCase();
  return candidates.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

function safeKeySegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-") || "unknown";
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  allowFailure = false,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new SymphonyError("conflict", `Accepted-artifact git command timed out: git ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 128_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 128_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        reject(
          new SymphonyError(
            "conflict",
            `Accepted-artifact git command failed: git ${args.join(" ")}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}
