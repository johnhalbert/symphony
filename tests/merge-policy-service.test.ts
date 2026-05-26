import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { MergePolicyService, type MergePolicyGitHubClient } from "../src/core/merge/MergePolicyService.js";
import { FileIssueLifecycleStore, type IssueMergeGateState, type IssueReviewVerdictRecord } from "../src/core/persistence/IssueLifecycleStore.js";
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
    expect(lifecycle?.lastReviewVerdictId).toBe("merge-gate:issue-1:pr-42:head-sha-2");
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
    expect(lifecycle?.lastReviewVerdictId).toBe(activeGate.id);
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
    expect(lifecycle?.reviewVerdicts.at(-1)?.findings).toEqual(["Required check missing (actionable): typecheck: missing"]);
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
      reviewRound: 1,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastReviewVerdictId: "merge-gate:issue-1:pr-42:head-sha-1",
    });
    expect(lifecycle?.reviewVerdicts.at(-1)).toMatchObject({
      id: "merge-gate:issue-1:pr-42:head-sha-1",
      verdict: "fail",
      reviewer: "symphony-merge-gate",
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
    const gateVerdicts = lifecycle?.reviewVerdicts.filter((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1") ?? [];

    expect(result.status).toBe("repair_dispatched");
    expect(secondWriter.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(lifecycle?.reviewRound).toBe(2);
    expect(lifecycle?.phase).toBe("implementation");
    expect(lifecycle?.lastReviewVerdictId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.mergeGate?.repairRunId).toBeNull();
    expect(lifecycle?.mergeGate?.repairReportId).toBeNull();
    expect(gateVerdicts).toHaveLength(1);
    expect(gateVerdicts[0]?.writebackOperationKeys).toEqual([
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
    expect(lifecycle?.reviewRound).toBe(3);
    expect(lifecycle?.lastReviewVerdictId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.blockedReason).toContain("3/3");
    expect(lifecycle?.reviewVerdicts.find((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")?.writebackOperationKeys).toEqual([
      "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:blocked:head-sha-1_test_failure:r3",
      "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_head-sha-1:blocked:head-sha-1_test_failure:r3:Blocked",
    ]);
  });

  it("restores approval context and merges when same-head checks recover", async () => {
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

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({ expectedHeadSha: "head-sha-1" });
    expect(currentIssue.state).toBe("Done");
    expect(lifecycle?.lastReviewVerdictId).toBe("review-verdict:issue-1:verdict-pass-1");
    expect(lifecycle?.summaryPointers.ciStatus).toBe("success");
    expect(lifecycle?.reviewVerdicts.filter((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "resolved",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
      writebackOperationKeys: [],
    });
    expect(lifecycle?.reviewVerdicts.find((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toMatchObject({
      findings: [],
      evidence: [],
      acceptanceResults: [],
    });
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
      acceptedAt: "2026-01-01T00:10:00.000Z",
    };
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
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
    });
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
    expect(lifecycle?.reviewVerdicts.find((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toMatchObject({
      findings: [],
      evidence: [],
      acceptanceResults: [],
    });
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
    expect(accepted?.reviewVerdicts.filter((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
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
    expect(lifecycle?.lastReviewVerdictId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
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
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.reviewVerdicts.filter((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
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
    expect(lifecycle?.reviewRound).toBe(1);
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
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.reviewVerdicts.filter((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
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
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      blockerFingerprint: "head-sha-1:typecheck:missing",
      checks: [{ name: "test", outcome: "passing" }, { name: "typecheck", outcome: "missing_actionable" }],
    });
    expect(lifecycle?.reviewVerdicts.filter((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1")).toHaveLength(1);
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
    const gateVerdict = lifecycle?.reviewVerdicts.find((verdict) => verdict.id === "merge-gate:issue-1:pr-42:head-sha-1");

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
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.mergeGate?.blockerFingerprint).toBe("head-sha-1:typecheck:missing");
    expect(gateVerdict).toMatchObject({
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
    expect(lifecycle?.reviewRound).toBe(3);
    expect(lifecycle?.blockedReason).toContain("merge gate required checks failed");
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
    expect(lifecycle?.reviewRound).toBe(3);
    expect(lifecycle?.blockedReason).toBe(blockedReason);
    expect(lifecycle?.lastReviewVerdictId).toBe("merge-gate:issue-1:pr-42:head-sha-1");
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
    expect(lifecycle?.reviewRound).toBe(1);
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
});

function mergeConfig(input: {
  requiredChecks?: string[];
  noCiEvidence?: string;
  writebackMode?: "live" | "dry_run";
  credentialProfiles?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}) {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: { root },
      writeback: { enabled: true, mode: input.writebackMode ?? "live" },
      review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge", blocked_states: ["Blocked"] },
      merge_policy: {
        mode: "gated",
        source_states: ["Ready to Merge"],
        done_state: "Done",
        merge_method: "squash",
        required_checks: input.requiredChecks ?? [],
        no_ci:
          input.noCiEvidence === undefined
            ? { allowed: false }
            : { allowed: true, evidence: input.noCiEvidence },
      },
      github: { owner: "acme", repo: "symphony" },
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
  });
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
      mergeCommitSha?: string | null;
      mergedAt?: string | null;
      mergedBy?: string | null;
      serviceLogin?: string | null;
      checkResults?: PullRequestCheckResult[];
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
      mergeCommitSha: this.input.mergeCommitSha ?? "merge-sha-1",
      mergedAt: this.input.mergedAt ?? "2026-01-01T00:00:02.000Z",
      mergedBy: this.input.mergedBy ?? "symphony-bot",
    };
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
    evidence: ["Required checks: test", "Failing checks: test: failure"],
    reviewer: "symphony-merge-gate",
    submittedAt: "2026-01-01T00:00:01.000Z",
    writebackOperationKeys: gate.writebackOperationKeys,
  };
}
