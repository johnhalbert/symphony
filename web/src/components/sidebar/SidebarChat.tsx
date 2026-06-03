import { useState } from "react";
import { orchestratorChatStateNotice } from "../../data/orchestratorChat";
import type { ChatMessage, OrchestratorChatModel } from "../../types/symphony";
import { Icon, UnavailableButton } from "../common";
import { formatInlineText } from "../messages/messageFormat";

export function SidebarChat({
  error = null,
  loading = false,
  messages,
  projection,
  onSend,
  readOnly = false,
  subtitle,
}: {
  error?: string | null;
  loading?: boolean;
  messages: ChatMessage[];
  projection?: OrchestratorChatModel | null;
  onSend: (input: string) => Promise<void>;
  readOnly?: boolean;
  subtitle?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const recent = messages.slice(-3);
  const chatError = error
    ? recent.length === 0
      ? `Orchestrator chat unavailable: ${error}`
      : `Could not refresh orchestrator chat: ${error}. Showing previous messages.`
    : null;
  const stateNotice = projection ? orchestratorChatStateNotice(projection, true) : null;
  const readOnlyNotice =
    "API mode shows durable chat history only. Sending commands from this compact chat is not supported yet; no orchestrator action will be dispatched.";
  const contextLabel = readOnly ? "read-only API mode" : sending ? "sending command..." : (subtitle?.trim() || "agent context unavailable");

  async function submit(input = draft) {
    const trimmed = input.trim();
    if (readOnly || !trimmed || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(trimmed);
      setDraft("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "40px 1fr auto", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 12px", gap: 10, background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
        <div className="av" style={{ width: 22, height: 22, borderRadius: 5, background: "linear-gradient(135deg, var(--accent), #a85f2e)", color: "#1a1208", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          SY
        </div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Orchestrator</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {contextLabel}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <UnavailableButton className="icon-btn" unavailableLabel="Compact chat history" unavailableReason="compact chat history navigation is unavailable until a backed API route exists">
          {Icon.history()}
        </UnavailableButton>
      </div>

      <div style={{ overflow: "auto", padding: "14px 14px 6px", display: "flex", flexDirection: "column", gap: 14 }}>
        {loading && recent.length === 0 ? <div className="view-loading">Loading orchestrator chat...</div> : null}
        {loading && recent.length > 0 ? <div className="transcript-status">Refreshing orchestrator chat... showing previous messages.</div> : null}
        {chatError ? <div className="view-error">{chatError}</div> : null}
        {sendError ? <div className="view-error">Orchestrator command failed: {sendError}</div> : null}
        {!loading && !error && stateNotice ? (
          <div className="view-empty" data-orchestrator-chat-state={projection?.state}>{stateNotice}</div>
        ) : null}
        {!loading && !error && !stateNotice && recent.length === 0 ? <div className="view-empty">No durable orchestrator chat messages are available yet.</div> : null}
        {recent.map((message, index) => (
          <div key={`${message.text}-${index}`} className="chat__msg">
            <div className={`who ${message.who === "user" ? "who--user" : ""}`}>
              <span className="av-tiny">{message.who === "user" ? "You" : "SY"}</span>
              {message.who === "user" ? "You" : "Orchestrator"}
            </div>
            <div className="body">
              <p>{formatInlineText(message.text)}</p>
              {message.suggestions?.length ? (
                <div style={{ marginTop: 4 }}>
                  {message.suggestions.map((suggestion, suggestionIndex) => (
                    <button
                      className="chat__suggestion"
                      disabled={readOnly || sending}
                      key={suggestion}
                      onClick={() => submit(suggestion)}
                      style={{ marginBottom: 4 }}
                      type="button"
                    >
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
            <textarea placeholder="Ask or command..." value={draft} onChange={(event) => setDraft(event.target.value)} style={{ minHeight: 34 }} />
            <div className="row">
              <UnavailableButton className="btn btn--ghost" style={{ padding: "1px 6px", fontSize: 10.5 }} unavailableLabel="Compact chat context picker" unavailableReason="context insertion is unavailable until a backed API command route exists">
                @ context
              </UnavailableButton>
              <UnavailableButton className="btn btn--ghost" style={{ padding: "1px 6px", fontSize: 10.5 }} unavailableLabel="Compact chat command picker" unavailableReason="command browsing is unavailable until a backed API command route exists">
                /
              </UnavailableButton>
              <div className="grow" />
              <button className="btn btn--primary" type="submit" style={{ padding: "2px 8px" }} disabled={sending || !draft.trim()}>
                {Icon.send()}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
