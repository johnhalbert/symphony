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
    includeIssueContract?: boolean;
    issueContractJson?: string;
    issueContractFenceLanguage?: string;
    issueContractSchemaVersion?: number;
    issueContractContractVersion?: string;
    issueContractRequirements?: Array<{
      id: string;
      requirement: string;
      proofHint?: string;
    }>;
    touchedSurfaces?: string[];
    acceptanceCriteria?: string[];
    contractChecklist?: string[];
    validationRequirements?: string[];
    outOfScopeHeading?: string;
    outOfScope?: string[];
    readyForDogfoodReady?: "yes" | "no";
    remainingBlocker?: string;
  } = {},
): string {
  const {
    problemGoal = "Do the work.",
    includeIssueContract = true,
    issueContractJson,
    issueContractFenceLanguage = "json",
    issueContractSchemaVersion = 1,
    issueContractContractVersion = "2026-06-04.1",
    issueContractRequirements = [
      {
        id: "REQ-001",
        requirement: "Complete the documented work.",
        proofHint: "Focused validation covers the acceptance criteria.",
      },
    ],
    touchedSurfaces = ["- [X] Docs only"],
    acceptanceCriteria = ["- Done."],
    contractChecklist = ["- Happy path: covered.", "- Negative/error path: covered."],
    validationRequirements = ["- Run the narrow test."],
    outOfScopeHeading = "Out Of Scope",
    outOfScope = ["- Nothing else."],
    readyForDogfoodReady = "yes",
    remainingBlocker = readyForDogfoodReady === "yes" ? "none" : "Manual operator implementation required.",
  } = overrides;

  const renderedIssueContractJson =
    issueContractJson ??
    JSON.stringify(
      {
        schemaVersion: issueContractSchemaVersion,
        contractVersion: issueContractContractVersion,
        requirements: issueContractRequirements,
      },
      null,
      2,
    );

  return [
    "## Problem / Goal",
    problemGoal,
    "",
    ...(includeIssueContract
      ? ["## Issue Contract", "", "```" + issueContractFenceLanguage, renderedIssueContractJson, "```", ""]
      : []),
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
    `## ${outOfScopeHeading}`,
    ...outOfScope,
    "",
    "## Promotion Readiness",
    `- Ready for \`dogfood-ready\`: ${readyForDogfoodReady}`,
    `- Remaining blocker: ${remainingBlocker}`,
  ].join("\n");
}

export function fencedAuthoringSectionSpoof(
  overrides: Parameters<typeof agentEligibleIssueContract>[0] = {},
): string {
  const lines = agentEligibleIssueContract(overrides).split("\n");
  const secondHeadingIndex = lines.findIndex((line, index) => index > 0 && line.startsWith("## "));
  if (secondHeadingIndex === -1) return lines.join("\n");

  return [...lines.slice(0, secondHeadingIndex), "````md", ...lines.slice(secondHeadingIndex), "````"].join("\n");
}

export function nestedFencedIssueContractSpoof(
  overrides: Parameters<typeof agentEligibleIssueContract>[0] = {},
): string {
  const lines = agentEligibleIssueContract(overrides).split("\n");
  const issueContractHeadingIndex = lines.findIndex((line) => line === "## Issue Contract");
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > issueContractHeadingIndex && line.startsWith("## "),
  );
  if (issueContractHeadingIndex === -1 || nextHeadingIndex === -1) return lines.join("\n");

  const issueContractBody = lines.slice(issueContractHeadingIndex + 1, nextHeadingIndex);
  const trimmedBody =
    issueContractBody[0]?.trim().length === 0 ? issueContractBody.slice(1) : issueContractBody;

  return [
    ...lines.slice(0, issueContractHeadingIndex + 1),
    "",
    "````md",
    ...trimmedBody,
    "````",
    "",
    ...lines.slice(nextHeadingIndex),
  ].join("\n");
}
