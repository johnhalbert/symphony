import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHistoryView } from "../src/components/history/ChatHistoryView";
import type { HistoryModel, SessionModel, TranscriptMessage } from "../src/types/symphony";

vi.mock("../src/hooks/useSymphonyData", () => ({
  useTranscript: () => {
    throw new Error("History view must not fetch selected-session transcripts in ENG-106");
  },
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
  it("renders API history default selection safely when transcriptBySession is empty or omitted", () => {
    const markup = renderToStaticMarkup(<ChatHistoryView history={history()} />);
    const omittedTranscriptMarkup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: undefined as unknown as HistoryModel["transcriptBySession"] })} />,
    );

    expect(markup).toContain("Sessions");
    expect(markup).toContain("API selected session");
    expect(markup).toContain("History API loaded");
    expect(markup).toContain("No transcript messages for this session.");
    expect(omittedTranscriptMarkup).toContain("API selected session");
    expect(omittedTranscriptMarkup).toContain("No transcript messages for this session.");
  });

  it("preserves embedded mock transcript fallback when provided in the history model", () => {
    const markup = renderToStaticMarkup(
      <ChatHistoryView history={history({ transcriptBySession: { "run-two": embeddedTranscript } })} />,
    );

    expect(markup).toContain("Mock transcript remains embedded.");
    expect(markup).not.toContain("No transcript messages for this session.");
  });

  it("renders timeline and empty-session variants from the history model", () => {
    const timelineMarkup = renderToStaticMarkup(<ChatHistoryView history={history()} variant="timeline" />);
    const emptyMarkup = renderToStaticMarkup(<ChatHistoryView history={history({ sessions: [], defaultSessionId: "", timeline: [] })} />);

    expect(timelineMarkup).toContain("Activity timeline");
    expect(timelineMarkup).toContain("History API loaded");
    expect(emptyMarkup).toContain("No sessions in history.");
  });
});
