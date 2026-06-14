import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import {
  IssueInspectionService,
  type IssueInspectionResult,
} from "../src/core/IssueInspectionService.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileOperatorApprovalStore } from "../src/core/approval/OperatorApprovalService.js";
import {
  FileIssueLifecycleStore,
  type IssueCompletionReportRecord,
  type IssueReviewVerdictRecord,
  type IssueTriageReportRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue } from "../src/core/types.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { issue } from "./helpers.js";

describe("IssueInspectionService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-issue-inspect-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it("explains lifecycle gates without clearing stale blocked lifecycle records", async () => {
    const config = inspectionConfig(root);
    const candidate = issue({ state: "Todo" });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      blockedReason: "max reviewer failures reached (3/3)",
      reviewRound: 3,
    });
    const orchestrator = createOrchestrator({ config, issue: candidate, lifecycleStore });

    const result = await orchestrator.inspectManualAgentEligibilityForIssue(candidate, { stage: "worker" });

    expect(result).toMatchObject({
      eligible: true,
      reason: null,
      role: "worker",
      runPhase: "implementation",
    });
    expect(result.explanation).toContain("stale-blocked");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "max reviewer failures reached (3/3)",
      reviewRound: 3,
    });
    await orchestrator.stop();
  });

  it("projects tracker, lifecycle, run, writeback, approval, and stage eligibility metadata", async () => {
    const config = inspectionConfig(root);
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const writebackOutbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    const approvalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
    await runStore.upsertWorkspace({
      workspaceKey: candidate.identifier,
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      path: path.join(config.workspace.root, candidate.identifier),
      sourceKind: "git_worktree",
      gitBranchName: candidate.branchName ?? "symphony/TEST-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-worker-1",
      sessionId: "session-worker-1",
      agentId: "agent-worker-1",
      role: "worker",
      runPhase: "implementation",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(config.workspace.root, candidate.identifier),
    });
    await runStore.updateRun("run-worker-1", {
      status: "succeeded",
      completedAt: "2026-01-01T00:05:00.000Z",
    });
    const completion = completionReport(candidate);
    const review = reviewVerdict(candidate);
    const triage = triageReport(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      blockedReason: "max reviewer failures reached (3/3)",
      reviewRound: 3,
      lastCompletionReportId: completion.id,
      lastReviewVerdictId: review.id,
      lastIssueTriageReportId: triage.id,
      completionReports: [completion],
      reviewVerdicts: [review],
      issueTriageReports: [triage],
      summaryPointers: {
        workspaceKey: candidate.identifier,
        workspacePath: path.join(config.workspace.root, candidate.identifier),
        branchName: candidate.branchName,
        gitBranchName: candidate.branchName,
        repoPath: config.workspace.root,
        baseRef: "origin/main",
        lastRunId: "run-worker-1",
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        prHeadSha: "abc123",
        prBranch: candidate.branchName,
        ciStatus: "pending",
        lastPushedAt: "2026-01-01T00:04:00.000Z",
        lastEvidenceCursor: "cursor-1",
      },
    });
    await writebackOutbox.enqueueOnce({
      idempotencyKey: "comment:triage",
      kind: "comment",
      issueId: candidate.id,
      runId: "run-triage-1",
      payload: {
        body: "## Symphony Issue Triage\n\nRepair implementation.",
        dedupeKey: "triage-comment",
      },
    });
    await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-worker-1",
        evidenceCursor: "cursor-1",
        action: {
          kind: "push_and_pr",
          branchName: "symphony/TEST-1",
          baseBranch: "main",
          workspacePath: path.join(config.workspace.root, candidate.identifier),
          title: "TEST-1: Do work",
          evidenceCursor: "cursor-1",
          summaryPreview: "Ready to publish.",
          changedFiles: ["src/app/http.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      },
      null,
    );
    const orchestrator = createOrchestrator({
      config,
      issue: candidate,
      runStore,
      lifecycleStore,
    });
    const inspector = new IssueInspectionService({
      config,
      tracker: new SingleIssueTracker(candidate),
      lifecycleStore,
      runStore,
      writebackOutbox,
      approvalStore,
      orchestrator,
    });

    const result: IssueInspectionResult = await inspector.inspect(candidate.identifier, {
      stages: ["triage"],
      includeRaw: true,
    });

    expect(result.found).toBe(true);
    expect(result.tracker.status).toBe("found");
    expect(result.lifecycle.summary).toMatchObject({
      phase: "blocked",
      blockedReason: "max reviewer failures reached (3/3)",
      reviewRound: 3,
    });
    expect(result.latest.completionReport).toMatchObject({ id: completion.id, runId: completion.runId });
    expect(result.latest.reviewVerdict).toMatchObject({ id: review.id, verdict: "fail" });
    expect(result.latest.issueTriageReport).toMatchObject({
      id: triage.id,
      disposition: "implementation_repair",
    });
    expect(result.latest.run).toMatchObject({ runId: "run-worker-1", status: "succeeded" });
    expect(result.latest.pendingApproval).toMatchObject({ runId: "run-worker-1", status: "pending" });
    expect(result.writebacks.pendingCount).toBe(1);
    expect(result.eligibility.triage).toMatchObject({
      eligible: true,
      role: "triage",
      runPhase: "issue_triage",
    });
    expect(result.raw?.lifecycle?.issueId).toBe(candidate.id);
    expect(result.raw?.runs).toHaveLength(1);
    await orchestrator.stop();
  });
});

function inspectionConfig(root: string): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Canceled"],
      },
      workspace: {
        root,
      },
      polling: {
        interval_ms: 60_000,
      },
      agent: {
        max_concurrent_agents: 2,
        max_turns: 1,
      },
      review_loop: {
        review_states: ["In Review"],
        blocked_states: ["Blocked"],
        failure_limits: {
          reviewer_failures: 3,
          merge_gate_failures: 3,
        },
      },
      issue_triage: {
        enabled: true,
        max_attempts_per_trigger: 1,
      },
      issue_breakdown: {
        enabled: true,
      },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-test-key" },
  );
}

function createOrchestrator(input: {
  config: ServiceConfig;
  issue: Issue;
  runStore?: FileRunTranscriptStore;
  lifecycleStore: FileIssueLifecycleStore;
}): Orchestrator {
  const logger = new StructuredLogger(() => undefined);
  const runStore = input.runStore ?? new FileRunTranscriptStore(input.config.workspace.stateDir);
  return new Orchestrator({
    config: input.config,
    tracker: new SingleIssueTracker(input.issue),
    workspaceManager: new WorkspaceManager({ workspace: input.config.workspace, hooks: input.config.hooks, logger }),
    harness: new FakeHarness(),
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    runStore,
    lifecycleStore: input.lifecycleStore,
    statusServerBaseUrl: () => null,
    statusMutationToken: null,
  });
}

class SingleIssueTracker implements TrackerClient {
  constructor(private readonly candidate: Issue | null) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.candidate ? [this.candidate] : [];
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.candidate && states.some((state) => state.toLowerCase() === this.candidate?.state.toLowerCase())
      ? [this.candidate]
      : [];
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (!this.candidate) return [];
    return issueIds.some(
      (id) =>
        id.toLowerCase() === this.candidate?.id.toLowerCase() ||
        id.toLowerCase() === this.candidate?.identifier.toLowerCase(),
    )
      ? [this.candidate]
      : [];
  }
}

function completionReport(candidate: Issue): IssueCompletionReportRecord {
  return {
    id: `completion-report:${candidate.id}:1`,
    idempotencyKey: "completion-1",
    runId: "run-worker-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    summary: "Implemented the requested behavior.",
    validationEvidence: ["npm test -- tests/status-api.test.ts"],
    acceptanceChecklist: [
      {
        text: "Requirement is satisfied.",
        satisfied: true,
        evidence: "Focused test passed.",
      },
    ],
    changedFiles: ["src/app/http.ts"],
    branchName: candidate.branchName,
    pullRequest: {
      url: "https://github.com/acme/repo/pull/7",
      number: 7,
      headSha: "abc123",
      branch: candidate.branchName,
    },
    risks: [],
    acceptedAt: "2026-01-01T00:05:00.000Z",
    writebackOperationKeys: [],
  };
}

function reviewVerdict(candidate: Issue): IssueReviewVerdictRecord {
  return {
    id: `review-verdict:${candidate.id}:1`,
    idempotencyKey: "review-1",
    runId: "run-reviewer-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    verdict: "fail",
    acceptanceResults: [
      {
        text: "Requirement is satisfied.",
        satisfied: false,
        evidence: "Missing fallback case.",
      },
    ],
    findings: ["Missing fallback case."],
    gateFindings: [
      {
        summary: "Missing fallback case.",
        requirementIds: ["REQ-001"],
        contractAnchor: "Issue Contract",
        scenario: "fallback",
        scenarioEntitlement: "explicit_requirement",
        observedFailure: "The API returns the default workspace.",
        currentIssueOwnership: "Owned by TEST-1.",
        boundedRepair: "Return not_found for the fallback case.",
        evidence: ["tests/status-api.test.ts"],
      },
    ],
    discoveryFindings: [],
    evidence: ["npm test -- tests/status-api.test.ts"],
    reviewer: "reviewer",
    submittedAt: "2026-01-01T00:10:00.000Z",
    writebackOperationKeys: [],
  };
}

function triageReport(candidate: Issue): IssueTriageReportRecord {
  return {
    id: `issue-triage-report:${candidate.id}:1`,
    idempotencyKey: "triage-1",
    requestHash: "request-hash-1",
    runId: "run-triage-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    triggerFingerprint: "trigger-1",
    disposition: "implementation_repair",
    confidence: "high",
    summary: "The worker needs a focused implementation repair.",
    evidence: ["Latest review verdict failed."],
    recommendedAction: "Repair the fallback behavior and rerun focused tests.",
    blockers: [
      {
        kind: "implementation_unsatisfied_requirements",
        status: "active",
        nextActor: "worker",
        confidence: "high",
        summary: "Fallback behavior remains wrong.",
        evidence: ["Review verdict run-reviewer-1."],
        recommendedAction: "Repair fallback behavior.",
      },
    ],
    submittedAt: "2026-01-01T00:15:00.000Z",
    writebackOperationKeys: [],
  };
}
