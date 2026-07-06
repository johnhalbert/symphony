import { describe, expect, it } from "vitest";
import type { IssueDetailsEnvelope } from "../src/core/types.js";
import type { IssueLifecycleRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import type { RunRecord, TranscriptEvent, TranscriptPage } from "../src/core/persistence/RunTranscriptStore.js";
import {
  clampIssuePriority,
  deriveIssueStatus,
  deterministicColor,
  emptyDashboardModel,
  emptySidebarModel,
  normalizeDescription,
  projectActivityModels,
  projectDashboardModel,
  projectHistoryModel,
  projectIssueBoardModel,
  projectIssueModel,
  projectWebReferenceData,
  projectIssueDetailModel,
  projectSessionModel,
  projectWebDashboard,
  projectWebIssueBoard,
  projectWebSidebar,
  projectTranscriptMessages,
  projectWebOrchestratorChat,
  projectWebOrchestratorChatPost,
  type ActivityFeedResponseProjectionInput,
  type IssueBoardCardProjectionInput,
  type IssueBoardResponseProjectionInput,
} from "../src/app/webProjection.js";
import { projectWebHistory } from "../src/app/WebHistoryProjection.js";

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

function contextualIssueDetails(input: {
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  projectContextId: string;
  projectContextLabel: string;
  linearProjectSlug: string;
}): IssueDetailsEnvelope {
  const base = issueDetails();
  return issueDetails({
    issue: {
      ...base.issue,
      id: input.issueId,
      identifier: input.identifier,
      title: input.title,
      state: input.state,
      labels: [],
      projectContext: {
        projectContextId: input.projectContextId,
        projectContextLabel: input.projectContextLabel,
        linearProjectSlug: input.linearProjectSlug,
        routingSource: "explicit",
      },
    },
  });
}

function contextualBoardCard(
  input: {
    issueId: string;
    identifier: string;
    title: string;
    lane: IssueBoardCardProjectionInput["lane"];
    state: string;
    projectContextId: string;
    projectContextLabel: string;
    linearProjectSlug: string;
  },
): IssueBoardCardProjectionInput {
  return card({
    key: input.issueId,
    issueId: input.issueId,
    issueIdentifier: input.identifier,
    lane: input.lane,
    issueDetails: contextualIssueDetails(input),
    live: null,
    operatorLiveness: null,
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

function lifecycle(overrides: Partial<IssueLifecycleRecord> = {}): IssueLifecycleRecord {
  const issueId = overrides.issueId ?? "issue-1";
  const issueIdentifier = overrides.issueIdentifier ?? "TEST-1";
  const updatedAt = overrides.updatedAt ?? "2026-01-01T00:10:00.000Z";
  const summaryPointers = {
    workspaceKey: null,
    workspacePath: null,
    branchName: null,
    gitBranchName: null,
    repoPath: null,
    baseRef: null,
    lastRunId: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    ciStatus: null,
    lastPushedAt: null,
    lastEvidenceCursor: null,
    ...(overrides.summaryPointers ?? {}),
  };
  return {
    issueId,
    issueIdentifier,
    phase: "implementation",
    updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    ...overrides,
    summaryPointers,
  } as IssueLifecycleRecord;
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

  it("enriches issue models from backend detail evidence and keeps missing evidence honest", () => {
    const base = issueDetails();
    const enriched = projectIssueModel(
      card({
        key: "TEST-ENRICH",
        issueId: "issue-enrich",
        issueIdentifier: "TEST-ENRICH",
        lane: "unknown",
        issueDetails: issueDetails({
          issue: {
            ...base.issue,
            id: "issue-enrich",
            identifier: "TEST-ENRICH",
            title: "Enriched issue",
            description: "Primary detail",
            priority: 99,
            state: null,
            assigneeId: "assignee-1",
            delegateId: "delegate-1",
            labels: ["dogfood", "ui"],
            blockedBy: [{ id: "issue-blocker", identifier: "TEST-BLOCKER", state: "Todo" }],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
          tracker: { ...base.tracker, state: null, classification: null },
          blockers: {
            available: true,
            totalCount: 1,
            openCount: 1,
            open: [{ id: "issue-blocker", identifier: "TEST-BLOCKER", state: "Todo" }],
            blocked: true,
            humanBlockedReason: null,
          },
          workspace: {
            ...base.workspace,
            workspaceKey: "TEST-ENRICH",
            path: null,
          },
          pullRequest: {
            url: null,
            number: null,
            headSha: "head-sha-9",
            branch: "symphony/TEST-ENRICH",
            ciStatus: null,
            lastPushedAt: "2026-01-01T00:06:00.000Z",
          },
          latestRun: {
            runId: "run-enrich",
            runPhase: "implementation",
            runKind: "implementation",
            status: "failed",
            terminalReason: "failed",
            error: "Harness failed after report",
            completedAt: "2026-01-01T00:07:00.000Z",
          },
        }),
        live: null,
        operatorLiveness: { agentId: null, sessionId: null, workspacePath: null, runId: "operator-run", activeRunId: "active-run", status: "failed" },
        metadata: { prNumber: 9, ciStatus: "failure", prBranch: "symphony/TEST-ENRICH" },
        reviewLoop: {
          phase: "blocked",
          blockedReason: "needs operator",
          lastCompletionReport: { id: "report-1", summary: "Worker summary", acceptedAt: "2026-01-01T00:08:00.000Z" },
          lastReviewVerdict: {
            id: "verdict-1",
            verdict: "fail",
            findings: ["Fix invariant"],
            evidence: ["review evidence"],
            submittedAt: "2026-01-01T00:09:00.000Z",
          },
        },
      }),
    );

    expect(enriched).toMatchObject({
      id: "TEST-ENRICH",
      title: "Enriched issue",
      status: "progress",
      priority: 3,
      labels: ["dogfood", "ui"],
      assignee: "assignee-1",
      agent: "delegate-1",
      pr: "#9",
      ci: "failure",
      workspace: "TEST-ENRICH",
      session: "active-run",
      desc: ["Primary detail", "Blocked by TEST-BLOCKER", "needs operator", "Worker summary", "Fix invariant", "Harness failed after report"],
    });
    expect(enriched.activity).toEqual([
      { t: "2026-01-01T00:00:00.000Z", verb: "created", val: "TEST-ENRICH", who: "tracker" },
      { t: "2026-01-01T00:05:00.000Z", verb: "updated", val: "TEST-ENRICH", who: "delegate-1" },
      { t: "2026-01-01T00:06:00.000Z", verb: "pr pushed", val: "#9", who: "github" },
      { t: "2026-01-01T00:07:00.000Z", verb: "run failed", val: "run-enrich", who: "delegate-1" },
    ]);

    const sparse = projectIssueModel(
      card({
        key: "TEST-SPARSE",
        issueId: null,
        issueIdentifier: "TEST-SPARSE",
        lane: "unknown",
        issueDetails: issueDetails({
          issue: {
            ...base.issue,
            id: null,
            identifier: "TEST-SPARSE",
            title: null,
            description: null,
            priority: null,
            state: null,
            assigneeId: null,
            delegateId: null,
            labels: [],
            blockedBy: [],
            createdAt: null,
            updatedAt: null,
          },
          tracker: { ...base.tracker, state: null, classification: null },
          blockers: { available: false, totalCount: 0, openCount: 0, open: [], blocked: false, humanBlockedReason: null },
          workspace: { ...base.workspace, workspaceKey: null, path: null },
          pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
          latestRun: { runId: null, runPhase: null, runKind: null, status: null, terminalReason: null, error: null, completedAt: null },
        }),
        live: null,
        operatorLiveness: null,
        metadata: null,
        reviewLoop: null,
      }),
    );

    expect(sparse).toMatchObject({
      id: "TEST-SPARSE",
      title: "TEST-SPARSE",
      status: "backlog",
      priority: 0,
      labels: [],
      assignee: "unassigned",
      agent: null,
      pr: null,
      ci: null,
      workspace: null,
      session: null,
      activity: [],
    });
    expect(sparse.desc).toBeUndefined();
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

  it("projects project attribution for duplicate issue identifiers on the React issue board", () => {
    const board = projectWebIssueBoard({
      issues: [
        contextualBoardCard({
          issueId: "issue-docs-179",
          identifier: "ENG-179",
          title: "Docs issue",
          lane: "todo",
          state: "Todo",
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectSlug: "DOCS",
        }),
        contextualBoardCard({
          issueId: "issue-symphony-179",
          identifier: "ENG-179",
          title: "Symphony issue",
          lane: "progress",
          state: "In Progress",
          projectContextId: "symphony",
          projectContextLabel: "Symphony",
          linearProjectSlug: "ENG",
        }),
      ],
    });

    expect(board).toMatchObject({ selectedIssueId: "symphony:ENG-179" });
    expect(board.issues).toHaveLength(2);
    expect(board.issues.map(({ id, title, project, status }) => ({ id, title, project, status }))).toEqual([
      { id: "docs:ENG-179", title: "Docs issue", project: "Documentation Site", status: "todo" },
      { id: "symphony:ENG-179", title: "Symphony issue", project: "Symphony", status: "progress" },
    ]);
    expect(board.lanes.todo.map(({ id, title, project }) => ({ id, title, project }))).toEqual([
      { id: "docs:ENG-179", title: "Docs issue", project: "Documentation Site" },
    ]);
    expect(board.lanes.progress.map(({ id, title, project }) => ({ id, title, project }))).toEqual([
      { id: "symphony:ENG-179", title: "Symphony issue", project: "Symphony" },
    ]);
  });

  it("normalizes canceled backend board cards to cancelled for the React issue board", () => {
    const board = projectWebIssueBoard({
      issues: [webCard("TEST-CANCELED", { lane: "canceled", state: "Canceled", title: "Canceled issue" })],
    });

    expect(board.issues[0]).toMatchObject({ id: "TEST-CANCELED", title: "Canceled issue", status: "cancelled" });
    expect(board.lanes).toEqual({ todo: [], progress: [], review: [] });
    expect(board.selectedIssueId).toBe("TEST-CANCELED");
  });

  it("derives review, done, cancelled, and blocked issue states from durable metadata without live liveness", () => {
    const base = issueDetails();
    const durableStateCard = (
      identifier: string,
      state: string,
      overrides: Partial<IssueDetailsEnvelope> = {},
    ): IssueBoardCardProjectionInput =>
      card({
        key: identifier,
        issueId: "issue-" + identifier.toLowerCase(),
        issueIdentifier: identifier,
        lane: "unknown",
        issueDetails: issueDetails({
          issue: {
            ...base.issue,
            id: "issue-" + identifier.toLowerCase(),
            identifier,
            title: identifier + " title",
            description: null,
            priority: null,
            state,
            labels: [],
            assigneeId: null,
            delegateId: null,
            createdAt: null,
            updatedAt: null,
          },
          tracker: { ...base.tracker, state, classification: null },
          workspace: { ...base.workspace, workspaceKey: null, path: null },
          pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
          latestRun: { runId: null, runPhase: null, runKind: null, status: null, terminalReason: null, error: null, completedAt: null },
          ...overrides,
        }),
        live: null,
        operatorLiveness: null,
        metadata: null,
      });

    const board = projectWebIssueBoard({
      issues: [
        durableStateCard("TEST-REVIEW", "Ready to Merge"),
        durableStateCard("TEST-DONE", "Closed"),
        durableStateCard("TEST-CANCELED", "Canceled"),
        durableStateCard("TEST-BLOCKED", "Blocked", {
          blockers: {
            available: true,
            totalCount: 1,
            openCount: 1,
            open: [{ id: "issue-blocker", identifier: "TEST-BLOCKER", state: "Todo" }],
            blocked: true,
            humanBlockedReason: "Waiting for operator approval",
          },
        }),
      ],
    });

    expect(Object.fromEntries(board.issues.map((issue) => [issue.id, issue.status]))).toEqual({
      "TEST-REVIEW": "review",
      "TEST-DONE": "done",
      "TEST-CANCELED": "cancelled",
      "TEST-BLOCKED": "progress",
    });
    expect(board.lanes.review.map((issue) => issue.id)).toEqual(["TEST-REVIEW"]);
    expect(board.lanes.progress.map((issue) => issue.id)).toEqual(["TEST-BLOCKED"]);
    expect(board.issues.find((issue) => issue.id === "TEST-BLOCKED")?.desc).toEqual(["Blocked: Waiting for operator approval"]);
    expect(board.issues.every((issue) => issue.agent === null && issue.workspace === null && issue.session === null)).toBe(true);
    expect(deriveIssueStatus({ state: "Blocked" })).toBe("progress");
    expect(deriveIssueStatus({ lifecyclePhase: "blocked" })).toBe("progress");
    expect(deriveIssueStatus({ runStatus: "canceled" })).toBe("cancelled");
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
    expect(deriveIssueStatus({ lane: null, state: null, classification: null, lifecyclePhase: "review" })).toBe("review");
    expect(deriveIssueStatus({ lane: null, state: null, classification: null, runStatus: "cancelled" })).toBe("cancelled");
    expect(deriveIssueStatus({ lane: null, state: null, classification: null })).toBe("backlog");
    expect(clampIssuePriority("urgent")).toBe("urgent");
    expect(clampIssuePriority(null)).toBe(0);
    expect(clampIssuePriority(10)).toBe(3);
    expect(normalizeDescription(" one  two \n\n three ")).toEqual(["one two", "three"]);
  });

  it("projects issue detail project attribution for duplicate issue identifiers", () => {
    const docsCard = contextualBoardCard({
      issueId: "issue-docs-179",
      identifier: "ENG-179",
      title: "Docs issue",
      lane: "todo",
      state: "Todo",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });
    const symphonyCard = contextualBoardCard({
      issueId: "issue-symphony-179",
      identifier: "ENG-179",
      title: "Symphony issue",
      lane: "progress",
      state: "In Progress",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "ENG",
    });

    const docsDetail = projectIssueDetailModel({
      issue: "docs:ENG-179",
      boardCard: docsCard,
      issueDetails: docsCard.issueDetails,
      latestRun: run({ issueId: "issue-docs-179", issueIdentifier: "ENG-179" }),
      runs: [],
      operatorLiveness: null,
    });
    const symphonyDetail = projectIssueDetailModel({
      issue: "symphony:ENG-179",
      boardCard: symphonyCard,
      issueDetails: symphonyCard.issueDetails,
      latestRun: run({ issueId: "issue-symphony-179", issueIdentifier: "ENG-179" }),
      runs: [],
      operatorLiveness: null,
    });

    expect([docsDetail.issue, symphonyDetail.issue].map(({ id, title, project }) => ({ id, title, project }))).toEqual([
      { id: "docs:ENG-179", title: "Docs issue", project: "Documentation Site" },
      { id: "symphony:ENG-179", title: "Symphony issue", project: "Symphony" },
    ]);
  });

  it("keeps legacy default tracker attribution out of the web project label", () => {
    const legacyDefaultIssue = projectIssueModel(
      issueDetails({
        issue: {
          ...issueDetails().issue,
          linearProjectIdentity: { kind: "linear", slug: "ENG" },
          linearProjectSlug: "ENG",
          routingSource: "legacy_default",
        },
      }),
    );

    expect(legacyDefaultIssue).toMatchObject({ id: "TEST-1", project: "" });
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

    const runtimeProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    const runtime = {
      generatedAt: "2026-01-01T00:11:00.000Z",
      counts: { running: 1, retrying: 0, paused: 0, providerGates: 1 },
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
      running: [
        {
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          runId: "run-1",
          projectContext: runtimeProjectContext,
          startedAt: "2026-01-01T00:01:00.000Z",
          lastEvent: "progress",
          lastMessage: "Implementing dashboard route",
          issueDetails: { title: "Live dashboard run" },
          liveness: { status: "active" },
          tokens: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        },
      ],
      retrying: [],
      paused: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      rateLimits: null,
    } as any;
    const dashboard = projectWebDashboard({
      board: {
        issues: [
          webCard("TEST-TODO", { lane: "todo", state: "Todo" }),
          webCard("TEST-PROGRESS", { lane: "progress", state: "In Progress" }),
          webCard("TEST-DONE", { lane: "done", state: "Done" }),
          webCard("TEST-CANCELED", { lane: "canceled", state: "Canceled" }),
        ],
      },
      activity: activityInput,
      runtime,
      source: {
        status: "ok",
        generatedAt: "2026-01-01T00:10:00.000Z",
        trackerFetchedAt: "2026-01-01T00:09:00.000Z",
        issueCount: 4,
        runCount: 1,
        lifecycleCount: 0,
        activityCount: 2,
        writebackCount: 0,
        cached: false,
      },
      config: {
        repoLabel: "acme/symphony",
        branch: "main",
        workflowLabel: "WORKFLOW.md",
        pollIntervalMs: 60_000,
        concurrencyCap: 2,
      },
    });
    const detail = projectIssueDetailModel({ issue: "TEST-1", boardCard: card(), issueDetails: issueDetails(), latestRun: run(), runs: [run()], operatorLiveness: { agentId: "agent-1", sessionId: "session-1", workspacePath: "/tmp/workspaces/TEST-1", runId: "run-1", activeRunId: "run-1", status: "active" } });
    const history = projectHistoryModel({ runs: [run()], transcript: transcriptPage, selectedRunId: "run-1" });

    expect(dashboard).toMatchObject({
      projectName: "Symphony",
      repoLabel: "acme/symphony",
      branch: "main",
      workflowLabel: "WORKFLOW.md",
      pollLabel: "poll 60s",
      agentUsageLabel: "1/2 agents",
      concurrencyCap: 2,
      chat: [],
      totals: { backlog: 0, todo: 1, progress: 1, review: 0, done: 1, cancelled: 1, open: 2, all: 4, completeness: 25 },
      source: {
        status: "fresh",
        label: "tracker fresh · 4 issues",
        detail: "Issue board tracker source is current; 1 runs · 0 lifecycle records · 2 activity entries · 0 writeback operations.",
        generatedAt: "2026-01-01T00:10:00.000Z",
        trackerFetchedAt: "2026-01-01T00:09:00.000Z",
        issueCount: 4,
        runCount: 1,
        lifecycleCount: 0,
        activityCount: 2,
        writebackCount: 0,
        cached: false,
        error: null,
      },
    });
    expect(dashboard.runningAgents[0]).toMatchObject({
      id: "run-1",
      issue: "TEST-1",
      title: "Live dashboard run",
      state: "active",
      step: "Implementing dashboard route",
      duration: "10m",
      tokens: "12",
      projectContext: runtimeProjectContext,
    });
    expect(dashboard.providerGates[0]).toMatchObject({
      provider: "openai-codex",
      kind: "windowed_bucket_exhausted",
      resumeAt: "2026-01-01T05:00:00.000Z",
      sourceIssue: "TEST-1",
    });
    expect(dashboard.activity.map((item) => item.verb)).toEqual(["run_started", "tool_call"]);
    expect(JSON.stringify(dashboard)).not.toContain("openai/symphony");
    expect(JSON.stringify(dashboard)).not.toContain("poll 22s");
    expect(JSON.stringify(dashboard)).not.toContain("mock");
    expect(detail.issue.id).toBe("TEST-1");
    expect(detail.runs).toHaveLength(1);
    expect(history.selectedSessionId).toBe("run-1");
    expect(history.transcript.map((message) => message.kind)).toEqual(["tool_call", "request"]);
    expect(projectActivityModels(activityInput)[1]).toMatchObject({ who: "agent-1", id: "TEST-1", extra: "read_file" });
    expect(projectTranscriptMessages(transcriptEvents)[0]).toMatchObject({
      kind: "tool_call",
      call_id: "run-1:1",
      name: "tool_call",
      status: "unknown",
      args: {},
      result: null,
    });
  });

  it("uses issue ids as context-safe fallback ids for live same-identifier siblings before run ids exist", () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const symphonyProjectContext = {
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "ENG",
      routingSource: "candidate_poll",
    } as const;

    const dashboard = projectWebDashboard({
      generatedAt: "2026-01-01T00:15:00.000Z",
      runtime: {
        generatedAt: "2026-01-01T00:15:00.000Z",
        running: [
          {
            issueId: "issue-docs-123",
            issueIdentifier: "ENG-123",
            runId: null,
            projectContext: docsProjectContext,
            startedAt: "2026-01-01T00:05:00.000Z",
            issueDetails: { title: "Docs live duplicate" },
            liveness: { status: "active" },
            lastMessage: "docs heartbeat",
            state: "running",
            tokens: { totalTokens: 10 },
          },
          {
            issueId: "issue-symphony-123",
            issueIdentifier: "ENG-123",
            runId: null,
            projectContext: symphonyProjectContext,
            startedAt: "2026-01-01T00:06:00.000Z",
            issueDetails: { title: "Symphony live duplicate" },
            liveness: { status: "active" },
            lastMessage: "symphony heartbeat",
            state: "running",
            tokens: { totalTokens: 12 },
          },
        ],
        providerGates: [],
      } as any,
      config: { concurrencyCap: 2 },
    });

    expect(dashboard.runningAgents.map((agent) => agent.id)).toEqual(["issue-docs-123", "issue-symphony-123"]);
    expect(new Set(dashboard.runningAgents.map((agent) => agent.id)).size).toBe(2);
    expect(dashboard.runningAgents.map((agent) => agent.projectContext)).toEqual([docsProjectContext, symphonyProjectContext]);
  });

  it("does not project stale Cursor model as legacy session model for explicit Hermes ACP runs", () => {
    expect(
      projectSessionModel(
        run({ harnessId: "hermes_acp", runtimeModel: null, cursorModel: "stale-cursor-model", cursorMode: "agent" }),
      ),
    ).toMatchObject({ model: null });

    expect(projectSessionModel(run({ harnessId: "cursor", runtimeModel: null, cursorModel: "cursor-model" }))).toMatchObject({
      model: "cursor-model",
    });
  });

  it("projects dashboard source freshness metadata for stale and failed tracker sources", () => {
    const staleDashboard = projectWebDashboard({
      source: {
        status: "ok",
        cached: true,
        issueCount: 3,
        runCount: 2,
        lifecycleCount: 1,
        activityCount: 4,
        writebackCount: 5,
      },
    });
    expect(staleDashboard.source).toMatchObject({
      status: "stale",
      label: "tracker stale · 3 cached issues",
      issueCount: 3,
      cached: true,
    });
    expect(staleDashboard.source.detail).toContain("Using a cached tracker source while refresh catches up");

    const failedDashboard = projectWebDashboard({
      source: {
        status: "error",
        issueCount: 0,
        error: "Issue board tracker fetch failed: request timed out",
      },
    });
    expect(failedDashboard.source).toMatchObject({
      status: "error",
      label: "tracker error",
      issueCount: 0,
      error: "Issue board tracker fetch failed: request timed out",
    });
    expect(failedDashboard.source.detail).toBe("Issue board tracker fetch failed: request timed out");
  });

  it("derives dashboard totals and active agents from durable run and lifecycle state when board/runtime data is incomplete", () => {
    const durableProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    const dashboard = projectWebDashboard({
      generatedAt: "2026-01-01T00:15:00.000Z",
      board: {
        issues: [
          webCard("TEST-BOARD", { issueId: "issue-board", lane: "todo", state: "Todo" }),
          webCard("TEST-RUNNING", { issueId: "issue-running", lane: "progress", state: "In Progress" }),
        ],
      },
      runtime: null,
      runs: [
        run({
          runId: "run-running",
          issueId: "issue-running",
          issueIdentifier: "TEST-RUNNING",
          workspaceKey: "TEST-RUNNING",
          projectContext: durableProjectContext,
          status: "running",
          completedAt: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:14:00.000Z",
          tokens: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        }),
        run({
          runId: "run-done",
          issueId: "issue-done",
          issueIdentifier: "TEST-DONE",
          workspaceKey: "TEST-DONE",
          status: "succeeded",
        }),
        run({
          runId: "run-cancelled",
          issueId: "issue-cancelled",
          issueIdentifier: "TEST-CANCELLED",
          workspaceKey: "TEST-CANCELLED",
          status: "cancelled",
        }),
        run({
          runId: "run-failed",
          issueId: "issue-failed",
          issueIdentifier: "TEST-FAILED",
          workspaceKey: "TEST-FAILED",
          status: "failed",
        }),
      ],
      lifecycleRecords: [
        lifecycle({ issueId: "issue-running", issueIdentifier: "TEST-RUNNING", phase: "implementation" }),
        lifecycle({ issueId: "issue-done", issueIdentifier: "TEST-DONE", phase: "terminal" }),
        lifecycle({ issueId: "issue-review", issueIdentifier: "TEST-REVIEW", phase: "review" }),
      ],
      config: { concurrencyCap: 3 },
    });

    expect(dashboard.totals).toEqual({
      backlog: 0,
      todo: 1,
      progress: 2,
      review: 1,
      done: 1,
      cancelled: 1,
      open: 4,
      all: 6,
      completeness: 17,
    });
    expect(dashboard.runningAgents).toEqual([
      {
        id: "run-running",
        issue: "TEST-RUNNING",
        title: "TEST-RUNNING",
        state: "running",
        step: "implementation",
        duration: "15m",
        tokens: "25",
        projectContext: durableProjectContext,
      },
    ]);
    expect(dashboard.agentUsageLabel).toBe("1/3 agents");
    expect(JSON.stringify(dashboard)).not.toContain("mock");
  });

  it("uses issue ids as context-safe fallback ids for durable same-identifier siblings when run ids are unavailable", () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const symphonyProjectContext = {
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "ENG",
      routingSource: "candidate_poll",
    } as const;

    const dashboard = projectWebDashboard({
      generatedAt: "2026-01-01T00:15:00.000Z",
      runtime: null,
      runs: [
        run({
          runId: "",
          issueId: "issue-docs-123",
          issueIdentifier: "ENG-123",
          workspaceKey: "docs-ENG-123",
          projectContext: docsProjectContext,
          status: "running",
          completedAt: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:14:00.000Z",
          tokens: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        }),
        run({
          runId: "",
          issueId: "issue-symphony-123",
          issueIdentifier: "ENG-123",
          workspaceKey: "symphony-ENG-123",
          projectContext: symphonyProjectContext,
          status: "running",
          completedAt: null,
          startedAt: "2026-01-01T00:01:00.000Z",
          updatedAt: "2026-01-01T00:13:00.000Z",
          tokens: { inputTokens: 9, outputTokens: 9, totalTokens: 18 },
        }),
      ],
      config: { concurrencyCap: 2 },
    });

    expect(dashboard.runningAgents.map((agent) => agent.id)).toEqual(["issue-docs-123", "issue-symphony-123"]);
    expect(new Set(dashboard.runningAgents.map((agent) => agent.id)).size).toBe(2);
    expect(dashboard.runningAgents.map((agent) => agent.projectContext)).toEqual([docsProjectContext, symphonyProjectContext]);
  });

  it("dedupes contextual board issues against durable totals by raw issue id without collapsing same-identifier sibling contexts", () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const symphonyProjectContext = {
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "ENG",
      routingSource: "candidate_poll",
    } as const;
    const dashboard = projectWebDashboard({
      generatedAt: "2026-01-01T00:15:00.000Z",
      board: {
        issues: [
          contextualBoardCard({
            issueId: "issue-docs-179",
            identifier: "ENG-179",
            title: "Docs issue",
            lane: "todo",
            state: "Todo",
            projectContextId: "docs",
            projectContextLabel: "Documentation Site",
            linearProjectSlug: "DOCS",
          }),
        ],
      },
      runtime: null,
      runs: [
        run({
          runId: "run-docs-179",
          issueId: "issue-docs-179",
          issueIdentifier: "ENG-179",
          workspaceKey: "ENG-179",
          status: "running",
          completedAt: null,
          updatedAt: "2026-01-01T00:14:00.000Z",
          projectContext: docsProjectContext,
        }),
      ],
      lifecycleRecords: [
        lifecycle({
          issueId: "issue-docs-179",
          issueIdentifier: "ENG-179",
          phase: "implementation",
          projectContext: docsProjectContext,
        }),
        lifecycle({
          issueId: "issue-symphony-179",
          issueIdentifier: "ENG-179",
          phase: "review",
          projectContext: symphonyProjectContext,
        }),
      ],
      config: { concurrencyCap: 2 },
    });

    expect(dashboard.totals).toEqual({
      backlog: 0,
      todo: 1,
      progress: 0,
      review: 1,
      done: 0,
      cancelled: 0,
      open: 2,
      all: 2,
      completeness: 0,
    });
  });

  it("prefers live runtime agent rows over matching durable running records without double-counting usage", () => {
    const runtimeProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const durableProjectContext = {
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "ENG",
      routingSource: "candidate_poll",
    } as const;

    const dashboard = projectWebDashboard({
      generatedAt: "2026-01-01T00:15:00.000Z",
      runtime: {
        generatedAt: "2026-01-01T00:15:00.000Z",
        running: [
          {
            issueId: "issue-running",
            issueIdentifier: "TEST-RUNNING",
            runId: "run-running",
            projectContext: runtimeProjectContext,
            startedAt: "2026-01-01T00:05:00.000Z",
            lastMessage: "runtime heartbeat",
            state: "running",
            tokens: { totalTokens: 10 },
          },
        ],
        providerGates: [],
      } as any,
      runs: [
        run({
          runId: "run-running",
          issueId: "issue-running",
          issueIdentifier: "TEST-RUNNING",
          workspaceKey: "TEST-RUNNING",
          projectContext: durableProjectContext,
          status: "running",
          completedAt: null,
          tokens: { inputTokens: 9, outputTokens: 9, totalTokens: 18 },
        }),
      ],
      config: { concurrencyCap: 2 },
    });

    expect(dashboard.runningAgents).toEqual([
      {
        id: "run-running",
        issue: "TEST-RUNNING",
        title: "TEST-RUNNING",
        state: "running",
        step: "runtime heartbeat",
        duration: "10m",
        tokens: "10",
        projectContext: runtimeProjectContext,
      },
    ]);
    expect(dashboard.agentUsageLabel).toBe("1/2 agents");
  });

  it("treats an empty runtime snapshot as authoritative over stale durable running records", () => {
    const dashboard = projectWebDashboard({
      generatedAt: "2026-01-01T00:15:00.000Z",
      runtime: {
        generatedAt: "2026-01-01T00:15:00.000Z",
        running: [],
        providerGates: [],
      } as any,
      runs: [
        run({
          runId: "stale-run",
          issueId: "issue-stale",
          issueIdentifier: "TEST-STALE",
          workspaceKey: "TEST-STALE",
          status: "running",
          completedAt: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:14:00.000Z",
        }),
      ],
      config: { concurrencyCap: 5 },
    });

    expect(dashboard.runningAgents).toEqual([]);
    expect(dashboard.agentUsageLabel).toBe("0/5 agents");
  });

  it("composes the web sidebar model directly from dashboard, issue, history, and chat projections", () => {
    const issues = projectWebIssueBoard({
      issues: [
        webCard("TEST-TODO", { lane: "todo", state: "Todo" }),
        webCard("TEST-REVIEW", { lane: "review", state: "In Review" }),
      ],
    });
    const providerGates = [
      {
        id: "gate-1",
        provider: "openai-codex",
        kind: "windowed_bucket_exhausted",
        message: "provider paused",
        resumeAt: "2026-01-01T05:00:00.000Z",
        resumePolicy: "auto_at_window_close",
        sourceIssue: "TEST-REVIEW",
        sourceRunId: "run-sidebar",
        affected: "worker",
      },
    ];
    const runningAgents = [
      {
        id: "run-sidebar",
        issue: "TEST-REVIEW",
        title: "Review issue",
        state: "active",
        step: "reviewing",
        duration: "1m",
        tokens: "12",
      },
    ];
    const activity = [{ t: "2026-01-01T00:00:00.000Z", who: "agent-1", verb: "run_started", id: "TEST-REVIEW", extra: "run-sidebar" }];
    const totals = { backlog: 0, todo: 1, progress: 0, review: 1, done: 0, cancelled: 0, open: 2, all: 2, completeness: 0 };
    const dashboard = {
      projectName: "Symphony",
      repoLabel: "acme/symphony",
      branch: "main",
      workflowLabel: "WORKFLOW.md",
      pollLabel: "poll 60s",
      agentUsageLabel: "1/2 agents",
      concurrencyCap: 2,
      providerGates,
      runningAgents,
      activity,
      chat: [],
      totals,
      source: emptyDashboardModel().source,
    };
    const history = projectWebHistory([run({ runId: "run-sidebar", issueIdentifier: "TEST-REVIEW" })], []);
    const chat = [{ who: "user" as const, text: "show the sidebar" }];

    const sidebar = projectWebSidebar(dashboard, issues, history, chat);

    expect(sidebar.providerGates).toBe(providerGates);
    expect(sidebar.runningAgents).toBe(runningAgents);
    expect(sidebar.reviewIssues).toEqual(issues.lanes.review);
    expect(sidebar.activity).toBe(activity);
    expect(sidebar.sessions).toBe(history.sessions);
    expect(sidebar.chat).toBe(chat);
    expect(sidebar.totals).toBe(totals);
  });

  it("caps sidebar review issues at three while preserving issue projection order", () => {
    const issues = projectWebIssueBoard({
      issues: [
        webCard("TEST-REVIEW-1", { lane: "review", state: "In Review" }),
        webCard("TEST-REVIEW-2", { lane: "review", state: "Ready to Merge" }),
        webCard("TEST-REVIEW-3", { lane: "review", state: "In Review" }),
        webCard("TEST-REVIEW-4", { lane: "review", state: "Ready to Merge" }),
        webCard("TEST-PROGRESS", { lane: "progress", state: "In Progress" }),
      ],
    });

    const sidebar = projectWebSidebar(emptyDashboardModel(), issues, projectWebHistory([], []), []);

    expect(issues.lanes.review.map((issue) => issue.id)).toEqual([
      "TEST-REVIEW-1",
      "TEST-REVIEW-2",
      "TEST-REVIEW-3",
      "TEST-REVIEW-4",
    ]);
    expect(sidebar.reviewIssues.map((issue) => issue.id)).toEqual(["TEST-REVIEW-1", "TEST-REVIEW-2", "TEST-REVIEW-3"]);
    expect(sidebar.reviewIssues[0]).toBe(issues.lanes.review[0]);
    expect(sidebar.reviewIssues[2]).toBe(issues.lanes.review[2]);
  });

  it("returns a complete empty sidebar model without mock sidebar-only data", () => {
    const expected = {
      providerGates: [],
      runningAgents: [],
      reviewIssues: [],
      activity: [],
      sessions: [],
      chat: [],
      totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 },
    };

    expect(emptySidebarModel()).toEqual(expected);
    expect(projectWebSidebar(emptyDashboardModel(), projectWebIssueBoard(null), projectWebHistory([], []), projectWebOrchestratorChat())).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain("mock");
    expect(JSON.stringify(expected)).not.toContain("assistant");
  });

  it("projects deterministic reference data from board labels, assignees, and delegates", () => {
    const firstIssue = {
      ...issueDetails().issue,
      id: "issue-a",
      identifier: "TEST-A",
      assigneeId: "user-b",
      delegateId: "delegate-a",
      labels: ["zeta", "alpha", "alpha", ""],
    };
    const secondIssue = {
      ...issueDetails().issue,
      id: "issue-b",
      identifier: "TEST-B",
      assigneeId: "user-c",
      labels: ["beta", "zeta"],
    };

    const firstCard = card({
      key: "issue-a",
      issueId: "issue-a",
      issueIdentifier: "TEST-A",
      issueDetails: issueDetails({ issue: firstIssue }),
    });
    const duplicateFirstCard = card({
      key: "issue-a",
      issueId: "issue-a",
      issueIdentifier: "TEST-A",
      issueDetails: issueDetails({ issue: { ...firstIssue, labels: ["should-not-leak"] } }),
    });

    const reference = projectWebReferenceData({
      generatedAt: "2026-01-01T00:06:00.000Z",
      issues: [firstCard, duplicateFirstCard],
      columns: [{ id: "todo", title: "Todo", issues: [card({ key: "issue-b", issueId: "issue-b", issueIdentifier: "TEST-B", issueDetails: issueDetails({ issue: secondIssue }) })] }],
    });

    expect(Object.keys(reference.labels)).toEqual(["alpha", "beta", "zeta"]);
    expect(Object.keys(reference.users)).toEqual(["delegate-a", "unassigned", "user-b", "user-c"]);
    expect(reference.labels.alpha).toEqual({ name: "alpha", color: deterministicColor("alpha") });
    expect(reference.users["delegate-a"]).toEqual({ name: "delegate-a", color: deterministicColor("delegate-a") });
    expect(reference.users.unassigned).toEqual({ name: "Unassigned", color: deterministicColor("unassigned") });
    expect(reference.labels["should-not-leak"]).toBeUndefined();
  });

  it("returns default reference data for unavailable or empty board input", () => {
    const expected = {
      labels: {},
      users: { unassigned: { name: "Unassigned", color: deterministicColor("unassigned") } },
    };

    expect(projectWebReferenceData(null)).toEqual(expected);
    expect(projectWebReferenceData({ generatedAt: null, issues: [], columns: [] })).toEqual(expected);
  });

  it("returns empty models for unavailable projection sources", () => {
    const emptyDashboard = {
      projectName: "Symphony",
      repoLabel: "",
      branch: "",
      workflowLabel: "",
      pollLabel: "",
      agentUsageLabel: "0 agents",
      concurrencyCap: 0,
      providerGates: [],
      runningAgents: [],
      activity: [],
      chat: [],
      totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 },
      source: {
        status: "unavailable",
        label: "source unavailable",
        detail: "No dashboard source metadata is available.",
        generatedAt: null,
        trackerFetchedAt: null,
        issueCount: 0,
        runCount: 0,
        lifecycleCount: 0,
        activityCount: 0,
        writebackCount: 0,
        cached: false,
        error: null,
      },
    };

    expect(emptyDashboardModel()).toEqual(emptyDashboard);
    expect(projectIssueBoardModel(null)).toMatchObject({ counts: { total: 0 }, issues: [] });
    expect(projectWebDashboard({ activity: null, board: null, runs: [] })).toEqual(emptyDashboard);
    expect(projectDashboardModel({ activity: null, board: null, runs: [] })).toEqual(emptyDashboard);
  });

  it("keeps dashboard mapping stable for partial runtime rows and unavailable board data", () => {
    const dashboard = projectWebDashboard({
      board: null,
      runtime: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        running: [
          {
            issueId: "issue-live",
            issueIdentifier: "",
            runId: null,
            state: "running",
            lastMessage: "",
            lastEvent: "executing tool",
            startedAt: "2026-01-01T00:05:00.000Z",
            tokens: {},
          },
        ],
        providerGates: [
          {
            id: "gate-1",
            scope: { harnessId: "hermes", providerId: "" },
            kind: "manual_pause",
            message: "Provider gate active",
            window: null,
            resumePolicy: "manual",
            source: { issueId: "issue-source", issueIdentifier: "", runId: "" },
            affectedRoles: [],
            affectedRunPhases: null,
          },
        ],
      } as any,
      config: {
        repoLabel: "acme/symphony",
        branch: "main",
        workflowLabel: "WORKFLOW.md",
        pollIntervalMs: -1,
        concurrencyCap: 1.9,
      },
    });

    expect(dashboard).toMatchObject({
      repoLabel: "acme/symphony",
      branch: "main",
      workflowLabel: "WORKFLOW.md",
      pollLabel: "",
      agentUsageLabel: "1/1 agents",
      concurrencyCap: 1,
      activity: [],
      chat: [],
      totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 },
    });
    expect(dashboard.runningAgents).toEqual([
      {
        id: "issue-live",
        issue: "issue-live",
        title: "issue-live",
        state: "running",
        step: "executing tool",
        duration: "",
        tokens: "",
      },
    ]);
    expect(dashboard.providerGates).toEqual([
      {
        id: "gate-1",
        provider: "hermes",
        kind: "manual_pause",
        message: "Provider gate active",
        resumeAt: null,
        resumePolicy: "manual",
        sourceIssue: "issue-source",
        sourceRunId: null,
        affected: "",
      },
    ]);
  });

  it("drops caller-provided dashboard chat input to keep chat behavior out of scope", () => {
    const injectedChat = [{ who: "agent" as const, text: "not allowed mock chat", suggestions: ["assistant suggestion"] }];

    const dashboard = projectWebDashboard({ chat: injectedChat });
    const legacyDashboard = projectDashboardModel({ chat: injectedChat });

    expect(dashboard.chat).toEqual([]);
    expect(legacyDashboard.chat).toEqual([]);
    expect(JSON.stringify(dashboard)).not.toContain("not allowed mock chat");
    expect(JSON.stringify(dashboard)).not.toContain("assistant suggestion");
    expect(JSON.stringify(legacyDashboard)).not.toContain("not allowed mock chat");
    expect(JSON.stringify(legacyDashboard)).not.toContain("assistant suggestion");
  });

  it("projects orchestrator chat as an empty default and maps durable messages without mock content", () => {
    const chat = projectWebOrchestratorChat();
    const replay = projectWebOrchestratorChat();
    const postChat = projectWebOrchestratorChatPost("please inspect ENG-94");
    const durableChat = projectWebOrchestratorChat([
      { who: "agent", text: "  ready  ", suggestions: [" status ", "", "inspect ENG-123"] },
      { who: "user", text: "pause ENG-123" },
    ]);

    expect(chat).toEqual([]);
    expect(replay).toEqual([]);
    expect(postChat).toEqual([{ who: "user", text: "please inspect ENG-94" }]);
    expect(durableChat).toEqual([
      { who: "agent", text: "  ready  ", suggestions: ["status", "inspect ENG-123"] },
      { who: "user", text: "pause ENG-123" },
    ]);
    expect(replay).not.toBe(chat);
    expect(postChat).not.toBe(chat);
    expect(durableChat).not.toBe(chat);
    expect(JSON.stringify(chat)).not.toContain("assistant");
    expect(JSON.stringify(durableChat)).not.toContain("mock");
    expect(JSON.stringify(durableChat)).not.toContain("assistant");
  });
});
