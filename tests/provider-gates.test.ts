import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeProjectContextResolution, type ProjectContextResolution } from "../src/core/config/ProjectContexts.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileProviderGateStore } from "../src/core/persistence/ProviderGateStore.js";
import type { ProviderLimitSignal, RuntimeProviderGate } from "../src/core/provider/ProviderLimits.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { testConfig, trackerClientFixture, trackerIssue } from "./helpers.js";

const futureResumeAt = "2099-01-01T05:00:00.000Z";
const symphonyProjectSlug = "TEST";
const docsProjectSlug = "DOCS";

const symphonyProjectContext = normalizeProjectContextResolution({
  projectContextId: "symphony",
  projectContextLabel: "Symphony",
  linearProjectSlug: symphonyProjectSlug,
  routingSource: "candidate_poll",
});

const docsProjectContext = normalizeProjectContextResolution({
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: docsProjectSlug,
  routingSource: "candidate_poll",
});

class ProviderLimitHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: AgentRunContext[] = [];

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    this.runs.push(ctx);
    yield { type: "session_started", sessionId: "provider-limit-session", runId: "provider-limit-run" };
    yield {
      type: "provider_limit",
      signal: {
        scope: {
          harnessId: this.id,
          providerId: "openai-codex",
          model: "gpt-5-test",
        },
        kind: "windowed_bucket_exhausted",
        message: "Codex usage window exhausted",
        window: {
          resumeAt: futureResumeAt,
          windowLabel: "Session",
          windowKind: "codex_5h",
        },
        resumePolicy: "auto_at_window_close",
      },
    };
  }
}

function addDocsPollingProjectContext(config: ReturnType<typeof testConfig>): void {
  if (config.projectContexts.byId.has(docsProjectContext.projectContextId)) return;

  const defaultContext = config.projectContexts.defaultContext;
  const docsContext = {
    ...defaultContext,
    id: docsProjectContext.projectContextId,
    label: docsProjectContext.projectContextLabel,
    source: "explicit" as const,
    tracker: {
      ...defaultContext.tracker,
      projectSlug: docsProjectSlug,
    },
    reviewLoop: {
      ...config.reviewLoop,
    },
    issueBreakdown: {
      ...config.issueBreakdown,
    },
    agent: {
      ...config.agent,
    },
    publicMetadata: {
      ...defaultContext.publicMetadata,
      id: docsProjectContext.projectContextId,
      label: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectSlug,
    },
    publicSummary: {
      ...defaultContext.publicSummary,
      id: docsProjectContext.projectContextId,
      label: docsProjectContext.projectContextLabel,
      tracker: {
        ...defaultContext.publicSummary.tracker,
        projectSlug: docsProjectSlug,
      },
      publicMetadata: {
        ...defaultContext.publicSummary.publicMetadata,
        id: docsProjectContext.projectContextId,
        label: docsProjectContext.projectContextLabel,
        linearProjectSlug: docsProjectSlug,
      },
    },
  };

  config.projectContexts.contexts = [...config.projectContexts.contexts, docsContext];
  config.projectContexts.enabledContexts = [...config.projectContexts.enabledContexts, docsContext];
  (config.projectContexts.byId as unknown as Map<string, typeof docsContext>).set(docsContext.id, docsContext);
}

function providerGateSignal(
  providerId: string,
  issueIdentifier: string,
  projectContext: ProjectContextResolution,
  observedAt: string,
): ProviderLimitSignal {
  return {
    scope: { harnessId: "hermes", providerId, model: "gpt-5-test" },
    kind: "windowed_bucket_exhausted",
    window: {
      resumeAt: futureResumeAt,
      windowKind: "codex_5h",
      windowLabel: "Session",
    },
    resumePolicy: "auto_at_window_close",
    message: `Provider limit for ${projectContext.projectContextId}`,
    observedAt,
    source: {
      issueId: `issue-${projectContext.projectContextId}`,
      issueIdentifier,
      runId: `run-${projectContext.projectContextId}`,
      sessionId: `session-${projectContext.projectContextId}`,
      role: "worker",
      runPhase: "implementation",
      projectContext,
    },
  };
}

async function readPersistedProviderGates(stateDir: string): Promise<RuntimeProviderGate[]> {
  const providerGatesDir = path.join(stateDir, "provider-gates");
  const entries = (await readdir(providerGatesDir)).filter((entry) => entry.endsWith(".json")).sort();
  return Promise.all(entries.map(async (entry) => JSON.parse(await readFile(path.join(providerGatesDir, entry), "utf8")) as RuntimeProviderGate));
}

async function waitFor(predicate: () => boolean, description = "condition", timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
}

describe("provider gate project-context attribution", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-provider-gates-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records project-context attribution through the orchestrator provider-limit path", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    const candidate = trackerIssue({
      id: "issue-docs-1",
      identifier: "ENG-123",
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectSlug,
      state: "Todo",
    });
    const tracker = trackerClientFixture({ candidates: [candidate] });
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const providerGateStore = new FileProviderGateStore(config.workspace.stateDir);
    const harness = new ProviderLimitHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      providerGateStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1, "provider-limit run dispatched");
      await waitFor(() => orchestrator.snapshot().counts.running === 0, "provider-limit run exited");
      await waitFor(() => orchestrator.snapshot().providerGates.length === 1, "provider gate recorded");

      const gate = orchestrator.snapshot().providerGates[0]!;
      const persisted = await readPersistedProviderGates(config.workspace.stateDir);
      const reloaded = await new FileProviderGateStore(config.workspace.stateDir).listActive();

      expect(harness.runs[0]?.projectContext).toEqual(docsProjectContext);
      expect(gate).toMatchObject({
        source: {
          issueIdentifier: "ENG-123",
          runId: "provider-limit-run",
          projectContextId: docsProjectContext.projectContextId,
          projectContextLabel: docsProjectContext.projectContextLabel,
          linearProjectSlug: docsProjectContext.linearProjectSlug,
          routingSource: docsProjectContext.routingSource,
          projectContext: docsProjectContext,
        },
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        id: gate.id,
        source: {
          issueIdentifier: "ENG-123",
          runId: "provider-limit-run",
          projectContextId: docsProjectContext.projectContextId,
          projectContextLabel: docsProjectContext.projectContextLabel,
          linearProjectSlug: docsProjectContext.linearProjectSlug,
          routingSource: docsProjectContext.routingSource,
          projectContext: docsProjectContext,
        },
      });
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({
        id: gate.id,
        source: {
          issueIdentifier: "ENG-123",
          runId: "provider-limit-run",
          projectContextId: docsProjectContext.projectContextId,
          projectContextLabel: docsProjectContext.projectContextLabel,
          linearProjectSlug: docsProjectContext.linearProjectSlug,
          routingSource: docsProjectContext.routingSource,
          projectContext: docsProjectContext,
        },
      });
    } finally {
      await orchestrator.stop();
    }
  });

  it("keeps the current owner context on same-provider gate overwrites", async () => {
    const store = new FileProviderGateStore(root);

    const firstGate = await store.upsert(
      providerGateSignal("openai-codex", "ENG-123", symphonyProjectContext, "2026-01-01T00:00:00.000Z"),
    );
    const secondGate = await store.upsert(
      providerGateSignal("openai-codex", "ENG-123", docsProjectContext, "2026-01-01T00:01:00.000Z"),
    );

    const persisted = await readPersistedProviderGates(root);
    const reloaded = await new FileProviderGateStore(root).listActive();

    expect(firstGate.id).toBe(secondGate.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: secondGate.id,
      observedAt: "2026-01-01T00:01:00.000Z",
      source: {
        issueIdentifier: "ENG-123",
        runId: "run-docs",
        projectContextId: docsProjectContext.projectContextId,
        projectContextLabel: docsProjectContext.projectContextLabel,
        linearProjectSlug: docsProjectContext.linearProjectSlug,
        routingSource: docsProjectContext.routingSource,
        projectContext: docsProjectContext,
      },
    });
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      id: secondGate.id,
      source: {
        issueIdentifier: "ENG-123",
        runId: "run-docs",
        projectContextId: docsProjectContext.projectContextId,
        projectContextLabel: docsProjectContext.projectContextLabel,
        linearProjectSlug: docsProjectContext.linearProjectSlug,
        routingSource: docsProjectContext.routingSource,
        projectContext: docsProjectContext,
      },
    });
  });

  it("rehydrates project-context source metadata when reloading legacy provider gate records", async () => {
    const store = new FileProviderGateStore(root);
    const created = await store.upsert(
      providerGateSignal("openai-codex", "ENG-123", docsProjectContext, "2026-01-01T00:00:00.000Z"),
    );

    const providerGatesDir = path.join(root, "provider-gates");
    const [entry] = await readdir(providerGatesDir);
    const legacyRecord = JSON.parse(await readFile(path.join(providerGatesDir, entry!), "utf8")) as RuntimeProviderGate & {
      source?: Record<string, unknown> | null;
    };

    expect(legacyRecord.source).toMatchObject({
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
      routingSource: docsProjectContext.routingSource,
      projectContext: docsProjectContext,
    });

    if (legacyRecord.source && typeof legacyRecord.source === "object") {
      delete legacyRecord.source.projectContextId;
      delete legacyRecord.source.projectContextLabel;
      delete legacyRecord.source.linearProjectSlug;
      delete legacyRecord.source.routingSource;
    }

    await writeFile(path.join(providerGatesDir, entry!), `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");

    const reloaded = await new FileProviderGateStore(root).listActive();

    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      id: created.id,
      source: {
        issueIdentifier: "ENG-123",
        runId: "run-docs",
        projectContextId: docsProjectContext.projectContextId,
        projectContextLabel: docsProjectContext.projectContextLabel,
        linearProjectSlug: docsProjectContext.linearProjectSlug,
        routingSource: docsProjectContext.routingSource,
        projectContext: docsProjectContext,
      },
    });
  });
});
