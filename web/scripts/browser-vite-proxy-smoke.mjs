#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const webDistRoot = path.resolve(webRoot, "dist");
const requestLog = [];
const browserDevtoolsTimeoutMs = parsePositiveInteger(process.env.SYMPHONY_WEB_BROWSER_DEVTOOLS_TIMEOUT_MS, 30_000);

const totals = {
  backlog: 0,
  todo: 1,
  progress: 1,
  review: 0,
  done: 1,
  cancelled: 0,
  open: 2,
  all: 3,
  completeness: 33,
};

const runningAgent = {
  id: "browser-proxy-agent",
  issue: "PROXY-1",
  title: "Proxy Smoke Vite agent",
  state: "running",
  step: "Loaded through the Vite /api proxy",
  duration: "1s",
  tokens: "42",
};

const sidebarRunningAgent = {
  ...runningAgent,
  id: "sidebar-summary-agent",
  title: "Sidebar summary API agent",
  step: "Loaded through sidebar summary API",
};

const activity = [
  {
    t: "now",
    who: "smoke-api-worker",
    verb: "served",
    id: "PROXY-1",
    extra: "through Vite proxy",
  },
];

const sidebarActivity = [
  {
    t: "now",
    who: "sidebar-summary-worker",
    verb: "summarized",
    id: "SIDEBAR-SMOKE",
    extra: "from sidebar endpoint",
  },
];

const staleDashboardChat = [
  {
    who: "agent",
    text: "STALE dashboard embedded chat should not render",
    suggestions: ["STALE dashboard suggestion should not render"],
  },
];

const staleSidebarChat = [
  {
    who: "agent",
    text: "STALE sidebar embedded chat should not render",
    suggestions: ["STALE sidebar suggestion should not render"],
  },
];

const orchestratorChat = [
  {
    who: "agent",
    text: "Dedicated orchestrator chat from API endpoint",
    suggestions: ["Dedicated smoke suggestion"],
  },
];

const issueSummary = {
  id: "PROXY-1",
  title: "Browser smoke through Vite proxy",
  status: "progress",
  priority: 1,
  labels: ["dogfood-ready", "web"],
  assignee: "smoke-api-worker",
  agent: runningAgent.id,
  project: "Symphony",
  cycle: "Proxy smoke",
  desc: ["Served by the fake API behind the Vite development proxy."],
  activity: [{ t: "now", verb: "loaded", val: "via proxy", who: "smoke-api-worker" }],
  pr: null,
  ci: null,
  workspace: "web-smoke",
  session: "smoke-session",
};

const staleIssueSummary = {
  ...issueSummary,
  id: "PROXY-0",
  title: "Default issue summary before smoke selection",
  status: "todo",
  labels: ["web"],
  agent: null,
  desc: ["Summary-only issue card before the smoke selects PROXY-1."],
  activity: [],
  workspace: "summary-only-workspace",
  session: "summary-only-session",
};

const issueDetail = {
  ...issueSummary,
  desc: ["Dedicated issue detail via Vite proxy."],
  workspace: "web-smoke-detail-workspace",
  session: "smoke-session-detail",
  activity: [{ t: "now", verb: "inspected", val: "dedicated issue detail endpoint", who: "smoke-api-worker" }],
};

const staleIssueDetail = {
  ...staleIssueSummary,
  desc: ["Default stale issue detail before browser selection."],
};

const staleSession = {
  id: "stale-session",
  issue: "PROXY-0",
  title: "Default stale history session",
  state: "finished",
  model: "browser-smoke-stale",
  startedAt: "2026-05-28T00:00:00.000Z",
  updatedAt: "2026-05-28T00:00:01.000Z",
  msgCount: 1,
  lastEvent: "Default stale transcript should not satisfy smoke",
  toolCount: 0,
};

const session = {
  id: "smoke-session",
  issue: "PROXY-1",
  title: "Browser proxy smoke session",
  state: "running",
  model: "browser-smoke",
  startedAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:01.000Z",
  msgCount: 1,
  lastEvent: "Loaded through Vite proxy",
  toolCount: 0,
};

const transcript = [{ kind: "assistant", ts: session.updatedAt, text: "Dedicated session transcript from API endpoint" }];
const staleTranscript = [{ kind: "assistant", ts: staleSession.updatedAt, text: "STALE embedded history transcript should not render" }];

const referenceData = {
  users: {
    "smoke-api-worker": { name: "Smoke API Worker", color: "#68d391" },
  },
  labels: {
    "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
    web: { name: "web", color: "#63b3ed" },
  },
};

const dashboard = {
  projectName: "Symphony Browser Proxy Smoke",
  repoLabel: "proxy/symphony",
  branch: "vite-proxy-smoke",
  workflowLabel: "WORKFLOW.smoke@vite-proxy",
  pollLabel: "poll proxy smoke",
  agentUsageLabel: "1/4 agents",
  concurrencyCap: 4,
  providerGates: [],
  runningAgents: [runningAgent],
  activity,
  chat: staleDashboardChat,
  totals,
};

const issueBoard = {
  issues: [staleIssueSummary, issueSummary],
  backlog: [],
  lanes: {
    todo: [staleIssueSummary],
    progress: [issueSummary],
    review: [],
  },
  cycleLabel: "Proxy smoke cycle",
  cycleDateRange: "today",
  selectedIssueId: staleIssueSummary.id,
};

const history = {
  sessions: [staleSession, session],
  transcriptBySession: {
    [staleSession.id]: staleTranscript,
    [session.id]: staleTranscript,
  },
  timeline: [{ t: session.updatedAt, sess: session.id, kind: "status", text: "Loaded through Vite proxy", state: "running" }],
  defaultSessionId: staleSession.id,
};

const sidebar = {
  providerGates: [],
  runningAgents: [sidebarRunningAgent],
  reviewIssues: [],
  activity: sidebarActivity,
  sessions: [session],
  chat: staleSidebarChat,
  totals,
};

function smokeModeFromArgs(args) {
  if (args.includes("--production") || args.includes("--prod")) return "production";
  return "vite";
}

async function main() {
  requestLog.length = 0;
  const mode = smokeModeFromArgs(process.argv.slice(2));
  if (mode === "production") await runProductionServingSmoke();
  else await runViteProxySmoke();
}

async function runViteProxySmoke() {
  let apiServer = null;
  let viteServer = null;
  let userDataDir = null;
  let browserProcess = null;
  const originalEnv = {
    SYMPHONY_WEB_API_PROXY_TARGET: process.env.SYMPHONY_WEB_API_PROXY_TARGET,
    SYMPHONY_API_PROXY_TARGET: process.env.SYMPHONY_API_PROXY_TARGET,
    VITE_SYMPHONY_API_PROXY_TARGET: process.env.VITE_SYMPHONY_API_PROXY_TARGET,
    VITE_SYMPHONY_API_BASE_URL: process.env.VITE_SYMPHONY_API_BASE_URL,
    VITE_SYMPHONY_DATA_SOURCE: process.env.VITE_SYMPHONY_DATA_SOURCE,
  };

  try {
    const api = await startFakeApiServer();
    apiServer = api.server;
    process.env.SYMPHONY_WEB_API_PROXY_TARGET = api.origin;
    delete process.env.SYMPHONY_API_PROXY_TARGET;
    delete process.env.VITE_SYMPHONY_API_PROXY_TARGET;
    delete process.env.VITE_SYMPHONY_API_BASE_URL;
    process.env.VITE_SYMPHONY_DATA_SOURCE = "api";

    viteServer = await createServer({
      root: webRoot,
      logLevel: "error",
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await viteServer.listen();
    const viteOrigin = resolveViteOrigin(viteServer);

    const proxiedDashboard = await fetchJson(`${viteOrigin}/api/v1/web/dashboard`);
    assert(
      proxiedDashboard.branch === dashboard.branch,
      `Expected Vite proxy to return dashboard branch ${dashboard.branch}, got ${proxiedDashboard.branch}`,
    );

    const browserExecutable = await findBrowserExecutable();
    userDataDir = await mkdtemp(path.join(os.tmpdir(), "symphony-web-smoke-"));
    const browser = await openBrowserPage(browserExecutable, `${viteOrigin}/`, userDataDir);
    browserProcess = browser.process;
    const page = browser.page;
    await prepareBrowserPage(page, `${viteOrigin}/`);
    await runBrowserSmokeAssertions(page);

    await page.close();
    await stopBrowserProcess(browserProcess);
    browserProcess = null;
    console.log(
      `Browser smoke passed: Vite served ${viteOrigin}/ in API mode and proxied ${requestLog.length} API request(s) to ${api.origin}.`,
    );
  } finally {
    restoreEnv(originalEnv);
    if (browserProcess) await stopBrowserProcess(browserProcess);
    if (viteServer) await viteServer.close();
    if (apiServer) await closeServer(apiServer);
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function runProductionServingSmoke() {
  let productionServer = null;
  let userDataDir = null;
  let browserProcess = null;

  try {
    const production = await startProductionWebServer();
    productionServer = production.server;
    const productionOrigin = production.origin;

    await assertProductionStaticServing(productionOrigin);
    const dashboardFromSameOriginApi = await fetchJson(`${productionOrigin}/api/v1/web/dashboard`);
    assert(
      dashboardFromSameOriginApi.branch === dashboard.branch,
      `Expected production same-origin API to return dashboard branch ${dashboard.branch}, got ${dashboardFromSameOriginApi.branch}`,
    );

    const browserExecutable = await findBrowserExecutable();
    userDataDir = await mkdtemp(path.join(os.tmpdir(), "symphony-web-production-smoke-"));
    const browser = await openBrowserPage(browserExecutable, `${productionOrigin}/web/issues/PROXY-1`, userDataDir);
    browserProcess = browser.process;
    const page = browser.page;
    await prepareBrowserPage(page, `${productionOrigin}/web/issues/PROXY-1`);
    await runBrowserSmokeAssertions(page);

    await page.close();
    await stopBrowserProcess(browserProcess);
    browserProcess = null;
    console.log(
      `Browser production smoke passed: built assets from ${webDistRoot} served at ${productionOrigin}/web/ with ${requestLog.length} same-origin API request(s).`,
    );
  } finally {
    if (browserProcess) await stopBrowserProcess(browserProcess);
    if (productionServer) await closeServer(productionServer);
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function prepareBrowserPage(page, url) {
  await page.command("Runtime.enable");
  await page.command("Page.enable");
  await page.command("Page.navigate", { url });
  await page.waitForEvent("Page.loadEventFired", 10_000).catch(() => undefined);
}

async function runBrowserSmokeAssertions(page) {
  const staleChatMarkers = [
    "STALE dashboard embedded chat should not render",
    "STALE dashboard suggestion should not render",
    "STALE sidebar embedded chat should not render",
    "STALE sidebar suggestion should not render",
  ];
  const staleTranscriptMarkers = [
    "STALE embedded history transcript should not render",
  ];
  const mockUiMarkers = ["openai/symphony", "Restart SYM-42"];
  const forbiddenMarkers = [...mockUiMarkers, ...staleChatMarkers];
  const forbiddenSelectedTranscriptMarkers = [...forbiddenMarkers, ...staleTranscriptMarkers];

  await waitForBrowserText(page, "dashboard API-mode data", {
    include: [
      "api source · api",
      "proxy/symphony",
      "vite-proxy-smoke",
      "Proxy Smoke Vite agent",
      "smoke-api-worker",
      "through Vite proxy",
      "Dedicated orchestrator chat from API endpoint",
    ],
    exclude: forbiddenMarkers,
  });

  await waitForBrowserText(page, "dashboard orchestrator chat read-only API-mode guard", {
    include: [
      "Dedicated smoke suggestion",
      "API mode shows durable chat history only",
      "Sending commands from this web chat is not supported yet",
      "no orchestrator action will be dispatched",
    ],
    exclude: forbiddenMarkers,
  });
  await assertButtonDisabledByText(page, "Dedicated smoke suggestion", "dedicated orchestrator chat suggestion");
  await clickButtonByText(page, "Dedicated smoke suggestion", "disabled dedicated orchestrator chat suggestion");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assertNoObservedEndpoint("POST /api/v1/web/orchestrator-chat");

  await clickButtonByAriaLabel(page, "Issues", "Issues tab");
  await waitForBrowserText(page, "issues tab issue cards", {
    include: ["Proxy smoke cycle", "Default issue summary before smoke selection", "PROXY-1"],
    exclude: forbiddenMarkers,
  });
  await clickButtonByText(page, "PROXY-1", "PROXY-1 issue card");
  await waitForBrowserText(page, "PROXY-1 issue detail rendered from the dedicated API endpoint", {
    include: [
      "Dedicated issue detail via Vite proxy.",
      "web-smoke-detail-workspace",
      "smoke-session-detail",
      "dedicated issue detail endpoint",
    ],
    exclude: forbiddenMarkers,
  });

  await clickButtonByAriaLabel(page, "Chat history", "Chat history tab");
  await waitForBrowserText(page, "history session list", {
    include: ["Default stale history session", "Browser proxy smoke session"],
    exclude: forbiddenMarkers,
  });
  await clickButtonByText(page, "Browser proxy smoke session", "smoke transcript session row");
  await waitForBrowserText(page, "selected history transcript rendered from the transcript API endpoint", {
    include: ["Browser proxy smoke session", "smoke-session", "Dedicated session transcript from API endpoint"],
    exclude: forbiddenSelectedTranscriptMarkers,
  });

  await clickButtonByAriaLabel(page, "Sidebars", "Sidebars tab");
  await waitForBrowserText(page, "sidebar summary rendered from API data", {
    include: [
      "Sidebar summary API agent",
      "Loaded through sidebar summary API",
      "sidebar-summary-worker",
      "summarized",
      "SIDEBAR-SMOKE",
      "33%",
      "3 total issues",
    ],
    exclude: forbiddenMarkers,
  });
  await selectOption(page, 'select[aria-label="Sidebar variant"]', "chat", "sidebar chat variant");
  await waitForBrowserText(page, "sidebar chat uses the dedicated orchestrator chat payload and read-only guard", {
    include: [
      "Dedicated orchestrator chat from API endpoint",
      "Dedicated smoke suggestion",
      "read-only API mode",
      "Sending commands from this compact chat is not supported yet",
    ],
    exclude: forbiddenMarkers,
  });
  await assertButtonDisabledByText(page, "Dedicated smoke suggestion", "sidebar dedicated orchestrator chat suggestion");

  assertObservedEndpoints([
    "GET /api/v1/web/reference-data",
    "GET /api/v1/web/dashboard",
    "GET /api/v1/web/issues",
    "GET /api/v1/web/issues/PROXY-1",
    "GET /api/v1/web/history",
    "GET /api/v1/web/sessions/smoke-session/transcript",
    "GET /api/v1/web/sidebar",
    "GET /api/v1/web/orchestrator-chat",
  ]);
  assertNoObservedEndpoint("POST /api/v1/web/orchestrator-chat");
}

async function assertProductionStaticServing(origin) {
  const root = await fetch(`${origin}/web/`);
  assert(root.ok, `Expected production /web/ to return 2xx, got HTTP ${root.status}`);
  assert(root.headers.get("content-type")?.includes("text/html"), `Expected /web/ HTML content-type, got ${root.headers.get("content-type")}`);
  assert(root.headers.get("cache-control") === "no-cache", `Expected /web/ no-cache, got ${root.headers.get("cache-control")}`);
  const html = await root.text();
  assert(html.includes('<div id="root"'), "Production /web/ did not return the built React shell");
  assert(html.includes('/web/assets/'), "Production /web/ shell does not reference /web/-scoped built assets");
  assert(!html.includes('/src/main.tsx'), "Production /web/ returned a dev-server HTML entry instead of built assets");

  const assetPaths = Array.from(html.matchAll(/(?:src|href)="(\/web\/assets\/[^"]+)"/g), (match) => match[1]);
  assert(assetPaths.length > 0, "Production /web/ shell did not include built asset URLs");
  for (const assetPath of assetPaths.slice(0, 2)) {
    const asset = await fetch(`${origin}${assetPath}`);
    assert(asset.ok, `Expected built asset ${assetPath} to return 2xx, got HTTP ${asset.status}`);
    assert(
      asset.headers.get("cache-control") === "public, max-age=31536000, immutable",
      `Expected immutable cache header for ${assetPath}, got ${asset.headers.get("cache-control")}`,
    );
    await asset.arrayBuffer();
  }

  const deepLink = await fetch(`${origin}/web/issues/PROXY-1`);
  assert(deepLink.ok, `Expected /web/issues/PROXY-1 SPA fallback to return 2xx, got HTTP ${deepLink.status}`);
  assert(deepLink.headers.get("content-type")?.includes("text/html"), `Expected deep-link HTML, got ${deepLink.headers.get("content-type")}`);
  const deepLinkHtml = await deepLink.text();
  assert(deepLinkHtml.includes('<div id="root"'), "Production deep-link fallback did not return the built React shell");

  const missingAsset = await fetch(`${origin}/web/assets/missing.js`, { headers: { Accept: "application/json" } });
  assert(missingAsset.status === 404, `Expected missing production asset to return 404, got HTTP ${missingAsset.status}`);
  const missingBody = await missingAsset.json();
  assert(
    missingBody?.error?.message === "Static asset not found",
    `Expected missing production asset JSON 404, got ${JSON.stringify(missingBody)}`,
  );
}

function restoreEnv(originalEnv) {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startFakeApiServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requestLog.push({ method: request.method ?? "GET", path: url.pathname });
    await handleFakeApiRequest(request, response, url);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object", "Fake API server did not expose a TCP address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function handleFakeApiRequest(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/v1/web/reference-data") return sendJson(response, 200, referenceData);
  if (request.method === "GET" && url.pathname === "/api/v1/web/dashboard") return sendJson(response, 200, dashboard);
  if (request.method === "GET" && url.pathname === "/api/v1/web/issues") return sendJson(response, 200, issueBoard);
  if (request.method === "GET" && url.pathname === "/api/v1/web/sidebar") return sendJson(response, 200, sidebar);
  if (request.method === "GET" && url.pathname === "/api/v1/web/history") return sendJson(response, 200, history);
  if (request.method === "GET" && url.pathname === "/api/v1/web/orchestrator-chat") return sendJson(response, 200, orchestratorChat);
  if (request.method === "GET" && url.pathname === "/api/v1/web/issues/PROXY-1") {
    return sendJson(response, 200, { issue: issueDetail, activity: issueDetail.activity, runs: [session], transcript });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/web/issues/PROXY-0") {
    return sendJson(response, 200, { issue: staleIssueDetail, activity: [], runs: [staleSession], transcript: staleTranscript });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/web/sessions/smoke-session/transcript") return sendJson(response, 200, transcript);
  if (request.method === "GET" && url.pathname === "/api/v1/web/sessions/stale-session/transcript") return sendJson(response, 200, staleTranscript);
  if (request.method === "POST" && url.pathname === "/api/v1/web/orchestrator-chat") {
    const bodyText = await readRequestBody(request);
    const input = parseChatInput(bodyText) ?? "browser smoke input";
    return sendJson(response, 200, [
      ...orchestratorChat,
      { who: "user", text: input },
      { who: "agent", text: "Dedicated chat POST acknowledgement from API", suggestions: ["POST guard observed"] },
    ]);
  }

  return sendJson(response, 404, { error: { code: "not_found", path: url.pathname } });
}

async function startProductionWebServer() {
  await assertReadableProductionAsset(path.join(webDistRoot, "index.html"));
  const resolvedDistRoot = await realpath(webDistRoot);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/api/")) {
        requestLog.push({ method: request.method ?? "GET", path: url.pathname });
        await handleFakeApiRequest(request, response, url);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/web" || url.pathname.startsWith("/web/"))) {
        await serveProductionWebAsset(request, response, url, resolvedDistRoot);
        return;
      }

      sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      sendJson(response, 500, { error: { code: "production_smoke_error", message: error instanceof Error ? error.message : String(error) } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object", "Production smoke server did not expose a TCP address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function assertReadableProductionAsset(filePath) {
  try {
    const assetStat = await stat(filePath);
    assert(assetStat.isFile(), `Production smoke requires ${filePath} to be a file`);
  } catch (error) {
    throw new Error(
      `Production smoke requires a built web bundle at ${webDistRoot}. Run npm run build --prefix web before npm run smoke:browser-production --prefix web. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function serveProductionWebAsset(request, response, url, resolvedDistRoot) {
  const assetRequest = resolveProductionWebAssetRequest(url.pathname, resolvedDistRoot);
  if (!assetRequest) {
    sendStaticAssetNotFound(response, request.method ?? "GET");
    return;
  }

  if (assetRequest.relativePath === "index.html" || assetRequest.assetLike) {
    if (await sendProductionWebAssetFile(response, request.method ?? "GET", assetRequest, resolvedDistRoot)) return;
    sendStaticAssetNotFound(response, request.method ?? "GET");
    return;
  }

  const fallback = { filePath: path.join(resolvedDistRoot, "index.html"), relativePath: "index.html" };
  if (await sendProductionWebAssetFile(response, request.method ?? "GET", fallback, resolvedDistRoot)) return;
  sendStaticAssetNotFound(response, request.method ?? "GET");
}

function resolveProductionWebAssetRequest(pathname, resolvedDistRoot) {
  const mountRelativePath = pathname === "/web" ? "" : pathname.slice("/web/".length);
  let decodedRelativePath;
  try {
    decodedRelativePath = decodeURIComponent(mountRelativePath);
  } catch {
    return null;
  }
  const segments = decodedRelativePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const relativePath = segments.length === 0 ? "index.html" : segments.join("/");
  const filePath = path.resolve(resolvedDistRoot, relativePath);
  if (!pathIsWithin(resolvedDistRoot, filePath)) return null;
  return { filePath, relativePath, assetLike: isProductionAssetLike(relativePath, segments) };
}

function isProductionAssetLike(relativePath, segments) {
  const firstSegment = (segments[0] ?? "").toLowerCase();
  return ["assets", "static", "media", "images", "img", "fonts", "icons"].includes(firstSegment) || path.posix.extname(relativePath).length > 0;
}

async function sendProductionWebAssetFile(response, method, assetRequest, resolvedDistRoot) {
  let filePath;
  let assetStat;
  try {
    filePath = await realpath(assetRequest.filePath);
    if (!pathIsWithin(resolvedDistRoot, filePath)) return false;
    assetStat = await stat(filePath);
  } catch {
    return false;
  }
  if (!assetStat.isFile()) return false;

  response.writeHead(200, {
    "content-type": contentTypeForProductionAsset(filePath),
    "content-length": String(assetStat.size),
    "cache-control": assetRequest.relativePath === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (method === "HEAD") {
    response.end();
    return true;
  }
  response.end(await readFile(filePath));
  return true;
}

function sendStaticAssetNotFound(response, method) {
  response.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") response.end();
  else response.end(JSON.stringify({ error: { code: "not_found", message: "Static asset not found" } }));
}

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeForProductionAsset(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".woff") return "font/woff";
  return "application/octet-stream";
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

function parseChatInput(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    return typeof body.input === "string" && body.input.trim() ? body.input.trim() : null;
  } catch {
    return null;
  }
}

function resolveViteOrigin(server) {
  const localUrl = server.resolvedUrls?.local?.find((url) => url.startsWith("http://127.0.0.1:"));
  if (localUrl) return localUrl.replace(/\/$/, "");
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite dev server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function reserveTcpPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object", "Could not reserve a TCP port for browser DevTools");
  const port = address.port;
  await closeServer(server);
  return port;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  assert(response.ok, `Expected ${url} to return 2xx, got HTTP ${response.status}`);
  return response.json();
}

async function findBrowserExecutable() {
  const explicit = [process.env.SYMPHONY_WEB_BROWSER_EXECUTABLE, process.env.CHROME_BIN].filter(Boolean);
  const candidates = [...explicit, ...browserCandidates()];
  for (const candidate of candidates) {
    if (candidate && (await canAccess(candidate))) return candidate;
  }
  throw new Error(
    "No Chromium-compatible browser executable found. Set SYMPHONY_WEB_BROWSER_EXECUTABLE or CHROME_BIN to run the browser smoke.",
  );
}

function browserCandidates() {
  if (process.platform === "win32") {
    const programFiles = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    return programFiles.flatMap((root) => [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
}

async function canAccess(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    try {
      await access(filePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function openBrowserPage(executable, url, userDataDir) {
  const stderrLines = [];
  const debugPort = await reserveTcpPort();
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-sync",
    "--no-default-browser-check",
    "--no-first-run",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  if (process.platform === "linux") args.splice(1, 0, "--no-sandbox", "--disable-dev-shm-usage");

  const browserProcess = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const debugOrigin = await waitForDevtoolsOrigin(browserProcess, stderrLines, debugPort);
    const target = await createBrowserTarget(debugOrigin, url);
    const page = await connectCdp(target.webSocketDebuggerUrl);
    page.stderrLines = stderrLines;
    return { process: browserProcess, page };
  } catch (error) {
    await stopBrowserProcess(browserProcess).catch(() => undefined);
    throw error;
  }
}

async function waitForDevtoolsOrigin(browserProcess, stderrLines, debugPort) {
  let buffer = "";
  let stderrDevtoolsOrigin = null;
  let browserExit = null;
  let lastPollError = null;

  const onData = (data) => {
    const text = String(data);
    stderrLines.push(text);
    buffer += text;
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
    if (match) stderrDevtoolsOrigin = debugOriginFromWebSocketUrl(match[1]);
  };
  const onExit = (code, signal) => {
    browserExit = { code, signal };
  };

  try {
    browserProcess.stderr?.on("data", onData);
    browserProcess.once("exit", onExit);
    const deadline = Date.now() + browserDevtoolsTimeoutMs;
    while (Date.now() < deadline) {
      if (stderrDevtoolsOrigin) return stderrDevtoolsOrigin;
      if (browserExit) throw browserExitedBeforeDevtoolsError(browserExit, stderrLines);
      try {
        const polledOrigin = await pollDevtoolsOrigin(debugPort);
        if (polledOrigin) return polledOrigin;
      } catch (error) {
        lastPollError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (browserExit) throw browserExitedBeforeDevtoolsError(browserExit, stderrLines);
    const pollDetail = lastPollError instanceof Error ? ` Last poll error: ${lastPollError.message}` : "";
    throw new Error(
      `Timed out waiting for browser DevTools endpoint on 127.0.0.1:${debugPort}.${pollDetail} Browser stderr:\n${stderrLines.join("")}`,
    );
  } finally {
    browserProcess.stderr?.off("data", onData);
    browserProcess.off("exit", onExit);
  }
}

function browserExitedBeforeDevtoolsError(browserExit, stderrLines) {
  return new Error(
    `Browser exited before DevTools was ready (code ${browserExit.code}, signal ${browserExit.signal}). Browser stderr:\n${stderrLines.join("")}`,
  );
}

async function pollDevtoolsOrigin(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(500),
  });
  if (!response.ok) return null;
  const version = await response.json();
  return typeof version.webSocketDebuggerUrl === "string" ? debugOriginFromWebSocketUrl(version.webSocketDebuggerUrl) : null;
}

function debugOriginFromWebSocketUrl(webSocketUrl) {
  const parsed = new URL(webSocketUrl);
  const protocol = parsed.protocol === "wss:" ? "https" : "http";
  return `${protocol}://${parsed.host}`;
}

async function createBrowserTarget(debugOrigin, url) {
  const targetUrl = `${debugOrigin}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(targetUrl, { method: "PUT" });
  if (!response.ok && (response.status === 405 || response.status === 404)) response = await fetch(targetUrl);
  assert(response.ok, `Could not create browser target via ${targetUrl}: HTTP ${response.status}`);
  const target = await response.json();
  assert(typeof target.webSocketDebuggerUrl === "string", "Browser target did not include webSocketDebuggerUrl");
  return target;
}

async function connectCdp(webSocketUrl) {
  assert(typeof WebSocket === "function", "Node WebSocket client is unavailable; use Node 22 or newer");
  const ws = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to browser WebSocket")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Browser WebSocket connection failed"));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
      else resolve(message.result ?? {});
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params ?? {});
    }
  });

  return {
    async command(method, params = {}) {
      const id = nextId++;
      const payload = JSON.stringify({ id, method, params });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(payload);
      });
    },
    async evaluate(expression) {
      const result = await this.command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value;
    },
    waitForEvent(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          off();
          reject(new Error(`Timed out waiting for browser event ${method}`));
        }, timeoutMs);
        const listener = (params) => {
          clearTimeout(timeout);
          off();
          resolve(params);
        };
        const off = () => {
          const methodListeners = listeners.get(method);
          if (!methodListeners) return;
          methodListeners.delete(listener);
          if (methodListeners.size === 0) listeners.delete(method);
        };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

async function stopBrowserProcess(browserProcess) {
  if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) return;
  browserProcess.kill();
  await waitForProcessExit(browserProcess, 2_000);
  if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) return;
  browserProcess.kill("SIGKILL");
  await waitForProcessExit(browserProcess, 3_000);
}

async function waitForProcessExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.off("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    childProcess.once("exit", onExit);
  });
}

async function waitForBrowserText(page, description, { include = [], exclude = [] }) {
  let lastBrowserState = null;
  return waitFor(async () => {
    const state = await readBrowserTextState(page, include, exclude);
    lastBrowserState = state;
    if (state.missing.length === 0 && state.presentForbidden.length === 0 && state.errors.length === 0) return state;
    return null;
  }, 10_000, 250, `browser to render ${description}`, () => describeBrowserTextState(lastBrowserState));
}

async function readBrowserTextState(page, include, exclude) {
  const snapshot = await page.evaluate(`(() => {
    const body = document.body?.innerText ?? "";
    const statusbar = document.querySelector(".statusbar")?.textContent ?? "";
    const errors = Array.from(document.querySelectorAll(".view-error")).map((element) => element.textContent?.trim() ?? "");
    return { body, statusbar, errors };
  })()`);
  const combinedText = [snapshot.body, snapshot.statusbar].join(" ");
  return {
    ...snapshot,
    missing: include.filter((marker) => !combinedText.includes(marker)),
    presentForbidden: exclude.filter((marker) => combinedText.includes(marker)),
  };
}

async function clickButtonByAriaLabel(page, label, description) {
  await clickElementFromExpression(
    page,
    `(() => Array.from(document.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === ${JSON.stringify(label)}))()`,
    description,
  );
}

async function clickButtonByText(page, text, description) {
  await clickElementFromExpression(
    page,
    `(() => {
      const expected = ${JSON.stringify(text)};
      const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("button")).find((button) => normalize(button.innerText || button.textContent).includes(expected));
    })()`,
    description,
  );
}

async function assertButtonDisabledByText(page, text, description) {
  const result = await page.evaluate(`(() => {
    const expected = ${JSON.stringify(text)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => normalize(candidate.innerText || candidate.textContent).includes(expected));
    if (!button) return { found: false };
    return {
      found: true,
      disabled: Boolean(button.disabled),
      ariaDisabled: button.getAttribute("aria-disabled"),
      text: normalize(button.innerText || button.textContent).slice(0, 160),
    };
  })()`);
  assert(result?.found, `Could not find ${description} in the browser`);
  assert(
    result.disabled || result.ariaDisabled === "true",
    `Expected ${description} to be disabled by the API-mode guard, got ${JSON.stringify(result)}`,
  );
}

async function clickElementFromExpression(page, elementExpression, description) {
  const rect = await page.evaluate(`(() => {
    const element = ${elementExpression};
    if (!element) return { found: false };
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return {
      found: true,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      text: (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
    };
  })()`);
  assert(rect?.found, `Could not find ${description} in the browser`);
  assert(rect.visible, `Found ${description}, but it was not visible/clickable: ${JSON.stringify(rect)}`);
  await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await page.command("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await page.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function selectOption(page, selector, value, description) {
  const result = await page.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!select) return { found: false };
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true, value: select.value, text: (select.textContent || "").replace(/\\s+/g, " ").trim() };
  })()`);
  assert(result?.found, `Could not find ${description} select ${selector}`);
  assert(result.value === value, `Could not select ${description}; expected ${value}, got ${JSON.stringify(result)}`);
}

function assertObservedEndpoints(endpoints) {
  const observed = new Set(requestLog.map((entry) => `${entry.method} ${entry.path}`));
  for (const endpoint of endpoints) {
    assert(observed.has(endpoint), `Expected fake API to receive ${endpoint}`);
  }
}

function assertNoObservedEndpoint(endpoint) {
  const observed = new Set(requestLog.map((entry) => `${entry.method} ${entry.path}`));
  assert(!observed.has(endpoint), `Expected API-mode read-only guard not to call ${endpoint}`);
}

function describeBrowserTextState(state) {
  if (!state) return "no browser state captured";
  const missing = state.missing?.length ? ` missing=${state.missing.join(" | ")}` : "";
  const forbidden = state.presentForbidden?.length ? ` forbidden=${state.presentForbidden.join(" | ")}` : "";
  const errors = state.errors?.length ? ` errors=${state.errors.join(" | ")}` : "";
  const statusbar = typeof state.statusbar === "string" ? state.statusbar.replace(/\s+/g, " ").slice(0, 240) : "";
  const body = typeof state.body === "string" ? state.body.replace(/\s+/g, " ").slice(0, 800) : "";
  return `${missing}${forbidden}${errors} statusbar=${JSON.stringify(statusbar)} body=${JSON.stringify(body)}`;
}

async function waitFor(probe, timeoutMs, intervalMs, description, describeLast = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const lastDescription = typeof describeLast === "function" ? describeLast() : "";
  const suffix = [lastDescription, lastError ? lastError.message : ""].filter(Boolean).join("; ");
  throw new Error(`Timed out waiting for ${description}${suffix ? `: ${suffix}` : ""}`);
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (requestLog.length) console.error(`Fake API requests before failure: ${requestLog.map((entry) => `${entry.method} ${entry.path}`).join(", ")}`);
  process.exitCode = 1;
});
