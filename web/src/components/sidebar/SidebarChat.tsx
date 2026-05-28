import type { ChatMessage } from "../../types/symphony";
import { Icon } from "../common";
import { formatInlineText } from "../messages/messageFormat";

export function SidebarChat({ messages }: { messages: ChatMessage[] }) {
  const recent = messages.slice(-3);
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "40px 1fr auto", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 12px", gap: 10, background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
        <div className="av" style={{ width: 22, height: 22, borderRadius: 5, background: "linear-gradient(135deg, var(--accent), #a85f2e)", color: "#1a1208", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          SY
        </div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Orchestrator</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>codex-1 · cycle 14</span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" type="button">
          {Icon.history()}
        </button>
      </div>

      <div style={{ overflow: "auto", padding: "14px 14px 6px", display: "flex", flexDirection: "column", gap: 14 }}>
        {recent.map((message, index) => (
          <div key={`${message.text}-${index}`} className="chat__msg">
            <div className={`who ${message.who === "user" ? "who--user" : ""}`}>
              <span className="av-tiny">{message.who === "user" ? "You" : "SY"}</span>
              {message.who === "user" ? "You" : "Orchestrator"}
            </div>
            <div className="body">
              <p>{formatInlineText(message.text)}</p>
              {message.suggestions ? (
                <div style={{ marginTop: 4 }}>
                  {message.suggestions.map((suggestion, suggestionIndex) => (
                    <button className="chat__suggestion" key={suggestion} style={{ marginBottom: 4 }} type="button">
                      {suggestionIndex === 0 ? Icon.bolt() : null}
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="chat__input">
        <div className="box">
          <textarea placeholder="Ask or command..." defaultValue="" style={{ minHeight: 34 }} />
          <div className="row">
            <button className="btn btn--ghost" type="button" style={{ padding: "1px 6px", fontSize: 10.5 }}>
              @ context
            </button>
            <button className="btn btn--ghost" type="button" style={{ padding: "1px 6px", fontSize: 10.5 }}>
              /
            </button>
            <div className="grow" />
            <button className="btn btn--primary" type="button" style={{ padding: "2px 8px" }}>
              {Icon.send()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
