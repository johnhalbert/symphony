declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type ConnectionState =
  | { kind: "connected"; baseUrl: string; generatedAt: string; summary: { runningCount: number | null; tokenConfigured: boolean; mutationsRequireToken: boolean | null } }
  | { kind: "offline"; baseUrl: string; reason: string; detail: string }
  | { kind: "error"; baseUrl: string; reason: string; detail: string };

type DashboardViewState = {
  connection: ConnectionState;
  sections: DashboardSections | null;
};

type DashboardSections = {
  operatorQueues: OperatorQueuesSection;
  board: BoardSection;
  activity: ActivitySection;
};

type OperatorQueuesSection =
  | { status: "ready"; data: OperatorQueuesSummary }
  | { status: "partial"; detail: string; data: OperatorQueuesSummary };

type OperatorQueuesSummary = {
  running: OperatorRow[];
  paused: OperatorRow[];
  orphaned: OperatorRow[];
  retrying: RetryingRow[];
};

type OperatorRow = {
  issueIdentifier: string;
  role: string | null;
  statusLabel: string | null;
  detail: string | null;
};

type RetryingRow = {
  issueIdentifier: string;
  attempt: number | null;
  dueAt: string | null;
  error: string | null;
};

type BoardSection =
  | {
      status: "ready";
      data: {
        generatedAt: string | null;
        columns: Array<{ id: string; title: string; count: number }>;
        counts: { total: number | null; live: number | null; paused: number | null; blocked: number | null } | null;
      };
    }
  | { status: "unavailable"; detail: string }
  | { status: "error"; detail: string };

type ActivitySection =
  | { status: "ready"; data: { items: Array<{ at: string; kind: string; issueIdentifier: string; summary: string | null }>; totalItems: number | null } }
  | { status: "error"; detail: string };

declare global {
  interface Window {
    __SYMPHONY_INITIAL_STATE__?: DashboardViewState | null;
  }
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("root");

window.addEventListener("message", (event: MessageEvent<{ type?: string; state?: DashboardViewState }>) => {
  if (event.data.type === "dashboardState" && event.data.state) render(event.data.state);
});

render(window.__SYMPHONY_INITIAL_STATE__ ?? null);

function render(state: DashboardViewState | null): void {
  if (!root) return;
  if (!state) {
    root.innerHTML = shell("offline", "Checking Symphony...", "Waiting for the first status probe to complete.");
    bindActions();
    return;
  }

  const connection = state.connection;
  if (connection.kind === "connected") {
    const running = connection.summary.runningCount === null ? "unknown" : String(connection.summary.runningCount);
    const token = connection.summary.tokenConfigured ? "configured" : "not configured";
    const tokenWarning =
      connection.summary.mutationsRequireToken === true && !connection.summary.tokenConfigured
        ? "<p class=\"meta\">Mutating controls require a token. Configure symphony.token before enabling future actions.</p>"
        : "";

    root.innerHTML = `<main class="shell">
      ${card(
        "connected",
        "Symphony connected",
        `<p class="meta mono">${escapeHtml(connection.baseUrl)}</p>
         <p class="meta">Snapshot: <span class="mono">${escapeHtml(connection.generatedAt)}</span></p>
         <p class="meta">Running agents: <span class="mono">${escapeHtml(running)}</span></p>
         <p class="meta">Token: <span class="mono">${escapeHtml(token)}</span></p>
         ${tokenWarning}
         ${actions()}`,
      )}
      ${state.sections ? renderOperatorQueues(state.sections.operatorQueues) : ""}
      ${state.sections ? renderBoard(state.sections.board) : ""}
      ${state.sections ? renderActivity(state.sections.activity) : ""}
    </main>`;
    bindActions();
    return;
  }

  const title = connection.kind === "offline" ? "Symphony offline" : "Symphony error";
  root.innerHTML = shell(
    connection.kind,
    title,
    `<p class="meta mono">${escapeHtml(connection.baseUrl || "No base URL configured")}</p>
     <p class="meta">${escapeHtml(connection.detail)}</p>`,
  );
  bindActions();
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

function renderOperatorQueues(section: OperatorQueuesSection): string {
  const partial = section.status === "partial" ? `<p class="meta">${escapeHtml(section.detail)}</p>` : "";
  return `<section class="card">
    <div class="title">Operator queues</div>
    ${partial}
    ${renderRows("Running", section.data.running, renderOperatorRow)}
    ${renderRows("Paused", section.data.paused, renderOperatorRow)}
    ${renderRows("Orphaned", section.data.orphaned, renderOperatorRow)}
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

function renderOperatorRow(row: OperatorRow): string {
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(row.issueIdentifier)}</span>
    <span class="row-meta">${escapeHtml([row.role, row.statusLabel, row.detail].filter(Boolean).join(" / "))}</span>
  </div>`;
}

function renderRetryingRow(row: RetryingRow): string {
  return `<div class="data-row">
    <span class="row-main">${escapeHtml(row.issueIdentifier)}</span>
    <span class="row-meta">${escapeHtml([row.attempt === null ? null : `attempt ${row.attempt}`, row.dueAt, row.error].filter(Boolean).join(" / "))}</span>
  </div>`;
}

function renderBoard(section: BoardSection): string {
  if (section.status !== "ready") return sectionCard("Board", section.status, section.detail);

  const counts = section.data.counts;
  const countLine = counts
    ? `<p class="meta">Total <span class="mono">${escapeHtml(displayNumber(counts.total))}</span> / live <span class="mono">${escapeHtml(displayNumber(counts.live))}</span> / blocked <span class="mono">${escapeHtml(displayNumber(counts.blocked))}</span></p>`
    : "";
  const columns = section.data.columns.length
    ? section.data.columns.map((column) => `<span class="chip">${escapeHtml(column.title)} <span class="mono">${escapeHtml(String(column.count))}</span></span>`).join("")
    : "<p class=\"meta\">No board columns returned.</p>";

  return `<section class="card">
    <div class="title">Board</div>
    ${countLine}
    <div class="chips">${columns}</div>
  </section>`;
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

function sectionCard(title: string, status: string, detail: string): string {
  return `<section class="card">
    <div class="title">${escapeHtml(title)}</div>
    <p class="meta"><span class="badge">${escapeHtml(status)}</span> ${escapeHtml(detail)}</p>
  </section>`;
}

function displayNumber(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function bindActions(): void {
  root?.querySelector('[data-action="retry"]')?.addEventListener("click", () => vscode.postMessage({ type: "retry" }));
  root?.querySelector('[data-action="settings"]')?.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
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
