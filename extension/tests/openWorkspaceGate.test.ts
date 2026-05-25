import { describe, expect, it } from "vitest";
import type { DashboardSections, DashboardViewState, WorkspaceContext } from "../src/dashboardTypes";
import {
  mutationPolicyBlockedReason,
  openWorkspaceProviderBlockedReason,
  resolveWorkspaceContextForIssueKey,
} from "../src/openWorkspaceGate";

describe("open workspace gate", () => {
  it("blocks only token-required mutations when the token is missing", () => {
    expect(mutationPolicyBlockedReason({ mutationsRequireToken: null, tokenConfigured: true })).toBe("Mutation policy unavailable.");
    expect(mutationPolicyBlockedReason({ mutationsRequireToken: true, tokenConfigured: false })).toBe("Configure symphony.token to enable.");
    expect(mutationPolicyBlockedReason({ mutationsRequireToken: false, tokenConfigured: false })).toBeNull();
  });

  it("resolves workspace context from open-workspace surfaces and excludes retrying rows", () => {
    const sections = sectionsWithWorkspace("board-issue", workspace("board-issue"));
    sections.operatorQueues.data.retrying = [{ issueIdentifier: "RETRY-1", attempt: 2, dueAt: null, error: "rate limited" }];

    expect(resolveWorkspaceContextForIssueKey(sections, "board-issue")).toMatchObject({ workspaceKey: "board-issue" });
    expect(resolveWorkspaceContextForIssueKey(sections, "RETRY-1")).toBeNull();
  });

  it("uses the fixed workspace resolution order before opening", () => {
    const sections = sectionsWithWorkspace("shared-key", workspace("active"));
    sections.operatorQueues.data.running = [
      {
        issueIdentifier: "RUN-1",
        issueKey: "shared-key",
        role: "worker",
        statusLabel: "running",
        detail: null,
        workspace: workspace("running"),
      },
    ];
    sections.board = {
      status: "ready",
      data: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        columns: [],
        counts: null,
        issues: [{ issueIdentifier: "BOARD-1", issueKey: "shared-key", title: null, state: null, workspace: workspace("board") }],
      },
    };

    expect(resolveWorkspaceContextForIssueKey(sections, "shared-key")).toMatchObject({ workspaceKey: "active" });
  });

  it("blocks null state, non-connected state, missing workspace, and unknown policy", () => {
    expect(openWorkspaceProviderBlockedReason(null, "issue-1", "token")).toBe("Dashboard state unavailable.");
    expect(
      openWorkspaceProviderBlockedReason(
        { connection: { kind: "offline", baseUrl: "http://127.0.0.1:7331", reason: "network", detail: "offline" }, sections: null },
        "issue-1",
        "token",
      ),
    ).toBe("Dashboard state unavailable.");
    expect(openWorkspaceProviderBlockedReason(connectedState({ mutationsRequireToken: false }), "missing", "")).toBe("No workspace context.");
    expect(openWorkspaceProviderBlockedReason(connectedState({ mutationsRequireToken: null }), "issue-1", "token")).toBe("Mutation policy unavailable.");
  });
});

function connectedState(summary: { mutationsRequireToken: boolean | null }): DashboardViewState {
  return {
    connection: {
      kind: "connected",
      baseUrl: "http://127.0.0.1:7331",
      generatedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        runningCount: 0,
        retryingCount: 0,
        tokenConfigured: true,
        mutationsRequireToken: summary.mutationsRequireToken,
      },
    },
    sections: sectionsWithWorkspace("issue-1", workspace("issue-1")),
  };
}

function sectionsWithWorkspace(issueKey: string, workspaceContext: WorkspaceContext): DashboardSections {
  return {
    activeSessions: {
      status: "ready",
      data: {
        sessions: [
          {
            issueIdentifier: issueKey,
            issueKey,
            role: "worker",
            statusLabel: "running",
            runId: "run-1",
            detail: null,
            workspace: workspaceContext,
          },
        ],
      },
    },
    operatorQueues: { status: "ready", data: { running: [], paused: [], orphaned: [], retrying: [] } },
    board: { status: "ready", data: { generatedAt: "2026-01-01T00:00:00.000Z", columns: [], counts: null, issues: [] } },
    workspaces: { status: "ready", data: { rows: [] } },
    activity: { status: "ready", data: { items: [], totalItems: 0 } },
  };
}

function workspace(workspaceKey: string): WorkspaceContext {
  return {
    workspaceKey,
    issueId: workspaceKey,
    issueIdentifier: workspaceKey,
    path: `C:\\workspaces\\${workspaceKey}`,
    sourceKind: "dogfood",
    branchName: "eng-6",
  };
}
