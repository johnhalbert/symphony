import path from "node:path";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { Issue } from "../src/core/types.js";

export function testConfig(workspaceRoot: string): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
      },
      workspace: {
        root: workspaceRoot,
      },
      polling: {
        interval_ms: 60_000,
      },
      agent: {
        max_concurrent_agents: 2,
        max_turns: 1,
      },
    },
    path.join(workspaceRoot, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-test-key" },
  );
}

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Do work",
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function agentEligibleIssueContract(
  overrides: {
    problemGoal?: string;
    touchedSurfaces?: string[];
    acceptanceCriteria?: string[];
    contractChecklist?: string[];
    validationRequirements?: string[];
    outOfScope?: string[];
    readyForDogfoodReady?: "yes" | "no";
    remainingBlocker?: string;
  } = {},
): string {
  const {
    problemGoal = "Do the work.",
    touchedSurfaces = ["- [X] Docs only"],
    acceptanceCriteria = ["- Done."],
    contractChecklist = ["- Happy path: covered.", "- Negative/error path: covered."],
    validationRequirements = ["- Run the narrow test."],
    outOfScope = ["- Nothing else."],
    readyForDogfoodReady = "yes",
    remainingBlocker = readyForDogfoodReady === "yes" ? "none" : "Manual operator implementation required.",
  } = overrides;

  return [
    "## Problem / Goal",
    problemGoal,
    "",
    "## Touched Surfaces",
    ...touchedSurfaces,
    "",
    "## Acceptance Criteria",
    ...acceptanceCriteria,
    "",
    "## Contract Checklist",
    ...contractChecklist,
    "",
    "## Validation Requirements",
    ...validationRequirements,
    "",
    "## Out Of Scope",
    ...outOfScope,
    "",
    "## Promotion Readiness",
    `- Ready for \`dogfood-ready\`: ${readyForDogfoodReady}`,
    `- Remaining blocker: ${remainingBlocker}`,
  ].join("\n");
}
