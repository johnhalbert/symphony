declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

import type {
  ActivityItem,
  BoardIssueDetailResponse,
  IssueBoardCard,
  IssueBoardColumn,
  IssueBoardResponse,
  JsonObject,
  TranscriptEvent,
} from "../statusApiTypes";
import type { ConnectionState } from "../connectionState";
import { applyExtensionMessage, createInitialDashboardState, type DashboardState } from "../webviewModel";
import type { ExtensionMessage } from "../webviewMessages";
import { sanitizeTranscriptPreview } from "./transcriptSanitizer";

declare global {
  interface Window {
    __SYMPHONY_INITIAL_STATE__?: ConnectionState | null;
  }
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
const model: DashboardState = createInitialDashboardState(window.__SYMPHONY_INITIAL_STATE__ ?? null);

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  applyMessage(event.data);
  render();
});

render();

function applyMessage(message: ExtensionMessage): void {
  applyExtensionMessage(model, message);
}

function render(): void {
  if (!root) return;
  const state = model.connection;
  if (!state) {
    root.innerHTML = shell("offline", "Checking Symphony...", "Waiting for the first status probe to complete.");
    bindActions();
    return;
  }

  if (state.kind === "connected") {
    root.innerHTML = connectedShell(state);
    bindActions();
    return;
  }

  const title = state.kind === "offline" ? "Symphony offline" : "Symphony error";
  root.innerHTML = shell(
    state.kind,
    title,
    `<p class="meta mono">${escapeHtml(state.baseUrl || "No base URL configured")}</p>
     <p class="meta">${escapeHtml(state.detail)}</p>`,
  );
  bindActions();
}

function connectedShell(state: Extract<ConnectionState, { kind: "connected" }>): string {
  const running = state.summary.runningCount === null ? "unknown" : String(state.summary.runningCount);
  const token = state.summary.tokenConfigured ? "configured" : "not configured";
  const tokenWarning =
    state.summary.mutationsRequireToken === true && !state.summary.tokenConfigured
      ? "<p class=\"meta warning\">Mutating controls require a token. Configure symphony.token before using workspace actions.</p>"
      : "";
  const body = `<div class="topbar">
      <div>
        <p class="meta mono">${escapeHtml(state.baseUrl)}</p>
        <p class="meta">Snapshot: <span class="mono">${escapeHtml(state.generatedAt)}</span> · Running agents: <span class="mono">${running}</span> · Token: <span class="mono">${token}</span></p>
      </div>
      <div class="actions compact">
        <button type="button" data-action="refresh">Refresh</button>
        <button type="button" data-action="settings">Settings</button>
      </div>
    </div>
    ${tokenWarning}
    ${model.operationMessage ? `<p class="notice ${model.operationMessage.level}">${escapeHtml(model.operationMessage.message)}</p>` : ""}
    <div class="tabs">
      ${tabButton("issues", "Issues")}
      ${tabButton("history", "History")}
    </div>
    ${model.activeTab === "issues" ? renderIssuesView(state) : renderHistoryView()}`;
  return shell("connected", "Symphony connected", body);
}

function shell(kind: "connected" | "offline" | "error", title: string, body: string): string {
  return `<main class="shell">
    <section class="card">
      <div class="title"><span class="dot ${kind}"></span>${escapeHtml(title)}</div>
      ${body}
      <div class="actions footer-actions">
        <button type="button" data-action="retry">Retry</button>
        <button type="button" data-action="settings">Settings</button>
      </div>
    </section>
  </main>`;
}

function bindActions(): void {
  if (!root) return;
  root.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === "retry") vscode.postMessage({ type: "retry" });
    if (action === "refresh") {
      model.dashboardGeneration += 1;
      vscode.postMessage({ type: "refresh" });
    }
    if (action === "settings") vscode.postMessage({ type: "openSettings" });
    if (action === "tab" && (target.dataset.tab === "issues" || target.dataset.tab === "history")) {
      model.activeTab = target.dataset.tab;
      render();
    }
    if (action === "selectIssue" && target.dataset.issue) {
      model.activeTab = "issues";
      model.selectedIssueKey = target.dataset.issue;
      model.issueEpoch += 1;
      model.issueDetail = null;
      model.issueActivity = [];
      model.issueActivityNextOffset = null;
      model.issueError = null;
      model.issueActivityError = null;
      vscode.postMessage({ type: "selectIssue", issueKey: target.dataset.issue });
      render();
    }
    if (action === "loadMoreActivity" && target.dataset.offset) {
      vscode.postMessage({ type: "loadMoreActivity", offset: Number(target.dataset.offset) });
    }
    if (action === "loadMoreIssueActivity" && target.dataset.issue && target.dataset.offset) {
      vscode.postMessage({ type: "loadMoreIssueActivity", issueKey: target.dataset.issue, offset: Number(target.dataset.offset) });
    }
    if (action === "selectRun" && target.dataset.run) {
      model.activeTab = "history";
      model.selectedRunId = target.dataset.run;
      model.runEpoch += 1;
      model.runDetail = null;
      model.transcript = [];
      model.transcriptNextOffset = null;
      model.runError = null;
      model.transcriptError = null;
      vscode.postMessage({ type: "selectRun", runId: target.dataset.run });
      render();
    }
    if (action === "loadMoreTranscript" && target.dataset.run && target.dataset.offset) {
      vscode.postMessage({ type: "loadMoreTranscript", runId: target.dataset.run, offset: Number(target.dataset.offset) });
    }
    if (action === "openWorkspace" && target.dataset.issue) {
      vscode.postMessage({ type: "openWorkspace", issueKey: target.dataset.issue });
    }
  };
}

function renderIssuesView(state: Extract<ConnectionState, { kind: "connected" }>): string {
  const board = model.board;
  return `<section class="view">
    <div class="view-header">
      <div>
        <h2>Issue Board</h2>
        <p class="meta">Review and human-review work share the workflow review lane while this workflow has no separate Human Review state.</p>
      </div>
      ${board ? `<p class="meta">Generated <span class="mono">${escapeHtml(board.generatedAt)}</span></p>` : ""}
    </div>
    ${model.boardLoading && !board ? `<div class="empty">Loading issue board...</div>` : ""}
    ${model.boardError ? `<div class="notice error">${escapeHtml(model.boardError)}</div>` : ""}
    ${board ? `<div class="issues-layout">${renderBoard(board)}${renderIssueDetail(state)}</div>` : ""}
  </section>`;
}

function renderBoard(board: IssueBoardResponse): string {
  return `<div class="board">${board.columns.map(renderColumn).join("")}</div>`;
}

function renderColumn(column: IssueBoardColumn): string {
  const title = column.id === "review" ? "In Review / Human Review" : column.title;
  return `<section class="lane">
    <header>
      <h3>${escapeHtml(title)}</h3>
      <span class="badge">${column.issues.length}</span>
    </header>
    <p class="meta">${column.states.length > 0 ? escapeHtml(column.states.join(", ")) : "No mapped states"}</p>
    <div class="lane-cards">${column.issues.length > 0 ? column.issues.map(renderIssueCard).join("") : `<div class="empty compact-empty">No issues</div>`}</div>
  </section>`;
}

function renderIssueCard(card: IssueBoardCard): string {
  const issue = card.issueDetails.issue;
  const key = card.issueId ?? card.issueIdentifier ?? card.key;
  const selected = model.selectedIssueKey === key ? " selected" : "";
  return `<button type="button" class="issue-card${selected}" data-action="selectIssue" data-issue="${escapeAttr(key)}">
    <span class="issue-key">${escapeHtml(issue.identifier ?? card.issueIdentifier ?? card.key)}</span>
    <strong>${escapeHtml(issue.title ?? "Untitled issue")}</strong>
    <span class="meta">${escapeHtml(issue.state ?? card.lane)} · ${escapeHtml(card.origin)}</span>
    <span class="badges">${card.paused ? `<span class="badge warn">Paused</span>` : ""}${isHumanRequired(card) ? `<span class="badge warn">Human required</span>` : ""}${card.live ? `<span class="badge ok">Live</span>` : ""}</span>
  </button>`;
}

function renderIssueDetail(state: Extract<ConnectionState, { kind: "connected" }>): string {
  if (!model.selectedIssueKey) {
    return `<aside class="detail"><div class="empty">Select an issue to inspect Linear metadata, workspace, PR/CI, latest run, and activity.</div></aside>`;
  }
  const detail = model.issueDetail;
  if (model.issueError && !detail) return `<aside class="detail"><div class="notice error">${escapeHtml(model.issueError)}</div></aside>`;
  if (!detail) return `<aside class="detail"><div class="empty">Loading issue detail...</div></aside>`;
  const issue = detail.issueDetails.issue;
  const issueKey = issue.identifier ?? issue.id ?? detail.issue;
  return `<aside class="detail">
    <h2>${escapeHtml(issue.identifier ?? detail.issue)}</h2>
    <h3>${escapeHtml(issue.title ?? "Untitled issue")}</h3>
    ${renderSection("Linear Metadata", rows([
      ["State", issue.state],
      ["Priority", issue.priority],
      ["Labels", issue.labels.join(", ")],
      ["Assignee", issue.assigneeId],
      ["Created", issue.createdAt],
      ["Updated", issue.updatedAt],
      ["URL", issue.url],
    ]))}
    ${renderSection("Blockers", rows([
      ["Blocked", boolText(detail.blockers.blocked)],
      ["Open blockers", `${detail.blockers.openCount} / ${detail.blockers.totalCount}`],
      ["Human block", detail.blockers.humanBlockedReason],
      ["Blocker refs", detail.blockers.open.map((blocker) => blocker.identifier ?? blocker.id ?? "unknown").join(", ")],
    ]))}
    ${renderWorkspaceSection(detail, state, issueKey)}
    ${renderSection("PR / CI", rows([
      ["PR", detail.pullRequest.url ?? detail.pullRequest.number],
      ["Head SHA", detail.pullRequest.headSha],
      ["Branch", detail.pullRequest.branch],
      ["CI", detail.pullRequest.ciStatus],
      ["Last pushed", detail.pullRequest.lastPushedAt],
    ]))}
    ${renderSection("Latest Run", rows([
      ["Run ID", detail.issueDetails.latestRun.runId],
      ["Kind", detail.issueDetails.latestRun.runKind],
      ["Phase", detail.issueDetails.latestRun.runPhase],
      ["Status", detail.issueDetails.latestRun.status],
      ["Terminal reason", detail.issueDetails.latestRun.terminalReason],
      ["Completed", detail.issueDetails.latestRun.completedAt],
      ["Error", detail.issueDetails.latestRun.error],
    ]))}
    ${renderRuns(detail.runs)}
    ${renderIssueActivity(model.selectedIssueKey ?? issueKey)}
  </aside>`;
}

function renderWorkspaceSection(detail: BoardIssueDetailResponse, state: Extract<ConnectionState, { kind: "connected" }>, issueKey: string): string {
  const requiresToken = detail.capabilities.mutationsRequireToken ?? state.summary.mutationsRequireToken ?? false;
  const disabled = !detail.capabilities.openWorkspace || (requiresToken && !state.summary.tokenConfigured);
  const reason = !detail.capabilities.openWorkspace
    ? "Workspace unavailable"
    : requiresToken && !state.summary.tokenConfigured
      ? "Configure token"
      : "Open workspace";
  return `<section class="detail-section">
    <h4>Workspace</h4>
    ${rows([
      ["Path", detail.issueDetails.workspace.path],
      ["Branch", detail.issueDetails.workspace.gitBranchName ?? detail.issueDetails.workspace.branchName],
      ["Repo", detail.issueDetails.workspace.repoPath],
      ["Base", detail.issueDetails.workspace.baseRef],
    ])}
    <button type="button" data-action="openWorkspace" data-issue="${escapeAttr(issueKey)}" ${disabled ? "disabled" : ""}>${escapeHtml(reason)}</button>
  </section>`;
}

function renderRuns(runs: JsonObject[]): string {
  if (runs.length === 0) return renderSection("Runs", `<p class="meta">No persisted runs for this issue yet.</p>`);
  return renderSection(
    "Runs",
    `<div class="activity-list">${runs.map((run) => {
      const runId = stringField(run, "runId");
      return `<button type="button" class="activity-row" data-action="selectRun" data-run="${escapeAttr(runId ?? "")}" ${runId ? "" : "disabled"}>
        <strong>${escapeHtml(runId ?? "unknown run")}</strong>
        <span class="meta">${escapeHtml([stringField(run, "role"), stringField(run, "status"), stringField(run, "updatedAt")].filter(Boolean).join(" · "))}</span>
      </button>`;
    }).join("")}</div>`,
  );
}

function renderIssueActivity(issueKey: string): string {
  return renderSection(
    "Issue Activity",
    `${model.issueActivityError ? `<div class="notice error">${escapeHtml(model.issueActivityError)}</div>` : ""}
    ${renderActivityList(model.issueActivity)}
    ${model.issueActivityNextOffset !== null ? `<button type="button" data-action="loadMoreIssueActivity" data-issue="${escapeAttr(issueKey)}" data-offset="${model.issueActivityNextOffset}">Load more activity</button>` : ""}`,
  );
}

function renderHistoryView(): string {
  return `<section class="view">
    <div class="view-header">
      <div>
        <h2>History</h2>
        <p class="meta">Runs and conversations are listed from durable activity, with transcripts loaded one page at a time.</p>
      </div>
      ${model.globalActivityNextOffset !== null ? `<button type="button" data-action="loadMoreActivity" data-offset="${model.globalActivityNextOffset}">Load more history</button>` : ""}
    </div>
    ${model.activityError ? `<div class="notice error">${escapeHtml(model.activityError)}</div>` : ""}
    <div class="history-layout">
      <section class="card subcard">
        <h3>Runs / Conversations</h3>
        ${renderRunList()}
        <h3>Activity</h3>
        ${renderActivityList(model.globalActivity)}
      </section>
      ${renderRunDetail()}
    </div>
  </section>`;
}

function renderRunList(): string {
  const runs = uniqueRuns(model.globalActivity);
  if (runs.length === 0) return `<div class="empty">No run activity has been recorded yet.</div>`;
  return `<div class="activity-list">${runs.map((run) => `<button type="button" class="activity-row${model.selectedRunId === run.runId ? " selected" : ""}" data-action="selectRun" data-run="${escapeAttr(run.runId)}">
    <strong>${escapeHtml(run.runId)}</strong>
    <span class="meta">${escapeHtml([run.issue, run.status, run.role, run.at].filter(Boolean).join(" · "))}</span>
  </button>`).join("")}</div>`;
}

function renderRunDetail(): string {
  if (!model.selectedRunId) return `<aside class="detail"><div class="empty">Select a run to inspect metadata and transcript history.</div></aside>`;
  if (model.runError && !model.runDetail) return `<aside class="detail"><div class="notice error">${escapeHtml(model.runError)}</div></aside>`;
  return `<aside class="detail">
    <h2>${escapeHtml(model.selectedRunId)}</h2>
    ${model.runDetail ? renderSection("Run Metadata", objectRows(model.runDetail, ["issueIdentifier", "role", "runKind", "runPhase", "status", "startedAt", "updatedAt", "completedAt", "error"])) : `<div class="empty">Loading run...</div>`}
    <section class="detail-section steering">
      <h4>Steering</h4>
      <p class="meta">Steering and agent resume controls are placeholders until Symphony exposes explicit APIs.</p>
      <button type="button" disabled>Steering unavailable</button>
    </section>
    ${renderTranscript()}
  </aside>`;
}

function renderTranscript(): string {
  return `<section class="detail-section">
    <h4>Transcript</h4>
    ${model.transcriptError ? `<div class="notice error">${escapeHtml(model.transcriptError)}</div>` : ""}
    ${model.transcript.length === 0 ? `<div class="empty">No transcript events loaded.</div>` : `<div class="transcript">${model.transcript.map(renderTranscriptEvent).join("")}</div>`}
    ${model.transcriptNextOffset !== null && model.selectedRunId ? `<button type="button" data-action="loadMoreTranscript" data-run="${escapeAttr(model.selectedRunId)}" data-offset="${model.transcriptNextOffset}">Load more transcript</button>` : ""}
  </section>`;
}

function renderTranscriptEvent(event: TranscriptEvent): string {
  const payload = renderTranscriptPayload(event);
  return `<article class="transcript-event">
    <header><span class="badge">${escapeHtml(event.source)}</span><strong>${escapeHtml(event.eventType)}</strong><span class="meta mono">#${event.sequence} · ${escapeHtml(event.at)}</span></header>
    ${event.message ? `<p>${escapeHtml(sanitizeTranscriptPreview(event.message))}</p>` : ""}
    ${payload}
  </article>`;
}

function renderTranscriptPayload(event: TranscriptEvent): string {
  if (event.payload === undefined) return missingPayloadNote(event.eventType);
  if (!isSummaryPayload(event.payload)) return `<pre>${escapeHtml(sanitizeTranscriptPreview(previewJson(event.payload)))}</pre>`;
  const rows = summaryRows(event.payload);
  return `<dl class="summary transcript-summary">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(sanitizeTranscriptPreview(String(value)))}</dd>`).join("")}</dl>`;
}

function isSummaryPayload(value: unknown): value is JsonObject & { kind: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { kind?: unknown }).kind === "string";
}

function summaryRows(payload: JsonObject & { kind: string }): Array<[string, string]> {
  const rows: Array<[string, string | null]> = [["Kind", payload.kind]];
  for (const [label, key] of [
    ["Tool", "name"],
    ["Status", "status"],
    ["Call ID", "callId"],
    ["Summary", "summary"],
    ["Text", "textPreview"],
    ["Message", "messagePreview"],
    ["Arguments", "argumentsPreview"],
    ["Result", "resultPreview"],
    ["Output", "outputPreview"],
    ["Error", "errorPreview"],
  ] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) rows.push([label, value]);
  }
  if (payload.truncated === true) rows.push(["Truncated", "yes"]);
  if (payload.redacted === true) rows.push(["Redacted", "yes"]);
  return rows.filter((row): row is [string, string] => row[1] !== null);
}

function renderActivityList(activity: ActivityItem[]): string {
  if (activity.length === 0) return `<div class="empty">No activity in this page.</div>`;
  return `<div class="activity-list">${activity.map((item) => {
    const runId = stringField(item.run, "runId");
    const transcript = item.transcript ? ` · ${item.transcript.eventType} #${item.transcript.sequence}` : "";
    return `<button type="button" class="activity-row" ${runId ? `data-action="selectRun" data-run="${escapeAttr(runId)}"` : "disabled"}>
      <strong>${escapeHtml(item.kind)}</strong>
      <span class="meta">${escapeHtml([item.issue?.identifier ?? item.issue?.id, runId, item.source, item.at].filter(Boolean).join(" · "))}${escapeHtml(transcript)}</span>
      ${item.transcript?.message ? `<span>${escapeHtml(sanitizeTranscriptPreview(item.transcript.message))}</span>` : ""}
    </button>`;
  }).join("")}</div>`;
}

function tabButton(tab: DashboardState["activeTab"], label: string): string {
  return `<button type="button" data-action="tab" data-tab="${tab}" class="${model.activeTab === tab ? "active" : ""}">${label}</button>`;
}

function renderSection(title: string, body: string): string {
  return `<section class="detail-section"><h4>${escapeHtml(title)}</h4>${body}</section>`;
}

function rows(values: Array<[string, unknown]>): string {
  const rendered = values
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
  return rendered ? `<dl>${rendered}</dl>` : `<p class="meta">No data available.</p>`;
}

function objectRows(record: JsonObject, keys: string[]): string {
  return rows(keys.map((key) => [labelize(key), record[key]]));
}

function uniqueRuns(activity: ActivityItem[]): Array<{ runId: string; issue: string | null; role: string | null; status: string | null; at: string }> {
  const seen = new Map<string, { runId: string; issue: string | null; role: string | null; status: string | null; at: string }>();
  for (const item of activity) {
    const runId = stringField(item.run, "runId");
    if (!runId || seen.has(runId)) continue;
    seen.set(runId, {
      runId,
      issue: item.issue?.identifier ?? item.issue?.id ?? null,
      role: stringField(item.run, "role"),
      status: stringField(item.run, "status"),
      at: item.at,
    });
  }
  return [...seen.values()];
}

function stringField(record: unknown, field: string): string | null {
  if (typeof record !== "object" || record === null || !(field in record)) return null;
  const value = (record as JsonObject)[field];
  return typeof value === "string" && value.trim() ? value : null;
}

function isHumanRequired(card: IssueBoardCard): boolean {
  return Boolean(card.capabilities.humanRequired?.active || card.issueDetails.blockers.humanBlockedReason);
}

function boolText(value: boolean): string {
  return value ? "yes" : "no";
}

function labelize(value: string): string {
  return value.replace(/[A-Z]/g, (char) => ` ${char}`).replace(/^./, (char) => char.toUpperCase());
}

function previewJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n... truncated` : text;
}

function missingPayloadNote(eventType: string): string {
  const lowered = eventType.toLowerCase();
  if (lowered.includes("tool") || lowered.includes("thinking")) {
    return `<p class="meta">Detailed tool output or thinking summary was not captured in this persisted event.</p>`;
  }
  return "";
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

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
