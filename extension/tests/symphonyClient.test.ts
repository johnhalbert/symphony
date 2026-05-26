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

  it("builds mutation headers only when a token is configured", () => {
    const client = new SymphonyClient();

    expect(client.buildMutationHeaders("")).toEqual({});
    expect(client.buildMutationHeaders(" token ")).toEqual({ [MUTATION_TOKEN_HEADER]: "token" });
  });

  it("reads board, activity, run, and transcript endpoints without mutation headers", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SymphonyClient();

    await client.fetchBoard("http://127.0.0.1:7331/", { refresh: true });
    await client.fetchBoardIssue("http://127.0.0.1:7331/", "ENG-8", { refresh: true });
    await client.fetchActivity("http://127.0.0.1:7331/", { issue: "ENG-8", offset: 50, limit: 25 });
    await client.fetchRun("http://127.0.0.1:7331/", "run-1");
    await client.fetchTranscript("http://127.0.0.1:7331/", "run-1", { offset: 100, limit: 50 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:7331/api/v1/board?refresh=1",
      "http://127.0.0.1:7331/api/v1/board/issues/ENG-8?refresh=1",
      "http://127.0.0.1:7331/api/v1/activity?issue=ENG-8&offset=50&limit=25",
      "http://127.0.0.1:7331/api/v1/runs/run-1",
      "http://127.0.0.1:7331/api/v1/runs/run-1/transcript?offset=100&limit=50",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.stringify(init)).not.toContain(MUTATION_TOKEN_HEADER);
    }
  });

  it("sends the mutation token only for open workspace", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ opened: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new SymphonyClient().openWorkspace("http://127.0.0.1:7331/", "ENG-8", " token ");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7331/api/v1/issues/ENG-8/open-workspace",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ [MUTATION_TOKEN_HEADER]: "token" }),
      }),
    );
  });

  it("surfaces status API error details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "tracker missing" } }), { status: 503 })));

    await expect(new SymphonyClient().fetchBoard("http://127.0.0.1:7331")).rejects.toThrow("tracker missing");
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
