import { useEffect, useState } from "react";
import { useDataSource } from "../../data/dataSourceContext";
import type { ChatMessage, DashboardModel, DashboardVariant } from "../../types/symphony";
import { Icon, UnavailableButton } from "../common";
import { AgentRow } from "./AgentRow";
import { BurndownCommandCenter, BurndownPanel, StatsGridDense, StatsRow } from "./Stats";
import { OrchestratorChat } from "./OrchestratorChat";

export function DashboardView({
  dashboard,
  orchestratorChat,
  orchestratorChatError = null,
  orchestratorChatLoading = false,
  orchestratorChatReadOnly = false,
  variant = "cards",
  useModelBurnupTotals = true,
}: {
  dashboard: DashboardModel;
  orchestratorChat?: ChatMessage[];
  orchestratorChatError?: string | null;
  orchestratorChatLoading?: boolean;
  orchestratorChatReadOnly?: boolean;
  variant?: DashboardVariant;
  useModelBurnupTotals?: boolean;
}) {
  const dataSource = useDataSource();
  const sourceChat = orchestratorChat ?? dashboard.chat;
  const [chat, setChat] = useState(sourceChat);
  const totals = dashboard.totals;
  const visibleActivity = dashboard.activity.slice(0, variant === "grid" ? 10 : 8);

  useEffect(() => {
    setChat(sourceChat);
  }, [sourceChat]);

  async function sendChat(input: string) {
    if (orchestratorChatReadOnly) return;
    const nextMessages = await dataSource.sendOrchestratorMessage(input);
    setChat(nextMessages);
  }

  return (
    <div className="dashboard" data-variant={variant}>
      <div className="dash__main">
        <div className="dash__header">
          <div>
            <h1 className="dash__title">Symphony · {dashboard.branch}</h1>
            <div className="dash__subtitle">
              <span>{dashboard.repoLabel}</span>
              <span className="sep">·</span>
              <span>{dashboard.workflowLabel}</span>
              <span className="sep">·</span>
              <span>{dashboard.pollLabel}</span>
              <span className="sep">·</span>
              <span style={{ color: "var(--accent)" }}>● {dashboard.agentUsageLabel}</span>
            </div>
            {dashboard.source ? <DashboardSourceStatus source={dashboard.source} /> : <DashboardSourceUnavailable />}
          </div>
          <div className="dash__actions">
            <UnavailableButton className="btn" unavailableLabel="Status totals" unavailableReason="status-total filtering is read-only until an API command route exists">
              {Icon.filter()}Status totals
            </UnavailableButton>
            <UnavailableButton className="btn" unavailableLabel="Trigger poll" unavailableReason="poll triggering is unavailable until the backend exposes a command route">
              {Icon.bolt()}Trigger poll
            </UnavailableButton>
            <UnavailableButton className="btn btn--primary" unavailableLabel="New issue" unavailableReason="issue creation is unavailable until the backend exposes a command route">
              New issue
            </UnavailableButton>
          </div>
        </div>

        {dashboard.providerGates.length ? (
          <div className="provider-limit-banner">
            {dashboard.providerGates.map((gate) => (
              <div className="provider-limit-banner__item" key={gate.id}>
                <div>
                  <strong>{gate.provider}</strong>
                  <span>{gate.kind}</span>
                </div>
                <p>{gate.message}</p>
                <small>
                  {gate.resumeAt ? `resets ${gate.resumeAt}` : "waiting for user resume"}
                  {gate.sourceIssue ? ` · ${gate.sourceIssue}` : ""}
                  {gate.sourceRunId ? ` · ${gate.sourceRunId}` : ""}
                </small>
              </div>
            ))}
          </div>
        ) : null}

        {variant === "grid" ? <StatsGridDense totals={totals} /> : <StatsRow dashboard={dashboard} />}

        {variant === "command-center" ? <BurndownCommandCenter dashboard={dashboard} /> : <BurndownPanel totals={totals} metrics={dashboard.metrics} useModelBurnupTotals={useModelBurnupTotals} />}

        <div className="section-head">
          <h2>Running agents</h2>
          <span className="right">
            {dashboard.runningAgents.length} active · concurrency cap {dashboard.concurrencyCap}
          </span>
        </div>

        <div className="panels" data-variant={variant}>
          <div className="panel">
            <div className="panel__head">
              <span>Active sessions</span>
              <span className="count">{dashboard.runningAgents.length}</span>
            </div>
            <div className="panel__body">
              {dashboard.runningAgents.length ? dashboard.runningAgents.map((agent) => <AgentRow key={agent.id} agent={agent} />) : <div className="view-empty">No active agents.</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <span>Activity feed</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>
                {dashboard.activity.length ? (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "var(--accent)",
                      animation: "pulse 1.6s ease-in-out infinite",
                    }}
                  />
                ) : null}
                {dashboard.activity.length} {dashboard.activity.length === 1 ? "event" : "events"}
              </span>
            </div>
            <div className="panel__body">
              {visibleActivity.length ? (
                visibleActivity.map((activityItem, index) => (
                  <div className="activity-row" key={`${activityItem.t}-${activityItem.id}-${index}`}>
                    <span className="dot" style={{ background: dotColorForVerb(activityItem.verb) }} />
                    <span className="text">
                      <span className="id">{activityItem.who}</span>{" "}
                      <span className="verb">{activityItem.verb}</span>{" "}
                      <span className="id">{activityItem.id}</span>{" "}
                      <span className="verb">{activityItem.extra}</span>
                    </span>
                    <span className="time">{activityItem.t}</span>
                  </div>
                ))
              ) : (
                <div className="view-empty">No activity entries are available from the current dashboard projection.</div>
              )}
            </div>
          </div>

          {variant === "grid" ? (
            <div className="panel">
              <div className="panel__head">
                <span>Throughput history</span>
                <span className="count">unavailable</span>
              </div>
              <div className="view-empty">Velocity trend unavailable; no durable throughput history is present.</div>
            </div>
          ) : null}
        </div>
      </div>

      <OrchestratorChat
        messages={chat}
        onSend={sendChat}
        agentLabel={chatAgentLabel(dashboard)}
        subtitle={chatSubtitle(dashboard)}
        loading={orchestratorChatLoading}
        error={orchestratorChatError}
        readOnly={orchestratorChatReadOnly}
      />
    </div>
  );
}

function DashboardSourceStatus({ source }: { source: NonNullable<DashboardModel["source"]> }) {
  const timestamps = [
    source.trackerFetchedAt ? `tracker fetched ${source.trackerFetchedAt}` : null,
    source.generatedAt ? `projection generated ${source.generatedAt}` : null,
  ].filter(Boolean);
  return (
    <div className="dash__source" data-status={source.status}>
      <span className="dash__source-label">{source.label}</span>
      <span className="sep">·</span>
      <span>{source.detail}</span>
      {timestamps.length > 0 ? (
        <>
          <span className="sep">·</span>
          <span>{timestamps.join(" · ")}</span>
        </>
      ) : null}
    </div>
  );
}

function DashboardSourceUnavailable() {
  return (
    <div className="dash__source" data-status="unavailable">
      <span className="dash__source-label">source unavailable</span>
      <span className="sep">·</span>
      <span>Dashboard payload did not include freshness metadata; treating projection age as unknown.</span>
    </div>
  );
}

function chatSubtitle(dashboard: DashboardModel) {
  return [dashboard.agentUsageLabel, dashboard.workflowLabel, dashboard.pollLabel].filter(Boolean).join(" · ");
}

function chatAgentLabel(dashboard: DashboardModel) {
  return dashboard.runningAgents[0]?.id ?? null;
}

function dotColorForVerb(verb: string) {
  if (verb.includes("completed") || verb.includes("finished") || verb.includes("merged") || verb.includes("reached")) return "var(--st-done)";
  if (verb.includes("retry") || verb.includes("error")) return "var(--pri-urgent)";
  if (verb.includes("dispatched") || verb.includes("started") || verb.includes("opened")) return "var(--accent)";
  return "var(--text-3)";
}
