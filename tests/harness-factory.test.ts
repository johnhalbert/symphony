import { describe, expect, it } from "vitest";
import { CursorHarness } from "../cursor/src/CursorHarness.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { createAgentHarness } from "../src/core/harness/HarnessFactory.js";

describe("createAgentHarness", () => {
  it("creates the Cursor harness from config", () => {
    expect(createAgentHarness(config())).toBeInstanceOf(CursorHarness);
  });
});

function config() {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      agent: { harness: "cursor", max_turns: 2 },
    },
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "secret" },
  );
}
