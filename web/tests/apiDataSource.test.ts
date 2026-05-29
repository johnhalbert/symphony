import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiDataSource } from "../src/data/apiDataSource";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("API data source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses same-origin /api paths when no base URL is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ projectName: "Symphony" }));

    await createApiDataSource("").getDashboard();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("normalizes absolute base URLs and encodes path parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "ENG/102" }));

    await createApiDataSource("https://symphony.test///").getIssueDetail("ENG/102");

    expect(fetchMock).toHaveBeenCalledWith("https://symphony.test/api/v1/web/issues/ENG%2F102", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("posts orchestrator chat messages through the same relative API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([{ speaker: "system", text: "Queued" }]));

    await createApiDataSource("").sendOrchestratorMessage("refresh status");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/orchestrator-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "refresh status" }),
    });
  });

  it("surfaces non-2xx API responses as errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "nope" }, { status: 502 }));

    await expect(createApiDataSource("").getIssueBoard()).rejects.toThrow("Symphony API returned HTTP 502");
  });
});
