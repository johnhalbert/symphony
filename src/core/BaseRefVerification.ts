import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { SymphonyError, errorMessage } from "./errors.js";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export type IssueBaseRefObservationClassification =
  | "ok"
  | "local_base_mismatch"
  | "branch_not_based_on_live_base"
  | "base_ref_unavailable"
  | "base_ref_fetch_failed"
  | "base_ref_compare_failed";

export interface IssueBaseRefObservation {
  version: 1;
  inputFingerprint: string;
  classification: IssueBaseRefObservationClassification;
  operation: string;
  checkedAt: string;
  workspacePath: string | null;
  branchName: string | null;
  baseRef: string | null;
  normalizedBaseBranch: string | null;
  localBaseRef: string | null;
  githubBaseHeadSha: string | null;
  localBaseHeadShaBeforeFetch: string | null;
  localBaseHeadShaAfterFetch: string | null;
  worktreeHeadSha: string | null;
  localBaseIsAncestorOfHead: boolean | null;
  reason: string | null;
  error: string | null;
}

export interface BaseRefGitHubClient {
  getBranchHeadSha(input: { branchName: string }): Promise<string>;
  gitAuthHeader(): Promise<string>;
}

export interface BaseRefVerificationInput {
  workspacePath: string | null | undefined;
  branchName: string | null | undefined;
  baseRef: string | null | undefined;
  operation: string;
  client: BaseRefGitHubClient;
  now?: Date;
}

export interface LocalRemoteBaseRefVerificationInput {
  workspacePath: string;
  baseRef: string;
  expectedBaseHeadSha: string;
  authHeader: string;
  errorMessageLabel?: string;
  createMismatchError?: (details: {
    refName: string;
    actualSha: string;
    expectedSha: string;
    baseBranch: string;
  }) => Error;
}

export interface LocalRemoteBaseRefVerificationResult {
  baseBranch: string;
  localBaseRef: string;
  expectedBaseHeadSha: string;
  localBaseHeadShaBeforeFetch: string | null;
  localBaseHeadShaAfterFetch: string;
}

interface BaseRefObservationDraft {
  checkedAt: string;
  workspacePath: string | null;
  branchName: string | null;
  baseRef: string | null;
  normalizedBaseBranch: string | null;
  localBaseRef: string | null;
  githubBaseHeadSha: string | null;
  localBaseHeadShaBeforeFetch: string | null;
  localBaseHeadShaAfterFetch: string | null;
  worktreeHeadSha: string | null;
  localBaseIsAncestorOfHead: boolean | null;
}

export class BaseRefVerifier {
  async verify(input: BaseRefVerificationInput): Promise<IssueBaseRefObservation> {
    const checkedAt = (input.now ?? new Date()).toISOString();
    const workspacePath = nonEmptyString(input.workspacePath);
    const branchName = nonEmptyString(input.branchName);
    const baseRef = nonEmptyString(input.baseRef);
    const normalizedBaseBranch = normalizeBaseBranch(baseRef);
    const localBaseRef =
      normalizedBaseBranch === null
        ? null
        : `refs/remotes/origin/${normalizedBaseBranch}`;
    const draft: BaseRefObservationDraft = {
      checkedAt,
      workspacePath,
      branchName,
      baseRef,
      normalizedBaseBranch,
      localBaseRef,
      githubBaseHeadSha: null,
      localBaseHeadShaBeforeFetch: null,
      localBaseHeadShaAfterFetch: null,
      worktreeHeadSha: null,
      localBaseIsAncestorOfHead: null,
    };

    if (
      workspacePath === null ||
      branchName === null ||
      baseRef === null ||
      normalizedBaseBranch === null ||
      localBaseRef === null
    ) {
      return this.observation(input, draft, "base_ref_unavailable", "Base ref verification requires a workspace path, branch, and base ref", null);
    }

    if (!safeRefName(branchName) || !safeRefName(normalizedBaseBranch)) {
      return this.observation(input, draft, "base_ref_unavailable", "Base ref verification received an unsafe branch or base ref", null);
    }

    const git = new BaseRefGit(workspacePath);
    try {
      await git.assertCurrentBranch(branchName);
    } catch (error) {
      return this.observation(input, draft, "base_ref_unavailable", "Base ref verification requires the worktree to be on the target branch", errorMessage(error));
    }

    try {
      draft.localBaseHeadShaBeforeFetch = await git.refSha(localBaseRef, true);
    } catch (error) {
      return this.observation(input, draft, "base_ref_compare_failed", "Unable to inspect local base ref before fetch", errorMessage(error));
    }

    try {
      draft.githubBaseHeadSha = nonEmptyString(await input.client.getBranchHeadSha({
        branchName: normalizedBaseBranch,
      }));
      if (draft.githubBaseHeadSha === null) {
        throw new SymphonyError("invalid_request", "GitHub returned an empty live base SHA");
      }
    } catch (error) {
      return this.observation(input, draft, "base_ref_unavailable", "Unable to resolve GitHub live base ref", errorMessage(error));
    }

    try {
      const authHeader = await input.client.gitAuthHeader();
      await git.fetchBranch(normalizedBaseBranch, authHeader);
    } catch (error) {
      return this.observation(input, draft, "base_ref_fetch_failed", "Unable to fetch the live base ref from origin", errorMessage(error));
    }

    try {
      draft.localBaseHeadShaAfterFetch = await git.refSha(localBaseRef, false);
      draft.worktreeHeadSha = await git.headSha();
    } catch (error) {
      return this.observation(input, draft, "base_ref_compare_failed", "Unable to inspect local base or worktree head after fetch", errorMessage(error));
    }

    if (draft.localBaseHeadShaAfterFetch !== draft.githubBaseHeadSha) {
      return this.observation(input, draft, "local_base_mismatch", "Fetched local base ref does not match GitHub live base", null);
    }

    try {
      draft.localBaseIsAncestorOfHead = await git.isAncestor(
        draft.localBaseHeadShaAfterFetch,
        "HEAD",
      );
    } catch (error) {
      return this.observation(input, draft, "base_ref_compare_failed", "Unable to compare local base ancestry", errorMessage(error));
    }

    if (!draft.localBaseIsAncestorOfHead) {
      return this.observation(input, draft, "branch_not_based_on_live_base", "Worktree HEAD is not based on the live origin base", null);
    }

    return this.observation(input, draft, "ok", null, null);
  }

  private observation(
    input: BaseRefVerificationInput,
    draft: BaseRefObservationDraft,
    classification: IssueBaseRefObservationClassification,
    reason: string | null,
    error: string | null,
  ): IssueBaseRefObservation {
    return {
      version: 1,
      inputFingerprint: baseRefObservationInputFingerprint(input),
      classification,
      operation: input.operation,
      checkedAt: draft.checkedAt,
      workspacePath: draft.workspacePath,
      branchName: draft.branchName,
      baseRef: draft.baseRef,
      normalizedBaseBranch: draft.normalizedBaseBranch,
      localBaseRef: draft.localBaseRef,
      githubBaseHeadSha: draft.githubBaseHeadSha,
      localBaseHeadShaBeforeFetch: draft.localBaseHeadShaBeforeFetch,
      localBaseHeadShaAfterFetch: draft.localBaseHeadShaAfterFetch,
      worktreeHeadSha: draft.worktreeHeadSha,
      localBaseIsAncestorOfHead: draft.localBaseIsAncestorOfHead,
      reason,
      error,
    };
  }
}

export function baseRefObservationInputFingerprint(
  input: Pick<BaseRefVerificationInput, "workspacePath" | "branchName" | "baseRef" | "operation">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspacePath: nonEmptyString(input.workspacePath),
        branchName: nonEmptyString(input.branchName),
        baseRef: nonEmptyString(input.baseRef),
        operation: input.operation,
      }),
    )
    .digest("hex");
}

export function baseRefBlockedReason(observation: IssueBaseRefObservation): string {
  switch (observation.classification) {
    case "local_base_mismatch":
      return "base ref verification failed: local origin base does not match GitHub";
    case "branch_not_based_on_live_base":
      return "base ref verification failed: worktree needs rebase over latest origin base";
    case "base_ref_unavailable":
      return "base ref verification failed: base ref metadata is unavailable";
    case "base_ref_fetch_failed":
      return "base ref verification failed: unable to fetch origin base";
    case "base_ref_compare_failed":
      return "base ref verification failed: unable to compare local base";
    case "ok":
      return "base ref verification passed";
  }
}

export function baseRefObservationIsTransient(
  observation: IssueBaseRefObservation,
): boolean {
  if (
    observation.classification === "local_base_mismatch" ||
    observation.classification === "base_ref_fetch_failed" ||
    observation.classification === "base_ref_compare_failed"
  ) {
    return true;
  }
  return (
    observation.classification === "base_ref_unavailable" &&
    observation.reason === "Unable to resolve GitHub live base ref"
  );
}

export async function localRemoteBaseRefExists(input: {
  workspacePath: string | null | undefined;
  baseRef: string | null | undefined;
}): Promise<boolean> {
  const workspacePath = nonEmptyString(input.workspacePath);
  const baseBranch = normalizeBaseBranch(nonEmptyString(input.baseRef));
  if (workspacePath === null || baseBranch === null || !safeRefName(baseBranch)) {
    return false;
  }
  const git = new BaseRefGit(workspacePath);
  try {
    return (
      (await git.refSha(`refs/remotes/origin/${baseBranch}`, true)) !== null
    );
  } catch {
    return false;
  }
}

export async function fetchAndVerifyLocalRemoteBaseRef(
  input: LocalRemoteBaseRefVerificationInput,
): Promise<LocalRemoteBaseRefVerificationResult> {
  const workspacePath = nonEmptyString(input.workspacePath);
  const baseBranch = normalizeBaseBranch(nonEmptyString(input.baseRef));
  const expectedBaseHeadSha = nonEmptyString(input.expectedBaseHeadSha);
  if (workspacePath === null || baseBranch === null || expectedBaseHeadSha === null) {
    throw new SymphonyError("invalid_request", "Local base ref verification requires a workspace path, base ref, and expected base SHA");
  }
  if (!safeRefName(baseBranch)) {
    throw new SymphonyError("invalid_request", `Unsafe base branch: ${input.baseRef}`);
  }
  const git = new BaseRefGit(workspacePath);
  const localBaseRef = `refs/remotes/origin/${baseBranch}`;
  const localBaseHeadShaBeforeFetch = await git.refSha(localBaseRef, true);
  await git.fetchBranch(baseBranch, input.authHeader);
  const localBaseHeadShaAfterFetch = await git.refSha(localBaseRef, false);
  if (localBaseHeadShaAfterFetch === null) {
    throw new SymphonyError("invalid_request", `${localBaseRef} could not be resolved after fetch`);
  }
  if (localBaseHeadShaAfterFetch !== expectedBaseHeadSha) {
    if (input.createMismatchError) {
      throw input.createMismatchError({
        refName: localBaseRef,
        actualSha: localBaseHeadShaAfterFetch,
        expectedSha: expectedBaseHeadSha,
        baseBranch,
      });
    }
    const label = input.errorMessageLabel ?? "expected base";
    throw new SymphonyError(
      "invalid_request",
      `${localBaseRef} resolved to ${localBaseHeadShaAfterFetch}, not ${label} ${expectedBaseHeadSha}`,
    );
  }
  return {
    baseBranch,
    localBaseRef,
    expectedBaseHeadSha,
    localBaseHeadShaBeforeFetch,
    localBaseHeadShaAfterFetch,
  };
}

class BaseRefGit {
  constructor(private readonly workspacePath: string) {}

  async assertCurrentBranch(branchName: string): Promise<void> {
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current === branchName) return;
    throw new SymphonyError("invalid_request", `Worktree is on ${current || "detached HEAD"}, not ${branchName}`);
  }

  async refSha(refName: string, allowMissing: boolean): Promise<string | null> {
    const result = await this.git(["rev-parse", `${refName}^{commit}`], {
      allowFailure: allowMissing,
    });
    if (result.code === 0) {
      const sha = result.stdout.trim();
      if (sha.length > 0) return sha;
      throw new SymphonyError("invalid_request", `${refName} resolved to an empty SHA`);
    }
    if (allowMissing) return null;
    throw new SymphonyError("invalid_request", `${refName} could not be resolved`);
  }

  async fetchBranch(branchName: string, authHeader: string): Promise<void> {
    await this.git([
      "-c",
      `http.extraheader=${authHeader}`,
      "fetch",
      "origin",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ]);
  }

  async headSha(): Promise<string> {
    const sha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    if (sha.length > 0) return sha;
    throw new SymphonyError("invalid_request", "HEAD resolved to an empty SHA");
  }

  async isAncestor(ancestorSha: string, descendant: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", ancestorSha, descendant], {
      allowFailure: true,
    });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new SymphonyError("invalid_request", "Unable to compare local base ancestry");
  }

  private git(args: string[], options: { allowFailure?: boolean } = {}): Promise<BaseRefCommandResult> {
    return runBaseRefCommand("git", args, this.workspacePath, DEFAULT_GIT_TIMEOUT_MS, options);
  }
}

export interface BaseRefCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runBaseRefCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { allowFailure?: boolean },
): Promise<BaseRefCommandResult> {
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
    child.on("close", (code) => {
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

function normalizeBaseBranch(value: string | null): string | null {
  const trimmed = nonEmptyString(value);
  if (trimmed === null) return null;
  return trimmed
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/remotes\/origin\//u, "")
    .replace(/^origin\//u, "");
}

function nonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function safeRefName(refName: string): boolean {
  return !(
    refName.length === 0 ||
    refName.startsWith("-") ||
    refName.includes("..") ||
    refName.includes("\\") ||
    refName.includes("~") ||
    refName.includes("^") ||
    refName.includes(":") ||
    refName.includes("?") ||
    refName.includes("*") ||
    refName.includes("[") ||
    refName.endsWith("/") ||
    refName.endsWith(".lock")
  );
}
