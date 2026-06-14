import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { normalizeProjectContextResolution, projectContextResolutionFromIssue, type ProjectContextResolution } from "./config/ProjectContexts.js";
import {
  AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS,
  analyzeIssueContractDescription,
  hasMeaningfulRemainingBlocker,
  missingRequiredIssueContractSections,
} from "./IssueContractLint.js";
import { SymphonyError } from "./errors.js";
import type {
  IssueBreakdownPlanRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueLifecycleSummaryReference,
} from "./persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { Issue } from "./types.js";

export const ISSUE_BREAKDOWN_PLAN_SCHEMA_VERSION = 1;
export const ISSUE_CONTENT_FINGERPRINT_VERSION = 1;

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
        dependencies: z.array(z.string().trim().min(1)),
        labels: z.array(z.string().trim().min(1)),
      }),
    )
    .min(1),
  idempotencyKey: z.string().trim().min(1),
});

export type IssueBreakdownPlanInput = z.infer<typeof issueBreakdownPlanSchema>;
type IssueBreakdownProposedIssue = IssueBreakdownPlanInput["proposedIssues"][number];

export interface IssueBreakdownPlanActiveContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
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
    const configFingerprint = issueBreakdownConfigFingerprint(this.options.config);
    const contentFingerprint = issueContentFingerprint(context.issue);
    const requestHash = issueBreakdownPlanRequestHash(parsed);
    const existingScoped = existingLifecycle?.issueBreakdownPlans.find(
      (plan) => plan.runId === context.activeRunId && plan.idempotencyKey === parsed.idempotencyKey,
    );
    if (existingScoped) {
      assertIssueBreakdownPlanReplayAllowed(existingScoped, {
        idempotencyKey: parsed.idempotencyKey,
        activeRunId: context.activeRunId,
        requestHash,
      });
      return { accepted: true, replayed: true, plan: existingScoped };
    }
    const existingCrossRun = existingLifecycle?.issueBreakdownPlans.find(
      (plan) => plan.idempotencyKey === parsed.idempotencyKey && plan.runId !== context.activeRunId,
    );
    if (existingCrossRun) {
      throw issueBreakdownPlanIdempotencyConflict("cross_run_key_reuse", existingCrossRun, {
        idempotencyKey: parsed.idempotencyKey,
        activeRunId: context.activeRunId,
        requestHash,
        configFingerprint,
        issueContentFingerprint: contentFingerprint,
      });
    }

    validateProposedIssues(parsed.proposedIssues, this.options.config);

    const acceptedAt = new Date().toISOString();
    const projectContext = resolveIssueBreakdownProjectContext(context, existingLifecycle);
    const plan: IssueBreakdownPlanRecord = {
      id: issueBreakdownPlanIdFor(context.issue.id, parsed.idempotencyKey),
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      runId: parsed.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      projectContext,
      summary: parsed.summary,
      proposedIssues: parsed.proposedIssues,
      transcriptPointers: [`/api/v1/runs/${encodeURIComponent(parsed.runId)}/transcript`],
      statusApiPointers: [
        `/api/v1/issues/${encodeURIComponent(context.issue.id)}`,
        `/api/v1/issues/${encodeURIComponent(context.issue.id)}/runs`,
        `/api/v1/runs/${encodeURIComponent(parsed.runId)}`,
      ],
      issueUpdatedAt: context.issue.updatedAt,
      issueContentFingerprint: contentFingerprint,
      configFingerprint,
      cursorMode: this.options.config.issueBreakdown.cursorMode,
      acceptedAt,
      applicationStatus: "not_requested",
      applicationOperationKeys: [],
      createdIssueRefs: [],
      appliedAt: null,
      applicationBlockedReason: null,
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
      issueContentFingerprint: plan.issueContentFingerprint,
      configFingerprint: plan.configFingerprint,
      cursorMode: plan.cursorMode,
      createdAt: acceptedAt,
    };

    const lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, {
      projectContext,
      lastIssueBreakdownPlanId: plan.id,
      planningFailureCount: 0,
      planningDispatchRetryCount: 0,
      lastPlanningFailureRunId: null,
      lastPlanningFailureAt: null,
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

export function resolveIssueBreakdownProjectContext(
  context: IssueBreakdownPlanActiveContext,
  lifecycle: IssueLifecycleRecord | null | undefined,
): ProjectContextResolution {
  return normalizeProjectContextResolution(
    context.projectContext ?? lifecycle?.projectContext ?? projectContextResolutionFromIssue(context.issue),
  );
}

export function issueBreakdownConfigFingerprint(config: ServiceConfig): string {
  return createHash("sha256")
    .update(
      stableJson({
        schemaVersion: ISSUE_BREAKDOWN_PLAN_SCHEMA_VERSION,
        promptTemplate: config.issueBreakdown.promptTemplate,
        cursorMode: config.issueBreakdown.cursorMode,
        planningLabels: config.issueBreakdown.planningLabels,
        applyToLinear: config.issueBreakdown.applyToLinear,
        workspaceMode: config.issueBreakdown.workspaceMode,
        requireLabels: config.agent.requireLabels,
        excludeLabels: config.agent.excludeLabels,
        protectedPaths: config.agent.protectedPaths,
      }),
    )
    .digest("hex");
}

export function issueContentFingerprint(issue: Issue): string {
  return createHash("sha256")
    .update(
      stableJson({
        version: ISSUE_CONTENT_FINGERPRINT_VERSION,
        title: normalizeString(issue.title),
        description: normalizeString(issue.description ?? ""),
        priority: issue.priority,
        labels: normalizeStringList(issue.labels, { lowercase: true }),
        blockedBy: issue.blockedBy
          .map((blocker) => ({
            id: normalizeNullableString(blocker.id),
            identifier: normalizeNullableString(blocker.identifier),
            state: normalizeNullableString(blocker.state),
          }))
          .sort((left, right) =>
            `${left.identifier ?? ""}\0${left.id ?? ""}\0${left.state ?? ""}`.localeCompare(
              `${right.identifier ?? ""}\0${right.id ?? ""}\0${right.state ?? ""}`,
            ),
          ),
      }),
    )
    .digest("hex");
}

export function issueBreakdownPlanFingerprintsMatch(
  plan: IssueBreakdownPlanRecord,
  issue: Issue,
  config: ServiceConfig,
): boolean {
  if (plan.configFingerprint !== issueBreakdownConfigFingerprint(config)) return false;
  if (plan.issueContentFingerprint.length === 0) return false;
  if (plan.issueContentFingerprint !== issueContentFingerprint(issue)) return false;
  return issueBreakdownPlanSatisfiesCurrentValidation(plan, config);
}

export function issueBreakdownPlanSatisfiesCurrentValidation(
  plan: Pick<IssueBreakdownPlanRecord, "proposedIssues">,
  config: ServiceConfig,
): boolean {
  try {
    validateProposedIssues(plan.proposedIssues, config);
    return true;
  } catch (error) {
    if (error instanceof SymphonyError && error.code === "invalid_request") return false;
    throw error;
  }
}

export function isCurrentFreshIssueBreakdownPlan(
  lifecycle: IssueLifecycleRecord | null | undefined,
  plan: IssueBreakdownPlanRecord,
  issue: Issue,
  config: ServiceConfig,
): boolean {
  if (!lifecycle || lifecycle.lastIssueBreakdownPlanId !== plan.id) return false;
  if (plan.applicationStatus === "stale") return false;
  return issueBreakdownPlanFingerprintsMatch(plan, issue, config);
}

export function latestFreshIssueBreakdownPlan(
  lifecycle: IssueLifecycleRecord | null | undefined,
  issue: Issue,
  config: ServiceConfig,
): IssueBreakdownPlanRecord | null {
  if (!lifecycle?.lastIssueBreakdownPlanId) return null;
  const plan = lifecycle.issueBreakdownPlans.find((candidate) => candidate.id === lifecycle.lastIssueBreakdownPlanId);
  if (!plan) return null;
  return isCurrentFreshIssueBreakdownPlan(lifecycle, plan, issue, config) ? plan : null;
}

export function issueBreakdownPlanRequestHash(input: IssueBreakdownPlanInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        issueId: input.issueId,
        summary: normalizeString(input.summary),
        proposedIssues: input.proposedIssues
          .map((item) => ({
            title: normalizeString(item.title),
            description: normalizeString(item.description),
            acceptanceCriteria: normalizeStringList(item.acceptanceCriteria),
            dependencies: normalizeStringList(item.dependencies),
            labels: normalizeStringList(item.labels, { lowercase: true }),
          }))
          .sort((left, right) =>
            `${left.title}\0${left.description}\0${left.labels.join(",")}`.localeCompare(
              `${right.title}\0${right.description}\0${right.labels.join(",")}`,
            ),
          ),
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

function validateProposedIssues(proposedIssues: readonly IssueBreakdownProposedIssue[], config: ServiceConfig): void {
  for (const [index, proposedIssue] of proposedIssues.entries()) {
    const descriptor = describeProposedIssue(index, proposedIssue.title);
    assertProposedIssueLabels(proposedIssue.labels, descriptor, config.agent.requireLabels);

    const missingSections = missingRequiredIssueContractSections(proposedIssue.description);
    if (missingSections.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `${descriptor} must include the required issue contract headings: ${AGENT_ELIGIBLE_ISSUE_REQUIRED_SECTIONS.join(", ")}`,
        { proposedIssueIndex: index, missingSections },
      );
    }

    const analysis = analyzeIssueContractDescription(proposedIssue.description, config.agent.protectedPaths);
    if (analysis.issueContractErrors.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `${descriptor} has an invalid Issue Contract: ${analysis.issueContractErrors.join("; ")}`,
        { proposedIssueIndex: index, issueContractErrors: analysis.issueContractErrors },
      );
    }
    if (analysis.readyForDogfoodReady === null) {
      throw new SymphonyError(
        "invalid_request",
        `${descriptor} must declare "Ready for \`dogfood-ready\`: yes/no" in Promotion Readiness`,
        { proposedIssueIndex: index, title: proposedIssue.title },
      );
    }

    if (analysis.protectedSurfaceMatches.length > 0) {
      if (analysis.readyForDogfoodReady !== false) {
        throw new SymphonyError(
          "invalid_request",
          `${descriptor} touches protected paths (${analysis.protectedSurfaceMatches.join(", ")}) and must keep "Ready for \`dogfood-ready\`: no"`,
          { proposedIssueIndex: index, protectedSurfaceMatches: analysis.protectedSurfaceMatches },
        );
      }
      if (!hasMeaningfulRemainingBlocker(analysis.remainingBlocker)) {
        throw new SymphonyError(
          "invalid_request",
          `${descriptor} touches protected paths (${analysis.protectedSurfaceMatches.join(", ")}) and must record a substantive manual/operator blocker for manual handling`,
          { proposedIssueIndex: index, protectedSurfaceMatches: analysis.protectedSurfaceMatches },
        );
      }
    }
  }
}

function assertProposedIssueLabels(labels: readonly string[], descriptor: string, requiredDispatchLabels: readonly string[]): void {
  const forbiddenLabels = new Set(["dogfood-ready", ...requiredDispatchLabels.map((label) => label.toLowerCase())]);
  const offendingLabels = labels.filter((label) => forbiddenLabels.has(label.toLowerCase()));
  if (offendingLabels.length > 0) {
    const uniqueOffendingLabels = [...new Set(offendingLabels)];
    throw new SymphonyError(
      "invalid_request",
      `${descriptor} must not include worker dispatch labels (${uniqueOffendingLabels.join(", ")}); operators add readiness labels after review`,
      { labels, forbiddenLabels: [...forbiddenLabels] },
    );
  }
}

function describeProposedIssue(index: number, title: string): string {
  return `Proposed issue ${index + 1} (${JSON.stringify(title)})`;
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

function assertIssueBreakdownPlanReplayAllowed(
  existing: IssueBreakdownPlanRecord,
  expected: {
    idempotencyKey: string;
    activeRunId: string;
    requestHash: string;
  },
): void {
  if (existing.requestHash.length === 0 || existing.issueContentFingerprint.length === 0) {
    throw issueBreakdownPlanIdempotencyConflict("legacy_plan_not_replayable", existing, expected);
  }
  if (existing.requestHash !== expected.requestHash) {
    throw issueBreakdownPlanIdempotencyConflict("payload_mismatch", existing, expected);
  }
}

function issueBreakdownPlanIdempotencyConflict(
  reason: "payload_mismatch" | "cross_run_key_reuse" | "legacy_plan_not_replayable",
  existing: IssueBreakdownPlanRecord,
  expected: {
    idempotencyKey: string;
    activeRunId: string;
    requestHash: string;
    configFingerprint?: string;
    issueContentFingerprint?: string;
  },
): SymphonyError {
  return new SymphonyError("conflict", "Issue breakdown plan idempotency key was reused with a different run or payload", {
    reason,
    idempotencyKey: expected.idempotencyKey,
    activeRunId: expected.activeRunId,
    requestHash: expected.requestHash,
    issueContentFingerprint: expected.issueContentFingerprint ?? null,
    configFingerprint: expected.configFingerprint ?? null,
    existingRunId: existing.runId,
    existingRequestHash: existing.requestHash,
    existingIssueContentFingerprint: existing.issueContentFingerprint,
    existingConfigFingerprint: existing.configFingerprint,
  });
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

function normalizeString(value: string): string {
  return value.trim();
}

function normalizeNullableString(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function normalizeStringList(values: string[], options: { lowercase?: boolean } = {}): string[] {
  const normalized = values
    .map((value) => {
      const trimmed = value.trim();
      return options.lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter((value) => value.length > 0);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
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
