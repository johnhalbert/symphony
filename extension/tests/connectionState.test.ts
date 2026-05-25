import { describe, expect, it } from "vitest";
import { classifyProbeResult } from "../src/connectionState";

describe("connection state classification", () => {
  it("accepts only Symphony state snapshots as connected", () => {
    expect(
      classifyProbeResult(
        { kind: "http", baseUrl: "http://127.0.0.1:7331", status: 200, body: { generatedAt: "2026-01-01T00:00:00.000Z" } },
        false,
      ),
    ).toMatchObject({ kind: "connected", generatedAt: "2026-01-01T00:00:00.000Z" });

    expect(classifyProbeResult({ kind: "http", baseUrl: "http://example.test", status: 200, body: {} }, false)).toMatchObject({
      kind: "error",
      reason: "malformed_body",
    });
    expect(
      classifyProbeResult({ kind: "http", baseUrl: "http://example.test", status: 200, body: { generatedAt: 1 } }, false),
    ).toMatchObject({ kind: "error", reason: "malformed_body" });
  });

  it("classifies HTTP and parsing failures as errors", () => {
    expect(classifyProbeResult({ kind: "http", baseUrl: "http://example.test", status: 503, body: {} }, false)).toMatchObject({
      kind: "error",
      reason: "http_status",
    });
    expect(classifyProbeResult({ kind: "parse_failure", baseUrl: "http://example.test", detail: "not json" }, false)).toMatchObject({
      kind: "error",
      reason: "parse_failure",
    });
  });

  it("classifies transport failures as offline", () => {
    expect(
      classifyProbeResult({ kind: "network", baseUrl: "http://example.test", reason: "timeout", detail: "aborted" }, false),
    ).toMatchObject({ kind: "offline", reason: "timeout" });
  });
});
