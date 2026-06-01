import type { ReactNode } from "react";
import { Icon } from "../components/common";
import type { AppTab } from "../types/symphony";
import { appTabs } from "./navigation";

const tabIcon: Record<AppTab, () => ReactNode> = {
  dashboard: Icon.dashboard,
  issues: Icon.layout,
  history: Icon.history,
  sidebar: Icon.message,
  states: Icon.agent,
};

export function AppChrome({
  activeTab,
  onTabChange,
  children,
  rightSlot,
  runningCount = 0,
  repoLabel = "repository unavailable",
  branch = "",
  pollLabel = "poll unavailable",
  agentUsageLabel,
  dataSourceLabel = "source unavailable",
}: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  children: ReactNode;
  rightSlot?: ReactNode;
  runningCount?: number;
  repoLabel?: string;
  branch?: string;
  pollLabel?: string;
  agentUsageLabel?: string;
  dataSourceLabel?: string;
}) {
  const repoBranchLabel = branch ? `${repoLabel}@${branch}` : repoLabel;
  const runningLabel = agentUsageLabel ?? `${runningCount} agents running`;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar__brand">
          <span className="dot" />
          Symphony
          <span className="meta">{branch || "--"}</span>
        </div>
        <div className="tabs" role="tablist" aria-label="Symphony views">
          {appTabs.map((tab) => (
            <button
              className="tab"
              data-active={activeTab === tab.id}
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              role="tab"
              aria-label={tab.label}
              aria-selected={activeTab === tab.id}
              title={tab.label}
              type="button"
            >
              {tabIcon[tab.id]()}
              <span>{tab.label}</span>
              {tab.badge ? <span className="badge">{tab.badge}</span> : null}
            </button>
          ))}
        </div>
        <div className="titlebar__right">
          {rightSlot}
          <button className="icon-btn" type="button" title="Search">
            {Icon.search()}
          </button>
          <button className="icon-btn" type="button" title="More">
            {Icon.more()}
          </button>
        </div>
      </div>
      {children}
      <div className="statusbar">
        <span className="statusbar__seg">
          <span className="pulse" />
          {runningLabel}
        </span>
        <span className="statusbar__sep">·</span>
        <span className="statusbar__seg mono">{repoBranchLabel}</span>
        <span className="statusbar__sep">·</span>
        <span className="statusbar__seg mono">{pollLabel}</span>
        <div className="statusbar__right">
          <span className="statusbar__seg mono">{dataSourceLabel}</span>
        </div>
      </div>
    </div>
  );
}
