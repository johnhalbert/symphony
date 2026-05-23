import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { mapCursorDelta, mapCursorMessage } from "../cursor/src/CursorEventMapper.js";
import {
  completionReportContextFilePath,
  completionReportMcpServerConfig,
  cursorAgentCreateOptions,
  cursorRoleMcpServers,
  reviewFeedbackContextFilePath,
  reviewFeedbackMcpServerConfig,
  reviewVerdictContextFilePath,
  reviewVerdictMcpServerConfig,
} from "../cursor/src/CursorHarness.js";
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

    const server = completionReportMcpServerConfig(ctx, "/tmp/context.json", { cliPath: "/repo/src/cli.ts" });
    const args = server.args as string[];

    expect(server).toMatchObject({
      type: "stdio",
      command: process.execPath,
      cwd: config.workflowDir,
    });
    expect(args).toEqual(
      expect.arrayContaining(["completion-report-mcp", "--workflow", config.workflowPath, "--context-file", "/tmp/context.json"]),
    );
    expect(args).toContain("/repo/src/cli.ts");
    expect(completionReportContextFilePath(ctx)).toBe(path.join(config.workspace.stateDir, "completion-report-mcp", "issue-1-1.json"));
    expect(server.env).toMatchObject({ LINEAR_API_KEY: "linear-test-key" });
    expect(server.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(server.env).not.toHaveProperty("CURSOR_API_KEY");
  });

  it("mounts worker MCP servers on Cursor agent create/resume options", () => {
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

    const mcpServers = cursorRoleMcpServers(ctx, { cliPath: "/repo/src/cli.ts" });
    const createOptions = cursorAgentCreateOptions(ctx, "cursor-test-key", { mcpServers });

    expect(Object.keys(mcpServers)).toEqual(["symphony"]);
    expect(createOptions).toMatchObject({
      apiKey: "cursor-test-key",
      mcpServers: {
        symphony: {
          type: "stdio",
          command: process.execPath,
          cwd: config.workflowDir,
        },
      },
    });
    expect(mcpServers.symphony?.args).toEqual(
      expect.arrayContaining(["completion-report-mcp", "--workflow", config.workflowPath]),
    );
  });

  it("uses profile-backed cursor.runtime credentials by default for worker and reviewer runs", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: "/tmp/symphony-cursor-harness" },
        credential_profiles: {
          profiles: {
            workerCursor: { value: "$WORKER_CURSOR_TOKEN", capabilities: ["cursor.runtime"] },
            reviewerCursor: { value: "$REVIEWER_CURSOR_TOKEN", capabilities: ["cursor.runtime"] },
          },
          roles: {
            worker: { "cursor.runtime": "workerCursor" },
            reviewer: { "cursor.runtime": "reviewerCursor" },
          },
        },
      },
      "/tmp/symphony-cursor-harness/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        CURSOR_API_KEY: "decoy-cursor-secret",
        WORKER_CURSOR_TOKEN: "worker-cursor-secret",
        REVIEWER_CURSOR_TOKEN: "reviewer-cursor-secret",
      },
    );

    expect(cursorAgentCreateOptions(agentContext(config, "worker"))).toMatchObject({
      apiKey: "worker-cursor-secret",
    });
    expect(cursorAgentCreateOptions(agentContext(config, "reviewer"))).toMatchObject({
      apiKey: "reviewer-cursor-secret",
    });
  });

  it("wires the Symphony review verdict MCP server into reviewer Cursor runs", () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const ctx: AgentRunContext = {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      role: "reviewer",
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

    const server = reviewVerdictMcpServerConfig(ctx, "/tmp/review-context.json", { cliPath: "/repo/src/cli.ts" });
    const args = server.args as string[];

    expect(server).toMatchObject({
      type: "stdio",
      command: process.execPath,
      cwd: config.workflowDir,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "review-verdict-mcp",
        "--workflow",
        config.workflowPath,
        "--context-file",
        "/tmp/review-context.json",
      ]),
    );
    expect(args).toContain("/repo/src/cli.ts");
    expect(reviewVerdictContextFilePath(ctx)).toBe(path.join(config.workspace.stateDir, "review-verdict-mcp", "issue-1-1.json"));
    expect(server.env).toMatchObject({ LINEAR_API_KEY: "linear-test-key" });
    expect(server.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(server.env).not.toHaveProperty("CURSOR_API_KEY");
  });

  it("wires the Symphony review feedback MCP server separately for reviewer Cursor runs", () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "feedback-secret";
    const ctx: AgentRunContext = {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      role: "reviewer",
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

    const server = reviewFeedbackMcpServerConfig(ctx, "/tmp/review-feedback-context.json", { cliPath: "/repo/src/cli.ts" });
    const args = server.args as string[];

    expect(server).toMatchObject({
      type: "stdio",
      command: process.execPath,
      cwd: config.workflowDir,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "review-feedback-mcp",
        "--workflow",
        config.workflowPath,
        "--context-file",
        "/tmp/review-feedback-context.json",
      ]),
    );
    expect(args).toContain("/repo/src/cli.ts");
    expect(reviewFeedbackContextFilePath(ctx)).toBe(path.join(config.workspace.stateDir, "review-feedback-mcp", "issue-1-1.json"));
    expect(server.env).toMatchObject({ LINEAR_API_KEY: "linear-test-key", GITHUB_TOKEN: "feedback-secret" });
    expect(server.env).not.toHaveProperty("CURSOR_API_KEY");
  });

  it("mounts both reviewer MCP servers on Cursor agent create/resume options", () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "feedback-secret";
    const ctx: AgentRunContext = {
      issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      role: "reviewer",
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

    const mcpServers = cursorRoleMcpServers(ctx, { cliPath: "/repo/src/cli.ts" });
    const createOptions = cursorAgentCreateOptions(ctx, "cursor-test-key", { mcpServers });

    expect(Object.keys(mcpServers).sort()).toEqual(["symphony_review_feedback", "symphony_review_verdict"]);
    expect(createOptions.mcpServers).toMatchObject({
      symphony_review_verdict: { type: "stdio", command: process.execPath, cwd: config.workflowDir },
      symphony_review_feedback: { type: "stdio", command: process.execPath, cwd: config.workflowDir },
    });
    expect(mcpServers.symphony_review_verdict?.args).toEqual(expect.arrayContaining(["review-verdict-mcp"]));
    expect(mcpServers.symphony_review_feedback?.args).toEqual(expect.arrayContaining(["review-feedback-mcp"]));
  });
});

function agentContext(config: ReturnType<typeof parseServiceConfig>, role: "worker" | "reviewer"): AgentRunContext {
  return {
    issue: issue({ state: role === "reviewer" ? "In Review" : "In Progress", branchName: "symphony/TEST-1" }),
    role,
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
}
