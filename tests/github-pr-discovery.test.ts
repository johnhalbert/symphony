import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator, type PullRequestDiscoveryClient } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import { GitHubPullRequestClient } from "../src/integrations/github/GitHubPullRequestClient.js";
import { issue, testConfig } from "./helpers.js";

describe("GitHub pull request discovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-github-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("queries open pull requests by configured head branch", async () => {
    let requestedPathname: string | null = null;
    let requestedHead: string | null = null;
    let requestedState: string | null = null;
    let authorization: string | null = null;
    const client = new GitHubPullRequestClient(
      {
        owner: "acme",
        repo: "symphony",
        token: "github-token",
        headOwner: "octo",
        apiBaseUrl: "https://github.internal/api/v3",
        publishPullRequests: false,
      },
      async (input, init) => {
        const url = new URL(String(input));
        requestedPathname = url.pathname;
        requestedHead = url.searchParams.get("head");
        requestedState = url.searchParams.get("state");
        const headers = init?.headers as Record<string, string> | undefined;
        authorization = headers?.authorization ?? null;
        return new Response(
          JSON.stringify([
            {
              html_url: "https://github.com/acme/symphony/pull/42",
              number: 42,
              draft: true,
              updated_at: "2026-01-01T00:00:02Z",
              head: {
                ref: "symphony/TEST-1",
                sha: "abc123",
                repo: { pushed_at: "2026-01-01T00:00:01Z" },
              },
            },
          ]),
          { status: 200 },
        );
      },
    );

    await expect(client.findOpenPullRequestByBranch({ branchName: "symphony/TEST-1" })).resolves.toEqual({
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      draft: true,
    });
    expect(requestedPathname).toBe("/api/v3/repos/acme/symphony/pulls");
    expect(requestedState).toBe("open");
    expect(requestedHead).toBe("octo:symphony/TEST-1");
    expect(authorization).toBe("Bearer github-token");
  });

  it("leaves PR metadata undiscovered when the token is missing", async () => {
    let fetchCount = 0;
    const client = new GitHubPullRequestClient(
      {
        owner: "acme",
        repo: "symphony",
        token: null,
        headOwner: "acme",
        apiBaseUrl: "https://api.github.test",
        publishPullRequests: false,
      },
      async () => {
        fetchCount += 1;
        return new Response("[]", { status: 200 });
      },
    );

    await expect(client.findOpenPullRequestByBranch({ branchName: "symphony/TEST-1" })).resolves.toBeNull();
    expect(fetchCount).toBe(0);
  });

  it("links a discovered PR to lifecycle and run records idempotently", async () => {
    const config = testConfig(root);
    const candidate = issue({ branchName: "symphony/TEST-1" });
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        return [refreshes === 1 ? candidate : { ...candidate, state: "Done" }];
      },
    };
    const pullRequestClient = new RecordingPullRequestClient();
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
      pullRequestClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    const run = await runStore.getRun("fake-issue-1-1");
    const transcript = await runStore.readTranscript("fake-issue-1-1");
    const lifecycle = await lifecycleStore.get(candidate.identifier);

    expect(pullRequestClient.branches).toEqual(["symphony/TEST-1", "symphony/TEST-1"]);
    expect(run).toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      gitBranchName: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
    });
    expect(transcript.events.map((event) => event.eventType).filter((eventType) => eventType !== "lane_memo_updated")).toEqual([
      "pr_opened",
      "session_started",
      "completed",
    ]);
    expect(transcript.events.map((event) => event.eventType)).toContain("lane_memo_updated");
    expect(lifecycle?.summaryPointers).toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      gitBranchName: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
    });
  });

  it("links PR metadata without handoff transitions in publication mode", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 1;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    config.github.prHandoff.requiredChecks = ["Typecheck and test"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    let candidateFetches = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        candidateFetches += 1;
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const pullRequestClient = new RecordingPullRequestClient({
      checks: [{ name: "Typecheck and test", status: "success", conclusion: "success", url: null }],
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
      writeback,
      pullRequestClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(candidateFetches).toBeGreaterThanOrEqual(1);
    expect(harness.runs).toHaveLength(1);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments.map((comment) => comment.dedupeKey)).not.toContain("pull-request-handoff:pr-42:abc123");
    expect(currentState).toBe("In Progress");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "implementation",
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
      },
    });
    expect(pullRequestClient.checkInputs).toEqual([]);
  });

  it("keeps non-publication PR discovery metadata-only even when checks pass", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.tracker.handoffStates = ["Human Review"];
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const pullRequestClient = new RecordingPullRequestClient({
      checks: [{ name: "Typecheck and test", status: "success", conclusion: "success", url: null }],
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore: new FileRunTranscriptStore(stateDir),
      lifecycleStore: new FileIssueLifecycleStore(stateDir),
      writeback: new WritebackProcessor(outboxStore, writer, logger, 300_000),
      pullRequestClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments.some((comment) => comment.dedupeKey.startsWith("pull-request-handoff"))).toBe(false);
    expect(currentState).toBe("In Progress");
    expect(pullRequestClient.checkInputs).toEqual([]);
    expect((await new FileIssueLifecycleStore(stateDir).get("issue-1"))?.phase).toBe("implementation");
  });
});

class RecordingPullRequestClient implements PullRequestDiscoveryClient {
  readonly branches: string[] = [];
  readonly checkInputs: Array<{ headSha: string; requiredChecks: string[] }> = [];

  constructor(
    private readonly options: {
      draft?: boolean;
      checks?: Array<{ name: string; status: "success" | "failure" | "pending" | "missing"; conclusion: string | null; url: string | null }>;
    } = {},
  ) {}

  async findOpenPullRequestByBranch(input: { branchName: string }) {
    this.branches.push(input.branchName);
    return {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: input.branchName,
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      ...(this.options.draft ? { draft: true } : {}),
    };
  }

  async getRequiredCheckResults(input: { headSha: string; requiredChecks: string[] }) {
    this.checkInputs.push(input);
    return this.options.checks ?? [];
  }
}

class StateChangingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  constructor(private readonly setState: (state: string) => void) {}

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    this.setState(input.toState);
    return { status: "applied" };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
    return { status: "applied" };
  }
}
