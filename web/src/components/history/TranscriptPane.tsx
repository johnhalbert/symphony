import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SessionModel, TranscriptMessage } from "../../types/symphony";
import { Icon, SessionStateChip } from "../common";
import { Message } from "../messages/Message";

export function TranscriptPane({
  session,
  messages,
  status = null,
}: {
  session: SessionModel;
  messages: TranscriptMessage[];
  status?: ReactNode;
}) {
  const initialOpenSet = useMemo(() => new Set([5, 9, 10]), []);
  const [openSet, setOpenSet] = useState(initialOpenSet);

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
          <button className="btn" type="button">
            <span>{Icon.branch()}</span>Open workspace
          </button>
          <button className="btn" type="button">
            <span>{Icon.link()}</span>
            {session.issue}
          </button>
          <button className="icon-btn" title="More" type="button">
            {Icon.more()}
          </button>
        </div>
      </div>
      <div className="transcript">
        {status}
        {messages.length === 0 ? <div className="transcript-status">No transcript messages for this session.</div> : null}
        {messages.map((message, index) => (
          <Message key={`${message.kind}-${index}`} message={message} open={openSet.has(index)} onToggle={() => toggle(index)} />
        ))}
      </div>
    </div>
  );
}
