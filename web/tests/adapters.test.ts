import { describe, expect, it } from "vitest";
import { computeTotals, toDashboardModel, toHistoryModel, toIssueBoardModel } from "../src/data/adapters";
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

  it("creates transcripts for each mock session", () => {
    const history = toHistoryModel(raw);

    expect(history.sessions.length).toBeGreaterThan(0);
    expect(history.transcriptBySession[history.defaultSessionId]?.length).toBeGreaterThan(0);
  });
});
