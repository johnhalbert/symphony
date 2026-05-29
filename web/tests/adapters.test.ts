import { describe, expect, it } from "vitest";
import { computeTotals, toDashboardModel, toHistoryModel, toIssueBoardModel, toIssueDetailModel } from "../src/data/adapters";
import { mockSymphonyData } from "../src/data/mockData";
import type { IssueModel } from "../src/types/symphony";

const raw = mockSymphonyData as unknown as Parameters<typeof toDashboardModel>[0];

describe("design-system data adapters", () => {
  it("computes dashboard totals from issue status counts", () => {
    const totals = computeTotals(raw.issues);

    expect(totals.all).toBe(raw.issues.length);
    expect(totals.open).toBe(totals.backlog + totals.todo + totals.progress + totals.review);
    expect(totals.completeness).toBeGreaterThan(0);
  });

  it("sorts backlog by priority for the issue board", () => {
    const board = toIssueBoardModel(raw);
    const weights = board.backlog.map((issue: IssueModel) => (issue.priority === "urgent" ? 4 : issue.priority));

    expect(board.selectedIssueId).toBe("SYM-12");
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it("maps issue detail mock data to the server detail shape", () => {
    const detail = toIssueDetailModel(raw, "SYM-12");

    expect(detail?.issue.id).toBe("SYM-12");
    expect(detail?.activity).toEqual(raw.activity.filter((item) => item.id === "SYM-12"));
    expect(detail?.runs.map((session) => session.id)).toEqual(["sess_01HZ8…b4f"]);
    expect(detail?.transcript.length).toBeGreaterThan(0);
    expect(toIssueDetailModel(raw, "MISSING")).toBeNull();
  });

  it("creates transcripts for each mock session", () => {
    const history = toHistoryModel(raw);

    expect(history.sessions.length).toBeGreaterThan(0);
    expect(history.transcriptBySession[history.defaultSessionId]?.length).toBeGreaterThan(0);
  });
});
