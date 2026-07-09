import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import type { IssueBaseRefObservation } from "../src/core/BaseRefVerification.js";
import { MergePolicyService, type MergePolicyGitHubClient } from "../src/core/merge/MergePolicyService.js";
import {
  ServiceOwnedMergeConflictGit,
  type ServiceOwnedMergeConflictPreparationResult,
} from "../src/core/merge/ServiceOwnedMergeConflictGit.js";
import {
  FileIssueLifecycleStore,
  latestCurrentApprovalPassVerdict,
  type IssueMergeGateState,
  type IssuePreservedWorktreeStash,
  type IssueReviewVerdictRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { formatWorkerMergeGatePromptResult } from "../src/core/ReviewVerdictService.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { TrackerTransitionInput, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import type { Issue } from "../src/core/types.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import type { PullRequestCheckResult } from "../src/integrations/github/GitHubPullRequestClient.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { issue } from "./helpers.js";

let root: string;

describe("MergePolicyService", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-merge-policy-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("merges the lifecycle-bound PR and transitions to Done after gated checks pass", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient();
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({
      pullRequestNumber: 42,
      expectedHeadSha: "head-sha-1",
      method: "squash",
    });
    expect(currentIssue.state).toBe("Done");
    expect(writer.transitions).toEqual([
      { issueId: "issue-1", fromStates: ["Ready to Merge"], toState: "Done", reason: "Symphony reviewer-approved merge completed" },
    ]);
    expect(lifecycle?.merge).toMatchObject({
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/symphony/pull/42",
        headSha: "head-sha-1",
        branch: "symphony/TEST-1",
      },
      mergeCommitSha: "merge-sha-1",
      mergedBy: { login: "symphony-bot", capability: "github.merge" },
      checkStatus: { requiredChecks: ["test"], passedChecks: ["test"], noCiEvidence: null },
    });
    expect(lifecycle?.merge?.doneTransitionOperationKey).toBe("transition:issue-1:merge:issue-1:head-sha-1:Done");
  });

  it("supersedes a stale PR head and routes the issue back to implementation", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({ headSha: "new-head-sha" });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("head_superseded");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("In Progress");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge", "In Progress"],
        toState: "In Progress",
        reason: "Symphony merge gate head superseded",
      },
    ]);
    expect(lifecycle?.phase).toBe("implementation");
    expect(lifecycle?.lastReviewVerdictId).toBeNull();
    expect(lifecycle?.mergeGate?.status).toBe("superseded");
    expect(lifecycle?.mergeGate?.supersededByHeadSha).toBe("new-head-sha");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("head_superseded");
  });

  it("silently retires an old-head merge gate when the latest report already matches the live head", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await runStore.recordPullRequestEvent({
      runId: "worker-run-1",
      action: "updated",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-2",
      prBranch: "symphony/TEST-1",
    });
    const seeded = await lifecycleStore.get(currentIssue.id);
    const report = {
      ...seeded!.completionReports[0]!,
      id: "completion-report:issue-1:report-2",
      idempotencyKey: "report-2",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
    };
    await lifecycleStore.updateIssue(currentIssue, {
      reviewRound: 1,
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-2",
        prBranch: "symphony/TEST-1",
      },
      reviewFeedback: [
        {
          ...seeded!.reviewFeedback[0]!,
          pullRequest: report.pullRequest,
        },
      ],
      mergeGate: mergeGateState({ status: "repair_dispatched", headSha: "head-sha-1", reviewRound: 1 }),
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({ headSha: "head-sha-2" });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-2" });
    expect(writer.transitions).toEqual([
      { issueId: "issue-1", fromStates: ["Ready to Merge"], toState: "Done", reason: "Symphony reviewer-approved merge completed" },
    ]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "superseded",
      headSha: "head-sha-1",
      supersededByHeadSha: "head-sha-2",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
      writebackOperationKeys: [],
    });
  });

  it("supersedes an old-head gate and dispatches a new-head repair when current checks fail", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await runStore.recordPullRequestEvent({
      runId: "worker-run-1",
      action: "updated",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-2",
      prBranch: "symphony/TEST-1",
    });
    const seeded = await lifecycleStore.get(currentIssue.id);
    const report = {
      ...seeded!.completionReports[0]!,
      id: "completion-report:issue-1:report-2",
      idempotencyKey: "report-2",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
    };
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      reviewRound: 1,
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-2",
        prBranch: "symphony/TEST-1",
      },
      reviewFeedback: [
        {
          ...seeded!.reviewFeedback[0]!,
          pullRequest: report.pullRequest,
        },
      ],
      mergeGate: mergeGateState({ status: "repair_dispatched", headSha: "head-sha-1", reviewRound: 1 }),
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      headSha: "head-sha-2",
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("In Progress");
    expect(writer.transitions).toEqual([
      { issueId: "issue-1", fromStates: ["Ready to Merge"], toState: "In Progress", reason: "Symphony merge gate required CI repair" },
    ]);
    expect(lifecycle?.mergeGate).toMatchObject({
      id: "merge-gate:issue-1:pr-42:head-sha-2",
      status: "repair_dispatched",
      headSha: "head-sha-2",
      checks: [{ name: "test", outcome: "failing" }],
      blockerFingerprint: "head-sha-2:test:failure",
    });
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.lastMergeGateResultId).toBe("merge-gate:issue-1:pr-42:head-sha-2");
    expect(lifecycle?.mergeGateResults).toHaveLength(1);
    expect(lifecycle?.mergeGateResults?.[0]).toMatchObject({
      id: "merge-gate:issue-1:pr-42:head-sha-2",
      status: "repair_dispatched",
      headSha: "head-sha-2",
      checks: [{ name: "test", outcome: "failing" }],
      findings: expect.arrayContaining([expect.stringContaining("Required check failed: test")]),
    });
    expect(lifecycle?.reviewVerdicts.some((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-2")).toBe(false);
  });

  it("does not treat a prior head approval as current after a new-head completion report", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const seeded = await lifecycleStore.get(currentIssue.id);
    const report = {
      ...seeded!.completionReports[0]!,
      id: "completion-report:issue-1:report-2",
      idempotencyKey: "report-2",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
    };
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      reviewRound: 1,
      lastCompletionReportId: report.id,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      completionReports: [report],
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-2",
        prBranch: "symphony/TEST-1",
      },
      mergeGate: mergeGateState({ status: "repair_dispatched", headSha: "head-sha-1", reviewRound: 1 }),
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({ headSha: "head-sha-2" });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/pass verdict/);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
    expect(lifecycle?.phase).toBe("passed");
    expect(lifecycle?.lastReviewVerdictId).toBeNull();
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "superseded",
      headSha: "head-sha-1",
      supersededByHeadSha: "head-sha-2",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
      writebackOperationKeys: [],
    });
  });

  it("blocks approved PRs with merge conflicts when no conflict state is configured", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({ mergeable: false, mergeableState: "dirty" });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result.status).toBe("blocked");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Blocked");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Blocked",
        reason: "Symphony merge gate repair ceiling reached",
      },
    ]);
    expect(writer.comments[0]?.body).toContain("Mergeability:");
    expect(writer.comments[0]?.body).toContain("GitHub mergeable_state: dirty");
    expect(writer.comments[0]?.body).toContain("Configure merge_policy.conflicts_state");
    expect(writer.comments[0]?.body).toContain("service-owned git operations");
    expect(writer.comments[0]?.body).not.toContain("Symphony will run issue triage");
    expect(writer.comments[0]?.body).not.toContain("reconcile the lifecycle-bound PR changes with origin/main");
    expect(writer.comments[0]?.body).not.toContain("commit and push the repaired branch");
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "merge_policy.conflicts_state is required before Symphony can prepare a service-owned merge-conflict repair",
      merge: null,
      mergeConflict: null,
      mergeGate: {
        status: "blocked",
        mergeability: {
          status: "conflicted",
          mergeable: false,
          mergeableState: "dirty",
          baseBranch: "main",
          baseHeadSha: "base-sha-1",
        },
        blockerFingerprint: expect.stringContaining("mergeability:dirty"),
      },
    });
  });

  it("service-prepares conflicted PRs against the live base branch before dispatching a conflict worker", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      mergeable: false,
      mergeableState: "dirty",
      baseHeadSha: "observed-base-sha",
      liveBaseHeadSha: "live-base-sha",
    });
    const conflictGit = new FakeConflictGit({
      status: "conflicted",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "observed-base-sha",
      liveBaseHeadSha: "live-base-sha",
      preparedBaseHeadSha: "live-base-sha",
      mergeBaseSha: "observed-base-sha",
      squashCommitSha: "squash-sha-1",
      conflictedFiles: ["tests/orchestrator.test.ts"],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
      conflictGit,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("conflict_dispatched");
    expect(conflictGit.prepareInput).toMatchObject({
      workspacePath: path.join(root, currentIssue.identifier),
      branchName: "symphony/TEST-1",
      expectedHeadSha: "head-sha-1",
      baseBranch: "main",
      observedPrBaseHeadSha: "observed-base-sha",
      liveBaseHeadSha: "live-base-sha",
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(conflictGit.publishInput).toBeNull();
    expect(currentIssue.state).toBe("Approved with Conflicts");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Approved with Conflicts",
        reason: expect.stringContaining("Pull request has merge conflicts"),
      },
    ]);
    expect(writer.comments[0]?.body).toContain("service-owned git operations");
    expect(writer.comments[0]?.body).toContain("must not run git fetch");
    expect(lifecycle).toMatchObject({
      phase: "merge_conflict_resolution",
      mergeGate: null,
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        approvedHeadSha: "head-sha-1",
        currentHeadSha: "head-sha-1",
        baseBranch: "main",
        baseHeadSha: "live-base-sha",
        servicePreparation: {
          strategy: "squash_rebase",
          status: "conflicted",
          originalHeadSha: "head-sha-1",
          observedPrBaseHeadSha: "observed-base-sha",
          liveBaseHeadSha: "live-base-sha",
          preparedBaseHeadSha: "live-base-sha",
          conflictedFiles: ["tests/orchestrator.test.ts"],
        },
      },
    });
  });

  it("refreshes stale service-prepared conflict bases before dispatching another conflict worker", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Approved with Conflicts", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeConflict: {
        ...mergeConflictRecord(),
        servicePreparation: {
          strategy: "squash_rebase",
          status: "conflicted",
          originalHeadSha: "head-sha-1",
          observedPrBaseHeadSha: "base-sha-0",
          liveBaseHeadSha: "base-sha-1",
          preparedBaseHeadSha: "base-sha-1",
          mergeBaseSha: "base-sha-0",
          squashCommitSha: "squash-sha-1",
          conflictedFiles: ["tests/orchestrator.test.ts"],
          preparedAt: "2026-01-01T00:00:02.000Z",
          finalizedAt: null,
          finalizedHeadSha: null,
        },
      },
      summaryPointers: {
        workspacePath: path.join(root, currentIssue.identifier),
      },
    });
    const conflictGit = new FakeConflictGit({
      status: "conflicted",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-2",
      conflictedFiles: ["tests/orchestrator.test.ts"],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({
        mergeable: false,
        mergeableState: "dirty",
        baseHeadSha: "base-sha-1",
        liveBaseHeadSha: "base-sha-2",
      }),
      conflictGit,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("conflict_dispatched");
    expect(conflictGit.prepareInput).toBeNull();
    expect(conflictGit.reprepareInput).toMatchObject({
      workspacePath: path.join(root, currentIssue.identifier),
      branchName: "symphony/TEST-1",
      expectedHeadSha: "head-sha-1",
      baseBranch: "main",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle).toMatchObject({
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        currentHeadSha: "head-sha-1",
        baseHeadSha: "base-sha-2",
        fixTurnCount: 0,
        attemptRunIds: [],
        servicePreparation: {
          status: "conflicted",
          liveBaseHeadSha: "base-sha-2",
          preparedBaseHeadSha: "base-sha-2",
          squashCommitSha: "squash-sha-2",
        },
      },
    });
  });

  it("publishes a clean service-prepared rebase and routes back to implementation", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "rebased-head-sha",
      conflictedFiles: [],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({
        mergeable: false,
        mergeableState: "dirty",
        baseHeadSha: "base-sha-1",
        liveBaseHeadSha: "base-sha-2",
      }),
      conflictGit,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("conflict_dispatched");
    expect(conflictGit.publishInput).toMatchObject({
      workspacePath: path.join(root, currentIssue.identifier),
      branchName: "symphony/TEST-1",
      previousRemoteHeadSha: "head-sha-1",
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(currentIssue.state).toBe("In Progress");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge", "In Progress"],
        toState: "In Progress",
        reason: "Symphony rebased stale worktree base; worker reverification required",
      },
    ]);
    expect(writer.comments[0]?.body).toContain("worker reverification required");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      mergeGate: null,
      summaryPointers: {
        ciStatus: null,
        prHeadSha: "rebased-head-sha",
      },
      mergeConflict: {
        status: "resolved",
        resolutionStatus: "resolved",
        approvedHeadSha: "head-sha-1",
        currentHeadSha: "rebased-head-sha",
        resolvedHeadSha: "rebased-head-sha",
        servicePreparation: {
          status: "finalized",
          finalizedHeadSha: "rebased-head-sha",
        },
      },
    });
  });

  it("repairs stale worktree base with a clean local rebase, publishes it, and routes back to implementation", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "rebased-head-sha",
      conflictedFiles: [],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    const result = await service.repairBaseRefDrift(currentIssue, baseRefObservation());
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result).toEqual({ status: "base_ref_repaired", headSha: "rebased-head-sha" });
    expect(conflictGit.prepareInput).toMatchObject({
      workspacePath: path.join(root, currentIssue.identifier),
      branchName: "symphony/TEST-1",
      expectedHeadSha: "head-sha-1",
      baseBranch: "main",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(conflictGit.publishInput).toMatchObject({
      workspacePath: path.join(root, currentIssue.identifier),
      branchName: "symphony/TEST-1",
      previousRemoteHeadSha: "head-sha-1",
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(currentIssue.state).toBe("In Progress");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["In Review", "In Progress"],
        toState: "In Progress",
        reason: "Symphony rebased stale worktree base; worker reverification required",
      },
    ]);
    expect(writer.comments[0]?.body).toContain("Status: clean rebase published, worker reverification required");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      blockedReason: null,
      mergeGate: null,
      mergeConflict: null,
      summaryPointers: {
        prHeadSha: "rebased-head-sha",
        prBranch: "symphony/TEST-1",
        baseRef: "main",
      },
    });
  });

  it("repairs stale worktree base against the current live base when the observation is stale", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-3",
      preparedBaseHeadSha: "base-sha-3",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "rebased-head-sha",
      conflictedFiles: [],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-3" }),
      conflictGit,
    });

    const result = await service.repairBaseRefDrift(currentIssue, baseRefObservation());
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result).toEqual({ status: "base_ref_repaired", headSha: "rebased-head-sha" });
    expect(conflictGit.prepareInput).toMatchObject({
      liveBaseHeadSha: "base-sha-3",
    });
    expect(writer.comments[0]?.body).toContain("base-sha-3");
    expect(lifecycle?.summaryPointers.prHeadSha).toBe("rebased-head-sha");
  });

  it("uses the current lifecycle PR head for base-ref repair when the latest completion report is historical", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      summaryPointers: { prHeadSha: "head-sha-2" },
    });
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-2",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "rebased-head-sha",
      conflictedFiles: [],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    const result = await service.repairBaseRefDrift(
      currentIssue,
      baseRefObservation({ worktreeHeadSha: "head-sha-2" }),
    );

    expect(result).toEqual({ status: "base_ref_repaired", headSha: "rebased-head-sha" });
    expect(conflictGit.prepareInput).toMatchObject({
      expectedHeadSha: "head-sha-2",
    });
    expect(conflictGit.publishInput).toMatchObject({
      previousRemoteHeadSha: "head-sha-2",
    });
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["In Review", "In Progress"],
        toState: "In Progress",
        reason: "Symphony rebased stale worktree base; worker reverification required",
      },
    ]);
  });

  it("rejects PR-backed base-ref repair when no lifecycle PR head candidate matches the worktree head", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      summaryPointers: { prHeadSha: "head-sha-2" },
    });
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-3",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "rebased-head-sha",
      conflictedFiles: [],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    await expect(
      service.repairBaseRefDrift(
        currentIssue,
        baseRefObservation({ worktreeHeadSha: "head-sha-3" }),
      ),
    ).rejects.toThrow("lifecycle PR head SHA does not match gated merge metadata");
    expect(conflictGit.prepareInput).toBeNull();
    expect(conflictGit.publishInput).toBeNull();
  });

  it("refreshes local-only stale worktree base without fetching or publishing an issue branch", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(currentIssue, {
      phase: "implementation",
      summaryPointers: {
        workspacePath: path.join(root, currentIssue.identifier),
        gitBranchName: "symphony/TEST-1",
        baseRef: "main",
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
      },
    });
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "unused-pr-rebase-sha",
      conflictedFiles: [],
    });
    conflictGit.localRefreshResult = {
      status: "refreshed",
      originalHeadSha: "head-sha-1",
      liveBaseHeadSha: "base-sha-2",
      refreshedHeadSha: "base-sha-2",
      aheadCommitCount: 0,
      behindCommitCount: 3,
    };
    conflictGit.preservedStash = preservedStashRecord(path.join(root, currentIssue.identifier));
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    const result = await service.repairBaseRefDrift(currentIssue, baseRefObservation());
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result).toEqual({ status: "base_ref_repaired", headSha: "base-sha-2" });
    expect(conflictGit.prepareInput).toBeNull();
    expect(conflictGit.publishInput).toBeNull();
    expect(conflictGit.refreshInput).toMatchObject({
      workspacePath: path.join(root, currentIssue.identifier),
      branchName: "symphony/TEST-1",
      expectedHeadSha: "head-sha-1",
      baseBranch: "main",
      liveBaseHeadSha: "base-sha-2",
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(conflictGit.applyInput).toMatchObject({
      preservedStash: conflictGit.preservedStash,
    });
    expect(conflictGit.dropInput).toMatchObject({
      preservedStash: expect.objectContaining({ status: "applied_clean" }),
    });
    expect(currentIssue.state).toBe("In Progress");
    expect(writer.comments[0]?.body).toContain("Status: local worktree base refreshed");
    expect(writer.comments[0]?.body).toContain("No PR branch was published");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      summaryPointers: {
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
        gitBranchName: "symphony/TEST-1",
        baseRef: "main",
      },
      preservedWorktreeStashes: [
        expect.objectContaining({
          id: conflictGit.preservedStash.id,
          status: "dropped",
        }),
      ],
    });
  });

  it("reuses an existing created preserved stash on base-ref repair retry", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const existingStash = preservedStashRecord(path.join(root, currentIssue.identifier));
    await lifecycleStore.ensureIssue(currentIssue, {
      phase: "implementation",
      summaryPointers: {
        workspacePath: path.join(root, currentIssue.identifier),
        gitBranchName: "symphony/TEST-1",
        baseRef: "main",
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
      },
      preservedWorktreeStashes: [existingStash],
    });
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "unused-pr-rebase-sha",
      conflictedFiles: [],
    });
    conflictGit.localRefreshResult = {
      status: "refreshed",
      originalHeadSha: "head-sha-1",
      liveBaseHeadSha: "base-sha-2",
      refreshedHeadSha: "base-sha-2",
      aheadCommitCount: 0,
      behindCommitCount: 1,
    };
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    await service.repairBaseRefDrift(currentIssue, baseRefObservation());
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(conflictGit.preserveInput).toMatchObject({
      source: "base_ref_repair",
    });
    expect(conflictGit.applyInput).toMatchObject({
      preservedStash: existingStash,
    });
    expect(lifecycle?.preservedWorktreeStashes).toEqual([
      expect.objectContaining({
        id: existingStash.id,
        status: "dropped",
      }),
    ]);
  });

  it("routes preserved local-change conflicts after clean base-ref repair to a stash-apply conflict worker", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const conflictGit = new FakeConflictGit({
      status: "clean",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      rebasedHeadSha: "rebased-head-sha",
      conflictedFiles: [],
    });
    conflictGit.preservedStash = preservedStashRecord(path.join(root, currentIssue.identifier));
    conflictGit.stashApplyResult = {
      status: "conflicted",
      stash: {
        ...conflictGit.preservedStash,
        status: "apply_conflicted",
        conflictedFiles: ["src/local.ts"],
        appliedAt: "2026-01-01T00:00:02.000Z",
      },
      changedFiles: ["src/local.ts"],
      conflictedFiles: ["src/local.ts"],
      headSha: "rebased-head-sha",
    };
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    const result = await service.repairBaseRefDrift(currentIssue, baseRefObservation());
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("conflict_dispatched");
    expect(conflictGit.publishInput).toMatchObject({
      previousRemoteHeadSha: "head-sha-1",
    });
    expect(conflictGit.applyInput).toMatchObject({
      preservedStash: conflictGit.preservedStash,
    });
    expect(conflictGit.dropInput).toBeNull();
    expect(currentIssue.state).toBe("Approved with Conflicts");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["In Review"],
        toState: "Approved with Conflicts",
        reason: "Symphony gated merge blocked: Preserved local changes conflicted while restoring after base-ref repair",
      },
    ]);
    expect(lifecycle).toMatchObject({
      phase: "merge_conflict_resolution",
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        currentHeadSha: "rebased-head-sha",
        reason: "Preserved local changes conflicted while restoring after base-ref repair",
        servicePreparation: {
          strategy: "stash_apply",
          status: "conflicted",
          originalHeadSha: "rebased-head-sha",
          currentHeadSha: "rebased-head-sha",
          conflictedFiles: ["src/local.ts"],
          allowedFiles: ["src/local.ts"],
          preservedStash: {
            status: "apply_conflicted",
            stashRef: "refs/symphony/preserved-stashes/test/stash-1",
          },
        },
      },
      preservedWorktreeStashes: [
        expect.objectContaining({
          status: "apply_conflicted",
          conflictedFiles: ["src/local.ts"],
        }),
      ],
    });
  });

  it("routes stale worktree base rebase conflicts to the service-prepared conflict worker", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "In Review", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const conflictGit = new FakeConflictGit({
      status: "conflicted",
      originalHeadSha: "head-sha-1",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-2",
      preparedBaseHeadSha: "base-sha-2",
      mergeBaseSha: "base-sha-1",
      squashCommitSha: "squash-sha-1",
      conflictedFiles: ["src/index.ts"],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({ liveBaseHeadSha: "base-sha-2" }),
      conflictGit,
    });

    const result = await service.repairBaseRefDrift(currentIssue, baseRefObservation());
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("conflict_dispatched");
    expect(conflictGit.publishInput).toBeNull();
    expect(currentIssue.state).toBe("Approved with Conflicts");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["In Review"],
        toState: "Approved with Conflicts",
        reason: "Symphony gated merge blocked: Worktree rebase over the live origin base produced conflicts",
      },
    ]);
    expect(writer.comments[0]?.body).toContain("Status: pull request has merge conflicts");
    expect(lifecycle).toMatchObject({
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        currentHeadSha: "head-sha-1",
        baseBranch: "main",
        baseHeadSha: "base-sha-2",
        sourceState: "In Review",
        conflictsState: "Approved with Conflicts",
        servicePreparation: {
          status: "conflicted",
          originalHeadSha: "head-sha-1",
          liveBaseHeadSha: "base-sha-2",
          preparedBaseHeadSha: "base-sha-2",
          squashCommitSha: "squash-sha-1",
          conflictedFiles: ["src/index.ts"],
        },
      },
      summaryPointers: {
        ciStatus: "conflicted",
        prHeadSha: "head-sha-1",
        prBranch: "symphony/TEST-1",
        baseRef: "main",
      },
    });
  });

  it("blocks combined check and conflict failures when no conflict state is configured", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      mergeable: false,
      mergeableState: "dirty",
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result.status).toBe("blocked");
    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]?.body).toContain("Failing checks:");
    expect(writer.comments[0]?.body).toContain("test: failure / failure");
    expect(writer.comments[0]?.body).toContain("GitHub mergeable_state: dirty");
    expect(writer.comments[0]?.body).toContain("Configure merge_policy.conflicts_state");
    const lifecycle = await lifecycleStore.get(currentIssue.id);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "blocked",
      blockerFingerprint: expect.stringContaining("test:failure"),
      mergeability: { status: "conflicted" },
    });
    expect(lifecycle?.mergeGate?.blockerFingerprint).toContain("mergeability:dirty");
  });

  it("blocks conflict repair while pending checks remain observation context without a conflict state", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      mergeable: false,
      mergeableState: "dirty",
      checkResults: [{ name: "test", status: "pending", conclusion: null, url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).resolves.toMatchObject({ status: "blocked" });

    expect(writer.comments[0]?.body).toContain("Pending checks:");
    expect(writer.comments[0]?.body).toContain("test: pending");
    expect(writer.comments[0]?.body).toContain("Configure merge_policy.conflicts_state");
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      mergeGate: {
        status: "blocked",
        checks: [{ name: "test", outcome: "pending" }],
        mergeability: { status: "conflicted" },
      },
    });
  });

  it("defers merge-gate repair while GitHub mergeability is unknown", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({ mergeable: false, mergeableState: "unknown" });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result).toMatchObject({ status: "checks_pending" });
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      mergeGate: {
        status: "observing",
        mergeability: { status: "unknown", mergeableState: "unknown" },
      },
    });
  });

  it("does not carry approval forward from the conflict repair state", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Conflict Repair",
    });
    const currentIssue = issue({ state: "Conflict Repair", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      mergeConflict: mergeConflictRecord({ resolutionStatus: "resolved", resolvedHeadSha: "head-sha-2" }),
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({ headSha: "head-sha-2" });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "issue is not in a merge source state: Conflict Repair",
    });
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Conflict Repair");
    expect((await lifecycleStore.get(currentIssue.id))?.merge).toBeNull();
  });

  it("dispatches merge-gate repair when the latest approval is already on the resolved conflict head", async () => {
    const config = mergeConfig({
      requiredChecks: ["test"],
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await runStore.startRun({
      runId: "worker-run-2",
      role: "worker",
      issueId: currentIssue.id,
      issueIdentifier: currentIssue.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "resolved conflict repair",
      workspaceKey: currentIssue.identifier,
      workspacePath: path.join(root, currentIssue.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await runStore.recordPullRequestEvent({
      runId: "worker-run-2",
      action: "updated",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-2",
      prBranch: "symphony/TEST-1",
    });
    const resolvedReport = {
      ...(await lifecycleStore.get(currentIssue.id))!.completionReports[0]!,
      id: "completion-report:issue-1:resolved-head",
      idempotencyKey: "resolved-head",
      runId: "worker-run-2",
      acceptedAt: "2026-01-01T00:10:00.000Z",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
    };
    const resolvedApproval: IssueReviewVerdictRecord = {
      id: "review-verdict:issue-1:resolved-head-pass",
      idempotencyKey: "resolved-head-pass",
      runId: "review-run-2",
      issueId: currentIssue.id,
      issueIdentifier: currentIssue.identifier,
      verdict: "pass",
      acceptanceResults: [{ text: "Resolved conflict head works", satisfied: true, evidence: "reviewed" }],
      findings: [],
      gateFindings: [],
      discoveryFindings: [],
      evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-2"],
      reviewer: "reviewer-2",
      submittedAt: "2026-01-01T00:11:00.000Z",
      writebackOperationKeys: [],
    };
    const seeded = await lifecycleStore.get(currentIssue.id);
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      lastCompletionReportId: resolvedReport.id,
      lastReviewVerdictId: resolvedApproval.id,
      summaryPointers: { prHeadSha: "head-sha-2" },
      completionReports: [...seeded!.completionReports, resolvedReport],
      reviewVerdicts: [...seeded!.reviewVerdicts, resolvedApproval],
      reviewFeedback: [
        ...seeded!.reviewFeedback,
        {
          id: "review-feedback:issue-1:review-run-2:approve",
          idempotencyKey: "approve-resolved-head",
          requestHash: "hash-resolved-head",
          runId: "review-run-2",
          issueId: currentIssue.id,
          issueIdentifier: currentIssue.identifier,
          kind: "review",
          event: "APPROVE",
          body: "Approved resolved head.",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "head-sha-2",
            branch: "symphony/TEST-1",
          },
          reviewer: "reviewer-2",
          reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-2",
          commentUrls: [],
          submittedAt: "2026-01-01T00:10:30.000Z",
        },
      ],
      mergeConflict: {
        ...mergeConflictRecord({ resolutionStatus: "resolved", resolvedHeadSha: "head-sha-2" }),
        servicePreparation: {
          strategy: "squash_rebase",
          status: "finalized",
          originalHeadSha: "head-sha-1",
          observedPrBaseHeadSha: "base-sha-1",
          liveBaseHeadSha: "base-sha-1",
          preparedBaseHeadSha: "base-sha-1",
          mergeBaseSha: "head-sha-1",
          squashCommitSha: "squash-sha-1",
          conflictedFiles: ["tests/orchestrator.test.ts"],
          preparedAt: "2026-01-01T00:02:00.000Z",
          finalizedAt: "2026-01-01T00:09:00.000Z",
          finalizedHeadSha: "head-sha-2",
        },
      },
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      headSha: "head-sha-2",
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result.status).toBe("repair_dispatched");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(client.mergeInput).toBeNull();
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      phase: "implementation",
      mergeGate: {
        status: "repair_dispatched",
        headSha: "head-sha-2",
        blockerFingerprint: "head-sha-2:test:failure",
      },
    });
  });

  it("ignores stale resolved conflict metadata after a newer completion report advances the PR head", async () => {
    const config = mergeConfig({
      requiredChecks: ["test"],
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await runStore.startRun({
      runId: "worker-run-3",
      role: "worker",
      issueId: currentIssue.id,
      issueIdentifier: currentIssue.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "fresh head repair",
      workspaceKey: currentIssue.identifier,
      workspacePath: path.join(root, currentIssue.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await runStore.recordPullRequestEvent({
      runId: "worker-run-3",
      action: "updated",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-3",
      prBranch: "symphony/TEST-1",
    });
    const seeded = await lifecycleStore.get(currentIssue.id);
    const freshReport = {
      ...seeded!.completionReports[0]!,
      id: "completion-report:issue-1:fresh-head",
      idempotencyKey: "fresh-head",
      runId: "worker-run-3",
      acceptedAt: "2026-01-01T00:20:00.000Z",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-3",
        branch: "symphony/TEST-1",
      },
    };
    const freshApproval: IssueReviewVerdictRecord = {
      id: "review-verdict:issue-1:fresh-head-pass",
      idempotencyKey: "fresh-head-pass",
      runId: "review-run-3",
      issueId: currentIssue.id,
      issueIdentifier: currentIssue.identifier,
      verdict: "pass",
      acceptanceResults: [{ text: "Fresh head is approved", satisfied: true, evidence: "reviewed" }],
      findings: [],
      gateFindings: [],
      discoveryFindings: [],
      evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-3"],
      reviewer: "reviewer-3",
      submittedAt: "2026-01-01T00:21:00.000Z",
      writebackOperationKeys: [],
    };
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      reviewRound: 2,
      lastCompletionReportId: freshReport.id,
      lastReviewVerdictId: freshApproval.id,
      summaryPointers: { prHeadSha: "head-sha-3" },
      completionReports: [...seeded!.completionReports, freshReport],
      reviewVerdicts: [...seeded!.reviewVerdicts, freshApproval],
      reviewFeedback: [
        ...seeded!.reviewFeedback,
        {
          id: "review-feedback:issue-1:review-run-3:approve",
          idempotencyKey: "approve-fresh-head",
          requestHash: "hash-fresh-head",
          runId: "review-run-3",
          issueId: currentIssue.id,
          issueIdentifier: currentIssue.identifier,
          kind: "review",
          event: "APPROVE",
          body: "Approved fresh head.",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "head-sha-3",
            branch: "symphony/TEST-1",
          },
          reviewer: "reviewer-3",
          reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-3",
          commentUrls: [],
          submittedAt: "2026-01-01T00:20:30.000Z",
        },
      ],
      mergeGate: mergeGateState({ status: "repair_dispatched", headSha: "head-sha-2", reviewRound: 2 }),
      mergeConflict: {
        ...mergeConflictRecord({ resolutionStatus: "resolved", resolvedHeadSha: "head-sha-2" }),
        servicePreparation: {
          strategy: "squash_rebase",
          status: "finalized",
          originalHeadSha: "head-sha-1",
          observedPrBaseHeadSha: "base-sha-1",
          liveBaseHeadSha: "base-sha-1",
          preparedBaseHeadSha: "base-sha-1",
          mergeBaseSha: "head-sha-1",
          squashCommitSha: "squash-sha-1",
          conflictedFiles: ["tests/orchestrator.test.ts"],
          preparedAt: "2026-01-01T00:02:00.000Z",
          finalizedAt: "2026-01-01T00:09:00.000Z",
          finalizedHeadSha: "head-sha-2",
        },
      },
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      headSha: "head-sha-3",
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result.status).toBe("blocked");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Blocked",
        reason: "Symphony merge gate repair ceiling reached",
      },
    ]);
    expect(client.mergeInput).toBeNull();
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "max merge gate failures reached (3/3)",
      mergeGate: {
        status: "blocked",
        headSha: "head-sha-3",
        blockerFingerprint: "head-sha-3:test:failure",
      },
      summaryPointers: {
        ciStatus: "failure",
        prHeadSha: "head-sha-3",
      },
    });
  });

  it("skips legacy resolved conflict metadata in the conflict repair state", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Conflict Repair",
    });
    const currentIssue = issue({ state: "Conflict Repair", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      mergeConflict: mergeConflictRecord({ resolutionStatus: "resolved", resolvedHeadSha: "head-sha-2" }),
    });
    const writer = new MemoryWriter(currentIssue);
    const dirtyClient = new FakeMergeClient({ headSha: "head-sha-2", mergeable: false, mergeableState: "dirty" });
    const conflictGit = new FakeConflictGit({
      status: "conflicted",
      originalHeadSha: "head-sha-2",
      observedPrBaseHeadSha: "base-sha-1",
      liveBaseHeadSha: "base-sha-1",
      preparedBaseHeadSha: "base-sha-1",
      mergeBaseSha: "head-sha-1",
      squashCommitSha: "squash-sha-2",
      conflictedFiles: ["src/index.ts"],
    });
    const dirtyService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: dirtyClient,
      conflictGit,
    });

    await expect(dirtyService.reconcileIssue(currentIssue)).resolves.toMatchObject({
      status: "skipped",
      reason: "issue is not in a merge source state: Conflict Repair",
    });
    expect(dirtyClient.mergeInput).toBeNull();
    expect(conflictGit.prepareInput).toBeNull();
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      phase: "passed",
      mergeConflict: {
        status: "resolved",
        resolutionStatus: "resolved",
        resolvedHeadSha: "head-sha-2",
      },
      mergeGate: null,
    });
  });

  it("does not validate conflict approval carry-forward from the conflict repair state", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Conflict Repair",
    });
    const currentIssue = issue({ state: "Conflict Repair", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      mergeConflict: mergeConflictRecord({ resolutionStatus: "resolved", resolvedHeadSha: "head-sha-2" }),
    });
    const client = new FakeMergeClient({ headSha: "head-sha-2", ancestor: false });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).resolves.toMatchObject({
      status: "skipped",
      reason: "issue is not in a merge source state: Conflict Repair",
    });
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Conflict Repair");
  });

  it("requires live writeback mode before gated merge", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test.", writebackMode: "dry_run" });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient();
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/service-owned writeback/);
    expect(client.mergeInput).toBeNull();
  });

  it("requires service-recorded APPROVE feedback from the reviewer run", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { includeApproval: false });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient(),
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/APPROVE/);
  });

  it("rejects empty required checks without explicit no-CI evidence", async () => {
    const config = mergeConfig({});
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient(),
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/configured checks or explicit no-CI/);
  });

  it("does not return merged when Done writeback is skipped", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient();
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue, "skipped"),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/Done writeback did not succeed/);
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(currentIssue.state).toBe("Ready to Merge");
  });

  it("retries a skipped merge Done writeback on later already-merged reconciliation", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient();
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue, "skipped"), new StructuredLogger(() => undefined), 60_000),
      client,
    });

    await expect(firstService.reconcileIssue(currentIssue)).rejects.toThrow(/Done writeback did not succeed/);
    expect((await lifecycleStore.get(currentIssue.id))?.merge?.mergeCommitSha).toBe("merge-sha-1");

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);

    expect(result.status).toBe("already_merged");
    expect(client.mergeCalls).toBe(1);
    expect(currentIssue.state).toBe("Done");
    expect(writer.transitions).toEqual([
      { issueId: "issue-1", fromStates: ["Ready to Merge"], toState: "Done", reason: "Symphony reviewer-approved merge completed" },
    ]);
  });

  it("backfills a service-merged PR and transitions Done when lifecycle merge metadata is missing", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      state: "closed",
      merged: true,
      mergeCommitSha: "merge-sha-recovered",
      mergedAt: "2026-01-01T00:05:00.000Z",
      mergedBy: "symphony-bot",
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("already_merged");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Done");
    expect(lifecycle?.merge).toMatchObject({
      mergeCommitSha: "merge-sha-recovered",
      mergedAt: "2026-01-01T00:05:00.000Z",
      mergedBy: { login: "symphony-bot", capability: "github.merge" },
    });
  });

  it("rejects already-merged PR backfill when GitHub does not attribute the merge to service credentials", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({ state: "closed", merged: true, mergedBy: "human" });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/service-merged/);
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
  });

  it("waits when a configured required check is missing", async () => {
    const config = mergeConfig({ requiredChecks: ["test", "typecheck"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result.status).toBe("checks_pending");
    expect(result.status === "checks_pending" ? result.gate.missingChecks.map((check) => check.name) : []).toEqual(["typecheck"]);
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
    expect((await lifecycleStore.get(currentIssue.id))?.mergeGate).toMatchObject({
      status: "observing",
      checks: [{ name: "test", outcome: "passing" }, { name: "typecheck", outcome: "missing_observed" }],
    });
  });

  it("does not dispatch repair when a required check is pending", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "pending", conclusion: null, url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("checks_pending");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "observing",
      checks: [{ name: "test", outcome: "pending", rawStatus: "pending" }],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
    });
  });

  it("does not dispatch repair when a required check is unknown", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "unknown", conclusion: null, url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("checks_pending");
    expect(result.status === "checks_pending" ? result.gate.unknownChecks.map((check) => check.name) : []).toEqual(["test"]);
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "observing",
      checks: [{ name: "test", outcome: "unknown", rawStatus: "unknown" }],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
    });
  });

  it.each<{
    name: string;
    checkResults: PullRequestCheckResult[];
    expectedCheck: { outcome: IssueMergeGateState["checks"][number]["outcome"]; rawStatus: IssueMergeGateState["checks"][number]["rawStatus"] };
    promptFragment: string;
  }>([
    {
      name: "pending",
      checkResults: [{ name: "test", status: "pending", conclusion: null, url: "https://ci.test/test" }],
      expectedCheck: { outcome: "pending", rawStatus: "pending" },
      promptFragment: "test: pending (https://ci.test/test)",
    },
    {
      name: "unknown",
      checkResults: [{ name: "test", status: "unknown", conclusion: null, url: "https://ci.test/test" }],
      expectedCheck: { outcome: "unknown", rawStatus: "unknown" },
      promptFragment: "test: unknown (https://ci.test/test)",
    },
    {
      name: "fresh missing",
      checkResults: [],
      expectedCheck: { outcome: "missing_observed", rawStatus: "missing" },
      promptFragment: "test: missing_observed",
    },
  ])("preserves an active same-head repair gate when a required check is $name", async ({ checkResults, expectedCheck, promptFragment }) => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const seeded = await lifecycleStore.get(currentIssue.id);
    const activeGate = mergeGateState({
      writebackOperationKeys: ["comment:issue-1:merge-gate", "transition:issue-1:merge-gate:In Progress"],
    });
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      reviewVerdicts: [...(seeded?.reviewVerdicts ?? []), mergeGateVerdict(activeGate, currentIssue)],
      mergeGate: activeGate,
      summaryPointers: { ciStatus: "failure" },
    });
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({ checkResults });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);
    const mergeGatePrompt = lifecycle ? formatWorkerMergeGatePromptResult(lifecycle) : null;
    const automationBlocked = lifecycle?.mergeGate?.status === "repair_dispatched" || lifecycle?.mergeGate?.status === "blocked";

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.phase).toBe("passed");
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.lastMergeGateResultId).toBe(activeGate.id);
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      repairRunId: "repair-run-1",
      repairReportId: "completion-report:issue-1:repair-1",
      blockerFingerprint: "head-sha-1:test:failure",
      writebackOperationKeys: ["comment:issue-1:merge-gate", "transition:issue-1:merge-gate:In Progress"],
      checks: [{ name: "test", ...expectedCheck }],
    });
    expect(automationBlocked).toBe(true);
    expect(mergeGatePrompt?.kind).toBe("repair");
    expect(mergeGatePrompt?.text).toContain("Status: repair_dispatched");
    expect(mergeGatePrompt?.text).toContain(promptFragment);
  });

  it("carries missing-check stabilization history across reconciles before dispatch", async () => {
    vi.useFakeTimers();
    const config = mergeConfig({ requiredChecks: ["test", "typecheck"] });
    config.mergePolicy.missingCheckStabilizationMs = 60_000;
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = await service.reconcileIssue(currentIssue);
    let lifecycle = await lifecycleStore.get(currentIssue.id);
    const firstMissing = lifecycle?.mergeGate?.checks.find((check) => check.name === "typecheck");

    expect(first.status).toBe("checks_pending");
    expect(firstMissing).toMatchObject({
      outcome: "missing_observed",
      rawStatus: "missing",
      firstObservedAt: "2026-01-01T00:00:00.000Z",
      actionableSince: null,
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    const second = await service.reconcileIssue(currentIssue);
    lifecycle = await lifecycleStore.get(currentIssue.id);
    const secondMissing = lifecycle?.mergeGate?.checks.find((check) => check.name === "typecheck");

    expect(second.status).toBe("checks_pending");
    expect(secondMissing).toMatchObject({
      outcome: "missing_observed",
      firstObservedAt: "2026-01-01T00:00:00.000Z",
      actionableSince: null,
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
    const third = await service.reconcileIssue(currentIssue);
    lifecycle = await lifecycleStore.get(currentIssue.id);
    const thirdMissing = lifecycle?.mergeGate?.checks.find((check) => check.name === "typecheck");

    expect(third.status).toBe("repair_dispatched");
    expect(thirdMissing).toMatchObject({
      outcome: "missing_actionable",
      firstObservedAt: "2026-01-01T00:00:00.000Z",
      actionableSince: "2026-01-01T00:01:01.000Z",
    });
    expect(writer.transitions).toHaveLength(1);
    expect(writer.comments).toHaveLength(1);
  });

  it("dispatches a worker repair when a missing required check stabilizes", async () => {
    const config = mergeConfig({ requiredChecks: ["test", "typecheck"] });
    config.mergePolicy.missingCheckStabilizationMs = 0;
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(writer.comments[0]?.body).toContain("Actionable missing checks:");
    expect(writer.comments[0]?.body).toContain("typecheck: missing");
    expect(currentIssue.state).toBe("In Progress");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      checks: [{ name: "test", outcome: "passing" }, { name: "typecheck", outcome: "missing_actionable" }],
    });
    expect(lifecycle?.mergeGateResults?.at(-1)?.findings).toEqual(["Required check missing (actionable): typecheck: missing"]);
  });

  it("dispatches a worker repair when a required check fails", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(writer.comments[0]?.body).toContain("Status: repair required");
    expect(writer.comments[0]?.body).toContain("test: failure / failure (https://ci.test/test)");
    expect(currentIssue.state).toBe("In Progress");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      lastMergeGateResultId: "merge-gate:issue-1:pr-42:head-sha-1",
      mergeGate: { reviewRound: 1 },
    });
    expect(lifecycle?.mergeGateResults?.at(-1)).toMatchObject({
      id: "merge-gate:issue-1:pr-42:head-sha-1",
      status: "repair_dispatched",
      findings: ["Required check failed: test: failure / failure (https://ci.test/test)"],
      writebackOperationKeys: [
        "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_test_failure:r1",
        "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_test_failure:r1:In Progress",
      ],
    });
  });

  it("treats stale required checks as actionable merge-gate failures", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "stale", url: "https://ci.test/test" }],
      }),
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(writer.transitions).toHaveLength(1);
    expect(lifecycle?.mergeGate?.checks).toMatchObject([{ name: "test", rawStatus: "failure", outcome: "failing", conclusion: "stale" }]);
  });

  it("accepts neutral and skipped required checks as passing for gated merge", async () => {
    const config = mergeConfig({ requiredChecks: ["test", "typecheck"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [
        { name: "test", status: "success", conclusion: "neutral", url: "https://ci.test/test" },
        { name: "typecheck", status: "success", conclusion: "skipped", url: "https://ci.test/typecheck" },
      ],
    });
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
  });

  it("redispatches a same-head merge gate failure after review pass with a fresh repair round", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstWriter = new MemoryWriter(currentIssue);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, firstWriter, new StructuredLogger(() => undefined), 60_000),
      client,
    });
    await firstService.reconcileIssue(currentIssue);
    currentIssue.state = "Ready to Merge";
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      summaryPointers: { ciStatus: "success" },
    });

    const secondWriter = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, secondWriter, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);
    const gateResults = (lifecycle?.mergeGateResults ?? []).filter((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1");

    expect(result.status).toBe("repair_dispatched");
    expect(secondWriter.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(lifecycle?.reviewRound).toBe(0);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(2);
    expect(lifecycle?.phase).toBe("implementation");
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.lastMergeGateResultId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.mergeGate?.repairRunId).toBeNull();
    expect(lifecycle?.mergeGate?.repairReportId).toBeNull();
    expect(gateResults).toHaveLength(1);
    expect(gateResults[0]?.writebackOperationKeys).toEqual([
      "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_test_failure:r2",
      "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_test_failure:r2:In Progress",
    ]);
    expect(client.mergeInput).toBeNull();
  });

  it("blocks a same-head merge gate re-failure at the repair ceiling", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { reviewRound: 1 });
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client,
    });
    await firstService.reconcileIssue(currentIssue);
    currentIssue.state = "Ready to Merge";
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      summaryPointers: { ciStatus: "success" },
    });

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("blocked");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Blocked",
        reason: "Symphony merge gate repair ceiling reached",
      },
    ]);
    expect(lifecycle?.phase).toBe("blocked");
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(3);
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.lastMergeGateResultId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.blockedReason).toContain("3/3");
    expect(lifecycle?.mergeGateResults?.find((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")?.writebackOperationKeys).toEqual([
      "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:blocked:head-sha-1_test_failure:r3",
      "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:blocked:head-sha-1_test_failure:r3:Blocked",
    ]);
  });

  it("carries merge-gate repair rounds across same-PR superseded heads", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { reviewRound: 2 });
    await runStore.startRun({
      runId: "worker-run-2",
      role: "worker",
      issueId: currentIssue.id,
      issueIdentifier: currentIssue.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "repair",
      workspaceKey: currentIssue.identifier,
      workspacePath: path.join(root, currentIssue.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await runStore.recordPullRequestEvent({
      runId: "worker-run-2",
      action: "updated",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-2",
      prBranch: "symphony/TEST-1",
    });
    const existing = await lifecycleStore.get(currentIssue.id);
    const previousReport = existing?.completionReports[0];
    if (!previousReport) throw new Error("expected seeded completion report");
    const report = {
      ...previousReport,
      id: "completion-report:issue-1:report-2",
      idempotencyKey: "report-2",
      runId: "worker-run-2",
      changedFiles: [],
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
      acceptedAt: "2026-01-01T00:00:03.000Z",
    };
    const verdict = postRepairPassVerdict(currentIssue, "2026-01-01T00:00:04.000Z");
    const feedback = {
      ...postRepairApprovalFeedback(currentIssue, "2026-01-01T00:00:04.000Z"),
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
    };
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastCompletionReportId: report.id,
      lastReviewVerdictId: verdict.id,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-2",
        prBranch: "symphony/TEST-1",
      },
      completionReports: [...(existing?.completionReports ?? []), report],
      reviewVerdicts: [...(existing?.reviewVerdicts ?? []), verdict],
      reviewFeedback: [...(existing?.reviewFeedback ?? []), feedback],
      mergeGate: mergeGateState({
        status: "superseded",
        headSha: "head-sha-1",
        reviewRound: 2,
        supersededByHeadSha: "head-sha-2",
        repairRunId: null,
        repairReportId: null,
      }),
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        headSha: "head-sha-2",
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("blocked");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "blocked",
      headSha: "head-sha-2",
      reviewRound: 3,
    });
    expect(lifecycle?.blockedReason).toContain("3/3");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Blocked",
        reason: "Symphony merge gate repair ceiling reached",
      },
    ]);
  });

  it("keeps same-head repair gate blocking when checks recover before repair completion", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    currentIssue.state = "Ready to Merge";
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      summaryPointers: { ciStatus: "failure" },
    });
    const client = new FakeMergeClient();
    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect((lifecycle?.mergeGateResults ?? []).filter((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: "head-sha-1:test:failure",
    });
    expect(lifecycle?.mergeGateResults?.find((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toMatchObject({
      findings: ["Required check failed: test: failure / failure (https://ci.test/test)"],
      evidence: ["PR: #42 (https://github.com/acme/symphony/pull/42)", "PR head SHA: head-sha-1", "Failing check: test: failure / failure (https://ci.test/test)"],
    });
  });

  it("returns repair dispatched when checks pass during implementation before repair completion", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    currentIssue.state = "Ready to Merge";
    const beforeRecover = await lifecycleStore.get(currentIssue.id);
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle).toEqual(beforeRecover);
  });

  it("merges after repair completion, review pass, and a fresh successful check fetch", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    const afterFailure = await lifecycleStore.get(currentIssue.id);
    const repairReport = {
      ...afterFailure!.completionReports[0]!,
      id: "completion-report:issue-1:repair-1",
      idempotencyKey: "repair-1",
      acceptedAt: "2099-01-01T00:10:00.000Z",
    };
    const postRepairVerdict = postRepairPassVerdict(currentIssue, "2099-01-01T00:11:00.000Z");
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "review",
      lastCompletionReportId: repairReport.id,
      completionReports: [...afterFailure!.completionReports, repairReport],
      mergeGate: {
        ...afterFailure!.mergeGate!,
        repairRunId: repairReport.runId,
        repairReportId: repairReport.id,
      },
    });
    currentIssue.state = "Ready to Merge";
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: postRepairVerdict.id,
      reviewVerdicts: [...afterFailure!.reviewVerdicts, postRepairVerdict],
      reviewFeedback: [...afterFailure!.reviewFeedback, postRepairApprovalFeedback(currentIssue, "2099-01-01T00:11:00.000Z")],
    });
    expect(latestCurrentApprovalPassVerdict((await lifecycleStore.get(currentIssue.id))!)?.id).toBe(postRepairVerdict.id);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(currentIssue.state).toBe("Done");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "resolved",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
    });
    expect(lifecycle?.summaryPointers.ciStatus).toBe("success");
    expect(lifecycle?.mergeGateResults?.find((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toMatchObject({
      supersededReason: "merge_gate_resolved",
    });
  });

  it.each<{
    name: string;
    checkResults: PullRequestCheckResult[];
    expectedCheck: { outcome: IssueMergeGateState["checks"][number]["outcome"]; rawStatus: IssueMergeGateState["checks"][number]["rawStatus"] };
  }>([
    {
      name: "pending",
      checkResults: [{ name: "test", status: "pending", conclusion: null, url: "https://ci.test/test" }],
      expectedCheck: { outcome: "pending", rawStatus: "pending" },
    },
    {
      name: "unknown",
      checkResults: [{ name: "test", status: "unknown", conclusion: null, url: "https://ci.test/test" }],
      expectedCheck: { outcome: "unknown", rawStatus: "unknown" },
    },
    {
      name: "fresh missing",
      checkResults: [],
      expectedCheck: { outcome: "missing_observed", rawStatus: "missing" },
    },
  ])("preserves post-repair approval through a passive $name observation before merging", async ({ checkResults, expectedCheck }) => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    const afterFailure = await lifecycleStore.get(currentIssue.id);
    const repairReport = {
      ...afterFailure!.completionReports[0]!,
      id: "completion-report:issue-1:repair-1",
      idempotencyKey: "repair-1",
      acceptedAt: "2099-01-01T00:10:00.000Z",
    };
    const postRepairVerdict = postRepairPassVerdict(currentIssue, "2099-01-01T00:11:00.000Z");
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastCompletionReportId: repairReport.id,
      lastReviewVerdictId: postRepairVerdict.id,
      completionReports: [...afterFailure!.completionReports, repairReport],
      reviewVerdicts: [...afterFailure!.reviewVerdicts, postRepairVerdict],
      reviewFeedback: [...afterFailure!.reviewFeedback, postRepairApprovalFeedback(currentIssue, "2099-01-01T00:11:00.000Z")],
      mergeGate: {
        ...afterFailure!.mergeGate!,
        repairRunId: repairReport.runId,
        repairReportId: repairReport.id,
      },
    });
    currentIssue.state = "Ready to Merge";

    const passiveWriter = new MemoryWriter(currentIssue);
    const passiveClient = new FakeMergeClient({ checkResults });
    const passiveService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, passiveWriter, new StructuredLogger(() => undefined), 60_000),
      client: passiveClient,
    });
    const passiveResult = await passiveService.reconcileIssue(currentIssue);
    const afterPassive = await lifecycleStore.get(currentIssue.id);

    expect(passiveResult.status).toBe("repair_dispatched");
    expect(passiveClient.mergeInput).toBeNull();
    expect(passiveWriter.transitions).toEqual([]);
    expect(passiveWriter.comments).toEqual([]);
    expect(afterPassive?.lastReviewVerdictId).toBe(postRepairVerdict.id);
    expect(afterPassive?.summaryPointers.ciStatus).toBe("failure");
    expect(afterPassive?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      repairRunId: repairReport.runId,
      repairReportId: repairReport.id,
      checks: [{ name: "test", ...expectedCheck }],
    });

    const mergeWriter = new MemoryWriter(currentIssue);
    const mergeClient = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const mergeService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, mergeWriter, new StructuredLogger(() => undefined), 60_000),
      client: mergeClient,
    });

    const mergeResult = await mergeService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(mergeResult.status).toBe("merged");
    expect(mergeClient.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(mergeWriter.comments).toEqual([]);
    expect(mergeWriter.transitions).toEqual([
      { issueId: "issue-1", fromStates: ["Ready to Merge"], toState: "Done", reason: "Symphony reviewer-approved merge completed" },
    ]);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "resolved",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
    });
    expect(lifecycle?.summaryPointers.ciStatus).toBe("success");
  });

  it("keeps repair gate blocking when post-repair approval feedback is missing", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    const afterFailure = await lifecycleStore.get(currentIssue.id);
    const repairReport = {
      ...afterFailure!.completionReports[0]!,
      id: "completion-report:issue-1:repair-1",
      idempotencyKey: "repair-1",
      acceptedAt: "2099-01-01T00:10:00.000Z",
    };
    const postRepairVerdict = postRepairPassVerdict(currentIssue, "2099-01-01T00:11:00.000Z");
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastCompletionReportId: repairReport.id,
      lastReviewVerdictId: postRepairVerdict.id,
      completionReports: [...afterFailure!.completionReports, repairReport],
      reviewVerdicts: [...afterFailure!.reviewVerdicts, postRepairVerdict],
      mergeGate: {
        ...afterFailure!.mergeGate!,
        repairRunId: repairReport.runId,
        repairReportId: repairReport.id,
      },
    });
    currentIssue.state = "Ready to Merge";
    const beforeRecover = await lifecycleStore.get(currentIssue.id);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle).toEqual(beforeRecover);
  });

  it("resolves an observing same-head gate when checks later pass", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    await lifecycleStore.updateIssue(currentIssue, {
      mergeGate: mergeGateState({
        status: "observing",
        checks: [
          {
            name: "test",
            outcome: "pending",
            rawStatus: "pending",
            conclusion: null,
            url: "https://ci.test/test",
            firstObservedAt: null,
            actionableSince: null,
          },
        ],
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: null,
        writebackOperationKeys: [],
      }),
    });
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "resolved",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
      writebackOperationKeys: [],
    });
  });

  it("does not resolve an observing gate before APPROVE feedback validation", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { includeApproval: false });
    await lifecycleStore.updateIssue(currentIssue, {
      mergeGate: mergeGateState({
        status: "observing",
        checks: [
          {
            name: "test",
            outcome: "pending",
            rawStatus: "pending",
            conclusion: null,
            url: "https://ci.test/test",
            firstObservedAt: null,
            actionableSince: null,
          },
        ],
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: null,
        writebackOperationKeys: [],
      }),
    });
    const beforeRecover = await lifecycleStore.get(currentIssue.id);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/APPROVE/);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle).toEqual(beforeRecover);
    expect(lifecycle?.mergeGate?.status).toBe("observing");
    expect(lifecycle?.summaryPointers.ciStatus).not.toBe("success");
  });

  it("keeps merge gate verdicts through completion acceptance and reactivates failing checks after review pass", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client,
    });
    await firstService.reconcileIssue(currentIssue);
    const afterFailure = await lifecycleStore.get(currentIssue.id);
    const repairReport = {
      ...afterFailure!.completionReports[0]!,
      id: "completion-report:issue-1:repair-1",
      idempotencyKey: "repair-1",
      acceptedAt: "2026-01-01T00:10:00.000Z",
    };
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "review",
      lastCompletionReportId: repairReport.id,
      completionReports: [...afterFailure!.completionReports, repairReport],
    });
    const accepted = await lifecycleStore.get(currentIssue.id);
    expect((accepted?.mergeGateResults ?? []).filter((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
    expect(accepted?.summaryPointers.ciStatus).toBe("failure");
    currentIssue.state = "Ready to Merge";
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
    });

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toHaveLength(1);
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.lastMergeGateResultId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
  });

  it("reactivates failing checks after repair approval even when last verdict still points at the merge gate", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client,
    });
    await firstService.reconcileIssue(currentIssue);
    const afterFailure = await lifecycleStore.get(currentIssue.id);
    const repairReport = {
      ...afterFailure!.completionReports[0]!,
      id: "completion-report:issue-1:repair-1",
      idempotencyKey: "repair-1",
      acceptedAt: "2099-01-01T00:10:00.000Z",
    };
    const postRepairVerdict = postRepairPassVerdict(currentIssue, "2099-01-01T00:11:00.000Z");
    currentIssue.state = "Ready to Merge";
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "passed",
      blockedReason: null,
      lastCompletionReportId: repairReport.id,
      lastReviewVerdictId: afterFailure!.mergeGate!.id,
      completionReports: [...afterFailure!.completionReports, repairReport],
      reviewVerdicts: [...afterFailure!.reviewVerdicts, postRepairVerdict],
      reviewFeedback: [...afterFailure!.reviewFeedback, postRepairApprovalFeedback(currentIssue, "2099-01-01T00:11:00.000Z")],
      mergeGate: {
        ...afterFailure!.mergeGate!,
        repairRunId: repairReport.runId,
        repairReportId: repairReport.id,
      },
    });

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(2);
    expect(lifecycle?.mergeGate?.repairRunId).toBeNull();
    expect(lifecycle?.mergeGate?.repairReportId).toBeNull();
    expect(lifecycle?.lastReviewVerdictId).toBe(postRepairVerdict.id);
    expect(lifecycle?.lastMergeGateResultId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
  });

  it("reobserves an already dispatched merge gate failure without duplicate writebacks", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    config.mergePolicy.sourceStates.push("In Progress");
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client,
    });
    await firstService.reconcileIssue(currentIssue);
    expect(currentIssue.state).toBe("In Progress");

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(1);
    expect((lifecycle?.mergeGateResults ?? []).filter((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
  });

  it("refreshes active repair observations without duplicate writebacks or round burn in In Progress", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    config.mergePolicy.sourceStates.push("In Progress");
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);

    const pendingWriter = new MemoryWriter(currentIssue);
    const pendingService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, pendingWriter, new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "pending", conclusion: null, url: "https://ci.test/test" }],
      }),
    });

    const pendingResult = await pendingService.reconcileIssue(currentIssue);
    let lifecycle = await lifecycleStore.get(currentIssue.id);
    let mergeGatePrompt = lifecycle ? formatWorkerMergeGatePromptResult(lifecycle) : null;

    expect(pendingResult.status).toBe("repair_dispatched");
    expect(pendingWriter.transitions).toEqual([]);
    expect(pendingWriter.comments).toEqual([]);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(1);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      blockerFingerprint: "head-sha-1:test:failure",
      checks: [{ name: "test", outcome: "pending", rawStatus: "pending" }],
    });
    expect(mergeGatePrompt?.kind).toBe("repair");
    expect(mergeGatePrompt?.text).toContain("test: pending (https://ci.test/test)");

    const refailureWriter = new MemoryWriter(currentIssue);
    const refailureService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, refailureWriter, new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });

    const refailureResult = await refailureService.reconcileIssue(currentIssue);
    lifecycle = await lifecycleStore.get(currentIssue.id);
    mergeGatePrompt = lifecycle ? formatWorkerMergeGatePromptResult(lifecycle) : null;
    const automationBlocked = lifecycle?.mergeGate?.status === "repair_dispatched" || lifecycle?.mergeGate?.status === "blocked";

    expect(refailureResult.status).toBe("repair_dispatched");
    expect(refailureWriter.transitions).toEqual([]);
    expect(refailureWriter.comments).toEqual([]);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(1);
    expect((lifecycle?.mergeGateResults ?? []).filter((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      blockerFingerprint: "head-sha-1:test:failure",
      checks: [{ name: "test", outcome: "failing", rawStatus: "failure" }],
    });
    expect(automationBlocked).toBe(true);
    expect(mergeGatePrompt?.kind).toBe("repair");
    expect(mergeGatePrompt?.text).toContain("test: failing / failure (https://ci.test/test)");
    expect(mergeGatePrompt?.text).not.toContain("test: pending (https://ci.test/test)");
  });

  it("reobserves an already dispatched actionable missing check without duplicate writebacks", async () => {
    const config = mergeConfig({ requiredChecks: ["test", "typecheck"] });
    config.mergePolicy.sourceStates.push("In Progress");
    config.mergePolicy.missingCheckStabilizationMs = 0;
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client,
    });
    await firstService.reconcileIssue(currentIssue);
    expect(currentIssue.state).toBe("In Progress");

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(1);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      blockerFingerprint: "head-sha-1:typecheck:missing",
      checks: [{ name: "test", outcome: "passing" }, { name: "typecheck", outcome: "missing_actionable" }],
    });
    expect((lifecycle?.mergeGateResults ?? []).filter((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
  });

  it("dispatches distinct merge-gate writebacks when the same-head blocker fingerprint changes", async () => {
    const config = mergeConfig({ requiredChecks: ["test", "typecheck"] });
    config.mergePolicy.sourceStates.push("In Progress");
    config.mergePolicy.missingCheckStabilizationMs = 0;
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [
          { name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" },
          { name: "typecheck", status: "success", conclusion: "success", url: "https://ci.test/typecheck" },
        ],
      }),
    });
    await firstService.reconcileIssue(currentIssue);

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
      }),
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);
    const gateResult = lifecycle?.mergeGateResults?.find((result) => result.id === "merge-gate:issue-1:pr-42:head-sha-1");

    expect(result.status).toBe("repair_dispatched");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["In Progress"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(writer.comments[0]?.dedupeKey).toContain("head-sha-1_typecheck_missing");
    expect(lifecycle?.reviewRound).toBe(0);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(1);
    expect(lifecycle?.mergeGate?.blockerFingerprint).toBe("head-sha-1:typecheck:missing");
    expect(gateResult).toMatchObject({
      idempotencyKey: "merge-gate:issue-1:pr-42:head-sha-1:repair:head-sha-1:typecheck:missing",
      writebackOperationKeys: [
        "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_typecheck_missing:r1",
        "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:repair:head-sha-1_typecheck_missing:r1:In Progress",
      ],
    });
  });

  it("blocks from the merge source state when the merge gate repair ceiling is reached", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { reviewRound: 2 });
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    const result = await service.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("blocked");
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Blocked",
        reason: "Symphony merge gate repair ceiling reached",
      },
    ]);
    expect(currentIssue.state).toBe("Blocked");
    expect(lifecycle?.phase).toBe("blocked");
    expect(lifecycle?.reviewRound).toBe(2);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(3);
    expect(lifecycle?.blockedReason).toContain("max merge gate failures reached");
  });

  it("preserves a blocked merge gate while same-head checks are pending", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    config.mergePolicy.sourceStates.push("Blocked");
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { reviewRound: 2 });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    const afterBlocked = await lifecycleStore.get(currentIssue.id);
    const blockedReason = afterBlocked?.blockedReason;
    const operationKeys = afterBlocked?.mergeGate?.writebackOperationKeys ?? [];
    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "pending", conclusion: null, url: "https://ci.test/test" }],
      }),
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);
    const mergeGatePrompt = lifecycle ? formatWorkerMergeGatePromptResult(lifecycle) : null;
    const automationBlocked = lifecycle?.mergeGate?.status === "repair_dispatched" || lifecycle?.mergeGate?.status === "blocked";

    expect(result.status).toBe("blocked");
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(currentIssue.state).toBe("Blocked");
    expect(lifecycle?.phase).toBe("blocked");
    expect(lifecycle?.reviewRound).toBe(2);
    expect(lifecycle?.mergeGate?.reviewRound).toBe(3);
    expect(lifecycle?.blockedReason).toBe(blockedReason);
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.lastMergeGateResultId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "blocked",
      blockerFingerprint: "head-sha-1:test:failure",
      writebackOperationKeys: operationKeys,
      checks: [{ name: "test", outcome: "pending", rawStatus: "pending" }],
    });
    expect(automationBlocked).toBe(true);
    expect(mergeGatePrompt?.kind).toBe("repair");
    expect(mergeGatePrompt?.text).toContain("Status: blocked");
    expect(mergeGatePrompt?.text).toContain("test: pending (https://ci.test/test)");
  });

  it("resolves a blocked same-head gate when checks pass after out-of-band CI recovery", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue, { reviewRound: 2 });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue), new StructuredLogger(() => undefined), 60_000),
      client: new FakeMergeClient({
        checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
      }),
    });
    await firstService.reconcileIssue(currentIssue);
    const afterBlocked = await lifecycleStore.get(currentIssue.id);
    const repairReport = {
      ...afterBlocked!.completionReports[0]!,
      id: "completion-report:issue-1:repair-1",
      idempotencyKey: "repair-1",
      acceptedAt: "2099-01-01T00:10:00.000Z",
    };
    const postRepairVerdict = postRepairPassVerdict(currentIssue, "2099-01-01T00:11:00.000Z");
    await lifecycleStore.updateIssue(currentIssue, {
      phase: "blocked",
      blockedReason: "max merge gate failures reached (3/3)",
      lastCompletionReportId: repairReport.id,
      lastReviewVerdictId: postRepairVerdict.id,
      completionReports: [...afterBlocked!.completionReports, repairReport],
      reviewVerdicts: [...afterBlocked!.reviewVerdicts, postRepairVerdict],
      reviewFeedback: [...afterBlocked!.reviewFeedback, postRepairApprovalFeedback(currentIssue, "2099-01-01T00:11:00.000Z")],
      mergeGate: {
        ...afterBlocked!.mergeGate!,
        repairRunId: repairReport.runId,
        repairReportId: repairReport.id,
      },
    });
    currentIssue.state = "Ready to Merge";
    const writer = new MemoryWriter(currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "success", conclusion: "success", url: "https://ci.test/test" }],
    });
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Done",
        reason: "Symphony reviewer-approved merge completed",
      },
    ]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.phase).toBe("passed");
    expect(lifecycle?.blockedReason).toBeNull();
    expect(lifecycle?.summaryPointers.ciStatus).toBe("success");
    expect(lifecycle?.mergeGate?.status).toBe("resolved");
    expect(lifecycle?.merge).toMatchObject({ headSha: "head-sha-1" });
  });

  it("retries a skipped merge gate repair writeback without merging or burning another round", async () => {
    const config = mergeConfig({ requiredChecks: ["test"] });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({
      checkResults: [{ name: "test", status: "failure", conclusion: "failure", url: "https://ci.test/test" }],
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const firstService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, new MemoryWriter(currentIssue, "skipped"), new StructuredLogger(() => undefined), 60_000),
      client,
    });

    await expect(firstService.reconcileIssue(currentIssue)).rejects.toThrow(/Merge gate writeback did not succeed/);
    expect((await lifecycleStore.get(currentIssue.id))?.reviewRound).toBe(0);
    expect(client.mergeInput).toBeNull();

    const writer = new MemoryWriter(currentIssue);
    const secondService = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 60_000),
      client,
    });

    const result = await secondService.reconcileIssue(currentIssue);
    const lifecycle = await lifecycleStore.get(currentIssue.id);

    expect(result.status).toBe("repair_dispatched");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("In Progress");
    expect(lifecycle?.mergeGate?.reviewRound).toBe(1);
  });

  it("rejects a successful Done writeback when the tracker still reports a non-Done state", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient();
    const writer = new MemoryWriter(currentIssue, "verified");
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/Done writeback could not be verified/);
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(writer.transitions).toEqual([
      { issueId: "issue-1", fromStates: ["Ready to Merge"], toState: "Done", reason: "Symphony reviewer-approved merge completed" },
    ]);
    expect(currentIssue.state).toBe("Ready to Merge");
  });

  it("enforces service-owned github.merge capability when a merge client is injected", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      credentialProfiles: {
        profiles: {
          merge: { value: "$GITHUB_MERGE_PROFILE_TOKEN", capabilities: ["github.merge"] },
        },
        roles: {
          worker: {
            "github.merge": "merge",
          },
        },
      },
      env: { GITHUB_MERGE_PROFILE_TOKEN: "merge-profile-secret" },
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient();
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/github\.merge is owned by service/);
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
  });

  it("enforces service-owned linear.writeback capability when writeback is injected", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      credentialProfiles: {
        profiles: {
          writeback: { value: "$LINEAR_WRITEBACK_PROFILE_TOKEN", capabilities: ["linear.writeback"] },
        },
        roles: {
          worker: {
            "linear.writeback": "writeback",
          },
        },
      },
      env: { LINEAR_WRITEBACK_PROFILE_TOKEN: "linear-writeback-profile-secret" },
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient();
    const writer = new MemoryWriter(currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        writer,
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/linear\.writeback is owned by service/);
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
  });

  it("records the explicit service github.merge profile in merge metadata", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      credentialProfiles: {
        profiles: {
          merge: { value: "$SERVICE_GITHUB_MERGE_TOKEN", capabilities: ["github.merge"] },
        },
        roles: {
          service: {
            "github.merge": "merge",
          },
        },
      },
      env: { SERVICE_GITHUB_MERGE_TOKEN: "service-merge-secret" },
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient(),
    });

    await service.reconcileIssue(currentIssue);
    expect((await lifecycleStore.get(currentIssue.id))?.merge?.mergedBy).toMatchObject({
      capability: "github.merge",
      profile: "merge",
    });
  });

  it("allows GitHub App installation auth for service-owned merge", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      github: {
        owner: "acme",
        repo: "symphony",
        app: { app_id: "12345", installation_id: "67890", private_key: "fake-private-key" },
      },
    });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const service = new MergePolicyService({
      config,
      tracker: tracker(currentIssue),
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(
        new FileWritebackOutboxStore(config.workspace.stateDir),
        new MemoryWriter(currentIssue),
        new StructuredLogger(() => undefined),
        60_000,
      ),
      client: new FakeMergeClient(),
    });

    await service.reconcileIssue(currentIssue);
    expect((await lifecycleStore.get(currentIssue.id))?.merge?.mergedBy).toMatchObject({
      capability: "github.merge",
      profile: null,
    });
  });
});

function mergeConfig(input: {
  requiredChecks?: string[];
  noCiEvidence?: string;
  writebackMode?: "live" | "dry_run";
  conflictsState?: string;
  credentialProfiles?: Record<string, unknown>;
  github?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}) {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
        ...(input.conflictsState === undefined ? {} : { active_states: ["Todo", "In Progress"] }),
      },
      workspace: { root },
      writeback: { enabled: true, mode: input.writebackMode ?? "live" },
      review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge", blocked_states: ["Blocked"] },
      merge_policy: {
        mode: "gated",
        source_states: ["Ready to Merge"],
        ...(input.conflictsState === undefined ? {} : { conflicts_state: input.conflictsState }),
        done_state: "Done",
        merge_method: "squash",
        required_checks: input.requiredChecks ?? [],
        no_ci:
          input.noCiEvidence === undefined
            ? { allowed: false }
            : { allowed: true, evidence: input.noCiEvidence },
      },
      github: input.github ?? { owner: "acme", repo: "symphony" },
      ...(input.credentialProfiles === undefined ? {} : { credential_profiles: input.credentialProfiles }),
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "github-secret", ...input.env },
  );
}

async function seedLifecycle(
  lifecycleStore: FileIssueLifecycleStore,
  runStore: FileRunTranscriptStore,
  currentIssue: Issue,
  options: { includeApproval?: boolean; reviewRound?: number } = {},
): Promise<void> {
  await runStore.startRun({
    runId: "worker-run-1",
    role: "worker",
    issueId: currentIssue.id,
    issueIdentifier: currentIssue.identifier,
    attempt: null,
    turnNumber: 1,
    prompt: "work",
    workspaceKey: currentIssue.identifier,
    workspacePath: path.join(root, currentIssue.identifier),
    gitBranchName: "symphony/TEST-1",
    repoPath: "/repo",
    baseRef: "main",
  });
  await runStore.recordPullRequestEvent({
    runId: "worker-run-1",
    action: "opened",
    prUrl: "https://github.com/acme/symphony/pull/42",
    prNumber: 42,
    prHeadSha: "head-sha-1",
    prBranch: "symphony/TEST-1",
  });
  await lifecycleStore.ensureIssue(currentIssue, {
    phase: "passed",
    reviewRound: options.reviewRound ?? 0,
    lastCompletionReportId: "completion-report:issue-1:report-1",
    lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
    summaryPointers: {
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-1",
      prBranch: "symphony/TEST-1",
    },
    completionReports: [
      {
        id: "completion-report:issue-1:report-1",
        idempotencyKey: "report-1",
        runId: "worker-run-1",
        issueId: currentIssue.id,
        issueIdentifier: currentIssue.identifier,
        summary: "Implemented the change.",
        validationEvidence: ["npm test"],
        acceptanceChecklist: [{ text: "Works", satisfied: true, evidence: "tests" }],
        changedFiles: ["src/index.ts"],
        branchName: "symphony/TEST-1",
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        risks: [],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        writebackOperationKeys: [],
      },
    ],
    reviewVerdicts: [
      {
        id: "review-verdict:issue-1:verdict-pass-1",
        idempotencyKey: "verdict-pass-1",
        runId: "review-run-1",
        issueId: currentIssue.id,
        issueIdentifier: currentIssue.identifier,
        verdict: "pass",
        acceptanceResults: [{ text: "Works", satisfied: true, evidence: "reviewed" }],
        findings: [],
        gateFindings: [],
        discoveryFindings: [],
        evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
        reviewer: "reviewer-1",
        submittedAt: "2026-01-01T00:00:01.000Z",
        writebackOperationKeys: [],
      },
    ],
    reviewFeedback:
      options.includeApproval === false
        ? []
        : [
            {
              id: "review-feedback:issue-1:review-run-1:approve",
              idempotencyKey: "approve",
              requestHash: "hash",
              runId: "review-run-1",
              issueId: currentIssue.id,
              issueIdentifier: currentIssue.identifier,
              kind: "review",
              event: "APPROVE",
              body: "Approved.",
              pullRequest: {
                url: "https://github.com/acme/symphony/pull/42",
                number: 42,
                headSha: "head-sha-1",
                branch: "symphony/TEST-1",
              },
              reviewer: "reviewer-1",
              reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
              commentUrls: [],
              submittedAt: "2026-01-01T00:00:01.000Z",
            },
          ],
    mergeGate:
      (options.reviewRound ?? 0) > 0
        ? mergeGateState({ status: "repair_dispatched", headSha: "head-sha-1", reviewRound: options.reviewRound ?? 0 })
        : null,
  });
}

function mergeConflictRecord(input: { resolutionStatus?: "pending" | "resolved"; resolvedHeadSha?: string | null } = {}) {
  const resolved = input.resolutionStatus === "resolved";
  return {
    id: "merge-conflict:issue-1:head-sha-1",
    status: resolved ? ("resolved" as const) : ("open" as const),
    resolutionStatus: input.resolutionStatus ?? ("pending" as const),
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: input.resolvedHeadSha ?? "head-sha-1",
      branch: "symphony/TEST-1",
    },
    approvedHeadSha: "head-sha-1",
    currentHeadSha: input.resolvedHeadSha ?? "head-sha-1",
    resolvedHeadSha: input.resolvedHeadSha ?? null,
    baseBranch: "main",
    baseHeadSha: "base-sha-1",
    sourceState: "Ready to Merge",
    conflictsState: "Approved with Conflicts",
    reason: "Pull request has merge conflicts with the base branch",
    mergeableState: "dirty",
    servicePreparation: null,
    detectedAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    fixTurnCount: 1,
    maxFixTurns: 3,
    lastConflictFixRunId: resolved ? "conflict-run-1" : null,
    lastConflictResolutionReportId: resolved ? "merge-conflict-resolution:issue-1:resolve-1" : null,
    attemptRunIds: [],
    writebackOperationKeys: [],
    blockedAt: null,
    blockedReason: null,
  };
}

function baseRefObservation(overrides: Partial<IssueBaseRefObservation> = {}): IssueBaseRefObservation {
  return {
    version: 1,
    inputFingerprint: "base-ref-fingerprint",
    classification: "branch_not_based_on_live_base",
    operation: "dispatch_reviewer",
    checkedAt: "2026-01-01T00:00:02.000Z",
    workspacePath: path.join(root, "TEST-1"),
    branchName: "symphony/TEST-1",
    baseRef: "main",
    normalizedBaseBranch: "main",
    localBaseRef: "refs/remotes/origin/main",
    githubBaseHeadSha: "base-sha-2",
    localBaseHeadShaBeforeFetch: "base-sha-1",
    localBaseHeadShaAfterFetch: "base-sha-2",
    worktreeHeadSha: "head-sha-1",
    localBaseIsAncestorOfHead: false,
    reason: "Worktree HEAD is not based on the live origin base",
    error: null,
    ...overrides,
  };
}

function mockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function missingStateTracker(): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [];
    },
  };
}

function sequenceTracker(issues: Issue[]): TrackerClient {
  let fetchIndex = 0;
  return {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates(states) {
      const current = issues[Math.min(fetchIndex, issues.length - 1)];
      return current && states.includes(current.state) ? [{ ...current }] : [];
    },
    async fetchIssueStatesByIds() {
      const current = issues[Math.min(fetchIndex, issues.length - 1)];
      fetchIndex += 1;
      return current ? [{ ...current }] : [];
    },
  };
}

function tracker(currentIssue: Issue): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates(states) {
      return states.includes(currentIssue.state) ? [currentIssue] : [];
    },
    async fetchIssueStatesByIds() {
      return [currentIssue];
    },
  };
}

class FakeMergeClient implements MergePolicyGitHubClient {
  mergeInput: Parameters<MergePolicyGitHubClient["mergePullRequest"]>[0] | null = null;
  mergeCalls = 0;

  constructor(
    private readonly input: {
      headSha?: string;
      state?: string;
      merged?: boolean;
      mergeable?: boolean | null;
      mergeableState?: string | null;
      mergeCommitSha?: string | null;
      mergedAt?: string | null;
      mergedBy?: string | null;
      serviceLogin?: string | null;
      checkResults?: PullRequestCheckResult[];
      ancestor?: boolean;
      baseHeadSha?: string;
      liveBaseHeadSha?: string;
    } = {},
  ) {}

  async getPullRequest() {
    return {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: this.input.headSha ?? "head-sha-1",
      lastPushedAt: "2026-01-01T00:00:00Z",
      state: this.input.state ?? "open",
      merged: this.input.merged ?? false,
      mergeable: this.input.mergeable === undefined ? true : this.input.mergeable,
      mergeableState: this.input.mergeableState === undefined ? "clean" : this.input.mergeableState,
      mergeCommitSha: this.input.mergeCommitSha ?? "merge-sha-1",
      mergedAt: this.input.mergedAt ?? "2026-01-01T00:00:02.000Z",
      mergedBy: this.input.mergedBy ?? "symphony-bot",
      baseBranch: "main",
      baseHeadSha: this.input.baseHeadSha ?? "base-sha-1",
    };
  }

  async getBranchHeadSha() {
    return this.input.liveBaseHeadSha ?? this.input.baseHeadSha ?? "base-sha-1";
  }

  async getRequiredCheckResults() {
    return (
      this.input.checkResults ?? [
        { name: "test", status: "success" as const, conclusion: "success", url: "https://ci.test/test" },
      ]
    );
  }

  async mergePullRequest(input: Parameters<MergePolicyGitHubClient["mergePullRequest"]>[0]) {
    this.mergeInput = input;
    this.mergeCalls += 1;
    return {
      merged: true,
      mergeCommitSha: "merge-sha-1",
      mergedAt: "2026-01-01T00:00:02.000Z",
      mergedBy: "symphony-bot",
    };
  }

  async getAuthenticatedLogin() {
    return this.input.serviceLogin ?? "symphony-bot";
  }

  async isAncestor() {
    return this.input.ancestor ?? true;
  }

  async gitAuthHeader() {
    return "AUTHORIZATION: bearer test-token";
  }
}

class FakeConflictGit extends ServiceOwnedMergeConflictGit {
  prepareInput: Parameters<ServiceOwnedMergeConflictGit["prepare"]>[0] | null = null;
  reprepareInput: Parameters<ServiceOwnedMergeConflictGit["reprepareAfterBaseDrift"]>[0] | null = null;
  refreshInput: Parameters<ServiceOwnedMergeConflictGit["refreshLocalBranchBase"]>[0] | null = null;
  publishInput: Parameters<ServiceOwnedMergeConflictGit["publishPreparedHead"]>[0] | null = null;
  preserveInput: Parameters<ServiceOwnedMergeConflictGit["preserveDirtyWorktree"]>[0] | null = null;
  applyInput: Parameters<ServiceOwnedMergeConflictGit["applyPreservedStash"]>[0] | null = null;
  dropInput: Parameters<ServiceOwnedMergeConflictGit["dropPreservedStash"]>[0] | null = null;
  preservedStash: IssuePreservedWorktreeStash | null = null;
  stashApplyResult: Awaited<ReturnType<ServiceOwnedMergeConflictGit["applyPreservedStash"]>> | null = null;
  localRefreshResult: Awaited<ReturnType<ServiceOwnedMergeConflictGit["refreshLocalBranchBase"]>> | null = null;

  constructor(private readonly result: ServiceOwnedMergeConflictPreparationResult) {
    super();
  }

  override async prepare(input: Parameters<ServiceOwnedMergeConflictGit["prepare"]>[0]) {
    this.prepareInput = input;
    return this.result;
  }

  override async reprepareAfterBaseDrift(input: Parameters<ServiceOwnedMergeConflictGit["reprepareAfterBaseDrift"]>[0]) {
    this.reprepareInput = input;
    return this.result;
  }

  override async refreshLocalBranchBase(input: Parameters<ServiceOwnedMergeConflictGit["refreshLocalBranchBase"]>[0]) {
    this.refreshInput = input;
    return (
      this.localRefreshResult ?? {
        status: "refreshed" as const,
        originalHeadSha: input.expectedHeadSha,
        liveBaseHeadSha: input.liveBaseHeadSha,
        refreshedHeadSha: input.liveBaseHeadSha,
        aheadCommitCount: 0,
        behindCommitCount: 0,
      }
    );
  }

  override async publishPreparedHead(input: Parameters<ServiceOwnedMergeConflictGit["publishPreparedHead"]>[0]) {
    this.publishInput = input;
  }

  override async preserveDirtyWorktree(input: Parameters<ServiceOwnedMergeConflictGit["preserveDirtyWorktree"]>[0]) {
    this.preserveInput = input;
    return this.preservedStash;
  }

  override async applyPreservedStash(input: Parameters<ServiceOwnedMergeConflictGit["applyPreservedStash"]>[0]) {
    this.applyInput = input;
    if (this.stashApplyResult === null) {
      return {
        status: "clean" as const,
        stash: { ...input.preservedStash, status: "applied_clean" as const, appliedAt: "2026-01-01T00:00:00.000Z" },
        changedFiles: input.preservedStash.dirtyFiles,
        headSha: this.result.status === "clean" ? this.result.rebasedHeadSha : input.preservedStash.originalHeadSha,
      };
    }
    return this.stashApplyResult;
  }

  override async dropPreservedStash(input: Parameters<ServiceOwnedMergeConflictGit["dropPreservedStash"]>[0]) {
    this.dropInput = input;
    return { ...input.preservedStash, status: "dropped" as const, droppedAt: "2026-01-01T00:00:01.000Z", dropError: null };
  }
}

function preservedStashRecord(workspacePath: string): IssuePreservedWorktreeStash {
  return {
    version: 1,
    id: "preserved-stash:issue-1:stash-1",
    operationId: "base-ref:issue-1:head-sha-1:base-sha-2",
    source: "base_ref_repair",
    stashRef: "refs/symphony/preserved-stashes/test/stash-1",
    stashSha: "stash-sha-1",
    message: "Symphony preserved local changes",
    workspacePath,
    branchName: "symphony/TEST-1",
    baseBranch: "main",
    originalHeadSha: "head-sha-1",
    dirtyFiles: ["src/local.ts"],
    status: "created",
    conflictedFiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    appliedAt: null,
    droppedAt: null,
    dropError: null,
  };
}

class MemoryWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: Array<{ issueId: string; body: string; dedupeKey: string }> = [];

  constructor(
    private readonly currentIssue?: Issue,
    private readonly transitionStatus: "applied" | "verified" | "skipped" = "applied",
  ) {}

  async transitionIssueState(input: TrackerTransitionInput) {
    this.transitions.push(input);
    if (this.transitionStatus === "applied" && this.currentIssue) this.currentIssue.state = input.toState;
    return this.transitionStatus === "skipped"
      ? { status: "skipped" as const, message: "source state mismatch" }
      : { status: this.transitionStatus };
  }

  async createIssueComment(input: { issueId: string; body: string; dedupeKey: string }) {
    this.comments.push(input);
    return { status: "applied" as const };
  }
}

function mergeGateState(overrides: Partial<IssueMergeGateState> = {}): IssueMergeGateState {
  const headSha = overrides.headSha ?? "head-sha-1";
  return {
    id: `merge-gate:issue-1:pr-42:${headSha}`,
    status: "repair_dispatched",
    headSha,
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha,
      branch: "symphony/TEST-1",
    },
    requiredChecks: ["test"],
    checks: [
      {
        name: "test",
        outcome: "failing",
        rawStatus: "failure",
        conclusion: "failure",
        url: "https://ci.test/test",
        firstObservedAt: null,
        actionableSince: null,
      },
    ],
    mergeability: null,
    reviewRound: 1,
    gateRunId: "worker-run-1",
    gateReportId: "completion-report:issue-1:report-1",
    repairRunId: "repair-run-1",
    repairReportId: "completion-report:issue-1:repair-1",
    blockerFingerprint: `${headSha}:test:failure`,
    writebackOperationKeys: [],
    supersededByHeadSha: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mergeGateVerdict(gate: IssueMergeGateState, currentIssue: Issue): IssueReviewVerdictRecord {
  return {
    id: gate.id,
    idempotencyKey: `${gate.id}:repair:${gate.blockerFingerprint ?? "no-blocker-fingerprint"}`,
    runId: gate.gateRunId ?? "worker-run-1",
    issueId: currentIssue.id,
    issueIdentifier: currentIssue.identifier,
    verdict: "fail",
    acceptanceResults: [{ text: "All configured required checks are passing before gated merge", satisfied: false, evidence: "test: failure" }],
    findings: ["Required check failed: test: failure"],
    gateFindings: [],
    discoveryFindings: [],
    evidence: ["Required checks: test", "Failing checks: test: failure"],
    reviewer: "symphony-merge-gate",
    submittedAt: "2026-01-01T00:00:01.000Z",
    writebackOperationKeys: gate.writebackOperationKeys,
  };
}

function postRepairPassVerdict(currentIssue: Issue, submittedAt: string): IssueReviewVerdictRecord {
  return {
    id: "review-verdict:issue-1:verdict-pass-2",
    idempotencyKey: "verdict-pass-2",
    runId: "review-run-2",
    issueId: currentIssue.id,
    issueIdentifier: currentIssue.identifier,
    verdict: "pass",
    acceptanceResults: [{ text: "Works after repair", satisfied: true, evidence: "reviewed after repair" }],
    findings: [],
    gateFindings: [],
    discoveryFindings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-2"],
    reviewer: "reviewer-2",
    submittedAt,
    writebackOperationKeys: [],
  };
}

function postRepairApprovalFeedback(currentIssue: Issue, submittedAt: string) {
  return {
    id: "review-feedback:issue-1:review-run-2:approve",
    idempotencyKey: "approve-2",
    requestHash: "hash-2",
    runId: "review-run-2",
    issueId: currentIssue.id,
    issueIdentifier: currentIssue.identifier,
    kind: "review" as const,
    event: "APPROVE" as const,
    body: "Approved after repair.",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    reviewer: "reviewer-2",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-2",
    commentUrls: [],
    submittedAt,
  };
}
