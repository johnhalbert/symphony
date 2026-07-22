import { createHash } from "node:crypto";
import type { ServiceConfig } from "./config/Config.js";
import { parseIssueContract } from "./IssueContractLint.js";
import { issueBreakdownPlanFingerprintsMatch, latestFreshIssueBreakdownPlan } from "./IssueBreakdownPlanService.js";
import { issueTriageTriggerFingerprint } from "./IssueTriageService.js";
import type {
  IssueBreakdownCreatedIssueRef,
  IssueBreakdownPlanRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import { isSupersededLifecycleRecord } from "./persistence/IssueLifecycleStore.js";
import type { Issue } from "./types.js";
import type {
  EnqueueWritebackOptions,
  NewWritebackOperation,
  WritebackOperation,
  WritebackProcessor,
} from "./writeback/WritebackOutbox.js";
import { ISSUE_BREAKDOWN_PLAN_STALE_REASON } from "./writeback/WritebackOutbox.js";

export type IssueBreakdownPlanApplyResult =
  | { status: "not_required"; reason: string }
  | { status: "no_fresh_plan"; reason: string }
  | { status: "preview"; plan: IssueBreakdownPlanRecord; operations: NewWritebackOperation[] }
  | { status: "pending"; plan: IssueBreakdownPlanRecord; operations: WritebackOperation[] }
  | { status: "applied"; plan: IssueBreakdownPlanRecord; operations: WritebackOperation[] }
  | { status: "blocked"; plan: IssueBreakdownPlanRecord; operations: WritebackOperation[] | NewWritebackOperation[]; reason: string };

export interface IssueBreakdownPlanApplyServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writeback?:
    | (Pick<WritebackProcessor, "enqueueAndProcess"> &
        Partial<Pick<WritebackProcessor, "getOperation" | "retryRegistered">>)
    | undefined;
}

export interface IssueBreakdownPlanApplyOptions {
  dryRun?: boolean;
  retrySkippedAfterOperatorResume?: boolean;
}

export const ISSUE_BREAKDOWN_TRIAGE_PROVENANCE_INVALID_REASON =
  "issue breakdown plan application cannot verify its automated triage planner recovery provenance";
export const ISSUE_BREAKDOWN_OPERATOR_RESUME_RETRY_UNAVAILABLE_REASON =
  "issue breakdown operator resume cannot retry registered skipped writebacks";

export class IssueBreakdownPlanApplyService {
  constructor(private readonly options: IssueBreakdownPlanApplyServiceOptions) {}

  async previewLatestFreshPlan(issue: Issue): Promise<IssueBreakdownPlanApplyResult> {
    return this.applyLatestFreshPlan(issue, { dryRun: true });
  }

  async applyLatestFreshPlan(
    issue: Issue,
    options: IssueBreakdownPlanApplyOptions = {},
  ): Promise<IssueBreakdownPlanApplyResult> {
    if (!this.options.config.issueBreakdown.applyToLinear.enabled) {
      return { status: "not_required", reason: "apply_to_linear_disabled" };
    }
    const contract = parseIssueContract(issue.description);
    let lifecycle = await this.options.lifecycleStore.get(issue.id);
    const initialLatestPlanId = lifecycle?.lastIssueBreakdownPlanId ?? null;
    let latestPlan = initialLatestPlanId
      ? lifecycle?.issueBreakdownPlans.find(
          (candidate) => candidate.id === initialLatestPlanId,
        ) ?? null
      : null;
    if (options.dryRun !== true && lifecycle && latestPlan) {
      const hydratedPlan = await this.hydrateCreatedIssueRefs(
        issue,
        latestPlan,
      );
      if (hydratedPlan !== latestPlan) {
        lifecycle = await this.options.lifecycleStore.get(issue.id);
        const latestPlanId = lifecycle?.lastIssueBreakdownPlanId ?? null;
        latestPlan = latestPlanId
          ? lifecycle?.issueBreakdownPlans.find(
              (candidate) => candidate.id === latestPlanId,
            ) ?? null
          : null;
      }
    }
    if (
      lifecycle &&
      latestPlan &&
      !hasValidAutomatedTriagePlannerProvenance(
        issue,
        lifecycle,
        latestPlan,
        this.options.config,
        { allowAppliedPlanTargetDrift: latestPlan.applicationStatus === "applied" },
      )
    ) {
      const blockedPlan =
        options.dryRun === true
          ? latestPlan
          : await this.updatePlan(issue, latestPlan, {
              applicationStatus: "blocked",
              applicationBlockedReason:
                ISSUE_BREAKDOWN_TRIAGE_PROVENANCE_INVALID_REASON,
            });
      return {
        status: "blocked",
        plan: blockedPlan,
        operations: [],
        reason: ISSUE_BREAKDOWN_TRIAGE_PROVENANCE_INVALID_REASON,
      };
    }
    if (
      contract.valid &&
      contract.contract.delivery.mode === "accepted_artifact"
    ) {
      if (options.dryRun !== true && latestPlan) {
        await this.writeLatestPlanDisposition(issue, latestPlan);
      }
      return {
        status: "no_fresh_plan",
        reason: "accepted_artifact_contract_cannot_be_decomposed",
      };
    }
    const plan = latestFreshIssueBreakdownPlan(lifecycle, issue, this.options.config);
    if (!plan) {
      let markedStale = false;
      if (options.dryRun !== true) {
        if (latestPlan) await this.writeLatestPlanDisposition(issue, latestPlan);
        markedStale = await this.markStaleDriftedPlans(issue, lifecycle);
      }
      return { status: "no_fresh_plan", reason: markedStale ? ISSUE_BREAKDOWN_PLAN_STALE_REASON : "no_fresh_plan" };
    }
    if (plan.applicationStatus === "applied") return { status: "applied", plan, operations: [] };
    const childOperations = planIssueBreakdownApplicationWritebacks(issue, plan);
    if (options.dryRun === true) {
      const dependencyValidation = validatePlanDependencies(plan);
      if (dependencyValidation.length > 0) {
        const reason = `Issue breakdown dependencies are unresolved: ${dependencyValidation.join("; ")}`;
        return { status: "blocked", plan, operations: childOperations, reason };
      }
      return { status: "preview", plan, operations: childOperations };
    }
    if (!this.options.writeback || !this.options.config.writeback.enabled) {
      const updated = await this.updatePlan(issue, plan, {
        applicationStatus: "blocked",
        applicationBlockedReason: "issue breakdown apply requires writeback to be enabled",
      });
      return { status: "blocked", plan: updated, operations: [], reason: updated.applicationBlockedReason ?? "writeback unavailable" };
    }

    if (
      options.retrySkippedAfterOperatorResume === true &&
      plan.applicationStatus === "blocked"
    ) {
      const retryUnavailableReason =
        await this.retryRegisteredSkippedPlanOperations(plan);
      if (retryUnavailableReason !== null) {
        const updated = await this.updatePlan(issue, plan, {
          applicationStatus: "blocked",
          applicationBlockedReason: retryUnavailableReason,
        });
        return {
          status: "blocked",
          plan: updated,
          operations: [],
          reason: retryUnavailableReason,
        };
      }
    }

    const replayPlan = plan;
    const dispositionOperation = planIssueBreakdownDispositionWriteback(issue, plan);
    let workingPlan = await this.updatePlan(issue, plan, {
      applicationStatus: "pending",
      applicationOperationKeys: mergeOperationKeys(plan.applicationOperationKeys, [dispositionOperation]),
      applicationBlockedReason: null,
    });

    const dispositionResult = await this.options.writeback.enqueueAndProcess(
      dispositionOperation,
      issueBreakdownRetryOptions(dispositionOperation, replayPlan),
    );
    const processed: WritebackOperation[] = [dispositionResult];
    if (dispositionResult.status === "skipped" || dispositionResult.status === "dead_letter") {
      const updated = await this.updatePlan(issue, workingPlan, {
        applicationStatus: "blocked",
        applicationBlockedReason:
          dispositionResult.resultMessage ??
          dispositionResult.lastError ??
          "issue breakdown disposition writeback did not succeed",
      });
      return {
        status: "blocked",
        plan: updated,
        operations: processed,
        reason: updated.applicationBlockedReason ?? "issue breakdown apply blocked",
      };
    }
    if (dispositionResult.status !== "succeeded") {
      const pending = await this.updatePlan(issue, workingPlan, {
        applicationStatus: "pending",
        applicationBlockedReason: null,
      });
      return { status: "pending", plan: pending, operations: processed };
    }

    const dependencyValidation = validatePlanDependencies(plan);
    if (dependencyValidation.length > 0) {
      const reason = `Issue breakdown dependencies are unresolved: ${dependencyValidation.join("; ")}`;
      const updated = await this.updatePlan(issue, workingPlan, {
        applicationStatus: "blocked",
        applicationBlockedReason: reason,
      });
      return { status: "blocked", plan: updated, operations: processed, reason };
    }

    workingPlan = await this.updatePlan(issue, workingPlan, {
      applicationStatus: "pending",
      applicationOperationKeys: mergeOperationKeys(workingPlan.applicationOperationKeys, childOperations),
      applicationBlockedReason: null,
    });
    for (const operation of childOperations) {
      const result = await this.options.writeback.enqueueAndProcess(operation, issueBreakdownRetryOptions(operation, replayPlan));
      processed.push(result);
      const ref = createdIssueRefFromOperation(result);
      if (ref) {
        workingPlan = await this.updatePlan(issue, workingPlan, {
          createdIssueRefs: mergeCreatedIssueRefs(workingPlan.createdIssueRefs, [ref]),
        });
      }
    }

    const childBlocked = processed.find((operation) => operation.status === "skipped" || operation.status === "dead_letter");
    if (childBlocked) {
      const updated = await this.updatePlan(issue, workingPlan, {
        applicationStatus: "blocked",
        applicationBlockedReason: childBlocked.resultMessage ?? childBlocked.lastError ?? "issue breakdown child creation did not succeed",
      });
      return {
        status: "blocked",
        plan: updated,
        operations: processed,
        reason: updated.applicationBlockedReason ?? "issue breakdown apply blocked",
      };
    }

    if (workingPlan.createdIssueRefs.length < workingPlan.proposedIssues.length) {
      const pending = await this.updatePlan(issue, workingPlan, {
        applicationStatus: "pending",
        applicationBlockedReason: null,
      });
      return { status: "pending", plan: pending, operations: processed };
    }

    const finalOperations = planIssueBreakdownFinalizationWritebacks(issue, workingPlan, this.options.config);
    workingPlan = await this.updatePlan(issue, workingPlan, {
      applicationOperationKeys: mergeOperationKeys(workingPlan.applicationOperationKeys, finalOperations),
    });
    for (const operation of finalOperations) {
      const result = await this.options.writeback.enqueueAndProcess(
        operation,
        issueBreakdownRetryOptions(operation, replayPlan),
      );
      processed.push(result);
      if (result.status === "skipped" || result.status === "dead_letter") {
        const updated = await this.updatePlan(issue, workingPlan, {
          applicationStatus: "blocked",
          applicationBlockedReason:
            result.resultMessage ??
            result.lastError ??
            "issue breakdown finalization writeback did not succeed",
        });
        return {
          status: "blocked",
          plan: updated,
          operations: processed,
          reason:
            updated.applicationBlockedReason ??
            "issue breakdown apply blocked",
        };
      }
      if (result.status !== "succeeded") {
        const pending = await this.updatePlan(issue, workingPlan, {
          applicationStatus: "pending",
          applicationBlockedReason: null,
        });
        return {
          status: "pending",
          plan: pending,
          operations: processed,
        };
      }
    }

    const blocked = processed.find((operation) => operation.status === "skipped" || operation.status === "dead_letter");
    if (!blocked && processed.every((operation) => operation.status === "succeeded")) {
      const applied = await this.updatePlan(issue, plan, {
        applicationStatus: "applied",
        appliedAt: new Date().toISOString(),
        applicationBlockedReason: null,
      });
      return { status: "applied", plan: applied, operations: processed };
    }

    if (blocked) {
      const updated = await this.updatePlan(issue, workingPlan, {
        applicationStatus: "blocked",
        applicationBlockedReason: blocked.resultMessage ?? blocked.lastError ?? "issue breakdown apply writeback did not succeed",
      });
      return {
        status: "blocked",
        plan: updated,
        operations: processed,
        reason: updated.applicationBlockedReason ?? "issue breakdown apply blocked",
      };
    }

    const pending = await this.updatePlan(issue, workingPlan, {
      applicationStatus: "pending",
      applicationBlockedReason: null,
    });
    return { status: "pending", plan: pending, operations: processed };
  }

  private async hydrateCreatedIssueRefs(
    issue: Issue,
    plan: IssueBreakdownPlanRecord,
  ): Promise<IssueBreakdownPlanRecord> {
    const getOperation = this.options.writeback?.getOperation;
    if (!getOperation) return plan;

    const existingIndexes = new Set(
      plan.createdIssueRefs.map((ref) => ref.proposedIssueIndex),
    );
    const registeredKeys = new Set(plan.applicationOperationKeys);
    const hydratedRefs: IssueBreakdownCreatedIssueRef[] = [];
    for (const operation of planIssueBreakdownApplicationWritebacks(
      issue,
      plan,
    )) {
      if (operation.kind !== "issue_create") continue;
      if (
        existingIndexes.has(operation.payload.proposedIssueIndex) ||
        !registeredKeys.has(operation.idempotencyKey)
      ) {
        continue;
      }
      const record = await getOperation.call(
        this.options.writeback,
        operation.idempotencyKey,
      );
      if (!isMatchingSucceededIssueCreate(record, operation, plan)) continue;
      const ref = createdIssueRefFromOperation(record);
      if (ref) hydratedRefs.push(ref);
    }
    if (hydratedRefs.length === 0) return plan;
    return this.updatePlan(issue, plan, {
      createdIssueRefs: mergeCreatedIssueRefs(
        plan.createdIssueRefs,
        hydratedRefs,
      ),
    });
  }

  private async retryRegisteredSkippedPlanOperations(
    plan: IssueBreakdownPlanRecord,
  ): Promise<string | null> {
    const getOperation = this.options.writeback?.getOperation;
    const retryRegistered = this.options.writeback?.retryRegistered;
    if (!getOperation || !retryRegistered) {
      return ISSUE_BREAKDOWN_OPERATOR_RESUME_RETRY_UNAVAILABLE_REASON;
    }

    for (const operationKey of plan.applicationOperationKeys) {
      const record = await getOperation.call(
        this.options.writeback,
        operationKey,
      );
      if (record?.status !== "skipped") continue;
      if (!writebackOperationBelongsToPlan(record, plan)) {
        return `${ISSUE_BREAKDOWN_OPERATOR_RESUME_RETRY_UNAVAILABLE_REASON}: ${operationKey} is not bound to plan ${plan.id}`;
      }
      await retryRegistered.call(
        this.options.writeback,
        [operationKey],
        { retrySkipped: true },
      );
    }
    return null;
  }

  private async updatePlan(
    issue: Issue,
    plan: IssueBreakdownPlanRecord,
    patch: Partial<
      Pick<
        IssueBreakdownPlanRecord,
        | "applicationStatus"
        | "applicationOperationKeys"
        | "createdIssueRefs"
        | "appliedAt"
        | "applicationBlockedReason"
      >
    >,
  ): Promise<IssueBreakdownPlanRecord> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const plans = lifecycle?.issueBreakdownPlans ?? [];
    const currentPlan = plans.find((candidate) => candidate.id === plan.id) ?? plan;
    const updatedPlan: IssueBreakdownPlanRecord = { ...currentPlan, ...patch };
    await this.options.lifecycleStore.updateIssue(issue, {
      issueBreakdownPlans: plans.map((candidate) => (candidate.id === plan.id ? updatedPlan : candidate)),
      lastIssueBreakdownPlanId: lifecycle?.lastIssueBreakdownPlanId ?? null,
    });
    return updatedPlan;
  }

  private async writeLatestPlanDisposition(
    issue: Issue,
    plan: IssueBreakdownPlanRecord,
  ): Promise<WritebackOperation | null> {
    if (!this.options.writeback || !this.options.config.writeback.enabled) return null;
    const operation = planIssueBreakdownDispositionWriteback(issue, plan);
    await this.updatePlan(issue, plan, {
      applicationOperationKeys: mergeOperationKeys(plan.applicationOperationKeys, [operation]),
    });
    return this.options.writeback.enqueueAndProcess(
      operation,
      issueBreakdownRetryOptions(operation, plan),
    );
  }

  private async markStaleDriftedPlans(issue: Issue, lifecycle: IssueLifecycleRecord | null): Promise<boolean> {
    if (!lifecycle) return false;
    let markedStale = false;
    for (const plan of lifecycle.issueBreakdownPlans) {
      if (plan.applicationStatus !== "pending" && plan.applicationStatus !== "blocked") continue;
      if (issueBreakdownPlanFingerprintsMatch(plan, issue, this.options.config)) continue;
      await this.updatePlan(issue, plan, {
        applicationStatus: "stale",
        applicationBlockedReason: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
      });
      markedStale = true;
    }
    return markedStale;
  }
}

function hasValidAutomatedTriagePlannerProvenance(
  issue: Issue,
  lifecycle: IssueLifecycleRecord,
  plan: IssueBreakdownPlanRecord,
  config: ServiceConfig,
  options: { allowAppliedPlanTargetDrift: boolean },
): boolean {
  const sourceReportId = plan.sourceIssueTriageReportId ?? null;
  if (sourceReportId === null) return true;
  const sourceIsCurrent = lifecycle.lastIssueTriageReportId === sourceReportId;
  const sourceWasConsumed =
    options.allowAppliedPlanTargetDrift &&
    lifecycle.lastIssueTriageReportId === null;
  if (!sourceIsCurrent && !sourceWasConsumed) return false;
  const report = lifecycle.issueTriageReports.find(
    (candidate) => candidate.id === sourceReportId,
  );
  if (
    !report ||
    isSupersededLifecycleRecord(report) ||
    report.issueId !== issue.id ||
    (sourceIsCurrent &&
      report.triggerFingerprint !== issueTriageTriggerFingerprint(lifecycle))
  ) {
    return false;
  }

  const recovery = report.recoveryDisposition;
  if (
    !recovery ||
    recovery.mode !== "automated" ||
    recovery.nextActor !== "planner" ||
    recovery.targetState === null ||
    !statesEqual(recovery.targetState, config.writeback.dispatchState) ||
    (!options.allowAppliedPlanTargetDrift &&
      !statesEqual(issue.state, recovery.targetState))
  ) {
    return false;
  }
  if (recovery.transitionStatus === "not_required") {
    return recovery.transitionOperationKey === null;
  }
  return (
    recovery.transitionStatus === "applied" &&
    recovery.transitionOperationKey !== null &&
    report.writebackOperationKeys.includes(recovery.transitionOperationKey)
  );
}

function isMatchingSucceededIssueCreate(
  record: WritebackOperation | null,
  expected: Extract<NewWritebackOperation, { kind: "issue_create" }>,
  plan: IssueBreakdownPlanRecord,
): record is Extract<WritebackOperation, { kind: "issue_create" }> {
  return Boolean(
    record &&
      record.status === "succeeded" &&
      record.kind === "issue_create" &&
      record.idempotencyKey === expected.idempotencyKey &&
      record.issueId === expected.issueId &&
      record.runId === expected.runId &&
      record.payload.planId === plan.id &&
      record.payload.proposedIssueIndex ===
        expected.payload.proposedIssueIndex &&
      record.payload.payloadHash === expected.payload.payloadHash,
  );
}

function writebackOperationBelongsToPlan(
  operation: WritebackOperation,
  plan: IssueBreakdownPlanRecord,
): boolean {
  if (operation.issueId !== plan.issueId || operation.runId !== plan.runId)
    return false;
  if (operation.kind === "issue_create")
    return operation.payload.planId === plan.id;
  if (operation.kind === "issue_relation")
    return operation.payload.planId === plan.id;
  if (operation.kind === "transition")
    return operation.payload.issueBreakdownPlanId === plan.id;
  if (operation.kind !== "comment") return false;
  return (
    operation.payload.issueBreakdownPlanId === plan.id ||
    operation.idempotencyKey ===
      `comment:${plan.issueId}:issue-breakdown:${plan.id}:disposition` ||
    operation.idempotencyKey ===
      `comment:${plan.issueId}:issue-breakdown:${plan.id}:children`
  );
}

function statesEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function planIssueBreakdownApplicationWritebacks(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
): NewWritebackOperation[] {
  return plan.proposedIssues.map((proposedIssue, index) => {
    const payloadHash = proposalHash(proposedIssue);
    const dedupeKey = `issue-breakdown:${plan.id}:${index}:${payloadHash}`;
    return {
      idempotencyKey: `issue-create:${issue.id}:${plan.id}:${index}:${payloadHash}`,
      kind: "issue_create",
      issueId: issue.id,
      runId: plan.runId,
      payload: {
        parentIssueId: issue.id,
        planId: plan.id,
        proposedIssueIndex: index,
        title: proposedIssue.title,
        description: proposedIssue.description,
        acceptanceCriteria: proposedIssue.acceptanceCriteria,
        requestedLabels: proposedIssue.labels,
        dependencies: proposedIssue.dependencies,
        dedupeKey,
        payloadHash,
      },
    };
  });
}

export function planIssueBreakdownDispositionWriteback(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
): NewWritebackOperation {
  const dedupeKey = `issue-breakdown-disposition:${plan.id}`;
  return {
    idempotencyKey: issueBreakdownDispositionOperationKey(issue, plan),
    kind: "comment",
    issueId: issue.id,
    runId: plan.runId,
    payload: {
      issueBreakdownPlanId: plan.id,
      dedupeKey,
      body: [
        "## Symphony Issue Breakdown Plan",
        "",
        "Status: accepted for application",
        `Plan: ${plan.id}`,
        `Run: ${plan.runId}`,
        ...(plan.finalDisposition === undefined
          ? []
          : ["", "Agent final disposition:", plan.finalDisposition]),
      ].join("\n"),
    },
  };
}

export function planIssueBreakdownFinalizationWritebacks(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
  config?: ServiceConfig,
): NewWritebackOperation[] {
  const operations: NewWritebackOperation[] = [];
  const refsByIndex = new Map(plan.createdIssueRefs.map((ref) => [ref.proposedIssueIndex, ref]));
  for (const ref of plan.createdIssueRefs) {
    operations.push({
      idempotencyKey: `issue-relation:${issue.id}:${plan.id}:${ref.proposedIssueIndex}:parent`,
      kind: "issue_relation",
      issueId: issue.id,
      runId: plan.runId,
      payload: {
        planId: plan.id,
        sourceIssueId: ref.id,
        sourceIssueIdentifier: ref.identifier,
        targetIssueId: issue.id,
        targetIssueIdentifier: issue.identifier,
        type: "blocks",
        dependency: `Blocks parent issue ${issue.identifier}`,
        dedupeKey: `issue-breakdown-parent-relation:${plan.id}:${ref.proposedIssueIndex}`,
        sourceProposedIssueIndex: ref.proposedIssueIndex,
        targetProposedIssueIndex: -1,
      },
    });
  }
  for (const relation of dependencyRelations(plan)) {
    const source = refsByIndex.get(relation.sourceProposedIssueIndex);
    const target = refsByIndex.get(relation.targetProposedIssueIndex);
    if (!source || !target) continue;
    operations.push({
      idempotencyKey: `issue-relation:${issue.id}:${plan.id}:${relation.sourceProposedIssueIndex}:${relation.targetProposedIssueIndex}`,
      kind: "issue_relation",
      issueId: issue.id,
      runId: plan.runId,
      payload: {
        planId: plan.id,
        sourceIssueId: source.id,
        sourceIssueIdentifier: source.identifier,
        targetIssueId: target.id,
        targetIssueIdentifier: target.identifier,
        type: "blocks",
        dependency: relation.dependency,
        dedupeKey: `issue-breakdown-relation:${plan.id}:${relation.sourceProposedIssueIndex}:${relation.targetProposedIssueIndex}`,
        sourceProposedIssueIndex: relation.sourceProposedIssueIndex,
        targetProposedIssueIndex: relation.targetProposedIssueIndex,
      },
    });
  }
  operations.push({
    idempotencyKey: issueBreakdownChildrenCommentOperationKey(issue, plan),
    kind: "comment",
    issueId: issue.id,
    runId: plan.runId,
    payload: {
      issueBreakdownPlanId: plan.id,
      dedupeKey: `issue-breakdown-children:${plan.id}`,
      body: renderParentComment(issue, plan),
    },
  });
  const reviewState = config?.reviewLoop.reviewStates[0] ?? null;
  if (config && reviewState) {
    operations.push({
      idempotencyKey: `transition:${issue.id}:issue-breakdown:${plan.id}:${reviewState}`,
      kind: "transition",
      issueId: issue.id,
      runId: plan.runId,
      payload: {
        toState: reviewState,
        fromStates: [...config.reviewLoop.blockedStates, ...config.tracker.activeStates],
        reason: "Symphony issue breakdown created blocking child issues; parent is ready for gated review",
        issueBreakdownPlanId: plan.id,
      },
    });
  }
  return operations;
}

function createdIssueRefFromOperation(operation: WritebackOperation): IssueBreakdownCreatedIssueRef | null {
  if (operation.kind !== "issue_create" || !operation.resultEvidence?.issue) return null;
  if (operation.resultEvidence.issueCreateStatus !== "created" && operation.resultEvidence.issueCreateStatus !== "verified") {
    return null;
  }
  return {
    proposedIssueIndex: operation.payload.proposedIssueIndex,
    operationKey: operation.idempotencyKey,
    status: operation.resultEvidence.issueCreateStatus,
    id: operation.resultEvidence.issue.id,
    identifier: operation.resultEvidence.issue.identifier,
    url: operation.resultEvidence.issue.url,
  };
}

function issueBreakdownRetryOptions(
  operation: NewWritebackOperation,
  replayPlan: IssueBreakdownPlanRecord,
): EnqueueWritebackOptions {
  if (!replayPlan.applicationOperationKeys.includes(operation.idempotencyKey)) return {};
  return {
    retrySkipped: true,
    retrySkippedMessages: [ISSUE_BREAKDOWN_PLAN_STALE_REASON, "Writeback dry_run"],
  };
}

function mergeOperationKeys(existing: string[], operations: NewWritebackOperation[]): string[] {
  const keys = new Set(existing);
  for (const operation of operations) keys.add(operation.idempotencyKey);
  return [...keys];
}

function mergeCreatedIssueRefs(
  existing: IssueBreakdownCreatedIssueRef[],
  incoming: IssueBreakdownCreatedIssueRef[],
): IssueBreakdownCreatedIssueRef[] {
  const byIndex = new Map(existing.map((ref) => [ref.proposedIssueIndex, ref]));
  for (const ref of incoming) byIndex.set(ref.proposedIssueIndex, ref);
  return [...byIndex.values()].sort((left, right) => left.proposedIssueIndex - right.proposedIssueIndex);
}

function validatePlanDependencies(plan: IssueBreakdownPlanRecord): string[] {
  const byTitle = new Map<string, number[]>();
  plan.proposedIssues.forEach((proposedIssue, index) => {
    const key = proposedIssue.title.trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), index]);
  });
  const errors: string[] = [];
  plan.proposedIssues.forEach((proposedIssue, index) => {
    for (const dependency of proposedIssue.dependencies) {
      const key = dependency.trim().toLowerCase();
      if (!key) continue;
      const matches = byTitle.get(key) ?? [];
      if (matches.length === 0) {
        errors.push(`"${proposedIssue.title}" references missing dependency "${dependency}"`);
      } else if (matches.length > 1) {
        errors.push(`"${proposedIssue.title}" references ambiguous dependency "${dependency}"`);
      } else if (matches[0] === index) {
        errors.push(`"${proposedIssue.title}" cannot depend on itself`);
      }
    }
  });
  return errors;
}

function dependencyRelations(plan: IssueBreakdownPlanRecord): Array<{
  sourceProposedIssueIndex: number;
  targetProposedIssueIndex: number;
  dependency: string;
}> {
  const byTitle = new Map(plan.proposedIssues.map((proposedIssue, index) => [proposedIssue.title.trim().toLowerCase(), index]));
  const relations: Array<{ sourceProposedIssueIndex: number; targetProposedIssueIndex: number; dependency: string }> = [];
  plan.proposedIssues.forEach((proposedIssue, targetProposedIssueIndex) => {
    for (const dependency of proposedIssue.dependencies) {
      const sourceProposedIssueIndex = byTitle.get(dependency.trim().toLowerCase());
      if (sourceProposedIssueIndex === undefined) continue;
      relations.push({ sourceProposedIssueIndex, targetProposedIssueIndex, dependency });
    }
  });
  return relations;
}

function renderParentComment(issue: Issue, plan: IssueBreakdownPlanRecord): string {
  const dispositionAlreadyWritten = plan.applicationOperationKeys.includes(
    issueBreakdownDispositionOperationKey(issue, plan),
  );
  const refs = plan.createdIssueRefs
    .slice()
    .sort((left, right) => left.proposedIssueIndex - right.proposedIssueIndex)
    .map((ref) => {
      const proposed = plan.proposedIssues[ref.proposedIssueIndex];
      const label = ref.identifier ?? ref.id;
      const link = ref.url ? `[${label}](${ref.url})` : label;
      return `- ${link}: ${proposed?.title ?? `Proposed issue ${ref.proposedIssueIndex + 1}`}`;
    });
  return [
    `Applied issue breakdown plan ${plan.id} for ${issue.identifier}.`,
    ...(plan.finalDisposition === undefined || dispositionAlreadyWritten
      ? []
      : ["", "Agent final disposition:", plan.finalDisposition]),
    "",
    "Created child issues:",
    ...refs,
  ].join("\n");
}

function issueBreakdownDispositionOperationKey(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
): string {
  return `comment:${issue.id}:issue-breakdown:${plan.id}:disposition`;
}

function issueBreakdownChildrenCommentOperationKey(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
): string {
  return `comment:${issue.id}:issue-breakdown:${plan.id}:children`;
}

function proposalHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
