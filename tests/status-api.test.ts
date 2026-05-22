import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
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
      ok: false,
      stages: [
        {
          stage: "sdk",
          status: "failure",
          failureCode: "sdk_init_timeout_no_tools_empty_tools_name_mismatch",
          message: "Cursor SDK did not expose submit_completion_report",
          results: [
            {
              role: "worker",
              serverKey: "symphony",
              command: "completion-report-mcp",
              expectedTool: "submit_completion_report",
              status: "failure",
              failureCode: "sdk_init_timeout_no_tools_empty_tools_name_mismatch",
              message: "Cursor SDK did not expose submit_completion_report",
              rawToolNames: ["read_file"],
              normalizedToolNames: [],
              envKeyNames: ["LINEAR_API_KEY"],
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
        };
        capabilities: { openWorkspace: boolean };
        diagnostics: { mcpToolExposure: { ok: boolean; stages: Array<{ failureCode: string | null }> } | null };
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
      const diagnosticsBody = (await diagnosticsResponse.json()) as { latest: { ok: boolean } | null };

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
      });
      expect(issueBody.capabilities.openWorkspace).toBe(false);
      expect(issueBody.diagnostics.mcpToolExposure).toMatchObject({
        ok: false,
        stages: [{ failureCode: "sdk_init_timeout_no_tools_empty_tools_name_mismatch" }],
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
});

function fakeOrchestrator(): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: new Date(0).toISOString(),
        counts: { running: 0, retrying: 0, paused: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    getIssueDetails() {
      return null;
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
