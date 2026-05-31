import { describe, expect, it } from "vitest";
import {
  HostHermesAcpJsonRpcStreamDecoder,
  encodeHostHermesAcpJsonRpcLine,
  parseHostHermesAcpJsonRpcLine,
  stringifyHostHermesAcpJsonRpcMessage,
  type HostHermesAcpJsonRpcDecodeResult,
  type HostHermesAcpJsonRpcMessage,
} from "../hermes/src/HostHermesAcpJsonRpcCodec.js";

function okResults(results: HostHermesAcpJsonRpcDecodeResult[]) {
  return results.map((result) => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic.message);
    return { kind: result.kind, message: result.message };
  });
}

function diagnosticCodes(results: HostHermesAcpJsonRpcDecodeResult[]): string[] {
  return results.map((result) => {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`Expected diagnostic, got ${result.kind}`);
    return result.diagnostic.code;
  });
}

describe("HostHermesAcpJsonRpcCodec", () => {
  it("encodes requests, notifications, and responses as newline-delimited JSON while preserving fields", () => {
    const request: HostHermesAcpJsonRpcMessage = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/new",
      params: { cwd: "/workspace" },
      future: { preserved: true },
    };
    const notification: HostHermesAcpJsonRpcMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
      extraNotificationField: 7,
    };
    const response: HostHermesAcpJsonRpcMessage = {
      jsonrpc: "2.0",
      id: 42,
      result: { stopReason: "end_turn" },
      extraResponseField: "kept",
    };

    expect(stringifyHostHermesAcpJsonRpcMessage(request)).toBe(JSON.stringify(request));
    expect([request, notification, response].map(encodeHostHermesAcpJsonRpcLine)).toEqual([
      `${JSON.stringify(request)}\n`,
      `${JSON.stringify(notification)}\n`,
      `${JSON.stringify(response)}\n`,
    ]);
  });

  it("decodes single, chunked, and multiple stdout messages while preserving id types", () => {
    const decoder = new HostHermesAcpJsonRpcStreamDecoder();
    const responseLine = `${stringifyHostHermesAcpJsonRpcMessage({ jsonrpc: "2.0", id: "1", result: { ok: true }, future: true })}\r\n`;
    const notificationLine = encodeHostHermesAcpJsonRpcLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
    });
    const requestLine = encodeHostHermesAcpJsonRpcLine({
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: { sessionId: "s1" },
    });

    const results: HostHermesAcpJsonRpcDecodeResult[] = [];
    results.push(...decoder.acceptChunk(responseLine.slice(0, 12)));
    expect(results).toHaveLength(0);

    results.push(...decoder.acceptChunk(responseLine.slice(12) + notificationLine + requestLine.slice(0, 9)));
    results.push(...decoder.acceptChunk(Buffer.from(requestLine.slice(9), "utf8")));

    expect(okResults(results)).toEqual([
      { kind: "response", message: { jsonrpc: "2.0", id: "1", result: { ok: true }, future: true } },
      { kind: "notification", message: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } } },
      { kind: "request", message: { jsonrpc: "2.0", id: 1, method: "session/request_permission", params: { sessionId: "s1" } } },
    ]);
  });

  it("flushes a final unterminated message and can ignore empty process-level lines", () => {
    const decoder = new HostHermesAcpJsonRpcStreamDecoder({ ignoreEmptyLines: true });

    expect(decoder.acceptChunk("\n")).toEqual([]);
    expect(decoder.acceptChunk('{"jsonrpc":"2.0","id":7,"result":null}')).toEqual([]);
    expect(okResults(decoder.flush())).toEqual([{ kind: "response", message: { jsonrpc: "2.0", id: 7, result: null } }]);
  });

  it("returns structured diagnostics for malformed JSON and invalid JSON-RPC shapes without throwing", () => {
    expect(parseHostHermesAcpJsonRpcLine("{not json")).toMatchObject({
      ok: false,
      diagnostic: { code: "host_hermes_acp_json_parse_error" },
    });
    expect(parseHostHermesAcpJsonRpcLine(JSON.stringify(["not", "object"]))).toMatchObject({
      ok: false,
      diagnostic: { code: "host_hermes_acp_message_not_object" },
    });
    expect(parseHostHermesAcpJsonRpcLine(JSON.stringify({ method: "session/update" }))).toMatchObject({
      ok: false,
      diagnostic: { code: "host_hermes_acp_invalid_version", details: { jsonrpc: undefined } },
    });

    const decoder = new HostHermesAcpJsonRpcStreamDecoder();
    const results = decoder.acceptChunk(
      [
        "{not json",
        JSON.stringify({ jsonrpc: "2.0", id: [], result: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: {}, error: { code: -32603, message: "bad" } }),
        JSON.stringify({ jsonrpc: "2.0", id: 2 }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: "bad", message: "wrong" } }),
        JSON.stringify({ jsonrpc: "2.0", params: { orphan: true } }),
      ].join("\n") + "\n",
    );

    expect(diagnosticCodes(results)).toEqual([
      "host_hermes_acp_json_parse_error",
      "host_hermes_acp_invalid_response_id",
      "host_hermes_acp_ambiguous_response",
      "host_hermes_acp_empty_response",
      "host_hermes_acp_invalid_error",
      "host_hermes_acp_unknown_message",
    ]);
  });
});
