#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { StatusServer } from "./app/http.js";
import { parseDatabaseConfig, type DatabaseConfig, type ServiceConfig } from "./core/config/Config.js";
import { SymphonyError } from "./core/errors.js";
import { createAgentHarness } from "./core/harness/HarnessFactory.js";
import { StructuredLogger } from "./core/logging/StructuredLogger.js";
import {
  Orchestrator,
  type IssueHistoryInspectionResult,
  type ManualAgentEligibilityResult,
  type ManualAgentRunResult,
  type ManualAgentRunStage,
  type PromptPreviewResult,
} from "./core/orchestrator/Orchestrator.js";
import {
  DEFAULT_ISSUE_INSPECTION_STAGES,
  IssueInspectionService,
  type IssueInspectionResult,
} from "./core/IssueInspectionService.js";
import {
  LifecycleReconciliationService,
  type LifecycleReconciliationApplyResult,
  type LifecycleReconciliationResult,
} from "./core/LifecycleReconciliationService.js";
import {
  RunTranscriptCleanupService,
  type RunTranscriptCleanupResult,
} from "./core/RunTranscriptCleanupService.js";
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
import { SqliteWritebackOutboxStore } from "./core/writeback/WritebackOutbox.js";
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
import { runIssuePostMortemMcpServer } from "./core/harness/IssuePostMortemMcpServer.js";
import { runIssueTriageMcpServer } from "./core/harness/IssueTriageMcpServer.js";
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
  .command("issue-triage-mcp")
  .description("Run the internal Symphony issue-triage MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active triage context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runIssueTriageMcpServer({
      workflowPath: path.resolve(process.cwd(), options.workflow),
      contextFile: path.resolve(process.cwd(), options.contextFile),
    });
  });

program
  .command("issue-post-mortem-mcp")
  .description("Run the internal Symphony issue-post-mortem MCP server")
  .requiredOption("--workflow <path>", "path to WORKFLOW.md")
  .requiredOption("--context-file <path>", "path to the active post-mortem context file")
  .action(async (options: { workflow: string; contextFile: string }) => {
    await runIssuePostMortemMcpServer({
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

const agentCommand = program.command("agent").description("Run or inspect Symphony agents");

agentCommand
  .command("run")
  .description("Dispatch one Symphony agent stage for a specific issue and wait for completion")
  .argument("<issue>", "issue id or identifier")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .requiredOption("--stage <stage>", "agent stage: worker, reviewer, review, triage, planner, breakdown, post-mortem, merge-conflict")
  .option("--force", "bypass configured label exclude guardrails; required with --ignore-state")
  .option("--ignore-state", "with --force, bypass the selected stage's current issue state gate")
  .option("--json", "print JSON result")
  .action(async (issue: string, workflow: string, options: { stage: string; force?: boolean; ignoreState?: boolean; json?: boolean }) => {
    if (options.ignoreState === true && options.force !== true) {
      throw new Error("--ignore-state requires --force");
    }
    const logger = new StructuredLogger();
    const workflowPath = path.resolve(process.cwd(), workflow);
    const loader = new WorkflowLoader(workflowPath);
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const configRef = { value: config };
    const tracker = createRuntimeTrackerClient(config);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const writeback = createRuntimeWritebackProcessor(() => configRef.value, logger);
    const operatorApprovalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: operatorApprovalStore, runStore });
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
      statusServerBaseUrl: () => null,
      statusMutationToken: null,
      ...(writeback === undefined ? {} : { writeback }),
      operatorApproval,
    });
    try {
      const result = await orchestrator.runManualAgent(issue, {
        stage: parseManualAgentRunStage(options.stage),
        forceLabels: options.force === true,
        ignoreState: options.ignoreState === true,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatManualAgentRunResult(result));
      }
      if (result.status === "not_dispatched") {
        process.exitCode = 2;
      } else if (result.finalStatus !== "succeeded") {
        process.exitCode = 1;
      }
    } finally {
      await orchestrator.stop();
      await writeback?.close();
      await loader.close();
      await harness.dispose?.();
    }
  });

const promptCommand = program.command("prompt").description("Inspect Symphony prompts without dispatching an agent");

promptCommand
  .command("render")
  .description("Render the prompt Symphony would give the next agent run for an issue")
  .argument("<issue>", "issue id or identifier")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--state <state>", "simulate the issue in a specific tracker state")
  .option("--role <role>", "force or constrain role: auto, worker, reviewer, triage, planner, post_mortem", "auto")
  .option("--phase <phase>", "force or constrain phase: auto, implementation, review, issue_breakdown, issue_triage, post_mortem, merge_conflict_resolution", "auto")
  .option("--force", "render the requested role/phase even if Symphony would not dispatch it")
  .option("--json", "print JSON output including prompt metadata")
  .option("--out <path>", "write the rendered prompt to a file instead of stdout")
  .action(
    async (
      issue: string,
      workflow: string,
      options: { state?: string; role?: string; phase?: string; force?: boolean; json?: boolean; out?: string },
    ) => {
      const logger = new StructuredLogger();
      const workflowPath = path.resolve(process.cwd(), workflow);
      const loader = new WorkflowLoader(workflowPath);
      const loaded = await loader.load();
      const config = loaded.serviceConfig;
      const tracker = createRuntimeTrackerClient(config);
      const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
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
        statusServerBaseUrl: () => null,
        statusMutationToken: null,
      });
      try {
        const result = await orchestrator.renderPromptPreview(issue, {
          ...(options.state === undefined ? {} : { state: options.state }),
          role: parsePromptRenderRole(options.role),
          phase: parsePromptRenderPhase(options.phase),
          force: options.force === true,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.status === "rendered") {
          const rendered = formatRenderedPromptPreview(result);
          if (options.out) {
            await fs.writeFile(path.resolve(process.cwd(), options.out), rendered, "utf8");
          } else {
            console.log(rendered);
          }
        } else {
          console.log(`No prompt would be dispatched for ${result.issue.identifier}: ${result.reason}`);
        }
      } finally {
        await loader.close();
        await harness.dispose?.();
      }
    },
  );

const issueCommand = program.command("issue").description("Inspect Symphony issue metadata");

issueCommand
  .command("inspect")
  .description("Inspect tracker, lifecycle, run, writeback, approval, and dispatch metadata for an issue")
  .argument("<issue>", "issue id or identifier")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--stage <stage>", "limit eligibility to one stage: worker, reviewer, review, triage, planner, breakdown, post-mortem, merge-conflict")
  .option("--json", "print JSON result")
  .option("--raw", "include raw lifecycle, run, writeback, and approval records; implies --json")
  .option("--runs-limit <count>", "number of recent runs to include", "10")
  .action(
    async (
      issue: string,
      workflow: string,
      options: { stage?: string; json?: boolean; raw?: boolean; runsLimit?: string },
    ) => {
      const logger = new StructuredLogger();
      const workflowPath = path.resolve(process.cwd(), workflow);
      const loader = new WorkflowLoader(workflowPath);
      const loaded = await loader.load();
      const config = loaded.serviceConfig;
      const tracker = createRuntimeTrackerClient(config);
      const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
      const writebackOutbox = new SqliteWritebackOutboxStore(config.workspace.stateDir);
      const operatorApprovalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
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
        statusServerBaseUrl: () => null,
        statusMutationToken: null,
      });
      try {
        const stage = options.stage === undefined ? null : parseManualAgentRunStage(options.stage);
        const inspector = new IssueInspectionService({
          config,
          tracker,
          lifecycleStore,
          runStore,
          writebackOutbox,
          approvalStore: operatorApprovalStore,
          orchestrator,
        });
        const result = await inspector.inspect(issue, {
          stages: stage === null ? DEFAULT_ISSUE_INSPECTION_STAGES : [stage],
          includeRaw: options.raw === true,
          runsLimit: parsePositiveIntegerOption(options.runsLimit, "--runs-limit"),
        });
        if (options.json || options.raw) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatIssueInspectionResult(result));
        }
        if (!result.found) process.exitCode = 2;
      } finally {
        await orchestrator.stop();
        await writebackOutbox.close();
        await loader.close();
        await harness.dispose?.();
      }
    },
  );

issueCommand
  .command("history")
  .description("Inspect persisted Symphony issue state history and replay transition decisions")
  .argument("<issue>", "issue id or identifier")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--json", "print JSON result")
  .action(async (issue: string, workflow: string, options: { json?: boolean }) => {
    const logger = new StructuredLogger();
    const workflowPath = path.resolve(process.cwd(), workflow);
    const loader = new WorkflowLoader(workflowPath);
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const tracker = createRuntimeTrackerClient(config);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
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
      statusServerBaseUrl: () => null,
      statusMutationToken: null,
    });
    try {
      const result = await orchestrator.inspectIssueHistory(issue);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatIssueHistoryInspectionResult(result));
      }
      if (!result.found) process.exitCode = 2;
      else if (!result.replayMatched) process.exitCode = 1;
    } finally {
      await orchestrator.stop();
      await loader.close();
      await harness.dispose?.();
    }
  });

issueCommand
  .command("cleanup-transcripts")
  .description("Preview or apply run transcript cleanup for one issue or terminal issues")
  .argument("[issueOrWorkflow]", "issue id or identifier, or workflow path when --terminal is used")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--terminal", "cleanup transcripts for issues in tracker.terminal_states")
  .option("--apply", "delete selected run transcript directories; default is dry-run")
  .option("--keep-latest <count>", "number of newest runs to preserve per issue")
  .option("--json", "print JSON result")
  .action(
    async (
      issueOrWorkflow: string | undefined,
      workflowArg: string,
      options: { terminal?: boolean; apply?: boolean; keepLatest?: string; json?: boolean },
    ) => {
      const terminal = options.terminal === true;
      const issue = terminal ? null : issueOrWorkflow ?? null;
      const workflow = terminal ? issueOrWorkflow ?? workflowArg : workflowArg;
      if (!terminal && issue === null) {
        throw new SymphonyError("invalid_request", "issue cleanup-transcripts requires an issue id or --terminal");
      }

      const workflowPath = path.resolve(process.cwd(), workflow);
      const loader = new WorkflowLoader(workflowPath);
      const loaded = await loader.load();
      const config = loaded.serviceConfig;
      const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
      const service = new RunTranscriptCleanupService({ runStore });
      try {
        const targets = terminal
          ? (await createRuntimeTrackerClient(config).fetchIssuesByStates(config.tracker.terminalStates)).map((terminalIssue) => ({
              issueIdOrIdentifier: terminalIssue.id,
              issueId: terminalIssue.id,
              issueIdentifier: terminalIssue.identifier,
            }))
          : [{ issueIdOrIdentifier: issue as string }];
        const result = await service.cleanup({
          targets,
          keepLatestRuns:
            options.keepLatest === undefined
              ? config.transcriptCleanup.terminalStartup.keepLatestRuns
              : parseNonnegativeIntegerOption(options.keepLatest, "--keep-latest"),
          apply: options.apply === true,
          reason: terminal ? "cli_terminal_transcript_cleanup" : "cli_issue_transcript_cleanup",
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatRunTranscriptCleanupResult(result, { terminal }));
        }
        if (result.totals.deletable === 0) process.exitCode = 2;
      } finally {
        await loader.close();
      }
    },
  );

issueCommand
  .command("reconcile-lifecycle")
  .description("Preview or apply lifecycle cleanup for superseded review, triage, and merge-gate records")
  .argument("[issueOrWorkflow]", "issue id or identifier, or workflow path when --all is used")
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--all", "reconcile every lifecycle record in the workflow state directory")
  .option("--apply", "write lifecycle cleanup changes; default is dry-run")
  .option("--json", "print JSON result")
  .action(
    async (
      issueOrWorkflow: string | undefined,
      workflowArg: string,
      options: { all?: boolean; apply?: boolean; json?: boolean },
    ) => {
      const all = options.all === true;
      const issue = all ? null : issueOrWorkflow ?? null;
      const workflow = all ? issueOrWorkflow ?? workflowArg : workflowArg;
      if (!all && issue === null) {
        throw new SymphonyError("invalid_request", "issue reconcile-lifecycle requires an issue id or --all");
      }
      const workflowPath = path.resolve(process.cwd(), workflow);
      const loader = new WorkflowLoader(workflowPath);
      const loaded = await loader.load();
      const lifecycleStore = new FileIssueLifecycleStore(loaded.serviceConfig.workspace.stateDir);
      const service = new LifecycleReconciliationService({ lifecycleStore });
      try {
        const result = all
          ? options.apply === true
            ? await service.applyAll()
            : await service.previewAll()
          : options.apply === true
            ? await service.applyIssue(issue as string)
            : await service.previewIssue(issue as string);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatLifecycleReconciliationResult(result, { all, applied: options.apply === true }));
        }
        if (result === null || (Array.isArray(result) && result.length === 0)) process.exitCode = 2;
      } finally {
        await loader.close();
      }
    },
  );

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
    const writebackOutbox = new SqliteWritebackOutboxStore(config.workspace.stateDir);
    const projectionPersistence =
      config.server.port === null || !config.server.enableStatusServer ? null : await createRuntimeProjectionPersistence(config);
    const operatorApprovalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: operatorApprovalStore, runStore });
    const writeback = createRuntimeWritebackProcessor(() => configRef.value, logger, undefined, {
      outboxStore: writebackOutbox,
      lifecycleStore,
    });
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
      await writeback?.close();
      await writebackOutbox.close();
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

function parsePromptRenderRole(value: string | undefined): "auto" | "worker" | "reviewer" | "triage" | "planner" | "post_mortem" {
  const normalized = (value ?? "auto").trim().toLowerCase().replace(/-/g, "_");
  if (
    normalized === "auto" ||
    normalized === "worker" ||
    normalized === "reviewer" ||
    normalized === "triage" ||
    normalized === "planner" ||
    normalized === "post_mortem"
  ) {
    return normalized;
  }
  throw new Error(`Invalid prompt render role: ${value}`);
}

function parsePromptRenderPhase(
  value: string | undefined,
): "auto" | "implementation" | "review" | "issue_breakdown" | "issue_triage" | "post_mortem" | "merge_conflict_resolution" {
  const normalized = (value ?? "auto").trim().toLowerCase().replace(/-/g, "_");
  if (
    normalized === "auto" ||
    normalized === "implementation" ||
    normalized === "review" ||
    normalized === "issue_breakdown" ||
    normalized === "issue_triage" ||
    normalized === "post_mortem" ||
    normalized === "merge_conflict_resolution"
  ) {
    return normalized;
  }
  throw new Error(`Invalid prompt render phase: ${value}`);
}

function parseManualAgentRunStage(value: string | undefined): ManualAgentRunStage {
  const normalized = (value ?? "").trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "worker":
      return "worker";
    case "review":
    case "reviewer":
      return "reviewer";
    case "triage":
      return "triage";
    case "post-mortem":
    case "postmortem":
      return "post_mortem";
    case "breakdown":
    case "planner":
      return "planner";
    case "merge-conflict":
    case "merge-conflict-resolution":
      return "merge_conflict";
    default:
      throw new Error(`Invalid agent run stage: ${value}`);
  }
}

function parsePositiveIntegerOption(value: string | undefined, label: string): number {
  const parsed = Number(value ?? "10");
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonnegativeIntegerOption(value: string | undefined, label: string): number {
  const parsed = Number(value ?? "0");
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function formatRenderedPromptPreview(result: Extract<PromptPreviewResult, { status: "rendered" }>): string {
  return [
    "===== EPHEMERAL SYSTEM PROMPT =====",
    result.ephemeralSystemPrompt,
    "",
    "===== USER PROMPT =====",
    result.userPrompt,
  ].join("\n");
}

function formatIssueInspectionResult(result: IssueInspectionResult): string {
  const trackerIssue = result.tracker.issue;
  const lifecycle = result.lifecycle.summary;
  const lines = [
    `Issue ${trackerIssue?.identifier ?? lifecycle?.issueIdentifier ?? result.issue}`,
    "",
    "Tracker",
    `  Status: ${result.tracker.status}${result.tracker.error ? ` (${result.tracker.error})` : ""}`,
    `  State: ${trackerIssue?.state ?? "n/a"}`,
    `  Title: ${trackerIssue?.title ?? "n/a"}`,
    `  Labels: ${formatCliList(trackerIssue?.labels ?? [])}`,
    `  Assigned to worker: ${formatCliBoolean(trackerIssue?.assignedToWorker)}`,
    `  Has children: ${formatCliBoolean(trackerIssue?.hasChildren)}`,
    `  Open blockers: ${trackerIssue ? trackerIssue.blockedBy.filter((blocker) => blocker.state === null || !stateInCliList(blocker.state, result.config.terminalStates)).length : "n/a"}`,
    "",
    "Lifecycle",
    `  Present: ${formatCliBoolean(result.lifecycle.found)}`,
    `  Phase: ${lifecycle?.phase ?? "n/a"}`,
    `  Blocked reason: ${lifecycle?.blockedReason ?? "n/a"}`,
    `  Review round: ${lifecycle?.reviewRound ?? "n/a"}`,
    `  Incomplete turns: ${lifecycle?.incompleteTurnCount ?? "n/a"}`,
    `  Planning failures: ${lifecycle?.planningFailureCount ?? "n/a"}`,
    `  Last run pointer: ${lifecycle?.summaryPointers.lastRunId ?? "n/a"}`,
    `  PR: ${formatCliPullRequest(lifecycle?.summaryPointers.prNumber ?? null, lifecycle?.summaryPointers.prUrl ?? null)}`,
    "",
    "Latest Signals",
    `  Completion: ${formatCompletionSignal(result)}`,
    `  Review: ${formatReviewSignal(result)}`,
    `  Merge gate result: ${formatMergeGateResultSignal(result)}`,
    `  Triage: ${formatTriageSignal(result)}`,
    `  Post-mortem: ${formatPostMortemSignal(result)}`,
    `  Run: ${formatRunSignal(result)}`,
    `  Pending approval: ${result.latest.pendingApproval ? `${result.latest.pendingApproval.requestId} (${result.latest.pendingApproval.status})` : "none"}`,
    "",
    "Workspace",
    `  Key: ${result.workspace?.workspaceKey ?? lifecycle?.summaryPointers.workspaceKey ?? "n/a"}`,
    `  Path: ${result.workspace?.path ?? lifecycle?.summaryPointers.workspacePath ?? "n/a"}`,
    `  Branch: ${result.workspace?.gitBranchName ?? lifecycle?.summaryPointers.gitBranchName ?? lifecycle?.summaryPointers.branchName ?? "n/a"}`,
    "",
    "Runs",
    `  Total: ${result.runs.count}`,
    ...formatRecentRuns(result),
    "",
    "Writebacks",
    `  Related: ${result.writebacks.count}`,
    `  Pending: ${result.writebacks.pendingCount}`,
    ...formatPendingWritebacks(result),
    "",
    "Eligibility",
    ...formatEligibility(result.eligibility),
  ];
  return lines.join("\n");
}

function formatIssueHistoryInspectionResult(result: IssueHistoryInspectionResult): string {
  if (!result.found || result.record === null) {
    return `No persisted issue history found for ${result.issueIdOrIdentifier}.`;
  }
  const record = result.record;
  const lines = [
    `Issue history for ${record.issueIdentifier}`,
    `  Issue id: ${record.issueId}`,
    `  Current state: ${record.trackerState}`,
    `  Snapshots: ${record.history.length}`,
    `  Replay: ${result.replayMatched ? "matched" : "mismatched"}`,
  ];
  if (record.history.length === 0) {
    lines.push("  No history snapshots recorded.");
    return lines.join("\n");
  }
  lines.push("", "Timeline");
  for (const [index, snapshot] of record.history.entries()) {
    const replay = result.replay[index];
    const replayStatus = replay?.replayable === false ? "not replayed" : replay?.matched === true ? "matched" : "mismatched";
    const snapshotKind = snapshot.snapshotKind ?? "transition";
    lines.push(
      `  ${index + 1}. ${snapshot.snapshotAt} ${snapshotKind}:${snapshot.transitionKind} via ${snapshot.rulesetId}@${snapshot.rulesetVersion} (${replayStatus})`,
    );
    lines.push(`     trigger=${snapshot.triggerType} source=${snapshot.candidateSource} reason=${snapshot.reason ?? "n/a"}`);
    if (snapshotKind === "evidence") {
      lines.push(
        `     evidence=${snapshot.evidenceKind ?? "n/a"}/${snapshot.evidenceEventType ?? "n/a"} source=${snapshot.evidenceSourceId ?? "n/a"}`,
      );
    }
    if (snapshot.role || snapshot.runPhase || snapshot.runKind) {
      lines.push(`     run=${snapshot.role ?? "n/a"}/${snapshot.runPhase ?? "n/a"}/${snapshot.runKind ?? "n/a"}`);
    }
    lines.push(`     actions=${snapshot.actions.length} errors=${snapshot.errors.length}`);
    if (replay && !replay.matched) {
      lines.push(
        `     replay expected ${replay.expectedTransitionKind}/${replay.expectedRulesetId}@${replay.expectedRulesetVersion}, actual ${replay.actualTransitionKind ?? "none"}/${replay.actualRulesetId ?? "none"}@${replay.actualRulesetVersion ?? "none"}`,
      );
    }
  }
  return lines.join("\n");
}

function formatLifecycleReconciliationResult(
  result: LifecycleReconciliationResult | LifecycleReconciliationApplyResult | LifecycleReconciliationResult[] | LifecycleReconciliationApplyResult[] | null,
  options: { all: boolean; applied: boolean },
): string {
  if (result === null) return "No lifecycle record found.";
  const results = Array.isArray(result) ? result : [result];
  const changed = results.filter((item) => item.changed);
  const appliedCount = results.filter((item) => "applied" in item && item.applied).length;
  const lines = [
    `Lifecycle reconciliation ${options.applied ? "apply" : "dry-run"}${options.all ? " for all issues" : ""}`,
    `  Scanned: ${results.length}`,
    `  Changed: ${changed.length}`,
    ...(options.applied ? [`  Applied: ${appliedCount}`] : []),
  ];
  if (changed.length === 0) {
    lines.push("  No lifecycle cleanup needed.");
    return lines.join("\n");
  }
  for (const item of changed) {
    lines.push("", `${item.issueIdentifier} (${item.issueId})`);
    for (const action of item.actions) {
      lines.push(
        `  - ${action.kind}: ${action.recordId}${action.supersededBy ? ` -> ${action.supersededBy}` : ""}${action.reason ? ` (${action.reason})` : ""}`,
      );
      lines.push(`    ${oneLineCli(action.detail)}`);
    }
  }
  return lines.join("\n");
}

function formatRunTranscriptCleanupResult(result: RunTranscriptCleanupResult, options: { terminal: boolean }): string {
  const lines = [
    `Transcript cleanup ${result.apply ? "apply" : "dry-run"}${options.terminal ? " for terminal issues" : ""}`,
    `  Issues: ${result.totals.issues}`,
    `  Runs considered: ${result.totals.considered}`,
    `  Kept: ${result.totals.kept}`,
    `  Skipped running: ${result.totals.skippedRunning}`,
    `  Deletable: ${result.totals.deletable}`,
    ...(result.apply ? [`  Deleted: ${result.totals.deleted}`] : []),
    `  Bytes ${result.apply ? "removed" : "deletable"}: ${result.apply ? result.totals.bytesRemoved : result.totals.bytesDeletable}`,
  ];
  for (const issue of result.issues.filter((item) => item.deletable > 0 || item.kept > 0 || item.skippedRunning > 0)) {
    lines.push("", `${issue.issueIdentifier ?? issue.issueIdOrIdentifier}${issue.issueId ? ` (${issue.issueId})` : ""}`);
    lines.push(
      `  considered=${issue.considered} kept=${issue.kept} skipped_running=${issue.skippedRunning} deletable=${issue.deletable} deleted=${issue.deleted}`,
    );
    for (const run of issue.runs.filter((item) => item.action === "deletable" || item.action === "deleted")) {
      lines.push(`  - ${run.action}: ${run.runId} ${run.status} ${run.bytes} bytes`);
    }
  }
  if (result.totals.deletable === 0) lines.push("  No transcript cleanup needed.");
  return lines.join("\n");
}

function formatManualAgentRunResult(result: ManualAgentRunResult): string {
  if (result.status === "not_dispatched") {
    return [
      `No manual agent run dispatched${result.issue ? ` for ${result.issue.identifier}` : ""}.`,
      `Role: ${result.role}`,
      `Phase: ${result.runPhase}`,
      `Reason: ${result.reason}`,
    ].join("\n");
  }
  return [
    `Manual agent run completed for ${result.issue.identifier}.`,
    `Role: ${result.role}`,
    `Phase: ${result.runPhase}`,
    `Run: ${result.runId ?? "n/a"}`,
    `Session: ${result.sessionId ?? "n/a"}`,
    `Status: ${result.finalStatus}`,
    ...(result.error === null ? [] : [`Error: ${result.error}`]),
  ].join("\n");
}

function formatCompletionSignal(result: IssueInspectionResult): string {
  const report = result.latest.completionReport;
  if (!report) return "none";
  return `${report.id} run=${report.runId} acceptedAt=${report.acceptedAt}; ${oneLineCli(report.summary)}`;
}

function formatReviewSignal(result: IssueInspectionResult): string {
  const verdict = result.latest.reviewVerdict;
  if (!verdict) return "none";
  return `${verdict.id} ${verdict.verdict} run=${verdict.runId} submittedAt=${verdict.submittedAt}; gate=${verdict.gateFindings.length} discovery=${verdict.discoveryFindings.length} unsatisfied=${verdict.unsatisfiedAcceptanceCount}`;
}

function formatMergeGateResultSignal(result: IssueInspectionResult): string {
  const mergeGate = result.latest.mergeGateResult;
  if (!mergeGate) return "none";
  return `${mergeGate.id} ${mergeGate.status} run=${mergeGate.runId} submittedAt=${mergeGate.submittedAt}; head=${mergeGate.headSha}; findings=${mergeGate.findings.length}`;
}

function formatTriageSignal(result: IssueInspectionResult): string {
  const triage = result.latest.issueTriageReport;
  if (!triage) return "none";
  return `${triage.id} ${triage.disposition}/${triage.confidence} run=${triage.runId} submittedAt=${triage.submittedAt}; blockers=${triage.blockers.length}; ${oneLineCli(triage.summary)}`;
}

function formatPostMortemSignal(result: IssueInspectionResult): string {
  const report = result.latest.issuePostMortemReport;
  if (!report) return "none";
  return `${report.id} ${report.completionStatus}/${report.specificationQuality} run=${report.runId} submittedAt=${report.submittedAt}; followups=${report.followUpCandidateCount}; ${oneLineCli(report.summary)}`;
}

function formatRunSignal(result: IssueInspectionResult): string {
  const run = result.latest.run;
  if (!run) return "none";
  return `${run.runId} ${run.role}/${run.runPhase ?? "n/a"} ${run.status} updatedAt=${run.updatedAt}${run.error ? ` error=${oneLineCli(run.error)}` : ""}`;
}

function formatRecentRuns(result: IssueInspectionResult): string[] {
  if (result.runs.recent.length === 0) return ["  Recent: none"];
  return result.runs.recent.map(
    (run) =>
      `  - ${run.runId}: ${run.role}/${run.runPhase ?? "n/a"} ${run.status} started=${run.startedAt} completed=${run.completedAt ?? "n/a"}${run.manualDispatch ? " manual" : ""}`,
  );
}

function formatPendingWritebacks(result: IssueInspectionResult): string[] {
  if (result.writebacks.pending.length === 0) return ["  Pending items: none"];
  return result.writebacks.pending.map(
    (operation) =>
      `  - ${operation.kind} ${operation.status} key=${operation.idempotencyKey} run=${operation.runId ?? "n/a"} next=${operation.nextAttemptAt}${operation.lastError ? ` error=${oneLineCli(operation.lastError)}` : ""}`,
  );
}

function formatEligibility(eligibility: IssueInspectionResult["eligibility"]): string[] {
  const lines: string[] = [];
  for (const stage of DEFAULT_ISSUE_INSPECTION_STAGES) {
    const result = eligibility[stage];
    if (!result) continue;
    lines.push(`  - ${formatManualStage(stage)}: ${formatEligibilityResult(result)}`);
  }
  return lines.length === 0 ? ["  n/a"] : lines;
}

function formatEligibilityResult(result: ManualAgentEligibilityResult): string {
  const status = result.eligible ? "eligible" : `blocked (${result.reason ?? "unknown"})`;
  return `${status}; role=${result.role}; phase=${result.runPhase}${result.explanation ? `; ${oneLineCli(result.explanation)}` : ""}`;
}

function formatManualStage(stage: ManualAgentRunStage): string {
  if (stage === "post_mortem") return "post-mortem";
  return stage === "merge_conflict" ? "merge-conflict" : stage;
}

function formatCliList(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function formatCliBoolean(value: boolean | undefined): string {
  return value === undefined ? "n/a" : value ? "yes" : "no";
}

function formatCliPullRequest(number: number | null, url: string | null): string {
  if (number === null && url === null) return "n/a";
  return [number === null ? null : `#${number}`, url].filter((value): value is string => value !== null).join(" ");
}

function stateInCliList(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

function oneLineCli(value: string): string {
  const rendered = value.replace(/\s+/g, " ").trim();
  return rendered.length <= 180 ? rendered : `${rendered.slice(0, 177)}...`;
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
