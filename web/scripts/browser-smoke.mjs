#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const fixtureData = {
  referenceData: {
    users: {
      "fixture-worker": { name: "Fixture Worker", color: "#5da8ff" },
      "fixture-operator": { name: "Fixture Operator", color: "#8ec07c" },
    },
    labels: {
      "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
      frontend: { name: "frontend", color: "#d3869b" },
    },
  },
  issue: {
    id: "ENG-84F",
    title: "Fixture issue loaded through Vite proxy",
    status: "progress",
    priority: 2,
    labels: ["dogfood-ready", "frontend"],
    assignee: "fixture-worker",
    agent: "hermes-fixture",
    project: "Symphony",
    cycle: "Dogfood",
    desc: ["Deterministic browser-smoke fixture; no Linear, GitHub, SDK, or workspace calls."],
    activity: [{ t: "now", verb: "loaded", val: "vite proxy", who: "browser-smoke" }],
    pr: null,
    ci: "pending",
    workspace: "ENG-84F",
    session: "run-fixture",
  },
  totals: { backlog: 0, todo: 1, progress: 1, review: 0, done: 0, cancelled: 0, open: 2, all: 2, completeness: 25 },
  transcript: [{ kind: "assistant", ts: "2026-05-29T00:01:00.000Z", text: "Fixture transcript." }],
};

function dashboard() {
  return {
    projectName: "Symphony",
    repoLabel: "johnhalbert/symphony",
    branch: "fixture/web-integration",
    workflowLabel: "WORKFLOW.fixture@fixture/web-integration",
    pollLabel: "poll 30s",
    agentUsageLabel: "1/5 agents",
    concurrencyCap: 5,
    providerGates: [],
    runningAgents: [
      {
        id: "agent-fixture",
        issue: fixtureData.issue.id,
        title: fixtureData.issue.title,
        state: "running",
        step: "serving API fixture",
        duration: "1m",
        tokens: "0",
      },
    ],
    activity: [{ t: "now", who: "symphony", verb: "started", id: fixtureData.issue.id, extra: "browser fixture" }],
    chat: [{ who: "agent", text: "Fixture chat from local backend." }],
    totals: fixtureData.totals,
  };
}

function history() {
  return {
    sessions: [
      {
        id: "run-fixture",
        issue: fixtureData.issue.id,
        title: "Fixture run",
        state: "running",
        model: "gpt-5.5",
        startedAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:01:00.000Z",
        msgCount: 1,
        lastEvent: "fixture started",
        toolCount: 0,
      },
    ],
    transcriptBySession: { "run-fixture": fixtureData.transcript },
    timeline: [{ t: "2026-05-29T00:01:00.000Z", sess: "run-fixture", kind: "assistant", text: "Fixture transcript." }],
    defaultSessionId: "run-fixture",
  };
}

function issueBoard() {
  return {
    issues: [fixtureData.issue],
    backlog: [],
    lanes: { todo: [], progress: [fixtureData.issue], review: [] },
    cycleLabel: "Dogfood",
    cycleDateRange: "Fixture cycle",
    selectedIssueId: fixtureData.issue.id,
  };
}

export async function startFixtureBackend() {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const method = request.method ?? "GET";

    let status = 200;
    let body;
    if (method === "GET" && url.pathname === "/api/v1/web/reference-data") body = fixtureData.referenceData;
    else if (method === "GET" && url.pathname === "/api/v1/web/dashboard") body = dashboard();
    else if (method === "GET" && url.pathname === "/api/v1/web/sidebar") {
      const d = dashboard();
      body = { providerGates: [], runningAgents: d.runningAgents, reviewIssues: [], activity: d.activity, sessions: history().sessions, chat: d.chat, totals: fixtureData.totals };
    } else if (method === "GET" && url.pathname === "/api/v1/web/issues") body = issueBoard();
    else if (method === "GET" && url.pathname === `/api/v1/web/issues/${encodeURIComponent(fixtureData.issue.id)}`) {
      body = { issue: fixtureData.issue, activity: dashboard().activity, runs: history().sessions, transcript: fixtureData.transcript };
    } else if (method === "GET" && url.pathname === "/api/v1/web/history") body = history();
    else if (method === "GET" && url.pathname === "/api/v1/web/sessions/run-fixture/transcript") body = fixtureData.transcript;
    else if (method === "GET" && url.pathname === "/api/v1/web/orchestrator-chat") body = dashboard().chat;
    else if (method === "POST" && url.pathname === "/api/v1/web/orchestrator-chat") {
      const input = await readJsonBody(request).then((payload) => payload.input ?? "");
      body = [...dashboard().chat, { who: "user", text: String(input) }];
    } else {
      status = 404;
      body = { error: { code: "not_found", message: `${method} ${url.pathname}` } };
    }

    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture backend did not bind to a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}

export async function startViteProxy(backendBaseUrl) {
  const vite = await createViteServer({
    root: webRoot,
    configFile: resolve(webRoot, "vite.config.ts"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": {
          target: backendBaseUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite dev server did not bind to a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => vite.close(),
  };
}

export async function runBrowserSmokeHarness() {
  const backend = await startFixtureBackend();
  const vite = await startViteProxy(backend.baseUrl);
  try {
    const root = await fetch(`${vite.baseUrl}/`);
    if (!root.ok) throw new Error(`Vite root returned HTTP ${root.status}`);

    const proxiedReference = await fetch(`${vite.baseUrl}/api/v1/web/reference-data`);
    if (!proxiedReference.ok) throw new Error(`Vite /api proxy returned HTTP ${proxiedReference.status}`);
    const reference = await proxiedReference.json();
    if (reference.users?.["fixture-worker"]?.name !== "Fixture Worker") {
      throw new Error("Vite /api proxy returned unexpected fixture reference data");
    }

    return {
      status: "ok",
      backendBaseUrl: backend.baseUrl,
      viteBaseUrl: vite.baseUrl,
      checked: ["GET /", "GET /api/v1/web/reference-data"],
    };
  } finally {
    await Promise.allSettled([vite.close(), backend.close()]);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserSmokeHarness()
    .then((result) => {
      console.log(`browser-smoke-harness ok: backend=${result.backendBaseUrl} vite=${result.viteBaseUrl} checked=${result.checked.join(",")}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : error);
      process.exitCode = 1;
    });
}
