import { describe, expect, it } from "vitest";
import { DashboardView } from "../src/components/dashboard/DashboardView";
import { DetailColumn } from "../src/components/issues/DetailColumn";
import {
  createApiModeDataSource,
  makeHarnessIssue,
  renderWithSymphonyProviders,
} from "./support/componentHarness";

describe("shared component provider harness", () => {
  it("renders components with injected reference data and no live backend", () => {
    const issue = makeHarnessIssue({ assignee: "api-user", labels: ["dogfood-ready"] });

    const html = renderWithSymphonyProviders(<DetailColumn issue={issue} onClose={() => {}} />, {
      referenceData: {
        users: { "api-user": { name: "API Fixture User", color: "#abcdef" } },
        labels: { "dogfood-ready": { name: "Ready for dogfood", color: "#7fc28b" } },
      },
    });

    expect(html).toContain("API Fixture User");
    expect(html).toContain("Ready for dogfood");
    expect(html).toContain("Fixture issue loaded through API mode");
  });

  it("provides a complete API-mode data source for async component setup", async () => {
    const dataSource = createApiModeDataSource({
      dashboard: { branch: "fixture/api-branch", agentUsageLabel: "2/5 agents" },
      orchestratorChat: [{ who: "agent", text: "Dedicated fixture chat" }],
    });

    const [dashboard, chat, detail] = await Promise.all([
      dataSource.getDashboard(),
      dataSource.getOrchestratorChat(),
      dataSource.getIssueDetail("ENG-84F"),
    ]);

    const html = renderWithSymphonyProviders(
      <DashboardView dashboard={dashboard} orchestratorChat={chat} orchestratorChatLoading={false} orchestratorChatError={null} />,
      { dataSource },
    );

    expect(detail?.issue.id).toBe("ENG-84F");
    expect(html).toContain("Symphony · fixture/api-branch");
    expect(html).toContain("2/5 agents");
    expect(html).toContain("Dedicated fixture chat");
  });
});
