import type { ReactNode } from "react";
import { Icon, StatusBadge, UnavailableButton } from "../common";
import type { TranscriptMessage } from "../../types/symphony";
import { Paragraphs } from "./messageFormat";

function MsgGutter({ kind }: { kind: TranscriptMessage["kind"] }) {
  const avatar =
    {
      system: { cls: "av--system", label: "S" },
      user: { cls: "av--user", label: "U" },
      assistant: { cls: "av--assist", label: "A" },
      thinking: { cls: "av--thinking", label: "..." },
      tool_call: { cls: "av--tool", label: "T" },
      status: { cls: "av--status", label: "." },
      task: { cls: "av--task", label: "OK" },
      request: { cls: "av--request", label: "?" },
    }[kind] || { cls: "av--status", label: "." };
  return (
    <div className="msg__gutter">
      <span className={`av ${avatar.cls}`}>{avatar.label}</span>
      <span className="line" />
    </div>
  );
}

function MsgHead({ kind, ts, extra }: { kind: TranscriptMessage["kind"]; ts: string; extra?: ReactNode }) {
  const name =
    {
      system: "System",
      user: "User prompt",
      assistant: "Assistant",
      thinking: "Thinking",
      tool_call: "Tool call",
      status: "Status",
      task: "Task",
      request: "Request",
    }[kind] || "Status";
  return (
    <div className="msg__head">
      <span className="name">{name}</span>
      {extra ? (
        <>
          <span className="dot" />
          {extra}
        </>
      ) : null}
      <span className="dot" />
      <span className="ts">{ts}</span>
    </div>
  );
}

function SystemMsg({ message }: { message: Extract<TranscriptMessage, { kind: "system" }> }) {
  return (
    <div className="msg">
      <MsgGutter kind="system" />
      <div>
        <MsgHead kind="system" ts={message.ts} extra="init" />
        <div className="sysblock">
          <h5>Session initialized</h5>
          <div className="grid">
            <span className="k">session_id</span>
            <span className="v">{message.session}</span>
            <span className="k">workspace</span>
            <span className="v">{message.workspace}</span>
            <span className="k">cwd</span>
            <span className="v">{message.cwd}</span>
            <span className="k">model</span>
            <span className="v">{message.model}</span>
            <span className="k">tools</span>
            <span className="v">
              <span className="tools">
                {message.tools.map((tool) => (
                  <span className="tool" key={tool}>
                    {tool}
                  </span>
                ))}
              </span>
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-3)", fontStyle: "italic" }}>
            {message.note}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserMsg({ message }: { message: Extract<TranscriptMessage, { kind: "user" }> }) {
  return (
    <div className="msg">
      <MsgGutter kind="user" />
      <div>
        <MsgHead kind="user" ts={message.ts} extra={`from ${message.from} · ${message.issue}`} />
        <div className="userblock">
          {message.text.split("\n\n").map((paragraph, index) => (
            <p key={index} style={{ margin: index ? "8px 0 0" : 0, whiteSpace: "pre-wrap" }}>
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function AssistantMsg({ message }: { message: Extract<TranscriptMessage, { kind: "assistant" }> }) {
  return (
    <div className="msg">
      <MsgGutter kind="assistant" />
      <div>
        <MsgHead kind="assistant" ts={message.ts} />
        <div className="msg__body">
          <Paragraphs text={message.text} />
        </div>
      </div>
    </div>
  );
}

function ThinkingMsg({ message }: { message: Extract<TranscriptMessage, { kind: "thinking" }> }) {
  return (
    <div className="msg">
      <MsgGutter kind="thinking" />
      <div>
        <MsgHead kind="thinking" ts={message.ts} extra="reasoning summary" />
        <div className="thinkbox">{message.text}</div>
      </div>
    </div>
  );
}

function ToolCallMsg({
  message,
  open,
  onToggle,
}: {
  message: Extract<TranscriptMessage, { kind: "tool_call" }>;
  open: boolean;
  onToggle: () => void;
}) {
  const argsPreview = JSON.stringify(message.args).replace(/[{}"]/g, "").replace(/,/g, ", ");
  return (
    <div className="msg">
      <MsgGutter kind="tool_call" />
      <div>
        <MsgHead
          kind="tool_call"
          ts={message.ts}
          extra={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <code style={{ fontFamily: "var(--font-mono)", color: "var(--text-2)" }}>{message.name}</code>
              <StatusBadge state={message.status} />
            </span>
          }
        />
        <div className="toolcall" data-open={open}>
          <button
            className="toolcall__head"
            onClick={onToggle}
            type="button"
            style={{ width: "100%", textAlign: "left" }}
            aria-expanded={open}
          >
            <span className="chev">{Icon.chevronRight()}</span>
            <span className="name">{message.name}</span>
            <span className="args-preview">({argsPreview})</span>
            <StatusBadge state={message.status} />
            <span className="cid">{message.call_id}</span>
          </button>
          {open ? (
            <div className="toolcall__body">
              <div className="toolcall__sec">
                <div className="lbl">Arguments</div>
                <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>{JSON.stringify(message.args, null, 2)}</div>
              </div>
              {message.result !== null ? (
                <div className="toolcall__sec">
                  <div className="lbl">
                    Result
                    {message.truncated ? <span className="trunc">truncated</span> : null}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>{message.result}</div>
                </div>
              ) : (
                <div className="toolcall__sec">
                  <div className="lbl">Result</div>
                  <div style={{ color: "var(--text-3)", fontStyle: "italic" }}>
                    <span className="spinner" style={{ display: "inline-block", verticalAlign: "-1px", marginRight: 6 }} />
                    awaiting tool response...
                  </div>
                </div>
              )}
              {message.output ? (
                <div className="toolcall__sec">
                  <div className="lbl">Output</div>
                  <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>{message.output}</div>
                </div>
              ) : null}
              {message.error ? (
                <div className="toolcall__sec">
                  <div className="lbl">Error</div>
                  <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>{message.error}</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusMsg({ message }: { message: Extract<TranscriptMessage, { kind: "status" }> }) {
  return (
    <div className="lifecycle">
      <StatusBadge state={message.state} />
      <span>{message.text}</span>
      <span style={{ color: "var(--text-4)" }}>{message.ts}</span>
    </div>
  );
}

function TaskMsg({ message }: { message: Extract<TranscriptMessage, { kind: "task" }> }) {
  return (
    <div className="msg">
      <MsgGutter kind="task" />
      <div>
        <MsgHead kind="task" ts={message.ts} extra="milestone" />
        <div className="task">
          <div className="head">
            <span className="lbl">Task complete</span>
          </div>
          <div className="title">{message.title}</div>
          <div className="desc">{message.desc}</div>
        </div>
      </div>
    </div>
  );
}

function RequestMsg({ message }: { message: Extract<TranscriptMessage, { kind: "request" }> }) {
  return (
    <div className="msg">
      <MsgGutter kind="request" />
      <div>
        <MsgHead kind="request" ts={message.ts} extra={`reason: ${message.reason}`} />
        <div className="request">
          <div className="head">
            <span className="lbl">Awaiting input</span>
          </div>
          <div className="q">{message.q}</div>
          <div className="actions">
            {message.actions.map((action, index) => (
              <UnavailableButton
                key={action}
                className={`btn ${index === 0 ? "btn--primary" : ""}`}
                unavailableLabel={action}
                unavailableReason="request responses cannot be submitted from the read-only transcript view"
              >
                {action}
              </UnavailableButton>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Message({
  message,
  open = false,
  onToggle = () => {},
}: {
  message: TranscriptMessage;
  open?: boolean;
  onToggle?: () => void;
}) {
  switch (message.kind) {
    case "system":
      return <SystemMsg message={message} />;
    case "user":
      return <UserMsg message={message} />;
    case "assistant":
      return <AssistantMsg message={message} />;
    case "thinking":
      return <ThinkingMsg message={message} />;
    case "tool_call":
      return <ToolCallMsg message={message} open={open} onToggle={onToggle} />;
    case "status":
      return <StatusMsg message={message} />;
    case "task":
      return <TaskMsg message={message} />;
    case "request":
      return <RequestMsg message={message} />;
    default:
      return null;
  }
}
