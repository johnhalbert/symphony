import type { SessionModel } from "../../types/symphony";
import { Icon, SessionStateChip, StatusBadgeDot } from "../common";

export function SidebarHistory({ sessions }: { sessions: SessionModel[] }) {
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "40px auto 1fr", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 12px", gap: 10, background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>Chat history</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>{sessions.length}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" type="button">
          {Icon.search()}
        </button>
        <button className="icon-btn" type="button">
          {Icon.filter()}
        </button>
      </div>
      <div style={{ padding: "8px 10px 4px", display: "flex", gap: 5, borderBottom: "1px solid var(--border-subtle)" }}>
        <button className="pill" data-active="true" type="button" style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: "var(--elevated)" }}>
          All
        </button>
        <button className="pill" type="button" style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-3)" }}>
          Running
        </button>
        <button className="pill" type="button" style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-3)" }}>
          Errors
        </button>
      </div>
      <div style={{ overflow: "auto" }}>
        {sessions.length ? (
          sessions.map((session) => (
            <div className="session-row" key={session.id} style={{ gridTemplateColumns: "14px 1fr", padding: "9px 12px" }}>
              <span className="ico">
                <StatusBadgeDot state={session.state} />
              </span>
              <div className="info">
                <div className="top">
                  <span className="id">{session.issue}</span>
                  <SessionStateChip state={session.state} />
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{session.updatedAt}</span>
                </div>
                <div className="t" style={{ fontSize: 11.5 }}>
                  {session.title}
                </div>
                <div className="meta" style={{ fontSize: 10 }}>
                  <span>
                    {session.msgCount} msgs · {session.toolCount} tools
                  </span>
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{session.lastEvent}</div>
              </div>
            </div>
          ))
        ) : (
          <div style={{ color: "var(--text-4)", fontSize: 12, lineHeight: 1.5, padding: "12px" }}>
            No sidebar sessions yet.
          </div>
        )}
      </div>
    </div>
  );
}
