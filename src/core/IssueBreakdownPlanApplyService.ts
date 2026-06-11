import { createHash } from "node:crypto";
import type { ServiceConfig } from "./config/Config.js";
import { issueBreakdownPlanFingerprintsMatch, latestFreshIssueBreakdownPlan } from "./IssueBreakdownPlanService.js";
import type {
  IssueBreakdownCreatedIssueRef,
  IssueBreakdownPlanRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import type { Issue } from "./types.js";
import type {
  EnqueueWritebackOptions,
  NewWritebackOperation,
  WritebackOperation,
  WritebackProcessor,
} from "./writeback/WritebackOutbox.js";
import { ISSUE_BREAKDOWN_PLAN_STALE_REASON } from "./writeback/WritebackOutbox.js";
import {
  mergeWritebackProjectContexts,
  stampWritebackProjectContexts,
  writebackProjectContextFromIssue,
} from "./writeback/ProjectContextAttribution.js";

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
  writeback?: Pick<WritebackProcessor, "enqueueAndProcess"> | undefined;
}

export class IssueBreakdownPlanApplyService {
  constructor(private readonly options: IssueBreakdownPlanApplyServiceOptions) {}

  async previewLatestFreshPlan(issue: Issue): Promise<IssueBreakdownPlanApplyResult> {
    return this.applyLatestFreshPlan(issue, { dryRun: true });
  }

  async applyLatestFreshPlan(
    issue: Issue,
    options: { dryRun?: boolean } = {},
  ): Promise<IssueBreakdownPlanApplyResult> {
    if (!this.options.config.issueBreakdown.applyToLinear.enabled) {
      return { status: "not_required", reason: "apply_to_linear_disabled" };
    }
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const plan = latestFreshIssueBreakdownPlan(lifecycle, issue, this.options.config);
    if (!plan) {
      let markedStale = false;
      if (options.dryRun !== true) {
        markedStale = await this.markStaleDriftedPlans(issue, lifecycle);
      }
      return { status: "no_fresh_plan", reason: markedStale ? ISSUE_BREAKDOWN_PLAN_STALE_REASON : "no_fresh_plan" };
    }
    if (plan.applicationStatus === "applied") return { status: "applied", plan, operations: [] };
    const childOperations = planIssueBreakdownApplicationWritebacks(issue, plan);
    const dependencyValidation = validatePlanDependencies(plan);
    if (dependencyValidation.length > 0) {
      const reason = `Issue breakdown dependencies are unresolved: ${dependencyValidation.join("; ")}`;
      if (options.dryRun === true) return { status: "blocked", plan, operations: childOperations, reason };
      const updated = await this.updatePlan(issue, plan, {
        applicationStatus: "blocked",
        applicationBlockedReason: reason,
        applicationOperationKeys: [],
      });
      return { status: "blocked", plan: updated, operations: [], reason };
    }
    if (options.dryRun === true) return { status: "preview", plan, operations: childOperations };
    if (!this.options.writeback || !this.options.config.writeback.enabled) {
      const updated = await this.updatePlan(issue, plan, {
        applicationStatus: "blocked",
        applicationBlockedReason: "issue breakdown apply requires writeback to be enabled",
      });
      return { status: "blocked", plan: updated, operations: [], reason: updated.applicationBlockedReason ?? "writeback unavailable" };
    }

    const replayPlan = plan;
    let workingPlan = await this.updatePlan(issue, plan, {
      applicationStatus: "pending",
      applicationOperationKeys: mergeOperationKeys(plan.applicationOperationKeys, childOperations),
      applicationBlockedReason: null,
    });

    const processed: WritebackOperation[] = [];
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

    const finalOperations = planIssueBreakdownFinalizationWritebacks(issue, workingPlan);
    workingPlan = await this.updatePlan(issue, workingPlan, {
      applicationOperationKeys: mergeOperationKeys(workingPlan.applicationOperationKeys, finalOperations),
    });
    for (const operation of finalOperations) {
      processed.push(await this.options.writeback.enqueueAndProcess(operation, issueBreakdownRetryOptions(operation, replayPlan)));
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

export function planIssueBreakdownApplicationWritebacks(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
): NewWritebackOperation[] {
  return stampWritebackProjectContexts(
    plan.proposedIssues.map((proposedIssue, index) => {
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
    }),
    mergeWritebackProjectContexts(
      writebackProjectContextFromIssue(issue),
      plan.projectContext == null
        ? undefined
        : {
            projectContext: plan.projectContext,
            projectContextId: plan.projectContext.projectContextId,
            projectContextLabel: plan.projectContext.projectContextLabel,
          },
    ),
  );
}

export function planIssueBreakdownFinalizationWritebacks(
  issue: Issue,
  plan: IssueBreakdownPlanRecord,
): NewWritebackOperation[] {
  const operations: NewWritebackOperation[] = [];
  const refsByIndex = new Map(plan.createdIssueRefs.map((ref) => [ref.proposedIssueIndex, ref]));
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
    idempotencyKey: `comment:${issue.id}:issue-breakdown:${plan.id}:children`,
    kind: "comment",
    issueId: issue.id,
    runId: plan.runId,
    payload: {
      issueBreakdownPlanId: plan.id,
      dedupeKey: `issue-breakdown-children:${plan.id}`,
      body: renderParentComment(issue, plan),
    },
  });
  return stampWritebackProjectContexts(
    operations,
    mergeWritebackProjectContexts(
      writebackProjectContextFromIssue(issue),
      plan.projectContext == null
        ? undefined
        : {
            projectContext: plan.projectContext,
            projectContextId: plan.projectContext.projectContextId,
            projectContextLabel: plan.projectContext.projectContextLabel,
          },
    ),
  );
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
    "",
    "Created child issues:",
    ...refs,
  ].join("\n");
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
