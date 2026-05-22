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

interface GraphQlPageInfoNode {
  hasNextPage?: unknown;
  endCursor?: unknown;
}

interface GraphQlReviewThreadCommentNode {
  databaseId?: unknown;
}

interface GraphQlReviewThreadNode {
  id?: unknown;
  isResolved?: unknown;
  isOutdated?: unknown;
  path?: unknown;
  line?: unknown;
  comments?: {
    nodes?: unknown;
  } | null;
}

interface GraphQlReviewThreadResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: GraphQlPageInfoNode | null;
          nodes?: unknown;
        } | null;
      } | null;
    } | null;
  } | null;
  errors?: unknown;
}

interface PullRequestReviewThreadMetadata {
  threadId: string;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  path: string | null;
  line: number | null;
  commentDatabaseIds: string[];
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
    this.assertConfiguredForReviewEvidenceRead();
    if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
      throw new SymphonyError("invalid_request", "A valid pull request number is required for review evidence ingestion");
    }

    const [reviews, reviewComments, issueComments, reviewThreads] = await Promise.all([
      this.fetchPaginatedJsonArray<GitHubReviewNode>(`pulls/${input.pullRequestNumber}/reviews`),
      this.fetchPaginatedJsonArray<GitHubReviewCommentNode>(`pulls/${input.pullRequestNumber}/comments`),
      this.fetchPaginatedJsonArray<GitHubIssueCommentNode>(`issues/${input.pullRequestNumber}/comments`),
      this.fetchReviewThreadMetadata(input.pullRequestNumber),
    ]);
    const threadByCommentId = reviewThreadMetadataByCommentId(reviewThreads);
    return [
      ...reviews
        .map((review) => normalizeReview(review, input.pullRequestNumber))
        .filter((item): item is GitHubPullRequestReviewEvidence => item !== null),
      ...reviewComments
        .map((comment) => normalizeReviewComment(comment, input.pullRequestNumber, threadByCommentId.get(asNumberString(comment.id) ?? "")))
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

  private assertConfiguredForReviewEvidenceRead(): void {
    if (!this.config.owner || !this.config.repo || !this.config.token) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token are required for PR review evidence ingestion",
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

  private async fetchPaginatedJsonArray<T>(repoPath: string): Promise<T[]> {
    const firstUrl = new URL(
      `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}/${repoPath}`,
      normalizedApiBaseUrl(this.config.apiBaseUrl),
    );
    firstUrl.searchParams.set("per_page", "100");
    const items: T[] = [];
    let nextUrl: URL | null = firstUrl;
    while (nextUrl) {
      const response = await this.fetchImpl(nextUrl, {
        method: "GET",
        headers: requestHeaders(this.config.token ?? ""),
      });
      if (!response.ok) {
        throw new SymphonyError("tracker_error", `GitHub PR review evidence returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        throw new SymphonyError("tracker_error", "GitHub PR review evidence response is invalid");
      }
      items.push(...(body as T[]));
      nextUrl = nextLinkUrl(response.headers.get("link"));
    }
    return items;
  }

  private async fetchReviewThreadMetadata(pullRequestNumber: number): Promise<PullRequestReviewThreadMetadata[]> {
    const threads: PullRequestReviewThreadMetadata[] = [];
    let after: string | null = null;
    while (true) {
      const response = await this.fetchImpl(graphQlApiUrl(this.config.apiBaseUrl), {
        method: "POST",
        headers: {
          ...requestHeaders(this.config.token ?? ""),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: {
            owner: this.config.owner,
            repo: this.config.repo,
            number: pullRequestNumber,
            after,
          },
        }),
      });
      if (!response.ok) {
        throw new SymphonyError("tracker_error", `GitHub PR review thread evidence returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as GraphQlReviewThreadResponse;
      if (body.errors !== undefined) {
        throw new SymphonyError("tracker_error", "GitHub PR review thread evidence response contains GraphQL errors");
      }
      const reviewThreads = body.data?.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads || !Array.isArray(reviewThreads.nodes)) {
        throw new SymphonyError("tracker_error", "GitHub PR review thread evidence response is invalid");
      }
      threads.push(...reviewThreads.nodes.map(normalizeReviewThreadMetadata).filter((item): item is PullRequestReviewThreadMetadata => item !== null));
      const pageInfo = reviewThreads.pageInfo;
      if (pageInfo?.hasNextPage !== true) return threads;
      after = asNullableString(pageInfo.endCursor);
      if (!after) throw new SymphonyError("tracker_error", "GitHub PR review thread evidence pagination cursor is missing");
    }
  }
}

const REVIEW_THREADS_QUERY = `
query SymphonyPullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes {
              databaseId
            }
          }
        }
      }
    }
  }
}
`;

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
  thread: PullRequestReviewThreadMetadata | undefined,
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
    threadId: thread?.threadId ?? (reviewId && path ? `${reviewId}:${path}:${asNullableNumber(node.original_line) ?? asNullableNumber(node.line) ?? githubId}` : null),
    inReplyToId: asNumberString(node.in_reply_to_id),
    isResolved: thread?.isResolved ?? null,
    isOutdated: thread?.isOutdated ?? null,
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

function normalizeReviewThreadMetadata(value: unknown): PullRequestReviewThreadMetadata | null {
  if (!isRecord(value)) return null;
  const threadId = asString(value.id);
  if (!threadId) return null;
  const comments = isRecord(value.comments) && Array.isArray(value.comments.nodes) ? value.comments.nodes : [];
  const commentDatabaseIds = comments
    .map((comment) => (isRecord(comment) ? asNumberString(comment.databaseId) : null))
    .filter((item): item is string => item !== null);
  return {
    threadId,
    isResolved: typeof value.isResolved === "boolean" ? value.isResolved : null,
    isOutdated: typeof value.isOutdated === "boolean" ? value.isOutdated : null,
    path: asNullableString(value.path),
    line: asNullableNumber(value.line),
    commentDatabaseIds,
  };
}

function reviewThreadMetadataByCommentId(
  threads: PullRequestReviewThreadMetadata[],
): Map<string, PullRequestReviewThreadMetadata> {
  const byCommentId = new Map<string, PullRequestReviewThreadMetadata>();
  for (const thread of threads) {
    for (const commentId of thread.commentDatabaseIds) byCommentId.set(commentId, thread);
  }
  return byCommentId;
}

function nextLinkUrl(linkHeader: string | null): URL | null {
  if (!linkHeader) return null;
  for (const segment of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(segment.trim());
    if (match?.[1]) return new URL(match[1]);
  }
  return null;
}

function graphQlApiUrl(apiBaseUrl: string): URL {
  const base = new URL(normalizedApiBaseUrl(apiBaseUrl));
  if (base.pathname.replace(/\/$/, "") === "/api/v3") {
    base.pathname = "/api/graphql";
    return base;
  }
  base.pathname = "/graphql";
  base.search = "";
  base.hash = "";
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
