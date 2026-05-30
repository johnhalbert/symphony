import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StdioHermesAcpClient, mcpServersToAcpStdioServers } from "../hermes/src/HermesAcpFacade.js";

let root: string;

describe("StdioHermesAcpClient", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-facade-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("performs ACP initialize/session/prompt over newline-delimited JSON-RPC and streams updates", async () => {
    const script = await writeFakeAcpScript("normal");
    const client = new StdioHermesAcpClient(
      { file: process.execPath, args: [script], cwd: root, env: { ...process.env } },
      { startupTimeoutMs: 2_000, requestTimeoutMs: 2_000, shutdownGraceMs: 100 },
    );
    const events: unknown[] = [];
    client.on("event", (event) => events.push(event));

    await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: 1 });
    const session = await client.newSession({
      cwd: root,
      mcpServers: mcpServersToAcpStdioServers({
        symphony: { command: "node", args: ["server.js"], env: { TOKEN: "value" } },
      }),
    });
    await expect(client.prompt({ sessionId: session.sessionId, prompt: "hello" })).resolves.toMatchObject({
      stopReason: "end_turn",
      usage: { input: 3, output: 5 },
    });
    await client.close("test");

    expect(session.sessionId).toBe("sess-1");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "acp.started" }),
        expect.objectContaining({
          type: "session.update",
          sessionId: "sess-1",
          update: expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
        }),
      ]),
    );
    expect(client.getLogTail()).toContain("session/update");
  });

  it("fails ACP permission requests closed instead of allowing host-side side effects", async () => {
    const script = await writeFakeAcpScript("permission");
    const client = new StdioHermesAcpClient(
      { file: process.execPath, args: [script], cwd: root, env: { ...process.env } },
      { startupTimeoutMs: 2_000, requestTimeoutMs: 2_000, shutdownGraceMs: 100 },
    );
    const events: unknown[] = [];
    client.on("event", (event) => events.push(event));

    await client.initialize();
    const session = await client.newSession({ cwd: root, mcpServers: [] });
    await expect(client.prompt({ sessionId: session.sessionId, prompt: "edit file" })).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    await client.close("test");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "permission.denied",
          sessionId: "sess-1",
          reason: expect.stringContaining("denied by Symphony"),
        }),
      ]),
    );
    expect(client.getLogTail()).toContain('"outcome":"cancelled"');
  });
});

async function writeFakeAcpScript(mode: "normal" | "permission"): Promise<string> {
  const script = path.join(root, `fake-acp-${mode}.mjs`);
  await writeFile(
    script,
    `import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function response(id, result) { send({ jsonrpc: "2.0", id, result }); }
async function clientRequest(method, params) {
  const id = "client-" + Math.random().toString(16).slice(2);
  send({ jsonrpc: "2.0", id, method, params });
  return await new Promise((resolve) => {
    const onLine = (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== id) return;
      process.stdin.off("data", onLine);
      resolve(msg.result ?? msg.error);
    };
  });
}
const pendingClientRequests = new Map();
function requestClient(method, params) {
  const id = "client-" + pendingClientRequests.size;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingClientRequests.set(id, resolve));
}
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (pendingClientRequests.has(String(msg.id))) {
    pendingClientRequests.get(String(msg.id))(msg);
    pendingClientRequests.delete(String(msg.id));
    return;
  }
  if (msg.method === "initialize") {
    response(msg.id, { protocolVersion: 1, authMethods: [{ id: "oauth", type: "oauth" }, { id: "hermes-setup", type: "terminal" }] });
    return;
  }
  if (msg.method === "authenticate") {
    response(msg.id, { ok: true });
    return;
  }
  if (msg.method === "session/new") {
    response(msg.id, { sessionId: "sess-1" });
    return;
  }
  if (msg.method === "session/prompt") {
    if (mode === "permission") {
      await requestClient("session/request_permission", {
        sessionId: msg.params.sessionId,
        options: [{ optionId: "allow", name: "Allow" }],
        toolCall: { title: "write file" }
      });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from acp" } } } });
    response(msg.id, { stopReason: "end_turn", usage: { input: 3, output: 5 } });
    return;
  }
  response(msg.id, null);
});
`,
    "utf8",
  );
  return script;
}
