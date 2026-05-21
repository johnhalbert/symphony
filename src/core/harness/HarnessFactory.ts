import type { ServiceConfig } from "../config/Config.js";
import type { RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { AgentHarness } from "./AgentHarness.js";
import { CursorHarness } from "../../../cursor/src/CursorHarness.js";

export interface DisposableAgentHarness extends AgentHarness {
  dispose?(): Promise<void>;
}

export interface AgentHarnessFactoryOptions {
  runStore?: RunTranscriptStore;
}

export function createAgentHarness(_config: ServiceConfig, options: AgentHarnessFactoryOptions = {}): DisposableAgentHarness {
  return new CursorHarness(options.runStore === undefined ? {} : { runStore: options.runStore });
}
