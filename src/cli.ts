#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { StatusServer } from "./app/http.js";
import { createAgentHarness } from "./core/harness/HarnessFactory.js";
import { StructuredLogger } from "./core/logging/StructuredLogger.js";
import { Orchestrator } from "./core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "./core/persistence/IssueLifecycleStore.js";
import { FileMcpExposureDiagnosticsStore } from "./core/persistence/McpExposureDiagnosticsStore.js";
import { FileRunTranscriptStore } from "./core/persistence/RunTranscriptStore.js";
import { WorkspaceManager } from "./core/workspace/WorkspaceManager.js";
import { WorkflowLoader } from "./core/workflow/WorkflowLoader.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { formatDoctorResult, runDoctor } from "./doctor.js";
import { runCompletionReportMcpServer } from "./core/harness/CompletionReportMcpServer.js";
import { runReviewFeedbackMcpServer } from "./core/harness/ReviewFeedbackMcpServer.js";
import { runReviewVerdictMcpServer } from "./core/harness/ReviewVerdictMcpServer.js";
import {
  createRuntimeTrackerClient,
  createRuntimeWritebackProcessor,
  resolveStatusMutationToken,
  resolveTrackerStateLists,
} from "./app/RuntimeDependencies.js";

const program = new Command();

program
  .name("symphony")
  .description("Run Symphony coding-agent orchestration");

program
  .command("doctor")
  .description("Run Symphony dogfood preflight checks")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--json", "print JSON output")
  .option("--strict", "treat warnings as failures")
  .action(async (workflow: string, options: { json?: boolean; strict?: boolean }) => {
    const result = await runDoctor({
      workflowPath: path.resolve(process.cwd(), workflow),
      strict: options.strict,
      cliPath: currentCliPath(),
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatDoctorResult(result));
    }
    if (!result.ok) process.exitCode = 2;
  });

program
  .command("completion-report-mcp")
  .description("Run the internal Symphony completion-report MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active worker context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runCompletionReportMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .command("review-verdict-mcp")
  .description("Run the internal Symphony review-verdict MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active reviewer context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runReviewVerdictMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .command("review-feedback-mcp")
  .description("Run the internal Symphony review-feedback MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active reviewer feedback context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runReviewFeedbackMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--port <port>", "enable local HTTP status server on this port")
  .option("--host <host>", "HTTP bind host")
  .action(async (workflow: string, options: { port?: string; host?: string }) => {
    const logger = new StructuredLogger();
    const workflowPath = path.resolve(process.cwd(), workflow);
    const loader = new WorkflowLoader(workflowPath);
    const loaded = await loader.load();
    const config = {
      ...loaded.serviceConfig,
      server: {
        ...loaded.serviceConfig.server,
        port: options.port === undefined ? loaded.serviceConfig.server.port : Number(options.port),
        host: options.host ?? loaded.serviceConfig.server.host,
      },
    };

    const tracker = createRuntimeTrackerClient(config);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const mcpExposureDiagnosticsStore = new FileMcpExposureDiagnosticsStore(config.workspace.stateDir);
    const writeback = createRuntimeWritebackProcessor(config, logger);
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger,
    });
    const harness = createAgentHarness(config, { runStore });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: loaded.definition.promptTemplate,
      runStore,
      lifecycleStore,
      ...(writeback === undefined ? {} : { writeback }),
    });

    loader.watch((event) => {
      if (event.loaded) {
        orchestrator.updateConfig(event.loaded.serviceConfig, event.loaded.definition.promptTemplate);
        logger.info("workflow reloaded", { workflow_path: event.loaded.definition.workflowPath });
      } else if (event.error) {
        logger.error("workflow reload failed", { error: event.error.message, code: event.error.code });
      }
    });

    const opener = new CursorWorkspaceOpener({
      workspaceRoot: config.workspace.root,
      openerCommand: config.cursor.openerCommand,
    });
    const statusServer =
      config.server.port === null
        ? null
        : new StatusServer({
            orchestrator,
            workspaceManager,
            workspaceOpener: opener,
            runStore,
            lifecycleStore,
            mcpExposureDiagnosticsStore,
            host: config.server.host,
            port: config.server.port,
            openWorkspaceToken: resolveStatusMutationToken(config),
            tracker,
            trackerStateLists: resolveTrackerStateLists(config),
            issueBoardColumns: config.issueBoard.columns,
            staleThresholdMs: config.polling.intervalMs,
          });

    if (statusServer) {
      const address = await statusServer.start();
      logger.info("status server started", { host: address.host, port: address.port });
    }

    await orchestrator.start();
    logger.info("symphony started", { workflow_path: workflowPath });

    const shutdown = async () => {
      logger.info("symphony shutting down");
      await orchestrator.stop();
      await statusServer?.stop();
      await loader.close();
      await harness.dispose?.();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exit(1);
});

function currentCliPath(): string {
  return path.resolve(process.argv[1] ?? "dist/cli.js");
}
