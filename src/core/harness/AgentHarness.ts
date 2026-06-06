import type { ServiceConfig } from "../config/Config.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { ProviderLimitSignal } from "../provider/ProviderLimits.js";
import type { RunActivityEvent } from "../runActivity/RunActivityEvent.js";
import type { AgentRunPhase, AgentRunRole, Issue, TokenCounts, Workspace } from "../types.js";

export type AgentRunMode = "agent" | "plan";

export interface AgentHarnessCapabilities {
  readonly mcpHandoff?: boolean;
  readonly continuation?: boolean;
  readonly runStatus?: boolean;
  readonly liveDiagnostics?: boolean;
}

export interface AgentRunContext {
  issue: Issue;
  role: AgentRunRole;
  runPhase?: AgentRunPhase;
  attempt: number | null;
  workspace: Workspace;
  config: ServiceConfig;
  turnNumber: number;
  runModeOverride?: AgentRunMode | null;
  operatorChat?: {
    conversationId: string;
    messageId: string;
    statusServer?: OperatorChatRunContext["statusServer"];
  };
  abortSignal: AbortSignal;
  logger: Logger;
}

export interface OperatorChatRunContext {
  conversationId: string;
  messageId: string;
  workspace: Workspace;
  config: ServiceConfig;
  turnNumber: number;
  abortSignal: AbortSignal;
  logger: Logger;
  statusServer?: {
    baseUrl: string;
    mutationToken: string | null;
  } | null;
}

export type AgentActivitySource = "stream" | "delta" | "tool";
export type AgentRunSdkStatus = "running" | "finished" | "error" | "cancelled";

export interface AgentEventBase {
  runActivity?: RunActivityEvent;
}

export type AgentEvent = AgentEventBase &
  (
    | {
        type: "session_started";
        sessionId: string;
        threadId?: string;
        runId?: string;
        providerId?: string | null;
        model?: string | null;
        at?: string;
      }
    | {
        type: "progress";
        message: string;
        activitySource?: AgentActivitySource;
        at?: string;
      }
    | {
        type: "tokens";
        tokens: Partial<TokenCounts>;
        at?: string;
      }
    | {
        type: "rate_limits";
        payload: unknown;
        at?: string;
      }
    | {
        type: "provider_limit";
        signal: ProviderLimitSignal;
        at?: string;
      }
    | {
        type: "run_status";
        runId: string;
        sdkStatus: AgentRunSdkStatus;
        source: "initial" | "onDidChangeStatus" | "wait";
        at?: string;
      }
    | {
        type: "run_diagnostic";
        code: string;
        message: string;
        payload?: unknown;
        at?: string;
      }
    | {
        type: "completed";
        message?: string;
        payload?: unknown;
        at?: string;
      }
    | {
        type: "failed";
        error: string;
        at?: string;
      }
    | {
        type: "cancelled";
        at?: string;
      }
  );

export interface AgentHarness {
  readonly id: string;
  readonly capabilities?: AgentHarnessCapabilities;
  /**
   * @deprecated Use capabilities.continuation. Kept as a compatibility alias
   * while existing tests and harnesses migrate to neutral capabilities.
   */
  readonly supportsContinuation?: boolean;
  prepare?(ctx: AgentRunContext): Promise<void>;
  run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent>;
  runOperatorChat?(ctx: OperatorChatRunContext, prompt: string): AsyncIterable<AgentEvent>;
  reload?(ctx: AgentRunContext): Promise<void>;
  stop?(runId: string): Promise<void>;
}
