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
          return new Response(JSON.stringify([{ who: "user", text: (request.body as { input: string }).input }]), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    ]);

    await expect(createApiDataSource("").sendOrchestratorMessage("pause ENG-84F")).resolves.toEqual([
      { who: "user", text: "pause ENG-84F" },
    ]);
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/web/orchestrator-chat",
      body: { input: "pause ENG-84F" },
    });
  });
});
