import { describe, expect, it } from "vitest";
import type { RealtimeProjectionEvent, RealtimeProjectionResource } from "../src/data/dataSource";
import { combineLiveResourceTokens, createLiveResourceTokenMap, liveResourceKeysForRealtimeEvent, realtimeRefreshHrefsForEvent } from "../src/hooks/useLiveResource";

function eventFor(resources: readonly RealtimeProjectionResource[], overrides: Partial<RealtimeProjectionEvent> = {}): RealtimeProjectionEvent {
  return {
    id: "1",
    type: "projection.updated",
    revision: 1,
    createdAt: "2026-06-02T00:00:00.000Z",
    source: { source: "runs", revision: 1, observedAt: "2026-06-02T00:00:00.000Z" },
    resources,
    recovery: {
      strategy: "refetch",
      reason: "event",
      lastEventId: null,
      endpoints: resources.map((resource) => resource.href),
    },
    missedEvents: false,
    detail: null,
    ...overrides,
  };
}

describe("live resource realtime mapping", () => {
  it("maps source.status refresh hints to reference, issue board, and dashboard resources", () => {
    const event = eventFor(
      [
        { kind: "source", href: "/api/v1/web/reference-data?refresh=1", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues?refresh=1", relation: "refetch" },
        { kind: "dashboard", href: "/api/v1/web/dashboard?refresh=1", relation: "refetch" },
      ],
      { type: "source.status" },
    );

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual(["referenceData", "issueBoard", "dashboard"]);
    expect(realtimeRefreshHrefsForEvent(event)).toEqual([
      "/api/v1/web/reference-data?refresh=1",
      "/api/v1/web/issues?refresh=1",
      "/api/v1/web/dashboard?refresh=1",
    ]);
  });

  it("maps transcript template events to history and selected transcript refresh tokens", () => {
    const event = eventFor(
      [
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
        { kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" },
      ],
      { type: "transcript.delta" },
    );

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual(["history", "sessionTranscript"]);
  });

  it("falls back to all live resources when a missed-events recovery has no resource hints", () => {
    const event = eventFor([], {
      missedEvents: true,
      recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "old", endpoints: [] },
    });

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual([
      "referenceData",
      "dashboard",
      "issueBoard",
      "issueDetail",
      "history",
      "sidebar",
      "sessionTranscript",
      "orchestratorChat",
    ]);
  });

  it("combines resource counters for detail and transcript refresh dependencies", () => {
    const tokens = createLiveResourceTokenMap();
    tokens.issueBoard = 2;
    tokens.issueDetail = 3;
    tokens.history = 5;
    tokens.sessionTranscript = 7;

    expect(combineLiveResourceTokens(tokens, ["issueDetail", "issueBoard"])).toBe(5);
    expect(combineLiveResourceTokens(tokens, ["sessionTranscript", "history"])).toBe(12);
  });
});
