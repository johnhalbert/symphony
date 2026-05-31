import { useEffect, useState } from "react";
import { useDataSource } from "../../data/dataSourceContext";
import type { ChatMessage, DashboardModel, DashboardVariant } from "../../types/symphony";
import { Icon } from "../common";
import { AgentRow } from "./AgentRow";
import { BurndownCommandCenter, BurndownPanel, Sparkline, StatsGridDense, StatsRow } from "./Stats";
import { OrchestratorChat } from "./OrchestratorChat";

function textOr(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function metricSeries(series: number[] | null | undefined) {
  return (series ?? []).filter((value) => Number.isFinite(value)).map((value) => Math.max(value, 0));
}

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
  const cycleLabel = textOr(dashboard.metrics?.cycle?.label, "Cycle unavailable");
  const velocity = dashboard.metrics?.velocity;
  const velocityWindow = textOr(velocity?.windowLabel, "metric unavailable");
  const velocityDelta = textOr(velocity?.deltaLabel, "—");
  const velocitySparkline = metricSeries(velocity?.sparkline);

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
          </div>
          <div className="dash__actions">
            <button className="btn" type="button">
              {Icon.filter()}{cycleLabel}
            </button>
            <button className="btn" type="button">
              {Icon.bolt()}Trigger poll
            </button>
            <button className="btn btn--primary" type="button">
              New issue
            </button>
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

        {variant === "grid" ? <StatsGridDense totals={totals} metrics={dashboard.metrics} /> : <StatsRow dashboard={dashboard} />}

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
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--accent)",
                    animation: "pulse 1.6s ease-in-out infinite",
                  }}
                />
                live
              </span>
            </div>
            <div className="panel__body">
              {dashboard.activity.slice(0, variant === "grid" ? 10 : 8).map((activityItem, index) => (
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
              ))}
            </div>
          </div>

          {variant === "grid" ? (
            <div className="panel">
              <div className="panel__head">
                <span>Velocity · {velocityWindow}</span>
                <span className="count">{velocityDelta}</span>
              </div>
              <div style={{ padding: "14px 14px 18px" }}>
                {velocitySparkline.length >= 2 ? <Sparkline points={velocitySparkline} /> : <div className="view-empty">Velocity metric unavailable.</div>}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <OrchestratorChat
        messages={chat}
        onSend={sendChat}
        subtitle={chatSubtitle(dashboard)}
        loading={orchestratorChatLoading}
        error={orchestratorChatError}
        readOnly={orchestratorChatReadOnly}
      />
    </div>
  );
}

function chatSubtitle(dashboard: DashboardModel) {
  return [dashboard.agentUsageLabel, dashboard.workflowLabel, dashboard.pollLabel].filter(Boolean).join(" · ");
}

function dotColorForVerb(verb: string) {
  if (verb.includes("completed") || verb.includes("finished") || verb.includes("merged") || verb.includes("reached")) return "var(--st-done)";
  if (verb.includes("retry") || verb.includes("error")) return "var(--pri-urgent)";
  if (verb.includes("dispatched") || verb.includes("started") || verb.includes("opened")) return "var(--accent)";
  return "var(--text-3)";
}
