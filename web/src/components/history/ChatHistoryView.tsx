import { useState } from "react";
import type { HistoryModel, HistoryVariant } from "../../types/symphony";
import { useTranscript } from "../../hooks/useSymphonyData";
import { SessionsList } from "./SessionsList";
import { Timeline } from "./Timeline";
import { TranscriptPane } from "./TranscriptPane";

export function ChatHistoryView({
  history,
  variant = "list",
  refreshToken,
}: {
  history: HistoryModel;
  variant?: HistoryVariant;
  refreshToken?: unknown;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState(history.defaultSessionId);
  const selectedSession = history.sessions.find((candidate) => candidate.id === selectedSessionId);
  const defaultSession = history.sessions.find((candidate) => candidate.id === history.defaultSessionId) ?? history.sessions[0];
  const session = selectedSession ?? defaultSession;

  if (variant === "timeline") {
    return <Timeline events={history.timeline} sessions={history.sessions} />;
  }

  if (!session) {
    return <div className="view-empty">No sessions in history.</div>;
  }

  return (
    <div className="history">
      {variant !== "focused" ? <SessionsList sessions={history.sessions} selectedId={session.id} onSelect={setSelectedSessionId} /> : null}
      <SelectedTranscript history={history} session={session} refreshToken={refreshToken} />
    </div>
  );
}

function SelectedTranscript({
  history,
  session,
  refreshToken,
}: {
  history: HistoryModel;
  session: HistoryModel["sessions"][number];
  refreshToken?: unknown;
}) {
  const transcript = useTranscript(session.id, refreshToken);
  const embeddedMessages = history.transcriptBySession?.[session.id] ?? [];
  const messages = transcript.data ?? embeddedMessages;

  return (
    <TranscriptPane
      key={session.id}
      session={session}
      messages={messages}
      loading={transcript.loading}
      error={transcript.error}
    />
  );
}
