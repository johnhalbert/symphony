declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type ConnectionState =
  | { kind: "connected"; baseUrl: string; generatedAt: string; summary: { runningCount: number | null; tokenConfigured: boolean; mutationsRequireToken: boolean | null } }
  | { kind: "offline"; baseUrl: string; reason: string; detail: string }
  | { kind: "error"; baseUrl: string; reason: string; detail: string };

declare global {
  interface Window {
    __SYMPHONY_INITIAL_STATE__?: ConnectionState | null;
  }
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("root");

window.addEventListener("message", (event: MessageEvent<{ type?: string; state?: ConnectionState }>) => {
  if (event.data.type === "connectionState" && event.data.state) render(event.data.state);
});

render(window.__SYMPHONY_INITIAL_STATE__ ?? null);

function render(state: ConnectionState | null): void {
  if (!root) return;
  if (!state) {
    root.innerHTML = shell("offline", "Checking Symphony...", "Waiting for the first status probe to complete.");
    bindActions();
    return;
  }

  if (state.kind === "connected") {
    const running = state.summary.runningCount === null ? "unknown" : String(state.summary.runningCount);
    const token = state.summary.tokenConfigured ? "configured" : "not configured";
    const tokenWarning =
      state.summary.mutationsRequireToken === true && !state.summary.tokenConfigured
        ? "<p class=\"meta\">Mutating controls require a token. Configure symphony.token before enabling future actions.</p>"
        : "";
    root.innerHTML = shell(
      "connected",
      "Symphony connected",
      `<p class="meta mono">${escapeHtml(state.baseUrl)}</p>
       <p class="meta">Snapshot: <span class="mono">${escapeHtml(state.generatedAt)}</span></p>
       <p class="meta">Running agents: <span class="mono">${running}</span></p>
       <p class="meta">Token: <span class="mono">${token}</span></p>
       ${tokenWarning}
       <p class="meta">Board, activity, and transcript views are intentionally left for follow-up work.</p>`,
    );
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

function shell(kind: "connected" | "offline" | "error", title: string, body: string): string {
  return `<main class="shell">
    <section class="card">
      <div class="title"><span class="dot ${kind}"></span>${escapeHtml(title)}</div>
      ${body}
      <div class="actions">
        <button type="button" data-action="retry">Retry</button>
        <button type="button" data-action="settings">Settings</button>
      </div>
    </section>
  </main>`;
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
