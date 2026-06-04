import { useEffect, useMemo, useState } from "react";
import type { TriggerPollResult } from "../../data/dataSource";
import { useDataSource } from "../../data/dataSourceContext";
import { normalizeOrchestratorChatModel, orchestratorChatModelFromMessages } from "../../data/orchestratorChat";
import type { ChatMessage, DashboardModel, DashboardVariant, OrchestratorChatModel } from "../../types/symphony";
import { Icon, UnavailableButton } from "../common";
import { AgentRow } from "./AgentRow";
import { resolveDashboardFreshnessCue, type DashboardFreshnessCue } from "./freshness";
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
  freshnessCue,
  onPollTriggered,
}: {
  dashboard: DashboardModel;
  orchestratorChat?: OrchestratorChatModel | ChatMessage[];
  orchestratorChatError?: string | null;
  orchestratorChatLoading?: boolean;
  orchestratorChatReadOnly?: boolean;
  variant?: DashboardVariant;
  useModelBurnupTotals?: boolean;
  freshnessCue?: DashboardFreshnessCue;
  onPollTriggered?: (result: TriggerPollResult) => void;
}) {
  const dataSource = useDataSource();
  const sourceChat = useMemo(() => normalizeOrchestratorChatModel(orchestratorChat ?? dashboard.chat), [orchestratorChat, dashboard.chat]);
  const [chat, setChat] = useState(sourceChat);
  const totals = dashboard.totals;
  const visibleActivity = dashboard.activity.slice(0, variant === "grid" ? 10 : 8);
  const resolvedFreshnessCue = freshnessCue ?? resolveDashboardFreshnessCue(dashboard);
  const liveIndicatorsEnabled = resolvedFreshnessCue.liveIndicatorsEnabled;
  const runningAgentsLabel = liveIndicatorsEnabled
    ? `${dashboard.runningAgents.length} active · concurrency cap ${dashboard.concurrencyCap}`
    : `${dashboard.runningAgents.length} projected · concurrency cap ${dashboard.concurrencyCap}`;
  const runningAgentsPanelTitle = liveIndicatorsEnabled ? "Active sessions" : "Projected running sessions";
  const emptyAgentsLabel = liveIndicatorsEnabled ? "No active agents." : "No running agents are present in this dashboard projection.";
  const activityNoun = dashboard.activity.length === 1 ? "event" : "events";
  const activityCountLabel = liveIndicatorsEnabled
    ? `${dashboard.activity.length} ${activityNoun}`
    : `${dashboard.activity.length} projected ${activityNoun}`;
  const [pollAction, setPollAction] = useState<PollActionState>({ status: "idle", message: null });

  useEffect(() => {
    setChat(sourceChat);
  }, [sourceChat]);

  async function sendChat(input: string) {
    if (orchestratorChatReadOnly) return;
    const nextMessages = await dataSource.sendOrchestratorMessage(input);
    setChat(orchestratorChatModelFromMessages(nextMessages, { conversationId: chat.conversation.id }));
  }

  async function triggerPoll() {
    if (!dataSource.triggerPoll || pollAction.status === "sending") return;
    setPollAction({ status: "sending", message: "Requesting an immediate poll..." });
    try {
      const result = await dataSource.triggerPoll();
      onPollTriggered?.(result);
      setPollAction({ status: "queued", message: pollTriggerResultMessage(result) });
    } catch (error: unknown) {
      setPollAction({ status: "failed", message: `Poll trigger failed: ${errorMessage(error)}` });
    }
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
              <span style={{ color: liveIndicatorsEnabled ? "var(--accent)" : "var(--text-3)" }}>
                {liveIndicatorsEnabled ? `● ${resolvedFreshnessCue.agentUsageLabel}` : resolvedFreshnessCue.agentUsageLabel}
              </span>
            </div>
            {dashboard.source ? <DashboardSourceStatus source={dashboard.source} /> : <DashboardSourceUnavailable />}
          </div>
          <div className="dash__actions">
            <UnavailableButton className="btn" unavailableLabel="Status totals" unavailableReason="status-total filtering is read-only until an API command route exists">
              {Icon.filter()}Status totals
            </UnavailableButton>
            {dataSource.triggerPoll ? (
              <button
                aria-describedby={pollAction.message ? "dashboard-poll-action-status" : undefined}
                className="btn"
                disabled={pollAction.status === "sending"}
                onClick={triggerPoll}
                type="button"
              >
                {Icon.bolt()}{pollAction.status === "sending" ? "Triggering poll..." : "Trigger poll"}
              </button>
            ) : (
              <UnavailableButton
                className="btn"
                unavailableLabel="Trigger poll"
                unavailableReason="poll triggering is unavailable because the active data source does not expose the /api/v1/refresh command"
              >
                {Icon.bolt()}Trigger poll
              </UnavailableButton>
            )}
            <UnavailableButton className="btn btn--primary" unavailableLabel="New issue" unavailableReason="issue creation is unavailable until the backend exposes a command route">
              New issue
            </UnavailableButton>
            {pollAction.message ? (
              <span className="dash__action-status" data-status={pollAction.status} id="dashboard-poll-action-status" role="status" aria-live="polite">
                {pollAction.message}
              </span>
            ) : null}
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

        {variant === "grid" ? <StatsGridDense totals={totals} /> : <StatsRow dashboard={dashboard} freshnessCue={resolvedFreshnessCue} />}

        {variant === "command-center" ? <BurndownCommandCenter dashboard={dashboard} freshnessCue={resolvedFreshnessCue} /> : <BurndownPanel totals={totals} metrics={dashboard.metrics} useModelBurnupTotals={useModelBurnupTotals} />}

        <div className="section-head">
          <h2>Running agents</h2>
          <span className="right">
            {runningAgentsLabel}
          </span>
        </div>

        <div className="panels" data-variant={variant}>
          <div className="panel">
            <div className="panel__head">
              <span>{runningAgentsPanelTitle}</span>
              <span className="count">{dashboard.runningAgents.length}</span>
            </div>
            <div className="panel__body">
              {dashboard.runningAgents.length ? (
                dashboard.runningAgents.map((agent) => <AgentRow key={agent.id} agent={agent} liveIndicatorsEnabled={liveIndicatorsEnabled} />)
              ) : (
                <div className="view-empty">{emptyAgentsLabel}</div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <span>Activity feed</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)" }}>
                {liveIndicatorsEnabled && dashboard.activity.length ? (
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
                {activityCountLabel}
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
        projection={chat}
        messages={chat.chat}
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


type PollActionState =
  | { status: "idle"; message: null }
  | { status: "sending" | "queued" | "failed"; message: string };

function pollTriggerResultMessage(result: TriggerPollResult): string {
  const operations = result.operations?.map((operation) => operation.trim()).filter(Boolean).join(", ") || "poll";
  const queueState = result.queued ? "queued" : "requested";
  const coalesced = result.coalesced ? " · coalesced with an in-flight refresh" : "";
  const requestedAt = result.requested_at ? ` · ${result.requested_at}` : "";
  return `Poll trigger ${queueState}: ${operations}${coalesced}${requestedAt}.`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function dotColorForVerb(verb: string) {
  if (verb.includes("completed") || verb.includes("finished") || verb.includes("merged") || verb.includes("reached")) return "var(--st-done)";
  if (verb.includes("retry") || verb.includes("error")) return "var(--pri-urgent)";
  if (verb.includes("dispatched") || verb.includes("started") || verb.includes("opened")) return "var(--accent)";
  return "var(--text-3)";
}
