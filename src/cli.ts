#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { StatusServer } from "./app/http.js";
import { parseDatabaseConfig, type DatabaseConfig, type ServiceConfig } from "./core/config/Config.js";
import { createAgentHarness } from "./core/harness/HarnessFactory.js";
import { StructuredLogger } from "./core/logging/StructuredLogger.js";
import { Orchestrator } from "./core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "./core/persistence/IssueLifecycleStore.js";
import { FileMcpExposureDiagnosticsStore } from "./core/persistence/McpExposureDiagnosticsStore.js";
import { FileOrchestratorConversationStore } from "./core/persistence/OrchestratorConversationStore.js";
import {
  PostgresProjectionTransactionStore,
  ProjectionTransactionService,
  type ProjectionSqlPool,
} from "./core/persistence/ProjectionTransactionService.js";
import { FileRunTranscriptStore } from "./core/persistence/RunTranscriptStore.js";
import {
  PostgresRunActivityAppendStore,
  type PostgresRunActivityAppendClient,
} from "./core/persistence/RunActivityAppendStore.js";
import { FileWritebackOutboxStore } from "./core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "./core/workspace/WorkspaceManager.js";
import {
  loadWorkflowEnvironment,
  parseWorkflowFile,
  readWorkflowFile,
  WorkflowLoader,
} from "./core/workflow/WorkflowLoader.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { formatDoctorResult, runDoctor } from "./doctor.js";
import { runCompletionReportMcpServer } from "./core/harness/CompletionReportMcpServer.js";
import { runIssueBreakdownPlanMcpServer } from "./core/harness/IssueBreakdownPlanMcpServer.js";
import { runMergeConflictResolutionMcpServer } from "./core/harness/MergeConflictResolutionMcpServer.js";
import { runOperatorChatMcpServer } from "./core/harness/OperatorChatMcpServer.js";
import { runReviewFeedbackMcpServer } from "./core/harness/ReviewFeedbackMcpServer.js";
import { runReviewVerdictMcpServer } from "./core/harness/ReviewVerdictMcpServer.js";
import { runTranscriptRecallMcpServer } from "./core/harness/TranscriptRecallMcpServer.js";
import { runAgentCommandPolicyHookStdio } from "./core/harness/AgentCommandPolicyHookRunner.js";
import { FileOperatorApprovalStore, OperatorApprovalService } from "./core/approval/OperatorApprovalService.js";
import {
  createRuntimeTrackerClient,
  createRuntimeWritebackProcessor,
  resolveStatusMutationToken,
  resolveTrackerStateLists,
} from "./app/RuntimeDependencies.js";
import {
  applyConfiguredPostgresMigrations,
  validateConfiguredPostgresMigrations,
  type PostgresMigrationApplyResult,
  type PostgresMigrationValidationResult,
} from "./core/database/PostgresMigrations.js";

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
  .option("--live-runtime", "run opt-in live runtime harness diagnostics")
  .action(async (workflow: string, options: { json?: boolean; strict?: boolean; liveRuntime?: boolean }) => {
    const result = await runDoctor({
      workflowPath: path.resolve(process.cwd(), workflow),
      strict: options.strict,
      liveRuntime: options.liveRuntime,
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
  .command("migrations:validate")
  .description("Validate Postgres migration discovery and ordering without connecting to Postgres")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--json", "print JSON output")
  .action(async (workflow: string, options: { json?: boolean }) => {
    const database = await loadDatabaseConfigForCli(workflow);
    const result = await validateConfiguredPostgresMigrations({ database });
    printMigrationValidationResult(result, options.json ?? false);
  });

program
  .command("migrations:apply")
  .description("Apply configured Postgres migrations to the configured database")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--json", "print JSON output")
  .action(async (workflow: string, options: { json?: boolean }) => {
    const database = await loadDatabaseConfigForCli(workflow);
    const result = await applyConfiguredPostgresMigrations({ database });
    printMigrationApplyResult(result, options.json ?? false);
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
  .command("merge-conflict-resolution-mcp")
  .description("Run the internal Symphony merge-conflict-resolution MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active conflict-fix worker context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runMergeConflictResolutionMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .command("issue-breakdown-plan-mcp")
  .description("Run the internal Symphony issue-breakdown-plan MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active planning worker context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runIssueBreakdownPlanMcpServer({
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
  .command("transcript-recall-mcp")
  .description("Run the internal Symphony read-only transcript recall MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active recall context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runTranscriptRecallMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .command("operator-chat-mcp")
  .description("Run the internal Symphony operator chat MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active operator chat context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runOperatorChatMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .command("agent-command-policy-hook")
  .description("Evaluate a Hermes pre_tool_call payload against the Symphony agent command policy")
  .option("--role <role>", "agent role for this hook invocation; falls back to SYMPHONY_AGENT_ROLE")
  .option("--phase <phase>", "agent run phase for this hook invocation; falls back to SYMPHONY_RUN_PHASE")
  .option("--issue-id <id>", "active issue id; falls back to SYMPHONY_ISSUE_ID")
  .option("--run-id <id>", "active run id; falls back to SYMPHONY_RUN_ID or Hermes session_id")
  .option("--decision-journal <path>", "append redacted structured policy decisions to this newline-delimited JSON journal")
  .action(async (options: { role?: string; phase?: string; issueId?: string; runId?: string; decisionJournal?: string }) => {
    await runAgentCommandPolicyHookStdio({
      role: options.role ?? process.env.SYMPHONY_AGENT_ROLE,
      phase: options.phase ?? process.env.SYMPHONY_RUN_PHASE,
      issueId: options.issueId ?? process.env.SYMPHONY_ISSUE_ID,
      runId: options.runId ?? process.env.SYMPHONY_RUN_ID,
      journalPath: options.decisionJournal,
    });
  });

program
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--port <port>", "enable local HTTP status server on this port")
  .option("--host <host>", "HTTP bind host")
  .option(
    "--web-assets-root <path>",
    "serve the built React web asset root under /web (usually web/dist)",
  )
  .action(async (workflow: string, options: { port?: string; host?: string; webAssetsRoot?: string }) => {
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
        webAssetsRoot:
          options.webAssetsRoot === undefined
            ? loaded.serviceConfig.server.webAssetsRoot
            : resolveCliPathOption(options.webAssetsRoot),
      },
    };

    const configRef = { value: config };

    const tracker = createRuntimeTrackerClient(config);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const orchestratorConversationStore = new FileOrchestratorConversationStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const mcpExposureDiagnosticsStore = new FileMcpExposureDiagnosticsStore(config.workspace.stateDir);
    const writebackOutbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    const projectionPersistence =
      config.server.port === null || !config.server.enableStatusServer ? null : await createRuntimeProjectionPersistence(config);
    const operatorApprovalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: operatorApprovalStore, runStore });
    const writeback = createRuntimeWritebackProcessor(() => configRef.value, logger);
    const statusMutationToken = resolveStatusMutationToken(config);
    let statusServerBaseUrl: string | null = null;
    const workspaceManager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger,
      planningWorkspaceMode: config.issueBreakdown.workspaceMode,
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
      orchestratorConversationStore,
      statusServerBaseUrl: () => statusServerBaseUrl,
      statusMutationToken,
      ...(writeback === undefined ? {} : { writeback }),
      operatorApproval,
    });

    loader.watch((event) => {
      if (event.loaded) {
        configRef.value = event.loaded.serviceConfig;
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
            orchestratorConversationStore,
            lifecycleStore,
            mcpExposureDiagnosticsStore,
            writebackOutbox,
            operatorApproval,
            host: config.server.host,
            port: config.server.port,
            openWorkspaceToken: statusMutationToken,
            tracker,
            trackerStateLists: resolveTrackerStateLists(config),
            issueBoardColumns: config.issueBoard.columns,
            staleThresholdMs: config.polling.intervalMs,
            dashboard: statusDashboardConfig(config),
            webAssetsRoot: config.server.webAssetsRoot,
            enableStatusServer: config.server.enableStatusServer,
            ...(projectionPersistence
              ? {
                  projectionWriter: projectionPersistence.writer,
                  projectionReader: projectionPersistence.writer,
                  runActivitySourceStore: projectionPersistence.runActivitySourceStore,
                }
              : {}),
          });

    if (statusServer) {
      const address = await statusServer.start();
      statusServerBaseUrl = `http://${localStatusHost(address.host)}:${address.port}`;
      logger.info("status server started", { host: address.host, port: address.port });
    }

    await orchestrator.start();
    logger.info("symphony started", { workflow_path: workflowPath });

    const shutdown = async () => {
      logger.info("symphony shutting down");
      await orchestrator.stop();
      await statusServer?.stop();
      await projectionPersistence?.close();
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

function localStatusHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

interface RuntimeProjectionPersistence {
  writer: ProjectionTransactionService;
  runActivitySourceStore: PostgresRunActivityAppendStore;
  close(): Promise<void>;
}

async function createRuntimeProjectionPersistence(config: ServiceConfig): Promise<RuntimeProjectionPersistence | null> {
  const connectionString = config.database.postgres.connectionString;
  if (connectionString === null) return null;
  const require = createRequire(import.meta.url);
  const { Pool } = require("pg") as {
    Pool: new (options: { connectionString: string; ssl: boolean }) => ProjectionSqlPool & { end(): Promise<void> };
  };
  const pool = new Pool({ connectionString, ssl: config.database.postgres.ssl });
  return {
    writer: new ProjectionTransactionService(new PostgresProjectionTransactionStore(pool)),
    runActivitySourceStore: new PostgresRunActivityAppendStore({
      connect: async () => (await pool.connect()) as PostgresRunActivityAppendClient,
    }),
    close: () => pool.end(),
  };
}

async function loadDatabaseConfigForCli(workflow: string): Promise<DatabaseConfig> {
  const workflowPath = path.resolve(process.cwd(), workflow);
  const definition = parseWorkflowFile(await readWorkflowFile(workflowPath), workflowPath);
  const env = await loadWorkflowEnvironment(workflowPath);
  return parseDatabaseConfig(definition.config, workflowPath, env);
}

function printMigrationValidationResult(result: PostgresMigrationValidationResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Validated ${result.count} Postgres migration(s) in ${result.migrationsDir}: ${formatMigrationIds(result)}`,
  );
}

function printMigrationApplyResult(result: PostgresMigrationApplyResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Applied ${result.applied.length} Postgres migration(s), skipped ${result.skipped.length} already-applied migration(s) in ${result.migrationsDir}: ${formatMigrationIds(result)}`,
  );
}

function formatMigrationIds(result: PostgresMigrationValidationResult): string {
  return result.migrations.length === 0 ? "none" : result.migrations.map((migration) => migration.id).join(", ");
}

function statusDashboardConfig(config: ServiceConfig) {
  const githubRepoLabel = config.github.owner && config.github.repo ? `${config.github.owner}/${config.github.repo}` : null;
  return {
    repoLabel: githubRepoLabel ?? config.workspace.source.repository ?? config.workspace.source.path ?? "",
    branch: config.workspace.source.ref ?? config.workspace.source.baseRef ?? "",
    workflowLabel: path.basename(config.workflowPath),
    pollIntervalMs: config.polling.intervalMs,
    concurrencyCap: config.agent.maxConcurrentAgents,
  };
}

function resolveCliPathOption(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return path.resolve(process.cwd(), trimmed);
}
