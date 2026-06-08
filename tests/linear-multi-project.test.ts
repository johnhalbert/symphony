import { describe, expect, it } from "vitest";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import { withProjectContextServiceConfig } from "../src/core/config/ProjectContexts.js";
import { MultiProjectLinearTrackerClient } from "../src/integrations/linear/MultiProjectLinearTrackerClient.js";
import type { Issue } from "../src/core/types.js";

function baseIssue(identifier: string, state = "Todo", id = `${identifier.toLowerCase()}-id`): Issue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    priority: null,
    state,
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function multiProjectConfig(): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "DEFAULT" },
      workspace: {
        source: { kind: "git_worktree", repository: ".", base_ref: "origin/main" },
      },
      project_contexts: [
        { id: "symphony", tracker: { project_slug: "ENG" } },
        { id: "docs", tracker: { project_slug: "DOCS" } },
      ],
    },
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "secret" },
  );
}

describe("MultiProjectLinearTrackerClient", () => {
  it("aggregates and decorates candidate issues across configured project contexts", async () => {
    const config = multiProjectConfig();
    const client = new MultiProjectLinearTrackerClient(config, (contextConfig) => {
      const slug = contextConfig.tracker.projectSlug;
      return {
        async fetchCandidateIssues() {
          return [baseIssue(`${slug}-1`)];
        },
        async fetchIssuesByStates(stateNames: string[]) {
          return [baseIssue(`${slug}-${stateNames[0]}`, stateNames[0] ?? "Todo")];
        },
        async fetchIssueStatesByIds(issueIds: string[]) {
          return issueIds.map((issueId) => baseIssue(`${slug}-${issueId}`));
        },
        async fetchWorkflowStatesByTeam() {
          return [{ teamId: slug, teamKey: slug, teamName: slug, states: ["Todo", "In Review"] }];
        },
        async transitionIssueState() {
          return { status: "applied" as const };
        },
        async createIssueComment() {
          return { status: "applied" as const };
        },
      } as never;
    });

    const issues = await client.fetchCandidateIssues();
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identifier: "ENG-1", projectContextId: "symphony", trackerProjectSlug: "ENG" }),
        expect.objectContaining({ identifier: "DOCS-1", projectContextId: "docs", trackerProjectSlug: "DOCS" }),
      ]),
    );
  });

  it("drops ambiguous candidate issues that resolve to multiple project contexts", async () => {
    const config = multiProjectConfig();
    const client = new MultiProjectLinearTrackerClient(config, () => ({
      async fetchCandidateIssues() {
        return [baseIssue("ENG-1", "Todo", "shared-issue-id")];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchWorkflowStatesByTeam() {
        return [];
      },
      async transitionIssueState() {
        return { status: "applied" as const };
      },
      async createIssueComment() {
        return { status: "applied" as const };
      },
    }) as never);

    await expect(client.fetchCandidateIssues()).resolves.toEqual([]);
  });

  it("fails closed when a direct issue refresh is ambiguous across project contexts", async () => {
    const config = multiProjectConfig();
    const client = new MultiProjectLinearTrackerClient(config, () => ({
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [baseIssue("ENG-1", "Todo", "shared-issue-id")];
      },
      async fetchWorkflowStatesByTeam() {
        return [];
      },
      async transitionIssueState() {
        return { status: "applied" as const };
      },
      async createIssueComment() {
        return { status: "applied" as const };
      },
    }) as never);

    await expect(client.fetchIssueStatesByIds(["shared-issue-id"])).rejects.toThrow(/Ambiguous project context resolution/);
  });

  it("routes tracker writes through the resolved project context and rejects missing context in multi-project mode", async () => {
    const config = multiProjectConfig();
    const calls: string[] = [];
    const client = new MultiProjectLinearTrackerClient(config, (contextConfig) => {
      const slug = contextConfig.tracker.projectSlug;
      return {
        async fetchCandidateIssues() {
          return [];
        },
        async fetchIssuesByStates() {
          return [];
        },
        async fetchIssueStatesByIds() {
          return [];
        },
        async fetchWorkflowStatesByTeam() {
          return [];
        },
        async transitionIssueState(input: { projectContextId?: string | null }) {
          calls.push(`transition:${slug}:${input.projectContextId}`);
          return { status: "applied" as const };
        },
        async createIssueComment(input: { projectContextId?: string | null }) {
          calls.push(`comment:${slug}:${input.projectContextId}`);
          return { status: "applied" as const };
        },
        async createIssueFromPlan(input: { projectContextId?: string | null }) {
          calls.push(`create:${slug}:${input.projectContextId}`);
          return { status: "applied" as const };
        },
        async createIssueRelation(input: { projectContextId?: string | null }) {
          calls.push(`relation:${slug}:${input.projectContextId}`);
          return { status: "applied" as const };
        },
      } as never;
    });

    await client.transitionIssueState({ issueId: "issue-1", projectContextId: "symphony", toState: "In Progress" });
    await client.createIssueComment({ issueId: "issue-1", projectContextId: "docs", body: "hello", dedupeKey: "comment-1" });
    await client.createIssueFromPlan({
      parentIssueId: "issue-1",
      projectContextId: "docs",
      title: "Child",
      description: "desc",
      acceptanceCriteria: [],
      requestedLabels: [],
      dependencies: [],
      dedupeKey: "create-1",
      payloadHash: "hash-1",
    });
    await client.createIssueRelation({
      sourceIssueId: "issue-1",
      targetIssueId: "issue-2",
      projectContextId: "symphony",
      type: "blocks",
      dedupeKey: "relation-1",
      dependency: "Child",
    });

    expect(calls).toEqual([
      "transition:ENG:symphony",
      "comment:DOCS:docs",
      "create:DOCS:docs",
      "relation:ENG:symphony",
    ]);

    expect(() => client.createIssueComment({ issueId: "issue-1", body: "oops", dedupeKey: "comment-2" })).toThrow(
      /requires an explicit project context/,
    );
  });

  it("builds per-context service config views for the client factory", async () => {
    const config = multiProjectConfig();
    const views = config.projectContexts?.map((context) => withProjectContextServiceConfig(config, context)) ?? [];
    expect(views.map((view) => view.tracker.projectSlug)).toEqual(["ENG", "DOCS"]);
    expect(views.map((view) => view.github.repo)).toEqual([null, null]);
  });
});
