import { spawn } from "node:child_process";
import type { GitHubConfig } from "../../core/config/Config.js";
import { SymphonyError } from "../../core/errors.js";

type FetchLike = typeof fetch;
export interface GitHubAuthTokenProvider {
  getToken(): Promise<string>;
  describe?(): string;
}

type GitHubPullRequestClientConfig = Omit<GitHubConfig, "prHandoff" | "app"> &
  Partial<Pick<GitHubConfig, "prHandoff" | "app">>;
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
  draft?: boolean;
}

export interface PullRequestDetails extends PullRequestMetadata {
  state: string | null;
  merged: boolean | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  baseBranch: string;
  baseHeadSha: string;
}

export interface PullRequestCheckResult {
  name: string;
  status: "success" | "failure" | "pending" | "missing" | "unknown";
  conclusion: string | null;
  url: string | null;
}

export interface PullRequestChecksInput {
  headSha: string;
  requiredChecks: string[];
}

export interface PullRequestMergeInput {
  pullRequestNumber: number;
  expectedHeadSha: string;
  method: "merge" | "squash" | "rebase";
}

export interface PullRequestMergeResult {
  merged: boolean;
  mergeCommitSha: string;
  mergedAt: string;
  mergedBy: string | null;
}

export interface CommitAncestryInput {
  ancestorSha: string;
  descendantSha: string;
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

export type GitHubPullRequestReviewFeedbackEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PullRequestReviewInlineFeedbackInput {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number | null;
  startSide?: "LEFT" | "RIGHT" | null;
}

export interface PullRequestReviewFeedbackInput {
  pullRequestNumber: number;
  headSha: string;
  event: GitHubPullRequestReviewFeedbackEvent;
  body: string;
  comments?: PullRequestReviewInlineFeedbackInput[];
}

export interface PullRequestReviewCommentFeedbackInput {
  pullRequestNumber: number;
  headSha: string | null;
  body: string;
  path?: string | null;
  line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  inReplyToId?: number | null;
}

export interface PullRequestIssueCommentFeedbackInput {
  pullRequestNumber: number;
  body: string;
}

export interface PullRequestReviewFeedbackResult {
  reviewUrl: string | null;
  commentUrls: string[];
}

interface GitHubPullRequestNode {
  html_url?: unknown;
  number?: unknown;
  state?: unknown;
  merged?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
  merge_commit_sha?: unknown;
  merged_at?: unknown;
  draft?: unknown;
  merged_by?: GitHubUserNode | null;
  updated_at?: unknown;
  head?: {
    ref?: unknown;
    sha?: unknown;
    repo?: {
      pushed_at?: unknown;
    } | null;
  } | null;
  base?: {
    ref?: unknown;
    sha?: unknown;
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

interface GitHubReviewFeedbackNode extends GitHubReviewNode {
  comments?: unknown;
}

interface GitHubCommitStatusNode {
  context?: unknown;
  state?: unknown;
  target_url?: unknown;
  created_at?: unknown;
}

interface GitHubCheckRunNode {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  created_at?: unknown;
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
  #lastAuthToken: string | null = null;
  #lastAuthDescription: string | null = null;

  constructor(
    private readonly config: GitHubPullRequestClientConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly authTokenProvider: GitHubAuthTokenProvider | null = null,
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
      headers: await this.requestHeaders(),
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

  async getPullRequest(input: { pullRequestNumber: number }): Promise<PullRequestDetails> {
    this.assertConfiguredForMerge();
    assertPullRequestNumber(input.pullRequestNumber, "PR merge inspection");
    const response = await this.fetchImpl(this.repoUrl(`pulls/${input.pullRequestNumber}`), {
      method: "GET",
      headers: await this.requestHeaders(),
    });
    if (!response.ok) {
      throw new SymphonyError("tracker_error", `GitHub PR inspection returned HTTP ${response.status}`);
    }
    const pullRequest = normalizePullRequestDetails((await response.json()) as GitHubPullRequestNode);
    if (!pullRequest) throw new SymphonyError("tracker_error", "GitHub PR inspection response is invalid");
    return pullRequest;
  }

  async closePullRequest(input: { pullRequestNumber: number }): Promise<void> {
    this.assertConfiguredForPublication();
    assertPullRequestNumber(input.pullRequestNumber, "PR close");
    const response = await this.fetchImpl(this.repoUrl(`pulls/${input.pullRequestNumber}`), {
      method: "PATCH",
      headers: await this.requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ state: "closed" }),
    });
    if (!response.ok) {
      throw new SymphonyError("tracker_error", await this.githubWriteError(response, "GitHub PR close"));
    }
    const pullRequest = normalizePullRequestDetails((await response.json()) as GitHubPullRequestNode);
    if (!pullRequest || pullRequest.state?.toLowerCase() !== "closed") {
      throw new SymphonyError("tracker_error", "GitHub PR close response is invalid");
    }
  }

  async getRequiredCheckResults(input: PullRequestChecksInput): Promise<PullRequestCheckResult[]> {
    this.assertConfiguredForMerge();
    const headSha = requireNonEmpty(input.headSha, "A pull request head SHA is required for check validation");
    const requiredChecks = input.requiredChecks.map((check) => check.trim()).filter((check) => check.length > 0);
    const [statuses, checkRuns] = await Promise.all([this.fetchAllCommitStatusesForCommit(headSha), this.fetchAllCheckRunsForCommit(headSha)]);
    const statusByName = indexCommitStatusesByName(statuses);
    const checkRunByName = indexCheckRunsByName(checkRuns);
    return requiredChecks.map((required) => {
      const status = statusByName.get(required);
      if (status) return status;
      const checkRun = checkRunByName.get(required);
      return checkRun ?? { name: required, status: "missing", conclusion: null, url: null };
    });
  }

  async mergePullRequest(input: PullRequestMergeInput): Promise<PullRequestMergeResult> {
    this.assertConfiguredForMerge();
    assertPullRequestNumber(input.pullRequestNumber, "PR merge");
    const expectedHeadSha = requireNonEmpty(input.expectedHeadSha, "A pull request head SHA is required for PR merge");
    const response = await this.fetchImpl(this.repoUrl(`pulls/${input.pullRequestNumber}/merge`), {
      method: "PUT",
      headers: await this.requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        sha: expectedHeadSha,
        merge_method: input.method,
      }),
    });
    if (!response.ok) {
      throw new SymphonyError("tracker_error", await this.githubWriteError(response, "GitHub PR merge"));
    }
    const body = (await response.json()) as Record<string, unknown>;
    const sha = asNullableString(body.sha);
    if (body.merged !== true || sha === null) {
      throw new SymphonyError("tracker_error", "GitHub PR merge response is invalid");
    }
    return {
      merged: true,
      mergeCommitSha: sha,
      mergedAt: new Date().toISOString(),
      mergedBy: await this.getAuthenticatedLogin(),
    };
  }

  async isAncestor(input: CommitAncestryInput): Promise<boolean> {
    this.assertConfiguredForMerge();
    const ancestorSha = requireNonEmpty(input.ancestorSha, "An ancestor commit SHA is required for approval carry-forward");
    const descendantSha = requireNonEmpty(input.descendantSha, "A descendant commit SHA is required for approval carry-forward");
    const response = await this.fetchImpl(
      this.repoUrl(`compare/${encodeURIComponent(ancestorSha)}...${encodeURIComponent(descendantSha)}`),
      {
        method: "GET",
        headers: await this.requestHeaders(),
      },
    );
    if (!response.ok) {
      throw new SymphonyError("tracker_error", `GitHub commit comparison returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const status = asNullableString(body.status);
    return status === "identical" || status === "ahead";
  }

  async submitPullRequestReviewFeedback(
    input: PullRequestReviewFeedbackInput,
  ): Promise<PullRequestReviewFeedbackResult> {
    this.assertConfiguredForReviewFeedbackWrite();
    assertPullRequestNumber(input.pullRequestNumber, "PR review feedback");
    const headSha = requireNonEmpty(input.headSha, "A pull request head SHA is required for PR review feedback");
    const body = requireNonEmpty(input.body, "A review body is required for PR review feedback");
    const response = await this.fetchImpl(this.repoUrl(`pulls/${input.pullRequestNumber}/reviews`), {
      method: "POST",
      headers: await this.requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        commit_id: headSha,
        event: input.event,
        body,
        comments: (input.comments ?? []).map((comment) => ({
          path: requireNonEmpty(comment.path, "Inline review comments require a path"),
          body: requireNonEmpty(comment.body, "Inline review comments require a body"),
          line: comment.line,
          side: comment.side,
          ...(comment.startLine === undefined || comment.startLine === null ? {} : { start_line: comment.startLine }),
          ...(comment.startSide === undefined || comment.startSide === null ? {} : { start_side: comment.startSide }),
        })),
      }),
    });
    if (!response.ok) {
      throw new SymphonyError("tracker_error", await this.githubWriteError(response, "GitHub PR review feedback"));
    }

    const bodyJson = (await response.json()) as GitHubReviewFeedbackNode;
    return {
      reviewUrl: asNullableString(bodyJson.html_url),
      commentUrls: asRecordArray(bodyJson.comments)
        .map((comment) => asNullableString(comment.html_url))
        .filter((url): url is string => url !== null),
    };
  }

  async submitPullRequestReviewCommentFeedback(
    input: PullRequestReviewCommentFeedbackInput,
  ): Promise<PullRequestReviewFeedbackResult> {
    this.assertConfiguredForReviewFeedbackWrite();
    assertPullRequestNumber(input.pullRequestNumber, "PR review comment feedback");
    const body = requireNonEmpty(input.body, "A review comment body is required for PR feedback");
    const payload =
      input.inReplyToId !== undefined && input.inReplyToId !== null
        ? { body, in_reply_to: input.inReplyToId }
        : {
            body,
            commit_id: requireNonEmpty(input.headSha ?? "", "A pull request head SHA is required for inline PR feedback"),
            path: requireNonEmpty(input.path ?? "", "Inline PR feedback requires a path"),
            line: input.line,
            side: input.side,
          };
    const response = await this.fetchImpl(this.repoUrl(`pulls/${input.pullRequestNumber}/comments`), {
      method: "POST",
      headers: await this.requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new SymphonyError("tracker_error", await this.githubWriteError(response, "GitHub PR review comment feedback"));
    }

    const comment = (await response.json()) as GitHubReviewCommentNode;
    const url = asNullableString(comment.html_url);
    return { reviewUrl: null, commentUrls: url === null ? [] : [url] };
  }

  async submitPullRequestIssueCommentFeedback(
    input: PullRequestIssueCommentFeedbackInput,
  ): Promise<PullRequestReviewFeedbackResult> {
    this.assertConfiguredForReviewFeedbackWrite();
    assertPullRequestNumber(input.pullRequestNumber, "PR issue comment feedback");
    const response = await this.fetchImpl(this.repoUrl(`issues/${input.pullRequestNumber}/comments`), {
      method: "POST",
      headers: await this.requestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ body: requireNonEmpty(input.body, "An issue comment body is required for PR feedback") }),
    });
    if (!response.ok) {
      throw new SymphonyError("tracker_error", await this.githubWriteError(response, "GitHub PR issue comment feedback"));
    }

    const comment = (await response.json()) as GitHubIssueCommentNode;
    const url = asNullableString(comment.html_url);
    return { reviewUrl: null, commentUrls: url === null ? [] : [url] };
  }

  async publishPullRequest(input: PullRequestPublicationInput): Promise<PullRequestPublicationResult> {
    this.assertConfiguredForPublication();
    const token = await this.resolveAuthToken();
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
    this.assertConfiguredForRepositoryAccess();
    const response = await this.fetchImpl(
      this.repoUrl(""),
      {
        method: "GET",
        headers: await this.requestHeaders(),
      },
    );
    if (!response.ok) {
      const detail = await githubErrorDetail(response, this.#lastAuthToken ?? this.config.token ?? null);
      throw new SymphonyError(
        "tracker_error",
        detail.length === 0
          ? `GitHub repository access returned HTTP ${response.status}`
          : `GitHub repository access returned HTTP ${response.status}: ${detail}`,
      );
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.config.owner && this.config.repo && this.hasAuthentication());
  }

  private hasAuthentication(): boolean {
    return Boolean(this.config.token?.trim() || this.authTokenProvider);
  }

  private async resolveAuthToken(): Promise<string> {
    const staticToken = this.config.token?.trim();
    if (staticToken) {
      this.#lastAuthToken = staticToken;
      this.#lastAuthDescription = "static GitHub token";
      return staticToken;
    }
    const appToken = (await this.authTokenProvider?.getToken())?.trim() ?? "";
    if (appToken.length > 0) {
      this.#lastAuthToken = appToken;
      this.#lastAuthDescription = this.authTokenProvider?.describe?.() ?? "GitHub App installation auth";
      return appToken;
    }
    throw new SymphonyError("invalid_request", "GitHub token or GitHub App installation auth is required");
  }

  private async requestHeaders(extraHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
    return { ...requestHeaders(await this.resolveAuthToken()), ...extraHeaders };
  }

  authenticationDescription(): string | null {
    return (
      this.#lastAuthDescription ??
      (this.config.token?.trim() ? "static GitHub token" : this.authTokenProvider?.describe?.() ?? null)
    );
  }

  private assertConfiguredForPublication(): void {
    if (!this.config.owner || !this.config.repo || !this.hasAuthentication()) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token or GitHub App installation auth are required when PR publication is enabled",
      );
    }
  }

  private assertConfiguredForReviewEvidenceRead(): void {
    if (!this.config.owner || !this.config.repo || !this.hasAuthentication()) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token or GitHub App installation auth are required for PR review evidence ingestion",
      );
    }
  }

  private assertConfiguredForReviewFeedbackWrite(): void {
    if (!this.config.owner || !this.config.repo || !this.hasAuthentication()) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token or GitHub App installation auth are required for PR review feedback",
      );
    }
  }

  private assertConfiguredForRepositoryAccess(): void {
    if (!this.config.owner || !this.config.repo || !this.hasAuthentication()) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token or GitHub App installation auth are required for repository access",
      );
    }
  }

  private assertConfiguredForMerge(): void {
    if (!this.config.owner || !this.config.repo || !this.hasAuthentication()) {
      throw new SymphonyError(
        "invalid_request",
        "GitHub owner, repo, and token or GitHub App installation auth are required for service-owned PR merge",
      );
    }
  }

  private repoUrl(repoPath: string): URL {
    const suffix = repoPath.length === 0 ? "" : `/${repoPath}`;
    return new URL(
      `repos/${encodeURIComponent(this.config.owner ?? "")}/${encodeURIComponent(this.config.repo ?? "")}${suffix}`,
      normalizedApiBaseUrl(this.config.apiBaseUrl),
    );
  }

  private async githubWriteError(response: Response, action: string): Promise<string> {
    const detail = await githubErrorDetail(response, this.#lastAuthToken ?? this.config.token ?? null);
    return detail.length === 0 ? `${action} returned HTTP ${response.status}` : `${action} returned HTTP ${response.status}: ${detail}`;
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
        headers: await this.requestHeaders({ "content-type": "application/json" }),
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

  async getAuthenticatedLogin(): Promise<string | null> {
    if (!this.hasAuthentication()) return null;
    const response = await this.fetchImpl(new URL("user", normalizedApiBaseUrl(this.config.apiBaseUrl)), {
      method: "GET",
      headers: await this.requestHeaders(),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as GitHubUserNode;
    return asNullableString(body.login);
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
        headers: await this.requestHeaders(),
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

  private async fetchAllCheckRunsForCommit(headSha: string): Promise<GitHubCheckRunNode[]> {
    const firstUrl = this.repoUrl(`commits/${encodeURIComponent(headSha)}/check-runs`);
    firstUrl.searchParams.set("per_page", "100");
    const checkRuns: GitHubCheckRunNode[] = [];
    let nextUrl: URL | null = firstUrl;
    while (nextUrl) {
      const response = await this.fetchImpl(nextUrl, {
        method: "GET",
        headers: await this.requestHeaders({ accept: "application/vnd.github+json" }),
      });
      if (!response.ok) {
        throw new SymphonyError("tracker_error", `GitHub check run inspection returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as { check_runs?: unknown };
      if (Array.isArray(body.check_runs)) {
        checkRuns.push(...body.check_runs.filter(isRecord).map((item) => item as GitHubCheckRunNode));
      }
      nextUrl = nextLinkUrl(response.headers.get("link"));
    }
    return checkRuns;
  }

  private async fetchAllCommitStatusesForCommit(headSha: string): Promise<GitHubCommitStatusNode[]> {
    const firstUrl = this.repoUrl(`commits/${encodeURIComponent(headSha)}/status`);
    firstUrl.searchParams.set("per_page", "100");
    const statuses: GitHubCommitStatusNode[] = [];
    let nextUrl: URL | null = firstUrl;
    while (nextUrl) {
      const response = await this.fetchImpl(nextUrl, {
        method: "GET",
        headers: await this.requestHeaders(),
      });
      if (!response.ok) {
        throw new SymphonyError("tracker_error", `GitHub commit status inspection returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as { statuses?: unknown };
      if (!Array.isArray(body.statuses)) {
        throw new SymphonyError("tracker_error", "GitHub commit status inspection response is invalid");
      }
      statuses.push(...body.statuses.filter(isRecord).map((item) => item as GitHubCommitStatusNode));
      nextUrl = nextLinkUrl(response.headers.get("link"));
    }
    return statuses;
  }

  private async fetchReviewThreadMetadata(pullRequestNumber: number): Promise<PullRequestReviewThreadMetadata[]> {
    const threads: PullRequestReviewThreadMetadata[] = [];
    let after: string | null = null;
    while (true) {
      const response = await this.fetchImpl(graphQlApiUrl(this.config.apiBaseUrl), {
        method: "POST",
        headers: await this.requestHeaders({ "content-type": "application/json" }),
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
  const draft = typeof node.draft === "boolean" ? node.draft : false;
  if (!url || number === null || !headBranch) return null;
  return {
    url,
    number,
    headBranch,
    headSha,
    lastPushedAt: asNullableString(node.head?.repo?.pushed_at) ?? asNullableString(node.updated_at),
    ...(draft ? { draft } : {}),
  };
}

function normalizePullRequestDetails(node: GitHubPullRequestNode): PullRequestDetails | null {
  const metadata = normalizePullRequest(node);
  const baseBranch = asString(node.base?.ref);
  const baseHeadSha = asString(node.base?.sha);
  if (!metadata || !baseBranch || !baseHeadSha) return null;
  return {
    ...metadata,
    state: asNullableString(node.state),
    merged: typeof node.merged === "boolean" ? node.merged : null,
    mergeCommitSha: asNullableString(node.merge_commit_sha),
    mergedAt: asNullableString(node.merged_at),
    mergedBy: asNullableString(node.merged_by?.login),
    mergeable: typeof node.mergeable === "boolean" ? node.mergeable : null,
    mergeableState: asNullableString(node.mergeable_state),
    baseBranch,
    baseHeadSha,
  };
}

function normalizeCommitStatus(node: GitHubCommitStatusNode): PullRequestCheckResult | null {
  const name = asString(node.context);
  if (!name) return null;
  const state = asNullableString(node.state);
  const status = state === "success" ? "success" : state === "pending" ? "pending" : state === "failure" || state === "error" ? "failure" : "unknown";
  return {
    name,
    status,
    conclusion: state,
    url: asNullableString(node.target_url),
  };
}

function indexCommitStatusesByName(nodes: GitHubCommitStatusNode[]): Map<string, PullRequestCheckResult> {
  const grouped = new Map<string, GitHubCommitStatusNode[]>();
  for (const node of nodes) {
    const name = asString(node.context);
    if (!name) continue;
    grouped.set(name, [...(grouped.get(name) ?? []), node]);
  }
  const indexed = new Map<string, PullRequestCheckResult>();
  for (const [name, statuses] of grouped.entries()) {
    const selected = selectAuthoritativeCommitStatus(statuses);
    const normalized = selected ? normalizeCommitStatus(selected) : null;
    if (normalized) indexed.set(name, normalized);
  }
  return indexed;
}

function selectAuthoritativeCommitStatus(nodes: GitHubCommitStatusNode[]): GitHubCommitStatusNode | null {
  return [...nodes].sort(compareCommitStatusesByRecency)[0] ?? null;
}

function compareCommitStatusesByRecency(a: GitHubCommitStatusNode, b: GitHubCommitStatusNode): number {
  return commitStatusSortValue(b) - commitStatusSortValue(a);
}

function commitStatusSortValue(node: GitHubCommitStatusNode): number {
  return checkRunTimestamp(node.created_at) ?? 0;
}

function indexCheckRunsByName(nodes: GitHubCheckRunNode[]): Map<string, PullRequestCheckResult> {
  const grouped = new Map<string, GitHubCheckRunNode[]>();
  for (const node of nodes) {
    const name = asString(node.name);
    if (!name) continue;
    grouped.set(name, [...(grouped.get(name) ?? []), node]);
  }
  const indexed = new Map<string, PullRequestCheckResult>();
  for (const [name, runs] of grouped.entries()) {
    const selected = selectAuthoritativeCheckRun(runs);
    const normalized = selected ? normalizeCheckRun(selected) : null;
    if (normalized) indexed.set(name, normalized);
  }
  return indexed;
}

function selectAuthoritativeCheckRun(nodes: GitHubCheckRunNode[]): GitHubCheckRunNode | null {
  return [...nodes].sort(compareCheckRunsByRecency)[0] ?? null;
}

function compareCheckRunsByRecency(a: GitHubCheckRunNode, b: GitHubCheckRunNode): number {
  return checkRunSortValue(b) - checkRunSortValue(a);
}

function checkRunSortValue(node: GitHubCheckRunNode): number {
  return checkRunTimestamp(node.completed_at) ?? checkRunTimestamp(node.started_at) ?? checkRunTimestamp(node.created_at) ?? checkRunId(node.id) ?? 0;
}

function checkRunTimestamp(value: unknown): number | null {
  const raw = asNullableString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkRunId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeCheckRun(node: GitHubCheckRunNode): PullRequestCheckResult | null {
  const name = asString(node.name);
  if (!name) return null;
  const status = asNullableString(node.status);
  const conclusion = asNullableString(node.conclusion);
  const normalizedStatus =
    status !== "completed"
      ? "pending"
      : conclusion === "success" || conclusion === "neutral" || conclusion === "skipped"
      ? "success"
      : conclusion === "failure" ||
        conclusion === "cancelled" ||
        conclusion === "timed_out" ||
        conclusion === "action_required" ||
        conclusion === "stale"
      ? "failure"
      : "unknown";
  return {
    name,
    status: normalizedStatus,
    conclusion,
    url: asNullableString(node.html_url),
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

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value) && value.every((item) => isRecord(item))) return value as Array<Record<string, unknown>>;
  return [];
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

function assertPullRequestNumber(value: number, description: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SymphonyError("invalid_request", `A valid pull request number is required for ${description}`);
  }
}

function requireNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new SymphonyError("invalid_request", message);
  return trimmed;
}

async function githubErrorDetail(response: Response, token: string | null): Promise<string> {
  let text = "";
  try {
    const body = (await response.clone().json()) as unknown;
    if (isRecord(body)) {
      const message = asNullableString(body.message);
      const errors = Array.isArray(body.errors)
        ? body.errors
            .map((error) => (isRecord(error) ? asNullableString(error.message) : null))
            .filter((item): item is string => item !== null)
        : [];
      text = [message, ...errors].filter((item): item is string => item !== null && item.length > 0).join("; ");
    }
  } catch {
    try {
      text = await response.text();
    } catch {
      text = "";
    }
  }
  return sanitizeSecret(text, token).slice(0, 500);
}

function sanitizeSecret(value: string, secret: string | null): string {
  if (!secret || secret.length === 0) return value;
  return value.split(secret).join("[redacted]");
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

function pullRequestHeadRef(config: GitHubPullRequestClientConfig, branchName: string): string {
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
      const detail = sanitizeSecret(result.stderr.trim() || result.stdout.trim(), token);
      throw new SymphonyError("tracker_error", "GitHub branch push failed: " + detail);
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
