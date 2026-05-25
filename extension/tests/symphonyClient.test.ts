import { afterEach, describe, expect, it, vi } from "vitest";
import { SYMPHONY_PROBE_TIMEOUT_MS } from "../src/connectionState";
import { MUTATION_TOKEN_HEADER, SymphonyClient } from "../src/symphonyClient";

describe("SymphonyClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("probes the public state endpoint without a token header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const state = await new SymphonyClient().probeState("http://127.0.0.1:7331/", "secret");

    expect(state.kind).toBe("connected");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7331/api/v1/state",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain(MUTATION_TOKEN_HEADER);
  });

  it("fetches dashboard sections from public read endpoints without token headers", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/state")) {
        return new Response(
          JSON.stringify({
            generatedAt: "2026-01-01T00:00:00.000Z",
            operatorView: {
              running: [{ issueIdentifier: "TEST-1", role: "worker", liveness: { status: "running" } }],
              paused: [],
              orphaned: [],
              retrying: [],
              mutationsRequireToken: true,
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/v1/board?refresh=1")) {
        return new Response(JSON.stringify({ columns: [{ id: "todo", title: "Todo", count: 1 }], counts: { total: 1 } }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/v1/activity?offset=0&limit=20")) {
        return new Response(JSON.stringify({ activity: [], counts: { totalItems: 0 } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await new SymphonyClient().fetchDashboard("http://127.0.0.1:7331/", "secret", undefined, { refreshBoard: true });

    expect(state.connection.kind).toBe("connected");
    expect(state.sections?.operatorQueues).toMatchObject({ status: "ready", data: { running: [{ issueIdentifier: "TEST-1" }] } });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:7331/api/v1/state",
      "http://127.0.0.1:7331/api/v1/board?refresh=1",
      "http://127.0.0.1:7331/api/v1/activity?offset=0&limit=20",
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(MUTATION_TOKEN_HEADER);
  });

  it("keeps the dashboard connected when the board tracker is unavailable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/state")) {
        return new Response(JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", operatorView: {} }), { status: 200 });
      }
      if (url.endsWith("/api/v1/board")) {
        return new Response(JSON.stringify({ error: { code: "tracker_unavailable", message: "Issue board requires a configured tracker client" } }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ activity: [], counts: { totalItems: 0 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await new SymphonyClient().fetchDashboard("http://127.0.0.1:7331", "");

    expect(state.connection.kind).toBe("connected");
    expect(state.sections?.board).toMatchObject({ status: "unavailable" });
  });

  it("skips dashboard section fetches when the state probe fails", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const state = await new SymphonyClient().fetchDashboard("http://127.0.0.1:7331", "");

    expect(state.connection).toMatchObject({ kind: "error", reason: "http_status" });
    expect(state.sections).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds mutation headers only when a token is configured", () => {
    const client = new SymphonyClient();

    expect(client.buildMutationHeaders("")).toEqual({});
    expect(client.buildMutationHeaders(" token ")).toEqual({ [MUTATION_TOKEN_HEADER]: "token" });
  });

  it("classifies timeout aborts as offline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      }),
    );

    const promise = new SymphonyClient().probeState("http://127.0.0.1:7331", "");
    await vi.advanceTimersByTimeAsync(SYMPHONY_PROBE_TIMEOUT_MS);

    await expect(promise).resolves.toMatchObject({ kind: "offline", reason: "timeout" });
  });
});
