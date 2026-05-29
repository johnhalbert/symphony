import type { ReactNode } from "react";
import type { IssueModel, PriorityLevel, SidebarModel } from "../../types/symphony";
import { Icon, StatusIcon } from "../common";

export function SidebarPrimary({ sidebar }: { sidebar: SidebarModel }) {
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "40px auto 1fr auto", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 12px", gap: 10, background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--accent)", boxShadow: "0 0 0 3px rgba(240,184,108,0.18)" }} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>Symphony</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>
          {sidebar.runningAgents.length} live · {sidebar.totals.open} open
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" type="button">
          {Icon.more()}
        </button>
      </div>

      <div style={{ padding: "12px 12px 4px" }}>
        {sidebar.providerGates.length ? (
          <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
            {sidebar.providerGates.map((gate) => (
              <div key={gate.id} style={{ border: "1px solid rgba(240,184,108,0.42)", borderLeft: "3px solid var(--accent)", borderRadius: 6, background: "rgba(240,184,108,0.08)", padding: "8px 10px" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5 }}>
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>{gate.provider}</span>
                  <span style={{ color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{gate.kind}</span>
                </div>
                <div style={{ color: "var(--text-2)", fontSize: 11, lineHeight: 1.4, marginTop: 3 }}>{gate.message}</div>
                <div style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)", fontSize: 10, marginTop: 3 }}>
                  {gate.resumeAt ? `resets ${gate.resumeAt}` : "waiting for user resume"}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <MiniStat label="Completeness" value={`${sidebar.totals.completeness}%`} bar={`${sidebar.totals.completeness}%`} accent />
          <MiniStat label="Running" value={String(sidebar.runningAgents.length)} sub="agents" />
          <MiniStat label="Open" value={String(sidebar.totals.open)} sub="issues" />
          <MiniStat label="Review" value={String(sidebar.totals.review)} sub="issues" />
        </div>
      </div>

      <div style={{ overflow: "auto" }}>
        <SidebarSection title="Running agents" count={sidebar.runningAgents.length}>
          {sidebar.runningAgents.length ? (
            sidebar.runningAgents.map((agent) => (
              <div key={agent.id} style={{ display: "grid", gridTemplateColumns: "8px 1fr auto", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)", alignItems: "center" }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", boxShadow: "0 0 0 3px rgba(240,184,108,0.15)", animation: "pulse 1.6s ease-in-out infinite" }} />
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5 }}>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-3)", fontSize: 10.5 }}>{agent.issue}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{agent.title}</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--accent)", fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 5 }}>
                    <span className="spinner" />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.step}</span>
                  </div>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>{agent.duration}</span>
              </div>
            ))
          ) : (
            <SidebarEmptyState>No running agents.</SidebarEmptyState>
          )}
        </SidebarSection>

        <SidebarSection title="Agent review queue" count={sidebar.reviewIssues.length}>
          {sidebar.reviewIssues.length ? (
            sidebar.reviewIssues.map((issue) => (
              <div key={issue.id} style={{ display: "grid", gridTemplateColumns: "13px 1fr", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)", alignItems: "center" }}>
                <StatusIcon state="review" />
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5 }}>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-3)", fontSize: 10.5 }}>{issue.id}</span>
                    {issue.pr ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--link)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
                        <span style={{ width: 11, height: 11 }}>{Icon.pr()}</span>
                        {issue.pr}
                      </span>
                    ) : null}
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</span>
                  <span style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {reviewIssueMeta(issue)}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <SidebarEmptyState>No review issues.</SidebarEmptyState>
          )}
        </SidebarSection>

        <SidebarSection title="Recent activity" count={null}>
          {sidebar.activity.length ? (
            sidebar.activity.slice(0, 6).map((activity, index) => (
              <div key={`${activity.t}-${index}`} style={{ display: "grid", gridTemplateColumns: "8px 1fr", gap: 8, padding: "7px 12px", alignItems: "flex-start", borderBottom: "1px solid var(--border-subtle)", fontSize: 11.5 }}>
                <span style={{ width: 5, height: 5, borderRadius: 999, marginTop: 7, background: "var(--text-3)" }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text-2)", lineHeight: 1.4 }}>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{activity.who}</span>{" "}
                    <span style={{ color: "var(--text-3)" }}>{activity.verb}</span>{" "}
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{activity.id}</span>
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-4)", marginTop: 1 }}>{activity.t}</div>
                </div>
              </div>
            ))
          ) : (
            <SidebarEmptyState>No recent activity.</SidebarEmptyState>
          )}
        </SidebarSection>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--panel)", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", animation: "pulse 1.6s ease-in-out infinite" }} />
        <span>{sidebar.totals.all} total issues</span>
        <div style={{ flex: 1 }} />
        <span>
          {sidebar.totals.done} done · {sidebar.totals.cancelled} cancelled
        </span>
      </div>
    </div>
  );
}

function formatPriority(priority: PriorityLevel): string {
  return priority === "urgent" ? "urgent" : `P${priority}`;
}

function reviewIssueMeta(issue: IssueModel): string {
  return [
    issue.assignee ? `@${issue.assignee}` : null,
    `priority ${formatPriority(issue.priority)}`,
    ...issue.labels.map((label) => `#${label}`),
    issue.ci ? `ci ${issue.ci}` : null,
    issue.workspace ? `ws ${issue.workspace}` : null,
    issue.session ? `session ${issue.session}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function MiniStat({ label, value, sub, bar, accent }: { label: string; value: string; sub?: string; bar?: string; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "9px 11px", background: "var(--panel)", display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 500, lineHeight: 1, fontFeatureSettings: "\"tnum\"", color: accent ? "var(--accent)" : "var(--text)" }}>{value}</div>
      {bar ? (
        <div style={{ height: 3, background: "var(--elevated)", borderRadius: 999, marginTop: 2 }}>
          <div style={{ width: bar, height: "100%", background: "var(--accent)", borderRadius: 999 }} />
        </div>
      ) : (
        <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>{sub}</div>
      )}
    </div>
  );
}

function SidebarSection({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 6px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)" }}>
        <span>{title}</span>
        {count !== null ? <span style={{ marginLeft: 6, fontFamily: "var(--font-mono)", color: "var(--text-4)" }}>{count}</span> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SidebarEmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "8px 12px", color: "var(--text-4)", fontSize: 11.5, fontStyle: "italic" }}>
      {children}
    </div>
  );
}
