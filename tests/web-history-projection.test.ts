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
    });
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
