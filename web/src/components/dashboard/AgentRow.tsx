import type { RunningAgentModel } from "../../types/symphony";

export function AgentRow({ agent, liveIndicatorsEnabled = true }: { agent: RunningAgentModel; liveIndicatorsEnabled?: boolean }) {
  return (
    <div className="agent-row">
      <span className="left" />
      <div className="ttl">
        <div className="t">
          <span className="id">{agent.issue}</span>
          <span>{agent.title}</span>
        </div>
        <div className="meta">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: liveIndicatorsEnabled ? "var(--accent)" : "var(--text-3)" }}>
            {liveIndicatorsEnabled ? <span className="spinner" /> : null}
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
