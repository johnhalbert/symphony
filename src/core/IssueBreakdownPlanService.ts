import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  IssueBreakdownPlanRecord,
  IssueLifecycleStore,
  IssueLifecycleSummaryReference,
} from "./persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { Issue } from "./types.js";

export const ISSUE_BREAKDOWN_PLAN_SCHEMA_VERSION = 1;

const issueBreakdownPlanSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  proposedIssues: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        description: z.string().trim().min(1),
        acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
        dependencies: z.array(z.string().trim().min(1)).default([]),
        labels: z.array(z.string().trim().min(1)).default([]),
      }),
    )
    .min(1),
  idempotencyKey: z.string().trim().min(1),
});

export type IssueBreakdownPlanInput = z.infer<typeof issueBreakdownPlanSchema>;

export interface IssueBreakdownPlanActiveContext {
  issue: Issue;
  activeRunId: string;
  role: "worker";
  phase: "issue_breakdown";
}

export interface IssueBreakdownPlanServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  runStore?: Pick<RunTranscriptStore, "appendEvent">;
}

export interface IssueBreakdownPlanResult {
  accepted: true;
  replayed: boolean;
  plan: IssueBreakdownPlanRecord;
}

export class IssueBreakdownPlanService {
  constructor(private readonly options: IssueBreakdownPlanServiceOptions) {}

  async submit_issue_breakdown_plan(
    input: unknown,
    context: IssueBreakdownPlanActiveContext,
  ): Promise<IssueBreakdownPlanResult> {
    return this.submitIssueBreakdownPlan(input, context);
  }

  async submitIssueBreakdownPlan(input: unknown, context: IssueBreakdownPlanActiveContext): Promise<IssueBreakdownPlanResult> {
    const parsed = parseIssueBreakdownPlan(input);
    validateCaller(parsed, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    const existing = existingLifecycle?.issueBreakdownPlans.find((plan) => plan.idempotencyKey === parsed.idempotencyKey);
    if (existing) return { accepted: true, replayed: true, plan: existing };

    const acceptedAt = new Date().toISOString();
    const plan: IssueBreakdownPlanRecord = {
      id: issueBreakdownPlanIdFor(context.issue.id, parsed.idempotencyKey),
      idempotencyKey: parsed.idempotencyKey,
      runId: parsed.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      summary: parsed.summary,
      proposedIssues: parsed.proposedIssues,
      transcriptPointers: [`/api/v1/runs/${encodeURIComponent(parsed.runId)}/transcript`],
      statusApiPointers: [
        `/api/v1/issues/${encodeURIComponent(context.issue.identifier)}`,
        `/api/v1/issues/${encodeURIComponent(context.issue.identifier)}/runs`,
        `/api/v1/runs/${encodeURIComponent(parsed.runId)}`,
      ],
      issueUpdatedAt: context.issue.updatedAt,
      configFingerprint: issueBreakdownConfigFingerprint(this.options.config),
      cursorMode: this.options.config.issueBreakdown.cursorMode,
      acceptedAt,
    };

    const reference: IssueLifecycleSummaryReference = {
      id: `issue-breakdown-${parsed.runId}`,
      kind: "issue_breakdown_plan",
      planId: plan.id,
      summary: renderIssueBreakdownPlanSummary(plan),
      runIds: [parsed.runId],
      transcriptEventCount: 1,
      transcriptPointers: plan.transcriptPointers,
      statusApiPointers: plan.statusApiPointers,
      issueUpdatedAt: plan.issueUpdatedAt,
      configFingerprint: plan.configFingerprint,
      cursorMode: plan.cursorMode,
      createdAt: acceptedAt,
    };

    const lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
      lastIssueBreakdownPlanId: plan.id,
      issueBreakdownPlans: [...(existingLifecycle?.issueBreakdownPlans ?? []), plan],
      summaryReferences: upsertIssueBreakdownReference(existingLifecycle?.summaryReferences ?? [], reference),
    });
    await this.options.runStore?.appendEvent({
      runId: parsed.runId,
      at: acceptedAt,
      source: "orchestrator",
      eventType: "issue_breakdown_plan_accepted",
      message: `Accepted issue breakdown plan ${plan.id}`,
      payload: { planId: plan.id, proposedIssueCount: plan.proposedIssues.length, lifecycleUpdatedAt: lifecycle.updatedAt },
    });
    return { accepted: true, replayed: false, plan };
  }
}

export function parseIssueBreakdownPlan(input: unknown): IssueBreakdownPlanInput {
  const parsed = issueBreakdownPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Issue breakdown plan is invalid", parsed.error.flatten());
  }
  return parsed.data;
}

export function issueBreakdownConfigFingerprint(config: ServiceConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: ISSUE_BREAKDOWN_PLAN_SCHEMA_VERSION,
        promptTemplate: config.issueBreakdown.promptTemplate,
        cursorMode: config.issueBreakdown.cursorMode,
        planningLabels: config.issueBreakdown.planningLabels,
      }),
    )
    .digest("hex");
}

export function renderIssueBreakdownPlanSummary(plan: IssueBreakdownPlanRecord): string {
  return [
    plan.summary,
    "",
    "Proposed issues:",
    ...plan.proposedIssues.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `   Description: ${item.description}`,
      "   Acceptance criteria:",
      ...item.acceptanceCriteria.map((criterion) => `   - ${criterion}`),
      `   Dependencies: ${item.dependencies.length === 0 ? "None" : item.dependencies.join(", ")}`,
      `   Labels: ${item.labels.length === 0 ? "None" : item.labels.join(", ")}`,
    ]),
  ].join("\n");
}

function validateCaller(plan: IssueBreakdownPlanInput, context: IssueBreakdownPlanActiveContext): void {
  if (context.role !== "worker" || context.phase !== "issue_breakdown") {
    throw new SymphonyError("invalid_request", "Issue breakdown plans can only be submitted by issue breakdown worker runs");
  }
  if (plan.runId !== context.activeRunId) {
    throw new SymphonyError("invalid_request", "Issue breakdown plan runId does not match the active run");
  }
  if (plan.issueId !== context.issue.id) {
    throw new SymphonyError("invalid_request", "Issue breakdown plan issueId does not match the active issue");
  }
}

function issueBreakdownPlanIdFor(issueId: string, idempotencyKey: string): string {
  return `issue-breakdown-plan:${issueId}:${idempotencyKey}`;
}

function upsertIssueBreakdownReference(
  references: IssueLifecycleSummaryReference[],
  reference: IssueLifecycleSummaryReference,
): IssueLifecycleSummaryReference[] {
  return [...references.filter((item) => item.id !== reference.id), reference];
}
