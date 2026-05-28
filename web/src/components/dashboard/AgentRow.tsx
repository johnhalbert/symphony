import type { RunningAgentModel } from "../../types/symphony";

export function AgentRow({ agent }: { agent: RunningAgentModel }) {
  return (
    <div className="agent-row">
      <span className="left" />
      <div className="ttl">
        <div className="t">
          <span className="id">{agent.issue}</span>
          <span>{agent.title}</span>
        </div>
        <div className="meta">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--accent)" }}>
            <span className="spinner" />
            {agent.step}
          </span>
        </div>
      </div>
      <div className="right">
        <span>{agent.duration}</span>
        <span style={{ color: "var(--text-4)" }}>·</span>
        <span>{agent.tokens}</span>
      </div>
    </div>
  );
}
