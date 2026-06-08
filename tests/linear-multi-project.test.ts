import { describe, expect, it } from "vitest";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import { withProjectContextServiceConfig } from "../src/core/config/ProjectContexts.js";
import { MultiProjectLinearTrackerClient } from "../src/integrations/linear/MultiProjectLinearTrackerClient.js";
import type { Issue } from "../src/core/types.js";

function baseIssue(identifier: string, state = "Todo"): Issue {
  return {
    id: `${identifier.toLowerCase()}-id`,
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

  it("builds per-context service config views for the client factory", async () => {
    const config = multiProjectConfig();
    const views = config.projectContexts?.map((context) => withProjectContextServiceConfig(config, context)) ?? [];
    expect(views.map((view) => view.tracker.projectSlug)).toEqual(["ENG", "DOCS"]);
    expect(views.map((view) => view.github.repo)).toEqual([null, null]);
  });
});
