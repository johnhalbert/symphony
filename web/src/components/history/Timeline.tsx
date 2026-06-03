import type { TimelineEvent, TranscriptMessage } from "../../types/symphony";
import { Icon, StatusBadge, UnavailableButton } from "../common";

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="history" style={{ gridTemplateColumns: "1fr" }}>
      <div className="transcript-wrap">
        <div className="transcript-head">
          <div>
            <h2>Activity timeline</h2>
            <div className="meta">
              <span>All sessions · last 1h</span>
              <span style={{ color: "var(--text-4)" }}>·</span>
              <span>4 running · 7 finished</span>
              <span style={{ color: "var(--text-4)" }}>·</span>
              <span>live</span>
              <span
                className="pulse"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--accent)",
                  boxShadow: "0 0 0 2px rgba(240,184,108,0.18)",
                  display: "inline-block",
                  animation: "pulse 1.6s ease-in-out infinite",
                }}
              />
            </div>
          </div>
          <div className="right">
            <UnavailableButton className="btn" unavailableLabel="Timeline filter" unavailableReason="timeline filtering is unavailable until a backed API command route exists">
              {Icon.filter()}Filter
            </UnavailableButton>
            <UnavailableButton className="btn" unavailableLabel="Group timeline by session" unavailableReason="timeline regrouping is unavailable until a backed API command route exists">
              Group by session
            </UnavailableButton>
          </div>
        </div>
        <div className="transcript" style={{ padding: "12px 24px 60px" }}>
          {events.map((event, index) => (
            <TimelineRow key={`${event.t}-${event.sess}-${index}`} event={event} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const avatar =
    {
      user: "av--user",
      assistant: "av--assist",
      thinking: "av--thinking",
      tool_call: "av--tool",
      status: "av--status",
      task: "av--task",
      request: "av--request",
      system: "av--system",
    }[event.kind] || "av--status";
  const label =
    {
      user: "User prompt",
      assistant: "Assistant",
      thinking: "Thinking",
      tool_call: "Tool call",
      status: "Status",
      task: "Task",
      request: "Request",
      system: "System",
    }[event.kind] || "Status";
  const marker: Record<TranscriptMessage["kind"], string> = {
    user: "U",
    assistant: "A",
    thinking: "...",
    tool_call: "T",
    status: ".",
    task: "OK",
    request: "?",
    system: "S",
  };

  return (
    <div
      className="timeline-row"
      style={{
        display: "grid",
        gridTemplateColumns: "70px 26px 1fr auto",
        alignItems: "center",
        gap: 14,
        padding: "8px 0",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 12,
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-4)" }}>{event.t}</span>
      <span className={`av ${avatar}`} style={{ width: 22, height: 22, borderRadius: 5, fontSize: 9, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        {marker[event.kind]}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--text-3)" }}>
          <span style={{ fontWeight: 500, color: "var(--text-2)" }}>{label}</span>
          <span style={{ color: "var(--text-4)" }}>·</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-2)" }}>{event.sess}</span>
          {event.state ? <StatusBadge state={event.state} /> : null}
        </div>
        <div style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{event.text}</div>
      </div>
      <span style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)", fontSize: 10.5 }} title="Timeline row navigation unavailable until a backed API route exists.">
        open unavailable
      </span>
    </div>
  );
}
