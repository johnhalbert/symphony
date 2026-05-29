import { afterEach, describe, expect, it } from "vitest";
import { withHermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";

const touchedEnvKeys = [
  "HERMES_API_KEY",
  "HERMES_AUTH_HOME",
  "HERMES_CWD",
  "HERMES_HOME",
  "HERMES_MODEL",
  "HERMES_PYTHON",
  "HERMES_PYTHON_SRC_ROOT",
  "HERMES_TUI_AGENT_INIT_TIMEOUT_MS",
  "HERMES_TUI_GATEWAY_URL",
  "HERMES_TUI_PROVIDER",
  "HERMES_TUI_RPC_TIMEOUT_MS",
  "HERMES_TUI_SIDECAR_URL",
  "HERMES_TUI_STARTUP_TIMEOUT_MS",
  "TERMINAL_CWD",
] as const;

const originalEnv = new Map<string, string | undefined>(
  touchedEnvKeys.map((key) => [key, process.env[key]]),
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
    withSavedEnvironment(
      ["HERMES_HOME", "HERMES_AUTH_HOME", "HERMES_TUI_GATEWAY_URL", "HERMES_API_KEY"],
      () => {
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
      },
    );
  });

  it("passes the request timeout through for deferred Hermes agent initialization", () => {
    withSavedEnvironment(["HERMES_TUI_AGENT_INIT_TIMEOUT_MS"], () => {
      delete process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS;

      const observed = withHermesGatewayEnvironment(
        {
          upstreamRoot: "/repo/hermes",
          hermesHome: "/state/profile",
          cwd: "/workspace",
          requestTimeoutMs: 120_000,
        },
        () => process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS,
      );

      expect(observed).toBe("120000");
      expect(process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS).toBeUndefined();
    });
  });

  it("restores an existing deferred initialization timeout after a scoped request", () => {
    withSavedEnvironment(["HERMES_TUI_AGENT_INIT_TIMEOUT_MS"], () => {
      process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS = "45000";

      const observed = withHermesGatewayEnvironment(
        {
          upstreamRoot: "/repo/hermes",
          hermesHome: "/state/profile",
          cwd: "/workspace",
          requestTimeoutMs: 120_000,
        },
        () => process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS,
      );

      expect(observed).toBe("120000");
      expect(process.env.HERMES_TUI_AGENT_INIT_TIMEOUT_MS).toBe("45000");
    });
  });
});
