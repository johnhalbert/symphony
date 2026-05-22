import { spawn } from "node:child_process";
import type { GitHubConfig } from "../../core/config/Config.js";
import { SymphonyError } from "../../core/errors.js";

type FetchLike = typeof fetch;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export interface PullRequestBranchLookup {
  branchName: string;
  baseBranch?: string | null;
}

export interface PullRequestMetadata {
  url: string;
  number: number;
  headBranch: string;
  headSha: string | null;
  lastPushedAt: string | null;
}

export interface PullRequestPublicationInput {
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  evidenceCursor: string;
}

export interface PullRequestPublicationResult extends PullRequestMetadata {
  headSha: string;
  action: "reused" | "created";
  evidenceCursor: string;
}

export type GitHubPullRequestReviewEvidenceSource = "review" | "review_comment" | "issue_comment";

export interface GitHubPullRequestReviewEvidence {
  source: GitHubPullRequestReviewEvidenceSource;
  githubId: string;
  pullRequestNumber: number;
  pullRequestUrl: string | null;
  url: string | null;
  reviewer: string | null;
  body: string;
  state: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  threadId: string | null;
  inReplyToId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
}

export interface PullRequestReviewEvidenceLookup {
  pullRequestNumber: number;
}

interface GitHubPullRequestNode {
  html_url?: unknown;
  number?: unknown;
  updated_at?: unknown;
  head?: {
    ref?: unknown;
    sha?: unknown;
    repo?: {
      pushed_at?: unknown;
    } | null;
  } | null;
}

interface GitHubUserNode {
  login?: unknown;
}

interface GitHubReviewNode {
  id?: unknown;
  node_id?: unknown;
  html_url?: unknown;
  pull_request_url?: unknown;
  body?: unknown;
  state?: unknown;
  user?: GitHubUserNode | null;
  submitted_at?: unknown;
  updated_at?: unknown;
}

interface GitHubReviewCommentNode {
  id?: unknown;
  node_id?: unknown;
  html_url?: unknown;
  pull_request_url?: unknown;
  pull_request_review_id?: unknown;
  body?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  side?: unknown;
  in_reply_to_id?: unknown;
  user?: GitHubUserNode | null;
  created_at?: unknown;
  updated_at?: unknown;
  resolved?: unknown;
  is_resolved?: unknown;
  outdated?: unknown;
  is_outdated?: unknown;
}

interface GitHubIssueCommentNode {
  id?: unknown;
  node_id?: unknown;
  html_url?: unknown;
  body?: unknown;
  user?: GitHubUserNode | null;
  created_at?: unknown;
  updated_at?: unknown;
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
    const baseBranch = normalizeBaseBranch(input.baseBranch ?? null);

    const headOwner = this.config.headOwner ?? this.config.owner;
    if (!headOwner) return null;
    const url = new URL(
      `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}/pulls`,
      normalizedApiBaseUrl(this.config.apiBaseUrl),
    );
    url.searchParams.set("state", "open");
    url.searchParams.set("head", `${headOwner}:${branchName}`);
    if (baseBranch !== null) url.searchParams.set("base", baseBranch);
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

  async listPullRequestReviewEvidence(input: PullRequestReviewEvidenceLookup): Promise<GitHubPullRequestReviewEvidence[]> {
    this.assertConfiguredForPublication();
    if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
      throw new SymphonyError("invalid_request", "A valid pull request number is required for review evidence ingestion");
    }

    const [reviews, reviewComments, issueComments] = await Promise.all([
      this.fetchJsonArray<GitHubReviewNode>(`pulls/${input.pullRequestNumber}/reviews`),
      this.fetchJsonArray<GitHubReviewCommentNode>(`pulls/${input.pullRequestNumber}/comments`),
      this.fetchJsonArray<GitHubIssueCommentNode>(`issues/${input.pullRequestNumber}/comments`),
    ]);
    return [
      ...reviews
        .map((review) => normalizeReview(review, input.pullRequestNumber))
        .filter((item): item is GitHubPullRequestReviewEvidence => item !== null),
      ...reviewComments
        .map((comment) => normalizeReviewComment(comment, input.pullRequestNumber))
        .filter((item): item is GitHubPullRequestReviewEvidence => item !== null),
      ...issueComments
        .map((comment) => normalizeIssueComment(comment, input.pullRequestNumber))
        .filter((item): item is GitHubPullRequestReviewEvidence => item !== null),
    ].sort(compareEvidence);
  }

  async publishPullRequest(input: PullRequestPublicationInput): Promise<PullRequestPublicationResult> {
    this.assertConfiguredForPublication();
    const token = this.config.token ?? "";
    const branchName = normalizeBranchName(input.branchName);
    assertSafePublishBranch(branchName);
    const baseBranch = normalizeBaseBranch(input.baseBranch) ?? input.baseBranch.trim();
    if (baseBranch.length === 0) {
      throw new SymphonyError("invalid_request", "A base branch is required for GitHub PR publication");
    }

    const existing = await this.findOpenPullRequestByBranch({ branchName, baseBranch });
    const git = new GitWorktreePublisher(input.workspacePath);
    await git.assertCurrentBranch(branchName);

    const dirty = await git.hasCommittableChanges();
    const branchDiffBeforeCommit = await git.hasBranchDiff(baseBranch);
    if (!existing && !dirty && !branchDiffBeforeCommit) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report cannot be accepted because the worktree branch has no committable changes",
      );
    }

    if (dirty) {
      await git.commitAll(input.title, input.body);
    }

    const branchDiffAfterCommit = dirty ? await git.hasBranchDiff(baseBranch) : branchDiffBeforeCommit;
    if (!existing && !branchDiffAfterCommit) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report cannot be accepted because the worktree branch has no code changes relative to the base branch",
      );
    }

    if (dirty || branchDiffAfterCommit) {
      await git.pushBranch(branchName, token);
    }
    const headSha = await git.headSha();

    if (existing) {
      return {
        ...existing,
        headSha,
        action: "reused",
        evidenceCursor: input.evidenceCursor,
      };
    }

    const created = await this.createPullRequest({
      branchName,
      baseBranch,
      title: input.title,
      body: input.body,
    });
    return {
      ...created,
      headSha,
      action: "created",
      evidenceCursor: input.evidenceCursor,
    };
  }

  async checkRepositoryAccess(): Promise<void> {
    this.assertConfiguredForPublication();
    const response = await this.fetchImpl(
      new URL(
        `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}`,
        normalizedApiBaseUrl(this.config.apiBaseUrl),
      ),
      {
        method: "GET",
        headers: requestHeaders(this.config.token ?? ""),
      },
    );
    if (!response.ok) {
      throw new SymphonyError("tracker_error", `GitHub repository access returned HTTP ${response.status}`);
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.config.owner && this.config.repo && this.config.token);
  }

  private assertConfiguredForPublication(): void {
    if (!this.config.owner || !this.config.repo || !this.config.token) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token are required when PR publication is enabled",
      );
    }
  }

  private async createPullRequest(input: {
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestMetadata> {
    const response = await this.fetchImpl(
      new URL(
        `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}/pulls`,
        normalizedApiBaseUrl(this.config.apiBaseUrl),
      ),
      {
        method: "POST",
        headers: {
          ...requestHeaders(this.config.token ?? ""),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: pullRequestHeadRef(this.config, input.branchName),
          base: input.baseBranch,
          maintainer_can_modify: false,
        }),
      },
    );

    if (!response.ok) {
      if (response.status === 422) {
        const raced = await this.findOpenPullRequestByBranch({
          branchName: input.branchName,
          baseBranch: input.baseBranch,
        });
        if (raced) return raced;
      }
      throw new SymphonyError("tracker_error", `GitHub PR creation returned HTTP ${response.status}`);
    }

    const pullRequest = normalizePullRequest((await response.json()) as GitHubPullRequestNode);
    if (!pullRequest) throw new SymphonyError("tracker_error", "GitHub PR creation response is invalid");
    return pullRequest;
  }

  private async fetchJsonArray<T>(repoPath: string): Promise<T[]> {
    const response = await this.fetchImpl(
      new URL(
        `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}/${repoPath}`,
        normalizedApiBaseUrl(this.config.apiBaseUrl),
      ),
      {
        method: "GET",
        headers: requestHeaders(this.config.token ?? ""),
      },
    );
    if (!response.ok) {
      throw new SymphonyError("tracker_error", `GitHub PR review evidence returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new SymphonyError("tracker_error", "GitHub PR review evidence response is invalid");
    }
    return body as T[];
  }
}

function normalizePullRequest(node: GitHubPullRequestNode): PullRequestMetadata | null {
  const url = asString(node.html_url);
  const number = typeof node.number === "number" && Number.isInteger(node.number) ? node.number : null;
  const headBranch = asString(node.head?.ref);
  const headSha = asNullableString(node.head?.sha);
  if (!url || number === null || !headBranch) return null;
  return {
    url,
    number,
    headBranch,
    headSha,
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

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumberString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeReview(node: GitHubReviewNode, pullRequestNumber: number): GitHubPullRequestReviewEvidence | null {
  const githubId = asNumberString(node.id) ?? asString(node.node_id);
  const body = asNonEmptyString(node.body);
  const state = asNullableString(node.state);
  if (!githubId || !body) return null;
  return {
    source: "review",
    githubId,
    pullRequestNumber,
    pullRequestUrl: asNullableString(node.pull_request_url),
    url: asNullableString(node.html_url),
    reviewer: asNullableString(node.user?.login),
    body,
    state,
    path: null,
    line: null,
    originalLine: null,
    side: null,
    threadId: null,
    inReplyToId: null,
    isResolved: null,
    isOutdated: null,
    createdAt: asNullableString(node.submitted_at),
    updatedAt: asNullableString(node.updated_at) ?? asNullableString(node.submitted_at),
    submittedAt: asNullableString(node.submitted_at),
  };
}

function normalizeReviewComment(
  node: GitHubReviewCommentNode,
  pullRequestNumber: number,
): GitHubPullRequestReviewEvidence | null {
  const githubId = asNumberString(node.id) ?? asString(node.node_id);
  const body = asNonEmptyString(node.body);
  if (!githubId || !body) return null;
  const reviewId = asNumberString(node.pull_request_review_id);
  const path = asNullableString(node.path);
  return {
    source: "review_comment",
    githubId,
    pullRequestNumber,
    pullRequestUrl: asNullableString(node.pull_request_url),
    url: asNullableString(node.html_url),
    reviewer: asNullableString(node.user?.login),
    body,
    state: null,
    path,
    line: asNullableNumber(node.line),
    originalLine: asNullableNumber(node.original_line),
    side: asNullableString(node.side),
    threadId: reviewId && path ? `${reviewId}:${path}:${asNullableNumber(node.original_line) ?? asNullableNumber(node.line) ?? githubId}` : null,
    inReplyToId: asNumberString(node.in_reply_to_id),
    isResolved: asNullableBoolean(node.is_resolved) ?? asNullableBoolean(node.resolved),
    isOutdated: asNullableBoolean(node.is_outdated) ?? asNullableBoolean(node.outdated),
    createdAt: asNullableString(node.created_at),
    updatedAt: asNullableString(node.updated_at) ?? asNullableString(node.created_at),
    submittedAt: null,
  };
}

function normalizeIssueComment(
  node: GitHubIssueCommentNode,
  pullRequestNumber: number,
): GitHubPullRequestReviewEvidence | null {
  const githubId = asNumberString(node.id) ?? asString(node.node_id);
  const body = asNonEmptyString(node.body);
  if (!githubId || !body) return null;
  return {
    source: "issue_comment",
    githubId,
    pullRequestNumber,
    pullRequestUrl: null,
    url: asNullableString(node.html_url),
    reviewer: asNullableString(node.user?.login),
    body,
    state: null,
    path: null,
    line: null,
    originalLine: null,
    side: null,
    threadId: null,
    inReplyToId: null,
    isResolved: null,
    isOutdated: null,
    createdAt: asNullableString(node.created_at),
    updatedAt: asNullableString(node.updated_at) ?? asNullableString(node.created_at),
    submittedAt: null,
  };
}

function compareEvidence(left: GitHubPullRequestReviewEvidence, right: GitHubPullRequestReviewEvidence): number {
  return evidenceTimestamp(left).localeCompare(evidenceTimestamp(right)) || left.source.localeCompare(right.source) || left.githubId.localeCompare(right.githubId);
}

function evidenceTimestamp(item: GitHubPullRequestReviewEvidence): string {
  return item.updatedAt ?? item.submittedAt ?? item.createdAt ?? "";
}

function requestHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "symphony",
    "x-github-api-version": "2022-11-28",
  };
}

function normalizeBranchName(value: string): string {
  const branchName = value.trim();
  if (branchName.length === 0) throw new SymphonyError("invalid_request", "A branch name is required for PR publication");
  return branchName;
}

function normalizeBaseBranch(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return trimmed.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function assertSafePublishBranch(branchName: string): void {
  const normalized = branchName.toLowerCase();
  if (normalized === "main" || normalized === "master") {
    throw new SymphonyError("invalid_request", `Refusing to publish protected branch: ${branchName}`);
  }
}

function pullRequestHeadRef(config: GitHubConfig, branchName: string): string {
  const headOwner = config.headOwner ?? config.owner;
  return headOwner && headOwner !== config.owner ? `${headOwner}:${branchName}` : branchName;
}

class GitWorktreePublisher {
  constructor(private readonly workspacePath: string) {}

  async assertCurrentBranch(branchName: string): Promise<void> {
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current !== branchName) {
      throw new SymphonyError("invalid_request", `Worktree is on ${current || "detached HEAD"}, not ${branchName}`);
    }
  }

  async hasCommittableChanges(): Promise<boolean> {
    return (await this.git(["status", "--porcelain"])).stdout.trim().length > 0;
  }

  async hasBranchDiff(baseBranch: string): Promise<boolean> {
    const baseRef = await this.resolveBaseRef(baseBranch);
    const result = await this.git(["diff", "--quiet", `${baseRef}...HEAD`], { allowFailure: true });
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    throw new SymphonyError("invalid_request", `Unable to compare worktree branch to ${baseBranch}`);
  }

  async commitAll(title: string, body: string): Promise<void> {
    await this.git(["add", "-A"]);
    const stagedDiff = await this.git(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (stagedDiff.code === 0) return;
    if (stagedDiff.code !== 1) {
      throw new SymphonyError("invalid_request", "Unable to inspect staged completion-report changes");
    }
    await this.git([
      "-c",
      "user.name=Symphony",
      "-c",
      "user.email=symphony@users.noreply.github.com",
      "commit",
      "-m",
      title,
      "-m",
      body,
    ]);
  }

  async pushBranch(branchName: string, token: string): Promise<void> {
    const result = await this.git(
      [
        "-c",
        `http.extraheader=AUTHORIZATION: bearer ${token}`,
        "push",
        "origin",
        `HEAD:refs/heads/${branchName}`,
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) {
      throw new SymphonyError("tracker_error", `GitHub branch push failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async headSha(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  private async resolveBaseRef(baseBranch: string): Promise<string> {
    const candidates = [baseBranch, `origin/${baseBranch}`];
    for (const candidate of candidates) {
      const result = await this.git(["rev-parse", "--verify", `${candidate}^{commit}`], { allowFailure: true });
      if (result.code === 0) return candidate;
    }
    throw new SymphonyError("invalid_request", `Unable to resolve PR base branch: ${baseBranch}`);
  }

  private git(args: string[], options: { allowFailure?: boolean } = {}): Promise<GitResult> {
    return runCommand("git", args, this.workspacePath, DEFAULT_GIT_TIMEOUT_MS, options);
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { allowFailure?: boolean },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 64_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(new Error(`git exited with ${result.code}: ${stderr}`));
      }
    });
  });
}
