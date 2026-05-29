import type { DashboardModel, DashboardTotals } from "../../types/symphony";

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
        <div className="stat__delta stat__delta--up">▲ 12% this cycle</div>
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
        <div className="stat__label">Velocity / ETA</div>
        <div className="stat__value">
          3.2<span className="suffix">PR/day</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <Sparkline tiny />
        </div>
        <div className="stat__delta stat__delta--warn">ETA: cycle ends ~3 days early</div>
      </div>
    </div>
  );
}

export function StatsGridDense({ totals }: { totals: DashboardTotals }) {
  return (
    <div className="stats" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      <DenseStat label="Done" value={totals.done} sub="this cycle" color="var(--st-done)" />
      <DenseStat label="In Review" value={totals.review} sub="agent review" color="var(--st-review)" />
      <DenseStat label="In Progress" value={totals.progress} sub="running" color="var(--st-progress)" />
      <DenseStat label="Todo" value={totals.todo} sub="dispatchable" color="var(--st-todo)" />
      <DenseStat label="Backlog" value={totals.backlog} sub="" color="var(--st-backlog)" />
      <DenseStat label="Completeness" value={`${totals.completeness}%`} sub="cycle 14" color="var(--accent)" emphasis />
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

export function BurndownPanel({ totals }: { totals: DashboardTotals }) {
  return (
    <div className="panel" style={{ marginBottom: 0 }}>
      <div className="panel__head">
        <span>Burn-up · Cycle 14</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>
          {totals.done}/{totals.all} done · 7 days left
        </span>
      </div>
      <div style={{ padding: "14px 18px 18px" }}>
        <BurnupChart />
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
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--accent)" }}>● live</span>
      </div>
      <div style={{ padding: "12px 16px 14px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.65 }}>
        <div>
          <span style={{ color: "var(--text-3)" }}>cycle      </span> 14 · May 15 - May 29 · <span style={{ color: "var(--text)" }}>7 days remaining</span>
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>completion </span> <span style={{ color: "var(--st-done)" }}>{totals.completeness}%</span> ({totals.done}/{totals.all}) · projected <span style={{ color: "var(--st-done)" }}>96%</span>
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>velocity   </span> <span style={{ color: "var(--accent)" }}>3.2 PR/day</span> · 7d avg · 14d trend ↑
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>agents     </span> <span style={{ color: "var(--accent)" }}>{dashboard.agentUsageLabel}</span> · {dashboard.runningAgents.length} running / {dashboard.concurrencyCap} cap
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>review     </span> 3 issues in In Review agent queue · oldest 24m
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>health     </span> <span style={{ color: "var(--st-done)" }}>nominal</span> · {dashboard.pollLabel || "poll unavailable"} · 0 errors in 24h
        </div>
      </div>
    </div>
  );
}

function BurnupChart() {
  const width = 700;
  const height = 160;
  const completed = [0, 2, 3, 5, 6, 8, 11, 13];
  const target = [0, 2.4, 4.8, 7.2, 9.6, 12, 14.4, 16.8];
  const max = 17;
  const dx = (width - 30) / 13;
  const sy = (y: number) => height - 18 - (y / max) * (height - 36);
  const sx = (i: number) => 18 + i * dx;
  const pathCompleted = completed.map((y, index) => `${index ? "L" : "M"}${sx(index)},${sy(y)}`).join(" ");
  const pathTarget = target.map((y, index) => `${index ? "L" : "M"}${sx(index)},${sy(y)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height }}>
      {[0, 5, 10, 15].map((value) => (
        <line key={value} x1="18" x2={width - 12} y1={sy(value)} y2={sy(value)} stroke="var(--border-subtle)" strokeWidth="1" />
      ))}
      <path d={pathTarget} fill="none" stroke="var(--text-3)" strokeWidth="1.3" strokeDasharray="3 3" opacity="0.7" />
      <path d={pathCompleted} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <path d={`${pathCompleted} L${sx(7)},${sy(0)} L${sx(0)},${sy(0)} Z`} fill="var(--accent-soft)" />
      {completed.map((y, index) => (
        <circle key={index} cx={sx(index)} cy={sy(y)} r="2.5" fill="var(--accent)" />
      ))}
      <path d={`M${sx(7)},${sy(13)} L${sx(13)},${sy(17)}`} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.55" />
      <circle cx={sx(13)} cy={sy(17)} r="3" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <line x1={sx(7)} x2={sx(7)} y1="6" y2={height - 12} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="2 3" />
      <text x={sx(7) + 4} y="16" fill="var(--text-3)" fontSize="10" fontFamily="var(--font-mono)">
        today
      </text>
      {["Day 1", "", "", "", "", "", "", "Day 7", "", "", "", "", "", "Day 14"].map((label, index) =>
        label ? (
          <text key={index} x={sx(index)} y={height - 2} textAnchor="middle" fill="var(--text-4)" fontSize="9.5" fontFamily="var(--font-mono)">
            {label}
          </text>
        ) : null,
      )}
      <text x={width - 14} y={sy(17) + 3} textAnchor="end" fill="var(--text-3)" fontSize="9.5" fontFamily="var(--font-mono)">
        target 17
      </text>
      <text x={width - 14} y={sy(13) - 6} textAnchor="end" fill="var(--accent)" fontSize="9.5" fontFamily="var(--font-mono)">
        completed 13
      </text>
    </svg>
  );
}

export function Sparkline({ tiny }: { tiny?: boolean }) {
  const points = [1, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6, 3, 8, 5];
  const width = tiny ? 120 : 240;
  const height = tiny ? 22 : 36;
  const max = Math.max(...points);
  const dx = width / (points.length - 1);
  const path = points.map((y, index) => `${index ? "L" : "M"}${index * dx},${height - (y / max) * (height - 3) - 1}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height }}>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill="var(--accent-soft)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}
