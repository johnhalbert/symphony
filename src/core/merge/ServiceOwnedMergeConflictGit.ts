import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fetchAndVerifyLocalRemoteBaseRef } from "../BaseRefVerification.js";
import { SymphonyError } from "../errors.js";
import type {
  IssuePreservedWorktreeStash,
  IssuePreservedWorktreeStashSource,
} from "../persistence/IssueLifecycleStore.js";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const SERVICE_GIT_NAME = "Symphony";
const SERVICE_GIT_EMAIL = "symphony@users.noreply.github.com";
const SERVICE_GIT_JOURNAL_VERSION = 1;

export type ServiceOwnedMergeConflictGitMutation =
  | "preserve_stash"
  | "apply_stash"
  | "prepare_rebase"
  | "publish_prepared_head"
  | "finalize_rebase"
  | "finalize_stash_apply"
  | "local_refresh_reset";

export interface ServiceOwnedMergeConflictGitOptions {
  journalDir?: string;
  afterMutation?: (
    mutation: ServiceOwnedMergeConflictGitMutation,
  ) => void | Promise<void>;
}

export interface ServiceOwnedMergeConflictPreparationInput {
  workspacePath: string;
  branchName: string;
  expectedHeadSha: string;
  baseBranch: string;
  observedPrBaseHeadSha: string | null;
  liveBaseHeadSha: string;
  authHeader: string;
}

export interface ServiceOwnedLocalBaseRefreshInput {
  workspacePath: string;
  branchName: string;
  expectedHeadSha: string;
  baseBranch: string;
  liveBaseHeadSha: string;
  authHeader: string;
}

export type ServiceOwnedMergeConflictPreparationResult =
  | {
      status: "clean";
      originalHeadSha: string;
      observedPrBaseHeadSha: string | null;
      liveBaseHeadSha: string;
      preparedBaseHeadSha: string;
      mergeBaseSha: string;
      squashCommitSha: string | null;
      rebasedHeadSha: string;
      conflictedFiles: [];
    }
  | {
      status: "conflicted";
      originalHeadSha: string;
      observedPrBaseHeadSha: string | null;
      liveBaseHeadSha: string;
      preparedBaseHeadSha: string;
      mergeBaseSha: string;
      squashCommitSha: string | null;
      conflictedFiles: string[];
    };

export interface ServiceOwnedLocalBaseRefreshResult {
  status: "refreshed";
  originalHeadSha: string;
  liveBaseHeadSha: string;
  refreshedHeadSha: string;
  aheadCommitCount: number;
  behindCommitCount: number;
}

export interface ServiceOwnedMergeConflictFinalizationInput {
  workspacePath: string;
  branchName: string;
  previousRemoteHeadSha: string;
  preparedBaseHeadSha: string;
  baseBranch: string;
  conflictedFiles: string[];
  changedFiles: string[];
  authHeader: string;
}

export type ServiceOwnedMergeConflictFinalizationResult =
  | {
      status?: "finalized";
      newHeadSha: string;
    }
  | {
      status: "prepared_base_ref_drift";
      newHeadSha: string;
      refName: string;
      actualSha: string;
      expectedSha: string;
      baseBranch: string;
    };

export interface ServiceOwnedPreserveWorktreeInput {
  workspacePath: string;
  branchName: string;
  baseBranch: string | null;
  operationId: string;
  source: IssuePreservedWorktreeStashSource;
  message?: string;
}

export type ServiceOwnedPreservedStashApplyResult =
  | {
      status: "clean";
      stash: IssuePreservedWorktreeStash;
      changedFiles: string[];
      headSha: string;
    }
  | {
      status: "conflicted";
      stash: IssuePreservedWorktreeStash;
      changedFiles: string[];
      conflictedFiles: string[];
      headSha: string;
    };

export interface ServiceOwnedStashApplyFinalizationInput {
  workspacePath: string;
  branchName: string;
  previousRemoteHeadSha: string;
  allowedFiles: string[];
  conflictedFiles: string[];
  changedFiles: string[];
  preservedStash: IssuePreservedWorktreeStash;
  authHeader: string;
  remoteBacked?: boolean;
}

export interface ServiceOwnedStashApplyFinalizationResult {
  newHeadSha: string;
  preservedStash: IssuePreservedWorktreeStash;
}

export interface PreparedBaseRefDriftDetails {
  kind: "prepared_base_ref_drift";
  refName: string;
  actualSha: string;
  expectedSha: string;
  baseBranch: string;
  finalizedHeadSha?: string;
}

type ServiceGitJournalPhase =
  | "intent"
  | "rebasing"
  | "conflicted"
  | "finalized"
  | "published"
  | "completed"
  | "consumed";

interface ServiceGitJournalBase {
  version: typeof SERVICE_GIT_JOURNAL_VERSION;
  id: string;
  kind:
    | "prepare"
    | "finalize"
    | "stash_finalize"
    | "local_refresh"
    | "preserve_stash"
    | "apply_stash";
  phase: ServiceGitJournalPhase;
  workspacePath: string;
  branchName: string;
  createdAt: string;
  updatedAt: string;
}

interface PrepareJournalRecord extends ServiceGitJournalBase {
  kind: "prepare";
  expectedHeadSha: string;
  baseBranch: string;
  observedPrBaseHeadSha: string | null;
  liveBaseHeadSha: string;
  mergeBaseSha: string;
  squashCommitSha: string | null;
  result: ServiceOwnedMergeConflictPreparationResult | null;
}

interface FinalizeJournalRecord extends ServiceGitJournalBase {
  kind: "finalize";
  previousRemoteHeadSha: string;
  preparedBaseHeadSha: string;
  baseBranch: string;
  allowedFiles: string[];
  reportedChangedFiles: string[];
  action: "continue" | "skip";
  rebaseOriginalHeadSha: string;
  expectedTreeSha: string;
  resultHeadSha: string | null;
}

interface StashFinalizeJournalRecord extends ServiceGitJournalBase {
  kind: "stash_finalize";
  previousRemoteHeadSha: string;
  allowedFiles: string[];
  conflictedFiles: string[];
  reportedChangedFiles: string[];
  preservedStashId: string;
  preservedStashOperationId: string;
  preservedStashRef: string;
  preservedStashSha: string;
  remoteBacked: boolean;
  action: "commit" | "noop";
  expectedTreeSha: string;
  resultHeadSha: string | null;
  result: ServiceOwnedStashApplyFinalizationResult | null;
}

interface LocalRefreshJournalRecord extends ServiceGitJournalBase {
  kind: "local_refresh";
  expectedHeadSha: string;
  baseBranch: string;
  liveBaseHeadSha: string;
  aheadCommitCount: number;
  behindCommitCount: number;
  result: ServiceOwnedLocalBaseRefreshResult | null;
}

interface PreserveStashJournalRecord extends ServiceGitJournalBase {
  kind: "preserve_stash";
  baseBranch: string | null;
  operationId: string;
  source: IssuePreservedWorktreeStashSource;
  message: string;
  gitMessage: string;
  generation: number;
  originalHeadSha: string;
  dirtyFiles: string[];
  stashId: string;
  stashRef: string;
  stashSha: string | null;
  result: IssuePreservedWorktreeStash | null;
}

interface ApplyStashJournalRecord extends ServiceGitJournalBase {
  kind: "apply_stash";
  preservedStashId: string;
  preservedStashOperationId: string;
  preservedStashRef: string;
  preservedStashSha: string;
  preApplyHeadSha: string;
  appliedAt: string;
  result: ServiceOwnedPreservedStashApplyResult | null;
}

type ServiceGitJournalRecord =
  | PrepareJournalRecord
  | FinalizeJournalRecord
  | StashFinalizeJournalRecord
  | LocalRefreshJournalRecord
  | PreserveStashJournalRecord
  | ApplyStashJournalRecord;

export class ServiceOwnedMergeConflictGit {
  constructor(
    private readonly options: ServiceOwnedMergeConflictGitOptions = {},
  ) {}

  async preserveDirtyWorktree(
    input: ServiceOwnedPreserveWorktreeInput,
  ): Promise<IssuePreservedWorktreeStash | null> {
    validateRefName(input.branchName, "PR branch");
    if (input.baseBranch !== null) validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const journal = this.journal();
    const message =
      input.message ??
      `Symphony preserved local changes for ${input.operationId}`;
    const baseIdentity = preserveStashBaseIdentity(input, message);
    const records = await journal.findPreserveStashes(baseIdentity);
    const active = records.find((record) => record.phase !== "consumed") ?? null;
    const dirtyFiles = await git.statusFiles();
    if (active !== null) {
      assertPreserveStashJournalMatches(active, input, message);
      if (active.phase === "intent") {
        if (
          dirtyFiles.length > 0 &&
          !sameStringArrays(sortedUnique(dirtyFiles), active.dirtyFiles)
        ) {
          throw invalidJournal(
            "Dirty worktree no longer matches the pending preservation journal",
          );
        }
        return this.resumePreserveDirtyWorktree(git, active, journal);
      }
      if (active.phase !== "completed" || active.result === null) {
        throw invalidJournal(`Unsupported stash preservation journal phase ${active.phase}`);
      }
      const stashSha = await git.optionalRefSha(active.stashRef);
      if (stashSha !== active.stashSha || stashSha !== active.result.stashSha) {
        throw invalidJournal(
          "Completed stash preservation journal does not match its custom ref",
        );
      }
      if (dirtyFiles.length > 0) {
        throw invalidJournal(
          "Worktree became dirty while a preserved stash is still pending",
        );
      }
      return active.result;
    }
    if (dirtyFiles.length === 0) return null;
    const originalHeadSha = await git.headSha();
    const stashId = `preserved-stash:${input.operationId}:${randomUUID()}`;
    const refName = `refs/symphony/preserved-stashes/${safeRefSegment(input.operationId)}/${randomUUID()}`;
    const generation =
      records.reduce((maximum, record) => Math.max(maximum, record.generation), 0) +
      1;
    const now = new Date().toISOString();
    const identity = { ...baseIdentity, generation };
    const id = serviceGitOperationId("preserve_stash", identity);
    const intent: PreserveStashJournalRecord = {
      version: SERVICE_GIT_JOURNAL_VERSION,
      id,
      kind: "preserve_stash",
      phase: "intent",
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      operationId: input.operationId,
      source: input.source,
      message,
      gitMessage: `${message} [symphony-journal:${id}]`,
      generation,
      originalHeadSha,
      dirtyFiles: sortedUnique(dirtyFiles),
      stashId,
      stashRef: refName,
      stashSha: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    await journal.write(intent);
    return this.resumePreserveDirtyWorktree(git, intent, journal);
  }

  async applyPreservedStash(input: {
    workspacePath: string;
    branchName: string;
    preservedStash: IssuePreservedWorktreeStash;
  }): Promise<ServiceOwnedPreservedStashApplyResult> {
    validateRefName(input.branchName, "PR branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const journal = this.journal();
    const identity = applyStashJournalIdentity(input);
    const existing = await journal.read<ApplyStashJournalRecord>(
      "apply_stash",
      identity,
    );
    if (existing !== null) {
      assertApplyStashJournalMatches(existing, input);
      if (existing.phase === "consumed") {
        throw invalidJournal("Preserved stash application was already consumed");
      }
      return this.resumeApplyPreservedStash(git, input, existing, journal);
    }
    await git.assertClean();
    const stashSha = await git.optionalRefSha(input.preservedStash.stashRef);
    if (stashSha !== input.preservedStash.stashSha) {
      throw invalidJournal("Preserved stash custom ref does not match its lifecycle record");
    }
    const now = new Date().toISOString();
    const intent: ApplyStashJournalRecord = {
      version: SERVICE_GIT_JOURNAL_VERSION,
      id: serviceGitOperationId("apply_stash", identity),
      kind: "apply_stash",
      phase: "intent",
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      preservedStashId: input.preservedStash.id,
      preservedStashOperationId: input.preservedStash.operationId,
      preservedStashRef: input.preservedStash.stashRef,
      preservedStashSha: input.preservedStash.stashSha,
      preApplyHeadSha: await git.headSha(),
      appliedAt: now,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    await journal.write(intent);
    return this.resumeApplyPreservedStash(git, input, intent, journal);
  }

  async dropPreservedStash(input: {
    workspacePath: string;
    preservedStash: IssuePreservedWorktreeStash;
  }): Promise<IssuePreservedWorktreeStash> {
    const git = new ServiceGit(input.workspacePath);
    const droppedAt = new Date().toISOString();
    try {
      const stashSha = await git.optionalRefSha(input.preservedStash.stashRef);
      if (stashSha !== null && stashSha !== input.preservedStash.stashSha) {
        throw invalidJournal(
          "Preserved stash custom ref no longer matches the recorded stash SHA",
        );
      }
      if (stashSha !== null) await git.deleteRef(input.preservedStash.stashRef);
      const dropped: IssuePreservedWorktreeStash = {
        ...input.preservedStash,
        status: "dropped",
        droppedAt,
        dropError: null,
      };
      await this.journal().markStashConsumed(input.preservedStash);
      return dropped;
    } catch (error) {
      return {
        ...input.preservedStash,
        status: "drop_failed",
        droppedAt: null,
        dropError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resumePreserveDirtyWorktree(
    git: ServiceGit,
    record: PreserveStashJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<IssuePreservedWorktreeStash> {
    if ((await git.headSha()) !== record.originalHeadSha) {
      throw invalidJournal(
        "Pending stash preservation journal does not match the current worktree head",
      );
    }
    let stashSha = await git.optionalRefSha(record.stashRef);
    if (stashSha === null) {
      const dirtyFiles = sortedUnique(await git.statusFiles());
      if (dirtyFiles.length > 0) {
        assertJournalArray(
          dirtyFiles,
          record.dirtyFiles,
          "dirty files awaiting preservation",
        );
        await git.stashPush(record.gitMessage);
        await this.afterMutation("preserve_stash");
      }
      stashSha = await git.optionalRefSha("refs/stash");
      if (stashSha === null) {
        throw invalidJournal(
          "Pending stash preservation has neither dirty files nor a recoverable stash entry",
        );
      }
      if (!(await git.commitMessage(stashSha)).includes(record.gitMessage)) {
        throw invalidJournal(
          "Latest stash entry does not match the server-owned preservation journal",
        );
      }
      await git.updateRef(record.stashRef, stashSha);
    } else if (!(await git.commitMessage(stashSha)).includes(record.gitMessage)) {
      throw invalidJournal(
        "Preserved stash custom ref does not match the journaled stash message",
      );
    }
    await git.assertClean();
    const latestStackSha = await git.optionalRefSha("refs/stash");
    if (latestStackSha === stashSha) {
      await git.dropLatestStashStackEntry();
    } else if (latestStackSha !== null) {
      throw invalidJournal(
        "A different stash entry appeared while finalizing preservation",
      );
    }
    const result: IssuePreservedWorktreeStash = {
      version: 1,
      id: record.stashId,
      operationId: record.operationId,
      source: record.source,
      stashRef: record.stashRef,
      stashSha,
      message: record.message,
      workspacePath: record.workspacePath,
      branchName: record.branchName,
      baseBranch: record.baseBranch,
      originalHeadSha: record.originalHeadSha,
      dirtyFiles: record.dirtyFiles,
      status: "created",
      conflictedFiles: [],
      createdAt: record.createdAt,
      appliedAt: null,
      droppedAt: null,
      dropError: null,
    };
    await journal.write({
      ...record,
      phase: "completed",
      stashSha,
      result,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }

  private async resumeApplyPreservedStash(
    git: ServiceGit,
    input: {
      workspacePath: string;
      branchName: string;
      preservedStash: IssuePreservedWorktreeStash;
    },
    record: ApplyStashJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<ServiceOwnedPreservedStashApplyResult> {
    if ((await git.headSha()) !== record.preApplyHeadSha) {
      throw invalidJournal(
        "Preserved stash application journal does not match the current worktree head",
      );
    }
    if (record.phase === "completed") {
      if (record.result === null) {
        throw invalidJournal("Completed stash application journal has no result");
      }
      await assertAppliedStashResult(git, record.result);
      return record.result;
    }
    if (record.phase !== "intent") {
      throw invalidJournal(`Unsupported stash application journal phase ${record.phase}`);
    }
    const stashSha = await git.optionalRefSha(record.preservedStashRef);
    if (stashSha !== record.preservedStashSha) {
      throw invalidJournal(
        "Preserved stash application journal no longer matches its custom ref",
      );
    }
    const alreadyChanged = (await git.statusFiles()).length > 0;
    const apply = alreadyChanged
      ? null
      : await git.applyStash(input.preservedStash.stashRef);
    if (apply !== null) await this.afterMutation("apply_stash");
    const conflictedFiles = sortedUnique(await git.conflictedFiles());
    const changedFiles = sortedUnique(await git.workerTouchedFiles());
    const allowedFiles = new Set(
      input.preservedStash.dirtyFiles.map(normalizeRepoPath),
    );
    const outsideAllowed = sortedUnique([
      ...changedFiles,
      ...conflictedFiles,
    ]).filter((file) => !allowedFiles.has(file));
    if (outsideAllowed.length > 0) {
      throw invalidJournal(
        `Journaled stash application touched files outside the preserved stash set: ${outsideAllowed.join(", ")}`,
      );
    }
    const headSha = await git.headSha();
    if (conflictedFiles.length === 0 && apply !== null && apply.code !== 0) {
      throw new SymphonyError(
        "invalid_request",
        `Preserved worktree stash apply failed without file conflicts: ${apply.stderr.trim() || apply.stdout.trim()}`,
      );
    }
    if (changedFiles.length === 0) {
      throw invalidJournal(
        "Journaled preserved stash application produced no recoverable worktree changes",
      );
    }
    const result: ServiceOwnedPreservedStashApplyResult =
      conflictedFiles.length === 0
        ? {
            status: "clean",
            stash: {
              ...input.preservedStash,
              status: "applied_clean",
              appliedAt: record.appliedAt,
              conflictedFiles: [],
              dropError: null,
            },
            changedFiles,
            headSha,
          }
        : {
            status: "conflicted",
            stash: {
              ...input.preservedStash,
              status: "apply_conflicted",
              appliedAt: record.appliedAt,
              conflictedFiles,
              dropError: null,
            },
            changedFiles,
            conflictedFiles,
            headSha,
          };
    await journal.write({
      ...record,
      phase: "completed",
      result,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }

  async prepare(
    input: ServiceOwnedMergeConflictPreparationInput,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    return this.prepareInternal(input, false);
  }

  async reprepareAfterBaseDrift(
    input: ServiceOwnedMergeConflictPreparationInput,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    return this.prepareInternal(input, true);
  }

  private async prepareInternal(
    input: ServiceOwnedMergeConflictPreparationInput,
    resetExistingRebase: boolean,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    validateRefName(input.branchName, "PR branch");
    validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const journal = this.journal();
    const identity = prepareJournalIdentity(input);
    const existing = await journal.read<PrepareJournalRecord>(
      "prepare",
      identity,
    );
    if (existing !== null) {
      assertPrepareJournalMatches(existing, input);
      const resumed = await this.resumePreparation(
        git,
        input,
        existing,
        journal,
      );
      if (resumed !== null) return resumed;
    }

    if (resetExistingRebase || existing !== null) {
      await git.abortRebaseIfInProgress();
      await git.resetHard(input.expectedHeadSha);
    }
    await git.assertClean();
    return this.prepareFromCleanWorkspace(git, input, journal, existing);
  }

  async publishPreparedHead(input: {
    workspacePath: string;
    branchName: string;
    previousRemoteHeadSha: string;
    authHeader: string;
  }): Promise<void> {
    validateRefName(input.branchName, "PR branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.assertNoRebaseInProgress();
    await git.assertClean();
    const journal = this.journal();
    const localHeadSha = await git.headSha();
    const preparation = await journal.findPublishedPreparation({
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      previousRemoteHeadSha: input.previousRemoteHeadSha,
      resultHeadSha: localHeadSha,
    });
    if (preparation === null) {
      throw new SymphonyError(
        "invalid_request",
        "Prepared head publication requires an exact server-owned finalized preparation journal",
      );
    }
    await assertFinalizedPreparation(git, input.authHeader, preparation);
    await git.fetchBranch(input.branchName, input.authHeader);
    const remoteHeadSha = await git.refSha(
      `refs/remotes/origin/${input.branchName}`,
    );
    if (
      remoteHeadSha !== input.previousRemoteHeadSha &&
      remoteHeadSha !== localHeadSha
    ) {
      throw new SymphonyError(
        "invalid_request",
        `Remote PR head resolved to ${remoteHeadSha}, not expected PR head ${input.previousRemoteHeadSha}`,
      );
    }
    if (preparation.phase === "published" && remoteHeadSha !== localHeadSha) {
      throw invalidJournal(
        "Published preparation journal no longer matches the remote PR head",
      );
    }
    if (remoteHeadSha !== localHeadSha) {
      await git.pushForceWithLease(
        input.branchName,
        input.previousRemoteHeadSha,
        input.authHeader,
      );
      await this.afterMutation("publish_prepared_head");
    }
    if (preparation.phase !== "published") {
      await journal.write({
        ...preparation,
        phase: "published",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async refreshLocalBranchBase(
    input: ServiceOwnedLocalBaseRefreshInput,
  ): Promise<ServiceOwnedLocalBaseRefreshResult> {
    validateRefName(input.branchName, "worktree branch");
    validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.assertClean();
    const journal = this.journal();
    const identity = localRefreshJournalIdentity(input);
    const existing = await journal.read<LocalRefreshJournalRecord>(
      "local_refresh",
      identity,
    );
    if (existing !== null) {
      assertLocalRefreshJournalMatches(existing, input);
      const resumed = await resumeLocalRefresh(git, input, existing, journal);
      if (resumed !== null) return resumed;
    }
    const localHeadSha = await git.headSha();
    if (localHeadSha !== input.expectedHeadSha) {
      throw new SymphonyError(
        "invalid_request",
        `HEAD resolved to ${localHeadSha}, not expected worktree head ${input.expectedHeadSha}`,
      );
    }
    await git.assertRefSha("HEAD", input.expectedHeadSha, "expected worktree head");
    await fetchAndVerifyLocalRemoteBaseRef({
      workspacePath: input.workspacePath,
      baseRef: input.baseBranch,
      expectedBaseHeadSha: input.liveBaseHeadSha,
      authHeader: input.authHeader,
      errorMessageLabel: "expected live base",
    });
    await git.ensureCommit(input.expectedHeadSha);
    await git.ensureCommit(input.liveBaseHeadSha);
    const counts = await git.revListLeftRightCount(
      input.expectedHeadSha,
      input.liveBaseHeadSha,
    );
    if (counts.left > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Local-only base refresh would discard ${counts.left} local commit(s) not in the live base; worker inspection is required`,
      );
    }
    const now = new Date().toISOString();
    const intent: LocalRefreshJournalRecord = {
      version: SERVICE_GIT_JOURNAL_VERSION,
      id: serviceGitOperationId("local_refresh", identity),
      kind: "local_refresh",
      phase: "intent",
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      expectedHeadSha: input.expectedHeadSha,
      baseBranch: input.baseBranch,
      liveBaseHeadSha: input.liveBaseHeadSha,
      aheadCommitCount: counts.left,
      behindCommitCount: counts.right,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    await journal.write(intent);
    await git.resetHard(input.liveBaseHeadSha);
    await this.afterMutation("local_refresh_reset");
    const refreshedHeadSha = await git.headSha();
    if (refreshedHeadSha !== input.liveBaseHeadSha) {
      throw new SymphonyError(
        "invalid_request",
        "Local base refresh did not land on the journaled live base head",
      );
    }
    const result: ServiceOwnedLocalBaseRefreshResult = {
      status: "refreshed",
      originalHeadSha: input.expectedHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      refreshedHeadSha,
      aheadCommitCount: counts.left,
      behindCommitCount: counts.right,
    };
    await journal.write({
      ...intent,
      phase: "finalized",
      result,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }

  async finalize(
    input: ServiceOwnedMergeConflictFinalizationInput,
  ): Promise<ServiceOwnedMergeConflictFinalizationResult> {
    validateRefName(input.branchName, "PR branch");
    validateRefName(input.baseBranch, "base branch");
    const allowedFiles = sortedUnique(
      input.conflictedFiles.map(normalizeRepoPath),
    );
    const reportedChangedFiles = sortedUnique(
      input.changedFiles.map(normalizeRepoPath),
    );
    const allowed = new Set(allowedFiles);
    const changed = reportedChangedFiles;
    const outside = changed.filter((file) => !allowed.has(file));
    if (outside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Merge conflict repair changed files outside the service-prepared conflict set: ${outside.join(", ")}`,
      );
    }

    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const journal = this.journal();
    const identity = finalizeJournalIdentity(input, {
      allowedFiles,
      reportedChangedFiles,
    });
    const existing = await journal.read<FinalizeJournalRecord>(
      "finalize",
      identity,
    );
    if (existing !== null) {
      assertFinalizeJournalMatches(existing, input, {
        allowedFiles,
        reportedChangedFiles,
      });
      return this.resumeFinalization(git, input, existing, journal);
    }

    await git.fetchBranch(input.branchName, input.authHeader);
    const remoteRef = `refs/remotes/origin/${input.branchName}`;
    await git.assertRefSha(remoteRef, input.previousRemoteHeadSha, "expected PR head");
    const workerTouchedFiles = await git.workerTouchedFiles();
    const actualOutside = workerTouchedFiles.filter((file) => !allowed.has(file));
    if (actualOutside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Merge conflict repair touched files outside the service-prepared conflict set: ${actualOutside.join(", ")}`,
      );
    }
    for (const file of allowedFiles) {
      await assertNoConflictMarkers(path.join(input.workspacePath, file));
    }
    await git.add(allowedFiles);
    if ((await git.unmergedEntries()).length > 0) {
      throw new SymphonyError("invalid_request", "Merge conflict repair still has unmerged index entries");
    }
    const preparedHeadSha = await git.headSha();
    if (preparedHeadSha !== input.preparedBaseHeadSha) {
      throw new SymphonyError(
        "invalid_request",
        `Service-owned conflict repair HEAD ${preparedHeadSha} does not match prepared base ${input.preparedBaseHeadSha}`,
      );
    }
    const rebaseMetadata = await git.requireRebaseMetadata();
    if (rebaseMetadata.onto !== input.preparedBaseHeadSha) {
      throw new SymphonyError(
        "invalid_request",
        "Service-owned conflict repair rebase is not bound to the prepared base",
      );
    }
    const expectedTreeSha = await git.writeTree();
    const action = (await git.hasStagedDiff()) ? "continue" : "skip";
    const now = new Date().toISOString();
    const intent: FinalizeJournalRecord = {
      version: SERVICE_GIT_JOURNAL_VERSION,
      id: serviceGitOperationId("finalize", identity),
      kind: "finalize",
      phase: "intent",
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      previousRemoteHeadSha: input.previousRemoteHeadSha,
      preparedBaseHeadSha: input.preparedBaseHeadSha,
      baseBranch: input.baseBranch,
      allowedFiles,
      reportedChangedFiles,
      action,
      rebaseOriginalHeadSha: rebaseMetadata.originalHeadSha,
      expectedTreeSha,
      resultHeadSha: null,
      createdAt: now,
      updatedAt: now,
    };
    await journal.write(intent);
    if (action === "continue") {
      await git.rebaseContinue();
    } else {
      await git.rebaseSkip();
    }
    await this.afterMutation("finalize_rebase");
    const newHeadSha = await git.headSha();
    await assertFinalizedRebaseHead(git, intent, newHeadSha);
    const finalized: FinalizeJournalRecord = {
      ...intent,
      phase: "finalized",
      resultHeadSha: newHeadSha,
      updatedAt: new Date().toISOString(),
    };
    await journal.write(finalized);
    return this.publishFinalizedRepair(git, input, finalized, journal);
  }

  async finalizeStashApply(
    input: ServiceOwnedStashApplyFinalizationInput,
  ): Promise<ServiceOwnedStashApplyFinalizationResult> {
    validateRefName(input.branchName, "PR branch");
    const allowedFiles = sortedUnique(input.allowedFiles.map(normalizeRepoPath));
    const conflictedFiles = sortedUnique(
      input.conflictedFiles.map(normalizeRepoPath),
    );
    const reportedChangedFiles = sortedUnique(
      input.changedFiles.map(normalizeRepoPath),
    );
    const allowed = new Set(allowedFiles);
    const changed = reportedChangedFiles;
    const outside = changed.filter((file) => !allowed.has(file));
    if (outside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Stash-apply repair changed files outside the preserved local changes set: ${outside.join(", ")}`,
      );
    }

    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const remoteBacked = input.remoteBacked !== false;
    const journal = this.journal();
    const identity = stashFinalizeJournalIdentity(input, {
      allowedFiles,
      conflictedFiles,
      reportedChangedFiles,
      remoteBacked,
    });
    const existing = await journal.read<StashFinalizeJournalRecord>(
      "stash_finalize",
      identity,
    );
    if (existing !== null) {
      assertStashFinalizeJournalMatches(existing, input, {
        allowedFiles,
        conflictedFiles,
        reportedChangedFiles,
        remoteBacked,
      });
      return this.resumeStashFinalization(git, input, existing, journal);
    }
    if (remoteBacked) {
      await git.fetchBranch(input.branchName, input.authHeader);
      await git.assertRefSha(
        `refs/remotes/origin/${input.branchName}`,
        input.previousRemoteHeadSha,
        "expected PR head",
      );
    }
    const actualTouchedFiles = await git.workerTouchedFiles();
    const actualOutside = actualTouchedFiles.filter((file) => !allowed.has(file));
    if (actualOutside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Stash-apply repair touched files outside the preserved local changes set: ${actualOutside.join(", ")}`,
      );
    }
    for (const file of conflictedFiles) {
      await assertNoConflictMarkers(path.join(input.workspacePath, file));
    }
    await git.add(actualTouchedFiles.filter((file) => allowed.has(file)));
    if ((await git.unmergedEntries()).length > 0) {
      throw new SymphonyError("invalid_request", "Stash-apply repair still has unmerged index entries");
    }
    const previousHeadSha = await git.headSha();
    if (previousHeadSha !== input.previousRemoteHeadSha) {
      throw new SymphonyError(
        "invalid_request",
        `Stash-apply repair HEAD ${previousHeadSha} does not match expected pre-repair head ${input.previousRemoteHeadSha}`,
      );
    }
    const expectedTreeSha = await git.writeTree();
    const action = (await git.hasStagedDiff()) ? "commit" : "noop";
    const now = new Date().toISOString();
    const intent: StashFinalizeJournalRecord = {
      version: SERVICE_GIT_JOURNAL_VERSION,
      id: serviceGitOperationId("stash_finalize", identity),
      kind: "stash_finalize",
      phase: "intent",
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      previousRemoteHeadSha: input.previousRemoteHeadSha,
      allowedFiles,
      conflictedFiles,
      reportedChangedFiles,
      preservedStashId: input.preservedStash.id,
      preservedStashOperationId: input.preservedStash.operationId,
      preservedStashRef: input.preservedStash.stashRef,
      preservedStashSha: input.preservedStash.stashSha,
      remoteBacked,
      action,
      expectedTreeSha,
      resultHeadSha: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    await journal.write(intent);
    if (action === "commit") {
      await git.commit(
        "Symphony preserved local changes repair",
        "Finalize preserved local changes after service-owned base-ref repair.",
      );
    }
    await this.afterMutation("finalize_stash_apply");
    const newHeadSha = await git.headSha();
    await assertFinalizedStashHead(git, intent, newHeadSha);
    const finalized: StashFinalizeJournalRecord = {
      ...intent,
      phase: "finalized",
      resultHeadSha: newHeadSha,
      updatedAt: new Date().toISOString(),
    };
    await journal.write(finalized);
    return this.publishAndCompleteStashFinalization(
      git,
      input,
      finalized,
      journal,
    );
  }

  private async prepareFromCleanWorkspace(
    git: ServiceGit,
    input: ServiceOwnedMergeConflictPreparationInput,
    journal: ServiceGitJournal,
    previous: PrepareJournalRecord | null,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    await git.fetchBranch(input.branchName, input.authHeader);
    await git.assertRefSha(
      `refs/remotes/origin/${input.branchName}`,
      input.expectedHeadSha,
      "expected PR head",
    );
    await fetchAndVerifyLocalRemoteBaseRef({
      workspacePath: input.workspacePath,
      baseRef: input.baseBranch,
      expectedBaseHeadSha: input.liveBaseHeadSha,
      authHeader: input.authHeader,
      errorMessageLabel: "expected live base",
    });
    await git.ensureCommit(input.expectedHeadSha);
    await git.ensureCommit(input.liveBaseHeadSha);
    const mergeBaseSha = await git.mergeBase(
      input.expectedHeadSha,
      input.liveBaseHeadSha,
    );
    const now = new Date().toISOString();
    const intent: PrepareJournalRecord = {
      version: SERVICE_GIT_JOURNAL_VERSION,
      id: serviceGitOperationId("prepare", prepareJournalIdentity(input)),
      kind: "prepare",
      phase: "intent",
      workspacePath: normalizedWorkspacePath(input.workspacePath),
      branchName: input.branchName,
      expectedHeadSha: input.expectedHeadSha,
      baseBranch: input.baseBranch,
      observedPrBaseHeadSha: input.observedPrBaseHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      mergeBaseSha,
      squashCommitSha: null,
      result: null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await journal.write(intent);
    await git.resetHard(input.expectedHeadSha);
    await git.resetSoft(mergeBaseSha);
    if (!(await git.hasStagedDiff())) {
      await git.resetHard(input.expectedHeadSha);
      throw new SymphonyError(
        "invalid_request",
        "Service-owned conflict preparation found no PR-side changes to squash",
      );
    }
    await git.commit(
      "Symphony service-owned merge-conflict prep",
      "Squash lifecycle-bound PR changes before rebasing onto the live base.",
    );
    const squashCommitSha = await git.headSha();
    const rebasing: PrepareJournalRecord = {
      ...intent,
      phase: "rebasing",
      squashCommitSha,
      updatedAt: new Date().toISOString(),
    };
    await journal.write(rebasing);
    const rebase = await git.rebaseOnto(input.liveBaseHeadSha, mergeBaseSha);
    await this.afterMutation("prepare_rebase");
    if (rebase.code === 0) {
      const rebasedHeadSha = await git.headSha();
      const result: ServiceOwnedMergeConflictPreparationResult = {
        status: "clean",
        originalHeadSha: input.expectedHeadSha,
        observedPrBaseHeadSha: input.observedPrBaseHeadSha,
        liveBaseHeadSha: input.liveBaseHeadSha,
        preparedBaseHeadSha: input.liveBaseHeadSha,
        mergeBaseSha,
        squashCommitSha,
        rebasedHeadSha,
        conflictedFiles: [],
      };
      const finalized: PrepareJournalRecord = {
        ...rebasing,
        phase: "finalized",
        result,
        updatedAt: new Date().toISOString(),
      };
      await assertFinalizedPreparation(git, input.authHeader, finalized);
      await journal.write(finalized);
      return result;
    }

    const conflictedFiles = await git.conflictedFiles();
    if (conflictedFiles.length === 0) {
      throw new SymphonyError(
        "invalid_request",
        `Service-owned rebase failed without file conflicts: ${rebase.stderr.trim() || rebase.stdout.trim()}`,
      );
    }
    const result: ServiceOwnedMergeConflictPreparationResult = {
      status: "conflicted",
      originalHeadSha: input.expectedHeadSha,
      observedPrBaseHeadSha: input.observedPrBaseHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      preparedBaseHeadSha: input.liveBaseHeadSha,
      mergeBaseSha,
      squashCommitSha,
      conflictedFiles,
    };
    await journal.write({
      ...rebasing,
      phase: "conflicted",
      result,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }

  private async resumePreparation(
    git: ServiceGit,
    input: ServiceOwnedMergeConflictPreparationInput,
    record: PrepareJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<ServiceOwnedMergeConflictPreparationResult | null> {
    if (record.phase === "finalized" || record.phase === "published") {
      if (record.result?.status !== "clean") {
        throw invalidJournal("Finalized preparation journal has no clean result");
      }
      await assertFinalizedPreparation(git, input.authHeader, record);
      await git.fetchBranch(input.branchName, input.authHeader);
      const remoteHeadSha = await git.refSha(
        `refs/remotes/origin/${input.branchName}`,
      );
      const resultHeadSha = record.result.rebasedHeadSha;
      if (
        remoteHeadSha !== input.expectedHeadSha &&
        remoteHeadSha !== resultHeadSha
      ) {
        throw invalidJournal(
          `Journaled preparation does not match remote PR head ${remoteHeadSha}`,
        );
      }
      if (record.phase === "published" && remoteHeadSha !== resultHeadSha) {
        throw invalidJournal("Published preparation journal no longer matches the remote PR head");
      }
      if (record.phase === "finalized" && remoteHeadSha === resultHeadSha) {
        await journal.write({
          ...record,
          phase: "published",
          updatedAt: new Date().toISOString(),
        });
      }
      return record.result;
    }

    if (record.phase === "conflicted") {
      if (record.result?.status !== "conflicted") {
        throw invalidJournal("Conflicted preparation journal has no conflict result");
      }
      await assertJournaledPreparationConflict(git, input, record);
      return record.result;
    }

    if (record.phase === "rebasing" && (await git.isRebaseInProgress())) {
      if (record.squashCommitSha === null) {
        throw invalidJournal("Rebasing preparation journal has no squash commit");
      }
      await assertJournaledRebaseMetadata(
        git,
        input.liveBaseHeadSha,
        record.squashCommitSha,
      );
      const conflictedFiles = await git.conflictedFiles();
      if (conflictedFiles.length === 0) {
        throw invalidJournal("Journaled preparation rebase has no recoverable conflicts");
      }
      const result: ServiceOwnedMergeConflictPreparationResult = {
        status: "conflicted",
        originalHeadSha: input.expectedHeadSha,
        observedPrBaseHeadSha: input.observedPrBaseHeadSha,
        liveBaseHeadSha: input.liveBaseHeadSha,
        preparedBaseHeadSha: input.liveBaseHeadSha,
        mergeBaseSha: record.mergeBaseSha,
        squashCommitSha: record.squashCommitSha,
        conflictedFiles,
      };
      await journal.write({
        ...record,
        phase: "conflicted",
        result,
        updatedAt: new Date().toISOString(),
      });
      return result;
    }

    if (record.phase !== "intent" && record.phase !== "rebasing") {
      throw invalidJournal(`Unsupported preparation journal phase ${record.phase}`);
    }
    return null;
  }

  private async resumeFinalization(
    git: ServiceGit,
    input: ServiceOwnedMergeConflictFinalizationInput,
    record: FinalizeJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<ServiceOwnedMergeConflictFinalizationResult> {
    let current = record;
    if (current.phase === "intent") {
      if (await git.isRebaseInProgress()) {
        await assertJournaledRebaseMetadata(
          git,
          current.preparedBaseHeadSha,
          current.rebaseOriginalHeadSha,
        );
        if ((await git.unmergedEntries()).length > 0) {
          throw invalidJournal("Journaled conflict finalization regained unmerged index entries");
        }
        if ((await git.writeTree()) !== current.expectedTreeSha) {
          throw invalidJournal("Journaled conflict finalization index tree changed before resume");
        }
        if (current.action === "continue") await git.rebaseContinue();
        else await git.rebaseSkip();
        await this.afterMutation("finalize_rebase");
      }
      const resultHeadSha = await git.headSha();
      await assertFinalizedRebaseHead(git, current, resultHeadSha);
      current = {
        ...current,
        phase: "finalized",
        resultHeadSha,
        updatedAt: new Date().toISOString(),
      };
      await journal.write(current);
    }
    if (current.phase !== "finalized" && current.phase !== "published") {
      throw invalidJournal(`Unsupported conflict finalization journal phase ${current.phase}`);
    }
    if (current.resultHeadSha === null) {
      throw invalidJournal("Finalized conflict journal has no result head");
    }
    await assertFinalizedRebaseHead(git, current, current.resultHeadSha);
    return this.publishFinalizedRepair(git, input, current, journal);
  }

  private async publishFinalizedRepair(
    git: ServiceGit,
    input: ServiceOwnedMergeConflictFinalizationInput,
    record: FinalizeJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<ServiceOwnedMergeConflictFinalizationResult> {
    const resultHeadSha = requireJournalHead(record.resultHeadSha);
    await git.fetchBranch(input.branchName, input.authHeader);
    const remoteHeadSha = await git.refSha(
      `refs/remotes/origin/${input.branchName}`,
    );
    if (
      remoteHeadSha !== input.previousRemoteHeadSha &&
      remoteHeadSha !== resultHeadSha
    ) {
      throw invalidJournal(
        `Journaled conflict repair head ${resultHeadSha} does not match remote PR head ${remoteHeadSha}`,
      );
    }
    if (record.phase === "published" && remoteHeadSha !== resultHeadSha) {
      throw invalidJournal("Published conflict repair journal no longer matches the remote PR head");
    }
    if (remoteHeadSha !== resultHeadSha) {
      await git.pushForceWithLease(
        input.branchName,
        input.previousRemoteHeadSha,
        input.authHeader,
      );
    }
    if (record.phase !== "published") {
      await journal.write({
        ...record,
        phase: "published",
        updatedAt: new Date().toISOString(),
      });
    }
    return verifyFinalizedPreparedBase(input, resultHeadSha);
  }

  private async resumeStashFinalization(
    git: ServiceGit,
    input: ServiceOwnedStashApplyFinalizationInput,
    record: StashFinalizeJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<ServiceOwnedStashApplyFinalizationResult> {
    let current = record;
    if (current.phase === "completed") {
      if (current.result === null || current.resultHeadSha === null) {
        throw invalidJournal("Completed stash finalization journal has no result");
      }
      await assertFinalizedStashHead(git, current, current.resultHeadSha);
      await assertStashRemoteMatches(git, input, current, true);
      return current.result;
    }
    if (current.phase === "intent") {
      const headSha = await git.headSha();
      if (headSha === current.previousRemoteHeadSha) {
        if ((await git.unmergedEntries()).length > 0) {
          throw invalidJournal("Journaled stash finalization regained unmerged index entries");
        }
        if ((await git.writeTree()) !== current.expectedTreeSha) {
          throw invalidJournal("Journaled stash finalization index tree changed before resume");
        }
        if (current.action === "commit") {
          await git.commit(
            "Symphony preserved local changes repair",
            "Finalize preserved local changes after service-owned base-ref repair.",
          );
          await this.afterMutation("finalize_stash_apply");
        }
      }
      const resultHeadSha = await git.headSha();
      await assertFinalizedStashHead(git, current, resultHeadSha);
      current = {
        ...current,
        phase: "finalized",
        resultHeadSha,
        updatedAt: new Date().toISOString(),
      };
      await journal.write(current);
    }
    if (current.phase !== "finalized" && current.phase !== "published") {
      throw invalidJournal(`Unsupported stash finalization journal phase ${current.phase}`);
    }
    return this.publishAndCompleteStashFinalization(
      git,
      input,
      current,
      journal,
    );
  }

  private async publishAndCompleteStashFinalization(
    git: ServiceGit,
    input: ServiceOwnedStashApplyFinalizationInput,
    record: StashFinalizeJournalRecord,
    journal: ServiceGitJournal,
  ): Promise<ServiceOwnedStashApplyFinalizationResult> {
    const resultHeadSha = requireJournalHead(record.resultHeadSha);
    await assertFinalizedStashHead(git, record, resultHeadSha);
    await assertStashRemoteMatches(git, input, record, record.phase === "published");
    if (record.remoteBacked) {
      const remoteHeadSha = await git.refSha(
        `refs/remotes/origin/${input.branchName}`,
      );
      if (remoteHeadSha !== resultHeadSha) {
        await git.pushForceWithLease(
          input.branchName,
          input.previousRemoteHeadSha,
          input.authHeader,
        );
      }
    }
    const published: StashFinalizeJournalRecord =
      record.phase === "published"
        ? record
        : {
            ...record,
            phase: "published",
            updatedAt: new Date().toISOString(),
          };
    if (published !== record) await journal.write(published);
    const dropped = await this.dropPreservedStash({
      workspacePath: input.workspacePath,
      preservedStash: {
        ...input.preservedStash,
        status: "finalized",
      },
    });
    const result: ServiceOwnedStashApplyFinalizationResult = {
      newHeadSha: resultHeadSha,
      preservedStash:
        dropped.status === "drop_failed"
          ? dropped
          : { ...dropped, status: "dropped" },
    };
    await journal.write({
      ...published,
      phase: "completed",
      result,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }

  private journal(): ServiceGitJournal {
    const journalDir = this.options.journalDir?.trim();
    if (!journalDir) {
      throw new SymphonyError(
        "invalid_request",
        "Service-owned Git operations require a server-owned journal directory",
      );
    }
    return new ServiceGitJournal(journalDir);
  }

  private async afterMutation(
    mutation: ServiceOwnedMergeConflictGitMutation,
  ): Promise<void> {
    await this.options.afterMutation?.(mutation);
  }
}

class ServiceGit {
  constructor(private readonly workspacePath: string) {}

  async assertCurrentBranch(branchName: string): Promise<void> {
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current === branchName) return;
    const rebaseHeadName = await this.rebaseHeadName();
    if (normalizeBranchRef(rebaseHeadName) === branchName) return;
    throw new SymphonyError("invalid_request", `Worktree is on ${current || "detached HEAD"}, not ${branchName}`);
  }

  async assertClean(): Promise<void> {
    const status = (await this.git(["status", "--porcelain=v1", "-uall"])).stdout.trim();
    if (status.length > 0) throw new SymphonyError("invalid_request", "Service-owned conflict preparation requires a clean worktree");
  }

  async statusFiles(): Promise<string[]> {
    return normalizeGitPathLines((await this.git(["status", "--porcelain=v1", "-uall"])).stdout);
  }

  async stashPush(message: string): Promise<void> {
    await this.git(["stash", "push", "--include-untracked", "-m", message]);
  }

  async dropLatestStashStackEntry(): Promise<void> {
    await this.git(["stash", "drop", "stash@{0}"]);
  }

  async applyStash(stashRef: string): Promise<GitResult> {
    return this.git(["stash", "apply", stashRef], { allowFailure: true });
  }

  async updateRef(refName: string, sha: string): Promise<void> {
    await this.git(["update-ref", refName, sha]);
  }

  async deleteRef(refName: string): Promise<void> {
    await this.git(["update-ref", "-d", refName]);
  }

  async fetchBranch(branchName: string, authHeader: string): Promise<void> {
    await this.git([
      "-c",
      `http.extraheader=${authHeader}`,
      "fetch",
      "origin",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ]);
  }

  async assertRefSha(refName: string, expectedSha: string, label: string): Promise<void> {
    const actual = await this.refSha(refName);
    if (actual !== expectedSha) {
      throw new SymphonyError("invalid_request", `${refName} resolved to ${actual}, not ${label} ${expectedSha}`);
    }
  }

  async refSha(refName: string): Promise<string> {
    return (await this.git(["rev-parse", `${refName}^{commit}`])).stdout.trim();
  }

  async commitMessage(refName: string): Promise<string> {
    return (await this.git(["log", "-1", "--format=%B", refName])).stdout.trim();
  }

  async optionalRefSha(refName: string): Promise<string | null> {
    const result = await this.git(
      ["rev-parse", "--verify", `${refName}^{commit}`],
      { allowFailure: true },
    );
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async ensureCommit(sha: string): Promise<void> {
    await this.git(["cat-file", "-e", `${sha}^{commit}`]);
  }

  async resetHard(sha: string): Promise<void> {
    await this.git(["reset", "--hard", sha]);
  }

  async resetSoft(sha: string): Promise<void> {
    await this.git(["reset", "--soft", sha]);
  }

  async mergeBase(left: string, right: string): Promise<string> {
    return (await this.git(["merge-base", left, right])).stdout.trim();
  }

  async writeTree(): Promise<string> {
    return (await this.git(["write-tree"])).stdout.trim();
  }

  async treeSha(refName: string): Promise<string> {
    return (await this.git(["rev-parse", `${refName}^{tree}`])).stdout.trim();
  }

  async parentShas(refName: string): Promise<string[]> {
    const line = (
      await this.git(["rev-list", "--parents", "-n", "1", refName])
    ).stdout.trim();
    return line.split(/\s+/u).slice(1);
  }

  async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
    const result = await this.git(
      ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
      { allowFailure: true },
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new SymphonyError(
      "invalid_request",
      "Unable to verify checkpointed service-owned Git ancestry",
    );
  }

  async revListLeftRightCount(
    left: string,
    right: string,
  ): Promise<{ left: number; right: number }> {
    const output = (
      await this.git(["rev-list", "--left-right", "--count", `${left}...${right}`])
    ).stdout.trim();
    const counts = output.split(/\s+/).map((value) => Number(value));
    const leftCount = counts[0];
    const rightCount = counts[1];
    if (
      !Number.isFinite(leftCount) ||
      !Number.isFinite(rightCount)
    ) {
      throw new SymphonyError(
        "invalid_request",
        `Unable to parse local branch divergence: ${output}`,
      );
    }
    return { left: leftCount!, right: rightCount! };
  }

  async hasStagedDiff(): Promise<boolean> {
    const result = await this.git(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    throw new SymphonyError("invalid_request", "Unable to inspect staged service-owned conflict repair changes");
  }

  async commit(title: string, body: string): Promise<void> {
    await this.git([
      "-c",
      `user.name=${SERVICE_GIT_NAME}`,
      "-c",
      `user.email=${SERVICE_GIT_EMAIL}`,
      "commit",
      "-m",
      title,
      "-m",
      body,
    ]);
  }

  async rebaseOnto(newBaseSha: string, oldBaseSha: string): Promise<GitResult> {
    return this.git(
      [
        "-c",
        `user.name=${SERVICE_GIT_NAME}`,
        "-c",
        `user.email=${SERVICE_GIT_EMAIL}`,
        "rebase",
        "--onto",
        newBaseSha,
        oldBaseSha,
      ],
      { allowFailure: true },
    );
  }

  async conflictedFiles(): Promise<string[]> {
    return normalizeGitPathLines((await this.git(["diff", "--name-only", "--diff-filter=U"])).stdout);
  }

  async workerTouchedFiles(): Promise<string[]> {
    return sortedUnique([
      ...normalizeGitPathLines((await this.git(["diff", "--name-only"])).stdout),
      ...normalizeGitPathLines((await this.git(["ls-files", "--others", "--exclude-standard"])).stdout),
    ]);
  }

  async add(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.git(["add", "--", ...files]);
  }

  async unmergedEntries(): Promise<string[]> {
    return normalizeGitPathLines((await this.git(["ls-files", "-u"])).stdout);
  }

  async rebaseContinue(): Promise<void> {
    await this.git([
      "-c",
      `user.name=${SERVICE_GIT_NAME}`,
      "-c",
      `user.email=${SERVICE_GIT_EMAIL}`,
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    ]);
  }

  async rebaseSkip(): Promise<void> {
    await this.git(["rebase", "--skip"]);
  }

  async assertNoRebaseInProgress(): Promise<void> {
    if (await this.isRebaseInProgress()) {
      throw new SymphonyError("invalid_request", "Service-owned rebase is still in progress");
    }
  }

  async isRebaseInProgress(): Promise<boolean> {
    const rebaseMerge = (
      await this.git(["rev-parse", "--git-path", "rebase-merge"])
    ).stdout.trim();
    const rebaseApply = (
      await this.git(["rev-parse", "--git-path", "rebase-apply"])
    ).stdout.trim();
    return (
      (await exists(resolveGitPath(this.workspacePath, rebaseMerge))) ||
      (await exists(resolveGitPath(this.workspacePath, rebaseApply)))
    );
  }

  async requireRebaseMetadata(): Promise<{
    onto: string;
    originalHeadSha: string;
  }> {
    for (const directory of ["rebase-merge", "rebase-apply"]) {
      const gitDirectory = (
        await this.git(["rev-parse", "--git-path", directory])
      ).stdout.trim();
      const resolvedDirectory = resolveGitPath(this.workspacePath, gitDirectory);
      if (!(await exists(resolvedDirectory))) continue;
      const onto = await readRequiredGitMetadata(path.join(resolvedDirectory, "onto"));
      const originalHeadSha = await readRequiredGitMetadata(
        path.join(resolvedDirectory, "orig-head"),
      );
      return { onto, originalHeadSha };
    }
    throw new SymphonyError(
      "invalid_request",
      "Service-owned operation requires the journaled rebase to remain in progress",
    );
  }

  async abortRebaseIfInProgress(): Promise<void> {
    const rebaseMerge = (await this.git(["rev-parse", "--git-path", "rebase-merge"])).stdout.trim();
    const rebaseApply = (await this.git(["rev-parse", "--git-path", "rebase-apply"])).stdout.trim();
    if (!(await exists(resolveGitPath(this.workspacePath, rebaseMerge))) && !(await exists(resolveGitPath(this.workspacePath, rebaseApply)))) {
      return;
    }
    await this.git(["rebase", "--abort"]);
  }

  private async rebaseHeadName(): Promise<string | null> {
    const rebaseMerge = (await this.git(["rev-parse", "--git-path", "rebase-merge/head-name"])).stdout.trim();
    const rebaseApply = (await this.git(["rev-parse", "--git-path", "rebase-apply/head-name"])).stdout.trim();
    for (const filePath of [resolveGitPath(this.workspacePath, rebaseMerge), resolveGitPath(this.workspacePath, rebaseApply)]) {
      try {
        const value = (await fs.readFile(filePath, "utf8")).trim();
        if (value.length > 0) return value;
      } catch {
        // Not in this rebase mode.
      }
    }
    return null;
  }

  async pushForceWithLease(branchName: string, expectedRemoteHeadSha: string, authHeader: string): Promise<void> {
    await this.git([
      "-c",
      `http.extraheader=${authHeader}`,
      "push",
      `--force-with-lease=refs/heads/${branchName}:${expectedRemoteHeadSha}`,
      "origin",
      `HEAD:refs/heads/${branchName}`,
    ]);
  }

  async headSha(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  private git(args: string[], options: { allowFailure?: boolean } = {}): Promise<GitResult> {
    return runCommand("git", args, this.workspacePath, DEFAULT_GIT_TIMEOUT_MS, options);
  }
}

class ServiceGitJournal {
  private readonly recordsDir: string;

  constructor(stateDir: string) {
    this.recordsDir = path.join(
      normalizedWorkspacePath(stateDir),
      "service-git-journal",
    );
  }

  async read<T extends ServiceGitJournalRecord>(
    kind: ServiceGitJournalRecord["kind"],
    identity: Record<string, unknown>,
  ): Promise<T | null> {
    await this.ensureRecordsDir();
    const id = serviceGitOperationId(kind, identity);
    const record = await this.readPath(this.recordPath(kind, id));
    if (record === null) return null;
    if (record.kind !== kind || record.id !== id) {
      throw invalidJournal("Service-owned Git journal identity mismatch");
    }
    return record as T;
  }

  async write(record: ServiceGitJournalRecord): Promise<void> {
    await this.ensureRecordsDir();
    const target = this.recordPath(record.kind, record.id);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temp, target);
      const directory = await fs.open(this.recordsDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async findPublishedPreparation(input: {
    workspacePath: string;
    branchName: string;
    previousRemoteHeadSha: string;
    resultHeadSha: string;
  }): Promise<PrepareJournalRecord | null> {
    await this.ensureRecordsDir();
    const entries = await fs.readdir(this.recordsDir);
    const matches: PrepareJournalRecord[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("prepare-") || !entry.endsWith(".json")) continue;
      const record = await this.readPath(path.join(this.recordsDir, entry));
      if (
        record?.kind !== "prepare" ||
        (record.phase !== "finalized" && record.phase !== "published") ||
        record.workspacePath !== input.workspacePath ||
        record.branchName !== input.branchName ||
        record.expectedHeadSha !== input.previousRemoteHeadSha ||
        record.result?.status !== "clean" ||
        record.result.rebasedHeadSha !== input.resultHeadSha
      ) {
        continue;
      }
      matches.push(record);
    }
    if (matches.length > 1) {
      throw invalidJournal("Prepared head matches multiple service-owned journal records");
    }
    return matches[0] ?? null;
  }

  async findPreserveStashes(
    identity: ReturnType<typeof preserveStashBaseIdentity>,
  ): Promise<PreserveStashJournalRecord[]> {
    const records = await this.listRecords();
    return records
      .filter(
        (record): record is PreserveStashJournalRecord =>
          record.kind === "preserve_stash" &&
          record.workspacePath === identity.workspacePath &&
          record.branchName === identity.branchName &&
          record.baseBranch === identity.baseBranch &&
          record.operationId === identity.operationId &&
          record.source === identity.source &&
          record.message === identity.message,
      )
      .sort((left, right) => right.generation - left.generation);
  }

  async markStashConsumed(stash: IssuePreservedWorktreeStash): Promise<void> {
    for (const record of await this.listRecords()) {
      const matches =
        (record.kind === "preserve_stash" && record.stashId === stash.id) ||
        (record.kind === "apply_stash" &&
          record.preservedStashId === stash.id);
      if (!matches || record.phase === "consumed") continue;
      await this.write({
        ...record,
        phase: "consumed",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private recordPath(
    kind: ServiceGitJournalRecord["kind"],
    id: string,
  ): string {
    const digest = id.slice(id.indexOf(":") + 1);
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      throw invalidJournal("Service-owned Git journal has an invalid record ID");
    }
    return path.join(this.recordsDir, `${kind}-${digest}.json`);
  }

  private async readPath(filePath: string): Promise<ServiceGitJournalRecord | null> {
    let content: string;
    try {
      await fs.chmod(filePath, 0o600);
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw invalidJournal(`Service-owned Git journal is not valid JSON: ${filePath}`);
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== SERVICE_GIT_JOURNAL_VERSION ||
      typeof parsed.id !== "string" ||
      !isJournalKind(parsed.kind) ||
      typeof parsed.phase !== "string" ||
      typeof parsed.workspacePath !== "string" ||
      typeof parsed.branchName !== "string"
    ) {
      throw invalidJournal(`Service-owned Git journal is invalid: ${filePath}`);
    }
    return parsed as unknown as ServiceGitJournalRecord;
  }

  private async listRecords(): Promise<ServiceGitJournalRecord[]> {
    await this.ensureRecordsDir();
    const records: ServiceGitJournalRecord[] = [];
    for (const entry of await fs.readdir(this.recordsDir)) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readPath(path.join(this.recordsDir, entry));
      if (record !== null) records.push(record);
    }
    return records;
  }

  private async ensureRecordsDir(): Promise<void> {
    await fs.mkdir(this.recordsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.recordsDir, 0o700);
  }
}

function prepareJournalIdentity(
  input: ServiceOwnedMergeConflictPreparationInput,
): Record<string, unknown> {
  return {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    expectedHeadSha: input.expectedHeadSha,
    baseBranch: input.baseBranch,
    observedPrBaseHeadSha: input.observedPrBaseHeadSha,
    liveBaseHeadSha: input.liveBaseHeadSha,
  };
}

function finalizeJournalIdentity(
  input: ServiceOwnedMergeConflictFinalizationInput,
  normalized: { allowedFiles: string[]; reportedChangedFiles: string[] },
): Record<string, unknown> {
  return {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    previousRemoteHeadSha: input.previousRemoteHeadSha,
    preparedBaseHeadSha: input.preparedBaseHeadSha,
    baseBranch: input.baseBranch,
    allowedFiles: normalized.allowedFiles,
    reportedChangedFiles: normalized.reportedChangedFiles,
  };
}

function stashFinalizeJournalIdentity(
  input: ServiceOwnedStashApplyFinalizationInput,
  normalized: {
    allowedFiles: string[];
    conflictedFiles: string[];
    reportedChangedFiles: string[];
    remoteBacked: boolean;
  },
): Record<string, unknown> {
  return {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    previousRemoteHeadSha: input.previousRemoteHeadSha,
    allowedFiles: normalized.allowedFiles,
    conflictedFiles: normalized.conflictedFiles,
    reportedChangedFiles: normalized.reportedChangedFiles,
    preservedStashId: input.preservedStash.id,
    preservedStashOperationId: input.preservedStash.operationId,
    preservedStashRef: input.preservedStash.stashRef,
    preservedStashSha: input.preservedStash.stashSha,
    remoteBacked: normalized.remoteBacked,
  };
}

function localRefreshJournalIdentity(
  input: ServiceOwnedLocalBaseRefreshInput,
): Record<string, unknown> {
  return {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    expectedHeadSha: input.expectedHeadSha,
    baseBranch: input.baseBranch,
    liveBaseHeadSha: input.liveBaseHeadSha,
  };
}

function preserveStashBaseIdentity(
  input: ServiceOwnedPreserveWorktreeInput,
  message: string,
) {
  return {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    operationId: input.operationId,
    source: input.source,
    message,
  };
}

function applyStashJournalIdentity(input: {
  workspacePath: string;
  branchName: string;
  preservedStash: IssuePreservedWorktreeStash;
}): Record<string, unknown> {
  return {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    preservedStashId: input.preservedStash.id,
    preservedStashOperationId: input.preservedStash.operationId,
    preservedStashRef: input.preservedStash.stashRef,
    preservedStashSha: input.preservedStash.stashSha,
  };
}

function serviceGitOperationId(
  kind: ServiceGitJournalRecord["kind"],
  identity: Record<string, unknown>,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind, ...identity }))
    .digest("hex");
  return `${kind}:${digest}`;
}

function assertPrepareJournalMatches(
  record: PrepareJournalRecord,
  input: ServiceOwnedMergeConflictPreparationInput,
): void {
  assertJournalFields(record, {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    expectedHeadSha: input.expectedHeadSha,
    baseBranch: input.baseBranch,
    observedPrBaseHeadSha: input.observedPrBaseHeadSha,
    liveBaseHeadSha: input.liveBaseHeadSha,
  });
}

function assertFinalizeJournalMatches(
  record: FinalizeJournalRecord,
  input: ServiceOwnedMergeConflictFinalizationInput,
  normalized: { allowedFiles: string[]; reportedChangedFiles: string[] },
): void {
  assertJournalFields(record, {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    previousRemoteHeadSha: input.previousRemoteHeadSha,
    preparedBaseHeadSha: input.preparedBaseHeadSha,
    baseBranch: input.baseBranch,
  });
  assertJournalArray(record.allowedFiles, normalized.allowedFiles, "allowed files");
  assertJournalArray(
    record.reportedChangedFiles,
    normalized.reportedChangedFiles,
    "reported changed files",
  );
}

function assertStashFinalizeJournalMatches(
  record: StashFinalizeJournalRecord,
  input: ServiceOwnedStashApplyFinalizationInput,
  normalized: {
    allowedFiles: string[];
    conflictedFiles: string[];
    reportedChangedFiles: string[];
    remoteBacked: boolean;
  },
): void {
  assertJournalFields(record, {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    previousRemoteHeadSha: input.previousRemoteHeadSha,
    preservedStashId: input.preservedStash.id,
    preservedStashOperationId: input.preservedStash.operationId,
    preservedStashRef: input.preservedStash.stashRef,
    preservedStashSha: input.preservedStash.stashSha,
    remoteBacked: normalized.remoteBacked,
  });
  assertJournalArray(record.allowedFiles, normalized.allowedFiles, "allowed files");
  assertJournalArray(record.conflictedFiles, normalized.conflictedFiles, "conflicted files");
  assertJournalArray(
    record.reportedChangedFiles,
    normalized.reportedChangedFiles,
    "reported changed files",
  );
}

function assertLocalRefreshJournalMatches(
  record: LocalRefreshJournalRecord,
  input: ServiceOwnedLocalBaseRefreshInput,
): void {
  assertJournalFields(record, {
    workspacePath: normalizedWorkspacePath(input.workspacePath),
    branchName: input.branchName,
    expectedHeadSha: input.expectedHeadSha,
    baseBranch: input.baseBranch,
    liveBaseHeadSha: input.liveBaseHeadSha,
  });
}

function assertPreserveStashJournalMatches(
  record: PreserveStashJournalRecord,
  input: ServiceOwnedPreserveWorktreeInput,
  message: string,
): void {
  assertJournalFields(record, preserveStashBaseIdentity(input, message));
}

function assertApplyStashJournalMatches(
  record: ApplyStashJournalRecord,
  input: {
    workspacePath: string;
    branchName: string;
    preservedStash: IssuePreservedWorktreeStash;
  },
): void {
  assertJournalFields(record, applyStashJournalIdentity(input));
}

async function assertAppliedStashResult(
  git: ServiceGit,
  result: ServiceOwnedPreservedStashApplyResult,
): Promise<void> {
  if ((await git.headSha()) !== result.headSha) {
    throw invalidJournal(
      "Completed stash application journal does not match the current worktree head",
    );
  }
  const conflictedFiles = sortedUnique(await git.conflictedFiles());
  const expectedConflictedFiles =
    result.status === "conflicted" ? sortedUnique(result.conflictedFiles) : [];
  assertJournalArray(
    conflictedFiles,
    expectedConflictedFiles,
    "stash application conflicts",
  );
  assertJournalArray(
    sortedUnique(await git.workerTouchedFiles()),
    sortedUnique(result.changedFiles),
    "stash application changed files",
  );
}

async function resumeLocalRefresh(
  git: ServiceGit,
  input: ServiceOwnedLocalBaseRefreshInput,
  record: LocalRefreshJournalRecord,
  journal: ServiceGitJournal,
): Promise<ServiceOwnedLocalBaseRefreshResult | null> {
  await fetchAndVerifyLocalRemoteBaseRef({
    workspacePath: input.workspacePath,
    baseRef: input.baseBranch,
    expectedBaseHeadSha: input.liveBaseHeadSha,
    authHeader: input.authHeader,
    errorMessageLabel: "expected live base",
  });
  const headSha = await git.headSha();
  if (record.phase === "intent") {
    if (headSha === input.expectedHeadSha) return null;
    if (headSha !== input.liveBaseHeadSha) {
      throw invalidJournal("Local refresh intent does not match the current worktree head");
    }
    const result: ServiceOwnedLocalBaseRefreshResult = {
      status: "refreshed",
      originalHeadSha: input.expectedHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      refreshedHeadSha: input.liveBaseHeadSha,
      aheadCommitCount: record.aheadCommitCount,
      behindCommitCount: record.behindCommitCount,
    };
    await journal.write({
      ...record,
      phase: "finalized",
      result,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }
  if (record.phase !== "finalized" || record.result === null) {
    throw invalidJournal(`Unsupported local refresh journal phase ${record.phase}`);
  }
  if (headSha !== record.result.refreshedHeadSha || headSha !== input.liveBaseHeadSha) {
    throw invalidJournal("Finalized local refresh journal does not match the current worktree head");
  }
  return record.result;
}

async function assertFinalizedPreparation(
  git: ServiceGit,
  authHeader: string,
  record: PrepareJournalRecord,
): Promise<void> {
  if (record.result?.status !== "clean") {
    throw invalidJournal("Preparation journal has no clean finalized result");
  }
  await git.assertNoRebaseInProgress();
  await git.assertClean();
  const resultHeadSha = record.result.rebasedHeadSha;
  if ((await git.headSha()) !== resultHeadSha) {
    throw invalidJournal("Finalized preparation journal does not match the current worktree head");
  }
  const parents = await git.parentShas(resultHeadSha);
  if (
    parents.length !== 1 ||
    parents[0] !== record.liveBaseHeadSha ||
    !(await git.isAncestor(record.liveBaseHeadSha, resultHeadSha))
  ) {
    throw invalidJournal("Finalized preparation is not an exact child of the journaled live base");
  }
  await fetchAndVerifyLocalRemoteBaseRef({
    workspacePath: record.workspacePath,
    baseRef: record.baseBranch,
    expectedBaseHeadSha: record.liveBaseHeadSha,
    authHeader,
    errorMessageLabel: "journaled live base",
  });
}

async function assertJournaledPreparationConflict(
  git: ServiceGit,
  input: ServiceOwnedMergeConflictPreparationInput,
  record: PrepareJournalRecord,
): Promise<void> {
  if (record.result?.status !== "conflicted" || record.squashCommitSha === null) {
    throw invalidJournal("Conflicted preparation journal is incomplete");
  }
  await assertJournaledRebaseMetadata(
    git,
    record.liveBaseHeadSha,
    record.squashCommitSha,
  );
  const conflictedFiles = sortedUnique(await git.conflictedFiles());
  assertJournalArray(
    conflictedFiles,
    sortedUnique(record.result.conflictedFiles),
    "active conflicted files",
  );
  await git.fetchBranch(input.branchName, input.authHeader);
  await git.assertRefSha(
    `refs/remotes/origin/${input.branchName}`,
    input.expectedHeadSha,
    "journaled PR head",
  );
  await fetchAndVerifyLocalRemoteBaseRef({
    workspacePath: input.workspacePath,
    baseRef: input.baseBranch,
    expectedBaseHeadSha: input.liveBaseHeadSha,
    authHeader: input.authHeader,
    errorMessageLabel: "journaled live base",
  });
}

async function assertJournaledRebaseMetadata(
  git: ServiceGit,
  expectedOnto: string,
  expectedOriginalHeadSha: string,
): Promise<void> {
  const metadata = await git.requireRebaseMetadata();
  if (
    metadata.onto !== expectedOnto ||
    metadata.originalHeadSha !== expectedOriginalHeadSha
  ) {
    throw invalidJournal("Active rebase does not match the server-owned journal");
  }
}

async function assertFinalizedRebaseHead(
  git: ServiceGit,
  record: FinalizeJournalRecord,
  resultHeadSha: string,
): Promise<void> {
  await git.assertNoRebaseInProgress();
  await git.assertClean();
  if ((await git.headSha()) !== resultHeadSha) {
    throw invalidJournal("Journaled conflict finalization does not match the current worktree head");
  }
  if ((await git.treeSha(resultHeadSha)) !== record.expectedTreeSha) {
    throw invalidJournal("Journaled conflict finalization tree does not match the validated resolution tree");
  }
  if (record.action === "skip") {
    if (resultHeadSha !== record.preparedBaseHeadSha) {
      throw invalidJournal("Skipped conflict repair did not land on the prepared base");
    }
    return;
  }
  const parents = await git.parentShas(resultHeadSha);
  if (
    parents.length !== 1 ||
    parents[0] !== record.preparedBaseHeadSha ||
    !(await git.isAncestor(record.preparedBaseHeadSha, resultHeadSha))
  ) {
    throw invalidJournal("Finalized conflict repair is not an exact child of the prepared base");
  }
}

async function assertFinalizedStashHead(
  git: ServiceGit,
  record: StashFinalizeJournalRecord,
  resultHeadSha: string,
): Promise<void> {
  await git.assertClean();
  if ((await git.headSha()) !== resultHeadSha) {
    throw invalidJournal("Journaled stash finalization does not match the current worktree head");
  }
  if ((await git.treeSha(resultHeadSha)) !== record.expectedTreeSha) {
    throw invalidJournal("Journaled stash finalization tree does not match the validated resolution tree");
  }
  if (record.action === "noop") {
    if (resultHeadSha !== record.previousRemoteHeadSha) {
      throw invalidJournal("No-op stash finalization changed the worktree head");
    }
    return;
  }
  const parents = await git.parentShas(resultHeadSha);
  if (
    parents.length !== 1 ||
    parents[0] !== record.previousRemoteHeadSha ||
    !(await git.isAncestor(record.previousRemoteHeadSha, resultHeadSha))
  ) {
    throw invalidJournal("Finalized stash repair is not an exact child of the pre-repair head");
  }
}

async function assertStashRemoteMatches(
  git: ServiceGit,
  input: ServiceOwnedStashApplyFinalizationInput,
  record: StashFinalizeJournalRecord,
  publishedMustMatch: boolean,
): Promise<void> {
  if (!record.remoteBacked) return;
  const resultHeadSha = requireJournalHead(record.resultHeadSha);
  await git.fetchBranch(input.branchName, input.authHeader);
  const remoteHeadSha = await git.refSha(
    `refs/remotes/origin/${input.branchName}`,
  );
  if (
    remoteHeadSha !== input.previousRemoteHeadSha &&
    remoteHeadSha !== resultHeadSha
  ) {
    throw invalidJournal(
      `Journaled stash repair head ${resultHeadSha} does not match remote PR head ${remoteHeadSha}`,
    );
  }
  if (publishedMustMatch && remoteHeadSha !== resultHeadSha) {
    throw invalidJournal("Published stash repair journal no longer matches the remote PR head");
  }
}

function assertJournalFields(
  actual: object,
  expected: Record<string, unknown>,
): void {
  const fields = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (fields[key] !== value) {
      throw invalidJournal(`Service-owned Git journal field ${key} does not match the operation`);
    }
  }
}

function assertJournalArray(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw invalidJournal(`Service-owned Git journal ${label} do not match`);
  }
}

function sameStringArrays(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizedWorkspacePath(value: string): string {
  return path.resolve(value);
}

function requireJournalHead(value: string | null): string {
  if (value === null) throw invalidJournal("Service-owned Git journal has no result head");
  return value;
}

function invalidJournal(message: string): SymphonyError {
  return new SymphonyError("invalid_request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJournalKind(value: unknown): value is ServiceGitJournalRecord["kind"] {
  return [
    "prepare",
    "finalize",
    "stash_finalize",
    "local_refresh",
    "preserve_stash",
    "apply_stash",
  ].includes(String(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function verifyFinalizedPreparedBase(
  input: ServiceOwnedMergeConflictFinalizationInput,
  newHeadSha: string,
): Promise<ServiceOwnedMergeConflictFinalizationResult> {
  try {
    await fetchAndVerifyLocalRemoteBaseRef({
      workspacePath: input.workspacePath,
      baseRef: input.baseBranch,
      expectedBaseHeadSha: input.preparedBaseHeadSha,
      authHeader: input.authHeader,
      createMismatchError: ({ refName, actualSha, expectedSha, baseBranch }) =>
        preparedBaseRefDriftError(
          refName,
          actualSha,
          expectedSha,
          baseBranch,
          newHeadSha,
        ),
    });
  } catch (error) {
    if (!isPreparedBaseRefDriftError(error)) throw error;
    return {
      status: "prepared_base_ref_drift",
      newHeadSha,
      refName: error.details.refName,
      actualSha: error.details.actualSha,
      expectedSha: error.details.expectedSha,
      baseBranch: error.details.baseBranch,
    };
  }
  return { newHeadSha };
}

export function isPreparedBaseRefDriftError(error: unknown): error is SymphonyError & { details: PreparedBaseRefDriftDetails } {
  return (
    error instanceof SymphonyError &&
    typeof error.details === "object" &&
    error.details !== null &&
    (error.details as { kind?: unknown }).kind === "prepared_base_ref_drift" &&
    typeof (error.details as { actualSha?: unknown }).actualSha === "string" &&
    typeof (error.details as { expectedSha?: unknown }).expectedSha === "string"
  );
}

function preparedBaseRefDriftError(
  refName: string,
  actualSha: string,
  expectedSha: string,
  baseBranch: string,
  finalizedHeadSha?: string,
): SymphonyError {
  return new SymphonyError("conflict", `${refName} resolved to ${actualSha}, not prepared base ${expectedSha}`, {
    kind: "prepared_base_ref_drift",
    refName,
    actualSha,
    expectedSha,
    baseBranch,
    ...(finalizedHeadSha === undefined ? {} : { finalizedHeadSha }),
  } satisfies PreparedBaseRefDriftDetails);
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { allowFailure?: boolean },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 64_000);
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
      if (result.code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(new Error(`git exited with ${result.code}: ${stderr}`));
      }
    });
  });
}

function validateRefName(refName: string, label: string): void {
  const trimmed = refName.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("~") ||
    trimmed.includes("^") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("*") ||
    trimmed.includes("[") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".lock")
  ) {
    throw new SymphonyError("invalid_request", `Unsafe ${label}: ${refName}`);
  }
}

function normalizeGitPathLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => normalizeRepoPath(line.trim().split(/\s+/u).pop() ?? ""))
    .filter((line) => line.length > 0);
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/u, "");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeBranchRef(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/^refs\/heads\//u, "");
}

function safeRefSegment(value: string): string {
  const safe = value
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/\.\.+/g, ".")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.lock$/u, "-lock");
  return safe.length > 0 ? safe : "operation";
}

async function assertNoConflictMarkers(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (/^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/mu.test(content)) {
    throw new SymphonyError("invalid_request", `Conflict markers remain in ${filePath}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRequiredGitMetadata(filePath: string): Promise<string> {
  let value: string;
  try {
    value = (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    throw invalidJournal(`Journaled rebase metadata is missing: ${filePath}`);
  }
  if (value.length === 0) {
    throw invalidJournal(`Journaled rebase metadata is empty: ${filePath}`);
  }
  return value;
}

function resolveGitPath(workspacePath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.join(workspacePath, gitPath);
}
