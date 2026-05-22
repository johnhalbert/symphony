import { Liquid } from "liquidjs";
import { SymphonyError, errorMessage } from "../errors.js";
import type { AgentRunRole, Issue, RunAttempt } from "../types.js";

export interface PromptRenderInput {
  issue: Issue;
  attempt: RunAttempt;
  role?: AgentRunRole;
  completionReport?: unknown;
  acceptanceCriteria?: string[];
  workspaceEvidence?: string[];
  validationEvidence?: string[];
  runDigest?: string[];
}

export class PromptRenderer {
  private readonly engine: Liquid;

  constructor() {
    this.engine = new Liquid({
      strictVariables: true,
      strictFilters: true,
    });
  }

  async render(template: string, input: PromptRenderInput): Promise<string> {
    const effectiveTemplate =
      template.trim().length === 0 ? "You are working on an issue from Linear." : template;

    try {
      const parsed = this.engine.parse(effectiveTemplate);
      const rendered = await this.engine.render(parsed, {
        issue: input.issue,
        attempt: input.attempt,
        role: input.role ?? "worker",
        completionReport: input.completionReport ?? null,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        workspaceEvidence: input.workspaceEvidence ?? [],
        validationEvidence: input.validationEvidence ?? [],
        runDigest: input.runDigest ?? [],
      });
      return rendered.trim();
    } catch (error) {
      throw new SymphonyError("template_render_error", `Unable to render workflow prompt: ${errorMessage(error)}`, error);
    }
  }
}
