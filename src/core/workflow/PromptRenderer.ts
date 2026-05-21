import { Liquid } from "liquidjs";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Issue, RunAttempt } from "../types.js";

export interface PromptRenderInput {
  issue: Issue;
  attempt: RunAttempt;
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
      });
      return rendered.trim();
    } catch (error) {
      throw new SymphonyError("template_render_error", `Unable to render workflow prompt: ${errorMessage(error)}`, error);
    }
  }
}
