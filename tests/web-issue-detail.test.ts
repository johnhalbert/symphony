import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import {
  projectWebIssueDetail,
  type BoardIssueDetailProjectionInput,
  type IssueBoardCardProjectionInput,
} from "../src/app/webProjection.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { Issue, IssueDetailsEnvelope, TrackerStateLists } from "../src/core/types.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { issue as trackerIssue, testConfig } from "./helpers.js";

function issueDetails(overrides: Partial<IssueDetailsEnvelope> = {}): IssueDetailsEnvelope {
  return {
    source: "tracker",
    completeness: "full",
    issue: {
      id: "issue-1",
      identifier: "TEST-1",
      title: "Implement web route",
      description: "Real description from the tracker.",
      priority: 2,
      state: "In Progress",
      branchName: "symphony/TEST-1",
      url: "https://linear.test/TEST-1",
      assigneeId: "user-1",
      labels: ["web"],
      blockedBy: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    },
    tracker: {
      generatedAt: "2026-01-01T00:06:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
      ageMs: 60_000,
      stale: false,
      staleThresholdMs: 300_000,
      state: "In Progress",
      classification: "active",
    },
    blockers: {
      available: true,
      totalCount: 0,
      openCount: 0,
      open: [],
      blocked: false,
      humanBlockedReason: null,
    },
    workspace: {
      workspaceKey: "TEST-1",
      path: "/tmp/workspaces/TEST-1",
      sourceKind: "git_worktree",
      branchName: "symphony/TEST-1",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    pullRequest: {
      url: "https://github.com/acme/repo/pull/12",
      number: 12,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
      ciStatus: "success",
      lastPushedAt: "2026-01-01T00:04:00.000Z",
    },
    latestRun: {
      runId: "run-1",
      runPhase: "implementation",
      runKind: "implementation",
      status: "running",
      terminalReason: null,
      error: null,
      completedAt: null,
    },
    ...overrides,
  };
}

function card(overrides: Partial<IssueBoardCardProjectionInput> = {}): IssueBoardCardProjectionInput {
  return {
    key: "TEST-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    origin: "tracker",
    lane: "progress",
    issueDetails: issueDetails(),
    paused: false,
    live: {
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      state: "running",
      runId: "run-1",
      agentId: "agent-1",
      sessionId: "session-1",
    },
    operatorLiveness: {
      agentId: "agent-1",
      sessionId: "session-1",
      workspacePath: "/tmp/workspaces/TEST-1",
      runId: "run-1",
      activeRunId: "run-1",
      status: "active",
    },
    metadata: {
      prUrl: "https://github.com/acme/repo/pull/12",
      prNumber: 12,
      ciStatus: "success",
      branchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    ...overrides,
  };
}

function durableDetail(overrides: Partial<IssueDetailsEnvelope> = {}): BoardIssueDetailProjectionInput {
  return {
    issue: "REQ-2",
    boardCard: null,
    issueDetails: issueDetails({
      source: "durable",
      completeness: "partial",
      issue: {
        id: "durable-id",
        identifier: null,
        title: null,
        description: null,
        priority: null,
        state: null,
        branchName: null,
        url: null,
        assigneeId: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      tracker: {
        generatedAt: null,
        updatedAt: null,
        ageMs: null,
        stale: null,
        staleThresholdMs: 300_000,
        state: null,
        classification: null,
      },
      blockers: {
        available: false,
        totalCount: 0,
        openCount: 0,
        open: [],
        blocked: false,
        humanBlockedReason: null,
      },
      workspace: {
        workspaceKey: null,
        path: null,
        sourceKind: null,
        branchName: null,
        gitBranchName: null,
        repoPath: null,
        baseRef: null,
      },
      pullRequest: {
        url: null,
        number: null,
        headSha: null,
        branch: null,
        ciStatus: null,
        lastPushedAt: null,
      },
      latestRun: {
        runId: null,
        runPhase: null,
        runKind: null,
        status: null,
        terminalReason: null,
        error: null,
        completedAt: null,
      },
      ...overrides,
    }),
  };
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["In Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  };
}

function fakeOrchestrator(): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:10:00.000Z",
        counts: { running: 0, retrying: 0, paused: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    getIssueDetails() {
      return null;
    },
  } as unknown as Orchestrator;
}

class FakeTracker implements TrackerClient {
  fetchCount = 0;

  constructor(private readonly issues: Issue[]) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return [];
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    this.fetchCount += 1;
    return this.issues.filter((item) => stateNames.some((state) => state.toLowerCase() === item.state.toLowerCase()));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return this.issues.filter((item) => issueIds.includes(item.id));
  }
}

describe("web issue detail projection", () => {
  it("projects a found board-backed issue detail into the complete web issue-detail shape", () => {
    const detail = projectWebIssueDetail(
      {
        issue: "TEST-1",
        boardCard: card(),
        issueDetails: issueDetails(),
        operatorLiveness: {
          agentId: "agent-1",
          sessionId: "session-1",
          workspacePath: "/tmp/workspaces/TEST-1",
          runId: "run-1",
          activeRunId: "run-1",
          status: "active",
        },
      },
      "TEST-1",
    );

    expect(detail).toEqual({
      issue: {
        id: "TEST-1",
        title: "Implement web route",
        status: "progress",
        priority: 2,
        labels: ["web"],
        assignee: "user-1",
        agent: "agent-1",
        project: "",
        cycle: "",
        activity: [],
        pr: "#12",
        ci: "success",
        workspace: "/tmp/workspaces/TEST-1",
        session: "session-1",
        desc: ["Real description from the tracker."],
      },
    });
    expect(Object.keys(detail ?? {})).toEqual(["issue"]);
    expect(JSON.stringify(detail).toLowerCase()).not.toContain("mock");
  });

  it("projects durable-only issue details without a board card or invented mock data", () => {
    const detail = projectWebIssueDetail(durableDetail(), "REQ-2");
    const requestFallback = projectWebIssueDetail(
      durableDetail({
        issue: { ...durableDetail().issueDetails.issue, id: null, identifier: null },
      }),
      "REQ-3",
    );

    expect(detail).toEqual({
      issue: {
        id: "durable-id",
        title: "durable-id",
        status: "backlog",
        priority: 0,
        labels: [],
        assignee: "unassigned",
        agent: null,
        project: "",
        cycle: "",
        activity: [],
        pr: null,
        ci: null,
        workspace: null,
        session: null,
      },
    });
    expect(detail?.issue).not.toHaveProperty("desc");
    expect(requestFallback?.issue).toMatchObject({ id: "REQ-3", title: "REQ-3" });
    expect(JSON.stringify(detail).toLowerCase()).not.toContain("mock");
  });
});

describe("GET /api/v1/web/issues/:issueId", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-issue-detail-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns a board-backed web issue detail through the HTTP route", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const tracker = new FakeTracker([
      trackerIssue({
        id: "issue-1",
        identifier: "TEST-1",
        title: "Tracker detail title",
        description: "Tracker detail description.",
        priority: 3,
        state: "In Progress",
        labels: ["web", "api"],
        assigneeId: "user-2",
      }),
    ]);
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      tracker,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/web/issues/TEST-1`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        issue: {
          id: "TEST-1",
          title: "Tracker detail title",
          status: "progress",
          priority: 3,
          labels: ["web", "api"],
          assignee: "user-2",
          agent: null,
          project: "",
          cycle: "",
          activity: [],
          pr: null,
          ci: null,
          workspace: null,
          session: null,
          desc: ["Tracker detail description."],
        },
      });
      expect(JSON.stringify(body).toLowerCase()).not.toContain("mock");
      expect(tracker.fetchCount).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("returns a durable-only web issue detail through the HTTP route when tracker data is unavailable", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await runStore.upsertWorkspace({
      workspaceKey: "TEST-DURABLE",
      issueId: "issue-durable",
      issueIdentifier: "TEST-DURABLE",
      path: path.join(config.workspace.root, "TEST-DURABLE"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-DURABLE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-durable",
      sessionId: "session-durable",
      agentId: "agent-durable",
      role: "worker",
      issueId: "issue-durable",
      issueIdentifier: "TEST-DURABLE",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-DURABLE",
      workspacePath: path.join(config.workspace.root, "TEST-DURABLE"),
      gitBranchName: "symphony/TEST-DURABLE",
      repoPath: "/repo",
      baseRef: "main",
    });
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/web/issues/TEST-DURABLE`);
      const body = (await response.json()) as { issue: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        issue: {
          id: "TEST-DURABLE",
          title: "TEST-DURABLE",
          status: "backlog",
          priority: 0,
          labels: [],
          assignee: "unassigned",
          agent: "agent-durable",
          project: "",
          cycle: "",
          activity: [],
          pr: null,
          ci: null,
          workspace: path.join(config.workspace.root, "TEST-DURABLE"),
          session: "session-durable",
        },
      });
      expect(body.issue).not.toHaveProperty("desc");
      expect(JSON.stringify(body).toLowerCase()).not.toContain("mock");
    } finally {
      await server.stop();
    }
  });

  it("returns HTTP 200 with exact JSON null for a missing issue detail", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/web/issues/UNKNOWN-1`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
