import {
  buildIssueHandoffState,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueMergeGateState,
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";

export function shouldSilentlyRetireMergeGate(
  gate: IssueMergeGateState | null | undefined,
  currentHeadSha: string | null | undefined,
  pullRequestNumber: number | null | undefined,
): gate is IssueMergeGateState {
  return (
    gate !== null &&
    gate !== undefined &&
    gate.status !== "superseded" &&
    typeof currentHeadSha === "string" &&
    currentHeadSha.length > 0 &&
    pullRequestNumber !== null &&
    pullRequestNumber !== undefined &&
    gate.pullRequest.number === pullRequestNumber &&
    gate.headSha !== currentHeadSha
  );
}

export function silentlyRetireMergeGate(gate: IssueMergeGateState, currentHeadSha: string): IssueMergeGateState {
  return inactiveMergeGate(gate, "superseded", currentHeadSha);
}

export function resolveMergeGate(gate: IssueMergeGateState): IssueMergeGateState {
  return inactiveMergeGate(gate, "resolved", null);
}

export function isActiveMergeGate(gate: IssueMergeGateState | null | undefined): gate is IssueMergeGateState {
  return gate !== null && gate !== undefined && gate.status !== "resolved" && gate.status !== "superseded";
}

export function inactiveMergeGateLifecyclePatch(
  lifecycle: IssueLifecycleRecord,
  gate: IssueMergeGateState,
  status: "resolved" | "superseded",
  supersededByHeadSha: string | null = null,
): IssueLifecyclePatch {
  const mergeGate = inactiveMergeGate(gate, status, supersededByHeadSha);
  const reviewVerdicts = scrubMergeGateVerdicts(lifecycle.reviewVerdicts, gate.id);
  const lastReviewVerdictId =
    lifecycle.lastReviewVerdictId === gate.id ? latestNonMergeGateVerdictId(reviewVerdicts) : lifecycle.lastReviewVerdictId;
  return {
    mergeGate,
    reviewVerdicts,
    lastReviewVerdictId,
  };
}

export function sanitizeInactiveMergeGateLifecycle(lifecycle: IssueLifecycleRecord | null | undefined): IssueLifecycleRecord | null | undefined {
  const gate = lifecycle?.mergeGate ?? null;
  if (!lifecycle || !gate) return lifecycle;
  if (gate.status !== "resolved" && gate.status !== "superseded") return lifecycle;
  const scrubbedGate = inactiveMergeGate(gate, gate.status, gate.supersededByHeadSha);
  const reviewVerdicts = scrubMergeGateVerdicts(lifecycle.reviewVerdicts, gate.id);
  const lastReviewVerdictId = lifecycle.lastReviewVerdictId === gate.id ? latestNonMergeGateVerdictId(reviewVerdicts) : lifecycle.lastReviewVerdictId;
  const sanitized = {
    ...lifecycle,
    mergeGate: scrubbedGate,
    reviewVerdicts,
    lastReviewVerdictId,
  };
  return {
    ...sanitized,
    handoff: buildIssueHandoffState(sanitized),
  };
}

function inactiveMergeGate(
  gate: IssueMergeGateState,
  status: "resolved" | "superseded",
  supersededByHeadSha: string | null,
): IssueMergeGateState {
  return {
    ...gate,
    status,
    checks: [],
    repairRunId: null,
    repairReportId: null,
    blockerFingerprint: null,
    writebackOperationKeys: [],
    supersededByHeadSha: status === "superseded" ? supersededByHeadSha : null,
    updatedAt: new Date().toISOString(),
  };
}

function scrubMergeGateVerdicts(verdicts: IssueReviewVerdictRecord[], gateId: string): IssueReviewVerdictRecord[] {
  return verdicts.map((verdict) =>
    verdict.id === gateId && isMergeGateVerdict(verdict)
      ? {
          ...verdict,
          acceptanceResults: [],
          findings: [],
          evidence: [],
        }
      : verdict,
  );
}

function latestNonMergeGateVerdictId(verdicts: IssueReviewVerdictRecord[]): string | null {
  return verdicts
    .slice()
    .reverse()
    .find((verdict) => !isMergeGateVerdict(verdict))?.id ?? null;
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === "symphony-merge-gate" || verdict.id.startsWith("merge-gate:");
}
