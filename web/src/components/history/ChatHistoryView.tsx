import { useState } from "react";
import type { HistoryModel, HistoryVariant } from "../../types/symphony";
import { useTranscript } from "../../hooks/useSymphonyData";
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

  if (variant === "timeline") {
    return <Timeline events={history.timeline} />;
  }

  if (!session) {
    return <div className="view-empty">No sessions in history.</div>;
  }

  return (
    <div className="history">
      {variant !== "focused" ? <SessionsList sessions={history.sessions} selectedId={session.id} onSelect={setSelectedSessionId} /> : null}
      <SelectedTranscript history={history} session={session} />
    </div>
  );
}

function SelectedTranscript({ history, session }: { history: HistoryModel; session: HistoryModel["sessions"][number] }) {
  const transcript = useTranscript(session.id);
  const embeddedMessages = history.transcriptBySession?.[session.id] ?? [];
  const messages = transcript.error ? [] : (transcript.data ?? embeddedMessages);

  return (
    <TranscriptPane
      key={session.id}
      session={session}
      messages={messages}
      loading={transcript.loading && messages.length === 0}
      error={transcript.error}
    />
  );
}
