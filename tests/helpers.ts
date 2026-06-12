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
    hasChildren: false,
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
        requirement: "Update the documented docs-only surface with the requested behavior and keep related implementation paths unchanged.",
        proofHint: "Focused validation checks the named docs artifact and confirms no implementation files changed.",
      },
    ],
    touchedSurfaces = ["- [X] Docs only"],
    acceptanceCriteria = ["- Done."],
    contractChecklist = [
      "- Happy path: Requested docs-only change is present in the named artifact.",
      "- Negative/error path: Existing behavior remains documented for unsupported cases.",
      "- Adjacent sibling surface: Related docs section is checked for contradictory guidance.",
      "- Empty/missing/stale/fallback state: N/A because the docs-only fixture has no runtime state.",
      "- Replay/restart/idempotency: N/A because the docs-only fixture has no replayed side effects.",
      "- Credential/security boundary: N/A because the docs-only fixture does not handle credentials.",
      "- Side-effect verification: Confirm only the intended docs artifact changes.",
    ],
    validationRequirements = ["- Run `npm test -- tests/issue-contract-lint.test.ts`."],
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
    "## Out Of Scope",
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
