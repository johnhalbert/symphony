import { afterEach, describe, expect, it } from "vitest";
import { createApiDataSource } from "../src/data/apiDataSource";
import { installApiFetchFixture, type ApiFetchFixture } from "./support/apiFetchFixture";

let activeFixture: ApiFetchFixture | null = null;

afterEach(() => {
  activeFixture?.restore();
  activeFixture = null;
});

function installFixture(routes: Parameters<typeof installApiFetchFixture>[0]): ApiFetchFixture {
  activeFixture = installApiFetchFixture(routes);
  return activeFixture;
}

describe("shared API fetch fixture", () => {
  it("drives API data-source tests with deterministic JSON routes", async () => {
    const fixture = installFixture([
      { path: "/api/v1/web/dashboard", body: { projectName: "Fixture Project", runningAgents: [] } },
      { path: "/api/v1/web/issues/ENG%2F84F", body: { issue: { id: "ENG/84F", title: "Encoded issue" } } },
    ]);

    await expect(createApiDataSource("").getDashboard()).resolves.toMatchObject({ projectName: "Fixture Project" });
    await expect(createApiDataSource("https://symphony.example///").getIssueDetail("ENG/84F")).resolves.toMatchObject({
      issue: { id: "ENG/84F" },
    });

    expect(fixture.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/v1/web/dashboard",
      "GET /api/v1/web/issues/ENG%2F84F",
    ]);
  });

  it("fails closed on unregistered API calls instead of reaching real services", async () => {
    const fixture = installFixture([{ path: "/api/v1/web/dashboard", body: { projectName: "Fixture Project" } }]);

    await expect(createApiDataSource("").getIssueBoard()).rejects.toThrow("Unhandled test API fetch GET /api/v1/web/issues");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/web/issues" });
  });

  it("surfaces configured HTTP failures through the API data source", async () => {
    installFixture([{ path: "/api/v1/web/sidebar", status: 503, body: { error: { message: "backend unavailable" } } }]);

    await expect(createApiDataSource("").getSidebar()).rejects.toThrow("Symphony API returned HTTP 503");
  });

  it("captures POST JSON bodies for command-style API tests", async () => {
    const fixture = installFixture([
      {
        method: "POST",
        path: "/api/v1/web/orchestrator-chat",
        handler(request) {
          return new Response(JSON.stringify({
            schemaVersion: 1,
            conversation: {
              id: "orchestrator-default",
              status: "pending",
              createdAt: "2026-06-05T00:00:00.000Z",
              updatedAt: "2026-06-05T00:00:00.000Z",
              messageCount: 1,
              metadata: {},
            },
            state: "pending",
            status: {
              state: "pending",
              conversationStatus: "pending",
              latestMessageStatus: "pending",
              active: true,
              terminal: false,
              empty: false,
              messageCount: 1,
              statusCounts: {
                pending: 1,
                streaming: 0,
                completed: 0,
                failed: 0,
                disabled: 0,
                unavailable: 0,
              },
            },
            chat: [{ who: "user", text: (request.body as { input: string }).input, status: "pending" }],
            source: {
              source: "orchestrator_conversations",
              revision: "fixture-chat-1",
              observedAt: "2026-06-05T00:00:00.000Z",
              conversationId: "orchestrator-default",
              latestMessageSequence: 1,
              latestMessageUpdatedAt: "2026-06-05T00:00:00.000Z",
            },
          }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    ]);

    await expect(createApiDataSource("").sendOrchestratorMessage("pause ENG-84F")).resolves.toMatchObject({
      state: "pending",
      conversation: { status: "pending", messageCount: 1 },
      chat: [{ who: "user", text: "pause ENG-84F", status: "pending" }],
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/web/orchestrator-chat",
      body: { input: "pause ENG-84F" },
    });
  });
});
