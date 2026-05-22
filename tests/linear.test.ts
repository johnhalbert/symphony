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

  it("fetches unique project workflow state names for doctor validation", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                teams: {
                  nodes: [
                    {
                      states: {
                        nodes: [
                          { id: "todo", name: "Todo" },
                          { id: "review", name: "In Review" },
                        ],
                      },
                    },
                    {
                      states: {
                        nodes: [
                          { id: "review-duplicate", name: "In Review" },
                          { id: "blocked", name: "Blocked" },
                          { id: "pass", name: "Ready to Merge" },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStateNames()).resolves.toEqual([
      "Todo",
      "In Review",
      "Blocked",
      "Ready to Merge",
    ]);
    expect(requests[0]).toMatchObject({ variables: { projectSlug: "TEST" } });
  });

  it("transitions issue state by resolving Linear state ids", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return jsonResponse({
          data: {
            issue: {
              id: "issue-1",
              identifier: "T-1",
              state: { id: "todo", name: "Todo" },
              team: { states: { nodes: [{ id: "progress", name: "In Progress" }] } },
              comments: { nodes: [] },
            },
          },
        });
      }
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.transitionIssueState({
      issueId: "issue-1",
      fromStates: ["Todo"],
      toState: "In Progress",
    });

    expect(result.status).toBe("applied");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ variables: { id: "issue-1", stateId: "progress" } });
  });

  it("deduplicates comments with hidden writeback markers", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "T-1",
            state: { id: "todo", name: "Todo" },
            team: { states: { nodes: [] } },
            comments: { nodes: [{ id: "comment-1", body: "<!-- symphony-writeback:run-1:run-started -->" }] },
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.createIssueComment({
      issueId: "issue-1",
      body: "Run started",
      dedupeKey: "run-1:run-started",
    });

    expect(result.status).toBe("skipped");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
