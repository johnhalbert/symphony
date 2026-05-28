import { Icon } from "./Icon";

export const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  progress: "In Progress",
  review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

export function StatusIcon({ state }: { state: string }) {
  const color =
    {
      backlog: "var(--st-backlog)",
      todo: "var(--st-todo)",
      progress: "var(--st-progress)",
      review: "var(--st-review)",
      done: "var(--st-done)",
      cancelled: "var(--st-cancelled)",
    }[state] || "var(--text-3)";
  return (
    <span className="status-icon" style={{ color }}>
      {Icon.status(state)}
    </span>
  );
}

export function StatusBadge({ state }: { state: string }) {
  const key = state.toLowerCase().replace(/\s+/g, "-");
  return (
    <span className={`statbadge statbadge--${key}`}>
      <span className="d" />
      {state}
    </span>
  );
}

export function StatusBadgeDot({ state }: { state: string }) {
  const color =
    {
      running: "var(--run-active)",
      finished: "var(--run-done)",
      error: "var(--run-error)",
      cancelled: "var(--text-3)",
      queued: "var(--run-queued)",
    }[state] || "var(--text-3)";
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        boxShadow: state === "running" ? "0 0 0 3px rgba(240,184,108,0.15)" : "none",
        animation: state === "running" ? "pulse 1.6s ease-in-out infinite" : "none",
      }}
    />
  );
}

export function SessionStateChip({ state }: { state: string }) {
  const map =
    {
      running: { cls: "statbadge--running", label: "RUNNING" },
      finished: { cls: "statbadge--finished", label: "FINISHED" },
      error: { cls: "statbadge--error", label: "ERROR" },
      cancelled: { cls: "statbadge--cancelled", label: "CANCELLED" },
      queued: { cls: "statbadge--creating", label: "QUEUED" },
    }[state] || { cls: "statbadge--pending", label: state.toUpperCase() };
  return (
    <span className={`statbadge ${map.cls}`}>
      <span className="d" />
      {map.label}
    </span>
  );
}
