import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAcpHarness, type HermesAcpRuntimeClient, type HermesAcpRuntimeClientOptions } from "../hermes/src/HermesAcpHarness.js";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import type { GatewayEvent, HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";
import type {
  HostHermesAcpDiagnostic,
  HostHermesAcpJsonRpcNotification,
  HostHermesAcpJsonRpcRequest,
  HostHermesAcpProcessExit,
  HostHermesAcpRequestOptions,
} from "../hermes/src/HostHermesAcpFacade.js";
import type {
  HostHermesAcpProcessCommand,
  HostHermesAcpProfileLease,
  HostHermesAcpProfileLeaseOptions,
  HostHermesAcpTerminalStatus,
} from "../hermes/src/HostHermesAcpProfileLease.js";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import type { RunTranscriptStore, TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import { sanitizeAgentEventForPublicOutput } from "../src/core/transcript/TranscriptProjection.js";
import type { Issue } from "../src/core/types.js";
import {
  ALLOWED_HARNESS_ACTIVITY_SOURCES,
  ALLOWED_HARNESS_AGENT_EVENT_TYPES,
  ALLOWED_PUBLIC_FRONTEND_KINDS,
  HARNESS_ACTIVITY_ADAPTER_IDS,
  HARNESS_ACTIVITY_SENSITIVE_NEEDLES,
  PROTOCOL_EVENT_NAMES_FORBIDDEN_AS_AGENT_EVENT_TYPES,
  PROTOCOL_EVENT_NAMES_FORBIDDEN_AS_FRONTEND_KINDS,
  harnessActivityConformanceFixtures,
  type HarnessActivityConformanceFixture,
  type HarnessActivityProtocolAdapterId,
  type HarnessActivityProtocolExpectation,
} from "./fixtures/harnessActivityConformanceFixtures.js";

interface CapturedHarnessActivityRun {
  events: AgentEvent[];
  runtimeTranscriptEvents: TranscriptEvent[];
}

interface AdapterCase {
  adapterId: HarnessActivityProtocolAdapterId;
  fixture: HarnessActivityConformanceFixture;
}

type NotificationHandler = (params: unknown, notification: HostHermesAcpJsonRpcNotification) => void;
type ClientRequestHandler = (params: unknown, request: HostHermesAcpJsonRpcRequest) => unknown | Promise<unknown>;

const tempRoots: string[] = [];
const REQUIRED_BASELINE_ADAPTER_CASE_KEYS = [
  "hermes_jsonrpc:streaming_tool_tokens_success",
  "hermes_acp:streaming_tool_tokens_success",
  "hermes_jsonrpc:terminal_error_failure",
  "hermes_acp:terminal_error_failure",
  "hermes_jsonrpc:cancelled_terminal",
  "hermes_acp:cancelled_terminal",
  "hermes_jsonrpc:provider_limit_terminal",
  "hermes_jsonrpc:malformed_incomplete_negative",
  "hermes_acp:malformed_incomplete_negative",
] as const;
const adapterCases: AdapterCase[] = buildAdapterCases(harnessActivityConformanceFixtures);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("harness activity contract conformance", () => {
  it("keeps the shared scenario matrix adapter-oriented so future harnesses can extend it without rewriting expectations", () => {
    const adapterCaseKeys = adapterCases.map(adapterCaseKey);

    expect(adapterCaseKeys).toEqual(expect.arrayContaining([...REQUIRED_BASELINE_ADAPTER_CASE_KEYS]));
    expect(adapterCases.length).toBeGreaterThanOrEqual(REQUIRED_BASELINE_ADAPTER_CASE_KEYS.length);
    expect(harnessActivityConformanceFixtures.some((fixture) => fixture.expected.negative)).toBe(true);

    for (const fixture of harnessActivityConformanceFixtures) {
      const registeredProtocols = registeredFixtureProtocols(fixture);

      expect(fixture.name).toMatch(/\S/);
      expect(fixture.description).toMatch(/\S/);
      expect(registeredProtocols.length).toBeGreaterThan(0);
      expect(adapterCases.filter((adapterCase) => adapterCase.fixture === fixture).map(({ adapterId }) => adapterId)).toEqual(
        registeredProtocols,
      );
    }
  });

  it("accepts additional fixture rows without changing the shared matrix expectation", () => {
    const futureFixture: HarnessActivityConformanceFixture = {
      name: "future_extension_success",
      description: "Synthetic extension fixture proving the conformance matrix is open to additional rows.",
      protocols: {
        hermes_jsonrpc: { events: [] },
      },
      expected: { terminal: "completed" },
    };
    const extendedCaseKeys = buildAdapterCases([...harnessActivityConformanceFixtures, futureFixture]).map(adapterCaseKey);

    expect(extendedCaseKeys).toEqual(
      expect.arrayContaining([...REQUIRED_BASELINE_ADAPTER_CASE_KEYS, "hermes_jsonrpc:future_extension_success"]),
    );
    expect(extendedCaseKeys.length).toBeGreaterThan(adapterCases.length);
  });

  it("redacts runActivity extension data when sanitizing public AgentEvents", () => {
    const publicEvent = sanitizeAgentEventForPublicOutput({
      type: "progress",
      message: "streamed SECRET_ACP_DELTA_TOKEN",
      runActivity: {
        text: "activity SECRET_ACP_DELTA_TOKEN",
        payload: { nestedToken: "SECRET_ACP_MALFORMED_TOKEN" },
      },
    } as unknown as AgentEvent);

    expect(JSON.stringify(publicEvent)).not.toContain("SECRET_ACP_DELTA_TOKEN");
    expect(JSON.stringify(publicEvent)).not.toContain("SECRET_ACP_MALFORMED_TOKEN");
  });

  it.each(adapterCases)("normalizes $adapterId $fixture.name activity through the shared contract", async ({ adapterId, fixture }) => {
    const result = await runAdapterFixture(adapterId, fixture);
    const publicEvents = result.events.map((event) => sanitizeAgentEventForPublicOutput(event));
    const transcriptEvents = transcriptEventsForRun(publicEvents, result.runtimeTranscriptEvents);
    const frontendMessages = projectWebTranscript(transcriptEvents);

    if (adapterId === "hermes_acp") assertAgentEventsAreBoundedAndRedacted(result.events);
    assertAgentEventContract(publicEvents, adapterId, fixture);
    assertTranscriptContract(transcriptEvents, publicEvents);
    assertFrontendContract(frontendMessages);
    assertNoProtocolTaxonomyLeak(publicEvents, frontendMessages);
    assertPublicPayloadsAreBoundedAndRedacted(publicEvents, frontendMessages);
    expect(projectWebTranscript(transcriptEvents)).toEqual(frontendMessages);
  });
});

function buildAdapterCases(fixtures: readonly HarnessActivityConformanceFixture[]): AdapterCase[] {
  return fixtures.flatMap((fixture) => registeredFixtureProtocols(fixture).map((adapterId) => ({ adapterId, fixture })));
}

function registeredFixtureProtocols(fixture: HarnessActivityConformanceFixture): HarnessActivityProtocolAdapterId[] {
  return HARNESS_ACTIVITY_ADAPTER_IDS.filter((adapterId) => fixture.protocols[adapterId] !== undefined);
}

function adapterCaseKey({ adapterId, fixture }: AdapterCase): string {
  return `${adapterId}:${fixture.name}`;
}

async function runAdapterFixture(
  adapterId: HarnessActivityProtocolAdapterId,
  fixture: HarnessActivityConformanceFixture,
): Promise<CapturedHarnessActivityRun> {
  switch (adapterId) {
    case "hermes_jsonrpc":
      return runHermesJsonRpcFixture(fixture);
    case "hermes_acp":
      return runHermesAcpFixture(fixture);
  }
}

async function runHermesJsonRpcFixture(fixture: HarnessActivityConformanceFixture): Promise<CapturedHarnessActivityRun> {
  const protocol = fixture.protocols.hermes_jsonrpc;
  if (!protocol) throw new Error(`Fixture ${fixture.name} does not define Hermes JSON-RPC activity.`);
  const root = await createTempRoot("symphony-harness-jsonrpc-");
  await prepareHermesTemplates(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const runStore = new CapturingRunStore();
  const hookVerifications: CommandPolicyHookVerification[] = [];
  const harness = new HermesHarnessForConformance(protocol.events, runStore, hookVerifications);
  const config = serviceConfig(root, "hermes");
  const events = await collectEvents(harness.run(runContext(config, workspacePath), "Run JSON-RPC conformance fixture"));
  expect(hookVerifications).toEqual([
    { role: "worker", phase: "implementation", upstreamRoot: config.hermes.upstreamRoot },
  ]);
  await harness.dispose();
  return { events, runtimeTranscriptEvents: runStore.events };
}

async function runHermesAcpFixture(fixture: HarnessActivityConformanceFixture): Promise<CapturedHarnessActivityRun> {
  const protocol = fixture.protocols.hermes_acp;
  if (!protocol) throw new Error(`Fixture ${fixture.name} does not define Hermes ACP activity.`);
  const root = await createTempRoot("symphony-harness-acp-");
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const runStore = new CapturingRunStore();
  const client = new FixtureAcpClient(protocol.notifications, protocol.promptResult, protocol.diagnostics ?? []);
  const harness = new HermesAcpHarness({
    cliPath: path.join(root, "src", "cli.ts"),
    profileLeaseFactory: async (options) => acpLease(options),
    acpClientFactory: (_command: HostHermesAcpProcessCommand, _options: HermesAcpRuntimeClientOptions) => client,
  });
  const config = serviceConfig(root, "hermes_acp");
  const events = await collectEvents(harness.run(runContext(config, workspacePath), "Run ACP conformance fixture"));
  await harness.dispose();
  return { events, runtimeTranscriptEvents: runStore.events };
}

interface CommandPolicyHookVerification {
  role: string;
  phase: string;
  upstreamRoot: string;
}

class HermesHarnessForConformance extends HermesHarness {
  constructor(
    events: readonly GatewayEvent[],
    runStore: CapturingRunStore,
    hookVerifications: CommandPolicyHookVerification[],
  ) {
    super({
      cliPath: "/host/bin/hermes",
      runStore: runStore as unknown as RunTranscriptStore,
      commandPolicyHookVerifier: async (verification) => {
        hookVerifications.push({
          role: verification.role,
          phase: verification.phase,
          upstreamRoot: verification.upstreamRoot,
        });
      },
      gatewayFactory: (env) => new FixtureGatewayClient(env, events, "jsonrpc-session-1"),
    });
  }
}

class FixtureGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly killedReasons: string[] = [];

  constructor(
    readonly env: HermesGatewayEnvironment,
    private readonly eventsOnPrompt: readonly GatewayEvent[],
    private readonly sessionId: string,
  ) {
    super();
  }

  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.on(event, listener);
  }

  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.off(event, listener);
  }

  drain(): void {
    return;
  }

  async request<T = unknown>(method: string, _params: Record<string, unknown> = {}): Promise<T> {
    if (method === "session.create") return { session_id: this.sessionId, session_key: `hermes-${this.sessionId}` } as T;
    if (method === "prompt.submit") {
      queueMicrotask(() => {
        for (const event of this.eventsOnPrompt) this.emit("event", scopeGatewayEvent(event, this.sessionId));
      });
      return { ok: true } as T;
    }
    return { ok: true } as T;
  }

  kill(reason?: string): void {
    this.killedReasons.push(reason ?? "");
  }

  getLogTail(_limit?: number): string {
    return "";
  }

  isClosed(): boolean {
    return false;
  }
}

class FixtureAcpClient extends EventEmitter implements HermesAcpRuntimeClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly kills: string[] = [];
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly clientRequestHandlers = new Map<string, Set<ClientRequestHandler>>();

  constructor(
    private readonly notifications: readonly unknown[],
    private readonly promptResult: Record<string, unknown> | null,
    private readonly diagnostics: readonly HostHermesAcpDiagnostic[],
  ) {
    super();
  }

  async request<T = unknown>(method: string, params?: unknown, _options?: HostHermesAcpRequestOptions): Promise<T> {
    this.requests.push({ method, params });
    switch (method) {
      case "initialize":
        return { authMethods: [{ id: "openai-codex", name: "OpenAI Codex", type: "provider" }] } as T;
      case "authenticate":
        return {} as T;
      case "session/new":
        return { sessionId: "acp-session-1" } as T;
      case "session/prompt":
        for (const diagnostic of this.diagnostics) this.emit("diagnostic", diagnostic);
        for (const notification of this.notifications) this.emitNotification("session/update", notification);
        return this.promptResult as T;
      case "session/cancel":
        return {} as T;
      default:
        return {} as T;
    }
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set<NotificationHandler>();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  onClientRequest(method: string, handler: ClientRequestHandler): () => void {
    let handlers = this.clientRequestHandlers.get(method);
    if (!handlers) {
      handlers = new Set<ClientRequestHandler>();
      this.clientRequestHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  on(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  on(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  off(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  kill(reason?: string): void {
    this.kills.push(reason ?? "");
  }

  getLogTail(_limit?: number): string {
    return "";
  }

  private emitNotification(method: string, params: unknown): void {
    const notification: HostHermesAcpJsonRpcNotification = { jsonrpc: "2.0", method, params };
    for (const handler of this.notificationHandlers.get(method) ?? []) handler(params, notification);
  }
}

class CapturingRunStore {
  readonly events: TranscriptEvent[] = [];

  async appendEvent(input: Omit<TranscriptEvent, "sequence"> & { sequence?: number }): Promise<TranscriptEvent> {
    const event: TranscriptEvent = { ...input, sequence: input.sequence ?? this.events.length + 1 };
    this.events.push(event);
    return event;
  }
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function prepareHermesTemplates(root: string): Promise<void> {
  for (const template of ["worker", "reviewer", "planner"]) {
    const templateDir = path.join(root, "templates", template);
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, "SOUL.md"), `${template} soul\n`, "utf8");
    await writeFile(path.join(templateDir, "config.yaml"), "{}\n", "utf8");
  }
}

function acpLease(options: HostHermesAcpProfileLeaseOptions): HostHermesAcpProfileLease {
  const profileName = "profile-1";
  return {
    profileName,
    sourceProfile: options.sourceProfile ?? "host-source",
    acpCommand: { file: options.binaryPath, args: ["-p", profileName, "acp"], cwd: options.cwd, env: {} },
    dispose: async (_terminalStatus: HostHermesAcpTerminalStatus) => ({ profileName, reason: "deleted" as const, deleted: true }),
  };
}

function serviceConfig(root: string, harness: "hermes" | "hermes_acp"): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      agent: { harness, max_turns: 2 },
      workspace: {
        root: path.join(root, "workspaces"),
        state_dir: path.join(root, "state"),
        source: { kind: "none" },
      },
      github: { publish_pull_requests: false },
      hermes: {
        upstream_root: path.join(root, "hermes-src"),
        templates_dir: path.join(root, "templates"),
        state_dir: path.join(root, "state", "hermes"),
        model: "gpt-5-test",
        keep_profiles: "never",
        startup_timeout_ms: 1_000,
        request_timeout_ms: 1_000,
        acp_binary_path: "/host/bin/hermes",
        acp_source_profile: "host-source",
      },
      credential_profiles: {
        profiles: {
          "worker-hermes": { value: "$WORKER_HERMES_TOKEN", capabilities: ["runtime.hermes"] },
        },
        roles: {
          worker: { "runtime.hermes": "worker-hermes" },
        },
      },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret", WORKER_HERMES_TOKEN: "worker-hermes-secret" },
  );
}

function runContext(config: ServiceConfig, workspacePath: string): AgentRunContext {
  return {
    issue: issue(),
    role: "worker",
    runPhase: "implementation",
    attempt: 1,
    workspace: {
      path: workspacePath,
      workspaceKey: "ENG-195",
      createdNow: false,
      issueId: "issue-1",
      issueIdentifier: "ENG-195",
      sourceKind: "git_worktree",
      gitBranchName: "sinfonista/eng-195-eng-176e-add-contract-fixtures-and-adapter-conformance-tests",
      repoPath: path.dirname(workspacePath),
      baseRef: "main",
    },
    config,
    turnNumber: 1,
    runModeOverride: null,
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function issue(): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-195",
    title: "ENG-176E: Add contract fixtures and adapter conformance tests",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: "sinfonista/eng-195-eng-176e-add-contract-fixtures-and-adapter-conformance-tests",
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: ["dogfood-ready"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function scopeGatewayEvent(event: GatewayEvent, sessionId: string): GatewayEvent {
  if (event.type.startsWith("gateway.") || event.session_id !== undefined) return event;
  return { ...event, session_id: sessionId } as GatewayEvent;
}

function expectedForProtocol(
  fixture: HarnessActivityConformanceFixture,
  adapterId: HarnessActivityProtocolAdapterId,
): {
  readonly requiredAgentEventTypes: readonly AgentEvent["type"][];
  readonly activitySources: readonly NonNullable<HarnessActivityProtocolExpectation["activitySources"]>[number][];
  readonly tokenTotals: readonly number[];
  readonly diagnosticCodes: readonly string[];
  readonly providerLimitKind: string | undefined;
} {
  const specific = fixture.expected.perProtocol?.[adapterId] ?? {};
  return {
    requiredAgentEventTypes: specific.requiredAgentEventTypes ?? fixture.expected.requiredAgentEventTypes ?? [],
    activitySources: specific.activitySources ?? fixture.expected.activitySources ?? [],
    tokenTotals: specific.tokenTotals ?? fixture.expected.tokenTotals ?? [],
    diagnosticCodes: specific.diagnosticCodes ?? fixture.expected.diagnosticCodes ?? [],
    providerLimitKind: specific.providerLimitKind ?? fixture.expected.providerLimitKind,
  };
}

function assertAgentEventContract(
  events: readonly AgentEvent[],
  adapterId: HarnessActivityProtocolAdapterId,
  fixture: HarnessActivityConformanceFixture,
): void {
  const expected = expectedForProtocol(fixture, adapterId);
  expect(events.length).toBeGreaterThan(1);
  expect(events[0]).toMatchObject({ type: "session_started" });
  const started = events[0] as Extract<AgentEvent, { type: "session_started" }>;
  expect(started.sessionId).toContain(started.runId ?? "");
  expect(started.threadId).toBeTruthy();
  if (started.at !== undefined) expect(started.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  for (const event of events) {
    expect(ALLOWED_HARNESS_AGENT_EVENT_TYPES).toContain(event.type);
    if (event.at !== undefined) expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    if (event.type === "progress" && event.activitySource !== undefined) {
      expect(ALLOWED_HARNESS_ACTIVITY_SOURCES).toContain(event.activitySource);
    }
  }

  expectRequiredTypesInOrder(events, expected.requiredAgentEventTypes);
  expectTerminalShape(events, fixture.expected.terminal);

  const activitySources = events
    .filter((event): event is Extract<AgentEvent, { type: "progress" }> => event.type === "progress")
    .map((event) => event.activitySource)
    .filter((source): source is NonNullable<typeof source> => source !== undefined);
  for (const source of expected.activitySources) expect(activitySources).toContain(source);

  const tokenTotals = events
    .filter((event): event is Extract<AgentEvent, { type: "tokens" }> => event.type === "tokens")
    .map((event) => event.tokens.totalTokens)
    .filter((total): total is number => typeof total === "number");
  for (const total of expected.tokenTotals) expect(tokenTotals).toContain(total);

  const diagnosticCodes = events
    .filter((event): event is Extract<AgentEvent, { type: "run_diagnostic" }> => event.type === "run_diagnostic")
    .map((event) => event.code);
  for (const code of expected.diagnosticCodes) expect(diagnosticCodes).toContain(code);

  if (expected.providerLimitKind) {
    const limit = events.find((event): event is Extract<AgentEvent, { type: "provider_limit" }> => event.type === "provider_limit");
    expect(limit?.signal.kind).toBe(expected.providerLimitKind);
    expect(limit?.signal.scope.harnessId).toBe("hermes");
    expect(limit?.signal.scope.providerId).toBe("openai-codex");
  }
}

function expectRequiredTypesInOrder(events: readonly AgentEvent[], requiredTypes: readonly AgentEvent["type"][]): void {
  let cursor = 0;
  for (const requiredType of requiredTypes) {
    const nextIndex = events.findIndex((event, index) => index >= cursor && event.type === requiredType);
    expect(nextIndex, `missing required AgentEvent ${requiredType}`).toBeGreaterThanOrEqual(cursor);
    cursor = nextIndex + 1;
  }
}

function expectTerminalShape(events: readonly AgentEvent[], terminal: HarnessActivityConformanceFixture["expected"]["terminal"]): void {
  const terminalEvents = events.filter((event) => event.type === "completed" || event.type === "failed" || event.type === "cancelled");
  expect(terminalEvents).toHaveLength(1);
  expect(events.at(-1)).toBe(terminalEvents[0]);
  switch (terminal) {
    case "completed":
      expect(terminalEvents[0]?.type).toBe("completed");
      break;
    case "failed":
      expect(terminalEvents[0]?.type).toBe("failed");
      break;
    case "cancelled":
      expect(terminalEvents[0]?.type).toBe("cancelled");
      break;
    case "provider_limit_failed":
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["provider_limit", "failed"]));
      expect(terminalEvents[0]?.type).toBe("failed");
      break;
  }
}

function transcriptEventsForRun(events: readonly AgentEvent[], runtimeTranscriptEvents: readonly TranscriptEvent[]): TranscriptEvent[] {
  const harnessEvents = events.map((event, index): TranscriptEvent => {
    const runId = "runId" in event && typeof event.runId === "string" ? event.runId : "harness-conformance-run";
    const message = event.type === "progress" || event.type === "completed" || event.type === "run_diagnostic" ? event.message : undefined;
    return {
      runId,
      sequence: runtimeTranscriptEvents.length + index + 1,
      at: event.at ?? new Date(0).toISOString(),
      source: "harness",
      eventType: event.type,
      ...(message === undefined ? {} : { message }),
      payload: event,
    };
  });
  return [...runtimeTranscriptEvents, ...harnessEvents].map((event, index) => ({ ...event, sequence: index + 1 }));
}

function assertTranscriptContract(transcriptEvents: readonly TranscriptEvent[], publicEvents: readonly AgentEvent[]): void {
  expect(transcriptEvents.length).toBeGreaterThanOrEqual(publicEvents.length);
  expect(transcriptEvents.map((event) => event.sequence)).toEqual(transcriptEvents.map((_event, index) => index + 1));
  expect(new Set(transcriptEvents.map((event) => `${event.runId}:${event.sequence}`)).size).toBe(transcriptEvents.length);
  for (const event of transcriptEvents) {
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.source).toMatch(/^(harness|runtime)$/);
  }
}

function assertFrontendContract(frontendMessages: ReturnType<typeof projectWebTranscript>): void {
  expect(frontendMessages.length).toBeGreaterThan(0);
  for (const message of frontendMessages) expect(ALLOWED_PUBLIC_FRONTEND_KINDS).toContain(message.kind);
}

function assertNoProtocolTaxonomyLeak(
  events: readonly AgentEvent[],
  frontendMessages: ReturnType<typeof projectWebTranscript>,
): void {
  const eventTypes = events.map((event) => event.type);
  for (const forbidden of PROTOCOL_EVENT_NAMES_FORBIDDEN_AS_AGENT_EVENT_TYPES) expect(eventTypes).not.toContain(forbidden);
  const frontendKinds = frontendMessages.map((message) => message.kind);
  for (const forbidden of PROTOCOL_EVENT_NAMES_FORBIDDEN_AS_FRONTEND_KINDS) expect(frontendKinds).not.toContain(forbidden);
}

function assertPublicPayloadsAreBoundedAndRedacted(
  events: readonly AgentEvent[],
  frontendMessages: ReturnType<typeof projectWebTranscript>,
): void {
  const publicJson = JSON.stringify({ events, frontendMessages });
  for (const secret of HARNESS_ACTIVITY_SENSITIVE_NEEDLES) expect(publicJson).not.toContain(secret);

  assertAgentEventsAreBoundedAndRedacted(events);

  for (const message of frontendMessages) {
    for (const value of Object.values(message)) {
      if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(5_020);
      if (value && typeof value === "object" && "preview" in value) {
        expect(String((value as { preview: unknown }).preview).length).toBeLessThanOrEqual(520);
      }
    }
  }
}

function assertAgentEventsAreBoundedAndRedacted(events: readonly AgentEvent[]): void {
  const eventJson = JSON.stringify(events);
  for (const secret of HARNESS_ACTIVITY_SENSITIVE_NEEDLES) expect(eventJson).not.toContain(secret);

  for (const event of events) {
    if (event.type === "progress" || event.type === "completed" || event.type === "run_diagnostic") {
      expect(event.message?.length ?? 0).toBeLessThanOrEqual(520);
    }
    if (event.type === "failed") expect(event.error.length).toBeLessThanOrEqual(520);
  }
}
