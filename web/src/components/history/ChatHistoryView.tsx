import { useState } from "react";
import type { HistoryModel, HistoryVariant } from "../../types/symphony";
import { SessionsList } from "./SessionsList";
import { Timeline } from "./Timeline";
import { TranscriptPane } from "./TranscriptPane";

export function ChatHistoryView({
  history,
  variant = "list",
}: {
  history: HistoryModel;
  variant?: HistoryVariant;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState(history.defaultSessionId);
  const session = history.sessions.find((candidate) => candidate.id === selectedSessionId) ?? history.sessions[0];

  if (variant === "timeline") {
    return <Timeline events={history.timeline} />;
  }

  if (!session) {
    return <div className="view-empty">No sessions in the mock history.</div>;
  }

  return (
    <div className="history">
      {variant !== "focused" ? <SessionsList sessions={history.sessions} selectedId={session.id} onSelect={setSelectedSessionId} /> : null}
      <TranscriptPane session={session} messages={history.transcriptBySession[session.id] ?? []} />
    </div>
  );
}
