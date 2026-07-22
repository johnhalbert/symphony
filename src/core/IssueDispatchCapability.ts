import type { ServiceConfig } from "./config/Config.js";
import type { Issue } from "./types.js";

export type WorkerDispatchCapabilityReason =
  | "dispatch_state_not_active"
  | "issue_unassigned"
  | "issue_has_children"
  | "missing_required_label"
  | "excluded_label"
  | "worker_excluded_label"
  | "incomplete_turn_limit"
  | "merge_conflict_active"
  | "planning_required"
  | "issue_breakdown_application_required";

export interface WorkerDispatchCapability {
  available: boolean;
  reason: WorkerDispatchCapabilityReason | null;
}

export interface WorkerDispatchCapabilityContext {
  hasFreshIssueBreakdownPlan?: boolean;
  issueBreakdownPlanApplicationStatus?: string | null;
  incompleteTurnCount?: number;
  hasActiveMergeConflict?: boolean;
}

/**
 * Evaluates durable worker-dispatch guardrails only. Runtime capacity, claims,
 * pauses, and retry backoff are transient and must not force an issue into
 * Blocked during triage.
 */
export function evaluateWorkerDispatchCapability(
  issue: Issue,
  config: ServiceConfig,
  targetState: string,
  context: WorkerDispatchCapabilityContext = {},
): WorkerDispatchCapability {
  if (!containsState(config.tracker.activeStates, targetState)) {
    return unavailable("dispatch_state_not_active");
  }
  if (!issue.assignedToWorker) return unavailable("issue_unassigned");
  if (
    issue.hasChildren === true ||
    issue.childrenTruncated === true ||
    (issue.children?.length ?? 0) > 0
  ) {
    return unavailable("issue_has_children");
  }
  if (
    (context.incompleteTurnCount ?? 0) >=
    config.reviewLoop.maxIncompleteTurns
  ) {
    return unavailable("incomplete_turn_limit");
  }
  if (context.hasActiveMergeConflict === true) {
    return unavailable("merge_conflict_active");
  }

  const labels = new Set(issue.labels.map(normalizeName));
  if (
    config.agent.requireLabels.some(
      (label) => !labels.has(normalizeName(label)),
    )
  ) {
    return unavailable("missing_required_label");
  }
  if (
    config.agent.excludeLabels.some((label) =>
      labels.has(normalizeName(label)),
    )
  ) {
    return unavailable("excluded_label");
  }
  if (
    config.agent.workerExcludeLabels.some((label) =>
      labels.has(normalizeName(label)),
    )
  ) {
    return unavailable("worker_excluded_label");
  }

  const hasPlanningLabel =
    config.issueBreakdown.enabled &&
    config.issueBreakdown.planningLabels.some((label) =>
      labels.has(normalizeName(label)),
    );
  if (hasPlanningLabel) {
    if (context.hasFreshIssueBreakdownPlan !== true) {
      return unavailable("planning_required");
    }
    if (config.issueBreakdown.applyToLinear.enabled) {
      return unavailable("issue_breakdown_application_required");
    }
  }

  return { available: true, reason: null };
}

function unavailable(
  reason: WorkerDispatchCapabilityReason,
): WorkerDispatchCapability {
  return { available: false, reason };
}

function containsState(states: readonly string[], state: string): boolean {
  const normalized = normalizeName(state);
  return states.some((candidate) => normalizeName(candidate) === normalized);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
