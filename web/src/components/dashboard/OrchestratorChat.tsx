import { useState } from "react";
import { Icon } from "../common";
import type { ChatMessage } from "../../types/symphony";
import { formatInlineText } from "../messages/messageFormat";

export function OrchestratorChat({
  error = null,
  loading = false,
  messages,
  onSend,
  agentLabel,
  readOnly = false,
  subtitle,
}: {
  error?: string | null;
  loading?: boolean;
  messages: ChatMessage[];
  onSend: (input: string) => Promise<void>;
  agentLabel?: string | null;
  readOnly?: boolean;
  subtitle?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const hasNoMessages = messages.length === 0;
  const readOnlyNotice =
    "API mode shows durable chat history only. Sending commands from this web chat is not supported yet; no orchestrator action will be dispatched.";
  const agentContextLabel = agentLabel?.trim() || "agent unavailable";

  async function submit(input = draft) {
    const trimmed = input.trim();
    if (readOnly || !trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="dash__chat">
      <div className="chat__head">
        <div className="av">SY</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <h3>Symphony orchestrator</h3>
          <span className="sub">{subtitle || "Dashboard context unavailable"}</span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" type="button">
          {Icon.more()}
        </button>
      </div>
      <div className="chat__body">
        {loading && hasNoMessages ? <div className="view-loading">Loading orchestrator chat...</div> : null}
        {error ? <div className="view-error">Orchestrator chat unavailable: {error}</div> : null}
        {!loading && !error && hasNoMessages ? <div className="view-empty">No durable orchestrator chat messages are available yet.</div> : null}
        {messages.map((message, index) => (
          <div className="chat__msg" key={`${message.who}-${index}-${message.text}`}>
            <div className={`who ${message.who === "user" ? "who--user" : ""}`}>
              <span className="av-tiny">{message.who === "user" ? "You" : "SY"}</span>
              {message.who === "user" ? "You" : "Orchestrator"}
              <span className="dot" style={{ width: 3, height: 3, borderRadius: 999, background: "var(--text-4)", display: "inline-block" }} />
              <span style={{ color: "var(--text-4)" }}>just now</span>
            </div>
            <div className="body">
              <p>{formatInlineText(message.text)}</p>
              {message.suggestions ? (
                <div style={{ marginTop: 4 }}>
                  {message.suggestions.map((suggestion, suggestionIndex) => (
                    <button className="chat__suggestion" disabled={readOnly || sending} key={suggestion} onClick={() => submit(suggestion)} type="button">
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
      {readOnly ? (
        <div className="chat__input chat__input--readonly" role="status" aria-live="polite">
          <div className="view-empty">{readOnlyNotice}</div>
        </div>
      ) : (
        <form
          className="chat__input"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="box">
            <textarea
              placeholder="Ask about the project, or issue a command (e.g. 'show stalled agents')..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="row">
              <button className="btn btn--ghost" type="button" style={{ padding: "2px 6px" }}>
                @ context
              </button>
              <button className="btn btn--ghost" type="button" style={{ padding: "2px 6px" }}>
                / commands
              </button>
              <div className="grow" />
              <span style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{agentContextLabel}</span>
              <button className="btn btn--primary" type="submit" style={{ padding: "3px 9px" }} disabled={sending || !draft.trim()}>
                {Icon.send()}
                {sending ? "Sending" : "Send"}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
