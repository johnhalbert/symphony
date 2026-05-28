import { describe, expect, it } from "vitest";
import { CursorHarness } from "../cursor/src/CursorHarness.js";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { createAgentHarness } from "../src/core/harness/HarnessFactory.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";

describe("createAgentHarness", () => {
  it("creates the Cursor harness from config", () => {
    expect(createAgentHarness(config())).toBeInstanceOf(CursorHarness);
  });

  it("creates the Hermes harness from the built-in registry", () => {
    expect(createAgentHarness(config("hermes"))).toBeInstanceOf(HermesHarness);
  });

  it("parses unknown harness ids but fails clearly when no provider is registered", () => {
    const openclaw = config("openclaw");

    expect(openclaw.agent.harness).toBe("openclaw");
    expect(() => createAgentHarness(openclaw)).toThrow(/No runtime harness registered for openclaw/);
  });

  it("creates a non-Cursor harness from an injected registry", () => {
    const harness = createAgentHarness(config("hermes"), {
      registry: {
        hermes: () => new RegistryHarness(),
      },
    });

    expect(harness).toBeInstanceOf(RegistryHarness);
    expect(harness.id).toBe("hermes");
  });
});

class RegistryHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = { continuation: true, mcpHandoff: true };

  async *run(_ctx: AgentRunContext, _prompt: string): AsyncIterable<AgentEvent> {
    yield { type: "completed" };
  }
}

function config(harness = "cursor") {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      agent: { harness, max_turns: 2 },
    },
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "secret" },
  );
}
