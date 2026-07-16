import { createHash } from "node:crypto";

import {
  baseRefObservationIsTransient,
  type IssueBaseRefObservation,
} from "./BaseRefVerification.js";
import type {
  CompletionReportPullRequestRef,
  IssueBlockerProvenanceRecord,
  IssueBlockerProvenanceResolution,
  IssueLifecyclePatch,
  IssueLifecycleRecord,
} from "./persistence/IssueLifecycleStore.js";
import type { Issue } from "./types.js";

export function createReviewFeedbackBaseRefProvenance(input: {
  issue: Pick<Issue, "id" | "identifier">;
  runId: string;
  pullRequestNumber: number;
  pullRequestHeadSha: string;
  observation: IssueBaseRefObservation;
  observationAttempt?: number;
  reviewVerdictId?: string | null;
}): IssueBlockerProvenanceRecord {
  return createBaseRefBlockerProvenance(input);
}

export function createBaseRefBlockerProvenance(input: {
  issue: Pick<Issue, "id" | "identifier">;
  runId: string;
  pullRequestNumber?: number | null;
  pullRequestHeadSha?: string | null;
  observation: IssueBaseRefObservation;
  observationAttempt?: number;
  reviewVerdictId?: string | null;
}): IssueBlockerProvenanceRecord {
  const createdAt = input.observation.checkedAt;
  const observationAttempt = input.observationAttempt ?? 1;
  const identity = JSON.stringify({
    issueId: input.issue.id,
    runId: input.runId,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestHeadSha: input.pullRequestHeadSha,
    operation: input.observation.operation,
    observationFingerprint: input.observation.inputFingerprint,
    classification: input.observation.classification,
    checkedAt: createdAt,
    observationAttempt,
  });
  return {
    version: 1,
    id: `blocker-provenance:${createHash("sha256").update(identity).digest("hex")}`,
    code:
      input.observation.classification === "branch_not_based_on_live_base"
        ? "base_ref_drift"
        : "base_ref_verification_failure",
    recoveryKind: recoveryKindForObservation(input.observation),
    sourceKind: "base_ref_observation",
    initialObservationFingerprint: input.observation.inputFingerprint,
    initialClassification: input.observation.classification,
    initialLiveBaseHeadSha: input.observation.githubBaseHeadSha,
    initialWorktreeHeadSha: input.observation.worktreeHeadSha,
    sourceObservationFingerprint: input.observation.inputFingerprint,
    classification: input.observation.classification,
    operation: input.observation.operation,
    runId: input.runId,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestHeadSha: input.pullRequestHeadSha ?? null,
    baseRef: input.observation.baseRef,
    liveBaseHeadSha: input.observation.githubBaseHeadSha,
    worktreeHeadSha: input.observation.worktreeHeadSha,
    observationAttempt,
    lastObservedAt: createdAt,
    reviewVerdictId: input.reviewVerdictId ?? null,
    createdAt,
    resolvedAt: null,
    resolution: null,
  };
}

export function updateReviewFeedbackBaseRefProvenanceObservationPatch(
  lifecycle: IssueLifecycleRecord,
  provenanceId: string,
  observation: IssueBaseRefObservation,
): Pick<IssueLifecyclePatch, "blockerProvenances"> {
  return updateBaseRefBlockerProvenanceObservationPatch(
    lifecycle,
    provenanceId,
    observation,
  );
}

export function updateBaseRefBlockerProvenanceObservationPatch(
  lifecycle: IssueLifecycleRecord,
  provenanceId: string,
  observation: IssueBaseRefObservation,
): Pick<IssueLifecyclePatch, "blockerProvenances"> {
  const provenance = activeBlockerProvenance(lifecycle);
  if (provenance === null || provenance.id !== provenanceId) return {};
  return {
    blockerProvenances: (lifecycle.blockerProvenances ?? []).map((record) =>
      record.id === provenance.id
        ? {
            ...record,
            code:
              observation.classification === "branch_not_based_on_live_base"
                ? "base_ref_drift"
                : "base_ref_verification_failure",
            recoveryKind:
              observation.classification === "ok"
                ? record.recoveryKind
                : recoveryKindForObservation(observation),
            sourceObservationFingerprint: observation.inputFingerprint,
            classification: observation.classification,
            operation: observation.operation,
            baseRef: observation.baseRef,
            liveBaseHeadSha: observation.githubBaseHeadSha,
            worktreeHeadSha: observation.worktreeHeadSha,
            observationAttempt:
              Number.isInteger(record.observationAttempt) &&
              record.observationAttempt > 0
                ? record.observationAttempt + 1
                : 2,
            lastObservedAt: observation.checkedAt,
          }
        : record,
    ),
  };
}

export function blockerProvenanceMatchesObservation(
  provenance: IssueBlockerProvenanceRecord,
  observation: IssueBaseRefObservation,
  input: {
    runId?: string | null;
    pullRequestNumber?: number | null;
    pullRequestHeadSha?: string | null;
  } = {},
): boolean {
  return (
    provenance.resolvedAt === null &&
    provenance.resolution === null &&
    provenance.sourceKind === "base_ref_observation" &&
    provenance.operation === observation.operation &&
    provenance.sourceObservationFingerprint === observation.inputFingerprint &&
    provenance.classification === observation.classification &&
    provenance.baseRef === observation.baseRef &&
    provenance.liveBaseHeadSha === observation.githubBaseHeadSha &&
    provenance.worktreeHeadSha === observation.worktreeHeadSha &&
    (provenance.lastObservedAt ?? provenance.createdAt) ===
      observation.checkedAt &&
    (input.runId === undefined || provenance.runId === input.runId) &&
    (input.pullRequestNumber === undefined ||
      provenance.pullRequestNumber === input.pullRequestNumber) &&
    (input.pullRequestHeadSha === undefined ||
      provenance.pullRequestHeadSha === input.pullRequestHeadSha)
  );
}

function recoveryKindForObservation(
  observation: IssueBaseRefObservation,
): IssueBlockerProvenanceRecord["recoveryKind"] {
  if (observation.classification === "branch_not_based_on_live_base") {
    return "automatic_rebase";
  }
  return baseRefObservationIsTransient(observation)
    ? "automatic_recheck"
    : "operator_triage";
}

export function activateBlockerProvenancePatch(
  lifecycle: IssueLifecycleRecord,
  provenance: IssueBlockerProvenanceRecord,
): Pick<IssueLifecyclePatch, "blockerProvenances" | "activeBlockerProvenanceId"> {
  const records = (lifecycle.blockerProvenances ?? []).map((record) =>
    record.id === lifecycle.activeBlockerProvenanceId &&
    record.id !== provenance.id &&
    record.resolvedAt === null
      ? {
          ...record,
          resolvedAt: provenance.createdAt,
          resolution: "superseded" as const,
        }
      : record,
  );
  const existingIndex = records.findIndex((record) => record.id === provenance.id);
  if (existingIndex === -1) records.push(provenance);
  else records[existingIndex] = provenance;
  return {
    blockerProvenances: records,
    activeBlockerProvenanceId: provenance.id,
  };
}

export function activeBlockerProvenance(
  lifecycle: Pick<
    IssueLifecycleRecord,
    "blockerProvenances" | "activeBlockerProvenanceId"
  >,
): IssueBlockerProvenanceRecord | null {
  if (!lifecycle.activeBlockerProvenanceId) return null;
  const record = (lifecycle.blockerProvenances ?? []).find(
    (candidate) => candidate.id === lifecycle.activeBlockerProvenanceId,
  );
  return record?.resolvedAt === null ? record : null;
}

export function matchingReviewFeedbackBaseRefProvenance(
  lifecycle: IssueLifecycleRecord,
  input: {
    runId: string;
    pullRequest: CompletionReportPullRequestRef;
  },
): IssueBlockerProvenanceRecord | null {
  const provenance = activeBlockerProvenance(lifecycle);
  const pullRequestNumber = input.pullRequest.number;
  const pullRequestHeadSha = input.pullRequest.headSha?.trim() ?? "";
  const observation = lifecycle.baseRefObservation ?? null;
  if (
    provenance === null ||
    provenance.sourceKind !== "base_ref_observation" ||
    provenance.operation !== "review_feedback" ||
    provenance.runId !== input.runId ||
    pullRequestNumber === null ||
    provenance.pullRequestNumber !== pullRequestNumber ||
    pullRequestHeadSha.length === 0 ||
    provenance.pullRequestHeadSha !== pullRequestHeadSha ||
    observation === null ||
    observation.operation !== "review_feedback" ||
    provenance.sourceObservationFingerprint !== observation.inputFingerprint ||
    provenance.classification !== observation.classification
  ) {
    return null;
  }
  return provenance;
}

export function linkBlockerProvenanceToVerdictPatch(
  lifecycle: IssueLifecycleRecord,
  provenanceId: string | null,
  verdictId: string,
): Pick<IssueLifecyclePatch, "blockerProvenances"> {
  if (provenanceId === null) return {};
  return {
    blockerProvenances: (lifecycle.blockerProvenances ?? []).map((record) =>
      record.id === provenanceId
        ? { ...record, reviewVerdictId: verdictId }
        : record,
    ),
  };
}

export function resolveActiveBlockerProvenancePatch(
  lifecycle: IssueLifecycleRecord,
  input: {
    resolution: IssueBlockerProvenanceResolution;
    resolvedAt?: string;
    expectedProvenanceId?: string | null;
    expectedObservation?: IssueBaseRefObservation | null;
  },
): Pick<IssueLifecyclePatch, "blockerProvenances" | "activeBlockerProvenanceId"> {
  const provenance = activeBlockerProvenance(lifecycle);
  if (provenance === null) return {};
  if (
    input.expectedProvenanceId !== undefined &&
    input.expectedProvenanceId !== null &&
    provenance.id !== input.expectedProvenanceId
  ) {
    return {};
  }
  if (
    input.expectedObservation !== undefined &&
    input.expectedObservation !== null &&
    (provenance.sourceObservationFingerprint !==
      input.expectedObservation.inputFingerprint ||
      provenance.classification !== input.expectedObservation.classification ||
      provenance.worktreeHeadSha !== input.expectedObservation.worktreeHeadSha)
  ) {
    return {};
  }
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  return {
    blockerProvenances: (lifecycle.blockerProvenances ?? []).map((record) =>
      record.id === provenance.id
        ? {
            ...record,
            resolvedAt,
            resolution: input.resolution,
          }
        : record,
    ),
    activeBlockerProvenanceId: null,
  };
}
