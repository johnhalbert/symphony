import { Liquid } from "liquidjs";
import { SymphonyError, errorMessage } from "../errors.js";
import type { AgentRunRole, Issue, RunAttempt } from "../types.js";
import { GENERAL_REVIEW_SCENARIO_MATRIX } from "./ReviewLoopPromptGuidance.js";

export interface PromptRenderInput {
  issue: Issue;
  attempt: RunAttempt;
  role?: AgentRunRole;
  [key: string]: unknown;
  completionReport?: unknown;
  acceptanceCriteria?: string[];
  workspaceEvidence?: string[];
  validationEvidence?: string[];
  runDigest?: string[];
  genericScenarioMatrix?: string[];
  reviewerPromptExtensions?: string[];
  workerPromptExtensions?: string[];
}

export class PromptRenderer {
  private readonly engine: Liquid;

  constructor(options: { root?: string | string[] | null } = {}) {
    this.engine = new Liquid({
      strictVariables: true,
      strictFilters: true,
      ...(options.root ? { root: options.root } : {}),
    });
  }

  async render(template: string, input: PromptRenderInput): Promise<string> {
    const effectiveTemplate =
      template.trim().length === 0 ? "You are working on an issue from Linear." : template;

    try {
      const parsed = this.engine.parse(effectiveTemplate);
      const rendered = await this.engine.render(parsed, {
        ...input,
        issue: input.issue,
        attempt: input.attempt,
        role: input.role ?? "worker",
        completionReport: input.completionReport ?? null,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        workspaceEvidence: input.workspaceEvidence ?? [],
        validationEvidence: input.validationEvidence ?? [],
        runDigest: input.runDigest ?? [],
        genericScenarioMatrix: input.genericScenarioMatrix ?? GENERAL_REVIEW_SCENARIO_MATRIX,
        reviewerPromptExtensions: input.reviewerPromptExtensions ?? [],
        workerPromptExtensions: input.workerPromptExtensions ?? [],
      });
      return rendered.trim();
    } catch (error) {
      throw new SymphonyError("template_render_error", `Unable to render workflow prompt: ${errorMessage(error)}`, error);
    }
  }
}
