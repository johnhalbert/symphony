import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { StatusServer } from "../src/app/http.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type { TrackerStateLists } from "../src/core/types.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { testConfig } from "./helpers.js";

describe("/api/v1/web route contracts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-route-contract-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the frontend GET route matrix with stable JSON top-level contracts", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const routes: Array<{ path: string; assert: (body: unknown, text: string) => void }> = [
        {
          path: "/api/v1/web/reference-data",
          assert: (body) => {
            expectTopLevelKeys(body, ["labels", "users"]);
            expect(body).toMatchObject({ labels: {}, users: { unassigned: { name: "Unassigned" } } });
          },
        },
        {
          path: "/api/v1/web/dashboard",
          assert: (body) => {
            expectTopLevelKeys(body, [
              "activity",
              "agentUsageLabel",
              "branch",
              "chat",
              "concurrencyCap",
              "pollLabel",
              "projectName",
              "providerGates",
              "repoLabel",
              "runningAgents",
              "totals",
              "workflowLabel",
            ]);
            expect(body).toEqual({
              projectName: "Symphony",
              repoLabel: "",
              branch: "",
              workflowLabel: "",
              pollLabel: "",
              agentUsageLabel: "0 agents",
              concurrencyCap: 0,
              providerGates: [],
              runningAgents: [],
              activity: [],
              chat: [],
              totals: emptyTotals(),
            });
          },
        },
        {
          path: "/api/v1/web/issues",
          assert: (body) => {
            expectTopLevelKeys(body, ["backlog", "cycleDateRange", "cycleLabel", "issues", "lanes", "selectedIssueId"]);
            expect(body).toEqual({
              issues: [],
              backlog: [],
              lanes: { todo: [], progress: [], review: [] },
              cycleLabel: "",
              cycleDateRange: "",
              selectedIssueId: "",
            });
          },
        },
        {
          path: "/api/v1/web/issues/UNKNOWN-1",
          assert: (body, text) => {
            expect(body).toBeNull();
            expect(text.trim()).toBe("null");
          },
        },
        {
          path: "/api/v1/web/history",
          assert: (body) => {
            expectTopLevelKeys(body, ["defaultSessionId", "sessions", "timeline", "transcriptBySession"]);
            expect(body).toEqual({ sessions: [], transcriptBySession: {}, timeline: [], defaultSessionId: "" });
          },
        },
        {
          path: "/api/v1/web/sessions/missing-session/transcript",
          assert: (body, text) => {
            expect(body).toEqual([]);
            expect(text.trim()).toBe("[]");
          },
        },
        {
          path: "/api/v1/web/sidebar",
          assert: (body) => {
            expectTopLevelKeys(body, [
              "activity",
              "chat",
              "providerGates",
              "reviewIssues",
              "runningAgents",
              "sessions",
              "totals",
            ]);
            expect(body).toEqual({
              providerGates: [],
              runningAgents: [],
              reviewIssues: [],
              activity: [],
              sessions: [],
              chat: [],
              totals: emptyTotals(),
            });
          },
        },
        {
          path: "/api/v1/web/orchestrator-chat",
          assert: (body, text) => {
            expect(body).toEqual([]);
            expect(text.trim()).toBe("[]");
          },
        },
      ];

      for (const route of routes) {
        const { response, body, text } = await getJson(`${baseUrl}${route.path}`);
        expect({ path: route.path, status: response.status }).toEqual({ path: route.path, status: 200 });
        route.assert(body, text);
        expect(text).not.toMatch(/mock|placeholder|sample/i);
      }
    } finally {
      await server.stop();
    }
  });

  it("keeps the orchestrator chat POST contract side-effect-free and validates malformed input", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = `${baseUrlFor(address)}/api/v1/web/orchestrator-chat`;
    try {
      const accepted = await postJson(url, { input: "summarize ENG-113" });
      expect(accepted.response.status).toBe(200);
      expect(accepted.body).toEqual([]);
      expect(accepted.text.trim()).toBe("[]");
      expect(accepted.text).not.toContain("summarize ENG-113");

      const malformed = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ input: "   " }),
      });
      const malformedBody = (await malformed.json()) as { error?: { code?: string; message?: string } };
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("content-type")).toContain("application/json");
      expect(malformedBody.error).toMatchObject({
        code: "invalid_request",
        message: "Web orchestrator chat request body must include a non-empty string input",
      });
      expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    } finally {
      await server.stop();
    }
  });

  it("returns JSON not_found errors for unsupported /api/v1/web route or method variants", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const unsupportedCases: Array<{ name: string; url: string; init?: RequestInit }> = [
        { name: "unsupported dashboard method", url: `${baseUrl}/api/v1/web/dashboard`, init: { method: "POST" } },
        { name: "missing transcript suffix", url: `${baseUrl}/api/v1/web/sessions/run-1` },
        { name: "unknown web route", url: `${baseUrl}/api/v1/web/unknown` },
      ];

      for (const testCase of unsupportedCases) {
        const { response, body } = await getJson(testCase.url, testCase.init);
        expect({ name: testCase.name, status: response.status }).toEqual({ name: testCase.name, status: 404 });
        expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
      }
    } finally {
      await server.stop();
    }
  });

  it("serves configured production web assets under /web while preserving same-origin web APIs", async () => {
    const webAssetsRoot = await createWebAssets(root);
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const redirect = await fetch(`${baseUrl}/web`, { redirect: "manual" });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("location")).toBe("/web/");

      const index = await fetch(`${baseUrl}/web/`);
      const indexText = await index.text();
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(index.headers.get("cache-control")).toBe("no-cache");
      expect(indexText).toContain("Symphony Web App");
      expect(indexText).toContain('/web/assets/app.js');

      const spaFallback = await fetch(`${baseUrl}/web/issues/ENG-119`);
      expect(spaFallback.status).toBe(200);
      expect(spaFallback.headers.get("content-type")).toContain("text/html");
      expect(await spaFallback.text()).toContain("Symphony Web App");

      const asset = await fetch(`${baseUrl}/web/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await asset.text()).toContain("web asset loaded");

      const assetHead = await fetch(`${baseUrl}/web/assets/app.js`, { method: "HEAD" });
      expect(assetHead.status).toBe(200);
      expect(assetHead.headers.get("content-type")).toContain("javascript");
      expect(assetHead.headers.get("content-length")).toBe(String("console.log('web asset loaded');\n".length));
      expect(await assetHead.text()).toBe("");

      const api = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(api.response.status).toBe(200);
      expectTopLevelKeys(api.body, [
        "activity",
        "agentUsageLabel",
        "branch",
        "chat",
        "concurrencyCap",
        "pollLabel",
        "projectName",
        "providerGates",
        "repoLabel",
        "runningAgents",
        "totals",
        "workflowLabel",
      ]);
    } finally {
      await server.stop();
    }
  });

  it("keeps /web unclaimed when assets are not configured", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/web/`);
      expect(response.status).toBe(404);
      expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
    } finally {
      await server.stop();
    }
  });

  it("does not serve files outside the configured /web asset root", async () => {
    const webAssetsRoot = await createWebAssets(root);
    await writeFile(path.join(root, "secret.txt"), "do not serve", "utf8");
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const traversal = await fetch(`${baseUrl}/web/%2e%2e%2fsecret.txt`);
      expect(traversal.status).toBe(404);
      expect(traversal.headers.get("content-type")).toContain("text/plain");
      expect(await traversal.text()).not.toContain("do not serve");

      const missingAsset = await fetch(`${baseUrl}/web/assets/missing.js`);
      expect(missingAsset.status).toBe(404);
      expect(missingAsset.headers.get("content-type")).toContain("text/plain");
      expect(await missingAsset.text()).toContain("Web asset not found");
    } finally {
      await server.stop();
    }
  });
});

interface OrchestratorCallCounts {
  snapshot: number;
  getIssueDetails: number;
  refreshNow: number;
  pauseIssue: number;
  resumeIssue: number;
  cancelIssue: number;
}

interface CreateStatusServerOptions {
  webAssetsRoot?: string | null;
}

function createStatusServer(
  root: string,
  options: CreateStatusServerOptions = {},
): { server: StatusServer; calls: OrchestratorCallCounts } {
  const config = testConfig(path.join(root, "workspaces"));
  const { orchestrator, calls } = instrumentedOrchestrator();
  return {
    calls,
    server: new StatusServer({
      orchestrator,
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
      webAssetsRoot: options.webAssetsRoot,
    }),
  };
}

async function createWebAssets(root: string): Promise<string> {
  const webAssetsRoot = path.join(root, "web-dist");
  await mkdir(path.join(webAssetsRoot, "assets"), { recursive: true });
  await writeFile(
    path.join(webAssetsRoot, "index.html"),
    `<!doctype html>
<html>
  <head><title>Symphony Web App</title></head>
  <body>
    <div id="root">Symphony Web App</div>
    <script type="module" src="/web/assets/app.js"></script>
  </body>
</html>
`,
    "utf8",
  );
  await writeFile(path.join(webAssetsRoot, "assets", "app.js"), "console.log('web asset loaded');\n", "utf8");
  return webAssetsRoot;
}

function instrumentedOrchestrator(): { orchestrator: Orchestrator; calls: OrchestratorCallCounts } {
  const calls: OrchestratorCallCounts = {
    snapshot: 0,
    getIssueDetails: 0,
    refreshNow: 0,
    pauseIssue: 0,
    resumeIssue: 0,
    cancelIssue: 0,
  };
  return {
    calls,
    orchestrator: {
      snapshot() {
        calls.snapshot += 1;
        return {
          generatedAt: "2026-01-01T00:00:00.000Z",
          counts: { running: 0, retrying: 0, paused: 0 },
          running: [],
          retrying: [],
          paused: [],
          totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
          rateLimits: null,
          providerGates: [],
        };
      },
      getIssueDetails() {
        calls.getIssueDetails += 1;
        return null;
      },
      async refreshNow() {
        calls.refreshNow += 1;
      },
      pauseIssue() {
        calls.pauseIssue += 1;
      },
      resumeIssue() {
        calls.resumeIssue += 1;
      },
      async cancelIssue() {
        calls.cancelIssue += 1;
      },
    } as unknown as Orchestrator,
  };
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["In Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  };
}

function baseUrlFor(address: { host: string; port: number }): string {
  return `http://${address.host}:${address.port}`;
}

async function getJson(url: string, init?: RequestInit): Promise<{ response: Response; text: string; body: unknown }> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, ...init });
  const text = await response.text();
  expect(response.headers.get("content-type")).toContain("application/json");
  return { response, text, body: JSON.parse(text) as unknown };
}

async function postJson(url: string, body: unknown): Promise<{ response: Response; text: string; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.headers.get("content-type")).toContain("application/json");
  return { response, text, body: JSON.parse(text) as unknown };
}

function expectTopLevelKeys(body: unknown, keys: string[]): void {
  expect(body).not.toBeNull();
  expect(Array.isArray(body)).toBe(false);
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([...keys].sort());
}

function emptyTotals(): Record<string, number> {
  return { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 };
}
