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
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import type { Issue, IssueDetailsEnvelope, IssueStatusView, TrackerStateLists } from "../src/core/types.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { issue, testConfig } from "./helpers.js";

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
        id: "fake-summary:TEST-1",
        transcriptPointers: ["/api/v1/runs/run-1/transcript"],
        statusApiPointers: ["/api/v1/issues/TEST-1"],
      });
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
          syntheticRunEvents: number;
          writebackOperationsConsidered: number;
        };
        source: { runStoreAvailable: boolean; writebackOutboxAvailable: boolean };
      };
      const secondPageResponse = await fetch(`${baseUrl}/api/v1/activity?offset=1&limit=1`);
      const secondPage = (await secondPageResponse.json()) as typeof firstPage;
      const issueResponse = await fetch(`${baseUrl}/api/v1/activity?issue=TEST-A&limit=100`);
      const issueBody = (await issueResponse.json()) as typeof firstPage;
      const writebackResponse = await fetch(`${baseUrl}/api/v1/activity?issue=TEST-B&offset=1001&limit=10`);
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
        totalItems: 1_005,
        distinctRunsConsidered: 2,
        transcriptEventsConsidered: 1_002,
        syntheticRunEvents: 2,
        writebackOperationsConsidered: 1,
      });
      expect(firstPage.source.runStoreAvailable).toBe(true);
      expect(firstPage.source.writebackOutboxAvailable).toBe(true);
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
      expect(html).toContain("Not Live Runs");
      expect(html).toContain("TEST-ORPHANED");
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
          syntheticRunEvents: number;
          writebackOperationsConsidered: number;
        };
        source: { kind: string; runStoreAvailable: boolean; writebackOutboxAvailable: boolean };
      };

      expect(response.status).toBe(200);
      expect(body.activity).toEqual([]);
      expect(body.nextOffset).toBeNull();
      expect(body.counts).toEqual({
        totalItems: 0,
        distinctRunsConsidered: 0,
        transcriptEventsConsidered: 0,
        syntheticRunEvents: 0,
        writebackOperationsConsidered: 0,
      });
      expect(body.source).toEqual({ kind: "durable_activity", runStoreAvailable: false, writebackOutboxAvailable: false });
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

  it("serves a Linear-backed issue board enriched with Symphony state", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    config.mergePolicy.sourceStates = ["Ready to Merge"];

    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
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
        state: "In Review",
        url: "https://linear.app/acme/issue/TEST-1/linear-review-title",
        labels: ["dogfood-ready"],
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
      expect(tracker.requestedStates).toEqual(["Backlog", "Todo", "In Progress", "Blocked", "In Review", "Ready to Merge", "Done", "Canceled"]);
      expect(tracker.fetchCount).toBe(1);
      expect(body.tracker).toMatchObject({ issueCount: 6, cached: false });
      expect(body.counts).toMatchObject({ total: 7, trackerBacked: 6, symphonyOnly: 1, live: 1, paused: 1, blocked: 3 });
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
      expect(boardBody.counts.total).toBe(7);
      expect(boardBody.issues.find((item) => item.issueIdentifier === "TEST-TODO")?.capabilities.detail).toBe(
        "/api/v1/board/issues/issue-todo",
      );

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
          issue: { description: "Todo detail description", identifier: "TEST-TODO" },
        },
        runs: [],
        pullRequest: { url: null, ciStatus: null },
        blockers: { openCount: 1, blocked: true },
        capabilities: { openWorkspace: false, transcript: false },
      });

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
      const body = (await response.json()) as { error: { code: string; message: string } };
      const acceptedBody = (await acceptedResponse.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(503);
      expect(body.error).toMatchObject({
        code: "tracker_unavailable",
        message: "Issue board requires a configured tracker client",
      });
      expect(acceptedResponse.status).toBe(503);
      expect(acceptedBody.error).toMatchObject(body.error);
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
