#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import {
  HermesAuthManager,
  hermesOwnedAuthProvidersForRuntime,
  normalizeHermesAuthProvider,
} from "../hermes/src/HermesAuthManager.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { runMcpToolExposureProbe } from "../src/core/harness/McpToolExposureProbe.js";
import { errorMessage } from "../src/core/errors.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { FileMcpExposureDiagnosticsStore } from "../src/core/persistence/McpExposureDiagnosticsStore.js";
import { WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import type { Issue, Workspace } from "../src/core/types.js";

const EXPECTED_TEXT = "Symphony Hermes local smoke OK";

interface RawOptions {
  cliPath?: string;
  expect?: string;
  keepTemp?: boolean;
  timeoutMs?: string;
}

const program = new Command()
  .name("hermes-local-smoke")
  .description("Run a local HermesHarness smoke without touching Linear, GitHub, tracked files, or normal workspace state")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--cli-path <path>", "explicit Symphony CLI entrypoint for MCP subprocesses", path.resolve(process.cwd(), "src/cli.ts"))
  .option("--expect <text>", "text that must appear in the Hermes terminal response", EXPECTED_TEXT)
  .option("--timeout-ms <ms>", "overall prompt response timeout", "120000")
  .option("--keep-temp", "leave the temporary smoke workspace on disk for inspection", false);

program.parse(process.argv);

void main(program.args[0] ?? "WORKFLOW.md", program.opts<RawOptions>()).catch((error) => {
  console.error(`[smoke:hermes] ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main(workflow: string, rawOptions: RawOptions): Promise<void> {
  const workflowPath = path.resolve(process.cwd(), workflow);
  const cliPath = path.resolve(process.cwd(), rawOptions.cliPath ?? "src/cli.ts");
  const timeoutMs = parsePositiveInt(rawOptions.timeoutMs ?? "120000", "--timeout-ms");
  const loader = new WorkflowLoader(workflowPath);
  let tempRoot: string | null = null;
  try {
    const loaded = await loader.load();
    const baseConfig = loaded.serviceConfig;
    assertHermesSmokeReady(baseConfig);
    await assertHermesAuthReady(baseConfig);

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-hermes-local-smoke-"));
    const smokeWorkspace = path.join(tempRoot, "workspace");
    const smokeState = path.join(tempRoot, "state");
    await fs.mkdir(smokeWorkspace, { recursive: true });
    const smokeConfig = withSmokeState(baseConfig, tempRoot, smokeState);

    console.log("[smoke:hermes] checking MCP subprocess and Hermes gateway exposure");
    const report = await runMcpToolExposureProbe({
      config: smokeConfig,
      cliPath,
      roles: ["worker", "reviewer"],
      liveSmokeEnabled: true,
      sdkCwd: smokeWorkspace,
      mcpCwd: smokeWorkspace,
    });
    await new FileMcpExposureDiagnosticsStore(baseConfig.workspace.stateDir).writeLatest(report);
    if (!report.ok) {
      throw new Error(`Hermes MCP exposure failed: ${report.stages.map((stage) => stage.message).join("; ")}`);
    }

    console.log("[smoke:hermes] starting HermesHarness prompt smoke");
    const events = await runHermesPromptSmoke(smokeConfig, cliPath, smokeWorkspace, rawOptions.expect ?? EXPECTED_TEXT, timeoutMs);
    const completed = events.find((event): event is Extract<AgentEvent, { type: "completed" }> => event.type === "completed");
    if (!completed) {
      throw new Error(`HermesHarness smoke did not complete; events=${summarizeEvents(events)}`);
    }
    if ((rawOptions.expect ?? EXPECTED_TEXT).length > 0 && !completed.message?.includes(rawOptions.expect ?? EXPECTED_TEXT)) {
      throw new Error(`HermesHarness smoke response did not contain expected text: ${rawOptions.expect ?? EXPECTED_TEXT}`);
    }

    console.log("[smoke:hermes] OK");
    console.log(
      JSON.stringify(
        {
          workflowPath,
          harness: smokeConfig.agent.harness,
          provider: smokeConfig.hermes.provider,
          model: smokeConfig.hermes.model,
          diagnostics: path.join(baseConfig.workspace.stateDir, "diagnostics", "mcp-tool-exposure", "latest.json"),
          tempRoot: rawOptions.keepTemp ? tempRoot : undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await loader.close();
    if (tempRoot && !rawOptions.keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
  }
}

function assertHermesSmokeReady(config: ServiceConfig): void {
  if (config.agent.harness !== "hermes") {
    throw new Error(`agent.harness must be hermes for smoke:hermes-local; current value is ${config.agent.harness}`);
  }
  if (normalizeHermesAuthProvider(config.hermes.provider ?? "") !== "openai-codex") {
    throw new Error(`hermes.provider must be openai-codex for the default dogfood smoke; current value is ${config.hermes.provider ?? "unset"}`);
  }
  if (!config.hermes.model) {
    throw new Error("hermes.model is required for smoke:hermes-local");
  }
}

async function assertHermesAuthReady(config: ServiceConfig): Promise<void> {
  const providers = hermesOwnedAuthProvidersForRuntime(config.hermes.provider, config.hermes.auth.providers);
  if (!providers.includes("openai-codex")) {
    throw new Error("hermes.auth.providers must include openai-codex for smoke:hermes-local");
  }
  const manager = new HermesAuthManager({
    managedRoot: config.hermes.auth.managedRoot,
    bootstrapFrom: config.hermes.auth.bootstrapFrom,
    providers: config.hermes.auth.providers,
    upstreamRoot: config.hermes.upstreamRoot,
    python: config.hermes.python,
    timeoutMs: config.hermes.startupTimeoutMs,
  });
  await manager.requireProviders(providers);
  await manager.validateOpenAiCodex({ refreshIfExpiring: false });
}

function withSmokeState(config: ServiceConfig, tempRoot: string, stateDir: string): ServiceConfig {
  return {
    ...config,
    workspace: {
      ...config.workspace,
      root: path.join(tempRoot, "workspaces"),
      stateDir,
    },
    hermes: {
      ...config.hermes,
      stateDir: path.join(stateDir, "hermes"),
      auth: {
        ...config.hermes.auth,
      },
    },
  };
}

async function runHermesPromptSmoke(
  config: ServiceConfig,
  cliPath: string,
  workspacePath: string,
  expectedText: string,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const abortController = new AbortController();
  const harness = new HermesHarness({ cliPath });
  const prompt = `This is a Symphony Hermes local smoke. Reply with exactly: ${expectedText}. Do not edit files or call tools.`;
  const ctx = smokeRunContext(config, workspacePath, abortController);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      collectEvents(harness.run(ctx, prompt)),
      new Promise<AgentEvent[]>((_resolve, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          reject(new Error(`HermesHarness smoke timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
    await harness.dispose();
  }
}

function smokeRunContext(config: ServiceConfig, workspacePath: string, abortController: AbortController): AgentRunContext {
  return {
    issue: smokeIssue(),
    role: "worker",
    runPhase: "implementation",
    attempt: null,
    workspace: smokeWorkspace(workspacePath),
    config,
    turnNumber: 1,
    runModeOverride: null,
    abortSignal: abortController.signal,
    logger: new StructuredLogger(() => undefined),
  };
}

function smokeIssue(): Issue {
  return {
    id: "hermes-local-smoke",
    identifier: "HERMES-SMOKE",
    title: "Hermes local smoke",
    description: "Local smoke issue used only by npm run smoke:hermes-local.",
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: ["dogfood-ready"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function smokeWorkspace(workspacePath: string): Workspace {
  return {
    path: workspacePath,
    workspaceKey: "hermes-local-smoke",
    createdNow: true,
    issueId: "hermes-local-smoke",
    issueIdentifier: "HERMES-SMOKE",
    sourceKind: "smoke",
    repoPath: process.cwd(),
  };
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function summarizeEvents(events: AgentEvent[]): string {
  if (events.length === 0) return "none";
  return events
    .map((event) => {
      const details: string[] = [event.type];
      if ("code" in event && typeof event.code === "string") details.push(`code=${event.code}`);
      if ("message" in event && typeof event.message === "string") details.push(`message=${oneLine(event.message)}`);
      if ("error" in event && typeof event.error === "string") details.push(`error=${oneLine(event.error)}`);
      return details.join(":");
    })
    .join(", ");
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").slice(0, 500);
}

function parsePositiveInt(input: string, label: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
