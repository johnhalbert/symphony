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
});

function mergeConfig(input: { requiredChecks?: string[]; noCiEvidence?: string }) {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: { root },
      writeback: { enabled: true, mode: "live" },
      review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge" },
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
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "github-secret" },
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

  constructor(private readonly input: { headSha?: string } = {}) {}

  async getPullRequest() {
    return {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: this.input.headSha ?? "head-sha-1",
      lastPushedAt: "2026-01-01T00:00:00Z",
      state: "open",
    };
  }

  async getRequiredCheckResults() {
    return [{ name: "test", status: "success" as const, conclusion: "success", url: "https://ci.test/test" }];
  }

  async mergePullRequest(input: Parameters<MergePolicyGitHubClient["mergePullRequest"]>[0]) {
    this.mergeInput = input;
    return {
      merged: true,
      mergeCommitSha: "merge-sha-1",
      mergedAt: "2026-01-01T00:00:02.000Z",
      mergedBy: "symphony-bot",
    };
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
