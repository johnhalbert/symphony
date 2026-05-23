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
import type { IssueDetailsEnvelope, IssueStatusView } from "../src/core/types.js";
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
        issueDetails: IssueDetailsEnvelope;
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
      expect(issueBody.issueDetails).toEqual(durableIssueDetails());
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
      expect(runsBody.issueDetails).toEqual(durableIssueDetails());
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
        blockedBy: [{ id: "blocker-1", identifier: "TEST-0", state: "Done" }],
        url: "https://linear.app/acme/issue/TEST-1/live-issue",
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
      runStore,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const dashboardResponse = await fetch(`${baseUrl}/`);
      const stateBody = (await stateResponse.json()) as {
        running: Array<{ issueDetails: IssueStatusView; liveness: unknown; cancellation: unknown }>;
        operatorView: {
          running: Array<{
            issueDetails: IssueDetailsEnvelope;
            liveness: { status: string; agentId: string | null };
            controls: { cancel: boolean };
            humanRequired: { active: boolean };
            continuationSummary: { available: boolean };
          }>;
        };
        operatorLivenessContract: { cancelFailed: { tracked: boolean }; deferred: Record<string, unknown> };
      };
      const issueBody = (await issueResponse.json()) as {
        issueDetails: IssueDetailsEnvelope;
        live: {
          issueDetails?: IssueStatusView;
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
      const dashboardHtml = await dashboardResponse.text();

      expect(stateResponse.status).toBe(200);
      expect(issueResponse.status).toBe(200);
      expect(dashboardResponse.status).toBe(200);
      expect(stateBody.running[0]).toMatchObject({
        issueDetails: {
          id: "issue-1",
          identifier: "TEST-1",
          title: "Live issue",
          labels: ["dogfood-ready"],
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
      expect(issueBody.live).not.toHaveProperty("issueDetails");
      expect(issueBody.issueDetails).toEqual({
        source: "live",
        completeness: "full",
        issue: stateBody.running[0]?.issueDetails,
      });
      expect(stateBody.operatorView.running[0]).toMatchObject({
        issueDetails: {
          source: "live",
          completeness: "full",
          issue: stateBody.running[0]?.issueDetails,
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
        cancellationSource: "operator",
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
        runs: Array<{ runId: string; operatorLiveness: null | typeof runDetailBody.operatorLiveness }>;
      };
      const issueBody = (await issueResponse.json()) as {
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
        phase: "blocked",
        blockedReason: "human required",
        summaryPointers: {},
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
        humanRequired: { active: true, reason: "human required" },
        continuationSummary: { available: true, path: "/api/v1/issues/TEST-4/continuation-summary" },
      });
      expect(runsResponse.status).toBe(200);
      expect(runDetailResponse.status).toBe(200);
      expect(runsBody.issueBlocked).toMatchObject({ status: "blocked_human_required", reason: "human required" });
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
      state: "Blocked",
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
      const paused = stateBody.operatorView.paused[0];
      expect(paused).toMatchObject({
        issueId: "issue-paused",
        issueIdentifier: "TEST-PAUSED",
        controls: { pause: false, resume: true, cancel: false, mutationsRequireToken: false },
        issueDetails: durableIssueDetails({ id: "issue-paused", identifier: "TEST-PAUSED", branchName: null }),
        humanRequired: { active: true, reason: "paused needs operator" },
        continuationSummary: { available: true, path: "/api/v1/issues/TEST-PAUSED/continuation-summary" },
      });
      const blocked = stateBody.operatorView.running.find((row) => row.issueIdentifier === "TEST-BLOCKED");
      const rawBlocked = stateBody.running.find((row) => row.issueIdentifier === "TEST-BLOCKED");
      expect(blocked).toMatchObject({
        issueDetails: { source: "live", completeness: "full", issue: rawBlocked?.issueDetails },
        liveness: { status: "blocked_human_required" },
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
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...rest,
  };
}

function durableIssueDetails(overrides: Partial<IssueDetailsEnvelope["issue"]> = {}): IssueDetailsEnvelope {
  return {
    source: "durable",
    completeness: "partial",
    issue: {
      id: "issue-1",
      identifier: "TEST-1",
      title: null,
      description: null,
      priority: null,
      state: null,
      branchName: "symphony/TEST-1",
      url: null,
      assigneeId: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      ...overrides,
    },
  };
}

function fakeOrchestrator(
  running: ReturnType<Orchestrator["snapshot"]>["running"] = [],
  overrides: Partial<Pick<ReturnType<Orchestrator["snapshot"]>, "paused" | "retrying">> = {},
): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: new Date(0).toISOString(),
        counts: {
          running: running.length,
          retrying: overrides.retrying?.length ?? 0,
          paused: overrides.paused?.length ?? 0,
        },
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
