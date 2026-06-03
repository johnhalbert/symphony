import { useState } from "react";
import { Icon, UnavailableButton } from "../common";
import { orchestratorChatStateNotice } from "../../data/orchestratorChat";
import type { ChatMessage, OrchestratorChatModel } from "../../types/symphony";
import { formatInlineText } from "../messages/messageFormat";

export function OrchestratorChat({
  error = null,
  loading = false,
  messages,
  projection,
  onSend,
  agentLabel,
  readOnly = false,
  subtitle,
}: {
  error?: string | null;
  loading?: boolean;
  messages: ChatMessage[];
  projection?: OrchestratorChatModel | null;
  onSend: (input: string) => Promise<void>;
  agentLabel?: string | null;
  readOnly?: boolean;
  subtitle?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const hasNoMessages = messages.length === 0;
  const stateNotice = projection ? orchestratorChatStateNotice(projection) : null;
  const readOnlyNotice =
    "API mode shows durable chat history only. Sending commands from this web chat is not supported yet; no orchestrator action will be dispatched.";
  const agentContextLabel = agentLabel?.trim() || "agent unavailable";

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
    <div className="dash__chat">
      <div className="chat__head">
        <div className="av">SY</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <h3>Symphony orchestrator</h3>
          <span className="sub">{subtitle || "Dashboard context unavailable"}</span>
        </div>
        <div style={{ flex: 1 }} />
        <UnavailableButton className="icon-btn" unavailableLabel="Orchestrator chat menu" unavailableReason="chat menus are unavailable until backend command routes exist">
          {Icon.more()}
        </UnavailableButton>
      </div>
      <div className="chat__body">
        {loading && hasNoMessages ? <div className="view-loading">Loading orchestrator chat...</div> : null}
        {error ? <div className="view-error">Orchestrator chat unavailable: {error}</div> : null}
        {sendError ? <div className="view-error">Orchestrator command failed: {sendError}</div> : null}
        {!loading && !error && stateNotice ? (
          <div className="view-empty" data-orchestrator-chat-state={projection?.state}>{stateNotice}</div>
        ) : null}
        {!loading && !error && !stateNotice && hasNoMessages ? <div className="view-empty">No durable orchestrator chat messages are available yet.</div> : null}
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
              <UnavailableButton className="btn btn--ghost" style={{ padding: "2px 6px" }} unavailableLabel="Chat context picker" unavailableReason="context insertion is unavailable until a backed API command route exists">
                @ context
              </UnavailableButton>
              <UnavailableButton className="btn btn--ghost" style={{ padding: "2px 6px" }} unavailableLabel="Chat command picker" unavailableReason="command browsing is unavailable until a backed API command route exists">
                / commands
              </UnavailableButton>
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
