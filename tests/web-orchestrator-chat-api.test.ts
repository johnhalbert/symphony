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

  it("serves GET HTTP 200 with the exact empty chat array and no mock response text", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address));
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual([]);
      expect(Array.isArray(JSON.parse(text))).toBe(true);
      expect(text.trim()).toBe("[]");
      expect(text).not.toMatch(/assistant|suggestion|mock|command|transcript/i);
    } finally {
      await server.stop();
    }
  });

  it("accepts a valid POST body as a no-side-effect placeholder returning the exact empty chat array", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "please inspect ENG-94" }),
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual([]);
      expect(Array.isArray(JSON.parse(text))).toBe(true);
      expect(text.trim()).toBe("[]");
      expect(text).not.toContain("please inspect ENG-94");
      expect(text).not.toMatch(/assistant|suggestion|mock|command|transcript/i);
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("requires the mutation token for POST when configured while leaving GET read-only access open", async () => {
    const { server, calls } = createStatusServer(root, { openWorkspaceToken: "secret" });
    const address = await server.start();
    const url = chatUrl(address);
    try {
      const getResponse = await fetch(url);
      const missingToken = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ input: "please inspect ENG-94" }),
      });
      const wrongToken = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "x-symphony-token": "wrong" },
        body: JSON.stringify({ input: "please inspect ENG-94" }),
      });
      const invalidBodyWithToken = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "x-symphony-token": "secret" },
        body: "{not-json",
      });
      const validToken = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ input: "please inspect ENG-94" }),
      });

      const missingBody = (await missingToken.json()) as { error?: { code?: string; message?: string } };
      const wrongBody = (await wrongToken.json()) as { error?: { code?: string; message?: string } };
      const invalidBody = (await invalidBodyWithToken.json()) as { error?: { code?: string; message?: string } };

      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual([]);
      expect(missingToken.status).toBe(401);
      expect(missingBody.error).toMatchObject({
        code: "invalid_request",
        message: "Missing or invalid open-workspace token",
      });
      expect(wrongToken.status).toBe(401);
      expect(wrongBody.error).toMatchObject({
        code: "invalid_request",
        message: "Missing or invalid open-workspace token",
      });
      expect(invalidBodyWithToken.status).toBe(400);
      expect(invalidBody.error).toMatchObject({
        code: "invalid_request",
        message: "Web orchestrator chat request body must be valid JSON",
      });
      expect(validToken.status).toBe(200);
      expect(await validToken.json()).toEqual([]);
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("rejects invalid POST bodies with deterministic 400 error payloads and no orchestration side effects", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = chatUrl(address);
    const invalidRequests: Array<{ name: string; body?: string }> = [
      { name: "missing body" },
      { name: "missing input", body: JSON.stringify({}) },
      { name: "non-string input", body: JSON.stringify({ input: 123 }) },
      { name: "empty input", body: JSON.stringify({ input: "" }) },
      { name: "blank input", body: JSON.stringify({ input: "   " }) },
      { name: "array body", body: JSON.stringify([{ input: "hello" }]) },
      { name: "null body", body: "null" },
      { name: "malformed json", body: "{not-json" },
    ];

    try {
      for (const invalidRequest of invalidRequests) {
        const response = await fetch(
          url,
          invalidRequest.body === undefined
            ? { method: "POST" }
            : {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: invalidRequest.body,
              },
        );
        const body = (await response.json()) as { error?: { code?: string; message?: string } };

        expect({ name: invalidRequest.name, status: response.status }).toEqual({ name: invalidRequest.name, status: 400 });
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(body.error?.code).toBe("invalid_request");
        expect(body.error?.message).toMatch(/^Web orchestrator chat request body must /);
      }
      expect(calls).toEqual(zeroCallCounts());
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

function zeroCallCounts(): OrchestratorCallCounts {
  return {
    snapshot: 0,
    getIssueDetails: 0,
    refreshNow: 0,
    pauseIssue: 0,
    resumeIssue: 0,
    cancelIssue: 0,
  };
}

function chatUrl(address: { host: string; port: number }): string {
  return "http://" + address.host + ":" + String(address.port) + "/api/v1/web/orchestrator-chat";
}

function createStatusServer(
  root: string,
  options: { openWorkspaceToken?: string | null } = {},
): { server: StatusServer; calls: OrchestratorCallCounts } {
  const config = testConfig(path.join(root, "workspaces"));
  const { orchestrator, calls } = instrumentedOrchestrator();
  const server = new StatusServer({
    orchestrator,
    workspaceManager: new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    }),
    workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: options.openWorkspaceToken ?? null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
  return { server, calls };
}

function instrumentedOrchestrator(): { orchestrator: Orchestrator; calls: OrchestratorCallCounts } {
  const calls = zeroCallCounts();
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
        };
      },
      getIssueDetails() {
        calls.getIssueDetails += 1;
        return null;
      },
      async refreshNow() {
        calls.refreshNow += 1;
        return undefined;
      },
      pauseIssue() {
        calls.pauseIssue += 1;
        return undefined;
      },
      resumeIssue() {
        calls.resumeIssue += 1;
        return undefined;
      },
      async cancelIssue() {
        calls.cancelIssue += 1;
        return undefined;
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
