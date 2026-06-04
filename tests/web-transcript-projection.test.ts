import { describe, expect, it } from "vitest";
import {
  emptyWebTranscriptProjectionPayload,
  projectWebTranscript,
  projectWebTranscriptWindow,
} from "../src/app/WebTranscriptProjection.js";
import type { RunRecord, TranscriptEvent, TranscriptPage } from "../src/core/persistence/RunTranscriptStore.js";

describe("projectWebTranscript", () => {
  it("maps sanitized Cursor transcript preview payloads into public web transcript messages", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "tool_call",
        source: "cursor",
        message: "tool shell completed",
        payload: {
          kind: "tool_call",
          callId: "call-1",
          name: "shell",
          status: "completed",
          argumentsPreview: 'command="npm test" token=[redacted]',
          resultPreview: "tests passed",
          outputPreview: "stdout safe",
          errorPreview: "stderr safe",
          truncated: true,
          rawArgs: { command: "echo SECRET_TOOL_VALUE", apiKey: "SECRET_API_VALUE" },
          result: { stdout: "Bearer raw-secret-token", internalOnly: "result-only" },
          internalOnly: "payload-only",
        },
      }),
      event({
        eventType: "thinking",
        source: "cursor",
        message: "Cursor thinking event",
        payload: { kind: "thinking", summary: "actual reasoning from public summary", redacted: true },
      }),
      event({
        eventType: "assistant",
        source: "cursor",
        message: "Cursor assistant message",
        payload: { kind: "assistant", textPreview: "actual assistant text", truncated: false },
      }),
      event({ eventType: "progress", source: "harness", message: "harness response" }),
      event({
        eventType: "task",
        source: "cursor",
        message: "Cursor task event",
        payload: { kind: "task", summary: "actual task summary", redacted: true },
      }),
      event({
        eventType: "approval_request",
        source: "orchestrator",
        message: "Approval required",
        payload: {
          reason: "workflow_policy",
          prompt: "Approve publication?",
          actions: [{ label: "Approve" }, { id: "reject" }],
        },
      }),
      event({ eventType: "human_required", source: "orchestrator", message: "Human input needed" }),
      event({ eventType: "surprise_event", source: "orchestrator", message: "fallback status" }),
    ]);

    expect(messages.map((message) => message.kind)).toEqual([
      "tool_call",
      "thinking",
      "assistant",
      "assistant",
      "task",
      "request",
      "request",
      "status",
    ]);
    expect(messages[0]).toEqual({
      kind: "tool_call",
      ts: "2026-01-01T00:00:00.000Z",
      call_id: "call-1",
      name: "shell",
      status: "completed",
      args: { preview: 'command="npm test" token=[redacted]' },
      result: "tests passed",
      output: "stdout safe",
      error: "stderr safe",
      truncated: true,
    });
    expect(messages[1]).toMatchObject({ kind: "thinking", text: "actual reasoning from public summary" });
    expect(messages[2]).toMatchObject({ kind: "assistant", text: "actual assistant text" });
    expect(messages[3]).toMatchObject({ kind: "assistant", text: "harness response" });
    expect(messages[4]).toEqual({
      kind: "task",
      ts: "2026-01-01T00:00:00.000Z",
      title: "task",
      desc: "actual task summary",
    });
    expect(messages[5]).toEqual({
      kind: "request",
      ts: "2026-01-01T00:00:00.000Z",
      reason: "workflow_policy",
      q: "Approve publication?",
      actions: ["Approve", "reject"],
    });
    expect(messages[6]).toMatchObject({ kind: "request", q: "Human input needed" });
    expect(messages[7]).toEqual({
      kind: "status",
      state: "surprise_event",
      ts: "2026-01-01T00:00:00.000Z",
      text: "fallback status",
    });
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_TOOL_VALUE");
    expect(serialized).not.toContain("SECRET_API_VALUE");
    expect(serialized).not.toContain("raw-secret-token");
    expect(serialized).not.toContain("payload-only");
    expect(serialized).not.toContain("internalOnly");
    expect(serialized).not.toContain("Cursor thinking event");
    expect(serialized).not.toContain("Cursor assistant message");
    expect(serialized).not.toContain("Cursor task event");
  });

  it("projects command-policy decisions as public status details without exposing hook payloads or command secrets", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "command_policy_decision",
        source: "harness",
        message: "Blocked command containing SECRET_POLICY_MESSAGE for https://user:pass@github.com/owner/repo.git",
        payload: {
          kind: "command_policy_decision",
          redacted: true,
          decisionId: "decision-public-policy",
          surface: "terminal_execute",
          role: "worker",
          phase: "implementation",
          outcome: "deny",
          reasonKind: "upstream_github",
          commandClass: "direct_upstream_git_operation",
          message: "Blocked command containing SECRET_POLICY_MESSAGE for https://user:pass@github.com/owner/repo.git",
          upstreamContactAttempted: false,
          requiresUserOrServiceFix: true,
          requestKind: "pre_tool_call",
          permissionOutcome: "denied",
          hookAction: "block",
          commandPreview: "git push https://user:pass@github.com/owner/repo.git",
          raw: { params: { command: "git push origin HEAD", token: "SECRET_RAW_TOKEN" } },
          env: { GIT_ASKPASS: "/tmp/secret-askpass", GITHUB_TOKEN: "SECRET_ENV_TOKEN" },
          audit: {
            redacted: true,
            surface: "terminal_execute",
            role: "worker",
            phase: "implementation",
            outcome: "deny",
            reasonKind: "upstream_github",
            commandClass: "direct_upstream_git_operation",
            rawInputPreview: "GIT_ASKPASS=/tmp/secret-askpass git push origin HEAD",
            commandPreview: "git push https://user:pass@github.com/owner/repo.git",
            inlineEnvironmentKeys: ["GIT_ASKPASS"],
            unsafeConfigCategories: ["credential_helper"],
            helperPath: "/tmp/secret-credential-helper",
            upstreamContactAttempted: false,
          },
        },
      }),
    ]);

    expect(messages).toEqual([
      {
        kind: "status",
        state: "command_policy_decision",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Command policy deny: upstream_github (worker · implementation · terminal_execute)",
        policy: {
          outcome: "deny",
          reasonKind: "upstream_github",
          role: "worker",
          phase: "implementation",
          surface: "terminal_execute",
          commandClass: "direct_upstream_git_operation",
          upstreamContactAttempted: false,
          requiresUserOrServiceFix: true,
          requestKind: "pre_tool_call",
          hookAction: "block",
          permissionOutcome: "denied",
        },
      },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("git push");
    expect(serialized).not.toContain("/tmp/secret");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("raw");
    expect(serialized).not.toContain("GITHUB_TOKEN");
  });

  it("preserves persisted harness stream progress text while routing explicit progress status", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "progress",
        source: "harness",
        message: "hello from stream",
        payload: { type: "progress", activitySource: "stream", message: "hello from stream" },
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "legacy progress text",
        payload: { type: "progress", message: "legacy progress text" },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "Workspace warming",
        payload: { type: "progress", activitySource: "status", status: "warming", message: "Workspace warming" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 3,
      }),
    ]);

    expect(messages).toEqual([
      { kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "hello from stream" },
      { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "legacy progress text" },
      { kind: "status", state: "warming", ts: "2026-01-01T00:00:02.000Z", text: "Workspace warming" },
    ]);
  });

  it("coalesces Hermes runtime deltas and tool pairs while preserving public-safe run prelude messages", () => {
    const messages = projectWebTranscript(
      [
        event({
          eventType: "message_delta",
          source: "runtime",
          message: "Hermes message delta",
          payload: { textPreview: "partial assistant text" },
        }),
        event({
          eventType: "message_complete",
          source: "runtime",
          message: "Hermes message complete",
          payload: { textPreview: "final assistant text", status: "completed" },
          at: "2026-01-01T00:00:01.000Z",
          sequence: 2,
        }),
        event({
          eventType: "tool_start",
          source: "runtime",
          message: "Hermes tool terminal started",
          payload: { toolId: "tool-1", name: "terminal", argsPreview: "cmd=\"npm test\" apiKey=[redacted]" },
          at: "2026-01-01T00:00:02.000Z",
          sequence: 3,
        }),
        event({
          eventType: "tool_complete",
          source: "runtime",
          message: "Hermes tool terminal completed",
          payload: { toolId: "tool-1", name: "terminal", resultPreview: "tests passed", errorPreview: null },
          at: "2026-01-01T00:00:03.000Z",
          sequence: 4,
        }),
        event({
          eventType: "approval_resolved",
          source: "orchestrator",
          message: "Operator approval approved: branch -> main",
          payload: { status: "approved", decision: "approve" },
          at: "2026-01-01T00:00:04.000Z",
          sequence: 5,
        }),
      ],
      { run: runRecord({ prompt: "Issue: publish safely\n\napiKey=SECRET_PROMPT_VALUE" }) },
    );

    expect(messages).toEqual([
      {
        kind: "system",
        ts: "2026-01-01T00:00:00.000Z",
        model: "gpt-5-test",
        cwd: "/tmp/workspaces/TEST-1",
        workspace: "TEST-1",
        session: "session-1",
        tools: [],
        note: "Initialized implementation run from persisted run metadata. System prompt redacted.",
      },
      {
        kind: "user",
        ts: "2026-01-01T00:00:00.000Z",
        from: "orchestrator",
        issue: "TEST-1",
        text: "Issue: publish safely\n\napiKey=[redacted]",
      },
      { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "final assistant text" },
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:02.000Z",
        call_id: "tool-1",
        name: "terminal",
        status: "completed",
        args: { preview: "cmd=\"npm test\" apiKey=[redacted]" },
        result: "tests passed",
      },
      {
        kind: "status",
        state: "approved",
        ts: "2026-01-01T00:00:04.000Z",
        text: "Operator approval approved: branch -> main",
      },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("partial assistant text");
    expect(serialized).not.toContain("SECRET_PROMPT_VALUE");
  });


  it("surfaces Hermes grouped tool activity, diagnostics, tokens, and provider/rate limits as public web messages", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "progress",
        source: "harness",
        message: "Hermes ACP terminal (completed)",
        payload: { type: "progress", activitySource: "tool", message: "Hermes ACP terminal (completed)" },
      }),
      event({
        eventType: "run_diagnostic",
        source: "harness",
        message: "Host Hermes ACP refused the prompt.",
        payload: { type: "run_diagnostic", code: "hermes_acp_refusal", message: "Host Hermes ACP refused the prompt." },
        sequence: 2,
      }),
      event({
        eventType: "tokens",
        source: "harness",
        payload: { type: "tokens", tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
        sequence: 3,
      }),
      event({
        eventType: "provider_limit",
        source: "harness",
        payload: {
          type: "provider_limit",
          signal: {
            kind: "windowed_bucket_exhausted",
            message: "5h bucket exhausted",
            scope: { providerId: "openai-codex", model: "gpt-5.5" },
            window: { resumeAt: "2026-01-01T05:00:00.000Z" },
            raw: { apiKey: "SECRET_PROVIDER_KEY" },
          },
        },
        sequence: 4,
      }),
      event({
        eventType: "rate_limits",
        source: "harness",
        payload: {
          type: "rate_limits",
          payload: { provider: "cursor", remaining: 0, authorization: "Bearer SECRET_RATE_TOKEN" },
        },
        sequence: 5,
      }),
    ]);

    expect(messages).toEqual([
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:00.000Z",
        call_id: "run-1:1",
        name: "terminal",
        status: "completed",
        args: {},
        result: null,
      },
      {
        kind: "status",
        state: "hermes_acp_refusal",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Host Hermes ACP refused the prompt.",
      },
      {
        kind: "status",
        state: "tokens",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Tokens: input 10 · output 20 · total 30",
      },
      {
        kind: "status",
        state: "windowed_bucket_exhausted",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Provider limit: 5h bucket exhausted (openai-codex · gpt-5.5 · resume 2026-01-01T05:00:00.000Z)",
      },
      {
        kind: "status",
        state: "rate_limits",
        ts: "2026-01-01T00:00:00.000Z",
        text: 'Rate limits: {"provider":"cursor","remaining":0,"authorization":"[redacted]"}',
      },
    ]);
    expect(messages.map((message) => message.kind)).not.toContain("assistant");
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_PROVIDER_KEY");
    expect(serialized).not.toContain("SECRET_RATE_TOKEN");
    expect(serialized).not.toContain("Bearer");
  });

  it("maps reasoning aliases to thinking with public text previews", () => {
    expect(
      projectWebTranscript([
        event({
          eventType: "reasoning_delta",
          source: "cursor",
          message: "Cursor thinking event",
          payload: { kind: "thinking", textPreview: "actual reasoning text preview" },
        }),
      ]),
    ).toEqual([{ kind: "thinking", ts: "2026-01-01T00:00:00.000Z", text: "actual reasoning text preview" }]);
  });

  it("projects Cursor status, system, and unknown events as non-assistant messages", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "status",
        source: "cursor",
        message: "Cursor status running",
        payload: { kind: "status", status: "running", messagePreview: "workspace ready" },
      }),
      event({
        eventType: "system",
        source: "cursor",
        message: "Cursor system event: startup",
        payload: { kind: "system", subtype: "startup", messagePreview: "system public preview", truncated: false },
      }),
      event({ eventType: "some_new_cursor_kind", source: "cursor" }),
    ]);

    expect(messages).toEqual([
      { kind: "status", state: "running", ts: "2026-01-01T00:00:00.000Z", text: "workspace ready" },
      {
        kind: "system",
        ts: "2026-01-01T00:00:00.000Z",
        model: "",
        cwd: "",
        workspace: "",
        session: "run-1",
        tools: [],
        note: "system public preview",
      },
      {
        kind: "status",
        state: "some_new_cursor_kind",
        ts: "2026-01-01T00:00:00.000Z",
        text: "some_new_cursor_kind",
      },
    ]);
    expect(messages.map((message) => message.kind)).not.toContain("assistant");
  });

  it("groups display taxonomy events while surfacing tool/token/rate telemetry and hiding metadata", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "session_started",
        source: "harness",
        payload: { type: "session_started", sessionId: "internal-session", runId: "internal-run" },
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "Hel",
        payload: { type: "progress", activitySource: "delta", message: "Hel" },
      }),
      event({
        eventType: "tokens",
        source: "harness",
        payload: { type: "tokens", tokens: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, secret: "SECRET_TOKEN_SUMMARY" },
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "Hermes tool terminal: SECRET_TOOL_ARGUMENT",
        payload: { type: "progress", activitySource: "tool", message: "Hermes tool terminal: SECRET_TOOL_ARGUMENT" },
      }),
      event({
        eventType: "rate_limits",
        source: "harness",
        payload: { type: "rate_limits", payload: { apiKey: "SECRET_RATE_LIMIT" } },
      }),
      event({
        eventType: "run_status",
        source: "harness",
        payload: { type: "run_status", runId: "internal-run", sdkStatus: "running", source: "wait" },
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "lo",
        payload: { type: "progress", activitySource: "delta", message: "lo" },
        at: "2026-01-01T00:00:01.000Z",
      }),
      event({
        eventType: "tool_start",
        source: "runtime",
        message: "Hermes tool terminal started",
        payload: { toolId: "tool-1", name: "terminal", argsPreview: "cmd=\"npm test\" apiKey=[redacted]" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 2,
      }),
      event({
        eventType: "tool_complete",
        source: "runtime",
        message: "Hermes tool terminal completed",
        payload: { toolId: "tool-1", name: "terminal", resultPreview: "tests passed" },
        at: "2026-01-01T00:00:03.000Z",
        sequence: 3,
      }),
      event({
        eventType: "run_diagnostic",
        source: "harness",
        message: "raw SECRET_DIAGNOSTIC_MESSAGE",
        payload: {
          type: "run_diagnostic",
          code: "cursor_stream_error",
          message: "Public diagnostic message",
          payload: { token: "SECRET_DIAGNOSTIC_TOKEN" },
        },
        at: "2026-01-01T00:00:04.000Z",
      }),
      event({
        eventType: "provider_limit",
        source: "harness",
        payload: {
          type: "provider_limit",
          signal: {
            kind: "windowed_bucket_exhausted",
            message: "Provider paused until quota resets",
            raw: { apiKey: "SECRET_PROVIDER_LIMIT" },
          },
        },
        at: "2026-01-01T00:00:05.000Z",
      }),
      event({
        eventType: "completed",
        source: "harness",
        message: "Worker completed",
        payload: { type: "completed", message: "Worker completed" },
        at: "2026-01-01T00:00:06.000Z",
      }),
      event({
        eventType: "failed",
        source: "harness",
        payload: { type: "failed", error: "Worker failed" },
        at: "2026-01-01T00:00:07.000Z",
      }),
      event({
        eventType: "cancelled",
        source: "harness",
        payload: { type: "cancelled" },
        at: "2026-01-01T00:00:08.000Z",
      }),
    ]);

    expect(messages).toEqual([
      { kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hel" },
      {
        kind: "status",
        state: "tokens",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Tokens: input 7 · output 3 · total 10",
      },
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:00.000Z",
        call_id: "run-1:1",
        name: "terminal",
        status: "running",
        args: {},
        result: null,
      },
      {
        kind: "status",
        state: "rate_limits",
        ts: "2026-01-01T00:00:00.000Z",
        text: 'Rate limits: {"apiKey":"[redacted]"}',
      },
      { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "lo" },
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:02.000Z",
        call_id: "tool-1",
        name: "terminal",
        status: "completed",
        args: { preview: "cmd=\"npm test\" apiKey=[redacted]" },
        result: "tests passed",
      },
      {
        kind: "status",
        state: "cursor_stream_error",
        ts: "2026-01-01T00:00:04.000Z",
        text: "Public diagnostic message",
      },
      {
        kind: "status",
        state: "windowed_bucket_exhausted",
        ts: "2026-01-01T00:00:05.000Z",
        text: "Provider limit: Provider paused until quota resets",
      },
      { kind: "status", state: "completed", ts: "2026-01-01T00:00:06.000Z", text: "Worker completed" },
      { kind: "status", state: "failed", ts: "2026-01-01T00:00:07.000Z", text: "Worker failed" },
      { kind: "status", state: "cancelled", ts: "2026-01-01T00:00:08.000Z", text: "Run cancelled" },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("internal-run");
    expect(serialized).not.toContain("internal-session");
    expect(serialized).not.toContain("run_status");
    expect(serialized).toContain("Tokens: input 7");
    expect(serialized).toContain("Rate limits:");
    expect(serialized).not.toContain("Hermes tool terminal: ");
  });

  it("shows canonical token summaries while preserving raw token telemetry without public counts as hidden metadata", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "tokens",
        source: "harness",
        message: "Token usage updated",
        payload: { kind: "usage", tokens: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } },
      }),
      event({
        eventType: "tokens",
        source: "harness",
        message: "Fixture token update 12",
        payload: { type: "tokens", tokens: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, totalTokens: 12 },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
      }),
      event({
        eventType: "tokens",
        source: "harness",
        payload: { type: "tokens", secret: "SECRET_TOKEN_SUMMARY" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 3,
      }),
    ]);

    expect(messages).toEqual([
      { kind: "status", state: "usage", ts: "2026-01-01T00:00:00.000Z", text: "Tokens: input 4 · output 6 · total 10" },
      { kind: "status", state: "tokens", ts: "2026-01-01T00:00:01.000Z", text: "Tokens: input 5 · output 7 · total 12" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("SECRET_TOKEN_SUMMARY");
  });

  it("projects persisted harness-provided ACP RunActivityEvent taxonomy without falling back to legacy progress", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "Hello",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "message", textPreview: "Hello", delta: true },
      }),
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: " world",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "message", textPreview: " world", delta: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
      }),
      event({
        eventType: "user_message_submitted",
        source: "harness",
        message: "Do work",
        payload: { kind: "user_message_submitted", actor: "user", channel: "chat", replay: true, textPreview: "Do work" },
        at: "2026-01-01T00:00:01.500Z",
        sequence: 3,
      }),
      event({
        eventType: "assistant_reasoning_delta",
        source: "harness",
        message: "Hermes ACP thought update",
        payload: { kind: "assistant_reasoning_delta", actor: "assistant", channel: "message", delta: true, reasoningPreview: "public thought preview" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 4,
      }),
      event({
        eventType: "tool_call_started",
        source: "harness",
        message: "Hermes ACP tool started: terminal",
        payload: { kind: "tool_call_started", actor: "tool", channel: "tool", toolCallId: "call-1", toolName: "terminal", status: "running", inputPreview: 'cmd="npm test"' },
        at: "2026-01-01T00:00:03.000Z",
        sequence: 5,
      }),
      event({
        eventType: "tool_call_completed",
        source: "harness",
        message: "Hermes ACP tool completed: terminal",
        payload: { kind: "tool_call_completed", actor: "tool", channel: "tool", toolCallId: "call-1", toolName: "terminal", status: "succeeded", outputPreview: "tests passed" },
        at: "2026-01-01T00:00:04.000Z",
        sequence: 6,
      }),
      event({
        eventType: "token_usage_reported",
        source: "harness",
        message: "Token usage reported",
        payload: { kind: "token_usage_reported", actor: "runtime", channel: "token", inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        at: "2026-01-01T00:00:05.000Z",
        sequence: 7,
      }),
      event({
        eventType: "runtime_diagnostic",
        source: "harness",
        message: "ACP permission denied",
        payload: { kind: "runtime_diagnostic", actor: "runtime", channel: "status", code: "hermes_acp_permission_denied", messagePreview: "permission denied" },
        at: "2026-01-01T00:00:06.000Z",
        sequence: 8,
      }),
      event({
        eventType: "run_cancelled",
        source: "harness",
        message: "Run cancelled",
        payload: { kind: "run_cancelled", actor: "runtime", channel: "terminal", reason: "run_cancelled" },
        at: "2026-01-01T00:00:07.000Z",
        sequence: 9,
      }),
      event({
        eventType: "run_failed",
        source: "harness",
        message: "Run failed token=SECRET_FAILURE_TOKEN",
        payload: { kind: "run_failed", actor: "runtime", channel: "terminal", errorPreview: "Run failed token=SECRET_FAILURE_TOKEN", redacted: true },
        at: "2026-01-01T00:00:08.000Z",
        sequence: 10,
      }),
    ]);

    expect(messages).toEqual([
      { kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello world" },
      { kind: "user", ts: "2026-01-01T00:00:01.500Z", from: "user", issue: "", text: "Do work" },
      { kind: "thinking", ts: "2026-01-01T00:00:02.000Z", text: "public thought preview" },
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:03.000Z",
        call_id: "call-1",
        name: "terminal",
        status: "succeeded",
        args: { preview: 'cmd="npm test"' },
        result: "tests passed",
        output: "tests passed",
      },
      { kind: "status", state: "token_usage_reported", ts: "2026-01-01T00:00:05.000Z", text: "Tokens: input 3 · output 5 · total 8" },
      { kind: "status", state: "runtime_diagnostic", ts: "2026-01-01T00:00:06.000Z", text: "permission denied" },
      { kind: "status", state: "run_cancelled", ts: "2026-01-01T00:00:07.000Z", text: "Run cancelled" },
      { kind: "status", state: "run_failed", ts: "2026-01-01T00:00:08.000Z", text: "Run failed token=[redacted]" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("SECRET_FAILURE_TOKEN");
  });

  it("exact-concatenates canonical assistant_message_delta chunks and ignores only empty chunks", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "fallback label",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "chat", textPreview: "H", delta: true },
        sequence: 20,
      }),
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "fallback label",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "chat", textPreview: "ello", delta: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 21,
      }),
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "fallback label",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "chat", textPreview: " ", delta: true },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 22,
      }),
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "fallback label",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "chat", textPreview: "world", delta: true },
        at: "2026-01-01T00:00:03.000Z",
        sequence: 23,
      }),
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "fallback label",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "chat", textPreview: "", delta: true },
        at: "2026-01-01T00:00:04.000Z",
        sequence: 24,
      }),
    ]);

    expect(messages).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello world" }]);
  });

  it("routes progress-shaped token and rate-limit telemetry to status while coalescing assistant progress deltas", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "progress",
        source: "harness",
        message: "assistant delta one",
        payload: { kind: "progress", actor: "assistant", channel: "message", textPreview: "Hello", delta: true },
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "assistant delta two",
        payload: { kind: "progress", actor: "assistant", channel: "message", textPreview: "again", delta: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "Token usage reported",
        payload: { kind: "token_usage_reported", actor: "runtime", channel: "token", messagePreview: "8 total tokens" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 3,
      }),
      event({
        eventType: "progress",
        source: "runtime",
        message: "Provider rate limit updated",
        payload: { kind: "provider_rate_limit", actor: "runtime", channel: "status", messagePreview: "rate limit backoff" },
        at: "2026-01-01T00:00:03.000Z",
        sequence: 4,
      }),
      event({
        eventType: "completed",
        source: "harness",
        message: "legacy harness assistant completion",
        at: "2026-01-01T00:00:04.000Z",
        sequence: 5,
      }),
    ]);

    expect(messages).toEqual([
      { kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello again" },
      { kind: "status", state: "token_usage_reported", ts: "2026-01-01T00:00:02.000Z", text: "8 total tokens" },
      { kind: "status", state: "provider_rate_limit", ts: "2026-01-01T00:00:03.000Z", text: "rate limit backoff" },
      { kind: "status", state: "completed", ts: "2026-01-01T00:00:04.000Z", text: "legacy harness assistant completion" },
    ]);
  });

  it("keeps missing-completion assistant streams readable across duplicate and empty deltas", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "progress",
        source: "harness",
        message: "Hel",
        payload: { type: "progress", activitySource: "delta", message: "Hel" },
        sequence: 10,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "Hel",
        payload: { type: "progress", activitySource: "delta", message: "Hel" },
        sequence: 10,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "",
        payload: { type: "progress", activitySource: "delta", message: "" },
        sequence: 11,
      }),
      event({
        eventType: "progress",
        source: "harness",
        payload: { type: "progress", activitySource: "delta" },
        sequence: 12,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "lo",
        payload: { type: "progress", activitySource: "delta", message: "lo" },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 13,
      }),
    ]);

    expect(messages).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello" }]);
  });

  it("exact-concatenates Hermes runtime message_delta streams without completion", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "message_delta",
        source: "runtime",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "H", redacted: true },
      }),
      event({
        eventType: "message_delta",
        source: "runtime",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "ello", redacted: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
      }),
    ]);

    expect(messages).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello" }]);
  });

  it("preserves whitespace-only and leading-space assistant delta chunks while redacting secrets", () => {
    const harnessMessages = projectWebTranscript([
      event({
        eventType: "progress",
        source: "harness",
        message: "Hello",
        payload: { type: "progress", activitySource: "delta", message: "Hello" },
        sequence: 30,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: " ",
        payload: { type: "progress", activitySource: "delta", message: " " },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 31,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "world",
        payload: { type: "progress", activitySource: "delta", message: "world" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 32,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "",
        payload: { type: "progress", activitySource: "delta", message: "" },
        at: "2026-01-01T00:00:03.000Z",
        sequence: 33,
      }),
    ]);
    const runtimeMessages = projectWebTranscript([
      event({
        eventType: "message_delta",
        source: "runtime",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "Hello", redacted: true },
        sequence: 40,
      }),
      event({
        eventType: "message_delta",
        source: "runtime",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: " world", redacted: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 41,
      }),
    ]);
    const redactedMessages = projectWebTranscript([
      event({
        eventType: "progress",
        source: "harness",
        message: "Token ",
        payload: { type: "progress", activitySource: "delta", message: "Token " },
        sequence: 50,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "SECRET_DELTA_TOKEN",
        payload: { type: "progress", activitySource: "delta", message: "SECRET_DELTA_TOKEN" },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 51,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: " done",
        payload: { type: "progress", activitySource: "delta", message: " done" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 52,
      }),
    ]);

    expect(harnessMessages).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello world" }]);
    expect(runtimeMessages).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello world" }]);
    expect(redactedMessages).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Token [redacted] done" }]);
    expect(JSON.stringify(redactedMessages)).not.toContain("SECRET_DELTA_TOKEN");
  });

  it("coalesces real Hermes runtime and harness mirrored deltas before failed or cancelled terminal rows", () => {
    const mirroredDeltas: TranscriptEvent[] = [
      event({
        eventType: "message_delta",
        source: "runtime",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "Hel", redacted: true },
        sequence: 20,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "Hel",
        payload: {
          kind: "assistant_delta",
          activitySource: "delta",
          progressKind: "assistant_delta",
          messagePreview: "Hel",
          truncated: false,
          redacted: false,
        },
        at: "2026-01-01T00:00:00.100Z",
        sequence: 21,
      }),
      event({
        eventType: "message_delta",
        source: "runtime",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "lo", redacted: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 22,
      }),
      event({
        eventType: "progress",
        source: "harness",
        message: "lo",
        payload: {
          kind: "assistant_delta",
          activitySource: "delta",
          progressKind: "assistant_delta",
          messagePreview: "lo",
          truncated: false,
          redacted: false,
        },
        at: "2026-01-01T00:00:01.100Z",
        sequence: 23,
      }),
    ];
    const terminalCases = [
      {
        eventType: "failed",
        message: "Run failed before message.complete",
        payload: { kind: "terminal", status: "failed", errorPreview: "Run failed before message.complete" },
        expected: { kind: "status", state: "failed", ts: "2026-01-01T00:00:02.000Z", text: "Run failed before message.complete" },
      },
      {
        eventType: "cancelled",
        message: "Run cancelled",
        payload: { kind: "terminal", status: "cancelled" },
        expected: { kind: "status", state: "cancelled", ts: "2026-01-01T00:00:02.000Z", text: "Run cancelled" },
      },
    ];

    for (const terminalCase of terminalCases) {
      const messages = projectWebTranscript([
        ...mirroredDeltas,
        event({
          eventType: terminalCase.eventType,
          source: "harness",
          message: terminalCase.message,
          payload: terminalCase.payload,
          at: "2026-01-01T00:00:02.000Z",
          sequence: 24,
        }),
      ]);

      expect(messages).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello" },
        terminalCase.expected,
      ]);
    }
  });

  it("keeps unresolved request actions exact empty arrays and maps unknown payloads without leaking runtime fields", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "approval_request",
        source: "orchestrator",
        message: "Approval requested",
        payload: {
          reason: "workflow_policy",
          prompt: "Operator approval requested",
          actions: [{ unresolvedId: "approve-secret" }, {}, null, ""],
          rawRequest: { token: "SECRET_ACTION_TOKEN" },
        },
      }),
      event({
        eventType: "brand_new_runtime_event",
        source: "runtime",
        message: "raw SECRET_RUNTIME_MESSAGE",
        payload: {
          textPreview: "Public fallback status",
          runId: "internal-run-id",
          toolArgs: { token: "SECRET_TOOL_ARG" },
          result: "SECRET_RESULT_PAYLOAD",
        },
      }),
    ]);

    expect(messages).toEqual([
      {
        kind: "request",
        ts: "2026-01-01T00:00:00.000Z",
        reason: "workflow_policy",
        q: "Operator approval requested",
        actions: [],
      },
      {
        kind: "status",
        state: "brand_new_runtime_event",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Public fallback status",
      },
    ]);
    expect(messages[0]?.kind === "request" ? messages[0].actions : null).toEqual([]);
    expect(messages[0]?.kind === "request" ? messages[0].actions : null).not.toBeUndefined();
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("internal-run-id");
    expect(serialized).not.toContain("rawRequest");
    expect(serialized).not.toContain("toolArgs");
  });

  it("downgrades legacy ACP protocol event names to neutral public status states", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "acp_session_update",
        source: "runtime",
        message: "Legacy ACP session update",
        payload: { kind: "session_update", status: "tool_call_update", messagePreview: "legacy update" },
      }),
      event({
        eventType: "acp_permission_denied",
        source: "runtime",
        message: "Legacy permission denied",
        payload: { state: "acp_permission_denied", messagePreview: "permission denied" },
        sequence: 2,
      }),
      event({
        eventType: "hermes_acp_profile",
        source: "runtime",
        message: "Legacy profile detail",
        payload: { kind: "hermes_acp_profile", messagePreview: "profile ready" },
        sequence: 3,
      }),
    ]);

    expect(messages).toEqual([
      { kind: "status", state: "runtime_diagnostic", ts: "2026-01-01T00:00:00.000Z", text: "legacy update" },
      { kind: "status", state: "runtime_diagnostic", ts: "2026-01-01T00:00:00.000Z", text: "permission denied" },
      { kind: "status", state: "runtime_diagnostic", ts: "2026-01-01T00:00:00.000Z", text: "profile ready" },
    ]);
    expect(messages.flatMap((message) => message.kind === "status" ? [message.state] : [])).not.toEqual(
      expect.arrayContaining(["acp_session_update", "acp_permission_denied", "hermes_acp_profile", "session_update", "tool_call_update"]),
    );
  });

  it("does not use stale Cursor metadata in run prelude system messages for explicit Hermes ACP runs", () => {
    const hermesAcpMessages = projectWebTranscript([], {
      run: runRecord({ harnessId: "hermes_acp", runtimeModel: null, cursorModel: "stale-cursor-model" }),
    });

    expect(hermesAcpMessages[0]).toMatchObject({ kind: "system", model: "" });

    const cursorMessages = projectWebTranscript([], {
      run: runRecord({ harnessId: "cursor", runtimeModel: null, cursorModel: "cursor-model" }),
    });
    expect(cursorMessages[0]).toMatchObject({ kind: "system", model: "cursor-model" });
  });

  it("wraps explicit transcript pages with window metadata and inactive tail state", () => {
    const payload = projectWebTranscriptWindow(
      transcriptPage({ offset: 25, limit: 100, nextOffset: 125, total: 250, windowKind: "page" }),
      [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "paged message" }],
      { run: runRecord({ status: "succeeded" }), kind: "page", requestedPage: { offset: 25, limit: 100 }, tailLimit: 500 },
    );

    expect(payload).toMatchObject({
      schemaVersion: 1,
      messages: [{ kind: "assistant", text: "paged message" }],
      page: {
        offset: 25,
        limit: 100,
        size: 1,
        total: 250,
        nextOffset: 125,
        previousOffset: 0,
        hasNext: true,
        hasPrevious: true,
        firstSequence: 26,
        lastSequence: 26,
        lastEventAt: "2026-01-01T00:00:26.000Z",
      },
      window: { kind: "page", requested: { offset: 25, limit: 100 }, tailLimit: 500, messageCount: 1 },
      activeTail: { enabled: false, canAppend: false, runStatus: "succeeded", afterSequence: 26 },
      recovery: { strategy: "refetch", reason: "tail-gap" },
      compatibility: { responseShape: "transcript_window", messagesField: "messages" },
    });
  });

  it("enables active append metadata for running transcript tails", () => {
    const payload = projectWebTranscriptWindow(
      transcriptPage({ offset: 100, limit: 500, nextOffset: null, total: 101, windowKind: "tail" }),
      [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "tail message" }],
      { run: runRecord({ status: "running" }), kind: "tail", requestedPage: null, tailLimit: 500 },
    );

    expect(payload.window).toMatchObject({ kind: "tail", requested: { offset: null, limit: 500 }, tailLimit: 500 });
    expect(payload.activeTail).toMatchObject({
      enabled: true,
      canAppend: true,
      runStatus: "running",
      tailLimit: 500,
      afterSequence: 101,
      refetchHref: "/api/v1/web/sessions/session-1/transcript?refresh=1",
    });
    expect(payload.activeTail.gapFallback).toEqual(payload.recovery);
  });

  it("creates empty transcript window payloads for unavailable or missing runs", () => {
    expect(emptyWebTranscriptProjectionPayload({ runId: "missing-run", limit: 500 })).toMatchObject({
      schemaVersion: 1,
      messages: [],
      page: { offset: 0, limit: 500, size: 0, total: 0, nextOffset: null, previousOffset: null },
      window: { kind: "tail", messageCount: 0, requested: { offset: null, limit: 500 } },
      activeTail: { enabled: false, canAppend: false, runStatus: null, afterSequence: null },
      compatibility: { responseShape: "transcript_window", messagesField: "messages" },
    });
  });

});

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "test-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "Implement TEST-1",
    harnessId: "hermes",
    runtimeModel: "gpt-5-test",
    cursorModel: "claude-sonnet-4",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspaces/TEST-1",
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

function transcriptPage(input: {
  offset: number;
  limit: number;
  nextOffset: number | null;
  total: number;
  windowKind: "page" | "tail";
}): TranscriptPage {
  const sequence = input.windowKind === "tail" ? input.total : input.offset + 1;
  const at = `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`;
  return {
    runId: "run-1",
    offset: input.offset,
    limit: input.limit,
    nextOffset: input.nextOffset,
    events: [event({ sequence, at })],
    total: input.total,
    eventCount: 1,
    previousOffset: input.offset > 0 ? Math.max(0, input.offset - input.limit) : null,
    hasPrevious: input.offset > 0,
    hasNext: input.nextOffset !== null,
    windowKind: input.windowKind,
    firstSequence: sequence,
    lastSequence: sequence,
    lastEventAt: at,
  };
}

function event(overrides: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    runId: "run-1",
    sequence: 1,
    at: "2026-01-01T00:00:00.000Z",
    source: "harness",
    eventType: "progress",
    ...overrides,
  };
}