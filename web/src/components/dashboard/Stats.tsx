import type { DashboardModel, DashboardTotals } from "../../types/symphony";

const unavailableValue = "—";

export function StatsRow({ dashboard }: { dashboard: DashboardModel }) {
  const totals = dashboard.totals;
  const runningCount = dashboard.runningAgents.length;
  const agentSlotCount = Math.max(dashboard.concurrencyCap, runningCount, 0);

  return (
    <div className="stats">
      <div className="stat">
        <div className="stat__label">Completeness</div>
        <div className="stat__value">
          {totals.completeness}
          <span className="suffix">%</span>
        </div>
        <div className="completeness-bar">
          <div style={{ width: `${totals.completeness}%` }} />
        </div>
        <div className="stat__delta">derived from stored issue/run state</div>
      </div>
      <div className="stat">
        <div className="stat__label">Running agents</div>
        <div className="stat__value">
          {runningCount}<span className="suffix">/ {dashboard.concurrencyCap}</span>
        </div>
        <div style={{ display: "flex", gap: 3, marginTop: 8 }}>
          {Array.from({ length: agentSlotCount }).map((_, index) => (
            <span
              key={index}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: index < runningCount ? "var(--accent)" : "var(--elevated)",
              }}
            />
          ))}
        </div>
        <div className="stat__delta">{dashboard.agentUsageLabel}</div>
      </div>
      <div className="stat">
        <div className="stat__label">Open issues</div>
        <div className="stat__value">{totals.open}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
          <span>
            <span style={{ color: "var(--st-todo)" }}>●</span> {totals.todo} todo
          </span>
          <span>
            <span style={{ color: "var(--st-progress)" }}>●</span> {totals.progress} prog
          </span>
          <span>
            <span style={{ color: "var(--st-review)" }}>●</span> {totals.review} review
          </span>
        </div>
        <div className="stat__delta">{totals.backlog} in backlog</div>
      </div>
      <div className="stat">
        <div className="stat__label">Throughput / ETA</div>
        <div className="stat__value">{unavailableValue}</div>
        <div className="stat__delta stat__delta--warn">unavailable: no durable throughput or ETA source</div>
      </div>
    </div>
  );
}

export function StatsGridDense({ totals }: { totals: DashboardTotals }) {
  return (
    <div className="stats" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      <DenseStat label="Done" value={totals.done} sub="done" color="var(--st-done)" />
      <DenseStat label="In Review" value={totals.review} sub="in review" color="var(--st-review)" />
      <DenseStat label="In Progress" value={totals.progress} sub="in progress" color="var(--st-progress)" />
      <DenseStat label="Todo" value={totals.todo} sub="todo" color="var(--st-todo)" />
      <DenseStat label="Backlog" value={totals.backlog} sub="backlog" color="var(--st-backlog)" />
      <DenseStat label="Completeness" value={`${totals.completeness}%`} sub="from totals" color="var(--accent)" emphasis />
    </div>
  );
}

function DenseStat({
  label,
  value,
  sub,
  color,
  emphasis,
}: {
  label: string;
  value: string | number;
  sub: string;
  color: string;
  emphasis?: boolean;
}) {
  return (
    <div className="stat" style={{ minHeight: 78, padding: "10px 12px 9px" }}>
      <div className="stat__label" style={{ marginBottom: 4 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: color, display: "inline-block" }} />
        {label}
      </div>
      <div className="stat__value" style={{ fontSize: emphasis ? 24 : 20 }}>
        {value}
      </div>
      <div className="stat__delta">{sub}</div>
    </div>
  );
}

export function BurndownPanel({ totals }: { totals: DashboardTotals; useModelBurnupTotals?: boolean }) {
  return (
    <div className="panel" style={{ marginBottom: 0 }}>
      <div className="panel__head">
        <span>Progress totals</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>
          {totals.done}/{totals.all} done · trend unavailable
        </span>
      </div>
      <div style={{ padding: "14px 18px 18px" }}>
        <ProgressTotalsChart totals={totals} />
      </div>
    </div>
  );
}

export function BurndownCommandCenter({ dashboard }: { dashboard: DashboardModel }) {
  const totals = dashboard.totals;

  return (
    <div className="panel" style={{ borderRadius: 6, background: "#0a0a0c" }}>
      <div className="panel__head" style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          ./symphony status --branch {dashboard.branch || "--"}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--accent)" }}>● projection</span>
      </div>
      <div style={{ padding: "12px 16px 14px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.65 }}>
        <div>
          <span style={{ color: "var(--text-3)" }}>scope      </span> current durable dashboard projection
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>completion </span> <span style={{ color: "var(--st-done)" }}>{totals.completeness}%</span> ({totals.done}/{totals.all} done) · total {totals.all} · from stored totals
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>open       </span> {totals.open} open · {totals.todo} todo · {totals.progress} in progress · {totals.review} in review
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>agents     </span> <span style={{ color: "var(--accent)" }}>{dashboard.agentUsageLabel}</span> · {dashboard.runningAgents.length} running / {dashboard.concurrencyCap} cap
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>poll       </span> {dashboard.pollLabel || "poll unavailable"}
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>unavailable</span> cycle dates, throughput, ETA, health, and error-window metrics need durable source fields
        </div>
      </div>
    </div>
  );
}

function ProgressTotalsChart({ totals }: { totals: DashboardTotals }) {
  const width = 700;
  const height = 120;
  const padding = 18;
  const usableWidth = width - padding * 2;
  const done = chartValue(totals.done);
  const total = chartValue(totals.all);
  const denominator = Math.max(done, total, 1);
  const doneWidth = (done / denominator) * usableWidth;
  const remaining = Math.max(total - done, 0);
  const completion = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height }}>
      <rect x={padding} y="42" width={usableWidth} height="18" rx="9" fill="var(--elevated)" />
      <rect x={padding} y="42" width={doneWidth} height="18" rx="9" fill="var(--accent)" />
      <text x={padding} y="24" fill="var(--accent)" fontSize="10.5" fontFamily="var(--font-mono)">
        done {formatChartValue(done)}
      </text>
      <text x={width - padding} y="24" textAnchor="end" fill="var(--text-3)" fontSize="10.5" fontFamily="var(--font-mono)">
        total {formatChartValue(total)}
      </text>
      <text x={padding} y="82" fill="var(--text-3)" fontSize="10.5" fontFamily="var(--font-mono)">
        remaining {formatChartValue(remaining)}
      </text>
      <text x={width - padding} y="82" textAnchor="end" fill="var(--text-3)" fontSize="10.5" fontFamily="var(--font-mono)">
        completion {completion}%
      </text>
    </svg>
  );
}

function chartValue(value: number) {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function formatChartValue(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}
