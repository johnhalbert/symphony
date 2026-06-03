import { describe, expect, it } from "vitest";
import {
  WEB_CONTRACT_ISSUE_ID,
  WEB_CONTRACT_SESSION_ID,
  webRouteContractFixturesWithIssueDetail,
  webRouteContractGetFixtureCases,
  webRouteContractPaths,
} from "../web/tests/fixtures/webRouteContractFixtures.js";

describe("web route contract fixtures", () => {
  it("covers the full frontend GET route matrix with stable path and top-level key fixtures", () => {
    expect(webRouteContractGetFixtureCases.map((testCase) => [testCase.name, testCase.path])).toEqual([
      ["reference data", webRouteContractPaths.referenceData],
      ["dashboard", webRouteContractPaths.dashboard],
      ["issue board", webRouteContractPaths.issueBoard],
      ["issue detail", webRouteContractPaths.issueDetail],
      ["history", webRouteContractPaths.history],
      ["transcript", webRouteContractPaths.transcript],
      ["sidebar", webRouteContractPaths.sidebar],
      ["orchestrator chat", webRouteContractPaths.orchestratorChat],
    ]);

    for (const testCase of webRouteContractGetFixtureCases) {
      if (testCase.topLevelKeys === null) {
        expect({ name: testCase.name, arrayFixture: Array.isArray(testCase.fixture) }).toEqual({
          name: testCase.name,
          arrayFixture: true,
        });
        continue;
      }

      expect(Object.keys(testCase.fixture).sort()).toEqual([...testCase.topLevelKeys].sort());
    }
  });

  it("keeps fixture totals, issue detail, sidebar, history, and transcript payloads internally consistent", () => {
    const fixtures = webRouteContractFixturesWithIssueDetail;

    expect(fixtures.dashboard.totals).toEqual(computeTotals(fixtures.issueBoard.issues));
    expect(fixtures.issueBoard.selectedIssueId).toBe(WEB_CONTRACT_ISSUE_ID);
    expect(fixtures.issueBoard.backlog.map((issue) => issue.id)).toEqual(["ENG-176", "ENG-180"]);
    expect(fixtures.issueBoard.lanes.progress.map((issue) => issue.id)).toEqual([WEB_CONTRACT_ISSUE_ID]);
    expect(fixtures.issueBoard.lanes.review.map((issue) => issue.id)).toEqual(["ENG-177"]);

    expect(fixtures.issueDetail.issue).toEqual(fixtures.issueBoard.issues.find((issue) => issue.id === WEB_CONTRACT_ISSUE_ID));
    expect(fixtures.issueDetail.activity).toEqual(fixtures.dashboard.activity);
    expect(fixtures.issueDetail.runs).toEqual(fixtures.history.sessions);
    expect(fixtures.issueDetail.transcript).toEqual(fixtures.transcript);

    expect(fixtures.history.defaultSessionId).toBe(WEB_CONTRACT_SESSION_ID);
    expect(fixtures.history.sessions.map((session) => session.id)).toEqual([WEB_CONTRACT_SESSION_ID]);
    expect(fixtures.transcript.map((message) => message.kind)).toEqual(["system", "user", "assistant", "tool_call"]);

    expect(fixtures.sidebar.providerGates).toEqual(fixtures.dashboard.providerGates);
    expect(fixtures.sidebar.runningAgents).toEqual(fixtures.dashboard.runningAgents);
    expect(fixtures.sidebar.reviewIssues).toEqual(fixtures.issueBoard.lanes.review.slice(0, 3));
    expect(fixtures.sidebar.activity).toEqual(fixtures.dashboard.activity);
    expect(fixtures.sidebar.sessions).toEqual(fixtures.history.sessions);
    expect(fixtures.sidebar.chat).toEqual(fixtures.orchestratorChat.chat);
    expect(fixtures.sidebar.totals).toEqual(fixtures.dashboard.totals);
  });

  it("documents the current web API boundary without legacy session or mock-data endpoints", () => {
    const paths = Object.values(webRouteContractPaths);

    expect(paths).toEqual([
      "/api/v1/web/reference-data",
      "/api/v1/web/dashboard",
      "/api/v1/web/issues",
      `/api/v1/web/issues/${WEB_CONTRACT_ISSUE_ID}`,
      "/api/v1/web/history",
      `/api/v1/web/sessions/${WEB_CONTRACT_SESSION_ID}/transcript`,
      "/api/v1/web/sidebar",
      "/api/v1/web/orchestrator-chat",
    ]);
    expect(paths.every((route) => route.startsWith("/api/v1/web/"))).toBe(true);
    expect(paths).not.toContain("/api/v1/sessions");
    expect(paths).not.toContain("/api/v1/web/mock-data");
  });
});

function computeTotals(issues: readonly { status: string }[]): Record<string, number> {
  const totals = { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 };
  for (const issue of issues) {
    if (!isIssueStatus(issue.status)) continue;
    totals[issue.status] += 1;
  }
  totals.open = totals.backlog + totals.todo + totals.progress + totals.review;
  totals.all = totals.open + totals.done + totals.cancelled;
  totals.completeness = totals.all === 0 ? 0 : Math.round((totals.done / totals.all) * 100);
  return totals;
}

function isIssueStatus(status: string): status is "backlog" | "todo" | "progress" | "review" | "done" | "cancelled" {
  return ["backlog", "todo", "progress", "review", "done", "cancelled"].includes(status);
}
