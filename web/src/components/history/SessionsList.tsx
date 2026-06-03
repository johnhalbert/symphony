import type { SessionModel } from "../../types/symphony";
import { Icon, SessionStateChip, StatusBadgeDot, UnavailableButton } from "../common";

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
        <UnavailableButton className="icon-btn" unavailableLabel="Filter" unavailableReason="session filtering is unavailable until a backed API command route exists">
          {Icon.filter()}
        </UnavailableButton>
        <UnavailableButton className="icon-btn" unavailableLabel="Sort" unavailableReason="session sorting is unavailable until a backed API command route exists">
          {Icon.sort()}
        </UnavailableButton>
      </div>
      <div className="sessions__filter">
        <span className="pill btn--readonly" data-active="true" title="Read-only session filter state from the API history view." aria-label="All sessions selected">
          All
        </span>
        <UnavailableButton className="pill" unavailableLabel="Running sessions filter" unavailableReason="session status filtering is unavailable until a backed API command route exists">
          Running <span style={{ color: "var(--accent)", marginLeft: 4 }}>{sessions.filter((session) => session.state === "running").length}</span>
        </UnavailableButton>
        <UnavailableButton className="pill" unavailableLabel="Finished sessions filter" unavailableReason="session status filtering is unavailable until a backed API command route exists">
          Finished
        </UnavailableButton>
        <UnavailableButton className="pill" unavailableLabel="Error sessions filter" unavailableReason="session status filtering is unavailable until a backed API command route exists">
          Errors
        </UnavailableButton>
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
