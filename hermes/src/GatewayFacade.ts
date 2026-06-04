import { GatewayClient as UpstreamGatewayClient } from "../upstream-src/ui-tui/src/gatewayClient.js";
import type {
  GatewayEvent,
  PromptSubmitResponse,
  SessionCloseResponse,
  SessionCreateResponse,
  SessionInterruptResponse,
  SessionUsageResponse,
} from "../upstream-src/ui-tui/src/gatewayTypes.js";

export type {
  GatewayEvent,
  PromptSubmitResponse,
  SessionCloseResponse,
  SessionCreateResponse,
  SessionInterruptResponse,
  SessionUsageResponse,
};

export interface HermesGatewayEnvironment {
  upstreamRoot: string;
  hermesHome: string;
  authHome?: string | null;
  cwd: string;
  python?: string | null;
  model?: string | null;
  provider?: string | null;
  startupTimeoutMs?: number | null;
  requestTimeoutMs?: number | null;
  extraEnv?: Record<string, string | null | undefined>;
}

export interface HermesGatewayClient {
  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  drain(): void;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  kill(reason?: string): void;
  getLogTail(limit?: number): string;
  isClosed(): boolean;
}

export class ScopedGatewayClient implements HermesGatewayClient {
  readonly #client = new UpstreamGatewayClient();
  #closed = false;

  constructor(private readonly env: HermesGatewayEnvironment) {
    this.#client.on("exit", () => {
      this.#closed = true;
    });
  }

  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    this.#client.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    this.#client.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  drain(): void {
    this.#client.drain();
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return withHermesGatewayEnvironment(this.env, () => this.#client.request<T>(method, params));
  }

  kill(reason?: string): void {
    this.#closed = true;
    this.#client.kill(reason);
  }

  getLogTail(limit?: number): string {
    return this.#client.getLogTail(limit);
  }

  isClosed(): boolean {
    return this.#closed;
  }
}

export function withHermesGatewayEnvironment<T>(env: HermesGatewayEnvironment, operation: () => T): T {
  const patch: Record<string, string | null | undefined> = {
    HERMES_PYTHON_SRC_ROOT: env.upstreamRoot,
    HERMES_HOME: env.hermesHome,
    HERMES_AUTH_HOME: env.authHome,
    HERMES_CWD: env.cwd,
    TERMINAL_CWD: env.cwd,
    HERMES_PYTHON: env.python,
    HERMES_MODEL: env.model,
    HERMES_TUI_PROVIDER: env.provider,
    HERMES_TUI_STARTUP_TIMEOUT_MS: env.startupTimeoutMs === null || env.startupTimeoutMs === undefined ? undefined : String(env.startupTimeoutMs),
    HERMES_TUI_RPC_TIMEOUT_MS: env.requestTimeoutMs === null || env.requestTimeoutMs === undefined ? undefined : String(env.requestTimeoutMs),
    HERMES_TUI_AGENT_INIT_TIMEOUT_MS:
      env.requestTimeoutMs === null || env.requestTimeoutMs === undefined ? undefined : String(env.requestTimeoutMs),
    HERMES_TUI_GATEWAY_URL: null,
    HERMES_TUI_SIDECAR_URL: null,
    ...(env.extraEnv ?? {}),
  };
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
  }
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
