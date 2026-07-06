import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import { MergeConflictResolutionService } from "../src/core/MergeConflictResolutionService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";

describe("MergeConflictResolutionService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-merge-conflict-resolution-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records resolved conflict reports without re-entering normal review", async () => {
    const { service, lifecycleStore } = await fixture();

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "resolved", headSha: "head-sha-2" }),
      context(),
    );

    expect(result.replayed).toBe(false);
    expect(result.report.resolutionStatus).toBe("resolved");
    expect(result.report).toMatchObject({
      previousHeadSha: "head-sha-1",
      newHeadSha: "head-sha-2",
      baseBranch: "main",
      baseHeadSha: "base-sha-1",
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      blockedReason: null,
      summaryPointers: {
        prHeadSha: "head-sha-2",
        lastEvidenceCursor: "resolve-1",
      },
      mergeConflict: {
        status: "resolved",
        resolutionStatus: "resolved",
        approvedHeadSha: "head-sha-1",
        currentHeadSha: "head-sha-2",
        resolvedHeadSha: "head-sha-2",
        baseBranch: "main",
        baseHeadSha: "base-sha-1",
        lastConflictFixRunId: "conflict-run-1",
      },
      mergeConflictResolutionReports: [
        {
          id: "merge-conflict-resolution:issue-1:resolve-1",
          resolutionStatus: "resolved",
        },
      ],
    });
  });

  it("counts still-conflicted reports once and blocks at the configured conflict-fix limit", async () => {
    const { service, lifecycleStore, outbox } = await fixture({ fixTurnCount: 2 });

    const first = await service.submit_merge_conflict_resolution(
      resolutionReport({ idempotencyKey: "still-1", resolutionStatus: "still_conflicted" }),
      context(),
    );
    const replay = await service.submit_merge_conflict_resolution(
      resolutionReport({ idempotencyKey: "still-1", resolutionStatus: "still_conflicted" }),
      context(),
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      mergeConflict: {
        status: "blocked",
        resolutionStatus: "blocked",
        fixTurnCount: 3,
        attemptRunIds: ["conflict-run-1"],
        blockedReason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)",
      },
    });
    const operations = await outbox.list();
    expect(operations.some((operation) => operation.kind === "comment")).toBe(true);
    expect(operations.some((operation) => operation.kind === "transition")).toBe(true);
  });

  it("records explicit blocked reports with durable head and base metadata", async () => {
    const { service, lifecycleStore } = await fixture();

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({
        idempotencyKey: "blocked-1",
        resolutionStatus: "blocked",
        blockedReason: "conflict requires manual database migration review",
      }),
      context(),
    );
    const replay = await service.submit_merge_conflict_resolution(
      resolutionReport({
        idempotencyKey: "blocked-1",
        resolutionStatus: "blocked",
        blockedReason: "conflict requires manual database migration review",
      }),
      context(),
    );

    expect(result.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "conflict requires manual database migration review",
      mergeConflict: {
        status: "blocked",
        resolutionStatus: "blocked",
        approvedHeadSha: "head-sha-1",
        currentHeadSha: "head-sha-1",
        baseBranch: "main",
        baseHeadSha: "base-sha-1",
        blockedReason: "conflict requires manual database migration review",
      },
      mergeConflictResolutionReports: [
        expect.objectContaining({
          resolutionStatus: "blocked",
          previousHeadSha: "head-sha-1",
          newHeadSha: "head-sha-1",
          baseBranch: "main",
          baseHeadSha: "base-sha-1",
          blockedReason: "conflict requires manual database migration review",
        }),
      ],
    });
  });

  it("rejects idempotency replays with different head or base metadata", async () => {
    const { service } = await fixture();

    await service.submit_merge_conflict_resolution(
      resolutionReport({ idempotencyKey: "still-1", resolutionStatus: "still_conflicted" }),
      context(),
    );

    await expect(
      service.submit_merge_conflict_resolution(
        resolutionReport({ idempotencyKey: "still-1", resolutionStatus: "still_conflicted", baseHeadSha: "base-sha-2" }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects ordinary or mismatched issue state for conflict-resolution reports", async () => {
    const { service } = await fixture();

    await expect(
      service.submit_merge_conflict_resolution(
        resolutionReport({ resolutionStatus: "resolved" }),
        context({ issue: issue({ state: "In Progress" }) }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("finalizes a service-prepared conflict when the worker reports resolved file contents", async () => {
    const finalizerCalls: unknown[] = [];
    const { service, lifecycleStore } = await fixture({
      servicePreparation: servicePreparationRecord(),
      finalizer: {
        async finalize(input) {
          finalizerCalls.push(input);
          return { newHeadSha: "head-sha-2" };
        },
      },
    });

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "resolved", omitNewHeadSha: true }),
      context({ workspacePath: "/tmp/service-prepared-workspace" }),
    );

    expect(result.report.newHeadSha).toBe("head-sha-2");
    expect(finalizerCalls).toEqual([
      expect.objectContaining({
        workspacePath: "/tmp/service-prepared-workspace",
        branchName: "symphony/TEST-1",
        previousRemoteHeadSha: "head-sha-1",
        preparedBaseHeadSha: "base-sha-1",
        baseBranch: "main",
        conflictedFiles: ["src/index.ts"],
        changedFiles: ["src/index.ts"],
        authHeader: "AUTHORIZATION: bearer test-token",
      }),
    ]);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      summaryPointers: {
        prHeadSha: "head-sha-2",
      },
      mergeConflict: {
        status: "resolved",
        resolutionStatus: "resolved",
        currentHeadSha: "head-sha-2",
        resolvedHeadSha: "head-sha-2",
        servicePreparation: {
          status: "finalized",
          finalizedHeadSha: "head-sha-2",
        },
      },
      mergeConflictResolutionReports: [
        expect.objectContaining({
          newHeadSha: "head-sha-2",
        }),
      ],
    });
  });

  it("turns a pending preserved stash conflict into a stash-apply repair after squash finalization", async () => {
    const preservedStash = preservedStashRecord();
    const applyCalls: unknown[] = [];
    const { service, lifecycleStore } = await fixture({
      servicePreparation: servicePreparationRecord({ preservedStash }),
      finalizer: {
        async finalize() {
          return { newHeadSha: "head-sha-2" };
        },
        async applyPreservedStash(input) {
          applyCalls.push(input);
          return {
            status: "conflicted" as const,
            stash: {
              ...input.preservedStash,
              status: "apply_conflicted" as const,
              conflictedFiles: ["src/local.ts"],
              appliedAt: "2026-01-01T00:00:02.000Z",
            },
            changedFiles: ["src/local.ts"],
            conflictedFiles: ["src/local.ts"],
            headSha: "head-sha-2",
          };
        },
      },
    });

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "resolved", omitNewHeadSha: true }),
      context({ workspacePath: "/tmp/service-prepared-workspace" }),
    );

    expect(result.report.resolutionStatus).toBe("still_conflicted");
    expect(applyCalls).toEqual([expect.objectContaining({ preservedStash })]);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "merge_conflict_resolution",
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        currentHeadSha: "head-sha-2",
        reason: "Preserved local changes conflicted while restoring after service-owned repair",
        servicePreparation: {
          strategy: "stash_apply",
          status: "conflicted",
          originalHeadSha: "head-sha-2",
          currentHeadSha: "head-sha-2",
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

  it("finalizes stash-apply conflicts through service-owned git and routes back to implementation", async () => {
    const finalizerCalls: unknown[] = [];
    const { service, lifecycleStore } = await fixture({
      servicePreparation: stashApplyServicePreparationRecord(),
      finalizer: {
        async finalize() {
          throw new Error("squash finalizer should not be called for stash_apply");
        },
        async finalizeStashApply(input) {
          finalizerCalls.push(input);
          return {
            newHeadSha: "head-sha-3",
            preservedStash: {
              ...input.preservedStash,
              status: "dropped" as const,
              droppedAt: "2026-01-01T00:00:03.000Z",
            },
          };
        },
      },
    });

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "resolved", omitNewHeadSha: true, changedFiles: ["src/local.ts"] }),
      context({ workspacePath: "/tmp/stash-apply-workspace" }),
    );

    expect(result.report.newHeadSha).toBe("head-sha-3");
    expect(finalizerCalls).toEqual([
      expect.objectContaining({
        workspacePath: "/tmp/stash-apply-workspace",
        branchName: "symphony/TEST-1",
        previousRemoteHeadSha: "head-sha-1",
        allowedFiles: ["src/local.ts"],
        conflictedFiles: ["src/local.ts"],
        changedFiles: ["src/local.ts"],
      }),
    ]);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "implementation",
      summaryPointers: {
        prHeadSha: "head-sha-3",
        ciStatus: null,
      },
      mergeConflict: {
        status: "resolved",
        resolutionStatus: "resolved",
        currentHeadSha: "head-sha-3",
        resolvedHeadSha: "head-sha-3",
        servicePreparation: {
          strategy: "stash_apply",
          status: "finalized",
          finalizedHeadSha: "head-sha-3",
          preservedStash: {
            status: "dropped",
          },
        },
      },
      preservedWorktreeStashes: [
        expect.objectContaining({
          status: "dropped",
        }),
      ],
    });
  });

  it("re-prepares a service-owned conflict instead of blocking when the prepared base drifted", async () => {
    const finalizerCalls: unknown[] = [];
    const reprepareCalls: unknown[] = [];
    const { service, lifecycleStore, outbox } = await fixture({
      fixTurnCount: 1,
      servicePreparation: servicePreparationRecord(),
      finalizer: {
        async finalize(input) {
          finalizerCalls.push(input);
          throw new SymphonyError("conflict", "refs/remotes/origin/main resolved to base-sha-2, not prepared base base-sha-1", {
            kind: "prepared_base_ref_drift",
            refName: "refs/remotes/origin/main",
            actualSha: "base-sha-2",
            expectedSha: "base-sha-1",
            baseBranch: "main",
          });
        },
        async reprepareAfterBaseDrift(input) {
          reprepareCalls.push(input);
          return {
            status: "conflicted" as const,
            originalHeadSha: "head-sha-1",
            observedPrBaseHeadSha: "base-sha-2",
            liveBaseHeadSha: "base-sha-2",
            preparedBaseHeadSha: "base-sha-2",
            mergeBaseSha: "base-sha-0",
            squashCommitSha: "squash-sha-2",
            conflictedFiles: ["src/index.ts"],
          };
        },
      },
    });

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "resolved", omitNewHeadSha: true }),
      context({ workspacePath: "/tmp/service-prepared-workspace" }),
    );

    expect(result.report.resolutionStatus).toBe("still_conflicted");
    expect(finalizerCalls).toHaveLength(1);
    expect(reprepareCalls).toEqual([
      expect.objectContaining({
        workspacePath: "/tmp/service-prepared-workspace",
        branchName: "symphony/TEST-1",
        expectedHeadSha: "head-sha-1",
        baseBranch: "main",
        observedPrBaseHeadSha: "base-sha-2",
        liveBaseHeadSha: "base-sha-2",
      }),
    ]);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        currentHeadSha: "head-sha-1",
        baseHeadSha: "base-sha-2",
        fixTurnCount: 0,
        lastConflictFixRunId: null,
        attemptRunIds: [],
        blockedReason: null,
        servicePreparation: {
          status: "conflicted",
          liveBaseHeadSha: "base-sha-2",
          preparedBaseHeadSha: "base-sha-2",
          squashCommitSha: "squash-sha-2",
        },
      },
      mergeConflictResolutionReports: [
        expect.objectContaining({
          resolutionStatus: "still_conflicted",
          newHeadSha: "head-sha-1",
          baseHeadSha: "base-sha-2",
        }),
      ],
    });
    await expect(outbox.list()).resolves.toEqual([]);
  });

  it("accepts service-prepared still-conflicted reports without requiring worker git metadata", async () => {
    const { service, lifecycleStore } = await fixture({ servicePreparation: servicePreparationRecord() });

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "still_conflicted", omitNewHeadSha: true }),
      context(),
    );

    expect(result.report.newHeadSha).toBe("head-sha-1");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "merge_conflict_resolution",
      mergeConflict: {
        status: "open",
        resolutionStatus: "still_conflicted",
        currentHeadSha: "head-sha-1",
        servicePreparation: {
          status: "conflicted",
          finalizedHeadSha: null,
        },
      },
    });
  });

  it("accepts conflict-resolution reports with the issue state gate explicitly ignored", async () => {
    const { service, lifecycleStore } = await fixture();

    const result = await service.submit_merge_conflict_resolution(
      resolutionReport({ resolutionStatus: "resolved", headSha: "head-sha-2" }),
      context({
        issue: issue({ state: "In Progress" }),
        ignoreStateGate: true,
      }),
    );

    expect(result.replayed).toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      mergeConflict: {
        status: "resolved",
        resolutionStatus: "resolved",
        resolvedHeadSha: "head-sha-2",
      },
    });
  });

  async function fixture(input: {
    fixTurnCount?: number;
    servicePreparation?:
      | ReturnType<typeof servicePreparationRecord>
      | ReturnType<typeof stashApplyServicePreparationRecord>
      | null;
    finalizer?: ConstructorParameters<typeof MergeConflictResolutionService>[0]["finalizer"];
  } = {}) {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.mergePolicy.mode = "gated";
    config.mergePolicy.conflictsState = "Approved with Conflicts";
    config.mergePolicy.maxConflictFixTurns = 3;
    config.tracker.activeStates = ["Todo", "In Progress", "Approved with Conflicts"];
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const conflictIssue = issue({ state: "Approved with Conflicts" });
    await lifecycleStore.ensureIssue(conflictIssue, {
      phase: "merge_conflict_resolution",
      mergeConflict: mergeConflictRecord({
        fixTurnCount: input.fixTurnCount ?? 0,
        servicePreparation: input.servicePreparation ?? null,
      }),
    });
    const outbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    return {
      service: new MergeConflictResolutionService({
        config,
        lifecycleStore,
        writebackOutbox: outbox,
        ...(input.finalizer === undefined ? {} : { finalizer: input.finalizer }),
        gitAuthHeaderProvider: async () => "AUTHORIZATION: bearer test-token",
      }),
      lifecycleStore,
      outbox,
    };
  }
});

function context(overrides: Partial<Parameters<MergeConflictResolutionService["submit_merge_conflict_resolution"]>[1]> = {}) {
  return {
    issue: issue({ state: "Approved with Conflicts" }),
    activeRunId: "conflict-run-1",
    role: "worker" as const,
    workspacePath: "/tmp/workspace",
    phase: "merge_conflict_resolution" as const,
    ...overrides,
  };
}

function resolutionReport(input: {
  idempotencyKey?: string;
  resolutionStatus: "resolved" | "still_conflicted" | "blocked";
  headSha?: string;
  previousHeadSha?: string;
  baseBranch?: string;
  baseHeadSha?: string;
  blockedReason?: string;
  omitNewHeadSha?: boolean;
  changedFiles?: string[];
}) {
  const headSha = input.headSha ?? "head-sha-1";
  return {
    runId: "conflict-run-1",
    issueId: "issue-1",
    resolutionStatus: input.resolutionStatus,
    summary: "Resolved merge conflicts.",
    validationEvidence: ["npm test"],
    changedFiles: input.changedFiles ?? ["src/index.ts"],
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha,
      branch: "symphony/TEST-1",
    },
    previousHeadSha: input.previousHeadSha ?? "head-sha-1",
    ...(input.omitNewHeadSha === true ? {} : { newHeadSha: headSha }),
    baseBranch: input.baseBranch ?? "main",
    baseHeadSha: input.baseHeadSha ?? "base-sha-1",
    ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
    risks: [],
    idempotencyKey: input.idempotencyKey ?? "resolve-1",
  };
}

function mergeConflictRecord(input: {
  fixTurnCount: number;
  servicePreparation?:
    | ReturnType<typeof servicePreparationRecord>
    | ReturnType<typeof stashApplyServicePreparationRecord>
    | null;
}) {
  return {
    id: "merge-conflict:issue-1:head-sha-1",
    status: "open" as const,
    resolutionStatus: "pending" as const,
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    approvedHeadSha: "head-sha-1",
    currentHeadSha: "head-sha-1",
    resolvedHeadSha: null,
    baseBranch: "main",
    baseHeadSha: "base-sha-1",
    sourceState: "Ready to Merge",
    conflictsState: "Approved with Conflicts",
    reason: "Pull request has merge conflicts with the base branch",
    mergeableState: "dirty",
    servicePreparation: input.servicePreparation ?? null,
    detectedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fixTurnCount: input.fixTurnCount,
    maxFixTurns: 3,
    lastConflictFixRunId: null,
    lastConflictResolutionReportId: null,
    attemptRunIds: [],
    writebackOperationKeys: [],
    blockedAt: null,
    blockedReason: null,
  };
}

function servicePreparationRecord(input: { preservedStash?: ReturnType<typeof preservedStashRecord> | null } = {}) {
  return {
    strategy: "squash_rebase" as const,
    status: "conflicted" as const,
    originalHeadSha: "head-sha-1",
    observedPrBaseHeadSha: "base-sha-0",
    liveBaseHeadSha: "base-sha-1",
    preparedBaseHeadSha: "base-sha-1",
    mergeBaseSha: "base-sha-0",
    squashCommitSha: "squash-sha-1",
    conflictedFiles: ["src/index.ts"],
    preparedAt: "2026-01-01T00:00:01.000Z",
    finalizedAt: null,
    finalizedHeadSha: null,
    preservedStash: input.preservedStash ?? null,
  };
}

function stashApplyServicePreparationRecord() {
  return {
    strategy: "stash_apply" as const,
    status: "conflicted" as const,
    originalHeadSha: "head-sha-1",
    currentHeadSha: "head-sha-1",
    conflictedFiles: ["src/local.ts"],
    allowedFiles: ["src/local.ts"],
    preservedStash: {
      ...preservedStashRecord(),
      status: "apply_conflicted" as const,
      conflictedFiles: ["src/local.ts"],
      appliedAt: "2026-01-01T00:00:02.000Z",
    },
    preparedAt: "2026-01-01T00:00:02.000Z",
    finalizedAt: null,
    finalizedHeadSha: null,
  };
}

function preservedStashRecord() {
  return {
    version: 1 as const,
    id: "preserved-stash:issue-1:stash-1",
    operationId: "base-ref:issue-1:head-sha-1:base-sha-1",
    source: "base_ref_repair" as const,
    stashRef: "refs/symphony/preserved-stashes/test/stash-1",
    stashSha: "stash-sha-1",
    message: "Symphony preserved local changes",
    workspacePath: "/tmp/workspace",
    branchName: "symphony/TEST-1",
    baseBranch: "main",
    originalHeadSha: "head-sha-1",
    dirtyFiles: ["src/local.ts"],
    status: "created" as const,
    conflictedFiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    appliedAt: null,
    droppedAt: null,
    dropError: null,
  };
}
