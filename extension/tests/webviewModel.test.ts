import { describe, expect, it } from "vitest";
import type { ActivityFeedResponse, ActivityItem, BoardIssueDetailResponse } from "../src/statusApiTypes";
import { applyExtensionMessage, createInitialDashboardState } from "../src/webviewModel";

describe("webview model reducer", () => {
  it("keeps issue detail visible when issue activity fails", () => {
    const model = createInitialDashboardState();
    model.selectedIssueKey = "ENG-8";
    model.issueEpoch = 1;
    const detail = { issue: "ENG-8" } as BoardIssueDetailResponse;

    applyExtensionMessage(model, {
      type: "issueDetailState",
      issueKey: "ENG-8",
      issueEpoch: 1,
      offset: 0,
      detail,
      activity: null,
      activityError: "activity failed",
    });

    expect(model.issueDetail).toBe(detail);
    expect(model.issueError).toBeNull();
    expect(model.issueActivityError).toBe("activity failed");
  });

  it("ignores stale same-issue detail responses", () => {
    const model = createInitialDashboardState();
    model.selectedIssueKey = "ENG-8";
    model.issueEpoch = 2;

    applyExtensionMessage(model, {
      type: "issueDetailState",
      issueKey: "ENG-8",
      issueEpoch: 1,
      offset: 0,
      detail: { issue: "ENG-8" } as BoardIssueDetailResponse,
      activity: activityPage(0, null, ["old"]),
    });

    expect(model.issueDetail).toBeNull();
    expect(model.issueActivity).toEqual([]);
  });

  it("preserves global history when dashboard refresh omits activity", () => {
    const model = createInitialDashboardState();
    model.globalActivity = [activityItem("a"), activityItem("b")];
    model.globalActivityNextOffset = 50;
    model.activityError = "previous failure";

    applyExtensionMessage(model, {
      type: "dashboardState",
      dashboardGeneration: 1,
      board: null,
      activity: null,
    });

    expect(model.globalActivity.map((item) => item.id)).toEqual(["a", "b"]);
    expect(model.globalActivityNextOffset).toBe(50);
    expect(model.activityError).toBe("previous failure");
  });

  it("reconciles refreshed global activity head while preserving loaded tail", () => {
    const model = createInitialDashboardState();
    model.dashboardGeneration = 1;
    model.globalActivity = [...Array.from({ length: 50 }, (_, index) => activityItem(`old-${index}`)), activityItem("tail-50")];
    model.globalActivityNextOffset = 100;

    applyExtensionMessage(model, {
      type: "dashboardState",
      dashboardGeneration: 1,
      board: null,
      activity: activityPage(0, 50, ["new-0", "old-1"]),
      offset: 0,
      reconcileActivityHead: true,
    });

    expect(model.globalActivity.map((item) => item.id)).toEqual(["new-0", "old-1", "tail-50"]);
    expect(model.globalActivityNextOffset).toBe(100);
    expect(model.activityError).toBeNull();
  });

  it("reconciles issue activity head with the same tail-preserving rules", () => {
    const model = createInitialDashboardState();
    model.selectedIssueKey = "ENG-8";
    model.issueEpoch = 1;
    model.issueActivity = [...Array.from({ length: 50 }, (_, index) => activityItem(`issue-old-${index}`)), activityItem("issue-tail")];
    model.issueActivityNextOffset = 100;

    applyExtensionMessage(model, {
      type: "issueDetailState",
      issueKey: "ENG-8",
      issueEpoch: 1,
      offset: 0,
      detail: null,
      activity: activityPage(0, 50, ["issue-new"]),
      reconcileActivityHead: true,
    });

    expect(model.issueActivity.map((item) => item.id)).toEqual(["issue-new", "issue-tail"]);
    expect(model.issueActivityNextOffset).toBe(100);
  });

  it("rejects global history appends with stale offsets", () => {
    const model = createInitialDashboardState();
    model.dashboardGeneration = 1;
    model.globalActivity = [activityItem("a")];
    model.globalActivityNextOffset = 50;

    applyExtensionMessage(model, {
      type: "dashboardState",
      dashboardGeneration: 1,
      board: null,
      activity: activityPage(100, null, ["wrong"]),
      appendActivity: true,
      offset: 100,
    });

    expect(model.globalActivity.map((item) => item.id)).toEqual(["a"]);
    expect(model.globalActivityNextOffset).toBe(50);
  });

  it("keeps run metadata and transcript events when transcript append fails", () => {
    const model = createInitialDashboardState();
    model.selectedRunId = "run-1";
    model.runEpoch = 1;
    model.runDetail = { runId: "run-1" };
    model.transcript = [{ runId: "run-1", sequence: 1, at: "now", source: "worker", eventType: "message" }];
    model.transcriptNextOffset = 100;

    applyExtensionMessage(model, {
      type: "runState",
      runId: "run-1",
      runEpoch: 1,
      offset: 100,
      run: null,
      transcript: null,
      transcriptError: "transcript failed",
      appendTranscript: true,
    });

    expect(model.runDetail).toEqual({ runId: "run-1" });
    expect(model.runError).toBeNull();
    expect(model.transcript.map((event) => event.sequence)).toEqual([1]);
    expect(model.transcriptNextOffset).toBe(100);
    expect(model.transcriptError).toBe("transcript failed");
  });

  it("ignores stale transcript append failures for old offsets", () => {
    const model = createInitialDashboardState();
    model.selectedRunId = "run-1";
    model.runEpoch = 1;
    model.transcriptNextOffset = 200;

    applyExtensionMessage(model, {
      type: "runState",
      runId: "run-1",
      runEpoch: 1,
      offset: 100,
      run: null,
      transcript: null,
      transcriptError: "old page failed",
      appendTranscript: true,
    });

    expect(model.transcriptError).toBeNull();
    expect(model.transcriptNextOffset).toBe(200);
  });

  it("shows run metadata when the initial transcript page fails", () => {
    const model = createInitialDashboardState();
    model.selectedRunId = "run-1";
    model.runEpoch = 1;

    applyExtensionMessage(model, {
      type: "runState",
      runId: "run-1",
      runEpoch: 1,
      offset: 0,
      run: { runId: "run-1" },
      transcript: null,
      transcriptError: "transcript failed",
    });

    expect(model.runDetail).toEqual({ runId: "run-1" });
    expect(model.runError).toBeNull();
    expect(model.transcriptError).toBe("transcript failed");
  });

  it("clears connection-scoped history and selections on activity scope reset", () => {
    const model = createInitialDashboardState();
    model.globalActivity = [activityItem("a")];
    model.globalActivityNextOffset = 50;
    model.selectedIssueKey = "ENG-8";
    model.issueDetail = { issue: "ENG-8" } as BoardIssueDetailResponse;
    model.selectedRunId = "run-1";
    model.runDetail = { runId: "run-1" };

    applyExtensionMessage(model, { type: "activityScopeReset", scopeKey: "http://example.test" });

    expect(model.globalActivity).toEqual([]);
    expect(model.globalActivityNextOffset).toBeNull();
    expect(model.selectedIssueKey).toBeNull();
    expect(model.issueDetail).toBeNull();
    expect(model.selectedRunId).toBeNull();
    expect(model.runDetail).toBeNull();
  });
});

function activityPage(offset: number, nextOffset: number | null, ids: string[]): ActivityFeedResponse {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    offset,
    limit: 50,
    nextOffset,
    activity: ids.map(activityItem),
    counts: {},
    source: {},
    filter: { issue: null },
  };
}

function activityItem(id: string): ActivityItem {
  return {
    id,
    at: "2026-01-01T00:00:00.000Z",
    kind: "run",
    source: "test",
    issue: null,
    run: { runId: id },
    transcript: null,
    writeback: null,
    links: {},
  };
}

