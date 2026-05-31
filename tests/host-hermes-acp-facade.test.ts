import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  HostHermesAcpStdioJsonRpcFacade,
  parseHostHermesAcpJsonRpcLine,
  stringifyHostHermesAcpJsonRpcMessage,
  type HostHermesAcpChildProcess,
  type HostHermesAcpDiagnostic,
  type HostHermesAcpJsonRpcMessage,
  type HostHermesAcpProcessExit,
  type HostHermesAcpSpawnOptions,
} from "../hermes/src/HostHermesAcpFacade.js";
import { buildHostHermesAcpLaunchCommand } from "../hermes/src/HostHermesAcpProfileLease.js";

class FakeChildProcess extends EventEmitter implements HostHermesAcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  readonly pid = 42;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  close(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

interface SpawnCall {
  file: string;
  args: readonly string[];
  options: HostHermesAcpSpawnOptions;
}

function createSpawnedFacade(options: { requestTimeoutMs?: number; stderrTailBytes?: number } = {}) {
  const child = new FakeChildProcess();
  const spawnCalls: SpawnCall[] = [];
  const writes = collectJsonRpcWrites(child.stdin);
  const facade = HostHermesAcpStdioJsonRpcFacade.spawn(
    {
      file: "hermes",
      args: ["-p", "symphony-run", "acp"],
      cwd: "/workspace",
      env: { PATH: "/usr/bin", CUSTOM: "kept" },
    },
    {
      ...options,
      spawn: (file: string, args: readonly string[], spawnOptions: HostHermesAcpSpawnOptions) => {
        spawnCalls.push({ file, args: [...args], options: { ...spawnOptions, env: { ...spawnOptions.env } } });
        return child;
      },
    },
  );
  return { child, facade, spawnCalls, writes };
}

function collectJsonRpcWrites(stdin: PassThrough): HostHermesAcpJsonRpcMessage[] {
  const writes: HostHermesAcpJsonRpcMessage[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) writes.push(JSON.parse(line) as HostHermesAcpJsonRpcMessage);
    }
  });
  return writes;
}

function writeJsonRpc(child: FakeChildProcess, message: HostHermesAcpJsonRpcMessage | Record<string, unknown>): void {
  child.stdout.write(`${stringifyHostHermesAcpJsonRpcMessage(message as HostHermesAcpJsonRpcMessage)}\n`);
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("HostHermesAcpFacade JSON-RPC codec", () => {
  it("parses request, notification, and response messages while preserving future fields", () => {
    const request = parseHostHermesAcpJsonRpcLine(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/new", params: { cwd: "/workspace" }, future: true }),
    );
    const notification = parseHostHermesAcpJsonRpcLine(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" }, future: { ok: true } }),
    );
    const response = parseHostHermesAcpJsonRpcLine(
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { sessionId: "s1" }, futureResultField: "kept" }),
    );

    expect(request).toMatchObject({ ok: true, kind: "request", message: { id: 7, method: "session/new", future: true } });
    expect(notification).toMatchObject({
      ok: true,
      kind: "notification",
      message: { method: "session/update", future: { ok: true } },
    });
    expect(response).toMatchObject({
      ok: true,
      kind: "response",
      message: { id: 7, result: { sessionId: "s1" }, futureResultField: "kept" },
    });
  });

  it("rejects malformed or ambiguous JSON-RPC lines without throwing", () => {
    expect(parseHostHermesAcpJsonRpcLine("{not json")).toMatchObject({
      ok: false,
      diagnostic: { code: "host_hermes_acp_json_parse_error" },
    });
    expect(parseHostHermesAcpJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: [], result: {} }))).toMatchObject({
      ok: false,
      diagnostic: { code: "host_hermes_acp_invalid_response_id" },
    });
    expect(parseHostHermesAcpJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {}, error: {} }))).toMatchObject({
      ok: false,
      diagnostic: { code: "host_hermes_acp_ambiguous_response" },
    });
  });
});

describe("HostHermesAcpStdioJsonRpcFacade", () => {
  it("spawns the lease ACP command in the workspace cwd with stripped vendored runtime env", () => {
    const child = new FakeChildProcess();
    const spawnCalls: SpawnCall[] = [];
    const command = buildHostHermesAcpLaunchCommand({
      binaryPath: "/opt/hermes/bin/hermes",
      profileName: "symphony-eng-149",
      cwd: "/workspace/project",
      env: {
        HERMES_HOME: "/vendored/home",
        hermes_auth_home: "/vendored/auth",
        HERMES_PYTHON_SRC_ROOT: "/vendored/src",
        PYTHONPATH: "/vendored/python",
        HERMES_MODEL: "vendored-model",
        HERMES_TUI_PROVIDER: "vendored-provider",
        PATH: "/usr/bin",
        CUSTOM_ENV: "kept",
      },
    });

    HostHermesAcpStdioJsonRpcFacade.spawn(command, {
      spawn: (file: string, args: readonly string[], spawnOptions: HostHermesAcpSpawnOptions) => {
        spawnCalls.push({ file, args: [...args], options: { ...spawnOptions, env: { ...spawnOptions.env } } });
        return child;
      },
    });

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    if (!call) throw new Error("Expected Host Hermes ACP spawn call.");
    expect(call.file).toBe("/opt/hermes/bin/hermes");
    expect(call.args).toEqual(["-p", "symphony-eng-149", "acp"]);
    expect(call.options.cwd).toBe("/workspace/project");
    expect(call.options.stdio).toBe("pipe");
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.env).toEqual({ PATH: "/usr/bin", CUSTOM_ENV: "kept" });
  });

  it("spawns the profile lease command, writes newline JSON-RPC, and routes responses and session/update notifications", async () => {
    const { child, facade, spawnCalls, writes } = createSpawnedFacade();
    const notifications: unknown[] = [];
    facade.onNotification("session/update", (params) => notifications.push(params));

    const response = facade.request<{ sessionId: string }>("session/new", { cwd: "/workspace" });
    facade.notify("session/ping", { sessionId: "s1" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      file: "hermes",
      args: ["-p", "symphony-run", "acp"],
      options: { cwd: "/workspace", stdio: "pipe", windowsHide: true, env: { CUSTOM: "kept" } },
    });
    expect(writes).toEqual([
      { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/workspace" } },
      { jsonrpc: "2.0", method: "session/ping", params: { sessionId: "s1" } },
    ]);

    writeJsonRpc(child, {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: "hi" } },
      future: "kept",
    });
    writeJsonRpc(child, { jsonrpc: "2.0", id: 1, result: { sessionId: "s1" }, future: { ok: true } });

    expect(notifications).toEqual([
      { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: "hi" } },
    ]);
    await expect(response).resolves.toEqual({ sessionId: "s1" });
  });

  it("routes Hermes client-method requests such as session/request_permission and replies to unknown methods defensively", async () => {
    const { child, facade, writes } = createSpawnedFacade();
    facade.onClientRequest("session/request_permission", (params) => ({ outcome: "allow_once", received: params }));

    writeJsonRpc(child, {
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { id: "tool-1" } },
      future: { ignored: false },
    });
    await flushAsyncHandlers();

    expect(writes.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "perm-1",
      result: {
        outcome: "allow_once",
        received: { sessionId: "s1", toolCall: { id: "tool-1" } },
      },
    });

    writeJsonRpc(child, { jsonrpc: "2.0", id: "future-1", method: "future/client_method", params: { ok: true } });
    await flushAsyncHandlers();

    expect(writes.at(-1)).toMatchObject({
      jsonrpc: "2.0",
      id: "future-1",
      error: { code: -32601, message: "Method not found: future/client_method" },
    });
  });

  it("captures malformed stdout diagnostics and bounded stderr log tails without crashing", () => {
    const { child, facade } = createSpawnedFacade({ stderrTailBytes: 256 });
    const diagnostics: HostHermesAcpDiagnostic[] = [];
    facade.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));

    child.stderr.write(`discarded-prefix\n${"x".repeat(600)}\nfirst\nsecond\nthird\nfourth\n`);
    child.stdout.write("{not json\n");
    writeJsonRpc(child, { jsonrpc: "2.0", id: 999, result: { late: true } });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "host_hermes_acp_json_parse_error",
      "host_hermes_acp_unmatched_response",
    ]);
    expect(facade.getLogTail().length).toBeLessThanOrEqual(256);
    expect(facade.getLogTail()).not.toContain("discarded-prefix");
    expect(facade.getLogTail(2)).toBe("third\nfourth");
  });

  it("rejects pending requests on request timeout and treats late responses as unmatched", async () => {
    const { child, facade } = createSpawnedFacade();
    const diagnostics: HostHermesAcpDiagnostic[] = [];
    facade.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));

    const response = facade.request("session/prompt", { sessionId: "s1" }, { timeoutMs: 5 });
    await expect(response).rejects.toThrow("Host Hermes ACP request session/prompt timed out after 5ms.");

    writeJsonRpc(child, { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "host_hermes_acp_request_timeout",
      "host_hermes_acp_unmatched_response",
    ]);
  });

  it("rejects pending startup requests with stderr context when the child process fails before initialization", async () => {
    const { child, facade } = createSpawnedFacade();
    const diagnostics: HostHermesAcpDiagnostic[] = [];
    const exitEvents: HostHermesAcpProcessExit[] = [];
    facade.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    facade.on("exit", (exit) => exitEvents.push(exit));

    const sessionNew = facade.request("session/new", { cwd: "/workspace" }, { timeoutMs: 1_000 });
    child.stderr.write("startup failed: missing profile\n");
    child.fail(new Error("spawn ENOENT"));
    child.close(null);

    await expect(sessionNew).rejects.toThrow(
      /Host Hermes ACP process exited before all requests completed \(exit code unknown; process error: spawn ENOENT\)\.\nStderr tail:\nstartup failed: missing profile/,
    );
    expect(diagnostics).toEqual([
      { code: "host_hermes_acp_process_error", message: "Host Hermes ACP process error: spawn ENOENT" },
    ]);
    expect(exitEvents).toEqual([{ code: null, signal: null, error: "spawn ENOENT" }]);

    const earlyExit = createSpawnedFacade();
    const initialize = earlyExit.facade.request("initialize", {}, { timeoutMs: 1_000 });
    earlyExit.child.stderr.write("early boot exit\n");
    earlyExit.child.exit(2);
    earlyExit.child.close(2);

    await expect(initialize).rejects.toThrow(
      /Host Hermes ACP process exited before all requests completed \(exit code 2\)\.\nStderr tail:\nearly boot exit/,
    );
  });

  it("waits for process close before rejecting startup requests so late stderr is included", async () => {
    const { child, facade } = createSpawnedFacade();
    const exitEvents: HostHermesAcpProcessExit[] = [];
    const logTailAtExit: string[] = [];
    facade.on("exit", (exit) => {
      exitEvents.push(exit);
      logTailAtExit.push(facade.getLogTail());
    });

    const initialize = facade.request("initialize", {}, { timeoutMs: 1_000 });
    let rejectedBeforeClose = false;
    void initialize.catch(() => {
      rejectedBeforeClose = true;
    });

    child.exit(2);
    await flushAsyncHandlers();
    expect(rejectedBeforeClose).toBe(false);
    expect(exitEvents).toEqual([]);

    child.stderr.write("late stderr after exit event\n");
    child.close(2);

    await expect(initialize).rejects.toThrow(
      /Host Hermes ACP process exited before all requests completed \(exit code 2\)\.\nStderr tail:\nlate stderr after exit event/,
    );
    expect(exitEvents).toEqual([{ code: 2, signal: null }]);
    expect(logTailAtExit).toEqual(["late stderr after exit event"]);
  });

  it("rejects pending requests on process exit and kill while retaining stderr diagnostics", async () => {
    const first = createSpawnedFacade();
    const exitEvents: HostHermesAcpProcessExit[] = [];
    first.facade.on("exit", (exit) => exitEvents.push(exit));
    const prompt = first.facade.request("session/prompt", { sessionId: "s1" }, { timeoutMs: 1_000 });
    first.child.stderr.write("fatal line\n");
    first.child.exit(1);
    first.child.close(1);

    await expect(prompt).rejects.toThrow(/Host Hermes ACP process exited before all requests completed \(exit code 1\)\.\nStderr tail:\nfatal line/);
    expect(exitEvents).toEqual([{ code: 1, signal: null }]);

    const second = createSpawnedFacade();
    const pending = second.facade.request("session/prompt", { sessionId: "s2" }, { timeoutMs: 1_000 });
    second.facade.kill("test cleanup");
    second.facade.kill("duplicate cleanup");

    await expect(pending).rejects.toThrow("Host Hermes ACP process killed: test cleanup.");
    expect(second.child.killCalls).toEqual(["SIGTERM"]);
  });
});
