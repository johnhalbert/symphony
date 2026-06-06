import { useEffect, useState } from "react";
import type { HistoryModel, HistoryVariant } from "../../types/symphony";
import { useTranscript } from "../../hooks/useSymphonyData";
import { SessionsList } from "./SessionsList";
import { Timeline } from "./Timeline";
import { TranscriptPane } from "./TranscriptPane";

export function resolveSelectedSessionId(
  currentSelectedId: string,
  history: Pick<HistoryModel, "sessions" | "defaultSessionId">,
): string {
  if (currentSelectedId && history.sessions.some((session) => session.id === currentSelectedId)) return currentSelectedId;
  if (history.defaultSessionId && history.sessions.some((session) => session.id === history.defaultSessionId)) return history.defaultSessionId;
  return history.sessions[0]?.id ?? "";
}

export function ChatHistoryView({
  history,
  variant = "list",
  refreshToken,
}: {
  history: HistoryModel;
  variant?: HistoryVariant;
  refreshToken?: unknown;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState(() => resolveSelectedSessionId(history.defaultSessionId, history));
  useEffect(() => {
    setSelectedSessionId((currentSelectedId) => resolveSelectedSessionId(currentSelectedId, history));
  }, [history.sessions, history.defaultSessionId]);

  const effectiveSelectedSessionId = resolveSelectedSessionId(selectedSessionId, history);
  const session = history.sessions.find((candidate) => candidate.id === effectiveSelectedSessionId);

  if (variant === "timeline") {
    return <Timeline events={history.timeline} sessions={history.sessions} />;
  }

  if (!session) {
    return <div className="view-empty">No sessions in history.</div>;
  }

  return (
    <div className="history">
      {variant !== "focused" ? <SessionsList sessions={history.sessions} selectedId={effectiveSelectedSessionId} onSelect={setSelectedSessionId} /> : null}
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
      activeTail={transcript.activeTail}
      hasPrevious={transcript.hasPrevious}
      loadingPrevious={transcript.loadingPrevious}
      previousError={transcript.previousError}
      onLoadPrevious={transcript.loadPrevious}
    />
  );
}
