import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { ProjectContextResolution } from "../src/core/config/ProjectContexts.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue } from "../src/core/types.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import {
  issue,
  multiProjectWorkflowConfig,
  projectContextFixture,
  trackerIssue,
  type TestProjectContextFixture,
} from "./helpers.js";

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

describe("project context routing contract", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-project-context-routing-"));
    await mkdir(path.join(root, "workspace-template"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the single enabled context match on the live orchestration seam", async () => {
    const config = projectConfig(root, [
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "." }),
    ]);
    const candidate = candidatePollIssue({ id: "issue-docs-1", identifier: "DOCS-1", state: "Todo" }, "DOCS");

    const result = await runRoutingScenario({
      candidate,
      config,
      runIdPrefix: "one-match",
    });

    expect(result.harness.runs).toHaveLength(1);
    expect(result.harness.runs[0]?.ctx.projectContext).toEqual(docsProjectContext);
    await expect(result.runStore.getRun(result.harness.lastRunId()!)).resolves.toMatchObject({
      projectContext: docsProjectContext,
    });
    await expect(result.lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
    });
  });

  it.each([
    {
      name: "no enabled context matches the issue",
      blockedReason: "did not match any enabled project context",
      candidate: candidatePollIssue({ id: "issue-ops-1", identifier: "OPS-1", state: "Todo" }, "OPS"),
      projectContexts: [
        projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
        projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "." }),
      ],
    },
    {
      name: "more than one enabled context matches the issue",
      blockedReason: "matched multiple enabled project contexts",
      candidate: candidatePollIssue({ id: "issue-docs-2", identifier: "DOCS-2", state: "Todo" }, "DOCS"),
      projectContexts: [
        projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "." }),
        projectContextFixture({ id: "docs-staging", label: "Documentation Staging", projectSlug: "DOCS", repository: "." }),
      ],
    },
    {
      name: "the only matching context is disabled",
      blockedReason: "matched only disabled project contexts",
      candidate: candidatePollIssue({ id: "issue-docs-3", identifier: "DOCS-3", state: "Todo" }, "DOCS"),
      projectContexts: [
        projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
        projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: ".", enabled: false }),
      ],
    },
  ])("fails closed on the live orchestration seam when $name", async ({ blockedReason, candidate, projectContexts }) => {
    const config = projectConfig(root, projectContexts);

    const result = await runRoutingScenario({
      candidate,
      config,
      runIdPrefix: `blocked-${candidate.id}`,
    });

    expect(result.harness.runs).toHaveLength(0);
    expect(result.harness.lastRunId()).toBeNull();
    await expect(result.lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: expect.stringContaining(blockedReason),
      incompleteTurnCount: 0,
    });
  });

  it("fails closed when scoped polling contexts share a Linear project slug and return the same candidate", async () => {
    const config = projectConfig(root, [
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "." }),
      projectContextFixture({ id: "guides", label: "Guides Site", projectSlug: "DOCS", repository: "." }),
    ]);
    const candidate = candidatePollIssue({ id: "issue-docs-shared", identifier: "DOCS-77", state: "Todo" }, "DOCS");
    const docsTracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [structuredClone(candidate)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [structuredClone(candidate)];
      },
    };
    const guidesTracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [structuredClone(candidate)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [structuredClone(candidate)];
      },
    };

    const result = await runRoutingScenario({
      candidate,
      config,
      runIdPrefix: "duplicate-scoped-slug",
      tracker: docsTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === "guides" ? guidesTracker : docsTracker;
      },
    });

    expect(result.harness.runs).toHaveLength(0);
    expect(result.harness.lastRunId()).toBeNull();
    await expect(result.lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: expect.stringContaining("matched multiple enabled project contexts"),
      incompleteTurnCount: 0,
    });
  });

  it.each(["replay", "state_refresh"] as const)(
    "preserves explicit project context metadata for %s sources even after config drift on the live orchestration seam",
    async (routingSource) => {
      const config = projectConfig(root, [
        projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      ]);
      const candidate = trackerIssue({
        id: `issue-${routingSource}`,
        identifier: `DOCS-${routingSource.toUpperCase()}`,
        state: "Todo",
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource,
      });

      const result = await runRoutingScenario({
        candidate,
        config,
        runIdPrefix: routingSource,
      });

      const expectedProjectContext = {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource,
      };
      expect(result.harness.runs).toHaveLength(1);
      expect(result.harness.runs[0]?.ctx.projectContext).toEqual(expectedProjectContext);
      await expect(result.runStore.getRun(result.harness.lastRunId()!)).resolves.toMatchObject({
        projectContext: expectedProjectContext,
      });
      await expect(result.lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "implementation",
        projectContext: expectedProjectContext,
      });
    },
  );

  it("reuses persisted project context after config reload disables the original context on the live orchestration seam", async () => {
    const initialConfig = projectConfig(root, [
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "." }),
    ]);
    const candidate = candidatePollIssue({ id: "issue-docs-persisted", identifier: "DOCS-9", state: "Todo" }, "DOCS");

    const firstRun = await runRoutingScenario({
      candidate,
      config: initialConfig,
      runIdPrefix: "persisted-seed",
    });
    await expect(firstRun.lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      projectContext: docsProjectContext,
    });

    const reloadedConfig = projectConfig(root, [
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: ".", enabled: false }),
    ]);
    const refreshedIssue = issue({
      id: candidate.id,
      identifier: candidate.identifier,
      state: "Todo",
      updatedAt: "2026-01-02T00:00:00Z",
    });

    const secondRun = await runRoutingScenario({
      candidate: refreshedIssue,
      config: reloadedConfig,
      runIdPrefix: "persisted-reuse",
    });

    expect(secondRun.harness.runs).toHaveLength(1);
    expect(secondRun.harness.runs[0]?.ctx.projectContext).toEqual(docsProjectContext);
    await expect(secondRun.runStore.getRun(secondRun.harness.lastRunId()!)).resolves.toMatchObject({
      projectContext: docsProjectContext,
    });
    await expect(secondRun.lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
    });
  });
});

class RecordingHarness implements AgentHarness {
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly id: string;
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string; runId: string }> = [];

  constructor(private readonly runIdPrefix: string) {
    this.id = `recording-${runIdPrefix}`;
  }

  lastRunId(): string | null {
    return this.runs.at(-1)?.runId ?? null;
  }

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const runId = `${this.runIdPrefix}-${ctx.issue.id}-${this.runs.length + 1}`;
    this.runs.push({ ctx, prompt, runId });
    yield { type: "session_started", sessionId: runId };
    yield { type: "completed", message: "routing test completed" };
  }
}

async function runRoutingScenario(params: {
  config: ReturnType<typeof parseServiceConfig>;
  candidate: Issue;
  runIdPrefix: string;
  refreshedIssue?: Issue;
  tracker?: TrackerClient;
  trackerResolver?: (projectContext?: ProjectContextResolution) => TrackerClient;
}): Promise<{
  harness: RecordingHarness;
  lifecycleStore: FileIssueLifecycleStore;
  runStore: FileRunTranscriptStore;
}> {
  const logger = new StructuredLogger(() => undefined);
  const tracker: TrackerClient =
    params.tracker ??
    {
      async fetchCandidateIssues() {
        return [structuredClone(params.candidate)];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [structuredClone(params.refreshedIssue ?? params.candidate)];
      },
    };
  const harness = new RecordingHarness(params.runIdPrefix);
  const lifecycleStore = new FileIssueLifecycleStore(params.config.workspace.stateDir);
  const runStore = new FileRunTranscriptStore(params.config.workspace.stateDir);
  const workspaceManager = new WorkspaceManager({
    workspace: params.config.workspace,
    hooks: params.config.hooks,
    logger,
  });
  const orchestrator = new Orchestrator({
    config: params.config,
    tracker,
    ...(params.trackerResolver ? { trackerResolver: params.trackerResolver } : {}),
    workspaceManager,
    harness,
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    lifecycleStore,
    runStore,
  });

  try {
    await orchestrator.refreshNow();
    await waitForCondition(async () => {
      const lifecycle = await lifecycleStore.get(params.candidate.id);
      if (lifecycle !== null && (lifecycle.phase === "blocked" || lifecycle.blockedReason !== null)) {
        return true;
      }
      const runId = harness.lastRunId();
      return runId !== null && (await runStore.getRun(runId)) !== null;
    }, `project-context routing outcome for ${params.candidate.identifier}`);
  } finally {
    await orchestrator.stop();
  }

  return { harness, lifecycleStore, runStore };
}

function projectConfig(
  root: string,
  projectContexts: TestProjectContextFixture[],
): ReturnType<typeof parseServiceConfig> {
  const workspaceRoot = path.join(root, "workspaces");
  const stateDir = path.join(root, "state");
  const workspaceTemplatePath = path.join(root, "workspace-template");
  const workspaceSource = { kind: "copy" as const, path: workspaceTemplatePath };
  const routedProjectContexts: TestProjectContextFixture[] = projectContexts.map(
    (projectContext): TestProjectContextFixture => ({
      ...projectContext,
      workspace: {
        ...(projectContext.workspace ?? {}),
        root: workspaceRoot,
        state_dir: stateDir,
        source: {
          ...(projectContext.workspace?.source ?? {}),
          ...workspaceSource,
        },
      },
    }),
  );

  return parseServiceConfig(
    multiProjectWorkflowConfig({
      topLevel: {
        workspace: {
          root: workspaceRoot,
          state_dir: stateDir,
          source: workspaceSource,
        },
      },
      projectContexts: routedProjectContexts,
    }),
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-test-key" },
  );
}

function candidatePollIssue(
  overrides: Partial<Issue> & Pick<Issue, "id" | "identifier" | "state">,
  linearProjectSlug: string,
): Issue {
  return {
    ...issue(overrides),
    linearProjectIdentity: { slug: linearProjectSlug },
    routingSource: "candidate_poll",
  } as Issue;
}

async function waitForCondition(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
