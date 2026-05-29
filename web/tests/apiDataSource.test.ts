import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiDataSource, normalizeReferenceData } from "../src/data/apiDataSource";
import type { ChatMessage, HistoryModel, TranscriptMessage } from "../src/types/symphony";

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

const historyModel: HistoryModel = {
  sessions: [
    {
      id: "run/with space",
      issue: "ENG-106",
      title: "ENG-106: Integrate web history",
      state: "finished",
      model: "gpt-5.5",
      startedAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:05:00.000Z",
      msgCount: 2,
      lastEvent: "ENG-106 run finished",
      toolCount: 1,
    },
  ],
  transcriptBySession: {},
  timeline: [
    {
      t: "2026-05-29T00:05:00.000Z",
      sess: "run/with space",
      kind: "status",
      text: "ENG-106 run finished",
      state: "finished",
    },
  ],
  defaultSessionId: "run/with space",
};

const transcript: TranscriptMessage[] = [
  {
    kind: "user",
    ts: "2026-05-29T00:01:00.000Z",
    from: "operator",
    issue: "ENG-106",
    text: "Load history from the API.",
  },
  {
    kind: "assistant",
    ts: "2026-05-29T00:02:00.000Z",
    text: "History loaded.",
  },
];

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

  it("fetches issue detail from the encoded issue-detail endpoint", async () => {
    const detail = { issue: { id: "ENG/109", title: "Detail" }, activity: [], runs: [], transcript: [] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(detail));

    await expect(createApiDataSource("https://symphony.example.test///").getIssueDetail("ENG/109")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example.test/api/v1/web/issues/ENG%2F109", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("passes through null issue detail responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(null));

    await expect(createApiDataSource("").getIssueDetail("UNKNOWN-1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/issues/UNKNOWN-1", {
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

  it("loads the web history model from GET /api/v1/web/history", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(historyModel));

    await expect(createApiDataSource("http://localhost:7331/").getHistory()).resolves.toEqual(historyModel);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:7331/api/v1/web/history", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("loads selected session transcripts using the encoded web session id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(transcript));

    await expect(createApiDataSource("").getTranscript("run/with space")).resolves.toEqual(transcript);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/sessions/run%2Fwith%20space/transcript", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("loads GET /api/v1/web/orchestrator-chat from the configured API base URL", async () => {
    const chat: ChatMessage[] = [
      { who: "agent", text: "Chat loaded from the API.", suggestions: ["Inspect ENG-108"] },
      { who: "user", text: "show active workers" },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(chat));

    await expect(createApiDataSource("https://symphony.example///").getOrchestratorChat()).resolves.toEqual(chat);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example/api/v1/web/orchestrator-chat", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("posts orchestrator chat input to the same relative API boundary and returns the response chat", async () => {
    const responseChat: ChatMessage[] = [{ who: "user", text: "pause ENG-108" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(responseChat));

    await expect(createApiDataSource("").sendOrchestratorMessage("pause ENG-108")).resolves.toEqual(responseChat);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/orchestrator-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "pause ENG-108" }),
    });
  });

  it("surfaces non-2xx API responses as errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "nope" }, { status: 502 }));

    await expect(createApiDataSource("").getIssueBoard()).rejects.toThrow("Symphony API returned HTTP 502");
  });

  it("surfaces issue-detail HTTP failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));

    await expect(createApiDataSource("https://symphony.example.test").getIssueDetail("missing")).rejects.toThrow(
      "Symphony API returned HTTP 404",
    );
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example.test/api/v1/web/issues/missing", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("surfaces non-2xx history responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }, { status: 503 }));

    await expect(createApiDataSource("http://localhost:7331").getHistory()).rejects.toThrow("Symphony API returned HTTP 503");
  });

  it("surfaces non-2xx orchestrator chat responses instead of substituting mock chat", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: { code: "unavailable" } }, { status: 503 }));

    await expect(createApiDataSource("https://symphony.example").getOrchestratorChat()).rejects.toThrow(
      "Symphony API returned HTTP 503",
    );
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
