#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const requestLog = [];

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

const activity = [
  {
    t: "now",
    who: "smoke-api-worker",
    verb: "served",
    id: "PROXY-1",
    extra: "through Vite proxy",
  },
];

const chat = [{ who: "agent", text: "Proxy smoke chat from API", suggestions: ["Smoke suggestion from API"] }];

const issue = {
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
  chat,
  totals,
};

const issueBoard = {
  issues: [issue],
  backlog: [],
  lanes: {
    todo: [],
    progress: [issue],
    review: [],
  },
  cycleLabel: "Proxy smoke cycle",
  cycleDateRange: "today",
  selectedIssueId: issue.id,
};

const history = {
  sessions: [session],
  transcriptBySession: {
    [session.id]: [{ kind: "assistant", ts: session.updatedAt, text: "Loaded through Vite proxy" }],
  },
  timeline: [{ t: session.updatedAt, sess: session.id, kind: "status", text: "Loaded through Vite proxy", state: "running" }],
  defaultSessionId: session.id,
};

const sidebar = {
  providerGates: [],
  runningAgents: [runningAgent],
  reviewIssues: [],
  activity,
  sessions: [session],
  chat,
  totals,
};

async function main() {
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

    await page.command("Runtime.enable");
    await page.command("Page.enable");
    await page.command("Page.navigate", { url: `${viteOrigin}/` });
    await page.waitForEvent("Page.loadEventFired", 10_000).catch(() => undefined);

    let lastBrowserState = null;
    const browserState = await waitFor(async () => {
      const state = await page.evaluate(`(() => {
        const body = document.body?.innerText ?? "";
        const statusbar = document.querySelector(".statusbar")?.textContent ?? "";
        const combinedText = [body, statusbar].join(" ");
        const errors = Array.from(document.querySelectorAll(".view-error")).map((element) => element.textContent?.trim() ?? "");
        return {
          body,
          statusbar,
          errors,
          hasApiMode: combinedText.includes("api source · api"),
          hasDashboardData: body.includes("proxy/symphony") && body.includes("vite-proxy-smoke") && body.includes("Proxy Smoke Vite agent"),
          hasProxyActivity: body.includes("smoke-api-worker") && body.includes("through Vite proxy"),
          hasProxyChat: body.includes("Proxy smoke chat from API"),
          leakedMockData: combinedText.includes("openai/symphony") || body.includes("Restart SYM-42"),
        };
      })()`);
      lastBrowserState = state;
      if (state.hasApiMode && state.hasDashboardData && state.hasProxyActivity && state.hasProxyChat) return state;
      return null;
    }, 10_000, 250, "browser to render API data through the Vite proxy", () => describeBrowserState(lastBrowserState));

    assert(!browserState.leakedMockData, "Browser rendered mock data while API mode was expected");
    assert(browserState.errors.length === 0, `Browser rendered error state: ${browserState.errors.join(" | ")}`);

    const observed = new Set(requestLog.map((entry) => `${entry.method} ${entry.path}`));
    for (const endpoint of [
      "GET /api/v1/web/reference-data",
      "GET /api/v1/web/dashboard",
      "GET /api/v1/web/issues",
      "GET /api/v1/web/history",
      "GET /api/v1/web/sidebar",
      "GET /api/v1/web/orchestrator-chat",
    ]) {
      assert(observed.has(endpoint), `Expected fake API to receive ${endpoint} through the Vite proxy`);
    }

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

    if (request.method === "GET" && url.pathname === "/api/v1/web/reference-data") return sendJson(response, 200, referenceData);
    if (request.method === "GET" && url.pathname === "/api/v1/web/dashboard") return sendJson(response, 200, dashboard);
    if (request.method === "GET" && url.pathname === "/api/v1/web/issues") return sendJson(response, 200, issueBoard);
    if (request.method === "GET" && url.pathname === "/api/v1/web/sidebar") return sendJson(response, 200, sidebar);
    if (request.method === "GET" && url.pathname === "/api/v1/web/history") return sendJson(response, 200, history);
    if (request.method === "GET" && url.pathname === "/api/v1/web/orchestrator-chat") return sendJson(response, 200, chat);
    if (request.method === "GET" && /^\/api\/v1\/web\/issues\//.test(url.pathname)) return sendJson(response, 200, { issue, activity, runs: [session], transcript: history.transcriptBySession[session.id] });
    if (request.method === "GET" && /^\/api\/v1\/web\/sessions\//.test(url.pathname)) return sendJson(response, 200, history.transcriptBySession[session.id]);
    if (request.method === "POST" && url.pathname === "/api/v1/web/orchestrator-chat") {
      await readRequestBody(request);
      return sendJson(response, 200, [...chat, { who: "user", text: "browser smoke input" }]);
    }

    return sendJson(response, 404, { error: { code: "not_found", path: url.pathname } });
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

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  for await (const _chunk of request) {
    // Drain the request so Node can reuse the socket.
  }
}

function resolveViteOrigin(server) {
  const localUrl = server.resolvedUrls?.local?.find((url) => url.startsWith("http://127.0.0.1:"));
  if (localUrl) return localUrl.replace(/\/$/, "");
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite dev server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
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
    "No Chromium-compatible browser executable found. Set SYMPHONY_WEB_BROWSER_EXECUTABLE or CHROME_BIN to run the browser Vite proxy smoke.",
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
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
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
  if (process.platform === "linux") args.splice(1, 0, "--no-sandbox");

  const browserProcess = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  const devtoolsUrl = await waitForDevtoolsUrl(browserProcess, stderrLines);
  const debugOrigin = devtoolsUrl.replace(/^ws:\/\//, "http://").replace(/\/devtools\/browser\/.+$/, "");
  const target = await createBrowserTarget(debugOrigin, url);
  const page = await connectCdp(target.webSocketDebuggerUrl);
  page.stderrLines = stderrLines;
  return { process: browserProcess, page };
}

async function waitForDevtoolsUrl(browserProcess, stderrLines) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for browser DevTools endpoint. Browser stderr:\n${stderrLines.join("")}`));
    }, 10_000);

    const onData = (data) => {
      const text = String(data);
      stderrLines.push(text);
      buffer += text;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Browser exited before DevTools was ready (code ${code}, signal ${signal}). Browser stderr:\n${stderrLines.join("")}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      browserProcess.stderr?.off("data", onData);
      browserProcess.off("exit", onExit);
    };

    browserProcess.stderr?.on("data", onData);
    browserProcess.once("exit", onExit);
  });
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

function describeBrowserState(state) {
  if (!state) return "no browser state captured";
  const flags = ["hasApiMode", "hasDashboardData", "hasProxyActivity", "hasProxyChat", "leakedMockData"]
    .map((key) => `${key}=${Boolean(state[key])}`)
    .join(", ");
  const errors = state.errors?.length ? ` errors=${state.errors.join(" | ")}` : "";
  const statusbar = typeof state.statusbar === "string" ? state.statusbar.replace(/\s+/g, " ").slice(0, 240) : "";
  const body = typeof state.body === "string" ? state.body.replace(/\s+/g, " ").slice(0, 600) : "";
  return `${flags}${errors} statusbar=${JSON.stringify(statusbar)} body=${JSON.stringify(body)}`;
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
