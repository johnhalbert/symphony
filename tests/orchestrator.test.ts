import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompletionReportService,
  type CompletionReportPullRequestPublication,
  type CompletionReportPullRequestPublicationInput,
  type CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";
import { ReviewVerdictService } from "../src/core/ReviewVerdictService.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator, sortIssuesForDispatch, type PullRequestDiscoveryClient } from "../src/core/orchestrator/Orchestrator.js";
import {
  FileIssueLifecycleStore,
  type IssueCompletionReportRecord,
  type IssueReviewVerdictRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  PullRequestReviewEvidenceClient,
  RemotePullRequestReviewEvidence,
} from "../src/core/review/PullRequestReviewEvidenceService.js";
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs[0]?.prompt).toBe("Work on TEST-1");
    expect(harness.runs[0]?.ctx.role).toBe("worker");
    expect(orchestrator.snapshot().counts.running).toBe(0);
  });

  it("adds scoped Symphony MCP completion instructions to Cursor worker prompts", async () => {
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
    const harness = new CursorPromptHarness();
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

    expect(harness.prompts[0]).toContain("Work on TEST-1");
    expect(harness.prompts[0]).toContain("Symphony MCP completion handoff");
    expect(harness.prompts[0]).toContain("Active issue: TEST-1 (issue-1)");
    expect(harness.prompts[0]).toContain("call the submit_completion_report MCP tool");
    expect(harness.prompts[0]).toContain("Symphony injects runId and issueId");
    expect(harness.prompts[0]).toContain("Do not comment on Linear");
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

  it("blocks a worker after the max incomplete turn ceiling", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 5;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.maxIncompleteTurns = 2;
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
    const stateDir = config.workspace.stateDir;
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
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
    expect(currentState).toBe("Blocked");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Blocked"]);
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "fake-issue-1-1:run-started",
      "fake-issue-1-2:run-started",
      "fake-issue-1-2:blocked-escalation",
    ]);
    expect(writer.comments[2]?.body).toContain("max incomplete turns reached (2/2)");
    expect(writer.comments[2]?.body).toContain("Incomplete turns: 2 / 2");
    expect(writer.comments[2]?.body).toContain("Last completion report:");
    expect(writer.comments[2]?.body).toContain("Required human action:");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      incompleteTurnCount: 2,
      blockedReason: "max incomplete turns reached (2/2)",
    });
  });

  it("blocks a reviewer fail verdict at the max review round ceiling", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.maxReviewRounds = 1;
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    let currentState = "In Review";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new ReviewVerdictSubmittingHarness("fail", lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs).toEqual([{ role: "reviewer", runId: "review-run-1" }]);
    expect(currentState).toBe("Blocked");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual(["review-run-1:blocked-escalation"]);
    expect(writer.comments[0]?.body).toContain("max review rounds reached (1/1)");
    expect(writer.comments[0]?.body).toContain("Review rounds: 1 / 1");
    expect(writer.comments[0]?.body).toContain("Last completion report:");
    expect(writer.comments[0]?.body).toContain("Last review verdict:");
    expect(writer.comments[0]?.body).toContain("Add reviewer MCP integration.");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      reviewRound: 1,
      incompleteTurnCount: 0,
      blockedReason: "max review rounds reached (1/1)",
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-fail-1",
    });
  });

  it("does not redispatch persisted fallback-blocked issues after restart", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = [];
    config.reviewLoop.maxIncompleteTurns = 2;
    const candidate = issue({ state: "In Progress" });
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
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      incompleteTurnCount: 2,
      blockedReason: "max incomplete turns reached (2/2)",
    });
    const harness = new FakeHarness();
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
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "max incomplete turns reached (2/2)",
    });
  });

  it("clears blocked lifecycle counters after a human unblock transition", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "In Progress" });
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
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      incompleteTurnCount: 2,
      blockedReason: "max review rounds reached (3/3)",
    });
    const harness = new BlockingHarness();
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

    expect(harness.stoppedRunIds).toEqual(["run-123"]);
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
    });
  });

  it("treats accepted completion reports as live handoff and suppresses continuation/no-report writeback", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
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
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher);
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
      runStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.prompts).toEqual(["Work on TEST-1"]);
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "report-run-1:run-started",
      "report-run-1:completion-report:idem-1",
    ]);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "In Review"]);
    expect(currentState).toBe("In Review");
    expect(writer.comments[1]?.body).toContain("https://github.com/acme/symphony/pull/42");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "review",
      incompleteTurnCount: 0,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("dispatches reviewer runs from configured review states with reviewer evidence", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate =
      "Review {{ issue.identifier }} as {{ role }}: {{ completionReport.summary }}\n{% for item in workspaceEvidence %}{{ item }}\n{% endfor %}{% for item in runDigest %}{{ item }}\n{% endfor %}";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const fetchedReviewStates: string[][] = [];
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        fetchedReviewStates.push(states);
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
      },
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: report.runId,
      at: "2026-01-01T00:00:02Z",
      source: "harness",
      eventType: "progress",
      message: "Implemented the reviewer dispatch lane.",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(fetchedReviewStates).toEqual([["In Review"]]);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.role).toBe("reviewer");
    expect(harness.runs[0]?.prompt).toContain("Review TEST-1 as reviewer");
    expect(harness.runs[0]?.prompt).toContain("Implemented the requested change.");
    expect(harness.runs[0]?.prompt).toContain("Pull request: https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Implemented the reviewer dispatch lane.");
    const runs = await runStore.listRunsForIssue(candidate.identifier);
    expect(runs.find((run) => run.runId === "fake-issue-1-1")).toMatchObject({ role: "reviewer" });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({ reviewRound: 0 });
  });

  it("processes a live fail verdict submitted by a reviewer harness run", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    let currentState = "In Review";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
      },
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    const harness = new ReviewVerdictSubmittingHarness("fail", lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs).toEqual([{ role: "reviewer", runId: "review-run-1" }]);
    expect(currentState).toBe("In Progress");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual(["review-run-1:review-verdict-fail"]);
    expect(writer.comments[0]?.body).toContain("Symphony review failed");
    expect(writer.comments[0]?.body).toContain("Add reviewer MCP integration.");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "implementation",
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-fail-1",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("processes a live pass verdict submitted by a reviewer harness run", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    let currentState = "In Review";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new ReviewVerdictSubmittingHarness("pass", lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs).toEqual([{ role: "reviewer", runId: "review-run-1" }]);
    expect(currentState).toBe("Ready to Merge");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual(["review-run-1:review-verdict-pass"]);
    expect(writer.comments[0]?.body).toContain("Symphony review passed");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Ready to Merge"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "passed",
      reviewRound: 0,
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-pass-1",
    });
  });

  it("does not treat review-state issues as worker candidates", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "In Review" });
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

  it("does not dispatch worker runs for blocked states even when they are active states", async () => {
    const config = testConfig(root);
    config.tracker.activeStates = ["Todo", "In Progress", "Blocked"];
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked" });
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
    expect(refreshes).toBe(0);
  });

  it("does not dispatch reviewers for blocked review issues", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({
      state: "In Review",
      blockedBy: [{ id: "blocker", identifier: "TEST-0", state: "Todo" }],
    });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [candidate];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new FakeHarness();
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
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
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
      headSha: "abc123",
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

  it("injects PR review evidence into the next worker prompt after requested changes", async () => {
    const config = testConfig(root);
    config.reviewLoop.continuationHistoryThreshold = 5;
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
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
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReportRecord(candidate)],
    });
    const pullRequestReviewClient = new FakePullRequestReviewEvidenceClient([
      {
        source: "review",
        githubId: "review-1",
        pullRequestNumber: 42,
        pullRequestUrl: "https://api.github.test/repos/acme/symphony/pulls/42",
        url: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
        reviewer: "reviewer-a",
        body: "Please address the inline comments.",
        state: "CHANGES_REQUESTED",
        path: null,
        line: null,
        originalLine: null,
        side: null,
        threadId: null,
        inReplyToId: null,
        isResolved: null,
        isOutdated: null,
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        submittedAt: "2026-01-01T00:00:01Z",
      },
      {
        source: "review_comment",
        githubId: "comment-1",
        pullRequestNumber: 42,
        pullRequestUrl: "https://api.github.test/repos/acme/symphony/pulls/42",
        url: "https://github.com/acme/symphony/pull/42#discussion_r1",
        reviewer: "reviewer-a",
        body: "Add coverage for the dedupe path.",
        state: null,
        path: "src/core/review/PullRequestReviewEvidenceService.ts",
        line: 72,
        originalLine: 70,
        side: "RIGHT",
        threadId: "thread-1",
        inReplyToId: null,
        isResolved: false,
        isOutdated: false,
        createdAt: "2026-01-01T00:00:02Z",
        updatedAt: "2026-01-01T00:00:02Z",
        submittedAt: null,
      },
    ]);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      pullRequestReviewClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(pullRequestReviewClient.calls).toEqual([42]);
    expect(harness.runs[0]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[0]?.prompt).toContain("PR review feedback to address");
    expect(harness.runs[0]?.prompt).toContain("Reviewer verdict: fail / requested changes");
    expect(harness.runs[0]?.prompt).toContain("src/core/review/PullRequestReviewEvidenceService.ts:72");
    expect(harness.runs[0]?.prompt).toContain("thread: thread-1");
    expect(harness.runs[0]?.prompt).toContain("Add coverage for the dedupe path.");
    expect(harness.runs[0]?.prompt).toContain("https://github.com/acme/symphony/pull/42");
  });

  it("injects the latest fail verdict findings and workspace context into the next worker prompt", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
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
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: report.id,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
      completionReports: [report],
      reviewVerdicts: [reviewVerdictRecord(candidate)],
      summaryPointers: {
        workspacePath: "/tmp/old-workspace",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
      },
    });
    const harness = new FakeHarness();
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs[0]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Reviewer findings to address");
    expect(harness.runs[0]?.prompt).toContain("Current workspace context:");
    expect(harness.runs[0]?.prompt).toContain("Branch: symphony/TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Pull request: #42 https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Add regression coverage for duplicate verdict submissions.");
    expect(harness.runs[0]?.prompt).toContain("https://github.com/acme/symphony/pull/42#discussion_r1");
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

function completionReportRecord(candidate = issue()): IssueCompletionReportRecord {
  return {
    id: `completion-report:${candidate.id}:idem-1`,
    idempotencyKey: "idem-1",
    runId: "worker-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    summary: "Implemented the requested change.",
    validationEvidence: ["npm test -- orchestrator"],
    acceptanceChecklist: [
      {
        text: "Reviewer dispatch is covered.",
        satisfied: true,
        evidence: "orchestrator test",
      },
    ],
    changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
    branchName: candidate.branchName,
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: candidate.branchName,
    },
    risks: [],
    acceptedAt: "2026-01-01T00:00:01Z",
    writebackOperationKeys: [],
  };
}

function reviewVerdictRecord(candidate = issue()): IssueReviewVerdictRecord {
  return {
    id: `review-verdict:${candidate.id}:verdict-1`,
    idempotencyKey: "verdict-1",
    runId: "review-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    verdict: "fail",
    acceptanceResults: [
      {
        text: "Duplicate verdicts are idempotent",
        satisfied: false,
        evidence: "Reviewer could not find a regression test.",
      },
    ],
    findings: ["Add regression coverage for duplicate verdict submissions."],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    reviewer: "reviewer-a",
    submittedAt: "2026-01-01T00:00:02Z",
    writebackOperationKeys: [],
  };
}

class BlockingHarness implements AgentHarness {
  readonly id = "blocking";
  readonly stoppedRunIds: string[] = [];

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-123", runId: "run-123" };
    if (!ctx.abortSignal.aborted) {
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
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

class CursorPromptHarness implements AgentHarness {
  readonly id = "cursor";
  readonly prompts: string[] = [];

  async *run(_ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "cursor-session-1", runId: "cursor-run-1" };
    yield { type: "completed" };
  }
}

class ReportingHarness implements AgentHarness {
  readonly id = "reporting";
  readonly prompts: string[] = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
    private readonly publisher: CompletionReportPullRequestPublisher,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "report-session-1", runId: "report-run-1" };
    await new CompletionReportService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
      runStore: this.runStore,
      pullRequestPublisher: this.publisher,
    }).submitCompletionReport(
      {
        runId: "report-run-1",
        issueId: ctx.issue.id,
        summary: "Implemented the requested handoff.",
        validationEvidence: ["npm test"],
        acceptanceChecklist: [
          {
            text: "Completion report handoff is live.",
            satisfied: true,
            evidence: "Orchestrator test",
          },
        ],
        changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
        branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
        pullRequest: null,
        risks: [],
        idempotencyKey: "idem-1",
      },
      {
        issue: ctx.issue,
        activeRunId: "report-run-1",
        role: "worker",
        sessionId: "report-session-1",
        workspacePath: ctx.workspace.path,
        workspace: ctx.workspace,
        phase: "implementation",
      },
    );
    yield { type: "completed" };
  }
}

class ReviewVerdictSubmittingHarness implements AgentHarness {
  readonly id = "review-verdict-submitting";
  readonly runs: Array<{ role: string; runId: string }> = [];

  constructor(
    private readonly verdict: "fail" | "pass",
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
  ) {}

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const runId = "review-run-1";
    this.runs.push({ role: ctx.role, runId });
    yield { type: "session_started", sessionId: "review-session-1", runId };
    await new ReviewVerdictService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
    }).submitReviewVerdict(
      this.verdict === "fail"
        ? {
            runId,
            issueId: ctx.issue.id,
            verdict: "fail",
            acceptanceResults: [
              {
                text: "Reviewer verdict submissions are wired through the reviewer harness.",
                satisfied: false,
                evidence: "Reviewer MCP path was missing.",
              },
            ],
            findings: ["Add reviewer MCP integration."],
            evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
            idempotencyKey: "review-verdict-fail-1",
          }
        : {
            runId,
            issueId: ctx.issue.id,
            verdict: "pass",
            acceptanceResults: [
              {
                text: "Reviewer verdict submissions are wired through the reviewer harness.",
                satisfied: true,
                evidence: "Reviewer MCP path is present.",
              },
            ],
            findings: [],
            evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-2"],
            idempotencyKey: "review-verdict-pass-1",
          },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "reviewer",
        reviewer: "reviewer-agent",
        phase: "review",
      },
    );
    yield { type: "completed" };
  }
}

class FakeCompletionReportPublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(private readonly publication: CompletionReportPullRequestPublication) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    return this.publication;
  }
}

class FakePullRequestDiscoveryClient implements PullRequestDiscoveryClient {
  readonly branches: string[] = [];

  constructor(
    private readonly pullRequest: {
      url: string;
      number: number;
      headBranch: string;
      headSha: string | null;
      lastPushedAt: string | null;
    } | null,
  ) {}

  async findOpenPullRequestByBranch(input: { branchName: string }) {
    this.branches.push(input.branchName);
    return this.pullRequest;
  }
}

class FakePullRequestReviewEvidenceClient implements PullRequestReviewEvidenceClient {
  readonly calls: number[] = [];

  constructor(private readonly evidence: RemotePullRequestReviewEvidence[]) {}

  async listPullRequestReviewEvidence(input: { pullRequestNumber: number }): Promise<RemotePullRequestReviewEvidence[]> {
    this.calls.push(input.pullRequestNumber);
    return this.evidence.filter((item) => item.pullRequestNumber === input.pullRequestNumber);
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
