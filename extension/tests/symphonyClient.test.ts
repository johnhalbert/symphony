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
