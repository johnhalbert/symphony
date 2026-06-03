import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHistoryView } from "../src/components/history/ChatHistoryView";
import type { HistoryModel, Loadable, SessionModel, TranscriptMessage } from "../src/types/symphony";

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

describe("ChatHistoryView", () => {
  beforeEach(() => {
    useTranscriptMock.mockReset();
    useTranscriptMock.mockReturnValue(transcriptState());
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
