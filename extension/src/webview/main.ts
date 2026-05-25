import type { DashboardViewState } from "../dashboardTypes";
import { renderDashboardHtml } from "./render";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

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
  root.innerHTML = renderDashboardHtml(state);
  bindActions();
}

function bindActions(): void {
  root?.querySelector('[data-action="retry"]')?.addEventListener("click", () => vscode.postMessage({ type: "retry" }));
  root?.querySelector('[data-action="settings"]')?.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
  root?.querySelectorAll<HTMLButtonElement>('[data-action="openWorkspace"]').forEach((button) => {
    button.addEventListener("click", () => {
      const issueKey = button.dataset.issueKey;
      if (issueKey) vscode.postMessage({ type: "openWorkspace", issueKey });
    });
  });
}
