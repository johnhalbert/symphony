import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiDataSource, normalizeReferenceData } from "../src/data/apiDataSource";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

  it("fetches the dedicated sidebar endpoint without remapping enriched issue fields", async () => {
    const sidebar = {
      providerGates: [],
      runningAgents: [{ id: "agent-1", issue: "ENG-7", title: "Sidebar", state: "running", step: "render", duration: "1m", tokens: "1k" }],
      reviewIssues: [
        {
          id: "ENG-8",
          title: "Review enriched issue",
          status: "review",
          priority: "urgent",
          labels: ["dogfood", "api"],
          assignee: "reviewer-1",
          agent: "agent-2",
          project: "Symphony",
          cycle: "Cycle 1",
          activity: [{ t: "now", verb: "reviewed", val: "pass", who: "bot" }],
          pr: "#123",
          ci: "green",
          workspace: "ENG-8",
          session: "session-8",
        },
      ],
      activity: [],
      sessions: [],
      chat: [],
      totals: { backlog: 0, todo: 0, progress: 0, review: 1, done: 0, cancelled: 0, open: 1, all: 1, completeness: 0 },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(sidebar));

    await expect(createApiDataSource("").getSidebar()).resolves.toEqual(sidebar);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/sidebar", {
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

describe("api data source reference data", () => {
  it("loads GET /api/v1/web/reference-data from the configured API base URL", async () => {
    const fetchMock = vi.fn(async () =>
      mockJsonResponse({
        users: {
          unassigned: { name: "Unassigned", color: "#6f7785" },
          "delegate-review": { name: "delegate-review", color: null },
        },
        labels: {
          "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const dataSource = createApiDataSource("https://symphony.example///");
    const reference = await dataSource.getReferenceData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example/api/v1/web/reference-data", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
    expect(reference).toEqual({
      users: {
        unassigned: { name: "Unassigned", color: "#6f7785" },
        "delegate-review": { name: "delegate-review", color: null },
      },
      labels: {
        "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
      },
    });
  });

  it("normalizes sparse reference records without dropping usable keys", () => {
    expect(
      normalizeReferenceData({
        users: {
          "delegate-a": { name: "  ", color: null },
          "user-b": null,
        },
        labels: {
          alpha: { color: "#123456" },
          beta: { name: "Beta", color: undefined },
        },
      }),
    ).toEqual({
      users: {
        "delegate-a": { name: "delegate-a", color: null },
        "user-b": { name: "user-b", color: null },
      },
      labels: {
        alpha: { name: "alpha", color: "#123456" },
        beta: { name: "Beta", color: null },
      },
    });
  });

  it("surfaces HTTP failures while loading reference data", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: { code: "tracker_unavailable" } }, 503)) as typeof fetch;

    await expect(createApiDataSource("https://symphony.example").getReferenceData()).rejects.toThrow(
      "Symphony API returned HTTP 503",
    );
  });
});
