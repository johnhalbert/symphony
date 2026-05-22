import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { mapCursorDelta, mapCursorMessage } from "../cursor/src/CursorEventMapper.js";
import { completionReportMcpServerConfig } from "../cursor/src/CursorHarness.js";
import { issue, testConfig } from "./helpers.js";

describe("Cursor event mapping", () => {
  it("maps assistant text to progress", () => {
    const events = mapCursorMessage({
      type: "assistant",
      agent_id: "agent",
      run_id: "run",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    expect(events).toEqual([{ type: "progress", message: "hello" }]);
  });

  it("maps turn-ended usage into token totals", () => {
    const events = mapCursorDelta({
      type: "turn-ended",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    expect(events).toEqual([{ type: "tokens", tokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }]);
  });

  it("wires the Symphony completion report MCP server into Cursor runs", () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const ctx: AgentRunContext = {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      role: "worker",
      attempt: null,
      workspace: {
        path: "/tmp/workspace",
        workspaceKey: "TEST-1",
        createdNow: false,
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
      config,
      turnNumber: 1,
      abortSignal: new AbortController().signal,
      logger: new StructuredLogger(() => undefined),
    };

    const server = completionReportMcpServerConfig(ctx, "/tmp/context.json");
    const args = server.args as string[];

    expect(server).toMatchObject({
      type: "stdio",
      command: process.execPath,
      cwd: config.workflowDir,
    });
    expect(args).toEqual(
      expect.arrayContaining(["completion-report-mcp", "--workflow", config.workflowPath, "--context-file", "/tmp/context.json"]),
    );
  });
});
