import { describe, expect, it } from "vitest";
import { parseWorkflowFile } from "../src/core/workflow/WorkflowLoader.js";
import {
  multiProjectWorkflowConfig,
  multiProjectWorkflowDocument,
  projectContextFixture,
  trackerClientFixture,
  trackerIssue,
} from "./helpers.js";
import type { TestMultiProjectWorkflowConfig } from "./helpers.js";

describe("test helper fixtures", () => {
  it("builds explicit multi-project workflow config fixtures", () => {
    const config = multiProjectWorkflowConfig();

    expect(config.tracker?.api_key).toBe("$LINEAR_API_KEY");
    expect(config.project_contexts.map((context) => context.id)).toEqual(["symphony", "docs"]);
    expect(config.project_contexts.map((context) => context.tracker?.project_slug)).toEqual(["SYMPHONY", "DOCS"]);
    expect(config.project_contexts[0]?.workspace?.source?.branch_template).toBe(
      "symphony/{{ project.id }}/{{ issue.identifier }}",
    );
  });

  it("composes custom multi-project context arrays without secret-bearing per-context tracker values", () => {
    const config = multiProjectWorkflowConfig({
      projectContexts: [
        projectContextFixture({ id: "api", label: "API", projectSlug: "API", repository: "../api-repo" }),
        projectContextFixture({ id: "docs", label: "Docs", projectSlug: "DOCS", repository: "../docs-site" }),
      ],
    });

    expect(config.tracker?.api_key).toBe("$LINEAR_API_KEY");
    expect(config.project_contexts.map((context) => context.id)).toEqual(["api", "docs"]);
    expect(config.project_contexts.map((context) => context.workspace?.source?.repository)).toEqual([
      "../api-repo",
      "../docs-site",
    ]);
    expect(config.project_contexts.every((context) => context.tracker?.api_key === undefined)).toBe(true);
  });

  it("builds reusable multi-project workflow documents for downstream loader tests", () => {
    const workflow = parseWorkflowFile(
      multiProjectWorkflowDocument({
        projectContexts: [
          projectContextFixture({ id: "api", label: "API", projectSlug: "API", repository: "../api-repo" }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
          }),
        ],
        promptTemplate: "Route {{ issue.identifier }}.",
      }),
      "/repo/WORKFLOW.md",
    );
    const config = workflow.config as TestMultiProjectWorkflowConfig;

    expect(workflow.promptTemplate).toBe("Route {{ issue.identifier }}.");
    expect(config.tracker?.api_key).toBe("$LINEAR_API_KEY");
    expect(config.project_contexts.map((context) => context.id)).toEqual(["api", "docs"]);
    expect(config.project_contexts.every((context) => context.tracker?.api_key === undefined)).toBe(true);
  });

  it("can omit project slugs and workspace sources for negative validation fixtures", () => {
    const context = projectContextFixture({
      id: "broken",
      projectSlug: null,
      workspace: { source: null },
    });

    expect(context.tracker?.project_slug).toBeUndefined();
    expect(context.workspace?.source).toBeUndefined();
  });

  it("builds project-scoped tracker issues with overlapping identifiers", () => {
    const symphonyIssue = trackerIssue({
      id: "issue-symphony",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    expect(symphonyIssue.identifier).toBe(docsIssue.identifier);
    expect(symphonyIssue.projectContextId).not.toBe(docsIssue.projectContextId);
    expect(symphonyIssue.linearProjectIdentity.slug).toBe("SYMPHONY");
    expect(docsIssue.linearProjectIdentity.slug).toBe("DOCS");
  });

  it("builds tracker clients that record routing lookups", async () => {
    const todo = trackerIssue({ id: "issue-todo", state: "Todo" });
    const review = trackerIssue({ id: "issue-review", state: "In Review", routingSource: "state_refresh" });
    const tracker = trackerClientFixture({
      candidates: [todo],
      issues: [todo, review],
    });

    await expect(tracker.fetchCandidateIssues()).resolves.toEqual([todo]);
    await expect(tracker.fetchIssuesByStates(["In Review"])).resolves.toEqual([review]);
    await expect(tracker.fetchIssueStatesByIds(["issue-todo"])).resolves.toEqual([todo]);
    expect(tracker.candidateFetchCount).toBe(1);
    expect(tracker.requestedStates).toEqual([["In Review"]]);
    expect(tracker.requestedIds).toEqual([["issue-todo"]]);
  });
});
