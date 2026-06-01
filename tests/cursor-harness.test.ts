import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { mapCursorDelta, mapCursorMessage } from "../cursor/src/CursorEventMapper.js";
import {
  CursorHarness,
  completionReportContextFilePath,
  completionReportMcpServerConfig,
  cursorAgentCreateOptions,
  cursorRoleMcpServers,
  mergeConflictResolutionContextFilePath,
  mergeConflictResolutionMcpServerConfig,
  reviewFeedbackContextFilePath,
  reviewFeedbackMcpServerConfig,
  reviewVerdictContextFilePath,
  reviewVerdictMcpServerConfig,
  transcriptRecallContextFilePath,
  transcriptRecallMcpServerConfig,
} from "../cursor/src/CursorHarness.js";
import { issue, testConfig } from "./helpers.js";
import {
  withWorkerReviewerGithubCommandPolicyProcessEnv,
  workerReviewerGithubCommandPolicyProcessEnv,
} from "../src/core/harness/AgentCommandPolicy.js";
import { createGitWorktree } from "../src/core/workspace/GitWorktreeManager.js";

const cursorSdk = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: cursorSdk.create,
    resume: cursorSdk.resume,
  },
}));

describe("Cursor event mapping", () => {
  beforeEach(() => {
    cursorSdk.create.mockReset();
    cursorSdk.resume.mockReset();
  });

  it("maps assistant text to progress", () => {
    const events = mapCursorMessage({
      type: "assistant",
      agent_id: "agent",
      run_id: "run",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    expect(events).toEqual([{ type: "progress", message: "hello", activitySource: "stream" }]);
  });

  it("tags tool and text delta activity sources", () => {
    expect(mapCursorMessage({ type: "thinking", text: "private chain of thought" } as never)).toEqual([
      { type: "progress", message: "Cursor thinking event", activitySource: "stream" },
    ]);
    expect(mapCursorMessage({ type: "task", text: "private task text" } as never)).toEqual([
      { type: "progress", message: "Cursor task event", activitySource: "stream" },
    ]);
    expect(
      mapCursorMessage({
        type: "tool_call",
        agent_id: "agent",
        run_id: "run",
        call_id: "call",
        name: "shell",
        status: "completed",
      }),
    ).toEqual([{ type: "progress", message: "tool shell completed", activitySource: "tool" }]);
    expect(mapCursorDelta({ type: "text-delta", text: "chunk" })).toEqual([
      { type: "progress", message: "chunk", activitySource: "delta" },
    ]);
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

  it("treats Cursor stream terminal statuses as diagnostics", () => {
    expect(
      mapCursorMessage({
        type: "status",
        agent_id: "agent",
        run_id: "run",
        status: "CANCELLED",
        message: "cancelled by runtime",
      } as never),
    ).toEqual([
      {
        type: "run_diagnostic",
        code: "cursor_stream_status_cancelled",
        message: "cancelled by runtime",
        payload: { status: "CANCELLED" },
      },
    ]);
  });

  it("redacts secret-like assistant, status, and text-delta stream messages", () => {
    const assistantEvents = mapCursorMessage({
      type: "assistant",
      agent_id: "agent",
      run_id: "run",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "assistant saw SECRET_ASSISTANT token=abc123 access_token=access-123 refreshToken: refresh-123 ghp_ABCDEFGH1",
          },
        ],
      },
    });
    const statusEvents = mapCursorMessage({
      type: "status",
      agent_id: "agent",
      run_id: "run",
      status: "ERROR",
      message: "status leaked Authorization: Bearer SECRET_STATUS github_token=github-123 client_secret: client-123",
    } as never);
    const deltaEvents = mapCursorDelta({
      type: "text-delta",
      text: "delta apiKey=SECRET_DELTA private_key=private-123 sk-ABCDEFGH1 inputTokens: 7 totalTokens: 9 tokenConfigured: true",
    });
    const serialized = JSON.stringify([...assistantEvents, ...statusEvents, ...deltaEvents]);

    expect(serialized).not.toContain("SECRET_ASSISTANT");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("access-123");
    expect(serialized).not.toContain("refresh-123");
    expect(serialized).not.toContain("ghp_ABCDEFGH1");
    expect(serialized).not.toContain("SECRET_STATUS");
    expect(serialized).not.toContain("github-123");
    expect(serialized).not.toContain("client-123");
    expect(serialized).not.toContain("SECRET_DELTA");
    expect(serialized).not.toContain("private-123");
    expect(serialized).not.toContain("sk-ABCDEFGH1");
    expect(serialized).toContain("inputTokens: 7");
    expect(serialized).toContain("totalTokens: 9");
    expect(serialized).toContain("tokenConfigured: true");
    expect(serialized).toContain("[redacted]");
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

  it("mounts only the merge conflict resolution MCP server for conflict-fix workers", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.mergePolicy.mode = "gated";
    config.mergePolicy.conflictsState = "Approved with Conflicts";
    const ctx: AgentRunContext = {
      ...agentContext(config, "worker"),
      runPhase: "merge_conflict_resolution",
      issue: issue({ state: "Approved with Conflicts", branchName: "symphony/TEST-1" }),
    };

    const server = mergeConflictResolutionMcpServerConfig(ctx, "/tmp/conflict-context.json", { cliPath: "/repo/src/cli.ts" });
    const mcpServers = cursorRoleMcpServers(ctx, { cliPath: "/repo/src/cli.ts" });
    await new CursorHarness().prepare(ctx);

    expect(Object.keys(mcpServers)).toEqual(["symphony_conflicts"]);
    expect(server.args).toEqual(
      expect.arrayContaining(["merge-conflict-resolution-mcp", "--workflow", config.workflowPath, "--context-file", "/tmp/conflict-context.json"]),
    );
    expect(mcpServers.symphony_conflicts?.args).toEqual(
      expect.arrayContaining([
        "merge-conflict-resolution-mcp",
        "--workflow",
        config.workflowPath,
        "--context-file",
        mergeConflictResolutionContextFilePath(ctx),
      ]),
    );
    expect(mcpServers).not.toHaveProperty("symphony");
    await expect(readFile(mergeConflictResolutionContextFilePath(ctx), "utf8")).resolves.toContain(
      '"phase": "merge_conflict_resolution"',
    );
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


  it("hardens Cursor worker process env around create and send", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const originalPolicy = process.env.SYMPHONY_AGENT_COMMAND_POLICY;
    let createEnv: Record<string, string | undefined> | null = null;
    let sendEnv: Record<string, string | undefined> | null = null;
    const capturePolicyEnv = () => ({
      SYMPHONY_AGENT_COMMAND_POLICY: process.env.SYMPHONY_AGENT_COMMAND_POLICY,
      SYMPHONY_AGENT_ROLE: process.env.SYMPHONY_AGENT_ROLE,
      GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
      GCM_INTERACTIVE: process.env.GCM_INTERACTIVE,
      GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      SYMPHONY_COMMAND_POLICY_SHIM_DIR: process.env.SYMPHONY_COMMAND_POLICY_SHIM_DIR,
      SYMPHONY_REAL_GIT: process.env.SYMPHONY_REAL_GIT,
      PATH: process.env.PATH,
      PYTHONPATH: process.env.PYTHONPATH,
    });
    const send = vi.fn(async () => {
      sendEnv = capturePolicyEnv();
      return completedSdkRun("sdk-run-policy");
    });
    cursorSdk.create.mockImplementation(async () => {
      createEnv = capturePolicyEnv();
      return {
        agentId: "agent-policy",
        send,
        reload: vi.fn(),
        [Symbol.asyncDispose]: vi.fn(),
      };
    });
    const harness = new CursorHarness();

    const events: unknown[] = [];
    for await (const event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
      events.push(event);
    }

    for (const env of [createEnv, sendEnv]) {
      expect(env).not.toBeNull();
      const captured = env as unknown as Record<string, string | undefined>;
      expect(captured).toMatchObject({
        SYMPHONY_AGENT_COMMAND_POLICY: "worker_reviewer_github_upstream_block",
        SYMPHONY_AGENT_ROLE: "worker",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GH_PROMPT_DISABLED: "1",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      });
      expect(captured.SYMPHONY_COMMAND_POLICY_SHIM_DIR).toContain(path.join("command-policy", "TEST-1", "worker", "bin"));
      expect(captured.PATH?.split(path.delimiter)[0]).toBe(captured.SYMPHONY_COMMAND_POLICY_SHIM_DIR);
      expect(captured.SYMPHONY_REAL_GIT).toBeTruthy();
      expect(captured.PYTHONPATH?.split(path.delimiter)[0]).toBe(config.hermes.upstreamRoot);
    }
    expect(process.env.SYMPHONY_AGENT_COMMAND_POLICY).toBe(originalPolicy);
    expect(events).toContainEqual({ type: "completed" });
  });

  it("executes Cursor worker command-policy shims for allowed local git and blocked GitHub tools", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-cursor-policy-"));
    const originalPath = process.env.PATH;
    try {
      const fakeBin = path.join(tempRoot, "real-bin");
      await mkdir(fakeBin, { recursive: true });
      await writeFakeGit(fakeBin);
      process.env.PATH = fakeBin + (originalPath ? path.delimiter + originalPath : "");

      const config = testConfig(path.join(tempRoot, "workspace"));
      config.workspace.stateDir = tempRoot;
      config.hermes.upstreamRoot = path.resolve("hermes/upstream-src");
      config.hermes.python = process.env.PYTHON || "python";
      const env = workerReviewerGithubCommandPolicyProcessEnv(agentContext(config, "worker"));
      const policyPath = env.PATH;

      expect(env.SYMPHONY_COMMAND_POLICY_SHIM_DIR).toBeTruthy();
      expect(policyPath).toBeTruthy();
      expect(policyPath?.split(path.delimiter)[0]).toBe(env.SYMPHONY_COMMAND_POLICY_SHIM_DIR);
      expect(env.SYMPHONY_REAL_GIT).toBe(path.join(fakeBin, process.platform === "win32" ? "git.cmd" : "git"));

      const gitVersion = runPolicyShim(env, "git", ["--version"]);
      expect(gitVersion.status).toBe(0);
      expect(gitVersion.stdout.toLowerCase()).toContain("git version fake");

      const gitStatus = runPolicyShim(env, "git", ["-C", process.cwd(), "status", "--short"]);
      expect(gitStatus.status).toBe(0);

      for (const [tool, args] of [
        ["git", ["fetch", "origin"]],
        ["gh", ["pr", "status"]],
        ["ssh-keyscan", ["github.com"]],
        ["wget", ["https://api.github.com/repos/acme/repo"]],
      ] as const) {
        const blocked = runPolicyShim(env, tool, args);
        expect(blocked.status).toBe(126);
        expect(blocked.stderr).toContain("BLOCKED by Symphony worker/reviewer GitHub command policy");
        expect(blocked.stderr).not.toContain("FAKE_GIT_RAN");
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps service-owned git worktree preparation off Cursor worker policy shims during overlap", async () => {
    if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) return;
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-cursor-service-git-"));
    try {
      const originRepo = path.join(tempRoot, "origin.git");
      const seedRepo = path.join(tempRoot, "seed");
      const serviceRepo = path.join(tempRoot, "service.git");
      const workspacePath = path.join(tempRoot, "workspace", "TEST-1");
      const stateDir = path.join(tempRoot, "state");

      runGitForTest(["init", "--bare", originRepo], tempRoot);
      await mkdir(seedRepo, { recursive: true });
      runGitForTest(["init"], seedRepo);
      await writeFile(path.join(seedRepo, "README.md"), "seed\n", "utf8");
      runGitForTest(["add", "README.md"], seedRepo);
      runGitForTest(["-c", "user.name=Symphony", "-c", "user.email=symphony@example.invalid", "commit", "-m", "seed"], seedRepo);
      runGitForTest(["branch", "-M", "main"], seedRepo);
      runGitForTest(["remote", "add", "origin", originRepo], seedRepo);
      runGitForTest(["push", "origin", "main"], seedRepo);
      runGitForTest(["init", "--bare", serviceRepo], tempRoot);
      runGitForTest(["remote", "add", "origin", originRepo], serviceRepo);

      const config = testConfig(path.join(tempRoot, "workspace"));
      config.workspace.stateDir = stateDir;
      config.hermes.upstreamRoot = path.resolve("hermes/upstream-src");
      config.hermes.python = process.env.PYTHON || "python";

      await withWorkerReviewerGithubCommandPolicyProcessEnv(agentContext(config, "worker"), async () => {
        expect(process.env.SYMPHONY_COMMAND_POLICY_SHIM_DIR).toBeTruthy();
        await createGitWorktree({
          source: { kind: "git_worktree", repository: serviceRepo, baseRef: "main" },
          stateDir,
          workspacePath,
          branchName: "symphony/TEST-1",
          timeoutMs: 10_000,
          logger: new StructuredLogger(() => undefined),
        });
      });

      expect(runGitForTest(["-C", serviceRepo, "rev-parse", "--verify", "origin/main"], tempRoot).status).toBe(0);
      expect(runGitForTest(["-C", workspacePath, "status", "--short"], tempRoot).status).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes configured plan mode to worker create and send options", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.cursor.mode = "plan";
    const send = vi.fn(async () => completedSdkRun("sdk-run-plan"));
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-plan",
      send,
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    });
    const harness = new CursorHarness();

    const events: unknown[] = [];
    for await (const event of harness.run(agentContext(config, "worker"), "Plan TEST-1")) {
      events.push(event);
    }

    expect(cursorSdk.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan" }));
    expect(send).toHaveBeenCalledWith("Plan TEST-1", expect.objectContaining({ mode: "plan" }));
    expect(events).toContainEqual({ type: "completed" });
  });

  it("uses plan mode with planning MCP for issue breakdown runs", () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const ctx: AgentRunContext = {
      ...agentContext(config, "worker"),
      runPhase: "issue_breakdown",
      runModeOverride: "plan",
    };

    const mcpServers = cursorRoleMcpServers(ctx, { cliPath: "/repo/src/cli.ts" });
    const createOptions = cursorAgentCreateOptions(ctx, "cursor-test-key", { mcpServers });

    expect(Object.keys(mcpServers)).toEqual(["symphony_planning"]);
    expect(createOptions).toMatchObject({ mode: "plan" });
  });

  it("mounts read-only transcript recall as a separate MCP server when search is enabled", () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.continuationContext.searchEnabled = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-secret";
    const ctx = agentContext(config, "worker");

    const server = transcriptRecallMcpServerConfig(ctx, transcriptRecallContextFilePath(ctx), { cliPath: "/repo/src/cli.ts" });
    const mcpServers = cursorRoleMcpServers(ctx, { cliPath: "/repo/src/cli.ts" });

    expect(Object.keys(mcpServers).sort()).toEqual(["symphony", "symphony_recall"]);
    expect(server.args).toEqual(
      expect.arrayContaining(["transcript-recall-mcp", "--workflow", config.workflowPath, "--context-file", transcriptRecallContextFilePath(ctx)]),
    );
    expect(server.env).toMatchObject({ LINEAR_API_KEY: "linear-test-key" });
    expect(server.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(server.env).not.toHaveProperty("CURSOR_API_KEY");
  });

  it("uses profile-backed runtime.cursor credentials by default for worker and reviewer runs", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: "/tmp/symphony-cursor-harness" },
        credential_profiles: {
          profiles: {
            workerCursor: { value: "$WORKER_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
            reviewerCursor: { value: "$REVIEWER_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
          },
          roles: {
            worker: { "runtime.cursor": "workerCursor" },
            reviewer: { "runtime.cursor": "reviewerCursor" },
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

  it("writes MCP context without creating or resuming managed worker agents during prepare or reload in fresh mode", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const harness = new CursorHarness();
    const ctx = agentContext(config, "worker");

    await harness.prepare(ctx);
    await harness.reload(ctx);

    expect(cursorSdk.create).not.toHaveBeenCalled();
    expect(cursorSdk.resume).not.toHaveBeenCalled();
    await expect(readFile(completionReportContextFilePath(ctx), "utf8")).resolves.toContain('"activeRunId": null');
  });

  it("creates and disposes a fresh worker agent for each managed run by default", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const dispose = vi.fn(async () => undefined);
    const send = vi.fn(async () => completedSdkRun("sdk-run-fresh"));
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-fresh",
      send,
      reload: vi.fn(),
      [Symbol.asyncDispose]: dispose,
    });
    const runStore = {
      latestRunForIssue: vi.fn(),
      updateRun: vi.fn(),
      appendEvent: vi.fn(),
    };
    const harness = new CursorHarness({ runStore: runStore as never });

    const events: unknown[] = [];
    for await (const event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
      events.push(event);
    }

    expect(cursorSdk.resume).not.toHaveBeenCalled();
    expect(runStore.latestRunForIssue).not.toHaveBeenCalled();
    expect(cursorSdk.create).toHaveBeenCalledTimes(1);
    const sendOptions = (send as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } }).mock.calls[0]?.[1];
    expect(sendOptions).toBeDefined();
    expect(sendOptions).not.toHaveProperty("mode");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "sdk-run-fresh",
        eventType: "cursor_agent_lifecycle",
        payload: expect.objectContaining({
          agentId: "agent-fresh",
          created: true,
          resumeUsed: false,
          outcome: "created",
        }),
      }),
    );
    expect(runStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "sdk-run-fresh",
        eventType: "cursor_agent_disposed",
        payload: expect.objectContaining({ agentId: "agent-fresh", ok: true }),
      }),
    );
    expect(events).toEqual([
      { type: "session_started", sessionId: "agent-fresh:sdk-run-fresh", threadId: "agent-fresh", runId: "sdk-run-fresh" },
      expect.objectContaining({ type: "run_status", runId: "sdk-run-fresh", sdkStatus: "finished", source: "wait" }),
      { type: "completed" },
    ]);
  });

  it("buffers SDK status observations until after session_started", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const onDidChangeStatus = vi.fn(() => () => undefined);
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-status",
      send: vi.fn(async () => ({
        id: "sdk-run-status",
        status: "running",
        onDidChangeStatus,
        async *stream(): AsyncIterable<unknown> {},
        wait: async () => ({ status: "finished" as const, result: undefined }),
        cancel: vi.fn(async () => undefined),
      })),
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    });
    const harness = new CursorHarness();

    const events: unknown[] = [];
    for await (const event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
      events.push(event);
    }

    expect(onDidChangeStatus).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "session_started", sessionId: "agent-status:sdk-run-status", threadId: "agent-status", runId: "sdk-run-status" },
      expect.objectContaining({ type: "run_status", runId: "sdk-run-status", sdkStatus: "running", source: "initial" }),
      expect.objectContaining({ type: "run_status", runId: "sdk-run-status", sdkStatus: "finished", source: "wait" }),
      { type: "completed" },
    ]);
  });

  it("disposes a fresh worker agent when send fails", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const dispose = vi.fn(async () => undefined);
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-send-fails",
      send: vi.fn(async () => {
        throw new Error("send failed");
      }),
      reload: vi.fn(),
      [Symbol.asyncDispose]: dispose,
    });
    const harness = new CursorHarness();

    await expect(async () => {
      for await (const _event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
        // no events expected
      }
    }).rejects.toThrow("send failed");

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("sanitizes raw Cursor stream payloads before persisting transcript events", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const dispose = vi.fn(async () => undefined);
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-sanitize",
      send: vi.fn(async () => ({
        id: "sdk-run-sanitize",
        async *stream(): AsyncIterable<unknown> {
          yield { type: "user", message: { content: "SECRET_PROMPT access_token=user-access-token" } };
          yield { type: "thinking", text: "SECRET_THINKING refreshToken=thinking-refresh-token" };
          yield { type: "task", text: "SECRET_TASK github_token=task-github-token" };
          yield {
            type: "tool_call",
            name: "shell",
            status: "completed",
            arguments: "SECRET_ARGS client_secret=args-client-secret",
            result: "SECRET_RESULT private_key=result-private-key",
            output: "SECRET_OUTPUT ghp_ABCDEFGH1",
            error: "SECRET_ERROR sk-ABCDEFGH1",
          };
        },
        wait: async () => ({ status: "finished" as const, result: undefined }),
        cancel: vi.fn(async () => undefined),
      })),
      reload: vi.fn(),
      [Symbol.asyncDispose]: dispose,
    });
    const runStore = {
      latestRunForIssue: vi.fn(),
      updateRun: vi.fn(),
      appendEvent: vi.fn(),
    };
    const harness = new CursorHarness({ runStore: runStore as never });

    const events: unknown[] = [];
    for await (const event of harness.run(agentContext(config, "worker"), "SECRET_PROMPT")) {
      events.push(event);
    }

    const persisted = JSON.stringify(runStore.appendEvent.mock.calls);
    expect(persisted).not.toContain("SECRET_PROMPT");
    expect(persisted).not.toContain("SECRET_THINKING");
    expect(persisted).not.toContain("SECRET_TASK");
    expect(persisted).not.toContain("SECRET_ARGS");
    expect(persisted).not.toContain("SECRET_RESULT");
    expect(persisted).not.toContain("SECRET_OUTPUT");
    expect(persisted).not.toContain("SECRET_ERROR");
    expect(persisted).not.toContain("user-access-token");
    expect(persisted).not.toContain("thinking-refresh-token");
    expect(persisted).not.toContain("task-github-token");
    expect(persisted).not.toContain("args-client-secret");
    expect(persisted).not.toContain("result-private-key");
    expect(persisted).not.toContain("ghp_ABCDEFGH1");
    expect(persisted).not.toContain("sk-ABCDEFGH1");
    expect(runStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "thinking",
        message: "Cursor thinking event",
        payload: expect.objectContaining({ kind: "thinking", summary: expect.stringContaining("[redacted]") }),
      }),
    );
    expect(runStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "task",
        message: "Cursor task event",
        payload: expect.objectContaining({ kind: "task", summary: expect.stringContaining("[redacted]") }),
      }),
    );
    expect(runStore.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool_call",
        message: "tool shell completed",
        payload: expect.objectContaining({
          kind: "tool_call",
          name: "shell",
          status: "completed",
          argumentsPreview: expect.stringContaining("[redacted]"),
          resultPreview: expect.stringContaining("[redacted]"),
          outputPreview: expect.stringContaining("[redacted]"),
          errorPreview: expect.stringContaining("[redacted]"),
        }),
      }),
    );
    expect(events).toContainEqual({ type: "progress", message: "Cursor thinking event", activitySource: "stream" });
    expect(events).toContainEqual({ type: "progress", message: "Cursor task event", activitySource: "stream" });
  });

  it("redacts terminal wait results before emitting public events", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-terminal-secret",
      send: vi.fn(async () => ({
        id: "sdk-run-terminal-secret",
        async *stream(): AsyncIterable<unknown> {},
        wait: async () => ({ status: "error" as const, result: "terminal failed with SECRET_TERMINAL token=raw-token" }),
        cancel: vi.fn(async () => undefined),
      })),
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    });
    const harness = new CursorHarness();
    const events: unknown[] = [];

    for await (const event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
      events.push(event);
    }

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SECRET_TERMINAL");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).toContain("[redacted]");
    expect(events.at(-1)).toEqual({ type: "failed", error: "terminal failed with [redacted] token=[redacted]" });
  });

  it("only resumes worker agents when resume_by_issue compatibility mode is explicit", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.cursor.workerAgentLifecycle = "resume_by_issue";
    const agent = {
      agentId: "agent-reused",
      send: vi.fn(),
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    };
    cursorSdk.resume.mockResolvedValue(agent);
    const runStore = {
      latestRunForIssue: vi.fn(async () => ({ agentId: "agent-previous" })),
    };
    const harness = new CursorHarness({ runStore: runStore as never });

    await harness.prepare(agentContext(config, "worker"));
    await harness.reload(agentContext(config, "worker"));

    expect(runStore.latestRunForIssue).toHaveBeenCalledTimes(1);
    expect(cursorSdk.resume).toHaveBeenCalledTimes(1);
    expect(cursorSdk.resume).toHaveBeenCalledWith("agent-previous", expect.any(Object));
    expect(agent.reload).toHaveBeenCalledTimes(1);
    expect(cursorSdk.create).not.toHaveBeenCalled();
  });

  it("keeps resume options mode-free while configured sends request plan mode", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    config.cursor.mode = "plan";
    config.cursor.workerAgentLifecycle = "resume_by_issue";
    const send = vi.fn(async () => completedSdkRun("sdk-run-resumed-plan"));
    const agent = {
      agentId: "agent-resumed-plan",
      send,
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    };
    cursorSdk.resume.mockResolvedValue(agent);
    const runStore = {
      latestRunForIssue: vi.fn(async () => ({ agentId: "agent-previous-plan" })),
      updateRun: vi.fn(),
      appendEvent: vi.fn(),
    };
    const harness = new CursorHarness({ runStore: runStore as never });

    for await (const _event of harness.run(agentContext(config, "worker"), "Plan TEST-1")) {
      // drain events
    }

    expect(cursorSdk.resume).toHaveBeenCalledTimes(1);
    expect(cursorSdk.resume.mock.calls[0]?.[1]).not.toHaveProperty("mode");
    expect(send).toHaveBeenCalledWith("Plan TEST-1", expect.objectContaining({ mode: "plan" }));
  });

  it("cancels the SDK run through the abort signal when cancellation happens before session_started", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const controller = new AbortController();
    const sendDeferred = deferred<{
      id: string;
      stream(): AsyncIterable<unknown>;
      wait(): Promise<{ status: "cancelled" }>;
      cancel(): Promise<void>;
    }>();
    const cancel = vi.fn(async () => undefined);
    const run = {
      id: "sdk-run-1",
      async *stream(): AsyncIterable<unknown> {},
      wait: async () => ({ status: "cancelled" as const }),
      cancel,
    };
    const send = vi.fn(() => sendDeferred.promise);
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-1",
      send,
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    });
    const harness = new CursorHarness();
    const iterator = harness.run(
      {
        ...agentContext(config, "worker"),
        abortSignal: controller.signal,
      },
      "Work on TEST-1",
    )[Symbol.asyncIterator]();

    const firstEvent = iterator.next();
    await waitFor(() => send.mock.calls.length === 1, "agent send to start");
    controller.abort();
    await harness.stop("issue-1");
    expect(cancel).not.toHaveBeenCalled();

    sendDeferred.resolve(run);
    await expect(firstEvent).resolves.toMatchObject({
      value: {
        type: "session_started",
        runId: "sdk-run-1",
      },
      done: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await iterator.return?.();
  });

  it("uses SDK wait as the terminal source when the stream fails", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    const dispose = vi.fn(async () => {
      throw new Error("dispose auth failure");
    });
    const run = {
      id: "sdk-run-auth",
      async *stream(): AsyncIterable<unknown> {
        throw new Error("authentication stream failure");
      },
      wait: vi.fn(async () => ({ status: "failed" as const, result: "wait should not run" })),
      cancel: vi.fn(async () => undefined),
    };
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-auth",
      send: vi.fn(async () => run),
      reload: vi.fn(),
      [Symbol.asyncDispose]: dispose,
    });
    const harness = new CursorHarness();
    const events: unknown[] = [];

    for await (const event of harness.run(agentContext(config, "reviewer"), "Review TEST-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "session_started",
        sessionId: "agent-auth:sdk-run-auth",
        threadId: "agent-auth",
        runId: "sdk-run-auth",
      },
      expect.objectContaining({
        type: "run_diagnostic",
        code: "cursor_stream_error",
        message: "Cursor stream failed: authentication stream failure",
      }),
      expect.objectContaining({ type: "run_status", runId: "sdk-run-auth", sdkStatus: "error", source: "wait" }),
      expect.objectContaining({
        type: "run_diagnostic",
        code: "cursor_run_wait_terminal_error",
        payload: expect.objectContaining({
          runId: "sdk-run-auth",
          agentId: "agent-auth",
          sdkStatus: "error",
          sdkStatusSource: "wait",
          waitResultMessage: "wait should not run",
        }),
      }),
      { type: "failed", error: "wait should not run" },
    ]);
    expect(run.wait).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("emits bounded wait diagnostics with last tool context", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-wait-error",
      send: vi.fn(async () => ({
        id: "sdk-run-wait-error",
        async *stream(): AsyncIterable<unknown> {
          yield { type: "tool_call", name: "shell", status: "running", arguments: "SECRET_ARGS" };
        },
        wait: async () => ({ status: "error" as const, result: "runtime failed with details" }),
        cancel: vi.fn(async () => undefined),
      })),
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    });
    const harness = new CursorHarness();
    const events: unknown[] = [];

    for await (const event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
      events.push(event);
    }

    const diagnostic = events.find(
      (event): event is { type: "run_diagnostic"; code: string; payload: { lastTool?: unknown } } =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "run_diagnostic" &&
        "code" in event &&
        event.code === "cursor_run_wait_terminal_error",
    );
    expect(diagnostic).toBeDefined();
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET_ARGS");
    expect(diagnostic?.payload).toMatchObject({
      runId: "sdk-run-wait-error",
      agentId: "agent-wait-error",
      sdkStatus: "error",
      sdkStatusSource: "wait",
      waitResultMessage: "runtime failed with details",
      lastTool: { name: "shell", status: "running" },
    });
    expect(events.at(-1)).toEqual({ type: "failed", error: "runtime failed with details" });
  });

  it("emits SDK error status when run.wait throws", async () => {
    const config = testConfig("/tmp/symphony-cursor-harness");
    cursorSdk.create.mockResolvedValue({
      agentId: "agent-wait-throw",
      send: vi.fn(async () => ({
        id: "sdk-run-wait-throw",
        async *stream(): AsyncIterable<unknown> {},
        wait: async () => {
          throw new Error("wait exploded");
        },
        cancel: vi.fn(async () => undefined),
      })),
      reload: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    });
    const harness = new CursorHarness();
    const events: unknown[] = [];

    for await (const event of harness.run(agentContext(config, "worker"), "Work on TEST-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "session_started", sessionId: "agent-wait-throw:sdk-run-wait-throw", threadId: "agent-wait-throw", runId: "sdk-run-wait-throw" },
      expect.objectContaining({ type: "run_status", runId: "sdk-run-wait-throw", sdkStatus: "error", source: "wait" }),
      expect.objectContaining({
        type: "run_diagnostic",
        code: "cursor_run_wait_threw",
        payload: expect.objectContaining({ runId: "sdk-run-wait-throw", errorPreview: "wait exploded" }),
      }),
      { type: "failed", error: "Cursor run wait failed: wait exploded" },
    ]);
  });
});

async function writeFakeGit(binDir: string): Promise<void> {
  const filePath = path.join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  const content = process.platform === "win32"
    ? [
        "@echo off",
        "if \"%~1\"==\"--version\" echo git version fake&& exit /b 0",
        "if \"%~1\"==\"-C\" exit /b 0",
        "echo FAKE_GIT_RAN 1>&2",
        "exit /b 99",
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'git version fake'; exit 0; fi",
        "if [ \"$1\" = \"-C\" ]; then exit 0; fi",
        "echo FAKE_GIT_RAN >&2",
        "exit 99",
        "",
      ].join("\n");
  await writeFile(filePath, content, "utf8");
  if (process.platform !== "win32") await chmod(filePath, 0o755);
}

function runGitForTest(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runPolicyShim(
  env: Record<string, string>,
  tool: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const shimDir = env.SYMPHONY_COMMAND_POLICY_SHIM_DIR;
  if (!shimDir) throw new Error("Missing SYMPHONY_COMMAND_POLICY_SHIM_DIR in policy env");
  const executable = path.join(shimDir, process.platform === "win32" ? `${tool}.cmd` : tool);
  const result = spawnSync(executable, [...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function completedSdkRun(id: string): {
  id: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{ status: "finished"; result: undefined }>;
  cancel(): Promise<void>;
} {
  return {
    id,
    async *stream(): AsyncIterable<unknown> {},
    wait: async () => ({ status: "finished" as const, result: undefined }),
    cancel: vi.fn(async () => undefined),
  };
}

async function waitFor(predicate: () => boolean, description = "condition", timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
}
