import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { MergePolicyService, type MergePolicyGitHubClient } from "../src/core/merge/MergePolicyService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
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

  it("fails closed when the live PR head SHA has changed", async () => {
    const config = mergeConfig({ noCiEvidence: "Repository intentionally has no CI for this test." });
    const currentIssue = issue({ state: "Ready to Merge", labels: ["dogfood-ready"] });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await seedLifecycle(lifecycleStore, runStore, currentIssue);
    const client = new FakeMergeClient({ headSha: "new-head-sha" });
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
      client,
    });

    await expect(service.reconcileIssue(currentIssue)).rejects.toMatchObject({ code: "invalid_request" });
    expect(client.mergeInput).toBeNull();
  });

  it("transitions approved PRs with merge conflicts to the conflict-fix state without merging", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
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

    expect(result.status).toBe("blocked_conflicts");
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Approved with Conflicts");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["Ready to Merge"],
        toState: "Approved with Conflicts",
        reason: "Symphony gated merge blocked: Pull request has merge conflicts with the base branch",
      },
    ]);
    await expect(lifecycleStore.get(currentIssue.id)).resolves.toMatchObject({
      phase: "merge_conflict_resolution",
      blockedReason: null,
      merge: null,
      mergeConflict: {
        status: "open",
        resolutionStatus: "pending",
        approvedHeadSha: "head-sha-1",
        currentHeadSha: "head-sha-1",
        fixTurnCount: 0,
        maxFixTurns: 3,
        conflictsState: "Approved with Conflicts",
      },
    });
  });

  it("defers merge while GitHub mergeability is unknown", async () => {
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

    expect(result).toMatchObject({ status: "skipped" });
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
  });

  it("carries approval forward from the approved head to a resolved conflict head", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Approved with Conflicts", labels: ["dogfood-ready"] });
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

    expect(result.status).toBe("merged");
    expect(client.mergeInput).toMatchObject({
      pullRequestNumber: 42,
      expectedHeadSha: "head-sha-2",
    });
    expect(currentIssue.state).toBe("Done");
    expect((await lifecycleStore.get(currentIssue.id))?.merge).toMatchObject({
      headSha: "head-sha-2",
      pullRequest: { headSha: "head-sha-2" },
    });
  });

  it("rejects conflict approval carry-forward when the resolved head is not a descendant", async () => {
    const config = mergeConfig({
      noCiEvidence: "Repository intentionally has no CI for this test.",
      conflictsState: "Approved with Conflicts",
    });
    const currentIssue = issue({ state: "Approved with Conflicts", labels: ["dogfood-ready"] });
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

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/approval cannot be carried forward/);
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Approved with Conflicts");
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

  it("requires every configured required check to be returned successful by the merge client", async () => {
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

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/typecheck/);
    expect(client.mergeInput).toBeNull();
    expect(currentIssue.state).toBe("Ready to Merge");
  });

  it("rejects a returned required check with a non-success status", async () => {
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

    await expect(service.reconcileIssue(currentIssue)).rejects.toThrow(/Required checks are not passing: test/);
    expect(client.mergeInput).toBeNull();
    expect(writer.transitions).toEqual([]);
    expect(currentIssue.state).toBe("Ready to Merge");
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
  conflictsState?: string;
  credentialProfiles?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}) {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
        ...(input.conflictsState === undefined ? {} : { active_states: ["Todo", "In Progress", input.conflictsState] }),
      },
      workspace: { root },
      writeback: { enabled: true, mode: input.writebackMode ?? "live" },
      review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge" },
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
  options: { includeApproval?: boolean } = {},
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
    sourceState: "Ready to Merge",
    conflictsState: "Approved with Conflicts",
    reason: "Pull request has merge conflicts with the base branch",
    mergeableState: "dirty",
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

  async isAncestor() {
    return this.input.ancestor ?? true;
  }
}

class MemoryWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];

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

  async createIssueComment() {
    return { status: "applied" as const };
  }
}
