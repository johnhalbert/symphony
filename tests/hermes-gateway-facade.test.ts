import { afterEach, describe, expect, it } from "vitest";
import { withHermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";

const GATEWAY_ENV_KEYS = [
  "HERMES_PYTHON_SRC_ROOT",
  "HERMES_HOME",
  "HERMES_AUTH_HOME",
  "HERMES_CWD",
  "TERMINAL_CWD",
  "HERMES_PYTHON",
  "HERMES_MODEL",
  "HERMES_TUI_PROVIDER",
  "HERMES_TUI_STARTUP_TIMEOUT_MS",
  "HERMES_TUI_RPC_TIMEOUT_MS",
  "HERMES_TUI_AGENT_INIT_TIMEOUT_MS",
  "HERMES_TUI_GATEWAY_URL",
  "HERMES_TUI_SIDECAR_URL",
  "HERMES_API_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>(
  GATEWAY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function withSavedEnvironment<T>(keys: readonly string[], operation: () => T): T {
  const previous = new Map(keys.map((key) => [key, process.env[key]] as const));
  try {
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

describe("withHermesGatewayEnvironment", () => {
  it("scopes Hermes gateway environment overrides to a synchronous request start", () => {
    withSavedEnvironment(GATEWAY_ENV_KEYS, () => {
      process.env.HERMES_HOME = "original-home";
      process.env.HERMES_AUTH_HOME = "original-auth-home";
      process.env.HERMES_TUI_GATEWAY_URL = "ws://existing";
      delete process.env.HERMES_API_KEY;

      const observed = withHermesGatewayEnvironment(
        {
          upstreamRoot: "/repo/hermes",
          hermesHome: "/state/profile",
          authHome: "/state/auth",
          cwd: "/workspace",
          python: "python3",
          model: "model-a",
          provider: "openai",
          extraEnv: { HERMES_API_KEY: "secret" },
        },
        () => ({
          home: process.env.HERMES_HOME,
          authHome: process.env.HERMES_AUTH_HOME,
          cwd: process.env.HERMES_CWD,
          terminalCwd: process.env.TERMINAL_CWD,
          python: process.env.HERMES_PYTHON,
          model: process.env.HERMES_MODEL,
          provider: process.env.HERMES_TUI_PROVIDER,
          agentInitTimeout: process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS,
          gatewayUrl: process.env.HERMES_TUI_GATEWAY_URL,
          apiKey: process.env.HERMES_API_KEY,
        }),
      );

      expect(observed).toEqual({
        home: "/state/profile",
        authHome: "/state/auth",
        cwd: "/workspace",
        terminalCwd: "/workspace",
        python: "python3",
        model: "model-a",
        provider: "openai",
        agentInitTimeout: undefined,
        gatewayUrl: undefined,
        apiKey: "secret",
      });
      expect(process.env.HERMES_HOME).toBe("original-home");
      expect(process.env.HERMES_AUTH_HOME).toBe("original-auth-home");
      expect(process.env.HERMES_TUI_GATEWAY_URL).toBe("ws://existing");
      expect(process.env.HERMES_API_KEY).toBeUndefined();
    });
  });

  it("restores ambient gateway environment and credentials after scoped overrides", () => {
    withSavedEnvironment(GATEWAY_ENV_KEYS, () => {
      for (const key of GATEWAY_ENV_KEYS) {
        process.env[key] = `ambient-${key}`;
      }

      const observed = withHermesGatewayEnvironment(
        {
          upstreamRoot: "/repo/hermes",
          hermesHome: "/state/profile",
          authHome: "/state/auth",
          cwd: "/workspace",
          python: "python3",
          model: "model-a",
          provider: "openai",
          startupTimeoutMs: 15_000,
          requestTimeoutMs: 120_000,
          extraEnv: { HERMES_API_KEY: "scoped-key" },
        },
        () => ({
          pythonRoot: process.env.HERMES_PYTHON_SRC_ROOT,
          home: process.env.HERMES_HOME,
          authHome: process.env.HERMES_AUTH_HOME,
          cwd: process.env.HERMES_CWD,
          terminalCwd: process.env.TERMINAL_CWD,
          python: process.env.HERMES_PYTHON,
          model: process.env.HERMES_MODEL,
          provider: process.env.HERMES_TUI_PROVIDER,
          startupTimeout: process.env.HERMES_TUI_STARTUP_TIMEOUT_MS,
          rpcTimeout: process.env.HERMES_TUI_RPC_TIMEOUT_MS,
          agentInitTimeout: process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS,
          gatewayUrl: process.env.HERMES_TUI_GATEWAY_URL,
          sidecarUrl: process.env.HERMES_TUI_SIDECAR_URL,
          apiKey: process.env.HERMES_API_KEY,
        }),
      );

      expect(observed).toEqual({
        pythonRoot: "/repo/hermes",
        home: "/state/profile",
        authHome: "/state/auth",
        cwd: "/workspace",
        terminalCwd: "/workspace",
        python: "python3",
        model: "model-a",
        provider: "openai",
        startupTimeout: "15000",
        rpcTimeout: "120000",
        agentInitTimeout: "120000",
        gatewayUrl: undefined,
        sidecarUrl: undefined,
        apiKey: "scoped-key",
      });
      for (const key of GATEWAY_ENV_KEYS) {
        expect(process.env[key]).toBe(`ambient-${key}`);
      }
    });
  });

  it("passes the request timeout through for deferred Hermes agent initialization", () => {
    withSavedEnvironment(GATEWAY_ENV_KEYS, () => {
      delete process.env.HERMES_TUI_RPC_TIMEOUT_MS;
      delete process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS;

      const observed = withHermesGatewayEnvironment(
        {
          upstreamRoot: "/repo/hermes",
          hermesHome: "/state/profile",
          cwd: "/workspace",
          requestTimeoutMs: 120_000,
        },
        () => ({
          rpcTimeout: process.env.HERMES_TUI_RPC_TIMEOUT_MS,
          agentInitTimeout: process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS,
        }),
      );

      expect(observed).toEqual({
        rpcTimeout: "120000",
        agentInitTimeout: "120000",
      });
      expect(process.env.HERMES_TUI_RPC_TIMEOUT_MS).toBeUndefined();
      expect(process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS).toBeUndefined();
    });
  });

  it("restores existing deferred initialization timeouts after a scoped request", () => {
    withSavedEnvironment(GATEWAY_ENV_KEYS, () => {
      process.env.HERMES_TUI_RPC_TIMEOUT_MS = "30000";
      process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS = "45000";

      const observed = withHermesGatewayEnvironment(
        {
          upstreamRoot: "/repo/hermes",
          hermesHome: "/state/profile",
          cwd: "/workspace",
          requestTimeoutMs: 120_000,
        },
        () => ({
          rpcTimeout: process.env.HERMES_TUI_RPC_TIMEOUT_MS,
          agentInitTimeout: process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS,
        }),
      );

      expect(observed).toEqual({
        rpcTimeout: "120000",
        agentInitTimeout: "120000",
      });
      expect(process.env.HERMES_TUI_RPC_TIMEOUT_MS).toBe("30000");
      expect(process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS).toBe("45000");
    });
  });
});
