import type { SessionModel } from "../../types/symphony";
import { Icon, SessionStateChip, StatusBadgeDot } from "../common";

export function SessionsList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionModel[];
  selectedId: string;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <div className="history__sessions">
      <div className="colhead">
        <h3>
          Sessions <span className="count">{sessions.length}</span>
        </h3>
        <div className="grow" />
        <button className="icon-btn" title="Filter" type="button">
          {Icon.filter()}
        </button>
        <button className="icon-btn" title="Sort" type="button">
          {Icon.sort()}
        </button>
      </div>
      <div className="sessions__filter">
        <button className="pill" data-active="true" type="button">
          All
        </button>
        <button className="pill" type="button">
          Running <span style={{ color: "var(--accent)", marginLeft: 4 }}>{sessions.filter((session) => session.state === "running").length}</span>
        </button>
        <button className="pill" type="button">
          Finished
        </button>
        <button className="pill" type="button">
          Errors
        </button>
      </div>
      <div className="sessions__list">
        {sessions.map((session) => (
          <button
            className="session-row"
            data-selected={session.id === selectedId}
            key={session.id}
            onClick={() => onSelect(session.id)}
            style={{ textAlign: "left", width: "100%" }}
            type="button"
          >
            <span className="ico">
              <StatusBadgeDot state={session.state} />
            </span>
            <div className="info">
              <div className="top">
                <span className="id">{session.issue}</span>
                <SessionStateChip state={session.state} />
              </div>
              <div className="t">{session.title}</div>
              <div className="meta">
                <span>{session.model}</span>
                <span style={{ color: "var(--text-4)" }}>·</span>
                <span>{session.msgCount} msgs</span>
                <span style={{ color: "var(--text-4)" }}>·</span>
                <span>{session.toolCount} tools</span>
              </div>
              <div className="meta" style={{ color: "var(--text-4)" }}>
                {session.lastEvent}
              </div>
            </div>
            <div className="right">{session.updatedAt}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
