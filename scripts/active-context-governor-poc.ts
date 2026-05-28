#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent, Cursor, CursorAgentError, type ModelSelection, type SettingSource } from "@cursor/sdk";
import { Command } from "commander";
import {
  buildContinuationSummary,
  countKnownPromptTokens,
  decideBeforeSend,
  decideDuringRun,
  estimateRunTokenTotal,
  evidenceEvent,
  loadPromptFromFile,
  parseModelParamPairs,
  promptSourceFromText,
  readPromptFromStdin,
  reconcileKnownPromptTokens,
  renderContinuationPrompt,
  serializeEvidenceEvent,
  StreamingTokenAccumulator,
  validateModelSelection,
  type EvidenceEvent,
  type GovernorThresholds,
  type PromptSource,
  type StreamAccumulatorSnapshot,
} from "../src/core/context-governor/index.js";

const VALID_SETTING_SOURCES = new Set<SettingSource>(["project", "user", "team", "mdm", "plugins", "all"]);
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PARAMS = "context=272k,reasoning=extra-high";

process.on("unhandledRejection", (reason) => {
  if (isSdkCancellationError(reason)) {
    console.error(`[poc] ignored SDK cancellation rejection: ${formatError(reason)}`);
    return;
  }
  throw reason;
});

interface RawOptions {
  prompt?: string;
  cwd?: string;
  model?: string;
  modelParams?: string;
  settingSources?: string;
  maxKnownPromptTokens?: string;
  maxOutputTokens?: string;
  maxRunTotalTokens?: string;
  maxEstimatedRunTotalTokens?: string;
  inputTokenReserve?: string;
  maxTurnInputTokens?: string;
  maxTurnTotalTokens?: string;
  cancelAfterMs?: string;
  maxContinuations?: string;
  jsonl?: string;
  allowLargeContext?: boolean;
  continueOnFinish?: boolean;
  nonceProbe?: boolean;
}

interface PocOptions {
  promptPath: string | null;
  cwd: string;
  model: ModelSelection;
  settingSources: SettingSource[];
  thresholds: GovernorThresholds;
  cancelAfterMs: number | null;
  inputTokenReserve: number;
  maxContinuations: number;
  jsonlPath: string | null;
  allowLargeContext: boolean;
  continueOnFinish: boolean;
  nonceProbe: boolean;
}

interface RunOutcome {
  agentId: string;
  runId: string;
  status: string;
  resultText: string | null;
  cancelRequested: boolean;
  cancelReason: string | null;
  snapshot: StreamAccumulatorSnapshot;
}

const program = new Command()
  .name("active-context-governor-poc")
  .description("POC for active Cursor SDK context/token governor behavior")
  .allowExcessArguments(true)
  .option("--prompt <path>", "markdown prompt file; if omitted, stdin is used")
  .option("--cwd <path>", "local workspace path", process.cwd())
  .option("--model <id>", "Cursor model id", DEFAULT_MODEL)
  .option("--model-params <pairs>", "comma-separated model params", DEFAULT_MODEL_PARAMS)
  .option("--setting-sources <sources>", "comma-separated setting sources or none", "none")
  .option("--max-known-prompt-tokens <n>", "block before send when known prompt estimate exceeds n")
  .option("--max-output-tokens <n>", "cancel and summarize when observed token-delta output reaches n")
  .option("--max-run-total-tokens <n>", "cancel when known prompt estimate + input reserve + observed output reaches n")
  .option("--max-estimated-run-total-tokens <n>", "alias for --max-run-total-tokens")
  .option("--input-token-reserve <n>", "extra estimated input tokens reserved for Cursor-added context", "0")
  .option("--max-turn-input-tokens <n>", "cancel and summarize when turn-ended input tokens exceed n")
  .option("--max-turn-total-tokens <n>", "cancel and summarize when turn-ended total tokens exceed n")
  .option("--cancel-after-ms <n>", "cancel first run after elapsed milliseconds")
  .option("--max-continuations <n>", "maximum fresh-agent continuation cycles after governor interruption", "1")
  .option("--jsonl <path>", "write JSONL evidence to this file")
  .option("--allow-large-context", "allow context=1m model params", false)
  .option("--continue-on-finish", "create a fresh continuation run even when first run finishes", false)
  .option("--nonce-probe", "run an optional same-agent vs fresh-agent memory-boundary probe", false);

program.parse(process.argv.filter((arg, index) => index < 2 || arg !== "--"));

void main(program.opts<RawOptions>()).catch((error) => {
  if (error instanceof CursorAgentError) {
    console.error("[poc] Cursor SDK error");
    console.error(formatError(error));
    process.exitCode = 1;
    return;
  }
  console.error("[poc] unexpected error");
  console.error(formatError(error));
  process.exitCode = 1;
});

async function main(raw: RawOptions): Promise<void> {
  const options = await normalizeOptions(raw);
  const apiKey = await resolveApiKey();
  const prompt = await loadPrompt(options.promptPath);
  const knownPromptTokens = countKnownPromptTokens(prompt.text);
  const evidence = new EvidenceWriter(options.jsonlPath);

  await evidence.write("prompt_loaded", {
    source: prompt.label,
    kind: prompt.kind,
    sha256: prompt.sha256,
    charCount: prompt.charCount,
    byteCount: prompt.byteCount,
    lineCount: prompt.lineCount,
    knownPromptTokens,
  });

  const catalog = await Cursor.models.list({ apiKey });
  const catalogResult = validateModelSelection(catalog, options.model, {
    allowLargeContext: options.allowLargeContext,
  });
  await evidence.write("model_catalog_validation", catalogResult);
  printJson("[poc] model catalog validation", catalogResult);
  if (!catalogResult.ok) {
    process.exitCode = 2;
    return;
  }

  printJson("[poc] known prompt tokens", {
    source: prompt.label,
    charCount: prompt.charCount,
    knownPromptTokens,
    inputTokenReserve: options.inputTokenReserve,
    estimatedInputTokens: knownPromptTokens.tokens + options.inputTokenReserve,
  });

  let currentSource = prompt;
  let currentTokenCount = knownPromptTokens;
  let previousOutcome: RunOutcome | null = null;

  for (let turn = 0; ; turn += 1) {
    const beforeSendDecision = decideBeforeSend({
      knownPromptTokens: currentTokenCount.tokens,
      inputReserveTokens: options.inputTokenReserve,
      thresholds: options.thresholds,
    });
    await evidence.write("before_send_decision", {
      turn,
      source: currentSource.label,
      knownPromptTokens: currentTokenCount,
      inputTokenReserve: options.inputTokenReserve,
      estimatedRunTokenTotal: estimateRunTokenTotal({
        knownPromptTokens: currentTokenCount.tokens,
        inputReserveTokens: options.inputTokenReserve,
      }),
      decision: beforeSendDecision,
    });
    printJson("[poc] before-send decision", {
      turn,
      source: currentSource.label,
      knownPromptTokens: currentTokenCount.tokens,
      inputTokenReserve: options.inputTokenReserve,
      decision: beforeSendDecision,
    });
    if (beforeSendDecision.action === "block_before_send") {
      await evidence.write("run_blocked_before_send", { turn, decision: beforeSendDecision });
      process.exitCode = turn === 0 ? 2 : 0;
      break;
    }

    const outcome = await runPrompt({
      apiKey,
      cwd: options.cwd,
      model: options.model,
      settingSources: options.settingSources,
      promptText: currentSource.text,
      runName:
        turn === 0
          ? `Symphony Active Context Governor POC ${new Date().toISOString()}`
          : `Symphony Active Context Governor Continuation ${turn} ${new Date().toISOString()}`,
      thresholds: options.thresholds,
      cancelAfterMs: turn === 0 ? options.cancelAfterMs : null,
      knownPromptTokens: currentTokenCount.tokens,
      inputTokenReserve: options.inputTokenReserve,
      evidence,
    });

    if (previousOutcome) {
      await evidence.write("fresh_continuation_complete", {
        oldAgentId: previousOutcome.agentId,
        oldRunId: previousOutcome.runId,
        freshAgentId: outcome.agentId,
        freshRunId: outcome.runId,
        finalStatus: outcome.status,
      });
      printJson("[poc] fresh continuation complete", {
        oldAgentId: previousOutcome.agentId,
        oldRunId: previousOutcome.runId,
        freshAgentId: outcome.agentId,
        freshRunId: outcome.runId,
        finalStatus: outcome.status,
      });
    }

    const latestUsage = outcome.snapshot.latestUsage;
    if (latestUsage) {
      const reconciliation = reconcileKnownPromptTokens(currentTokenCount, latestUsage);
      await evidence.write("prompt_token_reconciliation", reconciliation);
      printJson("[poc] prompt token reconciliation", reconciliation);
      const estimatedTotalThreshold = options.thresholds.maxEstimatedRunTotalTokens;
      if (estimatedTotalThreshold !== undefined && latestUsage.totalTokens > estimatedTotalThreshold) {
        const overBudget = {
          turn,
          threshold: estimatedTotalThreshold,
          sdkTotalTokens: latestUsage.totalTokens,
          sdkInputTokens: latestUsage.inputTokens,
          sdkOutputTokens: latestUsage.outputTokens,
          note: "Actual SDK usage arrived at turn-ended after the live estimated gate could act.",
        };
        await evidence.write("actual_total_budget_exceeded", overBudget);
        printJson("[poc] actual total budget exceeded post-turn", overBudget);
      }
    } else {
      await evidence.write("prompt_token_reconciliation_unavailable", {
        note: "SDK did not emit turn-ended.usage before terminal status.",
      });
    }

    const shouldContinue = outcome.cancelRequested || (options.continueOnFinish && turn === 0);
    if (!shouldContinue) break;
    if (turn >= options.maxContinuations) {
      await evidence.write("continuation_cap_reached", {
        maxContinuations: options.maxContinuations,
        lastAgentId: outcome.agentId,
        lastRunId: outcome.runId,
        lastStatus: outcome.status,
        lastCancelReason: outcome.cancelReason,
      });
      printJson("[poc] continuation cap reached", {
        maxContinuations: options.maxContinuations,
        lastAgentId: outcome.agentId,
        lastRunId: outcome.runId,
        lastStatus: outcome.status,
        lastCancelReason: outcome.cancelReason,
      });
      break;
    }

    const summary = buildContinuationSummary({
      prompt: currentSource,
      knownPromptTokens: currentTokenCount,
      snapshot: outcome.snapshot,
      reason: outcome.cancelReason ?? `run_${turn}_${outcome.status}`,
    });
    const continuationPrompt = renderContinuationPrompt(summary);
    currentSource = promptSourceFromText({
      kind: "inline",
      label: `deterministic-continuation-summary-${turn + 1}`,
      text: continuationPrompt,
    });
    currentTokenCount = countKnownPromptTokens(continuationPrompt);
    await evidence.write("continuation_summary", { summary, continuationTokens: currentTokenCount });
    printJson("[poc] continuation summary", {
      reason: summary.reason,
      continuationPromptTokens: currentTokenCount,
    });
    previousOutcome = outcome;
  }

  if (options.nonceProbe) {
    await runNonceProbe({ apiKey, cwd: options.cwd, model: options.model, settingSources: options.settingSources, evidence });
  }
}

async function runPrompt(input: {
  apiKey: string;
  cwd: string;
  model: ModelSelection;
  settingSources: SettingSource[];
  promptText: string;
  runName: string;
  thresholds: GovernorThresholds;
  cancelAfterMs: number | null;
  knownPromptTokens: number;
  inputTokenReserve: number;
  evidence: EvidenceWriter;
}): Promise<RunOutcome> {
  const accumulator = new StreamingTokenAccumulator();
  const agent = await Agent.create({
    apiKey: input.apiKey,
    model: input.model,
    name: input.runName,
    local: { cwd: input.cwd, settingSources: input.settingSources },
  });
  let cancelRequested = false;
  let cancelReason: string | null = null;
  let cancelDelivered = false;
  let runRef: Awaited<ReturnType<typeof agent.send>> | null = null;
  let cancelTimer: NodeJS.Timeout | null = null;

  const deliverCancel = async (reason: string): Promise<void> => {
    if (!runRef || cancelDelivered) return;
    if (!runRef.supports("cancel")) {
      await input.evidence.write("cancel_unsupported", { reason, runId: runRef.id, unsupportedReason: runRef.unsupportedReason("cancel") });
      cancelDelivered = true;
      return;
    }
    try {
      await runRef.cancel();
      await input.evidence.write("cancel_delivered", { reason, runId: runRef.id });
    } catch (error) {
      await input.evidence.write("cancel_error", { reason, runId: runRef.id, error: formatError(error) });
      console.error(`[poc] cancel error: ${formatError(error)}`);
    }
    cancelDelivered = true;
  };

  const requestCancel = async (reason: string): Promise<void> => {
    if (!cancelRequested) {
      cancelRequested = true;
      cancelReason = reason;
      await input.evidence.write("cancel_requested", { reason, runId: runRef?.id ?? null });
    }
    await deliverCancel(cancelReason ?? reason);
  };

  try {
    await input.evidence.write("agent_created", { agentId: agent.agentId, model: input.model });
    const run = await agent.send(input.promptText, {
      model: input.model,
      local: { force: true },
      onDelta: async ({ update }) => {
        const snapshot = accumulator.recordUpdate(update);
        await input.evidence.write("interaction_update", {
          type: updateType(update),
          snapshot: compactSnapshot(snapshot),
        });
        const decision = decideDuringRun({
          snapshot,
          knownPromptTokens: input.knownPromptTokens,
          inputReserveTokens: input.inputTokenReserve,
          thresholds: input.thresholds,
        });
        if (decision.action === "cancel_and_summarize") {
          await input.evidence.write("governor_decision", decision);
          await requestCancel(decision.reason ?? "governor_threshold");
        }
      },
    });
    runRef = run;
    if (cancelRequested) await deliverCancel(cancelReason ?? "pending_cancel_request");
    await input.evidence.write("run_started", {
      agentId: agent.agentId,
      runId: run.id,
      status: run.status,
      model: run.model,
      estimatedRunTokenTotal: estimateRunTokenTotal({
        knownPromptTokens: input.knownPromptTokens,
        inputReserveTokens: input.inputTokenReserve,
      }),
    });
    printJson("[poc] run started", { agentId: agent.agentId, runId: run.id, status: run.status, model: run.model });

    if (input.cancelAfterMs !== null) {
      cancelTimer = setTimeout(() => {
        void requestCancel("cancel_after_ms").catch((error) => {
          console.error(`[poc] cancel timer error: ${formatError(error)}`);
        });
      }, input.cancelAfterMs);
    }

    if (run.supports("stream")) {
      try {
        for await (const message of run.stream()) {
          const snapshot = accumulator.recordMessage(message);
          await input.evidence.write("stream_message", {
            type: updateType(message),
            snapshot: compactSnapshot(snapshot),
          });
          printStreamMessage(message);
        }
      } catch (error) {
        await input.evidence.write("stream_error", { error: formatError(error) });
        console.error(`[poc] stream error: ${formatError(error)}`);
      }
    } else {
      await input.evidence.write("stream_unsupported", { reason: run.unsupportedReason("stream") });
    }

    const result = run.supports("wait") ? await run.wait() : { status: "error", result: "run.wait unsupported" };
    const snapshot = accumulator.snapshot();
    await input.evidence.write("run_terminal", {
      agentId: agent.agentId,
      runId: run.id,
      status: result.status,
      result: result.result,
      model: "model" in result ? result.model : null,
      snapshot: compactSnapshot(snapshot),
    });
    printJson("[poc] run terminal", {
      agentId: agent.agentId,
      runId: run.id,
      status: result.status,
      cancelRequested,
      cancelReason,
      latestUsage: snapshot.latestUsage,
    });
    return {
      agentId: agent.agentId,
      runId: run.id,
      status: result.status,
      resultText: typeof result.result === "string" ? result.result : null,
      cancelRequested,
      cancelReason,
      snapshot,
    };
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    await agent[Symbol.asyncDispose]();
    await input.evidence.write("agent_disposed", { agentId: agent.agentId });
  }
}

async function runNonceProbe(input: {
  apiKey: string;
  cwd: string;
  model: ModelSelection;
  settingSources: SettingSource[];
  evidence: EvidenceWriter;
}): Promise<void> {
  const nonce = randomUUID();
  const rememberPrompt = `Remember this nonce exactly for the next turn: ${nonce}\nReply with exactly: READY`;
  const askPrompt = "What nonce did I ask you to remember? Reply with only the nonce, or NO_NONCE if you do not know.";
  const summaryPrompt = `Compact continuation summary: the previous run asked the agent to remember nonce ${nonce}.\n${askPrompt}`;

  const sameAgent = await Agent.create({
    apiKey: input.apiKey,
    model: input.model,
    name: `Symphony Governor Nonce Same-Agent ${new Date().toISOString()}`,
    local: { cwd: input.cwd, settingSources: input.settingSources },
  });
  try {
    const first = await sameAgent.send(rememberPrompt, { model: input.model, local: { force: true } });
    await first.wait();
    const sameRun = await sameAgent.send(askPrompt, { model: input.model, local: { force: true } });
    const sameResult = await sameRun.wait();
    await input.evidence.write("nonce_probe_same_agent", { nonce, result: sameResult.result, containsNonce: sameResult.result?.includes(nonce) ?? false });
  } finally {
    await sameAgent[Symbol.asyncDispose]();
  }

  const freshNoSummary = await runOneShot({
    apiKey: input.apiKey,
    cwd: input.cwd,
    model: input.model,
    settingSources: input.settingSources,
    name: `Symphony Governor Nonce Fresh No Summary ${new Date().toISOString()}`,
    prompt: askPrompt,
  });
  await input.evidence.write("nonce_probe_fresh_without_summary", {
    nonce,
    result: freshNoSummary.result,
    containsNonce: freshNoSummary.result?.includes(nonce) ?? false,
  });

  const freshWithSummary = await runOneShot({
    apiKey: input.apiKey,
    cwd: input.cwd,
    model: input.model,
    settingSources: input.settingSources,
    name: `Symphony Governor Nonce Fresh With Summary ${new Date().toISOString()}`,
    prompt: summaryPrompt,
  });
  await input.evidence.write("nonce_probe_fresh_with_summary", {
    nonce,
    result: freshWithSummary.result,
    containsNonce: freshWithSummary.result?.includes(nonce) ?? false,
  });
  printJson("[poc] nonce probe complete", {
    nonce,
    freshWithoutSummaryContainsNonce: freshNoSummary.result?.includes(nonce) ?? false,
    freshWithSummaryContainsNonce: freshWithSummary.result?.includes(nonce) ?? false,
  });
}

async function runOneShot(input: {
  apiKey: string;
  cwd: string;
  model: ModelSelection;
  settingSources: SettingSource[];
  name: string;
  prompt: string;
}): Promise<{ status: string; result: string | undefined }> {
  const agent = await Agent.create({
    apiKey: input.apiKey,
    model: input.model,
    name: input.name,
    local: { cwd: input.cwd, settingSources: input.settingSources },
  });
  try {
    const run = await agent.send(input.prompt, { model: input.model, local: { force: true } });
    const result = await run.wait();
    return { status: result.status, result: result.result };
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

async function normalizeOptions(raw: RawOptions): Promise<PocOptions> {
  const promptOption = configString(raw.prompt, "prompt");
  const cwdOption = configString(raw.cwd, "cwd") ?? process.cwd();
  const modelOption = configString(raw.model, "model") ?? DEFAULT_MODEL;
  const modelParamsOption = configString(raw.modelParams, "model_params") ?? DEFAULT_MODEL_PARAMS;
  const settingSourcesOption = configString(raw.settingSources, "setting_sources") ?? "none";
  const promptPath = promptOption === undefined ? null : path.resolve(promptOption);
  const cwd = await fs.realpath(path.resolve(cwdOption));
  const thresholds: GovernorThresholds = {};
  const maxKnownPromptTokens = parseOptionalPositiveInteger(
    configString(raw.maxKnownPromptTokens, "max_known_prompt_tokens"),
    "--max-known-prompt-tokens",
  );
  if (maxKnownPromptTokens !== undefined) thresholds.maxKnownPromptTokens = maxKnownPromptTokens;
  const maxObservedOutputTokens = parseOptionalPositiveInteger(configString(raw.maxOutputTokens, "max_output_tokens"), "--max-output-tokens");
  if (maxObservedOutputTokens !== undefined) thresholds.maxObservedOutputTokens = maxObservedOutputTokens;
  const maxEstimatedRunTotalTokens = parseOptionalPositiveInteger(
    configString(raw.maxRunTotalTokens, "max_run_total_tokens") ??
      configString(raw.maxEstimatedRunTotalTokens, "max_estimated_run_total_tokens"),
    "--max-run-total-tokens",
  );
  if (maxEstimatedRunTotalTokens !== undefined) thresholds.maxEstimatedRunTotalTokens = maxEstimatedRunTotalTokens;
  const maxTurnInputTokens = parseOptionalPositiveInteger(configString(raw.maxTurnInputTokens, "max_turn_input_tokens"), "--max-turn-input-tokens");
  if (maxTurnInputTokens !== undefined) thresholds.maxTurnInputTokens = maxTurnInputTokens;
  const maxTurnTotalTokens = parseOptionalPositiveInteger(configString(raw.maxTurnTotalTokens, "max_turn_total_tokens"), "--max-turn-total-tokens");
  if (maxTurnTotalTokens !== undefined) thresholds.maxTurnTotalTokens = maxTurnTotalTokens;
  return {
    promptPath,
    cwd,
    model: { id: modelOption, params: parseModelParamPairs(modelParamsOption) },
    settingSources: parseSettingSources(settingSourcesOption),
    thresholds,
    cancelAfterMs: parseOptionalPositiveInteger(configString(raw.cancelAfterMs, "cancel_after_ms"), "--cancel-after-ms") ?? null,
    inputTokenReserve: parseOptionalNonNegativeInteger(configString(raw.inputTokenReserve, "input_token_reserve"), "--input-token-reserve") ?? 0,
    maxContinuations: parseOptionalNonNegativeInteger(configString(raw.maxContinuations, "max_continuations"), "--max-continuations") ?? 1,
    jsonlPath: configString(raw.jsonl, "jsonl") === undefined ? null : path.resolve(configString(raw.jsonl, "jsonl") ?? ""),
    allowLargeContext: configBoolean(raw.allowLargeContext, "allow_large_context"),
    continueOnFinish: configBoolean(raw.continueOnFinish, "continue_on_finish"),
    nonceProbe: configBoolean(raw.nonceProbe, "nonce_probe"),
  };
}

async function loadPrompt(promptPath: string | null): Promise<PromptSource> {
  if (promptPath) return loadPromptFromFile(promptPath);
  if (process.stdin.isTTY) {
    throw new Error("No --prompt provided and stdin is a TTY. Pipe a prompt or pass --prompt <path>.");
  }
  return readPromptFromStdin();
}

function parseSettingSources(input: string): SettingSource[] {
  if (input.trim().toLowerCase() === "none") return [];
  const values = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const invalid = values.filter((value) => !VALID_SETTING_SOURCES.has(value as SettingSource));
  if (invalid.length > 0) throw new Error(`Invalid setting source(s): ${invalid.join(", ")}`);
  return values as SettingSource[];
}

function parseOptionalPositiveInteger(input: string | undefined, label: string): number | undefined {
  if (input === undefined) return undefined;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseOptionalNonNegativeInteger(input: string | undefined, label: string): number | undefined {
  if (input === undefined) return undefined;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function configString(raw: string | undefined, name: string): string | undefined {
  const envValue = process.env[`npm_config_${name}`];
  return raw ?? (envValue === undefined || envValue === "true" ? undefined : envValue);
}

function configBoolean(raw: boolean | undefined, name: string): boolean {
  const envValue = process.env[`npm_config_${name}`];
  if (envValue !== undefined) return envValue === "true" || envValue === "1";
  return raw ?? false;
}

async function resolveApiKey(): Promise<string> {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY;
  const envPath = path.resolve(".env");
  try {
    const text = await fs.readFile(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      if (key !== "CURSOR_API_KEY") continue;
      return trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error("CURSOR_API_KEY is required in the environment or .env");
}

function compactSnapshot(snapshot: StreamAccumulatorSnapshot): unknown {
  return {
    updateCounts: snapshot.updateCounts,
    messageCounts: snapshot.messageCounts,
    observedOutputTokenDeltas: snapshot.observedOutputTokenDeltas,
    estimatedOutputTokens: snapshot.estimatedOutputTokens,
    textDeltaChars: snapshot.textDeltaChars,
    thinkingDeltaChars: snapshot.thinkingDeltaChars,
    latestUsage: snapshot.latestUsage,
    systemModels: snapshot.systemModels,
  };
}

function printStreamMessage(message: unknown): void {
  if (!isRecord(message) || typeof message.type !== "string") return;
  if (message.type === "assistant" && isRecord(message.message) && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        process.stdout.write(block.text);
      }
    }
  }
}

function updateType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printJson(label: string, value: unknown): void {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isSdkCancellationError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return text.includes("canceled") || text.includes("cancelled") || text.includes("aborted");
}

class EvidenceWriter {
  constructor(private readonly filePath: string | null) {}

  async write(kind: string, payload: unknown): Promise<EvidenceEvent> {
    const event = evidenceEvent(kind, payload);
    if (this.filePath) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, serializeEvidenceEvent(event), "utf8");
    }
    return event;
  }
}
