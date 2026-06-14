import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import { resolveStatusMutationToken } from "../src/app/RuntimeDependencies.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
} from "../src/core/config/ProjectContexts.js";
import {
  FileIssueLifecycleStore,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileMcpExposureDiagnosticsStore } from "../src/core/persistence/McpExposureDiagnosticsStore.js";
import { FileRunTranscriptStore, type RunRecord } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { SymphonyError } from "../src/core/errors.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import type { Issue, IssueDetailsEnvelope, IssueStatusView, TrackerStateLists } from "../src/core/types.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { issue, multiProjectWorkflowConfig, testConfig, trackerClientFixture, trackerIssue } from "./helpers.js";

describe("StatusServer durable API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-http-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function stripPersistedProjectContext(filePath: string): Promise<void> {
    const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete record.projectContext;
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  it("serves durable issue, run, transcript, and workspace records", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.upsertWorkspace({
      workspaceKey: "TEST-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      path: path.join(config.workspace.root, "TEST-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: path.join(config.workspace.root, "TEST-1"),
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    await runStore.appendEvent({
      runId: "run-1",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "hello",
    });
    await runStore.recordPullRequestEvent({
      runId: "run-1",
      action: "updated",
      at: "2026-01-01T00:00:01.000Z",
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      lastPushedAt: "2026-01-01T00:00:00.500Z",
    });
    await runStore.recordCiStatusEvent({
      runId: "run-1",
      at: "2026-01-01T00:00:02.000Z",
      ciStatus: "success",
    });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(
      { id: "issue-1", identifier: "TEST-1" },
      {
        phase: "review",
        reviewRound: 1,
        incompleteTurnCount: 0,
        lastCompletionReportId: "completion-report:issue-1:report-1",
        lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
        blockedReason: null,
        summaryPointers: {
          workspaceKey: "TEST-1",
          workspacePath: path.join(config.workspace.root, "TEST-1"),
          branchName: "symphony/TEST-1",
          gitBranchName: "symphony/TEST-1",
          repoPath: "/repo",
          baseRef: "origin/main",
          lastRunId: "run-1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prNumber: 7,
          ciStatus: "success",
          lastPushedAt: "2026-01-01T00:00:00.500Z",
        },
        merge: {
          id: "merge:issue-1:head-sha-1",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/7",
            number: 7,
            headSha: "head-sha-1",
            branch: "symphony/TEST-1",
          },
          headSha: "head-sha-1",
          mergeCommitSha: "merge-sha-1",
          mergedAt: "2026-01-01T00:00:06.000Z",
          mergedBy: { login: "symphony-bot", profile: "github-merge", capability: "github.merge" },
          checkStatus: { requiredChecks: ["test"], passedChecks: ["test"], noCiEvidence: null },
          mergeOperationKey: "github-merge:issue-1:7:head-sha-1",
          doneTransitionOperationKey: "transition:issue-1:merge:issue-1:head-sha-1:Done",
        },
        mergeGate: {
          id: "merge-gate:issue-1:pr-7:head-sha-1",
          status: "repair_dispatched",
          headSha: "head-sha-1",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/7",
            number: 7,
            headSha: "head-sha-1",
            branch: "symphony/TEST-1",
          },
          requiredChecks: ["test", "typecheck"],
          checks: [
            {
              name: "test",
              outcome: "failing",
              rawStatus: "failure",
              conclusion: "failure",
              url: "https://ci.test/test",
              firstObservedAt: null,
              actionableSince: null,
            },
            {
              name: "typecheck",
              outcome: "missing_actionable",
              rawStatus: "missing",
              conclusion: null,
              url: null,
              firstObservedAt: "2026-01-01T00:00:01.000Z",
              actionableSince: "2026-01-01T00:05:01.000Z",
            },
          ],
          mergeability: null,
          reviewRound: 2,
          gateRunId: "run-1",
          gateReportId: "completion-report:issue-1:report-1",
          repairRunId: "repair-run-1",
          repairReportId: "completion-report:issue-1:repair-1",
          blockerFingerprint: "head-sha-1:test:failure|typecheck:missing",
          writebackOperationKeys: ["comment:issue-1:merge-gate"],
          supersededByHeadSha: null,
          updatedAt: "2026-01-01T00:05:01.000Z",
        },
        mergeConflict: {
          id: "merge-conflict:issue-1:head-sha-1",
          status: "open",
          resolutionStatus: "still_conflicted",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/7",
            number: 7,
            headSha: "head-sha-1",
            branch: "symphony/TEST-1",
          },
          approvedHeadSha: "head-sha-0",
          currentHeadSha: "head-sha-1",
          resolvedHeadSha: null,
          baseBranch: "main",
          baseHeadSha: "base-sha-1",
          sourceState: "Ready to Merge",
          conflictsState: "Approved with Conflicts",
          reason: "Pull request has merge conflicts with the base branch",
          mergeableState: "dirty",
          detectedAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.500Z",
          fixTurnCount: 1,
          maxFixTurns: 3,
          lastConflictFixRunId: "conflict-run-1",
          lastConflictResolutionReportId: "merge-conflict-resolution:issue-1:still-1",
          attemptRunIds: ["conflict-run-1"],
          writebackOperationKeys: [],
          blockedAt: null,
          blockedReason: null,
        },
        completionReports: [
          {
            id: "completion-report:issue-1:report-1",
            idempotencyKey: "report-1",
            runId: "run-1",
            issueId: "issue-1",
            issueIdentifier: "TEST-1",
            summary: "Implemented the status surface.",
            validationEvidence: ["npm test -- tests/status-api.test.ts"],
            acceptanceChecklist: [{ text: "Status exposes review-loop fields.", satisfied: true, evidence: "API response" }],
            changedFiles: ["src/app/http.ts"],
            branchName: "symphony/TEST-1",
            pullRequest: null,
            risks: [],
            acceptedAt: "2026-01-01T00:00:03.000Z",
            writebackOperationKeys: [],
          },
        ],
        reviewVerdicts: [
          {
            id: "review-verdict:issue-1:verdict-1",
            idempotencyKey: "verdict-1",
            runId: "review-run-1",
            issueId: "issue-1",
            issueIdentifier: "TEST-1",
            verdict: "fail",
            acceptanceResults: [{ text: "Reviewer pass is present.", satisfied: false, evidence: "No pass yet." }],
            findings: ["Add reviewer pass evidence."],
            evidence: ["https://github.com/acme/repo/pull/7#discussion_r1"],
            reviewer: "reviewer-1",
            submittedAt: "2026-01-01T00:00:04.000Z",
            writebackOperationKeys: [],
          },
        ],
      },
    );
    const mcpExposureDiagnosticsStore = new FileMcpExposureDiagnosticsStore(config.workspace.stateDir);
    await mcpExposureDiagnosticsStore.writeLatest({
      version: 1,
      generatedAt: "2026-01-01T00:00:05.000Z",
      workflowPath: config.workflowPath,
      cliPath: "/repo/src/cli.ts",
      liveSmokeEnabled: true,
      probeConfig: {
        cliPath: "/repo/src/cli.ts",
        liveSmokeEnabled: true,
        roles: ["worker", "reviewer"],
        sdkTimeoutMs: 45_000,
        waitTimeoutMs: 5_000,
        postCancelWaitMs: 1_500,
        agentCwd: "/repo",
        mcpCwd: "/repo",
        settingSources: ["project", "user"],
        cursorMode: "plan",
      },
      ok: false,
      stages: [
        {
          stage: "sdk",
          status: "failure",
          failureCode: "sdk_system_tools_name_mismatch",
          message: "Cursor SDK did not expose submit_completion_report",
          sdkRoleRuns: [
            {
              role: "worker",
              agentId: "agent-1",
              runId: "run-1",
              primaryFailureCode: "sdk_system_tools_name_mismatch",
              roleStatus: "failure",
              sdkObservation: {
                role: "worker",
                agentCwd: "/repo",
                mcpCwd: "/repo",
                settingSources: ["project", "user"],
                cursorMode: "plan",
                sdkTimeoutMs: 45_000,
                waitTimeoutMs: 5_000,
                postCancelWaitMs: 1_500,
                supportsStream: true,
                supportsWait: true,
                streamStatus: "drained",
                waitStatus: "finished",
                waitError: null,
                timedOut: false,
                cancelledAfterTimeout: false,
                startupSendError: null,
                unexpectedToolCall: null,
                systemMessageCount: 1,
                systemToolPayloadCount: 1,
                systemToolsCount: 1,
                namedToolCount: 1,
                unnamedToolObjectCount: 0,
                malformedToolObjectCount: 0,
                rawSystemToolPayloads: [[{ name: "read_file" }]],
                rawToolNames: ["read_file"],
                normalizedToolNames: [],
                mcpTraceFile: null,
                mcpTraceMethodsByServer: {},
                observedMessageTypes: ["system"],
                messageTypeCounts: { system: 1 },
                streamError: null,
              },
            },
          ],
          results: [
            {
              role: "worker",
              serverKey: "symphony",
              command: "completion-report-mcp",
              expectedTool: "submit_completion_report",
              status: "failure",
              failureCode: "sdk_system_tools_name_mismatch",
              message: "Cursor SDK did not expose submit_completion_report",
              rawToolNames: ["read_file"],
              normalizedToolNames: [],
              envKeyNames: ["LINEAR_API_KEY"],
              sdkRoleRunRole: "worker",
              sdkRoleRunIndex: 0,
            },
          ],
        },
      ],
    });
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      mcpExposureDiagnosticsStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/runs`);
      const runResponse = await fetch(`${baseUrl}/api/v1/runs/run-1`);
      const transcriptResponse = await fetch(`${baseUrl}/api/v1/runs/run-1/transcript?limit=1`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/TEST-1`);
      const diagnosticsResponse = await fetch(`${baseUrl}/api/v1/diagnostics/mcp-tool-exposure`);
      const openResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/open-workspace`, { method: "POST" });
      const pauseWithoutTokenResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/pause`, { method: "POST" });
      const pauseResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/pause`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const continuationSummaryResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/continuation-summary`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const issueBody = (await issueResponse.json()) as {
        issueDetails: IssueDetailsEnvelope;
        mergeGate: IssueDetailsEnvelope["mergeGate"];
        latestRun: { runId: string };
        reviewLoop: {
          phase: string | null;
          role: string | null;
          reviewRound: number | null;
          incompleteTurnCount: number | null;
          blockedReason: string | null;
          lastCompletionReport: { id: string; summary: string } | null;
          lastReviewVerdict: { id: string; verdict: string; findings: string[] } | null;
          mergeConflict: { resolutionStatus: string; fixTurnCount: number } | null;
        };
        metadata: {
          prUrl: string | null;
          prNumber: number | null;
          ciStatus: string | null;
          lastPushedAt: string | null;
          gitBranchName: string | null;
          repoPath: string | null;
          baseRef: string | null;
          merge: { mergeCommitSha: string } | null;
          mergeConflict: { resolutionStatus: string; fixTurnCount: number; lastConflictFixRunId: string | null } | null;
        };
        capabilities: { openWorkspace: boolean };
        diagnostics: {
          mcpToolExposure: {
            ok: boolean;
            stages: Array<{
              failureCode: string | null;
              sdkRoleRuns?: Array<{ role: string; roleStatus: string; primaryFailureCode: string | null }>;
              results?: Array<{ sdkRoleRunRole?: string; sdkRoleRunIndex?: number }>;
            }>;
          } | null;
        };
      };
      const runsBody = (await runsResponse.json()) as { issueDetails: IssueDetailsEnvelope; runs: unknown[] };
      const runBody = (await runResponse.json()) as {
        prUrl: string | null;
        prNumber: number | null;
        ciStatus: string | null;
        lastPushedAt: string | null;
      };
      const continuationSummaryBody = (await continuationSummaryResponse.json()) as {
        summaryReference: { id: string; transcriptPointers: string[]; statusApiPointers: string[] };
      };
      const transcriptBody = (await transcriptResponse.json()) as { events: Array<{ message?: string }> };
      const workspaceBody = (await workspaceResponse.json()) as { gitBranchName?: string };
      const diagnosticsBody = (await diagnosticsResponse.json()) as {
        latest: {
          ok: boolean;
          stages: Array<{
            sdkRoleRuns?: Array<{ role: string; roleStatus: string; primaryFailureCode: string | null }>;
            results?: Array<{ sdkRoleRunRole?: string; sdkRoleRunIndex?: number }>;
          }>;
        } | null;
      };

      expect(issueResponse.status).toBe(200);
      expect(issueBody.issueDetails).toMatchObject({
        source: "durable",
        completeness: "partial",
        issue: { id: "issue-1", identifier: "TEST-1", state: null, branchName: "symphony/TEST-1" },
        tracker: { generatedAt: null, stale: null, classification: null },
        pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7 },
        mergeGate: {
          active: true,
          status: "repair_dispatched",
          headSha: "head-sha-1",
          repairRound: 2,
          gateReportId: "completion-report:issue-1:report-1",
          repairReportId: "completion-report:issue-1:repair-1",
          actionableCheckNames: ["test", "typecheck"],
          checks: [
            { name: "test", outcome: "failing" },
            { name: "typecheck", outcome: "missing_actionable" },
          ],
        },
        latestRun: { runId: "run-1", status: "running", terminalReason: null },
      });
      expect(issueBody.mergeGate).toMatchObject({ status: "repair_dispatched", actionableCheckNames: ["test", "typecheck"] });
      expect(issueBody.latestRun.runId).toBe("run-1");
      expect(issueBody.reviewLoop).toMatchObject({
        phase: "review",
        role: "worker",
        reviewRound: 1,
        incompleteTurnCount: 0,
        blockedReason: null,
        lastCompletionReport: {
          id: "completion-report:issue-1:report-1",
          summary: "Implemented the status surface.",
        },
        lastReviewVerdict: {
          id: "review-verdict:issue-1:verdict-1",
          verdict: "fail",
          findings: ["Add reviewer pass evidence."],
        },
        mergeConflict: {
          resolutionStatus: "still_conflicted",
          fixTurnCount: 1,
        },
      });
      expect(issueBody.metadata).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        ciStatus: "success",
        lastPushedAt: "2026-01-01T00:00:00.500Z",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "origin/main",
        merge: { mergeCommitSha: "merge-sha-1" },
        mergeConflict: {
          resolutionStatus: "still_conflicted",
          fixTurnCount: 1,
          lastConflictFixRunId: "conflict-run-1",
        },
      });
      expect(issueBody.capabilities.openWorkspace).toBe(false);
      expect(issueBody.diagnostics.mcpToolExposure).toMatchObject({
        ok: false,
        probeConfig: { sdkTimeoutMs: 45_000, waitTimeoutMs: 5_000, postCancelWaitMs: 1_500 },
        stages: [{ failureCode: "sdk_system_tools_name_mismatch" }],
      });
      expect(issueBody.diagnostics.mcpToolExposure?.stages[0]).toMatchObject({
        sdkRoleRuns: [
          {
            role: "worker",
            roleStatus: "failure",
            primaryFailureCode: "sdk_system_tools_name_mismatch",
          },
        ],
        results: [{ sdkRoleRunRole: "worker", sdkRoleRunIndex: 0 }],
      });
      expect(runsBody.runs).toHaveLength(1);
      expect(runsBody.issueDetails).toMatchObject({
        source: "durable",
        completeness: "partial",
        issue: { id: "issue-1", identifier: "TEST-1", state: null, branchName: "symphony/TEST-1" },
        mergeGate: { status: "repair_dispatched" },
        latestRun: { runId: "run-1", terminalReason: null },
      });
      expect(runResponse.status).toBe(200);
      expect(runBody).toMatchObject({
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        ciStatus: "success",
        lastPushedAt: "2026-01-01T00:00:00.500Z",
      });
      expect(transcriptBody.events[0]?.message).toBe("hello");
      expect(workspaceBody.gitBranchName).toBe("symphony/TEST-1");
      expect(diagnosticsResponse.status).toBe(200);
      expect(diagnosticsBody.latest).toMatchObject({ ok: false });
      expect(diagnosticsBody.latest?.stages[0]).toMatchObject({
        sdkRoleRuns: [
          {
            role: "worker",
            roleStatus: "failure",
            primaryFailureCode: "sdk_system_tools_name_mismatch",
          },
        ],
        results: [{ sdkRoleRunRole: "worker", sdkRoleRunIndex: 0 }],
      });
      expect(openResponse.status).toBe(401);
      expect(pauseWithoutTokenResponse.status).toBe(401);
      expect(pauseResponse.status).toBe(202);
      expect(continuationSummaryResponse.status).toBe(201);
      expect(continuationSummaryBody.summaryReference).toMatchObject({
        id: "fake-summary:issue-1",
        transcriptPointers: ["/api/v1/runs/run-1/transcript"],
        statusApiPointers: ["/api/v1/issues/TEST-1"],
      });
    } finally {
      await server.stop();
    }
  });


  it("surfaces legacy/default project context attribution across durable status records", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const legacyDefaultProjectContext = {
      projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      projectContextLabel: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      linearProjectSlug: null,
      routingSource: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
    };

    await runStore.upsertWorkspace({
      workspaceKey: "LEGACY-1",
      issueId: "issue-legacy",
      issueIdentifier: "LEGACY-1",
      path: path.join(config.workspace.root, "LEGACY-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/LEGACY-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-legacy",
      sessionId: "session-legacy",
      agentId: "agent-legacy",
      role: "worker",
      issueId: "issue-legacy",
      issueIdentifier: "LEGACY-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "LEGACY-1",
      workspacePath: path.join(config.workspace.root, "LEGACY-1"),
      gitBranchName: "symphony/LEGACY-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    await lifecycleStore.ensureIssue(issue({ id: "issue-legacy", identifier: "LEGACY-1" }), { phase: "implementation" });

    const legacyRunPath = path.join(config.workspace.stateDir, "runs", "run-legacy", "meta.json");
    const legacyRun = JSON.parse(await readFile(legacyRunPath, "utf8")) as Record<string, unknown>;
    delete legacyRun.projectContext;
    await writeFile(legacyRunPath, `${JSON.stringify(legacyRun, null, 2)}\n`, "utf8");

    const legacyWorkspacePath = path.join(config.workspace.stateDir, "workspaces", "LEGACY-1.json");
    const legacyWorkspace = JSON.parse(await readFile(legacyWorkspacePath, "utf8")) as Record<string, unknown>;
    delete legacyWorkspace.projectContext;
    await writeFile(legacyWorkspacePath, `${JSON.stringify(legacyWorkspace, null, 2)}\n`, "utf8");

    const legacyLifecyclePath = path.join(config.workspace.stateDir, "issue-lifecycle", "issue-legacy.json");
    const legacyLifecycle = JSON.parse(await readFile(legacyLifecyclePath, "utf8")) as Record<string, unknown>;
    delete legacyLifecycle.projectContext;
    await writeFile(legacyLifecyclePath, `${JSON.stringify(legacyLifecycle, null, 2)}\n`, "utf8");

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();

    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/LEGACY-1`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/LEGACY-1/runs`);
      const runResponse = await fetch(`${baseUrl}/api/v1/runs/run-legacy`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/LEGACY-1`);

      const issueBody = (await issueResponse.json()) as {
        workspace: { projectContext: typeof legacyDefaultProjectContext } | null;
        latestRun: { projectContext: typeof legacyDefaultProjectContext } | null;
        lifecycle: { projectContext: typeof legacyDefaultProjectContext } | null;
      };
      const runsBody = (await runsResponse.json()) as { runs: Array<{ projectContext: typeof legacyDefaultProjectContext }> };
      const runBody = (await runResponse.json()) as { projectContext: typeof legacyDefaultProjectContext };
      const workspaceBody = (await workspaceResponse.json()) as { projectContext: typeof legacyDefaultProjectContext };

      expect(issueResponse.status).toBe(200);
      expect(runsResponse.status).toBe(200);
      expect(runResponse.status).toBe(200);
      expect(workspaceResponse.status).toBe(200);
      expect(issueBody.workspace?.projectContext).toMatchObject(legacyDefaultProjectContext);
      expect(issueBody.latestRun?.projectContext).toMatchObject(legacyDefaultProjectContext);
      expect(issueBody.lifecycle?.projectContext).toMatchObject(legacyDefaultProjectContext);
      expect(runsBody.runs).toHaveLength(1);
      expect(runsBody.runs[0]?.projectContext).toMatchObject(legacyDefaultProjectContext);
      expect(runBody.projectContext).toMatchObject(legacyDefaultProjectContext);
      expect(workspaceBody.projectContext).toMatchObject(legacyDefaultProjectContext);
    } finally {
      await server.stop();
    }
  });

  it("strips unexpected project context repository/source fields across durable status routes", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const expectedProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    await runStore.upsertWorkspace({
      workspaceKey: "DOCS-CTX",
      issueId: "issue-docs-ctx",
      issueIdentifier: "DOCS-CTX",
      projectContext: expectedProjectContext,
      path: path.join(config.workspace.root, "DOCS-CTX"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/DOCS-CTX",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-docs-ctx",
      sessionId: "session-docs-ctx",
      agentId: "agent-docs-ctx",
      role: "worker",
      issueId: "issue-docs-ctx",
      issueIdentifier: "DOCS-CTX",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "DOCS-CTX",
      workspacePath: path.join(config.workspace.root, "DOCS-CTX"),
      gitBranchName: "symphony/DOCS-CTX",
      repoPath: "/repo",
      baseRef: "origin/main",
      projectContext: expectedProjectContext,
    });
    await lifecycleStore.ensureIssue(issue({ id: "issue-docs-ctx", identifier: "DOCS-CTX" }), {
      phase: "implementation",
      projectContext: expectedProjectContext,
    } as IssueLifecyclePatch);

    const injectedProjectContext = {
      ...expectedProjectContext,
      repository: "https://x-access-token:repo-secret@example.com/org/docs.git",
      path: "packages/site",
      token: "workspace-secret",
      profile: { value: "profile-secret" },
    };
    const runPath = path.join(config.workspace.stateDir, "runs", "run-docs-ctx", "meta.json");
    const rawRun = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;
    rawRun.projectContext = injectedProjectContext;
    await writeFile(runPath, `${JSON.stringify(rawRun, null, 2)}\n`, "utf8");

    const workspacePath = path.join(config.workspace.stateDir, "workspaces", "DOCS-CTX.json");
    const rawWorkspace = JSON.parse(await readFile(workspacePath, "utf8")) as Record<string, unknown>;
    rawWorkspace.projectContext = injectedProjectContext;
    await writeFile(workspacePath, `${JSON.stringify(rawWorkspace, null, 2)}\n`, "utf8");

    const lifecyclePath = path.join(config.workspace.stateDir, "issue-lifecycle", "issue-docs-ctx.json");
    const rawLifecycle = JSON.parse(await readFile(lifecyclePath, "utf8")) as Record<string, unknown>;
    rawLifecycle.projectContext = injectedProjectContext;
    await writeFile(lifecyclePath, `${JSON.stringify(rawLifecycle, null, 2)}\n`, "utf8");

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();

    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/docs:DOCS-CTX`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/docs:DOCS-CTX/runs`);
      const runResponse = await fetch(`${baseUrl}/api/v1/runs/run-docs-ctx`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/docs:DOCS-CTX`);

      const issueBody = (await issueResponse.json()) as {
        workspace: { projectContext: typeof expectedProjectContext } | null;
        latestRun: { projectContext: typeof expectedProjectContext } | null;
        lifecycle: { projectContext: typeof expectedProjectContext } | null;
      };
      const runsBody = (await runsResponse.json()) as { runs: Array<{ projectContext: typeof expectedProjectContext }> };
      const runBody = (await runResponse.json()) as { projectContext: typeof expectedProjectContext };
      const workspaceBody = (await workspaceResponse.json()) as { projectContext: typeof expectedProjectContext };

      expect(issueResponse.status).toBe(200);
      expect(runsResponse.status).toBe(200);
      expect(workspaceResponse.status).toBe(200);
      expect(issueBody.workspace?.projectContext).toEqual(expectedProjectContext);
      expect(issueBody.latestRun?.projectContext).toEqual(expectedProjectContext);
      expect(issueBody.lifecycle?.projectContext).toEqual(expectedProjectContext);
      expect(runsBody.runs).toHaveLength(1);
      expect(runsBody.runs[0]?.projectContext).toEqual(expectedProjectContext);
      expect(runBody.projectContext).toEqual(expectedProjectContext);
      expect(workspaceBody.projectContext).toEqual(expectedProjectContext);

      const serialized = JSON.stringify({ issueBody, runsBody, runBody, workspaceBody });
      expect(serialized).not.toContain("repo-secret");
      expect(serialized).not.toContain("x-access-token");
      expect(serialized).not.toContain("workspace-secret");
      expect(serialized).not.toContain("profile-secret");
    } finally {
      await server.stop();
    }
  });

  it("resolves legacy unqualified status and transcript aliases through the configured default project context", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);

    await runStore.upsertWorkspace({
      workspaceKey: "DEFAULT-ALIAS-1",
      issueId: "issue-default-alias-1",
      issueIdentifier: "DEFAULT-ALIAS-1",
      path: path.join(config.workspace.root, "DEFAULT-ALIAS-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/DEFAULT-ALIAS-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-default-alias-1",
      sessionId: "session-default-alias-1",
      agentId: "agent-default-alias-1",
      role: "worker",
      issueId: "issue-default-alias-1",
      issueIdentifier: "DEFAULT-ALIAS-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "DEFAULT-ALIAS-1",
      workspacePath: path.join(config.workspace.root, "DEFAULT-ALIAS-1"),
      gitBranchName: "symphony/DEFAULT-ALIAS-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    await runStore.appendEvent({
      runId: "run-default-alias-1",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "resolved through compatibility default",
    });
    await lifecycleStore.ensureIssue(issue({ id: "issue-default-alias-1", identifier: "DEFAULT-ALIAS-1" }), { phase: "implementation" });

    await stripPersistedProjectContext(path.join(config.workspace.stateDir, "runs", "run-default-alias-1", "meta.json"));
    await stripPersistedProjectContext(path.join(config.workspace.stateDir, "workspaces", "DEFAULT-ALIAS-1.json"));
    await stripPersistedProjectContext(path.join(config.workspace.stateDir, "issue-lifecycle", "issue-default-alias-1.json"));

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/DEFAULT-ALIAS-1`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/DEFAULT-ALIAS-1/runs`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/DEFAULT-ALIAS-1`);
      const transcriptResponse = await fetch(`${baseUrl}/api/v1/runs/DEFAULT-ALIAS-1/transcript?limit=10`);

      const issueBody = (await issueResponse.json()) as {
        latestRun: { runId: string; projectContext: { projectContextId: string } } | null;
        workspace: { workspaceKey: string; projectContext: { projectContextId: string } } | null;
        lifecycle: { issueIdentifier: string; projectContext: { projectContextId: string } } | null;
      };
      const runsBody = (await runsResponse.json()) as { runs: Array<{ runId: string; projectContext: { projectContextId: string } }> };
      const workspaceBody = (await workspaceResponse.json()) as { workspaceKey: string; projectContext: { projectContextId: string } };
      const transcriptBody = (await transcriptResponse.json()) as { runId: string; events: Array<{ message?: string }> };

      expect(issueResponse.status).toBe(200);
      expect(runsResponse.status).toBe(200);
      expect(workspaceResponse.status).toBe(200);
      expect(transcriptResponse.status).toBe(200);
      expect(issueBody.latestRun).toMatchObject({ runId: "run-default-alias-1", projectContext: { projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID } });
      expect(issueBody.workspace).toMatchObject({ workspaceKey: "DEFAULT-ALIAS-1", projectContext: { projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID } });
      expect(issueBody.lifecycle).toMatchObject({ issueIdentifier: "DEFAULT-ALIAS-1", projectContext: { projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID } });
      expect(runsBody.runs).toEqual([
        expect.objectContaining({
          runId: "run-default-alias-1",
          projectContext: expect.objectContaining({ projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID }),
        }),
      ]);
      expect(workspaceBody).toMatchObject({ workspaceKey: "DEFAULT-ALIAS-1", projectContext: { projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID } });
      expect(transcriptBody.runId).toBe("run-default-alias-1");
      expect(transcriptBody.events).toEqual([
        expect.objectContaining({ message: "resolved through compatibility default" }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("resolves literal colon-bearing session IDs on the durable transcript route", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const sessionId = "sym_eng-447_worker_issue:00dcda50:hermes-run-1";

    await runStore.upsertWorkspace({
      workspaceKey: "COLON-SESSION-1",
      issueId: "issue-colon-session-1",
      issueIdentifier: "COLON-SESSION-1",
      path: path.join(config.workspace.root, "COLON-SESSION-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/COLON-SESSION-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-colon-session-1",
      sessionId,
      agentId: "agent-colon-session-1",
      role: "worker",
      issueId: "issue-colon-session-1",
      issueIdentifier: "COLON-SESSION-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "COLON-SESSION-1",
      workspacePath: path.join(config.workspace.root, "COLON-SESSION-1"),
      gitBranchName: "symphony/COLON-SESSION-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    await runStore.appendEvent({
      runId: "run-colon-session-1",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "colon session transcript",
    });

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/api/v1/runs/${encodeURIComponent(sessionId)}/transcript?limit=10`,
      );
      const body = (await response.json()) as { runId: string; events: Array<{ message?: string }> };

      expect(response.status).toBe(200);
      expect(body.runId).toBe("run-colon-session-1");
      expect(body.events).toEqual([expect.objectContaining({ message: "colon session transcript" })]);
    } finally {
      await server.stop();
    }
  });

  it("refreshes the default project context used for legacy alias resolution", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    await runStore.upsertWorkspace({
      workspaceKey: "ENG-179",
      issueId: "issue-docs-refresh-1",
      issueIdentifier: "ENG-179",
      path: path.join(config.workspace.root, "docs", "ENG-179"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/docs/ENG-179",
      projectContext: docsProjectContext,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-docs-refresh-1",
      sessionId: "session-docs-refresh-1",
      agentId: "agent-docs-refresh-1",
      role: "worker",
      issueId: "issue-docs-refresh-1",
      issueIdentifier: "ENG-179",
      attempt: null,
      turnNumber: 1,
      prompt: "docs work",
      workspaceKey: "ENG-179",
      workspacePath: path.join(config.workspace.root, "docs", "ENG-179"),
      gitBranchName: "symphony/docs/ENG-179",
      repoPath: "/repo-docs",
      baseRef: "origin/main",
      projectContext: docsProjectContext,
    });
    await runStore.appendEvent({
      runId: "run-docs-refresh-1",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "docs transcript",
    });
    await lifecycleStore.ensureIssue(
      issue({ id: "issue-docs-refresh-1", identifier: "ENG-179" }),
      { phase: "implementation", projectContext: docsProjectContext },
    );

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: "docs",
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/ENG-179`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/ENG-179/runs`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/ENG-179`);
      const transcriptResponse = await fetch(`${baseUrl}/api/v1/runs/ENG-179/transcript?limit=10`);

      const issueBody = (await issueResponse.json()) as {
        latestRun: { projectContext?: { projectContextId: string } } | null;
        workspace: { projectContext?: { projectContextId: string } } | null;
        lifecycle: { projectContext?: { projectContextId: string } } | null;
      };
      const runsBody = (await runsResponse.json()) as { runs: Array<{ projectContext?: { projectContextId: string } }> };
      const workspaceBody = (await workspaceResponse.json()) as { projectContext?: { projectContextId: string } };
      const transcriptBody = (await transcriptResponse.json()) as { runId: string; events: Array<{ message?: string }> };

      expect(issueResponse.status).toBe(200);
      expect(runsResponse.status).toBe(200);
      expect(workspaceResponse.status).toBe(200);
      expect(transcriptResponse.status).toBe(200);
      expect(issueBody.latestRun?.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(issueBody.workspace?.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(issueBody.lifecycle?.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(runsBody.runs).toEqual([expect.objectContaining({ projectContext: expect.objectContaining({ projectContextId: "docs" }) })]);
      expect(workspaceBody.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(transcriptBody.runId).toBe("run-docs-refresh-1");
      expect(transcriptBody.events).toEqual([expect.objectContaining({ message: "docs transcript" })]);

      server.setDefaultProjectContextId("symphony");

      const updatedIssueResponse = await fetch(`${baseUrl}/api/v1/issues/ENG-179`);
      const updatedRunsResponse = await fetch(`${baseUrl}/api/v1/issues/ENG-179/runs`);
      const updatedWorkspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/ENG-179`);
      const updatedTranscriptResponse = await fetch(`${baseUrl}/api/v1/runs/ENG-179/transcript?limit=10`);

      const updatedIssueBody = (await updatedIssueResponse.json()) as { error: { message: string } };
      const updatedRunsBody = (await updatedRunsResponse.json()) as { error: { message: string } };
      const updatedWorkspaceBody = (await updatedWorkspaceResponse.json()) as { error: { message: string } };
      const updatedTranscriptBody = (await updatedTranscriptResponse.json()) as { error: { message: string } };

      expect(updatedIssueResponse.status).toBe(404);
      expect(updatedRunsResponse.status).toBe(404);
      expect(updatedWorkspaceResponse.status).toBe(404);
      expect(updatedTranscriptResponse.status).toBe(404);
      expect(updatedIssueBody.error.message).toContain("default project context");
      expect(updatedRunsBody.error.message).toContain("default project context");
      expect(updatedWorkspaceBody.error.message).toContain("default project context");
      expect(updatedTranscriptBody.error.message).toContain("default project context");
    } finally {
      await server.stop();
    }
  });

  it("preserves exact workspace-key matches across sibling workspaces that share issue aliases", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);

    await runStore.upsertWorkspace({
      workspaceKey: "ENG-1",
      issueId: "issue-eng-1",
      issueIdentifier: "ENG-1",
      path: path.join(config.workspace.root, "ENG-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/ENG-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.upsertWorkspace({
      workspaceKey: "ENG-1-planning",
      issueId: "issue-eng-1",
      issueIdentifier: "ENG-1",
      path: path.join(config.workspace.root, "ENG-1-planning"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/ENG-1-planning",
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/workspaces/ENG-1-planning`);
      const body = (await response.json()) as {
        workspaceKey: string;
        issueId: string | null;
        issueIdentifier: string;
        path: string;
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        workspaceKey: "ENG-1-planning",
        issueId: "issue-eng-1",
        issueIdentifier: "ENG-1",
        path: path.join(config.workspace.root, "ENG-1-planning"),
      });
    } finally {
      await server.stop();
    }
  });

  it("opens the workspace resolved from the request issue context when identifiers collide across project contexts", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const symphonyProjectContext = {
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
      routingSource: "candidate_poll",
    } as const;
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const symphonyPath = path.join(config.workspace.root, "symphony", "ENG-179");
    const docsPath = path.join(config.workspace.root, "docs", "ENG-179");
    await mkdir(symphonyPath, { recursive: true });
    await mkdir(docsPath, { recursive: true });
    await runStore.upsertWorkspace({
      workspaceKey: "ENG-179",
      issueId: "issue-symphony-open-workspace-1",
      issueIdentifier: "ENG-179",
      path: symphonyPath,
      sourceKind: "git_worktree",
      gitBranchName: "symphony/ENG-179",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      projectContext: symphonyProjectContext,
    });
    await runStore.upsertWorkspace({
      workspaceKey: "docs-ENG-179",
      issueId: "issue-docs-open-workspace-1",
      issueIdentifier: "ENG-179",
      path: docsPath,
      sourceKind: "git_worktree",
      gitBranchName: "symphony/docs/ENG-179",
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      projectContext: docsProjectContext,
    });
    const openedPaths: string[] = [];
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: {
        async open(workspacePath: string) {
          openedPaths.push(workspacePath);
        },
      },
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const defaultResponse = await fetch(`${baseUrl}/api/v1/issues/ENG-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const docsResponse = await fetch(`${baseUrl}/api/v1/issues/docs:ENG-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const defaultBody = (await defaultResponse.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          requestAlias: string;
          requestedProjectContextId: string | null;
          redacted: true;
          sources: string[];
        };
      };
      const docsBody = (await docsResponse.json()) as {
        workspace_path: string;
        routeEvidence: {
          kind: string;
          status: string;
          requestAlias: string;
          resolvedProjectContextId: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(defaultResponse.status).toBe(404);
      expect(docsResponse.status).toBe(202);
      expect(defaultBody).toMatchObject({
        error: {
          code: "not_found",
          message: "Issue alias is ambiguous across project contexts: ENG-179. Use a context-qualified alias.",
        },
      });
      expect(defaultBody.routeEvidence).toMatchObject({
        kind: "open_workspace",
        status: "ambiguous",
        requestAlias: "ENG-179",
        requestedProjectContextId: null,
        redacted: true,
      });
      expect(docsBody.workspace_path).toBe(docsPath);
      expect(docsBody.routeEvidence).toMatchObject({
        kind: "open_workspace",
        status: "resolved",
        requestAlias: "ENG-179",
        resolvedProjectContextId: "docs",
        redacted: true,
      });
      expect(docsBody.routeEvidence.sources).toEqual(expect.arrayContaining(["alias_workspace", "workspace_record"]));
      expect(openedPaths).toEqual([docsPath]);
    } finally {
      await server.stop();
    }
  });

  it("preserves the context-qualified alias for open-workspace filesystem fallback when no durable match exists", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const defaultPath = workspaceManager.getPathForIssue("ENG-179");
    const docsPath = workspaceManager.getPathForIssue("docs:ENG-179");
    await mkdir(defaultPath, { recursive: true });
    await mkdir(docsPath, { recursive: true });
    const openedPaths: string[] = [];
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager,
      workspaceOpener: {
        async open(workspacePath: string) {
          openedPaths.push(workspacePath);
        },
      },
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as { workspace_path: string };

      expect(response.status).toBe(202);
      expect(body.workspace_path).toBe(docsPath);
      expect(openedPaths).toEqual([docsPath]);
    } finally {
      await server.stop();
    }
  });

  it("fails closed for context-qualified open-workspace filesystem fallback when only the default workspace exists", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const defaultPath = workspaceManager.getPathForIssue("ENG-179");
    const docsPath = workspaceManager.getPathForIssue("docs:ENG-179");
    await mkdir(defaultPath, { recursive: true });
    const openedPaths: string[] = [];
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager,
      workspaceOpener: {
        async open(workspacePath: string) {
          openedPaths.push(workspacePath);
        },
      },
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          resolvedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toBe(`Workspace not found: ${docsPath}`);
      expect(body.routeEvidence).toMatchObject({
        kind: "open_workspace",
        status: "missing",
        resolvedProjectContextId: "docs",
        reason: "workspace_path_not_found",
        redacted: true,
      });
      expect(body.routeEvidence.sources).toEqual(expect.arrayContaining(["workspace_filesystem_fallback"]));
      expect(openedPaths).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("fails closed for context-qualified open-workspace live fallback when only a default-context live row exists", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const defaultPath = workspaceManager.getPathForIssue("ENG-179");
    const docsPath = workspaceManager.getPathForIssue("docs:ENG-179");
    await mkdir(defaultPath, { recursive: true });
    const liveRunning = liveRunningFixture(testConfig(path.join(root, "workspaces")), "ENG-179", "In Progress");
    liveRunning.workspacePath = defaultPath;
    const openedPaths: string[] = [];
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([liveRunning]),
      workspaceManager,
      workspaceOpener: {
        async open(workspacePath: string) {
          openedPaths.push(workspacePath);
        },
      },
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          resolvedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toBe(`Workspace not found: ${docsPath}`);
      expect(body.routeEvidence).toMatchObject({
        kind: "open_workspace",
        status: "missing",
        resolvedProjectContextId: "docs",
        reason: "workspace_path_not_found",
        redacted: true,
      });
      expect(body.routeEvidence.sources).toEqual(expect.arrayContaining(["workspace_filesystem_fallback"]));
      expect(openedPaths).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("fails closed for context-qualified open-workspace durable fallback when only a default-context workspace record exists", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const defaultPath = workspaceManager.getPathForIssue("ENG-179");
    const docsPath = workspaceManager.getPathForIssue("docs:ENG-179");
    await mkdir(defaultPath, { recursive: true });
    await runStore.upsertWorkspace({
      workspaceKey: "ENG-179",
      issueId: "issue-default-open-workspace-context-1",
      issueIdentifier: "ENG-179",
      path: defaultPath,
      sourceKind: "git_worktree",
      gitBranchName: "symphony/ENG-179",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const openedPaths: string[] = [];
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager,
      workspaceOpener: {
        async open(workspacePath: string) {
          openedPaths.push(workspacePath);
        },
      },
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          resolvedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toBe(`Workspace not found: ${docsPath}`);
      expect(body.routeEvidence).toMatchObject({
        kind: "open_workspace",
        status: "missing",
        resolvedProjectContextId: "docs",
        reason: "workspace_path_not_found",
        redacted: true,
      });
      expect(body.routeEvidence.sources).toEqual(expect.arrayContaining(["workspace_filesystem_fallback"]));
      expect(openedPaths).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("derives qualified workspace context from runs and lifecycles when the durable workspace record is legacy-default", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    await runStore.upsertWorkspace({
      workspaceKey: "ENG-179",
      issueId: "issue-docs-workspace-context-1",
      issueIdentifier: "ENG-179",
      path: path.join(config.workspace.root, "docs", "ENG-179"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/docs/ENG-179",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-docs-workspace-context-1",
      sessionId: "session-docs-workspace-context-1",
      agentId: "agent-docs-workspace-context-1",
      role: "worker",
      issueId: "issue-docs-workspace-context-1",
      issueIdentifier: "ENG-179",
      attempt: null,
      turnNumber: 1,
      prompt: "docs work",
      workspaceKey: "ENG-179",
      workspacePath: path.join(config.workspace.root, "docs", "ENG-179"),
      gitBranchName: "symphony/docs/ENG-179",
      repoPath: "/repo-docs",
      baseRef: "origin/main",
      projectContext: docsProjectContext,
    });
    await lifecycleStore.ensureIssue(
      issue({ id: "issue-docs-workspace-context-1", identifier: "ENG-179" }),
      { phase: "implementation", projectContext: docsProjectContext },
    );

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/docs:ENG-179`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/docs:ENG-179`);

      const issueBody = (await issueResponse.json()) as {
        workspace: { workspaceKey: string; projectContext?: { projectContextId: string } } | null;
        latestRun: { projectContext?: { projectContextId: string } } | null;
        lifecycle: { projectContext?: { projectContextId: string } } | null;
        capabilities: { continuationSummary: { path: string } };
      };
      const workspaceBody = (await workspaceResponse.json()) as {
        workspaceKey: string;
        projectContext?: { projectContextId: string };
      };
      const continuationSummaryResponse = await fetch(`${baseUrl}${issueBody.capabilities.continuationSummary.path}`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const continuationSummaryBody = (await continuationSummaryResponse.json()) as {
        issue: string;
        summaryReference: { id: string };
      };

      expect(issueResponse.status).toBe(200);
      expect(workspaceResponse.status).toBe(200);
      expect(continuationSummaryResponse.status).toBe(201);
      expect(issueBody.workspace).toMatchObject({
        workspaceKey: "ENG-179",
        projectContext: { projectContextId: "docs" },
      });
      expect(issueBody.latestRun?.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(issueBody.lifecycle?.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(issueBody.capabilities.continuationSummary.path).toBe("/api/v1/issues/docs%3AENG-179/continuation-summary");
      expect(workspaceBody).toMatchObject({
        workspaceKey: "ENG-179",
        projectContext: { projectContextId: "docs" },
      });
      expect(continuationSummaryBody).toMatchObject({
        issue: "docs:ENG-179",
        summaryReference: { id: "fake-summary:issue-docs-workspace-context-1" },
      });
    } finally {
      await server.stop();
    }
  });

  it("opens a context-qualified canonical Linear-id workspace through durable lifecycle and run fallback data", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const docsPath = workspaceManager.getPathForIssue("docs:ENG-179");
    await mkdir(docsPath, { recursive: true });
    await runStore.startRun({
      runId: "run-docs-open-workspace-canonical-id-1",
      sessionId: "session-docs-open-workspace-canonical-id-1",
      agentId: "agent-docs-open-workspace-canonical-id-1",
      role: "worker",
      issueId: "linear-docs-179",
      issueIdentifier: "ENG-179",
      attempt: null,
      turnNumber: 1,
      prompt: "docs work",
      workspaceKey: "docs:ENG-179",
      workspacePath: docsPath,
      gitBranchName: "symphony/docs/ENG-179",
      repoPath: "/repo-docs",
      baseRef: "origin/main",
      projectContext: docsProjectContext,
    });
    await lifecycleStore.ensureIssue(issue({ id: "linear-docs-179", identifier: "ENG-179" }), {
      phase: "implementation",
      projectContext: docsProjectContext,
      summaryPointers: {
        workspaceKey: "docs:ENG-179",
        workspacePath: docsPath,
        branchName: "symphony/docs/ENG-179",
        gitBranchName: "symphony/docs/ENG-179",
        repoPath: "/repo-docs",
        baseRef: "origin/main",
      },
    });
    const openedPaths: string[] = [];
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager,
      workspaceOpener: {
        async open(workspacePath: string) {
          openedPaths.push(workspacePath);
        },
      },
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:linear-docs-179/open-workspace`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as { workspace_path: string };

      expect(response.status).toBe(202);
      expect(body.workspace_path).toBe(docsPath);
      expect(openedPaths).toEqual([docsPath]);
    } finally {
      await server.stop();
    }
  });

  it("fails closed for ambiguous legacy unqualified status and transcript aliases across project contexts", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "workspaces"),
            state_dir: path.join(root, ".symphony"),
          },
        },
      }),
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    await runStore.upsertWorkspace({
      workspaceKey: "AMBIGUOUS-ALIAS-1",
      issueId: "issue-default-ambiguous-1",
      issueIdentifier: "AMBIGUOUS-ALIAS-1",
      path: path.join(config.workspace.root, "AMBIGUOUS-ALIAS-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/AMBIGUOUS-ALIAS-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-default-ambiguous-1",
      sessionId: "session-default-ambiguous-1",
      agentId: "agent-default-ambiguous-1",
      role: "worker",
      issueId: "issue-default-ambiguous-1",
      issueIdentifier: "AMBIGUOUS-ALIAS-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "AMBIGUOUS-ALIAS-1",
      workspacePath: path.join(config.workspace.root, "AMBIGUOUS-ALIAS-1"),
      gitBranchName: "symphony/AMBIGUOUS-ALIAS-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    await runStore.appendEvent({
      runId: "run-default-ambiguous-1",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "default transcript",
    });
    await lifecycleStore.ensureIssue(issue({ id: "issue-default-ambiguous-1", identifier: "AMBIGUOUS-ALIAS-1" }), { phase: "implementation" });

    await stripPersistedProjectContext(path.join(config.workspace.stateDir, "runs", "run-default-ambiguous-1", "meta.json"));
    await stripPersistedProjectContext(path.join(config.workspace.stateDir, "workspaces", "AMBIGUOUS-ALIAS-1.json"));
    await stripPersistedProjectContext(path.join(config.workspace.stateDir, "issue-lifecycle", "issue-default-ambiguous-1.json"));

    await runStore.upsertWorkspace({
      workspaceKey: "AMBIGUOUS-ALIAS-1",
      issueId: "issue-docs-ambiguous-1",
      issueIdentifier: "AMBIGUOUS-ALIAS-1",
      path: path.join(config.workspace.root, "docs", "AMBIGUOUS-ALIAS-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/docs/AMBIGUOUS-ALIAS-1",
      projectContext: docsProjectContext,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-docs-ambiguous-1",
      sessionId: "session-docs-ambiguous-1",
      agentId: "agent-docs-ambiguous-1",
      role: "worker",
      issueId: "issue-docs-ambiguous-1",
      issueIdentifier: "AMBIGUOUS-ALIAS-1",
      attempt: null,
      turnNumber: 1,
      prompt: "docs work",
      workspaceKey: "AMBIGUOUS-ALIAS-1",
      workspacePath: path.join(config.workspace.root, "docs", "AMBIGUOUS-ALIAS-1"),
      gitBranchName: "symphony/docs/AMBIGUOUS-ALIAS-1",
      repoPath: "/repo-docs",
      baseRef: "origin/main",
      projectContext: docsProjectContext,
    });
    await runStore.appendEvent({
      runId: "run-docs-ambiguous-1",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "progress",
      message: "docs transcript",
    });
    await lifecycleStore.ensureIssue(
      issue({ id: "issue-docs-ambiguous-1", identifier: "AMBIGUOUS-ALIAS-1" }),
      { phase: "implementation", projectContext: docsProjectContext },
    );

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/AMBIGUOUS-ALIAS-1`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/AMBIGUOUS-ALIAS-1/runs`);
      const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspaces/AMBIGUOUS-ALIAS-1`);
      const transcriptResponse = await fetch(`${baseUrl}/api/v1/runs/AMBIGUOUS-ALIAS-1/transcript?limit=10`);
      const continuationSummaryResponse = await fetch(`${baseUrl}/api/v1/issues/AMBIGUOUS-ALIAS-1/continuation-summary`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });

      const issueBody = (await issueResponse.json()) as { error: { message: string } };
      const runsBody = (await runsResponse.json()) as { error: { message: string } };
      const workspaceBody = (await workspaceResponse.json()) as { error: { message: string } };
      const transcriptBody = (await transcriptResponse.json()) as { error: { message: string } };
      const continuationSummaryBody = (await continuationSummaryResponse.json()) as { error: { message: string } };

      expect(issueResponse.status).toBe(404);
      expect(runsResponse.status).toBe(404);
      expect(workspaceResponse.status).toBe(404);
      expect(transcriptResponse.status).toBe(404);
      expect(continuationSummaryResponse.status).toBe(404);
      expect(issueBody.error.message).toContain("context-qualified alias");
      expect(runsBody.error.message).toContain("context-qualified alias");
      expect(workspaceBody.error.message).toContain("context-qualified alias");
      expect(transcriptBody.error.message).toContain("context-qualified alias");
      expect(continuationSummaryBody.error.message).toContain("context-qualified alias");
    } finally {
      await server.stop();
    }
  });

  it("surfaces provider-limit gates in state and dashboard and lets operators clear them", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    config.hermes.provider = "openai-codex";
    const candidate = issue({ state: "Todo" });
    let candidateAvailable = true;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return candidateAvailable ? [candidate] : [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new StatusProviderLimitHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    try {
      await orchestrator.refreshNow();
      await waitForStatusApiAsync(async () => orchestrator.snapshot().providerGates.length === 1, "provider gate");
      await waitForStatusApiAsync(async () => orchestrator.snapshot().counts.running === 0, "provider-limit run exit");

      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const dashboardResponse = await fetch(baseUrl + "/");
      const state = (await stateResponse.json()) as {
        providerGates: Array<{ id: string; message: string; resumePolicy: string }>;
        providerGateCounts: { active: number; manual: number };
        operatorView: { providerGates: Array<{ provider: string; controls: { resume: boolean } }> };
      };
      const dashboard = await dashboardResponse.text();
      const gateId = state.providerGates[0]!.id;

      expect(state.providerGateCounts).toMatchObject({ active: 1, manual: 1 });
      expect(state.providerGates[0]).toMatchObject({ message: "Codex weekly allotment exhausted", resumePolicy: "manual" });
      expect(state.operatorView.providerGates[0]).toMatchObject({ provider: "openai-codex", controls: { resume: true } });
      expect(dashboard).toContain("Provider Limits");
      expect(dashboard).toContain("waiting for user resume");
      expect(dashboard).toContain("Codex weekly allotment exhausted");

      const unauthorized = await fetch(`${baseUrl}/api/v1/provider-gates/${encodeURIComponent(gateId)}/resume`, { method: "POST" });
      expect(unauthorized.status).toBe(401);
      candidateAvailable = false;
      const cleared = await fetch(`${baseUrl}/api/v1/provider-gates/${encodeURIComponent(gateId)}/resume`, {
        method: "POST",
        headers: { "X-Symphony-Token": "secret" },
      });
      expect(cleared.status).toBe(202);
      await waitForStatusApiAsync(async () => orchestrator.snapshot().providerGates.length === 0, "provider gate clear");
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("serves web history from run records without hydrating transcripts", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "web-run-1",
      sessionId: "cursor-session-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "Build web history",
      cursorModel: "claude-sonnet-4",
      workspaceKey: "TEST-1",
      workspacePath: path.join(config.workspace.root, "TEST-1"),
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: "web-run-1",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "transcript detail should not be eagerly hydrated",
    });

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch("http://" + address.host + ":" + address.port + "/api/v1/web/history");
      const body = (await response.json()) as {
        sessions: Array<{
          id: string;
          issue: string;
          title: string;
          state: string;
          model: string;
          msgCount: number;
          lastEvent: string;
          toolCount: number;
          runSession: {
            runId: string;
            sessionId: string | null;
            agentId: string | null;
            role: string;
            runPhase: string | null;
            runKind: string | null;
            harnessId: string | null;
            runtime: { model: string | null };
            cursor: { model: string | null };
            workspace: { key: string; path: string; repoPath: string | null; baseRef: string | null; branch: string | null };
            links: { run: string; transcript: string };
          };
        }>;
        transcriptBySession: Record<string, unknown[]>;
        timeline: Array<{ sess: string; kind: string; text: string; state?: string }>;
        defaultSessionId: string;
      };

      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(["defaultSessionId", "sessions", "timeline", "transcriptBySession"]);
      expect(body.transcriptBySession).toEqual({});
      expect(body.defaultSessionId).toBe("web-run-1");
      expect(body.sessions).toHaveLength(1);
      expect(Object.keys(body.sessions[0] ?? {}).sort()).toEqual([
        "id",
        "issue",
        "lastEvent",
        "model",
        "msgCount",
        "runSession",
        "startedAt",
        "state",
        "title",
        "toolCount",
        "updatedAt",
      ]);
      expect(body.sessions[0]).toMatchObject({
        id: "web-run-1",
        issue: "TEST-1",
        title: "TEST-1",
        state: "not_live",
        model: "claude-sonnet-4",
        msgCount: 1,
        lastEvent: "TEST-1 not live",
        toolCount: 0,
        runSession: {
          runId: "web-run-1",
          sessionId: "cursor-session-1",
          agentId: "agent-1",
          role: "worker",
          runPhase: "implementation",
          runKind: "implementation",
          harnessId: "cursor",
          runtime: { model: "claude-sonnet-4" },
          cursor: { model: "claude-sonnet-4" },
          workspace: { key: "TEST-1", repoPath: "/repo", baseRef: "main", branch: "symphony/TEST-1" },
          links: { run: "/api/v1/runs/web-run-1", transcript: "/api/v1/web/sessions/web-run-1/transcript" },
        },
      });

      expect(body.timeline).toHaveLength(1);
      expect(body.timeline[0]).toMatchObject({
        sess: "web-run-1",
        kind: "status",
        text: "TEST-1 run started",
        state: "running",
      });
      expect(JSON.stringify(body.timeline)).not.toContain("transcript detail should not be eagerly hydrated");
    } finally {
      await server.stop();
    }
  });

  it("serves an empty web history when no run store is configured", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch("http://" + address.host + ":" + address.port + "/api/v1/web/history");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sessions: [],
        transcriptBySession: {},
        timeline: [],
        defaultSessionId: "",
      });
    } finally {
      await server.stop();
    }
  });

  it("bounds sidebar and history defaults and honors capped history query limits", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const timestamp = (index: number, seconds = 0) => new Date(Date.UTC(2026, 0, 1, 0, index, seconds)).toISOString();
    const makeRun = (index: number): RunRecord => {
      const suffix = String(index).padStart(3, "0");
      const issueIdentifier = index === 0 ? "TEST-HISTORY-BOUNDARY" : `TEST-HISTORY-${suffix}`;
      return {
        runId: index === 0 ? "run-history-boundary" : `run-history-${suffix}`,
        sessionId: index === 0 ? "session-history-boundary" : `session-history-${suffix}`,
        agentId: index === 0 ? "agent-history-boundary" : `agent-history-${suffix}`,
        role: "worker",
        runPhase: "implementation",
        runKind: "implementation",
        issueId: index === 0 ? "issue-history-boundary" : `issue-history-${suffix}`,
        issueIdentifier,
        attempt: null,
        turnNumber: 1,
        prompt: `work ${issueIdentifier}`,
        promptCharCount: `work ${issueIdentifier}`.length,
        cursorModel: "gpt-test",
        workspaceKey: issueIdentifier,
        workspacePath: path.join(config.workspace.root, issueIdentifier),
        gitBranchName: `symphony/${issueIdentifier}`,
        repoPath: "/repo",
        baseRef: "main",
        status: "succeeded",
        startedAt: timestamp(index),
        updatedAt: timestamp(index, 30),
        completedAt: timestamp(index, 30),
        error: null,
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        transcriptEventCount: 0,
      };
    };
    const runs = Array.from({ length: 501 }, (_, index) => makeRun(index));
    let runListCalls = 0;
    let writebackListCalls = 0;
    const runStore = {
      listRuns: async () => {
        runListCalls += 1;
        return runs;
      },
    } as unknown as FileRunTranscriptStore;
    const writebackOutbox = {
      list: async () => {
        writebackListCalls += 1;
        return [];
      },
    } as unknown as FileWritebackOutboxStore;
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      writebackOutbox,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      type HistoryBody = {
        sessions: Array<{ id: string; issue: string; state: string; lastEvent: string }>;
        transcriptBySession: Record<string, unknown[]>;
        timeline: Array<{ sess: string; kind: string; text: string; state?: string }>;
      };
      const fetchHistory = async (query = "") => {
        const response = await fetch(`http://${address.host}:${address.port}/api/v1/web/history${query}`);
        return { response, body: (await response.json()) as HistoryBody };
      };

      const sidebarResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/sidebar`);
      const { response: historyResponse, body: historyBody } = await fetchHistory();
      const sidebarBody = (await sidebarResponse.json()) as {
        activity: Array<{ id: string; verb: string }>;
        sessions: Array<{ id: string; issue: string; state: string; lastEvent: string }>;
      };

      expect(historyResponse.status).toBe(200);
      expect(sidebarResponse.status).toBe(200);
      expect(runListCalls).toBeGreaterThan(0);
      expect(writebackListCalls).toBeGreaterThan(0);
      expect(sidebarBody.activity).toHaveLength(20);
      expect(sidebarBody.activity.map((item) => item.id)).not.toContain("TEST-HISTORY-BOUNDARY");
      expect(sidebarBody.sessions).toHaveLength(10);
      expect(sidebarBody.sessions.find((session) => session.id === "run-history-boundary")).toBeUndefined();
      expect(sidebarBody.sessions[0]?.id).toBe("run-history-500");
      expect(sidebarBody.sessions.at(-1)?.id).toBe("run-history-491");

      expect(historyBody.sessions).toHaveLength(100);
      expect(historyBody.timeline).toHaveLength(250);
      expect(historyBody.sessions.find((session) => session.id === "run-history-boundary")).toBeUndefined();
      expect(JSON.stringify(historyBody.timeline)).not.toContain("TEST-HISTORY-BOUNDARY");
      expect(historyBody.sessions[0]).toMatchObject({
        id: "run-history-500",
        issue: "TEST-HISTORY-500",
        state: "finished",
        lastEvent: "TEST-HISTORY-500 run finished",
      });
      expect(historyBody.sessions.at(-1)?.id).toBe("run-history-401");
      expect(historyBody.transcriptBySession).toEqual({});

      const { response: smallResponse, body: smallBody } = await fetchHistory("?sessionLimit=5&timelineLimit=7");
      expect(smallResponse.status).toBe(200);
      expect(smallBody.sessions.map((session) => session.id)).toEqual([
        "run-history-500",
        "run-history-499",
        "run-history-498",
        "run-history-497",
        "run-history-496",
      ]);
      expect(smallBody.timeline).toHaveLength(7);

      const { response: cappedResponse, body: cappedBody } = await fetchHistory("?sessionLimit=9999&timelineLimit=9999");
      expect(cappedResponse.status).toBe(200);
      expect(cappedBody.sessions).toHaveLength(500);
      expect(cappedBody.timeline).toHaveLength(500);
      expect(cappedBody.sessions.find((session) => session.id === "run-history-boundary")).toBeUndefined();

      for (const query of ["?sessionLimit=&timelineLimit=bogus", "?sessionLimit=0&timelineLimit=-3"]) {
        const { response, body } = await fetchHistory(query);
        expect(response.status).toBe(200);
        expect(body.sessions).toHaveLength(100);
        expect(body.timeline).toHaveLength(250);
      }
    } finally {
      await server.stop();
    }
  });
  it("scrubs inactive merge-gate blockers from durable status responses", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(
      { id: "issue-2", identifier: "TEST-2" },
      {
        phase: "implementation",
        reviewRound: 1,
        lastReviewVerdictId: "merge-gate:issue-2:pr-7:old-head",
        mergeGate: {
          id: "merge-gate:issue-2:pr-7:old-head",
          status: "superseded",
          headSha: "old-head",
          pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7, headSha: "old-head", branch: "symphony/TEST-2" },
          requiredChecks: ["test", "typecheck"],
          checks: [
            {
              name: "test",
              outcome: "failing",
              rawStatus: "failure",
              conclusion: "failure",
              url: "https://ci.test/test",
              firstObservedAt: null,
              actionableSince: null,
            },
            {
              name: "typecheck",
              outcome: "missing_actionable",
              rawStatus: "missing",
              conclusion: null,
              url: null,
              firstObservedAt: "2026-01-01T00:00:00.000Z",
              actionableSince: "2026-01-01T00:05:00.000Z",
            },
          ],
          mergeability: null,
          reviewRound: 1,
          gateRunId: "gate-run-1",
          gateReportId: "completion-report:issue-2:gate-1",
          repairRunId: "repair-run-1",
          repairReportId: "completion-report:issue-2:repair-1",
          blockerFingerprint: "old-head:test:failure|typecheck:missing",
          writebackOperationKeys: ["comment:issue-2:merge-gate"],
          supersededByHeadSha: "new-head",
          updatedAt: "2026-01-01T00:10:00.000Z",
        },
        reviewVerdicts: [
          {
            id: "merge-gate:issue-2:pr-7:old-head",
            idempotencyKey: "merge-gate:issue-2:pr-7:old-head",
            runId: "gate-run-1",
            issueId: "issue-2",
            issueIdentifier: "TEST-2",
            verdict: "fail",
            acceptanceResults: [{ text: "All configured required checks are passing before gated merge", satisfied: false, evidence: "test: failure" }],
            findings: ["Required check failed: test: failure"],
            evidence: ["Merge gate blocked PR #7"],
            reviewer: "symphony-merge-gate",
            submittedAt: "2026-01-01T00:06:00.000Z",
            writebackOperationKeys: ["comment:issue-2:merge-gate"],
          },
        ],
      },
    );
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/TEST-2`);
      const body = (await response.json()) as {
        lifecycle: {
          lastReviewVerdictId: string | null;
          mergeGate: { checks: unknown[]; repairRunId: string | null; repairReportId: string | null; blockerFingerprint: string | null; writebackOperationKeys: string[] };
          reviewVerdicts: Array<{ id: string; acceptanceResults: unknown[]; findings: string[]; evidence: string[] }>;
        };
        mergeGate: { active: boolean; checks: unknown[]; repairRunId: string | null; repairReportId: string | null; blockerFingerprint: string | null; actionableCheckNames: string[] };
        issueDetails: IssueDetailsEnvelope;
      };

      expect(response.status).toBe(200);
      expect(body.lifecycle.lastReviewVerdictId).toBeNull();
      expect(body.lifecycle.mergeGate).toMatchObject({
        checks: [],
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: null,
        writebackOperationKeys: [],
      });
      expect(body.lifecycle.reviewVerdicts[0]).toMatchObject({
        acceptanceResults: [],
        findings: [],
        evidence: [],
      });
      expect(body.mergeGate).toMatchObject({
        active: false,
        checks: [],
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: null,
        actionableCheckNames: [],
      });
      expect(body.issueDetails.mergeGate).toMatchObject({ active: false, checks: [], actionableCheckNames: [] });
    } finally {
      await server.stop();
    }
  });

  it("projects active old-head merge gates and approvals as non-current after PR head advances", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(
      { id: "issue-3", identifier: "TEST-3" },
      {
        phase: "implementation",
        reviewRound: 1,
        lastCompletionReportId: "completion-report:issue-3:head-a",
        lastReviewVerdictId: "review-verdict:issue-3:head-a-pass",
        summaryPointers: {
          prUrl: "https://github.com/acme/repo/pull/7",
          prNumber: 7,
          prHeadSha: "new-head",
          prBranch: "symphony/TEST-3",
        },
        completionReports: [
          {
            id: "completion-report:issue-3:head-a",
            idempotencyKey: "head-a",
            runId: "worker-run-1",
            issueId: "issue-3",
            issueIdentifier: "TEST-3",
            summary: "Implemented head A.",
            validationEvidence: ["npm test"],
            acceptanceChecklist: [{ text: "Works", satisfied: true, evidence: "tests" }],
            changedFiles: ["src/index.ts"],
            branchName: "symphony/TEST-3",
            pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7, headSha: "old-head", branch: "symphony/TEST-3" },
            risks: [],
            acceptedAt: "2026-01-01T00:00:00.000Z",
            writebackOperationKeys: [],
          },
        ],
        reviewVerdicts: [
          {
            id: "review-verdict:issue-3:head-a-pass",
            idempotencyKey: "head-a-pass",
            runId: "review-run-1",
            issueId: "issue-3",
            issueIdentifier: "TEST-3",
            verdict: "pass",
            acceptanceResults: [{ text: "Head A reviewed", satisfied: true, evidence: "approved" }],
            findings: [],
            evidence: ["https://github.com/acme/repo/pull/7#pullrequestreview-1"],
            reviewer: "reviewer-1",
            submittedAt: "2026-01-01T00:00:01.000Z",
            writebackOperationKeys: [],
          },
        ],
        reviewFeedback: [
          {
            id: "review-feedback:issue-3:review-run-1:approve",
            idempotencyKey: "head-a-approve",
            requestHash: "hash",
            runId: "review-run-1",
            issueId: "issue-3",
            issueIdentifier: "TEST-3",
            kind: "review",
            event: "APPROVE",
            body: "Approved.",
            pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7, headSha: "old-head", branch: "symphony/TEST-3" },
            reviewer: "reviewer-1",
            reviewUrl: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
            commentUrls: [],
            submittedAt: "2026-01-01T00:00:01.000Z",
          },
        ],
        mergeGate: {
          id: "merge-gate:issue-3:pr-7:old-head",
          status: "repair_dispatched",
          headSha: "old-head",
          pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7, headSha: "old-head", branch: "symphony/TEST-3" },
          requiredChecks: ["test"],
          checks: [
            {
              name: "test",
              outcome: "failing",
              rawStatus: "failure",
              conclusion: "failure",
              url: "https://ci.test/test",
              firstObservedAt: null,
              actionableSince: null,
            },
          ],
          mergeability: null,
          reviewRound: 1,
          gateRunId: "gate-run-1",
          gateReportId: "completion-report:issue-3:head-a",
          repairRunId: "repair-run-1",
          repairReportId: "completion-report:issue-3:repair-1",
          blockerFingerprint: "old-head:test:failure",
          writebackOperationKeys: ["comment:issue-3:merge-gate"],
          supersededByHeadSha: null,
          updatedAt: "2026-01-01T00:10:00.000Z",
        },
      },
    );
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/TEST-3`);
      const body = (await response.json()) as {
        lifecycle: { lastReviewVerdictId: string | null; handoff: { lastReviewerOutput: unknown } };
        reviewLoop: { lastReviewVerdict: unknown };
        blockers: unknown;
        mergeGate: {
          active: boolean;
          checks: unknown[];
          repairRunId: string | null;
          repairReportId: string | null;
          blockerFingerprint: string | null;
          actionableCheckNames: string[];
          automationBlocked: boolean;
        };
        issueDetails: IssueDetailsEnvelope;
      };

      expect(response.status).toBe(200);
      expect(body.lifecycle.lastReviewVerdictId).toBeNull();
      expect(body.lifecycle.handoff.lastReviewerOutput).toBeNull();
      expect(body.reviewLoop.lastReviewVerdict).toBeNull();
      expect(body.mergeGate).toMatchObject({
        active: false,
        checks: [],
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: null,
        actionableCheckNames: [],
        automationBlocked: false,
      });
      expect(body.issueDetails.blockers).toMatchObject({ blocked: false });
      expect(body.issueDetails.mergeGate).toMatchObject({ active: false, checks: [], actionableCheckNames: [] });
    } finally {
      await server.stop();
    }
  });

  it("posts planning-run using internal id and records strict id lookup behavior", async () => {
    const candidate = issue({ id: "issue-1", identifier: "TEST-1", state: "Todo", labels: ["planning"] });
    const idFixture = await createPlanningRunApiFixture(path.join(root, "planning-id"), candidate);
    try {
      const response = await fetch(`${idFixture.baseUrl}/api/v1/issues/${candidate.id}/planning-run`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as {
        queued: boolean;
        issue: string;
        issueId: string;
        runPhase: string;
        runKind: string;
        reason: string;
      };

      expect(response.status).toBe(202);
      expect(body).toMatchObject({
        queued: true,
        issue: "TEST-1",
        issueId: "issue-1",
        runPhase: "issue_breakdown",
        runKind: "planning",
        reason: "explicit_request",
      });
      expect(idFixture.tracker.lookupCalls).toEqual([["issue-1"]]);
      await waitForStatusApiAsync(
        async () =>
          ((await idFixture.runStore.latestRunForIssue(candidate.id, {
            role: "worker",
            runPhase: "issue_breakdown",
          }))?.runKind ?? null) === "planning",
        "durable planning run",
      );
      await expect(
        idFixture.runStore.latestRunForIssue(candidate.id, { role: "worker", runPhase: "issue_breakdown" }),
      ).resolves.toMatchObject({
        runPhase: "issue_breakdown",
        runKind: "planning",
      });
      expect(idFixture.harness.runs.map((run) => run.ctx.runPhase)).toEqual(["issue_breakdown"]);
    } finally {
      await idFixture.orchestrator.stop();
      await idFixture.server.stop();
    }

    const identifierFixture = await createPlanningRunApiFixture(path.join(root, "planning-identifier"), candidate);
    try {
      const response = await fetch(`${identifierFixture.baseUrl}/api/v1/issues/${candidate.identifier}/planning-run`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(404);
      expect(body.error).toMatchObject({
        code: "not_found",
        message: "Issue not found: TEST-1",
      });
      expect(identifierFixture.tracker.lookupCalls).toEqual([["TEST-1"]]);
      await expect(
        identifierFixture.runStore.latestRunForIssue(candidate.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toBeNull();
      expect(identifierFixture.harness.runs).toEqual([]);
    } finally {
      await identifierFixture.orchestrator.stop();
      await identifierFixture.server.stop();
    }
  });

  it("routes planning-run identifier lookups through the resolved issue project context when scoped candidate lookups return runtime-shaped issues", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-workspaces"),
            state_dir: path.join(root, "planning-context-state"),
          },
        },
      }),
      path.join(root, "planning-context-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.tracker.activeStates = ["Root Todo"];
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["root-planning"];
    config.issueBreakdown.promptTemplate = "Default planning prompt for {{ issue.identifier }}";
    config.issueBreakdown.cursorMode = "agent";
    const docsContext = config.projectContexts.byId.get("docs");
    expect(docsContext).toBeDefined();
    if (!docsContext) throw new Error("Expected docs project context in planning route fixture");
    docsContext.tracker.activeStates = ["Docs Todo"];
    docsContext.issueBreakdown.enabled = true;
    docsContext.issueBreakdown.planningLabels = ["docs-planning"];
    docsContext.issueBreakdown.promptTemplate = "Docs planning prompt for {{ issue.identifier }}";
    docsContext.issueBreakdown.cursorMode = "plan";
    const docsRuntimeIssue = issue({
      id: "issue-docs-planning-1",
      identifier: "ENG-179",
      state: "Docs Todo",
      labels: ["docs-planning"],
    });
    const symphonyTracker = trackerClientFixture({ candidates: [], issues: [] });
    const docsRequestedIds: string[][] = [];
    let docsCandidateFetchCount = 0;
    const docsTracker: TrackerClient = {
      async fetchCandidateIssues() {
        docsCandidateFetchCount += 1;
        return [structuredClone(docsRuntimeIssue)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        docsRequestedIds.push([...issueIds]);
        return [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: symphonyTracker,
      trackerResolver: (projectContext) => (projectContext?.projectContextId === "docs" ? docsTracker : symphonyTracker),
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/planning-run`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as {
        queued: boolean;
        issue: string;
        issueId: string;
        runPhase: string;
        runKind: string;
        reason: string;
        routeEvidence: {
          kind: string;
          status: string;
          requestAlias: string;
          requestedProjectContextId: string | null;
          resolvedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(202);
      expect(body).toMatchObject({
        queued: true,
        issue: "ENG-179",
        issueId: docsRuntimeIssue.id,
        runPhase: "issue_breakdown",
        runKind: "planning",
        reason: "explicit_request",
      });
      expect(body.routeEvidence).toMatchObject({
        kind: "issue_breakdown",
        status: "resolved",
        requestAlias: "ENG-179",
        requestedProjectContextId: "docs",
        resolvedProjectContextId: "docs",
        reason: "candidate_identifier_fallback",
        redacted: true,
      });
      expect(body.routeEvidence.sources).toEqual(expect.arrayContaining(["tracker_direct", "tracker_candidate"]));
      expect(symphonyTracker.requestedIds).toEqual([]);
      expect(symphonyTracker.candidateFetchCount).toBe(0);
      expect(docsRequestedIds[0]).toEqual(["ENG-179"]);
      expect(docsCandidateFetchCount).toBe(1);
      await waitForStatusApiAsync(
        async () =>
          ((await runStore.latestRunForIssue(docsRuntimeIssue.id, {
            role: "worker",
            runPhase: "issue_breakdown",
          }))?.runKind ?? null) === "planning",
        "context-routed durable planning run",
      );
      await expect(
        runStore.latestRunForIssue(docsRuntimeIssue.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toMatchObject({
        issueId: docsRuntimeIssue.id,
        issueIdentifier: docsRuntimeIssue.identifier,
        runPhase: "issue_breakdown",
        runKind: "planning",
        projectContext: expect.objectContaining({ projectContextId: "docs" }),
      });
      expect(harness.runs[0]?.ctx.issue.id).toBe(docsRuntimeIssue.id);
      expect(harness.runs[0]?.ctx.issue).toMatchObject({ projectContext: { projectContextId: "docs" } });
      expect(harness.runs[0]?.ctx.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(harness.runs[0]?.ctx.config.tracker.activeStates).toEqual(["Docs Todo"]);
      expect(harness.runs[0]?.ctx.config.issueBreakdown.planningLabels).toEqual(["docs-planning"]);
      expect(harness.runs[0]?.ctx.runModeOverride).toBe("plan");
      expect(harness.runs[0]?.prompt).toContain("Docs planning prompt for ENG-179");
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("routes context-qualified planning-run direct lookups through the resolved issue project context when scoped tracker issues omit project-context proof", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-direct-context-workspaces"),
            state_dir: path.join(root, "planning-direct-context-state"),
          },
        },
      }),
      path.join(root, "planning-direct-context-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.tracker.activeStates = ["Root Todo"];
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["root-planning"];
    config.issueBreakdown.promptTemplate = "Default planning prompt for {{ issue.identifier }}";
    config.issueBreakdown.cursorMode = "agent";
    const docsContext = config.projectContexts.byId.get("docs");
    expect(docsContext).toBeDefined();
    if (!docsContext) throw new Error("Expected docs project context in planning direct route fixture");
    docsContext.tracker.activeStates = ["Docs Todo"];
    docsContext.issueBreakdown.enabled = true;
    docsContext.issueBreakdown.planningLabels = ["docs-planning"];
    docsContext.issueBreakdown.promptTemplate = "Docs planning prompt for {{ issue.identifier }}";
    docsContext.issueBreakdown.cursorMode = "plan";
    const docsRuntimeIssue = issue({
      id: "linear-docs-179",
      identifier: "ENG-179",
      state: "Docs Todo",
      labels: ["docs-planning"],
    });
    const symphonyTracker = trackerClientFixture({ candidates: [], issues: [] });
    const docsRequestedIds: string[][] = [];
    let docsCandidateFetchCount = 0;
    const docsTracker: TrackerClient = {
      async fetchCandidateIssues() {
        docsCandidateFetchCount += 1;
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        docsRequestedIds.push([...issueIds]);
        return issueIds.includes(docsRuntimeIssue.id) ? [structuredClone(docsRuntimeIssue)] : [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: symphonyTracker,
      trackerResolver: (projectContext) => (projectContext?.projectContextId === "docs" ? docsTracker : symphonyTracker),
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/api/v1/issues/docs:${docsRuntimeIssue.id}/planning-run`,
        {
          method: "POST",
          headers: { "x-symphony-token": "secret" },
        },
      );
      const body = (await response.json()) as {
        queued: boolean;
        issue: string;
        issueId: string;
        runPhase: string;
        runKind: string;
        reason: string;
      };

      expect(response.status).toBe(202);
      expect(body).toMatchObject({
        queued: true,
        issue: "ENG-179",
        issueId: docsRuntimeIssue.id,
        runPhase: "issue_breakdown",
        runKind: "planning",
        reason: "explicit_request",
      });
      expect(symphonyTracker.requestedIds).toEqual([]);
      expect(symphonyTracker.candidateFetchCount).toBe(0);
      expect(docsRequestedIds[0]).toEqual([docsRuntimeIssue.id]);
      expect(docsCandidateFetchCount).toBe(0);
      await waitForStatusApiAsync(
        async () =>
          ((await runStore.latestRunForIssue(docsRuntimeIssue.id, {
            role: "worker",
            runPhase: "issue_breakdown",
          }))?.runKind ?? null) === "planning",
        "context-routed direct planning run",
      );
      await expect(
        runStore.latestRunForIssue(docsRuntimeIssue.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toMatchObject({
        issueId: docsRuntimeIssue.id,
        issueIdentifier: docsRuntimeIssue.identifier,
        runPhase: "issue_breakdown",
        runKind: "planning",
        projectContext: expect.objectContaining({ projectContextId: "docs" }),
      });
      expect(harness.runs[0]?.ctx.issue.id).toBe(docsRuntimeIssue.id);
      expect(harness.runs[0]?.ctx.issue).toMatchObject({ projectContext: { projectContextId: "docs" } });
      expect(harness.runs[0]?.ctx.projectContext).toMatchObject({ projectContextId: "docs" });
      expect(harness.runs[0]?.ctx.config.tracker.activeStates).toEqual(["Docs Todo"]);
      expect(harness.runs[0]?.ctx.config.issueBreakdown.planningLabels).toEqual(["docs-planning"]);
      expect(harness.runs[0]?.ctx.runModeOverride).toBe("plan");
      expect(harness.runs[0]?.prompt).toContain("Docs planning prompt for ENG-179");
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("routes explicit default-context planning-run identifier lookups through the resolver-selected default tracker when runtime-shaped issues omit project-context proof", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-default-context-workspaces"),
            state_dir: path.join(root, "planning-default-context-state"),
          },
        },
      }),
      path.join(root, "planning-default-context-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.tracker.activeStates = ["Root Todo"];
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["root-planning"];
    config.issueBreakdown.promptTemplate = "Default planning prompt for {{ issue.identifier }}";
    config.issueBreakdown.cursorMode = "agent";
    const defaultContextId = config.projectContexts.defaultContextId;
    const defaultRuntimeIssue = issue({
      id: "issue-root-planning-1",
      identifier: "ENG-179",
      state: "Root Todo",
      labels: ["root-planning"],
    });
    const baseTracker = trackerClientFixture({ candidates: [], issues: [] });
    const defaultRequestedIds: string[][] = [];
    let defaultCandidateFetchCount = 0;
    const defaultTracker: TrackerClient = {
      async fetchCandidateIssues() {
        defaultCandidateFetchCount += 1;
        return [structuredClone(defaultRuntimeIssue)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        defaultRequestedIds.push([...issueIds]);
        return [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: baseTracker,
      trackerResolver: (projectContext) =>
        projectContext?.projectContextId === defaultContextId ? defaultTracker : baseTracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/api/v1/issues/${defaultContextId}:ENG-179/planning-run`,
        {
          method: "POST",
          headers: { "x-symphony-token": "secret" },
        },
      );
      const body = (await response.json()) as {
        queued: boolean;
        issue: string;
        issueId: string;
        runPhase: string;
        runKind: string;
        reason: string;
      };

      expect(response.status).toBe(202);
      expect(body).toMatchObject({
        queued: true,
        issue: "ENG-179",
        issueId: defaultRuntimeIssue.id,
        runPhase: "issue_breakdown",
        runKind: "planning",
        reason: "explicit_request",
      });
      expect(baseTracker.requestedIds).toEqual([]);
      expect(baseTracker.candidateFetchCount).toBe(0);
      expect(defaultRequestedIds[0]).toEqual(["ENG-179"]);
      expect(defaultCandidateFetchCount).toBe(1);
      await waitForStatusApiAsync(
        async () =>
          ((await runStore.latestRunForIssue(defaultRuntimeIssue.id, {
            role: "worker",
            runPhase: "issue_breakdown",
          }))?.runKind ?? null) === "planning",
        "default-context planning run",
      );
      await expect(
        runStore.latestRunForIssue(defaultRuntimeIssue.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toMatchObject({
        issueId: defaultRuntimeIssue.id,
        issueIdentifier: defaultRuntimeIssue.identifier,
        runPhase: "issue_breakdown",
        runKind: "planning",
        projectContext: expect.objectContaining({ projectContextId: defaultContextId }),
      });
      expect(harness.runs[0]?.ctx.issue.id).toBe(defaultRuntimeIssue.id);
      expect(harness.runs[0]?.ctx.issue).toMatchObject({ projectContext: { projectContextId: defaultContextId } });
      expect(harness.runs[0]?.ctx.projectContext).toMatchObject({ projectContextId: defaultContextId });
      expect(harness.runs[0]?.ctx.config.tracker.activeStates).toEqual(["Root Todo"]);
      expect(harness.runs[0]?.ctx.config.issueBreakdown.planningLabels).toEqual(["root-planning"]);
      expect(harness.runs[0]?.ctx.runModeOverride).toBe("agent");
      expect(harness.runs[0]?.prompt).toContain("Default planning prompt for ENG-179");
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("rejects explicit default-context planning-run apply requests after resolving runtime-shaped issues through the resolver-selected default tracker", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-default-context-apply-workspaces"),
            state_dir: path.join(root, "planning-default-context-apply-state"),
          },
        },
      }),
      path.join(root, "planning-default-context-apply-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.applyToLinear.enabled = false;
    const defaultContextId = config.projectContexts.defaultContextId;
    const defaultRuntimeIssue = issue({
      id: "issue-root-apply-1",
      identifier: "ENG-179",
      state: "Todo",
      labels: ["planning"],
    });
    const baseTracker = trackerClientFixture({ candidates: [], issues: [] });
    const defaultRequestedIds: string[][] = [];
    let defaultCandidateFetchCount = 0;
    const defaultTracker: TrackerClient = {
      async fetchCandidateIssues() {
        defaultCandidateFetchCount += 1;
        return [structuredClone(defaultRuntimeIssue)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        defaultRequestedIds.push([...issueIds]);
        return [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: baseTracker,
      trackerResolver: (projectContext) =>
        projectContext?.projectContextId === defaultContextId ? defaultTracker : baseTracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/api/v1/issues/${defaultContextId}:ENG-179/planning-run/apply`,
        {
          method: "POST",
          headers: { "x-symphony-token": "secret" },
        },
      );
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(401);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toBe("Issue breakdown Linear application is disabled");
      expect(baseTracker.requestedIds).toEqual([]);
      expect(baseTracker.candidateFetchCount).toBe(0);
      expect(defaultRequestedIds[0]).toEqual(["ENG-179"]);
      expect(defaultCandidateFetchCount).toBe(1);
      expect(harness.runs).toHaveLength(0);
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("fails closed for context-qualified planning-run requests when resolved-context tracker credentials are unavailable", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-credential-unavailable-workspaces"),
            state_dir: path.join(root, "planning-context-credential-unavailable-state"),
          },
        },
      }),
      path.join(root, "planning-context-credential-unavailable-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["planning"];
    const rawCredentialMessage =
      "Linear credential capability linear.tracker is owned by worker, but is assigned only to service. Configure credential_profiles.roles.worker.linear.tracker or remove the non-owning assignment to use legacy tracker api key/LINEAR_API_KEY.";
    const resolverProjectContextIds: Array<string | null> = [];
    const baseTracker = trackerClientFixture({ candidates: [], issues: [] });
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: baseTracker,
      trackerResolver: (projectContext) => {
        resolverProjectContextIds.push(projectContext?.projectContextId ?? null);
        if (projectContext?.projectContextId === "docs") {
          throw new SymphonyError("config_validation_error", rawCredentialMessage);
        }
        return baseTracker;
      },
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/planning-run`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          requestedProjectContextId: string | null;
          resolvedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toContain("Issue not found");
      expect(body.error.message).not.toContain("Linear credential capability linear.tracker is owned by worker");
      expect(body.error.message).not.toContain("credential_profiles.roles.worker.linear.tracker");
      expect(body.error.message).not.toContain("LINEAR_API_KEY");
      expect(body.routeEvidence).toMatchObject({
        kind: "issue_breakdown",
        status: "credential_unavailable",
        requestedProjectContextId: "docs",
        resolvedProjectContextId: "docs",
        reason: "resolved_project_context_tracker_unavailable",
        redacted: true,
      });
      expect(JSON.stringify(body.routeEvidence)).not.toContain(rawCredentialMessage);
      expect(JSON.stringify(body.routeEvidence)).not.toContain("credential_profiles.roles.worker.linear.tracker");
      expect(JSON.stringify(body.routeEvidence)).not.toContain("LINEAR_API_KEY");
      expect(resolverProjectContextIds).toEqual(["docs"]);
      expect(baseTracker.requestedIds).toEqual([]);
      expect(baseTracker.candidateFetchCount).toBe(0);
      expect(harness.runs).toHaveLength(0);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("fails closed for context-qualified planning-run apply requests when resolved-context tracker credentials are unavailable", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-apply-credential-unavailable-workspaces"),
            state_dir: path.join(root, "planning-context-apply-credential-unavailable-state"),
          },
        },
      }),
      path.join(root, "planning-context-apply-credential-unavailable-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.applyToLinear.enabled = true;
    const rawCredentialMessage =
      "Linear credential capability linear.tracker is owned by worker, but is assigned only to service. Configure credential_profiles.roles.worker.linear.tracker or remove the non-owning assignment to use legacy tracker api key/LINEAR_API_KEY.";
    const resolverProjectContextIds: Array<string | null> = [];
    const baseTracker = trackerClientFixture({ candidates: [], issues: [] });
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: baseTracker,
      trackerResolver: (projectContext) => {
        resolverProjectContextIds.push(projectContext?.projectContextId ?? null);
        if (projectContext?.projectContextId === "docs") {
          throw new SymphonyError("config_validation_error", rawCredentialMessage);
        }
        return baseTracker;
      },
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/planning-run/apply`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
        body: JSON.stringify({ dryRun: true }),
      });
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          requestedProjectContextId: string | null;
          resolvedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toContain("Issue not found");
      expect(body.error.message).not.toContain("Linear credential capability linear.tracker is owned by worker");
      expect(body.error.message).not.toContain("credential_profiles.roles.worker.linear.tracker");
      expect(body.error.message).not.toContain("LINEAR_API_KEY");
      expect(body.routeEvidence).toMatchObject({
        kind: "issue_breakdown_apply",
        status: "credential_unavailable",
        requestedProjectContextId: "docs",
        resolvedProjectContextId: "docs",
        reason: "resolved_project_context_tracker_unavailable",
        redacted: true,
      });
      expect(JSON.stringify(body.routeEvidence)).not.toContain(rawCredentialMessage);
      expect(JSON.stringify(body.routeEvidence)).not.toContain("credential_profiles.roles.worker.linear.tracker");
      expect(JSON.stringify(body.routeEvidence)).not.toContain("LINEAR_API_KEY");
      expect(resolverProjectContextIds).toEqual(["docs"]);
      expect(baseTracker.requestedIds).toEqual([]);
      expect(baseTracker.candidateFetchCount).toBe(0);
      expect(harness.runs).toHaveLength(0);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("fails closed for context-qualified planning-run internal-id requests when the direct tracker hit lacks project-context proof", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-mismatch-workspaces"),
            state_dir: path.join(root, "planning-context-mismatch-state"),
          },
        },
      }),
      path.join(root, "planning-context-mismatch-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["planning"];
    const directRuntimeIssue = issue({
      id: "linear-symphony-179",
      identifier: "ENG-179",
      state: "Todo",
      labels: ["planning"],
    });
    const wrongContextCandidate = trackerIssue({
      id: directRuntimeIssue.id,
      identifier: directRuntimeIssue.identifier,
      state: directRuntimeIssue.state,
      labels: [...directRuntimeIssue.labels],
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
      routingSource: "candidate_poll",
    });
    const requestedIds: string[][] = [];
    let candidateFetchCount = 0;
    const sharedTracker: TrackerClient = {
      async fetchCandidateIssues() {
        candidateFetchCount += 1;
        return [structuredClone(wrongContextCandidate)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        requestedIds.push([...issueIds]);
        return issueIds.includes(directRuntimeIssue.id) ? [structuredClone(directRuntimeIssue)] : [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: sharedTracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/api/v1/issues/docs:${directRuntimeIssue.id}/planning-run`,
        {
          method: "POST",
          headers: { "x-symphony-token": "secret" },
        },
      );
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          requestedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toContain("Issue not found");
      expect(body.routeEvidence).toMatchObject({
        kind: "issue_breakdown",
        status: "wrong_context",
        requestedProjectContextId: "docs",
        redacted: true,
      });
      expect(body.routeEvidence.reason).toBeDefined();
      expect(body.routeEvidence.sources).toEqual(expect.arrayContaining(["tracker_direct", "tracker_candidate"]));
      expect(requestedIds[0]).toEqual([directRuntimeIssue.id]);
      expect(candidateFetchCount).toBe(1);
      expect(harness.runs).toHaveLength(0);
      await expect(
        runStore.latestRunForIssue(directRuntimeIssue.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toBeNull();
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("fails closed for context-qualified planning-run apply internal-id requests when the direct tracker hit lacks project-context proof", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-apply-mismatch-workspaces"),
            state_dir: path.join(root, "planning-context-apply-mismatch-state"),
          },
        },
      }),
      path.join(root, "planning-context-apply-mismatch-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.applyToLinear.enabled = true;
    const directRuntimeIssue = issue({
      id: "linear-symphony-179",
      identifier: "ENG-179",
      state: "Todo",
      labels: ["planning"],
    });
    const wrongContextCandidate = trackerIssue({
      id: directRuntimeIssue.id,
      identifier: directRuntimeIssue.identifier,
      state: directRuntimeIssue.state,
      labels: [...directRuntimeIssue.labels],
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
      routingSource: "candidate_poll",
    });
    const requestedIds: string[][] = [];
    let candidateFetchCount = 0;
    const sharedTracker: TrackerClient = {
      async fetchCandidateIssues() {
        candidateFetchCount += 1;
        return [structuredClone(wrongContextCandidate)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        requestedIds.push([...issueIds]);
        return issueIds.includes(directRuntimeIssue.id) ? [structuredClone(directRuntimeIssue)] : [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: sharedTracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:${directRuntimeIssue.id}/planning-run/apply`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
        body: JSON.stringify({ dryRun: true }),
      });
      const body = (await response.json()) as {
        error: { code: string; message: string };
        routeEvidence: {
          kind: string;
          status: string;
          requestedProjectContextId: string | null;
          reason: string | null;
          redacted: true;
          sources: string[];
        };
      };

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toContain("Issue not found");
      expect(body.routeEvidence).toMatchObject({
        kind: "issue_breakdown_apply",
        status: "wrong_context",
        requestedProjectContextId: "docs",
        redacted: true,
      });
      expect(body.routeEvidence.reason).toBeDefined();
      expect(body.routeEvidence.sources).toEqual(expect.arrayContaining(["tracker_direct", "tracker_candidate"]));
      expect(requestedIds[0]).toEqual([directRuntimeIssue.id]);
      expect(candidateFetchCount).toBe(1);
      expect(harness.runs).toHaveLength(0);
      await expect(
        runStore.latestRunForIssue(directRuntimeIssue.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toBeNull();
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("rejects planning-run requests when the resolved issue context disables issue breakdown", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-disabled-workspaces"),
            state_dir: path.join(root, "planning-context-disabled-state"),
          },
        },
      }),
      path.join(root, "planning-context-disabled-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["planning"];
    const docsContext = config.projectContexts.byId.get("docs");
    expect(docsContext).toBeDefined();
    if (!docsContext) throw new Error("Expected docs project context in planning disabled fixture");
    docsContext.issueBreakdown.enabled = false;
    const docsCandidate = trackerIssue({
      id: "issue-docs-disabled-1",
      identifier: "ENG-179",
      state: "Todo",
      labels: ["planning"],
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    });
    const symphonyTracker = trackerClientFixture({ candidates: [], issues: [] });
    const docsTracker = trackerClientFixture({ candidates: [docsCandidate], issues: [docsCandidate] });
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: symphonyTracker,
      trackerResolver: (projectContext) => (projectContext?.projectContextId === "docs" ? docsTracker : symphonyTracker),
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/planning-run`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(401);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toBe("Issue breakdown planning is disabled");
      expect(symphonyTracker.requestedIds).toEqual([]);
      expect(symphonyTracker.candidateFetchCount).toBe(0);
      expect(docsTracker.requestedIds[0]).toEqual(["ENG-179"]);
      expect(docsTracker.candidateFetchCount).toBe(1);
      expect(harness.runs).toHaveLength(0);
      await expect(
        runStore.latestRunForIssue(docsCandidate.id, {
          role: "worker",
          runPhase: "issue_breakdown",
        }),
      ).resolves.toBeNull();
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("rejects planning-run apply requests when the resolved issue context disables Linear application", async () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: path.join(root, "planning-context-apply-disabled-workspaces"),
            state_dir: path.join(root, "planning-context-apply-disabled-state"),
          },
        },
      }),
      path.join(root, "planning-context-apply-disabled-WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.applyToLinear.enabled = true;
    const docsContext = config.projectContexts.byId.get("docs");
    expect(docsContext).toBeDefined();
    if (!docsContext) throw new Error("Expected docs project context in planning apply fixture");
    docsContext.issueBreakdown.enabled = true;
    docsContext.issueBreakdown.applyToLinear.enabled = false;
    const docsCandidate = trackerIssue({
      id: "issue-docs-apply-disabled-1",
      identifier: "ENG-179",
      state: "Todo",
      labels: ["planning"],
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    });
    const symphonyTracker = trackerClientFixture({ candidates: [], issues: [] });
    const docsTracker = trackerClientFixture({ candidates: [docsCandidate], issues: [docsCandidate] });
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: symphonyTracker,
      trackerResolver: (projectContext) => (projectContext?.projectContextId === "docs" ? docsTracker : symphonyTracker),
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: config.projectContexts.defaultContextId,
      runStore,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/planning-run/apply`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(401);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toBe("Issue breakdown Linear application is disabled");
      expect(symphonyTracker.requestedIds).toEqual([]);
      expect(symphonyTracker.candidateFetchCount).toBe(0);
      expect(docsTracker.requestedIds[0]).toEqual(["ENG-179"]);
      expect(docsTracker.candidateFetchCount).toBe(1);
      expect(harness.runs).toHaveLength(0);
    } finally {
      await orchestrator.stop();
      await server.stop();
    }
  });

  it("waits for terminal planning-run persistence before stop returns", async () => {
    const candidate = issue({ id: "issue-stop", identifier: "TEST-STOP", state: "Todo", labels: ["planning"] });
    const config = testConfig(path.join(root, "planning-stop"));
    config.issueBreakdown.enabled = true;
    const logger = new StructuredLogger(() => undefined);
    const tracker = new PlanningRunStrictIdTracker(candidate);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new BlockingPlanningFailureLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new PlanningRunRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.requestIssueBreakdown(candidate.id);
    await lifecycleStore.waitForPlanningFailureUpdate();
    expect(orchestrator.snapshot().counts.running).toBe(0);

    let stopSettled = false;
    const stopPromise = orchestrator.stop().then(() => {
      stopSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stopSettled).toBe(false);

    lifecycleStore.releasePlanningFailureUpdate();
    await stopPromise;

    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      planningFailureCount: 1,
      lastPlanningFailureRunId: "planning-api-run",
    });
    await expect(runStore.getRun("planning-api-run")).resolves.toMatchObject({
      status: "failed",
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
  });

  it("protects issue breakdown preview/apply with a fail-closed token", async () => {
    const config = testConfig(path.join(root, "apply-token"));
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    let applyCalls = 0;
    const applyOptions: Array<{ dryRun?: boolean }> = [];
    const orchestrator = Object.assign(fakeOrchestrator(), {
      async applyIssueBreakdownPlan(_issueId: string, options: { dryRun?: boolean }) {
        applyCalls += 1;
        applyOptions.push(options);
        return { status: "preview", plan: { id: "plan-1" }, operations: [] };
      },
    }) as unknown as Orchestrator;
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const noConfiguredToken = await fetch(`${baseUrl}/api/v1/issues/issue-1/planning-run/apply`, {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      expect(noConfiguredToken.status).toBe(401);
      expect(applyCalls).toBe(0);
      (server as unknown as { options: { openWorkspaceToken: string } }).options.openWorkspaceToken = "secret";
      const missing = await fetch(`${baseUrl}/api/v1/issues/issue-1/planning-run/apply`, {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      const invalid = await fetch(`${baseUrl}/api/v1/issues/issue-1/planning-run/apply`, {
        method: "POST",
        headers: { "x-symphony-token": "wrong" },
        body: JSON.stringify({ dryRun: false }),
      });
      const valid = await fetch(`${baseUrl}/api/v1/issues/issue-1/planning-run/apply`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
        body: JSON.stringify({ mode: "preview" }),
      });
      const validApply = await fetch(`${baseUrl}/api/v1/issues/issue-1/planning-run/apply`, {
        method: "POST",
        headers: { "x-symphony-token": "secret" },
        body: JSON.stringify({ dryRun: false }),
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(valid.status).toBe(200);
      expect(validApply.status).toBe(200);
      expect(applyCalls).toBe(2);
      expect(applyOptions).toEqual([{ dryRun: true }, { dryRun: false }]);
    } finally {
      await server.stop();
    }
  });

  it("serves a redacted globally sorted activity feed from persisted transcripts", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-a",
      sessionId: "session-a",
      agentId: "agent-a",
      role: "worker",
      issueId: "issue-a",
      issueIdentifier: "TEST-A",
      attempt: null,
      turnNumber: 1,
      prompt: "PROMPT_SECRET_A",
      workspaceKey: "TEST-A",
      workspacePath: path.join(config.workspace.root, "TEST-A"),
    });
    await runStore.startRun({
      runId: "run-b",
      sessionId: "session-b",
      agentId: "agent-b",
      role: "reviewer",
      issueId: "issue-b",
      issueIdentifier: "TEST-B",
      attempt: null,
      turnNumber: 1,
      prompt: "PROMPT_SECRET_B",
      workspaceKey: "TEST-B",
      workspacePath: path.join(config.workspace.root, "TEST-B"),
    });
    await runStore.appendEvent({
      runId: "run-a",
      at: "2030-01-01T00:04:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "safe run-a progress",
      payload: { secret: "PAYLOAD_SECRET_A" },
    });
    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      await runStore.appendEvent({
        runId: "run-b",
        sequence,
        at: "2030-01-01T00:00:00.000Z",
        source: "harness",
        eventType: "tokens",
        payload: { secret: `PAYLOAD_SECRET_B_${sequence}` },
      });
    }
    await runStore.appendEvent({
      runId: "run-b",
      sequence: 1_001,
      at: "2030-01-01T00:05:00.000Z",
      source: "orchestrator",
      eventType: "pr_updated",
      message: "latest from long transcript",
      payload: { secret: "PAYLOAD_SECRET_B_LATEST" },
    });
    const writebackOutbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writebackOperation = await writebackOutbox.enqueueOnce({
      idempotencyKey: "comment:issue-b:report",
      kind: "comment",
      issueId: "issue-b",
      runId: "run-b",
      payload: {
        body: "WRITEBACK_BODY_SECRET /local/workspace/path",
        dedupeKey: "report",
      },
    });

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      writebackOutbox,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const firstPageResponse = await fetch(`${baseUrl}/api/v1/activity?limit=1`);
      const firstPageText = await firstPageResponse.text();
      const firstPage = JSON.parse(firstPageText) as {
        limit: number;
        nextOffset: number | null;
        activity: Array<{
          kind: string;
          source: string;
          issue: { identifier: string };
          run: { runId: string; role: string } | null;
          transcript: { sequence: number; eventType: string; message: string | null } | null;
          links: { issue?: string; run: string | null; transcript: string | null };
          id?: string;
          writeback?: null | {
            operationKind: string;
            status: string;
            attempt: number;
            createdAt: string;
            updatedAt: string;
            nextAttemptAt: string;
            comment: null | { dedupeKey: string; bodyLength: number; bodyRedacted: true };
          };
        }>;
        counts: {
          totalItems: number;
          distinctRunsConsidered: number;
          transcriptEventsConsidered: number;
          transcriptEventsTotal: number;
          transcriptEventsIncluded: number;
          transcriptEventsTruncated: boolean;
          syntheticRunEvents: number;
          writebackOperationsConsidered: number;
        };
        source: { runStoreAvailable: boolean; writebackOutboxAvailable: boolean; transcriptTailPerRun: number };
      };
      const secondPageResponse = await fetch(`${baseUrl}/api/v1/activity?offset=1&limit=1`);
      const secondPage = (await secondPageResponse.json()) as typeof firstPage;
      const issueResponse = await fetch(`${baseUrl}/api/v1/activity?issue=TEST-A&limit=100`);
      const issueBody = (await issueResponse.json()) as typeof firstPage;
      const writebackResponse = await fetch(`${baseUrl}/api/v1/activity?issue=TEST-B&offset=500&limit=10`);
      const writebackText = await writebackResponse.text();
      const writebackBody = JSON.parse(writebackText) as typeof firstPage;
      const clampedResponse = await fetch(`${baseUrl}/api/v1/activity?limit=999`);
      const clampedBody = (await clampedResponse.json()) as { limit: number };

      expect(firstPageResponse.status).toBe(200);
      expect(firstPage.activity).toHaveLength(1);
      expect(firstPage.activity[0]).toMatchObject({
        kind: "transcript_event",
        source: "orchestrator",
        issue: { identifier: "TEST-B" },
        run: { runId: "run-b", role: "reviewer" },
        transcript: { sequence: 1_001, eventType: "pr_updated", message: "latest from long transcript" },
        links: {
          run: "/api/v1/runs/run-b",
          transcript: "/api/v1/runs/run-b/transcript?offset=1000&limit=1",
        },
      });
      expect(firstPage.nextOffset).toBe(1);
      expect(firstPage.counts).toMatchObject({
        totalItems: 504,
        distinctRunsConsidered: 2,
        transcriptEventsConsidered: 501,
        transcriptEventsTotal: 1_002,
        transcriptEventsIncluded: 501,
        transcriptEventsTruncated: true,
        syntheticRunEvents: 2,
        writebackOperationsConsidered: 1,
      });
      expect(firstPage.source.runStoreAvailable).toBe(true);
      expect(firstPage.source.writebackOutboxAvailable).toBe(true);
      expect(firstPage.source.transcriptTailPerRun).toBe(500);
      expect(firstPageText).not.toContain("PROMPT_SECRET");
      expect(firstPageText).not.toContain("PAYLOAD_SECRET");
      expect(secondPage.activity[0]?.issue.identifier).toBe("TEST-A");
      expect(issueBody.activity.map((item) => item.issue.identifier)).toEqual(["TEST-A", "TEST-A"]);
      expect(issueBody.counts.distinctRunsConsidered).toBe(1);
      const writebackItem = writebackBody.activity.find((item) => item.id === "writeback:comment:issue-b:report");
      expect(writebackItem).toMatchObject({
        at: writebackOperation.updatedAt,
        kind: "writeback_operation",
        source: "writeback",
        issue: { id: "issue-b", identifier: "TEST-B" },
        run: { runId: "run-b" },
        transcript: null,
        writeback: {
          operationKind: "comment",
          status: "pending",
          attempt: 0,
          comment: {
            dedupeKey: "report",
            bodyLength: "WRITEBACK_BODY_SECRET /local/workspace/path".length,
            bodyRedacted: true,
          },
        },
        links: {
          issue: "/api/v1/board/issues/TEST-B",
          run: "/api/v1/runs/run-b",
          transcript: null,
        },
      });
      expect(writebackBody.counts.writebackOperationsConsidered).toBe(1);
      expect(writebackText).not.toContain("WRITEBACK_BODY_SECRET");
      expect(writebackText).not.toContain("/local/workspace/path");
      expect(clampedBody.limit).toBe(100);
    } finally {
      await server.stop();
    }
  });

  it("serves redacted legacy transcript rows without backfilling counts during GET", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-legacy-secret",
      sessionId: "session-legacy-secret",
      agentId: "agent-legacy-secret",
      role: "worker",
      issueId: "issue-legacy-secret",
      issueIdentifier: "TEST-LEGACY-SECRET",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-LEGACY-SECRET",
      workspacePath: path.join(config.workspace.root, "TEST-LEGACY-SECRET"),
    });
    await runStore.appendEvent({
      runId: "run-legacy-secret",
      at: "2030-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message:
        "raw assistant SECRET_ACTIVITY token=activity-token access_token=activity-access refreshToken: activity-refresh github_token=activity-github client_secret: activity-client private_key=activity-private ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      payload: {
        activitySource: "stream",
        apiKey: "SECRET_API_KEY",
        detail: "Bearer SECRET_BEARER",
        access_token: "payload-access",
        refreshToken: "payload-refresh",
        github_token: "payload-github",
        client_secret: "payload-client",
        private_key: "payload-private",
        tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        tokenConfigured: true,
      },
    });
    const metaPath = path.join(config.workspace.stateDir, "runs", "run-legacy-secret", "meta.json");
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as { transcriptEventCount?: number };
    delete metadata.transcriptEventCount;
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const beforeRead = await readFile(metaPath, "utf8");

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const transcriptResponse = await fetch(`${baseUrl}/api/v1/runs/run-legacy-secret/transcript`);
      const activityResponse = await fetch(`${baseUrl}/api/v1/activity?issue=TEST-LEGACY-SECRET&limit=10`);
      const transcriptText = await transcriptResponse.text();
      const activityText = await activityResponse.text();

      expect(transcriptResponse.status).toBe(200);
      expect(activityResponse.status).toBe(200);
      expect(`${transcriptText}\n${activityText}`).not.toContain("SECRET_ACTIVITY");
      expect(`${transcriptText}\n${activityText}`).not.toContain("activity-token");
      expect(`${transcriptText}\n${activityText}`).not.toContain("SECRET_API_KEY");
      expect(`${transcriptText}\n${activityText}`).not.toContain("SECRET_BEARER");
      expect(`${transcriptText}\n${activityText}`).not.toContain("activity-access");
      expect(`${transcriptText}\n${activityText}`).not.toContain("activity-refresh");
      expect(`${transcriptText}\n${activityText}`).not.toContain("activity-github");
      expect(`${transcriptText}\n${activityText}`).not.toContain("activity-client");
      expect(`${transcriptText}\n${activityText}`).not.toContain("activity-private");
      expect(`${transcriptText}\n${activityText}`).not.toContain("payload-access");
      expect(`${transcriptText}\n${activityText}`).not.toContain("payload-refresh");
      expect(`${transcriptText}\n${activityText}`).not.toContain("payload-github");
      expect(`${transcriptText}\n${activityText}`).not.toContain("payload-client");
      expect(`${transcriptText}\n${activityText}`).not.toContain("payload-private");
      expect(`${transcriptText}\n${activityText}`).not.toContain("ghp_ABCDEFGH1");
      expect(`${transcriptText}\n${activityText}`).not.toContain("sk-ABCDEFGH1");
      expect(`${transcriptText}\n${activityText}`).toContain("inputTokens");
      expect(`${transcriptText}\n${activityText}`).toContain("totalTokens");
      expect(`${transcriptText}\n${activityText}`).toContain("tokenConfigured");
      expect(`${transcriptText}\n${activityText}`).toContain("[redacted]");
      expect(await readFile(metaPath, "utf8")).toBe(beforeRead);
    } finally {
      await server.stop();
    }
  });

  it("serves redacted run errors across public status surfaces without mutating persisted runs", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.upsertWorkspace({
      workspaceKey: "TEST-RUN-ERROR",
      issueId: "issue-run-error",
      issueIdentifier: "TEST-RUN-ERROR",
      path: path.join(config.workspace.root, "TEST-RUN-ERROR"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-RUN-ERROR",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-error-secret",
      sessionId: "session-error-secret",
      agentId: "agent-error-secret",
      role: "worker",
      issueId: "issue-run-error",
      issueIdentifier: "TEST-RUN-ERROR",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-RUN-ERROR",
      workspacePath: path.join(config.workspace.root, "TEST-RUN-ERROR"),
      gitBranchName: "symphony/TEST-RUN-ERROR",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    const rawError =
      "failed SECRET_RUN_ERROR token=run-token access_token=run-access Bearer run-bearer ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7";
    const rawCancelFailure = "cancel SECRET_CANCEL_FAILURE token=cancel-token client_secret: cancel-client";
    await runStore.updateRun("run-error-secret", {
      status: "cancelled",
      completedAt: "2026-01-01T00:05:00.000Z",
      error: rawError,
      metadata: {
        cancelFailed: true,
        cancelFailedAt: "2026-01-01T00:05:01.000Z",
        cancelFailedReason: rawCancelFailure,
        cancelFailedSource: "cancel_ignored",
      },
    });
    const tracker = new FakeTracker([
      issue({
        id: "issue-run-error",
        identifier: "TEST-RUN-ERROR",
        title: "Run error redaction",
        state: "In Progress",
      }),
    ]);
    const metaPath = path.join(config.workspace.stateDir, "runs", "run-error-secret", "meta.json");
    const beforeRead = await readFile(metaPath, "utf8");
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([], { paused: ["TEST-RUN-ERROR"] }),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      tracker,
      trackerStateLists: testTrackerStateLists(),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const responses = await Promise.all([
        fetch(`${baseUrl}/api/v1/runs/run-error-secret`),
        fetch(`${baseUrl}/api/v1/issues/TEST-RUN-ERROR`),
        fetch(`${baseUrl}/api/v1/issues/TEST-RUN-ERROR/runs`),
        fetch(`${baseUrl}/api/v1/board`),
        fetch(`${baseUrl}/api/v1/issue-board`),
        fetch(`${baseUrl}/api/v1/board/issues/issue-run-error`),
        fetch(`${baseUrl}/api/v1/state`),
      ]);
      const [runBody, issueBody, issueRunsBody, boardBody, issueBoardBody, boardDetailBody, stateBody] = await Promise.all(
        responses.map(async (response) => {
          expect(response.status).toBe(200);
          return response.json() as Promise<Record<string, unknown>>;
        }),
      );
      const responseText = JSON.stringify({ runBody, issueBody, issueRunsBody, boardBody, issueBoardBody, boardDetailBody, stateBody });

      for (const raw of [
        "SECRET_RUN_ERROR",
        "run-token",
        "run-access",
        "run-bearer",
        "ghp_ABCDEFGH1",
        "sk-ABCDEFGH1",
        "SECRET_CANCEL_FAILURE",
        "cancel-token",
        "cancel-client",
      ]) {
        expect(responseText).not.toContain(raw);
      }
      expect(responseText).toContain("failed");
      expect(responseText).toContain("cancel");
      expect(responseText).toContain("inputTokens");
      expect(responseText).toContain("[redacted]");

      const runRecord = runBody as {
        error: string | null;
        cancelFailedReason: string | null;
        operatorLiveness: {
          lastMessage: string | null;
          cancelFailed: { reason: string | null };
          timeline: Array<{ kind: string; detail: string | null }>;
        };
      };
      expect(runRecord.error).toContain("[redacted]");
      expect(runRecord.cancelFailedReason).toContain("[redacted]");
      expect(runRecord.operatorLiveness.lastMessage).toContain("[redacted]");
      expect(runRecord.operatorLiveness.cancelFailed.reason).toContain("[redacted]");
      expect(runRecord.operatorLiveness.timeline.find((item) => item.kind === "run_terminal")?.detail).toContain("[redacted]");
      expect(runRecord.operatorLiveness.timeline.find((item) => item.kind === "cancel_failed")?.detail).toContain("[redacted]");

      const issue = issueBody as {
        latestRun: { error: string | null };
        issueDetails: IssueDetailsEnvelope;
        operatorLiveness: typeof runRecord.operatorLiveness;
      };
      expect(issue.latestRun.error).toBe(runRecord.error);
      expect(issue.issueDetails.latestRun.error).toBe(runRecord.error);
      expect(issue.operatorLiveness.lastMessage).toBe(runRecord.operatorLiveness.lastMessage);

      const issueRuns = issueRunsBody as {
        issueDetails: IssueDetailsEnvelope;
        runs: Array<{ runId: string; error: string | null; operatorLiveness: typeof runRecord.operatorLiveness }>;
      };
      const issueRun = issueRuns.runs.find((run) => run.runId === "run-error-secret");
      expect(issueRuns.issueDetails.latestRun.error).toBe(runRecord.error);
      expect(issueRun?.error).toBe(runRecord.error);
      expect(issueRun?.operatorLiveness.lastMessage).toBe(runRecord.operatorLiveness.lastMessage);

      const board = boardBody as { issues: Array<{ issueIdentifier: string | null; issueDetails: IssueDetailsEnvelope }> };
      const issueBoard = issueBoardBody as { issues: Array<{ issueIdentifier: string | null; issueDetails: IssueDetailsEnvelope }> };
      expect(board.issues.find((item) => item.issueIdentifier === "TEST-RUN-ERROR")?.issueDetails.latestRun.error).toBe(runRecord.error);
      expect(issueBoard.issues.find((item) => item.issueIdentifier === "TEST-RUN-ERROR")?.issueDetails.latestRun.error).toBe(runRecord.error);

      const boardDetail = boardDetailBody as {
        latestRun: { error: string | null };
        issueDetails: IssueDetailsEnvelope;
        boardCard: { issueDetails: IssueDetailsEnvelope } | null;
        runs: Array<{ runId: string; error: string | null; operatorLiveness: typeof runRecord.operatorLiveness }>;
        operatorLiveness: typeof runRecord.operatorLiveness;
      };
      expect(boardDetail.latestRun.error).toBe(runRecord.error);
      expect(boardDetail.issueDetails.latestRun.error).toBe(runRecord.error);
      expect(boardDetail.boardCard?.issueDetails.latestRun.error).toBe(runRecord.error);
      expect(boardDetail.runs.find((run) => run.runId === "run-error-secret")?.error).toBe(runRecord.error);
      expect(boardDetail.operatorLiveness.lastMessage).toBe(runRecord.operatorLiveness.lastMessage);

      const state = stateBody as { operatorView: { paused: Array<{ issueDetails: IssueDetailsEnvelope }> } };
      expect(state.operatorView.paused.find((item) => item.issueDetails.issue.identifier === "TEST-RUN-ERROR")?.issueDetails.latestRun.error).toBe(
        runRecord.error,
      );
      expect(await readFile(metaPath, "utf8")).toBe(beforeRead);
      expect(beforeRead).toContain(rawError);
      expect(beforeRead).toContain(rawCancelFailure);
    } finally {
      await server.stop();
    }
  });

  it("serves redacted live liveness diagnostics across public status surfaces without mutating live rows", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const liveRunning = liveRunningFixture(config, "TEST-LIVE-SECRET", "In Progress");
    const rawLastEvent = "progress SECRET_LIVE_EVENT token=event-token";
    const rawLastMessage =
      "live SECRET_LIVE_MESSAGE token=live-token access_token=live-access Bearer live-bearer ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7";
    const rawCancelReason = "cancel SECRET_LIVE_CANCEL token=cancel-token client_secret: cancel-client";
    const rawHarnessStopReason = "harness SECRET_LIVE_HARNESS Bearer harness-bearer github_token=harness-github private_key: harness-private";
    const rawNestedCancelReason = "nested SECRET_LIVE_NESTED refreshToken: nested-refresh sk-HIJKLMNO1";

    liveRunning.runId = "run-live-secret";
    liveRunning.sessionId = "session-live-secret";
    liveRunning.lastEvent = rawLastEvent;
    liveRunning.lastMessage = rawLastMessage;
    liveRunning.lastEventAt = "2026-01-01T00:00:03.000Z";
    liveRunning.liveness = {
      status: "cancelling",
      activeRunId: "run-live-secret",
      lastActivityAt: "2026-01-01T00:00:03.000Z",
      secondsSinceLastActivity: 2,
      stallTimeoutMs: 300_000,
    };
    liveRunning.cancellation = {
      requested: true,
      requestedAt: "2026-01-01T00:00:02.000Z",
      source: "operator",
      reason: rawCancelReason,
      abortSignalled: true,
      harnessStopRequestedAt: "2026-01-01T00:00:02.000Z",
      harnessStopFailedAt: "2026-01-01T00:00:04.000Z",
      harnessStopFailedReason: rawHarnessStopReason,
      cancelFailed: {
        tracked: true,
        active: true,
        phase: "failed",
        at: "2026-01-01T00:00:04.000Z",
        reason: rawNestedCancelReason,
        source: "harness_stop",
      },
      suppressRetryOnExit: true,
    };
    await runStore.startRun({
      runId: liveRunning.runId,
      sessionId: liveRunning.sessionId,
      agentId: "agent-live-secret",
      role: "worker",
      issueId: liveRunning.issueId,
      issueIdentifier: liveRunning.issueIdentifier,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: liveRunning.issueIdentifier,
      workspacePath: path.join(config.workspace.root, liveRunning.issueIdentifier),
    });
    const tracker = new FakeTracker([
      issue({
        id: liveRunning.issueId,
        identifier: liveRunning.issueIdentifier,
        title: "Live diagnostic redaction",
        state: "In Progress",
      }),
    ]);
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([liveRunning]),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      tracker,
      trackerStateLists: testTrackerStateLists(),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const responses = await Promise.all([
        fetch(`${baseUrl}/api/v1/runs/${liveRunning.runId}`),
        fetch(`${baseUrl}/api/v1/issues/${liveRunning.issueIdentifier}`),
        fetch(`${baseUrl}/api/v1/issues/${liveRunning.issueIdentifier}/runs`),
        fetch(`${baseUrl}/api/v1/board`),
        fetch(`${baseUrl}/api/v1/issue-board`),
        fetch(`${baseUrl}/api/v1/board/issues/${liveRunning.issueId}`),
      ]);
      const [runBody, issueBody, issueRunsBody, boardBody, issueBoardBody, boardDetailBody] = await Promise.all(
        responses.map(async (response) => {
          expect(response.status).toBe(200);
          return response.json() as Promise<Record<string, unknown>>;
        }),
      );
      const responseText = JSON.stringify({ runBody, issueBody, issueRunsBody, boardBody, issueBoardBody, boardDetailBody });

      for (const raw of [
        "SECRET_LIVE_EVENT",
        "event-token",
        "SECRET_LIVE_MESSAGE",
        "live-token",
        "live-access",
        "live-bearer",
        "ghp_ABCDEFGH1",
        "sk-ABCDEFGH1",
        "SECRET_LIVE_CANCEL",
        "cancel-token",
        "cancel-client",
        "SECRET_LIVE_HARNESS",
        "harness-bearer",
        "harness-github",
        "harness-private",
        "SECRET_LIVE_NESTED",
        "nested-refresh",
        "sk-HIJKLMNO1",
      ]) {
        expect(responseText).not.toContain(raw);
      }
      expect(responseText).toContain("[redacted]");
      expect(responseText).toContain("inputTokens");

      type PublicLiveLiveness = {
        lastTranscriptEvent: string | null;
        lastMessage: string | null;
        cancellation: {
          reason: string | null;
          harnessStopFailedReason?: string | null;
          cancelFailed?: { reason: string | null };
        };
        cancelFailed: { reason: string | null };
        timeline: Array<{ kind: string; detail: string | null }>;
      };
      const runLiveness = (runBody as { operatorLiveness: PublicLiveLiveness }).operatorLiveness;
      const timelineDetail = (kind: string) => runLiveness.timeline.find((item) => item.kind === kind)?.detail ?? "";
      expect(runLiveness.lastTranscriptEvent ?? "").toContain("[redacted]");
      expect(runLiveness.lastMessage ?? "").toContain("[redacted]");
      expect(runLiveness.cancellation.reason ?? "").toContain("[redacted]");
      expect(runLiveness.cancellation.harnessStopFailedReason ?? "").toContain("[redacted]");
      expect(runLiveness.cancellation.cancelFailed?.reason ?? "").toContain("[redacted]");
      expect(runLiveness.cancelFailed.reason ?? "").toContain("[redacted]");
      expect(timelineDetail("last_activity")).toContain("[redacted]");
      expect(timelineDetail("cancellation_requested")).toContain("[redacted]");
      expect(timelineDetail("harness_stop_failed")).toContain("[redacted]");

      const issueLive = (issueBody as {
        live: { lastEvent: string | null; lastMessage: string | null; cancellation: PublicLiveLiveness["cancellation"]; operatorLiveness: PublicLiveLiveness };
        operatorLiveness: PublicLiveLiveness;
      }).live;
      expect(issueLive.lastEvent).toBe(runLiveness.lastTranscriptEvent);
      expect(issueLive.lastMessage).toBe(runLiveness.lastMessage);
      expect(issueLive.cancellation.reason).toBe(runLiveness.cancellation.reason);
      expect(issueLive.cancellation.harnessStopFailedReason).toBe(runLiveness.cancellation.harnessStopFailedReason);
      expect(issueLive.cancellation.cancelFailed?.reason).toBe(runLiveness.cancellation.cancelFailed?.reason);
      expect(issueLive.operatorLiveness.lastMessage).toBe(runLiveness.lastMessage);
      expect((issueBody as { operatorLiveness: PublicLiveLiveness }).operatorLiveness.lastMessage).toBe(runLiveness.lastMessage);

      const issueRuns = issueRunsBody as { runs: Array<{ runId: string; operatorLiveness: PublicLiveLiveness }> };
      expect(issueRuns.runs.find((run) => run.runId === liveRunning.runId)?.operatorLiveness.lastMessage).toBe(runLiveness.lastMessage);
      const boardDetail = boardDetailBody as { live: { lastMessage: string | null }; operatorLiveness: PublicLiveLiveness };
      expect(boardDetail.live.lastMessage).toBe(runLiveness.lastMessage);
      expect(boardDetail.operatorLiveness.cancelFailed.reason).toBe(runLiveness.cancelFailed.reason);

      expect(liveRunning.lastEvent).toBe(rawLastEvent);
      expect(liveRunning.lastMessage).toBe(rawLastMessage);
      expect(liveRunning.cancellation.reason).toBe(rawCancelReason);
      expect(liveRunning.cancellation.harnessStopFailedReason).toBe(rawHarnessStopReason);
      expect(liveRunning.cancellation.cancelFailed?.reason).toBe(rawNestedCancelReason);
    } finally {
      await server.stop();
    }
  });

  it("serves redacted cursor-derived transcript rows without backfilling counts during GET", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-cursor-secret",
      sessionId: "session-cursor-secret",
      agentId: "agent-cursor-secret",
      role: "worker",
      issueId: "issue-cursor-secret",
      issueIdentifier: "TEST-CURSOR-SECRET",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-CURSOR-SECRET",
      workspacePath: path.join(config.workspace.root, "TEST-CURSOR-SECRET"),
    });
    await runStore.appendEvent({
      runId: "run-cursor-secret",
      at: "2030-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message:
        "assistant stream SECRET_STREAM token=stream-token access_token=stream-access github_token=stream-github client_secret: stream-client private_key=stream-private ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      payload: {
        type: "progress",
        activitySource: "stream",
        message:
          "assistant stream payload SECRET_STREAM_PAYLOAD token=stream-payload-token client_secret: stream-payload-client inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      },
    });
    await runStore.appendEvent({
      runId: "run-cursor-secret",
      at: "2030-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message:
        "text delta SECRET_DELTA token=delta-token apiKey=delta-api private_key=delta-private sk-HIJKLMNO1 inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      payload: {
        type: "progress",
        activitySource: "delta",
        message:
          "text delta payload SECRET_DELTA_PAYLOAD refreshToken: delta-refresh github_token=delta-github inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      },
    });
    await runStore.appendEvent({
      runId: "run-cursor-secret",
      at: "2030-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "run_diagnostic",
      message:
        "status diagnostic SECRET_DIAGNOSTIC token=diagnostic-token client_secret: diagnostic-client private_key=diagnostic-private inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      payload: {
        type: "run_diagnostic",
        code: "cursor_stream_status_error",
        status: "ERROR",
        message:
          "diagnostic payload SECRET_DIAGNOSTIC_PAYLOAD access_token=diagnostic-access github_token=diagnostic-github inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      },
    });
    await runStore.appendEvent({
      runId: "run-cursor-secret",
      at: "2030-01-01T00:00:03.000Z",
      source: "cursor",
      eventType: "status",
      message: "Cursor status ERROR",
      payload: {
        kind: "status",
        status: "ERROR",
        messagePreview:
          "cursor status SECRET_CURSOR_STATUS token=status-token access_token=status-access github_token=status-github client_secret: status-client private_key=status-private ghp_QRSTUVWX1 sk-QRSTUVWX1 inputTokens: 7 totalTokens: 9 tokenConfigured: true",
        truncated: false,
      },
    });
    const metaPath = path.join(config.workspace.stateDir, "runs", "run-cursor-secret", "meta.json");
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as { transcriptEventCount?: number };
    delete metadata.transcriptEventCount;
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const beforeRead = await readFile(metaPath, "utf8");

    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const transcriptResponse = await fetch(`${baseUrl}/api/v1/runs/run-cursor-secret/transcript`);
      const activityResponse = await fetch(`${baseUrl}/api/v1/activity?issue=TEST-CURSOR-SECRET&limit=10`);
      const transcriptText = await transcriptResponse.text();
      const activityText = await activityResponse.text();
      const combinedText = `${transcriptText}\n${activityText}`;

      expect(transcriptResponse.status).toBe(200);
      expect(activityResponse.status).toBe(200);
      for (const rawValue of [
        "SECRET_STREAM",
        "stream-token",
        "stream-access",
        "stream-github",
        "stream-client",
        "stream-private",
        "ghp_ABCDEFGH1",
        "sk-ABCDEFGH1",
        "SECRET_STREAM_PAYLOAD",
        "stream-payload-token",
        "stream-payload-client",
        "SECRET_DELTA",
        "delta-token",
        "delta-api",
        "delta-private",
        "sk-HIJKLMNO1",
        "SECRET_DELTA_PAYLOAD",
        "delta-refresh",
        "delta-github",
        "SECRET_DIAGNOSTIC",
        "diagnostic-token",
        "diagnostic-client",
        "diagnostic-private",
        "SECRET_DIAGNOSTIC_PAYLOAD",
        "diagnostic-access",
        "diagnostic-github",
        "SECRET_CURSOR_STATUS",
        "status-token",
        "status-access",
        "status-github",
        "status-client",
        "status-private",
        "ghp_QRSTUVWX1",
        "sk-QRSTUVWX1",
      ]) {
        expect(combinedText).not.toContain(rawValue);
      }
      expect(combinedText).toContain("activitySource");
      expect(combinedText).toContain("stream");
      expect(combinedText).toContain("delta");
      expect(combinedText).toContain("cursor_stream_status_error");
      expect(combinedText).toContain("\"eventType\": \"status\"");
      expect(combinedText).toContain("\"kind\": \"status\"");
      expect(combinedText).toContain("inputTokens");
      expect(combinedText).toContain("totalTokens");
      expect(combinedText).toContain("tokenConfigured");
      expect(combinedText).toContain("[redacted]");
      expect(await readFile(metaPath, "utf8")).toBe(beforeRead);
    } finally {
      await server.stop();
    }
  });

  it("labels persisted running runs that are not live as not_live without mutating history", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-orphaned",
      sessionId: "session-orphaned",
      agentId: "agent-orphaned",
      role: "worker",
      issueId: "issue-orphaned",
      issueIdentifier: "TEST-ORPHANED",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-ORPHANED",
      workspacePath: path.join(config.workspace.root, "TEST-ORPHANED"),
    });
    await runStore.updateRun("run-orphaned", {
      metadata: {
        sdkRunStatus: "running",
        sdkRunStatusObservedAt: "2026-01-01T00:00:01.000Z",
        sdkRunStatusSource: "initial",
      },
    });
    const runMetaPath = path.join(config.workspace.stateDir, "runs", "run-orphaned", "meta.json");
    const legacyRun = JSON.parse(await readFile(runMetaPath, "utf8")) as { role?: string };
    delete legacyRun.role;
    await writeFile(runMetaPath, `${JSON.stringify(legacyRun, null, 2)}\n`, "utf8");
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-ORPHANED`);
      const issueRunsResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-ORPHANED/runs`);
      const runResponse = await fetch(`${baseUrl}/api/v1/runs/run-orphaned`);
      const webHistoryResponse = await fetch(`${baseUrl}/api/v1/web/history?refresh=1`);
      const dashboardResponse = await fetch(`${baseUrl}/`);
      const stateBody = (await stateResponse.json()) as {
        operatorView: { orphaned: Array<{ runId: string; status: string; tracking: string; controls: { cancel: boolean } }> };
        operatorLivenessContract: { version: string; supportedStatuses: string[] };
      };
      const issueBody = (await issueResponse.json()) as { operatorLiveness: { status: string; tracking: string; rawStatus: string } };
      const issueRunsBody = (await issueRunsResponse.json()) as {
        runs: Array<{
          runId: string;
          status: string;
          livenessSummary: { status: string; tracking: string; rawStatus: string };
          operatorLiveness: { status: string; tracking: string; rawStatus: string };
        }>;
      };
      const runBody = (await runResponse.json()) as { status: string; operatorLiveness: { status: string; tracking: string; rawStatus: string } };
      const webHistoryBody = (await webHistoryResponse.json()) as {
        sessions: Array<{ id: string; state: string; lastEvent: string; runSession: { status: string } }>;
      };
      const html = await dashboardResponse.text();

      expect(stateBody.operatorLivenessContract.version).toBe("sdk-run-lifecycle-v2");
      expect(stateBody.operatorLivenessContract.supportedStatuses).toContain("not_live");
      expect(stateBody.operatorView.orphaned[0]).toMatchObject({
        runId: "run-orphaned",
        status: "not_live",
        tracking: "orphaned",
        controls: { cancel: false },
      });
      expect(issueBody.operatorLiveness).toMatchObject({ status: "not_live", tracking: "orphaned", rawStatus: "running" });
      const issueRun = issueRunsBody.runs.find((run) => run.runId === "run-orphaned");
      expect(issueRun).toMatchObject({
        status: "running",
        livenessSummary: { status: "not_live", tracking: "orphaned", rawStatus: "running" },
        operatorLiveness: { status: "not_live", tracking: "orphaned", rawStatus: "running" },
      });
      expect(runBody).toMatchObject({
        status: "running",
        operatorLiveness: { status: "not_live", tracking: "orphaned", rawStatus: "running" },
      });
      expect(webHistoryBody.sessions[0]).toMatchObject({
        id: "run-orphaned",
        state: "not_live",
        lastEvent: "TEST-ORPHANED not live",
        runSession: { status: "running" },
      });
      expect(html).toContain("Not Live Runs");
      expect(html).toContain("TEST-ORPHANED");
      expect(html).toContain("unknown");
      expect(html).toContain("controls: none");
      await expect(runStore.getRun("run-orphaned")).resolves.toMatchObject({ status: "running" });
    } finally {
      await server.stop();
    }
  });

  it("serves an empty activity feed when no run store is configured", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/activity`);
      const body = (await response.json()) as {
        activity: unknown[];
        nextOffset: number | null;
        counts: {
          totalItems: number;
          distinctRunsConsidered: number;
          transcriptEventsConsidered: number;
          transcriptEventsTotal: number;
          transcriptEventsIncluded: number;
          transcriptEventsTruncated: boolean;
          syntheticRunEvents: number;
          writebackOperationsConsidered: number;
        };
        source: { kind: string; runStoreAvailable: boolean; writebackOutboxAvailable: boolean; transcriptTailPerRun: number };
      };

      expect(response.status).toBe(200);
      expect(body.activity).toEqual([]);
      expect(body.nextOffset).toBeNull();
      expect(body.counts).toEqual({
        totalItems: 0,
        distinctRunsConsidered: 0,
        transcriptEventsConsidered: 0,
        transcriptEventsTotal: 0,
        transcriptEventsIncluded: 0,
        transcriptEventsTruncated: false,
        syntheticRunEvents: 0,
        writebackOperationsConsidered: 0,
      });
      expect(body.source).toEqual({ kind: "durable_activity", runStoreAvailable: false, writebackOutboxAvailable: false, transcriptTailPerRun: 500 });
    } finally {
      await server.stop();
    }
  });

  it("protects status mutations with the resolved server.open_workspace profile token", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: path.join(root, "workspaces") },
        server: { open_workspace_token: "$LEGACY_OPEN_WORKSPACE_TOKEN" },
        credential_profiles: {
          profiles: {
            "open-workspace": { value: "$OPEN_WORKSPACE_PROFILE_TOKEN", capabilities: ["server.open_workspace"] },
          },
          roles: {
            worker: {
              "server.open_workspace": "open-workspace",
            },
          },
        },
      },
      path.join(root, "WORKFLOW.md"),
      {
        LINEAR_API_KEY: "linear-secret",
        LEGACY_OPEN_WORKSPACE_TOKEN: "legacy-open-secret",
        OPEN_WORKSPACE_PROFILE_TOKEN: "profile-open-secret",
      },
    );
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: resolveStatusMutationToken(config),
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const legacyPauseResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/pause`, {
        method: "POST",
        headers: { "x-symphony-token": "legacy-open-secret" },
      });
      const profilePauseResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/pause`, {
        method: "POST",
        headers: { "x-symphony-token": "profile-open-secret" },
      });

      expect(legacyPauseResponse.status).toBe(401);
      expect(profilePauseResponse.status).toBe(202);
    } finally {
      await server.stop();
    }
  });

  it("keeps durable issue ids null when only workspace identity is known", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.upsertWorkspace({
      workspaceKey: "workspace-only",
      issueId: null,
      issueIdentifier: "TEST-WORKSPACE-ONLY",
      path: path.join(config.workspace.root, "workspace-only"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-WORKSPACE-ONLY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/workspace-only`);
      const issueBody = (await issueResponse.json()) as { issueDetails: IssueDetailsEnvelope };

      expect(issueResponse.status).toBe(200);
      expect(issueBody.issueDetails).toMatchObject({
        source: "durable",
        completeness: "partial",
        issue: {
          id: null,
          identifier: "TEST-WORKSPACE-ONLY",
          branchName: "symphony/TEST-WORKSPACE-ONLY",
          state: null,
        },
        tracker: { generatedAt: null, stale: null, classification: null },
      });
    } finally {
      await server.stop();
    }
  });

  it("classifies live tracker states and marks recent records as not stale", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const cases: Array<{ identifier: string; state: string; classification: string }> = [
      { identifier: "TEST-HANDOFF", state: "In Review", classification: "handoff" },
      { identifier: "TEST-TERMINAL", state: "Done", classification: "terminal" },
      { identifier: "TEST-BLOCKED-STATE", state: "Blocked", classification: "blocked" },
    ];
    const running = cases.map(({ identifier, state }) => liveRunningFixture(config, identifier, state));
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(running),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      for (const item of cases) {
        const response = await fetch(`${baseUrl}/api/v1/issues/${item.identifier}`);
        const body = (await response.json()) as { issueDetails: IssueDetailsEnvelope };
        expect(response.status).toBe(200);
        expect(body.issueDetails).toMatchObject({
          tracker: {
            classification: item.classification,
            generatedAt: "2026-01-01T00:10:00.000Z",
            updatedAt: "2026-01-01T00:08:30.000Z",
            ageMs: 90_000,
            stale: false,
          },
          pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
          workspace: { workspaceKey: null, path: null, sourceKind: null },
        });
      }
    } finally {
      await server.stop();
    }
  });

  it("proves the public issue metadata redaction matrix across status and web routes", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const liveWorkspacePath = path.join(config.workspace.root, "TEST-LIVE");
    const durableWorkspacePath = path.join(config.workspace.root, "TEST-DURABLE");

    await runStore.upsertWorkspace({
      workspaceKey: "TEST-LIVE",
      issueId: "issue-live",
      issueIdentifier: "TEST-LIVE",
      path: liveWorkspacePath,
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-LIVE",
      repoPath: "/repo",
      baseRef: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.upsertWorkspace({
      workspaceKey: "TEST-DURABLE",
      issueId: "issue-durable",
      issueIdentifier: "TEST-DURABLE",
      path: durableWorkspacePath,
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-DURABLE",
      repoPath: "/repo",
      baseRef: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-live",
      sessionId: "session-live",
      agentId: "agent-live",
      role: "worker",
      issueId: "issue-live",
      issueIdentifier: "TEST-LIVE",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-LIVE",
      workspacePath: liveWorkspacePath,
      gitBranchName: "symphony/TEST-LIVE",
      repoPath: "/repo",
      baseRef: "main",
    });
    await lifecycleStore.ensureIssue(
      { id: "issue-live", identifier: "TEST-LIVE" },
      {
        phase: "implementation",
        blockedReason: null,
        summaryPointers: {
          workspaceKey: "TEST-LIVE",
          workspacePath: liveWorkspacePath,
          branchName: "symphony/TEST-LIVE",
          gitBranchName: "symphony/TEST-LIVE",
          repoPath: "/repo",
          baseRef: "main",
          lastRunId: "run-live",
        },
      },
    );
    await lifecycleStore.ensureIssue(
      { id: "issue-durable", identifier: "TEST-DURABLE" },
      {
        phase: "blocked",
        blockedReason: "needs operator",
        summaryPointers: {
          workspaceKey: "TEST-DURABLE",
          workspacePath: durableWorkspacePath,
          branchName: "symphony/TEST-DURABLE",
          gitBranchName: "symphony/TEST-DURABLE",
          repoPath: "/repo",
          baseRef: "main",
        },
      },
    );

    const liveRunning = liveRunningFixture(config, "TEST-LIVE", "In Progress");
    liveRunning.issueId = "issue-live";
    liveRunning.runId = "run-live";
    liveRunning.sessionId = "session-live";
    liveRunning.workspacePath = liveWorkspacePath;
    liveRunning.liveness.activeRunId = "run-live";
    liveRunning.metadata.branchName = "symphony/TEST-LIVE";
    liveRunning.metadata.gitBranchName = "symphony/TEST-LIVE";
    liveRunning.metadata.repoPath = "/repo";
    liveRunning.metadata.baseRef = "main";
    liveRunning.issueDetails = issueDetailsFixture({
      id: "issue-live",
      identifier: "TEST-LIVE",
      title: "Visible tracker title",
      description: "Visible tracker description.\n\nSecond public paragraph.",
      priority: 3,
      state: "In Progress",
      branchName: "symphony/TEST-LIVE",
      url: "https://linear.app/acme/issue/TEST-LIVE/visible-tracker-title",
      assigneeId: "user-live",
      delegateId: "delegate-live",
      labels: ["visible-label"],
      blockedBy: [{ id: "issue-blocker", identifier: "TEST-BLOCKER", state: "In Progress" }],
      updatedAt: "2026-01-01T00:09:00.000Z",
    });

    const tracker = new FakeTracker([
      issue({
        id: "issue-live",
        identifier: "TEST-LIVE",
        title: "Visible tracker title",
        description: "Visible tracker description.\n\nSecond public paragraph.",
        priority: 3,
        state: "In Progress",
        branchName: "symphony/TEST-LIVE",
        url: "https://linear.app/acme/issue/TEST-LIVE/visible-tracker-title",
        assigneeId: "user-live",
        delegateId: "delegate-live",
        labels: ["visible-label"],
        blockedBy: [{ id: "issue-blocker", identifier: "TEST-BLOCKER", state: "In Progress" }],
        updatedAt: "2026-01-01T00:09:00.000Z",
      }),
    ]);

    const server = new StatusServer({
      orchestrator: fakeOrchestrator([liveRunning], { paused: ["TEST-DURABLE"] }),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      tracker,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const liveIssueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-LIVE`);
      const durableIssueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-DURABLE`);
      const durableRunsResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-DURABLE/runs`);
      const referenceDataResponse = await fetch(`${baseUrl}/api/v1/web/reference-data`);
      const webIssuesResponse = await fetch(`${baseUrl}/api/v1/web/issues`);
      const webLiveResponse = await fetch(`${baseUrl}/api/v1/web/issues/TEST-LIVE`);
      const webDurableResponse = await fetch(`${baseUrl}/api/v1/web/issues/TEST-DURABLE`);

      const liveIssueBody = (await liveIssueResponse.json()) as { issueDetails: IssueDetailsEnvelope };
      const durableIssueBody = (await durableIssueResponse.json()) as { issueDetails: IssueDetailsEnvelope };
      const durableRunsBody = (await durableRunsResponse.json()) as { issueDetails: IssueDetailsEnvelope };
      const webIssuesBody = (await webIssuesResponse.json()) as {
        issues: Array<Record<string, unknown>>;
        lanes: { progress: Array<{ id: string }>; review: Array<{ id: string }> };
      };
      const webLiveBody = (await webLiveResponse.json()) as { issue: Record<string, unknown> & { desc?: string[] } };
      const webDurableBody = (await webDurableResponse.json()) as { issue: Record<string, unknown> & { desc?: string[] } };
      const referenceDataBody = (await referenceDataResponse.json()) as {
        labels: Record<string, { name: string }>;
        users: Record<string, { name: string }>;
      };

      expect(liveIssueResponse.status).toBe(200);
      expect(durableIssueResponse.status).toBe(200);
      expect(durableRunsResponse.status).toBe(200);
      expect(webIssuesResponse.status).toBe(200);
      expect(webLiveResponse.status).toBe(200);
      expect(webDurableResponse.status).toBe(200);
      expect(referenceDataResponse.status).toBe(200);

      expect(liveIssueBody.issueDetails).toMatchObject({
        source: "live",
        completeness: "full",
        issue: {
          id: "issue-live",
          identifier: "TEST-LIVE",
          title: "Visible tracker title",
          description: "Visible tracker description.\n\nSecond public paragraph.",
          priority: 3,
          state: "In Progress",
          branchName: "symphony/TEST-LIVE",
          url: "https://linear.app/acme/issue/TEST-LIVE/visible-tracker-title",
          assigneeId: "user-live",
          delegateId: "delegate-live",
          labels: ["visible-label"],
          blockedBy: [{ id: "issue-blocker", identifier: "TEST-BLOCKER", state: "In Progress" }],
        },
        blockers: { available: true, totalCount: 1, openCount: 1, blocked: false },
      });

      expect(durableIssueBody.issueDetails).toMatchObject({
        source: "durable",
        completeness: "partial",
        issue: {
          id: "issue-durable",
          identifier: "TEST-DURABLE",
          title: null,
          description: null,
          priority: null,
          state: null,
          branchName: "symphony/TEST-DURABLE",
          url: null,
          assigneeId: null,
          delegateId: null,
          labels: [],
          blockedBy: [],
        },
        tracker: { generatedAt: null, stale: null, classification: null },
        blockers: { available: false, totalCount: 0, openCount: 0, blocked: true, humanBlockedReason: "needs operator" },
      });
      expect(durableRunsBody.issueDetails).toMatchObject(durableIssueBody.issueDetails);

      const webLiveIssue = webIssuesBody.issues.find((item) => item.id === "TEST-LIVE") as
        | (Record<string, unknown> & { desc?: string[] })
        | undefined;
      const webDurableIssue = webIssuesBody.issues.find((item) => item.id === "TEST-DURABLE") as
        | (Record<string, unknown> & { desc?: string[] })
        | undefined;
      expect(webIssuesBody.lanes.progress.map((item) => item.id)).toContain("TEST-LIVE");
      expect(webIssuesBody.lanes.progress.map((item) => item.id)).toContain("TEST-DURABLE");
      expect(webIssuesBody.lanes.review).toEqual([]);
      expect(webLiveIssue).toMatchObject({
        id: "TEST-LIVE",
        title: "Visible tracker title",
        labels: ["visible-label"],
        assignee: "user-live",
      });
      expect(webLiveIssue?.desc).toEqual([
        "Visible tracker description.",
        "Second public paragraph.",
        "Blocked by TEST-BLOCKER",
      ]);
      expect(webDurableIssue).toMatchObject({
        id: "TEST-DURABLE",
        title: "TEST-DURABLE",
        labels: [],
        assignee: "unassigned",
      });
      expect(webDurableIssue?.desc).toEqual(["Blocked: needs operator", "needs operator"]);

      expect(webLiveBody.issue).toMatchObject({
        id: "TEST-LIVE",
        title: "Visible tracker title",
        labels: ["visible-label"],
        assignee: "user-live",
      });
      expect(webLiveBody.issue.desc).toEqual([
        "Visible tracker description.",
        "Second public paragraph.",
        "Blocked by TEST-BLOCKER",
      ]);
      expect(webDurableBody.issue).toMatchObject({
        id: "TEST-DURABLE",
        title: "TEST-DURABLE",
        labels: [],
        assignee: "unassigned",
      });
      expect(webDurableBody.issue.desc).toEqual(["Blocked: needs operator", "needs operator"]);

      expect(Object.keys(referenceDataBody.labels)).toEqual(["visible-label"]);
      expect(Object.keys(referenceDataBody.users)).toEqual(["delegate-live", "unassigned", "user-live"]);
    } finally {
      await server.stop();
    }
  });

  it("serves a Linear-backed issue board enriched with Symphony state", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    config.mergePolicy.sourceStates = ["Ready to Merge"];

    const runStore = new CountingRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new CountingIssueLifecycleStore(config.workspace.stateDir);

    await runStore.upsertWorkspace({
      workspaceKey: "TEST-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      path: path.join(config.workspace.root, "TEST-1"),
      sourceKind: "git_worktree",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await runStore.startRun({
      runId: "run-test-1",
      sessionId: "session-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: path.join(config.workspace.root, "TEST-1"),
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await runStore.recordPullRequestEvent({
      runId: "run-test-1",
      action: "updated",
      at: "2026-01-01T00:01:00.000Z",
      prUrl: "https://github.com/acme/repo/pull/67",
      prNumber: 67,
      lastPushedAt: "2026-01-01T00:00:30.000Z",
    });
    await runStore.recordCiStatusEvent({
      runId: "run-test-1",
      at: "2026-01-01T00:01:30.000Z",
      ciStatus: "success",
    });
    await lifecycleStore.ensureIssue(
      { id: "issue-1", identifier: "TEST-1" },
      {
        phase: "review",
        reviewRound: 1,
        blockedReason: null,
        summaryPointers: {
          workspaceKey: "TEST-1",
          workspacePath: path.join(config.workspace.root, "TEST-1"),
          branchName: "symphony/TEST-1",
          gitBranchName: "symphony/TEST-1",
          repoPath: "/repo",
          baseRef: "main",
          lastRunId: "run-test-1",
          prUrl: "https://github.com/acme/repo/pull/67",
          prNumber: 67,
          ciStatus: "success",
          lastPushedAt: "2026-01-01T00:00:30.000Z",
        },
      },
    );
    await lifecycleStore.ensureIssue(
      { id: "issue-blocked", identifier: "TEST-BLOCKED" },
      { phase: "blocked", blockedReason: "needs operator", summaryPointers: {} },
    );
    await lifecycleStore.ensureIssue(
      { id: "issue-terminal", identifier: "TEST-ARCHIVED" },
      { phase: "terminal", blockedReason: null, summaryPointers: {} },
    );

    const liveRunning = liveRunningFixture(config, "TEST-1", "In Progress");
    liveRunning.issueId = "issue-1";
    liveRunning.sessionId = "session-1";
    liveRunning.workspacePath = path.join(config.workspace.root, "TEST-1");
    liveRunning.issueDetails = issueDetailsFixture({
      id: "issue-1",
      identifier: "TEST-1",
      title: "Stale live title",
      state: "In Progress",
      url: "https://linear.app/acme/issue/TEST-1/stale-live",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const tracker = new FakeTracker([
      issue({
        id: "issue-todo",
        identifier: "TEST-TODO",
        title: "Todo with dependency",
        description: "Todo detail description",
        state: "Todo",
        delegateId: "delegate-1",
        blockedBy: [{ id: "issue-0", identifier: "TEST-0", state: "In Progress" }],
      }),
      issue({
        id: "issue-progress",
        identifier: "TEST-PROGRESS",
        title: "Progress with dependency",
        state: "In Progress",
        blockedBy: [{ id: "issue-0", identifier: "TEST-0", state: "In Progress" }],
      }),
      issue({
        id: "issue-1",
        identifier: "TEST-1",
        title: "Linear review title",
        description: "Review route description.\n\nSecond route paragraph.",
        priority: 2,
        state: "In Review",
        url: "https://linear.app/acme/issue/TEST-1/linear-review-title",
        assigneeId: "review-assignee",
        labels: ["dogfood-ready"],
        delegateId: "delegate-review",
        blockedBy: [{ id: "issue-0", identifier: "TEST-0", state: "In Progress" }],
        updatedAt: "2026-01-01T00:09:00.000Z",
      }),
      issue({
        id: "issue-merge",
        identifier: "TEST-MERGE",
        title: "Ready to merge",
        state: "Ready to Merge",
      }),
      issue({
        id: "issue-review-3",
        identifier: "TEST-REVIEW-3",
        title: "Third review issue",
        state: "In Review",
        labels: ["third-review"],
      }),
      issue({
        id: "issue-review-4",
        identifier: "TEST-REVIEW-4",
        title: "Fourth review issue",
        state: "In Review",
        labels: ["fourth-review"],
      }),
      issue({
        id: "issue-done",
        identifier: "TEST-DONE",
        title: "Done issue",
        state: "Done",
      }),
      issue({
        id: "issue-canceled",
        identifier: "TEST-CANCELED",
        title: "Canceled issue",
        state: "Canceled",
      }),
    ]);

    lifecycleStore.resetReadCounts();
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([liveRunning], { paused: ["TEST-BLOCKED"] }),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      tracker,
      trackerStateLists: testTrackerStateLists(),
      issueBoardColumns: {
        backlog: ["Backlog"],
        todo: ["Todo"],
        progress: ["In Progress", "Blocked"],
        review: ["In Review", "Ready to Merge"],
        done: ["Done"],
        canceled: ["Canceled"],
      },
      dashboard: {
        repoLabel: "acme/symphony",
        branch: "main",
        workflowLabel: "WORKFLOW.md",
        pollIntervalMs: 60_000,
        concurrencyCap: 2,
      },
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issue-board`);
      const body = (await response.json()) as {
        tracker: { fetchedStates: string[]; issueCount: number; cached: boolean };
        counts: { total: number; trackerBacked: number; symphonyOnly: number; live: number; paused: number; blocked: number };
        lanes: Array<{ id: string; issues: Array<{ issueIdentifier: string | null; origin: string; issueDetails: IssueDetailsEnvelope; live: unknown; paused: boolean }> }>;
        issues: Array<{ issueIdentifier: string | null }>;
      };

      expect(response.status).toBe(200);
      expect(runStore.listWorkspacesCount).toBe(1);
      expect(runStore.listRunsCount).toBe(1);
      expect(runStore.findWorkspaceCount).toBe(0);
      expect(runStore.listRunsForIssueCount).toBe(0);
      expect(runStore.latestRunForIssueCount).toBe(0);
      expect(lifecycleStore.listCount).toBe(1);
      expect(lifecycleStore.getCount).toBe(0);
      expect(tracker.requestedStates).toEqual(["Backlog", "Todo", "In Progress", "Blocked", "In Review", "Ready to Merge", "Done", "Canceled"]);
      expect(tracker.fetchCount).toBe(1);
      expect(body.tracker).toMatchObject({ issueCount: 8, cached: false });
      expect(body.counts).toMatchObject({ total: 9, trackerBacked: 8, symphonyOnly: 1, live: 1, paused: 1, blocked: 3 });
      expect(body.lanes.map((lane) => lane.id)).toEqual(["backlog", "todo", "progress", "review", "done", "canceled"]);
      expect(body.issues.map((item) => item.issueIdentifier)).not.toContain("TEST-ARCHIVED");

      const reviewCard = body.lanes.find((lane) => lane.id === "review")?.issues.find((item) => item.issueIdentifier === "TEST-1");
      expect(reviewCard).toMatchObject({
        origin: "tracker",
        issueDetails: {
          source: "tracker",
          completeness: "full",
          issue: {
            title: "Linear review title",
            state: "In Review",
            url: "https://linear.app/acme/issue/TEST-1/linear-review-title",
            labels: ["dogfood-ready"],
          },
          tracker: { classification: "handoff", stale: false },
          workspace: { workspaceKey: "TEST-1", gitBranchName: "symphony/TEST-1" },
          latestRun: { runId: "run-test-1", status: "running" },
        },
        live: { state: "In Progress", runId: "run-test-1" },
      });
      expect(reviewCard?.issueDetails.blockers).toMatchObject({ available: true, totalCount: 1, openCount: 1, blocked: true });

      const todoCard = body.lanes.find((lane) => lane.id === "todo")?.issues.find((item) => item.issueIdentifier === "TEST-TODO");
      const progressCard = body.lanes.find((lane) => lane.id === "progress")?.issues.find((item) => item.issueIdentifier === "TEST-PROGRESS");
      expect(todoCard?.issueDetails.blockers).toMatchObject({ openCount: 1, blocked: true });
      expect(progressCard?.issueDetails.blockers).toMatchObject({ openCount: 1, blocked: false });

      const mergeCard = body.lanes.find((lane) => lane.id === "review")?.issues.find((item) => item.issueIdentifier === "TEST-MERGE");
      expect(mergeCard?.issueDetails.issue.state).toBe("Ready to Merge");
      expect(body.lanes.find((lane) => lane.id === "done")?.issues.map((item) => item.issueIdentifier)).toContain("TEST-DONE");
      expect(body.lanes.find((lane) => lane.id === "canceled")?.issues.map((item) => item.issueIdentifier)).toContain("TEST-CANCELED");

      const blockedCard = body.lanes.find((lane) => lane.id === "progress")?.issues.find((item) => item.issueIdentifier === "TEST-BLOCKED");
      expect(blockedCard).toMatchObject({
        origin: "symphony",
        paused: true,
        issueDetails: {
          source: "durable",
          blockers: { humanBlockedReason: "needs operator", blocked: true },
        },
      });

      const webIssuesResponse = await fetch("http://" + address.host + ":" + address.port + "/api/v1/web/issues");
      const webIssuesBody = (await webIssuesResponse.json()) as {
        issues: Array<{
          id: string;
          status: string;
          priority: number | string;
          labels: string[];
          assignee: string;
          agent: string | null;
          pr: string | null;
          ci: string | null;
          workspace: string | null;
          session: string | null;
          desc?: string[];
          activity: Array<{ t: string; verb: string; val: string; who: string }>;
        }>;
        backlog: Array<{ id: string; status: string }>;
        lanes: { todo: Array<{ id: string }>; progress: Array<{ id: string }>; review: Array<{ id: string }> };
        cycleLabel: string;
        cycleDateRange: string;
        selectedIssueId: string;
      };
      expect(webIssuesResponse.status).toBe(200);
      expect(Object.keys(webIssuesBody).sort()).toEqual([
        "backlog",
        "cycleDateRange",
        "cycleLabel",
        "issues",
        "lanes",
        "selectedIssueId",
      ]);
      expect(webIssuesBody.cycleLabel).toBe("");
      expect(webIssuesBody.cycleDateRange).toBe("");
      expect(webIssuesBody.issues.map((item) => item.id)).toEqual([
        "TEST-TODO",
        "TEST-PROGRESS",
        "TEST-1",
        "TEST-MERGE",
        "TEST-REVIEW-3",
        "TEST-REVIEW-4",
        "TEST-DONE",
        "TEST-CANCELED",
        "TEST-BLOCKED",
      ]);
      expect(webIssuesBody.backlog.map((item) => item.id)).toEqual(["TEST-TODO"]);
      expect(webIssuesBody.lanes.todo.map((item) => item.id)).toEqual(["TEST-TODO"]);
      expect(webIssuesBody.lanes.progress.map((item) => item.id)).toEqual(["TEST-PROGRESS", "TEST-BLOCKED"]);
      expect(webIssuesBody.lanes.review.map((item) => item.id)).toEqual(["TEST-1", "TEST-MERGE", "TEST-REVIEW-3", "TEST-REVIEW-4"]);
      expect(webIssuesBody.issues.find((item) => item.id === "TEST-CANCELED")?.status).toBe("cancelled");
      expect(webIssuesBody.selectedIssueId).toBe("TEST-PROGRESS");

      const webTodo = webIssuesBody.issues.find((item) => item.id === "TEST-TODO");
      expect(webTodo).toMatchObject({
        id: "TEST-TODO",
        status: "todo",
        priority: 1,
        labels: [],
        assignee: "unassigned",
        agent: "delegate-1",
        pr: null,
        ci: null,
        workspace: null,
        session: null,
        desc: ["Todo detail description", "Blocked by TEST-0"],
        activity: [{ t: "2026-01-01T00:00:00Z", verb: "created", val: "Todo", who: "tracker" }],
      });
      const webReview = webIssuesBody.issues.find((item) => item.id === "TEST-1");
      expect(webReview).toMatchObject({
        id: "TEST-1",
        status: "review",
        priority: 2,
        labels: ["dogfood-ready"],
        assignee: "review-assignee",
        agent: "agent-1",
        pr: "#67",
        ci: "success",
        workspace: path.join(config.workspace.root, "TEST-1"),
        session: "session-1",
      });
      expect(webReview?.desc).toEqual(expect.arrayContaining(["Review route description.", "Second route paragraph.", "Blocked by TEST-0"]));
      expect(webReview?.activity.map((item) => item.verb)).toEqual(expect.arrayContaining(["created", "updated", "pr pushed"]));

      const dashboardResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/dashboard`);
      const dashboardBody = (await dashboardResponse.json()) as {
        projectName: string;
        repoLabel: string;
        branch: string;
        workflowLabel: string;
        pollLabel: string;
        agentUsageLabel: string;
        concurrencyCap: number;
        providerGates: unknown[];
        runningAgents: Array<{ issue: string; title: string; state: string; duration: string }>;
        activity: Array<{ verb: string; id: string }>;
        chat: unknown[];
        totals: Record<string, number>;
        source: { status: string; label: string; detail: string; issueCount: number; cached: boolean };
      };
      expect(dashboardResponse.status).toBe(200);
      expect(Object.keys(dashboardBody).sort()).toEqual([
        "activity",
        "agentUsageLabel",
        "branch",
        "chat",
        "concurrencyCap",
        "pollLabel",
        "projectName",
        "providerGates",
        "repoLabel",
        "runningAgents",
        "source",
        "totals",
        "workflowLabel",
      ]);
      expect(dashboardBody).toMatchObject({
        projectName: "Symphony",
        repoLabel: "acme/symphony",
        branch: "main",
        workflowLabel: "WORKFLOW.md",
        pollLabel: "poll 60s",
        agentUsageLabel: "1/2 agents",
        concurrencyCap: 2,
        providerGates: [],
        chat: [],
        totals: { backlog: 0, todo: 1, progress: 2, review: 4, done: 2, cancelled: 1, open: 7, all: 10, completeness: 20 },
      });
      expect(dashboardBody.runningAgents[0]).toMatchObject({
        issue: "TEST-1",
        title: "Stale live title",
        state: "active",
        duration: "10m",
      });
      expect(dashboardBody.source).toMatchObject({
        status: "stale",
        label: "tracker stale · 8 cached issues",
        issueCount: 8,
        cached: true,
      });
      expect(dashboardBody.source.detail).toContain("Using a cached tracker source while refresh catches up");
      expect(dashboardBody.activity[0]).toMatchObject({ verb: "run_started", id: "TEST-1" });
      expect(JSON.stringify(dashboardBody)).not.toContain("openai/symphony");
      expect(JSON.stringify(dashboardBody)).not.toContain("poll 22s");
      expect(JSON.stringify(dashboardBody)).not.toContain("Mock");

      const sidebarResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/sidebar`);
      const sidebarBody = (await sidebarResponse.json()) as {
        providerGates: unknown[];
        runningAgents: Array<{ issue: string; title: string; state: string; duration: string }>;
        reviewIssues: Array<{
          id: string;
          title: string;
          status: string;
          priority: number | string;
          labels: string[];
          assignee: string;
          agent: string | null;
          pr: string | null;
          ci: string | null;
          workspace: string | null;
          session: string | null;
          activity: Array<{ verb: string; val: string; who: string }>;
          desc?: string[];
        }>;
        activity: Array<{ verb: string; id: string }>;
        sessions: Array<{ id: string; issue: string; state: string; lastEvent: string }>;
        chat: unknown[];
        totals: Record<string, number>;
      };
      expect(sidebarResponse.status).toBe(200);
      expect(Object.keys(sidebarBody).sort()).toEqual([
        "activity",
        "chat",
        "providerGates",
        "reviewIssues",
        "runningAgents",
        "sessions",
        "totals",
      ]);
      expect(sidebarBody.providerGates).toEqual(dashboardBody.providerGates);
      expect(sidebarBody.runningAgents).toEqual(dashboardBody.runningAgents);
      expect(sidebarBody.reviewIssues.map((item) => item.id)).toEqual(["TEST-1", "TEST-MERGE", "TEST-REVIEW-3"]);
      expect(sidebarBody.reviewIssues).toHaveLength(3);
      expect(sidebarBody.reviewIssues.find((item) => item.id === "TEST-REVIEW-4")).toBeUndefined();
      expect(sidebarBody.reviewIssues[0]).toMatchObject({
        id: "TEST-1",
        title: "Linear review title",
        status: "review",
        priority: 2,
        labels: ["dogfood-ready"],
        assignee: "review-assignee",
        agent: "agent-1",
        pr: "#67",
        ci: "success",
        workspace: path.join(config.workspace.root, "TEST-1"),
        session: "session-1",
      });
      expect(sidebarBody.reviewIssues[0]?.desc).toEqual(
        expect.arrayContaining(["Review route description.", "Second route paragraph.", "Blocked by TEST-0"]),
      );
      expect(sidebarBody.reviewIssues[0]?.activity.map((item) => item.verb)).toEqual(expect.arrayContaining(["created", "updated", "pr pushed"]));
      expect(sidebarBody.activity).toEqual(dashboardBody.activity);
      expect(sidebarBody.sessions[0]).toMatchObject({ id: "run-test-1", issue: "TEST-1", state: "running", lastEvent: "TEST-1 run started" });
      expect(sidebarBody.chat).toEqual([]);
      expect(sidebarBody.totals).toEqual(dashboardBody.totals);
      expect(JSON.stringify(sidebarBody)).not.toContain("openai/symphony");
      expect(JSON.stringify(sidebarBody)).not.toContain("poll 22s");
      expect(JSON.stringify(sidebarBody)).not.toContain("Mock");

      const boardResponse = await fetch(`http://${address.host}:${address.port}/api/v1/board`);
      const boardBody = (await boardResponse.json()) as {
        columns: Array<{
          id: string;
          count: number;
          issues: Array<{ issueId: string | null; issueIdentifier: string | null; capabilities: { detail: string | null } }>;
        }>;
        issues: Array<{ issueIdentifier: string | null; capabilities: { detail: string | null } }>;
        counts: { total: number };
      };
      expect(boardResponse.status).toBe(200);
      expect(boardBody.columns.map((column) => column.id)).toEqual(["backlog", "todo", "progress", "review", "done", "canceled"]);
      expect(boardBody.columns.find((column) => column.id === "todo")?.count).toBe(1);
      expect(boardBody.counts.total).toBe(9);
      expect(boardBody.issues.find((item) => item.issueIdentifier === "TEST-TODO")?.capabilities.detail).toBe(
        "/api/v1/board/issues/issue-todo",
      );

      const referenceResponse = await fetch("http://" + address.host + ":" + address.port + "/api/v1/web/reference-data");
      const referenceBody = (await referenceResponse.json()) as {
        labels: Record<string, { name: string; color: string | null }>;
        users: Record<string, { name: string; color: string | null }>;
      };
      expect(referenceResponse.status).toBe(200);
      expect(referenceBody.users.unassigned).toMatchObject({ name: "Unassigned" });
      expect(referenceBody.users["delegate-review"]).toMatchObject({ name: "delegate-review" });
      expect(referenceBody.labels["dogfood-ready"]).toMatchObject({ name: "dogfood-ready" });

      const boardDetailByIdResponse = await fetch(`http://${address.host}:${address.port}/api/v1/board/issues/issue-todo`);
      const boardDetailByIdentifierResponse = await fetch(`http://${address.host}:${address.port}/api/v1/board/issues/TEST-TODO`);
      const boardDetail = (await boardDetailByIdResponse.json()) as {
        boardCard: { issueIdentifier: string | null; capabilities: { detail: string | null } };
        issueDetails: IssueDetailsEnvelope;
        runs: unknown[];
        pullRequest: IssueDetailsEnvelope["pullRequest"];
        blockers: IssueDetailsEnvelope["blockers"];
        capabilities: { openWorkspace: boolean; transcript: boolean };
      };
      expect(boardDetailByIdResponse.status).toBe(200);
      expect(boardDetailByIdentifierResponse.status).toBe(200);
      expect(boardDetail).toMatchObject({
        boardCard: {
          issueIdentifier: "TEST-TODO",
          capabilities: { detail: "/api/v1/board/issues/issue-todo" },
        },
        issueDetails: {
          source: "tracker",
          issue: { description: "Todo detail description", identifier: "TEST-TODO", delegateId: "delegate-1" },
        },
        runs: [],
        pullRequest: { url: null, ciStatus: null },
        blockers: { openCount: 1, blocked: true },
        capabilities: { openWorkspace: false, transcript: false },
      });

      const reviewBoardDetailResponse = await fetch(`http://${address.host}:${address.port}/api/v1/board/issues/TEST-1`);
      const reviewBoardDetail = (await reviewBoardDetailResponse.json()) as {
        boardCard: { issueIdentifier: string | null; live: { state: string; runId: string | null } | null };
        issueDetails: IssueDetailsEnvelope;
        live: { state: string; runId: string | null } | null;
        workspace: { workspaceKey: string; path: string | null; gitBranchName: string | null } | null;
        latestRun: { runId: string; sessionId: string | null; status: string; ciStatus?: string | null } | null;
        runs: Array<{ runId: string; sessionId: string | null; status: string }>;
        lifecycle: { phase: string; reviewRound: number } | null;
        pullRequest: IssueDetailsEnvelope["pullRequest"];
        capabilities: { openWorkspace: boolean; transcript: boolean };
      };
      expect(reviewBoardDetailResponse.status).toBe(200);
      expect(reviewBoardDetail).toMatchObject({
        boardCard: { issueIdentifier: "TEST-1", live: { state: "In Progress", runId: "run-test-1" } },
        issueDetails: {
          source: "tracker",
          issue: {
            identifier: "TEST-1",
            title: "Linear review title",
            description: "Review route description.\n\nSecond route paragraph.",
            state: "In Review",
            labels: ["dogfood-ready"],
          },
          tracker: { classification: "handoff", stale: false },
          workspace: { workspaceKey: "TEST-1", path: path.join(config.workspace.root, "TEST-1"), gitBranchName: "symphony/TEST-1" },
          latestRun: { runId: "run-test-1", status: "running" },
          pullRequest: { url: "https://github.com/acme/repo/pull/67", number: 67, ciStatus: "success" },
        },
        live: { state: "In Progress", runId: "run-test-1" },
        workspace: { workspaceKey: "TEST-1", path: path.join(config.workspace.root, "TEST-1"), gitBranchName: "symphony/TEST-1" },
        latestRun: { runId: "run-test-1", sessionId: "session-1", status: "running", ciStatus: "success" },
        lifecycle: { phase: "review", reviewRound: 1 },
        pullRequest: { url: "https://github.com/acme/repo/pull/67", number: 67, ciStatus: "success" },
        capabilities: { openWorkspace: false, transcript: true },
      });
      expect(reviewBoardDetail.runs).toHaveLength(1);
      expect(reviewBoardDetail.runs[0]).toMatchObject({ runId: "run-test-1", sessionId: "session-1", status: "running" });

      const webDetailResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/issues/TEST-1`);
      const webDetail = (await webDetailResponse.json()) as {
        issue: {
          id: string;
          title: string;
          status: string;
          priority: number | string;
          labels: string[];
          assignee: string;
          agent: string | null;
          pr: string | null;
          ci: string | null;
          workspace: string | null;
          session: string | null;
          desc?: string[];
          activity: Array<{ verb: string; val: string | null; who: string | null }>;
        };
        activity: Array<{ verb: string; id: string }>;
        runs: Array<{ id: string; issue: string; state: string }>;
        transcript: unknown[];
      };
      expect(webDetailResponse.status).toBe(200);
      expect(webDetail.issue).toMatchObject({
        id: "TEST-1",
        title: "Linear review title",
        status: "review",
        priority: 2,
        labels: ["dogfood-ready"],
        assignee: "review-assignee",
        agent: "agent-1",
        pr: "#67",
        ci: "success",
        workspace: path.join(config.workspace.root, "TEST-1"),
        session: "session-1",
      });
      expect(webDetail.issue.desc).toEqual(expect.arrayContaining(["Review route description.", "Second route paragraph.", "Blocked by TEST-0"]));
      expect(webDetail.issue.activity.map((item) => item.verb)).toEqual(expect.arrayContaining(["created", "updated", "pr pushed"]));
      expect(webDetail.activity[0]).toMatchObject({ verb: "run_started", id: "TEST-1" });
      expect(webDetail.runs).toEqual([expect.objectContaining({ id: "session-1", issue: "TEST-1", state: "running" })]);
      expect(webDetail.transcript).toEqual(expect.any(Array));
      expect(runStore.findWorkspaceCount).toBe(0);
      expect(runStore.listRunsForIssueCount).toBe(0);
      expect(runStore.latestRunForIssueCount).toBe(0);
      expect(lifecycleStore.getCount).toBe(0);

      const cachedResponse = await fetch(`http://${address.host}:${address.port}/api/v1/issue-board`);
      const cachedBody = (await cachedResponse.json()) as { tracker: { cached: boolean } };
      expect(cachedResponse.status).toBe(200);
      expect(cachedBody.tracker.cached).toBe(true);
      expect(tracker.fetchCount).toBe(1);

      const refreshResponse = await fetch(`http://${address.host}:${address.port}/api/v1/issue-board?refresh=1`);
      const refreshBody = (await refreshResponse.json()) as { tracker: { cached: boolean } };
      expect(refreshResponse.status).toBe(200);
      expect(refreshBody.tracker.cached).toBe(false);
      expect(tracker.fetchCount).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("fails the issue board clearly when no tracker is configured", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/issue-board`);
      const acceptedResponse = await fetch(`http://${address.host}:${address.port}/api/v1/board`);
      const webIssuesResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/issues`);
      const referenceResponse = await fetch("http://" + address.host + ":" + address.port + "/api/v1/web/reference-data");
      const dashboardResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/dashboard`);
      const sidebarResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/sidebar`);
      const body = (await response.json()) as { error: { code: string; message: string } };
      const acceptedBody = (await acceptedResponse.json()) as { error: { code: string; message: string } };
      const webIssuesBody = (await webIssuesResponse.json()) as {
        issues: unknown[];
        backlog: unknown[];
        lanes: { todo: unknown[]; progress: unknown[]; review: unknown[] };
        cycleLabel: string;
        cycleDateRange: string;
        selectedIssueId: string;
      };
      const referenceBody = (await referenceResponse.json()) as {
        labels: Record<string, { name: string; color: string | null }>;
        users: Record<string, { name: string; color: string | null }>;
      };
      const dashboardBody = (await dashboardResponse.json()) as {
        projectName: string;
        activity: unknown[];
        providerGates: unknown[];
        runningAgents: unknown[];
        totals: { all: number; open: number; completeness: number };
        source: { status: string; label: string; detail: string; issueCount: number; cached: boolean; error: string | null };
      };
      const sidebarBody = (await sidebarResponse.json()) as {
        providerGates: unknown[];
        runningAgents: unknown[];
        reviewIssues: unknown[];
        activity: unknown[];
        sessions: unknown[];
        chat: unknown[];
        totals: { backlog: number; todo: number; progress: number; review: number; done: number; cancelled: number; open: number; all: number; completeness: number };
      };

      expect(response.status).toBe(503);
      expect(body.error).toMatchObject({
        code: "tracker_unavailable",
        message: "Issue board requires a configured tracker client",
      });
      expect(acceptedResponse.status).toBe(503);
      expect(acceptedBody.error).toMatchObject(body.error);
      expect(webIssuesResponse.status).toBe(200);
      expect(webIssuesBody).toEqual({
        issues: [],
        backlog: [],
        lanes: { todo: [], progress: [], review: [] },
        cycleLabel: "",
        cycleDateRange: "",
        selectedIssueId: "",
      });
      expect(referenceResponse.status).toBe(200);
      expect(referenceBody.labels).toEqual({});
      expect(referenceBody.users.unassigned).toMatchObject({ name: "Unassigned" });
      expect(dashboardResponse.status).toBe(200);
      expect(dashboardBody).toMatchObject({
        projectName: "Symphony",
        activity: [],
        providerGates: [],
        runningAgents: [],
        totals: { all: 0, open: 0, completeness: 0 },
        source: {
          status: "unavailable",
          label: "tracker unavailable",
          issueCount: 0,
          cached: false,
          error: "Issue board requires a configured tracker client",
        },
      });
      expect(dashboardBody.source.detail).toBe("Issue board requires a configured tracker client");
      expect(sidebarResponse.status).toBe(200);
      expect(sidebarBody).toEqual({
        providerGates: [],
        runningAgents: [],
        reviewIssues: [],
        activity: [],
        sessions: [],
        chat: [],
        totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 },
      });
    } finally {
      await server.stop();
    }
  });

  it("serves an empty accepted board and clear missing board detail errors", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      tracker: new FakeTracker([]),
      trackerStateLists: testTrackerStateLists(),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const boardResponse = await fetch(`${baseUrl}/api/v1/board`);
      const boardBody = (await boardResponse.json()) as {
        columns: Array<{ id: string; count: number; issues: unknown[] }>;
        issues: unknown[];
        counts: { total: number; trackerBacked: number };
      };
      const missingResponse = await fetch(`${baseUrl}/api/v1/board/issues/TEST-MISSING`);
      const missingBody = (await missingResponse.json()) as { error: { code: string; message: string } };

      expect(boardResponse.status).toBe(200);
      expect(boardBody.issues).toEqual([]);
      expect(boardBody.counts).toMatchObject({ total: 0, trackerBacked: 0 });
      expect(boardBody.columns.every((column) => column.count === 0 && column.issues.length === 0)).toBe(true);
      expect(missingResponse.status).toBe(404);
      expect(missingBody.error).toMatchObject({ code: "not_found", message: "Board issue not found: TEST-MISSING" });
    } finally {
      await server.stop();
    }
  });

  it("serves live liveness and cancellation state from the orchestrator snapshot", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: path.join(config.workspace.root, "TEST-1"),
    });
    await runStore.startRun({
      runId: "run-reviewer",
      sessionId: "session-reviewer",
      agentId: "agent-reviewer",
      role: "reviewer",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "review",
      workspaceKey: "TEST-1",
      workspacePath: path.join(config.workspace.root, "TEST-1"),
    });
    const liveRunning: ReturnType<Orchestrator["snapshot"]>["running"][number] = {
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      state: "In Progress",
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
      workspacePath: null,
      sessionId: "session-1",
      runId: "run-1",
      turnCount: 1,
      lastEvent: "progress",
      lastMessage: "Stopping run",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastEventAt: "2026-01-01T00:00:01.000Z",
      liveness: {
        status: "cancelling",
        activeRunId: "run-1",
        lastActivityAt: "2026-01-01T00:00:01.000Z",
        secondsSinceLastActivity: 2,
        stallTimeoutMs: 300_000,
      },
      cancellation: {
        requested: true,
        requestedAt: "2026-01-01T00:00:02.000Z",
        source: "operator",
        reason: "operator request",
        abortSignalled: true,
        harnessStopRequestedAt: "2026-01-01T00:00:02.000Z",
        harnessStopFailedAt: null,
        harnessStopFailedReason: null,
        cancelFailed: {
          tracked: true,
          active: false,
          phase: "requested",
          at: null,
          reason: null,
          source: null,
        },
        suppressRetryOnExit: true,
      },
      activity: {
        lastHarnessActivityAt: "2026-01-01T00:00:01.000Z",
        lastStreamActivityAt: "2026-01-01T00:00:01.000Z",
        lastDeltaOrToolActivityAt: null,
        lastToolActivityAt: null,
        unavailable: [],
      },
      tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      lifecycle: null,
      metadata: {
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
        ciStatus: null,
        lastPushedAt: null,
        lastEvidenceCursor: null,
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
      issueDetails: issueDetailsFixture({
        id: "issue-1",
        identifier: "TEST-1",
        title: "Live issue",
        state: "In Progress",
        branchName: "live/TEST-1",
        labels: ["dogfood-ready"],
        blockedBy: [{ id: "blocker-1", identifier: "TEST-0", state: "In Progress" }],
        url: "https://linear.app/acme/issue/TEST-1/live-issue",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([liveRunning]),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: "docs",
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1/runs`);
      const dashboardResponse = await fetch(`${baseUrl}/`);
      const stateBody = (await stateResponse.json()) as {
        running: Array<{
          issueDetails: IssueStatusView;
          liveness: unknown;
          cancellation: unknown;
          projectContext?: { projectContextId: string; projectContextLabel: string };
        }>;
        operatorView: {
          running: Array<{
            issueDetails: IssueDetailsEnvelope;
            liveness: { status: string; agentId: string | null };
            controls: { cancel: boolean };
            humanRequired: { active: boolean };
            continuationSummary: { available: boolean };
            projectContext?: { projectContextId: string; projectContextLabel: string };
          }>;
        };
        operatorLivenessContract: { cancelFailed: { tracked: boolean }; deferred: Record<string, unknown> };
      };
      const issueBody = (await issueResponse.json()) as {
        issueDetails: IssueDetailsEnvelope;
        live: {
          issueDetails: IssueStatusView;
          liveness: unknown;
          cancellation: unknown;
          operatorLiveness: {
            status: string;
            agentId: string | null;
            cancelFailed: { tracked: boolean; active: boolean };
            activity: { lastStreamActivityAt: string | null };
          };
        };
        operatorLiveness: {
          status: string;
          agentId: string | null;
          cancelFailed: { tracked: boolean; active: boolean };
          activity: { lastStreamActivityAt: string | null };
        };
        capabilities: {
          cancel: boolean;
          pause: boolean;
          mutationsRequireToken: boolean;
          continuationSummary: { available: boolean };
          humanRequired: { active: boolean };
        };
      };
      const runsBody = (await runsResponse.json()) as { issueDetails: IssueDetailsEnvelope };
      const dashboardHtml = await dashboardResponse.text();

      expect(stateResponse.status).toBe(200);
      expect(issueResponse.status).toBe(200);
      expect(runsResponse.status).toBe(200);
      expect(dashboardResponse.status).toBe(200);
      expect(stateBody.running[0]).toMatchObject({
        issueDetails: {
          id: "issue-1",
          identifier: "TEST-1",
          title: "Live issue",
          labels: ["dogfood-ready"],
        },
        projectContext: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
        },
        liveness: { status: "cancelling", activeRunId: "run-1" },
        cancellation: {
          requested: true,
          requestedAt: "2026-01-01T00:00:02.000Z",
          source: "operator",
          reason: "operator request",
          abortSignalled: true,
          suppressRetryOnExit: true,
        },
      });
      expect(issueBody.live).toMatchObject({
        liveness: { status: "cancelling", activeRunId: "run-1" },
        cancellation: {
          requested: true,
          requestedAt: "2026-01-01T00:00:02.000Z",
          source: "operator",
        },
      });
      expect(issueBody.live.issueDetails).toEqual(stateBody.running[0]?.issueDetails);
      expect(issueBody.issueDetails).toMatchObject({
        source: "live",
        completeness: "full",
        issue: stateBody.running[0]?.issueDetails,
        tracker: { generatedAt: "2026-01-01T00:10:00.000Z", classification: "active", stale: true },
        blockers: { available: true, totalCount: 1, openCount: 1, blocked: false },
        latestRun: { runId: "run-1", status: "running", terminalReason: null },
        pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null },
        workspace: { workspaceKey: "TEST-1", sourceKind: null },
      });
      expect(runsBody.issueDetails).toMatchObject(issueBody.issueDetails);
      expect(stateBody.operatorView.running[0]).toMatchObject({
        issueDetails: {
          source: "live",
          completeness: "full",
          issue: stateBody.running[0]?.issueDetails,
          tracker: { generatedAt: "2026-01-01T00:10:00.000Z", classification: "active", stale: true },
        },
        projectContext: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
        },
        liveness: { status: "cancelling", agentId: "agent-1" },
        controls: { cancel: false },
        humanRequired: { active: false },
        continuationSummary: { available: false },
      });
      expect(dashboardHtml).toContain("agent <code>agent-1</code>");
      expect(issueBody.operatorLiveness).toMatchObject({ status: "cancelling" });
      expect(issueBody.live.operatorLiveness).toMatchObject({ status: "cancelling" });
      expect(issueBody.operatorLiveness.agentId).toBe("agent-1");
      expect(issueBody.live.operatorLiveness.agentId).toBe("agent-1");
      expect(issueBody.operatorLiveness.cancelFailed).toMatchObject({ tracked: true, active: false });
      expect(issueBody.operatorLiveness.activity).toMatchObject({ lastStreamActivityAt: "2026-01-01T00:00:01.000Z" });
      expect(stateBody.operatorLivenessContract.cancelFailed).toMatchObject({ tracked: true });
      expect(stateBody.operatorLivenessContract.deferred).not.toHaveProperty("cancelFailed");
      expect(issueBody.capabilities).toMatchObject({
        cancel: false,
        pause: true,
        mutationsRequireToken: true,
        continuationSummary: { available: false },
        humanRequired: { active: false },
      });
    } finally {
      await server.stop();
    }
  });

  it("surfaces active cancelFailed on state, issue, and dashboard output", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const liveRunning: ReturnType<Orchestrator["snapshot"]>["running"][number] = {
      issueId: "issue-failed-cancel",
      issueIdentifier: "TEST-CANCEL-FAILED",
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      state: "In Progress",
      workspacePath: path.join(config.workspace.root, "TEST-CANCEL-FAILED"),
      sessionId: "session-failed-cancel",
      runId: "run-failed-cancel",
      turnCount: 1,
      lastEvent: "progress",
      lastMessage: "Still running",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastEventAt: "2026-01-01T00:00:03.000Z",
      liveness: {
        status: "cancelling",
        activeRunId: "run-failed-cancel",
        lastActivityAt: "2026-01-01T00:00:03.000Z",
        secondsSinceLastActivity: 1,
        stallTimeoutMs: 300_000,
      },
      cancellation: {
        requested: true,
        requestedAt: "2026-01-01T00:00:02.000Z",
        source: "operator",
        reason: "operator request",
        abortSignalled: true,
        harnessStopRequestedAt: "2026-01-01T00:00:02.000Z",
        harnessStopFailedAt: "2026-01-01T00:00:04.000Z",
        harnessStopFailedReason: "stop failed",
        cancelFailed: {
          tracked: true,
          active: true,
          phase: "failed",
          at: "2026-01-01T00:00:04.000Z",
          reason: "stop failed",
          source: "harness_stop",
        },
        suppressRetryOnExit: true,
      },
      activity: {
        lastHarnessActivityAt: "2026-01-01T00:00:03.000Z",
        lastStreamActivityAt: "2026-01-01T00:00:03.000Z",
        lastDeltaOrToolActivityAt: null,
        lastToolActivityAt: null,
        unavailable: [],
      },
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      lifecycle: null,
      metadata: {
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
        ciStatus: null,
        lastPushedAt: null,
        lastEvidenceCursor: null,
        branchName: "symphony/TEST-CANCEL-FAILED",
        gitBranchName: "symphony/TEST-CANCEL-FAILED",
        repoPath: "/repo",
        baseRef: "main",
      },
      issueDetails: issueDetailsFixture({
        id: "issue-failed-cancel",
        identifier: "TEST-CANCEL-FAILED",
        state: "In Progress",
        branchName: "symphony/TEST-CANCEL-FAILED",
      }),
    };
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([liveRunning]),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-CANCEL-FAILED`);
      const dashboardResponse = await fetch(`${baseUrl}/`);
      const stateBody = (await stateResponse.json()) as {
        running: Array<{ cancellation: { cancelFailed: { active: boolean; phase: string; source: string | null; at: string | null; reason: string | null } } }>;
        operatorView: {
          running: Array<{
            liveness: { cancelFailed: { active: boolean; phase: string; source: string | null; at: string | null; reason: string | null } };
          }>;
        };
      };
      const issueBody = (await issueResponse.json()) as {
        operatorLiveness: { cancelFailed: { active: boolean; phase: string; source: string | null; at: string | null; reason: string | null } };
        live: { operatorLiveness: { cancelFailed: { active: boolean; phase: string; source: string | null; at: string | null; reason: string | null } } };
      };
      const dashboardHtml = await dashboardResponse.text();

      const expectedCancelFailed = {
        active: true,
        phase: "failed",
        source: "harness_stop",
        at: "2026-01-01T00:00:04.000Z",
        reason: "stop failed",
      };
      expect(stateBody.running[0]?.cancellation.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(stateBody.operatorView.running[0]?.liveness.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(issueBody.operatorLiveness.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(issueBody.live.operatorLiveness.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(dashboardHtml).toContain("cancel_failed");
      expect(dashboardHtml).toContain("phase=failed");
      expect(dashboardHtml).toContain("source=harness_stop");
      expect(dashboardHtml).toContain("reason=stop failed");
      expect(dashboardHtml).not.toContain("harness stop failed stop failed");
    } finally {
      await server.stop();
    }
  });

  it("derives terminal activity from transcript events when activitySnapshot is absent", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-terminal-activity",
      sessionId: "session-terminal-activity",
      agentId: "agent-terminal-activity",
      role: "worker",
      issueId: "issue-terminal-activity",
      issueIdentifier: "TEST-TERMINAL-ACTIVITY",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-TERMINAL-ACTIVITY",
      workspacePath: path.join(config.workspace.root, "TEST-TERMINAL-ACTIVITY"),
    });
    await runStore.updateRun("run-terminal-activity", {
      status: "cancelled",
      completedAt: "2026-01-01T00:05:00.000Z",
      metadata: {
        cancellationRequestedAt: "2026-01-01T00:04:00.000Z",
          cancellationSource: "stalled",
        cancellationOutcome: "cancel_ignored",
        cancelFailed: true,
        cancelFailedAt: "2026-01-01T00:05:00.000Z",
        cancelFailedReason: "run completed after cancellation was requested",
        cancelFailedSource: "cancel_ignored",
      },
    });
    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      await runStore.appendEvent({
        runId: "run-terminal-activity",
        sequence,
        at: "2026-01-01T00:00:00.000Z",
        source: "harness",
        eventType: "tokens",
        payload: { type: "tokens", tokens: { totalTokens: sequence } },
      });
    }
    await runStore.appendEvent({
      runId: "run-terminal-activity",
      sequence: 1_001,
      at: "2026-01-01T00:01:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "stream",
      payload: { type: "progress", message: "stream", activitySource: "stream" },
    });
    await runStore.appendEvent({
      runId: "run-terminal-activity",
      sequence: 1_002,
      at: "2026-01-01T00:02:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "delta",
      payload: { type: "progress", message: "delta", activitySource: "delta" },
    });
    await runStore.appendEvent({
      runId: "run-terminal-activity",
      sequence: 1_003,
      at: "2026-01-01T00:03:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "tool",
      payload: { type: "progress", message: "tool", activitySource: "tool" },
    });
    await runStore.appendEvent({
      runId: "run-terminal-activity",
      sequence: 1_004,
      at: "2026-01-01T00:04:30.000Z",
      source: "harness",
      eventType: "cancelled",
      payload: { type: "cancelled" },
    });
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const runDetailResponse = await fetch(`${baseUrl}/api/v1/runs/run-terminal-activity`);
      const issueRunsResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-TERMINAL-ACTIVITY/runs`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-TERMINAL-ACTIVITY`);
      const runDetailBody = (await runDetailResponse.json()) as {
        operatorLiveness: {
          cancelFailed: { active: boolean; phase: string; source: string | null; at: string | null; reason: string | null };
          activity: {
            lastHarnessActivityAt: string | null;
            lastStreamActivityAt: string | null;
            lastDeltaOrToolActivityAt: string | null;
            lastToolActivityAt: string | null;
            unavailable: string[];
          };
        };
      };
      const issueRunsBody = (await issueRunsResponse.json()) as {
        issueDetails: IssueDetailsEnvelope;
        runs: Array<{ runId: string; operatorLiveness: null | typeof runDetailBody.operatorLiveness }>;
      };
      const issueBody = (await issueResponse.json()) as {
        issueDetails: IssueDetailsEnvelope;
        operatorLiveness: typeof runDetailBody.operatorLiveness;
      };

      const expectedActivity = {
        lastHarnessActivityAt: "2026-01-01T00:04:30.000Z",
        lastStreamActivityAt: "2026-01-01T00:01:00.000Z",
        lastDeltaOrToolActivityAt: "2026-01-01T00:03:00.000Z",
        lastToolActivityAt: "2026-01-01T00:03:00.000Z",
        unavailable: [],
      };
      const expectedCancelFailed = {
        active: true,
        phase: "resolved_failed",
        source: "cancel_ignored",
        at: "2026-01-01T00:05:00.000Z",
        reason: "run completed after cancellation was requested",
      };
      expect(runDetailBody.operatorLiveness.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(runDetailBody.operatorLiveness.activity).toEqual(expectedActivity);
      const issueRun = issueRunsBody.runs.find((run) => run.runId === "run-terminal-activity");
      expect(issueRun?.operatorLiveness?.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(issueRun?.operatorLiveness?.activity).toEqual(expectedActivity);
      expect(issueBody.operatorLiveness.cancelFailed).toMatchObject(expectedCancelFailed);
      expect(issueBody.operatorLiveness.activity).toEqual(expectedActivity);
      expect(issueBody.issueDetails.latestRun).toMatchObject({
        runId: "run-terminal-activity",
        status: "cancelled",
        terminalReason: "stalled",
      });
      expect(issueRunsBody.issueDetails.latestRun).toMatchObject(issueBody.issueDetails.latestRun);
    } finally {
      await server.stop();
    }
  });

  it("includes lifecycle-aware operator liveness and timelines in run history", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "run-old",
      sessionId: "session-old",
      agentId: "agent-old",
      role: "worker",
      issueId: "issue-4",
      issueIdentifier: "TEST-4",
      attempt: null,
      turnNumber: 1,
      prompt: "old work",
      workspaceKey: "TEST-4",
      workspacePath: path.join(config.workspace.root, "TEST-4"),
    });
    await runStore.updateRun("run-old", {
      status: "succeeded",
      completedAt: "2026-01-01T00:01:00.000Z",
    });
    await runStore.startRun({
      runId: "run-blocked",
      sessionId: "session-blocked",
      agentId: "agent-blocked",
      role: "worker",
      issueId: "issue-4",
      issueIdentifier: "TEST-4",
      attempt: null,
      turnNumber: 2,
      prompt: "blocked work",
      workspaceKey: "TEST-4",
      workspacePath: path.join(config.workspace.root, "TEST-4"),
    });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(
      { id: "issue-4", identifier: "TEST-4" },
      {
        phase: "merge_conflict_resolution",
        blockedReason: null,
        summaryPointers: {},
        mergeConflict: {
          id: "merge-conflict:issue-4:head-sha-1",
          status: "blocked",
          resolutionStatus: "blocked",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/7",
            number: 7,
            headSha: "head-sha-1",
            branch: "symphony/TEST-4",
          },
          approvedHeadSha: "approved-head-sha",
          currentHeadSha: "head-sha-1",
          resolvedHeadSha: null,
          baseBranch: "main",
          baseHeadSha: "base-sha-1",
          sourceState: "Ready to Merge",
          conflictsState: "Approved with Conflicts",
          reason: "Pull request has merge conflicts with the base branch",
          mergeableState: "dirty",
          detectedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          fixTurnCount: 3,
          maxFixTurns: 3,
          lastConflictFixRunId: "run-blocked",
          lastConflictResolutionReportId: "merge-conflict-resolution:issue-4:blocked-1",
          attemptRunIds: ["run-blocked"],
          writebackOperationKeys: [],
          blockedAt: "2026-01-01T00:01:00.000Z",
          blockedReason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)",
        },
      },
    );
    const server = new StatusServer({
      orchestrator: fakeOrchestrator(),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-4`);
      const runsResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-4/runs`);
      const runDetailResponse = await fetch(`${baseUrl}/api/v1/runs/run-blocked`);
      const issueBody = (await issueResponse.json()) as {
        operatorLiveness: { status: string };
        capabilities: { humanRequired: { active: boolean; reason: string | null }; continuationSummary: { available: boolean; path: string } };
      };
      const runsBody = (await runsResponse.json()) as {
        issueBlocked: { status: string; reason: string };
        enrichment: { timelineIncluded: boolean; level: string };
        runs: Array<{ runId: string; operatorLiveness: null | { status: string; timeline: Array<{ kind: string }> }; livenessSummary: { status: string | null } }>;
      };
      const runDetailBody = (await runDetailResponse.json()) as {
        operatorLiveness: null | { status: string; timeline: Array<{ kind: string }> };
      };

      expect(issueResponse.status).toBe(200);
      expect(issueBody.operatorLiveness).toMatchObject({ status: "blocked_human_required" });
      expect(issueBody.capabilities).toMatchObject({
        humanRequired: { active: true, reason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)" },
        continuationSummary: { available: true, path: "/api/v1/issues/TEST-4/continuation-summary" },
      });
      expect(runsResponse.status).toBe(200);
      expect(runDetailResponse.status).toBe(200);
      expect(runsBody.issueBlocked).toMatchObject({
        status: "blocked_human_required",
        reason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)",
      });
      expect(runsBody.enrichment).toMatchObject({ timelineIncluded: true, level: "operator_liveness_with_timeline" });
      expect(runsBody.runs.find((run) => run.runId === "run-old")?.operatorLiveness).toBeNull();
      const blockedRun = runsBody.runs.find((run) => run.runId === "run-blocked");
      expect(blockedRun?.operatorLiveness).toMatchObject({ status: "blocked_human_required" });
      expect(blockedRun?.livenessSummary).toMatchObject({ status: "blocked_human_required" });
      expect(blockedRun?.operatorLiveness?.timeline.some((event) => event.kind === "lifecycle_blocked")).toBe(true);
      expect(runDetailBody.operatorLiveness).toMatchObject({ status: "blocked_human_required" });
      expect(runDetailBody.operatorLiveness?.timeline.some((event) => event.kind === "lifecycle_blocked")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("renders operator liveness, retrying, and paused rows on the dashboard", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const blockedLifecycle = await lifecycleStore.ensureIssue(
      { id: "issue-blocked", identifier: "TEST-BLOCKED" },
      {
        phase: "blocked",
        blockedReason: "needs operator",
        summaryPointers: {},
        mergeConflict: {
          id: "merge-conflict:issue-blocked:head-sha-1",
          status: "blocked",
          resolutionStatus: "blocked",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/42",
            number: 42,
            headSha: "head-sha-1",
            branch: "symphony/TEST-BLOCKED",
          },
          approvedHeadSha: "approved-head-sha",
          currentHeadSha: "head-sha-1",
          resolvedHeadSha: null,
          baseBranch: "main",
          baseHeadSha: "base-sha-1",
          sourceState: "Ready to Merge",
          conflictsState: "Approved with Conflicts",
          reason: "Pull request has merge conflicts with the base branch",
          mergeableState: "dirty",
          detectedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          fixTurnCount: 3,
          maxFixTurns: 3,
          lastConflictFixRunId: "conflict-run-3",
          lastConflictResolutionReportId: "merge-conflict-resolution:issue-blocked:blocked-1",
          attemptRunIds: ["conflict-run-1", "conflict-run-2", "conflict-run-3"],
          writebackOperationKeys: [],
          blockedAt: "2026-01-01T00:01:00.000Z",
          blockedReason: "needs operator",
        },
      },
    );
    await lifecycleStore.ensureIssue(
      { id: "issue-paused", identifier: "TEST-PAUSED" },
      {
        phase: "blocked",
        blockedReason: "paused needs operator",
        summaryPointers: {},
      },
    );
    const stalledRunning: ReturnType<Orchestrator["snapshot"]>["running"][number] = {
      issueId: "issue-2",
      issueIdentifier: "TEST-2",
      role: "worker",
      runPhase: "implementation",
      runKind: "implementation",
      state: "In Progress",
      workspacePath: path.join(config.workspace.root, "TEST-2"),
      sessionId: "session-2",
      runId: "run-2",
      turnCount: 1,
      lastEvent: "progress",
      lastMessage: "<script>alert(1)</script>",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastEventAt: "2026-01-01T00:00:01.000Z",
      liveness: {
        status: "stalled",
        activeRunId: "run-2",
        lastActivityAt: "2026-01-01T00:00:01.000Z",
        secondsSinceLastActivity: 301,
        stallTimeoutMs: 300_000,
      },
      cancellation: {
        requested: false,
        requestedAt: null,
        source: null,
        reason: null,
        abortSignalled: false,
        harnessStopRequestedAt: null,
        suppressRetryOnExit: false,
      },
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      lifecycle: null,
      metadata: {
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
        ciStatus: null,
        lastPushedAt: null,
        lastEvidenceCursor: null,
        branchName: "symphony/TEST-2",
        gitBranchName: "symphony/TEST-2",
        repoPath: "/repo",
        baseRef: "main",
      },
      issueDetails: issueDetailsFixture({
        id: "issue-2",
        identifier: "TEST-2",
        title: "Stalled issue",
        state: "In Progress",
        branchName: "symphony/TEST-2",
      }),
    };
    const blockedRunning: ReturnType<Orchestrator["snapshot"]>["running"][number] = {
      ...stalledRunning,
      issueId: "issue-blocked",
      issueIdentifier: "TEST-BLOCKED",
      state: "Approved with Conflicts",
      workspacePath: path.join(config.workspace.root, "TEST-BLOCKED"),
      sessionId: "session-blocked",
      runId: "run-blocked-live",
      liveness: {
        ...stalledRunning.liveness,
        activeRunId: "run-blocked-live",
      },
      lifecycle: blockedLifecycle,
      issueDetails: issueDetailsFixture({
        id: "issue-blocked",
        identifier: "TEST-BLOCKED",
        title: "Blocked issue",
        state: "Blocked",
        branchName: "symphony/TEST-BLOCKED",
      }),
    };
    const server = new StatusServer({
      orchestrator: fakeOrchestrator([stalledRunning, blockedRunning], {
        paused: ["issue-paused"],
        retrying: [
          {
            issueId: "issue-3",
            issueIdentifier: "TEST-3",
            attempt: 2,
            dueAt: "2026-01-01T00:05:00.000Z",
            error: "rate limited",
          },
        ],
      }),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const response = await fetch(`${baseUrl}/`);
      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const html = await response.text();
      const stateBody = (await stateResponse.json()) as {
        running: Array<{ issueIdentifier: string; issueDetails: IssueStatusView }>;
        operatorView: {
          running: Array<{
            issueIdentifier: string;
            issueDetails: IssueDetailsEnvelope;
            liveness: { status: string };
            mergeConflict: {
              conflictState: string;
              status: string;
              resolutionStatus: string;
              fixTurnCount: number;
              maxFixTurns: number;
              attemptsLabel: string;
              pullRequest: { url: string | null; number: number | null; branch: string | null; headSha: string | null };
              baseBranch: string | null;
              baseHeadSha: string | null;
              lastConflictFixRunId: string | null;
              lastConflictResolutionReportId: string | null;
              blockedReason: string | null;
            } | null;
            humanRequired: { active: boolean; reason: string | null };
            continuationSummary: { available: boolean; path: string };
          }>;
          paused: Array<{
            issueId: string;
            issueIdentifier: string;
            issueDetails: IssueDetailsEnvelope;
            controls: { pause: boolean; resume: boolean; cancel: boolean; mutationsRequireToken: boolean };
            humanRequired: { active: boolean; reason: string | null };
            continuationSummary: { available: boolean; path: string };
          }>;
        };
      };

      expect(response.status).toBe(200);
      expect(stateResponse.status).toBe(200);
      expect(html).toContain("possibly_stalled");
      expect(html).toContain("operator-possibly_stalled");
      expect(html).toContain("blocked_human_required");
      expect(html).toContain("301s idle");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).toContain("TEST-3");
      expect(html).toContain("issue-paused");
      expect(html).toContain("TEST-PAUSED");
      expect(html).toContain("controls: resume");
      expect(html).toContain("continuation-summary POST /api/v1/issues/TEST-PAUSED/continuation-summary");
      expect(html).toContain("Merge conflict:");
      expect(html).toContain("state=Approved with Conflicts");
      expect(html).toContain("attempts=3/3");
      expect(html).toContain("PR=#42 https://github.com/acme/repo/pull/42");
      expect(html).toContain("lastRun=conflict-run-3");
      const paused = stateBody.operatorView.paused[0];
      expect(paused).toMatchObject({
        issueId: "issue-paused",
        issueIdentifier: "TEST-PAUSED",
        controls: { pause: false, resume: true, cancel: false, mutationsRequireToken: false },
        issueDetails: {
          source: "durable",
          completeness: "partial",
          issue: { id: "issue-paused", identifier: "TEST-PAUSED", branchName: null, state: null },
          tracker: { generatedAt: null, classification: null, stale: null },
          blockers: { available: false, humanBlockedReason: "paused needs operator" },
        },
        humanRequired: { active: true, reason: "paused needs operator" },
        continuationSummary: { available: true, path: "/api/v1/issues/TEST-PAUSED/continuation-summary" },
      });
      const blocked = stateBody.operatorView.running.find((row) => row.issueIdentifier === "TEST-BLOCKED");
      const rawBlocked = stateBody.running.find((row) => row.issueIdentifier === "TEST-BLOCKED");
      expect(blocked).toMatchObject({
        issueDetails: { source: "live", completeness: "full", issue: rawBlocked?.issueDetails },
        liveness: { status: "blocked_human_required" },
        mergeConflict: {
          conflictState: "Approved with Conflicts",
          status: "blocked",
          resolutionStatus: "blocked",
          fixTurnCount: 3,
          maxFixTurns: 3,
          attemptsLabel: "3/3",
          pullRequest: {
            url: "https://github.com/acme/repo/pull/42",
            number: 42,
            branch: "symphony/TEST-BLOCKED",
            headSha: "head-sha-1",
          },
          baseBranch: "main",
          baseHeadSha: "base-sha-1",
          lastConflictFixRunId: "conflict-run-3",
          lastConflictResolutionReportId: "merge-conflict-resolution:issue-blocked:blocked-1",
          blockedReason: "needs operator",
        },
        humanRequired: { active: true, reason: "needs operator" },
        continuationSummary: { available: true, path: "/api/v1/issues/TEST-BLOCKED/continuation-summary" },
      });
    } finally {
      await server.stop();
    }
  });
});

function issueDetailsFixture(overrides: Partial<IssueStatusView> & Pick<IssueStatusView, "id" | "identifier">): IssueStatusView {
  const { id, identifier, ...rest } = overrides;
  return {
    id,
    identifier,
    title: "Test issue",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...rest,
  };
}

function durableIssueDetails(overrides: Partial<IssueDetailsEnvelope["issue"]> = {}): IssueDetailsEnvelope {
  const issue = {
    id: "issue-1",
    identifier: "TEST-1",
    title: null,
    description: null,
    priority: null,
    state: null,
    branchName: "symphony/TEST-1",
    url: null,
    assigneeId: null,
    delegateId: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
  return {
    source: "durable",
    completeness: "partial",
    issue,
    tracker: {
      generatedAt: null,
      updatedAt: null,
      ageMs: null,
      stale: null,
      staleThresholdMs: 300_000,
      state: null,
      classification: null,
    },
    blockers: {
      available: false,
      totalCount: 0,
      openCount: 0,
      open: [],
      blocked: false,
      humanBlockedReason: null,
    },
    workspace: {
      workspaceKey: "TEST-1",
      path: null,
      sourceKind: null,
      branchName: issue.branchName,
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    },
    pullRequest: {
      url: "https://github.com/acme/repo/pull/7",
      number: 7,
      headSha: null,
      branch: null,
      ciStatus: "success",
      lastPushedAt: "2026-01-01T00:00:00.500Z",
    },
    latestRun: {
      runId: "run-1",
      runPhase: "implementation",
      runKind: "implementation",
      status: "running",
      terminalReason: null,
      error: null,
      completedAt: null,
    },
  };
}

function liveRunningFixture(
  config: ReturnType<typeof testConfig>,
  identifier: string,
  state: string,
): ReturnType<Orchestrator["snapshot"]>["running"][number] {
  const id = `issue-${identifier.toLowerCase()}`;
  const runId = `run-${identifier.toLowerCase()}`;
  return {
    issueId: id,
    issueIdentifier: identifier,
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    state,
    workspacePath: null,
    sessionId: null,
    runId,
    turnCount: 1,
    lastEvent: null,
    lastMessage: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastEventAt: null,
    liveness: {
      status: "active",
      activeRunId: runId,
      lastActivityAt: "2026-01-01T00:10:00.000Z",
      secondsSinceLastActivity: 0,
      stallTimeoutMs: 300_000,
    },
    cancellation: {
      requested: false,
      requestedAt: null,
      source: null,
      reason: null,
      abortSignalled: false,
      harnessStopRequestedAt: null,
      suppressRetryOnExit: false,
    },
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    lifecycle: null,
    metadata: {
      prUrl: null,
      prNumber: null,
      prHeadSha: null,
      prBranch: null,
      ciStatus: null,
      lastPushedAt: null,
      lastEvidenceCursor: null,
      branchName: null,
      gitBranchName: null,
      repoPath: null,
      baseRef: null,
    },
    issueDetails: issueDetailsFixture({
      id,
      identifier,
      title: `${identifier} title`,
      state,
      updatedAt: "2026-01-01T00:08:30.000Z",
    }),
  };
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["In Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  };
}

class FakeTracker implements TrackerClient {
  requestedStates: string[] = [];
  fetchCount = 0;

  constructor(private readonly issues: Issue[]) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return [];
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    this.fetchCount += 1;
    this.requestedStates = stateNames;
    return this.issues.filter((item) =>
      stateNames.some((state) => state.toLowerCase() === item.state.toLowerCase()),
    );
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return this.issues.filter((item) => issueIds.includes(item.id));
  }
}

class CountingRunTranscriptStore extends FileRunTranscriptStore {
  listWorkspacesCount = 0;
  listRunsCount = 0;
  findWorkspaceCount = 0;
  listRunsForIssueCount = 0;
  latestRunForIssueCount = 0;

  override async listWorkspaces() {
    this.listWorkspacesCount += 1;
    return super.listWorkspaces();
  }

  override async listRuns() {
    this.listRunsCount += 1;
    return super.listRuns();
  }

  override async findWorkspace(issueIdOrIdentifierOrKey: string) {
    this.findWorkspaceCount += 1;
    return super.findWorkspace(issueIdOrIdentifierOrKey);
  }

  override async listRunsForIssue(issueIdOrIdentifier: string): Promise<RunRecord[]> {
    this.listRunsForIssueCount += 1;
    return super.listRunsForIssue(issueIdOrIdentifier);
  }

  override async latestRunForIssue(
    issueIdOrIdentifier: string,
    options: Parameters<FileRunTranscriptStore["latestRunForIssue"]>[1] = {},
  ): Promise<RunRecord | null> {
    this.latestRunForIssueCount += 1;
    return super.latestRunForIssue(issueIdOrIdentifier, options);
  }
}

class CountingIssueLifecycleStore extends FileIssueLifecycleStore {
  listCount = 0;
  getCount = 0;

  resetReadCounts(): void {
    this.listCount = 0;
    this.getCount = 0;
  }

  override async list(): Promise<IssueLifecycleRecord[]> {
    this.listCount += 1;
    return super.list();
  }

  override async get(issueIdOrIdentifier: string): Promise<IssueLifecycleRecord | null> {
    this.getCount += 1;
    return super.get(issueIdOrIdentifier);
  }
}

class PlanningRunStrictIdTracker implements TrackerClient {
  readonly lookupCalls: string[][] = [];

  constructor(private readonly candidate: Issue) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return [];
  }

  async fetchIssuesByStates(): Promise<Issue[]> {
    return [];
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    this.lookupCalls.push([...issueIds]);
    return issueIds.includes(this.candidate.id) ? [this.candidate] : [];
  }
}

class PlanningRunRecordingHarness implements AgentHarness {
  readonly id = "planning-run-recording";
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    yield { type: "session_started", sessionId: "planning-api-session", runId: "planning-api-run" };
    yield { type: "completed" };
  }
}

class BlockingPlanningFailureLifecycleStore extends FileIssueLifecycleStore {
  private readonly planningFailureUpdateStarted: Promise<void>;
  private readonly releasePlanningFailureUpdatePromise: Promise<void>;
  private resolvePlanningFailureUpdateStarted!: () => void;
  private resolveReleasePlanningFailureUpdate!: () => void;

  constructor(stateDir: string) {
    super(stateDir);
    this.planningFailureUpdateStarted = new Promise((resolve) => {
      this.resolvePlanningFailureUpdateStarted = resolve;
    });
    this.releasePlanningFailureUpdatePromise = new Promise((resolve) => {
      this.resolveReleasePlanningFailureUpdate = resolve;
    });
  }

  override async updateIssue(
    issue: Pick<Issue, "id" | "identifier">,
    patch: IssueLifecyclePatch,
  ): Promise<IssueLifecycleRecord> {
    if (patch.lastPlanningFailureRunId === "planning-api-run") {
      this.resolvePlanningFailureUpdateStarted();
      await this.releasePlanningFailureUpdatePromise;
    }
    return super.updateIssue(issue, patch);
  }

  waitForPlanningFailureUpdate(): Promise<void> {
    return this.planningFailureUpdateStarted;
  }

  releasePlanningFailureUpdate(): void {
    this.resolveReleasePlanningFailureUpdate();
  }
}

class StatusProviderLimitHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    yield {
      type: "session_started",
      sessionId: `status-provider-limit-session-${this.runs.length}`,
      runId: `status-provider-limit-run-${this.runs.length}`,
    };
    if (this.runs.length > 1) {
      yield { type: "completed", message: "recovered" };
      return;
    }
    yield {
      type: "provider_limit",
      signal: {
        scope: { harnessId: "hermes", providerId: "openai-codex" },
        kind: "windowed_bucket_exhausted",
        message: "Codex weekly allotment exhausted",
        window: { windowLabel: "Weekly", windowKind: "codex_weekly" },
        resumePolicy: "manual",
      },
    };
  }
}

async function createPlanningRunApiFixture(root: string, candidate: Issue): Promise<{
  baseUrl: string;
  harness: PlanningRunRecordingHarness;
  orchestrator: Orchestrator;
  runStore: FileRunTranscriptStore;
  server: StatusServer;
  tracker: PlanningRunStrictIdTracker;
}> {
  const config = testConfig(path.join(root, "workspaces"));
  config.issueBreakdown.enabled = true;
  const logger = new StructuredLogger(() => undefined);
  const tracker = new PlanningRunStrictIdTracker(candidate);
  const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
  const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
  const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
  const harness = new PlanningRunRecordingHarness();
  const orchestrator = new Orchestrator({
    config,
    tracker,
    workspaceManager,
    harness,
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    lifecycleStore,
    runStore,
  });
  const server = new StatusServer({
    orchestrator,
    workspaceManager,
    workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
    runStore,
    lifecycleStore,
    writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: "secret",
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
  const address = await server.start();
  return {
    baseUrl: `http://${address.host}:${address.port}`,
    harness,
    orchestrator,
    runStore,
    server,
    tracker,
  };
}

async function waitForStatusApiAsync(predicate: () => Promise<boolean>, description: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await predicate(), `Timed out waiting for ${description}`).toBe(true);
}

function fakeOrchestrator(
  running: ReturnType<Orchestrator["snapshot"]>["running"] = [],
  overrides: Partial<Pick<ReturnType<Orchestrator["snapshot"]>, "paused" | "retrying">> = {},
): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:10:00.000Z",
        counts: {
          running: running.length,
          retrying: overrides.retrying?.length ?? 0,
          paused: overrides.paused?.length ?? 0,
          providerGates: 0,
        },
        providerGates: [],
        providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
        running,
        retrying: overrides.retrying ?? [],
        paused: overrides.paused ?? [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    getIssueDetails(issueIdOrIdentifier: string) {
      return (
        running.find((row) => row.issueId === issueIdOrIdentifier || row.issueIdentifier === issueIdOrIdentifier) ??
        null
      );
    },
    async refreshNow() {
      return undefined;
    },
    pauseIssue() {
      return undefined;
    },
    resumeIssue() {
      return undefined;
    },
    async cancelIssue() {
      return undefined;
    },
    async createContinuationSummary(issueId: string) {
      return {
        summaryReference: {
          id: `fake-summary:${issueId}`,
          kind: "continuation_history",
          summary: "fake summary",
          runIds: ["run-1"],
          transcriptEventCount: 1,
          transcriptPointers: ["/api/v1/runs/run-1/transcript"],
          statusApiPointers: ["/api/v1/issues/TEST-1"],
          createdAt: "2026-01-01T00:00:00Z",
        },
        lifecycle: {
          summaryReferences: [],
        },
      };
    },
  } as unknown as Orchestrator;
}
