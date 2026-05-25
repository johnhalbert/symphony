import { describe, expect, it } from "vitest";
import type { DashboardViewState } from "../src/dashboardTypes";
import { renderDashboardHtml } from "../src/webview/render";

describe("webview dashboard rendering", () => {
  it("renders connected dashboard surfaces and enabled workspace actions", () => {
    const html = renderDashboardHtml(connectedState({ tokenConfigured: true, mutationsRequireToken: true }));

    expect(html).toContain("Planning, Orchestrator, and Chat");
    expect(html).toContain("Planning");
    expect(html).toContain("Orchestrator");
    expect(html).toContain("Chat");
    expect(html).toContain("Active agent sessions");
    expect(html).toContain("Workspaces");
    expect(html).toContain("data-action=\"openWorkspace\"");
    expect(html).toContain("data-issue-key=\"issue-1\"");
  });

  it("fails closed for missing or unknown mutation policy and does not render postable buttons", () => {
    const missingTokenHtml = renderDashboardHtml(connectedState({ tokenConfigured: false, mutationsRequireToken: true }));
    const unknownPolicyHtml = renderDashboardHtml(connectedState({ tokenConfigured: true, mutationsRequireToken: null }));

    expect(missingTokenHtml).toContain("Configure symphony.token to enable.");
    expect(missingTokenHtml).not.toContain("data-action=\"openWorkspace\"");
    expect(unknownPolicyHtml).toContain("Mutation policy unavailable.");
    expect(unknownPolicyHtml).not.toContain("data-action=\"openWorkspace\"");
  });

  it("renders offline/error shells without mutation controls", () => {
    const html = renderDashboardHtml({
      connection: { kind: "offline", baseUrl: "http://127.0.0.1:7331", reason: "refused", detail: "ECONNREFUSED" },
      sections: null,
    });

    expect(html).toContain("Symphony offline");
    expect(html).toContain("Retry");
    expect(html).not.toContain("openWorkspace");
  });

  it("keeps connected sections visible when activity is degraded", () => {
    const state = connectedState({ tokenConfigured: true, mutationsRequireToken: false });
    if (!state.sections) throw new Error("expected sections");
    state.sections.activity = { status: "error", detail: "Symphony returned HTTP 500 for activity." };

    const html = renderDashboardHtml(state);

    expect(html).toContain("Symphony connected");
    expect(html).toContain("Active agent sessions");
    expect(html).toContain("Activity");
    expect(html).toContain("HTTP 500");
  });
});

function connectedState(summary: { tokenConfigured: boolean; mutationsRequireToken: boolean | null }): DashboardViewState {
  return {
    connection: {
      kind: "connected",
      baseUrl: "http://127.0.0.1:7331",
      generatedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        runningCount: 1,
        tokenConfigured: summary.tokenConfigured,
        mutationsRequireToken: summary.mutationsRequireToken,
      },
    },
    sections: {
      activeSessions: {
        status: "ready",
        data: {
          sessions: [
            {
              issueIdentifier: "ENG-6",
              issueKey: "issue-1",
              role: "worker",
              statusLabel: "running",
              runId: "run-1",
              detail: "Dashboard implementation",
              workspace: {
                workspaceKey: "ENG-6",
                issueId: "issue-1",
                issueIdentifier: "ENG-6",
                path: "C:\\workspaces\\ENG-6",
                sourceKind: "dogfood",
                branchName: "eng-6",
              },
            },
          ],
        },
      },
      operatorQueues: {
        status: "ready",
        data: {
          running: [],
          paused: [],
          orphaned: [],
          retrying: [],
        },
      },
      board: {
        status: "ready",
        data: {
          generatedAt: "2026-01-01T00:00:00.000Z",
          columns: [{ id: "active", title: "Active", count: 1 }],
          counts: { total: 1, live: 1, paused: 0, blocked: 0 },
          issues: [
            {
              issueIdentifier: "ENG-6",
              issueKey: "issue-1",
              title: "Dashboard implementation",
              state: "In Progress",
              workspace: {
                workspaceKey: "ENG-6",
                issueId: "issue-1",
                issueIdentifier: "ENG-6",
                path: "C:\\workspaces\\ENG-6",
                sourceKind: "dogfood",
                branchName: "eng-6",
              },
            },
          ],
        },
      },
      workspaces: {
        status: "ready",
        data: {
          rows: [
            {
              workspaceKey: "ENG-6",
              issueIdentifier: "ENG-6",
              issueKey: "issue-1",
              path: "C:\\workspaces\\ENG-6",
              sourceKind: "dogfood",
              branchName: "eng-6",
            },
          ],
        },
      },
      activity: { status: "ready", data: { items: [], totalItems: 0 } },
    },
  };
}
