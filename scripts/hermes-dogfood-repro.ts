#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { GatewayClient as UpstreamGatewayClient } from "../hermes/upstream-src/ui-tui/src/gatewayClient.js";
import type { GatewayEvent } from "../hermes/src/GatewayFacade.js";
import {
  type HermesGatewayClient,
  type HermesGatewayEnvironment,
  withHermesGatewayEnvironment,
} from "../hermes/src/GatewayFacade.js";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import { createRuntimeTrackerClient } from "../src/app/RuntimeDependencies.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { errorMessage } from "../src/core/errors.js";
import type { AgentEvent, AgentHarness } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore, type WorkspaceRecord } from "../src/core/persistence/RunTranscriptStore.js";
import type { Issue, Workspace } from "../src/core/types.js";
import { WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";

const DEFAULT_ISSUE = "ENG-78";
const DEFAULT_OBSERVE_MS = 8_000;
const SHUTDOWN_GRACE_MS = 15_000;

interface ConsumeContext {
  workspace: Workspace;
  prompt: string;
  attempt: number | null;
  turnNumber: number;
}

void main().catch((error) => {
  console.error(`[hermes-dogfood-repro] ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const workflowPath = path.resolve(process.cwd(), process.argv[2] ?? "WORKFLOW.md");
  const issueIdentifier = process.env.SYMPHONY_REPRO_ISSUE ?? DEFAULT_ISSUE;
  const observeMs = positiveInt(process.env.SYMPHONY_REPRO_OBSERVE_MS, DEFAULT_OBSERVE_MS);
  const afterSessionDelayMs = positiveInt(process.env.SYMPHONY_REPRO_AFTER_SESSION_STARTED_DELAY_MS, 0);
  const consumerMode = process.env.SYMPHONY_REPRO_CONSUMER === "orchestrator" ? "orchestrator" : "direct";
  const cliPath = path.resolve(process.cwd(), "src/cli.ts");
  const loader = new WorkflowLoader(workflowPath);
  const loaded = await loader.load();
  const config = loaded.serviceConfig;
  const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
  const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
  const diagnosticsDir = path.join(config.workspace.stateDir, "diagnostics", "hermes-dogfood-repro");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const diagnosticsPath = path.join(diagnosticsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const diagnostics = new DiagnosticLog(diagnosticsPath);
  const logger = new StructuredLogger((line) => void diagnostics.write(`[symphony] ${line}`));

  try {
    diagnostics.write(
      `[diag] workflow=${workflowPath} issue=${issueIdentifier} observeMs=${observeMs} consumer=${consumerMode} afterSessionDelayMs=${afterSessionDelayMs} stateDir=${config.workspace.stateDir}`,
    );
    assertHermesConfig(config);

    const tracker = createRuntimeTrackerClient(config);
    const issue = await findIssue(tracker, config, issueIdentifier);
    const workspaceRecord = await runStore.findWorkspace(issue.identifier);
    if (!workspaceRecord) throw new Error(`No workspace metadata found for ${issue.identifier}`);
    const workspace = workspaceFromRecord(workspaceRecord);

    const harness = new HermesHarness({
      cliPath,
      runStore,
      gatewayFactory: (env) => new InstrumentedGatewayClient(env, diagnostics),
    });
    const rendererHarness = rendererHarnessFor(harness);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger,
      planningWorkspaceMode: config.issueBreakdown.workspaceMode,
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness: rendererHarness,
      logger,
      promptTemplate: loaded.definition.promptTemplate,
      runStore,
      lifecycleStore,
    });
    const lifecycle = await lifecycleStore.get(issue.id);
    const entry = {
      issue,
      role: "worker",
      runPhase: "implementation",
      workspacePath: workspace.path,
      workspace,
      lifecycle,
    };
    const prompt = await (
      orchestrator as unknown as {
        renderWorkerPrompt(entry: unknown, attempt: number | null): Promise<string>;
      }
    ).renderWorkerPrompt(entry, null);
    diagnostics.write(`[diag] renderedPromptChars=${prompt.length}`);

    const abortController = new AbortController();
    const events: AgentEvent[] = [];
    const runContext = {
      issue,
      role: "worker" as const,
      runPhase: "implementation" as const,
      attempt: null,
      workspace,
      config,
      turnNumber: 1,
      abortSignal: abortController.signal,
      logger,
    };
    const collect =
      consumerMode === "orchestrator"
        ? consumeWithOrchestrator(orchestrator, entry, harness.run(runContext, prompt), { workspace, prompt, attempt: null, turnNumber: 1 }, events, diagnostics)
        : collectHarnessEvents(harness, runContext, prompt, events, diagnostics, afterSessionDelayMs);
    const outcome = await Promise.race([
      collect.then(() => "completed" as const),
      delay(observeMs).then(() => "observe_timeout" as const),
    ]);

    if (outcome === "observe_timeout") {
      diagnostics.write(`[diag] observe window elapsed; aborting run`);
      abortController.abort();
      await Promise.race([
        collect.catch((error) => diagnostics.write(`[diag] collector after abort rejected: ${errorMessage(error)}`)),
        delay(SHUTDOWN_GRACE_MS).then(() => diagnostics.write(`[diag] collector did not settle within shutdown grace`)),
      ]);
    }
    await harness.dispose();

    const terminal = events.find((event) => event.type === "failed" || event.type === "completed" || event.type === "cancelled");
    const failed = events.find((event): event is Extract<AgentEvent, { type: "failed" }> => event.type === "failed");
    const diagnosticsSummary = events
      .filter((event): event is Extract<AgentEvent, { type: "run_diagnostic" }> => event.type === "run_diagnostic")
      .map((event) => `${event.code}: ${event.message}`)
      .join("; ");
    const result = {
      issue: issue.identifier,
      workspace: workspace.path,
      promptChars: prompt.length,
      consumer: consumerMode,
      outcome,
      eventTypes: events.map((event) => event.type),
      terminal: terminal?.type ?? null,
      failedError: failed?.error ?? null,
      diagnostics: diagnosticsSummary || null,
      diagnosticsPath,
    };
    diagnostics.write(`[diag] result=${JSON.stringify(result)}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await loader.close();
  }
}

function assertHermesConfig(config: ServiceConfig): void {
  if (config.agent.harness !== "hermes") {
    throw new Error(`Expected agent.harness=hermes, got ${config.agent.harness}`);
  }
  if (!config.hermes.model) throw new Error("Expected nonempty hermes.model");
  if (config.hermes.provider !== "openai-codex") {
    throw new Error(`Expected hermes.provider=openai-codex, got ${config.hermes.provider ?? "unset"}`);
  }
}

async function findIssue(
  tracker: ReturnType<typeof createRuntimeTrackerClient>,
  config: ServiceConfig,
  issueIdentifier: string,
): Promise<Issue> {
  const states = [...new Set([...config.tracker.activeStates, ...config.reviewLoop.reviewStates, ...config.reviewLoop.blockedStates])];
  const issues = await tracker.fetchIssuesByStates(states);
  const issue = issues.find((candidate) => candidate.identifier === issueIdentifier || candidate.id === issueIdentifier);
  if (!issue) throw new Error(`Issue ${issueIdentifier} was not found in states: ${states.join(", ")}`);
  return issue;
}

function workspaceFromRecord(record: WorkspaceRecord): Workspace {
  return {
    path: record.path,
    workspaceKey: record.workspaceKey,
    createdNow: false,
    ...(record.issueId === null || record.issueId === undefined ? {} : { issueId: record.issueId }),
    ...(record.issueIdentifier === undefined ? {} : { issueIdentifier: record.issueIdentifier }),
    ...(record.sourceKind === undefined ? {} : { sourceKind: record.sourceKind }),
    ...(record.gitBranchName === undefined ? {} : { gitBranchName: record.gitBranchName }),
    ...(record.repoPath === undefined ? {} : { repoPath: record.repoPath }),
    ...(record.baseRef === undefined ? {} : { baseRef: record.baseRef }),
  };
}

function rendererHarnessFor(harness: HermesHarness): AgentHarness {
  return {
    id: harness.id,
    capabilities: harness.capabilities,
    run: harness.run.bind(harness),
    prepare: harness.prepare.bind(harness),
    reload: harness.reload.bind(harness),
    stop: harness.stop.bind(harness),
  };
}

async function collectHarnessEvents(
  harness: HermesHarness,
  ctx: Parameters<HermesHarness["run"]>[0],
  prompt: string,
  events: AgentEvent[],
  diagnostics: DiagnosticLog,
  afterSessionDelayMs: number,
): Promise<void> {
  try {
    for await (const event of harness.run(ctx, prompt)) {
      events.push(event);
      diagnostics.write(`[event] ${event.type}${"error" in event ? ` error=${event.error}` : ""}${"code" in event ? ` code=${event.code}` : ""}`);
      if (event.type === "session_started" && afterSessionDelayMs > 0) {
        diagnostics.write(`[event] delaying after session_started for ${afterSessionDelayMs}ms`);
        await delay(afterSessionDelayMs);
      }
    }
  } catch (error) {
    diagnostics.write(`[event] collector threw: ${errorMessage(error)}`);
    throw error;
  } finally {
    diagnostics.write(`[event] collector finally events=${events.map((event) => event.type).join(",")}`);
  }
}

async function consumeWithOrchestrator(
  orchestrator: Orchestrator,
  entrySeed: Record<string, unknown>,
  sourceEvents: AsyncIterable<AgentEvent>,
  context: ConsumeContext,
  events: AgentEvent[],
  diagnostics: DiagnosticLog,
): Promise<void> {
  const entry = {
    ...entrySeed,
    sessionId: null,
    runId: null,
    activeRunId: null,
    worker: Promise.resolve(),
    abortController: new AbortController(),
    startedAt: new Date(),
    lastEventAt: null,
    lastEvent: null,
    lastMessage: null,
    sdkRunStatus: null,
    sdkRunStatusUpdatedAt: null,
    sdkRunStatusSource: null,
    failureKind: null,
    failureDiagnosticCode: null,
    failureDiagnosticMessage: null,
    failureDiagnosticAt: null,
    failureDiagnosticPayload: undefined,
    turnCount: 0,
    retryAttempt: 0,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    activeRunTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cleanupWorkspaceOnExit: false,
    suppressRetryOnExit: false,
    completionReportAccepted: false,
    mergeConflictResolutionAccepted: false,
    issueBreakdownPlanAccepted: false,
    pullRequestHandoffAccepted: false,
    reviewVerdictAccepted: false,
    reviewEvidence: null,
    cancellationRequestedAt: null,
    cancellationSource: null,
    cancellationReason: null,
    abortSignalledAt: null,
    harnessStopRequestedAt: null,
    harnessStopFailedAt: null,
    harnessStopFailedReason: null,
    lastStreamActivityAt: null,
    lastDeltaOrToolActivityAt: null,
    lastToolActivityAt: null,
  };
  const tappedEvents = tapEvents(sourceEvents, events, diagnostics);
  try {
    await (
      orchestrator as unknown as {
        consumeHarnessEvents(entry: unknown, events: AsyncIterable<AgentEvent>, context: ConsumeContext): Promise<void>;
      }
    ).consumeHarnessEvents(entry, tappedEvents, context);
  } catch (error) {
    diagnostics.write(`[event] orchestrator consumer threw: ${errorMessage(error)}`);
    throw error;
  } finally {
    diagnostics.write(`[event] orchestrator consumer finally events=${events.map((event) => event.type).join(",")}`);
  }
}

async function* tapEvents(
  sourceEvents: AsyncIterable<AgentEvent>,
  events: AgentEvent[],
  diagnostics: DiagnosticLog,
): AsyncIterable<AgentEvent> {
  for await (const event of sourceEvents) {
    events.push(event);
    diagnostics.write(`[event] ${event.type}${"error" in event ? ` error=${event.error}` : ""}${"code" in event ? ` code=${event.code}` : ""}`);
    yield event;
  }
}

class InstrumentedGatewayClient implements HermesGatewayClient {
  private readonly client = new UpstreamGatewayClient();
  private readonly seenProcesses = new WeakSet<ChildProcess>();
  private closed = false;

  constructor(
    private readonly env: HermesGatewayEnvironment,
    private readonly diagnostics: DiagnosticLog,
  ) {
    this.client.on("exit", () => {
      this.closed = true;
    });
  }

  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    this.client.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    this.client.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  drain(): void {
    this.diagnostics.write(`[gw] drain`);
    this.client.drain();
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.diagnostics.write(`[gw] request start method=${method} ${this.transportState()}`);
    const promise = withHermesGatewayEnvironment(this.env, () => this.client.request<T>(method, params));
    this.attachProcess(`after request ${method}`);
    return promise.then(
      (result) => {
        this.diagnostics.write(`[gw] request resolved method=${method} ${this.transportState()}`);
        this.attachProcess(`after resolve ${method}`);
        return result;
      },
      (error: unknown) => {
        this.diagnostics.write(`[gw] request rejected method=${method} error=${errorMessage(error)} ${this.transportState()}`);
        this.attachProcess(`after reject ${method}`);
        throw error;
      },
    );
  }

  kill(reason?: string): void {
    this.closed = true;
    this.diagnostics.write(`[gw] kill reason=${reason ?? "none"} ${this.transportState()}`);
    this.client.kill(reason);
    this.diagnostics.write(`[gw] kill returned ${this.transportState()}`);
  }

  getLogTail(limit?: number): string {
    return this.client.getLogTail(limit);
  }

  isClosed(): boolean {
    return this.closed;
  }

  private attachProcess(reason: string): void {
    const proc = (this.client as unknown as { proc?: ChildProcess | null }).proc ?? null;
    if (!proc || this.seenProcesses.has(proc)) return;
    this.seenProcesses.add(proc);
    this.diagnostics.write(`[proc] attach reason=${reason} ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`);
    proc.on("spawn", () => this.diagnostics.write(`[proc] spawn ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.on("exit", (code, signal) => this.diagnostics.write(`[proc] exit code=${code ?? "null"} signal=${signal ?? "null"} ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.on("close", (code, signal) => this.diagnostics.write(`[proc] close code=${code ?? "null"} signal=${signal ?? "null"} ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.on("error", (error) => this.diagnostics.write(`[proc] error ${errorMessage(error)} ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.stdin?.on("finish", () => this.diagnostics.write(`[stdin] finish ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.stdin?.on("close", () => this.diagnostics.write(`[stdin] close ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.stdin?.on("error", (error) => this.diagnostics.write(`[stdin] error ${errorMessage(error)} ${describeProc(proc)} stdin=${describeWritable(proc.stdin)}`));
    proc.stdout?.on("close", () => this.diagnostics.write(`[stdout] close ${describeProc(proc)}`));
    proc.stderr?.on("close", () => this.diagnostics.write(`[stderr] close ${describeProc(proc)}`));
  }

  private transportState(): string {
    const proc = (this.client as unknown as { proc?: ChildProcess | null }).proc ?? null;
    return `proc=${describeProc(proc)} stdin=${describeWritable(proc?.stdin ?? null)}`;
  }
}

class DiagnosticLog {
  constructor(readonly path: string) {}

  write(line: string): void {
    const rendered = `${new Date().toISOString()} ${line}\n`;
    void fs.appendFile(this.path, rendered, "utf8").catch((error) => {
      console.error(`[hermes-dogfood-repro] failed to write diagnostics: ${errorMessage(error)}`);
    });
  }
}

function describeProc(proc: ChildProcess | null): string {
  if (!proc) return "pid=none";
  return `pid=${proc.pid ?? "unknown"} killed=${proc.killed} exitCode=${proc.exitCode ?? "null"} signal=${proc.signalCode ?? "null"}`;
}

function describeWritable(stream: NodeJS.WritableStream | null): string {
  if (!stream) return "none";
  const candidate = stream as NodeJS.WritableStream & {
    destroyed?: boolean;
    closed?: boolean;
    writable?: boolean;
    writableEnded?: boolean;
    writableFinished?: boolean;
  };
  return `destroyed=${candidate.destroyed ?? "n/a"} closed=${candidate.closed ?? "n/a"} writable=${candidate.writable ?? "n/a"} ended=${candidate.writableEnded ?? "n/a"} finished=${candidate.writableFinished ?? "n/a"}`;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
