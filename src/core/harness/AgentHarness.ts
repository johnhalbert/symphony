import type { ServiceConfig } from "../config/Config.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { AgentRunRole, Issue, TokenCounts, Workspace } from "../types.js";

export interface AgentRunContext {
  issue: Issue;
  role: AgentRunRole;
  attempt: number | null;
  workspace: Workspace;
  config: ServiceConfig;
  turnNumber: number;
  abortSignal: AbortSignal;
  logger: Logger;
}

export type AgentActivitySource = "stream" | "delta" | "tool";
export type AgentRunSdkStatus = "running" | "finished" | "error" | "cancelled";

export type AgentEvent =
  | {
      type: "session_started";
      sessionId: string;
      threadId?: string;
      runId?: string;
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
    };

export interface AgentHarness {
  readonly id: string;
  readonly supportsContinuation?: boolean;
  prepare?(ctx: AgentRunContext): Promise<void>;
  run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent>;
  reload?(ctx: AgentRunContext): Promise<void>;
  stop?(runId: string): Promise<void>;
}
