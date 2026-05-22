import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompletionReportService, type CompletionReportActiveContext, type CompletionReportInput } from "../src/core/CompletionReportService.js";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore, type NewWritebackOperation, type WritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";
import type {
  CompletionReportPullRequestPublication,
  CompletionReportPullRequestPublicationInput,
  CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";

describe("CompletionReportService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-completion-report-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a worker completion report, records it, and enqueues review writebacks", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const result = await service.submit_completion_report(report(), context());

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(2);
    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      incompleteTurnCount: 0,
      completionReports: [
        {
          id: "completion-report:issue-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Implemented the service contract.",
          changedFiles: ["src/core/CompletionReportService.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: null,
          risks: ["Reviewer handler remains out of scope."],
        },
      ],
    });
    const operations = await outbox.list();
    const commentOperation = operations.find((operation) => operation.kind === "comment");
    const transitionOperation = operations.find((operation) => operation.kind === "transition");
    expect(operations).toHaveLength(2);
    expect(commentOperation).toMatchObject({
      kind: "comment",
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1",
      payload: {
        dedupeKey: "run-1:completion-report:idem-1",
      },
    });
    expect(commentOperation?.kind === "comment" ? commentOperation.payload.body : "").toContain("Completion report:");
    expect(transitionOperation).toMatchObject({
      kind: "transition",
      idempotencyKey: "transition:issue-1:run-1:completion-report:idem-1:In Review",
      payload: {
        fromStates: ["In Progress"],
        toState: "In Review",
      },
    });
  });

  it("replays duplicate reports without new lifecycle or writeback side effects", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const first = await service.submitCompletionReport(report(), context());
    const second = await service.submitCompletionReport(report({ summary: "Changed summary on replay." }), context());

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.report.summary).toBe("Implemented the service contract.");
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
  });

  it("publishes a new service-owned PR before accepting a completion report", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, lifecycleStore, outbox, runStore } = fixture({ publisher });
    await startRun(runStore);

    const result = await service.submitCompletionReport(report(), contextWithWorkspace());

    expect(result.report.pullRequest).toEqual({
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: "symphony/TEST-1",
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      workspacePath: "/tmp/workspace",
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    const comment = (await outbox.list()).find((operation) => operation.kind === "comment");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("https://github.com/acme/symphony/pull/42");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("PR head SHA: abc123");
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
  });

  it("reuses a service-discovered PR and prevents duplicate publication on replay", async () => {
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, runStore, outbox } = fixture({ publisher });
    await startRun(runStore);

    const first = await service.submitCompletionReport(report(), contextWithWorkspace());
    const second = await service.submitCompletionReport(report({ summary: "Changed on replay." }), contextWithWorkspace());
    const transcript = await runStore.readTranscript("run-1");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(publisher.inputs).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
    expect(transcript.events.filter((event) => event.eventType === "pr_opened")).toHaveLength(1);
  });

  it("rejects completion handoff when service-owned PR publication fails", async () => {
    const publisher = new FakePublisher(null, new SymphonyError("tracker_error", "GitHub branch push failed"));
    const { service, lifecycleStore, outbox } = fixture({ publisher });

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "tracker_error",
    });

    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("does not durably accept a report when enqueueing writebacks fails", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const failingOutbox = new FailingOutbox();
    const failingService = new CompletionReportService({ config, lifecycleStore, writebackOutbox: failingOutbox });

    await expect(failingService.submitCompletionReport(report(), context())).rejects.toThrow("enqueue failed");

    const afterFailure = await lifecycleStore.get("issue-1");
    expect(afterFailure?.phase).toBe("implementation");
    expect(afterFailure?.lastCompletionReportId).toBeNull();
    expect(afterFailure?.completionReports).toHaveLength(0);
    expect(failingOutbox.attempted).toBeGreaterThan(0);

    const outbox = new FileWritebackOutboxStore(root);
    const retryService = new CompletionReportService({ config, lifecycleStore, writebackOutbox: outbox });
    const retry = await retryService.submitCompletionReport(report(), context());

    expect(retry.replayed).toBe(false);
    expect(retry.writebackOperations).toHaveLength(2);
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
  });

  it("rejects reports for a different active run", async () => {
    const { service } = fixture();

    await expect(service.submitCompletionReport(report({ runId: "run-2" }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects reports outside the implementation state and phase", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), { phase: "review" });

    await expect(
      service.submitCompletionReport(report(), context({ issue: issue({ state: "In Review" }), phase: "review" })),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects invalid role and token context", async () => {
    const { service } = fixture();

    await expect(service.submitCompletionReport(report(), context({ role: "reviewer" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.submitCompletionReport(report(), context({ token: "wrong-token" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects missing required report fields", async () => {
    const { service } = fixture();
    const { summary: _summary, ...missingSummary } = report();

    await expect(service.submitCompletionReport(missingSummary, context())).rejects.toBeInstanceOf(SymphonyError);
    await expect(service.submitCompletionReport(missingSummary, context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  function fixture(options: { publisher?: CompletionReportPullRequestPublisher } = {}) {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    if (options.publisher) {
      config.github.publishPullRequests = true;
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
    }
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      runStore,
      ...(options.publisher === undefined ? {} : { pullRequestPublisher: options.publisher }),
    });
    return { service, lifecycleStore, outbox, runStore };
  }
});

function report(overrides: Partial<CompletionReportInput> = {}): CompletionReportInput {
  return {
    runId: "run-1",
    issueId: "issue-1",
    summary: "Implemented the service contract.",
    validationEvidence: ["npm run typecheck", "npm test"],
    acceptanceChecklist: [
      {
        text: "Completion reports are persisted.",
        satisfied: true,
        evidence: "Lifecycle store records completionReports.",
      },
    ],
    changedFiles: ["src/core/CompletionReportService.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: null,
    risks: ["Reviewer handler remains out of scope."],
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function context(overrides: Partial<CompletionReportActiveContext> = {}): CompletionReportActiveContext {
  return {
    issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
    activeRunId: "run-1",
    role: "worker",
    token: "worker-token",
    expectedToken: "worker-token",
    sessionId: "session-1",
    workspacePath: "/tmp/workspace",
    phase: "implementation",
    ...overrides,
  };
}

function contextWithWorkspace(overrides: Partial<CompletionReportActiveContext> = {}): CompletionReportActiveContext {
  return context({
    workspace: {
      path: "/tmp/workspace",
      workspaceKey: "TEST-1",
      createdNow: false,
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    ...overrides,
  });
}

async function startRun(runStore: FileRunTranscriptStore): Promise<void> {
  await runStore.startRun({
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "work",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspace",
    gitBranchName: "symphony/TEST-1",
    repoPath: "/repo",
    baseRef: "main",
  });
}

class FailingOutbox {
  attempted = 0;

  async enqueueOnce(_operation: NewWritebackOperation): Promise<WritebackOperation> {
    this.attempted += 1;
    throw new Error("enqueue failed");
  }
}

class FakePublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(
    private readonly publication: CompletionReportPullRequestPublication | null,
    private readonly failure: Error | null = null,
  ) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    if (this.failure) throw this.failure;
    if (!this.publication) throw new Error("missing fake publication");
    return this.publication;
  }
}
