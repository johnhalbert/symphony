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
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    expect(transcript.events.map((event) => event.eventType)).toEqual(["pr_opened", "session_started", "completed"]);
    expect(lifecycle?.summaryPointers).toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      gitBranchName: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
    });
  });
});

class RecordingPullRequestClient implements PullRequestDiscoveryClient {
  readonly branches: string[] = [];

  async findOpenPullRequestByBranch(input: { branchName: string }) {
    this.branches.push(input.branchName);
    return {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: input.branchName,
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
    };
  }
}
