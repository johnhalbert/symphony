import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Orchestrator } from "../core/orchestrator/Orchestrator.js";
import type { WorkspaceManager } from "../core/workspace/WorkspaceManager.js";
import type { CursorWorkspaceOpener } from "../../cursor/src/CursorWorkspaceOpener.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import type { IssueLifecycleRecord, IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore, WorkspaceRecord } from "../core/persistence/RunTranscriptStore.js";

export interface StatusServerOptions {
  orchestrator: Orchestrator;
  workspaceManager: WorkspaceManager;
  workspaceOpener: CursorWorkspaceOpener;
  runStore?: RunTranscriptStore;
  lifecycleStore?: IssueLifecycleStore;
  host: string;
  port: number;
  openWorkspaceToken: string | null;
}

export class StatusServer {
  private server: http.Server | null = null;

  constructor(private readonly options: StatusServerOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      const address = this.server.address();
      return typeof address === "object" && address
        ? { host: address.address, port: address.port }
        : { host: this.options.host, port: this.options.port };
    }
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(this.options.port, this.options.host, resolve);
    });
    const address = this.server.address();
    if (typeof address === "object" && address) return { host: address.address, port: address.port };
    return { host: this.options.host, port: this.options.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, renderDashboard(this.options.orchestrator.snapshot()));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/state") {
        sendJson(response, 200, this.options.orchestrator.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
        sendJson(response, 200, {
          workspaces: (await this.options.runStore?.listWorkspaces()) ?? [],
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
        await this.options.orchestrator.refreshNow();
        sendJson(response, 202, {
          queued: true,
          coalesced: false,
          requested_at: new Date().toISOString(),
          operations: ["poll", "reconcile"],
        });
        return;
      }

      const pauseMatch = /^\/api\/v1\/issues\/([^/]+)\/pause$/.exec(url.pathname);
      if (request.method === "POST" && pauseMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(pauseMatch[1] ?? "");
        this.options.orchestrator.pauseIssue(issueId);
        sendJson(response, 202, { paused: true, issue: issueId });
        return;
      }

      const resumeMatch = /^\/api\/v1\/issues\/([^/]+)\/resume$/.exec(url.pathname);
      if (request.method === "POST" && resumeMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(resumeMatch[1] ?? "");
        this.options.orchestrator.resumeIssue(issueId);
        sendJson(response, 202, { paused: false, issue: issueId });
        return;
      }

      const cancelMatch = /^\/api\/v1\/issues\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(cancelMatch[1] ?? "");
        await this.options.orchestrator.cancelIssue(issueId);
        sendJson(response, 202, { cancelled: true, issue: issueId });
        return;
      }

      const issueRunsMatch = /^\/api\/v1\/issues\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "GET" && issueRunsMatch) {
        const issueId = decodeURIComponent(issueRunsMatch[1] ?? "");
        sendJson(response, 200, {
          issue: issueId,
          runs: (await this.options.runStore?.listRunsForIssue(issueId)) ?? [],
        });
        return;
      }

      const issueMatch = /^\/api\/v1\/issues\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && issueMatch) {
        const issueId = decodeURIComponent(issueMatch[1] ?? "");
        const live = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const latestRun = await this.options.runStore?.latestRunForIssue(issueId);
        const lifecycle = await this.options.lifecycleStore?.get(issueId);
        if (!live && !workspace && !latestRun && !lifecycle) throw new SymphonyError("not_found", `Issue not found: ${issueId}`);
        const workspacePath = live?.workspacePath ?? workspace?.path ?? null;
        sendJson(response, 200, {
          issue: issueId,
          live,
          workspace,
          latestRun,
          lifecycle,
          metadata: statusMetadata({ live, workspace, latestRun, lifecycle }),
          capabilities: {
            transcript: Boolean(latestRun),
            openWorkspace: workspacePath === null ? false : await pathExists(workspacePath),
          },
        });
        return;
      }

      const transcriptMatch = /^\/api\/v1\/runs\/([^/]+)\/transcript$/.exec(url.pathname);
      if (request.method === "GET" && transcriptMatch) {
        const runId = decodeURIComponent(transcriptMatch[1] ?? "");
        const run = await this.options.runStore?.getRun(runId);
        if (!run) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        sendJson(response, 200, await this.options.runStore?.readTranscript(runId, parsePagination(url)));
        return;
      }

      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const runId = decodeURIComponent(runMatch[1] ?? "");
        const run = await this.options.runStore?.getRun(runId);
        if (!run) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        sendJson(response, 200, run);
        return;
      }

      const workspaceMatch = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && workspaceMatch) {
        const workspaceKey = decodeURIComponent(workspaceMatch[1] ?? "");
        const workspace = await this.options.runStore?.findWorkspace(workspaceKey);
        if (!workspace) throw new SymphonyError("not_found", `Workspace not found: ${workspaceKey}`);
        sendJson(response, 200, workspace);
        return;
      }

      const openMatch = /^\/api\/v1\/issues\/([^/]+)\/open-workspace$/.exec(url.pathname);
      if (request.method === "POST" && openMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(openMatch[1] ?? "");
        const details = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const workspacePath =
          details?.workspacePath ?? workspace?.path ?? this.options.workspaceManager.getPathForIssue(issueId);
        if (!(await pathExists(workspacePath))) {
          throw new SymphonyError("not_found", `Workspace not found: ${workspacePath}`);
        }
        await this.options.workspaceOpener.open(workspacePath);
        sendJson(response, 202, { opened: true, workspace_path: workspacePath });
        return;
      }

      sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const status =
        error instanceof SymphonyError && error.code === "not_found"
          ? 404
          : error instanceof SymphonyError && error.code === "invalid_request"
            ? 401
            : 500;
      sendJson(response, status, {
        error: {
          code: error instanceof SymphonyError ? error.code : "internal_error",
          message: errorMessage(error),
        },
      });
    }
  }

  private requireMutationToken(request: IncomingMessage): void {
    const expected = this.options.openWorkspaceToken;
    if (!expected) return;
    const provided = request.headers["x-symphony-token"];
    if (provided !== expected) {
      throw new SymphonyError("invalid_request", "Missing or invalid open-workspace token");
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function renderDashboard(snapshot: ReturnType<Orchestrator["snapshot"]>): string {
  const running = snapshot.running
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.issueIdentifier)}</strong> ${escapeHtml(row.state)} ${escapeHtml(
          row.lastEvent ?? "",
        )}<br><code>${escapeHtml(row.workspacePath ?? "")}</code></li>`,
    )
    .join("");
  return `<!doctype html>
<html>
  <head><title>Symphony</title></head>
  <body>
    <h1>Symphony</h1>
    <p>Running: ${snapshot.counts.running}, retrying: ${snapshot.counts.retrying}</p>
    <ul>${running}</ul>
  </body>
</html>`;
}

function parsePagination(url: URL): { offset: number; limit: number } {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  return {
    offset: Number.isFinite(offset) ? Math.max(Math.floor(offset), 0) : 0,
    limit: Number.isFinite(limit) ? Math.max(Math.floor(limit), 1) : 100,
  };
}

function statusMetadata(input: {
  live: ReturnType<Orchestrator["getIssueDetails"]>;
  workspace: WorkspaceRecord | null | undefined;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
}) {
  const pointers = input.lifecycle?.summaryPointers;
  return {
    prUrl: metadataValue(input.latestRun, "prUrl", pointers?.prUrl ?? null),
    prNumber: metadataValue(input.latestRun, "prNumber", pointers?.prNumber ?? null),
    ciStatus: metadataValue(input.latestRun, "ciStatus", pointers?.ciStatus ?? null),
    lastPushedAt: metadataValue(input.latestRun, "lastPushedAt", pointers?.lastPushedAt ?? null),
    branchName:
      input.live?.metadata?.branchName ??
      pointers?.branchName ??
      input.latestRun?.gitBranchName ??
      input.workspace?.gitBranchName ??
      null,
    gitBranchName:
      input.live?.metadata?.gitBranchName ??
      pointers?.gitBranchName ??
      input.latestRun?.gitBranchName ??
      input.workspace?.gitBranchName ??
      null,
    repoPath: input.live?.metadata?.repoPath ?? pointers?.repoPath ?? input.latestRun?.repoPath ?? input.workspace?.repoPath ?? null,
    baseRef: input.live?.metadata?.baseRef ?? pointers?.baseRef ?? input.latestRun?.baseRef ?? input.workspace?.baseRef ?? null,
  };
}

function metadataValue<K extends "prUrl" | "prNumber" | "ciStatus" | "lastPushedAt">(
  run: RunRecord | null | undefined,
  key: K,
  fallback: NonNullable<RunRecord[K]> | null,
): RunRecord[K] | null {
  if (run && Object.prototype.hasOwnProperty.call(run, key)) return run[key] ?? null;
  return fallback;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
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
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
