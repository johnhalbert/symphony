import type { IssueMergeGateState } from "../persistence/IssueLifecycleStore.js";

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
  return {
    ...gate,
    status: "superseded",
    supersededByHeadSha: currentHeadSha,
    updatedAt: new Date().toISOString(),
  };
}
