import type {
  ActiveAgentSession,
  ActiveSessionsSection,
  ActivitySection,
  BoardIssueSummary,
  BoardSection,
  DashboardViewState,
  OperatorQueuesSection,
  OperatorRow,
  RetryingRow,
  WorkspaceContext,
  WorkspaceRow,
  WorkspaceSection,
} from "../dashboardTypes";
import { openWorkspaceDisabledReason } from "../openWorkspaceGate";

export function renderDashboardHtml(state: DashboardViewState | null): string {
  if (!state) {
    return shell("offline", "Checking Symphony...", "Waiting for the first status probe to complete.");
  }

  const connection = state.connection;
  if (connection.kind !== "connected") {
    const title = connection.kind === "offline" ? "Symphony offline" : "Symphony error";
    return shell(
      connection.kind,
      title,
      `<p class="meta mono">${escapeHtml(connection.baseUrl || "No base URL configured")}</p>
       <p class="meta">${escapeHtml(connection.detail)}</p>`,
    );
  }

  const running = connection.summary.runningCount === null ? "unknown" : String(connection.summary.runningCount);
  const retrying = connection.summary.retryingCount === null ? "unknown" : String(connection.summary.retryingCount);
  const token = connection.summary.tokenConfigured ? "configured" : "not configured";
  const tokenWarning =
    connection.summary.mutationsRequireToken === true && !connection.summary.tokenConfigured
      ? "<p class=\"meta\">Mutating controls require a token. Configure symphony.token before opening workspaces.</p>"
      : "";

  return `<main class="shell">
    ${card(
      "connected",
      "Symphony connected",
      `<p class="meta mono">${escapeHtml(connection.baseUrl)}</p>
       <p class="meta">Snapshot: <span class="mono">${escapeHtml(connection.generatedAt)}</span></p>
       <p class="meta">Running agents: <span class="mono">${escapeHtml(running)}</span> / Retrying: <span class="mono">${escapeHtml(retrying)}</span></p>
       <p class="meta">Token: <span class="mono">${escapeHtml(token)}</span></p>
       ${tokenWarning}
       ${actions()}`,
    )}
    ${renderPlanningPlaceholder()}
    ${state.sections ? renderActiveSessions(state.sections.activeSessions, connection.summary) : ""}
    ${state.sections ? renderWorkspaces(state.sections.workspaces, connection.summary) : ""}
    ${state.sections ? renderOperatorQueues(state.sections.operatorQueues, connection.summary) : ""}
    ${state.sections ? renderBoard(state.sections.board, connection.summary) : ""}
    ${state.sections ? renderActivity(state.sections.activity) : ""}
  </main>`;
}

function shell(kind: "connected" | "offline" | "error", title: string, body: string): string {
  return `<main class="shell">${card(kind, title, `${body}${actions()}`)}</main>`;
}

function card(kind: "connected" | "offline" | "error", title: string, body: string): string {
  return `<section class="card">
    <div class="title"><span class="dot ${kind}"></span>${escapeHtml(title)}</div>
    ${body}
  </section>`;
}

function actions(): string {
  return `<div class="actions">
    <button type="button" data-action="retry">Retry</button>
    <button type="button" data-action="settings">Settings</button>
  </div>`;
}

function renderPlanningPlaceholder(): string {
  const controls = ["Planning", "Orchestrator", "Chat"]
    .map(
      (label) => `<div class="placeholder-tile">
        <span class="row-main">${escapeHtml(label)}</span>
        <span class="row-meta">Disabled until Symphony exposes the ${escapeHtml(label.toLowerCase())} API.</span>
        <button type="button" disabled>Coming soon</button>
      </div>`,
    )
    .join("");
  return `<section class="card">
    <div class="title">Planning, Orchestrator, and Chat</div>
    <p class="meta">These controls are intentionally non-functional placeholders for APIs that do not exist yet.</p>
    <div class="placeholder-grid">${controls}</div>
  </section>`;
}

function renderActiveSessions(section: ActiveSessionsSection, summary: MutationSummary): string {
  const partial = section.status === "partial" ? `<p class="meta">${escapeHtml(section.detail)}</p>` : "";
  const rows = section.data.sessions.length
    ? section.data.sessions.slice(0, 6).map((session) => renderActiveSession(session, summary)).join("")
    : "<p class=\"meta\">No active agent sessions.</p>";
  const more = section.data.sessions.length > 6 ? `<p class="meta">+${escapeHtml(String(section.data.sessions.length - 6))} more active sessions</p>` : "";
  return `<section class="card">
    <div class="title">Active agent sessions <span class="badge">${escapeHtml(String(section.data.sessions.length))}</span></div>
    ${partial}
    <div class="row-list">${rows}${more}</div>
  </section>`;
}

function renderActiveSession(session: ActiveAgentSession, summary: MutationSummary): string {
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(session.issueIdentifier)}</span>
    <span class="row-meta">${escapeHtml([session.role, session.statusLabel, session.runId, session.detail].filter(Boolean).join(" / "))}</span>
    ${renderWorkspaceContext(session.workspace)}
    ${renderOpenWorkspaceAction(session.issueKey, session.workspace, summary)}
  </div>`;
}

function renderWorkspaces(section: WorkspaceSection, summary: MutationSummary): string {
  if (section.status !== "ready") return sectionCard("Workspaces", section.status, section.detail);
  const rows = section.data.rows.length
    ? section.data.rows.slice(0, 6).map((row) => renderWorkspaceRow(row, summary)).join("")
    : "<p class=\"meta\">No durable workspaces recorded.</p>";
  const more = section.data.rows.length > 6 ? `<p class="meta">+${escapeHtml(String(section.data.rows.length - 6))} more workspaces</p>` : "";
  return `<section class="card">
    <div class="title">Workspaces <span class="badge">${escapeHtml(String(section.data.rows.length))}</span></div>
    <div class="row-list">${rows}${more}</div>
  </section>`;
}

function renderWorkspaceRow(row: WorkspaceRow, summary: MutationSummary): string {
  const workspace: WorkspaceContext = {
    workspaceKey: row.workspaceKey,
    issueId: null,
    issueIdentifier: row.issueIdentifier,
    path: row.path,
    sourceKind: row.sourceKind,
    branchName: row.branchName,
  };
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(row.issueIdentifier)}</span>
    ${renderWorkspaceContext(workspace)}
    ${renderOpenWorkspaceAction(row.issueKey, workspace, summary)}
  </div>`;
}

function renderOperatorQueues(section: OperatorQueuesSection, summary: MutationSummary): string {
  const partial = section.status === "partial" ? `<p class="meta">${escapeHtml(section.detail)}</p>` : "";
  return `<section class="card">
    <div class="title">Operator queues</div>
    ${partial}
    ${renderRows("Running", section.data.running, (row) => renderOperatorRow(row, summary))}
    ${renderRows("Paused", section.data.paused, (row) => renderOperatorRow(row, summary))}
    ${renderRows("Orphaned", section.data.orphaned, (row) => renderOperatorRow(row, summary))}
    ${renderRows("Retrying", section.data.retrying, renderRetryingRow)}
  </section>`;
}

function renderRows<T>(title: string, rows: T[], renderRow: (row: T) => string): string {
  const visible = rows.slice(0, 5);
  const more = rows.length > visible.length ? `<p class="meta">+${escapeHtml(String(rows.length - visible.length))} more</p>` : "";
  const body = visible.length ? `${visible.map(renderRow).join("")}${more}` : "<p class=\"meta\">None</p>";
  return `<div class="subsection">
    <div class="subsection-title"><span>${escapeHtml(title)}</span><span class="badge">${escapeHtml(String(rows.length))}</span></div>
    <div class="row-list">${body}</div>
  </div>`;
}

function renderOperatorRow(row: OperatorRow, summary: MutationSummary): string {
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(row.issueIdentifier)}</span>
    <span class="row-meta">${escapeHtml([row.role, row.statusLabel, row.detail].filter(Boolean).join(" / "))}</span>
    ${renderWorkspaceContext(row.workspace)}
    ${renderOpenWorkspaceAction(row.issueKey, row.workspace, summary)}
  </div>`;
}

function renderRetryingRow(row: RetryingRow): string {
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(row.issueIdentifier)}</span>
    <span class="row-meta">${escapeHtml([row.attempt === null ? null : `attempt ${row.attempt}`, row.dueAt, row.error].filter(Boolean).join(" / "))}</span>
  </div>`;
}

function renderBoard(section: BoardSection, summary: MutationSummary): string {
  if (section.status !== "ready") return sectionCard("Board", section.status, section.detail);

  const counts = section.data.counts;
  const countLine = counts
    ? `<p class="meta">Total <span class="mono">${escapeHtml(displayNumber(counts.total))}</span> / live <span class="mono">${escapeHtml(displayNumber(counts.live))}</span> / blocked <span class="mono">${escapeHtml(displayNumber(counts.blocked))}</span></p>`
    : "";
  const columns = section.data.columns.length
    ? section.data.columns.map((column) => `<span class="chip">${escapeHtml(column.title)} <span class="mono">${escapeHtml(String(column.count))}</span></span>`).join("")
    : "<p class=\"meta\">No board columns returned.</p>";
  const issues = section.data.issues.length
    ? `<div class="subsection">
        <div class="subsection-title"><span>Board workspaces</span><span class="badge">${escapeHtml(String(section.data.issues.length))}</span></div>
        <div class="row-list">${section.data.issues.slice(0, 5).map((issue) => renderBoardIssue(issue, summary)).join("")}</div>
      </div>`
    : "";

  return `<section class="card">
    <div class="title">Board</div>
    ${countLine}
    <div class="chips">${columns}</div>
    ${issues}
  </section>`;
}

function renderBoardIssue(issue: BoardIssueSummary, summary: MutationSummary): string {
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(issue.issueIdentifier)}</span>
    <span class="row-meta">${escapeHtml([issue.state, issue.title].filter(Boolean).join(" / "))}</span>
    ${renderWorkspaceContext(issue.workspace)}
    ${renderOpenWorkspaceAction(issue.issueKey, issue.workspace, summary)}
  </div>`;
}

function renderActivity(section: ActivitySection): string {
  if (section.status !== "ready") return sectionCard("Activity", section.status, section.detail);

  const total = section.data.totalItems === null ? "unknown" : String(section.data.totalItems);
  const items = section.data.items.length
    ? section.data.items.slice(0, 10).map((item) => `<div class="activity-row">
      <span class="row-main">${escapeHtml(item.issueIdentifier)}</span>
      <span class="row-meta">${escapeHtml(item.kind)} / ${escapeHtml(item.at)}${item.summary ? ` / ${escapeHtml(item.summary)}` : ""}</span>
    </div>`).join("")
    : "<p class=\"meta\">No recent activity.</p>";

  return `<section class="card">
    <div class="title">Activity</div>
    <p class="meta">Showing recent items from <span class="mono">${escapeHtml(total)}</span> total.</p>
    <div class="row-list">${items}</div>
  </section>`;
}

function renderWorkspaceContext(workspace: WorkspaceContext | null): string {
  if (!workspace) return "";
  const title = workspace.workspaceKey ?? workspace.issueIdentifier ?? "Workspace";
  const details = [workspace.branchName, workspace.sourceKind, workspace.path].filter(Boolean).join(" / ");
  return `<span class="workspace">
    <span class="row-meta">Workspace: <span class="mono">${escapeHtml(title)}</span></span>
    ${details ? `<span class="row-meta">${escapeHtml(details)}</span>` : ""}
  </span>`;
}

function renderOpenWorkspaceAction(issueKey: string | null, workspace: WorkspaceContext | null, summary: MutationSummary): string {
  const disabledReason = openWorkspaceDisabledReason(issueKey, workspace, summary);
  if (disabledReason) {
    return `<div class="row-actions">
      <button type="button" disabled>Open workspace</button>
      <span class="action-reason">${escapeHtml(disabledReason)}</span>
    </div>`;
  }
  return `<div class="row-actions">
    <button type="button" data-action="openWorkspace" data-issue="${escapeHtml(issueKey ?? "")}">Open workspace</button>
  </div>`;
}

function sectionCard(title: string, status: string, detail: string): string {
  return `<section class="card">
    <div class="title">${escapeHtml(title)}</div>
    <p class="meta"><span class="badge">${escapeHtml(status)}</span> ${escapeHtml(detail)}</p>
  </section>`;
}

function displayNumber(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

type MutationSummary = {
  tokenConfigured: boolean;
  mutationsRequireToken: boolean | null;
};
