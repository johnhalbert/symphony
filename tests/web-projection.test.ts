import { describe, expect, it } from "vitest";
import type { IssueDetailsEnvelope } from "../src/core/types.js";
import type { RunRecord, TranscriptEvent, TranscriptPage } from "../src/core/persistence/RunTranscriptStore.js";
import {
  clampIssuePriority,
  deriveIssueStatus,
  emptyDashboardModel,
  normalizeDescription,
  projectActivityModels,
  projectDashboardModel,
  projectHistoryModel,
  projectIssueBoardModel,
  projectIssueDetailModel,
  projectWebIssueBoard,
  projectTranscriptMessages,
  type ActivityFeedResponseProjectionInput,
  type IssueBoardCardProjectionInput,
  type IssueBoardResponseProjectionInput,
} from "../src/app/webProjection.js";

function issueDetails(overrides: Partial<IssueDetailsEnvelope> = {}): IssueDetailsEnvelope {
  return {
    source: "tracker",
    completeness: "full",
    issue: {
      id: "issue-1",
      identifier: "TEST-1",
      title: "Add shared projection",
      description: "First paragraph.\n\nSecond paragraph with extra whitespace.",
      priority: 3,
      state: "In Progress",
      branchName: "symphony/TEST-1",
      url: "https://linear.test/TEST-1",
      assigneeId: "agent",
      delegateId: null,
      labels: ["orchestrator", "observability"],
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
      url: "https://github.com/acme/repo/pull/7",
      number: 7,
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
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      ciStatus: "success",
      branchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    ...overrides,
  };
}

function webCard(
  identifier: string,
  overrides: { lane: IssueBoardCardProjectionInput["lane"]; state: string; priority?: number | null; title?: string } & Partial<
    Pick<IssueBoardCardProjectionInput, "issueId" | "key" | "live" | "operatorLiveness">
  >,
): IssueBoardCardProjectionInput {
  const issueId = overrides.issueId ?? "issue-" + identifier.toLowerCase();
  return card({
    key: overrides.key ?? identifier,
    issueId,
    issueIdentifier: identifier,
    lane: overrides.lane,
    issueDetails: issueDetails({
      issue: {
        ...issueDetails().issue,
        id: issueId,
        identifier,
        title: overrides.title ?? identifier + " title",
        state: overrides.state,
        priority: overrides.priority ?? null,
        labels: [],
      },
    }),
    live: overrides.live ?? null,
    operatorLiveness: overrides.operatorLiveness ?? null,
  });
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "work",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspaces/TEST-1",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    completedAt: "2026-01-01T00:10:00.000Z",
    error: null,
    tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    transcriptEventCount: 2,
    cursorModel: "gpt-test",
    ...overrides,
  };
}

describe("web projection foundation", () => {
  it("projects issue board cards into stable design-system issue models", () => {
    const boardInput: IssueBoardResponseProjectionInput = {
      generatedAt: "2026-01-01T00:06:00.000Z",
      columns: [
        { id: "progress", title: "In Progress", issues: [card()] },
        {
          id: "canceled",
          title: "Canceled",
          issues: [
            card({
              key: "TEST-2",
              issueId: "issue-2",
              issueIdentifier: "TEST-2",
              lane: "canceled",
              issueDetails: issueDetails({
                issue: {
                  ...issueDetails().issue,
                  id: "issue-2",
                  identifier: "TEST-2",
                  title: "Cancelled issue",
                  priority: null,
                  state: "Cancelled",
                  labels: [],
                },
                pullRequest: { url: "https://github.com/acme/repo/pull/8", number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
              }),
              live: null,
              operatorLiveness: null,
            }),
          ],
        },
      ],
    };

    const board = projectIssueBoardModel(boardInput);

    expect(board.generatedAt).toBe("2026-01-01T00:06:00.000Z");
    expect(board.counts).toMatchObject({ total: 2, progress: 1, cancelled: 1, live: 1 });
    expect(board.columns.find((column) => column.id === "progress")?.count).toBe(1);
    expect(board.columns.find((column) => column.id === "cancelled")?.issues[0]).toMatchObject({
      id: "TEST-2",
      title: "Cancelled issue",
      status: "cancelled",
      priority: 0,
      pr: "https://github.com/acme/repo/pull/8",
      agent: null,
    });
    expect(board.issues[0]).toMatchObject({
      id: "TEST-1",
      title: "Add shared projection",
      status: "progress",
      priority: 3,
      labels: ["orchestrator", "observability"],
      assignee: "agent",
      agent: "agent-1",
      pr: "#7",
      ci: "success",
      workspace: "/tmp/workspaces/TEST-1",
      session: "session-1",
      desc: ["First paragraph.", "Second paragraph with extra whitespace."],
    });
  });

  it("projects the React issue-board shape from backend board cards", () => {
    const board = projectWebIssueBoard({
      generatedAt: "2026-01-01T00:06:00.000Z",
      issues: [
        webCard("TEST-TODO", { lane: "todo", state: "Todo", priority: 1 }),
        webCard("TEST-PROGRESS", { lane: "progress", state: "In Progress", priority: 2 }),
        webCard("TEST-REVIEW", { lane: "review", state: "In Review", priority: 3 }),
        webCard("TEST-DONE", { lane: "done", state: "Done", priority: 0 }),
      ],
    });

    expect(board).toMatchObject({
      cycleLabel: "",
      cycleDateRange: "",
      selectedIssueId: "TEST-PROGRESS",
    });
    expect(board.issues.map((issue) => issue.id)).toEqual(["TEST-TODO", "TEST-PROGRESS", "TEST-REVIEW", "TEST-DONE"]);
    expect(board.backlog.map((issue) => issue.id)).toEqual(["TEST-TODO"]);
    expect(board.lanes.todo.map((issue) => issue.id)).toEqual(["TEST-TODO"]);
    expect(board.lanes.progress.map((issue) => issue.id)).toEqual(["TEST-PROGRESS"]);
    expect(board.lanes.review.map((issue) => issue.id)).toEqual(["TEST-REVIEW"]);
  });

  it("normalizes canceled backend board cards to cancelled for the React issue board", () => {
    const board = projectWebIssueBoard({
      issues: [webCard("TEST-CANCELED", { lane: "canceled", state: "Canceled", title: "Canceled issue" })],
    });

    expect(board.issues[0]).toMatchObject({ id: "TEST-CANCELED", title: "Canceled issue", status: "cancelled" });
    expect(board.lanes).toEqual({ todo: [], progress: [], review: [] });
    expect(board.selectedIssueId).toBe("TEST-CANCELED");
  });

  it("sorts React issue-board backlog by priority weight while preserving equal-priority order", () => {
    const board = projectWebIssueBoard({
      issues: [
        webCard("TEST-LOW", { lane: "backlog", state: "Backlog", priority: 1 }),
        webCard("TEST-HIGH-A", { lane: "backlog", state: "Backlog", priority: 3 }),
        webCard("TEST-HIGH-B", { lane: "todo", state: "Todo", priority: 3 }),
        webCard("TEST-MED", { lane: "todo", state: "Todo", priority: 2 }),
      ],
    });

    expect(board.issues.map((issue) => issue.id)).toEqual(["TEST-LOW", "TEST-HIGH-A", "TEST-HIGH-B", "TEST-MED"]);
    expect(board.backlog.map((issue) => issue.id)).toEqual(["TEST-HIGH-A", "TEST-HIGH-B", "TEST-MED", "TEST-LOW"]);
  });

  it("returns an empty React issue-board model when board data is unavailable", () => {
    expect(projectWebIssueBoard(null)).toEqual({
      issues: [],
      backlog: [],
      lanes: { todo: [], progress: [], review: [] },
      cycleLabel: "",
      cycleDateRange: "",
      selectedIssueId: "",
    });
  });

  it("selects the React issue-board issue by progress, todo, backlog, all-issue, then empty fallback order", () => {
    expect(
      projectWebIssueBoard({
        issues: [
          webCard("TEST-TODO", { lane: "todo", state: "Todo" }),
          webCard("TEST-PROGRESS", { lane: "progress", state: "In Progress" }),
        ],
      }).selectedIssueId,
    ).toBe("TEST-PROGRESS");
    expect(projectWebIssueBoard({ issues: [webCard("TEST-TODO", { lane: "todo", state: "Todo" })] }).selectedIssueId).toBe(
      "TEST-TODO",
    );
    expect(
      projectWebIssueBoard({ issues: [webCard("TEST-BACKLOG", { lane: "backlog", state: "Backlog" })] }).selectedIssueId,
    ).toBe("TEST-BACKLOG");
    expect(projectWebIssueBoard({ issues: [webCard("TEST-DONE", { lane: "done", state: "Done" })] }).selectedIssueId).toBe(
      "TEST-DONE",
    );
    expect(projectWebIssueBoard(null).selectedIssueId).toBe("");
  });

  it("normalizes status, priority, and description boundary cases", () => {
    expect(deriveIssueStatus({ lane: "review", state: "Todo", classification: "active" })).toBe("review");
    expect(deriveIssueStatus({ lane: null, state: "Ready to Merge", classification: "active" })).toBe("review");
    expect(deriveIssueStatus({ lane: null, state: null, classification: "terminal" })).toBe("done");
    expect(deriveIssueStatus({ lane: null, state: null, classification: null })).toBe("backlog");
    expect(clampIssuePriority("urgent")).toBe("urgent");
    expect(clampIssuePriority(null)).toBe(0);
    expect(clampIssuePriority(10)).toBe(3);
    expect(normalizeDescription(" one  two \n\n three ")).toEqual(["one two", "three"]);
  });

  it("projects dashboard, detail, history, activity, and transcript models without runtime side effects", () => {
    const activityInput: ActivityFeedResponseProjectionInput = {
      generatedAt: "2026-01-01T00:11:00.000Z",
      activity: [
        {
          id: "run:run-1:run_started",
          at: "2026-01-01T00:00:00.000Z",
          kind: "run_started",
          source: "run",
          issue: { id: "issue-1", identifier: "TEST-1" },
          run: { runId: "run-1", role: "worker", runPhase: "implementation", runKind: "implementation", status: "running", agentId: "agent-1", sessionId: "session-1" },
          transcript: null,
          writeback: null,
        },
        {
          id: "transcript:run-1:1",
          at: "2026-01-01T00:01:00.000Z",
          kind: "transcript_event",
          source: "cursor",
          issue: { id: "issue-1", identifier: "TEST-1" },
          run: { runId: "run-1", role: "worker", runPhase: "implementation", runKind: "implementation", status: "running", agentId: "agent-1", sessionId: "session-1" },
          transcript: { sequence: 1, eventType: "tool_call", message: "read_file" },
          writeback: null,
        },
      ],
    };
    const transcriptEvents: TranscriptEvent[] = [
      { runId: "run-1", sequence: 1, at: "2026-01-01T00:01:00.000Z", source: "cursor", eventType: "tool_call", message: "read_file" },
      { runId: "run-1", sequence: 2, at: "2026-01-01T00:02:00.000Z", source: "orchestrator", eventType: "approval_request", message: "Approve publication?" },
    ];
    const transcriptPage: TranscriptPage = { runId: "run-1", offset: 0, limit: 10, nextOffset: null, events: transcriptEvents };

    const runtime = {
      generatedAt: "2026-01-01T00:11:00.000Z",
      counts: { running: 0, retrying: 0, paused: 0, providerGates: 1 },
      providerGates: [
        {
          id: "provider-gate:openai-codex:test",
          scope: { harnessId: "hermes", providerId: "openai-codex", model: "gpt-5-test" },
          kind: "windowed_bucket_exhausted",
          window: { resumeAt: "2026-01-01T05:00:00.000Z", windowLabel: "Session", windowKind: "codex_5h" },
          resumePolicy: "auto_at_window_close",
          message: "Codex session allotment exhausted",
          observedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          affectedRoles: ["worker", "reviewer"],
          affectedRunPhases: ["implementation", "review"],
          source: { issueIdentifier: "TEST-1", runId: "run-1" },
        },
      ],
      providerGateCounts: { active: 1, manual: 0, autoResume: 1 },
      running: [],
      retrying: [],
      paused: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      rateLimits: null,
    } as any;
    const dashboard = projectDashboardModel({ board: { issues: [card()] }, activity: activityInput, runs: [run()], runtime });
    const detail = projectIssueDetailModel({ issue: "TEST-1", boardCard: card(), issueDetails: issueDetails(), latestRun: run(), runs: [run()], operatorLiveness: { agentId: "agent-1", sessionId: "session-1", workspacePath: "/tmp/workspaces/TEST-1", runId: "run-1", activeRunId: "run-1", status: "active" } });
    const history = projectHistoryModel({ runs: [run()], transcript: transcriptPage, selectedRunId: "run-1" });

    expect(dashboard.board.counts.total).toBe(1);
    expect(dashboard.providerGates[0]).toMatchObject({
      provider: "openai-codex",
      kind: "windowed_bucket_exhausted",
      resumeAt: "2026-01-01T05:00:00.000Z",
      sourceIssue: "TEST-1",
    });
    expect(dashboard.activity.map((item) => item.verb)).toEqual(["run_started", "tool_call"]);
    expect(dashboard.sessions[0]).toMatchObject({ id: "session-1", issue: "TEST-1", state: "succeeded", model: "gpt-test", msgCount: 2 });
    expect(detail.issue.id).toBe("TEST-1");
    expect(detail.runs).toHaveLength(1);
    expect(history.selectedSessionId).toBe("run-1");
    expect(history.transcript.map((message) => message.kind)).toEqual(["tool_call", "request"]);
    expect(projectActivityModels(activityInput)[1]).toMatchObject({ who: "agent-1", issue: "TEST-1", runId: "run-1", text: "read_file" });
    expect(projectTranscriptMessages(transcriptEvents)[0]).toMatchObject({ kind: "tool_call", text: "read_file" });
  });

  it("returns empty models for unavailable projection sources", () => {
    expect(emptyDashboardModel()).toMatchObject({ generatedAt: null, board: { counts: { total: 0 } }, runningAgents: [], activity: [], sessions: [] });
    expect(projectIssueBoardModel(null)).toMatchObject({ counts: { total: 0 }, issues: [] });
    expect(projectDashboardModel({ activity: null, board: null, runs: [] })).toMatchObject({ board: { counts: { total: 0 } }, activity: [], sessions: [] });
  });
});
