import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import { resolveStatusMutationToken } from "../src/app/RuntimeDependencies.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileMcpExposureDiagnosticsStore } from "../src/core/persistence/McpExposureDiagnosticsStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { testConfig } from "./helpers.js";

describe("StatusServer durable API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-http-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

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
        latestRun: { runId: string };
        reviewLoop: {
          phase: string | null;
          role: string | null;
          reviewRound: number | null;
          incompleteTurnCount: number | null;
          blockedReason: string | null;
          lastCompletionReport: { id: string; summary: string } | null;
          lastReviewVerdict: { id: string; verdict: string; findings: string[] } | null;
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
      const runsBody = (await runsResponse.json()) as { runs: unknown[] };
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
        id: "fake-summary:TEST-1",
        transcriptPointers: ["/api/v1/runs/run-1/transcript"],
        statusApiPointers: ["/api/v1/issues/TEST-1"],
      });
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

  it("serves live liveness and cancellation state from the orchestrator snapshot", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const liveRunning: ReturnType<Orchestrator["snapshot"]>["running"][number] = {
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      role: "worker",
      state: "In Progress",
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
        suppressRetryOnExit: true,
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
      openWorkspaceToken: "secret",
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const stateBody = (await stateResponse.json()) as {
        running: Array<{ liveness: unknown; cancellation: unknown }>;
      };
      const issueBody = (await issueResponse.json()) as {
        live: { liveness: unknown; cancellation: unknown };
      };

      expect(stateResponse.status).toBe(200);
      expect(issueResponse.status).toBe(200);
      expect(stateBody.running[0]).toMatchObject({
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
    } finally {
      await server.stop();
    }
  });
});

function fakeOrchestrator(running: ReturnType<Orchestrator["snapshot"]>["running"] = []): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: new Date(0).toISOString(),
        counts: { running: running.length, retrying: 0, paused: 0 },
        running,
        retrying: [],
        paused: [],
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
