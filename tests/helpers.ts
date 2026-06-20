import path from "node:path";
import YAML from "yaml";
import type { RawProjectContextConfig, RawWorkflowConfig, ServiceConfig } from "../src/core/config/Config.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
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

type TestTrackerConfig = NonNullable<RawWorkflowConfig["tracker"]>;
type TestWorkspaceConfig = NonNullable<RawWorkflowConfig["workspace"]>;
type TestWorkspaceSourceConfig = NonNullable<NonNullable<TestWorkspaceConfig["source"]>>;
type TestGitHubConfig = NonNullable<RawWorkflowConfig["github"]>;
type TestReviewLoopConfig = NonNullable<RawWorkflowConfig["review_loop"]>;
type TestIssueBreakdownConfig = NonNullable<RawWorkflowConfig["issue_breakdown"]>;
type TestAgentConfig = NonNullable<RawWorkflowConfig["agent"]>;
type TestCredentialProfilesConfig = NonNullable<RawWorkflowConfig["credential_profiles"]>;
type TestProjectContextCredentialProfilesConfig = NonNullable<RawProjectContextConfig["credential_profiles"]>;

export type TestProjectRoutingSource =
  | "candidate_poll"
  | "state_refresh"
  | "legacy_default"
  | "operator_request"
  | "replay";

export interface TestProjectContextFixture {
  [key: string]: unknown;
  id: string;
  label?: string;
  enabled?: boolean;
  tracker?: TestTrackerConfig;
  workspace?: TestWorkspaceConfig;
  github?: TestGitHubConfig;
  review_loop?: TestReviewLoopConfig;
  issue_breakdown?: TestIssueBreakdownConfig;
  agent?: TestAgentConfig;
  credential_profiles?: TestProjectContextCredentialProfilesConfig;
}

export interface TestMultiProjectWorkflowConfig extends RawWorkflowConfig {
  project_contexts: TestProjectContextFixture[];
}

export interface TrackerIssueFixture extends Issue {
  projectContextId: string;
  projectContextLabel: string;
  linearProjectIdentity: {
    kind: "linear";
    slug: string;
    id: string | null;
  };
  routingSource: TestProjectRoutingSource;
  resolvedAt: string;
}

export interface TrackerClientFixture extends TrackerClient {
  candidateFetchCount: number;
  requestedStates: string[][];
  requestedIds: string[][];
}

export interface ProjectContextFixtureOverrides {
  id?: string;
  label?: string;
  enabled?: boolean;
  projectSlug?: string | null;
  workspaceRoot?: string;
  stateDir?: string;
  repository?: string | null;
  baseRef?: string | null;
  branchTemplate?: string | null;
  tracker?: Partial<TestTrackerConfig>;
  workspace?: Omit<Partial<TestWorkspaceConfig>, "source"> & {
    source?: Partial<TestWorkspaceSourceConfig> | null;
  };
  github?: Partial<TestGitHubConfig>;
  review_loop?: Partial<TestReviewLoopConfig>;
  issue_breakdown?: Partial<TestIssueBreakdownConfig>;
  agent?: Partial<TestAgentConfig>;
  credential_profiles?: TestProjectContextCredentialProfilesConfig;
}

export interface MultiProjectWorkflowConfigOverrides {
  projectContexts?: TestProjectContextFixture[];
  topLevel?: Partial<RawWorkflowConfig>;
}

export interface MultiProjectWorkflowDocumentOverrides extends MultiProjectWorkflowConfigOverrides {
  promptTemplate?: string;
}

export interface TrackerIssueFixtureOverrides extends Partial<Issue> {
  projectContextId?: string;
  projectContextLabel?: string;
  linearProjectSlug?: string;
  linearProjectId?: string | null;
  routingSource?: TestProjectRoutingSource;
  resolvedAt?: string;
}

export interface TrackerClientFixtureOptions {
  candidates?: Issue[];
  issues?: Issue[];
}

/**
 * Build a single multi-project workflow context fixture with safe defaults.
 *
 * Downstream tests can override tracker/workspace fields or explicitly omit the
 * project slug and workspace source to exercise negative validation paths
 * without embedding real credential values in fixture data.
 */
export function projectContextFixture(overrides: ProjectContextFixtureOverrides = {}): TestProjectContextFixture {
  const {
    id = "symphony",
    label = titleCaseId(id),
    enabled = true,
    projectSlug,
    workspaceRoot = "./symphony_workspaces",
    stateDir = "./.symphony",
    repository,
    baseRef,
    branchTemplate,
    tracker,
    workspace,
    github,
    review_loop,
    issue_breakdown,
    agent,
    credential_profiles,
  } = overrides;

  const defaultProjectSlug = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const defaultRepository = repository === undefined ? `../${id}-repo` : repository;
  const defaultBaseRef = baseRef === undefined ? "origin/main" : baseRef;
  const defaultBranchTemplate = branchTemplate === undefined ? "symphony/{{ project.id }}/{{ issue.identifier }}" : branchTemplate;

  const trackerFixture: TestTrackerConfig = {
    kind: "linear",
    active_states: ["Todo", "In Progress"],
    ...(projectSlug === null ? {} : { project_slug: projectSlug ?? defaultProjectSlug }),
    ...tracker,
  };

  const workspaceSourceOverrides = workspace?.source;
  const { source: _ignoredWorkspaceSource, ...workspaceWithoutSource } = workspace ?? {};
  const workspaceSourceFixture: TestWorkspaceSourceConfig | undefined =
    workspaceSourceOverrides === null
      ? undefined
      : {
          kind: "git_worktree",
          cleanup: "refuse_dirty",
          ...(defaultRepository === null ? {} : { repository: defaultRepository }),
          ...(defaultBaseRef === null ? {} : { base_ref: defaultBaseRef }),
          ...(defaultBranchTemplate === null ? {} : { branch_template: defaultBranchTemplate }),
          ...workspaceSourceOverrides,
        };

  const workspaceFixture: TestWorkspaceConfig = {
    root: workspaceRoot,
    state_dir: stateDir,
    ...workspaceWithoutSource,
    ...(workspaceSourceFixture === undefined ? {} : { source: workspaceSourceFixture }),
  };

  if (workspaceSourceFixture === undefined) {
    delete workspaceFixture.source;
  }

  return {
    id,
    label,
    enabled,
    tracker: trackerFixture,
    workspace: workspaceFixture,
    ...(github === undefined ? {} : { github: github as TestGitHubConfig }),
    ...(review_loop === undefined ? {} : { review_loop: review_loop as TestReviewLoopConfig }),
    ...(issue_breakdown === undefined ? {} : { issue_breakdown: issue_breakdown as TestIssueBreakdownConfig }),
    ...(agent === undefined ? {} : { agent: agent as TestAgentConfig }),
    ...(credential_profiles === undefined ? {} : { credential_profiles }),
  };
}

/**
 * Build a reusable raw workflow config fixture for multi-project tests.
 *
 * The top-level tracker keeps a placeholder API key token while per-context
 * defaults focus on routing metadata and workspace shape so tests can compose
 * multiple project contexts without introducing secret-bearing values.
 */
export function multiProjectWorkflowConfig(
  overrides: MultiProjectWorkflowConfigOverrides = {},
): TestMultiProjectWorkflowConfig {
  const topLevel = overrides.topLevel ?? {};
  const topLevelWorkspace = topLevel.workspace;
  const topLevelWorkspaceSource = topLevelWorkspace?.source;

  const mergedTracker: RawWorkflowConfig["tracker"] = {
    kind: "linear",
    api_key: "$LINEAR_API_KEY",
    ...topLevel.tracker,
  };

  const mergedWorkspace: RawWorkflowConfig["workspace"] = {
    root: "./symphony_workspaces",
    state_dir: "./.symphony",
    ...topLevelWorkspace,
    source: {
      kind: "git_worktree",
      repository: ".",
      base_ref: "origin/main",
      branch_template: "symphony/{{ issue.identifier }}",
      cleanup: "refuse_dirty",
      ...topLevelWorkspaceSource,
    },
  };

  const mergedPolling: RawWorkflowConfig["polling"] = {
    interval_ms: 60_000,
    ...topLevel.polling,
  };

  const mergedAgent: RawWorkflowConfig["agent"] = {
    max_concurrent_agents: 2,
    max_turns: 1,
    ...topLevel.agent,
  };

  return {
    ...topLevel,
    tracker: mergedTracker,
    workspace: mergedWorkspace,
    polling: mergedPolling,
    agent: mergedAgent,
    project_contexts: overrides.projectContexts ?? [
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({
        id: "docs",
        label: "Documentation Site",
        projectSlug: "DOCS",
        repository: "../docs-site",
      }),
    ],
  };
}

/**
 * Build a reusable WORKFLOW.md fixture for downstream multi-project loader tests.
 *
 * This keeps the top-level API key placeholder in YAML front matter while
 * reusing the safe per-context defaults from multiProjectWorkflowConfig().
 */
export function multiProjectWorkflowDocument(
  overrides: MultiProjectWorkflowDocumentOverrides = {},
): string {
  const {
    promptTemplate = "Work on {{ issue.identifier }}.",
    ...configOverrides
  } = overrides;
  const frontMatter = YAML.stringify(multiProjectWorkflowConfig(configOverrides)).trimEnd();

  return `---\n${frontMatter}\n---\n${promptTemplate}\n`;
}

export function trackerIssue(overrides: TrackerIssueFixtureOverrides = {}): TrackerIssueFixture {
  const projectContextId = overrides.projectContextId ?? "symphony";
  const projectContextLabel = overrides.projectContextLabel ?? titleCaseId(projectContextId);
  const linearProjectSlug = overrides.linearProjectSlug ?? projectContextId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const identifier = overrides.identifier ?? "ENG-1";

  const baseIssue = issue({
    id: overrides.id ?? `issue-${projectContextId}-1`,
    identifier,
    title: overrides.title ?? `${projectContextLabel} work item`,
    description: overrides.description ?? null,
    url: overrides.url ?? `https://linear.app/example/issue/${identifier.toLowerCase()}-${projectContextId}`,
    priority: overrides.priority ?? 1,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName === undefined ? `symphony/${projectContextId}/${identifier}` : overrides.branchName,
    assigneeId: overrides.assigneeId ?? null,
    delegateId: overrides.delegateId ?? null,
    assignedToWorker: overrides.assignedToWorker ?? true,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  });

  return {

    ...baseIssue,
    projectContextId,
    projectContextLabel,
    linearProjectIdentity: {
      kind: "linear",
      slug: linearProjectSlug,
      id: overrides.linearProjectId === undefined ? `linear-project-${projectContextId}` : overrides.linearProjectId,
    },
    routingSource: overrides.routingSource ?? "candidate_poll",
    resolvedAt: overrides.resolvedAt ?? "2026-01-01T00:00:00Z",
  };
}

export function trackerClientFixture(options: TrackerClientFixtureOptions = {}): TrackerClientFixture {
  const candidates = cloneTrackerIssues(options.candidates ?? []);
  const issues = cloneTrackerIssues(options.issues ?? options.candidates ?? []);

  const fixture: TrackerClientFixture = {
    candidateFetchCount: 0,
    requestedStates: [],
    requestedIds: [],
    async fetchCandidateIssues() {
      fixture.candidateFetchCount += 1;
      return cloneTrackerIssues(candidates);
    },
    async fetchIssuesByStates(stateNames: string[]) {
      fixture.requestedStates.push([...stateNames]);
      return cloneTrackerIssues(issues.filter((entry) => stateNames.includes(entry.state)));
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      fixture.requestedIds.push([...issueIds]);
      return cloneTrackerIssues(issues.filter((entry) => issueIds.includes(entry.id)));
    },
  };

  return fixture;
}

function cloneTrackerIssues(entries: readonly Issue[]): Issue[] {
  return entries.map((entry) => ({
    ...entry,
    labels: [...entry.labels],
    blockedBy: entry.blockedBy.map((blocker) => ({ ...blocker })),
    ...(entry.linearProjectIdentity === undefined ? {} : { linearProjectIdentity: { ...entry.linearProjectIdentity } }),
  }));
}

function titleCaseId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
        requirement: "Complete the documented work.",
        proofHint: "Focused validation covers the acceptance criteria.",
      },
    ],
    touchedSurfaces = ["- [X] Docs only"],
    acceptanceCriteria = ["- Done."],
    contractChecklist = ["- Happy path: covered.", "- Negative/error path: covered."],
    validationRequirements = ["- Run the narrow test."],
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
