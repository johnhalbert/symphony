import type { DashboardModel } from "../../types/symphony";

export interface DashboardFreshnessCue {
  liveIndicatorsEnabled: boolean;
  runningCount: number;
  agentUsageLabel: string;
}

export interface DashboardFreshnessState {
  loading?: boolean;
  error?: string | null;
}

function fallbackDashboardAgentUsageLabel(dashboard: DashboardModel): string {
  const label = dashboard.agentUsageLabel?.trim();
  if (label) return label;
  const count = dashboard.runningAgents.length;
  const agentNoun = count === 1 ? "agent" : "agents";
  return `${count} running ${agentNoun}`;
}

export function resolveDashboardFreshnessCue(
  dashboard: DashboardModel,
  state: DashboardFreshnessState = {},
): DashboardFreshnessCue {
  const usageLabel = fallbackDashboardAgentUsageLabel(dashboard);
  const sourceStatus = dashboard.source?.status;
  const hasRefreshError = state.error !== null && state.error !== undefined;
  const isFreshCurrentData = sourceStatus === "fresh" && !state.loading && !hasRefreshError;

  if (isFreshCurrentData) {
    return {
      liveIndicatorsEnabled: true,
      runningCount: dashboard.runningAgents.length,
      agentUsageLabel: usageLabel,
    };
  }

  let agentUsageLabel: string;
  if (hasRefreshError) {
    agentUsageLabel = `previous dashboard projection · ${usageLabel}`;
  } else if (state.loading) {
    agentUsageLabel = `refreshing dashboard projection · ${usageLabel}`;
  } else if (!sourceStatus) {
    agentUsageLabel = `dashboard projection freshness unknown · ${usageLabel}`;
  } else {
    agentUsageLabel = `${sourceStatus} dashboard projection · ${usageLabel}`;
  }

  return {
    liveIndicatorsEnabled: false,
    runningCount: 0,
    agentUsageLabel,
  };
}
