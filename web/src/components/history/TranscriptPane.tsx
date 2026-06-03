import { useMemo, useState } from "react";
import type { SessionModel, TranscriptMessage } from "../../types/symphony";
import { Icon, SessionStateChip, UnavailableButton } from "../common";
import { Message } from "../messages/Message";

export function TranscriptPane({
  session,
  messages,
  loading = false,
  error = null,
}: {
  session: SessionModel;
  messages: TranscriptMessage[];
  loading?: boolean;
  error?: string | null;
}) {
  const initialOpenSet = useMemo(() => new Set([5, 9, 10]), []);
  const [openSet, setOpenSet] = useState(initialOpenSet);
  const hasMessages = messages.length > 0;

  function toggle(index: number) {
    setOpenSet((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript-head">
        <div>
          <h2>{session.title}</h2>
          <div className="meta">
            <span style={{ color: "var(--text-2)", fontFamily: "var(--font-sans)" }}>
              <strong style={{ color: "var(--text)", fontWeight: 500 }}>{session.issue}</strong>
            </span>
            <SessionStateChip state={session.state} />
            <span>{session.model}</span>
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>{session.id}</span>
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>
              {session.msgCount} messages · {session.toolCount} tools
            </span>
          </div>
        </div>
        <div className="right">
          <UnavailableButton className="btn" unavailableLabel="Open workspace" unavailableReason="workspace navigation is unavailable until a safe command route exists">
            <span>{Icon.branch()}</span>Open workspace
          </UnavailableButton>
          <UnavailableButton className="btn" unavailableLabel="Open issue" unavailableReason="issue navigation from transcripts is unavailable until a safe route exists">
            <span>{Icon.link()}</span>
            {session.issue}
          </UnavailableButton>
          <UnavailableButton className="icon-btn" unavailableLabel="More" unavailableReason="transcript action menus are unavailable until backend command routes exist">
            {Icon.more()}
          </UnavailableButton>
        </div>
      </div>
      <div className="transcript">
        {loading ? (
          <div className="transcript-status">
            {hasMessages ? "Refreshing transcript... showing previous messages." : "Loading transcript..."}
          </div>
        ) : null}
        {error ? (
          <div className="transcript-status">
            {hasMessages ? `Could not refresh transcript: ${error}. Showing previous messages.` : `Transcript unavailable: ${error}`}
          </div>
        ) : null}
        {!loading && !error && !hasMessages ? <div className="transcript-status">No transcript messages for this session.</div> : null}
        {messages.map((message, index) => (
          <Message key={`${message.kind}-${index}`} message={message} open={openSet.has(index)} onToggle={() => toggle(index)} />
        ))}
      </div>
    </div>
  );
}
