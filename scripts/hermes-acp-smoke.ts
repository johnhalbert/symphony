#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { HermesAcpHarness } from "../hermes/src/HermesAcpHarness.js";
import { discoverHostHermes } from "../hermes/src/HostHermesDiscovery.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { errorMessage } from "../src/core/errors.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { DoctorCheck } from "../src/doctor.js";
import { runtimeHarnessDependencyDoctorChecks } from "../src/doctor.js";
import { WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import type { Issue, Workspace } from "../src/core/types.js";

const EXPECTED_TEXT = "Symphony Hermes ACP smoke OK";

interface RawOptions {
  cliPath?: string;
  expect?: string;
  keepTemp?: boolean;
  timeoutMs?: string;
  doctorOnly?: boolean;
}

const program = new Command()
  .name("hermes-acp-smoke")
  .description("Run an opt-in host Hermes ACP smoke with disposable cloned profiles and no Linear/GitHub writes")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--cli-path <path>", "explicit Symphony CLI entrypoint for MCP subprocesses", path.resolve(process.cwd(), "src/cli.ts"))
  .option("--expect <text>", "text that must appear in the Hermes ACP response; pass an empty string to accept any completed response", EXPECTED_TEXT)
  .option("--timeout-ms <ms>", "overall prompt response timeout", "120000")
  .option("--doctor-only", "only run the host Hermes ACP live doctor checks; skip the prompt smoke", false)
  .option("--keep-temp", "leave the temporary smoke workspace on disk for inspection", false);

program.parse(process.argv);

void main(program.args[0] ?? "WORKFLOW.md", program.opts<RawOptions>()).catch((error) => {
  console.error(`[smoke:hermes-acp] ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main(workflow: string, rawOptions: RawOptions): Promise<void> {
  const workflowPath = path.resolve(process.cwd(), workflow);
  const workflowRoot = path.dirname(workflowPath);
  const cliPath = path.resolve(process.cwd(), rawOptions.cliPath ?? "src/cli.ts");
  const timeoutMs = parsePositiveInt(rawOptions.timeoutMs ?? "120000", "--timeout-ms");
  const loader = new WorkflowLoader(workflowPath);
  let tempRoot: string | null = null;
  try {
    const loaded = await loader.load();
    const baseConfig = loaded.serviceConfig;
    assertHermesAcpSmokeReady(baseConfig);

    const activeProfileBefore = await discoverActiveHostProfile(baseConfig, workflowRoot);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-smoke-"));
    const smokeWorkspace = path.join(tempRoot, "workspace");
    await fs.mkdir(smokeWorkspace, { recursive: true });
    const smokeConfig = withSmokeState(baseConfig, tempRoot);

    console.log("[smoke:hermes-acp] checking host Hermes ACP discovery, disposable clone, cleanup, and live ACP session");
    const checks = await runtimeHarnessDependencyDoctorChecks(smokeConfig, { workflowPath, liveRuntime: true });
    for (const check of checks) console.log(formatCheck(check));
    const failedChecks = checks.filter((check) => check.status === "error");
    if (failedChecks.length > 0) {
      throw new Error(`Host Hermes ACP doctor checks failed: ${failedChecks.map((check) => `${check.id}: ${check.message}`).join("; ")}`);
    }

    let completed: Extract<AgentEvent, { type: "completed" }> | undefined;
    if (!rawOptions.doctorOnly) {
      console.log("[smoke:hermes-acp] starting HermesAcpHarness prompt smoke with a disposable cloned profile");
      const events = await runHermesAcpPromptSmoke(smokeConfig, cliPath, smokeWorkspace, rawOptions.expect ?? EXPECTED_TEXT, timeoutMs);
      completed = events.find((event): event is Extract<AgentEvent, { type: "completed" }> => event.type === "completed");
      if (!completed) {
        throw new Error(`HermesAcpHarness smoke did not complete; events=${summarizeEvents(events)}`);
      }
      if ((rawOptions.expect ?? EXPECTED_TEXT).length > 0 && !completed.message?.includes(rawOptions.expect ?? EXPECTED_TEXT)) {
        throw new Error(`HermesAcpHarness smoke response did not contain expected text: ${rawOptions.expect ?? EXPECTED_TEXT}`);
      }
    }

    const activeProfileAfter = await discoverActiveHostProfile(baseConfig, workflowRoot);
    if (activeProfileBefore && activeProfileAfter && activeProfileBefore !== activeProfileAfter) {
      throw new Error(
        `Host Hermes active profile changed from ${activeProfileBefore} to ${activeProfileAfter}; source profile selection must not be mutated by the ACP smoke`,
      );
    }

    console.log("[smoke:hermes-acp] OK");
    console.log(
      JSON.stringify(
        {
          workflowPath,
          harness: smokeConfig.agent.harness,
          configuredSourceProfile: smokeConfig.hermesAcp.sourceProfile,
          activeProfileBefore,
          activeProfileAfter,
          doctorOnly: rawOptions.doctorOnly === true,
          responsePreview: completed?.message?.replace(/\s+/g, " ").slice(0, 240),
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

function assertHermesAcpSmokeReady(config: ServiceConfig): void {
  if (config.agent.harness !== "hermes_acp") {
    throw new Error(`agent.harness must be hermes_acp for smoke:hermes-acp; current value is ${config.agent.harness}`);
  }
}

function withSmokeState(config: ServiceConfig, tempRoot: string): ServiceConfig {
  return {
    ...config,
    workspace: {
      ...config.workspace,
      root: path.join(tempRoot, "workspaces"),
      stateDir: path.join(tempRoot, "state"),
    },
    hermesAcp: {
      ...config.hermesAcp,
      keepProfiles: "never",
      workerSessionLifecycle: "fresh_per_run",
    },
  };
}

async function runHermesAcpPromptSmoke(
  config: ServiceConfig,
  cliPath: string,
  workspacePath: string,
  expectedText: string,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const abortController = new AbortController();
  const harness = new HermesAcpHarness({ cliPath });
  const prompt = `This is a Symphony host Hermes ACP smoke. Reply with exactly: ${expectedText}. Do not edit files or call tools.`;
  const ctx = smokeRunContext(config, workspacePath, abortController);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      collectEvents(harness.run(ctx, prompt)),
      new Promise<AgentEvent[]>((_resolve, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          reject(new Error(`HermesAcpHarness smoke timed out after ${timeoutMs}ms`));
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
    id: "hermes-acp-smoke",
    identifier: "HERMES-ACP-SMOKE",
    title: "Hermes ACP local smoke",
    description: "Local smoke issue used only by npm run smoke:hermes-acp.",
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
    workspaceKey: "hermes-acp-smoke",
    createdNow: true,
    issueId: "hermes-acp-smoke",
    issueIdentifier: "HERMES-ACP-SMOKE",
    sourceKind: "smoke",
    repoPath: process.cwd(),
  };
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function discoverActiveHostProfile(config: ServiceConfig, cwd: string): Promise<string | null> {
  const discovery = await discoverHostHermes({
    binaryPath: config.hermesAcp.binaryPath,
    cwd,
    timeoutMs: config.hermesAcp.discoveryTimeoutMs,
  });
  return discovery.sourceProfile?.name ?? null;
}

function formatCheck(check: DoctorCheck): string {
  return `[${check.status.toUpperCase()}] ${check.id}: ${check.message}`;
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
