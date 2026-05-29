import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHistoryView } from "../src/components/history/ChatHistoryView";
import type { HistoryModel, SessionModel, TranscriptMessage } from "../src/types/symphony";

const hookMocks = vi.hoisted(() => ({
  useTranscript: vi.fn(),
}));

vi.mock("../src/hooks/useSymphonyData", () => hookMocks);

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
    issue: "ENG-106",
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

const selectedTranscript: TranscriptMessage[] = [
  {
    kind: "assistant",
    ts: "2026-05-29T00:15:00.000Z",
    text: "Selected transcript loaded from the dedicated session endpoint.",
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

describe("ChatHistoryView", () => {
  beforeEach(() => {
    hookMocks.useTranscript.mockImplementation((sessionId: string | null) => ({
      data: sessionId === "run-two" ? selectedTranscript : [],
      loading: false,
      error: null,
    }));
  });

  it("renders API history default selection safely when transcriptBySession is empty or omitted", () => {
    const markup = renderToStaticMarkup(<ChatHistoryView history={history()} />);
    const omittedTranscriptMarkup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: undefined as unknown as HistoryModel["transcriptBySession"] })} />,
    );

    expect(markup).toContain("Sessions");
    expect(markup).toContain("API selected session");
    expect(markup).toContain("History API loaded");
    expect(markup).toContain("Selected transcript loaded from the dedicated session endpoint.");
    expect(omittedTranscriptMarkup).toContain("API selected session");
    expect(omittedTranscriptMarkup).toContain("Selected transcript loaded from the dedicated session endpoint.");
    expect(hookMocks.useTranscript).toHaveBeenCalledWith("run-two");
  });

  it("renders selected-session transcript hook data instead of embedded history-model transcript data", () => {
    const markup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: { "run-two": embeddedTranscript } })} />,
    );

    expect(markup).toContain("Selected transcript loaded from the dedicated session endpoint.");
    expect(markup).not.toContain("Mock transcript remains embedded.");
    expect(markup).not.toContain("No transcript messages for this session.");
  });

  it("surfaces selected-session transcript loading and error states", () => {
    hookMocks.useTranscript.mockReturnValue({ data: null, loading: true, error: "Symphony API returned HTTP 503" });

    const markup = renderToStaticMarkup(<ChatHistoryView history={history()} />);

    expect(markup).toContain("Loading transcript");
    expect(markup).toContain("Unable to load transcript: Symphony API returned HTTP 503");
  });

  it("renders timeline and empty-session variants from the history model", () => {
    const timelineMarkup = renderToStaticMarkup(<ChatHistoryView history={history()} variant="timeline" />);
    const emptyMarkup = renderToStaticMarkup(<ChatHistoryView history={history({ sessions: [], defaultSessionId: "", timeline: [] })} />);

    expect(timelineMarkup).toContain("Activity timeline");
    expect(timelineMarkup).toContain("History API loaded");
    expect(emptyMarkup).toContain("No sessions in history.");
  });
});
