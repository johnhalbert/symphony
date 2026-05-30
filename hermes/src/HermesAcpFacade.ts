import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { HostHermesAcpProcessCommand } from "./HostHermesAcpProfileLease.js";

export type AcpJsonRpcId = string | number | null;

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: AcpEnvVariable[];
}

export interface AcpClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface HermesAcpFacadeOptions {
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  permissionTimeoutMs?: number;
  shutdownGraceMs?: number;
  clientInfo?: AcpClientInfo;
}

export interface HermesAcpSession {
  sessionId: string;
  raw: Record<string, unknown>;
}

export interface HermesAcpPromptResult {
  stopReason: string | null;
  usage: unknown;
  raw: Record<string, unknown> | null;
}

export type HermesAcpFacadeEvent =
  | { type: "acp.started"; command: string; args: string[]; cwd: string }
  | { type: "acp.stderr"; line: string }
  | { type: "acp.protocol_error"; message: string; payload?: unknown }
  | { type: "acp.exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "session.update"; sessionId: string | null; update: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "permission.denied"; sessionId: string | null; options: unknown; toolCall: unknown; reason: string }
  | { type: "client_request.denied"; method: string; messageId: AcpJsonRpcId | undefined; reason: string };

export interface HermesAcpClient {
  on(event: "event", listener: (event: HermesAcpFacadeEvent) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "event", listener: (event: HermesAcpFacadeEvent) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  initialize(): Promise<Record<string, unknown>>;
  newSession(input: { cwd: string; mcpServers: AcpMcpServerStdio[] }): Promise<HermesAcpSession>;
  prompt(input: { sessionId: string; prompt: string }): Promise<HermesAcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
  close(reason?: string): Promise<void>;
  kill(reason?: string): void;
  getLogTail(limit?: number): string;
}

interface PendingRequest {
  method: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup";

export class StdioHermesAcpClient implements HermesAcpClient {
  private readonly emitter = new EventEmitter();
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly clientInfo: AcpClientInfo;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly logTail: string[] = [];

  constructor(
    private readonly command: HostHermesAcpProcessCommand,
    options: HermesAcpFacadeOptions = {},
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.clientInfo = options.clientInfo ?? { name: "symphony", title: "Symphony", version: "0.1.0" };
  }

  on(event: "event", listener: (event: HermesAcpFacadeEvent) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "event" | "exit", listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: "event", listener: (event: HermesAcpFacadeEvent) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "event" | "exit", listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: this.clientInfo,
      },
      this.startupTimeoutMs,
    );
    await this.authenticateAdvertisedAgentMethods(result);
    return result;
  }

  async newSession(input: { cwd: string; mcpServers: AcpMcpServerStdio[] }): Promise<HermesAcpSession> {
    const result = await this.request<Record<string, unknown>>(
      "session/new",
      { cwd: input.cwd, mcpServers: input.mcpServers },
      this.startupTimeoutMs,
    );
    const sessionId = nonEmptyString(result.sessionId) ?? nonEmptyString(result.session_id);
    if (!sessionId) throw new Error("Hermes ACP session/new did not return a sessionId.");
    return { sessionId, raw: result };
  }

  async prompt(input: { sessionId: string; prompt: string }): Promise<HermesAcpPromptResult> {
    const result = await this.request<Record<string, unknown> | null>(
      "session/prompt",
      {
        sessionId: input.sessionId,
        prompt: [{ type: "text", text: input.prompt }],
      },
      this.requestTimeoutMs,
    );
    const record = isRecord(result) ? result : null;
    return {
      stopReason: nonEmptyString(record?.stopReason) ?? nonEmptyString(record?.stop_reason) ?? null,
      usage: record?.usage,
      raw: record,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request("session/cancel", { sessionId }, Math.min(this.requestTimeoutMs, 10_000));
  }

  async close(reason = "close"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.process;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill(`${reason}.timeout`);
        resolve();
      }, this.shutdownGraceMs);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.stdin.end();
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  kill(reason = "kill"): void {
    this.appendLog(`client kill: ${reason}`);
    this.rejectAll(new Error(`Hermes ACP client killed: ${reason}`));
    const proc = this.process;
    if (!proc) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Best effort kill.
    }
  }

  getLogTail(limit = 50): string {
    return this.logTail.slice(-limit).join("\n");
  }

  private async request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    this.ensureStarted();
    const proc = this.process;
    if (!proc || proc.stdin.destroyed) throw new Error("Hermes ACP process is not writable.");
    const id = this.nextId++;
    const key = String(id);
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Hermes ACP request ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(key, {
        method,
        timeout,
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      try {
        proc.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureStarted(): void {
    if (this.process) return;
    if (this.closed) throw new Error("Hermes ACP client is closed.");
    const proc = spawn(this.command.file, [...this.command.args], {
      cwd: this.command.cwd,
      env: this.command.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.process = proc;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    proc.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    proc.once("error", (error) => {
      const wrapped = new Error(`Hermes ACP process failed: ${error.message}`);
      this.emit({ type: "acp.protocol_error", message: wrapped.message });
      this.rejectAll(wrapped);
    });
    proc.once("exit", (code, signal) => {
      this.emit({ type: "acp.exit", code, signal });
      this.emitter.emit("exit", code, signal);
      this.rejectAll(new Error(`Hermes ACP process exited${code === null ? "" : ` with code ${code}`}.`));
      this.process = null;
    });
    this.emit({ type: "acp.started", command: this.command.file, args: [...this.command.args], cwd: this.command.cwd });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.appendLog(`stdout: ${line}`);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit({ type: "acp.protocol_error", message: "Hermes ACP emitted malformed JSON-RPC output", payload: line });
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    while (true) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stderrBuffer.slice(0, newline).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (!line) continue;
      this.appendLog(`stderr: ${line}`);
      this.emit({ type: "acp.stderr", line });
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.emit({ type: "acp.protocol_error", message: "Hermes ACP emitted a non-object JSON-RPC message", payload: message });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && ("result" in message || "error" in message)) {
      this.handleResponse(message);
      return;
    }
    const method = nonEmptyString(message.method);
    if (!method) {
      this.emit({ type: "acp.protocol_error", message: "Hermes ACP emitted a JSON-RPC message without a method or response id", payload: message });
      return;
    }
    this.handleServerRequest(method, message);
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id as AcpJsonRpcId | undefined;
    const pending = this.pending.get(String(id));
    if (!pending) return;
    this.pending.delete(String(id));
    clearTimeout(pending.timeout);
    if ("error" in message) {
      pending.reject(jsonRpcError(pending.method, message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(method: string, message: Record<string, unknown>): void {
    const params = isRecord(message.params) ? message.params : {};
    const hasResponseId = Object.prototype.hasOwnProperty.call(message, "id");
    const messageId = hasResponseId ? (message.id as AcpJsonRpcId | undefined) : undefined;

    if (method === "session/update") {
      const update = isRecord(params.update) ? params.update : {};
      this.emit({
        type: "session.update",
        sessionId: nonEmptyString(params.sessionId) ?? nonEmptyString(params.session_id) ?? null,
        update,
        raw: params,
      });
      if (hasResponseId) this.writeResponse(messageId, null);
      return;
    }

    if (method === "session/request_permission") {
      this.emit({
        type: "permission.denied",
        sessionId: nonEmptyString(params.sessionId) ?? nonEmptyString(params.session_id) ?? null,
        options: params.options,
        toolCall: params.toolCall ?? params.tool_call,
        reason: "ACP permission requests are denied by Symphony unless an explicit approval bridge is implemented.",
      });
      if (hasResponseId) {
        this.writeResponse(messageId, { outcome: { outcome: "cancelled" } });
      }
      return;
    }

    if (hasResponseId) {
      this.emit({
        type: "client_request.denied",
        method,
        messageId,
        reason: `ACP client method ${method} is not supported by Symphony.`,
      });
      this.writeError(messageId, -32601, `ACP client method ${method} is not supported by Symphony.`);
    }
  }

  private async authenticateAdvertisedAgentMethods(initializeResult: Record<string, unknown>): Promise<void> {
    const authMethods = Array.isArray(initializeResult.authMethods)
      ? initializeResult.authMethods
      : Array.isArray(initializeResult.auth_methods)
        ? initializeResult.auth_methods
        : [];
    for (const method of authMethods) {
      if (!isRecord(method)) continue;
      const methodId = nonEmptyString(method.id) ?? nonEmptyString(method.methodId) ?? nonEmptyString(method.method_id);
      const methodType = nonEmptyString(method.type);
      if (!methodId || methodId === TERMINAL_SETUP_AUTH_METHOD_ID || methodType === "terminal") continue;
      await this.request("authenticate", { methodId }, this.startupTimeoutMs);
    }
  }

  private writeResponse(id: AcpJsonRpcId | undefined, result: unknown): void {
    this.writeJson({ jsonrpc: "2.0", id: id ?? null, result });
  }

  private writeError(id: AcpJsonRpcId | undefined, code: number, message: string): void {
    this.writeJson({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  private writeJson(payload: unknown): void {
    const proc = this.process;
    if (!proc || proc.stdin.destroyed) return;
    try {
      const encoded = JSON.stringify(payload);
      this.appendLog(`stdin: ${encoded}`);
      proc.stdin.write(`${encoded}\n`, "utf8");
    } catch (error) {
      this.emit({ type: "acp.protocol_error", message: `Failed to write ACP response: ${errorMessage(error)}` });
    }
  }

  private rejectAll(error: Error): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  private emit(event: HermesAcpFacadeEvent): void {
    this.appendLog(event.type === "acp.stderr" ? `event: ${event.type}` : `event: ${JSON.stringify(event)}`);
    this.emitter.emit("event", event);
  }

  private appendLog(line: string): void {
    this.logTail.push(line);
    if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200);
  }
}

export function mcpServersToAcpStdioServers(servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>): AcpMcpServerStdio[] {
  return Object.entries(servers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([envName, value]) => ({ name: envName, value })),
  }));
}

function jsonRpcError(method: string, value: unknown): Error {
  if (!isRecord(value)) return new Error(`Hermes ACP request ${method} failed.`);
  const message = nonEmptyString(value.message) ?? JSON.stringify(value);
  const error = new Error(`Hermes ACP request ${method} failed: ${message}`);
  Object.assign(error, { code: value.code, data: value.data });
  return error;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
