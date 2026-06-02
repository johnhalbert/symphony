import type { AgentActivitySource, AgentEvent } from "../../src/core/harness/AgentHarness.js";
import type { GatewayEvent } from "../../hermes/src/GatewayFacade.js";

export type HarnessActivityProtocolAdapterId = "hermes_jsonrpc" | "hermes_acp";
export type HarnessActivityTerminalKind = "completed" | "failed" | "cancelled" | "provider_limit_failed";
export type PublicFrontendTranscriptKind = "system" | "user" | "assistant" | "thinking" | "tool_call" | "status" | "task" | "request";

export interface HermesJsonRpcActivityFixture {
  readonly events: readonly GatewayEvent[];
}

export interface HermesAcpActivityFixture {
  readonly notifications: readonly unknown[];
  readonly diagnostics?: readonly { code: string; message: string; details?: Record<string, unknown> }[];
  readonly promptResult: Record<string, unknown> | null;
}

export interface HarnessActivityProtocols {
  readonly hermes_jsonrpc?: HermesJsonRpcActivityFixture;
  readonly hermes_acp?: HermesAcpActivityFixture;
}

export interface HarnessActivityProtocolExpectation {
  readonly requiredAgentEventTypes?: readonly AgentEvent["type"][];
  readonly activitySources?: readonly AgentActivitySource[];
  readonly tokenTotals?: readonly number[];
  readonly diagnosticCodes?: readonly string[];
  readonly providerLimitKind?: string;
}

export interface HarnessActivityExpectedContract extends HarnessActivityProtocolExpectation {
  readonly terminal: HarnessActivityTerminalKind;
  readonly negative?: boolean;
  readonly perProtocol?: Partial<Record<HarnessActivityProtocolAdapterId, HarnessActivityProtocolExpectation>>;
}

export interface HarnessActivityConformanceFixture {
  readonly name: string;
  readonly description: string;
  readonly protocols: HarnessActivityProtocols;
  readonly expected: HarnessActivityExpectedContract;
}

export const HARNESS_ACTIVITY_ADAPTER_IDS = ["hermes_jsonrpc", "hermes_acp"] as const satisfies readonly HarnessActivityProtocolAdapterId[];

export const ALLOWED_HARNESS_AGENT_EVENT_TYPES = [
  "session_started",
  "progress",
  "tokens",
  "rate_limits",
  "provider_limit",
  "run_status",
  "run_diagnostic",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly AgentEvent["type"][];

export const ALLOWED_HARNESS_ACTIVITY_SOURCES = ["stream", "delta", "tool"] as const satisfies readonly AgentActivitySource[];

export const ALLOWED_PUBLIC_FRONTEND_KINDS = [
  "system",
  "user",
  "assistant",
  "thinking",
  "tool_call",
  "status",
  "task",
  "request",
] as const satisfies readonly PublicFrontendTranscriptKind[];

export const PROTOCOL_EVENT_NAMES_FORBIDDEN_AS_AGENT_EVENT_TYPES = [
  "message.delta",
  "message.complete",
  "tool.start",
  "tool.progress",
  "tool.complete",
  "provider.limit",
  "session.update",
  "session/update",
  "session_update",
  "agent_message_chunk",
  "agent_thought_chunk",
  "usage_update",
  "tool_call",
  "tool_call_update",
  "current_mode_update",
] as const;

export const PROTOCOL_EVENT_NAMES_FORBIDDEN_AS_FRONTEND_KINDS = [
  "message.delta",
  "message.complete",
  "tool.start",
  "tool.progress",
  "tool.complete",
  "provider.limit",
  "session.update",
  "session/update",
  "session_update",
  "agent_message_chunk",
  "agent_thought_chunk",
  "usage_update",
  "tool_call_update",
  "current_mode_update",
] as const;

export const HARNESS_ACTIVITY_SENSITIVE_NEEDLES = [
  "SECRET_JSONRPC_DELTA_TOKEN",
  "SECRET_JSONRPC_TOOL_TOKEN",
  "SECRET_JSONRPC_RESULT_TOKEN",
  "SECRET_JSONRPC_ERROR_TOKEN",
  "SECRET_JSONRPC_MALFORMED_TOKEN",
  "SECRET_ACP_DELTA_TOKEN",
  "SECRET_ACP_TOOL_TOKEN",
  "SECRET_ACP_RESULT_TOKEN",
  "SECRET_ACP_MALFORMED_TOKEN",
] as const;

const LONG_JSONRPC_DELTA = `JSON-RPC delta ${"x".repeat(760)} SECRET_JSONRPC_DELTA_TOKEN`;
const LONG_ACP_DELTA = `ACP delta ${"y".repeat(760)} SECRET_ACP_DELTA_TOKEN`;

export const harnessActivityConformanceFixtures: readonly HarnessActivityConformanceFixture[] = [
  {
    name: "streaming_tool_tokens_success",
    description: "Streaming progress, assistant delta, tool activity, token accounting, and successful terminal result.",
    protocols: {
      hermes_jsonrpc: {
        events: [
          {
            type: "status.update",
            payload: { kind: "planning", text: "JSON-RPC planning contract fixture" },
          } as GatewayEvent,
          {
            type: "message.delta",
            payload: { text: LONG_JSONRPC_DELTA },
          } as GatewayEvent,
          {
            type: "tool.start",
            payload: { name: "read_file", tool_id: "tool-jsonrpc-1", args_text: "api_key=SECRET_JSONRPC_TOOL_TOKEN" },
          } as GatewayEvent,
          {
            type: "tool.progress",
            payload: { name: "read_file", preview: "read first chunk" },
          } as GatewayEvent,
          {
            type: "tool.complete",
            payload: {
              name: "read_file",
              tool_id: "tool-jsonrpc-1",
              summary: "fixture read finished",
              result_text: "result SECRET_JSONRPC_RESULT_TOKEN",
            },
          } as GatewayEvent,
          {
            type: "message.complete",
            payload: { status: "complete", text: "JSON-RPC final answer", usage: { input: 13, output: 21, total: 34 } },
          } as GatewayEvent,
        ],
      },
      hermes_acp: {
        notifications: [
          { sessionId: "acp-session-1", update: { sessionUpdate: "plan", text: "ACP planning contract fixture" } },
          { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: LONG_ACP_DELTA } } },
          {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCall: { id: "tool-acp-1", name: "read_file", status: "running" },
              content: "api_key=SECRET_ACP_TOOL_TOKEN",
            },
          },
          {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCall: { id: "tool-acp-1", name: "read_file", status: "completed" },
              content: "result SECRET_ACP_RESULT_TOKEN",
            },
          },
          { sessionId: "acp-session-1", update: { sessionUpdate: "usage_update", used: 34 } },
        ],
        promptResult: { stopReason: "end_turn", usage: { input: 13, output: 21, total: 34 } },
      },
    },
    expected: {
      terminal: "completed",
      requiredAgentEventTypes: ["session_started", "progress", "tokens", "completed"],
      activitySources: ["delta", "tool"],
      tokenTotals: [34],
    },
  },
  {
    name: "terminal_error_failure",
    description: "Protocol error/refusal terminal paths normalize into diagnostics plus failed AgentEvents.",
    protocols: {
      hermes_jsonrpc: {
        events: [
          {
            type: "error",
            payload: {
              code: "adapter_error",
              message: "JSON-RPC adapter error SECRET_JSONRPC_ERROR_TOKEN",
              data: { apiKey: "SECRET_JSONRPC_ERROR_TOKEN" },
            },
          } as GatewayEvent,
        ],
      },
      hermes_acp: {
        notifications: [],
        promptResult: { stopReason: "refusal", usage: { input: 2, output: 0, total: 2 } },
      },
    },
    expected: {
      terminal: "failed",
      requiredAgentEventTypes: ["session_started", "run_diagnostic", "failed"],
      perProtocol: {
        hermes_jsonrpc: { diagnosticCodes: ["hermes_gateway_error"] },
        hermes_acp: { diagnosticCodes: ["hermes_acp_refusal"], tokenTotals: [2] },
      },
    },
  },
  {
    name: "cancelled_terminal",
    description: "Interrupted JSON-RPC completions and ACP cancelled stop reasons normalize into cancelled terminal events.",
    protocols: {
      hermes_jsonrpc: {
        events: [
          {
            type: "message.complete",
            payload: { status: "interrupted", text: "operator cancelled", usage: { input: 3, output: 5, total: 8 } },
          } as GatewayEvent,
        ],
      },
      hermes_acp: {
        notifications: [],
        promptResult: { stopReason: "cancelled", usage: { input: 3, output: 5, total: 8 } },
      },
    },
    expected: {
      terminal: "cancelled",
      requiredAgentEventTypes: ["session_started", "tokens", "cancelled"],
      tokenTotals: [8],
    },
  },
  {
    name: "provider_limit_terminal",
    description: "Structured Hermes JSON-RPC provider-limit events normalize into provider_limit plus failed terminal events.",
    protocols: {
      hermes_jsonrpc: {
        events: [
          {
            type: "provider.limit",
            payload: {
              provider_id: "openai-codex",
              model: "gpt-5-test",
              kind: "windowed_bucket_exhausted",
              message: "Codex session allotment exhausted",
              resume_at: "2026-05-28T18:00:00.000Z",
              window_label: "Session",
              window_kind: "codex_5h",
            },
          } as GatewayEvent,
        ],
      },
    },
    expected: {
      terminal: "provider_limit_failed",
      requiredAgentEventTypes: ["session_started", "provider_limit", "failed"],
      providerLimitKind: "windowed_bucket_exhausted",
    },
  },
  {
    name: "malformed_incomplete_negative",
    description: "Malformed JSON-RPC/ACP diagnostics and incomplete activity payloads stay bounded, diagnostic, and normalized.",
    protocols: {
      hermes_jsonrpc: {
        events: [
          {
            type: "gateway.protocol_error",
            payload: { preview: "not-json SECRET_JSONRPC_MALFORMED_TOKEN" },
          } as GatewayEvent,
          {
            type: "tool.start",
            payload: { tool_id: "tool-jsonrpc-incomplete" },
          } as GatewayEvent,
          {
            type: "message.delta",
            payload: {},
          } as GatewayEvent,
          {
            type: "message.complete",
            payload: { status: "complete", usage: { total: 1 } },
          } as GatewayEvent,
        ],
      },
      hermes_acp: {
        diagnostics: [
          {
            code: "host_hermes_acp_parse_error",
            message: "Malformed ACP JSON-RPC SECRET_ACP_MALFORMED_TOKEN",
            details: { rawLine: "{not-json", token: "SECRET_ACP_MALFORMED_TOKEN" },
          },
        ],
        notifications: [
          "not-a-session-update-object",
          { sessionId: "acp-session-1" },
          { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: "ignored wrong session" } },
        ],
        promptResult: { stopReason: "end_turn", usage: { total: 1 } },
      },
    },
    expected: {
      terminal: "completed",
      requiredAgentEventTypes: ["session_started", "run_diagnostic", "completed"],
      tokenTotals: [1],
      negative: true,
      perProtocol: {
        hermes_jsonrpc: { diagnosticCodes: ["hermes_gateway_protocol_error"] },
        hermes_acp: { diagnosticCodes: ["host_hermes_acp_parse_error"] },
      },
    },
  },
];
