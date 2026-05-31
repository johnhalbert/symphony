import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { StatusServer, type StatusServerProjectionWriter } from "../src/app/http.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type {
  ProjectionPayloadWriteInput,
  ProjectionRevisionRecord,
  ProjectionWriteResult,
} from "../src/core/persistence/ProjectionTransactionService.js";
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

  it("records durable projection writes for web collection and chat routes", async () => {
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, { projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      for (const path of [
        "/api/v1/web/dashboard",
        "/api/v1/web/issues",
        "/api/v1/web/history?sessionLimit=7&timelineLimit=9",
        "/api/v1/web/sidebar",
        "/api/v1/web/orchestrator-chat?conversationId=operator-room",
      ]) {
        const { response } = await getJson(`${baseUrl}${path}`);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
      }
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writes.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      {
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "global:session:7:timeline:9",
      },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
    ]);
    const dashboard = projectionWriter.writeFor("dashboard_projection");
    expect(dashboard.sourceCursors).toMatchObject({
      issueCount: 0,
      openIssueCount: 0,
      runningAgentCount: 0,
      providerGateCount: 0,
      activityCount: 0,
    });
    const issueBoard = projectionWriter.writeFor("issue_board_projection");
    expect(issueBoard.fields?.fetchedStates).toEqual(
      expect.arrayContaining(["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"]),
    );
    expect(issueBoard.sourceCursors).toMatchObject({ issueCount: 0 });
    expect(projectionWriter.writeFor("history_projection").sourceCursors).toMatchObject({
      sessionLimit: 7,
      timelineLimit: 9,
      sessionCount: 0,
      timelineCount: 0,
    });
    expect(projectionWriter.writeFor("orchestrator_chat_projection")).toMatchObject({
      fields: { conversationKey: "operator-room", messageCount: 0 },
      sourceCursors: { conversationKey: "operator-room", messageCount: 0 },
    });
  });

  it("keeps web responses available when durable projection persistence rejects", async () => {
    const { server } = createStatusServer(root, { projectionWriter: new FailingProjectionWriter() });
    const address = await server.start();
    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/dashboard`);
      expect(response.status).toBe(200);
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
    } finally {
      await server.stop();
    }
  });

  it("keeps the orchestrator chat POST contract bounded when storage is absent and validates malformed input", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = `${baseUrlFor(address)}/api/v1/web/orchestrator-chat`;
    try {
      const unavailable = await postJson(url, { input: "summarize ENG-113" });
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.body).toEqual({
        error: {
          code: "orchestrator_chat_unavailable",
          message: "Web orchestrator chat is unavailable because durable conversation storage is not configured",
        },
        chat: [],
      });
      expect(unavailable.text).not.toContain("summarize ENG-113");

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

  it("serves configured production web assets under /web after API routes have precedence", async () => {
    const webAssetsRoot = await createWebAssets(root);
    const { server } = createStatusServer(root, { webAssetsRoot });
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
      expect(css.response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(css.text).toContain("color: papayawhip");

      const assetHead = await fetch(`${baseUrl}/web/assets/app.js`, { method: "HEAD" });
      expect(assetHead.status).toBe(200);
      expect(assetHead.headers.get("content-type")).toContain("javascript");
      expect(assetHead.headers.get("content-length")).toBe(String("console.log('symphony static shell');\n".length));
      expect(await assetHead.text()).toBe("");

      const deepLink = await getText(`${baseUrl}/web/issues/ENG-119`);
      expect(deepLink.response.status).toBe(200);
      expect(deepLink.response.headers.get("content-type")).toContain("text/html");
      expect(deepLink.response.headers.get("cache-control")).toBe("no-cache");
      expect(deepLink.text).toContain("Symphony static shell");

      const deepLinkHead = await fetch(`${baseUrl}/web/history/session-1`, { method: "HEAD" });
      expect(deepLinkHead.status).toBe(200);
      expect(deepLinkHead.headers.get("content-type")).toContain("text/html");
      expect(deepLinkHead.headers.get("cache-control")).toBe("no-cache");
      expect(await deepLinkHead.text()).toBe("");

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

  it("returns static 404s for missing asset-like /web paths instead of the SPA fallback", async () => {
    const webAssetsRoot = await createWebAssets(root);
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const cases = ["/web/assets/missing.js", "/web/assets", "/web/static/missing", "/web/missing.css", "/web/favicon.ico"];
      for (const route of cases) {
        const missingAsset = await getJson(`${baseUrl}${route}`);
        expect({ route, status: missingAsset.response.status }).toEqual({ route, status: 404 });
        expect(missingAsset.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
        expect(missingAsset.text).not.toContain("Symphony static shell");
      }
    } finally {
      await server.stop();
    }
  });

  it("can explicitly disable /web static serving", async () => {
    const { server } = createStatusServer(root, { webAssetsRoot: null });
    const address = await server.start();
    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/web/`);
      expect(response.status).toBe(404);
      expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
    } finally {
      await server.stop();
    }
  });

  it("returns safe static 404s when the configured /web asset root is missing or not a directory", async () => {
    const nonDirectoryRoot = path.join(root, "web-dist-file");
    await writeFile(nonDirectoryRoot, "not a directory", "utf8");
    const invalidRoots = [path.join(root, "missing-web-dist"), nonDirectoryRoot];

    for (const webAssetsRoot of invalidRoots) {
      const { server } = createStatusServer(root, { webAssetsRoot });
      const address = await server.start();
      const baseUrl = baseUrlFor(address);
      try {
        for (const route of ["/web", "/web/", "/web/assets/app.js"]) {
          const { response, body, text } = await getJson(`${baseUrl}${route}`);
          expect({ route, webAssetsRoot, status: response.status }).toEqual({ route, webAssetsRoot, status: 404 });
          expect(body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
          expect(text).not.toContain("Symphony static shell");
        }
      } finally {
        await server.stop();
      }
    }
  });

  it("does not serve files outside the configured /web asset root", async () => {
    const webAssetsRoot = await createWebAssets(root);
    await writeFile(path.join(root, "secret.txt"), "do not serve", "utf8");
    await writeFile(path.join(webAssetsRoot, ".env"), "SYMPHONY_SECRET=do not serve env", "utf8");
    await writeFile(path.join(webAssetsRoot, "package.json"), '{"secret":"do not serve package"}\n', "utf8");
    await writeFile(path.join(webAssetsRoot, "LICENSE"), "do not serve repository license", "utf8");
    await mkdir(path.join(webAssetsRoot, "src"), { recursive: true });
    await writeFile(path.join(webAssetsRoot, "src", "App.tsx"), "do not serve source", "utf8");
    await mkdir(path.join(webAssetsRoot, ".symphony"), { recursive: true });
    await writeFile(path.join(webAssetsRoot, ".symphony", "state.json"), "do not serve runtime state", "utf8");
    await mkdir(path.join(webAssetsRoot, "symphony_workspaces", "ENG-1"), { recursive: true });
    await writeFile(
      path.join(webAssetsRoot, "symphony_workspaces", "ENG-1", "package.json"),
      '{"secret":"do not serve workspace"}\n',
      "utf8",
    );
    const outsideRoot = path.join(root, "outside-web-dist");
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(path.join(outsideRoot, "secret.txt"), "do not serve via link", "utf8");
    await symlink(
      outsideRoot,
      path.join(webAssetsRoot, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const traversal = await getJson(`${baseUrl}/web/%2e%2e%2fsecret.txt`);
      expect(traversal.response.status).toBe(404);
      expect(traversal.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
      expect(traversal.text).not.toContain("do not serve");

      const missingAsset = await getJson(`${baseUrl}/web/assets/missing.js`);
      expect(missingAsset.response.status).toBe(404);
      expect(missingAsset.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });

      const linkedEscape = await getJson(`${baseUrl}/web/linked-outside/secret.txt`);
      expect(linkedEscape.response.status).toBe(404);
      expect(linkedEscape.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
      expect(linkedEscape.text).not.toContain("do not serve via link");

      const deniedRoutes = [
        { route: "/web/.env", secret: "do not serve env" },
        { route: "/web/package.json", secret: "do not serve package" },
        { route: "/web/LICENSE", secret: "do not serve repository license" },
        { route: "/web/src/App.tsx", secret: "do not serve source" },
        { route: "/web/.symphony/state.json", secret: "do not serve runtime state" },
        { route: "/web/symphony_workspaces/ENG-1/package.json", secret: "do not serve workspace" },
      ];
      for (const { route, secret } of deniedRoutes) {
        const denied = await getJson(`${baseUrl}${route}`);
        expect({ route, status: denied.response.status }).toEqual({ route, status: 404 });
        expect(denied.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
        expect(denied.text).not.toContain(secret);
        expect(denied.text).not.toContain("Symphony static shell");
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

interface CreateStatusServerOptions {
  webAssetsRoot?: string | null;
  projectionWriter?: StatusServerProjectionWriter;
}

class RecordingProjectionWriter implements StatusServerProjectionWriter {
  readonly writes: ProjectionPayloadWriteInput[] = [];

  async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
    this.writes.push(JSON.parse(JSON.stringify(input)) as ProjectionPayloadWriteInput);
    const revision = projectionRevisionRecordFixture(input, this.writes.length);
    return {
      status: "written",
      revision,
      previousRevision: null,
      contentSha256: "0".repeat(64),
      payloadSha256: "1".repeat(64),
      event: null,
    };
  }

  writeFor(projectionName: ProjectionPayloadWriteInput["projectionName"]): ProjectionPayloadWriteInput {
    const write = this.writes.find((candidate) => candidate.projectionName === projectionName);
    if (!write) throw new Error(`expected projection write for ${projectionName}`);
    return write;
  }
}

class FailingProjectionWriter implements StatusServerProjectionWriter {
  async writeProjection(): Promise<ProjectionWriteResult> {
    throw new Error("simulated projection persistence failure");
  }
}

function projectionRevisionRecordFixture(input: ProjectionPayloadWriteInput, revision: number): ProjectionRevisionRecord {
  return {
    projectionRevisionId: revision,
    projectionName: input.projectionName,
    scopeKind: input.scopeKind ?? "global",
    scopeKey: input.scopeKey ?? "global",
    revision,
    sourceRevisions: [],
    sourceCursors: {},
    sourceFreshness: [],
    contentSha256: "0".repeat(64),
    generatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    supersededAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
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
      ...(options.projectionWriter ? { projectionWriter: options.projectionWriter } : {}),
    }),
  };
}

async function createWebAssets(root: string): Promise<string> {
  const webAssetsRoot = path.join(root, "web-dist");
  const assetDir = path.join(webAssetsRoot, "assets");
  await mkdir(assetDir, { recursive: true });
  await writeFile(
    path.join(webAssetsRoot, "index.html"),
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
    "utf8",
  );
  await writeFile(path.join(assetDir, "app.css"), "body { color: papayawhip; }\n", "utf8");
  await writeFile(path.join(assetDir, "app.js"), "console.log('symphony static shell');\n", "utf8");
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
