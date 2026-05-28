import { describe, expect, it } from "vitest";
import { withHermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";

describe("withHermesGatewayEnvironment", () => {
  it("scopes Hermes gateway environment overrides to a synchronous request start", () => {
    process.env.HERMES_HOME = "original-home";
    process.env.HERMES_AUTH_HOME = "original-auth-home";
    process.env.HERMES_TUI_GATEWAY_URL = "ws://existing";

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
    delete process.env.HERMES_AUTH_HOME;
  });

  it("passes the request timeout through for deferred Hermes agent initialization", () => {
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
