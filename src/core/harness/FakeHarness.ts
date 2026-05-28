import type { AgentEvent, AgentHarness, AgentRunContext } from "./AgentHarness.js";

export interface FakeHarnessOptions {
  fail?: boolean;
  events?: AgentEvent[];
}

export class FakeHarness implements AgentHarness {
  readonly id = "fake";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];
  reloadCount = 0;

  constructor(private readonly options: FakeHarnessOptions = {}) {}

  async reload(): Promise<void> {
    this.reloadCount += 1;
  }

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    yield { type: "session_started", sessionId: `fake-${ctx.issue.id}-${ctx.turnNumber}` };
    for (const event of this.options.events ?? []) yield event;
    if (this.options.fail) {
      yield { type: "failed", error: "fake failure" };
      return;
    }
    yield { type: "completed", message: "fake completed" };
  }
}
