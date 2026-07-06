import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectWebHistory } from "../src/app/WebHistoryProjection.js";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import { approvalMatchesReport, isAwaitingPublicationApprovalLifecycle, pendingPublicationReport } from "../src/core/CompletionReportService.js";
import { FileOperatorApprovalStore } from "../src/core/approval/OperatorApprovalService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { DEFAULT_ORCHESTRATOR_CONVERSATION_ID, FileOrchestratorConversationStore } from "../src/core/persistence/OrchestratorConversationStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { generateLargeHistoryFixture } from "../scripts/generate-large-history-fixture.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("generateLargeHistoryFixture", () => {
  it("writes a deterministic large-history state tree that existing stores and web projection can read", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "large-history-fixture-state");

    const manifest = await generateLargeHistoryFixture({
      outputDir: stateDir,
      issueCount: 6,
      runsPerIssue: 4,
      eventsPerRun: 8,
      writebacksPerIssue: 5,
      baseTimestamp: "2026-02-03T04:05:06.000Z",
      issuePrefix: "LH",
    });

    expect(manifest.stateDir).toBe(stateDir);
    expect(manifest.counts).toEqual({
      issues: 6,
      workspaces: 6,
      lifecycleRecords: 6,
      runs: 24,
      transcriptEvents: 192,
      approvalRequests: 6,
      writebackOperations: 30,
      orchestratorMessages: 72,
    });
    expect(manifest.issues[0]).toMatchObject({
      id: "fixture-issue-0001",
      identifier: "LH-0001",
      workspaceKey: "LH-0001",
      runIds: ["fixture-run-0001-01", "fixture-run-0001-02", "fixture-run-0001-03", "fixture-run-0001-04"],
    });
    expect(manifest.apiHints.orchestratorChatEndpointTemplate).toBe("/api/v1/web/orchestrator-chat?conversationId={conversationId}");

    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const orchestratorConversationStore = new FileOrchestratorConversationStore(stateDir);
    const writebackStore = new FileWritebackOutboxStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);

    const runs = await runStore.listRuns();
    expect(runs).toHaveLength(24);
    expect(new Set(runs.map((run) => run.status))).toEqual(new Set(["running", "failed", "cancelled", "succeeded"]));
    expect(await runStore.findWorkspace("LH-0001")).toMatchObject({
      workspaceKey: "LH-0001",
      issueId: "fixture-issue-0001",
      gitBranchName: "fixture/lh-0001",
    });
    expect(await runStore.listRunsForIssue("LH-0001")).toHaveLength(4);
    expect(await runStore.listRunsForIssue("fixture-issue-0001")).toHaveLength(4);

    const transcriptPage = await runStore.readTranscript("fixture-run-0001-01", { offset: 0, limit: 2 });
    expect(await runStore.readTranscriptEventCount("fixture-run-0001-01")).toBe(8);
    expect(transcriptPage.nextOffset).toBe(2);
    expect(transcriptPage.events.map((event) => event.sequence)).toEqual([1, 2]);
    const transcriptTail = await runStore.readTranscriptTail("fixture-run-0001-01", { limit: 3 });
    expect(transcriptTail.offset).toBe(5);
    expect(transcriptTail.events.map((event) => event.sequence)).toEqual([6, 7, 8]);
    expect(await runStore.getRun("fixture-run-0001-02")).toMatchObject({
      activitySnapshot: {
        lastHarnessActivityAt: expect.any(String),
      },
    });

    const orchestratorConversation = await orchestratorConversationStore.getConversation(DEFAULT_ORCHESTRATOR_CONVERSATION_ID);
    expect(orchestratorConversation).toMatchObject({
      conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
      status: "completed",
      metadata: { source: "large_history_fixture", issueCount: 6, runsPerIssue: 4 },
    });
    const orchestratorMessages = await orchestratorConversationStore.listMessages(DEFAULT_ORCHESTRATOR_CONVERSATION_ID);
    expect(orchestratorMessages).toHaveLength(manifest.counts.orchestratorMessages);
    expect(orchestratorMessages[0]).toMatchObject({
      role: "user",
      metadata: { issueIdentifier: "LH-0001", runId: "fixture-run-0001-01", historyIndex: 1, messageKind: "prompt" },
    });
    expect(orchestratorMessages[1]).toMatchObject({
      role: "assistant",
      transcriptLinks: [{ runId: "fixture-run-0001-01", sequence: 1, eventType: "user_prompt" }],
    });
    expect(orchestratorMessages.at(-1)).toMatchObject({
      role: "server",
      metadata: { issueIdentifier: "LH-0006", runId: "fixture-run-0006-04", messageKind: "status" },
    });

    const lifecycles = await lifecycleStore.list();
    expect(lifecycles).toHaveLength(6);
    expect(new Set(lifecycles.map((record) => record.phase))).toEqual(
      new Set(["implementation", "review", "passed", "blocked", "terminal", "merge_conflict_resolution"]),
    );
    const lifecycleByIdentifier = await lifecycleStore.get("LH-0003");
    expect(lifecycleByIdentifier).toMatchObject({
      issueId: "fixture-issue-0003",
      issueIdentifier: "LH-0003",
      phase: "passed",
      handoff: { version: 1 },
      summaryPointers: { workspaceKey: "LH-0003", branchName: "fixture/lh-0003" },
    });

    const approvals = await approvalStore.list();
    expect(approvals).toHaveLength(6);
    expect(new Set(approvals.map((record) => record.status))).toEqual(
      new Set(["pending", "approved", "rejected", "cancelled", "stale", "expired"]),
    );
    const pendingApproval = await approvalStore.findPendingForIssue(["LH-0004", "fixture-issue-0004"]);
    expect(pendingApproval).toMatchObject({
      status: "pending",
      issueId: "fixture-issue-0004",
      issueIdentifier: "LH-0004",
    });
    const pendingRun = pendingApproval ? await runStore.getRun(pendingApproval.runId) : null;
    expect(pendingApproval ? await approvalStore.findPendingForRun(pendingApproval.runId) : null).toMatchObject({
      requestId: pendingApproval?.requestId,
    });
    expect(pendingRun).toMatchObject({
      pendingApprovalRequestId: pendingApproval?.requestId,
      pendingApprovalRequestedAt: pendingApproval?.requestedAt,
    });
    const pendingLifecycle = await lifecycleStore.get("LH-0004");
    expect(pendingLifecycle).not.toBeNull();
    if (!pendingLifecycle) throw new Error("expected pending approval lifecycle fixture");
    expect(isAwaitingPublicationApprovalLifecycle(pendingLifecycle)).toBe(true);
    const pendingReport = pendingPublicationReport(pendingLifecycle);
    expect(pendingReport).not.toBeNull();
    expect(pendingReport?.writebackOperationKeys).toEqual([]);
    expect(pendingApproval && pendingReport ? approvalMatchesReport(pendingApproval, pendingReport) : false).toBe(true);

    const writebacks = await writebackStore.list();
    expect(writebacks).toHaveLength(30);
    expect(new Set(writebacks.map((operation) => operation.status))).toEqual(
      new Set(["pending", "succeeded", "skipped", "retrying", "dead_letter"]),
    );
    expect(await writebackStore.get("fixture:LH-0001:writeback:02")).toMatchObject({
      kind: "comment",
      status: "succeeded",
      issueId: "fixture-issue-0001",
    });

    const history = projectWebHistory(runs);
    expect(history.sessions).toHaveLength(24);
    expect(history.defaultSessionId).not.toBe("");
    expect(history.sessions.some((session) => session.runSession.runtime.agentLifecycle === "reuse_by_issue")).toBe(true);
    expect(history.sessions.some((session) => session.runSession.approval.pendingRequestId === pendingApproval?.requestId)).toBe(true);
  });

  it("generates diagnostic, token, limit, approval, and oversized-reference scenarios through existing projections", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "large-history-fixture-scenarios");

    await generateLargeHistoryFixture({
      outputDir: stateDir,
      issueCount: 6,
      runsPerIssue: 4,
      eventsPerRun: 14,
      writebacksPerIssue: 2,
      baseTimestamp: "2026-03-04T05:06:07.000Z",
      issuePrefix: "TR",
    });

    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const run = await runStore.getRun("fixture-run-0001-01");
    expect(run).not.toBeNull();

    const transcriptPage = await runStore.readTranscript("fixture-run-0001-01", { offset: 0, limit: 14 });
    const eventTypes = new Set(transcriptPage.events.map((event) => event.eventType));
    for (const eventType of [
      "user_prompt",
      "run_status",
      "tokens",
      "run_diagnostic",
      "rate_limits",
      "provider_limit",
      "assistant_delta",
      "assistant_complete",
      "tool_call",
      "progress",
    ]) {
      expect(eventTypes.has(eventType)).toBe(true);
    }

    const diagnostic = transcriptPage.events.find((event) => event.eventType === "run_diagnostic");
    const diagnosticPayload = asRecord(diagnostic?.payload);
    const nestedDiagnosticPayload = asRecord(diagnosticPayload.payload);
    expect(String(nestedDiagnosticPayload.oversizedContextPreview)).toContain("[truncated]");
    expect(asRecord(nestedDiagnosticPayload.redactionProbe).apiToken).toBe("[redacted]");

    const providerLimit = asRecord(transcriptPage.events.find((event) => event.eventType === "provider_limit")?.payload);
    expect(asRecord(providerLimit.signal).kind).toBe("windowed_bucket_exhausted");
    const tokens = asRecord(transcriptPage.events.find((event) => event.eventType === "tokens")?.payload);
    expect(asRecord(tokens.tokens).totalTokens).toBe(run?.tokens.totalTokens);

    const messages = projectWebTranscript(transcriptPage.events, { run });
    expect(messages.some((message) => message.kind === "assistant" && message.text.includes("complete response"))).toBe(true);
    expect(messages.some((message) => message.kind === "tool_call" && message.name === "search_files")).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: "status",
        state: "tokens",
        text: `Tokens: input ${run?.tokens.inputTokens} · output ${run?.tokens.outputTokens} · total ${run?.tokens.totalTokens} · Project context: Default`,
      }),
    );

    await expectTerminalEvent(runStore, "fixture-run-0001-02", "completed");
    await expectTerminalEvent(runStore, "fixture-run-0003-04", "cancelled");
    await expectTerminalEvent(runStore, "fixture-run-0005-04", "failed");

    const lifecycle = await lifecycleStore.get("TR-0004");
    const oversizedReference = lifecycle?.summaryReferences.find((reference) => reference.id.includes("oversized"));
    expect(oversizedReference?.summary.length).toBeGreaterThan(5_000);
    expect(oversizedReference?.transcriptPointers.some((pointer) => pointer.length > 4_000)).toBe(true);
  });

  it("supports empty transcript/writeback boundaries without omitting durable run and lifecycle records", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "large-history-fixture-boundary");

    const manifest = await generateLargeHistoryFixture({
      outputDir: stateDir,
      issueCount: 1,
      runsPerIssue: 1,
      eventsPerRun: 0,
      writebacksPerIssue: 0,
      issuePrefix: "BD",
    });

    expect(manifest.counts).toMatchObject({ issues: 1, runs: 1, transcriptEvents: 0, writebackOperations: 0 });
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const writebackStore = new FileWritebackOutboxStore(stateDir);
    expect(await runStore.readTranscriptEventCount("fixture-run-0001-01")).toBe(0);
    expect((await runStore.readTranscript("fixture-run-0001-01", { offset: 0, limit: 10 })).events).toEqual([]);
    expect(await lifecycleStore.get("BD-0001")).toMatchObject({ issueIdentifier: "BD-0001" });
    expect(await writebackStore.list()).toEqual([]);
  });

  it("refuses accidental overwrites and only force-replaces safe fixture-looking directories by default", async () => {
    const root = await makeTempRoot();
    const safeStateDir = path.join(root, "safe-large-history-fixture");
    await generateLargeHistoryFixture({ outputDir: safeStateDir, issueCount: 1, runsPerIssue: 1, eventsPerRun: 1 });
    await fs.writeFile(path.join(safeStateDir, "stale-marker.txt"), "stale", "utf8");

    await expect(
      generateLargeHistoryFixture({ outputDir: safeStateDir, issueCount: 1, runsPerIssue: 1, eventsPerRun: 1 }),
    ).rejects.toThrow("Output directory is not empty");

    await generateLargeHistoryFixture({
      outputDir: safeStateDir,
      issueCount: 1,
      runsPerIssue: 1,
      eventsPerRun: 1,
      force: true,
    });
    await expect(fs.access(path.join(safeStateDir, "stale-marker.txt"))).rejects.toThrow();

    const nonFixtureDir = path.join(root, "state");
    await fs.mkdir(nonFixtureDir, { recursive: true });
    await fs.writeFile(path.join(nonFixtureDir, "data.txt"), "important", "utf8");
    await expect(
      generateLargeHistoryFixture({ outputDir: nonFixtureDir, issueCount: 1, runsPerIssue: 1, eventsPerRun: 1, force: true }),
    ).rejects.toThrow("Refusing to force-remove non-fixture-looking path");

    await generateLargeHistoryFixture({
      outputDir: nonFixtureDir,
      issueCount: 1,
      runsPerIssue: 1,
      eventsPerRun: 1,
      force: true,
      allowDestructiveOverwrite: true,
    });
    expect((await new FileRunTranscriptStore(nonFixtureDir).listRuns())).toHaveLength(1);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-large-history-fixture-"));
  tempRoots.push(root);
  return root;
}

async function expectTerminalEvent(runStore: FileRunTranscriptStore, runId: string, eventType: string): Promise<void> {
  const tail = await runStore.readTranscriptTail(runId, { limit: 1 });
  expect(tail.events.at(-1)?.eventType).toBe(eventType);
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}
