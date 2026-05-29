import { mkdtemp, rm } from "node:fs/promises";
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

describe("web orchestrator chat API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-chat-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves HTTP 200 with the exact empty chat array and no mock response text", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const server = new StatusServer({
      orchestrator: emptyOrchestrator(),
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
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/web/orchestrator-chat`);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual([]);
      expect(text.trim()).toBe("[]");
      expect(text).not.toMatch(/assistant|suggestion|mock|command|transcript/i);

      const postResponse = await fetch(`http://${address.host}:${address.port}/api/v1/web/orchestrator-chat`, {
        method: "POST",
      });
      const postBody = (await postResponse.json()) as { error: { code: string } };
      expect(postResponse.status).toBe(404);
      expect(postBody.error.code).toBe("not_found");
    } finally {
      await server.stop();
    }
  });
});

function emptyOrchestrator(): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:00:00.000Z",
        counts: { running: 0, retrying: 0, paused: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    getIssueDetails() {
      return null;
    },
    async refreshNow() {
      return undefined;
    },
    pauseIssue() {
      return undefined;
    },
    resumeIssue() {
      return undefined;
    },
    async cancelIssue() {
      return undefined;
    },
  } as unknown as Orchestrator;
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
