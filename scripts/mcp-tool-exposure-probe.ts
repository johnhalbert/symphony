#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import { runMcpToolExposureProbe, type McpToolExposureReport } from "../src/core/harness/McpToolExposureProbe.js";
import { FileMcpExposureDiagnosticsStore } from "../src/core/persistence/McpExposureDiagnosticsStore.js";
import type { AgentRunRole } from "../src/core/types.js";
import { errorMessage } from "../src/core/errors.js";

interface RawOptions {
  cliPath?: string;
  role?: string;
  timeoutMs?: string;
  cwd?: string;
  json?: boolean;
}

const program = new Command()
  .name("mcp-tool-exposure-probe")
  .description("Validate Symphony MCP subprocess tools/list and live Cursor SDK tool exposure")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--cli-path <path>", "explicit Symphony CLI entrypoint for MCP subprocesses", path.resolve(process.cwd(), "src/cli.ts"))
  .option("--role <role>", "worker, reviewer, or all", "all")
  .option("--timeout-ms <ms>", "live SDK system.tools wait timeout", "45000")
  .option("--cwd <path>", "local Cursor SDK cwd for the synthetic probe run")
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
      ...(rawOptions.cwd === undefined ? {} : { sdkCwd: path.resolve(process.cwd(), rawOptions.cwd) }),
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

function formatReport(report: McpToolExposureReport): string {
  const lines = [
    `[${report.ok ? "OK" : "FAIL"}] Symphony MCP tool exposure probe`,
    `workflow: ${report.workflowPath}`,
    `cliPath: ${report.cliPath}`,
    `liveSmokeEnabled: ${report.liveSmokeEnabled}`,
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
