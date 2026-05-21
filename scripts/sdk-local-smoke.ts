#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Agent,
  Cursor,
  CursorAgentError,
  type ModelParameterValue,
  type ModelSelection,
  type Run,
  type SDKAgentInfo,
  type SDKMessage,
  type SDKModel,
  type SettingSource,
} from "@cursor/sdk";
import { Command } from "commander";

const VALID_SETTING_SOURCES = new Set<SettingSource>(["project", "user", "team", "mdm", "plugins", "all"]);
const DEFAULT_EXPECTED_TEXT = "Symphony local SDK smoke OK";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PARAMS = "reasoning=extra-high";

class SmokeOptionError extends Error {}

interface SmokeOptions {
  cwd: string;
  model: string;
  modelVariant: string | null;
  modelParams: ModelParameterValue[] | null;
  name: string;
  prompt: string;
  expectedText: string | null;
  settingSources: SettingSource[];
  force: boolean;
}

interface RawOptions {
  cwd?: string;
  model?: string;
  modelVariant?: string;
  modelParams?: string;
  name?: string;
  prompt?: string;
  expect?: string;
  settingSources?: string;
  force?: boolean;
}

const program = new Command()
  .name("sdk-local-smoke")
  .description("Run a local-runtime Cursor SDK agent smoke test")
  .option("--cwd <path>", "local workspace path", process.cwd())
  .option("--model <id>", "Cursor model id", process.env.SYMPHONY_SDK_SMOKE_MODEL ?? DEFAULT_MODEL)
  .option(
    "--model-variant <name>",
    "Cursor model variant display name to copy params from; use 'none' to disable",
    process.env.SYMPHONY_SDK_SMOKE_MODEL_VARIANT ?? "none",
  )
  .option(
    "--model-params <pairs>",
    "comma-separated model params that override variant lookup, for example reasoning=extra-high",
    process.env.SYMPHONY_SDK_SMOKE_MODEL_PARAMS ?? DEFAULT_MODEL_PARAMS,
  )
  .option(
    "--name <name>",
    "human-readable agent name to search for in Cursor",
    process.env.SYMPHONY_SDK_SMOKE_NAME ?? `Symphony SDK Local Smoke ${new Date().toISOString()}`,
  )
  .option(
    "--prompt <prompt>",
    "prompt to send to the local SDK agent",
    process.env.SYMPHONY_SDK_SMOKE_PROMPT ??
      `This is a local SDK smoke test. Reply with exactly: ${DEFAULT_EXPECTED_TEXT}`,
  )
  .option(
    "--expect <text>",
    "text that must appear in the terminal run result; use 'none' to disable",
    process.env.SYMPHONY_SDK_SMOKE_EXPECT ?? DEFAULT_EXPECTED_TEXT,
  )
  .option(
    "--setting-sources <sources>",
    "comma-separated local Cursor setting sources: project,user,team,mdm,plugins,all or none",
    process.env.SYMPHONY_SDK_SMOKE_SETTING_SOURCES ?? "project,user",
  )
  .option("--force", "expire an active persisted local run before sending the smoke prompt", false);

program.parse(process.argv);

void main(program.opts<RawOptions>()).catch((error) => {
  if (error instanceof SmokeOptionError) {
    console.error(`[smoke] invalid options: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof CursorAgentError) {
    console.error("[smoke] Cursor SDK error");
    console.error(formatError(error));
    process.exitCode = 1;
    return;
  }
  console.error("[smoke] unexpected error");
  console.error(formatError(error));
  process.exitCode = 1;
});

async function main(rawOptions: RawOptions): Promise<void> {
  const options = await normalizeOptions(rawOptions);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("[smoke] CURSOR_API_KEY is required for local runtime SDK smoke tests.");
    console.error("[smoke] Example: $env:CURSOR_API_KEY=\"cursor_...\"; npm run smoke:sdk-local");
    process.exitCode = 1;
    return;
  }

  printUsageNotes(options);
  console.log("[smoke] starting local-runtime Cursor SDK smoke");
  console.log(
    JSON.stringify(
      {
        cwd: options.cwd,
        model: options.model,
        modelVariant: options.modelVariant,
        modelParams: options.modelParams,
        name: options.name,
        expectedText: options.expectedText,
        settingSources: options.settingSources,
        force: options.force,
      },
      null,
      2,
    ),
  );

  const model = await resolveModelSelection(apiKey, options);
  console.log("[smoke] resolved model selection");
  console.log(JSON.stringify(model, null, 2));

  const agent = await Agent.create({
    apiKey,
    model,
    name: options.name,
    local: {
      cwd: options.cwd,
      settingSources: options.settingSources,
    },
  });

  try {
    console.log(`[smoke] agent created: ${agent.agentId}`);
    if (agent.agentId.startsWith("bc-")) {
      throw new Error(`Expected a local agent id, but received cloud-shaped id: ${agent.agentId}`);
    }
    console.log("[smoke] sending prompt");
    const run = await agent.send(options.prompt, options.force ? { local: { force: true } } : undefined);
    console.log(`[smoke] run started: ${run.id} status=${run.status}`);

    if (!run.supports("stream")) {
      throw new Error(`run.stream unsupported: ${run.unsupportedReason("stream") ?? "no reason provided"}`);
    }
    if (!run.supports("wait")) {
      throw new Error(`run.wait unsupported: ${run.unsupportedReason("wait") ?? "no reason provided"}`);
    }

    for await (const message of run.stream()) {
      printMessage(message);
    }

    const result = await run.wait();
    console.log("[smoke] run finished");
    console.log(
      JSON.stringify(
        {
          agentId: agent.agentId,
          runId: run.id,
          status: result.status,
          durationMs: result.durationMs,
          result: result.result,
        },
        null,
        2,
      ),
    );

    await printConversationSupport(run);
    await assertLocalSdkListing(agent.agentId, run.id, options.cwd);
    printManualChecklist(options, agent.agentId, run.id);

    if (result.status !== "finished") {
      console.error(`[smoke] run terminal status was ${result.status}`);
      process.exitCode = 2;
      return;
    }
    if (options.expectedText && !result.result?.includes(options.expectedText)) {
      console.error(`[smoke] expected result text not found: ${options.expectedText}`);
      process.exitCode = 2;
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

async function normalizeOptions(raw: RawOptions): Promise<SmokeOptions> {
  const cwd = await fs.realpath(path.resolve(raw.cwd ?? process.cwd()));
  const settingSources = parseSettingSources(raw.settingSources ?? "project,user");
  const expectedText = raw.expect === "none" ? null : (raw.expect ?? DEFAULT_EXPECTED_TEXT);
  const modelParams = raw.modelParams === undefined ? null : parseModelParams(raw.modelParams);
  const modelVariant = raw.modelVariant === "none" ? null : (raw.modelVariant ?? null);
  return {
    cwd,
    model: raw.model ?? DEFAULT_MODEL,
    modelVariant,
    modelParams,
    name: raw.name ?? `Symphony SDK Local Smoke ${new Date().toISOString()}`,
    prompt: raw.prompt ?? `This is a local SDK smoke test. Reply with exactly: ${DEFAULT_EXPECTED_TEXT}`,
    expectedText,
    settingSources,
    force: raw.force ?? false,
  };
}

function parseSettingSources(input: string): SettingSource[] {
  if (input.trim().toLowerCase() === "none") return [];
  const values = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const invalid = values.filter((value) => !VALID_SETTING_SOURCES.has(value as SettingSource));
  if (invalid.length > 0) {
    throw new SmokeOptionError(`Invalid setting source(s): ${invalid.join(", ")}`);
  }
  return values as SettingSource[];
}

function parseModelParams(input: string): ModelParameterValue[] {
  if (input.trim().length === 0 || input.trim().toLowerCase() === "none") return [];
  return input.split(",").map((pair) => {
    const [id, value, ...extra] = pair.split("=");
    if (!id || !value || extra.length > 0) {
      throw new SmokeOptionError(`Invalid model param pair: ${pair}. Expected id=value.`);
    }
    return { id: id.trim(), value: value.trim() };
  });
}

async function resolveModelSelection(apiKey: string, options: SmokeOptions): Promise<ModelSelection> {
  if (options.modelParams) return modelSelection(options.model, options.modelParams);
  if (!options.modelVariant) return { id: options.model };

  const models = await Cursor.models.list({ apiKey });
  const model = models.find((candidate) => candidate.id === options.model);
  if (!model) {
    throw new SmokeOptionError(
      `Cannot use model ${options.model}. Available models: ${models.map((candidate) => candidate.id).join(", ")}`,
    );
  }

  const variant = findVariant(model, options.modelVariant);
  if (!variant) {
    const variants = model.variants?.map((candidate) => candidate.displayName).join(", ") || "none";
    const parameters =
      model.parameters
        ?.map((parameter) => `${parameter.id}=[${parameter.values.map((value) => value.value).join(", ")}]`)
        .join("; ") || "none";
    throw new SmokeOptionError(
      `Could not find variant "${options.modelVariant}" for ${options.model}. Variants: ${variants}. Parameters: ${parameters}. ` +
        "Use --model-variant none or --model-params id=value.",
    );
  }

  return modelSelection(options.model, variant.params);
}

function modelSelection(modelId: string, params: ModelParameterValue[]): ModelSelection {
  return params.length === 0 ? { id: modelId } : { id: modelId, params };
}

function findVariant(model: SDKModel, requestedName: string): { params: ModelParameterValue[] } | null {
  const requested = normalizeVariantName(requestedName);
  return (
    model.variants?.find((variant) => normalizeVariantName(variant.displayName) === requested) ??
    model.variants?.find((variant) => normalizeVariantName(variant.displayName).includes(requested)) ??
    null
  );
}

function normalizeVariantName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function printMessage(message: SDKMessage): void {
  switch (message.type) {
    case "system":
      console.log(
        `[stream:system] subtype=${message.subtype ?? "system"} model=${message.model?.id ?? "unknown"} tools=${
          message.tools?.length ?? 0
        }`,
      );
      return;
    case "assistant":
      for (const block of message.message.content) {
        if (block.type === "text") console.log(`[stream:assistant] ${oneLine(block.text)}`);
        if (block.type === "tool_use") console.log(`[stream:assistant-tool-use] ${block.name}`);
      }
      return;
    case "thinking":
      console.log(`[stream:thinking] ${oneLine(message.text)}`);
      return;
    case "task":
      console.log(`[stream:task] ${oneLine(message.text ?? message.status ?? "")}`);
      return;
    case "tool_call":
      console.log(
        `[stream:tool] ${message.name} status=${message.status} truncated=${JSON.stringify(message.truncated ?? {})}`,
      );
      return;
    case "status":
      console.log(`[stream:status] ${message.status}${message.message ? ` ${oneLine(message.message)}` : ""}`);
      return;
    case "request":
      console.log(`[stream:request] ${message.request_id}`);
      return;
    case "user":
      console.log("[stream:user] prompt recorded");
      return;
  }
}

async function printConversationSupport(run: Run): Promise<void> {
  if (!run.supports("conversation")) {
    console.log(`[smoke] run.conversation unsupported: ${run.unsupportedReason("conversation") ?? "no reason provided"}`);
    return;
  }
  const conversation = await run.conversation();
  console.log(`[smoke] run.conversation turns=${conversation.length}`);
}

async function assertLocalSdkListing(agentId: string, runId: string, cwd: string): Promise<void> {
  const agents = await Agent.list({ runtime: "local", cwd, limit: 25 });
  const match = agents.items.find((agent) => agent.agentId === agentId);
  console.log("[smoke] Agent.list({ runtime: \"local\", cwd }) match");
  console.log(JSON.stringify(match === undefined ? null : summarizeAgent(match), null, 2));
  if (!match) {
    throw new Error(`Created agent was not found in local SDK listing for cwd: ${cwd}`);
  }
  if (match.runtime !== "local") {
    throw new Error(`Expected local SDK listing, got runtime: ${match.runtime ?? "unknown"}`);
  }

  const runs = await Agent.listRuns(agentId, { runtime: "local", cwd, limit: 5 });
  console.log("[smoke] recent local runs");
  console.log(
    JSON.stringify(
      runs.items.map((run) => ({ id: run.id, status: run.status, createdAt: run.createdAt })),
      null,
      2,
    ),
  );
  if (!runs.items.some((run) => run.id === runId)) {
    throw new Error(`Created run was not found in Agent.listRuns for local agent: ${runId}`);
  }
}

function printManualChecklist(options: SmokeOptions, agentId: string, runId: string): void {
  console.log(`
[smoke] Manual local visibility checklist
1. Open the same workspace in Cursor: ${options.cwd}
2. Open Cursor's Agents Window: Command Palette -> Open Agents Window.
3. Search for agent name: ${options.name}
4. Search for agent id: ${agentId}
5. Confirm run id if surfaced: ${runId}
6. Check whether transcript/progress appears in Cursor UI.
7. Check whether follow-up/cancel/takeover controls exist for this local SDK agent.

If the agent only appears in this script's Agent.list output, local SDK persistence exists but Cursor UI visibility is not confirmed.
`);
}

function printUsageNotes(options: SmokeOptions): void {
  console.log(`
[smoke] Notes
- This is local runtime only: the script passes local.cwd and never passes cloud/repo options.
- It still uses CURSOR_API_KEY for SDK authentication and may use network-backed Cursor services.
- It creates a persisted local SDK agent/run for cwd: ${options.cwd}
- Default model baseline is ${DEFAULT_MODEL} with ${DEFAULT_MODEL_PARAMS}.
- Default setting sources are project,user to resemble Symphony; use --setting-sources none for an isolated probe.
- By default it will not force-expire an active local run; pass --force only if you need that recovery path.
`);
}

function summarizeAgent(agent: SDKAgentInfo): unknown {
  return {
    agentId: agent.agentId,
    name: agent.name,
    status: agent.status,
    runtime: agent.runtime,
    cwd: agent.runtime === "local" ? agent.cwd : undefined,
    lastModified: agent.lastModified,
    createdAt: agent.createdAt,
  };
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
