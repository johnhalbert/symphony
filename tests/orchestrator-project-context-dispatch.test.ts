import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { TokenCounts } from "../src/core/types.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

describe("Orchestrator project-context dispatch prompt/context threading", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-project-context-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it("threads resolved project context into harness contexts for worker, reviewer, issue-breakdown, and merge-conflict flows", async () => {
    const { orchestrator } = await fixture(root);
    const phases = [
      { runPhase: "implementation", role: "worker" },
      { runPhase: "issue_breakdown", role: "worker" },
      { runPhase: "merge_conflict_resolution", role: "worker" },
      { runPhase: "review", role: "reviewer" },
    ] as const;

    for (const phase of phases) {
      const { entry, workspace } = makeEntry(root, phase.runPhase, phase.role);
      const ctx = (orchestrator as any).buildRunContext(entry, workspace, null, 1) as AgentRunContext & {
        issue: AgentRunContext["issue"] & { projectContext?: unknown };
      };
      expect(ctx.projectContext).toMatchObject(docsProjectContext);
      expect(ctx.issue).toEqual(expect.objectContaining({ projectContext: docsProjectContext }));
    }
  });

  it("passes resolved project context into implementation dispatch prompts", async () => {
    const { config, orchestrator } = await fixture(root);
    const docsContext = requireDocsContext(config);
    docsContext.reviewLoop.workerPromptExtensions = ["Docs worker extension."];
    (orchestrator as any).promptTemplate = "Implement {{ issue.projectContext.projectContextId }} for {{ issue.identifier }}";
    const { entry } = makeEntry(root, "implementation", "worker");

    const prompt = await (orchestrator as any).renderWorkerPrompt(entry, null);

    expect(prompt).toContain(`Implement ${docsProjectContext.projectContextId} for TEST-1`);
    expect(prompt).toContain("Service-resolved project context:");
    expect(prompt).toContain(`Project context id: ${docsProjectContext.projectContextId}`);
    expect(prompt).toContain("do not alter, overwrite, or invent project-context values");
    expect(prompt).toContain("Docs worker extension.");
  });

  it("passes resolved project context into issue-breakdown dispatch prompts", async () => {
    const { config, orchestrator } = await fixture(root);
    const docsContext = requireDocsContext(config);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan global for {{ issue.identifier }}";
    docsContext.issueBreakdown.enabled = true;
    docsContext.issueBreakdown.promptTemplate = "Plan {{ issue.projectContext.projectContextId }} for {{ issue.identifier }}";
    const { entry } = makeEntry(root, "issue_breakdown", "worker");

    const prompt = await (orchestrator as any).renderIssueBreakdownPrompt(entry, null);

    expect(prompt).toContain(`Plan ${docsProjectContext.projectContextId} for TEST-1`);
    expect(prompt).not.toContain("Plan global for TEST-1");
    expect(prompt).toContain("Service-resolved project context:");
    expect(prompt).toContain(`Project context id: ${docsProjectContext.projectContextId}`);
  });

  it("passes resolved project context into reviewer dispatch prompts", async () => {
    const { config, orchestrator } = await fixture(root);
    const docsContext = requireDocsContext(config);
    config.reviewLoop.reviewerPromptTemplate = "Review GLOBAL for {{ issue.identifier }}";
    docsContext.reviewLoop.reviewerPromptTemplate = "Review {{ issue.projectContext.projectContextId }} for {{ issue.identifier }}";
    const { entry, workspace } = makeEntry(root, "review", "reviewer");
    const promptIssue = (orchestrator as any).issueWithResolvedProjectContext(entry);
    const runConfig = (orchestrator as any).configForProjectContext((orchestrator as any).resolvedProjectContext(entry));
    const renderedPrompt = await (orchestrator as any).promptRenderer.render((orchestrator as any).reviewerPromptTemplate(runConfig), {
      issue: promptIssue,
      attempt: null,
      role: "reviewer",
      completionReport: undefined,
      acceptanceCriteria: [],
      workspaceEvidence: [],
      validationEvidence: [],
      runDigest: undefined,
      reviewerPromptExtensions: runConfig.reviewLoop.reviewerPromptExtensions,
      workerPromptExtensions: runConfig.reviewLoop.workerPromptExtensions,
    });
    const prompt = (orchestrator as any).formatRenderedReviewerPrompt(
      renderedPrompt,
      (orchestrator as any).renderResolvedProjectContextPrompt(entry),
      {
        issue: promptIssue,
        role: "reviewer",
        workspacePath: workspace.path,
        branchName: workspace.gitBranchName ?? null,
        repoPath: workspace.repoPath ?? null,
        baseRef: workspace.baseRef ?? null,
      },
      runConfig,
    ) as string;

    expect(prompt).toContain(`Review ${docsProjectContext.projectContextId} for TEST-1`);
    expect(prompt).not.toContain("Review GLOBAL for TEST-1");
    expect(prompt).toContain("Service-resolved project context:");
    expect(prompt).toContain(`Project context id: ${docsProjectContext.projectContextId}`);
    expect(prompt).toContain("Symphony MCP review handoff:");
    expect(prompt).toContain("submit_pull_request_review_feedback");
    expect(prompt).toContain("submit_review_verdict before ending the run");
  });

  it("passes resolved project context into merge-conflict dispatch prompts", async () => {
    const { lifecycleStore, orchestrator } = await fixture(root);
    const { entry } = makeEntry(root, "merge_conflict_resolution", "worker");
    await lifecycleStore.ensureIssue(entry.issue, {
      phase: "merge_conflict_resolution",
      projectContext: docsProjectContext,
      mergeConflict: mergeConflictRecord(),
    });

    const prompt = await (orchestrator as any).renderMergeConflictResolutionPrompt(entry);

    expect(prompt).toContain("Service-resolved project context:");
    expect(prompt).toContain(`Project context id: ${docsProjectContext.projectContextId}`);
    expect(prompt).toContain("do not alter, overwrite, or invent project-context values");
    expect(prompt).toContain("Required handoff: call submit_merge_conflict_resolution before ending the run.");
  });
});

async function fixture(root: string) {
  const config = testConfig(root);
  addDocsProjectContext(config);
  const logger = new StructuredLogger(() => undefined);
  const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
  const tracker = idleTracker();
  const harness = new FakeHarness();
  const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
  const orchestrator = new Orchestrator({
    config,
    tracker,
    workspaceManager,
    harness,
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    lifecycleStore,
  });

  return { config, lifecycleStore, orchestrator };
}

function addDocsProjectContext(config: ReturnType<typeof testConfig>): void {
  if (config.projectContexts.byId.has(docsProjectContext.projectContextId)) return;

  const defaultContext = config.projectContexts.defaultContext;
  const docsContext = {
    ...defaultContext,
    id: docsProjectContext.projectContextId,
    label: docsProjectContext.projectContextLabel,
    source: "explicit" as const,
    tracker: {
      ...defaultContext.tracker,
      projectSlug: docsProjectContext.linearProjectSlug,
    },
    reviewLoop: {
      ...config.reviewLoop,
    },
    issueBreakdown: {
      ...config.issueBreakdown,
    },
    agent: {
      ...config.agent,
    },
    publicMetadata: {
      ...defaultContext.publicMetadata,
      id: docsProjectContext.projectContextId,
      label: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    },
    publicSummary: {
      ...defaultContext.publicSummary,
      id: docsProjectContext.projectContextId,
      label: docsProjectContext.projectContextLabel,
      tracker: {
        ...defaultContext.publicSummary.tracker,
        projectSlug: docsProjectContext.linearProjectSlug,
      },
      publicMetadata: {
        ...defaultContext.publicSummary.publicMetadata,
        id: docsProjectContext.projectContextId,
        label: docsProjectContext.projectContextLabel,
        linearProjectSlug: docsProjectContext.linearProjectSlug,
      },
    },
  };

  config.projectContexts.contexts = [...config.projectContexts.contexts, docsContext];
  config.projectContexts.enabledContexts = [...config.projectContexts.enabledContexts, docsContext];
  (config.projectContexts.byId as unknown as Map<string, typeof docsContext>).set(docsContext.id, docsContext);
}

function requireDocsContext(config: ReturnType<typeof testConfig>) {
  const docsContext = config.projectContexts.byId.get(docsProjectContext.projectContextId);
  expect(docsContext).toBeDefined();
  if (!docsContext) throw new Error("Expected docs project context in test fixture");
  return docsContext;
}

function makeEntry(
  root: string,
  runPhase: "implementation" | "issue_breakdown" | "merge_conflict_resolution" | "review",
  role: "worker" | "reviewer",
) {
  const baseIssue = issue({
    description: agentEligibleIssueContract(),
    branchName: "symphony/TEST-1",
  });
  const workspace = {
    path: path.join(root, `${runPhase}-${role}-workspace`),
    workspaceKey: `${runPhase}-${role}-workspace`,
    createdNow: false,
    issueId: baseIssue.id,
    issueIdentifier: baseIssue.identifier,
    gitBranchName: "symphony/TEST-1",
    repoPath: root,
    baseRef: "main",
  };
  const zeroTokens: TokenCounts = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const entry = {
    issue: baseIssue,
    projectContext: docsProjectContext,
    role,
    runPhase,
    workspacePath: workspace.path,
    workspace,
    sessionId: null,
    runId: null,
    activeRunId: null,
    lifecycle: null,
    worker: Promise.resolve(),
    abortController: new AbortController(),
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastEventAt: null,
    lastEvent: null,
    lastMessage: null,
    sdkRunStatus: null,
    sdkRunStatusUpdatedAt: null,
    sdkRunStatusSource: null,
    failureKind: null,
    failureDiagnosticCode: null,
    failureDiagnosticMessage: null,
    failureDiagnosticAt: null,
    failureDiagnosticPayload: undefined,
    turnCount: 0,
    retryAttempt: 0,
    tokens: zeroTokens,
    activeRunTokens: { ...zeroTokens },
    cleanupWorkspaceOnExit: false,
    suppressRetryOnExit: false,
    completionReportAccepted: false,
    mergeConflictResolutionAccepted: false,
    issueBreakdownPlanAccepted: false,
    pullRequestHandoffAccepted: false,
    reviewVerdictAccepted: false,
    reviewEvidence: null,
    cancellationRequestedAt: null,
    cancellationSource: null,
    cancellationReason: null,
    abortSignalledAt: null,
    harnessStopRequestedAt: null,
    harnessStopFailedAt: null,
    harnessStopFailedReason: null,
    lastStreamActivityAt: null,
    lastDeltaOrToolActivityAt: null,
    lastToolActivityAt: null,
    providerLimitSignal: null,
  } as any;

  return { entry, workspace };
}

function mergeConflictRecord() {
  return {
    id: "merge-conflict:issue-1:head-sha-1",
    status: "open" as const,
    resolutionStatus: "pending" as const,
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    approvedHeadSha: "head-sha-1",
    currentHeadSha: "head-sha-1",
    resolvedHeadSha: null,
    baseBranch: "main",
    baseHeadSha: "base-sha-1",
    sourceState: "Ready to Merge",
    conflictsState: "Approved with Conflicts",
    reason: "Pull request has merge conflicts with the base branch",
    mergeableState: "dirty",
    servicePreparation: null,
    detectedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fixTurnCount: 1,
    maxFixTurns: 3,
    lastConflictFixRunId: null,
    lastConflictResolutionReportId: null,
    attemptRunIds: [],
    writebackOperationKeys: [],
    blockedAt: null,
    blockedReason: null,
  };
}

function idleTracker(): TrackerClient {
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
  };
}
