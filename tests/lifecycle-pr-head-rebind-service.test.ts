import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecyclePrHeadRebindService } from "../src/core/LifecyclePrHeadRebindService.js";
import { FileIssueStateStore } from "../src/core/orchestration/FileIssueStateStore.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue } from "../src/core/types.js";
import { issue, testConfig } from "./helpers.js";

describe("LifecyclePrHeadRebindService", () => {
  let root: string;
  let candidate: Issue;
  let lifecycleStore: FileIssueLifecycleStore;
  let issueStateStore: FileIssueStateStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-head-rebind-"));
    candidate = issue({
      id: "issue-1",
      identifier: "TEST-1",
      branchName: "symphony/test-1",
    });
    lifecycleStore = new FileIssueLifecycleStore(root);
    issueStateStore = new FileIssueStateStore(root);
    await seedLifecycle("1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("previews a PR head rebind without mutating lifecycle or writing audit history", async () => {
    const service = serviceWithGitHubHead("2222222222222222222222222222222222222222");

    const result = await service.rebind({ issueIdOrIdentifier: "TEST-1" });

    expect(result).toMatchObject({
      status: "preview",
      applied: false,
      changed: true,
      targetHeadSha: "2222222222222222222222222222222222222222",
      targetHeadSource: "github_pull_request",
      oldSummaryPrHeadSha: "1111111111111111111111111111111111111111",
      oldLatestCompletionReportPrHeadSha: "1111111111111111111111111111111111111111",
      clearedBaseRefObservation: true,
      auditHistorySnapshotId: null,
    });
    expect(result.patch).toMatchObject({
      summaryPointers: { prHeadSha: "2222222222222222222222222222222222222222" },
      baseRefObservation: null,
    });
    const lifecycle = await lifecycleStore.get("TEST-1");
    expect(lifecycle?.summaryPointers.prHeadSha).toBe("1111111111111111111111111111111111111111");
    expect(lifecycle?.handoff.memo.pointers.prHeadSha).toBe("1111111111111111111111111111111111111111");
    await expect(issueStateStore.get("TEST-1")).resolves.toBeNull();
  });

  it("applies the rebind through lifecycle persistence and records a manual admin lifecycle audit snapshot", async () => {
    const service = serviceWithGitHubHead("2222222222222222222222222222222222222222");

    const result = await service.rebind({ issueIdOrIdentifier: "TEST-1", apply: true });

    expect(result.status).toBe("applied");
    expect(result.applied).toBe(true);
    expect(result.auditHistorySnapshotId).toMatch(/^issue-history:/);
    const lifecycle = await lifecycleStore.get("TEST-1");
    const latestReport = lifecycle?.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    expect(lifecycle?.summaryPointers.prHeadSha).toBe("2222222222222222222222222222222222222222");
    expect(latestReport?.pullRequest?.headSha).toBe("2222222222222222222222222222222222222222");
    expect(lifecycle?.handoff.memo.pointers.prHeadSha).toBe("2222222222222222222222222222222222222222");
    expect(lifecycle?.baseRefObservation).toBeNull();

    const history = (await issueStateStore.get("TEST-1"))?.history ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      historySnapshotId: result.auditHistorySnapshotId,
      snapshotKind: "evidence",
      transitionKind: "record_evidence",
      triggerType: "manual.cli_admin_action",
      triggerSource: "manual_cli",
      candidateSource: "evidence.lifecycle.manual_pr_head_rebind",
      evidenceKind: "lifecycle",
      evidenceEventType: "manual_pr_head_rebind",
      evidenceSourceId: "TEST-1",
      lifecyclePatch: {
        summaryPointers: { prHeadSha: "2222222222222222222222222222222222222222" },
        baseRefObservation: null,
      },
    });
    expect(history[0]?.evidencePayload).toMatchObject({
      audit: {
        action: "manual_pr_head_rebind",
        targetHeadSha: "2222222222222222222222222222222222222222",
        targetHeadSource: "github_pull_request",
        oldSummaryPrHeadSha: "1111111111111111111111111111111111111111",
        oldLatestCompletionReportPrHeadSha: "1111111111111111111111111111111111111111",
        clearedBaseRefObservation: {
          inputFingerprint: "base-ref-fingerprint",
          classification: "branch_not_based_on_live_base",
          worktreeHeadSha: "2222222222222222222222222222222222222222",
        },
      },
    });
  });

  it("blocks when the observed worktree head does not match the target unless forced", async () => {
    await seedLifecycle("1111111111111111111111111111111111111111", "3333333333333333333333333333333333333333");
    const service = serviceWithGitHubHead("2222222222222222222222222222222222222222");

    const result = await service.rebind({ issueIdOrIdentifier: "TEST-1" });

    expect(result).toMatchObject({
      status: "blocked",
      blockingReason: "worktree_head_does_not_match_target_head",
      targetHeadSha: "2222222222222222222222222222222222222222",
      observedWorktreeHeadSha: "3333333333333333333333333333333333333333",
    });
    const lifecycle = await lifecycleStore.get("TEST-1");
    expect(lifecycle?.summaryPointers.prHeadSha).toBe("1111111111111111111111111111111111111111");
  });

  it("does not use a local worktree head as a blocker when the workspace is on a different branch", async () => {
    await seedLifecycle("2222222222222222222222222222222222222222", null, {
      reportHeadSha: "1111111111111111111111111111111111111111",
      workspacePath: path.join(root, "wrong-branch-worktree"),
      baseRefClassification: "base_ref_unavailable",
    });
    const service = serviceWithGitHubHead("2222222222222222222222222222222222222222", {
      localGit: {
        async inspect() {
          return {
            headSha: "3333333333333333333333333333333333333333",
            branchName: "symphony/other-branch",
            warnings: [],
          };
        },
      },
    });

    const result = await service.rebind({ issueIdOrIdentifier: "TEST-1" });

    expect(result).toMatchObject({
      status: "preview",
      blockingReason: null,
      localWorktreeHeadSha: "3333333333333333333333333333333333333333",
      localWorktreeBranch: "symphony/other-branch",
      observedWorktreeHeadSha: null,
      clearedBaseRefObservation: true,
    });
    expect(result.warnings).toContain("workspace_branch_mismatch:symphony/other-branch->symphony/test-1");
    expect(result.patch).toMatchObject({
      completionReports: [
        {
          id: "report-1",
          pullRequest: { headSha: "2222222222222222222222222222222222222222" },
        },
      ],
      baseRefObservation: null,
    });
  });

  it("accepts an explicit target head without a GitHub client", async () => {
    const service = new LifecyclePrHeadRebindService({
      config: testConfig(root),
      tracker: trackerForIssue(candidate),
      lifecycleStore,
      issueStateStore,
      logger: testLogger(),
    });

    const result = await service.rebind({
      issueIdOrIdentifier: "TEST-1",
      headSha: "2222222222222222222222222222222222222222",
    });

    expect(result).toMatchObject({
      status: "preview",
      targetHeadSource: "explicit",
      targetHeadSha: "2222222222222222222222222222222222222222",
    });
  });

  async function seedLifecycle(
    summaryHeadSha: string,
    observedWorktreeHeadSha: string | null,
    options: {
      reportHeadSha?: string;
      workspacePath?: string | null;
      baseRefClassification?: "branch_not_based_on_live_base" | "base_ref_unavailable";
    } = {},
  ): Promise<void> {
    const reportHeadSha = options.reportHeadSha ?? summaryHeadSha;
    await lifecycleStore.updateIssue(candidate, {
      phase: "review",
      lastCompletionReportId: "report-1",
      summaryPointers: {
        workspacePath: options.workspacePath ?? null,
        gitBranchName: "symphony/test-1",
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        prHeadSha: summaryHeadSha,
        prBranch: "symphony/test-1",
        baseRef: "origin/main",
      },
      completionReports: [
        {
          id: "report-1",
          idempotencyKey: "report-key",
          runId: "worker-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          summary: "Implemented the issue.",
          validationEvidence: ["npm test"],
          acceptanceChecklist: [{ text: "Done", satisfied: true, evidence: "test" }],
          changedFiles: ["src/example.ts"],
          branchName: "symphony/test-1",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/7",
            number: 7,
            headSha: reportHeadSha,
            branch: "symphony/test-1",
          },
          risks: [],
          acceptedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      baseRefObservation: {
        version: 1,
        classification: options.baseRefClassification ?? "branch_not_based_on_live_base",
        inputFingerprint: "base-ref-fingerprint",
        operation: "dispatch_worker",
        checkedAt: "2026-01-01T00:00:00.000Z",
        workspacePath: null,
        branchName: "symphony/test-1",
        baseRef: "origin/main",
        normalizedBaseBranch: "main",
        localBaseRef: "origin/main",
        githubBaseHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        localBaseHeadShaBeforeFetch: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        localBaseHeadShaAfterFetch: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        worktreeHeadSha: observedWorktreeHeadSha,
        localBaseIsAncestorOfHead: observedWorktreeHeadSha === null ? null : false,
        reason: "branch is behind live base",
        error: null,
      },
    });
  }

  function serviceWithGitHubHead(
    headSha: string,
    options: Pick<ConstructorParameters<typeof LifecyclePrHeadRebindService>[0], "localGit"> = {},
  ): LifecyclePrHeadRebindService {
    return new LifecyclePrHeadRebindService({
      config: testConfig(root),
      tracker: trackerForIssue(candidate),
      lifecycleStore,
      issueStateStore,
      logger: testLogger(),
      ...options,
      pullRequestClient: {
        async getPullRequest() {
          return {
            number: 7,
            url: "https://github.com/acme/repo/pull/7",
            headBranch: "symphony/test-1",
            headSha,
          };
        },
      },
    });
  }
});

function trackerForIssue(candidate: Issue): Pick<TrackerClient, "fetchIssueStatesByIds"> {
  return {
    async fetchIssueStatesByIds(issueIds: string[]) {
      return issueIds.some((id) => id === candidate.id || id === candidate.identifier) ? [candidate] : [];
    },
  };
}

function testLogger() {
  return {
    warn() {
      // Tests assert return values; warnings are only diagnostic context here.
    },
  };
}
