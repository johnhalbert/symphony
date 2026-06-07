import type { RunState } from "../../types/symphony";

const stateConfig: Record<
  RunState,
  { dot: string; pulseShadow: string; label: string; labelBg: string; labelFg: string }
> = {
  running: { dot: "var(--run-active)", pulseShadow: "0 0 0 3px rgba(240,184,108,0.18)", label: "RUNNING", labelBg: "var(--accent-soft)", labelFg: "var(--accent)" },
  queued: { dot: "var(--run-queued)", pulseShadow: "none", label: "QUEUED", labelBg: "var(--link-soft)", labelFg: "var(--link)" },
  creating: { dot: "var(--run-queued)", pulseShadow: "0 0 0 3px rgba(122,167,255,0.16)", label: "CREATING", labelBg: "var(--link-soft)", labelFg: "var(--link)" },
  review: { dot: "var(--st-review)", pulseShadow: "none", label: "IN REVIEW", labelBg: "var(--link-soft)", labelFg: "var(--link)" },
  finished: { dot: "var(--run-done)", pulseShadow: "none", label: "FINISHED", labelBg: "rgba(127,194,139,0.10)", labelFg: "var(--st-done)" },
  error: { dot: "var(--run-error)", pulseShadow: "0 0 0 3px rgba(226,106,106,0.16)", label: "ERROR", labelBg: "rgba(226,106,106,0.10)", labelFg: "var(--pri-urgent)" },
  cancelled: { dot: "var(--text-3)", pulseShadow: "none", label: "CANCELLED", labelBg: "var(--elevated)", labelFg: "var(--text-3)" },
  not_live: { dot: "var(--text-3)", pulseShadow: "none", label: "NOT LIVE", labelBg: "var(--elevated)", labelFg: "var(--text-3)" },
  expired: { dot: "var(--text-3)", pulseShadow: "none", label: "EXPIRED", labelBg: "var(--elevated)", labelFg: "var(--text-3)" },
};

export function AgentStateCard({
  state,
  title,
  issue,
  agent,
  step,
  duration,
}: {
  state: RunState;
  title: string;
  issue: string;
  agent: string | null;
  step: string;
  duration: string;
}) {
  const cfg = stateConfig[state];
  const isAnimated = state === "running" || state === "creating";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "14px 16px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: "var(--font-sans)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 2,
          background: cfg.dot,
          opacity: state === "cancelled" || state === "not_live" || state === "expired" ? 0.4 : 1,
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: cfg.dot,
            boxShadow: cfg.pulseShadow,
            animation: isAnimated ? "pulse 1.6s ease-in-out infinite" : "none",
          }}
        />
        <span className={`statbadge statbadge--${state === "review" || state === "creating" ? "creating" : state}`} style={{ background: cfg.labelBg, color: cfg.labelFg }}>
          {cfg.label}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>{duration}</span>
      </div>

      <div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)" }}>{issue}</span>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text)",
            lineHeight: 1.35,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {title}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: "auto" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: isAnimated ? cfg.labelFg : "var(--text-3)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {state === "running" ? <span className="spinner" /> : null}
          {state === "creating" ? <span className="spinner" style={{ borderTopColor: "var(--link)" }} /> : null}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step}</span>
        </span>
        <div style={{ flex: 1 }} />
        <span
          className="avatar"
          style={{
            background: state === "running" || state === "creating" ? "var(--accent)" : "var(--elevated)",
            color: state === "running" || state === "creating" ? "#0c0c0e" : "var(--text-3)",
            border: state === "running" || state === "creating" ? "none" : "1px solid var(--border)",
          }}
        >
          {agent ? agent.slice(-2) : "--"}
        </span>
      </div>
    </div>
  );
}
