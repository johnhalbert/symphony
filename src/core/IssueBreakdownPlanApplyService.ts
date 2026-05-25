import { createHash } from "node:crypto";
import type { ServiceConfig } from "./config/Config.js";
import { latestFreshIssueBreakdownPlan } from "./IssueBreakdownPlanService.js";
import type {
  IssueBreakdownCreatedIssueRef,
  IssueBreakdownPlanRecord,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import type { Issue } from "./types.js";
import type { NewWritebackOperation, WritebackOperation, WritebackProcessor } from "./writeback/WritebackOutbox.js";

export type IssueBreakdownPlanApplyResult =
  | { status: "not_required"; reason: string }
  | { status: "no_fresh_plan"; reason: string }
  | { status: "pending"; plan: IssueBreakdownPlanRecord; operations: WritebackOperation[] }
  | { status: "applied"; plan: IssueBreakdownPlanRecord; operations: WritebackOperation[] }
  | { status: "blocked"; plan: IssueBreakdownPlanRecord; operations: WritebackOperation[]; reason: string };

export interface IssueBreakdownPlanApplyServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writeback?: Pick<WritebackProcessor, "enqueueAndProcess"> | undefined;
}

export class IssueBreakdownPlanApplyService {
  constructor(private readonly options: IssueBreakdownPlanApplyServiceOptions) {}

  async applyLatestFreshPlan(issue: Issue): Promise<IssueBreakdownPlanApplyResult> {
    if (!this.options.config.issueBreakdown.applyToLinear.enabled) {
      return { status: "not_required", reason: "apply_to_linear_disabled" };
    }
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const plan = latestFreshIssueBreakdownPlan(lifecycle, issue, this.options.config);
    if (!plan) return { status: "no_fresh_plan", reason: "no_fresh_plan" };
    if (plan.applicationStatus === "applied") return { status: "applied", plan, operations: [] };
    if (!this.options.writeback || !this.options.config.writeback.enabled) {
      const updated = await this.updatePlan(issue, plan, {
        applicationStatus: "blocked",
        applicationBlockedReason: "issue breakdown apply requires writeback to be enabled",
      });
      return { status: "blocked", plan: updated, operations: [], reason: updated.applicationBlockedReason ?? "writeback unavailable" };
    }

    const operations = planIssueBreakdownApplicationWritebacks(issue, plan);
    await this.updatePlan(issue, plan, {
      applicationStatus: "pending",
      applicationOperationKeys: operations.map((operation) => operation.idempotencyKey),
      applicationBlockedReason: null,
    });

    const processed: WritebackOperation[] = [];
    for (const operation of operations) {
      processed.push(await this.options.writeback.enqueueAndProcess(operation, { retrySkipped: isDryRunReplay(operation, plan) }));
    }

    const succeeded = processed.filter((operation) => operation.status === "succeeded");
    const refs = succeeded
      .map((operation) => createdIssueRefFromOperation(operation))
      .filter((ref): ref is IssueBreakdownCreatedIssueRef => ref !== null);
    if (refs.length === operations.length) {
      const applied = await this.updatePlan(issue, plan, {
        applicationStatus: "applied",
        createdIssueRefs: refs,
        appliedAt: new Date().toISOString(),
        applicationBlockedReason: null,
      });
      return { status: "applied", plan: applied, operations: processed };
    }

    const blocked = processed.find((operation) => operation.status === "skipped" || operation.status === "dead_letter");
    if (blocked) {
      const updated = await this.updatePlan(issue, plan, {
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

    const pending = await this.updatePlan(issue, plan, {
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
    const updatedPlan: IssueBreakdownPlanRecord = { ...plan, ...patch };
    await this.options.lifecycleStore.updateIssue(issue, {
      issueBreakdownPlans: plans.map((candidate) => (candidate.id === plan.id ? updatedPlan : candidate)),
      lastIssueBreakdownPlanId: lifecycle?.lastIssueBreakdownPlanId ?? plan.id,
    });
    return updatedPlan;
  }
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
        title: proposedIssue.title,
        description: proposedIssue.description,
        acceptanceCriteria: proposedIssue.acceptanceCriteria,
        requestedLabels: proposedIssue.labels,
        dependencies: proposedIssue.dependencies,
        dedupeKey,
        payloadHash,
        planId: plan.id,
        proposedIssueIndex: index,
      },
    };
  });
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

function isDryRunReplay(operation: NewWritebackOperation, plan: IssueBreakdownPlanRecord): boolean {
  return plan.applicationOperationKeys.includes(operation.idempotencyKey) && plan.applicationBlockedReason === "Writeback dry_run";
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
