// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHistoryView, resolveSelectedSessionId } from "../src/components/history/ChatHistoryView";
import type { HistoryModel, Loadable, SessionModel, TranscriptMessage } from "../src/types/symphony";
import {
  buildProjectedLargeRealRunTranscriptReadabilityFixture,
  projectedRealRunTranscriptReadabilityMessages,
} from "../../src/app/testing/real-run-transcript-readability.fixture.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const largeRealRunTranscriptCycleCount = 18;

const { useTranscriptMock } = vi.hoisted(() => ({
  useTranscriptMock: vi.fn<(sessionId: string | null, refreshToken?: unknown) => Loadable<TranscriptMessage[]>>(),
}));

vi.mock("../src/hooks/useSymphonyData", () => ({
  useTranscript: useTranscriptMock,
}));

const sessions: SessionModel[] = [
  {
    id: "run-one",
    issue: "ENG-100",
    title: "Earlier session",
    state: "finished",
    model: "gpt-5.5",
    startedAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:05:00.000Z",
    msgCount: 1,
    lastEvent: "Earlier run finished",
    toolCount: 0,
  },
  {
    id: "run-two",
    issue: "ENG-110",
    title: "API selected session",
    state: "running",
    model: "gpt-5.5",
    startedAt: "2026-05-29T00:10:00.000Z",
    updatedAt: "2026-05-29T00:15:00.000Z",
    msgCount: 2,
    lastEvent: "History API loaded",
    toolCount: 1,
  },
];

const embeddedTranscript: TranscriptMessage[] = [
  {
    kind: "user",
    ts: "2026-05-29T00:11:00.000Z",
    from: "operator",
    issue: "ENG-106",
    text: "Mock transcript remains embedded.",
  },
];

const apiTranscript: TranscriptMessage[] = [
  {
    kind: "assistant",
    ts: "2026-05-29T00:12:00.000Z",
    text: "Dedicated session transcript loaded from the API.",
  },
  {
    kind: "tool_call",
    ts: "2026-05-29T00:13:00.000Z",
    call_id: "call-1",
    name: "terminal",
    status: "completed",
    args: { preview: "npm test" },
    result: "tests passed",
  },
];

const realRunTranscriptMessages = projectedRealRunTranscriptReadabilityMessages;
const largeRealRunTranscriptFixture = buildProjectedLargeRealRunTranscriptReadabilityFixture({
  cycleCount: largeRealRunTranscriptCycleCount,
});
const largeRealRunTranscriptMessages = largeRealRunTranscriptFixture.messages;

function history(overrides: Partial<HistoryModel> = {}): HistoryModel {
  return {
    sessions,
    transcriptBySession: {},
    timeline: [
      {
        t: "2026-05-29T00:15:00.000Z",
        sess: "run-two",
        kind: "status",
        text: "History API loaded",
        state: "running",
      },
    ],
    defaultSessionId: "run-two",
    ...overrides,
  };
}

function transcriptState(overrides: Partial<Loadable<TranscriptMessage[]>> = {}): Loadable<TranscriptMessage[]> {
  return {
    data: apiTranscript,
    loading: false,
    error: null,
    ...overrides,
  };
}

function mountHistoryView(initialHistory: HistoryModel, refreshToken?: unknown) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  act(() => {
    root.render(<ChatHistoryView history={initialHistory} refreshToken={refreshToken} />);
  });

  return {
    container,
    rerender(nextHistory: HistoryModel, nextRefreshToken?: unknown) {
      act(() => {
        root.render(<ChatHistoryView history={nextHistory} refreshToken={nextRefreshToken} />);
      });
    },
  };
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("ChatHistoryView", () => {
  beforeEach(() => {
    useTranscriptMock.mockReset();
    useTranscriptMock.mockReturnValue(transcriptState());
  });

  it("resolves selected sessions across refreshed history boundaries", () => {
    expect(resolveSelectedSessionId("run-one", history())).toBe("run-one");
    expect(resolveSelectedSessionId("missing", history())).toBe("run-two");
    expect(resolveSelectedSessionId("", history({ defaultSessionId: "missing" }))).toBe("run-one");
    expect(resolveSelectedSessionId("missing", history({ sessions: [], defaultSessionId: "" }))).toBe("");
  });

  it("requests and renders the default selected session transcript from the dedicated session endpoint", () => {
    const markup = renderToStaticMarkup(<ChatHistoryView history={history()} />);

    expect(useTranscriptMock).toHaveBeenCalledTimes(1);
    expect(useTranscriptMock).toHaveBeenCalledWith("run-two", undefined);
    expect(markup).toContain("Sessions");
    expect(markup).toContain("API selected session");
    expect(markup).toContain("Dedicated session transcript loaded from the API.");
    expect(markup).toContain("terminal");
    expect(markup).not.toContain("No transcript messages for this session.");
  });

  it("renders a projected real-run transcript fixture and keeps multiline command output visible in the transcript UI", () => {
    useTranscriptMock.mockReturnValue(transcriptState({ data: realRunTranscriptMessages }));
    const fixtureSession = {
      ...sessions[1],
      title: "Real run readability fixture",
      msgCount: realRunTranscriptMessages.length,
      toolCount: 1,
      lastEvent: "Transcript readability fixture loaded",
    };
    const view = mountHistoryView(history({ sessions: [fixtureSession], defaultSessionId: fixtureSession.id }));

    expect(view.container.textContent).toContain(
      "Readability pass: split tokens and wrap long lines while preserving command output context.",
    );
    expect(view.container.textContent).toContain("Long transcript lines are now grouped and rendered with stable whitespace.");
    expect(view.container.textContent).toContain("Requests paused for provider window");
    expect(view.container.textContent).toContain("Cancelled after operator stop request token=[redacted]");
    expect(view.container.textContent).not.toContain("REAL_RUN_TOKEN_123456789");

    const toolCallButton = view.container.querySelector<HTMLButtonElement>(".toolcall__head");
    if (!toolCallButton) throw new Error("expected tool call button to render");
    act(() => {
      toolCallButton.click();
    });

    expect(view.container.textContent).toContain("tests: 42 passed");
    expect(view.container.textContent).toContain("coverage: 98.8%");
    expect(view.container.textContent).not.toContain("SECRET_REAL_RUN_API_KEY");
    expect(view.container.textContent).not.toContain("SECRET_PROVIDER_LIMIT_KEY");
  });

  it("renders the bounded projection of a generated large-session readability fixture without extra transcript rows", () => {
    useTranscriptMock.mockReturnValue(transcriptState({ data: largeRealRunTranscriptMessages }));
    const fixtureSession = {
      ...sessions[1],
      title: "Large transcript readability fixture",
      msgCount: largeRealRunTranscriptFixture.expectedMessageCount,
      toolCount: largeRealRunTranscriptFixture.expectedToolCallCount,
      lastEvent: "Large transcript fixture loaded",
    };
    const view = mountHistoryView(history({ sessions: [fixtureSession], defaultSessionId: fixtureSession.id }));

    expect(view.container.querySelectorAll(".msg, .lifecycle")).toHaveLength(largeRealRunTranscriptFixture.expectedMessageCount);
    expect(view.container.querySelectorAll(".toolcall__head")).toHaveLength(largeRealRunTranscriptFixture.expectedToolCallCount);
    expect(view.container.textContent).toContain("Cycle 01: merge transcript deltas and keep output previews readable.");
    expect(view.container.textContent).toContain("Run failed after provider interruption token=[redacted]");
    expect(view.container.textContent).not.toContain("LARGE_REAL_RUN_TOKEN_");
    expect(view.container.textContent).not.toContain("SECRET_PROVIDER_LIMIT_");
  });

  it("keeps selected session and scroll context while refreshed history adds and updates sessions", () => {
    const view = mountHistoryView(history(), "initial-token");
    const earlierButton = Array.from(view.container.querySelectorAll<HTMLButtonElement>(".session-row")).find((button) =>
      button.textContent?.includes("Earlier session"),
    );
    expect(earlierButton).toBeTruthy();

    act(() => {
      earlierButton?.click();
    });
    expect(useTranscriptMock).toHaveBeenLastCalledWith("run-one", "initial-token");

    const list = view.container.querySelector<HTMLDivElement>(".sessions__list");
    if (!list) throw new Error("expected sessions list to render");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2400 },
    });
    act(() => {
      list.scrollTop = 180;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    const refreshedSessions: SessionModel[] = [
      {
        ...sessions[1],
        id: "run-three",
        issue: "ENG-120",
        title: "New live session",
        updatedAt: "2026-05-29T00:20:00.000Z",
      },
      { ...sessions[0], title: "Earlier session refreshed", msgCount: 5, lastEvent: "Realtime refresh applied" },
      sessions[1],
    ];
    view.rerender(history({ sessions: refreshedSessions, defaultSessionId: "run-three" }), "refresh-token");

    expect(view.container.textContent).toContain("New live session");
    expect(view.container.querySelector('[data-selected="true"]')?.textContent).toContain("Earlier session refreshed");
    expect(list?.scrollTop).toBe(180);
    expect(useTranscriptMock).toHaveBeenLastCalledWith("run-one", "refresh-token");
  });

  it("renders dedicated selected-session transcript data even when embedded history data is present or omitted", () => {
    const embeddedMarkup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: { "run-two": embeddedTranscript } })} />,
    );
    const omittedTranscriptMarkup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: undefined as unknown as HistoryModel["transcriptBySession"] })} />,
    );

    expect(embeddedMarkup).toContain("Dedicated session transcript loaded from the API.");
    expect(embeddedMarkup).not.toContain("Mock transcript remains embedded.");
    expect(omittedTranscriptMarkup).toContain("API selected session");
    expect(omittedTranscriptMarkup).toContain("Dedicated session transcript loaded from the API.");
  });

  it("treats an exact empty transcript response as loaded-empty instead of substituting embedded messages", () => {
    useTranscriptMock.mockReturnValue(transcriptState({ data: [] }));

    const markup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: { "run-two": embeddedTranscript } })} />,
    );

    expect(useTranscriptMock).toHaveBeenCalledWith("run-two", undefined);
    expect(markup).toContain("No transcript messages for this session.");
    expect(markup).not.toContain("Mock transcript remains embedded.");
  });

  it("preserves embedded mock transcript fallback while the selected transcript request is still loading", () => {
    useTranscriptMock.mockReturnValue(transcriptState({ data: null, loading: true }));

    const markup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: { "run-two": embeddedTranscript } })} />,
    );

    expect(useTranscriptMock).toHaveBeenCalledWith("run-two", undefined);
    expect(markup).toContain("Mock transcript remains embedded.");
    expect(markup).toContain("Refreshing transcript... showing previous messages.");
    expect(markup).not.toContain("Loading transcript...");
  });

  it("surfaces loading and error states for API transcripts without fabricated messages", () => {
    useTranscriptMock.mockReturnValue(transcriptState({ data: null, loading: true }));
    const loadingMarkup = renderToStaticMarkup(<ChatHistoryView history={history()} />);
    expect(loadingMarkup).toContain("Loading transcript...");
    expect(loadingMarkup).not.toContain("Dedicated session transcript loaded from the API.");

    useTranscriptMock.mockReturnValue(transcriptState({ data: null, error: "Symphony API returned HTTP 503" }));
    const errorMarkup = renderToStaticMarkup(<ChatHistoryView history={history()} />);
    expect(errorMarkup).toContain("Transcript unavailable: Symphony API returned HTTP 503");
    expect(errorMarkup).not.toContain("Dedicated session transcript loaded from the API.");
  });

  it("keeps stale dedicated transcript messages visible when refresh fails", () => {
    useTranscriptMock.mockReturnValue(transcriptState({ data: apiTranscript, error: "Symphony API returned HTTP 503" }));

    const markup = renderToStaticMarkup(<ChatHistoryView history={history()} />);

    expect(markup).toContain("Could not refresh transcript: Symphony API returned HTTP 503. Showing previous messages.");
    expect(markup).toContain("Dedicated session transcript loaded from the API.");
    expect(markup).not.toContain("Transcript unavailable: Symphony API returned HTTP 503");
  });

  it("renders timeline and empty-session variants without fetching a selected-session transcript", () => {
    const timelineMarkup = renderToStaticMarkup(<ChatHistoryView history={history()} variant="timeline" />);
    expect(timelineMarkup).toContain("Activity timeline");
    expect(timelineMarkup).toContain("1 event");
    expect(timelineMarkup).toContain("2 sessions");
    expect(timelineMarkup).toContain("1 running · 1 finished");
    expect(timelineMarkup).toContain("durable history projection");
    expect(timelineMarkup).toContain("History API loaded");
    expect(timelineMarkup).not.toContain("4 running · 7 finished");
    expect(timelineMarkup).not.toContain("last 1h");
    expect(timelineMarkup).not.toContain(">live<");
    expect(useTranscriptMock).not.toHaveBeenCalled();

    const emptyTimelineMarkup = renderToStaticMarkup(<ChatHistoryView history={history({ timeline: [] })} variant="timeline" />);
    expect(emptyTimelineMarkup).toContain("No timeline events are available from the current history projection.");

    const emptyMarkup = renderToStaticMarkup(<ChatHistoryView history={history({ sessions: [], defaultSessionId: "", timeline: [] })} />);
    expect(emptyMarkup).toContain("No sessions in history.");
    expect(useTranscriptMock).not.toHaveBeenCalled();
  });
});
