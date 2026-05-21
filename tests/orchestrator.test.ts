import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator, sortIssuesForDispatch, type PullRequestDiscoveryClient } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { issue, testConfig } from "./helpers.js";

describe("Orchestrator", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sorts issues by priority, creation date, then identifier", () => {
    const sorted = sortIssuesForDispatch([
      issue({ identifier: "B", priority: null }),
      issue({ identifier: "A", priority: 2 }),
      issue({ identifier: "C", priority: 1 }),
    ]);
    expect(sorted.map((item) => item.identifier)).toEqual(["C", "A", "B"]);
  });

  it("dispatches eligible work through the harness", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    let active = true;
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return active ? [candidate] : [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        if (refreshes === 1) return [candidate];
        active = false;
        return [{ ...candidate, state: "Done" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs[0]?.prompt).toBe("Work on TEST-1");
    expect(orchestrator.snapshot().counts.running).toBe(0);
  });

  it("revalidates issue state before dispatch", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: "Done" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips issues no longer routed to this worker", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, assignedToWorker: false }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips issues with refreshed open blockers", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, blockedBy: [{ id: "blocker", identifier: "TEST-0", state: null }] }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips issues without required dispatch labels", async () => {
    const config = testConfig(root);
    config.agent.requireLabels = ["dogfood-ready"];
    const candidate = issue({ state: "Todo", labels: ["dogfood"] });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("does not retry after a handoff state", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        return [refreshes === 1 ? candidate : { ...candidate, state: "In Review" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("uses service-owned writeback for dispatch and turn-completed comments without handoff", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(
      new FileWritebackOutboxStore(path.join(root, "state")),
      writer,
      logger,
      300_000,
    );
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "fake-issue-1-1:run-started",
      "fake-issue-1-1:run-succeeded",
    ]);
    expect(writer.comments[1]?.body).toContain("worker turn completed");
    expect(writer.comments[1]?.body).toContain("not been marked ready for review");
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 1,
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("records max-turn exhaustion as incomplete turns instead of handoff", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(
      new FileWritebackOutboxStore(path.join(root, "state")),
      writer,
      logger,
      300_000,
    );
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(2);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 2,
    });
  });

  it("pauses and resumes issue dispatch", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    orchestrator.pauseIssue(candidate.id);
    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.runs).toHaveLength(0);

    orchestrator.resumeIssue(candidate.id);
    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
  });

  it("passes emitted run ids to harness stop", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.stoppedRunIds).toEqual(["run-123"]);
  });

  it("loads and exposes issue lifecycle records during dispatch", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, { reviewRound: 1, incompleteTurnCount: 2 });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const lifecycle = orchestrator.snapshot().running[0]?.lifecycle;
    await orchestrator.stop();

    expect(lifecycle).toMatchObject({
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      phase: "implementation",
      reviewRound: 1,
      incompleteTurnCount: 2,
      summaryPointers: {
        workspaceKey: "TEST-1",
        lastRunId: "run-123",
      },
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      reviewRound: 1,
      incompleteTurnCount: 2,
    });
  });

  it("discovers and links open pull requests by worktree branch idempotently", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const pullRequestClient = new FakePullRequestDiscoveryClient({
      url: "https://github.com/octo-org/symphony/pull/12",
      number: 12,
      headBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:01:00Z",
    });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
      pullRequestClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await orchestrator.stop();

    const run = await runStore.latestRunForIssue(candidate.identifier);
    const transcript = await runStore.readTranscript(run?.runId ?? "");
    const lifecycle = await lifecycleStore.get(candidate.identifier);

    expect(pullRequestClient.branches).toEqual(["symphony/TEST-1", "symphony/TEST-1"]);
    expect(run).toMatchObject({
      prUrl: "https://github.com/octo-org/symphony/pull/12",
      prNumber: 12,
      lastPushedAt: "2026-01-01T00:01:00Z",
      gitBranchName: "symphony/TEST-1",
    });
    expect(transcript.events.filter((event) => event.eventType === "pr_opened")).toHaveLength(1);
    expect(lifecycle?.summaryPointers).toMatchObject({
      prUrl: "https://github.com/octo-org/symphony/pull/12",
      prNumber: 12,
      lastPushedAt: "2026-01-01T00:01:00Z",
      branchName: "symphony/TEST-1",
      gitBranchName: "symphony/TEST-1",
    });
  });

  it("cancels an active issue without retrying it", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.cancelIssue(candidate.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.stoppedRunIds).toEqual(["run-123"]);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("blocks continuation turns for non-resumable harnesses", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new NonResumableHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await orchestrator.stop();

    expect(harness.prompts).toEqual(["Work on TEST-1"]);
  });
});

class BlockingHarness implements AgentHarness {
  readonly id = "blocking";
  readonly stoppedRunIds: string[] = [];

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-123", runId: "run-123" };
    await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }
}

class NonResumableHarness implements AgentHarness {
  readonly id = "non-resumable";
  readonly supportsContinuation = false;
  readonly prompts: string[] = [];

  async *run(_ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "session-1", runId: "run-1" };
    yield { type: "completed" };
  }
}

class FakePullRequestDiscoveryClient implements PullRequestDiscoveryClient {
  readonly branches: string[] = [];

  constructor(
    private readonly pullRequest: {
      url: string;
      number: number;
      headBranch: string;
      lastPushedAt: string | null;
    } | null,
  ) {}

  async findOpenPullRequestByBranch(input: { branchName: string }) {
    this.branches.push(input.branchName);
    return this.pullRequest;
  }
}

class StateChangingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  constructor(private readonly setState: (state: string) => void) {}

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    this.setState(input.toState);
    return { status: "applied" };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
    return { status: "applied" };
  }
}
