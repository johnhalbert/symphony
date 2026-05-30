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

  it("serves web build assets under /web after API routes have precedence", async () => {
    const webAssetsDir = await createTestWebDist(root);
    const { server } = createStatusServer(root, { webAssetsDir });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      for (const route of ["/web", "/web/", "/web/index.html"]) {
        const { response, text } = await getText(`${baseUrl}${route}`);
        expect({ route, status: response.status }).toEqual({ route, status: 200 });
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(text).toContain("Symphony static shell");
        expect(text).toContain('/web/assets/app.css');
      }

      const css = await getText(`${baseUrl}/web/assets/app.css?cache-bust=1`);
      expect(css.response.status).toBe(200);
      expect(css.response.headers.get("content-type")).toContain("text/css");
      expect(css.response.headers.get("cache-control")).toContain("immutable");
      expect(css.text).toContain("color: papayawhip");

      const head = await fetch(`${baseUrl}/web/assets/app.js`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toContain("text/javascript");
      expect(await head.text()).toBe("");

      const missingAsset = await getJson(`${baseUrl}/web/assets/missing.js`);
      expect(missingAsset.response.status).toBe(404);
      expect(missingAsset.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });

      const traversal = await getJson(`${baseUrl}/web/..%2fpackage.json`);
      expect(traversal.response.status).toBe(404);
      expect(traversal.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });

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

      const unsupportedApi = await getJson(`${baseUrl}/api/v1/web/unknown`);
      expect(unsupportedApi.response.status).toBe(404);
      expect(unsupportedApi.body).toEqual({ error: { code: "not_found", message: "Route not found" } });
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
});

interface OrchestratorCallCounts {
  snapshot: number;
  getIssueDetails: number;
  refreshNow: number;
  pauseIssue: number;
  resumeIssue: number;
  cancelIssue: number;
}

function createStatusServer(
  root: string,
  options: { webAssetsDir?: string | null } = {},
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
      webAssetsDir: options.webAssetsDir,
    }),
  };
}

async function createTestWebDist(root: string): Promise<string> {
  const webAssetsDir = path.join(root, "web-dist");
  const assetDir = path.join(webAssetsDir, "assets");
  await mkdir(assetDir, { recursive: true });
  await writeFile(
    path.join(webAssetsDir, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '  <meta charset="UTF-8" />',
      '  <link rel="stylesheet" href="/web/assets/app.css" />',
      "  <title>Symphony static shell</title>",
      "</head>",
      "<body>",
      "  <div id=\"root\">Symphony static shell</div>",
      '  <script type="module" src="/web/assets/app.js"></script>',
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(assetDir, "app.css"), "body { color: papayawhip; }\n");
  await writeFile(path.join(assetDir, "app.js"), "console.log('symphony static shell');\n");
  return webAssetsDir;
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

async function getText(url: string, init?: RequestInit): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, init);
  return { response, text: await response.text() };
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
