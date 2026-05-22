import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import { GitHubPullRequestClient } from "../src/integrations/github/GitHubPullRequestClient.js";

describe("GitHubPullRequestClient", () => {
  it("finds an open pull request by head branch", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new GitHubPullRequestClient(
      {
        owner: "octo-org",
        repo: "symphony",
        token: "github-secret",
        headOwner: "fork-owner",
        apiBaseUrl: "https://api.github.test",
        publishPullRequests: false,
      },
      async (input, init) => {
        calls.push({ url: new URL(String(input)), ...(init === undefined ? {} : { init }) });
        return jsonResponse([
          {
            html_url: "https://github.com/octo-org/symphony/pull/12",
            number: 12,
            updated_at: "2026-01-01T00:00:00Z",
            head: {
              ref: "symphony/TEST-1",
              sha: "abc123",
              repo: { pushed_at: "2026-01-01T00:01:00Z" },
            },
          },
        ]);
      },
    );

    await expect(client.findOpenPullRequestByBranch({ branchName: " symphony/TEST-1 " })).resolves.toEqual({
      url: "https://github.com/octo-org/symphony/pull/12",
      number: 12,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:01:00Z",
    });
    expect(calls[0]?.url.pathname).toBe("/repos/octo-org/symphony/pulls");
    expect(calls[0]?.url.searchParams.get("state")).toBe("open");
    expect(calls[0]?.url.searchParams.get("head")).toBe("fork-owner:symphony/TEST-1");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer github-secret",
      accept: "application/vnd.github+json",
    });
  });

  it("returns null when GitHub discovery is not configured", async () => {
    const client = new GitHubPullRequestClient({
      owner: "octo-org",
      repo: "symphony",
      token: null,
      headOwner: "octo-org",
      apiBaseUrl: "https://api.github.com",
      publishPullRequests: false,
    });

    await expect(client.findOpenPullRequestByBranch({ branchName: "symphony/TEST-1" })).resolves.toBeNull();
  });

  it("rejects failed GitHub responses", async () => {
    const client = new GitHubPullRequestClient(
      {
        owner: "octo-org",
        repo: "symphony",
        token: "github-secret",
        headOwner: "octo-org",
        apiBaseUrl: "https://api.github.com",
        publishPullRequests: false,
      },
      async () => jsonResponse({ message: "bad credentials" }, 401),
    );

    await expect(client.findOpenPullRequestByBranch({ branchName: "symphony/TEST-1" })).rejects.toBeInstanceOf(
      SymphonyError,
    );
  });

  it("ingests PR reviews, review comments, and PR issue comments as review evidence", async () => {
    const calls: string[] = [];
    const client = new GitHubPullRequestClient(config(), async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/graphql") {
        expect(init?.method).toBe("POST");
        return graphQlThreadsResponse([
          {
            id: "PRRT_thread_1",
            isResolved: false,
            isOutdated: false,
            path: "src/core/orchestrator/Orchestrator.ts",
            line: 588,
            comments: { nodes: [{ databaseId: 2001 }] },
          },
        ]);
      }
      if (url.pathname.endsWith("/pulls/42/reviews")) {
        return jsonResponse([
          {
            id: 1001,
            html_url: "https://github.com/octo-org/symphony/pull/42#pullrequestreview-1001",
            pull_request_url: "https://api.github.test/repos/octo-org/symphony/pulls/42",
            state: "CHANGES_REQUESTED",
            body: "Please cover the retry path.",
            user: { login: "reviewer-a" },
            submitted_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:01Z",
          },
          { id: 1002, state: "APPROVED", body: "" },
        ]);
      }
      if (url.pathname.endsWith("/pulls/42/comments")) {
        return jsonResponse([
          {
            id: 2001,
            html_url: "https://github.com/octo-org/symphony/pull/42#discussion_r2001",
            pull_request_url: "https://api.github.test/repos/octo-org/symphony/pulls/42",
            pull_request_review_id: 1001,
            body: "This branch needs a test.",
            path: "src/core/orchestrator/Orchestrator.ts",
            line: 588,
            original_line: 580,
            side: "RIGHT",
            user: { login: "reviewer-a" },
            created_at: "2026-01-01T00:00:02Z",
            updated_at: "2026-01-01T00:00:03Z",
          },
        ]);
      }
      return jsonResponse([
        {
          id: 3001,
          html_url: "https://github.com/octo-org/symphony/pull/42#issuecomment-3001",
          body: "High-level PR concern.",
          user: { login: "reviewer-b" },
          created_at: "2026-01-01T00:00:04Z",
          updated_at: "2026-01-01T00:00:05Z",
        },
      ]);
    });

    const evidence = await client.listPullRequestReviewEvidence({ pullRequestNumber: 42 });

    expect(calls).toEqual([
      "/repos/octo-org/symphony/pulls/42/reviews",
      "/repos/octo-org/symphony/pulls/42/comments",
      "/repos/octo-org/symphony/issues/42/comments",
      "/graphql",
    ]);
    expect(evidence).toHaveLength(3);
    expect(evidence[0]).toMatchObject({
      source: "review",
      githubId: "1001",
      state: "CHANGES_REQUESTED",
      body: "Please cover the retry path.",
    });
    expect(evidence[1]).toMatchObject({
      source: "review_comment",
      path: "src/core/orchestrator/Orchestrator.ts",
      line: 588,
      originalLine: 580,
      threadId: "PRRT_thread_1",
      isResolved: false,
      isOutdated: false,
    });
    expect(evidence[2]).toMatchObject({
      source: "issue_comment",
      body: "High-level PR concern.",
    });
  });

  it("paginates every PR review evidence source and review thread metadata", async () => {
    const calls: string[] = [];
    const client = new GitHubPullRequestClient(config(), async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/graphql") {
        const variables = JSON.parse(String(init?.body)).variables as { after: string | null };
        if (variables.after === null) {
          return graphQlThreadsResponse(
            [
              {
                id: "PRRT_thread_page_1",
                isResolved: false,
                isOutdated: false,
                path: "src/a.ts",
                line: 10,
                comments: { nodes: [{ databaseId: 2101 }] },
              },
            ],
            { hasNextPage: true, endCursor: "cursor-2" },
          );
        }
        return graphQlThreadsResponse(
          [
            {
              id: "PRRT_thread_page_2",
              isResolved: true,
              isOutdated: false,
              path: "src/b.ts",
              line: 20,
              comments: { nodes: [{ databaseId: 2102 }] },
            },
          ],
          { hasNextPage: false, endCursor: null },
        );
      }
      if (url.pathname.endsWith("/pulls/42/reviews")) {
        if (url.searchParams.get("page") === "2") {
          return jsonResponse([{ id: 1102, state: "COMMENTED", body: "Second review.", submitted_at: "2026-01-01T00:00:02Z" }]);
        }
        return jsonResponse(
          [{ id: 1101, state: "CHANGES_REQUESTED", body: "First review.", submitted_at: "2026-01-01T00:00:01Z" }],
          200,
          { link: '<https://api.github.test/repos/octo-org/symphony/pulls/42/reviews?per_page=100&page=2>; rel="next"' },
        );
      }
      if (url.pathname.endsWith("/pulls/42/comments")) {
        if (url.searchParams.get("page") === "2") {
          return jsonResponse([
            {
              id: 2102,
              body: "Resolved second-page thread.",
              path: "src/b.ts",
              line: 20,
              html_url: "https://github.com/octo-org/symphony/pull/42#discussion_r2102",
              updated_at: "2026-01-01T00:00:04Z",
            },
          ]);
        }
        return jsonResponse(
          [
            {
              id: 2101,
              body: "Unresolved first-page thread.",
              path: "src/a.ts",
              line: 10,
              html_url: "https://github.com/octo-org/symphony/pull/42#discussion_r2101",
              updated_at: "2026-01-01T00:00:03Z",
            },
          ],
          200,
          { link: '<https://api.github.test/repos/octo-org/symphony/pulls/42/comments?per_page=100&page=2>; rel="next"' },
        );
      }
      if (url.searchParams.get("page") === "2") {
        return jsonResponse([{ id: 3102, body: "Second issue comment.", updated_at: "2026-01-01T00:00:06Z" }]);
      }
      return jsonResponse(
        [{ id: 3101, body: "First issue comment.", updated_at: "2026-01-01T00:00:05Z" }],
        200,
        { link: '<https://api.github.test/repos/octo-org/symphony/issues/42/comments?per_page=100&page=2>; rel="next"' },
      );
    });

    const evidence = await client.listPullRequestReviewEvidence({ pullRequestNumber: 42 });

    expect(calls).toEqual([
      "GET /repos/octo-org/symphony/pulls/42/reviews?per_page=100",
      "GET /repos/octo-org/symphony/pulls/42/comments?per_page=100",
      "GET /repos/octo-org/symphony/issues/42/comments?per_page=100",
      "POST /graphql",
      "GET /repos/octo-org/symphony/pulls/42/reviews?per_page=100&page=2",
      "GET /repos/octo-org/symphony/pulls/42/comments?per_page=100&page=2",
      "GET /repos/octo-org/symphony/issues/42/comments?per_page=100&page=2",
      "POST /graphql",
    ]);
    expect(evidence.map((item) => `${item.source}:${item.githubId}`)).toEqual([
      "review:1101",
      "review:1102",
      "review_comment:2101",
      "review_comment:2102",
      "issue_comment:3101",
      "issue_comment:3102",
    ]);
    expect(evidence.find((item) => item.githubId === "2101")).toMatchObject({
      threadId: "PRRT_thread_page_1",
      isResolved: false,
      isOutdated: false,
    });
    expect(evidence.find((item) => item.githubId === "2102")).toMatchObject({
      threadId: "PRRT_thread_page_2",
      isResolved: true,
      isOutdated: false,
    });
  });

  it("reuses an existing open pull request without creating a duplicate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-reuse-"));
    try {
      const workspace = await initPublishRepo(root);
      const calls: string[] = [];
      const client = new GitHubPullRequestClient(config(), async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return jsonResponse([
          {
            html_url: "https://github.com/octo-org/symphony/pull/44",
            number: 44,
            head: { ref: "symphony/TEST-1", sha: "remote-sha", repo: { pushed_at: "2026-01-01T00:00:00Z" } },
          },
        ]);
      });

      const result = await client.publishPullRequest({
        workspacePath: workspace,
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        title: "TEST-1: Work",
        body: "body",
        evidenceCursor: "idem-1",
      });

      expect(result).toMatchObject({
        action: "reused",
        url: "https://github.com/octo-org/symphony/pull/44",
        number: 44,
        headBranch: "symphony/TEST-1",
        evidenceCursor: "idem-1",
      });
      expect(calls).toEqual(["GET /repos/octo-org/symphony/pulls"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits, pushes, and creates a pull request when none exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-create-"));
    try {
      const workspace = await initPublishRepo(root, { remote: true });
      await writeFile(path.join(workspace, "feature.txt"), "changed\n", "utf8");
      const calls: Array<{ method: string; pathname: string; body: unknown }> = [];
      const client = new GitHubPullRequestClient(config(), async (input, init) => {
        const url = new URL(String(input));
        calls.push({
          method: init?.method ?? "GET",
          pathname: url.pathname,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        if (init?.method === "POST") {
          return jsonResponse(
            {
              html_url: "https://github.com/octo-org/symphony/pull/45",
              number: 45,
              head: { ref: "symphony/TEST-1", sha: "created-sha", repo: { pushed_at: "2026-01-01T00:00:01Z" } },
            },
            201,
          );
        }
        return jsonResponse([]);
      });

      const result = await client.publishPullRequest({
        workspacePath: workspace,
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        title: "TEST-1: Work",
        body: "body",
        evidenceCursor: "idem-1",
      });

      expect(result.action).toBe("created");
      expect(result.url).toBe("https://github.com/octo-org/symphony/pull/45");
      expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
        "GET /repos/octo-org/symphony/pulls",
        "POST /repos/octo-org/symphony/pulls",
      ]);
      expect(calls[1]?.body).toMatchObject({
        head: "symphony/TEST-1",
        base: "main",
        title: "TEST-1: Work",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects PR publication when the worktree has no diff and no existing PR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-no-diff-"));
    try {
      const workspace = await initPublishRepo(root);
      const client = new GitHubPullRequestClient(config(), async () => jsonResponse([]));

      await expect(
        client.publishPullRequest({
          workspacePath: workspace,
          branchName: "symphony/TEST-1",
          baseBranch: "main",
          title: "TEST-1: Work",
          body: "body",
          evidenceCursor: "idem-1",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects PR publication when the branch push fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-push-fail-"));
    try {
      const workspace = await initPublishRepo(root);
      await git(["remote", "add", "origin", path.join(root, "missing.git")], workspace);
      await writeFile(path.join(workspace, "feature.txt"), "changed\n", "utf8");
      const client = new GitHubPullRequestClient(config(), async () => jsonResponse([]));

      await expect(
        client.publishPullRequest({
          workspacePath: workspace,
          branchName: "symphony/TEST-1",
          baseBranch: "main",
          title: "TEST-1: Work",
          body: "body",
          evidenceCursor: "idem-1",
        }),
      ).rejects.toThrow(/push failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects PR publication when GitHub credentials are missing", async () => {
    const client = new GitHubPullRequestClient({
      owner: "octo-org",
      repo: "symphony",
      token: null,
      headOwner: "octo-org",
      apiBaseUrl: "https://api.github.com",
      publishPullRequests: true,
    });

    await expect(
      client.publishPullRequest({
        workspacePath: "/tmp/nope",
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        title: "TEST-1: Work",
        body: "body",
        evidenceCursor: "idem-1",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("uses review-evidence wording when PR review evidence credentials are missing", async () => {
    const client = new GitHubPullRequestClient({
      owner: "octo-org",
      repo: "symphony",
      token: null,
      headOwner: "octo-org",
      apiBaseUrl: "https://api.github.com",
      publishPullRequests: false,
    });

    await expect(client.listPullRequestReviewEvidence({ pullRequestNumber: 42 })).rejects.toThrow(
      /PR review evidence ingestion/,
    );
  });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function graphQlThreadsResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
): Response {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo,
            nodes,
          },
        },
      },
    },
  });
}

function config() {
  return {
    owner: "octo-org",
    repo: "symphony",
    token: "github-secret",
    headOwner: "octo-org",
    apiBaseUrl: "https://api.github.test",
    publishPullRequests: true,
  };
}

async function initPublishRepo(root: string, options: { remote?: boolean } = {}): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await git(["init"], workspace);
  await git(["checkout", "-b", "main"], workspace);
  await writeFile(path.join(workspace, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], workspace);
  await git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.com", "commit", "-m", "initial"], workspace);
  if (options.remote) {
    const remote = path.join(root, "remote.git");
    await git(["init", "--bare", remote], root);
    await git(["remote", "add", "origin", remote], workspace);
  }
  await git(["checkout", "-b", "symphony/TEST-1"], workspace);
  return workspace;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited with ${code}: ${stderr}`));
    });
  });
}
