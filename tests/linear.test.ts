import { describe, expect, it } from "vitest";
import { LinearTrackerClient, normalizeIssue } from "../src/integrations/linear/LinearTrackerClient.js";
import { testConfig } from "./helpers.js";

describe("LinearTrackerClient", () => {
  it("normalizes issue labels and blockers", () => {
    const normalized = normalizeIssue({
      id: "id",
      identifier: "T-1",
      title: "Title",
      state: { name: "Todo" },
      assignee: { id: "user-1" },
      labels: { nodes: [{ name: "Bug" }] },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: { id: "other", identifier: "T-0", state: { name: "In Progress" } },
          },
        ],
      },
    });

    expect(normalized?.labels).toEqual(["bug"]);
    expect(normalized?.blockedBy[0]?.identifier).toBe("T-0");
    expect(normalized?.assigneeId).toBe("user-1");
    expect(normalized?.assignedToWorker).toBe(true);
  });

  it("filters assignment when an assignee route is configured", () => {
    const assigned = normalizeIssue(
      {
        id: "id",
        identifier: "T-1",
        title: "Title",
        state: { name: "Todo" },
        assignee: { id: "user-1" },
      },
      { matchValues: new Set(["user-1"]) },
    );
    const unassigned = normalizeIssue(
      {
        id: "id-2",
        identifier: "T-2",
        title: "Title",
        state: { name: "Todo" },
        assignee: { id: "user-2" },
      },
      { matchValues: new Set(["user-1"]) },
    );

    expect(assigned?.assignedToWorker).toBe(true);
    expect(unassigned?.assignedToWorker).toBe(false);
  });

  it("paginates candidate issue queries", async () => {
    const config = testConfig("/tmp/symphony");
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: `id-${calls}`,
                  identifier: `T-${calls}`,
                  title: "Title",
                  state: { name: "Todo" },
                },
              ],
              pageInfo: { hasNextPage: calls === 1, endCursor: calls === 1 ? "next" : null },
            },
          },
        }),
        { status: 200 },
      );
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const issues = await client.fetchCandidateIssues();

    expect(issues.map((item) => item.identifier)).toEqual(["T-1", "T-2"]);
  });
});
