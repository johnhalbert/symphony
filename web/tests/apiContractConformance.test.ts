import { afterEach, describe, expect, it } from "vitest";
import { createApiDataSource } from "../src/data/apiDataSource";
import {
  WEB_CONTRACT_ISSUE_ID,
  WEB_CONTRACT_SESSION_ID,
  webRouteContractFixturesWithIssueDetail,
  webRouteContractGetFixtureCases,
  webRouteContractPaths,
} from "./fixtures/webRouteContractFixtures";
import { createApiFetchFixture, type ApiFetchFixture } from "./support/apiFetchFixture";

let apiFixture: ApiFetchFixture | null = null;

afterEach(() => {
  apiFixture?.restore();
  apiFixture = null;
});

describe("API data source contract fixture conformance", () => {
  it("consumes every shared /api/v1/web contract fixture unchanged", async () => {
    apiFixture = createApiFetchFixture([
      ...webRouteContractGetFixtureCases.map((testCase) => ({ path: testCase.path, body: testCase.fixture })),
      { method: "POST", path: webRouteContractPaths.orchestratorChat, body: webRouteContractFixturesWithIssueDetail.orchestratorChat },
    ]);
    const dataSource = createApiDataSource("");

    await expect(dataSource.getReferenceData()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.referenceData);
    await expect(dataSource.getDashboard()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.dashboard);
    await expect(dataSource.getIssueBoard()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.issueBoard);
    await expect(dataSource.getIssueDetail(WEB_CONTRACT_ISSUE_ID)).resolves.toEqual(
      webRouteContractFixturesWithIssueDetail.issueDetail,
    );
    await expect(dataSource.getHistory()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.history);
    await expect(dataSource.getSessions()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.history.sessions);
    await expect(dataSource.getTranscript(WEB_CONTRACT_SESSION_ID)).resolves.toEqual(webRouteContractFixturesWithIssueDetail.transcript);
    await expect(dataSource.getSidebar()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.sidebar);
    await expect(dataSource.getOrchestratorChat()).resolves.toEqual(webRouteContractFixturesWithIssueDetail.orchestratorChat);
    await expect(dataSource.sendOrchestratorMessage("show contract fixture status")).resolves.toEqual(webRouteContractFixturesWithIssueDetail.orchestratorChat);

    expect(apiFixture.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", webRouteContractPaths.referenceData],
      ["GET", webRouteContractPaths.dashboard],
      ["GET", webRouteContractPaths.issueBoard],
      ["GET", webRouteContractPaths.issueDetail],
      ["GET", webRouteContractPaths.history],
      ["GET", webRouteContractPaths.transcript],
      ["GET", webRouteContractPaths.sidebar],
      ["GET", webRouteContractPaths.orchestratorChat],
      ["POST", webRouteContractPaths.orchestratorChat],
    ]);
    expect(apiFixture.requests.at(-1)?.body).toEqual({ input: "show contract fixture status" });
  });

  it("keeps selected issue and transcript identifiers encoded through the route contract", async () => {
    apiFixture = createApiFetchFixture([
      { path: "/api/v1/web/issues/ENG%2F195", body: webRouteContractFixturesWithIssueDetail.issueDetail },
      { path: "/api/v1/web/sessions/run%2F195%20with%20space/transcript", body: webRouteContractFixturesWithIssueDetail.transcript },
    ]);
    const dataSource = createApiDataSource("");

    await expect(dataSource.getIssueDetail("ENG/195")).resolves.toEqual(webRouteContractFixturesWithIssueDetail.issueDetail);
    await expect(dataSource.getTranscript("run/195 with space")).resolves.toEqual(webRouteContractFixturesWithIssueDetail.transcript);

    expect(apiFixture.requests.map((request) => request.path)).toEqual([
      "/api/v1/web/issues/ENG%2F195",
      "/api/v1/web/sessions/run%2F195%20with%20space/transcript",
    ]);
  });
});
