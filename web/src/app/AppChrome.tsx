import type { ReactNode } from "react";
import { Icon, UnavailableButton } from "../components/common";
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
  tabBadges,
  runningCount = 0,
  repoLabel = "repository unavailable",
  branch = "",
  pollLabel = "poll unavailable",
  agentUsageLabel,
  dataSourceLabel = "source unavailable",
  connectionStatusLabel = "connection unavailable",
  errorStatusLabel = "errors unavailable",
}: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  children: ReactNode;
  rightSlot?: ReactNode;
  tabBadges?: Partial<Record<AppTab, string | null | undefined>>;
  runningCount?: number;
  repoLabel?: string;
  branch?: string;
  pollLabel?: string;
  agentUsageLabel?: string;
  dataSourceLabel?: string;
  connectionStatusLabel?: string;
  errorStatusLabel?: string;
}) {
  const repoBranchLabel = branch ? `${repoLabel || "repo unavailable"}@${branch}` : repoLabel || "repo unavailable";
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
          {appTabs.map((tab) => {
            const badge = tabBadges?.[tab.id]?.trim();
            return (
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
                {badge ? <span className="badge">{badge}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="titlebar__right">
          {rightSlot}
          <UnavailableButton
            className="icon-btn"
            unavailableLabel="Search"
            unavailableReason="global dashboard search is unavailable until the backend exposes a backed search route"
          >
            {Icon.search()}
          </UnavailableButton>
          <UnavailableButton
            className="icon-btn"
            unavailableLabel="More"
            unavailableReason="additional dashboard actions are unavailable until the web dashboard maps this menu to explicit backed commands"
          >
            {Icon.more()}
          </UnavailableButton>
        </div>
      </div>
      {children}
      <div className="statusbar">
        <span className="statusbar__seg">
          {runningCount > 0 ? <span className="pulse" /> : null}
          {runningLabel}
        </span>
        <span className="statusbar__sep">·</span>
        <span className="statusbar__seg mono">{repoBranchLabel}</span>
        <span className="statusbar__sep">·</span>
        <span className="statusbar__seg mono">{pollLabel}</span>
        <div className="statusbar__right" role="status" aria-live="polite">
          <span className="statusbar__seg mono">{connectionStatusLabel}</span>
          <span className="statusbar__sep">·</span>
          <span className="statusbar__seg mono">{dataSourceLabel}</span>
          <span className="statusbar__sep">·</span>
          <span className="statusbar__seg mono">{errorStatusLabel}</span>
        </div>
      </div>
    </div>
  );
}
