import type { GitHubConfig } from "../../core/config/Config.js";
import { SymphonyError } from "../../core/errors.js";

type FetchLike = typeof fetch;

export interface PullRequestBranchLookup {
  branchName: string;
}

export interface PullRequestMetadata {
  url: string;
  number: number;
  headBranch: string;
  lastPushedAt: string | null;
}

interface GitHubPullRequestNode {
  html_url?: unknown;
  number?: unknown;
  updated_at?: unknown;
  head?: {
    ref?: unknown;
    repo?: {
      pushed_at?: unknown;
    } | null;
  } | null;
}

export class GitHubPullRequestClient {
  constructor(
    private readonly config: GitHubConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async findOpenPullRequestByBranch(input: PullRequestBranchLookup): Promise<PullRequestMetadata | null> {
    if (!this.isConfigured()) return null;
    const branchName = input.branchName.trim();
    if (branchName.length === 0) return null;

    const headOwner = this.config.headOwner ?? this.config.owner;
    if (!headOwner) return null;
    const url = new URL(
      `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}/pulls`,
      normalizedApiBaseUrl(this.config.apiBaseUrl),
    );
    url.searchParams.set("state", "open");
    url.searchParams.set("head", `${headOwner}:${branchName}`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "10");

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.config.token}`,
        "user-agent": "symphony",
        "x-github-api-version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new SymphonyError("tracker_error", `GitHub PR discovery returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new SymphonyError("tracker_error", "GitHub PR discovery response is invalid");
    }

    return body.map(normalizePullRequest).find((pr): pr is PullRequestMetadata => pr !== null) ?? null;
  }

  private isConfigured(): boolean {
    return Boolean(this.config.owner && this.config.repo && this.config.token);
  }
}

function normalizePullRequest(node: GitHubPullRequestNode): PullRequestMetadata | null {
  const url = asString(node.html_url);
  const number = typeof node.number === "number" && Number.isInteger(node.number) ? node.number : null;
  const headBranch = asString(node.head?.ref);
  if (!url || number === null || !headBranch) return null;
  return {
    url,
    number,
    headBranch,
    lastPushedAt: asNullableString(node.head?.repo?.pushed_at) ?? asNullableString(node.updated_at),
  };
}

function normalizedApiBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
