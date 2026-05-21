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
      },
      async () => jsonResponse({ message: "bad credentials" }, 401),
    );

    await expect(client.findOpenPullRequestByBranch({ branchName: "symphony/TEST-1" })).rejects.toBeInstanceOf(
      SymphonyError,
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
