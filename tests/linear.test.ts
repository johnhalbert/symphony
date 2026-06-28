import { describe, expect, it } from "vitest";
import {
  buildLinearIssueCandidateFilter,
  LinearTrackerClient,
  normalizeIssue,
} from "../src/integrations/linear/LinearTrackerClient.js";
import { testConfig } from "./helpers.js";

describe("LinearTrackerClient", () => {
  it("normalizes issue labels and blockers", () => {
    const normalized = normalizeIssue({
      id: "id",
      identifier: "T-1",
      title: "Title",
      state: { name: "Todo" },
      assignee: { id: "user-1" },
      delegate: { id: "delegate-1" },
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
    expect(normalized?.hasChildren).toBe(false);
    expect(normalized?.assigneeId).toBe("user-1");
    expect(normalized?.delegateId).toBe("delegate-1");
    expect(normalized?.assignedToWorker).toBe(true);
  });

  it("normalizes whether an issue has children", () => {
    const normalized = normalizeIssue({
      id: "id",
      identifier: "T-1",
      title: "Title",
      state: { name: "Todo" },
      children: { nodes: [{ id: "child-1" }] },
    });

    expect(normalized?.hasChildren).toBe(true);
  });

  it("routes to worker when an assignee route matches the assignee", () => {
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

    expect(assigned?.assigneeId).toBe("user-1");
    expect(assigned?.delegateId).toBeNull();
    expect(assigned?.assignedToWorker).toBe(true);
  });

  it("routes to worker when an assignee route matches the delegate", () => {
    const delegated = normalizeIssue(
      {
        id: "id-2",
        identifier: "T-2",
        title: "Title",
        state: { name: "Todo" },
        delegate: { id: "user-1" },
      },
      { matchValues: new Set(["user-1"]) },
    );

    expect(delegated?.assigneeId).toBeNull();
    expect(delegated?.delegateId).toBe("user-1");
    expect(delegated?.assignedToWorker).toBe(true);
  });

  it("does not route to worker when neither assignee nor delegate match the route", () => {
    const unassigned = normalizeIssue(
      {
        id: "id-3",
        identifier: "T-3",
        title: "Title",
        state: { name: "Todo" },
        assignee: { id: "user-2" },
        delegate: { id: "user-3" },
      },
      { matchValues: new Set(["user-1"]) },
    );

    expect(unassigned?.assigneeId).toBe("user-2");
    expect(unassigned?.delegateId).toBe("user-3");
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

  it("paginates issue state lookups by id", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({
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
            pageInfo: {
              hasNextPage: calls === 1,
              endCursor: calls === 1 ? "next-page" : null,
            },
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const issues = await client.fetchIssueStatesByIds(["id-1", "id-2", "id-1"]);

    expect(issues.map((item) => item.identifier)).toEqual(["T-1", "T-2"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("SymphonyIssueStates");
    expect(requests[0]?.variables).toMatchObject({
      ids: ["id-1", "id-2"],
      first: 250,
      after: null,
    });
    expect(requests[1]?.variables.after).toBe("next-page");
  });

  it("builds filtered tick candidate filters with safe label exclusion semantics", () => {
    const filter = buildLinearIssueCandidateFilter(
      {
        branches: [
          {
            id: "active_todo_dispatch",
            stateNames: ["Todo"],
            requireLabels: ["dogfood-ready", "post_mortem"],
            excludeLabels: ["dogfood-blocked"],
            requireAssignedToWorker: true,
            requireNoOpenBlockers: true,
            requireNoChildren: true,
          },
          {
            id: "blocked_triage",
            stateNames: ["Blocked"],
            requireLabels: ["dogfood-ready"],
            excludeLabels: ["dogfood-blocked"],
          },
        ],
      },
      { projectSlug: "TEST", assignee: "me" },
    );

    expect(filter).toEqual({
      and: [
        { project: { slugId: { eq: "TEST" } } },
        {
          or: [
            {
              and: [
                { state: { name: { in: ["Todo"] } } },
                { labels: { name: { eq: "dogfood-ready" } } },
                { labels: { name: { eq: "post_mortem" } } },
                {
                  labels: {
                    every: { name: { nin: ["dogfood-blocked"] } },
                  },
                },
                {
                  or: [
                    { assignee: { isMe: { eq: true } } },
                    { delegate: { isMe: { eq: true } } },
                  ],
                },
                { children: { length: { eq: 0 } } },
              ],
            },
            {
              and: [
                { state: { name: { in: ["Blocked"] } } },
                { labels: { name: { eq: "dogfood-ready" } } },
                {
                  labels: {
                    every: { name: { nin: ["dogfood-blocked"] } },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("fetches filtered tick candidates with configured max page size", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({
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
            pageInfo: {
              hasNextPage: calls === 1,
              endCursor: calls === 1 ? "next-page" : null,
            },
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const issues = await client.fetchIssueCandidatesByFilter({
      branches: [{ id: "todo", stateNames: ["Todo"] }],
    });

    expect(issues.map((item) => item.identifier)).toEqual(["T-1", "T-2"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("SymphonyTickIssueCandidates");
    expect(requests[0]?.variables).toMatchObject({
      first: 250,
      after: null,
      filter: {
        and: [
          { project: { slugId: { eq: "TEST" } } },
          { state: { name: { in: ["Todo"] } } },
        ],
      },
    });
    expect(requests[1]?.variables.after).toBe("next-page");
  });

  it("fetches bounded project workflow states with team identity", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Test Project",
                teams: {
                  nodes: [
                    {
                      id: "team-eng",
                      key: "ENG",
                      name: "Engineering",
                      states: {
                        nodes: [
                          { id: "todo", name: "Todo" },
                          { id: "review", name: "In Review" },
                          { id: "review-duplicate", name: "In Review" },
                        ],
                        pageInfo: pageInfo(),
                      },
                    },
                    {
                      id: "team-ops",
                      key: "OPS",
                      name: null,
                      states: {
                        nodes: [
                          { id: "blocked", name: "Blocked" },
                          { id: "pass", name: "Ready to Merge" },
                        ],
                        pageInfo: pageInfo(),
                      },
                    },
                  ],
                  pageInfo: pageInfo(),
                },
              },
            ],
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).resolves.toEqual([
      {
        teamId: "team-eng",
        teamKey: "ENG",
        teamName: "Engineering",
        states: ["Todo", "In Review"],
      },
      {
        teamId: "team-ops",
        teamKey: "OPS",
        teamName: null,
        states: ["Blocked", "Ready to Merge"],
      },
    ]);
    await expect(client.fetchWorkflowStateNames()).resolves.toEqual(["Todo", "In Review", "Blocked", "Ready to Merge"]);
    expect(requests[0]).toMatchObject({ variables: { projectSlug: "TEST" } });
    expect(JSON.stringify(requests[0])).toContain("projects(first: 1");
    expect(JSON.stringify(requests[0])).toContain("teams(first: 25, after: $teamsAfter)");
    expect(JSON.stringify(requests[0])).toContain("after: $teamsAfter");
    expect(JSON.stringify(requests[0])).toContain("states(first: 100)");
    expect(JSON.stringify(requests[0])).toContain("pageInfo { hasNextPage endCursor }");
    expect(JSON.stringify(requests[0])).toContain("id\\n            key\\n            name");
  });

  it("paginates project teams and team workflow states to exhaustion", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);

      if (request.query.includes("SymphonyTeamWorkflowStates")) {
        return jsonResponse({
          data: {
            team: {
              id: "team-eng",
              key: "ENG",
              name: "Engineering",
              states: {
                nodes: [{ id: "pass", name: "Ready to Merge" }],
                pageInfo: pageInfo(),
              },
            },
          },
        });
      }

      if (request.variables.teamsAfter === "teams-page-2") {
        return jsonResponse({
          data: {
            projects: {
              nodes: [
                {
                  id: "project-1",
                  name: "Test Project",
                  teams: {
                    nodes: [
                      {
                        id: "team-ops",
                        key: "OPS",
                        name: "Operations",
                        states: {
                          nodes: [{ id: "blocked", name: "Blocked" }],
                          pageInfo: pageInfo(),
                        },
                      },
                    ],
                    pageInfo: pageInfo(),
                  },
                },
              ],
            },
          },
        });
      }

      return jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Test Project",
                teams: {
                  nodes: [
                    {
                      id: "team-eng",
                      key: "ENG",
                      name: "Engineering",
                      states: {
                        nodes: [
                          { id: "todo", name: "Todo" },
                          { id: "review", name: "In Review" },
                        ],
                        pageInfo: pageInfo(true, "states-page-2"),
                      },
                    },
                  ],
                  pageInfo: pageInfo(true, "teams-page-2"),
                },
              },
            ],
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).resolves.toEqual([
      {
        teamId: "team-eng",
        teamKey: "ENG",
        teamName: "Engineering",
        states: ["Todo", "In Review", "Ready to Merge"],
      },
      {
        teamId: "team-ops",
        teamKey: "OPS",
        teamName: "Operations",
        states: ["Blocked"],
      },
    ]);
    expect(requests.map((request) => request.variables)).toEqual([
      { projectSlug: "TEST", teamsAfter: null },
      { teamId: "team-eng", statesAfter: "states-page-2" },
      { projectSlug: "TEST", teamsAfter: "teams-page-2" },
    ]);
  });

  it("throws when project team pagination is inconclusive", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Test Project",
                teams: {
                  nodes: [
                    {
                      id: "team-eng",
                      key: "ENG",
                      name: "Engineering",
                      states: {
                        nodes: [{ id: "review", name: "In Review" }],
                        pageInfo: pageInfo(),
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            ],
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow(
      "Linear project TEST teams pagination reported next page without endCursor",
    );
  });

  it("throws when team workflow state pagination is inconclusive", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Test Project",
                teams: {
                  nodes: [
                    {
                      id: "team-eng",
                      key: "ENG",
                      name: "Engineering",
                      states: {
                        nodes: [{ id: "review", name: "In Review" }],
                        pageInfo: { hasNextPage: true, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: pageInfo(),
                },
              },
            ],
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow(
      "Linear team Engineering (ENG) workflow states pagination reported next page without endCursor",
    );
  });

  it("throws when the project workflow state query fails", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () => jsonResponse({ errors: [{ message: "Query too complex" }] });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow("Linear GraphQL errors");
  });

  it("throws when the Linear project is missing", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () => jsonResponse({ data: { projects: { nodes: [] } } });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow("Linear project not found for slug TEST");
  });

  it("throws when the Linear project has no teams", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [{ id: "project-1", name: "Test Project", teams: { nodes: [], pageInfo: pageInfo() } }],
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow("Linear project TEST has no teams");
  });

  it("throws when a Linear team has no workflow states", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Test Project",
                teams: {
                  nodes: [{ id: "team-eng", key: "ENG", name: "Engineering", states: { nodes: [], pageInfo: pageInfo() } }],
                  pageInfo: pageInfo(),
                },
              },
            ],
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow("Linear team Engineering (ENG) has no workflow states");
  });

  it("throws when a Linear team state response is malformed", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [
              {
                id: "project-1",
                name: "Test Project",
                teams: {
                  nodes: [{ id: "team-eng", key: "ENG", name: "Engineering", states: null }],
                  pageInfo: pageInfo(),
                },
              },
            ],
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);

    await expect(client.fetchWorkflowStatesByTeam()).rejects.toThrow(
      "Linear team Engineering (ENG) workflow states are missing from response",
    );
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

  it("verifies already-target transitions without mutating Linear", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "T-1",
            state: { id: "done", name: "Done" },
            team: { states: { nodes: [{ id: "done", name: "Done" }] } },
            comments: { nodes: [] },
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.transitionIssueState({
      issueId: "issue-1",
      fromStates: ["Ready to Merge"],
      toState: "Done",
    });

    expect(result.status).toBe("verified");
    expect(requests).toHaveLength(1);
  });

  it("skips transitions outside allowed source states", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "T-1",
            state: { id: "review", name: "In Review" },
            team: { states: { nodes: [{ id: "done", name: "Done" }] } },
            comments: { nodes: [] },
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.transitionIssueState({
      issueId: "issue-1",
      fromStates: ["Ready to Merge"],
      toState: "Done",
    });

    expect(result.status).toBe("skipped");
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

    expect(result.status).toBe("verified");
  });

  it("creates child issues from planning output with parent linkage and marker", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      if (request.query.includes("SymphonyIssueCreateContext")) {
        return jsonResponse({
          data: {
            issue: {
              id: "issue-1",
              identifier: "T-1",
              team: { id: "team-1", labels: { nodes: [{ id: "label-1", name: "Planning" }] } },
              project: { id: "project-1" },
              children: { nodes: [] },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "child-1", identifier: "T-2", url: "https://linear.test/T-2" },
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.createIssueFromPlan({
      parentIssueId: "issue-1",
      title: "Child issue",
      description: "Build the child.",
      acceptanceCriteria: ["Done"],
      requestedLabels: ["planning"],
      dependencies: [],
      dedupeKey: "plan-1:0",
      payloadHash: "hash-1",
    });

    expect(result.status).toBe("applied");
    expect(result.evidence?.issue).toMatchObject({ id: "child-1", identifier: "T-2" });
    expect(requests[1]?.variables.input).toMatchObject({
      teamId: "team-1",
      projectId: "project-1",
      parentId: "issue-1",
      labelIds: ["label-1"],
    });
    expect(JSON.stringify(requests[1]?.variables.input)).toContain("symphony-issue-breakdown");
  });

  it("blocks child issue creation when requested labels are unresolved", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      return jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "T-1",
            team: { id: "team-1", labels: { nodes: [] } },
            project: { id: "project-1" },
            children: { nodes: [] },
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.createIssueFromPlan({
      parentIssueId: "issue-1",
      title: "Child issue",
      description: "Build the child.",
      acceptanceCriteria: ["Done"],
      requestedLabels: ["planning"],
      dependencies: [],
      dedupeKey: "plan-1:0",
      payloadHash: "hash-1",
    });

    expect(result.status).toBe("skipped");
    expect(result.evidence?.unresolvedLabelNames).toEqual(["planning"]);
    expect(requests).toHaveLength(1);
  });

  it("creates Linear blocker relations idempotently", async () => {
    const config = testConfig("/tmp/symphony");
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      if (request.query.includes("SymphonyIssueRelationContext")) {
        return jsonResponse({
          data: {
            issue: {
              id: "child-1",
              relations: { nodes: [] },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          issueRelationCreate: {
            success: true,
            issueRelation: { id: "relation-1", type: "blocks" },
          },
        },
      });
    };

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.createIssueRelation({
      sourceIssueId: "child-1",
      targetIssueId: "child-2",
      type: "blocks",
      dedupeKey: "relation-key",
      dependency: "Child one",
    });

    expect(result.status).toBe("applied");
    expect(requests[1]?.variables.input).toMatchObject({
      issueId: "child-1",
      relatedIssueId: "child-2",
      type: "blocks",
    });
  });

  it("verifies existing marker-matched child issues", async () => {
    const config = testConfig("/tmp/symphony");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "T-1",
            team: { id: "team-1", labels: { nodes: [] } },
            project: null,
            children: {
              nodes: [
                {
                  id: "child-1",
                  identifier: "T-2",
                  title: "Child issue",
                  description: "<!-- symphony-issue-breakdown:plan-1:0:hash-1 -->",
                  url: "https://linear.test/T-2",
                  parent: { id: "issue-1" },
                },
              ],
            },
          },
        },
      });

    const client = new LinearTrackerClient(config.tracker, fetchImpl);
    const result = await client.createIssueFromPlan({
      parentIssueId: "issue-1",
      title: "Child issue",
      description: "Build the child.",
      acceptanceCriteria: ["Done"],
      requestedLabels: [],
      dependencies: [],
      dedupeKey: "plan-1:0",
      payloadHash: "hash-1",
    });

    expect(result.status).toBe("verified");
    expect(result.evidence?.issueCreateStatus).toBe("verified");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function pageInfo(hasNextPage = false, endCursor: string | null = null): { hasNextPage: boolean; endCursor: string | null } {
  return { hasNextPage, endCursor };
}
