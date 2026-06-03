import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { evaluateAgentCommandPolicy, type AgentCommandPolicyDecision } from "../src/core/harness/AgentCommandPolicy.js";
import { GitHubPullRequestClient } from "../src/integrations/github/GitHubPullRequestClient.js";
import { executeCodePolicyInput, terminalPolicyInput } from "./agent-command-policy-fixtures.js";

interface RecordedGitHubRequest {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  body: unknown;
}

interface TerminalBoundaryCase {
  name: string;
  role: "worker" | "reviewer";
  command: string;
  commandClass: string;
  normalizedExecutable: string;
  targetHosts?: readonly string[];
}

interface ExecuteCodeBoundaryCase {
  name: string;
  role: "worker" | "reviewer";
  code: string;
  commandClass: string;
  targetHosts?: readonly string[];
}

describe("GitHub mergeability and CI service command-policy boundary", () => {
  it("keeps mergeability and CI service source paths free of AgentCommandPolicy coupling", async () => {
    await expectServiceSourceOutsideAgentPolicy([
      "../src/core/merge/MergePolicyService.ts",
      "../src/integrations/github/GitHubPullRequestClient.ts",
      "../src/integrations/github/GitHubCredentialResolver.ts",
    ]);
  });

  it("performs service-owned mergeability, required-check, and merge requests with merge credentials", async () => {
    const requests: RecordedGitHubRequest[] = [];
    const client = new GitHubPullRequestClient(
      {
        owner: "acme",
        repo: "symphony",
        token: "merge-secret",
        headOwner: "acme",
        apiBaseUrl: "https://api.github.test",
        publishPullRequests: false,
      },
      async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = parseJsonBody(init?.body);
        requests.push({
          method,
          path: url.pathname,
          search: url.search,
          authorization: headerValue(init?.headers, "authorization"),
          body,
        });

        if (method === "GET" && url.pathname === "/repos/acme/symphony/pulls/42") {
          return jsonResponse({
            html_url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            merge_commit_sha: null,
            merged_at: null,
            merged_by: null,
            updated_at: "2026-06-01T00:00:00Z",
            head: { ref: "sinfonista/ENG-274", sha: "head-sha-1", repo: { pushed_at: "2026-06-01T00:01:00Z" } },
            base: { ref: "main", sha: "base-sha-1" },
          });
        }

        if (method === "GET" && url.pathname === "/repos/acme/symphony/commits/head-sha-1/status") {
          return jsonResponse({
            statuses: [
              {
                context: "ci/test",
                state: "success",
                target_url: "https://ci.example.test/build/1",
                created_at: "2026-06-01T00:02:00Z",
              },
            ],
          });
        }

        if (method === "GET" && url.pathname === "/repos/acme/symphony/commits/head-sha-1/check-runs") {
          return jsonResponse({
            check_runs: [
              {
                id: 1001,
                name: "lint",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/acme/symphony/actions/runs/1001",
                completed_at: "2026-06-01T00:03:00Z",
              },
            ],
          });
        }

        if (method === "PUT" && url.pathname === "/repos/acme/symphony/pulls/42/merge") {
          expect(body).toEqual({ sha: "head-sha-1", merge_method: "squash" });
          return jsonResponse({ merged: true, sha: "merge-sha-1" });
        }

        if (method === "GET" && url.pathname === "/user") {
          return jsonResponse({ login: "symphony-merge-bot" });
        }

        throw new Error(`Unexpected GitHub request in service-boundary test: ${method} ${url.pathname}${url.search}`);
      },
    );

    await expect(client.getPullRequest({ pullRequestNumber: 42 })).resolves.toMatchObject({
      number: 42,
      mergeable: true,
      mergeableState: "clean",
      headSha: "head-sha-1",
      baseBranch: "main",
      baseHeadSha: "base-sha-1",
    });
    await expect(client.getRequiredCheckResults({ headSha: "head-sha-1", requiredChecks: ["ci/test", "lint"] })).resolves.toEqual([
      { name: "ci/test", status: "success", conclusion: "success", url: "https://ci.example.test/build/1" },
      { name: "lint", status: "success", conclusion: "success", url: "https://github.com/acme/symphony/actions/runs/1001" },
    ]);
    await expect(
      client.mergePullRequest({ pullRequestNumber: 42, expectedHeadSha: "head-sha-1", method: "squash" }),
    ).resolves.toMatchObject({ merged: true, mergeCommitSha: "merge-sha-1", mergedBy: "symphony-merge-bot" });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /repos/acme/symphony/pulls/42",
      "GET /repos/acme/symphony/commits/head-sha-1/status",
      "GET /repos/acme/symphony/commits/head-sha-1/check-runs",
      "PUT /repos/acme/symphony/pulls/42/merge",
      "GET /user",
    ]);
    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer merge-secret",
      "Bearer merge-secret",
      "Bearer merge-secret",
      "Bearer merge-secret",
      "Bearer merge-secret",
    ]);
    expect(requests.find((request) => request.path.endsWith("/status"))?.search).toBe("?per_page=100");
    expect(requests.find((request) => request.path.endsWith("/check-runs"))?.search).toBe("?per_page=100");
  });

  it.each([
    {
      name: "mergeability status rollup",
      command: "gh pr view 42 --json mergeable,mergeStateStatus,statusCheckRollup",
      normalizedExecutable: "gh",
    },
    {
      name: "required PR checks",
      command: "gh pr checks 42 --required",
      normalizedExecutable: "gh",
    },
    {
      name: "commit status API read",
      command: "gh api repos/acme/symphony/commits/head-sha-1/status",
      normalizedExecutable: "gh",
    },
    {
      name: "commit status API write",
      command: "gh api -X POST repos/acme/symphony/statuses/head-sha-1 -f state=success -f context=ci/test",
      normalizedExecutable: "gh",
    },
    {
      name: "service PR merge write",
      command: "gh pr merge 42 --squash --match-head-commit head-sha-1",
      normalizedExecutable: "gh",
    },
  ])("allows service-owned $name command context outside worker/reviewer policy", ({ command, normalizedExecutable }) => {
    const decision = evaluateAgentCommandPolicy(
      terminalPolicyInput(command, {
        role: "service",
        phase: "implementation",
        environment: { keysOnly: ["GITHUB_MERGE_TOKEN"] },
      }),
    );

    expect(decision).toMatchObject({
      outcome: "allow",
      reasonKind: "role_not_restricted",
      commandClass: "role_not_restricted",
      audit: {
        role: "service",
        normalizedExecutable,
        upstreamContactAttempted: false,
      },
    });
  });

  it.each<TerminalBoundaryCase>([
    {
      name: "worker mergeability status rollup",
      role: "worker",
      command: "gh pr view 42 --json mergeable,mergeStateStatus,statusCheckRollup",
      commandClass: "github_cli",
      normalizedExecutable: "gh",
    },
    {
      name: "reviewer required PR checks",
      role: "reviewer",
      command: "gh pr checks 42 --required",
      commandClass: "github_cli",
      normalizedExecutable: "gh",
    },
    {
      name: "worker commit status API read",
      role: "worker",
      command: "gh api repos/acme/symphony/commits/head-sha-1/status",
      commandClass: "github_cli",
      normalizedExecutable: "gh",
    },
    {
      name: "reviewer check-run API read",
      role: "reviewer",
      command: "curl https://api.github.com/repos/acme/symphony/commits/head-sha-1/check-runs",
      commandClass: "curl_github_request",
      normalizedExecutable: "curl",
      targetHosts: ["api.github.com"],
    },
    {
      name: "worker commit status API write",
      role: "worker",
      command: "gh api -X POST repos/acme/symphony/statuses/head-sha-1 -f state=success -f context=ci/test",
      commandClass: "github_cli",
      normalizedExecutable: "gh",
    },
    {
      name: "reviewer PR merge write",
      role: "reviewer",
      command: "gh pr merge 42 --squash --match-head-commit head-sha-1",
      commandClass: "github_cli",
      normalizedExecutable: "gh",
    },
  ])("denies direct terminal mergeability/CI attempt: $name", (testCase) => {
    const decision = evaluateAgentCommandPolicy(
      terminalPolicyInput(testCase.command, {
        role: testCase.role,
        phase: testCase.role === "reviewer" ? "review" : "implementation",
        environment: { keysOnly: ["GITHUB_MERGE_TOKEN"] },
      }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: testCase.commandClass,
      audit: {
        role: testCase.role,
        normalizedExecutable: testCase.normalizedExecutable,
        upstreamContactAttempted: false,
      },
    });
    if (testCase.targetHosts) expect(decision.audit.targetHosts).toEqual(testCase.targetHosts);
    expectServiceWorkflowGuidance(decision);
  });

  it.each<ExecuteCodeBoundaryCase>([
    {
      name: "worker subprocess PR checks",
      role: "worker",
      code: 'import subprocess\nsubprocess.run(["gh", "pr", "checks", "42", "--required"], check=True)',
      commandClass: "execute_code_subprocess_github_cli",
    },
    {
      name: "reviewer subprocess commit status write",
      role: "reviewer",
      code:
        'import subprocess\nsubprocess.run(["gh", "api", "-X", "POST", "repos/acme/symphony/statuses/head-sha-1", "-f", "state=success", "-f", "context=ci/test"], check=True)',
      commandClass: "execute_code_subprocess_github_cli",
    },
    {
      name: "worker direct check-run API client",
      role: "worker",
      code: 'import requests\nrequests.get("https://api.github.com/repos/acme/symphony/commits/head-sha-1/check-runs")',
      commandClass: "execute_code_python_network_github_request",
      targetHosts: ["api.github.com"],
    },
  ])("denies direct execute_code mergeability/CI attempt: $name", (testCase) => {
    const decision = evaluateAgentCommandPolicy(
      executeCodePolicyInput(testCase.code, {
        role: testCase.role,
        phase: testCase.role === "reviewer" ? "review" : "implementation",
        environment: { keysOnly: ["GITHUB_MERGE_TOKEN"] },
      }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: testCase.commandClass,
      audit: {
        role: testCase.role,
        surface: "execute_code",
        upstreamContactAttempted: false,
      },
    });
    if (testCase.targetHosts) expect(decision.audit.targetHosts).toEqual(testCase.targetHosts);
    expectServiceWorkflowGuidance(decision);
  });
});

async function expectServiceSourceOutsideAgentPolicy(relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    expect(source, relativePath).not.toMatch(/AgentCommandPolicy|evaluateAgentCommandPolicy|agent-command-policy/);
  }
}

function expectServiceWorkflowGuidance(decision: AgentCommandPolicyDecision): void {
  expect(decision.message).toContain("Symphony service-owned workflow actions");
  expect(decision.message).toContain("mergeability, and CI checks");
}

function parseJsonBody(body: RequestInit["body"] | undefined): unknown {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function headerValue(headers: RequestInit["headers"] | undefined, key: string): string | null {
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(key);
  if (Array.isArray(headers)) {
    const entry = headers.find(([header]) => header.toLowerCase() === key.toLowerCase());
    return entry?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record[key] ?? record[key.toLowerCase()] ?? null;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
