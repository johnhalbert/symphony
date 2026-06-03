import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replayRunSessionState } from "../src/app/RunReplayProjection.js";
import type { AgentCommandPolicyDecision } from "../src/core/harness/AgentCommandPolicy.js";
import {
  emptyCommandPolicyReplayState,
  FileRunTranscriptStore,
  type PersistedCommandPolicyReplayState,
  type RunRecord,
  type TranscriptEvent,
} from "../src/core/persistence/RunTranscriptStore.js";
import type {
  RunActivityCommandPolicyDecisionPayload,
  RunCommandPolicyDecisionActivityEvent,
} from "../src/core/runActivity/RunActivityEvent.js";
import {
  mapRunActivityEventToTranscriptEvent,
  RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX,
} from "../src/core/transcript/RunActivityEventMapper.js";
import { agentCommandPolicyAuditPayload, allowPolicyDecision, denyPolicyDecision } from "./agent-command-policy-fixtures.js";

const RUN_ID = "run-command-policy-replay";
const ISSUE_ID = "issue-command-policy-replay";

interface PolicyEvidence {
  role: string;
  phase: string;
  surface: string;
  outcome: "allow" | "deny";
  reasonKind: string;
  commandClass: string;
  upstreamContactAttempted: boolean;
}

describe("command policy transcript replay and persistence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-command-policy-replay-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists accepted, denied, and fail-closed policy decisions and reconstructs them on restart/replay", async () => {
    const store = new FileRunTranscriptStore(root);
    await startRun(store);

    const policyEvents = [
      commandPolicyTranscriptEvent(
        allowPolicyDecision({
          decisionId: "decision-allow-local-status",
          attemptId: "attempt-local-status",
          reasonKind: "local_only_inspection",
          commandClass: "local_git_inspection",
          message: "Allowed helper-free local Git inspection command.",
          audit: agentCommandPolicyAuditPayload({
            surface: "terminal_execute",
            role: "worker",
            phase: "implementation",
            outcome: "allow",
            reasonKind: "local_only_inspection",
            commandClass: "local_git_inspection",
            rawInputPreview: "git status --short",
            commandPreview: "git status --short",
            gitSubcommand: "status",
            targetHosts: [],
            upstreamContactAttempted: false,
          }),
        }),
        1,
        { selectedOptionId: "allow_once", permissionOutcome: "allow_once" },
      ),
      commandPolicyTranscriptEvent(
        denyPolicyDecision({
          decisionId: "decision-deny-upstream-push",
          attemptId: "attempt-upstream-push",
          commandClass: "direct_upstream_git_operation",
          reasonKind: "upstream_github",
          message: "Blocked worker/reviewer upstream GitHub activity. Use Symphony service-owned publication, review, and writeback workflow actions instead.",
          audit: agentCommandPolicyAuditPayload({
            surface: "terminal_execute",
            role: "worker",
            phase: "implementation",
            outcome: "deny",
            reasonKind: "upstream_github",
            commandClass: "direct_upstream_git_operation",
            rawInputPreview: "git push origin HEAD",
            commandPreview: "git push origin HEAD",
            gitSubcommand: "push",
            targetHosts: ["github.com"],
            upstreamContactAttempted: false,
          }),
        }),
        2,
        { permissionOutcome: "denied", hookAction: "block" },
      ),
      commandPolicyTranscriptEvent(
        denyPolicyDecision({
          decisionId: "decision-fail-closed-classifier-error",
          attemptId: "attempt-classifier-error",
          commandClass: "ambiguous_command",
          reasonKind: "classifier_error",
          message: "Blocked worker/reviewer command because policy classification failed closed.",
          audit: agentCommandPolicyAuditPayload({
            surface: "gateway_pre_tool_call",
            role: "worker",
            phase: "implementation",
            outcome: "deny",
            reasonKind: "classifier_error",
            commandClass: "ambiguous_command",
            rawInputPreview: "[redacted policy hook payload]",
            rawInputPreviewRedacted: true,
            normalizedExecutable: null,
            executableKind: "unknown",
            gitSubcommand: null,
            commandPreview: "[redacted policy hook payload]",
            targetHosts: [],
            upstreamContactAttempted: false,
            hasNestedCommand: true,
          }),
        }),
        3,
        { requestKind: "pre_tool_call", permissionOutcome: "fail_closed", hookAction: "block" },
      ),
    ];

    for (const event of policyEvents) {
      await store.appendEvent(event);
    }

    const afterAppend = await store.getRun(RUN_ID);
    expect(policyEvidence(afterAppend?.commandPolicy)).toEqual([
      {
        role: "worker",
        phase: "implementation",
        surface: "terminal_execute",
        outcome: "allow",
        reasonKind: "local_only_inspection",
        commandClass: "local_git_inspection",
        upstreamContactAttempted: false,
      },
      {
        role: "worker",
        phase: "implementation",
        surface: "terminal_execute",
        outcome: "deny",
        reasonKind: "upstream_github",
        commandClass: "direct_upstream_git_operation",
        upstreamContactAttempted: false,
      },
      {
        role: "worker",
        phase: "implementation",
        surface: "gateway_pre_tool_call",
        outcome: "deny",
        reasonKind: "classifier_error",
        commandClass: "ambiguous_command",
        upstreamContactAttempted: false,
      },
    ]);
    expect(afterAppend?.commandPolicy).toMatchObject({
      decisionCount: 3,
      malformedEventCount: 0,
      lastDecisionAt: "2026-06-01T12:00:03.000Z",
    });

    const restarted = new FileRunTranscriptStore(root);
    const persistedEvents = (await restarted.readTranscript(RUN_ID, { offset: 0, limit: 10 })).events;
    expect(policyEvidenceFromTranscript(persistedEvents)).toEqual(policyEvidence(afterAppend?.commandPolicy));

    await restarted.updateRun(RUN_ID, { metadata: { commandPolicy: emptyCommandPolicyReplayState() } });
    const rebuilt = await restarted.rebuildRunFromTranscript(RUN_ID);
    expect(policyEvidence(rebuilt?.commandPolicy)).toEqual(policyEvidence(afterAppend?.commandPolicy));
    expect(rebuilt?.commandPolicy).toMatchObject({ decisionCount: 3, malformedEventCount: 0 });

    const replayed = replayRunSessionState(rebuilt as RunRecord, persistedEvents);
    expect(policyEvidence(replayed.commandPolicy)).toEqual(policyEvidence(afterAppend?.commandPolicy));
    expect(replayed.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "status", state: "command_policy_decision", text: expect.stringContaining("Allowed helper-free") }),
        expect.objectContaining({ kind: "status", state: "command_policy_decision", text: expect.stringContaining("Blocked worker/reviewer") }),
      ]),
    );
  });

  it("preserves ACP/gateway correlation fields and falls back to transcript run id during replay", async () => {
    const runId = "run-command-policy-correlation";
    const store = new FileRunTranscriptStore(root);
    await startRun(store, runId);

    const event = commandPolicyTranscriptEvent(
      allowPolicyDecision({
        decisionId: "decision-correlation",
        attemptId: "attempt-correlation",
        reasonKind: "local_only_inspection",
        commandClass: "local_git_inspection",
        audit: agentCommandPolicyAuditPayload({
          surface: "gateway_pre_tool_call",
          role: "worker",
          phase: "implementation",
          outcome: "allow",
          reasonKind: "local_only_inspection",
          commandClass: "local_git_inspection",
          commandPreview: "git status --short",
          gitSubcommand: "status",
          upstreamContactAttempted: false,
        }),
      }),
      1,
      {
        requestKind: "pre_tool_call",
        toolCallId: "tool-call-correlation",
        selectedOptionId: "allow_once",
        permissionOutcome: "allow_once",
        hookAction: "allow",
      },
      runId,
    );
    delete (event.payload as Record<string, unknown>).runId;

    await store.appendEvent(event);

    const afterAppend = await store.getRun(runId);
    expect(afterAppend?.commandPolicy).toMatchObject({ decisionCount: 1, malformedEventCount: 0 });
    expect(afterAppend?.commandPolicy?.decisions[0]).toMatchObject({
      decisionId: "decision-correlation",
      attemptId: "attempt-correlation",
      activityId: "command-policy:decision-correlation",
      runId,
      issueId: ISSUE_ID,
      requestKind: "pre_tool_call",
      toolCallId: "tool-call-correlation",
      selectedOptionId: "allow_once",
      permissionOutcome: "allow_once",
      hookAction: "allow",
      requiresCodeChange: false,
      requiresUserOrServiceFix: false,
      normalizedCommand: expect.objectContaining({ executable: "git", gitSubcommand: "status" }),
      audit: expect.objectContaining({ redacted: true, surface: "gateway_pre_tool_call", commandPreview: "git status --short" }),
    });

    const restarted = new FileRunTranscriptStore(root);
    const rebuilt = await restarted.rebuildRunFromTranscript(runId);
    const replayed = replayRunSessionState(rebuilt as RunRecord, (await restarted.readTranscript(runId)).events);
    expect(rebuilt?.commandPolicy?.decisions[0]).toMatchObject({ runId, requestKind: "pre_tool_call", hookAction: "allow" });
    expect(replayed.commandPolicy.decisions[0]).toMatchObject({ runId, requestKind: "pre_tool_call", hookAction: "allow" });
  });

  it("keeps distinct command-policy decisions that share an agent attempt but have separate activity ids", async () => {
    const runId = "run-command-policy-shared-attempt";
    const store = new FileRunTranscriptStore(root);
    await startRun(store, runId);

    const allowEvent = commandPolicyTranscriptEvent(
      allowPolicyDecision({
        decisionId: null,
        attemptId: "shared-tool-call-attempt",
        reasonKind: "local_only_inspection",
        commandClass: "local_git_inspection",
        audit: agentCommandPolicyAuditPayload({
          outcome: "allow",
          reasonKind: "local_only_inspection",
          commandClass: "local_git_inspection",
          gitSubcommand: "status",
          upstreamContactAttempted: false,
        }),
      }),
      1,
      {},
      runId,
    );
    (allowEvent.payload as Record<string, unknown>).activityId = "activity-shared-attempt-allow";

    const denyEvent = commandPolicyTranscriptEvent(
      denyPolicyDecision({
        decisionId: null,
        attemptId: "shared-tool-call-attempt",
        reasonKind: "upstream_github",
        commandClass: "direct_upstream_git_operation",
        audit: agentCommandPolicyAuditPayload({
          outcome: "deny",
          reasonKind: "upstream_github",
          commandClass: "direct_upstream_git_operation",
          gitSubcommand: "push",
          targetHosts: ["github.com"],
          upstreamContactAttempted: false,
        }),
      }),
      2,
      {},
      runId,
    );
    (denyEvent.payload as Record<string, unknown>).activityId = "activity-shared-attempt-deny";

    await store.appendEvent(allowEvent);
    await store.appendEvent(denyEvent);

    const afterAppend = await store.getRun(runId);
    expect(afterAppend?.commandPolicy).toMatchObject({ decisionCount: 2, malformedEventCount: 0 });
    expect(afterAppend?.commandPolicy?.decisions.map((decision) => decision.activityId)).toEqual([
      "activity-shared-attempt-allow",
      "activity-shared-attempt-deny",
    ]);
    expect(afterAppend?.commandPolicy?.decisions.map((decision) => decision.outcome)).toEqual(["allow", "deny"]);
  });

  it("normalizes command-policy event type variants for store reduction and replay", async () => {
    const runId = "run-command-policy-event-type-variant";
    const store = new FileRunTranscriptStore(root);
    await startRun(store, runId);

    const event = {
      ...commandPolicyTranscriptEvent(
        denyPolicyDecision({
          decisionId: "decision-variant-event-type",
          attemptId: "attempt-variant-event-type",
          reasonKind: "upstream_github",
          commandClass: "direct_upstream_git_operation",
        }),
        1,
        {},
        runId,
      ),
      eventType: "Command-Policy Decision",
    };

    await store.appendEvent(event);

    const afterAppend = await store.getRun(runId);
    expect(afterAppend?.commandPolicy).toMatchObject({ decisionCount: 1, malformedEventCount: 0 });

    await store.updateRun(runId, { metadata: { commandPolicy: emptyCommandPolicyReplayState() } });
    const rebuilt = await store.rebuildRunFromTranscript(runId);
    const replayed = replayRunSessionState(rebuilt as RunRecord, (await store.readTranscript(runId)).events);
    expect(rebuilt?.commandPolicy).toMatchObject({ decisionCount: 1, malformedEventCount: 0 });
    expect(replayed.commandPolicy).toMatchObject({ decisionCount: 1, malformedEventCount: 0 });
  });

  it("normalizes preexisting command-policy metadata on read and list", async () => {
    const runId = "run-command-policy-corrupt-metadata";
    const store = new FileRunTranscriptStore(root);
    await startRun(store, runId);
    await store.appendEvent(commandPolicyTranscriptEvent(allowPolicyDecision({ decisionId: "decision-valid-metadata" }), 1, {}, runId));

    const metaPath = path.join(root, "runs", runId, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as RunRecord;
    const validDecision = meta.commandPolicy?.decisions[0];
    if (!validDecision || !meta.commandPolicy) throw new Error("Expected command policy metadata fixture");
    meta.commandPolicy = {
      ...meta.commandPolicy,
      decisionCount: 99,
      malformedEventCount: 99,
      decisions: [
        validDecision,
        {
          ...validDecision,
          sequence: 2,
          decisionId: "decision-invalid-no-audit",
          message: "SECRET_POLICY_METADATA should be filtered",
          audit: undefined,
        } as never,
        validDecision,
      ],
      malformedEvents: [
        {
          sequence: 3,
          at: "2026-06-01T14:00:00.000Z",
          source: "harness",
          eventType: "command_policy_decision",
          payloadPresent: true,
          failureKind: "malformed_persisted_policy_data",
          safeOutcome: "allow",
          message: "SECRET_MALFORMED_METADATA should be filtered",
          redacted: true,
        } as never,
      ],
    };
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const restarted = new FileRunTranscriptStore(root);
    const normalized = await restarted.getRun(runId);
    expect(normalized?.commandPolicy).toMatchObject({ decisionCount: 1, malformedEventCount: 0 });
    expect(JSON.stringify(normalized?.commandPolicy)).not.toContain("SECRET_POLICY_METADATA");
    expect(JSON.stringify(normalized?.commandPolicy)).not.toContain("SECRET_MALFORMED_METADATA");

    const listed = (await restarted.listRuns()).find((run) => run.runId === runId);
    expect(listed?.commandPolicy).toMatchObject({ decisionCount: 1, malformedEventCount: 0 });
  });

  it("records malformed or missing persisted policy payloads as fail-safe denied audit evidence without replaying them as allows", async () => {
    const store = new FileRunTranscriptStore(root);
    await startRun(store, "run-command-policy-malformed");

    await store.appendEvent({
      runId: "run-command-policy-malformed",
      sequence: 1,
      at: "2026-06-01T13:00:00.000Z",
      source: "harness",
      eventType: "command_policy_decision",
      message: "Malformed policy payload should not become an allow decision",
      payloadSchema: `${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.command_policy_decision.v1`,
      payload: {
        kind: "command_policy_decision",
        redacted: true,
        surface: "terminal_execute",
        role: "worker",
        phase: "implementation",
        message: "SECRET_POLICY_TOKEN should not appear in malformed replay audit",
        token: "SECRET_POLICY_TOKEN",
      },
    });
    await store.appendEvent({
      runId: "run-command-policy-malformed",
      sequence: 2,
      at: "2026-06-01T13:00:01.000Z",
      source: "harness",
      eventType: "command_policy_decision",
      message: "Missing policy payload should fail closed",
      payloadSchema: `${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.command_policy_decision.v1`,
    });

    const afterAppend = await store.getRun("run-command-policy-malformed");
    expect(afterAppend?.commandPolicy).toMatchObject({
      decisionCount: 0,
      malformedEventCount: 2,
      lastMalformedAt: "2026-06-01T13:00:01.000Z",
      malformedEvents: [
        expect.objectContaining({
          sequence: 1,
          failureKind: "malformed_persisted_policy_data",
          safeOutcome: "deny",
          payloadPresent: true,
          redacted: true,
        }),
        expect.objectContaining({
          sequence: 2,
          failureKind: "malformed_persisted_policy_data",
          safeOutcome: "deny",
          payloadPresent: false,
          redacted: true,
        }),
      ],
    });
    expect(JSON.stringify(afterAppend?.commandPolicy)).not.toContain("SECRET_POLICY_TOKEN");

    const restarted = new FileRunTranscriptStore(root);
    const persistedEvents = (await restarted.readTranscript("run-command-policy-malformed", { offset: 0, limit: 10 })).events;
    await restarted.updateRun("run-command-policy-malformed", { metadata: { commandPolicy: emptyCommandPolicyReplayState() } });
    const rebuilt = await restarted.rebuildRunFromTranscript("run-command-policy-malformed");
    expect(rebuilt?.commandPolicy).toMatchObject({ decisionCount: 0, malformedEventCount: 2 });
    expect(JSON.stringify(rebuilt?.commandPolicy)).not.toContain("SECRET_POLICY_TOKEN");

    const replayed = replayRunSessionState(rebuilt as RunRecord, persistedEvents);
    expect(replayed.commandPolicy).toMatchObject({ decisionCount: 0, malformedEventCount: 2 });
    expect(replayed.commandPolicy.malformedEvents.every((event) => event.safeOutcome === "deny")).toBe(true);
  });
});

async function startRun(store: FileRunTranscriptStore, runId = RUN_ID): Promise<void> {
  await store.startRun({
    runId,
    role: "worker",
    runPhase: "implementation",
    issueId: ISSUE_ID,
    issueIdentifier: "ENG-277",
    attempt: null,
    turnNumber: 1,
    prompt: "Implement command policy transcript replay and persistence.",
    harnessId: "hermes_acp",
    workspaceKey: "ENG-277",
    workspacePath: "/tmp/workspace",
  });
}

function commandPolicyTranscriptEvent(
  decision: AgentCommandPolicyDecision,
  sequence: number,
  payloadOverrides: Partial<RunActivityCommandPolicyDecisionPayload> = {},
  runId = RUN_ID,
): TranscriptEvent {
  return mapRunActivityEventToTranscriptEvent(commandPolicyActivity(decision, sequence, payloadOverrides, runId), {
    runId,
    source: "harness",
  });
}

function commandPolicyActivity(
  decision: AgentCommandPolicyDecision,
  sequence: number,
  payloadOverrides: Partial<RunActivityCommandPolicyDecisionPayload>,
  runId = RUN_ID,
): RunCommandPolicyDecisionActivityEvent {
  const payload = commandPolicyPayload(decision, {
    runId,
    issueId: ISSUE_ID,
    requestKind: decision.audit.surface,
    toolCallId: decision.attemptId ?? null,
    ...payloadOverrides,
  });
  return {
    eventId: `command-policy:${decision.decisionId ?? decision.attemptId ?? sequence}`,
    runSessionId: `${runId}:policy-session`,
    occurredAt: `2026-06-01T12:00:0${sequence}.000Z`,
    sequence,
    sequenceSource: "symphony",
    protocol: "symphony",
    harness: "hermes-command-policy",
    actor: "harness",
    channel: "diagnostic",
    kind: "command_policy_decision",
    text: payload.message,
    payload,
  };
}

function commandPolicyPayload(
  decision: AgentCommandPolicyDecision,
  overrides: Partial<RunActivityCommandPolicyDecisionPayload> = {},
): RunActivityCommandPolicyDecisionPayload {
  const base = {
    redacted: true,
    decisionId: decision.decisionId ?? null,
    attemptId: decision.attemptId ?? null,
    surface: decision.audit.surface,
    role: decision.audit.role,
    phase: decision.audit.phase,
    outcome: decision.outcome,
    reasonKind: decision.reasonKind,
    commandClass: decision.commandClass,
    message: decision.message,
    upstreamContactAttempted: decision.audit.upstreamContactAttempted,
    ...(decision.requiresCodeChange === undefined ? {} : { requiresCodeChange: decision.requiresCodeChange }),
    ...(decision.requiresUserOrServiceFix === undefined ? {} : { requiresUserOrServiceFix: decision.requiresUserOrServiceFix }),
    ...(decision.normalizedCommand === undefined ? {} : { normalizedCommand: decision.normalizedCommand }),
    audit: decision.audit,
  } satisfies RunActivityCommandPolicyDecisionPayload;
  return { ...base, ...overrides } as RunActivityCommandPolicyDecisionPayload;
}

function policyEvidence(state: PersistedCommandPolicyReplayState | undefined): PolicyEvidence[] {
  return (state?.decisions ?? []).map(({ role, phase, surface, outcome, reasonKind, commandClass, upstreamContactAttempted }) => ({
    role,
    phase,
    surface,
    outcome,
    reasonKind,
    commandClass,
    upstreamContactAttempted,
  }));
}

function policyEvidenceFromTranscript(events: TranscriptEvent[]): PolicyEvidence[] {
  return events
    .filter((event) => event.eventType === "command_policy_decision")
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return {
        role: payload.role as string,
        phase: payload.phase as string,
        surface: payload.surface as string,
        outcome: payload.outcome as "allow" | "deny",
        reasonKind: payload.reasonKind as string,
        commandClass: payload.commandClass as string,
        upstreamContactAttempted: payload.upstreamContactAttempted as boolean,
      };
    });
}
