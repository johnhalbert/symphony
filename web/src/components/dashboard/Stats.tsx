import type {
  DashboardBurnupMetrics,
  DashboardMetrics,
  DashboardModel,
  DashboardTotals,
} from "../../types/symphony";

function textOr(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function textOrNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSeries(series: number[] | null | undefined) {
  return (series ?? []).filter((value) => Number.isFinite(value)).map((value) => Math.max(value, 0));
}

function hasChartSeries(burnup: DashboardBurnupMetrics | null | undefined) {
  return normalizeSeries(burnup?.completedSeries).length >= 2 && normalizeSeries(burnup?.targetSeries).length >= 2;
}

function InlineUnavailable({ children }: { children: string }) {
  return <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>{children}</div>;
}

function PanelUnavailable({ children }: { children: string }) {
  return <div className="view-empty" style={{ minHeight: 132, display: "grid", placeItems: "center" }}>{children}</div>;
}

const unavailableValue = "—";

export function StatsRow({ dashboard }: { dashboard: DashboardModel }) {
  const totals = dashboard.totals;
  const runningCount = dashboard.runningAgents.length;
  const agentSlotCount = Math.max(dashboard.concurrencyCap, runningCount, 0);
  const cycleMetrics = dashboard.metrics?.cycle;
  const velocityMetrics = dashboard.metrics?.velocity;
  const velocityValue = textOrNull(velocityMetrics?.valueLabel);
  const velocityUnit = textOrNull(velocityMetrics?.unitLabel);
  const velocityEta = textOrNull(velocityMetrics?.etaLabel);
  const velocitySparkline = normalizeSeries(velocityMetrics?.sparkline);
  const completenessDelta = textOrNull(cycleMetrics?.completenessDeltaLabel);

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
        <div className={completenessDelta ? "stat__delta stat__delta--up" : "stat__delta"}>{completenessDelta ?? "derived from stored issue/run state"}</div>
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
        <div className="stat__value">
          {velocityValue ?? unavailableValue}
          {velocityUnit ? <span className="suffix">{velocityUnit}</span> : null}
        </div>
        {velocitySparkline.length >= 2 ? (
          <div style={{ marginTop: 8 }}>
            <Sparkline tiny points={velocitySparkline} />
          </div>
        ) : (
          <InlineUnavailable>Velocity trend unavailable</InlineUnavailable>
        )}
        <div className={velocityEta ? "stat__delta stat__delta--warn" : "stat__delta stat__delta--warn"}>{velocityEta ?? "ETA unavailable: no durable throughput or ETA source"}</div>
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

export function BurndownPanel({
  totals,
  metrics,
}: {
  totals: DashboardTotals;
  metrics?: DashboardMetrics | null;
  useModelBurnupTotals?: boolean;
}) {
  const burnup = metrics?.burnup;
  const hasBurnup = hasChartSeries(burnup);
  return (
    <div className="panel" style={{ marginBottom: 0 }}>
      <div className="panel__head">
        <span>{hasBurnup ? textOr(burnup?.title, "Burn-up") : "Progress totals"}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>
          {totals.done}/{totals.all} done · {hasBurnup ? textOr(burnup?.remainingLabel, "schedule unavailable") : "schedule unavailable"}
        </span>
      </div>
      <div style={{ padding: "14px 18px 18px" }}>
        {hasBurnup && burnup ? (
          <BurnupChart burnup={burnup} />
        ) : (
          <>
            <ProgressTotalsChart totals={totals} />
            <InlineUnavailable>Burn-up unavailable; no durable cycle history is present.</InlineUnavailable>
          </>
        )}
      </div>
    </div>
  );
}

export function BurndownCommandCenter({ dashboard }: { dashboard: DashboardModel }) {
  const totals = dashboard.totals;
  const cycle = dashboard.metrics?.cycle;
  const velocity = dashboard.metrics?.velocity;
  const health = dashboard.metrics?.health;
  const cycleLabel = textOr(cycle?.label, "cycle unavailable");
  const dateRange = textOr(cycle?.dateRange, "schedule unavailable");
  const remainingLabel = textOr(cycle?.remainingLabel, "remaining unavailable");
  const projectedCompletion = textOr(cycle?.projectedCompletionLabel, "unavailable");
  const velocityLabel = velocityValueLabel(velocity?.valueLabel, velocity?.unitLabel);
  const velocityTrend = textOr(velocity?.trendLabel, "backend metric unavailable");
  const reviewQueue = textOr(health?.reviewQueueLabel, `${totals.review} issues in review · queue age unavailable`);
  const healthState = textOr(health?.stateLabel, "status unavailable");
  const errorSummary = textOr(health?.errorSummaryLabel, "errors unavailable");

  return (
    <div className="panel" style={{ borderRadius: 6, background: "#0a0a0c" }}>
      <div className="panel__head" style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          ./symphony status --branch {dashboard.branch || "--"}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: health?.stateLabel ? "var(--accent)" : "var(--text-3)" }}>● {health?.stateLabel ? healthState : "projection"}</span>
      </div>
      <div style={{ padding: "12px 16px 14px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.65 }}>
        <div>
          <span style={{ color: "var(--text-3)" }}>scope      </span> current durable dashboard projection
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>cycle      </span> {cycleLabel} · {dateRange} · <span style={{ color: "var(--text)" }}>{remainingLabel}</span>
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>completion </span> <span style={{ color: "var(--st-done)" }}>{totals.completeness}%</span> ({totals.done}/{totals.all} done) · total {totals.all} · projection <span style={{ color: cycle?.projectedCompletionLabel ? "var(--st-done)" : "var(--text-3)" }}>{projectedCompletion}</span> · from stored totals
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>open       </span> {totals.open} open · {totals.todo} todo · {totals.progress} in progress · {totals.review} in review
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>velocity   </span> <span style={{ color: velocity?.valueLabel ? "var(--accent)" : "var(--text-3)" }}>{velocityLabel}</span> · {velocityTrend}
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>agents     </span> <span style={{ color: "var(--accent)" }}>{dashboard.agentUsageLabel}</span> · {dashboard.runningAgents.length} running / {dashboard.concurrencyCap} cap
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>review     </span> {reviewQueue}
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>health     </span> <span style={{ color: health?.stateLabel ? "var(--st-done)" : "var(--text-3)" }}>{healthState}</span> · {dashboard.pollLabel || "poll unavailable"} · {errorSummary}
        </div>
        <div>
          <span style={{ color: "var(--text-3)" }}>unavailable</span> cycle dates, throughput, ETA, health, and error-window metrics need durable source fields
        </div>
      </div>
    </div>
  );
}

function velocityValueLabel(value: string | null | undefined, unit: string | null | undefined) {
  const valueLabel = textOrNull(value);
  if (!valueLabel) return "unavailable";
  const unitLabel = textOrNull(unit);
  return unitLabel ? `${valueLabel} ${unitLabel}` : valueLabel;
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

function BurnupChart({ burnup }: { burnup: DashboardBurnupMetrics }) {
  const width = 700;
  const height = 160;
  const completed = normalizeSeries(burnup.completedSeries);
  const target = normalizeSeries(burnup.targetSeries);
  const totalPoints = Math.max(Math.trunc(burnup.totalPoints ?? Math.max(completed.length, target.length, 2)), 2);
  const currentIndex = clamp(Math.trunc(burnup.currentIndex ?? completed.length - 1), 0, totalPoints - 1);
  const completedEnd = chartValue(burnup.completedEnd ?? completed[completed.length - 1] ?? 0);
  const targetEnd = chartValue(burnup.targetEnd ?? target[target.length - 1] ?? completedEnd);
  const max = Math.max(...completed, ...target, completedEnd, targetEnd, 1);
  const gridLines = [0, max / 3, (max / 3) * 2, max];
  const dx = (width - 30) / (totalPoints - 1);
  const sy = (y: number) => height - 18 - (y / max) * (height - 36);
  const sx = (i: number) => 18 + i * dx;
  const pathCompleted = chartPath(completed, sx, sy);
  const pathTarget = chartPath(target, sx, sy);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height }}>
      {gridLines.map((value) => (
        <line key={value} x1="18" x2={width - 12} y1={sy(value)} y2={sy(value)} stroke="var(--border-subtle)" strokeWidth="1" />
      ))}
      <path d={pathTarget} fill="none" stroke="var(--text-3)" strokeWidth="1.3" strokeDasharray="3 3" opacity="0.7" />
      <path d={pathCompleted} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <path d={`${pathCompleted} L${sx(currentIndex)},${sy(0)} L${sx(0)},${sy(0)} Z`} fill="var(--accent-soft)" />
      {completed.map((y, index) => (
        <circle key={index} cx={sx(index)} cy={sy(y)} r="2.5" fill="var(--accent)" />
      ))}
      <path d={`M${sx(currentIndex)},${sy(completedEnd)} L${sx(totalPoints - 1)},${sy(targetEnd)}`} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.55" />
      <circle cx={sx(totalPoints - 1)} cy={sy(targetEnd)} r="3" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <line x1={sx(currentIndex)} x2={sx(currentIndex)} y1="6" y2={height - 12} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="2 3" />
      <text x={sx(currentIndex) + 4} y="16" fill="var(--text-3)" fontSize="10" fontFamily="var(--font-mono)">
        today
      </text>
      {Array.from({ length: totalPoints }).map((_, index) => {
        const label = dayLabel(index, currentIndex, totalPoints);
        return label ? (
          <text key={index} x={sx(index)} y={height - 2} textAnchor="middle" fill="var(--text-4)" fontSize="9.5" fontFamily="var(--font-mono)">
            {label}
          </text>
        ) : null;
      })}
      <text x={width - 14} y={sy(targetEnd) + 3} textAnchor="end" fill="var(--text-3)" fontSize="9.5" fontFamily="var(--font-mono)">
        target {formatChartValue(targetEnd)}
      </text>
    </svg>
  );
}

function chartPath(points: number[], sx: (index: number) => number, sy: (value: number) => number) {
  return points.map((y, index) => `${index ? "L" : "M"}${sx(index)},${sy(y)}`).join(" ");
}

function dayLabel(index: number, currentIndex: number, totalPoints: number) {
  if (index === 0) return "Day 1";
  if (index === currentIndex && index !== totalPoints - 1) return `Day ${index + 1}`;
  if (index === totalPoints - 1) return `Day ${totalPoints}`;
  return "";
}

function chartValue(value: number) {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatChartValue(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

export function Sparkline({ tiny, points = [] }: { tiny?: boolean; points?: number[] | null }) {
  const safePoints = normalizeSeries(points);
  if (safePoints.length < 2) return null;
  const width = tiny ? 120 : 240;
  const height = tiny ? 22 : 36;
  const max = Math.max(...safePoints, 1);
  const dx = width / (safePoints.length - 1);
  const path = safePoints.map((y, index) => `${index ? "L" : "M"}${index * dx},${height - (y / max) * (height - 3) - 1}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height }}>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill="var(--accent-soft)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}
