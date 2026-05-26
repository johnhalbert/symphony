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

  it("prefers finite top-level running and retrying counts over operator rows", () => {
    expect(
      classifyProbeResult(
        {
          kind: "http",
          baseUrl: "http://127.0.0.1:7331",
          status: 200,
          body: {
            generatedAt: "2026-01-01T00:00:00.000Z",
            counts: { running: 5, retrying: 2 },
            operatorView: { running: [{}, {}], retrying: [{}, {}, {}] },
          },
        },
        false,
      ),
    ).toMatchObject({ kind: "connected", summary: { runningCount: 5, retryingCount: 2 } });
  });

  it("falls back to operator row lengths when top-level counts are absent or non-finite", () => {
    expect(
      classifyProbeResult(
        {
          kind: "http",
          baseUrl: "http://127.0.0.1:7331",
          status: 200,
          body: {
            generatedAt: "2026-01-01T00:00:00.000Z",
            operatorView: { running: [{}, {}], retrying: [{}] },
          },
        },
        false,
      ),
    ).toMatchObject({ kind: "connected", summary: { runningCount: 2, retryingCount: 1 } });

    expect(
      classifyProbeResult(
        {
          kind: "http",
          baseUrl: "http://127.0.0.1:7331",
          status: 200,
          body: {
            generatedAt: "2026-01-01T00:00:00.000Z",
            counts: { running: Number.NaN, retrying: Number.POSITIVE_INFINITY },
            operatorView: { running: [{}], retrying: [{}, {}] },
          },
        },
        false,
      ),
    ).toMatchObject({ kind: "connected", summary: { runningCount: 1, retryingCount: 2 } });
  });

  it("reports unknown running and retrying counts when no source is usable", () => {
    expect(
      classifyProbeResult(
        { kind: "http", baseUrl: "http://127.0.0.1:7331", status: 200, body: { generatedAt: "2026-01-01T00:00:00.000Z" } },
        false,
      ),
    ).toMatchObject({ kind: "connected", summary: { runningCount: null, retryingCount: null } });
  });
});
