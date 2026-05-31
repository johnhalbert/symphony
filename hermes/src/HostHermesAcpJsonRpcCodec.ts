import { errorMessage } from "../../src/core/errors.js";

export type HostHermesAcpJsonRpcId = string | number | null;

export interface HostHermesAcpJsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface HostHermesAcpJsonRpcBaseMessage {
  jsonrpc: "2.0";
  [key: string]: unknown;
}

export interface HostHermesAcpJsonRpcRequest extends HostHermesAcpJsonRpcBaseMessage {
  id: HostHermesAcpJsonRpcId;
  method: string;
  params?: unknown;
}

export interface HostHermesAcpJsonRpcNotification extends HostHermesAcpJsonRpcBaseMessage {
  method: string;
  params?: unknown;
}

export interface HostHermesAcpJsonRpcResponse extends HostHermesAcpJsonRpcBaseMessage {
  id: HostHermesAcpJsonRpcId;
  result?: unknown;
  error?: HostHermesAcpJsonRpcErrorPayload;
}

export type HostHermesAcpJsonRpcMessage =
  | HostHermesAcpJsonRpcRequest
  | HostHermesAcpJsonRpcNotification
  | HostHermesAcpJsonRpcResponse;

export type HostHermesAcpJsonRpcMessageKind = "request" | "notification" | "response";

export interface HostHermesAcpDiagnostic {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type HostHermesAcpJsonRpcParseResult =
  | { ok: true; message: HostHermesAcpJsonRpcMessage; kind: HostHermesAcpJsonRpcMessageKind }
  | { ok: false; diagnostic: HostHermesAcpDiagnostic };

export type HostHermesAcpJsonRpcDecodeResult = HostHermesAcpJsonRpcParseResult;

export interface HostHermesAcpJsonRpcStreamDecoderOptions {
  ignoreEmptyLines?: boolean;
}

/**
 * Transport-agnostic newline-delimited JSON-RPC codec for Hermes ACP stdio traffic.
 * It accepts arbitrary stdout chunks, preserves message fields verbatim, and returns
 * structured diagnostics instead of throwing for malformed complete lines.
 */
export class HostHermesAcpJsonRpcStreamDecoder {
  readonly #ignoreEmptyLines: boolean;
  #buffer = "";

  constructor(options: HostHermesAcpJsonRpcStreamDecoderOptions = {}) {
    this.#ignoreEmptyLines = options.ignoreEmptyLines ?? false;
  }

  get bufferedLength(): number {
    return this.#buffer.length;
  }

  acceptChunk(chunk: string | Buffer): HostHermesAcpJsonRpcDecodeResult[] {
    this.#buffer += chunkToString(chunk);
    const results: HostHermesAcpJsonRpcDecodeResult[] = [];
    for (;;) {
      const newlineIndex = this.#buffer.indexOf("\n");
      if (newlineIndex < 0) return results;
      const rawLine = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      const result = this.#parseLine(rawLine);
      if (result) results.push(result);
    }
  }

  flush(): HostHermesAcpJsonRpcDecodeResult[] {
    if (this.#buffer.length === 0) return [];
    const rawLine = this.#buffer.replace(/\r$/, "");
    this.#buffer = "";
    const result = this.#parseLine(rawLine);
    return result ? [result] : [];
  }

  reset(): void {
    this.#buffer = "";
  }

  #parseLine(line: string): HostHermesAcpJsonRpcDecodeResult | null {
    if (this.#ignoreEmptyLines && line.trim().length === 0) return null;
    return parseHostHermesAcpJsonRpcLine(line);
  }
}

export function encodeHostHermesAcpJsonRpcLine(message: HostHermesAcpJsonRpcMessage): string {
  return `${stringifyHostHermesAcpJsonRpcMessage(message)}\n`;
}

export function stringifyHostHermesAcpJsonRpcMessage(message: HostHermesAcpJsonRpcMessage): string {
  return JSON.stringify(message);
}

export function parseHostHermesAcpJsonRpcLine(line: string): HostHermesAcpJsonRpcParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return jsonRpcParseFailure("host_hermes_acp_empty_message", "Host Hermes ACP stdout contained an empty JSON-RPC line.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    return jsonRpcParseFailure("host_hermes_acp_json_parse_error", `Could not parse Host Hermes ACP JSON-RPC line: ${errorMessage(error)}`, {
      line: previewLine(trimmed),
    });
  }
  return parseHostHermesAcpJsonRpcValue(parsed);
}

export function parseHostHermesAcpJsonRpcValue(value: unknown): HostHermesAcpJsonRpcParseResult {
  if (!isRecord(value)) {
    return jsonRpcParseFailure("host_hermes_acp_message_not_object", "Host Hermes ACP JSON-RPC message was not an object.");
  }
  if (value.jsonrpc !== "2.0") {
    return jsonRpcParseFailure("host_hermes_acp_invalid_version", "Host Hermes ACP JSON-RPC message did not include jsonrpc=2.0.", {
      jsonrpc: value.jsonrpc,
    });
  }

  const hasMethod = typeof value.method === "string" && value.method.trim().length > 0;
  const hasId = hasOwn(value, "id");
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");

  if (hasMethod) {
    if (hasId && !isJsonRpcId(value.id)) {
      return jsonRpcParseFailure("host_hermes_acp_invalid_request_id", "Host Hermes ACP JSON-RPC request id was not a string, number, or null.", {
        id: value.id,
      });
    }
    const message = value as unknown as HostHermesAcpJsonRpcRequest | HostHermesAcpJsonRpcNotification;
    return hasId ? { ok: true, message, kind: "request" } : { ok: true, message, kind: "notification" };
  }

  if (hasId) {
    if (!isJsonRpcId(value.id)) {
      return jsonRpcParseFailure("host_hermes_acp_invalid_response_id", "Host Hermes ACP JSON-RPC response id was not a string, number, or null.", {
        id: value.id,
      });
    }
    if (hasResult && hasError) {
      return jsonRpcParseFailure("host_hermes_acp_ambiguous_response", "Host Hermes ACP JSON-RPC response included both result and error.", {
        id: value.id,
      });
    }
    if (!hasResult && !hasError) {
      return jsonRpcParseFailure("host_hermes_acp_empty_response", "Host Hermes ACP JSON-RPC response included neither result nor error.", {
        id: value.id,
      });
    }
    if (hasError && !isJsonRpcErrorPayload(value.error)) {
      return jsonRpcParseFailure("host_hermes_acp_invalid_error", "Host Hermes ACP JSON-RPC response error had an invalid shape.", {
        id: value.id,
      });
    }
    return { ok: true, message: value as unknown as HostHermesAcpJsonRpcResponse, kind: "response" };
  }

  return jsonRpcParseFailure("host_hermes_acp_unknown_message", "Host Hermes ACP JSON-RPC message was not a request, notification, or response.");
}

function isJsonRpcId(value: unknown): value is HostHermesAcpJsonRpcId {
  if (value === null) return true;
  if (typeof value === "string") return true;
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonRpcErrorPayload(value: unknown): value is HostHermesAcpJsonRpcErrorPayload {
  return isRecord(value) && typeof value.code === "number" && Number.isFinite(value.code) && typeof value.message === "string";
}

function jsonRpcParseFailure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HostHermesAcpJsonRpcParseResult {
  const diagnostic: HostHermesAcpDiagnostic = { code, message };
  if (details) diagnostic.details = details;
  return { ok: false, diagnostic };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunkToString(chunk: string | Buffer): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function previewLine(line: string): string {
  return line.length <= 500 ? line : `${line.slice(0, 500)}…`;
}
