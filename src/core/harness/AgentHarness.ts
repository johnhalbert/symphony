import type { ServiceConfig } from "../config/Config.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { Issue, TokenCounts, Workspace } from "../types.js";

export interface AgentRunContext {
  issue: Issue;
  attempt: number | null;
  workspace: Workspace;
  config: ServiceConfig;
  turnNumber: number;
  abortSignal: AbortSignal;
  logger: Logger;
}

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
