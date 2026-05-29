import { useState } from "react";
import { useTranscript } from "../../hooks/useSymphonyData";
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
  const selectedSession = history.sessions.find((candidate) => candidate.id === selectedSessionId);
  const defaultSession = history.sessions.find((candidate) => candidate.id === history.defaultSessionId) ?? history.sessions[0];
  const session = selectedSession ?? defaultSession;
  const transcriptSessionId = variant === "timeline" ? null : (session?.id ?? null);
  const transcript = useTranscript(transcriptSessionId);

  if (variant === "timeline") {
    return <Timeline events={history.timeline} />;
  }

  if (!session) {
    return <div className="view-empty">No sessions in history.</div>;
  }

  return (
    <div className="history">
      {variant !== "focused" ? <SessionsList sessions={history.sessions} selectedId={session.id} onSelect={setSelectedSessionId} /> : null}
      <TranscriptPane
        session={session}
        messages={transcript.data ?? []}
        status={
          <>
            {transcript.loading ? <div className="view-loading">Loading transcript...</div> : null}
            {transcript.error ? <div className="view-error">Unable to load transcript: {transcript.error}</div> : null}
          </>
        }
      />
    </div>
  );
}
