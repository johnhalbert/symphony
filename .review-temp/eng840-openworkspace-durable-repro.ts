import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StatusServer } from "../src/app/http.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { multiProjectWorkflowConfig } from "../tests/helpers.js";

const root = await mkdtemp(path.join(os.tmpdir(), "eng840-open-workspace-durable-"));
try {
  const config = parseServiceConfig(
    multiProjectWorkflowConfig({
      topLevel: {
        workspace: {
          root: path.join(root, "workspaces"),
          state_dir: path.join(root, ".symphony"),
        },
      },
    }),
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret" },
  );
  const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
  const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
  const workspaceManager = new WorkspaceManager({
    workspace: config.workspace,
    hooks: config.hooks,
    logger: new StructuredLogger(() => undefined),
  });

  const defaultPath = workspaceManager.getPathForIssue("ENG-179");
  const docsPath = workspaceManager.getPathForIssue("docs:ENG-179");
  await mkdir(defaultPath, { recursive: true });
  await runStore.upsertWorkspace({
    workspaceKey: "ENG-179",
    issueId: "issue-default-workspace-1",
    issueIdentifier: "ENG-179",
    path: defaultPath,
    sourceKind: "git_worktree",
    gitBranchName: "symphony/ENG-179",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const openedPaths: string[] = [];
  const orchestrator = {
    snapshot() {
      return {
        generatedAt: new Date().toISOString(),
        counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
        providerGates: [],
        providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: [],
      };
    },
    getIssueDetails() {
      return null;
    },
  } as any;

  const server = new StatusServer({
    orchestrator,
    workspaceManager,
    workspaceOpener: {
      async open(workspacePath: string) {
        openedPaths.push(workspacePath);
      },
    },
    defaultProjectContextId: config.projectContexts.defaultContextId,
    runStore,
    lifecycleStore,
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: "secret",
    trackerStateLists: {
      active: ["Todo", "In Progress"],
      review: ["In Review"],
      done: ["Done"],
    },
    staleThresholdMs: 300_000,
  });

  const address = await server.start();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/api/v1/issues/docs:ENG-179/open-workspace`, {
      method: "POST",
      headers: { "x-symphony-token": "secret" },
    });
    const body = await response.json();
    console.log(JSON.stringify({ responseStatus: response.status, body, defaultPath, docsPath, openedPaths }, null, 2));
  } finally {
    await server.stop();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
