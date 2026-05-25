import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompletionReportService,
  PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
  PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
  type CompletionReportPullRequestPublication,
  type CompletionReportPullRequestPublicationInput,
  type CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";
import {
  FileOperatorApprovalStore,
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  OperatorApprovalService,
  type OperatorApprovalRecord,
} from "../src/core/approval/OperatorApprovalService.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { ReviewVerdictService } from "../src/core/ReviewVerdictService.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator, sortIssuesForDispatch, type PullRequestDiscoveryClient } from "../src/core/orchestrator/Orchestrator.js";
import {
  FileIssueLifecycleStore,
  type IssueCompletionReportRecord,
  type IssueLifecyclePatch,
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
import type { Issue, TokenCounts } from "../src/core/types.js";
import { issue, testConfig } from "./helpers.js";

describe("Orchestrator", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    expect(harness.runs[0]?.prompt).not.toContain("Compact Symphony handoff packet:");
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
    await waitFor(() => harness.prompts.length === 1);
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

  it.each([
    ["setup-incomplete", PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON],
    ["awaiting operator", PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON],
  ] as const)("does not burn incomplete turns while %s publication approval handoff is active", async (_name, blockedReason) => {
    const config = testConfig(root);
    config.reviewLoop.maxIncompleteTurns = 2;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        throw new Error("incomplete turn guard should not refresh active issues");
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      ...pendingApprovalLifecyclePatch(candidate, root, "run-1", blockedReason),
      phase: "implementation",
      incompleteTurnCount: 1,
    });
    const writer = new StateChangingWriter(() => undefined);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    try {
      await (
        orchestrator as unknown as {
          recordIncompleteTurn(entry: unknown): Promise<void>;
        }
      ).recordIncompleteTurn({
        issue: candidate,
        runId: "run-1",
        activeRunId: "run-1",
        lifecycle: await lifecycleStore.get(candidate.id),
      });

      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "implementation",
        blockedReason,
        incompleteTurnCount: 1,
      });
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
    } finally {
      await orchestrator.stop();
    }
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

  it.each([
    ["setup-incomplete", PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON],
    ["awaiting operator", PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON],
  ] as const)("does not redispatch issues with %s pending publication approval before Linear reaches Blocked", async (_name, blockedReason) => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
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
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, {
      ...pendingApprovalLifecyclePatch(candidate, root, "run-1", blockedReason),
      phase: "implementation",
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
      phase: "implementation",
      blockedReason,
    });
  });

  it("does not stall-cancel lifecycle-only pending publication approval handoffs", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
    (config.raw as { codex?: { stall_timeout_ms?: number } }).codex = { stall_timeout_ms: 1 };
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
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
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new BlockingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => orchestrator.snapshot().running[0]?.runId !== null, "worker run start");
      const runId = orchestrator.snapshot().running[0]?.runId ?? "";
      await lifecycleStore.ensureIssue(
        candidate,
        pendingApprovalLifecyclePatch(candidate, root, runId, PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON),
      );
      await runStore.updateRun(runId, {
        metadata: {
          pendingApprovalRequestId: null,
          pendingApprovalRequestedAt: null,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      await (
        orchestrator as unknown as {
          reconcileStalledRuns(): Promise<void>;
        }
      ).reconcileStalledRuns();
      await orchestrator.refreshNow();

      expect(orchestrator.snapshot().counts.running).toBe(1);
      const runningRun = await runStore.getRun(runId);
      expect(runningRun).toMatchObject({
        status: "running",
      });
      expect(runningRun?.pendingApprovalRequestId ?? null).toBeNull();
      expect(runningRun?.cancellationRequestedAt ?? null).toBeNull();
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        incompleteTurnCount: 0,
      });
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(1);
    } finally {
      await orchestrator.stop();
    }
  });

  it.each([
    {
      name: "comment fails while Blocked transition succeeds",
      writer: (setState: (state: string) => void) => new PublicationApprovalCommentFailingWriter(setState),
      stateBeforeRecovery: "Blocked",
      recoveryComments: 1,
      recoveryTransitions: 0,
    },
    {
      name: "Blocked transition fails after comment succeeds",
      writer: (setState: (state: string) => void) => new PublicationApprovalTransitionFailingWriter(setState),
      stateBeforeRecovery: "Todo",
      recoveryComments: 0,
      recoveryTransitions: 1,
    },
  ])(
    "recovers a real post-exit pending publication approval handoff after partial audit failure: $name",
    async ({ writer, stateBeforeRecovery, recoveryComments, recoveryTransitions }) => {
      const config = testConfig(root);
      config.writeback.enabled = true;
      config.writeback.mode = "live";
      config.writeback.dispatchState = "Todo";
      config.writeback.maxBackoffMs = 0;
      config.reviewLoop.blockedStates = ["Blocked"];
      config.github.publishPullRequests = true;
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
      config.github.operatorApproval!.requiredForPublication = true;
      config.workspace.source.baseRef = "main";
      const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
      let currentState = "Todo";
      const tracker: TrackerClient = {
        async fetchCandidateIssues() {
          return ["Todo", "In Progress"].includes(currentState) ? [{ ...candidate, state: currentState }] : [];
        },
        async fetchIssuesByStates(states) {
          return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
        },
        async fetchIssueStatesByIds() {
          return [{ ...candidate, state: currentState }];
        },
      };
      const logger = new StructuredLogger(() => undefined);
      const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
      const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
      const approvalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
      const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
      const partialWriter = writer((state) => {
        currentState = state;
      });
      const partialWriteback = new WritebackProcessor(outboxStore, partialWriter, logger, config.writeback.maxBackoffMs);
      const publisher = new FakeCompletionReportPublisher({
        action: "created",
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headBranch: "symphony/TEST-1",
        headSha: "abc123",
        lastPushedAt: "2026-01-01T00:00:01Z",
        evidenceCursor: "idem-1",
      });
      const harness = new ReportingHarness(
        lifecycleStore,
        outboxStore,
        runStore,
        publisher,
        "throw",
        operatorApproval,
        partialWriteback,
      );
      const firstOrchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness,
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
        writeback: partialWriteback,
        operatorApproval,
      });

      await firstOrchestrator.refreshNow();
      await waitFor(() => firstOrchestrator.snapshot().counts.running === 0, "partial audit worker exit");
      await firstOrchestrator.stop();

      expect(harness.prompts).toEqual(["Work on TEST-1"]);
      expect(currentState).toBe(stateBeforeRecovery);
      await expect(approvalStore.findPendingForRun("report-run-1")).resolves.toBeNull();
      const runBeforeRecovery = await waitForTerminalRunRecord(runStore, "report-run-1");
      expect(runBeforeRecovery).toMatchObject({ status: "succeeded" });
      expect(runBeforeRecovery?.pendingApprovalRequestId ?? null).toBeNull();
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        incompleteTurnCount: 0,
        completionReports: [
          expect.objectContaining({
            runId: "report-run-1",
            idempotencyKey: "idem-1",
            writebackOperationKeys: [],
          }),
        ],
      });
      expect(partialWriter.comments.some((comment) => comment.dedupeKey?.includes("run-failed"))).toBe(false);
      expect(partialWriter.comments.some((comment) => comment.dedupeKey?.includes("run-cancelled"))).toBe(false);
      expect(firstOrchestrator.snapshot().counts.retrying).toBe(0);
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(1);

      const recoveryWriter = new StateChangingWriter((state) => {
        currentState = state;
      });
      const recoveryWriteback = new WritebackProcessor(outboxStore, recoveryWriter, logger, config.writeback.maxBackoffMs);
      const recoveryOrchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness: new FakeHarness(),
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
        writeback: recoveryWriteback,
        operatorApproval,
      });

      await recoveryOrchestrator.refreshNow();
      const pending = await approvalStore.findPendingForRun("report-run-1");
      expect(pending).toMatchObject({
        status: "pending",
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "report-run-1",
        evidenceCursor: "idem-1",
      });
      await recoveryOrchestrator.refreshNow();

      const approvals = await approvalStore.list();
      expect(approvals.filter((approval) => approval.runId === "report-run-1")).toHaveLength(1);
      await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
        status: "succeeded",
        pendingApprovalRequestId: pending?.requestId,
        pendingApprovalRequestedAt: pending?.requestedAt,
      });
      const transcript = await runStore.readTranscript("report-run-1");
      expect(transcript.events.filter((event) => event.eventType === "approval_request")).toHaveLength(1);
      expect(recoveryWriter.comments).toHaveLength(recoveryComments);
      expect(recoveryWriter.transitions).toHaveLength(recoveryTransitions);
      const pendingAuditOperations = (await outboxStore.list()).filter((operation) =>
        operation.idempotencyKey.includes("publication-approval-pending"),
      );
      expect(pendingAuditOperations).toHaveLength(2);
      expect(pendingAuditOperations.map((operation) => operation.status)).toEqual(["succeeded", "succeeded"]);
      expect(recoveryOrchestrator.snapshot().counts.running).toBe(0);
      expect(recoveryOrchestrator.snapshot().counts.retrying).toBe(0);
      expect(harness.prompts).toHaveLength(1);
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(1);
      await recoveryOrchestrator.stop();
    },
  );

  it("skips recovery for an already linked pending publication approval wait", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logs: string[] = [];
    const logger = new StructuredLogger((line) => logs.push(line));
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    const { record: approval } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        action: {
          kind: "push_and_pr",
          branchName: "symphony/TEST-1",
          baseBranch: "main",
          workspacePath: path.join(root, "workspace"),
          title: `${candidate.identifier}: ${candidate.title}`,
          evidenceCursor: "idem-1",
          summaryPreview: "Implemented the requested handoff.",
          changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      },
      null,
    );
    await runStore.updateRun("run-1", {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        pendingApprovalRequestId: approval.requestId,
        pendingApprovalRequestedAt: approval.requestedAt,
      },
    });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const lifecycleBefore = await lifecycleStore.get(candidate.id);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
    });

    try {
      await orchestrator.refreshNow();
      await orchestrator.refreshNow();

      expect(await approvalStore.list()).toHaveLength(1);
      expect(await outboxStore.list()).toEqual([]);
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toEqual(lifecycleBefore);
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        pendingApprovalRequestId: approval.requestId,
        pendingApprovalRequestedAt: approval.requestedAt,
      });
      expect(logs.some((line) => line.includes("pending publication approval recovered"))).toBe(false);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("leaves missing_run pending publication approval recovery untouched during orchestrator ticks", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logs: string[] = [];
    const logger = new StructuredLogger((line) => logs.push(line));
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "missing-run"));
    const lifecycleBefore = await lifecycleStore.get(candidate.id);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();
      await orchestrator.refreshNow();

      expect(await approvalStore.list()).toHaveLength(0);
      expect(await outboxStore.list()).toEqual([]);
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toEqual(lifecycleBefore);
      await expect(runStore.getRun("missing-run")).resolves.toBeNull();
      expect(publisher.inputs).toEqual([]);
      expect(harness.runs).toEqual([]);
      expect(logs.some((line) => line.includes("pending publication approval recovered"))).toBe(false);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("leaves audit_not_settled pending publication approval recovery unfinalized during orchestrator ticks", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.writeback.maxBackoffMs = 0;
    config.reviewLoop.blockedStates = ["Blocked"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logs: string[] = [];
    const logger = new StructuredLogger((line) => logs.push(line));
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new FailingWriter();
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const lifecycleBefore = await lifecycleStore.get(candidate.id);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();
      const operationsAfterFirstTick = await outboxStore.list();
      expect(operationsAfterFirstTick).toHaveLength(2);
      expect(operationsAfterFirstTick.map((operation) => operation.status)).toEqual(["retrying", "retrying"]);

      await orchestrator.refreshNow();
      const operationsAfterSecondTick = await outboxStore.list();
      expect(operationsAfterSecondTick).toHaveLength(2);
      expect(operationsAfterSecondTick.map((operation) => operation.status)).toEqual(["retrying", "retrying"]);

      expect(await approvalStore.list()).toHaveLength(0);
      await expect(approvalStore.findPendingForRun("run-1")).resolves.toBeNull();
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toEqual(lifecycleBefore);
      expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
      expect(publisher.inputs).toEqual([]);
      expect(harness.runs).toEqual([]);
      expect(logs.some((line) => line.includes("pending publication approval recovered"))).toBe(false);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("recovers a pre-approved publication approval handoff during an orchestrator tick", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Blocked";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
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
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const { record } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        action: approvalRecordFor("pending", candidate, "run-1", root).action,
      },
      null,
    );
    await approvalStore.resolve(record.requestId, "approve");
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => publisher.inputs.length === 1, "approved recovery publication");
      await waitFor(
        () => harness.runs.filter((run) => run.ctx.role === "reviewer").length === 1,
        "reviewer dispatch after approved recovery",
      );

      expect(await approvalStore.list()).toHaveLength(1);
      await expect(approvalStore.findPendingForRun("run-1")).resolves.toBeNull();
      expect(publisher.inputs[0]).toMatchObject({
        workspacePath: path.join(root, "workspace"),
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        evidenceCursor: "idem-1",
      });
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Completion Report"))).toHaveLength(1);
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Setup Incomplete"))).toHaveLength(1);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked", "In Review"]);
      expect(currentState).toBe("In Review");
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "review",
        blockedReason: null,
        completionReports: [
          expect.objectContaining({
            runId: "run-1",
            idempotencyKey: "idem-1",
            pullRequest: {
              url: "https://github.com/acme/symphony/pull/42",
              number: 42,
              headSha: "abc123",
              branch: "symphony/TEST-1",
            },
          }),
        ],
      });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
      });
      expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
      expect(harness.runs.filter((run) => run.ctx.role === "worker")).toHaveLength(0);
      expect(orchestrator.snapshot().counts.retrying).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("recovers a terminal publication approval handoff during an orchestrator tick", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const { record } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        action: approvalRecordFor("pending", candidate, "run-1", root).action,
      },
      null,
    );
    await approvalStore.markExpired(record.requestId);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();

      expect(await approvalStore.list()).toHaveLength(1);
      await expect(approvalStore.findPendingForRun("run-1")).resolves.toBeNull();
      expect(publisher.inputs).toEqual([]);
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Setup Incomplete"))).toHaveLength(1);
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Not Completed"))).toHaveLength(1);
      expect(writer.comments.some((comment) => comment.body.includes("Status: accepted"))).toBe(false);
      expect(writer.comments.some((comment) => comment.body.includes("Status: expired"))).toBe(true);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked"]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: "publication approval expired",
        completionReports: [
          expect.objectContaining({
            runId: "run-1",
            idempotencyKey: "idem-1",
            pullRequest: null,
            writebackOperationKeys: [],
          }),
        ],
      });
      const recoveredRun = await runStore.getRun("run-1");
      expect(recoveredRun?.prUrl ?? null).toBeNull();
      expect(recoveredRun?.pendingApprovalRequestId ?? null).toBeNull();
      expect(orchestrator.snapshot().counts.running).toBe(0);
      expect(orchestrator.snapshot().counts.retrying).toBe(0);
    } finally {
      await orchestrator.stop();
    }
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
    await waitFor(() => orchestrator.snapshot().running[0]?.runId !== null, "blocked lifecycle worker start");
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

  it("reapplies Todo dispatch transitions after a prior dispatch writeback already succeeded", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Todo", updatedAt: "2026-01-01T01:00:00Z" });
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
    const stateDir = path.join(root, "state");
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const oldDispatchRecord = await outboxStore.enqueueOnce({
      idempotencyKey: `transition:${candidate.id}:dispatch:In Progress`,
      kind: "transition",
      issueId: candidate.id,
      payload: {
        fromStates: ["Todo"],
        toState: "In Progress",
        reason: "Symphony dispatch",
      },
    });
    await outboxStore.markSucceeded(oldDispatchRecord);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      incompleteTurnCount: 2,
      blockedReason: "max review rounds reached (3/3)",
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
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "worker dispatch after human Todo unblock");
    await orchestrator.stop();

    expect(writer.transitions).toEqual([
      expect.objectContaining({
        issueId: candidate.id,
        fromStates: ["Todo"],
        toState: "In Progress",
      }),
    ]);
    expect(currentState).toBe("In Progress");
    expect(harness.runs[0]?.ctx.issue.state).toBe("In Progress");
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

  it("[event-guard:failed] treats accepted completion reports as handoff when the harness fails after reporting", async () => {
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
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher, {
      type: "failed",
      error: "post-handoff harness failure",
    });
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
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-failed"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-cancelled"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      status: "succeeded",
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
    const transcript = await runStore.readTranscript("report-run-1");
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("failed");
    expect(eventTypes).not.toContain("completed");
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("[event-guard:cancelled] treats accepted completion reports as handoff when the harness is cancelled after reporting", async () => {
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
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher, {
      type: "cancelled",
    });
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
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-failed"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-cancelled"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      status: "succeeded",
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
    const transcript = await runStore.readTranscript("report-run-1");
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("cancelled");
    expect(eventTypes).not.toContain("completed");
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("[backstop:throw] reconciles accepted completion reports when the harness throws after reporting", async () => {
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
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher, "throw");
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
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-failed"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-cancelled"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      status: "succeeded",
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
    const transcript = await runStore.readTranscript("report-run-1");
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toContain("session_started");
    expect(eventTypes).not.toContain("failed");
    expect(eventTypes).not.toContain("cancelled");
    expect(eventTypes).not.toContain("completed");
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("preserves fail-policy approval rejection through abnormal worker exit", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.tracker.handoffStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "fail";
    config.github.operatorApproval!.pollIntervalMs = 5;
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
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(
      lifecycleStore,
      outboxStore,
      runStore,
      publisher,
      { type: "completed" },
      operatorApproval,
      writeback,
    );
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
    const pending = await waitForPendingApproval(approvalStore, "report-run-1");
    await operatorApproval.resolve(pending.requestId, "reject");
    const rejectedRun = await waitForRunRecord(runStore, "report-run-1");
    const rejectedAt = rejectedRun?.completedAt;

    expect(rejectedRun).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: OPERATOR_REJECTED_PUBLICATION_ERROR,
      pendingApprovalRequestId: null,
    });
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "approval-rejected worker exit");

    const finalRun = await waitForTerminalRunRecord(runStore, "report-run-1");
    expect(finalRun).toMatchObject({
      status: "failed",
      completedAt: rejectedAt,
      error: OPERATOR_REJECTED_PUBLICATION_ERROR,
      pendingApprovalRequestId: null,
    });
    expect(finalRun?.cancellationRequestedAt ?? null).toBeNull();
    expect(finalRun?.cancellationSource ?? null).toBeNull();
    expect(finalRun?.cancellationOutcome ?? "none").toBe("none");
    expect(publisher.inputs).toEqual([]);
    expect(writer.comments.some((comment) => comment.body.includes("Publication Approval Setup Incomplete"))).toBe(true);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
    await orchestrator.stop();
  });

  it("preserves cancel-policy approval rejection through cancelled worker exit", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.tracker.handoffStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "cancel";
    config.github.operatorApproval!.pollIntervalMs = 5;
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
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(
      lifecycleStore,
      outboxStore,
      runStore,
      publisher,
      { type: "completed" },
      operatorApproval,
      writeback,
    );
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
    const pending = await waitForPendingApproval(approvalStore, "report-run-1");
    expect(writer.comments.some((comment) => comment.body.includes("Publication Approval Setup Incomplete"))).toBe(true);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    const result = await operatorApproval.resolve(pending.requestId, "reject");
    await orchestrator.cancelIssue(candidate.id);
    await orchestrator.recordPublicationApprovalTerminal(result.request);
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "approval-rejected cancel-policy worker exit");

    const finalRun = await waitForTerminalRunRecord(runStore, "report-run-1");
    expect(finalRun).toMatchObject({
      status: "succeeded",
      completedAt: expect.any(String),
      pendingApprovalRequestId: null,
    });
    expect(publisher.inputs).toEqual([]);
    expect(writer.comments.some((comment) => comment.body.includes("Status: rejected"))).toBe(true);
    expect(writer.comments.some((comment) => comment.dedupeKey === "report-run-1:completion-report:idem-1")).toBe(false);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "publication approval rejected",
      incompleteTurnCount: 0,
      completionReports: [
        {
          idempotencyKey: "idem-1",
          runId: "report-run-1",
          writebackOperationKeys: [],
        },
      ],
    });
    await orchestrator.refreshNow();
    expect(harness.prompts).toHaveLength(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
    await orchestrator.stop();
  });

  it("resumes approved publication through the orchestrator after the worker exits", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Blocked";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
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
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      completionReportPublisher: publisher,
    });

    await expect(orchestrator.resumeApprovedPublication(approvalRecordFor("approved", candidate, "run-1", root))).resolves.toBe(
      true,
    );

    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      workspacePath: path.join(root, "workspace"),
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]?.body).toContain("## Symphony Completion Report");
    expect(writer.comments[0]?.body).toContain("Status: accepted");
    expect(writer.comments[0]?.body).not.toContain("Publication Approval Not Completed");
    expect(writer.transitions).toHaveLength(1);
    expect(writer.transitions[0]).toMatchObject({ toState: "In Review" });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "review",
      blockedReason: null,
      completionReports: [
        expect.objectContaining({
          runId: "run-1",
          idempotencyKey: "idem-1",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "abc123",
            branch: "symphony/TEST-1",
          },
        }),
      ],
    });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
    });
  });

  it.each([
    ["stale", "run cancellation has been requested"],
    ["expired", "approval request expired"],
  ] as const)(
    "records terminal publication approval recovery through the orchestrator when approval is %s after worker exit",
    async (status, staleReason) => {
      const config = testConfig(root);
      config.writeback.enabled = true;
      config.writeback.mode = "live";
      config.writeback.dispatchState = "Todo";
      config.reviewLoop.blockedStates = ["Blocked"];
      config.reviewLoop.reviewStates = ["In Review"];
      config.github.publishPullRequests = true;
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
      config.workspace.source.baseRef = "main";
      const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
      const tracker: TrackerClient = {
        async fetchCandidateIssues() {
          return [];
        },
        async fetchIssuesByStates() {
          return [];
        },
        async fetchIssueStatesByIds() {
          return [candidate];
        },
      };
      const logger = new StructuredLogger(() => undefined);
      const stateDir = config.workspace.stateDir;
      const outboxStore = new FileWritebackOutboxStore(stateDir);
      const writer = new StateChangingWriter(() => undefined);
      const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
      const runStore = new FileRunTranscriptStore(stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(stateDir);
      await startApprovalRun(runStore, candidate, "run-1", root);
      await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
      await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
      const orchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness: new FakeHarness(),
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
        writeback,
      });
      const approval = approvalRecordFor(status, candidate, "run-1", root, staleReason);

      await expect(orchestrator.recordPublicationApprovalTerminal(approval)).resolves.toBe(true);
      await expect(orchestrator.recordPublicationApprovalTerminal(approval)).resolves.toBe(true);

      expect(writer.comments).toHaveLength(1);
      expect(writer.comments[0]?.body).toContain("## Symphony Publication Approval Not Completed");
      expect(writer.comments[0]?.body).toContain(`Status: ${status}`);
      expect(writer.comments[0]?.body).toContain(`Reason: ${staleReason}`);
      expect(writer.comments[0]?.body).toContain("The worker completion report remains stored");
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: `publication approval ${status}`,
      });
    },
  );

  it("smokes a manufactured fail, revision worker, and pass review loop", async () => {
    const config = testConfig(root);
    config.agent.maxConcurrentAgents = 1;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    expect(config.continuationContext.searchEnabled).toBe(false);
    expect(config.continuationContext.summarizationEnabled).toBe(false);

    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return ["Todo", "In Progress"].includes(currentState) ? [{ ...candidate, state: currentState }] : [];
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
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new ManufacturedReviewLoopHarness(lifecycleStore, outboxStore, runStore);
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

    try {
      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "In Review" && harness.runs.length === 1 && orchestrator.snapshot().counts.running === 0,
        "first worker handoff",
      );
      await runStore.appendEvent({
        runId: "smoke-worker-run-1",
        at: "2026-01-01T00:00:10.000Z",
        source: "harness",
        eventType: "progress",
        message: `RAW_TRANSCRIPT_SECRET ${"x".repeat(20_000)}`,
      });
      await settleOrchestratorExit();

      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "In Progress" && harness.runs.length === 2 && orchestrator.snapshot().counts.running === 0,
        "reviewer fail handoff",
      );
      await settleOrchestratorExit();

      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "In Review" && harness.runs.length === 3 && orchestrator.snapshot().counts.running === 0,
        "revision worker handoff",
      );
      await settleOrchestratorExit();

      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "Ready to Merge" && harness.runs.length === 4 && orchestrator.snapshot().counts.running === 0,
        "reviewer pass handoff",
      );
    } finally {
      await orchestrator.stop();
    }

    expect(harness.runs.map(({ role, runId }) => ({ role, runId }))).toEqual([
      { role: "worker", runId: "smoke-worker-run-1" },
      { role: "reviewer", runId: "smoke-review-run-1" },
      { role: "worker", runId: "smoke-worker-run-2" },
      { role: "reviewer", runId: "smoke-review-run-2" },
    ]);
    expect(harness.runs[2]?.prompt).toContain("Reviewer findings to address");
    expect(harness.runs[2]?.prompt).toContain("Add the manufactured smoke revision.");
    expect(harness.runs[2]?.prompt).not.toContain("RAW_TRANSCRIPT_SECRET");
    expect(harness.runs[2]?.prompt.length).toBeLessThan(12_000);
    expect(currentState).toBe("Ready to Merge");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual([
      "In Progress",
      "In Review",
      "In Progress",
      "In Review",
      "Ready to Merge",
    ]);

    const lifecycle = await lifecycleStore.get(candidate.identifier);
    expect(lifecycle).toMatchObject({
      phase: "passed",
      reviewRound: 1,
      incompleteTurnCount: 0,
      lastCompletionReportId: "completion-report:issue-1:smoke-report-2",
      lastReviewVerdictId: "review-verdict:issue-1:smoke-verdict-pass",
    });
    expect(lifecycle?.completionReports.map((report) => report.idempotencyKey)).toEqual([
      "smoke-report-1",
      "smoke-report-2",
    ]);
    expect(lifecycle?.reviewVerdicts.map((verdict) => verdict.idempotencyKey)).toEqual([
      "smoke-verdict-fail",
      "smoke-verdict-pass",
    ]);
    expect(lifecycle?.summaryPointers.workspacePath).toBeTruthy();

    const runs = await runStore.listRunsForIssue(candidate.identifier);
    expect(runs).toHaveLength(4);
    expect(runs.map((run) => run.runId)).toEqual(
      expect.arrayContaining([
        "smoke-worker-run-1",
        "smoke-review-run-1",
        "smoke-worker-run-2",
        "smoke-review-run-2",
      ]),
    );
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    for (const runId of runs.map((run) => run.runId)) {
      await expect(runStore.readTranscript(runId)).resolves.toMatchObject({
        runId,
        events: expect.arrayContaining([expect.objectContaining({ eventType: "completed" })]),
      });
    }
    await expect(runStore.readTranscript("smoke-worker-run-2")).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: "lane_memo_updated",
          payload: expect.objectContaining({ memoSizeChars: expect.any(Number) }),
        }),
      ]),
    });
  }, 15_000);

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

  it("instructs default reviewer prompts to leave PR feedback before verdict submission", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
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

    const prompt = harness.runs[0]?.prompt ?? "";
    expect(prompt).toContain("submit_pull_request_review_feedback");
    expect(prompt).toContain("submit_review_verdict.evidence");
    expect(prompt.indexOf("submit_pull_request_review_feedback")).toBeLessThan(prompt.indexOf("submit_review_verdict"));
    expect(prompt).toContain("PR number, repository, token, or commit identity");
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

    let lifecycle = orchestrator.snapshot().running[0]?.lifecycle;
    try {
      await orchestrator.refreshNow();
      await waitFor(() => {
        lifecycle = orchestrator.snapshot().running[0]?.lifecycle;
        return lifecycle?.summaryPointers.lastRunId === "run-123";
      }, "lifecycle run id to be recorded");
    } finally {
      await orchestrator.stop();
    }

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

  it("lazy-resolves worker GitHub discovery credentials when no discovery client override is injected", async () => {
    const config = githubProfileConfig(root, {
      profiles: {
        discovery: { value: "$GITHUB_DISCOVERY_TOKEN", capabilities: ["github.discovery"] },
      },
      roles: {
        worker: {
          "github.discovery": "discovery",
        },
      },
      env: {
        GITHUB_DISCOVERY_TOKEN: "discovery-secret",
      },
    });
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
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      const url = new URL(String(input));
      expect(url.pathname).toBe("/repos/acme/symphony/pulls");
      return new Response(
        JSON.stringify([
          {
            html_url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            head: { ref: "symphony/TEST-1", sha: "abc123", repo: { pushed_at: "2026-01-01T00:00:01Z" } },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
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

    expect(authorizations).toEqual(["Bearer discovery-secret", "Bearer discovery-secret"]);
  });

  it("injects PR review evidence into the next worker prompt after requested changes", async () => {
    const config = testConfig(root);
    config.reviewLoop.continuationHistoryThreshold = 5;
    const candidate = issue({ state: "In Progress", branchName: null });
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
    expect(harness.runs[0]?.prompt).toContain("Compact Symphony handoff packet:");
    expect(harness.runs[0]?.prompt).toContain("Active unresolved PR review evidence:");
    expect(harness.runs[0]?.prompt).toContain("Reviewer verdict: fail / requested changes");
    expect(harness.runs[0]?.prompt).toContain("src/core/review/PullRequestReviewEvidenceService.ts:72");
    expect(harness.runs[0]?.prompt).toContain("thread: thread-1");
    expect(harness.runs[0]?.prompt).toContain("Add coverage for the dedupe path.");
    expect(harness.runs[0]?.prompt).toContain("https://github.com/acme/symphony/pull/42");
  });

  it("lazy-resolves reviewer GitHub review-evidence credentials for worker feedback prompts", async () => {
    const config = githubProfileConfig(root, {
      profiles: {
        "review-read": {
          value: "$GITHUB_REVIEW_READ_TOKEN",
          capabilities: ["github.review_evidence_read"],
        },
      },
      roles: {
        reviewer: {
          "github.review_evidence_read": "review-read",
        },
      },
      env: {
        GITHUB_REVIEW_READ_TOKEN: "review-read-secret",
      },
    });
    config.reviewLoop.continuationHistoryThreshold = 5;
    const candidate = issue({ state: "In Progress", branchName: null });
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
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReportRecord(candidate)],
    });
    const calls: Array<{ pathname: string; authorization: string }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        pathname: url.pathname,
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
      });
      if (url.pathname === "/graphql") {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        });
      }
      if (url.pathname.endsWith("/pulls/42/reviews")) {
        return jsonResponse([
          {
            id: 1001,
            html_url: "https://github.com/acme/symphony/pull/42#pullrequestreview-1001",
            state: "CHANGES_REQUESTED",
            body: "Please address the reviewer-owned evidence path.",
            user: { login: "reviewer-a" },
            submitted_at: "2026-01-01T00:00:01Z",
            updated_at: "2026-01-01T00:00:01Z",
          },
        ]);
      }
      return jsonResponse([]);
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

    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer review-read-secret",
      "Bearer review-read-secret",
      "Bearer review-read-secret",
      "Bearer review-read-secret",
    ]);
    expect(harness.runs[0]?.prompt).toContain("PR review feedback to address");
    expect(harness.runs[0]?.prompt).toContain("Please address the reviewer-owned evidence path.");
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
    expect(harness.runs[0]?.prompt).toContain("Lifecycle counters:");
    expect(harness.runs[0]?.prompt).toContain("Review rounds: 0");
    expect(harness.runs[0]?.prompt).toContain("Latest workspace/git evidence:");
    expect(harness.runs[0]?.prompt).toContain("Branch: symphony/TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Pull request: #42 https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Acceptance criteria gaps:");
    expect(harness.runs[0]?.prompt).toContain("Duplicate verdicts are idempotent");
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

  it("exposes live liveness and cancellation state before a cancelled run exits", async () => {
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
    const harness = new HeldCancellationHarness();
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
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-123", "run to start");
    const active = orchestrator.snapshot().running[0];
    expect(active).toMatchObject({
      issueIdentifier: "TEST-1",
      runId: "run-123",
      liveness: {
        status: "active",
        activeRunId: "run-123",
        stallTimeoutMs: 300_000,
      },
      cancellation: {
        requested: false,
        requestedAt: null,
        source: null,
        reason: null,
        abortSignalled: false,
        harnessStopRequestedAt: null,
        suppressRetryOnExit: false,
      },
    });

    await orchestrator.cancelIssue(candidate.id);
    const cancelling = orchestrator.snapshot().running[0];
    expect(cancelling).toMatchObject({
      issueIdentifier: "TEST-1",
      liveness: {
        status: "cancelling",
        activeRunId: "run-123",
      },
      cancellation: {
        requested: true,
        source: "operator",
        reason: "operator request",
        abortSignalled: true,
        suppressRetryOnExit: true,
      },
    });
    expect(cancelling?.cancellation.requestedAt).toEqual(expect.any(String));
    expect(cancelling?.cancellation.harnessStopRequestedAt).toEqual(expect.any(String));

    await orchestrator.cancelIssue(candidate.id);
    const repeatedCancel = orchestrator.snapshot().running[0];
    expect(repeatedCancel?.cancellation.requestedAt).toBe(cancelling?.cancellation.requestedAt);
    expect(repeatedCancel?.cancellation.reason).toBe("operator request");

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "cancelled run to exit");
    await orchestrator.stop();
  });

  it("records harness stop failures without failing cancellation", async () => {
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
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new FailingStopHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-failing-stop", "run to start");
    await expect(orchestrator.cancelIssue(candidate.id)).resolves.toBeUndefined();

    const cancelling = orchestrator.snapshot().running[0];
    expect(cancelling).toMatchObject({
      liveness: { status: "cancelling", activeRunId: "run-failing-stop" },
      cancellation: {
        requested: true,
        source: "operator",
        harnessStopFailedReason: "stop failed",
        cancelFailed: {
          tracked: true,
          active: true,
          phase: "failed",
          source: "harness_stop",
        },
      },
    });
    expect(cancelling?.cancellation.harnessStopFailedAt).toEqual(expect.any(String));

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "cancelled run to exit");
    await expect(runStore.getRun("run-failing-stop")).resolves.toMatchObject({
      status: "cancelled",
      cancelFailed: false,
      cancellationOutcome: "cancelled",
      harnessStopFailedReason: "stop failed",
      activitySnapshot: {
        lastHarnessActivityAt: expect.any(String),
      },
    });
    await orchestrator.stop();
  });

  it("treats stalled cancellation as terminal cancelled without retrying", async () => {
    const config = testConfig(root);
    (config.raw as { codex?: { stall_timeout_ms?: number } }).codex = { stall_timeout_ms: 1 };
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
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new StalledAbortHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-stalled", "stalled run to start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await orchestrator.refreshNow();
    await waitFor(
      () => orchestrator.snapshot().running[0]?.cancellation.source === "stalled",
      "stalled cancellation to be recorded",
    );
    const stalled = orchestrator.snapshot().running[0];
    expect(stalled).toMatchObject({
      liveness: { status: "cancelling" },
      cancellation: {
        requested: true,
        source: "stalled",
        reason: "run stalled",
        abortSignalled: true,
        suppressRetryOnExit: true,
      },
    });

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "stalled run to exit");

    await expect(runStore.getRun("run-stalled")).resolves.toMatchObject({
      status: "cancelled",
      error: "stalled abort",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
    await orchestrator.stop();
  });

  it("does not record harness stop metadata before a run id is known for operator cancellation", async () => {
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
    const harness = new PreSessionCancellationHarness();
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
    await harness.started;
    await orchestrator.cancelIssue(candidate.id);

    const cancelling = orchestrator.snapshot().running[0];
    expect(cancelling).toMatchObject({
      runId: null,
      liveness: { status: "cancelling", activeRunId: null },
      cancellation: {
        requested: true,
        source: "operator",
        reason: "operator request",
        abortSignalled: true,
        harnessStopRequestedAt: null,
        suppressRetryOnExit: true,
      },
    });
    expect(harness.stoppedRunIds).toEqual([]);

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "pre-session cancelled run to exit");
    await orchestrator.stop();
  });

  it("does not call harness stop with an issue id during pre-session orchestrator shutdown", async () => {
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
    const harness = new PreSessionCancellationHarness();
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
    await harness.started;
    const stopPromise = orchestrator.stop();
    await waitFor(
      () => orchestrator.snapshot().running[0]?.cancellation.source === "service_stop",
      "service stop cancellation to be recorded",
    );

    const stopping = orchestrator.snapshot().running[0];
    expect(stopping).toMatchObject({
      runId: null,
      cancellation: {
        requested: true,
        source: "service_stop",
        reason: "orchestrator stop",
        abortSignalled: true,
        harnessStopRequestedAt: null,
      },
    });
    expect(harness.stoppedRunIds).toEqual([]);

    harness.release();
    await stopPromise;
  });

  it("treats service stop aborts as terminal cancelled without retrying", async () => {
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
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new ServiceStopAbortHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-service-stop", "service-stop run to start");
    const stopPromise = orchestrator.stop();
    await waitFor(
      () => orchestrator.snapshot().running[0]?.cancellation.source === "service_stop",
      "service stop cancellation to be recorded",
    );
    expect(orchestrator.snapshot().running[0]).toMatchObject({
      liveness: { status: "cancelling", activeRunId: "run-service-stop" },
      cancellation: {
        requested: true,
        source: "service_stop",
        reason: "orchestrator stop",
        abortSignalled: true,
        suppressRetryOnExit: true,
      },
    });
    expect(harness.stoppedRunIds).toEqual(["run-service-stop"]);

    harness.release();
    await stopPromise;

    await expect(runStore.getRun("run-service-stop")).resolves.toMatchObject({
      status: "cancelled",
      error: "service stop abort",
    });
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

  it("accounts tokens per fresh active run across continuation turns", async () => {
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
    const harness = new TokenSequenceHarness([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ]);
    const runStore = new FileRunTranscriptStore(root);
    const lifecycleStore = new FileIssueLifecycleStore(root);
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
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2);
    await orchestrator.stop();

    const runs = await runStore.listRunsForIssue(candidate.id);
    expect(runs.map((run) => ({ runId: run.runId, tokens: run.tokens }))).toEqual([
      { runId: "token-run-1", tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      { runId: "token-run-2", tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]);
    expect(orchestrator.snapshot().totals).toMatchObject({
      inputTokens: 110,
      outputTokens: 55,
      totalTokens: 165,
    });
  });

  it("includes compact handoff for prior-run-only follow-up prompts", async () => {
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
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate);
    await runStore.startRun({
      runId: "prior-run-only",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "SECRET_FULL_PROMPT_BODY",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
    });
    await runStore.appendEvent({
      runId: "prior-run-only",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "Prior run exists without a lifecycle handoff.",
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
      runStore,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await orchestrator.stop();

    const prompt = harness.runs[0]?.prompt ?? "";
    expect(prompt).toContain("Compact Symphony handoff packet:");
    expect(prompt).toContain("/api/v1/runs/prior-run-only/transcript");
    expect(prompt).not.toContain("SECRET_FULL_PROMPT_BODY");
  });

  it("uses pointers instead of raw run history in continuation prompts below the event threshold", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.reviewLoop.continuationHistoryThreshold = 5;
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
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new FakeHarness();
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
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain("Structured continuation brief:");
    expect(harness.runs[1]?.prompt).toContain("Mode: summary");
    expect(harness.runs[1]?.prompt).toContain("Transcript/status pointers:");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/fake-issue-1-1/transcript");
    expect(harness.runs[1]?.prompt).not.toContain("completed: fake completed");
    expect(harness.runs[1]?.prompt).not.toContain("Continue working on the issue. Check current issue state");
  });

  it("uses stored summaries and API pointers in continuation prompts above the event threshold", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.reviewLoop.continuationHistoryThreshold = 1;
    config.reviewLoop.transcriptHistoryLimit = 1;
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
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await runStore.startRun({
      runId: "prior-run-1",
      sessionId: "prior-session-1",
      agentId: "prior-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Prior worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: "prior-run-1",
      at: "2026-01-01T00:00:01Z",
      source: "harness",
      eventType: "progress",
      message: "Prior run gathered context.",
    });
    await runStore.appendEvent({
      runId: "prior-run-1",
      at: "2026-01-01T00:00:02Z",
      source: "harness",
      eventType: "completed",
      message: "Prior run stopped before handoff.",
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
      runStore,
      lifecycleStore,
    });
    const createdSummary = await orchestrator.createContinuationSummary(candidate);
    const storedLifecycle = await lifecycleStore.get(candidate.identifier);

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(createdSummary.summaryReference.id).toContain("continuation-summary:issue-1:");
    expect(createdSummary.summaryReference.runIds).toEqual(["prior-run-1"]);
    expect(createdSummary.summaryReference.transcriptEventCount).toBe(2);
    expect(createdSummary.summaryReference.transcriptPointers).toEqual(["/api/v1/runs/prior-run-1/transcript"]);
    expect(createdSummary.summaryReference.statusApiPointers).toEqual([
      "/api/v1/issues/TEST-1",
      "/api/v1/issues/TEST-1/runs",
      "/api/v1/runs/prior-run-1",
    ]);
    expect(storedLifecycle?.summaryReferences).toEqual([createdSummary.summaryReference]);
    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain("Mode: summary");
    expect(harness.runs[1]?.prompt).toContain(`Reference: ${createdSummary.summaryReference.id}`);
    expect(harness.runs[1]?.prompt).toContain("Continuation history summarization is not automated yet.");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/prior-run-1/transcript");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/issues/TEST-1");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/prior-run-1");
    expect(harness.runs[1]?.prompt).not.toContain("Full relevant history:");
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

async function startApprovalRun(
  runStore: FileRunTranscriptStore,
  candidate: Issue,
  runId: string,
  root: string,
): Promise<void> {
  await runStore.startRun({
    runId,
    sessionId: `${runId}-session`,
    agentId: `${runId}-agent`,
    role: "worker",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    attempt: null,
    turnNumber: 1,
    prompt: "Worker submitted a completion report.",
    workspaceKey: candidate.identifier,
    workspacePath: path.join(root, "workspace"),
    gitBranchName: candidate.branchName ?? "symphony/TEST-1",
    repoPath: root,
    baseRef: "main",
  });
}

function pendingApprovalLifecyclePatch(
  candidate: Issue,
  root: string,
  runId: string,
  blockedReason = PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
): IssueLifecyclePatch {
  return {
    phase: "blocked",
    blockedReason,
    lastCompletionReportId: `completion-report:${candidate.id}:idem-1`,
    completionReports: [
      {
        ...completionReportRecord(candidate),
        runId,
        branchName: candidate.branchName,
        pullRequest: null,
      },
    ],
    summaryPointers: {
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, "workspace"),
      branchName: candidate.branchName,
      gitBranchName: candidate.branchName,
      repoPath: root,
      baseRef: "main",
      lastRunId: runId,
    },
  };
}

function approvalRecordFor(
  status: OperatorApprovalRecord["status"],
  candidate: Issue,
  runId: string,
  root: string,
  staleReason: string | null = null,
): OperatorApprovalRecord {
  return {
    requestId: `approval-${status}`,
    status,
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    runId,
    evidenceCursor: "idem-1",
    dedupeKey: `${runId}:idem-1:push_and_pr`,
    action: {
      kind: "push_and_pr",
      branchName: candidate.branchName ?? "symphony/TEST-1",
      baseBranch: "main",
      workspacePath: path.join(root, "workspace"),
      title: `${candidate.identifier}: ${candidate.title}`,
      evidenceCursor: "idem-1",
      summaryPreview: "Implemented the requested handoff.",
      changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
      plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
    },
    requestedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: status === "expired" ? "2026-01-01T00:00:01.000Z" : null,
    resolvedAt: status === "pending" ? null : "2026-01-01T00:00:02.000Z",
    resolvedBy: status === "approved" || status === "rejected" ? "operator" : status === "pending" ? null : "system",
    decision: status === "approved" ? "approve" : status === "rejected" ? "reject" : null,
    staleReason,
  };
}

function githubProfileConfig(
  workspaceRoot: string,
  input: {
    profiles: Record<string, { value: string; capabilities: string[] }>;
    roles: { worker?: Record<string, string>; reviewer?: Record<string, string> };
    env: Record<string, string>;
  },
) {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
      },
      workspace: {
        root: workspaceRoot,
      },
      polling: {
        interval_ms: 60_000,
      },
      agent: {
        max_concurrent_agents: 2,
        max_turns: 1,
      },
      github: {
        owner: "acme",
        repo: "symphony",
        token: "legacy-github-token",
        api_base_url: "https://api.github.test",
      },
      credential_profiles: {
        profiles: input.profiles,
        roles: input.roles,
      },
    },
    path.join(workspaceRoot, "WORKFLOW.md"),
    {
      LINEAR_API_KEY: "linear-test-key",
      ...input.env,
    },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean, description = "condition", timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
}

async function waitForPendingApproval(store: FileOperatorApprovalStore, runId: string, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pending = await store.findPendingForRun(runId);
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for pending approval on ${runId}`);
}

async function waitForRunRecord(store: FileRunTranscriptStore, runId: string, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const run = await store.getRun(runId);
      if (run) return run;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run record ${runId}`);
}

async function waitForTerminalRunRecord(store: FileRunTranscriptStore, runId: string, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const run = await store.getRun(runId);
      if (run && run.status !== "running") return run;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for terminal run record ${runId}`);
}

async function settleOrchestratorExit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
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

class HeldCancellationHarness implements AgentHarness {
  readonly id = "held-cancellation";
  readonly stoppedRunIds: string[] = [];
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-123", runId: "run-123" };
    await this.released;
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }

  release(): void {
    this.releaseRun();
  }
}

class FailingStopHarness implements AgentHarness {
  readonly id = "failing-stop";
  readonly stoppedRunIds: string[] = [];
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-failing-stop", runId: "run-failing-stop" };
    yield { type: "progress", message: "working", activitySource: "stream" };
    await this.released;
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
    throw new Error("stop failed");
  }

  release(): void {
    this.releaseRun();
  }
}

class StalledAbortHarness implements AgentHarness {
  readonly id = "stalled-abort";
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-stalled", runId: "run-stalled" };
    if (!ctx.abortSignal.aborted) {
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
    await this.released;
    throw new Error("stalled abort");
  }

  release(): void {
    this.releaseRun();
  }
}

class PreSessionCancellationHarness implements AgentHarness {
  readonly id = "pre-session-cancellation";
  readonly stoppedRunIds: string[] = [];
  private resolveStarted: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    this.resolveStarted();
    await this.released;
    yield { type: "session_started", sessionId: "session-pre", runId: "run-pre" };
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }

  release(): void {
    this.releaseRun();
  }
}

class ServiceStopAbortHarness implements AgentHarness {
  readonly id = "service-stop-abort";
  readonly stoppedRunIds: string[] = [];
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-service-stop", runId: "run-service-stop" };
    if (!ctx.abortSignal.aborted) {
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
    await this.released;
    throw new Error("service stop abort");
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }

  release(): void {
    this.releaseRun();
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

class TokenSequenceHarness implements AgentHarness {
  readonly id = "token-sequence";
  readonly runs: string[] = [];

  constructor(private readonly tokenEvents: TokenCounts[]) {}

  async *run(_ctx: AgentRunContext, _prompt: string): AsyncIterable<AgentEvent> {
    const runNumber = this.runs.length + 1;
    const runId = `token-run-${runNumber}`;
    this.runs.push(runId);
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    const tokens = this.tokenEvents[runNumber - 1];
    if (tokens) yield { type: "tokens", tokens };
    yield { type: "completed" };
  }
}

type ReportingHarnessTerminal = AgentEvent | "throw";

class ReportingHarness implements AgentHarness {
  readonly id = "reporting";
  readonly prompts: string[] = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
    private readonly publisher: CompletionReportPullRequestPublisher,
    private readonly terminalEvent: ReportingHarnessTerminal = { type: "completed" },
    private readonly operatorApproval?: OperatorApprovalService,
    private readonly writebackProcessor?: Pick<WritebackProcessor, "processDue">,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "report-session-1", runId: "report-run-1" };
    try {
      await new CompletionReportService({
        config: ctx.config,
        lifecycleStore: this.lifecycleStore,
        writebackOutbox: this.outboxStore,
        ...(this.writebackProcessor ? { writebackProcessor: this.writebackProcessor } : {}),
        runStore: this.runStore,
        pullRequestPublisher: this.publisher,
        ...(this.operatorApproval ? { operatorApproval: this.operatorApproval } : {}),
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
    } catch (error) {
      if (this.terminalEvent !== "throw") {
        yield this.terminalEvent;
        return;
      }
      yield { type: "failed", error: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (this.terminalEvent === "throw") {
      throw new Error("post-handoff harness throw");
    }
    yield this.terminalEvent;
  }
}

class ManufacturedReviewLoopHarness implements AgentHarness {
  readonly id = "manufactured-review-loop";
  readonly runs: Array<{ role: string; runId: string; prompt: string }> = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const roleRunNumber = this.runs.filter((run) => run.role === ctx.role).length + 1;
    const runId = ctx.role === "reviewer" ? `smoke-review-run-${roleRunNumber}` : `smoke-worker-run-${roleRunNumber}`;
    this.runs.push({ role: ctx.role, runId, prompt });
    yield { type: "session_started", sessionId: `${runId}-session`, runId };

    if (ctx.role === "reviewer") {
      await this.submitReviewVerdict(ctx, runId, roleRunNumber);
    } else {
      await this.submitCompletionReport(ctx, runId, roleRunNumber);
    }

    yield { type: "progress", message: `${ctx.role} submitted manufactured review-loop evidence.` };
    yield { type: "completed" };
  }

  private async submitCompletionReport(ctx: AgentRunContext, runId: string, runNumber: number): Promise<void> {
    await new CompletionReportService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
      runStore: this.runStore,
    }).submitCompletionReport(
      {
        runId,
        issueId: ctx.issue.id,
        summary:
          runNumber === 1
            ? "Submitted the manufactured smoke implementation."
            : "Addressed the manufactured smoke revision.",
        validationEvidence: ["npm test -- tests/orchestrator.test.ts"],
        acceptanceChecklist: [
          {
            text: "Manufactured fail/revise/pass smoke is covered.",
            satisfied: runNumber === 2,
            evidence: runNumber === 1 ? "Initial manufactured implementation." : "Revision worker handled reviewer feedback.",
          },
        ],
        changedFiles: ["tests/orchestrator.test.ts"],
        branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
        pullRequest: null,
        risks: [],
        idempotencyKey: `smoke-report-${runNumber}`,
      },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "worker",
        sessionId: `${runId}-session`,
        workspacePath: ctx.workspace.path,
        workspace: ctx.workspace,
        phase: "implementation",
      },
    );
  }

  private async submitReviewVerdict(ctx: AgentRunContext, runId: string, runNumber: number): Promise<void> {
    await new ReviewVerdictService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
      runStore: this.runStore,
    }).submitReviewVerdict(
      runNumber === 1
        ? {
            runId,
            issueId: ctx.issue.id,
            verdict: "fail",
            acceptanceResults: [
              {
                text: "Revision worker handles the manufactured reviewer feedback.",
                satisfied: false,
                evidence: "First worker intentionally leaves the manufactured revision outstanding.",
              },
            ],
            findings: ["Add the manufactured smoke revision."],
            evidence: ["manufactured-review-loop-smoke"],
            idempotencyKey: "smoke-verdict-fail",
          }
        : {
            runId,
            issueId: ctx.issue.id,
            verdict: "pass",
            acceptanceResults: [
              {
                text: "Revision worker handles the manufactured reviewer feedback.",
                satisfied: true,
                evidence: "Second worker prompt included and addressed the manufactured revision.",
              },
            ],
            findings: [],
            evidence: ["manufactured-review-loop-smoke"],
            idempotencyKey: "smoke-verdict-pass",
          },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "reviewer",
        reviewer: "reviewer-agent",
        phase: "review",
      },
    );
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

class FailingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  async transitionIssueState(_input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    throw new Error("linear transition failed");
  }

  async createIssueComment(_input: TrackerCommentInput): Promise<TrackerWriteResult> {
    throw new Error("linear comment failed");
  }
}

class PublicationApprovalCommentFailingWriter extends StateChangingWriter {
  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    if (input.dedupeKey?.includes("publication-approval-pending")) {
      throw new Error("linear pending approval comment failed");
    }
    return super.createIssueComment(input);
  }
}

class PublicationApprovalTransitionFailingWriter extends StateChangingWriter {
  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    if (
      input.toState === "Blocked" &&
      (input.reason?.includes("operator approval for PR publication") ||
        input.reason?.includes("publication approval setup incomplete"))
    ) {
      throw new Error("linear pending approval transition failed");
    }
    return super.transitionIssueState(input);
  }
}
