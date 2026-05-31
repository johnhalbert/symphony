import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { errorMessage } from "../../src/core/errors.js";
import {
  HostHermesAcpJsonRpcStreamDecoder,
  encodeHostHermesAcpJsonRpcLine,
  type HostHermesAcpDiagnostic,
  type HostHermesAcpJsonRpcDecodeResult,
  type HostHermesAcpJsonRpcErrorPayload,
  type HostHermesAcpJsonRpcId,
  type HostHermesAcpJsonRpcMessage,
  type HostHermesAcpJsonRpcMessageKind,
  type HostHermesAcpJsonRpcNotification,
  type HostHermesAcpJsonRpcRequest,
  type HostHermesAcpJsonRpcResponse,
} from "./HostHermesAcpJsonRpcCodec.js";
import type { HostHermesAcpProcessCommand } from "./HostHermesAcpProfileLease.js";

export {
  HostHermesAcpJsonRpcStreamDecoder,
  encodeHostHermesAcpJsonRpcLine,
  parseHostHermesAcpJsonRpcLine,
  parseHostHermesAcpJsonRpcValue,
  stringifyHostHermesAcpJsonRpcMessage,
} from "./HostHermesAcpJsonRpcCodec.js";
export type {
  HostHermesAcpDiagnostic,
  HostHermesAcpJsonRpcBaseMessage,
  HostHermesAcpJsonRpcDecodeResult,
  HostHermesAcpJsonRpcErrorPayload,
  HostHermesAcpJsonRpcId,
  HostHermesAcpJsonRpcMessage,
  HostHermesAcpJsonRpcMessageKind,
  HostHermesAcpJsonRpcNotification,
  HostHermesAcpJsonRpcParseResult,
  HostHermesAcpJsonRpcRequest,
  HostHermesAcpJsonRpcResponse,
  HostHermesAcpJsonRpcStreamDecoderOptions,
} from "./HostHermesAcpJsonRpcCodec.js";

export interface HostHermesAcpProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface HostHermesAcpSpawnOptions extends SpawnOptionsWithoutStdio {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "pipe";
  windowsHide: true;
}

export interface HostHermesAcpChildProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type HostHermesAcpProcessSpawner = (
  file: string,
  args: readonly string[],
  options: HostHermesAcpSpawnOptions,
) => HostHermesAcpChildProcess;

export interface HostHermesAcpSubprocessTransportOptions {
  spawn?: HostHermesAcpProcessSpawner;
  stderrTailBytes?: number;
}

export interface HostHermesAcpFacadeOptions extends HostHermesAcpSubprocessTransportOptions {
  requestTimeoutMs?: number;
  idFactory?: () => HostHermesAcpJsonRpcId;
}

export interface HostHermesAcpRequestOptions {
  timeoutMs?: number;
}

export type HostHermesAcpNotificationHandler = (
  params: unknown,
  notification: HostHermesAcpJsonRpcNotification,
) => void;

export type HostHermesAcpClientRequestHandler = (
  params: unknown,
  request: HostHermesAcpJsonRpcRequest,
) => unknown | Promise<unknown>;

export interface HostHermesAcpJsonRpcTransport {
  send(message: HostHermesAcpJsonRpcMessage): void;
  kill(reason?: string): void;
  getLogTail(limit?: number): string;
  on(event: "message", listener: (message: HostHermesAcpJsonRpcMessage, kind: HostHermesAcpJsonRpcMessageKind) => void): this;
  on(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  on(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  off(event: "message", listener: (message: HostHermesAcpJsonRpcMessage, kind: HostHermesAcpJsonRpcMessageKind) => void): this;
  off(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  off(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
}

export class HostHermesAcpJsonRpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: HostHermesAcpJsonRpcErrorPayload, method: string) {
    super(`Host Hermes ACP request ${method} failed with JSON-RPC error ${error.code}: ${error.message}`);
    this.name = "HostHermesAcpJsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class HostHermesAcpSubprocessTransport extends EventEmitter implements HostHermesAcpJsonRpcTransport {
  readonly #child: HostHermesAcpChildProcess;
  readonly #stderrTailBytes: number;
  readonly #stdoutDecoder = new HostHermesAcpJsonRpcStreamDecoder({ ignoreEmptyLines: true });
  #stderrTail = "";
  #exited = false;
  #exitEmitted = false;
  #pendingExit: HostHermesAcpProcessExit | null = null;
  #killRequested = false;
  #processError: string | null = null;

  constructor(command: HostHermesAcpProcessCommand, options: HostHermesAcpSubprocessTransportOptions = {}) {
    super();
    this.#stderrTailBytes = Math.max(256, options.stderrTailBytes ?? 16_384);
    const spawn = options.spawn ?? defaultHostHermesAcpProcessSpawner;
    this.#child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: "pipe",
      windowsHide: true,
    });
    this.#child.stdout?.on("data", (chunk: string | Buffer) => this.#acceptStdoutChunk(chunk));
    this.#child.stdout?.on("end", () => this.#flushStdoutRemainder());
    this.#child.stderr?.on("data", (chunk: string | Buffer) => this.#acceptStderrChunk(chunk));
    this.#child.on("error", (error) => {
      const processError = errorMessage(error);
      this.#processError = processError;
      this.#emitDiagnostic({
        code: "host_hermes_acp_process_error",
        message: `Host Hermes ACP process error: ${processError}`,
      });
      this.#recordExited({ code: null, signal: null, error: processError });
    });
    this.#child.on("exit", (code, signal) => {
      const exit: HostHermesAcpProcessExit = { code, signal };
      if (this.#processError) exit.error = this.#processError;
      this.#recordExited(exit);
    });
    this.#child.on("close", (code, signal) => {
      // ChildProcess "exit" can fire before stdio has drained; "close" is the
      // stream-drained lifecycle signal used for final rejection diagnostics.
      const exit = this.#pendingExit ?? { code, signal };
      if (this.#processError && !exit.error) exit.error = this.#processError;
      this.#markExited(exit);
    });
  }

  on(event: "message", listener: (message: HostHermesAcpJsonRpcMessage, kind: HostHermesAcpJsonRpcMessageKind) => void): this;
  on(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  on(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: "message", listener: (message: HostHermesAcpJsonRpcMessage, kind: HostHermesAcpJsonRpcMessageKind) => void): this;
  off(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  off(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  send(message: HostHermesAcpJsonRpcMessage): void {
    if (this.#exited) throw new Error("Host Hermes ACP process has already exited.");
    const stdin = this.#child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error("Host Hermes ACP stdin is not writable.");
    }
    stdin.write(encodeHostHermesAcpJsonRpcLine(message), "utf8");
  }

  kill(reason?: string): void {
    if (this.#exited || this.#killRequested) return;
    this.#killRequested = true;
    if (reason) {
      this.#emitDiagnostic({
        code: "host_hermes_acp_process_kill",
        message: `Killing Host Hermes ACP process: ${reason}`,
      });
    }
    this.#child.kill("SIGTERM");
  }

  getLogTail(limit?: number): string {
    return logTailLines(this.#stderrTail, limit);
  }

  #acceptStdoutChunk(chunk: string | Buffer): void {
    for (const result of this.#stdoutDecoder.acceptChunk(chunk)) {
      this.#acceptDecodedStdout(result);
    }
  }

  #flushStdoutRemainder(): void {
    for (const result of this.#stdoutDecoder.flush()) {
      this.#acceptDecodedStdout(result);
    }
  }

  #acceptDecodedStdout(result: HostHermesAcpJsonRpcDecodeResult): void {
    if (!result.ok) {
      this.#emitDiagnostic(result.diagnostic);
      return;
    }
    this.emit("message", result.message, result.kind);
  }

  #acceptStderrChunk(chunk: string | Buffer): void {
    this.#stderrTail += chunkToString(chunk);
    if (this.#stderrTail.length > this.#stderrTailBytes) {
      this.#stderrTail = this.#stderrTail.slice(this.#stderrTail.length - this.#stderrTailBytes);
    }
  }

  #emitDiagnostic(diagnostic: HostHermesAcpDiagnostic): void {
    this.emit("diagnostic", diagnostic);
  }

  #recordExited(exit: HostHermesAcpProcessExit): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#pendingExit = exit;
  }

  #markExited(exit: HostHermesAcpProcessExit): void {
    this.#recordExited(exit);
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.#flushStdoutRemainder();
    this.emit("exit", exit);
  }
}

export class HostHermesAcpStdioJsonRpcFacade extends EventEmitter {
  readonly #transport: HostHermesAcpJsonRpcTransport;
  readonly #requestTimeoutMs: number;
  readonly #idFactory: () => HostHermesAcpJsonRpcId;
  readonly #pending = new Map<string, PendingHostHermesAcpRequest>();
  readonly #notificationHandlers = new Map<string, Set<HostHermesAcpNotificationHandler>>();
  readonly #clientRequestHandlers = new Map<string, HostHermesAcpClientRequestHandler>();
  #nextRequestId = 1;
  #closed = false;

  constructor(transport: HostHermesAcpJsonRpcTransport, options: HostHermesAcpFacadeOptions = {}) {
    super();
    this.#transport = transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#idFactory = options.idFactory ?? (() => this.#nextRequestId++);
    this.#transport.on("message", (message, kind) => this.#routeMessage(message, kind));
    this.#transport.on("diagnostic", (diagnostic) => this.emit("diagnostic", diagnostic));
    this.#transport.on("exit", (exit) => this.#handleExit(exit));
  }

  static spawn(
    command: HostHermesAcpProcessCommand,
    options: HostHermesAcpFacadeOptions = {},
  ): HostHermesAcpStdioJsonRpcFacade {
    return new HostHermesAcpStdioJsonRpcFacade(new HostHermesAcpSubprocessTransport(command, options), options);
  }

  on(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  on(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  on(event: "notification", listener: (notification: HostHermesAcpJsonRpcNotification) => void): this;
  on(event: "client_request", listener: (request: HostHermesAcpJsonRpcRequest) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  off(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  off(event: "notification", listener: (notification: HostHermesAcpJsonRpcNotification) => void): this;
  off(event: "client_request", listener: (request: HostHermesAcpJsonRpcRequest) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  request<T = unknown>(method: string, params?: unknown, options: HostHermesAcpRequestOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Host Hermes ACP facade is closed."));
    const normalizedMethod = requireJsonRpcMethod(method);
    const id = this.#idFactory();
    const key = jsonRpcIdKey(id);
    if (this.#pending.has(key)) {
      return Promise.reject(new Error(`Host Hermes ACP request id collision for ${String(id)}.`));
    }
    const message: HostHermesAcpJsonRpcRequest = { jsonrpc: "2.0", id, method: normalizedMethod };
    if (params !== undefined) message.params = params;

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
      const pending: PendingHostHermesAcpRequest = {
        method: normalizedMethod,
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeout: setTimeout(() => {
          this.#pending.delete(key);
          reject(new Error(`Host Hermes ACP request ${normalizedMethod} timed out after ${timeoutMs}ms.`));
          this.emit("diagnostic", {
            code: "host_hermes_acp_request_timeout",
            message: `Host Hermes ACP request ${normalizedMethod} timed out after ${timeoutMs}ms.`,
            details: { id, method: normalizedMethod, timeoutMs },
          });
        }, timeoutMs),
      };
      this.#pending.set(key, pending);
      try {
        this.#transport.send(message);
      } catch (error) {
        this.#clearPending(key, pending);
        reject(new Error(`Failed to send Host Hermes ACP request ${normalizedMethod}: ${errorMessage(error)}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) throw new Error("Host Hermes ACP facade is closed.");
    const normalizedMethod = requireJsonRpcMethod(method);
    const message: HostHermesAcpJsonRpcNotification = { jsonrpc: "2.0", method: normalizedMethod };
    if (params !== undefined) message.params = params;
    this.#transport.send(message);
  }

  onNotification(method: string, handler: HostHermesAcpNotificationHandler): () => void {
    const normalizedMethod = requireJsonRpcMethod(method);
    let handlers = this.#notificationHandlers.get(normalizedMethod);
    if (!handlers) {
      handlers = new Set();
      this.#notificationHandlers.set(normalizedMethod, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.#notificationHandlers.get(normalizedMethod);
      current?.delete(handler);
      if (current?.size === 0) this.#notificationHandlers.delete(normalizedMethod);
    };
  }

  onClientRequest(method: string, handler: HostHermesAcpClientRequestHandler): () => void {
    const normalizedMethod = requireJsonRpcMethod(method);
    this.#clientRequestHandlers.set(normalizedMethod, handler);
    return () => {
      if (this.#clientRequestHandlers.get(normalizedMethod) === handler) this.#clientRequestHandlers.delete(normalizedMethod);
    };
  }

  kill(reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAllPending(new Error(`Host Hermes ACP process killed${reason ? `: ${reason}` : ""}.`));
    this.#transport.kill(reason);
  }

  getLogTail(limit?: number): string {
    return this.#transport.getLogTail(limit);
  }

  #routeMessage(message: HostHermesAcpJsonRpcMessage, kind: HostHermesAcpJsonRpcMessageKind): void {
    if (kind === "response") {
      this.#handleResponse(message as HostHermesAcpJsonRpcResponse);
      return;
    }
    if (kind === "notification") {
      this.#handleNotification(message as HostHermesAcpJsonRpcNotification);
      return;
    }
    void this.#handleClientRequest(message as HostHermesAcpJsonRpcRequest);
  }

  #handleResponse(response: HostHermesAcpJsonRpcResponse): void {
    const key = jsonRpcIdKey(response.id);
    const pending = this.#pending.get(key);
    if (!pending) {
      this.emit("diagnostic", {
        code: "host_hermes_acp_unmatched_response",
        message: `Received Host Hermes ACP response for unknown request id ${String(response.id)}.`,
        details: { id: response.id },
      });
      return;
    }
    this.#clearPending(key, pending);
    if (response.error) {
      pending.reject(new HostHermesAcpJsonRpcResponseError(response.error, pending.method));
      return;
    }
    pending.resolve(response.result);
  }

  #handleNotification(notification: HostHermesAcpJsonRpcNotification): void {
    this.emit("notification", notification);
    const handlers = this.#notificationHandlers.get(notification.method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(notification.params, notification);
      } catch (error) {
        this.emit("diagnostic", {
          code: "host_hermes_acp_notification_handler_error",
          message: `Host Hermes ACP notification handler for ${notification.method} failed: ${errorMessage(error)}`,
          details: { method: notification.method },
        });
      }
    }
  }

  async #handleClientRequest(request: HostHermesAcpJsonRpcRequest): Promise<void> {
    this.emit("client_request", request);
    const handler = this.#clientRequestHandlers.get(request.method);
    if (!handler) {
      this.emit("diagnostic", {
        code: "host_hermes_acp_unknown_client_request",
        message: `No Host Hermes ACP client request handler registered for ${request.method}.`,
        details: { id: request.id, method: request.method },
      });
      this.#sendClientResponse({ jsonrpc: "2.0", id: request.id, error: jsonRpcError(-32601, `Method not found: ${request.method}`) });
      return;
    }
    try {
      const result = await handler(request.params, request);
      this.#sendClientResponse({ jsonrpc: "2.0", id: request.id, result: result ?? null });
    } catch (error) {
      this.emit("diagnostic", {
        code: "host_hermes_acp_client_request_handler_error",
        message: `Host Hermes ACP client request handler for ${request.method} failed: ${errorMessage(error)}`,
        details: { id: request.id, method: request.method },
      });
      this.#sendClientResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: jsonRpcError(-32603, `Handler failed: ${errorMessage(error)}`),
      });
    }
  }

  #sendClientResponse(response: HostHermesAcpJsonRpcResponse): void {
    try {
      this.#transport.send(response);
    } catch (error) {
      this.emit("diagnostic", {
        code: "host_hermes_acp_client_response_send_error",
        message: `Failed to send Host Hermes ACP client response: ${errorMessage(error)}`,
        details: { id: response.id },
      });
    }
  }

  #handleExit(exit: HostHermesAcpProcessExit): void {
    if (!this.#closed) {
      this.#closed = true;
      const stderrTail = this.#transport.getLogTail();
      const exitDescription = hostHermesAcpExitDescription(exit);
      const message = `Host Hermes ACP process exited before all requests completed (${exitDescription}).${
        stderrTail.length > 0 ? `\nStderr tail:\n${stderrTail}` : ""
      }`;
      this.#rejectAllPending(new Error(message));
    }
    this.emit("exit", exit);
  }

  #clearPending(key: string, pending: PendingHostHermesAcpRequest): void {
    clearTimeout(pending.timeout);
    this.#pending.delete(key);
  }

  #rejectAllPending(error: Error): void {
    for (const [key, pending] of this.#pending) {
      this.#clearPending(key, pending);
      pending.reject(error);
    }
  }
}

function defaultHostHermesAcpProcessSpawner(
  file: string,
  args: readonly string[],
  options: HostHermesAcpSpawnOptions,
): HostHermesAcpChildProcess {
  return nodeSpawn(file, [...args], options) as ChildProcess as HostHermesAcpChildProcess;
}

interface PendingHostHermesAcpRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function requireJsonRpcMethod(method: string): string {
  const normalized = method.trim();
  if (!normalized) throw new Error("Host Hermes ACP JSON-RPC method is required.");
  return normalized;
}

function jsonRpcIdKey(id: HostHermesAcpJsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function jsonRpcError(code: number, message: string, data?: unknown): HostHermesAcpJsonRpcErrorPayload {
  const error: HostHermesAcpJsonRpcErrorPayload = { code, message };
  if (data !== undefined) error.data = data;
  return error;
}

function chunkToString(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function logTailLines(tail: string, limit?: number): string {
  const normalized = tail.replace(/\r/g, "");
  if (limit === undefined) return normalized.replace(/\n$/, "");
  const lineLimit = Math.max(0, Math.floor(limit));
  if (lineLimit === 0) return "";
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-lineLimit).join("\n");
}

function hostHermesAcpExitDescription(exit: HostHermesAcpProcessExit): string {
  const base = exit.signal ? `signal ${exit.signal}` : exit.code === null ? "exit code unknown" : `exit code ${exit.code}`;
  return exit.error ? `${base}; process error: ${exit.error}` : base;
}
