import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      context({ projectContext: docsProjectContext }),
    );

    expect(result.replayed).toBe(false);
    expect(result.report).toMatchObject({
      resolutionStatus: "resolved",
      projectContext: docsProjectContext,
      previousHeadSha: "head-sha-1",
      newHeadSha: "head-sha-2",
      baseBranch: "main",
      baseHeadSha: "base-sha-1",
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      blockedReason: null,
      projectContext: docsProjectContext,
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
          projectContext: docsProjectContext,
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

  async function fixture(input: { fixTurnCount?: number } = {}) {
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
      mergeConflict: mergeConflictRecord({ fixTurnCount: input.fixTurnCount ?? 0 }),
    });
    const outbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    return {
      service: new MergeConflictResolutionService({ config, lifecycleStore, writebackOutbox: outbox }),
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
}) {
  const headSha = input.headSha ?? "head-sha-1";
  return {
    runId: "conflict-run-1",
    issueId: "issue-1",
    resolutionStatus: input.resolutionStatus,
    summary: "Resolved merge conflicts.",
    validationEvidence: ["npm test"],
    changedFiles: ["src/index.ts"],
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha,
      branch: "symphony/TEST-1",
    },
    previousHeadSha: input.previousHeadSha ?? "head-sha-1",
    newHeadSha: headSha,
    baseBranch: input.baseBranch ?? "main",
    baseHeadSha: input.baseHeadSha ?? "base-sha-1",
    ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
    risks: [],
    idempotencyKey: input.idempotencyKey ?? "resolve-1",
  };
}

function mergeConflictRecord(input: { fixTurnCount: number }) {
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

const docsProjectContext = {
  projectContextId: "docs-site",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;
