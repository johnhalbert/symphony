import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";
import type { RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { AgentHarness } from "./AgentHarness.js";
import { CursorHarness } from "../../../cursor/src/CursorHarness.js";
import { HermesAcpHarness } from "../../../hermes/src/HermesAcpHarness.js";
import { HermesHarness } from "../../../hermes/src/HermesHarness.js";

export interface DisposableAgentHarness extends AgentHarness {
  dispose?(): Promise<void>;
}

export type AgentHarnessProvider = (
  config: ServiceConfig,
  options: AgentHarnessFactoryOptions,
) => DisposableAgentHarness;

export type AgentHarnessRegistry =
  | ReadonlyMap<string, AgentHarnessProvider>
  | Readonly<Record<string, AgentHarnessProvider>>;

export interface AgentHarnessFactoryOptions {
  runStore?: RunTranscriptStore;
  registry?: AgentHarnessRegistry;
}

export const BUILTIN_AGENT_HARNESSES: Readonly<Record<string, AgentHarnessProvider>> = {
  cursor: (_config, options) => new CursorHarness(options.runStore === undefined ? {} : { runStore: options.runStore }),
  hermes: (_config, options) => new HermesHarness(options.runStore === undefined ? {} : { runStore: options.runStore }),
  hermes_acp: (_config, options) =>
    new HermesAcpHarness(options.runStore === undefined ? {} : { runStore: options.runStore }),
};

export function createAgentHarness(config: ServiceConfig, options: AgentHarnessFactoryOptions = {}): DisposableAgentHarness {
  const provider = resolveHarnessProvider(options.registry ?? BUILTIN_AGENT_HARNESSES, config.agent.harness);
  if (!provider) {
    throw new SymphonyError("config_validation_error", `No runtime harness registered for ${config.agent.harness}`);
  }
  return provider(config, options);
}

function resolveHarnessProvider(registry: AgentHarnessRegistry, id: string): AgentHarnessProvider | undefined {
  if (registry instanceof Map) return registry.get(id);
  return (registry as Readonly<Record<string, AgentHarnessProvider>>)[id];
}
