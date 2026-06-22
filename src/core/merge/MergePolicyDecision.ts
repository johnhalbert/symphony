import type {
  IssueCurrentStateSnapshot,
  IssueTransitionRequest,
} from "../orchestration/IssueOrchestrationState.js";
import type { IssueMergeGateState } from "../persistence/IssueLifecycleStore.js";
import type {
  MergeGateStatus,
  MergePolicyObservation,
  MergePolicyObservationKind,
} from "./MergePolicyService.js";

export function mergePolicyTransitionRequestFromObservation(
  snapshot: IssueCurrentStateSnapshot,
  observation: MergePolicyObservation,
): IssueTransitionRequest | null {
  if (observation.status !== "ready") return null;
  switch (observation.observationKind) {
    case "skipped":
    case "already_done":
      return null;
    case "done_writeback_required":
      return { transitionKind: "merge_policy_write_done_state" };
    case "conflict_base_drifted":
      return { transitionKind: "merge_policy_refresh_conflict_base" };
    case "waiting_conflict_state":
      return { transitionKind: "merge_policy_wait_conflict_state" };
    case "head_superseded":
      return { transitionKind: "merge_policy_mark_head_superseded" };
    case "stale_gate":
      return { transitionKind: "merge_policy_retire_stale_gate" };
    case "base_rewritten":
    case "merge_gate_failure":
      return mergePolicyFailureTransitionRequest(snapshot, observation);
    case "service_preparable_conflict":
      return { transitionKind: "merge_policy_prepare_conflict" };
    case "wait_active_blocked_gate":
      return { transitionKind: "merge_policy_wait_active_blocked_gate" };
    case "wait_repair_clearance":
      return { transitionKind: "merge_policy_wait_repair_clearance" };
    case "same_gate_blocker_refresh":
    case "active_gate_observation_refresh":
      return { transitionKind: "merge_policy_refresh_same_gate_blocker" };
    case "checks_pending":
      return { transitionKind: "merge_policy_observe_checks_pending" };
    case "auto_resolve_gate":
      return { transitionKind: "merge_policy_auto_resolve_gate" };
    case "merge_ready":
      return { transitionKind: "merge_policy_merge_pull_request" };
    case "already_merged_pull_request":
      return { transitionKind: "merge_policy_recover_already_merged_pull_request" };
  }
}

export function mergePolicyObservationFromUnknown(value: unknown): MergePolicyObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<MergePolicyObservation>;
  if (candidate.version !== 1) return null;
  if (candidate.status !== "ready" && candidate.status !== "skipped") return null;
  if (typeof candidate.inputFingerprint !== "string") return null;
  if (typeof candidate.observedAt !== "string") return null;
  const observationKind = isMergePolicyObservationKind(candidate.observationKind)
    ? candidate.observationKind
    : mergePolicyObservationKindFromLegacyTransitionKind(
        typeof candidate.nextTransitionKind === "string" ? candidate.nextTransitionKind : null,
      );
  if (observationKind === null) return null;
  return {
    ...candidate,
    observationKind,
    serviceMergeLogin: typeof candidate.serviceMergeLogin === "string" ? candidate.serviceMergeLogin : null,
  } as MergePolicyObservation;
}

function mergePolicyFailureTransitionRequest(
  snapshot: IssueCurrentStateSnapshot,
  observation: MergePolicyObservation,
): IssueTransitionRequest | null {
  const gate = observation.gate;
  if (gate === null) return null;
  const missingConflictState = gate.mergeability?.status === "conflicted" && snapshot.mergePolicyConflictsState === null;
  if (missingConflictState) return { transitionKind: "merge_policy_block_failure" };
  const previousRound = mergePolicyPreviousMergeGateRepairRound(snapshot.mergePolicyMergeGate, gate);
  const newRepairCycle = observation.existingGateFailure === null || snapshot.phase === "passed";
  const reviewRound = newRepairCycle ? previousRound + 1 : previousRound;
  return reviewRound >= snapshot.mergePolicyMaxMergeGateFailures
    ? { transitionKind: "merge_policy_block_failure" }
    : { transitionKind: "merge_policy_dispatch_repair" };
}

function mergePolicyPreviousMergeGateRepairRound(current: IssueMergeGateState | null, gate: MergeGateStatus): number {
  if (current === null) return 0;
  if (current.id === gate.id) return current.reviewRound;
  if (current.status === "superseded" && current.pullRequest.number === gate.pullRequest.number) return current.reviewRound;
  return 0;
}

const MERGE_POLICY_OBSERVATION_KINDS: readonly MergePolicyObservationKind[] = [
  "skipped",
  "already_done",
  "done_writeback_required",
  "conflict_base_drifted",
  "waiting_conflict_state",
  "head_superseded",
  "stale_gate",
  "base_rewritten",
  "service_preparable_conflict",
  "wait_active_blocked_gate",
  "wait_repair_clearance",
  "same_gate_blocker_refresh",
  "active_gate_observation_refresh",
  "checks_pending",
  "auto_resolve_gate",
  "merge_gate_failure",
  "merge_ready",
  "already_merged_pull_request",
];

function isMergePolicyObservationKind(value: unknown): value is MergePolicyObservationKind {
  return typeof value === "string" && MERGE_POLICY_OBSERVATION_KINDS.includes(value as MergePolicyObservationKind);
}

function mergePolicyObservationKindFromLegacyTransitionKind(kind: string | null): MergePolicyObservationKind | null {
  switch (kind) {
    case "noop":
      return "already_done";
    case "merge_policy_write_done_state":
      return "done_writeback_required";
    case "merge_policy_refresh_conflict_base":
      return "conflict_base_drifted";
    case "merge_policy_wait_conflict_state":
      return "waiting_conflict_state";
    case "merge_policy_mark_head_superseded":
      return "head_superseded";
    case "merge_policy_retire_stale_gate":
      return "stale_gate";
    case "merge_policy_wait_active_blocked_gate":
      return "wait_active_blocked_gate";
    case "merge_policy_wait_repair_clearance":
      return "wait_repair_clearance";
    case "merge_policy_refresh_same_gate_blocker":
      return "same_gate_blocker_refresh";
    case "merge_policy_observe_checks_pending":
      return "checks_pending";
    case "merge_policy_auto_resolve_gate":
      return "auto_resolve_gate";
    case "merge_policy_prepare_conflict":
      return "service_preparable_conflict";
    case "merge_policy_dispatch_repair":
    case "merge_policy_block_failure":
      return "merge_gate_failure";
    case "merge_policy_merge_pull_request":
      return "merge_ready";
    case "merge_policy_recover_already_merged_pull_request":
      return "already_merged_pull_request";
    default:
      return null;
  }
}
