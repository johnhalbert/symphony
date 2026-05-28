#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import { runMcpToolExposureProbe, type McpToolExposureReport } from "../src/core/harness/McpToolExposureProbe.js";
import { FileMcpExposureDiagnosticsStore } from "../src/core/persistence/McpExposureDiagnosticsStore.js";
import type { AgentRunRole } from "../src/core/types.js";
import type { CursorSettingSource } from "../src/core/config/Config.js";
import { errorMessage } from "../src/core/errors.js";

interface RawOptions {
  cliPath?: string;
  role?: string;
  timeoutMs?: string;
  waitTimeoutMs?: string;
  postCancelWaitMs?: string;
  cwd?: string;
  mcpCwd?: string;
  settingSources?: string;
  json?: boolean;
}

const program = new Command()
  .name("mcp-tool-exposure-probe")
  .description("Validate Symphony MCP subprocess tools/list and selected live runtime-harness tool exposure")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--cli-path <path>", "explicit Symphony CLI entrypoint for MCP subprocesses", path.resolve(process.cwd(), "src/cli.ts"))
  .option("--role <role>", "worker, reviewer, or all", "all")
  .option("--timeout-ms <ms>", "live runtime tool-exposure timeout", "45000")
  .option("--wait-timeout-ms <ms>", "bounded Cursor SDK wait() timeout after stream drain", "5000")
  .option("--post-cancel-wait-ms <ms>", "bounded Cursor SDK wait() timeout after cancel cleanup", "1500")
  .option("--cwd <path>", "local Cursor SDK agent cwd for the synthetic probe run")
  .option("--mcp-cwd <path>", "cwd used by MCP subprocess server configs during the live SDK probe")
  .option("--setting-sources <sources>", "comma-separated Cursor setting sources for the live SDK probe, or none")
  .option("--json", "print the sanitized diagnostic report as JSON");

program.parse(process.argv);

void main(program.args[0] ?? "WORKFLOW.md", program.opts<RawOptions>()).catch((error) => {
  console.error(`[mcp-exposure] unexpected error: ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main(workflow: string, rawOptions: RawOptions): Promise<void> {
  const workflowPath = path.resolve(process.cwd(), workflow);
  const loader = new WorkflowLoader(workflowPath);
  try {
    const loaded = await loader.load();
    const cliPath = path.resolve(process.cwd(), rawOptions.cliPath ?? "src/cli.ts");
    const roles = parseRoles(rawOptions.role ?? "all");
    const report = await runMcpToolExposureProbe({
      config: loaded.serviceConfig,
      cliPath,
      roles,
      liveSmokeEnabled: process.env.SYMPHONY_MCP_EXPOSURE_SMOKE === "1",
      sdkTimeoutMs: parsePositiveInt(rawOptions.timeoutMs ?? "45000", "--timeout-ms"),
      waitTimeoutMs: parsePositiveInt(rawOptions.waitTimeoutMs ?? "5000", "--wait-timeout-ms"),
      postCancelWaitMs: parsePositiveInt(rawOptions.postCancelWaitMs ?? "1500", "--post-cancel-wait-ms"),
      ...(rawOptions.cwd === undefined ? {} : { sdkCwd: path.resolve(process.cwd(), rawOptions.cwd) }),
      ...(rawOptions.mcpCwd === undefined ? {} : { mcpCwd: path.resolve(process.cwd(), rawOptions.mcpCwd) }),
      ...(rawOptions.settingSources === undefined ? {} : { settingSources: parseSettingSources(rawOptions.settingSources) }),
    });
    await new FileMcpExposureDiagnosticsStore(loaded.serviceConfig.workspace.stateDir).writeLatest(report);
    if (rawOptions.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
    if (!report.ok) process.exitCode = 2;
  } finally {
    await loader.close();
  }
}

function parseRoles(input: string): AgentRunRole[] {
  if (input === "all") return ["worker", "reviewer"];
  if (input === "worker" || input === "reviewer") return [input];
  throw new Error(`Invalid --role value: ${input}. Expected worker, reviewer, or all.`);
}

function parsePositiveInt(input: string, label: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseSettingSources(input: string): CursorSettingSource[] {
  const values = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 1 && values[0] === "none") return [];
  const valid = new Set(["project", "user", "team", "mdm", "plugins", "all"]);
  const invalid = values.filter((value) => !valid.has(value));
  if (invalid.length > 0) {
    throw new Error(`Invalid --setting-sources value: ${invalid.join(", ")}.`);
  }
  return values as CursorSettingSource[];
}

function formatReport(report: McpToolExposureReport): string {
  const lines = [
    `[${report.ok ? "OK" : "FAIL"}] Symphony MCP tool exposure probe`,
    `workflow: ${report.workflowPath}`,
    `cliPath: ${report.cliPath}`,
    `liveSmokeEnabled: ${report.liveSmokeEnabled}`,
    `agentCwd: ${report.probeConfig.agentCwd}`,
    `mcpCwd: ${report.probeConfig.mcpCwd}`,
    `settingSources: ${formatList(report.probeConfig.settingSources)}`,
  ];
  for (const stage of report.stages) {
    lines.push(`[${stage.status.toUpperCase()}] ${stage.stage}: ${stage.message}`);
    for (const result of stage.results) {
      lines.push(
        `  - ${result.role}/${result.serverKey}: ${result.status} expected=${result.expectedTool} rawTools=${formatList(
          result.rawToolNames,
        )} envKeys=${formatList(result.envKeyNames)}`,
      );
    }
  }
  return lines.join("\n");
}

function formatList(values: string[]): string {
  return values.length === 0 ? "none" : values.join(",");
}
