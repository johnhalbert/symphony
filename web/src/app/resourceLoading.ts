import type { AppTab } from "../types/symphony";

export interface AppResourceLoading {
  referenceData: boolean;
  dashboard: boolean;
  issueBoard: boolean;
  history: boolean;
  sidebar: boolean;
  orchestratorChat: boolean;
}

export function resolveAppResourceLoading(activeTab: AppTab, apiMode: boolean): AppResourceLoading {
  if (!apiMode) {
    return {
      referenceData: true,
      dashboard: true,
      issueBoard: true,
      history: true,
      sidebar: true,
      orchestratorChat: true,
    };
  }

  return {
    referenceData: true,
    dashboard: activeTab === "dashboard" || activeTab === "states",
    issueBoard: activeTab === "issues",
    history: activeTab === "history" || activeTab === "states",
    sidebar: activeTab === "sidebar",
    orchestratorChat: activeTab === "dashboard" || activeTab === "sidebar",
  };
}
