import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ReviewVerdictService,
  type ReviewVerdictActiveContext,
} from "../ReviewVerdictService.js";
import { SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { Issue } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { SqliteWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const REVIEW_VERDICT_TOOL_NAME = "submit_review_verdict";

export interface ReviewVerdictMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "reviewer";
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase: "review";
  ignoreStateGate?: boolean;
}

export async function writeReviewVerdictMcpContext(
  filePath: string,
  context: ReviewVerdictMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitReviewVerdictFromMcp(input: unknown, options: {
  workflowPath: string;
  contextFile: string;
}): Promise<unknown> {
  const loadedContext = await readReviewVerdictContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Review verdict context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  let writebackOutbox: SqliteWritebackOutboxStore | null = null;
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    writebackOutbox = new SqliteWritebackOutboxStore(config.workspace.stateDir);
    const service = new ReviewVerdictService({
      config,
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      writebackOutbox,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });
    const context: ReviewVerdictActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      token: loadedContext.token ?? null,
      expectedToken: loadedContext.expectedToken ?? null,
      reviewer: loadedContext.reviewer ?? null,
      phase: loadedContext.phase,
      ignoreStateGate: loadedContext.ignoreStateGate === true,
    };
    const result = await service.submit_review_verdict(reviewVerdictInputFromMcp(input, context), context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      verdictId: result.verdict.id,
      verdict: result.verdict.verdict,
      writebackOperationKeys: result.verdict.writebackOperationKeys,
    };
  } finally {
    await writebackOutbox?.close();
    await loader.close();
  }
}

export async function runReviewVerdictMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-review-verdict",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: REVIEW_VERDICT_TOOL_NAME,
      description: "Submit a Symphony reviewer pass/fail verdict for the active review run.",
      inputSchema: reviewVerdictInputSchema(),
      handler: (input) => submitReviewVerdictFromMcp(input, options),
    },
  });
}

async function readReviewVerdictContext(filePath: string): Promise<ReviewVerdictMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as ReviewVerdictMcpContextFile;
  if (!parsed.issue || parsed.role !== "reviewer") {
    throw new SymphonyError("invalid_request", "Review verdict MCP context is invalid");
  }
  return parsed;
}

function reviewVerdictInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "acceptanceResults", "findings", "gateFindings", "discoveryFindings", "evidence", "idempotencyKey"],
    properties: {
      verdict: {
        enum: ["pass", "fail", "blocked"],
        description:
          "Use fail only when at least one worker-owned, contract-entitled gate finding remains; use blocked when review cannot complete because of a non-worker-owned blocker such as unavailable validation tooling; pass is allowed with discovery findings when no gate findings remain.",
      },
      acceptanceResults: {
        type: "array",
        minItems: 1,
        description: "One item per acceptance criterion, including whether it passed and the supporting evidence.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "satisfied", "evidence"],
          properties: {
            text: { type: "string", minLength: 1, description: "Acceptance criterion text." },
            satisfied: { type: "boolean", description: "Whether the implementation satisfies this criterion." },
            evidence: {
              description: "Specific review evidence for the status, or null when unavailable.",
              anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
            },
          },
        },
      },
      findings: {
        type: "array",
        description:
          "Compact summaries. For fail verdicts, this should equal gateFindings[].summary. For blocked verdicts, use this for non-worker-owned blocker summaries. Use an empty array for pass verdicts.",
        items: { type: "string", minLength: 1 },
      },
      gateFindings: {
        type: "array",
        description:
          "Blocking contract defects that are allowed to gate the worker. A fail verdict requires at least one item; pass and blocked verdicts require none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "summary",
            "requirementIds",
            "contractAnchor",
            "scenario",
            "scenarioEntitlement",
            "observedFailure",
            "currentIssueOwnership",
            "boundedRepair",
            "evidence",
          ],
          properties: {
            summary: { type: "string", minLength: 1 },
            requirementIds: { type: "array", items: { type: "string", minLength: 1 } },
            contractAnchor: { type: "string", minLength: 1 },
            scenario: { type: "string", minLength: 1 },
            scenarioEntitlement: {
              enum: ["explicit_requirement", "named_acceptance_criterion", "named_validation_requirement", "necessary_core_behavior"],
            },
            observedFailure: { type: "string", minLength: 1 },
            currentIssueOwnership: { type: "string", minLength: 1 },
            boundedRepair: { type: "string", minLength: 1 },
            evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          },
        },
      },
      discoveryFindings: {
        type: "array",
        description:
          "Non-gating discovered scope, adjacent scenarios, hidden matrix axes, sibling issue scope, or future hardening. These do not by themselves make the verdict fail.",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "summary",
            "importance",
            "relationship",
            "discoveryReason",
            "suggestedDisposition",
            "scenarioAxes",
            "evidence",
            "ownerIssueIdentifier",
          ],
          properties: {
            summary: { type: "string", minLength: 1 },
            importance: { enum: ["critical", "high", "medium", "low"] },
            relationship: {
              enum: ["implied_core", "adjacent_sibling", "hidden_matrix_axis", "sibling_issue_scope", "future_hardening", "out_of_scope"],
            },
            discoveryReason: { type: "string", minLength: 1 },
            suggestedDisposition: { enum: ["planner_decomposition", "followup_issue", "operator_decision", "ignore"] },
            scenarioAxes: { type: "array", items: { type: "string", minLength: 1 } },
            evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            ownerIssueIdentifier: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          },
        },
      },
      evidence: {
        type: "array",
        minItems: 1,
        description: "Durable review evidence, such as PR review or comment URLs.",
        items: { type: "string", minLength: 1 },
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable unique key for this review verdict so retries are safe.",
      },
    },
  };
}

function reviewVerdictInputFromMcp(input: unknown, context: ReviewVerdictActiveContext): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const idempotencyKey = typeof record.idempotencyKey === "string"
    ? `${context.activeRunId}:${record.idempotencyKey.trim()}`
    : record.idempotencyKey;
  return {
    ...input,
    idempotencyKey,
    runId: context.activeRunId,
    issueId: context.issue.id,
  };
}

