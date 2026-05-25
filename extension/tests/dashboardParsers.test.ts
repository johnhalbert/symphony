import { describe, expect, it } from "vitest";
import { parseActivitySection, parseBoardSection, parseOperatorQueues } from "../src/dashboardParsers";

describe("dashboard parsers", () => {
  it("parses operator queues from the state operatorView", () => {
    const section = parseOperatorQueues({
      operatorView: {
        running: [
          {
            issueIdentifier: "TEST-1",
            role: "worker",
            state: "In Progress",
            liveness: { status: "running" },
            issueDetails: { issue: { title: "Live title" } },
          },
        ],
        paused: [{ issueIdentifier: "TEST-2", label: "Paused TEST-2" }],
        orphaned: [{ issueIdentifier: "TEST-3", runId: "run-3", status: "not_live", tracking: "orphaned" }],
        retrying: [{ issueIdentifier: "TEST-4", attempt: 2, dueAt: "2026-01-01T00:05:00.000Z", error: "rate limited" }],
      },
    });

    expect(section.status).toBe("ready");
    expect(section.data.running[0]).toMatchObject({ issueIdentifier: "TEST-1", role: "worker", statusLabel: "running" });
    expect(section.data.paused[0]?.issueIdentifier).toBe("TEST-2");
    expect(section.data.orphaned[0]).toMatchObject({ issueIdentifier: "TEST-3", detail: "run-3" });
    expect(section.data.retrying[0]).toMatchObject({ issueIdentifier: "TEST-4", attempt: 2, dueAt: "2026-01-01T00:05:00.000Z" });
  });

  it("returns a partial operator section when operatorView is absent", () => {
    const section = parseOperatorQueues({ generatedAt: "2026-01-01T00:00:00.000Z" });

    expect(section.status).toBe("partial");
    expect(section.data.running).toEqual([]);
  });

  it("maps board tracker unavailability separately from board errors", () => {
    expect(
      parseBoardSection({
        kind: "http",
        status: 503,
        body: { error: { code: "tracker_unavailable", message: "Issue board requires a configured tracker client" } },
      }),
    ).toMatchObject({ status: "unavailable" });

    expect(parseBoardSection({ kind: "network", detail: "ECONNREFUSED" })).toMatchObject({ status: "error" });
  });

  it("parses board columns and counts without card detail payloads", () => {
    const section = parseBoardSection({
      kind: "http",
      status: 200,
      body: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        columns: [{ id: "todo", title: "Todo", count: 2, issues: [{ capabilities: { detail: "/api/v1/board/issues/1" } }] }],
        counts: { total: 2, live: 1, paused: 0, blocked: 1 },
      },
    });

    expect(section).toMatchObject({
      status: "ready",
      data: { columns: [{ id: "todo", title: "Todo", count: 2 }], counts: { total: 2, live: 1, blocked: 1 } },
    });
    expect(JSON.stringify(section)).not.toContain("/api/v1/board/issues/1");
  });

  it("parses a compact activity feed and sanitizes path-like summaries", () => {
    const section = parseActivitySection({
      kind: "http",
      status: 200,
      body: {
        activity: [
          {
            at: "2026-01-01T00:00:00.000Z",
            kind: "transcript_event",
            issue: { identifier: "TEST-1" },
            transcript: { message: "read C:\\Users\\john\\secret.txt" },
            links: { transcript: "/api/v1/runs/run-1/transcript" },
          },
          {
            at: "2026-01-01T00:00:01.000Z",
            kind: "writeback_operation",
            issue: { identifier: "TEST-2" },
            writeback: { operationKind: "comment", status: "pending" },
          },
        ],
        counts: { totalItems: 2 },
      },
    });

    expect(section).toMatchObject({
      status: "ready",
      data: {
        totalItems: 2,
        items: [
          { issueIdentifier: "TEST-1", summary: "read [path]" },
          { issueIdentifier: "TEST-2", summary: "comment pending" },
        ],
      },
    });
    expect(JSON.stringify(section)).not.toContain("/api/v1/runs");
  });
});
