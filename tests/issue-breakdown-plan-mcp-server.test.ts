import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { resolveServiceConfigForProjectContext } from "../src/core/config/ProjectContextServiceConfig.js";
import { submitIssueBreakdownPlanFromMcp, writeIssueBreakdownPlanMcpContext } from "../src/core/harness/IssueBreakdownPlanMcpServer.js";
import { latestFreshIssueBreakdownPlan } from "../src/core/IssueBreakdownPlanService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import {
  agentEligibleIssueContract,
  issue,
  multiProjectWorkflowConfig,
  multiProjectWorkflowDocument,
  projectContextFixture,
} from "./helpers.js";

describe("IssueBreakdownPlan MCP server", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-breakdown-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the resolved project-context issue-breakdown config when persisting plans", async () => {
    const workflowOverrides = {
      topLevel: {
        tracker: {
          api_key: "linear-secret",
        },
        workspace: {
          root: path.join(root, "workspaces"),
          state_dir: path.join(root, "state"),
        },
        issue_breakdown: {
          enabled: true,
          prompt_template: "Default planning prompt for {{ issue.identifier }}",
          planning_labels: ["default-planning"],
          cursor_mode: "agent" as const,
          apply_to_linear: {
            enabled: true,
          },
        },
      },
      projectContexts: [
        projectContextFixture({
          id: "symphony",
          label: "Symphony",
          projectSlug: "SYMPHONY",
          repository: ".",
          tracker: { api_key: "linear-secret" },
        }),
        projectContextFixture({
          id: "docs",
          label: "Documentation Site",
          projectSlug: "DOCS",
          repository: "../docs-site",
          tracker: { api_key: "linear-secret" },
          issue_breakdown: {
            enabled: true,
            prompt_template: "Docs planning prompt for {{ issue.identifier }}",
            planning_labels: ["docs-planning"],
            cursor_mode: "plan" as const,
            apply_to_linear: {
              enabled: false,
            },
          },
        }),
      ],
    };
    const rawWorkflow = multiProjectWorkflowConfig(workflowOverrides);
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, multiProjectWorkflowDocument(workflowOverrides), "utf8");

    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const planningIssue = issue({ id: "issue-docs-plan", identifier: "ENG-179", updatedAt: "2026-01-02T00:00:00Z" });
    const contextFile = path.join(root, "issue-breakdown-context.json");
    await writeIssueBreakdownPlanMcpContext(contextFile, {
      issue: planningIssue,
      projectContext: docsProjectContext,
      activeRunId: "run-docs-plan",
      role: "worker",
      phase: "issue_breakdown",
      workspacePath: null,
      workspace: {
        path: path.join(root, "workspaces", "docs-ENG-179"),
        workspaceKey: "docs:ENG-179",
        createdNow: true,
        issueId: planningIssue.id,
        issueIdentifier: planningIssue.identifier,
      },
    });

    const result = await submitIssueBreakdownPlanFromMcp(
      {
        summary: "Split the docs work into scoped issues.",
        proposedIssues: [
          {
            title: "Write docs planning contract",
            description: agentEligibleIssueContract(),
            acceptanceCriteria: ["Planning data uses the docs project context config."],
            dependencies: [],
            labels: ["docs-planning"],
          },
        ],
        idempotencyKey: "docs-plan-1",
      },
      { workflowPath, contextFile },
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      proposedIssueCount: 1,
    });

    const parsedConfig = parseServiceConfig(rawWorkflow, workflowPath, { LINEAR_API_KEY: "linear-secret" });
    const docsConfig = resolveServiceConfigForProjectContext(parsedConfig, docsProjectContext);
    const lifecycleStore = new FileIssueLifecycleStore(parsedConfig.workspace.stateDir);
    const lifecycle = await lifecycleStore.get(planningIssue.id);

    expect(lifecycle?.projectContext).toMatchObject({ projectContextId: "docs" });
    expect(latestFreshIssueBreakdownPlan(lifecycle, planningIssue, docsConfig)).not.toBeNull();
    expect(latestFreshIssueBreakdownPlan(lifecycle, planningIssue, parsedConfig)).toBeNull();
  });
});
