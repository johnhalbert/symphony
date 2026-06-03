import { describe, expect, it } from "vitest";
import { projectWebHistory } from "../src/app/WebHistoryProjection.js";
import type { RunRecord } from "../src/core/persistence/RunTranscriptStore.js";

type TestRunRecord = RunRecord & { runtimeModel?: string | null; issueTitle?: string | null };

describe("projectWebHistory", () => {
  it("sorts sessions by updatedAt descending then runId and uses runId as the session id", () => {
    const model = projectWebHistory([
      run({ runId: "run-c", sessionId: "session-c", issueIdentifier: "TEST-3", updatedAt: "2026-01-01T00:00:01.000Z" }),
      run({
        runId: "run-b",
        sessionId: "session-b",
        issueIdentifier: "TEST-2",
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
      run({
        runId: "run-a",
        sessionId: "session-a",
        issueIdentifier: "TEST-1",
        issueTitle: "Build web history",
        runtimeModel: "runtime-model",
        cursorModel: "cursor-model",
        transcriptEventCount: 7,
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    ]);

    expect(model.sessions.map((session) => session.id)).toEqual(["run-a", "run-b", "run-c"]);
    expect(model.defaultSessionId).toBe("run-a");
    expect(model.sessions[0]).toMatchObject({
      id: "run-a",
      issue: "TEST-1",
      title: "TEST-1: Build web history",
      model: "runtime-model",
      msgCount: 7,
      toolCount: 0,
      runSession: {
        runId: "run-a",
        sessionId: "session-a",
        runPhase: "implementation",
        runKind: "implementation",
        runtime: { model: "runtime-model" },
        cursor: { model: "cursor-model" },
        transcriptEventCount: 7,
      },
    });
  });

  it("projects durable run-session metadata and redacts public diagnostics", () => {
    const sourceRun = run({
      runId: "run-secure",
      sessionId: "session-secure",
      agentId: "agent-secure",
      role: "reviewer",
      runPhase: "issue_breakdown",
      attempt: 2,
      turnNumber: 3,
      harnessId: "hermes",
      runtimeModel: "gpt-runtime",
      runtimeModelParams: [
        { id: "context", value: "272k" },
        { id: "apiKey", value: "SECRET_MODEL_PARAM" },
        { id: "SECRET_PARAM_ID", value: "SECRET_RAW_ID_VALUE" },
      ],
      runtimeSettingSources: ["template:worker", "token=SECRET_SOURCE"],
      runtimeMode: "cli",
      runtimeAllowLargeContext: true,
      runtimeAgentLifecycle: "fresh_per_run",
      cursorModel: "gpt-cursor",
      cursorModelParams: [{ id: "reasoning", value: "high" }],
      cursorSettingSources: ["config:cursor"],
      cursorMode: "chat",
      cursorAllowLargeContext: false,
      cursorWorkerAgentLifecycle: "reuse",
      workspaceKey: "TEST-1",
      workspacePath: "/workspace/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
      gitBranchName: "symphony/TEST-1",
      status: "failed",
      completedAt: "2026-01-01T00:10:00.000Z",
      error: "failed with password=SECRET_ERROR",
      tokens: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
      transcriptEventCount: 9,
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      prHeadSha: "head-sha",
      prBranch: "symphony/TEST-1",
      ciStatus: "failed",
      lastPushedAt: "2026-01-01T00:09:00.000Z",
      lastEvidenceCursor: "cursor-7",
      pendingApprovalRequestId: "approval-1",
      pendingApprovalRequestedAt: "2026-01-01T00:08:00.000Z",
      cancellationRequestedAt: "2026-01-01T00:07:00.000Z",
      cancellationSource: "operator",
      cancellationReason: "operator supplied api_key=SECRET_CANCEL",
      cancellationOutcome: "cancel_ignored",
      harnessStopRequestedAt: "2026-01-01T00:07:01.000Z",
      harnessStopFailedAt: "2026-01-01T00:07:02.000Z",
      harnessStopFailedReason: "Bearer SECRET_HARNESS",
      cancelFailed: true,
      cancelFailedAt: "2026-01-01T00:07:03.000Z",
      cancelFailedReason: "cancel failed token=SECRET_CANCEL_FAILED",
      cancelFailedSource: "cancel_ignored",
      failureKind: "cursor_sdk_terminal_error",
      failureDiagnosticCode: "cursor_run_wait_terminal_error",
      failureDiagnosticMessage: "diagnostic password=SECRET_DIAGNOSTIC",
      failureDiagnosticAt: "2026-01-01T00:06:00.000Z",
      providerLimit: {
        scope: {
          harnessId: "hermes",
          providerId: "openai-codex",
          model: "gpt-5.5",
          accountScopeKey: "acct-secret-key",
        },
        kind: "windowed_bucket_exhausted",
        message: "Provider limit reached token=SECRET_PROVIDER_LIMIT",
        observedAt: "2026-01-01T00:05:00.000Z",
        resumePolicy: "auto_at_window_close",
        window: {
          resumeAt: "2026-01-01T05:00:00.000Z",
          retryAfterMs: 18_000_000,
          windowLabel: "5h bucket",
          windowKind: "codex_5h",
        },
        source: {
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          runId: "run-secure",
          sessionId: "session-secure",
          role: "reviewer",
          runPhase: "issue_breakdown",
        },
        raw: { authorization: "Bearer SECRET_PROVIDER_RAW" },
      },
    });
    delete sourceRun.runKind;

    const model = projectWebHistory([sourceRun]);

    const session = model.sessions[0]!;
    expect(session.runSession).toMatchObject({
      runId: "run-secure",
      sessionId: "session-secure",
      agentId: "agent-secure",
      role: "reviewer",
      runPhase: "issue_breakdown",
      runKind: "planning",
      attempt: 2,
      turnNumber: 3,
      harnessId: "hermes",
      status: "failed",
      completedAt: "2026-01-01T00:10:00.000Z",
      transcriptEventCount: 9,
      tokens: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
      runtime: {
        model: "gpt-runtime",
        modelParams: [
          { id: "context", value: "272k" },
          { id: "apiKey", value: "[redacted]" },
          { id: "[redacted]", value: "[redacted]" },
        ],
        settingSources: ["template:worker", "token=[redacted]"],
        mode: "cli",
        allowLargeContext: true,
        agentLifecycle: "fresh_per_run",
      },
      cursor: {
        model: "gpt-cursor",
        modelParams: [{ id: "reasoning", value: "high" }],
        settingSources: ["config:cursor"],
        mode: "chat",
        allowLargeContext: false,
        workerAgentLifecycle: "reuse",
      },
      workspace: { key: "TEST-1", path: "/workspace/TEST-1", repoPath: "/repo", baseRef: "main", branch: "symphony/TEST-1" },
      pullRequest: {
        url: "https://github.com/acme/repo/pull/7",
        number: 7,
        headSha: "head-sha",
        branch: "symphony/TEST-1",
        ciStatus: "failed",
        lastPushedAt: "2026-01-01T00:09:00.000Z",
        lastEvidenceCursor: "cursor-7",
      },
      approval: { pendingRequestId: "approval-1", requestedAt: "2026-01-01T00:08:00.000Z" },
      cancellation: {
        requestedAt: "2026-01-01T00:07:00.000Z",
        source: "operator",
        reason: "operator supplied api_key=[redacted]",
        outcome: "cancel_ignored",
        harnessStopRequestedAt: "2026-01-01T00:07:01.000Z",
        harnessStopFailedAt: "2026-01-01T00:07:02.000Z",
        harnessStopFailedReason: "Bearer [redacted]",
        cancelFailed: true,
        cancelFailedAt: "2026-01-01T00:07:03.000Z",
        cancelFailedReason: "cancel failed token=[redacted]",
        cancelFailedSource: "cancel_ignored",
      },
      failure: {
        kind: "cursor_sdk_terminal_error",
        diagnosticCode: "cursor_run_wait_terminal_error",
        diagnosticMessage: "diagnostic password=[redacted]",
        diagnosticAt: "2026-01-01T00:06:00.000Z",
      },
      providerLimit: {
        provider: "openai-codex",
        providerId: "openai-codex",
        harnessId: "hermes",
        model: "gpt-5.5",
        kind: "windowed_bucket_exhausted",
        message: "Provider limit reached token=[redacted]",
        observedAt: "2026-01-01T00:05:00.000Z",
        resumePolicy: "auto_at_window_close",
        window: {
          resumeAt: "2026-01-01T05:00:00.000Z",
          retryAfterMs: 18_000_000,
          windowLabel: "5h bucket",
          windowKind: "codex_5h",
        },
        source: {
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          runId: "run-secure",
          sessionId: "session-secure",
          role: "reviewer",
          runPhase: "issue_breakdown",
        },
      },
      links: {
        issue: "/api/v1/web/issues/TEST-1",
        run: "/api/v1/runs/run-secure",
        transcript: "/api/v1/web/sessions/run-secure/transcript",
      },
    });
    expect(session.runSession).not.toHaveProperty("prompt");
    expect(JSON.stringify(session.runSession)).not.toContain("SECRET_");
  });

  it("maps persisted run statuses into web session states", () => {
    const model = projectWebHistory([
      run({ runId: "run-running", status: "running" }),
      run({ runId: "run-succeeded", status: "succeeded" }),
      run({ runId: "run-failed", status: "failed" }),
      run({ runId: "run-cancelled", status: "cancelled" }),
    ]);

    expect(Object.fromEntries(model.sessions.map((session) => [session.id, session.state]))).toMatchObject({
      "run-running": "running",
      "run-succeeded": "finished",
      "run-failed": "error",
      "run-cancelled": "cancelled",
    });
  });

  it("returns the empty default history when no run store data is available", () => {
    expect(projectWebHistory([], [])).toEqual({
      sessions: [],
      transcriptBySession: {},
      timeline: [],
      defaultSessionId: "",
    });
  });

  it("keeps durable-only run sessions honest when optional history metadata is absent", () => {
    const model = projectWebHistory([
      run({
        runId: "run-durable-only",
        sessionId: null,
        agentId: null,
        issueIdentifier: "TEST-DURABLE",
        issueTitle: null,
        runtimeModel: null,
        cursorModel: null,
        runtimeModelParams: [],
        runtimeSettingSources: [],
        cursorModelParams: [],
        cursorSettingSources: [],
        workspaceKey: "TEST-DURABLE",
        workspacePath: "",
        repoPath: null,
        baseRef: null,
        gitBranchName: null,
        status: "succeeded",
      }),
    ]);

    expect(model.defaultSessionId).toBe("run-durable-only");
    expect(model.transcriptBySession).toEqual({});
    expect(model.timeline).toEqual([]);
    expect(model.sessions[0]).toMatchObject({
      id: "run-durable-only",
      issue: "TEST-DURABLE",
      title: "TEST-DURABLE",
      state: "finished",
      model: "",
      msgCount: 0,
      lastEvent: "TEST-DURABLE finished",
      toolCount: 0,
      runSession: {
        runId: "run-durable-only",
        sessionId: null,
        agentId: null,
        status: "succeeded",
        transcriptEventCount: 0,
        runtime: { model: null, modelParams: [], settingSources: [], mode: null, allowLargeContext: null, agentLifecycle: null },
        cursor: { model: null, modelParams: [], settingSources: [], mode: null, allowLargeContext: null, workerAgentLifecycle: null },
        workspace: { key: "TEST-DURABLE", path: "", repoPath: null, baseRef: null, branch: null },
        pullRequest: { url: null, number: null, headSha: null, branch: null, ciStatus: null, lastPushedAt: null, lastEvidenceCursor: null },
        approval: { pendingRequestId: null, requestedAt: null },
        cancellation: {
          requestedAt: null,
          source: null,
          reason: null,
          outcome: null,
          harnessStopRequestedAt: null,
          harnessStopFailedAt: null,
          harnessStopFailedReason: null,
          cancelFailed: false,
          cancelFailedAt: null,
          cancelFailedReason: null,
          cancelFailedSource: null,
        },
        failure: { kind: null, diagnosticCode: null, diagnosticMessage: null, diagnosticAt: null },
        providerLimit: null,
      },
    });
    expect(JSON.stringify(model).toLowerCase()).not.toContain("mock");
  });

  it("maps activity items into a deterministic status timeline without mock entries", () => {
    const model = projectWebHistory(
      [run({ runId: "run-a", issueIdentifier: "TEST-1" }), run({ runId: "run-b", issueIdentifier: "TEST-2" })],
      [
        activity({ id: "later", at: "2026-01-01T00:00:02.000Z", runId: "run-b", issueIdentifier: "TEST-2" }),
        activity({ id: "same-b", at: "2026-01-01T00:00:01.000Z", runId: "run-b", issueIdentifier: "TEST-2" }),
        activity({ id: "same-a", at: "2026-01-01T00:00:01.000Z", runId: "run-a", issueIdentifier: "TEST-1" }),
      ],
    );

    expect(model.timeline).toEqual([
      { t: "2026-01-01T00:00:02.000Z", sess: "run-b", kind: "status", text: "TEST-2 run started", state: "running" },
      { t: "2026-01-01T00:00:01.000Z", sess: "run-a", kind: "status", text: "TEST-1 run started", state: "running" },
      { t: "2026-01-01T00:00:01.000Z", sess: "run-b", kind: "status", text: "TEST-2 run started", state: "running" },
    ]);
    expect(model.timeline.map((event) => event.text).join("\n")).not.toContain("mock");
  });

  it("does not use stale Cursor fields as the session model for explicit Hermes ACP runs", () => {
    const hermesAcpHistory = projectWebHistory([
      run({
        harnessId: "hermes_acp",
        runtimeModel: null,
        runtimeModelParams: [],
        runtimeSettingSources: ["host_hermes:PATH:hermes"],
        runtimeMode: null,
        cursorModel: "stale-cursor-model",
        cursorMode: "agent",
      }),
    ]);

    expect(hermesAcpHistory.sessions[0]).toMatchObject({
      model: "",
      runSession: {
        harnessId: "hermes_acp",
        runtime: { model: null, mode: null },
        cursor: { model: "stale-cursor-model", mode: "agent" },
      },
    });

    const cursorHistory = projectWebHistory([run({ harnessId: "cursor", cursorModel: "cursor-model" })]);
    expect(cursorHistory.sessions[0]?.model).toBe("cursor-model");
  });
});

function run(overrides: Partial<TestRunRecord> = {}): TestRunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "Implement the requested change",
    cursorModel: null,
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/TEST-1",
    gitBranchName: "symphony/TEST-1",
    repoPath: "/repo",
    baseRef: "main",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    transcriptEventCount: 0,
    ...overrides,
  };
}

function activity(input: { id: string; at: string; runId: string; issueIdentifier: string }) {
  return {
    id: input.id,
    at: input.at,
    kind: "run_started",
    issue: { id: input.issueIdentifier.toLowerCase(), identifier: input.issueIdentifier },
    run: { runId: input.runId, status: "running" as const },
    transcript: null,
    writeback: null,
  };
}
